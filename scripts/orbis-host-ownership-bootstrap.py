"""Positive Root birth proof for a new, nonparticipating installation.

Only the empty-target installer creates this receipt, before publishing files or
starting Core. Reading an absent or partial recovery configuration never creates
one. Existing installations require their own qualified authority transition.
"""
import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import secrets
import stat
from contextlib import ExitStack, contextmanager
from contextvars import ContextVar
from types import SimpleNamespace


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


C = load('orbis-host-credential-service.py', 'orbis_ownership_bootstrap_private')
K = load('orbis-host-ownership-authority.py', 'orbis_ownership_bootstrap_kernel')
OWNER = 0
SCHEMA = 'orbis.main-ownership-bootstrap.v1'
LIMIT = 16384
RECOVERY = Path('/var/lib/orbis-sentinel/recovery')
RECOVERY_ENV = Path('/etc/orbis-sentinel/recovery.env')
RESERVED = frozenset({'runtipi', 'runtipi-db', 'runtipi-queue', 'runtipi-reverse-proxy'})
INSTALLER_STORAGE_PROTOCOL = 'orbis.installer.storage.v1'


def fail():
    raise ValueError('Positive installation ownership proof is unavailable; preserve Root custody for review.') from None


def custody(host, root, daemon=None, context=None):
    """Read positive adopted Root storage; an existing invalid layout refuses."""
    layout = host.AUTHORITY.LAYOUT
    namespace = layout.namespace(root)
    if not os.path.lexists(namespace): return None
    read = getattr(layout, 'read', None)
    if not callable(read): fail()
    value = read(root, daemon, context)
    if type(value) is not dict: fail()
    with host.CREDENTIAL_FENCE._directory(namespace, protected=True) as directory:
        pin = C.PinnedFile(namespace / 'layout.json', limit=65536, private=True)
        try:
            if C.json_body(pin.body) != value: fail()
            pin.verify()
            return {'kind': 'adopted', 'receipt': {'path': str(pin.path),
                'sha256': hashlib.sha256(pin.body).hexdigest(), 'identity': list(pin.identity)},
                'namespaceIdentity': list(C.seal(os.fstat(directory.fd))[:5])}
        finally: pin.close()


def control_directory(host, root, daemon=None, context=None):
    return host.AUTHORITY.LAYOUT.namespace(root) if custody(host, root, daemon, context) is not None else Path(root).parent


def installer_storage(host, root, context=None):
    selected = custody(host, root, context=context)
    return {'schema': INSTALLER_STORAGE_PROTOCOL, 'custody': selected} if selected is not None else None


def verify_installer_storage(host, root, reference, context=None):
    selected = installer_storage(host, root, context)
    if (reference is None) != (selected is None):
        raise ValueError('Installer storage changed; preserve the protected transaction for review.')
    if selected is not None:
        try:
            matches = type(reference) is dict and K.canonical(reference) == K.canonical(selected)
        except (TypeError, ValueError):
            matches = False
        if not matches:
            raise ValueError('Installer storage changed; preserve the protected transaction for review.')
    return selected


def installer_pointer_path(host, root, context=None):
    root = Path(root)
    legacy = root / '.orbis-installation.json'
    selected = installer_storage(host, root, context)
    if selected is None:
        return legacy
    if os.path.lexists(legacy):
        raise ValueError('A legacy installer marker needs reconciliation before protected recovery.')
    return host.AUTHORITY.LAYOUT.namespace(root) / 'installer-pointer.json'


def receipt_path(root, host=None):
    root = Path(root)
    if not root.is_absolute() or root.resolve(strict=True) != root:
        fail()
    path = (host.AUTHORITY.LAYOUT.namespace(root) / 'main-ownership-bootstrap.json' if host is not None
            and custody(host, root) is not None else root.parent / ('.' + root.name + '.orbis-main-ownership-bootstrap.json'))
    if len(os.fsencode(path.name + '.pending')) > 255:
        fail()
    return path


def root_identity(root):
    """Observed data identity, never the private authority for that data."""
    details = root.lstat()
    if (not stat.S_ISDIR(details.st_mode) or details.st_mode & 0o002
            or root.resolve(strict=True) != root):
        fail()
    return [details.st_dev, details.st_ino, details.st_uid, details.st_gid, details.st_mode]


def retired_path(root, host=None):
    path = receipt_path(root, host)
    if len(os.fsencode(path.name + '.retired')) > 255:
        fail()
    return path.with_name(path.name + '.retired')


def pending_path(root, host=None):
    path = receipt_path(root, host)
    return path.with_name(path.name + '.pending')


def legacy_journal_paths(layout, root):
    selected = layout.legacy_path(root, 'credential-fence')
    suffix = 'credential-fence.json'
    if not selected.name.endswith(suffix):
        fail()
    name = selected.name[:-len(suffix)] + K.STATE
    # Qualify every future authority filename before publishing birth proof.
    # SQLite's rollback journal has the longest suffix in this private cohort.
    if max(len(os.fsencode('.' + name + '.pending')), len(os.fsencode(name + '.completed.sqlite3-journal'))) > 255:
        fail()
    return selected.parent / name, selected.parent / ('.' + name + '.pending')


def vetoes(host, root):
    # These are additional vetoes, never the evidence that makes a caller
    # unmanaged. Positive birth custody and current enrolled peer are required.
    layout = host.AUTHORITY.LAYOUT
    return (pending_path(root), retired_path(root), layout.namespace(root), layout.STATE_ROOT / C.CONFIG_NAME, RECOVERY, RECOVERY_ENV,
            *(layout.legacy_path(root, kind) for kind in ('retained-authority', 'capture-fence', 'restore-selector')))


def require_no_transition(host, root, *, own_pending=False, proof=None):
    adopted = custody(host, root) if proof is not None else None
    if proof is not None and proof.get('custody') != adopted: fail()
    if adopted is not None:
        namespace = host.AUTHORITY.LAYOUT.namespace(root)
        if any(os.path.lexists(path) for path in (receipt_path(root), pending_path(root, host), retired_path(root, host))
               if not (own_pending and path == pending_path(root, host))): fail()
        with host.CREDENTIAL_FENCE._directory(namespace, protected=True) as directory:
            allowed = {'main-ownership-bootstrap.json', 'credential-fence.json', K.STATE, K.PENDING,
                       *(K.STATE + suffix for suffix in ('.completed.sqlite3', '.completed.sqlite3-journal',
                                                        '.completed.sqlite3-wal', '.completed.sqlite3-shm'))}
            if own_pending: allowed.add(pending_path(root, host).name)
            names = os.listdir(directory.fd)
            if len(names) > 512 or any(name.lstrip('.').startswith(
                    ('credential-', 'recovery-', 'main-ownership-', 'controller-handoff',
                     'existing-ownership-', 'bootstrap-', 'storage-migration-')) and name not in allowed for name in names): fail()
    if any(os.path.lexists(path) for path in vetoes(host, root)
           if not (adopted is not None and path == host.AUTHORITY.LAYOUT.namespace(root))
           if not (own_pending and path == pending_path(root))):
        fail()


def validate(value):
    fields = {'schema', 'root', 'context', 'daemonSha256', 'rootIdentity', 'installationId', 'birthId', 'initialPublication'}
    if (type(value) is not dict or set(value) not in (fields, fields | {'custody'}) or value['schema'] != SCHEMA
            or type(value['root']) is not str or not Path(value['root']).is_absolute()
            or type(value['context']) is not str or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', value['context'])
            or any(not K.valid_hash(value[key]) for key in ('daemonSha256', 'installationId', 'birthId'))
            or type(value['rootIdentity']) is not list or len(value['rootIdentity']) != 5
            or any(type(part) is not int or part < 0 for part in value['rootIdentity'])):
        fail()
    if 'custody' in value:
        selected = value['custody']
        if (type(selected) is not dict or set(selected) != {'kind', 'receipt', 'namespaceIdentity'}
                or selected['kind'] != 'adopted' or type(selected['receipt']) is not dict
                or set(selected['receipt']) != {'path', 'sha256', 'identity'}
                or type(selected['receipt']['path']) is not str or not Path(selected['receipt']['path']).is_absolute()
                or not K.valid_hash(selected['receipt']['sha256'])
                or type(selected['receipt']['identity']) is not list or len(selected['receipt']['identity']) != 9
                or type(selected['namespaceIdentity']) is not list or len(selected['namespaceIdentity']) != 5
                or any(type(n) is not int or n < 0 for n in (*selected['receipt']['identity'], *selected['namespaceIdentity']))): fail()
    publication = value['initialPublication']
    if (type(publication) is not dict or set(publication) != {'tag', 'commit', 'digest', 'manifestSha256'}
            or type(publication['tag']) is not str or not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?', publication['tag'])
            or type(publication['commit']) is not str or not re.fullmatch(r'[a-f0-9]{40}', publication['commit'])
            or type(publication['digest']) is not str or not re.fullmatch(r'sha256:[a-f0-9]{64}', publication['digest'])
            or not K.valid_hash(publication['manifestSha256'])):
        fail()
    return value


def prepare_new(host, root, reader, manifest):
    """Root installer only, with its real host lock and empty target witness.

    A failed or repeated issuance never overwrites the old receipt. No caller
    supplies a managed/unmanaged flag, epoch, process or installation identity.
    """
    root = Path(root)
    if os.geteuid() != OWNER or host.LOCK_DESCRIPTOR.get() is None:
        fail()
    manifest = copy.deepcopy(host.PLAN.require_installation_protocol(manifest))
    context = reader.context
    if type(context) is not str or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', context):
        fail()
    path = receipt_path(root, host)
    fence = host.CREDENTIAL_FENCE
    with fence._directory(control_directory(host, root), protected=True) as parent, fence._directory(root, protected=False) as target:
        identity = root_identity(root)
        daemon = reader.daemon()
        if (type(daemon) is not str or not 1 <= len(daemon) <= 256
                or any(ord(char) < 33 or ord(char) > 126 for char in daemon)):
            fail()
        selected = custody(host, root, daemon, context)

        def check(*, own_pending=False):
            parent.check()
            target.check()
            require_no_transition(host, root, own_pending=own_pending, proof=value if selected is not None else None)
            if selected is not None:
                allowed = {'layout.json', 'host.lock'}
                if own_pending: allowed.add(pending_path(root, host).name)
                # An empty data folder cannot erase a namespace's prior life.
                # Only a new reviewed namespace with no other custody qualifies.
                if not set(os.listdir(parent.fd)) <= allowed: fail()
            if any(os.path.lexists(path) for path in legacy_journal_paths(host.AUTHORITY.LAYOUT, root)):
                fail()
            if any(os.path.lexists(root.parent / ('.' + root.name + suffix))
                   for suffix in ('.orbis-proxy-identity', '.orbis-proxy-identity.json')):
                fail()
            if (reader.context != context or root_identity(root) != identity or os.listdir(target.fd)
                    or reader.daemon() != daemon
                    or any(row.get('name') in RESERVED for row in reader.containers())):
                fail()
            # The installer already holds this exact legacy lock. Rechecking
            # its opened identity prevents a replaced-name lock from issuing.
            fd = host.LOCK_DESCRIPTOR.get()
            if host.AUTHORITY.LAYOUT._lock_identity(os.fstat(fd)) != host.AUTHORITY.LAYOUT._lock_identity(
                    host.AUTHORITY.LAYOUT.legacy_path(root, 'host-lock').lstat()):
                fail()
            host._require_no_capture_restore_fence(root)
            fence.require_clear(host, root)

        value = {'schema': SCHEMA, 'root': str(root), 'context': context,
                 'daemonSha256': hashlib.sha256(daemon.encode()).hexdigest(), 'rootIdentity': identity,
                 'installationId': K.digest({'root': str(root), 'context': context,
                                            'daemon': daemon, 'rootIdentity': identity}),
                 'birthId': secrets.token_hex(32), 'initialPublication': {
                     **{key: manifest[key] for key in ('tag', 'commit', 'digest')},
                     'manifestSha256': K.digest(manifest)}}
        if selected is not None: value['custody'] = selected
        check()
        body = K.canonical(validate(value)) + b'\n'
        if len(body) > LIMIT:
            fail()
        if os.path.lexists(path):
            raise FileExistsError('Initial ownership proof already exists; preserve it for review.')
        pending = pending_path(root, host)
        out = os.open(pending.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                      0o600, dir_fd=parent.fd)
        try:
            os.fchmod(out, 0o600)
            remaining = memoryview(body)
            while remaining:
                count = os.write(out, remaining)
                if count <= 0:
                    fail()
                remaining = remaining[count:]
            os.fsync(out)
        finally:
            os.close(out)
        os.fsync(parent.fd)
        check(own_pending=True)
        staged = C.PinnedFile(pending, limit=LIMIT, private=True)
        try:
            if staged.body != body:
                fail()
            staged.verify()
            # An incomplete issuance is never a live proof. Exclusive linking
            # avoids overwriting a concurrent or previously retained receipt.
            os.link(pending.name, path.name, src_dir_fd=parent.fd, dst_dir_fd=parent.fd, follow_symlinks=False)
            os.fsync(parent.fd)
            os.unlink(pending.name, dir_fd=parent.fd)
            os.fsync(parent.fd)
        finally:
            staged.close()
        pinned = C.PinnedFile(path, limit=LIMIT, private=True)
        try:
            if pinned.body != body:
                fail()
        finally:
            pinned.close()
        return {'schema': SCHEMA, 'path': str(path), 'sha256': hashlib.sha256(body).hexdigest()}


def verify_reference(host, root, context, daemon_sha256, reference):
    root = Path(root)
    if (type(reference) is not dict or set(reference) != {'schema', 'path', 'sha256'}
            or reference['schema'] != SCHEMA or reference['path'] != str(receipt_path(root, host))
            or not K.valid_hash(reference['sha256'])):
        fail()
    pin = C.PinnedFile(receipt_path(root, host), limit=LIMIT, private=True)
    try:
        value = validate(C.json_body(pin.body))
        if (pin.body != K.canonical(value) + b'\n' or hashlib.sha256(pin.body).hexdigest() != reference['sha256']
                or value['root'] != str(root) or value['context'] != context
                or value['daemonSha256'] != daemon_sha256 or value['rootIdentity'] != root_identity(root)):
            fail()
        require_no_transition(host, root, proof=value)
        pin.verify()
        return value
    finally:
        pin.close()


def retire_for_layout(root, layout, legacy_lock):
    """Narrow birth authority before an independently approved layout transition.

    Requires the layout module's live enrollment lock. This archives existing
    proof; it approves no layout or recovery action and creates no replacement
    unmanaged claim. The tombstone remains outside the new authority mount.
    """
    root = Path(root)
    fd = layout.ENROLLMENT_DESCRIPTOR.get()
    if (os.geteuid() != OWNER or fd is None or layout._lock_identity(os.fstat(fd)) != legacy_lock
            or layout._lock_identity(layout.legacy_path(root, 'host-lock').lstat()) != legacy_lock):
        fail()
    layout._no_legacy_authority(root)
    if os.path.lexists(pending_path(root)):
        fail()
    original, retired = receipt_path(root), retired_path(root)
    if not os.path.lexists(original):
        if os.path.lexists(retired):
            pin = C.PinnedFile(retired, limit=LIMIT, private=True)
            try:
                value = validate(C.json_body(pin.body))
                if (pin.body != K.canonical(value) + b'\n' or value['root'] != str(root)
                        or value['rootIdentity'] != root_identity(root)):
                    fail()
            finally:
                pin.close()
        return
    journal, pending = legacy_journal_paths(layout, root)
    if os.path.lexists(pending):
        fail()
    if os.path.lexists(journal):
        record = C.PinnedFile(journal, limit=K.LIMIT, private=True)
        try:
            value = K.validate(K.decoded(record.body))
            if record.body != K.canonical(value) + b'\n' or value['active'] is not None:
                fail()
        finally:
            record.close()
    pin = C.PinnedFile(original, limit=LIMIT, private=True)
    try:
        value = validate(C.json_body(pin.body))
        if (pin.body != K.canonical(value) + b'\n' or value['root'] != str(root)
                or value['rootIdentity'] != root_identity(root)):
            fail()
        parent = pin.fds[-1][1]
        pin.verify()
        # Link is exclusive and durable before removing the live name. A crash
        # leaves either retired proof or two links, both of which deny grants.
        os.link(original.name, retired.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        os.fsync(parent)
        if (os.stat(retired.name, dir_fd=parent, follow_symlinks=False).st_ino != os.fstat(pin.file).st_ino
                or os.stat(original.name, dir_fd=parent, follow_symlinks=False).st_ino != os.fstat(pin.file).st_ino):
            fail()
        os.unlink(original.name, dir_fd=parent)
        os.fsync(parent)
    finally:
        pin.close()


class BootstrapService:
    """Narrow Root reader/issuer; no recovery realm, runtime or key is required."""
    def __init__(self, service, *, enrollment):
        if (not callable(enrollment) or service.state_dir != service.HOST.AUTHORITY.LAYOUT.STATE_ROOT):
            fail()
        self.service, self.enrollment = service, enrollment
        self.peer = ContextVar('orbis_ownership_bootstrap_peer', default=None)
        self.current_guard = ContextVar('orbis_ownership_bootstrap_guard', default=None)
        self.pin = C.PinnedFile(receipt_path(service.root, service.HOST), limit=LIMIT, private=True)
        try:
            self.value = validate(C.json_body(self.pin.body))
            if self.pin.body != K.canonical(self.value) + b'\n':
                fail()
            self.authority = K.OwnershipAuthority(service.HOST, service.root, service.context, self.scope)
        except BaseException:
            self.pin.close()
            raise

    @contextmanager
    def scope(self):
        host, root = self.service.HOST, self.service.root
        guard = self.current_guard.get()
        if guard is None: fail()
        # request() holds this exact guard before it observes the producer.
        # Kernel scopes reuse it, so data observation and authority cannot race
        # enrollment, and no nested acquisition of the same flock is needed.
        with _live_guard(self.service, guard):
            def admitted():
                self.pin.verify()
                require_no_transition(host, root, proof=self.value)
                witness = self.peer.get()
                if witness is None:
                    fail()
                witness.verify()
                peer = witness.identity()
                binding = witness.installation_binding()
                value = self.value
                if (value['root'] != str(root) or value['context'] != self.service.context
                        or value['rootIdentity'] != root_identity(root)
                        or value['installationId'] != peer.get('installationId')
                        or binding.get('root') != str(root) or binding.get('context') != self.service.context
                        or type(binding.get('daemon')) is not str
                        or hashlib.sha256(binding['daemon'].encode()).hexdigest() != value['daemonSha256']):
                    fail()
                self.service.require_credential_idle(guard)
                return K.admission({'schema': K.ADMISSION, 'mode': 'unmanaged', 'managedEver': False,
                                    **{key: peer[key] for key in ('installationId', 'controllerId', 'imageId', 'controllerEpoch')},
                                    'authorityEpoch': hashlib.sha256(self.pin.body).hexdigest()})
            admitted()
            yield guard, admitted
            admitted()

    def request(self, connection, operation, data, *, peer_module):
        if not C.acquire_request_lock(self.service.lock):
            fail()
        try:
            with self.service.HOST.credential_fence_lock(self.service.root, self.service.context) as guard:
                with peer_module.admit_bootstrap(self.service, connection, host=self.service.HOST,
                                                 enrollment=self.enrollment, guard=guard) as witness:
                    token, current = self.peer.set(witness), self.current_guard.set(guard)
                    try:
                        return self.dispatch(operation, data)
                    finally:
                        self.current_guard.reset(current); self.peer.reset(token)
        finally:
            self.service.lock.release()

    def dispatch(self, operation, data):
        if operation in ('ownership-prepare', 'ownership-check', 'ownership-complete'):
            fields = {'ownership-prepare': {'requestId', 'purpose'},
                      'ownership-check': {'operationId', 'admissionBinding', 'purpose'},
                      'ownership-complete': {'operationId', 'admissionBinding', 'purpose', 'disposition'}}
            if (type(data) is not dict or set(data) != fields[operation]
                    or type(data['purpose']) is not str or data['purpose'] not in K.PURPOSES):
                fail()
            if operation == 'ownership-prepare':
                return self.authority.prepare(data['requestId'], data['purpose'])
            args = data['operationId'], data['admissionBinding'], data['purpose']
            if operation == 'ownership-check':
                return self.authority.check(*args)
            return self.authority.complete(*args, data['disposition'])
        with self.scope() as (guard, admitted):
            proof = admitted()
            if guard.read() is not None or self.authority._read(guard)['active'] is not None:
                fail()
            binding = K.digest(proof)
            if operation == 'admission' and data == {}:
                return {'mode': 'unmanaged', 'binding': binding}
            if operation == 'change-admission' and data == {}:
                return {'protocol': 'root-ownership', 'mode': 'unmanaged', 'binding': binding}
            if (operation == 'counter-challenge' and type(data) is dict
                    and set(data) == {'admissionBinding', 'purpose', 'ceremonyBinding'}
                    and data['admissionBinding'] == binding and data['purpose'] in ('login', 'sensitive')
                    and K.valid_hash(data['ceremonyBinding'])):
                return {'mode': 'unmanaged', 'admissionBinding': binding}
            fail()

    def close(self):
        self.pin.close()


@contextmanager
def _live_guard(service, guard):
    host = service.HOST
    if (os.geteuid() != OWNER or service.state_dir != host.AUTHORITY.LAYOUT.STATE_ROOT
            or not isinstance(guard, host.CREDENTIAL_FENCE._Guard)
            or guard._host.LOCK_DESCRIPTOR is not host.LOCK_DESCRIPTOR or guard._host.AUTHORITY is not host.AUTHORITY
            or guard._host.CREDENTIAL_FENCE is not host.CREDENTIAL_FENCE
            or guard._root != service.root or guard._context != service.context
            or guard._directory.path != control_directory(host, service.root)
            or guard._selected != host.AUTHORITY.LAYOUT.selected_path(service.root, 'credential-fence')
            or not guard._directory.protected): fail()
    guard._check(); service.require_credential_idle(guard)
    yield guard
    guard._check()


def _observations():
    return load('orbis-host-existing-ownership.py', 'orbis_birth_data_observations')


class BirthRuntime:
    """Positive private birth custody plus current observed Main enrollment.

    The parent and proof retain private Root protection. Main data need not be
    Root-owned: its exact identity is bound by the positive empty-target issuer.
    This reader never classifies an existing installation from absence.
    """
    def __init__(self, service, guard):
        self.service, self.guard, self.pin = service, guard, None
        self.observed = _observations()
        try:
            with _live_guard(service, guard):
                self.pin = C.PinnedFile(receipt_path(service.root, service.HOST), limit=LIMIT, private=True)
                self.value = validate(C.json_body(self.pin.body))
                if self.pin.body != K.canonical(self.value) + b'\n': fail()
                self.verify()
        except BaseException:
            self.close(); raise

    def verify(self):
        with _live_guard(self.service, self.guard):
            self.pin.verify()
            value = self.value
            require_no_transition(self.service.HOST, self.service.root, proof=value)
            if (value['root'] != str(self.service.root) or value['context'] != self.service.context
                    or value['rootIdentity'] != root_identity(self.service.root)): fail()
            # The same kernel checks apply to a birth floor and an independently
            # approved existing floor. Only the private proof hash differs.
            floor = SimpleNamespace(reference={'proof': {'sha256': hashlib.sha256(self.pin.body).hexdigest()}}, plan=value)
            self.observed._kernel(self.service, self.guard, chain=floor)

    @contextmanager
    def enrollment(self):
        self.verify()
        root, host = self.service.root, self.service.HOST
        with ExitStack() as resources:
            fd, _, verify = resources.enter_context(self.observed.data_root(self.service))
            identity = list(C.seal(os.fstat(fd))[:5])
            if identity != self.value['rootIdentity']: fail()
            pin = self.observed.ObservedFile(root, fd, verify, root / host.STATE_NAME, limit=16384)
            resources.callback(pin.close)
            saved = C.json_body(pin.body)
            publication = host.PLAN.validate_manifest(copy.deepcopy(self.service.current_manifest()))
            daemon = self.observed._docker(self.service, ['info', '--format', '{{json .ID}}'])
            if (type(daemon) is not str or hashlib.sha256(daemon.encode()).hexdigest() != self.value['daemonSha256']
                    or self.value['installationId'] != K.digest({'root': str(root), 'context': self.service.context,
                        'daemon': daemon, 'rootIdentity': identity}) or host.saved_state(root) != saved): fail()
            protected = (receipt_path(root, host),)
            controller = self.observed._controller(self.service, publication, saved, daemon, protected=protected)
            yield copy.deepcopy(saved), tuple(identity)
            if (host.saved_state(root) != saved or self.service.current_manifest() != publication
                    or self.observed._controller(self.service, publication, saved, daemon, protected=protected) != controller): fail()
            pin.verify(); verify(); self.verify()

    def close(self):
        if self.pin is not None: self.pin.close()

    def __enter__(self):
        self.verify(); return self

    def __exit__(self, *_):
        self.close()
