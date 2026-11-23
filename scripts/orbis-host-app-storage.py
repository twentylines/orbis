"""Read-only app-data observations for the current local Main connection.

This module grants no recovery, process-start, filesystem-write or SQL authority.
The caller uses the ordinary Host lifecycle lock, not the credential broker.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import sys
import time
from contextlib import ExitStack


def _container_definition_module():
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location('orbis_container_definition', Path(__file__).with_name('orbis-container-definition.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CONTAINER_DEFINITION = _container_definition_module()


def _load():
    spec = importlib.util.spec_from_file_location('orbis_app_storage_process', Path(__file__).with_name('orbis-host-credential-peer.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PEER = _load()
SCHEMA = 'orbis.app-storage-observation.v1'
HASH = re.compile(r'[a-f0-9]{64}\Z')
URN = re.compile(r'([a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}):([a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127})\Z')
DECIMAL = re.compile(r'(?:0|[1-9][0-9]{0,19})\Z')


def fail():
    raise ValueError('The app storage binding could not be verified.') from None


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def _directory_identity(info):
    if not stat.S_ISDIR(info.st_mode): fail()
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode)


class Directory:
    """Pin user-owned data without treating its permissions as Root authority."""
    def __init__(self, path):
        self.path, self.fds = Path(path), []
        try:
            if (not self.path.is_absolute() or str(self.path) != str(Path(os.path.normpath(self.path)))
                    or len(str(self.path).encode()) > 4096 or len(self.path.parts) > 128
                    or any(c in str(self.path) for c in ('\0', '\n', '\r'))): fail()
            previous = None
            for part in self.path.parts:
                fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=previous)
                try:
                    identity = _directory_identity(os.fstat(fd))
                except BaseException:
                    os.close(fd)
                    raise
                self.fds.append((previous, part, fd, identity))
                previous = fd
            self.verify()
        except BaseException:
            self.close()
            raise

    @property
    def fd(self):
        return self.fds[-1][2]

    def verify(self):
        if not self.fds: fail()
        for parent, name, fd, identity in self.fds:
            if (identity != _directory_identity(os.fstat(fd))
                    or identity != _directory_identity(os.stat(name, dir_fd=parent, follow_symlinks=False))): fail()

    def metadata(self):
        self.verify()
        info = os.fstat(self.fd)
        return {'device': str(info.st_dev), 'inode': str(info.st_ino), 'uid': info.st_uid,
                'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}

    def close(self):
        for _, _, fd, _ in reversed(self.fds): os.close(fd)
        self.fds.clear()

    def __enter__(self):
        self.verify()
        return self

    def __exit__(self, *args):
        self.close()


def _path(value):
    return (type(value) is str and value.startswith('/') and value != '/' and len(value.encode()) <= 4096
            and os.path.normpath(value) == value and not any(c in value for c in ('\0', '\n', '\r', '\\')))


def _inside(root, value):
    return value == root or (value.startswith('/') if root == '/' else value.startswith(root + '/'))


def mounts(body):
    if type(body) is not bytes or not 0 < len(body) <= 1024 * 1024: fail()
    lines = body.decode('utf-8', errors='strict').splitlines()
    if not lines or len(lines) > 16384: fail()
    result, ids = [], set()
    for line in lines:
        sections = line.split(' - ')
        if len(sections) != 2: fail()
        fields, extra = sections[0].split(' '), sections[1].split(' ')
        if (len(fields) < 6 or len(extra) < 3 or not fields[0].isdecimal() or not fields[1].isdecimal()
                or not re.fullmatch(r'[0-9]+:[0-9]+', fields[2]) or fields[0] in ids): fail()
        ids.add(fields[0])
        def decoded(value):
            if re.search(r'\\(?!040|011|012|134)', value): fail()
            return re.sub(r'\\(040|011|012|134)', lambda m: chr(int(m[1], 8)), value)
        root, destination = decoded(fields[3]), decoded(fields[4])
        if (not root.startswith('/') or not destination.startswith('/')
                or os.path.normpath(destination) != destination): fail()
        result.append({'root': root, 'destination': destination, 'options': fields[5].split(','),
                       'optional': fields[6:], 'device': fields[2]})
    return result


def _storage_paths(value, app):
    if type(value) is not dict or type(value.get('Mounts')) is not list or len(value['Mounts']) > 256: fail()
    matching = []
    for mount in value['Mounts']:
        if type(mount) is not dict or not _path(mount.get('Destination')): fail()
        destination = mount['Destination']
        if _inside('/app-data', destination) or _inside(destination, '/app-data'):
            if (destination != '/app-data' or mount.get('Type') != 'bind' or mount.get('RW') is not True
                    or not _path(mount.get('Source')) or mount.get('Propagation') != 'rprivate'): fail()
            matching.append(mount)
    if len(matching) != 1: fail()
    parts = URN.fullmatch(app)
    if not parts: fail()
    name, store = parts.groups()
    base = matching[0]['Source']
    return base, base + '/' + store + '/' + name, '/app-data/' + store + '/' + name


def _data_scope(service, base):
    # Main's app data must never alias or expose Root control/recovery storage.
    # This is a confinement check, not an ownership grant for those paths.
    protected = (str(service.state_dir), str(service.HOST.AUTHORITY.LAYOUT.namespace(service.root)),
                 '/var/lib/orbis-host', '/var/lib/orbis-sentinel', '/etc/orbis-sentinel',
                 '/run/orbis', '/proc', '/sys', '/dev')
    if any(not _path(value) or _inside(base, value) or _inside(value, base) for value in protected): fail()


def _boundaries(host_rows, main_rows, host_path, main_path):
    if any(_inside(host_path, row['destination']) for row in host_rows): fail()
    if any(_inside(main_path, row['destination']) for row in main_rows): fail()
    candidates = [row for row in main_rows if row['destination'] == '/app-data']
    if (len(candidates) != 1 or any(option.startswith(('shared:', 'master:', 'propagate_from:'))
                                  for option in candidates[0]['optional'])): fail()
    containing = sorted((row for row in host_rows if _inside(row['destination'], host_path)), key=lambda row: len(row['destination']))
    if not containing or 'rw' not in containing[-1]['options'] or 'rw' not in candidates[0]['options']: fail()
    return digest({'host': containing[-1], 'main': candidates[0]})


class Witness:
    """Observe the real peer process and enrolled controller; accept no caller IDs."""
    def __init__(self, service, connection):
        self.service, self.connection = service, connection
        self.resources, self.processes, self.proc = ExitStack(), [], None
        outer = service.HOST.CAPTURE_READ_DEADLINE.get()
        self.deadline = min(time.monotonic() + 15, outer) if outer is not None else time.monotonic() + 15
        try:
            if sys.platform != 'linux' or os.geteuid() != 0 or not hasattr(socket, 'SO_PEERCRED'): fail()
            self.credentials = self._credentials()
            self.proc = os.open('/proc', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            self.resources.callback(os.close, self.proc)
            self.proc_identity = _directory_identity(os.fstat(self.proc))
            if self.proc_identity[2] != 0 or self.proc_identity[4] & 0o022: fail()
            self.before = self._observe()
            for pid in (self.credentials[0], self.before['pid']):
                process = PEER._Process(self.proc, pid)
                self.processes.append(process)
                self.resources.callback(process.close)
            peer, main = (item.identity for item in self.processes)
            if peer[1:] != main[1:]: fail()
            controller = self.before['controller']['id']
            if not all(any(part in {controller, 'docker-' + controller + '.scope'} for part in row[2].split('/')) for row in peer[1]): fail()
            self.verify()
        except BaseException:
            self.resources.close()
            raise

    def _credentials(self):
        value = struct.unpack('3i', self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if value[0] <= 0 or value[1] != 0 or value[2] < 0: fail()
        return value

    def command(self, arguments):
        return PEER._json(PEER._run(self.service, arguments, self.deadline))

    def _observe(self):
        self.service.require_controller_capture_idle()
        endpoint = self.command(['context', 'inspect', self.service.context, '--format', '{{json .Endpoints.docker.Host}}'])
        if endpoint not in ('unix:///var/run/docker.sock', 'unix:///run/docker.sock'): fail()
        socket_path = endpoint[len('unix://'):]
        info = os.stat(socket_path, follow_symlinks=False)
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o007: fail()
        saved = self.service.HOST.saved_state(self.service.root)
        publication = self.service.current_manifest()
        if (type(saved) is not dict or saved.get('root') != str(self.service.root)
                or saved.get('dockerContext') != self.service.context or type(publication) is not dict): fail()
        raw = self.command(['inspect', '--format', '{{json .}}', 'runtipi'])
        if type(raw) is not dict or not HASH.fullmatch(raw.get('Id', '')) or not re.fullmatch(r'sha256:[a-f0-9]{64}', raw.get('Image', '')): fail()
        state, config = raw.get('State'), raw.get('HostConfig')
        if (type(state) is not dict or type(state.get('Pid')) is not int or state['Pid'] <= 0
                or state.get('Running') is not True or state.get('Status') != 'running'
                or any(state.get(key) is not False for key in ('Paused', 'Restarting', 'Dead'))
                or type(config) is not dict or config.get('Privileged') is not False
                or any(config.get(key) == 'host' for key in ('PidMode', 'IpcMode', 'UTSMode', 'UsernsMode'))
                or any(str(cap).upper().removeprefix('CAP_') == 'SYS_ADMIN' for cap in (config.get('CapAdd') or []))): fail()
        controller = self.service.controller_capture_identity(raw['Id'], raw['Image'], saved)
        if (controller.get('releaseTag') != publication.get('tag') or controller.get('releaseDigest') != publication.get('digest')
                or controller.get('id') != raw['Id'] or controller.get('imageId') != raw['Image']
                or controller.get('startedAt') != state.get('StartedAt')): fail()
        daemon = self.command(['info', '--format', '{{json .ID}}'])
        if type(daemon) is not str or not 1 <= len(daemon) <= 256 or any(ord(c) < 33 or ord(c) > 126 for c in daemon): fail()
        definition = CONTAINER_DEFINITION.normalize({key: raw.get(key) for key in ('Config', 'HostConfig', 'Mounts', 'Path', 'Args')})
        return {'controller': {'id': raw['Id'], 'imageId': raw['Image'], 'startedAt': state['StartedAt'],
                               'definitionSha256': digest(definition)}, 'pid': state['Pid'], 'raw': raw,
                'daemonSha256': hashlib.sha256(daemon.encode()).hexdigest(),
                'socketIdentity': [str(info.st_dev), str(info.st_ino), info.st_uid, info.st_gid, info.st_mode],
                'enrollmentSha256': digest(saved), 'publicationSha256': digest(publication)}

    def verify(self):
        if (self.credentials != self._credentials() or self.proc_identity != _directory_identity(os.fstat(self.proc))
                or self.proc_identity != _directory_identity(os.lstat('/proc'))): fail()
        for process in self.processes: process.verify(self.proc)
        current = self._observe()
        if {k: v for k, v in self.before.items() if k != 'raw'} != {k: v for k, v in current.items() if k != 'raw'}: fail()
        for process in self.processes: process.verify(self.proc)

    def mount_tables(self):
        return (mounts(PEER._read(self.proc, 'self/mountinfo', 1024 * 1024)),
                mounts(PEER._read(self.processes[1].fd, 'mountinfo', 1024 * 1024)))

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.resources.close()


def observe(service, connection, request):
    """Read only. Caller supplies an app URN and nonce, never paths or identities."""
    token = None
    try:
        if (type(request) is not dict or set(request) != {'appUrn', 'nonce'} or type(request['appUrn']) is not str
                or not URN.fullmatch(request['appUrn']) or type(request['nonce']) is not str or not HASH.fullmatch(request['nonce'])): fail()
        outer = service.HOST.CAPTURE_READ_DEADLINE.get()
        deadline = time.monotonic() + 15
        token = service.HOST.CAPTURE_READ_DEADLINE.set(min(deadline, outer) if outer is not None else deadline)
        # Ordinary lifecycle lock also observes existing recovery/capture holds.
        with service.HOST.host_lock(service.root), Witness(service, connection) as witness:
            base, host_path, main_path = _storage_paths(witness.before['raw'], request['appUrn'])
            _data_scope(service, base)
            with Directory(host_path) as directory:
                before_mounts = witness.mount_tables()
                mount_digest = _boundaries(*before_mounts, host_path, main_path)
                metadata = directory.metadata()
                witness.verify()
                directory.verify()
                if before_mounts != witness.mount_tables() or metadata != directory.metadata(): fail()
                value = {'schema': SCHEMA, **request, 'controller': witness.before['controller'],
                         'daemonSha256': witness.before['daemonSha256'],
                         'dockerSocket': {'device': witness.before['socketIdentity'][0], 'inode': witness.before['socketIdentity'][1]},
                         'hostBasePath': base,
                         'hostPath': host_path, 'containerPath': main_path, 'directory': metadata,
                         'mountTablesSha256': mount_digest,
                         'controllerNamespace': ':'.join(str(v) for v in witness.processes[1].identity[2][0])}
                result = {**value, 'bindingSha256': hashlib.sha256((SCHEMA + '\n').encode() + canonical(value)).hexdigest()}
                if len(canonical(result)) > 16384: fail()
                return result
    except Exception:
        fail()
    finally:
        if token is not None: service.HOST.CAPTURE_READ_DEADLINE.reset(token)
