"""Protected preparation-v3 provenance and a single admit-or-abort decision.

An abort decision denies admission. It grants no source-marker or lease release.
"""
import os
import secrets
import stat
from contextlib import nullcontext
from pathlib import Path


SCHEMA = 'orbis.core-capture-preparation.v3'
DECISION = 'orbis.core-capture-reservation-decision.v1'
IDENTITY_NAMES = ('device', 'inode', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs')
STAT_NAMES = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
EXTRA = {'leaseNonce', 'leaseSha256', 'leaseIdentity'}
FIELDS = {'schema', 'id', 'root', 'context', 'scope', 'sourceSha256', 'controller', 'pointReservationSha256'} | EXTRA
INTENT = 'orbis.core-capture-preparation-intent.v1'


def lease_identity(info):
    return dict(zip(IDENTITY_NAMES, (getattr(info, key) for key in STAT_NAMES)))


def create_atomic(worker, directory, name, value, *, private=True):
    """A final authority name is never visible with incomplete bytes."""
    if not isinstance(name, str) or not name or name in {'.', '..'} or '/' in name or '\0' in name:
        raise worker.AdmissionError('Invalid preparation authority name')
    body = worker.P.canonical(value)
    if not 0 < len(body) <= 65536:
        raise worker.AdmissionError('Invalid preparation authority size')
    temporary = '.pending-' + secrets.token_hex(16)
    with worker.A.protected_directory(directory, private=private) as checked:
        expected = worker.identity(os.fstat(checked))
        parent = os.dup(checked)
    descriptor = None
    try:
        descriptor = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        with os.fdopen(descriptor, 'wb', closefd=False) as output:
            output.write(body)
            output.flush()
            os.fsync(descriptor)
        before = lease_identity(os.fstat(descriptor))
        if before['size'] != len(body) or os.pread(descriptor, len(body) + 1, 0) != body:
            raise worker.AdmissionError('The temporary preparation bytes are incomplete')
        rename = worker.load('orbis-host-core-capture-retirement.py', 'preparation_atomic_publication').rename_noreplace
        rename(parent, temporary, name)
        os.fsync(parent)
        after = lease_identity(os.stat(name, dir_fd=parent, follow_symlinks=False))
        if any(before[key] != after[key] for key in IDENTITY_NAMES if key != 'ctimeNs'):
            raise worker.AdmissionError('The published preparation inode changed')
        with worker.A.protected_directory(directory, private=private) as checked:
            if worker.identity(os.fstat(checked)) != expected:
                raise worker.AdmissionError('The preparation publication directory changed')
            with worker.A.protected_file(checked, name, 65536) as retained:
                if retained != body or lease_identity(os.stat(name, dir_fd=checked, follow_symlinks=False)) != after:
                    raise worker.AdmissionError('The published preparation bytes changed')
    finally:
        try:
            if descriptor is not None:
                try:
                    pending = os.stat(temporary, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    if worker.A.seal(pending) != worker.A.seal(os.fstat(descriptor)):
                        raise worker.AdmissionError('Ambiguous temporary preparation evidence was preserved')
                    os.unlink(temporary, dir_fd=parent)
                    os.fsync(parent)
        finally:
            if descriptor is not None:
                os.close(descriptor)
            os.close(parent)


class PreparationIntent:
    """Finish one staged reservation; never admit, drain, release or rebind it."""
    def __init__(self, worker, state, root, context, point):
        worker.require_root()
        self.W, self.H, self.A, self.P = worker, worker.CORE.HOST, worker.A, worker.P
        self.root, self.context, self.point = Path(root), context, worker.identifier(point)
        self.directory = Path(state) / 'core-capture-preparations' / self.point
        self.identities, self.seals = {}, {}
        for path in (Path(state), self.directory.parent, self.directory):
            with self.A.protected_directory(path) as checked:
                self.identities[path] = worker.identity(os.fstat(checked))
        self.value, self.body = self.read('preparation-intent.json')
        value = self.value
        if (set(value) != {'schema', 'preparation', 'grant', 'leaseIdentity', 'parentIdentity', 'reviewSha256'}
                or value['schema'] != INTENT or not isinstance(value['reviewSha256'], str)
                or not worker.HASH.fullmatch(value['reviewSha256'])):
            raise worker.AdmissionError('Invalid preparation intent')
        self.preparation, self.grant = value['preparation'], value['grant']
        record = self.preparation
        if (not isinstance(record, dict) or set(record) != FIELDS - EXTRA
                or record['schema'] != 'orbis.core-capture-preparation.v2' or record['id'] != point
                or record['root'] != str(self.root) or record['context'] != context or record['scope'] != worker.CORE.SCOPE
                or any(not isinstance(record[key], str) or not worker.HASH.fullmatch(record[key])
                       for key in ('sourceSha256', 'pointReservationSha256'))):
            raise worker.AdmissionError('Invalid preparation intent binding')
        frame = record['controller']
        if (not isinstance(frame, dict) or set(frame) != {'id', 'imageId', 'startedAt', 'definitionSha256'}
                or any(not isinstance(frame[key], str) or not worker.HASH.fullmatch(frame[key]) for key in ('id', 'definitionSha256'))
                or not isinstance(frame['imageId'], str) or not worker.CORE.TX.APPS.IMAGE_ID.fullmatch(frame['imageId'])
                or not isinstance(frame['startedAt'], str) or not 0 < len(frame['startedAt']) <= 128):
            raise worker.AdmissionError('Invalid preparation intent controller')
        if (not isinstance(self.grant, dict) or set(self.grant) != {'schema', 'id', 'root', 'context', 'sourceSha256', 'nonce'}
                or self.grant != {'schema': 'orbis.core-capture-lease.v1', 'id': point, 'root': str(self.root),
                                  'context': context, 'sourceSha256': record['sourceSha256'], 'nonce': self.grant['nonce']}
                or not isinstance(self.grant['nonce'], str) or not worker.HASH.fullmatch(self.grant['nonce'])):
            raise worker.AdmissionError('Invalid preparation intent lease')
        pinned, parent = value['leaseIdentity'], value['parentIdentity']
        if (not isinstance(pinned, dict) or set(pinned) != set(IDENTITY_NAMES)
                or any(type(item) is not int or not 0 <= item <= 2 ** 64 - 1 for item in pinned.values())
                or not stat.S_ISREG(pinned['mode']) or stat.S_IMODE(pinned['mode']) != 0o600
                or pinned['uid'] != self.A.OWNER or pinned['nlink'] != 1
                or pinned['size'] != len(self.P.canonical(self.grant))
                or not isinstance(parent, list) or len(parent) != 5
                or any(type(item) is not int or not 0 <= item <= 2 ** 64 - 1 for item in parent)):
            raise worker.AdmissionError('Invalid preparation intent inode')
        self.path = self.H.capture_fence_path(self.root)
        self.stage = self.path.with_name(worker.LEASE.CoreCaptureLease.staging_name(point))
        self.H.IDENTITY.binding(str(self.root), context)

    def read(self, name):
        if name not in {'preparation-intent.json', 'point-reservation.json'}:
            raise self.W.AdmissionError('Unknown preparation intent record')
        for path, expected in self.identities.items():
            with self.A.protected_directory(path) as checked:
                if self.W.identity(os.fstat(checked)) != expected:
                    raise self.W.AdmissionError('The preparation intent directory changed')
        with self.A.protected_directory(self.directory) as checked:
            with self.A.protected_file(checked, name, 65536) as body:
                value = self.P.metadata(body, byte_limit=65536)
                seal = self.A.seal(os.stat(name, dir_fd=checked, follow_symlinks=False))
                if (not isinstance(value, dict) or self.P.canonical(value) != body
                        or name in self.seals and self.seals[name] != seal):
                    raise self.W.AdmissionError('The preparation intent changed')
                self.seals[name] = seal
                return value, body

    def selection(self):
        if self.read('preparation-intent.json') != (self.value, self.body):
            raise self.W.AdmissionError('The original preparation intent changed')
        _, reservation = self.read('point-reservation.json')
        if self.W.digest(reservation) != self.preparation['pointReservationSha256']:
            raise self.W.AdmissionError('The intent saved-point reservation changed')
        with self.A.protected_directory(self.path.parent, private=False) as parent:
            if list(self.W.identity(os.fstat(parent))) != self.value['parentIdentity']:
                raise self.W.AdmissionError('The intent lease parent changed')
            found = []
            for path in (self.stage, self.path):
                try:
                    os.stat(path.name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                found.append(path)
            if len(found) != 1:
                raise self.W.AdmissionError('Ambiguous staged and published preparation lease')
            selected = found[0]
            with self.A.protected_file(parent, selected.name, 8192) as body:
                actual = lease_identity(os.stat(selected.name, dir_fd=parent, follow_symlinks=False))
                # Rename changes ctime. Only this staged-to-published transition
                # permits it; final v3 and all later owners pin the full seal.
                keys = IDENTITY_NAMES if selected == self.stage else IDENTITY_NAMES[:-1]
                if body != self.P.canonical(self.grant) or any(actual[key] != self.value['leaseIdentity'][key] for key in keys):
                    raise self.W.AdmissionError('The intent original lease inode changed')
            return selected

    def owner(self):
        if self.selection() == self.stage:
            return nullcontext()
        lease = self.W.LEASE.CoreCaptureLease.load(self.H, self.root)
        if lease.proof[0] != self.P.canonical(self.grant):
            raise self.W.AdmissionError('The intent original lease changed')
        return lease.owner()

    def sync_existing(self):
        """Durably preserve the intent before making its host fence durable."""
        for name in ('point-reservation.json', 'preparation-intent.json'):
            self.read(name)
            with self.A.protected_directory(self.directory) as parent:
                descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    if self.A.seal(os.fstat(descriptor)) != self.seals[name]:
                        raise self.W.AdmissionError('The preparation intent changed before sync')
                    os.fsync(descriptor)
                    if self.A.seal(os.fstat(descriptor)) != self.seals[name]:
                        raise self.W.AdmissionError('The preparation intent changed during sync')
                finally:
                    os.close(descriptor)
            self.read(name)
        for path, expected in reversed(tuple(self.identities.items())):
            with self.A.protected_directory(path) as parent:
                if self.W.identity(os.fstat(parent)) != expected:
                    raise self.W.AdmissionError('The preparation intent directory changed before sync')
                os.fsync(parent)
        self.selection()

    def publish(self):
        selected = self.selection()
        if selected == self.stage:
            self.W.LEASE.CoreCaptureLease.require_reservation_lock(self.H, self.root)
            with self.A.protected_directory(self.path.parent, private=False) as checked:
                parent = os.dup(checked)
            try:
                self.selection()
                rename = self.W.load('orbis-host-core-capture-retirement.py', 'preparation_lease_publication').rename_noreplace
                rename(parent, self.stage.name, self.path.name)
                os.fsync(parent)
            finally:
                os.close(parent)
        if self.selection() != self.path:
            raise self.W.AdmissionError('The original lease was not published')
        lease = self.W.LEASE.CoreCaptureLease.load(self.H, self.root)
        if lease.proof[0] != self.P.canonical(self.grant):
            raise self.W.AdmissionError('The published preparation lease changed')
        return lease


class ReservedPreparation:
    def __init__(self, worker, state, root, context, point):
        self.W, self.A, self.P, self.H = worker, worker.A, worker.P, worker.CORE.HOST
        worker.require_root()
        self.state, self.root, self.context, self.point = Path(state), Path(root), context, worker.identifier(point)
        self.directory = self.state / 'core-capture-preparations' / self.point
        self.identities, self.seals = {}, {}
        for path in (self.state, self.directory.parent, self.directory):
            with self.A.protected_directory(path) as checked:
                self.identities[path] = worker.identity(os.fstat(checked))
        self.preparation, self.body = self.read('preparation.json')
        record = self.preparation
        if (set(record) != FIELDS or record['schema'] != SCHEMA or record['id'] != point
                or record['root'] != str(self.root) or record['context'] != context or record['scope'] != worker.CORE.SCOPE
                or any(not isinstance(record[key], str) or not worker.HASH.fullmatch(record[key])
                       for key in ('sourceSha256', 'pointReservationSha256', 'leaseNonce', 'leaseSha256'))):
            raise worker.AdmissionError('Invalid reserved core preparation')
        pinned = record['leaseIdentity']
        if (not isinstance(pinned, dict) or set(pinned) != set(IDENTITY_NAMES)
                or any(type(value) is not int or not 0 <= value <= 2 ** 64 - 1 for value in pinned.values())):
            raise worker.AdmissionError('Invalid reserved capture lease identity')
        frame = record['controller']
        if (not isinstance(frame, dict) or set(frame) != {'id', 'imageId', 'startedAt', 'definitionSha256'}
                or any(not isinstance(frame[key], str) or not worker.HASH.fullmatch(frame[key]) for key in ('id', 'definitionSha256'))
                or not isinstance(frame['imageId'], str) or not worker.CORE.TX.APPS.IMAGE_ID.fullmatch(frame['imageId'])
                or not isinstance(frame['startedAt'], str) or not 0 < len(frame['startedAt']) <= 128):
            raise worker.AdmissionError('Invalid reserved controller frame')
        self.preparation_sha256 = worker.digest(self.body)
        self.grant = {'schema': 'orbis.core-capture-lease.v1', 'id': point, 'root': str(self.root),
                      'context': context, 'nonce': record['leaseNonce'], 'sourceSha256': record['sourceSha256']}
        if worker.digest(self.P.canonical(self.grant)) != record['leaseSha256']:
            raise worker.AdmissionError('The reserved capture lease bytes changed')
        self.lease()

    def read(self, name):
        if name not in {'preparation.json', 'decision.json', 'point-reservation.json'}:
            raise self.W.AdmissionError('Unknown reserved capture authority record')
        for path, expected in self.identities.items():
            with self.A.protected_directory(path) as checked:
                if self.W.identity(os.fstat(checked)) != expected:
                    raise self.W.AdmissionError('The reserved preparation directory changed')
        with self.A.protected_directory(self.directory) as checked:
            with self.A.protected_file(checked, name, 65536) as body:
                value = self.P.metadata(body, byte_limit=65536)
                seal = self.A.seal(os.stat(name, dir_fd=checked, follow_symlinks=False))
                if not isinstance(value, dict) or self.P.canonical(value) != body:
                    raise self.W.AdmissionError('Invalid reserved capture authority')
                if name in self.seals and self.seals[name] != seal:
                    raise self.W.AdmissionError('The reserved capture authority changed')
                self.seals[name] = seal
                return value, body

    def lease(self):
        if self.read('preparation.json') != (self.preparation, self.body):
            raise self.W.AdmissionError('The reserved preparation changed')
        _, reservation_body = self.read('point-reservation.json')
        if self.W.digest(reservation_body) != self.preparation['pointReservationSha256']:
            raise self.W.AdmissionError('The original reserved saved point changed')
        lease = self.W.LEASE.CoreCaptureLease.load(self.H, self.root)
        expected_seal = tuple(self.preparation['leaseIdentity'][key] for key in IDENTITY_NAMES)
        if lease.proof[0] != self.P.canonical(self.grant) or lease.proof[1] != expected_seal:
            raise self.W.AdmissionError('The original reserved capture lease changed')
        return lease

    def expected(self, choice, source_hold=None):
        if choice not in {'admit', 'abort'} or (choice == 'admit') != (source_hold is not None):
            raise self.W.AdmissionError('Invalid reserved capture decision')
        if source_hold is not None and (not isinstance(source_hold, str) or not self.W.HASH.fullmatch(source_hold)):
            raise self.W.AdmissionError('Invalid admitted source hold digest')
        record = self.preparation
        return {'schema': DECISION, 'id': self.point, 'root': str(self.root), 'context': self.context,
                'preparationSha256': self.preparation_sha256,
                **{key: record[key] for key in ('leaseNonce', 'leaseSha256', 'sourceSha256', 'pointReservationSha256')},
                'decision': choice, **({'sourceHoldSha256': source_hold} if choice == 'admit' else {})}

    def sync_existing(self):
        """Re-establish durability of existing authority without creating or replacing it."""
        lease = self.lease()
        if self.H.core_capture_owner(self.root) != self.grant or self.H.LOCK_DESCRIPTOR.get() is None:
            raise self.W.AdmissionError('Reserved observation requires its held installation lock')
        for name in ('point-reservation.json', 'preparation.json'):
            self.read(name)
            with self.A.protected_directory(self.directory) as parent:
                if self.W.identity(os.fstat(parent)) != self.identities[self.directory]:
                    raise self.W.AdmissionError('The reserved preparation directory changed')
                descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    if self.A.seal(os.fstat(descriptor)) != self.seals[name]:
                        raise self.W.AdmissionError('The reserved preparation record changed')
                    os.fsync(descriptor)
                    if self.A.seal(os.fstat(descriptor)) != self.seals[name]:
                        raise self.W.AdmissionError('The reserved preparation record changed')
                finally:
                    os.close(descriptor)
            self.read(name)
        fence = self.H.capture_fence_path(self.root)
        with self.A.protected_directory(fence.parent, private=False) as parent:
            info = os.fstat(parent)
            if tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode')) != lease.proof[2]:
                raise self.W.AdmissionError('The reserved capture parent changed')
            descriptor = os.open(fence.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                if self.A.seal(os.fstat(descriptor)) != lease.proof[1]:
                    raise self.W.AdmissionError('The reserved capture lease changed')
                os.fsync(descriptor)
                if self.A.seal(os.fstat(descriptor)) != lease.proof[1]:
                    raise self.W.AdmissionError('The reserved capture lease changed')
                os.fsync(parent)
            finally:
                os.close(descriptor)
        for path, expected in reversed(tuple(self.identities.items())):
            with self.A.protected_directory(path) as parent:
                if self.W.identity(os.fstat(parent)) != expected:
                    raise self.W.AdmissionError('The reserved authority directory changed')
                os.fsync(parent)
        self.lease()

    def decision(self, choice, source_hold=None):
        expected = self.expected(choice, source_hold)
        value, body = self.read('decision.json')
        if value != expected:
            raise self.W.AdmissionError('The reserved capture decision does not authorize this operation')
        self.lease()
        return value, body

    def decide(self, choice, source_hold=None):
        self.W.require_root()
        value = self.expected(choice, source_hold)
        self.lease()
        if self.H.core_capture_owner(self.root) != self.grant:
            raise self.W.AdmissionError('The reserved capture decision requires its exact owner')
        descriptor = self.H.LOCK_DESCRIPTOR.get()
        if type(descriptor) is not int:
            raise self.W.AdmissionError('The reserved capture decision requires the existing host lock')
        # The legacy lock may sit below an adopted user-owned ancestor. Its held
        # descriptor is installation exclusion, not a private authority record.
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != self.A.OWNER
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
            raise self.W.AdmissionError('The reserved capture host lock is no longer protected')
        held = self.A.seal(info)
        if not any(held == self.A.seal(path.lstat()) for path in self.H.AUTHORITY.LAYOUT.lock_paths(self.root)):
            raise self.W.AdmissionError('The reserved capture decision owns a different host lock')
        with self.A.protected_directory(self.directory) as checked:
            parent = os.dup(checked)
        try:
            fd = os.open('decision.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                with os.fdopen(fd, 'wb', closefd=False) as output:
                    output.write(self.P.canonical(value))
                    output.flush()
                    os.fsync(fd)
                os.fsync(parent)
            finally:
                os.close(fd)
        finally:
            os.close(parent)
        self.lease()
        return self.decision(choice, source_hold)

    def require_undecided(self):
        self.lease()
        with self.A.protected_directory(self.directory) as checked:
            try:
                os.stat('decision.json', dir_fd=checked, follow_symlinks=False)
            except FileNotFoundError:
                return
        raise self.W.AdmissionError('The reserved capture decision is already consumed')

    def admission(self, request, handoff, source_hold):
        self.lease()
        record, body = self.decision('admit', source_hold)
        if (request.get('schema') != 'orbis.core-capture-admission.v2'
                or handoff.get('schema') != 'orbis.core-capture-handoff.v2'
                or any(request.get(key) != value or handoff.get(key) != value for key, value in
                       {'preparationSha256': self.preparation_sha256, 'decisionSha256': self.W.digest(body)}.items())
                or any(request.get(key) != self.grant[other] for key, other in
                       (('id', 'id'), ('root', 'root'), ('context', 'context'), ('sourceSha256', 'sourceSha256'), ('leaseNonce', 'nonce')))
                or handoff.get('controller') != self.preparation['controller']):
            raise self.W.AdmissionError('The admission differs from its reserved decision')
        return record


def for_admission(worker, admission):
    path = admission.state / 'core-capture-preparations' / admission.point
    try:
        path.lstat()
    except FileNotFoundError:
        if admission.request['schema'] != 'orbis.core-capture-admission.v1':
            raise worker.AdmissionError('The reserved admission has no preparation provenance')
        return None
    with worker.A.protected_directory(path) as checked:
        with worker.A.protected_file(checked, 'preparation.json', 65536) as body:
            record = worker.P.metadata(body, byte_limit=65536)
            if not isinstance(record, dict) or worker.P.canonical(record) != body:
                raise worker.AdmissionError('Invalid capture preparation provenance')
    if record.get('schema') in {'orbis.core-capture-preparation.v1', 'orbis.core-capture-preparation.v2'}:
        if admission.request['schema'] != 'orbis.core-capture-admission.v1':
            raise worker.AdmissionError('A legacy preparation cannot authorize a reserved admission')
        return None
    if record.get('schema') != SCHEMA or admission.request['schema'] != 'orbis.core-capture-admission.v2':
        raise worker.AdmissionError('A reserved preparation cannot be downgraded')
    authority = ReservedPreparation(worker, admission.state, admission.root, admission.context, admission.point)
    hold, body = admission.read('source-hold.json')
    authority.admission(admission.request, admission.handoff, worker.digest(body))
    return authority
