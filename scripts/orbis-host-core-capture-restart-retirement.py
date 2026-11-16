"""Explicit Root retirement of unadmitted preparation after controller termination.

The Root caller independently authenticates the operator and confirms the exact
review. Absence is only a consistency check: original execution termination,
unchanged preparation authority, and no worker admission or supervisor are mandatory. This
neither completes a capture nor changes source data or queue state.
"""
import copy
import argparse
from contextlib import nullcontext
from dataclasses import dataclass
from datetime import datetime
import json
import importlib.util
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


REVIEW = 'orbis.core-capture-restart-retirement-review.v2'
INTENT = 'orbis.core-capture-restart-retirement-intent.v2'
RECEIPT = 'orbis.core-capture-restart-retirement-receipt.v2'
PREPARATION_FILES = {'point-reservation.json', 'preparation-intent.json', 'preparation.json'}
POLICIES = {'scope': 'retire-unadmitted-preparation-after-controller-restart-only', 'captureCompleted': False,
            'sourceAttempt': 'unknown-before-controller-restart', 'queueStateProved': False,
            'hostRebootProved': False,
            'activation': False, 'restoreAuthority': False}
READER_CAPABILITY = {'schema': 'orbis.core-capture-restart-retirement-reader.v1', 'version': 1,
                     'preparationVersion': 3, 'retirementVersion': 2,
                     'operations': ['restart-retirement'], 'sourceWrites': False, 'lifecycleAuthority': False}


class RestartRetirementError(ValueError):
    pass


def require(value):
    if not value:
        raise RestartRetirementError('Restarted capture preparation requires protected operator review')


def require_platform(worker):
    worker.require_root()
    require(os.uname().sysname == 'Linux')


def timestamp(value):
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z', value))
    try:
        return datetime.fromisoformat(value[:-1] + '+00:00').timestamp()
    except ValueError:
        raise RestartRetirementError('The controller execution timestamps are invalid') from None


def boot_witness():
    def read(path, limit):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            body = bytearray()
            while block := os.read(fd, min(65536, limit + 1 - len(body))):
                body.extend(block)
                require(len(body) <= limit)
            return bytes(body).decode('ascii')
        finally:
            os.close(fd)
    boot = read('/proc/sys/kernel/random/boot_id', 128).strip()
    require(re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', boot) is not None)
    rows = [line.split() for line in read('/proc/stat', 2 * 1024 ** 2).splitlines() if line.startswith('btime ')]
    require(len(rows) == 1 and len(rows[0]) == 2 and rows[0][1].isdigit())
    ticks = os.sysconf('SC_CLK_TCK')
    require(type(ticks) is int and 0 < ticks <= 1000000)
    return {'bootId': boot, 'bootTimeSeconds': int(rows[0][1]), 'clockTicksPerSecond': ticks}


def supervisor_absence(point):
    """Corroborate unadmitted durable authority with an absent fixed supervisor unit."""
    require(re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', point))
    unit = 'orbis-core-capture-' + point + '.service'
    expected = {'LoadState': 'not-found', 'ActiveState': 'inactive', 'SubState': 'dead',
                'ControlGroup': '', 'InvocationID': '', 'MainPID': '0', 'ControlPID': '0', 'ExecMainPID': '0'}
    result = subprocess.run(['/usr/bin/systemctl', 'show', unit, '--no-pager',
        '--property=' + ','.join(expected)], capture_output=True, text=True, timeout=10, check=False)
    require(result.returncode in (0, 4) and len(result.stdout) <= 4096 and len(result.stderr) <= 4096)
    rows = [line.split('=', 1) for line in result.stdout.splitlines()]
    require(len(rows) == len(expected) and all(len(row) == 2 for row in rows)
            and len({row[0] for row in rows}) == len(expected) and dict(rows) == expected)
    return {'unit': unit, **expected}


@dataclass(frozen=True)
class RootRestartRetirementApproval:
    """An independently authenticated Root operator's exact programmatic confirmation."""
    actor: dict
    review_sha256: str
    confirmation_id: str


class CoreCaptureRestartRetirement:
    def __init__(self, manager, worker):
        require_platform(worker)
        self.manager, self.W = manager, worker
        self.A, self.P, self.H = worker.A, worker.P, worker.CORE.HOST
        self.root, self.state, self.context = Path(manager.root), Path(manager.state), manager.context
        self.namespace = worker.load('orbis-host-core-capture-namespace.py', 'restart_retirement_namespace')
        self.retirement = worker.load('orbis-host-core-capture-retirement.py', 'restart_retirement_rename')
        self.reservation = worker.load('orbis-host-core-capture-reservation.py', 'restart_retirement_point')
        self.base = self.state / 'core-capture-restart-retirements'
        with self.A.protected_directory(self.state):
            pass
        fence = self.H.capture_fence_path(self.root)
        # Intent publication must not change the selector parent being reviewed.
        require(self.state != fence.parent and not fence.parent.is_relative_to(self.base))

    def digest(self, value):
        return self.W.digest(self.P.canonical(value))

    def actor(self, actor):
        require(isinstance(actor, dict) and set(actor) == {'operatorId', 'authorizationSha256'})
        self.W.identifier(actor['operatorId'])
        require(isinstance(actor['authorizationSha256'], str) and self.W.HASH.fullmatch(actor['authorizationSha256']))
        return self.digest(actor)

    def transaction(self, point):
        return self.base / self.W.identifier(point)

    def _read(self, directory, name, *, immutable=False):
        with self.A.protected_directory(directory) as parent:
            with self.A.protected_file(parent, name, 65536) as body:
                info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                require(not immutable or stat.S_IMODE(info.st_mode) == 0o400)
                value = self.P.metadata(body, byte_limit=65536)
                require(isinstance(value, dict) and body == self.P.canonical(value))
                return value, {'sha256': self.W.digest(body), 'seal': list(self.A.seal(info))}

    def _directory(self, path, *, private=True):
        with self.A.protected_directory(path, private=private) as fd:
            return {'identity': list(self.W.identity(os.fstat(fd))), 'seal': list(self.A.seal(os.fstat(fd)))}

    def _absent(self, path):
        with self.A.protected_directory(path.parent) as fd:
            try:
                os.stat(path.name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                return self._directory(path.parent)
        raise RestartRetirementError('Capture operation authority or artifacts already exist')

    def _no_operations(self, point):
        paths = [self.state / 'core-capture-admissions' / point,
                 self.manager.capture.base / point,
                 self.manager.capture.snapshots / ('orbis-time-machine-core-' + point)]
        result = {}
        for path in paths:
            # Missing parent is allowed only below the protected state or snapshots root.
            if path.parent == self.state / 'core-capture-admissions' and not os.path.lexists(path.parent):
                with self.A.protected_directory(self.state) as parent:
                    require(not os.path.lexists(path.parent))
                    result['admissionParentAbsent'] = list(self.W.identity(os.fstat(parent)))
            else:
                result[path.parent.name] = self._absent(path)
        return result

    def _preparation(self, point):
        reserved = self.W.RESERVED.ReservedPreparation(self.W, self.state, self.root, self.context, point)
        reserved.require_undecided()
        intent = self.W.RESERVED.PreparationIntent(self.W, self.state, self.root, self.context, point)
        require(intent.selection() == self.H.capture_fence_path(self.root))
        expected = {**intent.preparation, 'schema': self.W.RESERVED.SCHEMA,
            'leaseNonce': intent.grant['nonce'], 'leaseSha256': self.W.digest(self.P.canonical(intent.grant)),
            'leaseIdentity': reserved.preparation['leaseIdentity']}
        require(reserved.preparation == expected and intent.grant == reserved.grant)
        records = {}
        with self.A.protected_directory(reserved.directory) as parent:
            require(set(os.listdir(parent)) == PREPARATION_FILES)
        for name in sorted(PREPARATION_FILES):
            value, records[name] = self._read(reserved.directory, name)
            if name == 'point-reservation.json':self.reservation.validate_reservation(value, point)
        return reserved, records

    def _storage_absence(self, namespace):
        handles, bindings, result = [], [], {}
        try:
            namespace.unchanged()
            parent = namespace.root
            for index, name in enumerate(('data', 'backups', 'time-machine')):
                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
                handles.append(fd);info = os.fstat(fd)
                require(info.st_uid == self.A.OWNER and not stat.S_IMODE(info.st_mode) & 0o022
                        and (index != 2 or stat.S_IMODE(info.st_mode) == 0o700))
                require(self.W.identity(info) == self.W.identity(os.stat(name, dir_fd=parent, follow_symlinks=False)))
                bindings.append((parent, name, fd, self.A.seal(info)))
                result[name] = {'identity': list(self.W.identity(info)), 'seal': list(self.A.seal(info))}
                parent = fd
            try:
                os.stat('core-capture', dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise RestartRetirementError('The entire source capture directory must be absent')
            for parent, name, fd, seal in bindings:
                require(self.A.seal(os.fstat(fd)) == seal
                        and self.A.seal(os.stat(name, dir_fd=parent, follow_symlinks=False)) == seal)
            namespace.unchanged()
            return result
        finally:
            for fd in reversed(handles):os.close(fd)

    def _point_reservation(self, namespace, point):
        """Read an empty current point for retirement; admission stays capturing-only."""
        handles, bindings, directories = [], [], {}
        try:
            namespace.unchanged()
            parent = namespace.root
            for index, name in enumerate(('data', 'backups', 'time-machine', 'points', point)):
                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
                handles.append(fd);info = os.fstat(fd)
                require(info.st_uid == self.A.OWNER and not stat.S_IMODE(info.st_mode) & 0o022
                        and (index < 2 or stat.S_IMODE(info.st_mode) == 0o700))
                seal = self.A.seal(info)
                require(seal == self.A.seal(os.stat(name, dir_fd=parent, follow_symlinks=False)))
                bindings.append((parent, name, fd, seal))
                directories[name] = list(seal)
                parent = fd
            require(set(os.listdir(parent)) == {'point.json'})
            fd = os.open('point.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
            handles.append(fd);info = os.fstat(fd);seal = self.A.seal(info)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == self.A.OWNER and info.st_nlink == 1
                    and stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= self.reservation.LIMIT)
            body = bytearray()
            while block := os.read(fd, min(8192, self.reservation.LIMIT + 1 - len(body))):
                body.extend(block);require(len(body) <= self.reservation.LIMIT)
            require(len(body) == info.st_size and self.A.seal(os.fstat(fd)) == seal
                    and self.A.seal(os.stat('point.json', dir_fd=parent, follow_symlinks=False)) == seal)
            value = json.loads(bytes(body).decode('utf-8'), object_pairs_hook=self.reservation.unique_object,
                               parse_constant=self.reservation.invalid_number)
            require(isinstance(value, dict)
                    and set(value) in (self.reservation.POINT_FIELDS, self.reservation.POINT_FIELDS | {'assetBytes'})
                    and value['kind'] == 'orbis-core' and value['coreFormat'] == 'orbis.time-machine-core.v1'
                    and value['status'] in ('capturing', 'interrupted') and value['core'] is None
                    and all(value[key] is None for key in ('backupJobId', 'archiveSha256', 'metadataSha256'))
                    and type(value['archiveBytes']) is int and value['archiveBytes'] == 0
                    and ('assetBytes' not in value or (type(value['assetBytes']) is int and value['assetBytes'] == 0)))
            issue = value['issue']
            require((value['status'] == 'capturing' and issue is None)
                    or (value['status'] == 'interrupted' and isinstance(issue, str) and 0 < len(issue) <= 4096))
            reservation = self.reservation.validate_reservation(
                {key: value[key] for key in self.reservation.FIELDS}, point)
            require(set(os.listdir(parent)) == {'point.json'})
            for parent_fd, name, directory_fd, directory_seal in bindings:
                require(self.A.seal(os.fstat(directory_fd)) == directory_seal
                        and self.A.seal(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)) == directory_seal)
            namespace.unchanged()
            return reservation, {'status': value['status'], 'sha256': self.W.digest(bytes(body)),
                'seal': list(seal), 'directories': directories,
                'issueSha256': None if issue is None else self.W.digest(issue.encode('utf-8'))}
        finally:
            for fd in reversed(handles):os.close(fd)

    def _observe(self, point, actor_sha, authority, reader, *, pinned_namespace=None):
        self.manager.require_owned_idle_core()
        current, records = self._preparation(point)
        require(current.preparation == authority.preparation and current.seals == authority.seals)
        original = authority.preparation['controller']
        observed = self.manager.observe(reader)
        frame = observed['controller']
        require(all(frame[key] == original[key] for key in ('id', 'imageId', 'definitionSha256')))
        require(observed['sourceSha256'] == authority.preparation['sourceSha256'])
        raw = reader._object(['container', 'inspect', '--format', '{{json .}}', frame['id']])
        state = raw['State']
        require(raw['Id'] == frame['id'] and raw['Image'] == frame['imageId']
                and state.get('Status') == 'running' and state.get('Running') is True
                and all(state.get(key) is False for key in ('Restarting', 'Paused', 'Dead', 'OOMKilled'))
                and state.get('StartedAt') == frame['startedAt'] and type(state.get('Pid')) is int and state['Pid'] > 0)
        boot = boot_witness()
        # The current Docker execution replaces the old execution of this exact
        # container. Wall-clock boot ordering is not used as reboot authority.
        require(original['startedAt'] != frame['startedAt']
                and timestamp(original['startedAt']) <= timestamp(state.get('FinishedAt')) < timestamp(frame['startedAt']))
        supervisor = supervisor_absence(point)
        retained, _ = authority.read('point-reservation.json')
        no_operations = self._no_operations(point)
        holder = (self.namespace.CaptureNamespace(self.W, reader, frame) if pinned_namespace is None
                  else nullcontext(pinned_namespace))
        with holder as namespace:
            require(namespace.pid == state['Pid'] and type(namespace.start) is int and namespace.start > 0)
            absent = self._storage_absence(namespace)
            reservation, point_record = self._point_reservation(namespace, point)
            require(reservation == retained
                    and self.reservation.sha256(reservation) == authority.preparation['pointReservationSha256'])
            process = {'pid': namespace.pid, 'startTicks': namespace.start,
                'procIdentity': list(self.W.identity(os.fstat(namespace.proc))),
                'mountIdentity': list(namespace.mount_identity), 'rootIdentity': list(namespace.root_identity)}
            namespace.unchanged()
        lease = authority.lease()
        path = self.H.capture_fence_path(self.root)
        require(lease.proof[1] == tuple(authority.preparation['leaseIdentity'][key] for key in self.W.RESERVED.IDENTITY_NAMES))
        return {'schema': REVIEW, 'id': point, 'root': str(self.root), 'context': self.context,
            'actorSha256': actor_sha, 'originalController': copy.deepcopy(original), 'newController': copy.deepcopy(frame),
            'priorFinishedAt': state['FinishedAt'], 'currentSourceSha256': observed['sourceSha256'],
            'currentBootObservation': boot, 'supervisorAbsent': supervisor,
            'process': process, 'preparationRecords': records,
            'preparationDirectory': self._directory(authority.directory),
            'preparationParent': self._directory(authority.directory.parent),
            'stateIdentity': self._directory(self.state)['identity'],
            'lease': {'sha256': self.W.digest(lease.proof[0]), 'seal': list(lease.proof[1]),
                      'parent': self._directory(path.parent, private=False)},
            'noOperations': no_operations, 'sourceDirectoryAbsent': absent, 'pointRecord': point_record, **POLICIES}

    def review(self, point, actor):
        require_platform(self.W);point = self.W.identifier(point);actor_sha = self.actor(actor)
        require(not os.path.lexists(self.transaction(point)))
        with self.manager.service.lock:
            authority, _ = self._preparation(point)
            with authority.lease().owner(), self.H.host_lock(self.root) as descriptor:
                reader = self.W.CORE.TX.APPS.Docker(self.context);reader.lock_fd = descriptor
                proof = self._observe(point, actor_sha, authority, reader)
                require(self._observe(point, actor_sha, authority, reader) == proof)
                return {'review': proof, 'reviewSha256': self.digest(proof)}

    def _mkdir(self, parent_path, name):
        with self.A.protected_directory(parent_path) as checked:
            identity = self.W.identity(os.fstat(checked));parent = os.dup(checked)
        try:
            os.mkdir(name, mode=0o700, dir_fd=parent);os.fsync(parent)
            require(self._directory(parent_path)['identity'] == list(identity))
        finally:os.close(parent)

    def _publish(self, directory, name, value):
        body = self.P.canonical(value);require(0 < len(body) <= 65536)
        with self.A.protected_directory(directory) as checked:
            identity = self.W.identity(os.fstat(checked));parent = os.dup(checked)
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o400, dir_fd=parent)
            try:
                view = memoryview(body)
                while view:
                    count = os.write(fd, view);require(count > 0);view = view[count:]
                os.fchmod(fd, 0o400);os.fsync(fd)
                info = os.fstat(fd)
                require(stat.S_ISREG(info.st_mode) and info.st_uid == self.A.OWNER and info.st_nlink == 1
                        and stat.S_IMODE(info.st_mode) == 0o400 and info.st_size == len(body)
                        and self.A.seal(info) == self.A.seal(os.stat(name, dir_fd=parent, follow_symlinks=False)))
            finally:os.close(fd)
            os.fsync(parent);require(self._directory(directory)['identity'] == list(identity))
            require(self._read(directory, name, immutable=True)[0] == value)
            return self._read(directory, name, immutable=True)[1]
        finally:os.close(parent)

    def _retired_name(self, point, confirmation):
        return 'capture-fence.json.retired-preparation-restart-v1-' + point + '-' + self.W.identifier(confirmation)

    def _lease_record(self, parent, name, proof, *, retired):
        with self.A.protected_file(parent, name, 8192) as body:
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            require(self.W.digest(body) == proof['lease']['sha256'])
            seal = list(self.A.seal(info));expected = proof['lease']['seal']
            require((seal[:-1] == expected[:-1]) if retired else seal == expected)
            return seal

    def apply(self, point, approval):
        require_platform(self.W);point = self.W.identifier(point)
        require(type(approval) is RootRestartRetirementApproval)
        actor_sha = self.actor(approval.actor);self.W.identifier(approval.confirmation_id)
        require(isinstance(approval.review_sha256, str) and self.W.HASH.fullmatch(approval.review_sha256))
        directory = self.transaction(point)
        if os.path.lexists(directory):return self.status(point, approval)
        with self.manager.service.lock:
            authority, _ = self._preparation(point)
            with authority.lease().owner(), self.H.host_lock(self.root) as descriptor:
                reader = self.W.CORE.TX.APPS.Docker(self.context);reader.lock_fd = descriptor
                proof = self._observe(point, actor_sha, authority, reader)
                require(self.digest(proof) == approval.review_sha256)
                require(self._observe(point, actor_sha, authority, reader) == proof)
                if not os.path.lexists(self.base):self._mkdir(self.state, self.base.name)
                self._mkdir(self.base, point)
                retired = self._retired_name(point, approval.confirmation_id)
                intent = {'schema': INTENT, 'id': point, 'root': str(self.root), 'context': self.context,
                    'reviewSha256': approval.review_sha256, 'actorSha256': actor_sha,
                    'confirmationId': approval.confirmation_id, 'retiredName': retired,
                    'directoryIdentity': self._directory(directory)['identity'], 'review': proof, **POLICIES}
                intent_pin = self._publish(directory, 'intent.json', intent)
                require(self._observe(point, actor_sha, authority, reader) == proof)
                receipt = self._prepared_receipt(point, intent, intent_pin)
                receipt_pin = self._publish(directory, 'receipt.json', receipt)
                path = self.H.capture_fence_path(self.root)
                with self.A.protected_directory(path.parent, private=False) as checked:
                    require(list(self.A.seal(os.fstat(checked))) == proof['lease']['parent']['seal'])
                    parent = os.dup(checked)
                try:
                    self._lease_record(parent, path.name, proof, retired=False)
                    original = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
                    try:
                        require(list(self.A.seal(os.fstat(original))) == proof['lease']['seal'])
                        with self.namespace.CaptureNamespace(self.W, reader, proof['newController']) as namespace:
                            require(self._observe(point, actor_sha, authority, reader, pinned_namespace=namespace) == proof)
                            require(self._read(directory, 'intent.json', immutable=True) == (intent, intent_pin))
                            require(self._read(directory, 'receipt.json', immutable=True) == (receipt, receipt_pin))
                            require(list(self.A.seal(os.fstat(parent))) == proof['lease']['parent']['seal'])
                            self._lease_record(parent, path.name, proof, retired=False)
                            # All validation and durable accounting precede the
                            # irreversible commit. The old fence protects old helpers too.
                            self.retirement.rename_noreplace(parent, path.name, retired)
                            os.fsync(parent)
                    finally:os.close(original)
                finally:os.close(parent)
        return self.status(point, approval)

    def _prepared_receipt(self, point, intent, intent_pin):
        return {'schema': RECEIPT, 'id': point, 'phase': 'retirement-prepared',
            'commit': 'atomic-lease-rename', 'intentSha256': self.digest(intent), 'intentSeal': intent_pin['seal'],
            'reviewSha256': intent['reviewSha256'], 'actorSha256': intent['actorSha256'],
            'retiredName': intent['retiredName'], 'leaseIdentity': intent['review']['lease']['seal'][:-1], **POLICIES}

    def _no_original_selector(self, parent, name, point, proof):
        path = self.H.capture_fence_path(self.root)
        try:
            os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return
        with self.A.protected_file(parent, name, 8192) as body:
            original = self.P.metadata(body, byte_limit=8192)
        with self.A.protected_file(parent, path.name, 8192) as body:
            current = self.P.metadata(body, byte_limit=8192)
            require(isinstance(current, dict) and set(current) == {'schema', 'id', 'root', 'context', 'nonce', 'sourceSha256'}
                    and current['schema'] == 'orbis.core-capture-lease.v1' and current['root'] == str(self.root)
                    and current['id'] != point and current['nonce'] != original['nonce']
                    and self.W.digest(body) != proof['lease']['sha256'] and self.P.canonical(current) == body
                    and isinstance(current['context'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', current['context'])
                    and all(isinstance(current[key], str) and self.W.HASH.fullmatch(current[key])
                            for key in ('nonce', 'sourceSha256')))
            self.W.identifier(current['id'])

    def status(self, point, approval):
        require_platform(self.W);point = self.W.identifier(point)
        require(type(approval) is RootRestartRetirementApproval)
        return self._status(point, self.actor(approval.actor), approval.review_sha256, approval.confirmation_id)

    def _status(self, point, actor_sha, review_sha, confirmation):
        self.W.identifier(confirmation)
        require(isinstance(actor_sha, str) and self.W.HASH.fullmatch(actor_sha)
                and isinstance(review_sha, str) and self.W.HASH.fullmatch(review_sha))
        directory = self.transaction(point)
        intent, pinned = self._read(directory, 'intent.json', immutable=True)
        require(set(intent) == {'schema', 'id', 'root', 'context', 'reviewSha256', 'actorSha256',
                                'confirmationId', 'retiredName', 'directoryIdentity', 'review'} | set(POLICIES)
                and intent.get('schema') == INTENT and intent.get('id') == point
                and intent.get('root') == str(self.root) and intent.get('context') == self.context
                and intent.get('actorSha256') == actor_sha
                and intent.get('confirmationId') == confirmation
                and intent.get('reviewSha256') == review_sha
                and intent.get('retiredName') == self._retired_name(point, confirmation)
                and self.digest(intent['review']) == review_sha
                and all(intent.get(key) == value for key, value in POLICIES.items()))
        require(self._directory(directory)['identity'] == intent['directoryIdentity'])
        proof = intent['review'];preparation = self.state / 'core-capture-preparations' / point
        require(proof.get('schema') == REVIEW and proof.get('id') == point
                and proof.get('root') == str(self.root) and proof.get('context') == self.context
                and proof.get('actorSha256') == actor_sha
                and set(proof.get('preparationRecords', {})) == PREPARATION_FILES
                and all(proof.get(key) == value for key, value in POLICIES.items()))
        with self.A.protected_directory(directory) as checked:
            require(set(os.listdir(checked)) in ({'intent.json'}, {'intent.json', 'receipt.json'}))
        require(self._directory(preparation) == proof['preparationDirectory']
                and self._directory(preparation.parent)['identity'] == proof['preparationParent']['identity'])
        for name, expected in proof['preparationRecords'].items():require(self._read(preparation, name)[1] == expected)
        self._no_operations(point)
        path = self.H.capture_fence_path(self.root)
        with self.A.protected_directory(path.parent, private=False) as parent:
            require(list(self.W.identity(os.fstat(parent))) == proof['lease']['parent']['identity'])
            try:self._lease_record(parent, intent['retiredName'], proof, retired=True)
            except FileNotFoundError:
                self._lease_record(parent, path.name, proof, retired=False)
                if os.path.lexists(directory / 'receipt.json'):
                    require(self._read(directory, 'receipt.json', immutable=True)[0]
                            == self._prepared_receipt(point, intent, pinned))
                return {'version': 1, 'id': point, 'state': 'operator-review-required-before-retirement',
                        'intentSha256': pinned['sha256'], **POLICIES}
            self._lease_record(parent, intent['retiredName'], proof, retired=True)
            self._no_original_selector(parent, intent['retiredName'], point, proof)
            os.fsync(parent)
        receipt, _ = self._read(directory, 'receipt.json', immutable=True)
        require(receipt == self._prepared_receipt(point, intent, pinned))
        return {'version': 1, 'id': point, 'state': 'preparation-retired',
                'intentSha256': pinned['sha256'], 'receiptSha256': self.digest(receipt), **POLICIES}

    def observe(self, point, reservation_sha):
        """Read an already committed Root decision; this grants no new retirement authority."""
        require_platform(self.W);point = self.W.identifier(point)
        require(isinstance(reservation_sha, str) and self.W.HASH.fullmatch(reservation_sha))
        pending = {'version': 1, 'id': point, 'state': 'not-retired',
                   'pointReservationSha256': reservation_sha, **POLICIES}
        with self.manager.service.lock:
            directory = self.transaction(point)
            if not os.path.lexists(directory):
                return pending
            intent, _ = self._read(directory, 'intent.json', immutable=True)
            result = self._status(point, intent.get('actorSha256'), intent.get('reviewSha256'), intent.get('confirmationId'))
            if result['state'] != 'preparation-retired':
                return pending
            preparation, _ = self._read(self.state / 'core-capture-preparations' / point, 'preparation.json')
            require(preparation.get('schema') == self.W.RESERVED.SCHEMA
                    and preparation.get('id') == point and preparation.get('root') == str(self.root)
                    and preparation.get('context') == self.context
                    and preparation.get('pointReservationSha256') == reservation_sha)
            record = intent['review']['pointRecord']
            require(isinstance(record.get('sha256'), str) and self.W.HASH.fullmatch(record['sha256'])
                    and record.get('status') in ('capturing', 'interrupted'))
            return {**result, 'pointReservationSha256': reservation_sha,
                    'pointRecordSha256': record['sha256'], 'sourceSha256': preparation['sourceSha256']}


def cli_arguments(argv=None):
    parser = argparse.ArgumentParser(description=(
        'Review or retire an unadmitted capture after a verified controller restart. '
        'Requires an independently authenticated root administration session.'))
    parser.add_argument('action', choices=('review', 'apply', 'status', 'observe'))
    for name in ('root', 'snapshots', 'state-dir'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--docker-context', required=True)
    parser.add_argument('--point', required=True)
    parser.add_argument('--operator-id', required=True)
    parser.add_argument('--authorization-sha256', required=True)
    parser.add_argument('--review-sha256')
    parser.add_argument('--confirmation-id')
    parser.add_argument('--point-reservation-sha256')
    args = parser.parse_args(argv)
    identifier = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
    if not identifier.fullmatch(args.point) or not identifier.fullmatch(args.operator_id):
        parser.error('Choose valid capture and operator identifiers.')
    if not re.fullmatch(r'[a-f0-9]{64}', args.authorization_sha256):
        parser.error('An independent root authorization digest is required.')
    if args.action in ('review', 'observe'):
        if args.review_sha256 is not None or args.confirmation_id is not None:
            parser.error('Review does not accept a prior confirmation.')
    elif (not isinstance(args.review_sha256, str) or not re.fullmatch(r'[a-f0-9]{64}', args.review_sha256)
          or not isinstance(args.confirmation_id, str) or not identifier.fullmatch(args.confirmation_id)):
        parser.error('Apply and status require the exact review digest and confirmation identifier.')
    if args.action == 'observe':
        if not isinstance(args.point_reservation_sha256, str) or not re.fullmatch(r'[a-f0-9]{64}', args.point_reservation_sha256):
            parser.error('Observation requires the exact point reservation digest.')
    elif args.point_reservation_sha256 is not None:
        parser.error('The reservation digest is only accepted for observation.')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', args.docker_context):
        parser.error('Choose a valid Docker context.')
    if any(not value.is_absolute() or '..' in value.parts for value in (args.root, args.snapshots, args.state_dir)):
        parser.error('Installation, snapshots and state paths must be absolute.')
    return args


def cli_context(args):
    spec = importlib.util.spec_from_file_location('orbis_restart_retirement_admin_service',
        Path(__file__).with_name('orbis-host-service.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    # An administrative observation must not mark the live daemon's job interrupted.
    service = module.HostService(args.root, args.docker_context, args.snapshots, args.state_dir,
                                 recover_interrupted_job=False)
    captures = module.load_script('orbis-host-core-capture-service.py', 'orbis_restart_retirement_admin_capture')
    return CoreCaptureRestartRetirement(captures.CoreCaptureService(service), captures.W)


def main(argv=None):
    args = cli_arguments(argv)
    require(os.geteuid() == 0 and os.uname().sysname == 'Linux')
    helper = cli_context(args)
    actor = {'operatorId': args.operator_id, 'authorizationSha256': args.authorization_sha256}
    if args.action == 'review':
        result = helper.review(args.point, actor)
    elif args.action == 'observe':
        result = helper.observe(args.point, args.point_reservation_sha256)
    else:
        approval = RootRestartRetirementApproval(actor, args.review_sha256, args.confirmation_id)
        result = getattr(helper, args.action)(args.point, approval)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, TypeError, KeyError, subprocess.SubprocessError):
        print('Capture preparation needs protected review. Retained data was preserved.', file=sys.stderr)
        raise SystemExit(1)
