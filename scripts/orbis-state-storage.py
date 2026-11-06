#!/usr/bin/env python3
"""Narrow legacy state permissions at an independently verified controller stop."""
import hashlib
import json
import os
import re
import stat
import uuid
from contextlib import contextmanager
from pathlib import Path

OWNER = 0
SCHEMA = 'orbis.state-permissions.v1'
MAXIMUM = 1024 * 1024


class StateStorageError(ValueError):
    pass


def fail():
    return StateStorageError('Orbis state storage changed or could not be verified')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def identity(info):
    return {'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid,
            'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}


def operator():
    if os.geteuid() != OWNER:
        raise StateStorageError('State storage repair requires a root operator')


@contextmanager
def ancestry(path, *, private=False):
    path = Path(path)
    if not path.is_absolute() or str(path) != os.path.realpath(path):
        raise fail()
    descriptors, bindings = [], []
    try:
        parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(parent)
        for component in path.parts[1:]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            descriptors.append(child)
            info = os.fstat(child)
            if (not stat.S_ISDIR(info.st_mode) or (private and info.st_uid not in {0, OWNER})
                    or info.st_mode & (0o022 if private else 0o002)):
                raise fail()
            bindings.append((parent, component, child, identity(info)))
            parent = child
        if private and (os.fstat(parent).st_uid != OWNER or os.fstat(parent).st_mode & 0o077):
            raise fail()
        def check():
            for base, name, child, expected in bindings:
                if identity(os.fstat(child)) != expected or identity(os.stat(name, dir_fd=base, follow_symlinks=False)) != expected:
                    raise fail()
        check()
        yield parent, [item[3] for item in bindings], check
        check()
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def definition(row):
    host = dict(row['HostConfig'])
    host.pop('RestartPolicy', None)
    return digest({key: row[key] for key in ('Id', 'Created', 'Image', 'Path', 'Args', 'Config', 'Mounts')} | {'host': host})


def binding(root, row):
    mounts = [mount for mount in row['Mounts'] if mount.get('Destination') == '/data/state']
    if (len(mounts) != 1 or mounts[0].get('Type') != 'bind' or mounts[0].get('RW') is not True
            or mounts[0].get('Source') != str(Path(root) / 'state')
            or any(mount.get('Destination', '').startswith('/data/state/') for mount in row['Mounts'])):
        raise fail()
    if row['Config'].get('User', '') not in {'', 'root', '0', '0:0', 'root:root'} or row['HostConfig'].get('UsernsMode') not in {'', 'host'}:
        raise fail()
    return mounts[0]


def subtree_identities(path):
    """Inventory inode identities without reading data or following symlinks."""
    found, count = set(), 0
    def walk(descriptor, depth):
        nonlocal count
        if depth > 64:
            raise fail()
        before = os.fstat(descriptor)
        found.add((before.st_dev, before.st_ino))
        with os.scandir(descriptor) as entries:
            for entry in entries:
                count += 1
                if count > 100000:
                    raise fail()
                info = os.stat(entry.name, dir_fd=descriptor, follow_symlinks=False)
                found.add((info.st_dev, info.st_ino))
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                    try:
                        if identity(info) != identity(os.fstat(child)):
                            raise fail()
                        walk(child, depth + 1)
                        if identity(info) != identity(os.stat(entry.name, dir_fd=descriptor, follow_symlinks=False)):
                            raise fail()
                    finally:
                        os.close(child)
        after = os.fstat(descriptor)
        if identity(before) != identity(after) or (before.st_mtime_ns, before.st_ctime_ns) != (after.st_mtime_ns, after.st_ctime_ns):
            raise fail()
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        walk(descriptor, 0)
    finally:
        os.close(descriptor)
    return found


def only_writer(root, runtime, controller):
    state = Path(root) / 'state'
    state_inode = (state.stat().st_dev, state.stat().st_ino)
    ancestry_inodes = {(item.stat().st_dev, item.stat().st_ino) for item in (state, *state.parents)}
    settings = (state / 'settings.json').stat()
    settings_inode = (settings.st_dev, settings.st_ino)
    protected = subtree_identities(state)
    writers = []
    for row in runtime.containers():
        for mount in row['Mounts']:
            source = mount.get('Source')
            if not mount.get('RW') or not isinstance(source, str) or not source.startswith('/'):
                continue
            source = Path(os.path.realpath(source))
            mounted = runtime.mount_identity(row, mount)
            source_parents = {(item.stat().st_dev, item.stat().st_ino) for item in source.parents}
            if (source == state or source in state.parents or state in source.parents
                    or mounted in ancestry_inodes or mounted in protected or mounted == settings_inode or state_inode in source_parents):
                writers.append(row['Id'])
                break
    if sorted(writers) != [controller]:
        raise StateStorageError('Another container can write Orbis state')


def file_snapshot(descriptor):
    before = os.fstat(descriptor)
    if (not stat.S_ISREG(before.st_mode) or before.st_uid != OWNER or before.st_nlink != 1
            or not 1 <= before.st_size <= MAXIMUM):
        raise fail()
    os.lseek(descriptor, 0, os.SEEK_SET)
    hashed, size = hashlib.sha256(), 0
    while True:
        data = os.read(descriptor, min(65536, MAXIMUM + 1 - size))
        if not data:
            break
        hashed.update(data)
        size += len(data)
        if size > MAXIMUM:
            raise fail()
    after = os.fstat(descriptor)
    if (identity(before) != identity(after) or size != before.st_size
            or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
        raise fail()
    return identity(after) | {'links': after.st_nlink, 'bytes': size, 'sha256': hashed.hexdigest()}


class PreparedState:
    def __init__(self, root, runtime, row, parent, state, settings, ancestry_seal, ancestry_check):
        self.root, self.runtime, self.parent = root, runtime, parent
        self.state, self.settings = state, settings
        self.ancestry_check = ancestry_check
        state_info = os.fstat(state)
        settings_info = file_snapshot(settings)
        if (state_info.st_uid != OWNER or stat.S_IMODE(state_info.st_mode) not in {0o700, 0o750, 0o755, 0o770, 0o775, 0o777}
                or settings_info['mode'] not in {0o600, 0o640, 0o644, 0o660, 0o664, 0o666}):
            raise fail()
        self.plan = {'schema': SCHEMA, 'root': str(root), 'daemon': runtime.daemon_id(),
                     'controller': row['Id'], 'definition': definition(row), 'startedAt': row['State']['StartedAt'],
                     'ancestry': ancestry_seal, 'mount': binding(root, row), 'restartPolicy': row['HostConfig']['RestartPolicy'],
                     'state': identity(state_info), 'settings': settings_info,
                     'desired': {'state': stat.S_IMODE(state_info.st_mode) & ~0o022, 'settings': 0o600}}

    def check(self, *, secured=False):
        self.ancestry_check()
        for base, name, descriptor in ((self.parent, 'state', self.state), (self.state, 'settings.json', self.settings)):
            named = os.stat(name, dir_fd=base, follow_symlinks=False)
            if (not (stat.S_ISDIR(named.st_mode) if name == 'state' else stat.S_ISREG(named.st_mode))
                    or identity(named) != identity(os.fstat(descriptor))):
                raise fail()
        for name, actual in (('state', identity(os.fstat(self.state))), ('settings', file_snapshot(self.settings))):
            expected = self.plan[name]
            if secured:
                if actual['mode'] not in {expected['mode'], self.plan['desired'][name]}:
                    raise fail()
                actual = actual | {'mode': expected['mode']}
            if actual != expected:
                raise fail()

    def quiet(self):
        row = self.runtime.inspect(self.plan['controller'])
        if (self.runtime.daemon_id() != self.plan['daemon'] or definition(row) != self.plan['definition']
                or binding(self.root, row) != self.plan['mount']
                or row['State'].get('Status') not in {'exited', 'created'} or row['State'].get('Running') is not False
                or row['State'].get('Paused') or row['State'].get('Restarting') or row['State'].get('Pid') != 0
                or row['HostConfig']['RestartPolicy'].get('Name') != 'no'):
            raise StateStorageError('The reviewed Orbis controller must be stopped with restart disabled')
        only_writer(self.root, self.runtime, self.plan['controller'])


@contextmanager
def prepare(root, runtime, controller):
    """Caller holds the host lock and keeps this context open through the stop."""
    operator()
    root = Path(root)
    if not re.fullmatch('[a-f0-9]{64}', controller):
        raise fail()
    with ancestry(root) as (parent, seals, check):
        descriptors = []
        try:
            state = os.open('state', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            descriptors.append(state)
            settings = os.open('settings.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=state)
            descriptors.append(settings)
            row = runtime.inspect(controller)
            if row['State'].get('Running') is not True or row['State'].get('Paused') or row['State'].get('Restarting'):
                raise fail()
            only_writer(root, runtime, controller)
            prepared = PreparedState(root, runtime, row, parent, state, settings, seals, check)
            with runtime.mounted_state(row) as mounted:
                if identity(os.fstat(mounted)) != identity(os.fstat(state)):
                    raise fail()
                mounted_file = os.open('settings.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=mounted)
                try:
                    if file_snapshot(mounted_file) != prepared.plan['settings']:
                        raise fail()
                finally:
                    os.close(mounted_file)
            current = runtime.inspect(controller)
            if (definition(current) != prepared.plan['definition']
                    or current['State']['StartedAt'] != prepared.plan['startedAt']
                    or current['State'].get('Running') is not True):
                raise fail()
            prepared.check()
            yield prepared
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)


def save_receipt(directory, name, value):
    if not re.fullmatch(r'[a-f0-9]{64}(?:\.runtime)?\.json', name):
        raise fail()
    if value.get('schema') != SCHEMA or digest(value.get('plan')) != name[:64]:
        raise fail()
    with ancestry(directory, private=True) as (parent, _, check):
        try:
            previous = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        except FileNotFoundError:
            previous = None
        if previous is not None:
            try:
                info = os.fstat(previous)
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER or info.st_nlink != 1
                        or info.st_mode & 0o077 or not 1 <= info.st_size <= 65536):
                    raise fail()
                stored = json.loads(os.read(previous, 65537))
                if (stored.get('schema') != SCHEMA or stored.get('plan') != value['plan']
                        or stored.get('phase') not in {'prepared', 'quiescing', 'controller-stopped', 'state-secured',
                            'settings-secured', 'permissions-secured', 'restarting', 'complete', 'recovery-required'}):
                    raise fail()
                if identity(info) != identity(os.fstat(previous)) or identity(info) != identity(os.stat(name, dir_fd=parent, follow_symlinks=False)):
                    raise fail()
            finally:
                os.close(previous)
        temporary = '.' + str(uuid.uuid4()) + '.tmp'
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write((json.dumps(value, sort_keys=True) + '\n').encode())
                stream.flush()
                os.fsync(stream.fileno())
            check()
            os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass


def record_plan(prepared, approved_sha256, receipts):
    """Persist the witnessed intent before the caller changes restart policy."""
    operator()
    if digest(prepared.plan) != approved_sha256 or not re.fullmatch('[a-f0-9]{64}', approved_sha256):
        raise StateStorageError('Approve the exact state permission plan before applying it')
    prepared.check(secured=True)
    name = approved_sha256 + '.json'
    record = {'schema': SCHEMA, 'plan': prepared.plan, 'phase': 'prepared'}
    save_receipt(receipts, name, record)
    return record


def apply_stopped(prepared, approved_sha256, receipts):
    """Never stops or starts containers; retain narrowed modes on interruption."""
    operator()
    prepared.quiet()
    record = record_plan(prepared, approved_sha256, receipts)
    name = approved_sha256 + '.json'
    try:
        for key, descriptor in (('state', prepared.state), ('settings', prepared.settings)):
            prepared.quiet()
            prepared.check(secured=True)
            os.fchmod(descriptor, prepared.plan['desired'][key])
            os.fsync(descriptor)
            prepared.check(secured=True)
            record['phase'] = key + '-secured'
            save_receipt(receipts, name, record)
        prepared.quiet()
        prepared.check(secured=True)
        record['phase'] = 'complete'
        save_receipt(receipts, name, record)
        return record
    except BaseException:
        record['phase'] = 'recovery-required'
        save_receipt(receipts, name, record)
        raise


@contextmanager
def resume_stopped(root, runtime, approved_sha256, receipts):
    """Recover only the identities and bytes previously recorded under root authority."""
    operator()
    if not re.fullmatch('[a-f0-9]{64}', approved_sha256):
        raise fail()
    with ancestry(receipts, private=True) as (receipt_parent, _, receipt_check):
        descriptor = os.open(approved_sha256 + '.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=receipt_parent)
        try:
            before = os.fstat(descriptor)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != OWNER or before.st_nlink != 1
                    or before.st_mode & 0o077 or not 1 <= before.st_size <= 65536):
                raise fail()
            body = os.read(descriptor, 65537)
            if len(body) != before.st_size or identity(before) != identity(os.fstat(descriptor)):
                raise fail()
            record = json.loads(body)
        finally:
            os.close(descriptor)
        receipt_check()
    if (set(record) != {'schema', 'plan', 'phase'} or record['schema'] != SCHEMA
            or record['phase'] not in {'prepared', 'state-secured', 'settings-secured', 'complete', 'recovery-required'}
            or digest(record['plan']) != approved_sha256 or record['plan']['root'] != str(root)):
        raise fail()
    plan = record['plan']
    with ancestry(root) as (parent, seals, check):
        if seals != plan['ancestry']:
            raise fail()
        descriptors = []
        try:
            state = os.open('state', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            descriptors.append(state)
            settings = os.open('settings.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=state)
            descriptors.append(settings)
            row = runtime.inspect(plan['controller'])
            prepared = PreparedState(Path(root), runtime, row, parent, state, settings, seals, check)
            prepared.plan = plan
            prepared.quiet()
            prepared.check(secured=True)
            yield prepared
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)
