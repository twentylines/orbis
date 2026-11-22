#!/usr/bin/env python3
"""Review legacy deployment custody without issuing account ownership authority.

An independent Root decision may authorize the exact never-managed legacy plan.
This module cannot create that authorization, infer it from missing recovery
configuration, or authorize replacement/reset. Fresh still needs its separate
durable transaction permit and stopped-controller checks.
"""
import argparse
import copy
from contextlib import ExitStack, contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import threading
from types import SimpleNamespace


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


B = load('orbis-host-ownership-bootstrap.py', 'orbis_legacy_birth_reader')
E = load('orbis-host-existing-ownership.py', 'orbis_legacy_data_observer')
C, K = B.C, B.K
OWNER = 0
SCHEMA = 'orbis.legacy-ownership-review.v1'
AUTHORIZATION = 'orbis.legacy-ownership-authorization.v1'
POLICY = 'root-reviewed-never-managed-legacy.v1'
LIMIT = 16384
FILES = ('docker-compose.yml', '.env', 'VERSION', 'user-config/tipi-compose.yml', 'orbis-host-compose.yml')
OPTIONAL_FILES = frozenset({'user-config/tipi-compose.yml', 'orbis-host-compose.yml'})
_KEY = object()


def fail():
    raise ValueError('Legacy ownership requires an exact independent Root authorization; preserve deployment and recovery custody for review.') from None


def _adopted(host, root, reader=None):
    layout = host.AUTHORITY.LAYOUT
    if not os.path.lexists(layout.namespace(root)):
        return None
    read = getattr(layout, 'read', None)
    if not callable(read):
        fail()
    value = read(root, reader.daemon(), reader.context) if reader is not None else read(root)
    if type(value) is not dict:
        fail()
    return value


def authorization_path(root, host=None, reader=None):
    root = Path(root)
    if (not root.is_absolute() or str(root) != os.path.realpath(root)
            or len(os.fsencode('.' + root.name + '.orbis-legacy-ownership-authorization.json')) > 255):
        fail()
    if host is not None and _adopted(host, root, reader) is not None:
        return host.AUTHORITY.LAYOUT.namespace(root) / 'legacy-ownership-authorization.json'
    return root.parent / ('.' + root.name + '.orbis-legacy-ownership-authorization.json')


def require_lock(host, root, reader):
    if os.geteuid() != OWNER:
        fail()
    fd = host.LOCK_DESCRIPTOR.get()
    layout = host.AUTHORITY.LAYOUT
    if fd is None or getattr(reader, 'lock_fd', None) != fd:
        fail()
    paths = layout.lock_paths(root)
    expected = [layout.legacy_path(root, 'host-lock')]
    if _adopted(host, root, reader) is not None:
        expected.append(layout.namespace(root) / 'host.lock')
    if (paths != expected
            or layout._lock_identity(os.fstat(fd)) != layout._lock_identity(paths[0].lstat())):
        fail()
    host._require_no_capture_restore_fence(root)
    host.CREDENTIAL_FENCE.require_clear(host, root)


def transition_vetoes(host, root, *, fresh_records=()):
    # Absence is a veto check only. The separate positive Root decision is still
    # mandatory, even when this whole cohort is absent.
    layout = host.AUTHORITY.LAYOUT
    authority, pending = B.legacy_journal_paths(layout, root)
    namespace = layout.namespace(root)
    adopted = _adopted(host, root) is not None
    selected = namespace if adopted else root.parent
    if any(path.parent != selected or not re.fullmatch(
            r'\.orbis-fresh-ownership-[a-f0-9]{64}-[a-f0-9]{64}(?:\.[a-z-]+)?\.json', path.name)
            for path in fresh_records): fail()
    birth = (B.receipt_path(root, host), B.pending_path(root, host), B.retired_path(root, host)) if adopted else ()
    if adopted:
        with host.CREDENTIAL_FENCE._directory(namespace, protected=True) as directory:
            names = os.listdir(directory.fd)
            allowed = {path.name for path in (*fresh_records, *birth)}
            if fresh_records: allowed.add('credential-fence.json')
            if len(names) > 512 or any(name.lstrip('.').startswith(
                    ('credential-', 'recovery-', 'main-ownership-', 'controller-handoff',
                     'existing-ownership-', 'bootstrap-', 'storage-migration-',
                     'orbis-fresh-ownership-', 'orbis-main-ownership-')) and name not in allowed for name in names):
                fail()
    return (*(path for path in B.vetoes(host, root) if not (adopted and path == namespace)), *birth, B.receipt_path(root), authority, pending,
              authority.with_name(authority.name + '.completed.sqlite3'),
              authority.with_name(authority.name + '.completed.sqlite3-journal'),
              authority.with_name(authority.name + '.completed.sqlite3-wal'),
              authority.with_name(authority.name + '.completed.sqlite3-shm'),
              root / 'orbis-compose.yml', root / host.STATE_NAME)


def require_no_transition(host, root):
    if any(os.path.lexists(path) for path in transition_vetoes(host, root)):
        fail()
    host.require_no_capture_fence(root)
    if host.saved_state(root) is not None:
        fail()


def _controller(root, reader, *, protected=()):
    rows = reader.containers()
    if type(rows) is not list:
        fail()
    selected = [row for row in rows if type(row) is dict and row.get('name') == 'runtipi']
    if len(selected) != 1 or not K.valid_hash(selected[0].get('id')):
        fail()
    value = reader._object(['container', 'inspect', '--format', '{{json .}}', selected[0]['id']])
    if type(value) is not dict or any(type(value.get(key)) is not dict for key in ('Config', 'HostConfig', 'State')):
        fail()
    config, state = value['Config'], value['State']
    labels = config.get('Labels')
    if (value.get('Id') != selected[0]['id'] or value.get('Name') != '/runtipi'
            or not re.fullmatch(r'sha256:[a-f0-9]{64}', str(value.get('Image', '')))
            or config.get('Image') != 'ghcr.io/runtipi/runtipi:v4.10.1'
            or type(labels) is not dict or labels.get('com.docker.compose.project') != 'runtipi'
            or labels.get('com.docker.compose.service') != 'runtipi'
            or labels.get('com.docker.compose.project.working_dir') != str(root)
            or value['HostConfig'].get('ContainerIDFile')
            or state.get('Status') != 'running' or state.get('Running') is not True
            or state.get('Paused') is not False or state.get('Restarting') is not False or state.get('Dead') is not False
            or type(state.get('Pid')) is not int or state['Pid'] <= 0
            or type(state.get('Health')) is not dict or state['Health'].get('Status') != 'healthy'
            or type(state.get('StartedAt')) is not str or not 1 <= len(state['StartedAt']) <= 128
            or type(value.get('RestartCount')) is not int or value['RestartCount'] < 0):
        fail()
    mounts = value.get('Mounts')
    if type(mounts) is not list or any(type(row) is not dict for row in mounts):
        fail()
    if protected:
        for mount in mounts:
            source = mount.get('Source')
            if (type(source) is not str or not source.startswith('/')
                    or E.exposes(Path(os.path.realpath(source)), protected)):
                fail()
    for destination, relative in (('/data/.env', '.env'), ('/data/state', 'state'), ('/cache', 'cache')):
        matches = [row for row in mounts if row.get('Destination') == destination]
        if (len(matches) != 1 or matches[0].get('Type') != 'bind'
                or matches[0].get('Source') != str(root / relative) or matches[0].get('RW') is not True):
            fail()
    return {'id': value['Id'], 'imageId': value['Image'],
            'configurationSha256': K.digest({key: value[key] for key in ('Config', 'HostConfig', 'Mounts')}),
            'epochSha256': K.digest({'pid': state['Pid'], 'startedAt': state['StartedAt'], 'restartCount': value['RestartCount']})}


def _storage(root, resources, *, data=None):
    result = {}
    for name in ('state', 'cache'):
        path = root / name
        if str(path) != os.path.realpath(path):
            fail()
        descriptor = resources.enter_context(_directory(path, parent_fd=data[0] if data else None))
        info = os.fstat(descriptor)
        if not stat.S_ISDIR(info.st_mode) or info.st_mode & (0o002 if data else 0o022):
            fail()
        result[name] = list(C.seal(info)[:5])
    if data:
        data[2]()
    return result


@contextmanager
def _directory(path, *, parent_fd=None):
    # Data can belong to Main's service account. Adopted data is opened relative
    # to its observed root; private control custody is pinned separately.
    fd = os.open(path if parent_fd is None else path.name,
                 os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd)
    try:
        before = C.seal(os.fstat(fd))[:5]
        def named():
            return os.stat(path if parent_fd is None else path.name, dir_fd=parent_fd, follow_symlinks=False)
        if C.seal(named())[:5] != before:
            fail()
        yield fd
        if C.seal(os.fstat(fd))[:5] != before or C.seal(named())[:5] != before:
            fail()
    finally:
        os.close(fd)


def review(host, root, reader, manifest):
    """Read under the existing Root installer lock; never publish a policy."""
    root = Path(root)
    require_lock(host, root, reader)
    manifest = copy.deepcopy(host.PLAN.require_installation_protocol(manifest))
    context = reader.context
    if type(context) is not str or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', context):
        fail()
    identity = B.root_identity(root)
    daemon = reader.daemon()
    if (type(daemon) is not str or not 1 <= len(daemon) <= 256
            or any(ord(char) < 33 or ord(char) > 126 for char in daemon)):
        fail()
    require_no_transition(host, root)
    with ExitStack() as resources:
        adopted = _adopted(host, root, reader)
        data, custody, layout_pin, protected = None, None, None, ()
        if adopted is None:
            resources.enter_context(host.CREDENTIAL_FENCE._directory(root.parent, protected=True))
        else:
            namespace = host.AUTHORITY.LAYOUT.namespace(root)
            directory = resources.enter_context(host.CREDENTIAL_FENCE._directory(namespace, protected=True))
            layout_pin = C.PinnedFile(namespace / 'layout.json', limit=65536, private=True)
            resources.callback(layout_pin.close)
            if C.json_body(layout_pin.body) != adopted:
                fail()
            custody = {'kind': 'adopted', 'receipt': {'path': str(layout_pin.path),
                'sha256': hashlib.sha256(layout_pin.body).hexdigest(), 'identity': list(layout_pin.identity)},
                'namespaceIdentity': list(C.seal(os.fstat(directory.fd))[:5])}
            data = resources.enter_context(E.data_root(SimpleNamespace(HOST=host, root=root)))
            protected = (namespace,)
        controller = _controller(root, reader, protected=protected)
        storage = _storage(root, resources, data=data)
        pins, files, identities = [], {}, {}
        for name in FILES:
            path = root / name
            if name in OPTIONAL_FILES and not os.path.lexists(path):
                files[name] = None
                identities[name] = None
                continue
            pin = (E.ObservedFile(root, data[0], data[2], path, limit=1024 * 1024) if data
                   else C.PinnedFile(path, limit=1024 * 1024))
            resources.callback(pin.close)
            pins.append(pin)
            files[name] = hashlib.sha256(pin.body).hexdigest()
            identities[name] = list(pin.identity)
            if name == 'VERSION' and pin.body.strip() != b'4.10.1':
                fail()
        configured = host.PLAN.plan(root, manifest)
        if configured.get('configuredImage') != 'ghcr.io/runtipi/runtipi:v4.10.1':
            fail()
        value = {'schema': SCHEMA, 'policy': POLICY, 'root': str(root), 'context': context,
                 'rootIdentity': identity, 'daemonSha256': hashlib.sha256(daemon.encode()).hexdigest(),
                 'installationId': K.digest({'root': str(root), 'context': context, 'daemon': daemon, 'rootIdentity': identity}),
                 'controller': controller, 'files': files, 'fileIdentities': identities, 'storage': storage,
                 'target': {**{key: manifest[key] for key in ('tag', 'commit', 'digest')}, 'manifestSha256': K.digest(manifest)}}
        if custody is not None:
            value.update(custody=custody, dataAncestry=data[1])
        require_lock(host, root, reader)
        require_no_transition(host, root)
        if (reader.context != context or reader.daemon() != daemon or B.root_identity(root) != identity
                or _controller(root, reader, protected=protected) != controller
                or _adopted(host, root, reader) != adopted
                or any(files[name] is None and os.path.lexists(root / name) for name in FILES)):
            fail()
        for pin in pins:
            pin.verify()
        if layout_pin is not None:
            layout_pin.verify()
            data[2]()
        return value


class LegacyAuthorization:
    """Live Root decision witness, not a replacement or Main write grant."""
    def __init__(self, key, host, root, reader, manifest, plan, pin):
        if key is not _KEY:
            fail()
        self.host, self.root, self.reader = host, root, reader
        self._manifest, self._plan, self.pin = K.canonical(manifest), K.canonical(plan), pin
        self._lock = host.LOCK_DESCRIPTOR.get()
        self.pid, self.thread, self.live = os.getpid(), threading.get_ident(), True
        self._body = bytes(pin.body)

    @property
    def plan(self):
        return K.decoded(self._plan)

    def verify(self):
        if (not self.live or self.pid != os.getpid() or self.thread != threading.get_ident()
                or self.host.LOCK_DESCRIPTOR.get() != self._lock):
            fail()
        require_lock(self.host, self.root, self.reader)
        self.pin.verify()
        if (self.pin.body != self._body
                or K.canonical(review(self.host, self.root, self.reader, K.decoded(self._manifest))) != self._plan):
            fail()
        return {'schema': AUTHORIZATION, 'planSha256': hashlib.sha256(self._plan).hexdigest(),
                'authorizationSha256': hashlib.sha256(self._body).hexdigest(),
                'installationId': self.plan['installationId']}


@contextmanager
def authorized(host, root, reader, manifest):
    root, witness = Path(root), None
    plan = review(host, root, reader, manifest)
    pin = C.PinnedFile(authorization_path(root, host, reader), limit=LIMIT, private=True)
    try:
        value = C.json_body(pin.body)
        if (set(value) != {'schema', 'policy', 'planSha256', 'approvalId'}
                or value['schema'] != AUTHORIZATION or value['policy'] != POLICY
                or value['planSha256'] != K.digest(plan) or not K.valid_hash(value['approvalId'])
                or pin.body != K.canonical(value) + b'\n'):
            fail()
        witness = LegacyAuthorization(_KEY, host, root, reader, manifest, plan, pin)
        witness.verify()
        yield witness
        witness.verify()
    finally:
        if witness is not None:
            witness.live = False
        pin.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('review',))
    parser.add_argument('root', type=Path)
    parser.add_argument('--docker-context', required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    args = parser.parse_args()
    try:
        if os.sys.platform != 'linux' or os.geteuid() != OWNER:
            fail()
        replacement = load('orbis-install-replace.py', 'orbis_legacy_review_replacement')
        root = args.root.expanduser().resolve(strict=True)
        manifest = json.loads(args.manifest.read_bytes())
        replacement.UPDATE.verify_release(replacement.HOST.PLAN.require_installation_protocol(manifest))
        reader = replacement.APPS.Docker(args.docker_context)
        with replacement.HOST.host_lock(root) as descriptor:
            reader.lock_fd = descriptor
            plan = review(replacement.HOST, root, reader, manifest)
        print(json.dumps({'plan': plan, 'planSha256': K.digest(plan)}, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.TimeoutExpired):
        print('Legacy ownership review could not establish bound Root custody; existing data was preserved.', file=os.sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
