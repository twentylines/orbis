"""Root-owned named-volume plans and read-only, generation-pinned inventory holders.

The caller owns capture provenance and fencing. Engine and namespace objects are
code-owned adapters, never callbacks or definitions supplied by HTTP requests.
"""
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import stat
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

_SPEC = importlib.util.spec_from_file_location('orbis_volume_scan', Path(__file__).with_name('orbis-host-volume-inventory.py'))
_SCAN = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_SCAN)
HEX = re.compile(r'[a-f0-9]{64}')
IMAGE = re.compile(r'sha256:[a-f0-9]{64}')
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,254}')
PART = re.compile(r'[a-z0-9][a-z0-9_-]{0,127}')
SERVICE = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}')
POINT = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
ORIGIN = ('pointId', 'rootSha256', 'dockerContextSha256', 'daemonSha256', 'sha256')
LIMIT = 32 * 1024 * 1024
INVENTORY_LIMIT = 64 * 1024 * 1024
MAX_ENTRIES, MAX_PATH_BYTES, MAX_FILE_BYTES = 250000, 33554432, 1099511627776


class VolumeCaptureError(ValueError):
    pass


def fail():
    return VolumeCaptureError('Root volume capture could not be verified; inspect the private recovery record.')


def _bounded(value, *, maximum_nodes=262144):
    pending, count = [(value, 0)], 0
    while pending:
        item, depth = pending.pop()
        count += 1
        if count > maximum_nodes or depth > 32:
            raise fail()
        if isinstance(item, dict):
            if any(not isinstance(key, str) for key in item):
                raise fail()
            pending.extend((key, depth + 1) for key in item)
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
        elif isinstance(item, str):
            if len(item.encode('utf8', 'strict')) > 2 * 1024 * 1024:
                raise fail()
        elif item is None or type(item) is bool:
            pass
        elif type(item) is not int or abs(item) > 2 ** 53 - 1:
            raise fail()


def _text(value, maximum=255):
    return (isinstance(value, str) and 0 < len(value.encode('utf8', 'strict')) <= maximum
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))


def _match(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _target(value):
    return (_text(value, 4096) and value.startswith('/') and value != '/'
            and str(PurePosixPath(value)) == value and '..' not in value.split('/') and '\\' not in value)


def _started(raw):
    state = raw.get('State')
    if (not isinstance(state, dict) or any(type(state.get(key)) is not bool for key in ('Running', 'Paused', 'Restarting'))
            or state['Paused'] or state['Restarting'] or not _text(state.get('StartedAt'), 128)):
        raise fail()
    return state['StartedAt']


def _static(raw):
    if (not isinstance(raw, dict) or not _match(HEX, raw.get('Id')) or not _match(IMAGE, raw.get('Image'))
            or not _text(raw.get('Name')) or not raw['Name'].startswith('/')
            or not isinstance(raw.get('Config'), dict) or not isinstance(raw.get('HostConfig'), dict)
            or not isinstance(raw.get('Mounts'), list) or len(raw['Mounts']) > 4096
            or raw['HostConfig'].get('AutoRemove', False) is not False):
        raise fail()
    for mount in raw['Mounts']:
        if not isinstance(mount, dict) or not _target(mount.get('Destination')) or type(mount.get('RW')) is not bool:
            raise fail()
    if len({mount['Destination'] for mount in raw['Mounts']}) != len(raw['Mounts']):
        raise fail()
    result = {key: copy.deepcopy(raw[key]) for key in ('Id', 'Image', 'Name', 'Config', 'HostConfig')}
    if result['HostConfig'].get('OomKillDisable') is None:
        result['HostConfig']['OomKillDisable'] = False
    result['Mounts'] = sorted(copy.deepcopy(raw['Mounts']), key=lambda item: item['Destination'])
    return result


class LinuxVolumeNamespace:
    """Open only a pinned holder mount through its verified Linux process root."""
    def __init__(self, engine, *, proc_root='/proc'):
        self.engine = engine
        # proc_root is a code-owned fixture seam, never a request field.
        self.proc_root = Path(proc_root)

    @staticmethod
    def _read(directory, name, maximum):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
        try:
            chunks, count = [], 0
            while True:
                chunk = os.read(fd, min(65536, maximum + 1 - count))
                if not chunk:
                    break
                chunks.append(chunk)
                count += len(chunk)
                if count > maximum:
                    raise fail()
            return b''.join(chunks).decode('utf8', 'strict')
        finally:
            os.close(fd)

    def _process(self, descriptor, identifier):
        cgroup = self._read(descriptor, 'cgroup', 1024 * 1024)
        paths = [line.split(':', 2)[2] for line in cgroup.splitlines() if len(line.split(':', 2)) == 3]
        if not any(re.search(r'(?:^|/)(?:docker-)?' + identifier + r'(?:\.scope)?(?:/|$)', path) for path in paths):
            raise fail()
        process = self._read(descriptor, 'stat', 65536)
        closing = process.rfind(')')
        fields = process[closing + 2:].split()
        if closing < 0 or len(fields) < 20 or not fields[19].isdigit():
            raise fail()
        mountinfo = self._read(descriptor, 'mountinfo', 4 * 1024 * 1024)
        selected = []
        for line in mountinfo.splitlines():
            pieces = line.split()
            if len(pieces) < 10 or '-' not in pieces:
                raise fail()
            mountpoint = pieces[4]
            if mountpoint.startswith('/orbis-volume/'):
                raise fail()
            if mountpoint == '/orbis-volume':
                if 'ro' not in pieces[5].split(',') or 'rw' in pieces[5].split(','):
                    raise fail()
                selected.append(line)
        if len(selected) != 1:
            raise fail()
        return fields[19], selected[0]

    @contextmanager
    def open_reader(self, raw, expected_volume):
        if sys.platform != 'linux' or not hasattr(os, 'O_PATH'):
            raise fail()
        identifier, pid = raw['Id'], raw.get('State', {}).get('Pid')
        if type(pid) is not int or not 1 <= pid <= 2 ** 31 - 1 or not raw['State'].get('Running'):
            raise fail()
        mounts = raw.get('Mounts')
        if (len(mounts) != 1 or mounts[0].get('Type') != 'volume' or mounts[0].get('Name') != expected_volume
                or mounts[0].get('Destination') != '/orbis-volume' or mounts[0].get('RW') is not False):
            raise fail()
        before = self.engine.request('GET', '/containers/' + identifier + '/json')
        if before != raw:
            # Volatile accounting fields are irrelevant; pinned process and definition are not.
            if (_static(before) != _static(raw) or before.get('State', {}).get('Pid') != pid
                    or _started(before) != _started(raw) or not before['State']['Running']):
                raise fail()
        descriptors = []
        try:
            process = os.open(self.proc_root / str(pid), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            descriptors.append(process)
            process_inode = os.fstat(process)
            binding = self._process(process, identifier)
            root = os.open('root', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC, dir_fd=process)
            descriptors.append(root)
            directory = os.open('orbis-volume', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=root)
            descriptors.append(directory)
            root_identity = os.fstat(root)
            volume_identity = os.fstat(directory)
            mount_device = binding[1].split()[2].split(':')
            if (not stat.S_ISDIR(volume_identity.st_mode) or len(mount_device) != 2
                    or mount_device != [str(os.major(volume_identity.st_dev)), str(os.minor(volume_identity.st_dev))]
                    or not os.fstatvfs(directory).f_flag & os.ST_RDONLY):
                raise fail()
            yield directory
            after = self.engine.request('GET', '/containers/' + identifier + '/json')
            current = os.stat(self.proc_root / str(pid), follow_symlinks=False)
            current_root = os.stat('root', dir_fd=process)
            current_volume = os.stat('orbis-volume', dir_fd=root, follow_symlinks=False)
            if (_static(after) != _static(raw) or after.get('State', {}).get('Pid') != pid
                    or _started(after) != _started(raw) or not after['State']['Running']
                    or binding != self._process(process, identifier)
                    or (current_root.st_dev, current_root.st_ino) != (root_identity.st_dev, root_identity.st_ino)
                    or (current_volume.st_dev, current_volume.st_ino) != (volume_identity.st_dev, volume_identity.st_ino)
                    or (current.st_dev, current.st_ino) != (process_inode.st_dev, process_inode.st_ino)):
                raise fail()
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)


class VolumeCaptureCoordinator:
    def __init__(self, *, authority, engine, state_dir, runtime, controller_id, image_id, guard, namespace=None):
        if (not callable(guard) or not callable(getattr(engine, 'request', None))
                or not _match(HEX, controller_id) or not _match(IMAGE, image_id)
                or os.geteuid() != authority.OWNER):
            raise fail()
        _bounded(runtime)
        if (not isinstance(runtime, dict) or runtime.get('schema') not in ('orbis.app-runtime-capture.v1', 'orbis.app-runtime-capture.v2')
                or type(runtime.get('version')) is not int or runtime['version'] not in (1, 2)
                or runtime['schema'] != 'orbis.app-runtime-capture.v' + str(runtime['version'])
                or not _match(POINT, runtime.get('pointId'))
                or any(not _match(HEX, runtime.get(key)) for key in ORIGIN[1:])
                or not isinstance(runtime.get('apps'), list) or len(runtime['apps']) > 1024
                or not isinstance(runtime.get('containers'), list) or len(runtime['containers']) > 1024):
            raise fail()
        self.authority, self.engine, self.guard = authority, engine, guard
        self.runtime, self.controller_id, self.image_id = copy.deepcopy(runtime), controller_id, image_id
        self.origin = {key: runtime[key] for key in ORIGIN}
        self.apps, self.sources = {}, {}
        slots = set()
        for app in runtime['apps']:
            if not isinstance(app, dict) or not isinstance(app.get('urn'), str):
                raise fail()
            parts = app['urn'].split(':')
            if (len(parts) != 2 or not _match(PART, parts[0]) or parts[1] != '_user' and not _match(PART, parts[1])
                    or app.get('project') != app['urn'].replace(':', '_') or app['urn'] in self.apps):
                raise fail()
            self.apps[app['urn']] = app['project']
        for source in runtime['containers']:
            if (not isinstance(source, dict) or source.get('appUrn') not in self.apps
                    or not _match(SERVICE, source.get('service')) or type(source.get('ordinal')) is not int
                    or not 1 <= source['ordinal'] <= 1024):
                raise fail()
            raw = source.get('inspect')
            fixed = _static(raw)
            self._labels(source, fixed)
            if fixed['Id'] in self.sources or fixed['Id'] == controller_id:
                raise fail()
            slot = (source['appUrn'], source['service'], source['ordinal'])
            if slot in slots:
                raise fail()
            slots.add(slot)
            self.sources[fixed['Id']] = (source, fixed)
        self.state_dir = Path(state_dir)
        with authority.protected_directory(self.state_dir):
            pass
        self.directory = self.state_dir / 'volume-captures'
        self.directory.mkdir(mode=0o700, exist_ok=True)
        with authority.protected_directory(self.directory):
            pass
        self.directory = self.directory / runtime['pointId']
        self.directory.mkdir(mode=0o700, exist_ok=True)
        with authority.protected_directory(self.directory):
            pass
        self.namespace = namespace if namespace is not None else LinuxVolumeNamespace(self)
        if not callable(getattr(self.namespace, 'open_reader', None)):
            raise fail()
        self.deadline = None
        self.last_poll = 0

    def _labels(self, source, raw):
        labels = raw['Config'].get('Labels')
        if (not isinstance(labels, dict) or labels.get('com.docker.compose.project') != self.apps[source['appUrn']]
                or labels.get('com.docker.compose.service') != source['service']
                or labels.get('com.docker.compose.container-number') != str(source['ordinal'])
                or labels.get('runtipi.appurn') != source['appUrn'] or labels.get('runtipi.managed') != 'true'
                or str(labels.get('com.docker.compose.oneoff')).lower() != 'false'):
            raise fail()

    def _canonical(self, value, *, inventory=False):
        _bounded(value, maximum_nodes=2500000 if inventory else 262144)
        body = self.authority.P.canonical(value)
        if len(body) > (INVENTORY_LIMIT if inventory else LIMIT):
            raise fail()
        return body

    def _save(self, name, value):
        with self.authority.protected_directory(self.directory):
            pass
        self.authority.atomic(self.directory / name, self._canonical(value, inventory=name == 'inventory.json'))
        self._load(name)

    def _load(self, name):
        with self.authority.protected_directory(self.directory) as directory:
            try:
                with self.authority.protected_file(directory, name, INVENTORY_LIMIT if name == 'inventory.json' else LIMIT) as body:
                    value = json.loads(body)
                    if self._canonical(value, inventory=name == 'inventory.json') != body:
                        raise fail()
                    return value
            except FileNotFoundError:
                return None

    @contextmanager
    def _operation(self):
        # This lock belongs only to this capture; service fence renewal uses no such lock.
        descriptor = os.open(self.directory / 'operation.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            details = os.fstat(descriptor)
            if (not stat.S_ISREG(details.st_mode) or details.st_uid != self.authority.OWNER
                    or details.st_nlink != 1 or stat.S_IMODE(details.st_mode) & 0o077):
                raise fail()
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise fail() from None
            self.deadline = time.monotonic() + 300
            self._check()
            yield
            self._check()
        finally:
            self.deadline = None
            os.close(descriptor)

    def _check(self):
        if self.deadline is None or time.monotonic() >= self.deadline or self.guard() is False:
            raise fail()

    def request(self, method, path, body=None):
        self._check()
        try:
            result = self.engine.request(method, path, body)
        finally:
            self._check()
        _bounded(result)
        return result

    def _inspect(self, identifier, *, cleanup=False):
        request = self.engine.request if cleanup else self.request
        return request('GET', '/containers/' + identifier + '/json')

    def _base(self):
        daemon = self.request('GET', '/info')
        if (not isinstance(daemon, dict) or not _text(daemon.get('ID'), 255)
                or hashlib.sha256(daemon['ID'].encode()).hexdigest() != self.origin['daemonSha256']):
            raise fail()
        raw = self._inspect(self.controller_id)
        if raw.get('Image') != self.image_id or raw.get('Id') != self.controller_id:
            raise fail()
        return dict(static=_static(raw), startedAt=_started(raw))

    def _all(self):
        rows = self.request('GET', '/containers/json?all=1')
        if (not isinstance(rows, list) or len(rows) > 4096 or any(not isinstance(row, dict) or not _match(HEX, row.get('Id')) for row in rows)
                or len({row['Id'] for row in rows}) != len(rows)):
            raise fail()
        result = {}
        for row in rows:
            raw = self._inspect(row['Id'])
            if not isinstance(raw, dict) or raw.get('Id') != row['Id'] or not isinstance(raw.get('Mounts'), list):
                raise fail()
            result[row['Id']] = raw
        return result

    def _volume(self, name):
        raw = self.request('GET', '/volumes/' + name)
        if (not isinstance(raw, dict) or raw.get('Name') != name or raw.get('Driver') != 'local'
                or raw.get('Scope') != 'local' or raw.get('Options') not in (None, {})
                or not _text(raw.get('CreatedAt'), 128)
                or raw.get('Labels') is not None and not isinstance(raw['Labels'], dict)):
            raise fail()
        # Mountpoint is deliberately neither retained nor accessed.
        return {key: copy.deepcopy(raw.get(key)) for key in ('Name', 'Driver', 'Scope', 'Options', 'Labels', 'CreatedAt')}

    def _observe(self, *, stopped=False):
        controller = self._base()
        all_containers = self._all()
        selected, volumes, services, bindings = {}, {}, {}, 0
        source_paths = set()
        for identifier, (source, captured) in self.sources.items():
            raw = all_containers.get(identifier)
            fixed = _static(raw)
            if fixed != captured:
                raise fail()
            self._labels(source, fixed)
            started = _started(raw)
            if stopped and raw['State']['Running']:
                raise fail()
            selected[identifier] = dict(static=fixed, startedAt=started)
            specifications = fixed['HostConfig'].get('Mounts') or []
            if not isinstance(specifications, list):
                raise fail()
            for specification in specifications:
                if not isinstance(specification, dict):
                    raise fail()
                options = specification.get('VolumeOptions') or {}
                if not isinstance(options, dict) or options.get('Subpath') or options.get('SubPath'):
                    raise fail()
            for mount in fixed['Mounts']:
                if mount.get('Type') != 'volume':
                    continue
                name, target = mount.get('Name'), mount['Destination']
                if (not _match(NAME, name) or mount.get('Driver') != 'local' or mount.get('Subpath') or mount.get('SubPath')
                        or any(other['Destination'].startswith(target + '/') or target.startswith(other['Destination'] + '/')
                               for other in fixed['Mounts'] if other is not mount and other['Destination'] != target)):
                    raise fail()
                if not _target(mount.get('Source')):
                    raise fail()
                source_paths.add(mount['Source'])
                binding = (self.apps[source['appUrn']], source['service'], target)
                value = (name, not mount['RW'])
                if binding in services and services[binding] != value:
                    raise fail()
                services[binding] = value
                entry = dict(containerId=identifier, project=binding[0], service=binding[1], ordinal=source['ordinal'], target=target, readOnly=not mount['RW'])
                volumes.setdefault(name, []).append(entry)
                bindings += 1
        if len(volumes) > 1024 or bindings > 4096:
            raise fail()
        for identifier, raw in all_containers.items():
            if identifier in selected:
                continue
            labels = raw.get('Config', {}).get('Labels') or {}
            if labels.get('runtipi.appurn') in self.apps or labels.get('com.docker.compose.project') in self.apps.values():
                raise fail()
            for mount in raw['Mounts']:
                if not isinstance(mount, dict):
                    raise fail()
                if mount.get('Type') == 'volume' and mount.get('Name') in volumes:
                    raise fail()
                candidate = mount.get('Source')
                if mount.get('Type') == 'bind' and _target(candidate) and any(
                        candidate == path or candidate.startswith(path + '/') or path.startswith(candidate + '/') for path in source_paths):
                    raise fail()
        identities, records = {}, []
        for name in sorted(volumes):
            identities[name] = self._volume(name)
            records.append(dict(key=hashlib.sha256(('orbis.backup-volume.v1\n' + name).encode()).hexdigest(), sourceName=name,
                                mounts=sorted(volumes[name], key=self._canonical)))
        return dict(schema='orbis.host.volume-plan.v1', origin=self.origin, controllerId=self.controller_id, imageId=self.image_id,
                    controller=controller, consumers=selected, volumeIdentities=identities, plan=dict(version=1, volumes=records))

    def _plan(self):
        saved = self._load('plan.json')
        if (not isinstance(saved, dict) or set(saved) != {'schema', 'origin', 'controllerId', 'imageId', 'controller', 'consumers', 'volumeIdentities', 'plan'}
                or saved['schema'] != 'orbis.host.volume-plan.v1' or saved['origin'] != self.origin
                or saved['controllerId'] != self.controller_id or saved['imageId'] != self.image_id):
            raise fail()
        return saved

    def prepare(self):
        with self._operation():
            if self._load('holder.json') is not None:
                raise fail()
            observed = self._observe()
            previous = self._load('plan.json')
            if previous is not None and previous != observed:
                raise fail()
            if previous is None:
                self._save('plan.json', observed)
            return copy.deepcopy(observed['plan'])

    def _verify(self):
        saved = self._plan()
        if self._observe(stopped=True) != saved:
            raise fail()
        return saved

    def verify_stopped(self):
        with self._operation():
            if self._load('holder.json') is not None:
                raise fail()
            self._verify()
            return True

    def _spec(self, name, nonce, volume):
        image = self.request('GET', '/images/' + self.image_id + '/json')
        if not isinstance(image, dict) or image.get('Id') != self.image_id or not isinstance(image.get('Config'), dict):
            raise fail()
        config = image['Config']
        if config.get('Volumes') not in (None, {}):
            raise fail()
        env = config.get('Env') or []
        ports = config.get('ExposedPorts') or {}
        if not isinstance(env, list) or not all(_text(item, 65536) for item in env) or not isinstance(ports, dict):
            raise fail()
        spec = dict(Image=self.image_id, Entrypoint=['/usr/local/bin/node'], Cmd=['-e', 'setInterval(() => {}, 1000)'],
                    User='65534:65534', Env=[], WorkingDir='/', ExposedPorts={}, Volumes={}, Healthcheck={'Test': ['NONE']},
                    Labels={'org.orbis.role': 'volume-inventory', 'org.orbis.point': self.origin['pointId'],
                            'org.orbis.nonce': nonce, 'com.docker.compose.service': 'orbis-volume-reader'},
                    HostConfig={'NetworkMode': 'none', 'ReadonlyRootfs': True, 'CapDrop': ['ALL'], 'CapAdd': [],
                                'SecurityOpt': ['no-new-privileges'], 'Memory': 128 * 1024 * 1024, 'PidsLimit': 32,
                                'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0}, 'AutoRemove': False,
                                'Privileged': False, 'PublishAllPorts': False, 'PortBindings': {},
                                'Mounts': [{'Type': 'volume', 'Source': volume, 'Target': '/orbis-volume', 'ReadOnly': True,
                                            'VolumeOptions': {'NoCopy': True}}]})
        labels = config.get('Labels') or {}
        if not isinstance(labels, dict) or any(key in labels for key in ('runtipi.managed', 'runtipi.appurn')):
            raise fail()
        return spec, dict(env=env, exposedPorts=ports, labels=labels)

    def _owned(self, record, raw):
        if (not isinstance(record, dict) or record.get('origin') != self.origin or record.get('controllerId') != self.controller_id
                or record.get('imageId') != self.image_id or not _match(HEX, record.get('id'))
                or not isinstance(raw, dict) or raw.get('Id') != record['id'] or raw.get('Name') != '/' + record['name']
                or raw.get('Image') != self.image_id):
            raise fail()
        fixed = _static(raw)
        spec, config, host = record['spec'], raw['Config'], raw['HostConfig']
        for key in ('Entrypoint', 'Cmd', 'User', 'WorkingDir', 'Healthcheck'):
            if config.get(key) != spec[key]:
                raise fail()
        if config.get('Labels') != {**record['imageDefaults']['labels'], **spec['Labels']}:
            raise fail()
        if (config.get('Env') is not None and not isinstance(config.get('Env'), list)
                or (config.get('Env') or []) != record['imageDefaults']['env'] or (config.get('ExposedPorts') or {}) != record['imageDefaults']['exposedPorts']
                or config.get('Volumes') not in (None, {}) or config.get('OpenStdin', False) or config.get('Tty', False)):
            raise fail()
        for key, value in spec['HostConfig'].items():
            if key in ('CapAdd', 'PortBindings') and not host.get(key) and not value:
                continue
            if host.get(key) != value:
                raise fail()
        if any(host.get(key) for key in ('Binds', 'VolumesFrom', 'Devices', 'DeviceRequests', 'Links', 'ExtraHosts', 'GroupAdd', 'Sysctls', 'Tmpfs')):
            raise fail()
        if any(host.get(key) not in (None, '', 'private') for key in ('PidMode', 'IpcMode', 'UTSMode', 'UsernsMode')):
            raise fail()
        mounts = raw['Mounts']
        if (len(mounts) != 1 or mounts[0].get('Type') != 'volume' or mounts[0].get('Name') != record['volume']
                or mounts[0].get('Driver') != 'local' or mounts[0].get('Destination') != '/orbis-volume' or mounts[0].get('RW') is not False):
            raise fail()
        _started(raw)
        if record.get('static') is not None and record['static'] != fixed:
            raise fail()
        if record.get('startedAt') is not None and record['startedAt'] != raw['State']['StartedAt']:
            raise fail()
        return fixed

    def _cleanup(self, record):
        # Cancellation revokes reading, not this narrowly owned read-only holder's cleanup.
        # A missing returned ID or changed generation requires explicit root reconciliation.
        if not _match(HEX, record.get('id')):
            raise fail()
        raw = self._inspect(record['id'], cleanup=True)
        self._owned(record, raw)
        if raw['State']['Running']:
            self.engine.request('POST', '/containers/' + record['id'] + '/stop?t=5')
            raw = self._inspect(record['id'], cleanup=True)
            self._owned(record, raw)
        if raw['State']['Running'] is not False:
            raise fail()
        self.engine.request('DELETE', '/containers/' + record['id'] + '?v=false')
        try:
            self._inspect(record['id'], cleanup=True)
        except Exception as error:
            if getattr(error, 'status', None) != 404:
                raise
        else:
            raise fail()
        record['phase'] = 'cleaned'
        self._save('last-holder.json', record)
        (self.directory / 'holder.json').unlink()
        descriptor = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _inventory_volume(self, volume, budget):
        if budget['entries'] < 1 or budget['paths'] < 1 or budget['bytes'] < 0:
            raise fail()
        nonce = str(uuid.uuid4())
        name = 'orbis-volume-reader-' + str(uuid.uuid4())
        spec, defaults = self._spec(name, nonce, volume['sourceName'])
        record = dict(schema='orbis.host.volume-holder.v1', origin=self.origin, controllerId=self.controller_id, imageId=self.image_id,
                      name=name, nonce=nonce, volume=volume['sourceName'], spec=spec, imageDefaults=defaults, phase='create-intent', id=None)
        self._save('holder.json', record)
        try:
            self._check()
            try:
                created = self.engine.request('POST', '/containers/create?name=' + name, spec)
                if not isinstance(created, dict) or not _match(HEX, created.get('Id')):
                    raise fail()
                record['id'], record['phase'] = created['Id'], 'created'
                self._save('holder.json', record)
            finally:
                self._check()
            raw = self._inspect(record['id'])
            record['static'] = self._owned(record, raw)
            if raw['State']['Running'] or raw['State']['StartedAt'] not in ('0001-01-01T00:00:00Z', '0001-01-01T00:00:00.000000000Z'):
                raise fail()
            self._save('holder.json', record)
            self.request('POST', '/containers/' + record['id'] + '/start')
            raw = self._inspect(record['id'])
            self._owned(record, raw)
            if raw['State']['Running'] is not True:
                raise fail()
            record['startedAt'], record['phase'] = raw['State']['StartedAt'], 'reading'
            self._save('holder.json', record)
            self.last_poll = 0
            def cancelled():
                now = time.monotonic()
                if now - self.last_poll >= 0.5:
                    self._check()
                    self.last_poll = now
                return False
            with self.namespace.open_reader(raw, volume['sourceName']) as descriptor:
                entries = _SCAN.scan_directory(descriptor, maximum_entries=budget['entries'], maximum_path_bytes=budget['paths'],
                                               maximum_bytes=budget['bytes'], cancelled=cancelled)
                self._check()
            # Source identities are revalidated after the holder is removed so its own
            # deliberately shared volume cannot be mistaken for a foreign consumer.
            return dict(key=volume['key'], sourceName=volume['sourceName'], containerId=volume['mounts'][0]['containerId'], entries=entries)
        finally:
            try:
                self._cleanup(record)
            except Exception:
                record['phase'] = 'reconciliation-required'
                self._save('holder.json', record)
                raise fail() from None

    def inventory(self):
        with self._operation():
            if self._load('holder.json') is not None:
                raise fail()
            saved = self._verify()
            inventories = []
            budget = dict(entries=MAX_ENTRIES, paths=MAX_PATH_BYTES, bytes=MAX_FILE_BYTES)
            for volume in saved['plan']['volumes']:
                self._verify()
                inventory = self._inventory_volume(volume, budget)
                budget['entries'] -= len(inventory['entries'])
                for entry in inventory['entries']:
                    budget['paths'] -= len(entry['name'].encode('utf8')) + len(entry.get('target', '').encode('utf8'))
                    if entry['kind'] == 'file':
                        budget['bytes'] -= entry['bytes']
                if any(value < 0 for value in budget.values()):
                    raise fail()
                inventories.append(inventory)
                self._verify()
            self._verify()
            self._save('inventory.json', dict(schema='orbis.host.volume-inventory-receipt.v1', origin=self.origin,
                                             controllerId=self.controller_id, imageId=self.image_id, inventories=inventories))
            return copy.deepcopy(inventories)
