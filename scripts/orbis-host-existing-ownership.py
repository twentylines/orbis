#!/usr/bin/env python3
"""Review and retain an independently approved existing Orbis ownership proof.

Only an independent Root decision can classify this exact deployment as never
managed. Missing recovery history is a veto check, not that decision.
Provisioning consumes that exact decision under the shared lifecycle fence.
Runtime admission additionally requires the current enrolled controller peer.
"""
import argparse
import copy
from contextlib import ExitStack, contextmanager
from contextvars import ContextVar
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import threading


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


B = load('orbis-host-ownership-bootstrap.py', 'orbis_existing_birth_reader')
C, K = B.C, B.K
OWNER = 0
SCHEMA = 'orbis.existing-ownership-review.v1'
AUTHORIZATION = 'orbis.existing-ownership-authorization.v1'
POLICY = 'root-reviewed-never-managed-existing-orbis.v1'
INTENT = 'orbis.existing-ownership-intent.v1'
PROOF = 'orbis.existing-ownership-proof.v1'
RECORDS = {'intent': 'existing-ownership-intent.json', 'decision': 'existing-ownership-decision.json',
           'proof': 'existing-ownership-proof.json', 'retired': 'existing-ownership-proof.retired.json'}
LIMIT = 32768
RECORD_LIMIT = 65536
FILES = ('docker-compose.yml', '.env', 'VERSION', 'user-config/tipi-compose.yml',
         'orbis-compose.yml', 'orbis-host-compose.yml')
OPTIONAL_FILES = frozenset({'user-config/tipi-compose.yml', 'orbis-compose.yml', 'orbis-host-compose.yml'})
_KEY = object()


def fail():
    raise ValueError('Existing ownership requires an exact independent Root decision; preserve installation and recovery custody for review.') from None


def authorization_path(service):
    root = service.root
    if not root.is_absolute() or str(root) != os.path.realpath(root): fail()
    namespace = service.HOST.AUTHORITY.LAYOUT.namespace(root)
    if os.path.lexists(namespace):
        return namespace / 'existing-ownership-authorization.json'
    path = root.parent / ('.' + root.name + '.orbis-existing-ownership-authorization.json')
    if len(os.fsencode(path.name)) > 255: fail()
    return path


@contextmanager
def data_root(service):
    """Pin reviewed data ancestry without treating it as Root authority."""
    root = service.root
    with service.HOST.AUTHORITY.LAYOUT.R._reviewed_ancestry(root) as (ancestry, check):
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            def verify():
                check()
                info = os.fstat(fd)
                actual = {'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid,
                          'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}
                if actual != ancestry[-1]: fail()
            verify()
            yield fd, copy.deepcopy(ancestry), verify
            verify()
        finally: os.close(fd)


class ObservedFile:
    """Bound Main data input, never a private decision, receipt or key reader.

    Existing installations may have user-owned data and ancestors. Their bytes
    are checked against enrolled publication and the independent Root decision;
    this object alone confers no trust or ownership authority.
    """
    def __init__(self, root, fd, verify_root, path, *, limit):
        self.path, self.file, self.directories = Path(path), None, []
        self.verify_root = verify_root
        try:
            if (not self.path.is_relative_to(root) or self.path == root
                    or str(self.path) != os.path.realpath(self.path)): fail()
            verify_root()
            current = os.dup(fd)
            self.directories.append((None, None, current, C.seal(os.fstat(current))[:5]))
            for name in self.path.relative_to(root).parts[:-1]:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=current)
                self.directories.append((current, name, child, C.seal(os.fstat(child))[:5])); current = child
                if os.fstat(child).st_mode & 0o002: fail()
            self.name = self.path.name
            self.file = os.open(self.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=current)
            info = os.fstat(self.file)
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o002
                    or not 0 <= info.st_size <= limit): fail()
            self.identity = C.seal(info)
            self.body = os.read(self.file, limit + 1)
            if len(self.body) != info.st_size: fail()
            self.verify()
        except BaseException:
            self.close(); raise

    def verify(self):
        self.verify_root()
        if self.file is None: fail()
        for parent, name, fd, identity in self.directories:
            if C.seal(os.fstat(fd))[:5] != identity: fail()
            if parent is not None and C.seal(os.stat(name, dir_fd=parent, follow_symlinks=False))[:5] != identity: fail()
        if (C.seal(os.fstat(self.file)) != self.identity or C.seal(os.stat(
                self.name, dir_fd=self.directories[-1][2], follow_symlinks=False)) != self.identity): fail()

    def close(self):
        if self.file is not None: os.close(self.file); self.file = None
        for _, _, fd, _ in reversed(self.directories): os.close(fd)
        self.directories.clear()


def require_guard(service, guard, *, hold=None):
    host, root = service.HOST, service.root
    if (os.geteuid() != OWNER or service.state_dir != host.AUTHORITY.LAYOUT.STATE_ROOT
            or not isinstance(guard, host.CREDENTIAL_FENCE._Guard)
            or guard._host.LOCK_DESCRIPTOR is not host.LOCK_DESCRIPTOR
            or guard._host.AUTHORITY is not host.AUTHORITY or guard._host.CREDENTIAL_FENCE is not host.CREDENTIAL_FENCE
            or guard._root != root or guard._context != service.context):
        fail()
    if hold is None:
        if guard.read() is not None: fail()
    else:
        guard.check(*hold)
    service.require_credential_idle(guard)
    host._require_no_capture_restore_fence(root)


def participation_paths(service):
    root, state = service.root, service.state_dir
    namespace = service.HOST.AUTHORITY.LAYOUT.namespace(root)
    legacy, pending = B.legacy_journal_paths(service.HOST.AUTHORITY.LAYOUT, root)
    # Known current and future credential state must not be hidden by the
    # absence of one configuration or a deleted active selector.
    return (state / C.CONFIG_NAME, B.RECOVERY, B.RECOVERY_ENV,
            B.receipt_path(root), B.pending_path(root), B.retired_path(root),
            *(namespace / name for name in ('credential-journal', 'recovery-admission-history.json',
                'recovery-admission-intent.json', 'recovery-admission-approvals', K.STATE, K.PENDING,
                K.STATE + '.completed.sqlite3', K.STATE + '.completed.sqlite3-journal',
                K.STATE + '.completed.sqlite3-wal', K.STATE + '.completed.sqlite3-shm')),
            legacy, pending, *(legacy.with_name(legacy.name + suffix) for suffix in (
                '.completed.sqlite3', '.completed.sqlite3-journal', '.completed.sqlite3-wal', '.completed.sqlite3-shm')))


def record_paths(service):
    namespace = service.HOST.AUTHORITY.LAYOUT.namespace(service.root)
    return {name: namespace / filename for name, filename in RECORDS.items()}


def require_no_participation(service, *, own_records=False):
    if any(os.path.lexists(path) for path in participation_paths(service)): fail()
    namespace = service.HOST.AUTHORITY.LAYOUT.namespace(service.root)
    if os.path.lexists(namespace):
        with service.HOST.CREDENTIAL_FENCE._directory(namespace, protected=True) as directory:
            names = os.listdir(directory.fd)
            allowed = set(RECORDS.values()) - {RECORDS['retired']} if own_records else set()
            allowed.add('existing-ownership-authorization.json')
            if own_records: allowed.add('credential-fence.json')
            if len(names) > 512 or any(name.lstrip('.').startswith(
                    ('credential-', 'recovery-', 'main-ownership-', 'controller-handoff', 'existing-ownership-'))
                    and name not in allowed for name in names):
                fail()


def _docker(service, arguments):
    value = service.HOST.docker(service.context, arguments, service.root)
    if value.returncode or len(value.stdout.encode()) > 1024 * 1024: fail()
    return json.loads(value.stdout, object_pairs_hook=C.pairs, parse_constant=lambda _: fail())


def local_daemon():
    value = subprocess.run(['/usr/bin/docker', '--config', str(Path(__file__).resolve().parent),
        '--host', 'unix:///var/run/docker.sock', 'info', '--format', '{{json .ID}}'],
        capture_output=True, text=True, timeout=15, check=False,
        env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
    if value.returncode or len(value.stdout.encode()) > 4096: fail()
    return json.loads(value.stdout)


def mount_identity(path):
    info = Path(path).stat()
    return info.st_dev, info.st_ino


def exposes(source, protected):
    if any(source == path or source in path.parents or path in source.parents for path in protected): return True
    identity = mount_identity(source)
    # A bind alias need not have the protected path's spelling. Compare the
    # source with existing protected objects and their directory ancestors.
    for path in protected:
        for parent in (path, *path.parents):
            try:
                if mount_identity(parent) == identity: return True
            except FileNotFoundError:
                continue
    return False


def _controller(service, publication, saved, daemon, *, protected=()):
    raw = _docker(service, ['inspect', '--format', '{{json .}}', 'runtipi'])
    if type(raw) is not dict: fail()
    state = raw.get('State', {})
    if (not K.valid_hash(raw.get('Id')) or type(raw.get('Image')) is not str
            or not re.fullmatch(r'sha256:[a-f0-9]{64}', raw['Image']) or raw.get('Name') != '/runtipi'
            or state.get('Running') is not True or state.get('Status') != 'running'
            or any(state.get(key) is not False for key in ('Paused', 'Restarting', 'Dead'))
            or type(state.get('Pid')) is not int or state['Pid'] <= 0
            or type(raw.get('RestartCount')) is not int or raw['RestartCount'] < 0
            or type(state.get('Health')) is not dict or state['Health'].get('Status') != 'healthy'
            or type(state.get('StartedAt')) is not str or not 1 <= len(state['StartedAt']) <= 128):
        fail()
    enrolled = service.controller_capture_identity(raw['Id'], raw['Image'], saved)
    if (type(enrolled) is not dict or enrolled.get('id') != raw['Id'] or enrolled.get('imageId') != raw['Image']
            or enrolled.get('releaseTag') != publication['tag'] or enrolled.get('releaseDigest') != publication['digest']
            or enrolled.get('startedAt') != state['StartedAt']): fail()
    definition = {name: raw.get(name) for name in ('Config', 'HostConfig', 'Mounts', 'Path', 'Args')}
    if (any(type(definition[name]) is not dict for name in ('Config', 'HostConfig'))
            or type(definition['Mounts']) is not list or type(definition['Path']) is not str
            or type(definition['Args']) is not list): fail()
    if definition['Config'].get('Image') != enrolled.get('imageReference'): fail()
    protected = (*participation_paths(service), service.root / service.HOST.STATE_NAME,
                 authorization_path(service), *record_paths(service).values(), *protected)
    for mount in definition['Mounts']:
        if type(mount) is not dict or type(mount.get('Source')) is not str or not mount['Source'].startswith('/'): fail()
        source = Path(os.path.realpath(mount['Source']))
        if exposes(source, protected): fail()
    if local_daemon() != daemon: fail()
    return {'id': raw['Id'], 'imageId': raw['Image'], 'definitionSha256': K.digest(definition),
            'epochSha256': K.digest({'pid': state['Pid'], 'startedAt': state['StartedAt'], 'restarts': raw['RestartCount']})}


def _reference(pin):
    return {'path': str(pin.path), 'sha256': hashlib.sha256(pin.body).hexdigest(), 'identity': list(pin.identity)}


def _layout(service, daemon, resources):
    layout, root = service.HOST.AUTHORITY.LAYOUT, service.root
    value = layout.read(root, daemon, service.context)
    namespace = layout.namespace(root)
    if value is None:
        if os.path.lexists(namespace): fail()
        return {'kind': 'legacy'}
    directory = resources.enter_context(service.HOST.CREDENTIAL_FENCE._directory(namespace, protected=True))
    pin = C.PinnedFile(namespace / 'layout.json', limit=65536, private=True); resources.callback(pin.close)
    if C.json_body(pin.body) != value: fail()
    return {'kind': 'adopted', 'receipt': _reference(pin), 'namespaceIdentity': list(C.seal(os.fstat(directory.fd))[:5])}


def _review(service, guard, *, hold=None, own_records=False):
    require_guard(service, guard, hold=hold)
    root, context = service.root, service.context
    if (not isinstance(root, Path) or not root.is_absolute() or root.resolve(strict=True) != root
            or type(context) is not str or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', context)):
        fail()
    require_no_participation(service, own_records=own_records)
    publication = copy.deepcopy(service.current_manifest())
    publication = service.HOST.PLAN.validate_manifest(publication)
    daemon = _docker(service, ['info', '--format', '{{json .ID}}'])
    if type(daemon) is not str or not 1 <= len(daemon) <= 256 or any(ord(c) < 33 or ord(c) > 126 for c in daemon): fail()
    with ExitStack() as resources:
        fd, ancestry, verify_root = resources.enter_context(data_root(service))
        identity = list(C.seal(os.fstat(fd))[:5])
        enrollment = ObservedFile(root, fd, verify_root, root / service.HOST.STATE_NAME, limit=16384)
        resources.callback(enrollment.close)
        saved = C.json_body(enrollment.body)
        if service.HOST.saved_state(root) != saved: fail()
        files, pins = {}, [enrollment]
        for name in FILES:
            path = root / name
            if name in OPTIONAL_FILES and not os.path.lexists(path):
                files[name] = None
            else:
                pin = ObservedFile(root, fd, verify_root, path, limit=1024 * 1024); resources.callback(pin.close)
                pins.append(pin); files[name] = _reference(pin)
        layout = _layout(service, daemon, resources)
        controller = _controller(service, publication, saved, daemon)
        require_guard(service, guard, hold=hold); require_no_participation(service, own_records=own_records)
        verify_root()
        if (service.root != root or service.context != context or list(C.seal(os.fstat(fd))[:5]) != identity
                or service.current_manifest() != publication or service.HOST.saved_state(root) != saved
                or _docker(service, ['info', '--format', '{{json .ID}}']) != daemon
                or _controller(service, publication, saved, daemon) != controller
                or _layout(service, daemon, resources) != layout
                or any(value is None and os.path.lexists(root / name) for name, value in files.items())):
            fail()
        for pin in pins: pin.verify()
        value = {'schema': SCHEMA, 'policy': POLICY, 'root': str(root), 'context': context,
                 'rootIdentity': identity, 'ancestry': ancestry, 'daemonSha256': hashlib.sha256(daemon.encode()).hexdigest(),
                 'installationId': K.digest({'root': str(root), 'context': context, 'daemon': daemon, 'rootIdentity': identity}),
                 'publication': {**{key: publication[key] for key in ('tag', 'commit', 'digest')},
                                 'manifestSha256': K.digest(publication)},
                 'enrollment': _reference(enrollment), 'controller': controller, 'layout': layout, 'files': files}
        if len(K.canonical(value)) > LIMIT: fail()
        return value


def review(service, guard):
    """Observe the installed publisher/enrollment; publish no decision or grant."""
    return _review(service, guard)


class ExistingDecision:
    """A live independent decision witness, never a Main ownership grant."""
    def __init__(self, key, service, guard, plan, pin):
        if key is not _KEY: fail()
        self.service, self.guard, self.pin = service, guard, pin
        self._plan, self._body = K.canonical(plan), bytes(pin.body)
        self.pid, self.thread, self.live = os.getpid(), threading.get_ident(), True

    @property
    def plan(self):
        return K.decoded(self._plan)

    def verify(self):
        if (not self.live or self.pid != os.getpid() or self.thread != threading.get_ident()
                or K.canonical(review(self.service, self.guard)) != self._plan): fail()
        self.pin.verify()
        if self.pin.body != self._body: fail()
        decision = C.json_body(self._body)
        return {'authorizationSha256': hashlib.sha256(self._body).hexdigest(), 'planSha256': decision['planSha256'],
                'approvalId': decision['approvalId'], 'installationId': self.plan['installationId'],
                'authorizationPath': str(self.pin.path)}


@contextmanager
def authorized(service, guard, *, authorization_sha256):
    if not K.valid_hash(authorization_sha256): fail()
    plan = review(service, guard)
    pin = C.PinnedFile(authorization_path(service), limit=LIMIT, private=True)
    witness = None
    try:
        value = C.json_body(pin.body)
        if (set(value) != {'schema', 'policy', 'planSha256', 'approvalId'}
                or value['schema'] != AUTHORIZATION or value['policy'] != POLICY
                or value['planSha256'] != K.digest(plan) or not K.valid_hash(value['approvalId'])
                or hashlib.sha256(pin.body).hexdigest() != authorization_sha256
                or pin.body != K.canonical(value) + b'\n'): fail()
        witness = ExistingDecision(_KEY, service, guard, plan, pin)
        witness.verify(); yield witness; witness.verify()
    finally:
        if witness is not None: witness.live = False
        pin.close()


class Issuer:
    """Retain one Root decision; no credential grant or caller-supplied plan.

    The immutable intent follows the lifecycle hold, and the completed proof
    follows durable consumption of the decision. Partial or ambiguous custody
    is never removed, repaired or converted into a fresh authorization.
    """
    def __init__(self, service):
        self.service = service
        self.paths = record_paths(service)

    def _guard(self, guard, *, hold=None):
        require_guard(self.service, guard, hold=hold)
        namespace = self.service.HOST.AUTHORITY.LAYOUT.namespace(self.service.root)
        if (guard._directory.path != namespace or guard._selected != namespace / 'credential-fence.json'
                or not guard._directory.protected): fail()
        if os.path.lexists(self.paths['retired']): fail()

    def _intent(self, plan, authorization, decision):
        if (type(plan) is not dict or plan.get('schema') != SCHEMA or plan.get('policy') != POLICY
                or plan.get('root') != str(self.service.root) or plan.get('context') != self.service.context
                or plan.get('layout', {}).get('kind') != 'adopted'
                or type(authorization) is not dict or set(authorization) != {'path', 'sha256', 'identity'}
                or authorization['path'] != str(authorization_path(self.service))
                or not K.valid_hash(authorization['sha256']) or type(authorization['identity']) is not list
                or len(authorization['identity']) != 9 or any(type(v) is not int for v in authorization['identity'])
                or type(decision) is not dict or set(decision) != {'schema', 'policy', 'planSha256', 'approvalId'}
                or decision['schema'] != AUTHORIZATION or decision['policy'] != POLICY
                or decision['planSha256'] != K.digest(plan) or not K.valid_hash(decision['approvalId'])
                or hashlib.sha256(K.canonical(decision) + b'\n').hexdigest() != authorization['sha256']): fail()
        identifier = K.digest({'schema': INTENT, 'root': str(self.service.root), 'context': self.service.context,
                               'planSha256': K.digest(plan), 'authorizationSha256': authorization['sha256']})
        value = {'schema': INTENT, 'operationId': identifier, 'plan': copy.deepcopy(plan),
                 'authorization': copy.deepcopy(authorization), 'decision': copy.deepcopy(decision)}
        return {**value, 'admissionBinding': K.digest(value)}

    def _read(self, name, resources, *, limit=RECORD_LIMIT):
        pin = C.PinnedFile(self.paths[name], limit=limit, private=True)
        resources.callback(pin.close)
        value = C.json_body(pin.body)
        if pin.body != K.canonical(value) + b'\n': fail()
        return value, pin

    def _retained(self, resources, authorization_sha256=None):
        value, pin = self._read('intent', resources)
        if (type(value) is not dict or set(value) != {'schema', 'operationId', 'admissionBinding', 'plan', 'authorization', 'decision'}
                or self._intent(value['plan'], value['authorization'], value['decision']) != value
                or authorization_sha256 is not None and value['authorization']['sha256'] != authorization_sha256): fail()
        return value, pin

    def _publish(self, guard, name, value, hold):
        self._guard(guard, hold=hold)
        body = K.canonical(value) + b'\n'
        if name not in ('intent', 'proof') or not 0 < len(body) <= RECORD_LIMIT: fail()
        fd = os.open(self.paths[name].name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=guard._directory.fd)
        try:
            os.fchmod(fd, 0o600)
            remaining = memoryview(body)
            while remaining:
                count = os.write(fd, remaining)
                if count <= 0: fail()
                remaining = remaining[count:]
            os.fsync(fd)
        finally: os.close(fd)
        os.fsync(guard._directory.fd)
        self._guard(guard, hold=hold)

    def _consumed(self, value, resources):
        if os.path.lexists(authorization_path(self.service)): fail()
        decision, pin = self._read('decision', resources, limit=LIMIT)
        original = value['authorization']
        # link/unlink changes ctime. Inode, owner, mode, length and mtime must
        # remain the exact approved file; a copied body is insufficient.
        if (decision != value['decision'] or hashlib.sha256(pin.body).hexdigest() != original['sha256']
                or any(pin.identity[i] != original['identity'][i] for i in (0, 1, 2, 3, 4, 6, 7))): fail()
        return pin

    def _consume(self, guard, value, hold):
        self._guard(guard, hold=hold)
        origin, destination = authorization_path(self.service), self.paths['decision']
        pin = C.PinnedFile(origin, limit=LIMIT, private=True)
        try:
            if _reference(pin) != value['authorization']: fail()
            pin.verify(); before = pin.identity
            os.link(origin.name, destination.name, src_dir_fd=guard._directory.fd,
                    dst_dir_fd=guard._directory.fd, follow_symlinks=False)
            os.fsync(guard._directory.fd)
            linked = C.seal(os.fstat(pin.file))
            if (linked[5] != 2 or any(linked[i] != before[i] for i in (0, 1, 2, 3, 4, 6, 7))
                    or any(C.seal(os.stat(name, dir_fd=guard._directory.fd, follow_symlinks=False)) != linked
                           for name in (origin.name, destination.name))): fail()
            self._guard(guard, hold=hold)
            os.unlink(origin.name, dir_fd=guard._directory.fd)
            os.fsync(guard._directory.fd)
        finally: pin.close()

    def _check_plan(self, guard, value, *, hold):
        self._guard(guard, hold=hold)
        current = _review(self.service, guard, hold=hold, own_records=True)
        if current != value['plan']: fail()

    def _completed(self, guard, authorization_sha256, *, hold):
        with ExitStack() as resources:
            value, intent = self._retained(resources, authorization_sha256)
            decision = self._consumed(value, resources)
            proof, pin = self._read('proof', resources)
            expected = {'schema': PROOF, 'operationId': value['operationId'], 'admissionBinding': value['admissionBinding'],
                        'intent': _reference(intent), 'decision': _reference(decision)}
            if proof != expected: fail()
            self._check_plan(guard, value, hold=hold)
            for opened in (intent, decision, pin): opened.verify()
            return {'schema': PROOF, 'operationId': value['operationId'], 'proofSha256': hashlib.sha256(pin.body).hexdigest(),
                    'installationId': value['plan']['installationId'], 'planSha256': K.digest(value['plan'])}

    def provision(self, guard, *, authorization_sha256):
        """Consume a separately created decision and retain its exact proof.

        Repeating a completed issuance is read-only. An interruption after the
        hold but before its intent, a partial file or a double-linked decision
        remains held for separate reconciliation.
        """
        if not K.valid_hash(authorization_sha256): fail()
        marker = guard.read()
        if marker is None:
            self._guard(guard)
        else:
            # Validate the real guard now; accept only the retained exact
            # operation below, never the marker's untrusted values as policy.
            require_guard(self.service, guard, hold=(marker['operationId'], marker['admissionBinding']))
        if not os.path.lexists(self.paths['intent']):
            if marker is not None or any(os.path.lexists(p) for p in self.paths.values()): fail()
            with authorized(self.service, guard, authorization_sha256=authorization_sha256) as witness:
                witness.verify()
                value = self._intent(witness.plan, _reference(witness.pin), C.json_body(witness.pin.body))
            self._guard(guard)
            hold = value['operationId'], value['admissionBinding']
            guard.begin(*hold)
            self._publish(guard, 'intent', value, hold)
        with ExitStack() as resources:
            value, intent = self._retained(resources, authorization_sha256)
            hold = value['operationId'], value['admissionBinding']
            if marker is None and os.path.lexists(self.paths['proof']):
                return self._completed(guard, authorization_sha256, hold=None)
            self._guard(guard, hold=hold)
            self._check_plan(guard, value, hold=hold)
            if not os.path.lexists(self.paths['decision']):
                if os.path.lexists(self.paths['proof']): fail()
                self._consume(guard, value, hold)
            decision = self._consumed(value, resources)
            self._check_plan(guard, value, hold=hold)
            if not os.path.lexists(self.paths['proof']):
                self._publish(guard, 'proof', {'schema': PROOF, 'operationId': value['operationId'],
                    'admissionBinding': value['admissionBinding'], 'intent': _reference(intent), 'decision': _reference(decision)}, hold)
            for opened in (intent, decision): opened.verify()
            result = self._completed(guard, authorization_sha256, hold=hold)
            def completed():
                return self._completed(guard, authorization_sha256, hold=hold) == result
            guard.finish(*hold, verify_completed=completed)
            return result


def present(service):
    namespace = service.HOST.AUTHORITY.LAYOUT.namespace(service.root)
    if not os.path.lexists(namespace): return False
    with service.HOST.CREDENTIAL_FENCE._directory(namespace, protected=True) as directory:
        return any(name.lstrip('.').startswith('existing-ownership-') for name in os.listdir(directory.fd))


def _namespace_guard(service, guard):
    if (os.geteuid() != OWNER or service.state_dir != service.HOST.AUTHORITY.LAYOUT.STATE_ROOT
            or not isinstance(guard, service.HOST.CREDENTIAL_FENCE._Guard)
            or guard._host.LOCK_DESCRIPTOR is not service.HOST.LOCK_DESCRIPTOR
            or guard._host.AUTHORITY is not service.HOST.AUTHORITY
            or guard._host.CREDENTIAL_FENCE is not service.HOST.CREDENTIAL_FENCE
            or guard._root != service.root or guard._context != service.context
            or guard._directory.path != service.HOST.AUTHORITY.LAYOUT.namespace(service.root)
            or guard._selected != guard._directory.path / 'credential-fence.json'
            or not guard._directory.protected): fail()
    guard._check(); service.require_credential_idle(guard)


class ProofChain:
    """Pinned historical Root decision, separate from a current producer grant."""
    def __init__(self, service, resources):
        self.service = service
        issuer = Issuer(service)
        self.value, self.intent = issuer._retained(resources)
        self.decision = issuer._consumed(self.value, resources)
        proof, self.pin = issuer._read('proof', resources)
        if proof != {'schema': PROOF, 'operationId': self.value['operationId'], 'admissionBinding': self.value['admissionBinding'],
                     'intent': _reference(self.intent), 'decision': _reference(self.decision)}: fail()
        self.plan = self.value['plan']
        self.reference = {'schema': PROOF, 'proof': _reference(self.pin), 'installationId': self.plan['installationId'],
                          'planSha256': K.digest(self.plan)}
        self.verify()

    def verify(self):
        if os.path.lexists(authorization_path(self.service)): fail()
        for pin in (self.intent, self.decision, self.pin): pin.verify()


def _kernel(service, guard, *, chain=None):
    kernel = K.OwnershipAuthority(service.HOST, service.root, service.context, lambda: None)
    state = kernel._read(guard)
    marker = guard.read()
    row = None
    if chain is None:
        if state['active'] is not None: fail()
    elif marker is None:
        if state['active'] is not None: fail()
    else:
        row = state['operations'].get(marker['operationId']) or kernel._archived(guard, state, 'operation_id', marker['operationId'])
        if (row is None or state['active'] != (marker['operationId'] if row['phase'] == 'pending' else None)
                or K.digest(row['admission']) != marker['admissionBinding']
                or row['admission']['authorityEpoch'] != chain.reference['proof']['sha256']
                or row['admission']['installationId'] != chain.plan['installationId']): fail()
    # Completion durably records a zero-count ledger identity before its first
    # archive is allocated. Only that exact completed row under its still-live
    # matching hold can finish the allocation; absence alone grants nothing.
    allocating = (row is not None and row['phase'] == 'completed' and state['completed'] is not None
                  and state['completed']['count'] == 0
                  and not os.path.lexists(guard._directory.path / kernel._ledger_name(guard)))
    if allocating:
        if any(os.path.lexists(guard._directory.path / (kernel._ledger_name(guard) + suffix))
               for suffix in ('-journal', '-wal', '-shm')): fail()
    else:
        try:
            with kernel._ledger(guard, state['completed']): pass
        except ValueError:
            # The immutable receipt may have committed just before JSON row
            # removal. Accept only its single exact ahead receipt, read-only.
            if row is None or row['phase'] != 'completed' or state['completed'] is None: raise
            ahead = copy.deepcopy(state)
            ahead['completed']['count'] += 1
            if kernel._archived(guard, ahead, 'operation_id', marker['operationId']) != row: fail()
    return state


def _layout_scope(service, chain, resources):
    fd, ancestry, verify = resources.enter_context(data_root(service))
    identity = list(C.seal(os.fstat(fd))[:5])
    daemon = _docker(service, ['info', '--format', '{{json .ID}}'])
    if (type(daemon) is not str or hashlib.sha256(daemon.encode()).hexdigest() != chain.plan['daemonSha256']
            or local_daemon() != daemon or identity != chain.plan['rootIdentity'] or ancestry != chain.plan['ancestry']
            or _layout(service, daemon, resources) != chain.plan['layout']
            or K.digest({'root': str(service.root), 'context': service.context, 'daemon': daemon,
                         'rootIdentity': identity}) != chain.plan['installationId']): fail()
    verify(); chain.verify()
    return fd, identity, verify, daemon


class RuntimeProof:
    """Root scope for observed Main data; private decisions stay Root-only."""
    def __init__(self, service, guard):
        self.service, self.guard = service, guard
        self.resources = ExitStack()
        try:
            _namespace_guard(service, guard)
            self.chain = ProofChain(service, self.resources)
            self.verify()
        except BaseException:
            self.close(); raise

    def verify(self):
        _namespace_guard(self.service, self.guard)
        self.chain.verify()
        if os.path.lexists(record_paths(self.service)['retired']): fail()
        namespace = self.service.HOST.AUTHORITY.LAYOUT.namespace(self.service.root)
        kernel_names = {K.STATE, K.PENDING, *(K.STATE + '.completed.sqlite3' + suffix for suffix in ('', '-journal', '-wal', '-shm'))}
        if any(os.path.lexists(p) for p in participation_paths(self.service) if p.parent != namespace or p.name not in kernel_names): fail()
        allowed = {*RECORDS.values(), 'credential-fence.json', *kernel_names}
        with self.service.HOST.CREDENTIAL_FENCE._directory(namespace, protected=True) as directory:
            names = os.listdir(directory.fd)
            if len(names) > 512 or any(n.lstrip('.').startswith(('existing-ownership-', 'credential-', 'recovery-',
                    'main-ownership-', 'controller-handoff')) and n not in allowed for n in names): fail()
        _kernel(self.service, self.guard, chain=self.chain)

    @contextmanager
    def enrollment(self):
        self.verify()
        with ExitStack() as resources:
            fd, identity, verify, daemon = _layout_scope(self.service, self.chain, resources)
            pin = ObservedFile(self.service.root, fd, verify, self.service.root / self.service.HOST.STATE_NAME, limit=16384)
            resources.callback(pin.close)
            saved = C.json_body(pin.body)
            publication = self.service.HOST.PLAN.validate_manifest(copy.deepcopy(self.service.current_manifest()))
            if saved != self.service.HOST.saved_state(self.service.root): fail()
            controller = _controller(self.service, publication, saved, daemon)
            yield copy.deepcopy(saved), tuple(identity)
            if (self.service.current_manifest() != publication or self.service.HOST.saved_state(self.service.root) != saved
                    or _controller(self.service, publication, saved, daemon) != controller): fail()
            pin.verify(); verify(); self.verify()

    def binding(self):
        self.verify()
        return {'installationId': self.chain.plan['installationId'], 'authorityEpoch': self.chain.reference['proof']['sha256']}

    def close(self):
        self.resources.close()

    def __enter__(self):
        self.verify(); return self

    def __exit__(self, *_):
        self.close()


class ExistingService(B.BootstrapService):
    """Current peer plus retained Root proof, independent of recovery origin."""
    def __init__(self, service, *, enrollment):
        if not callable(enrollment) or service.state_dir != service.HOST.AUTHORITY.LAYOUT.STATE_ROOT: fail()
        self.service, self.enrollment = service, enrollment
        self.peer, self.current_guard = ContextVar('existing_ownership_peer', default=None), ContextVar('existing_ownership_guard', default=None)
        self.authority = K.OwnershipAuthority(service.HOST, service.root, service.context, self.scope)

    @contextmanager
    def scope(self):
        guard, witness = self.current_guard.get(), self.peer.get()
        if guard is None or witness is None: fail()
        def admitted():
            _namespace_guard(self.service, guard)
            witness.verify()
            peer, bound = witness.identity(), witness.ownership_binding()
            if peer.get('installationId') != bound.get('installationId'): fail()
            return K.admission({'schema': K.ADMISSION, 'mode': 'unmanaged', 'managedEver': False,
                **{key: peer[key] for key in ('installationId', 'controllerId', 'imageId', 'controllerEpoch')},
                'authorityEpoch': bound['authorityEpoch']})
        admitted(); yield guard, admitted; admitted()

    def request(self, connection, operation, data, *, peer_module):
        if not self.service.lock.acquire(blocking=False): fail()
        try:
            with self.service.HOST.credential_fence_lock(self.service.root, self.service.context) as guard:
                with peer_module.admit_existing(self.service, connection, host=self.service.HOST,
                                               enrollment=self.enrollment, guard=guard) as witness:
                    a, b = self.current_guard.set(guard), self.peer.set(witness)
                    try: return self.dispatch(operation, data)
                    finally: self.peer.reset(b); self.current_guard.reset(a)
        finally: self.service.lock.release()

    def close(self):
        pass


def _retirement_value(value, reference):
    fields = {'schema', 'proof', 'operationId', 'admissionBinding', 'planSha256', 'authorizationSha256'}
    if (type(value) is not dict or set(value) != fields or value['schema'] != PROOF + '.retired'
            or value['proof'] != reference or not all(K.valid_hash(value[k]) for k in fields - {'schema', 'proof'})): fail()
    return value


def retirement_reference(service):
    """Stable live/retired proof binding for the independently approved plan.

    This is historical custody only. The recovery supervisor independently
    verifies its stopped controller and publication, daemon and layout.
    """
    if not present(service): return None
    with ExitStack() as resources:
        chain = ProofChain(service, resources)
        _layout_scope(service, chain, resources)
        retired = record_paths(service)['retired']
        if os.path.lexists(retired):
            pin = C.PinnedFile(retired, limit=RECORD_LIMIT, private=True); resources.callback(pin.close)
            value = _retirement_value(C.json_body(pin.body), chain.reference)
            if pin.body != K.canonical(value) + b'\n': fail()
            pin.verify()
        chain.verify()
        return copy.deepcopy(chain.reference)


def retire_for_admission(service, guard, expected, *, plan_sha256, authorization_sha256):
    """Called only after Admission verifies its independent exact Root policy.

    Keep the original proof immutable. The permanent tombstone precedes every
    managed-admission publication and makes old/cached runtime readers refuse.
    """
    _namespace_guard(service, guard)
    marker = guard.read()
    if marker is None or not K.valid_hash(plan_sha256) or not K.valid_hash(authorization_sha256): fail()
    actual = retirement_reference(service)
    if actual != expected: fail()
    if actual is None: return
    if expected['installationId'] != K.digest({'root': str(service.root), 'context': service.context,
            'daemon': _docker(service, ['info', '--format', '{{json .ID}}']),
            'rootIdentity': list(C.seal(service.root.stat())[:5])}): fail()
    _kernel(service, guard)
    path = record_paths(service)['retired']
    if os.path.lexists(path): return
    value = {'schema': PROOF + '.retired', 'proof': actual, 'operationId': marker['operationId'],
             'admissionBinding': marker['admissionBinding'], 'planSha256': plan_sha256,
             'authorizationSha256': authorization_sha256}
    body = K.canonical(value) + b'\n'
    fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                 0o600, dir_fd=guard._directory.fd)
    try:
        os.fchmod(fd, 0o600)
        remaining = memoryview(body)
        while remaining:
            count = os.write(fd, remaining)
            if count <= 0: fail()
            remaining = remaining[count:]
        os.fsync(fd)
    finally: os.close(fd)
    os.fsync(guard._directory.fd)
    _namespace_guard(service, guard); guard.check(marker['operationId'], marker['admissionBinding'])
    if retirement_reference(service) != expected: fail()


def require_host():
    if os.sys.platform != 'linux' or os.geteuid() != OWNER: fail()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('review', 'provision'))
    parser.add_argument('root', type=Path)
    parser.add_argument('--docker-context', required=True)
    parser.add_argument('--snapshots', type=Path, required=True)
    parser.add_argument('--authorization-sha256')
    args = parser.parse_args()
    try:
        require_host()
        module = load('orbis-host-service.py', 'orbis_existing_review_service')
        service = module.HostService(args.root, args.docker_context, args.snapshots, module.HOST.AUTHORITY.LAYOUT.STATE_ROOT,
                                     recover_interrupted_job=False, credentials_only=True)
        with service.HOST.credential_fence_lock(service.root, service.context) as guard:
            if args.action == 'review':
                if args.authorization_sha256 is not None: fail()
                plan = review(service, guard)
                result = {'plan': plan, 'planSha256': K.digest(plan)}
            else:
                result = Issuer(service).provision(guard, authorization_sha256=args.authorization_sha256)
        print(json.dumps(result, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.SubprocessError):
        print('Existing ownership review could not establish bound Root custody; all data was preserved.', file=os.sys.stderr)
        return 1


if __name__ == '__main__': raise SystemExit(main())
