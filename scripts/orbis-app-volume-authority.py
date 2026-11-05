"""Root-admitted, append-only app pin generations and a CAS storage selector.

This library has no request/CLI admission path. A trusted root caller must obtain
the exact review digest independently, authenticate the source and prepared
receipt, and supply the manifest-approved target records. Hashing worker input
and immediately approving that hash is not admission. Docker observation proves
local identity/topology, never the restored contents or manifest provenance.

Selecting a generation only changes a protected host selector. It does not mount
it, start apps, restore a database, or authorize controller/Compose execution.
Generations are never edited/replaced/deleted, including after partial failure.
Root remains the trust boundary; 0700/0600 is not kernel write protection from root.
"""
import fcntl
from datetime import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import posixpath
import re
import stat
from contextlib import contextmanager


def _load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LAYOUT = _load('orbis-host-layout.py', 'app_volume_authority_layout')
ENGINE = _load('orbis-host-volume-engine.py', 'app_volume_authority_engine')
OWNER = 0
PIN_LIMIT = 512 * 1024
TOTAL_LIMIT = 16 * 1024 * 1024
MARKER_SCHEMA = 'orbis.app-volume-authority.v1'
PLAN_SCHEMA = 'orbis.host.app-volume-review.v1'
BINDING_SCHEMA = 'orbis.host.app-volume-binding.v1'
SELECTION_SCHEMA = 'orbis.host.app-volume-selection.v1'
SELECTION_PLAN_SCHEMA = 'orbis.host.app-volume-selection-review.v1'
HASH = re.compile(r'[a-f0-9]{64}')
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
NAME = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}')
SERVICE = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}')
URN = re.compile(r'[a-z0-9][a-z0-9._-]{0,127}:(?:[a-z0-9][a-z0-9._-]{0,127}|_user)')
TARGET_KEYS = {'key', 'sourceName', 'targetName', 'archiveSha256', 'inventorySha256', 'uploaderName',
               'uploaderId', 'state', 'volumeIdentity', 'containerIdentity', 'verificationSha256'}


class AuthorityError(ValueError):
    pass


def _fail():
    return AuthorityError('Protected app volume authority could not be verified; preserve existing generations for review')


def _operator():
    if os.geteuid() != 0:
        raise _fail()


def _match(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _exact(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)


def _sha(body):
    return hashlib.sha256(body).hexdigest()


def _js_keys(value):
    # JSON.stringify enumerates integer property names before insertion-order keys.
    integer = lambda key: key.isascii() and key.isdigit() and str(int(key)) == key and int(key) < 4294967295
    return sorted((key for key in value if integer(key)), key=int) + [key for key in value if not integer(key)]


def _ordered(value, canonical=False):
    if isinstance(value, dict):
        value = dict(sorted(value.items())) if canonical else value
        return {key: _ordered(value[key], canonical) for key in _js_keys(value)}
    if isinstance(value, list):
        return [_ordered(child, canonical) for child in value]
    return value


def _json(value, canonical=False):
    return json.dumps(_ordered(value, canonical), ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf8')


def plan_sha256(plan):
    return _sha(_json(plan, True))


def _parse(body):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise _fail()
            result[key] = value
        return result
    def constant(_value):
        raise _fail()
    try:
        value = json.loads(body.decode('utf8', 'strict'), object_pairs_hook=pairs, parse_constant=constant)
        if _json(value, True) != body:
            raise _fail()
        return value
    except (UnicodeError, ValueError, RecursionError, OverflowError) as error:
        raise _fail() from error


def _safe_target(value):
    return (isinstance(value, str) and len(value.encode('utf8')) <= 4096 and value.startswith('/')
            and value != '/' and not value.endswith('/') and posixpath.normpath(value) == value
            and not value.startswith('//') and not re.search(r'[\\:$]', value)
            and not any(ord(char) < 32 or ord(char) == 127 or 0xD800 <= ord(char) <= 0xDFFF for char in value)
            and not any(value == root or value.startswith(root + '/') for root in ('/proc', '/sys', '/dev')))


def decode_pins(body):
    """Require the complete byte-for-byte encodeAppVolumePins rendering."""
    if not isinstance(body, bytes) or not 1 <= len(body) <= PIN_LIMIT:
        raise _fail()
    try:
        # Pin JSON is insertion ordered, unlike the canonical root binding JSON.
        document = ENGINE._json(body)
        pins = document.get('x-orbis-volume-pin') if isinstance(document, dict) else None
        if (not _exact(pins, ('version', 'appUrn', 'project', 'services')) or type(pins['version']) is not int
                or pins['version'] != 1 or not _match(URN, pins['appUrn'])
                or pins['project'] != pins['appUrn'].replace(':', '_', 1)
                or not isinstance(pins['services'], list) or not 1 <= len(pins['services']) <= 256):
            raise _fail()
        previous, total, names = '', 0, set()
        for service in pins['services']:
            if (not _exact(service, ('name', 'mounts')) or not _match(SERVICE, service['name'])
                    or service['name'] <= previous or not isinstance(service['mounts'], list) or not service['mounts']):
                raise _fail()
            previous, last, targets = service['name'], '', set()
            for mount in service['mounts']:
                if (not _exact(mount, ('target', 'volume', 'readOnly')) or not _safe_target(mount['target'])
                        or mount['target'].encode('utf-16-be') <= last.encode('utf-16-be') or not _match(NAME, mount['volume'])
                        or type(mount['readOnly']) is not bool
                        or any(mount['target'].startswith(target + '/') for target in targets)):
                    raise _fail()
                last = mount['target']
                targets.add(last)
                names.add(mount['volume'])
                total += 1
                if total > 4096:
                    raise _fail()
        names = sorted(names)
        local = {name: 'orbis_retained_' + _sha(name.encode()) for name in names}
        # The extension retains its own key order, as encodeAppVolumePins does.
        # Every code-owned Compose field below is reconstructed and compared.
        rendered = {'x-orbis-volume-pin': pins, 'services': {
            service['name']: {'volumes': [dict(type='volume', source=local[mount['volume']], target=mount['target'],
                                             read_only=mount['readOnly'], volume={'nocopy': True}) for mount in service['mounts']]}
            for service in pins['services']}, 'volumes': {local[name]: dict(external=True, name=name) for name in names}}
        if body != _json(rendered):
            raise _fail()
        return pins
    except (ValueError, TypeError, KeyError, UnicodeError, RecursionError) as error:
        raise _fail() from error


def _identity(info):
    return dict(device=info.st_dev, inode=info.st_ino, uid=info.st_uid, gid=info.st_gid, mode=stat.S_IMODE(info.st_mode))


def _seal(info):
    return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_nlink',
                                             'st_size', 'st_mtime_ns', 'st_ctime_ns'))


@contextmanager
def _directory(path, *, private=True):
    path = Path(path)
    if not path.is_absolute() or str(path) != os.path.realpath(path):
        raise _fail()
    descriptors, bindings = [], []
    try:
        descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(descriptor)
        for component in path.parts[1:]:
            parent = descriptor
            descriptor = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            descriptors.append(descriptor)
            info = os.fstat(descriptor)
            if info.st_uid not in {0, OWNER} or stat.S_IMODE(info.st_mode) & 0o022:
                raise _fail()
            bindings.append((parent, component, descriptor, _identity(info)))
        if os.fstat(descriptor).st_uid != OWNER or private and stat.S_IMODE(os.fstat(descriptor).st_mode) != 0o700:
            raise _fail()
        yield descriptor
        for parent, name, child, expected in bindings:
            if _identity(os.fstat(child)) != expected or _identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != expected:
                raise _fail()
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def _read(directory, name, maximum=TOTAL_LIMIT):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        before = os.fstat(descriptor)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != OWNER or before.st_nlink != 1
                or stat.S_IMODE(before.st_mode) != 0o600 or not 1 <= before.st_size <= maximum):
            raise _fail()
        chunks, count = [], 0
        while True:
            chunk = os.read(descriptor, min(65536, maximum + 1 - count))
            if not chunk:
                break
            chunks.append(chunk)
            count += len(chunk)
            if count > maximum:
                raise _fail()
        if count != before.st_size or any(_seal(info) != _seal(before) for info in
                (os.fstat(descriptor), os.stat(name, dir_fd=directory, follow_symlinks=False))):
            raise _fail()
        return b''.join(chunks)
    finally:
        os.close(descriptor)


def _write_new(directory, name, body):
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'wb', closefd=False) as stream:
            stream.write(body)
            stream.flush()
            os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.fsync(directory)


def _mkdir(parent, name):
    os.mkdir(name, 0o700, dir_fd=parent)
    descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        os.fchmod(descriptor, 0o700)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.fsync(parent)


def store_path(root):
    return LAYOUT.namespace(root) / 'app-volume-authority'


def _overlap(first, second):
    return first == second or first.startswith(second.rstrip('/') + '/') or second.startswith(first.rstrip('/') + '/')


def _mounts(mountinfo):
    return [LAYOUT.R._durable_filesystem(view) for view in LAYOUT.R._mount_entries(mountinfo or '/proc/self/mountinfo')]


def _backing_path(path, mounts):
    path = str(path)
    covering = [mount for mount in mounts if path == mount['path'] or path.startswith(mount['path'].rstrip('/') + '/')]
    if not covering or len({mount['path'] for mount in covering}) != len(covering):
        raise _fail()
    selected = max(covering, key=lambda mount: len(mount['path']))
    return selected, posixpath.normpath(posixpath.join(selected['root'], posixpath.relpath(path, selected['path'])))


def _same_backing(first, second, mounts):
    left, left_path = _backing_path(first, mounts)
    right, right_path = _backing_path(second, mounts)
    return left['device'] == right['device'] and _overlap(left_path, right_path)


def _absolute(value):
    return (isinstance(value, str) and value.startswith('/') and not value.startswith('//')
            and posixpath.normpath(value) == value and not any(ord(char) < 32 or ord(char) == 127 for char in value))


def _bind_path(source):
    try:
        return os.path.realpath(source, strict=True)
    except OSError as error:
        raise _fail() from error


def _created_at(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT[^\s]{1,100}', value):
        return False
    try:
        return datetime.fromisoformat(value[:-1] + '+00:00' if value.endswith('Z') else value).tzinfo is not None
    except ValueError:
        return False


def _storage_observation(root, daemon, context, mountinfo):
    enrollment = LAYOUT.read(root, daemon, context, mountinfo)
    if enrollment is None:
        raise _fail()
    namespace = LAYOUT.namespace(root)
    with _directory(namespace) as directory:
        namespace_identity = _identity(os.fstat(directory))
    mounts = _mounts(mountinfo)
    backing = LAYOUT._filesystem(namespace, mountinfo)
    if backing != LAYOUT._filesystem(LAYOUT.STATE_ROOT, mountinfo):
        raise _fail()
    selected, namespace_backing = _backing_path(namespace, mounts)
    for mount in mounts:
        if mount == selected:
            continue
        if (mount['path'].startswith(str(namespace) + '/')
                or mount['device'] == selected['device'] and _overlap(mount['root'], namespace_backing)
                and 'ro' not in mount['options']):
            raise _fail()
    return dict(layoutSha256=plan_sha256(enrollment), namespaceIdentity=namespace_identity,
                backingFilesystem=backing), mounts


def _targets(restore, prepared_generation, expected_targets):
    if (not _exact(restore, ('restoreId', 'nonce', 'imageId', 'manifestSha256', 'preparedReceiptSha256'))
            or not _match(UUID, restore['restoreId']) or not _match(UUID, restore['nonce'])
            or not isinstance(restore['imageId'], str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', restore['imageId'])
            or not _match(HASH, restore['manifestSha256']) or not _match(HASH, restore['preparedReceiptSha256'])
            or not _match(UUID, prepared_generation) or not isinstance(expected_targets, list)
            or not 1 <= len(expected_targets) <= 1024):
        raise _fail()
    keys, sources, names, uploaders, ids = set(), set(), set(), set(), set()
    for target in expected_targets:
        if (not _exact(target, TARGET_KEYS) or not _match(NAME, target['sourceName']) or target['state'] != 'ready'
                or not all(_match(HASH, target[key]) for key in ('key', 'archiveSha256', 'inventorySha256', 'uploaderId',
                                                               'volumeIdentity', 'containerIdentity', 'verificationSha256'))
                or target['key'] != _sha(('orbis.backup-volume.v1\n' + target['sourceName']).encode())
                or target['targetName'] != 'orbis-restore-' + prepared_generation + '-' + target['key']
                or not isinstance(target['uploaderName'], str) or not target['uploaderName'].startswith('orbis-volume-restore-')
                or not _match(UUID, target['uploaderName'][len('orbis-volume-restore-'):])
                or target['key'] in keys or target['sourceName'] in sources or target['targetName'] in names
                or target['uploaderName'] in uploaders or target['uploaderId'] in ids):
            raise _fail()
        keys.add(target['key']); sources.add(target['sourceName']); names.add(target['targetName'])
        uploaders.add(target['uploaderName']); ids.add(target['uploaderId'])
    if sources & names:
        raise _fail()
    return sorted(expected_targets, key=lambda target: target['key'])


class LocalDockerAdapter:
    """Code-owned bounded local Engine transport; never constructed from RPC fields.

    The root integration chooses/authenticates the socket and Docker context.
    No Docker CLI, remote transport, or target content reader is used here.
    """
    def __init__(self, engine):
        self.engine = engine

    def observe(self, *, daemon, context, restore, prepared_generation, targets, pins, authority_path, mounts, unused):
        info = self.engine.request('GET', '/info')
        if not isinstance(info, dict) or info.get('ID') != daemon:
            raise _fail()
        inspected = {}
        for target in targets:
            raw = self.engine.request('GET', '/volumes/' + target['targetName'])
            labels = {'org.orbis.role': 'volume-restore', 'org.orbis.restore': restore['restoreId'],
                      'org.orbis.generation': prepared_generation, 'org.orbis.volume-key': target['key']}
            if (not isinstance(raw, dict) or raw.get('Name') != target['targetName'] or raw.get('Driver') != 'local'
                    or raw.get('Scope') != 'local' or raw.get('Options') not in (None, {}) or raw.get('Labels') != labels
                    or not _created_at(raw.get('CreatedAt'))
                    or not _absolute(raw.get('Mountpoint'))):
                raise _fail()
            identity = dict(name=raw['Name'], createdAt=raw['CreatedAt'], driver=raw['Driver'], scope=raw['Scope'],
                            options=raw.get('Options') or {}, labels=raw['Labels'], mountpoint=raw['Mountpoint'])
            if plan_sha256(identity) != target['volumeIdentity']:
                raise _fail()
            inspected[raw['Name']] = raw
        rows = self.engine.request('GET', '/containers/json?all=1')
        if (not isinstance(rows, list) or len(rows) > 4096 or any(not isinstance(row, dict) or not _match(HASH, row.get('Id')) for row in rows)
                or len({row['Id'] for row in rows}) != len(rows)):
            raise _fail()
        allowed = set((pin['project'], service['name'], mount['target'], mount['volume'], not mount['readOnly'])
                      for pin in pins for service in pin['services'] for mount in service['mounts'])
        for row in rows:
            raw = self.engine.request('GET', '/containers/' + row['Id'] + '/json')
            if (not isinstance(raw, dict) or raw.get('Id') != row['Id'] or not isinstance(raw.get('Mounts'), list)
                    or len(raw['Mounts']) > 4096 or not isinstance(raw.get('HostConfig'), dict)
                    or not isinstance(raw.get('Config'), dict)):
                raise _fail()
            host = raw['HostConfig']
            if host.get('VolumesFrom') or host.get('Privileged'):
                raise _fail()
            labels = raw['Config'].get('Labels') or {}
            if not isinstance(labels, dict):
                raise _fail()
            for mount in raw['Mounts']:
                if (not isinstance(mount, dict) or mount.get('Type') not in ('bind', 'volume', 'tmpfs')
                        or type(mount.get('RW')) is not bool or not isinstance(mount.get('Destination'), str)):
                    raise _fail()
                source = mount.get('Source')
                if mount['Type'] == 'tmpfs':
                    continue
                if not _absolute(source):
                    raise _fail()
                # Bind sources can traverse a symlink before Docker resolves the
                # mount. Resolve metadata only, never read volume data/Mountpoint.
                resolved = _bind_path(source) if mount['Type'] == 'bind' else source
                if _same_backing(resolved, str(authority_path), mounts):
                    # Only an exact completed generation may be exposed, read-only.
                    relative = Path(source).relative_to(authority_path) if Path(source).is_relative_to(authority_path) else None
                    if (mount['Type'] != 'bind' or mount['RW'] or resolved != source or relative is None or len(relative.parts) != 2
                            or relative.parts[0] != 'generations' or not _match(UUID, relative.parts[1])
                            or mount['Destination'] != '/data/orbis-volumes'):
                        raise _fail()
                for name, volume in inspected.items():
                    if _same_backing(resolved, volume['Mountpoint'], mounts):
                        if (mount['Type'] != 'volume' or mount.get('Name') != name or source != volume['Mountpoint']
                                or unused or mount.get('Driver') != 'local' or mount.get('Subpath') or mount.get('SubPath')
                                or (labels.get('com.docker.compose.project'), labels.get('com.docker.compose.service'),
                                    mount['Destination'], name, mount['RW']) not in allowed):
                            raise _fail()
            self._configured_aliases(host, raw['Mounts'], authority_path, inspected, mounts)
            if row['Id'] in {target['uploaderId'] for target in targets}:
                raise _fail()
        ending = self.engine.request('GET', '/info')
        if not isinstance(ending, dict) or ending.get('ID') != daemon:
            raise _fail()
        return {name: target['volumeIdentity'] for target in targets for name in (target['targetName'],)}

    @staticmethod
    def _configured_aliases(host, actual, authority_path, inspected, mounts):
        """Reject pending bind/volume specifications absent from resolved Mounts."""
        binds, specifications = host.get('Binds') or [], host.get('Mounts') or []
        if not isinstance(binds, list) or not isinstance(specifications, list) or len(binds) + len(specifications) > 4096:
            raise _fail()
        requested = []
        for bind in binds:
            if not isinstance(bind, str) or not 2 <= len(bind.split(':')) <= 3:
                raise _fail()
            parts = bind.split(':')
            requested.append((parts[0], parts[1], 'ro' not in (parts[2].split(',') if len(parts) == 3 else [])))
        for specification in specifications:
            if not isinstance(specification, dict) or specification.get('Type') not in ('bind', 'volume', 'tmpfs'):
                raise _fail()
            if specification['Type'] == 'tmpfs':
                continue
            if type(specification.get('ReadOnly', False)) is not bool:
                raise _fail()
            requested.append((specification.get('Source'), specification.get('Target'), not specification.get('ReadOnly', False)))
        for source, destination, writable in requested:
            if not isinstance(source, str) or not isinstance(destination, str):
                raise _fail()
            relevant = source in inspected
            if source.startswith('/'):
                if not _absolute(source):
                    raise _fail()
                resolved = _bind_path(source)
                relevant = (_same_backing(resolved, str(authority_path), mounts)
                            or any(_same_backing(resolved, volume['Mountpoint'], mounts) for volume in inspected.values()))
            if relevant and not any(mount.get('Destination') == destination and mount.get('RW') is writable
                    and (mount.get('Source') == source or mount.get('Name') == source) for mount in actual):
                raise _fail()


def _documents(pin_documents, targets):
    if not isinstance(pin_documents, (list, tuple)) or not 1 <= len(pin_documents) <= 1024:
        raise _fail()
    files, pins, used, total = {}, [], set(), 0
    for body in pin_documents:
        pin = decode_pins(body)
        name = _sha(pin['appUrn'].encode()) + '.json'
        if name in files:
            raise _fail()
        files[name] = body
        pins.append(pin)
        total += len(body)
        used.update(mount['volume'] for service in pin['services'] for mount in service['mounts'])
    if total > TOTAL_LIMIT or used != {target['targetName'] for target in targets}:
        raise _fail()
    return dict(sorted(files.items())), sorted(pins, key=lambda pin: pin['appUrn'])


def _review(root, daemon, context, *, restore_source_sha256, restore, prepared_generation, generation,
            pin_documents, expected_targets, adapter, mountinfo=None, unused=True):
    _operator()
    if not _match(HASH, restore_source_sha256) or not _match(UUID, generation) or adapter is None:
        raise _fail()
    targets = _targets(restore, prepared_generation, expected_targets)
    files, pins = _documents(pin_documents, targets)
    storage, mounts = _storage_observation(root, daemon, context, mountinfo)
    marker = dict(version=1, schema=MARKER_SCHEMA, generation=generation, files={name: _sha(body) for name, body in files.items()})
    marker_body = _json(marker)
    tree = {'authority.json': _sha(marker_body), **{'pins/' + name: _sha(body) for name, body in files.items()}}
    observed = adapter.observe(daemon=daemon, context=context, restore=restore, prepared_generation=prepared_generation,
                               targets=targets, pins=pins, authority_path=store_path(root), mounts=mounts, unused=unused)
    if observed != {target['targetName']: target['volumeIdentity'] for target in targets}:
        raise _fail()
    if _storage_observation(root, daemon, context, mountinfo)[0] != storage:
        raise _fail()
    return dict(schema=PLAN_SCHEMA, root=str(root), daemon=daemon, context=context, **storage,
                restoreSourceSha256=restore_source_sha256, restore=restore, preparedGeneration=prepared_generation,
                generation=generation, expectedTargets=targets, files=marker['files'], markerSha256=_sha(marker_body),
                treeSha256=plan_sha256(tree)), files, marker_body


def review(root, daemon, context, **options):
    """Read-only proposal for independent root admission; never auto-approved."""
    if 'unused' in options:
        raise _fail()
    return _review(root, daemon, context, **options)[0]


@contextmanager
def _locked(root, held_lock_fd=None):
    if held_lock_fd is None:
        host = _load('orbis-host.py', 'app_volume_authority_host')
        with host.host_lock(Path(root)) as descriptor:
            yield descriptor
        return
    # An inherited descriptor is a capability, not a boolean skip-lock flag. The
    # common legacy lock serializes both enrolled and previously loaded helpers.
    if type(held_lock_fd) is not int:
        raise _fail()
    path = LAYOUT.legacy_path(root, 'host-lock')
    before = os.fstat(held_lock_fd)
    if (not stat.S_ISREG(before.st_mode) or before.st_uid != OWNER or before.st_nlink != 1
            or stat.S_IMODE(before.st_mode) != 0o600 or _identity(before) != _identity(path.lstat())):
        raise _fail()
    fcntl.flock(held_lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    yield held_lock_fd
    if (any(info.st_nlink != 1 for info in (os.fstat(held_lock_fd), path.lstat()))
            or _identity(os.fstat(held_lock_fd)) != _identity(before) or _identity(path.lstat()) != _identity(before)):
        raise _fail()


def stage(root, daemon, context, *, approved_plan_sha256, held_lock_fd=None, **options):
    """Persist one admitted generation without changing current or deleting failure evidence."""
    _operator()
    if 'unused' in options:
        raise _fail()
    with _locked(root, held_lock_fd):
        plan, files, marker = _review(root, daemon, context, **options)
        if not _match(HASH, approved_plan_sha256) or plan_sha256(plan) != approved_plan_sha256:
            raise _fail()
        path = store_path(root)
        with _directory(path.parent) as namespace:
            try:
                _mkdir(namespace, path.name)
            except FileExistsError:
                pass
        with _directory(path) as store:
            try:
                _mkdir(store, 'generations')
            except FileExistsError:
                pass
        with _directory(path / 'generations') as generations:
            try:
                _mkdir(generations, plan['generation'])
            except FileExistsError:
                result = verify(root, daemon, context, plan['generation'], adapter=options['adapter'], mountinfo=options.get('mountinfo'))
                if result['approvedPlanSha256'] != approved_plan_sha256:
                    raise _fail()
                return result
        source = path / 'generations' / plan['generation']
        with _directory(source) as directory:
            _mkdir(directory, 'pins')
            with _directory(source / 'pins') as pins:
                for name, body in files.items():
                    _write_new(pins, name, body)
                pins_identity = _identity(os.fstat(pins))
            _write_new(directory, 'authority.json', marker)
            # Recheck independently observed targets after all writes. On failure
            # the incomplete generation remains and can never be selected.
            if _review(root, daemon, context, **options)[0] != plan:
                raise _fail()
            binding = dict(schema=BINDING_SCHEMA, plan=plan, approvedPlanSha256=approved_plan_sha256,
                           generationIdentity=_identity(os.fstat(directory)), pinsIdentity=pins_identity)
            _write_new(directory, 'binding.json', _json(binding, True))
        return verify(root, daemon, context, plan['generation'], adapter=options['adapter'], mountinfo=options.get('mountinfo'))


def verify(root, daemon, context, generation, *, adapter, mountinfo=None):
    """Return verified host storage only; this descriptor is not execution authority."""
    _operator()
    if not _match(UUID, generation):
        raise _fail()
    source = store_path(root) / 'generations' / generation
    with _directory(source) as directory:
        before = _seal(os.fstat(directory))
        if set(os.listdir(directory)) != {'authority.json', 'pins', 'binding.json'}:
            raise _fail()
        binding_body = _read(directory, 'binding.json')
        binding = _parse(binding_body)
        if (not _exact(binding, ('schema', 'plan', 'approvedPlanSha256', 'generationIdentity', 'pinsIdentity'))
                or binding['schema'] != BINDING_SCHEMA or binding['generationIdentity'] != _identity(os.fstat(directory))
                or not isinstance(binding['plan'], dict) or binding['plan'].get('generation') != generation
                or plan_sha256(binding['plan']) != binding['approvedPlanSha256']):
            raise _fail()
        plan = binding['plan']
        marker = _read(directory, 'authority.json', 256 * 1024)
        with _directory(source / 'pins') as pins:
            pins_before = _seal(os.fstat(pins))
            if (binding['pinsIdentity'] != _identity(os.fstat(pins)) or not isinstance(plan.get('files'), dict)
                    or len(plan['files']) > 1024 or set(os.listdir(pins)) != set(plan['files'])
                    or any(not re.fullmatch(r'[a-f0-9]{64}\.json', name) for name in plan['files'])):
                raise _fail()
            bodies = [_read(pins, name, PIN_LIMIT) for name in sorted(plan['files'])]
            proposed, _files, proposed_marker = _review(root, daemon, context, restore_source_sha256=plan.get('restoreSourceSha256'),
                restore=plan.get('restore'), prepared_generation=plan.get('preparedGeneration'), generation=generation,
                pin_documents=bodies, expected_targets=plan.get('expectedTargets'), adapter=adapter, mountinfo=mountinfo, unused=False)
            if (proposed != plan or marker != proposed_marker or _seal(os.fstat(pins)) != pins_before
                    or _seal(os.fstat(directory)) != before or _read(directory, 'binding.json') != binding_body):
                raise _fail()
            for name, body in zip(sorted(plan['files']), bodies):
                if _read(pins, name, PIN_LIMIT) != body:
                    raise _fail()
    return dict(generation=generation, source=str(source), markerSha256=plan['markerSha256'], bindingSha256=_sha(binding_body),
                approvedPlanSha256=binding['approvedPlanSha256'], treeSha256=plan['treeSha256'], layoutSha256=plan['layoutSha256'])


def current(root, daemon, context, *, adapter, mountinfo=None):
    """An absent selector means no selected generation, never an implicit fallback."""
    _operator()
    _storage_observation(root, daemon, context, mountinfo)
    path = store_path(root)
    try:
        with _directory(path) as directory:
            try:
                body = _read(directory, 'current.json', 65536)
            except FileNotFoundError:
                return None
            value = _parse(body)
            keys = ('schema', 'generation', 'bindingSha256', 'markerSha256', 'layoutSha256', 'approvedPlanSha256', 'previousCurrentSha256')
            if (not _exact(value, keys) or value['schema'] != SELECTION_SCHEMA
                    or not _match(HASH, value['approvedPlanSha256'])
                    or value['previousCurrentSha256'] is not None and not _match(HASH, value['previousCurrentSha256'])):
                raise _fail()
            result = verify(root, daemon, context, value['generation'], adapter=adapter, mountinfo=mountinfo)
            if any(result[key] != value[key] for key in ('bindingSha256', 'markerSha256', 'layoutSha256')):
                raise _fail()
            if _read(directory, 'current.json', 65536) != body:
                raise _fail()
            return dict(**result, currentSha256=_sha(body), selectionApprovedPlanSha256=value['approvedPlanSha256'],
                        previousCurrentSha256=value['previousCurrentSha256'])
    except FileNotFoundError:
        # Only absence of the store itself is empty; missing generation files fail closed.
        if path.exists() or path.is_symlink():
            raise _fail()
        return None


def review_selection(root, daemon, context, generation, *, expected_current_sha256, adapter, mountinfo=None):
    """Review a CAS or rollback to any retained, complete generation."""
    if expected_current_sha256 is not None and not _match(HASH, expected_current_sha256):
        raise _fail()
    previous = current(root, daemon, context, adapter=adapter, mountinfo=mountinfo)
    if (previous['currentSha256'] if previous else None) != expected_current_sha256:
        raise _fail()
    target = verify(root, daemon, context, generation, adapter=adapter, mountinfo=mountinfo)
    with _directory(Path(target['source'])) as directory:
        plan = _parse(_read(directory, 'binding.json'))['plan']
    # This is a pre-lifecycle selector transaction: no app or uploader may be using
    # the proposed targets. The surrounding runtime must maintain its own fence.
    options = dict(restore_source_sha256=plan['restoreSourceSha256'], restore=plan['restore'], prepared_generation=plan['preparedGeneration'],
                   generation=generation, expected_targets=plan['expectedTargets'], adapter=adapter, mountinfo=mountinfo)
    with _directory(Path(target['source']) / 'pins') as pins:
        options['pin_documents'] = [_read(pins, name, PIN_LIMIT) for name in sorted(plan['files'])]
    if _review(root, daemon, context, **options)[0] != plan:
        raise _fail()
    return dict(schema=SELECTION_PLAN_SCHEMA, root=str(root), daemon=daemon, context=context,
                generation=generation, bindingSha256=target['bindingSha256'], markerSha256=target['markerSha256'],
                layoutSha256=target['layoutSha256'], previousCurrentSha256=expected_current_sha256)


def activate_cas(root, daemon, context, generation, *, expected_current_sha256, approved_plan_sha256,
                 adapter, held_lock_fd=None, mountinfo=None):
    """CAS the host selector only. Rollback uses a new review of the retained target.

    Retrying the identical admitted transition is idempotent. A stale predecessor
    never overwrites a different transition. Failure after rename is uncertain;
    preserve all data and inspect current before any newly admitted rollback.
    """
    _operator()
    if not _match(HASH, approved_plan_sha256):
        raise _fail()
    with _locked(root, held_lock_fd):
        existing = current(root, daemon, context, adapter=adapter, mountinfo=mountinfo)
        if (existing and existing['generation'] == generation
                and existing['selectionApprovedPlanSha256'] == approved_plan_sha256
                and existing['previousCurrentSha256'] == expected_current_sha256):
            return existing
        plan = review_selection(root, daemon, context, generation, expected_current_sha256=expected_current_sha256,
                                adapter=adapter, mountinfo=mountinfo)
        if plan_sha256(plan) != approved_plan_sha256:
            raise _fail()
        value = {key: plan[key] for key in ('generation', 'bindingSha256', 'markerSha256', 'layoutSha256', 'previousCurrentSha256')}
        value.update(schema=SELECTION_SCHEMA, approvedPlanSha256=approved_plan_sha256)
        body = _json(value, True)
        temporary = '.selection-' + approved_plan_sha256 + '.json'
        with _directory(store_path(root)) as directory:
            # Preserve incomplete writes on failure. A complete retry can reuse
            # this exact temporary; it can never authorize a different transition.
            try:
                _write_new(directory, temporary, body)
            except FileExistsError:
                if _read(directory, temporary, 65536) != body:
                    raise _fail()
            if review_selection(root, daemon, context, generation, expected_current_sha256=expected_current_sha256,
                                adapter=adapter, mountinfo=mountinfo) != plan:
                raise _fail()
            os.replace(temporary, 'current.json', src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)
        return current(root, daemon, context, adapter=adapter, mountinfo=mountinfo)
