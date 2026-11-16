"""Exclusive physical-PG copy and fixed inspection sandbox; never a promotion profile."""
import base64
import hashlib
import importlib.util
import os
from pathlib import Path, PurePosixPath
import re
import stat
import time


spec = importlib.util.spec_from_file_location('orbis_pg_inspection_checkpoint_format', Path(__file__).with_name('orbis-host-core-checkpoint-materialize.py'))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)
spec = importlib.util.spec_from_file_location('orbis_pg_execution_profiles', Path(__file__).with_name('orbis-host-core-pg-profiles.py'))
PG = importlib.util.module_from_spec(spec)
spec.loader.exec_module(PG)
SCHEMA = 'orbis.core-source-pg-inspection.v1'
ROLE_SCHEMA = 'orbis.core-source-pg-inspection.v2'
ROLE_OVERLAY_SCHEMA = 'orbis.core-inspection-fixed-overlay.v2'
EXECUTION_SCHEMA = 'orbis.core-source-pg-inspection.v3'
EXECUTION_OVERLAY_SCHEMA = 'orbis.core-inspection-fixed-overlay.v3'
NAME = re.compile(r'[a-zA-Z_][a-zA-Z0-9_]{0,62}')
HEX = re.compile(r'[a-f0-9]{64}')
PG17_ARM64_IMAGE = 'sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'
QUARANTINE = {'postgresql.auto.conf', 'postgresql.conf', 'recovery.conf', 'recovery.signal', 'standby.signal', 'recovery.done'}
REFUSE = {'postmaster.pid', 'postgresql.auto.conf.tmp', 'postgresql.auto.conf.lock', 'backup_label', 'tablespace_map'}
SETTINGS = {
    'config_file': '/inspection-config/postgresql.conf', 'data_directory': '/var/lib/postgresql/data',
    'hba_file': '/inspection-config/pg_hba.conf', 'ident_file': '/inspection-config/pg_ident.conf',
    'listen_addresses': '', 'unix_socket_directories': '/var/run/postgresql', 'unix_socket_permissions': '0770',
    'port': '5432', 'ssl': 'off', 'shared_preload_libraries': '', 'local_preload_libraries': '', 'session_preload_libraries': '',
    'archive_mode': 'off', 'archive_command': '', 'archive_library': '', 'restore_command': '',
    'archive_cleanup_command': '', 'recovery_end_command': '', 'ssl_passphrase_command': '', 'external_pid_file': '',
    'autovacuum': 'off', 'default_transaction_read_only': 'on', 'max_connections': '4', 'max_worker_processes': '0',
    'max_parallel_workers': '0', 'max_parallel_workers_per_gather': '0', 'max_logical_replication_workers': '0',
    'max_sync_workers_per_subscription': '0', 'max_wal_senders': '0', 'max_replication_slots': '0',
    'logging_collector': 'off', 'log_destination': 'stderr', 'log_statement': 'none',
    'log_min_error_statement': 'panic', 'log_error_verbosity': 'terse',
}
RESOURCE_SETTINGS = {'shared_buffers': '32MB', 'work_mem': '1MB', 'maintenance_work_mem': '16MB'}
CONFIG = {
    'postgresql.conf': b"# fixed isolated inspection configuration\n",
    'pg_hba.conf': b'local all postgres trust\nlocal all all reject\n',
    'pg_ident.conf': b'',
}


class ProfileError(ValueError):
    pass


def fail():
    return ProfileError('The source PGDATA or fixed inspection profile is unsupported. Original captured data was preserved.')


def digest(body):
    return hashlib.sha256(body).hexdigest()


def write_exclusive(directory, name, body, uid, gid, mode):
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
    try:
        position = 0
        while position < len(body):
            written = os.write(descriptor, body[position:])
            if written <= 0:
                raise fail()
            position += written
        os.fchown(descriptor, uid, gid)
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def regular_digest(directory, name, authority, maximum):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 <= before.st_size <= maximum:
            raise fail()
        hashed, count = hashlib.sha256(), 0
        while block := os.read(descriptor, 65536):
            count += len(block)
            if count > maximum:
                raise fail()
            hashed.update(block)
        if (count != before.st_size or authority.seal(before) != authority.seal(os.fstat(descriptor))
                or authority.seal(before) != authority.seal(os.stat(name, dir_fd=directory, follow_symlinks=False))):
            raise fail()
        return {'bytes': count, 'sha256': hashed.hexdigest()}
    finally:
        os.close(descriptor)


def image_profile(image):
    if (not isinstance(image, dict) or image.get('Id') != PG17_ARM64_IMAGE
            or image.get('Os') != 'linux' or image.get('Architecture') != 'arm64'
            or image.get('Config', {}).get('Volumes') != {'/var/lib/postgresql/data': {}}):
        raise ProfileError('No independently qualified PostgreSQL execution profile matches this exact image and platform')
    # This named profile was observed in the exact immutable image, not inferred
    # from arbitrary captured file ownership or generalized across distributions.
    return {'schema': SCHEMA, 'imageId': PG17_ARM64_IMAGE, 'os': 'linux', 'architecture': 'arm64', 'major': 17, 'uid': 70, 'gid': 70}


def role_bound_image_profile(image, role, projection_sha):
    if (not isinstance(role, str) or not NAME.fullmatch(role)
            or not isinstance(projection_sha, str) or not HEX.fullmatch(projection_sha)):
        raise fail()
    return {**image_profile(image), 'schema': ROLE_SCHEMA, 'role': role, 'sourceProjectionSha256': projection_sha}


def execution_image_profile(image):
    return PG.execution_image_profile(image)


def role_bound_execution_profile(image, role, projection_sha):
    if (not isinstance(role, str) or not NAME.fullmatch(role)
            or not isinstance(projection_sha, str) or not HEX.fullmatch(projection_sha)):
        raise fail()
    return {**execution_image_profile(image), 'schema': EXECUTION_SCHEMA,
            'role': role, 'sourceProjectionSha256': projection_sha}


def binary_for(profile, tool):
    validate_profile(profile)
    if profile['schema'] == EXECUTION_SCHEMA:
        return PG.binary_for(profile, tool)
    if not isinstance(tool, str) or tool not in PG.TOOLS:
        raise fail()
    return '/usr/local/bin/' + tool


def overlay_schema(profile):
    if profile['schema'] == EXECUTION_SCHEMA:
        return EXECUTION_OVERLAY_SCHEMA
    return ROLE_OVERLAY_SCHEMA if profile['schema'] == ROLE_SCHEMA else 'orbis.core-inspection-fixed-overlay.v1'


def validate_profile(profile):
    if not isinstance(profile, dict):
        raise fail()
    image = {'Id': PG17_ARM64_IMAGE, 'Os': 'linux', 'Architecture': 'arm64',
             'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}}
    if profile.get('schema') == EXECUTION_SCHEMA:
        expected = role_bound_execution_profile(PG.image_for_profile(profile), profile.get('role'), profile.get('sourceProjectionSha256'))
    elif profile.get('schema') == ROLE_SCHEMA:
        expected = role_bound_image_profile(image, profile.get('role'), profile.get('sourceProjectionSha256'))
    else:
        expected = image_profile(image)
    if M.R.PACK.canonical(profile) != M.R.PACK.canonical(expected):
        raise fail()
    return profile


def settings_for(profile):
    validate_profile(profile)
    settings = dict(SETTINGS)
    if profile['schema'] == EXECUTION_SCHEMA and profile['major'] == 14:
        settings.pop('archive_library')
    return settings | ({'search_path': 'pg_catalog'} if profile['schema'] in {ROLE_SCHEMA, EXECUTION_SCHEMA} else {})


def config_for(profile):
    validate_profile(profile)
    if profile['schema'] in {ROLE_SCHEMA, EXECUTION_SCHEMA}:
        return CONFIG | {'pg_hba.conf': ('local all "' + profile['role'] + '" trust\nlocal all all reject\n').encode('ascii')}
    return dict(CONFIG)


def copy_tree(source, target, authority, *, maximum=64 * 1024 ** 3):
    """Copy only bounded regular physical data; no links, sockets or external tablespaces."""
    total, count, result = 0, 0, []
    deadline = time.monotonic() + 300
    def visit(origin, destination, prefix):
        nonlocal total, count
        before = os.fstat(origin)
        names = sorted(os.listdir(origin))
        for name in names:
            count += 1
            if (count > 100000 or time.monotonic() > deadline or '/' in name or name in {'.', '..'}
                    or any(ord(char) < 32 or ord(char) == 127 for char in name)):
                raise fail()
            value = os.stat(name, dir_fd=origin, follow_symlinks=False)
            relative = str(PurePosixPath(prefix, name))
            if stat.S_ISDIR(value.st_mode):
                os.mkdir(name, 0o700, dir_fd=destination)
                src = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=origin)
                dst = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=destination)
                try:
                    if authority.seal(value) != authority.seal(os.fstat(src)):
                        raise fail()
                    visit(src, dst, relative)
                finally:
                    os.close(src)
                    os.close(dst)
                item = {'path': relative, 'kind': 'directory', 'sourceSeal': list(authority.seal(value))}
            elif stat.S_ISREG(value.st_mode) and value.st_nlink == 1:
                total += value.st_size
                if total > maximum:
                    raise fail()
                available = os.fstatvfs(destination)
                if available.f_bavail * available.f_frsize < value.st_size + 256 * 1024 ** 2:
                    raise fail()
                src = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=origin)
                dst = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=destination)
                try:
                    if authority.seal(value) != authority.seal(os.fstat(src)):
                        raise fail()
                    hashed, length = hashlib.sha256(), 0
                    while block := os.read(src, 65536):
                        if time.monotonic() > deadline:
                            raise fail()
                        hashed.update(block)
                        length += len(block)
                        if length > value.st_size:
                            raise fail()
                        offset = 0
                        while offset < len(block):
                            written = os.write(dst, block[offset:])
                            if written <= 0:
                                raise fail()
                            offset += written
                    if length != value.st_size or authority.seal(value) != authority.seal(os.fstat(src)):
                        raise fail()
                    entry = {'uid': value.st_uid, 'gid': value.st_gid, 'mode': stat.S_IMODE(value.st_mode),
                             'mtimeNs': value.st_mtime_ns, 'xattrs': M.R.PACK.attributes(src)}
                    if any(not base64.b64decode(key).startswith(b'user.') for key in entry['xattrs']):
                        raise fail()
                    M.attributes(dst, entry)
                    if M.R.PACK.attributes(dst) != entry['xattrs']:
                        raise fail()
                    item = {'path': relative, 'kind': 'file', 'bytes': length, 'sha256': hashed.hexdigest(),
                            'sourceSeal': list(authority.seal(value))}
                finally:
                    os.close(src)
                    os.close(dst)
                if regular_digest(destination, name, authority, maximum) != {'bytes': item['bytes'], 'sha256': item['sha256']}:
                    raise fail()
            else:
                raise fail()
            if authority.seal(value) != authority.seal(os.stat(name, dir_fd=origin, follow_symlinks=False)):
                raise fail()
            result.append(item)
        if authority.seal(before) != authority.seal(os.fstat(origin)) or sorted(os.listdir(origin)) != names:
            raise fail()
        entry = {'uid': before.st_uid, 'gid': before.st_gid, 'mode': stat.S_IMODE(before.st_mode),
                 'mtimeNs': before.st_mtime_ns, 'xattrs': M.R.PACK.attributes(origin)}
        if any(not base64.b64decode(key).startswith(b'user.') for key in entry['xattrs']):
            raise fail()
        M.attributes(destination, entry)
    visit(source, target, '')
    return {'schema': 'orbis.core-inspection-physical-copy.v1', 'fileBytes': total, 'entryCount': count,
            'sourceTreeSha256': digest(M.R.PACK.canonical(sorted(result, key=lambda item: item['path']))), 'rootSourceSeal': list(authority.seal(os.fstat(source)))}


def _copy_destination(directory, authority):
    with authority.protected_directory(directory.parent):
        pass
    directory.mkdir(mode=0o700)
    (directory / 'pgdata').mkdir(mode=0o700)
    (directory / 'quarantined-config').mkdir(mode=0o700)
    (directory / 'config').mkdir(mode=0o700)


def _copy_source_fd(source, directory, profile, authority, maximum):
    details = os.fstat(source)
    # Private PGDATA is accessed by its pinned uid; the worker's primary gid can differ.
    # The captured gid is preserved and bound by the physical copy and prepared inventory.
    if (not stat.S_ISDIR(details.st_mode) or details.st_uid != profile['uid']
            or profile['schema'] not in {ROLE_SCHEMA, EXECUTION_SCHEMA} and details.st_gid != profile['gid']
            or stat.S_IMODE(details.st_mode) not in {0o700, 0o750} or set(os.listdir(source)) & REFUSE):
        raise fail()
    if regular_digest(source, 'PG_VERSION', authority, 3) not in [
            {'bytes': len(body), 'sha256': digest(body)} for body in (str(profile['major']).encode(), (str(profile['major']) + '\n').encode())]:
        raise fail()
    for name in QUARANTINE & set(os.listdir(source)):
        regular_digest(source, name, authority, 2 * 1024 * 1024)
    target = os.open(directory / 'pgdata', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        return copy_tree(source, target, authority, maximum=maximum)
    finally:
        os.close(target)


def prepare_copy(anchor, relative, directory, profile, authority):
    profile = dict(validate_profile(profile))
    anchor, directory = Path(anchor), Path(directory)
    parts = PurePosixPath(M.R.PACK.relative(relative)).parts
    if not parts or parts[0] != 'resources':
        raise fail()
    _copy_destination(directory, authority)
    with authority.protected_directory(anchor) as source_root:
        source = os.dup(source_root)
        try:
            for name in parts:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=source)
                os.close(source)
                source = child
            copied = _copy_source_fd(source, directory, profile, authority, 64 * 1024 ** 3)
        finally:
            os.close(source)
    return _copy_overlay(directory, profile, authority, copied)


def prepare_copy_from_fd(source, directory, profile, authority, *, maximum=64 * 1024 ** 3):
    """Use a caller-held readonly directory FD; its source authority stays with the caller."""
    profile = dict(validate_profile(profile))
    if type(source) is not int or type(maximum) is not int or not 1 <= maximum <= 64 * 1024 ** 3:
        raise fail()
    directory = Path(directory)
    _copy_destination(directory, authority)
    copied = _copy_source_fd(source, directory, profile, authority, maximum)
    return _copy_overlay(directory, profile, authority, copied)


def _copy_overlay(directory, profile, authority, copied):
    settings, configuration = settings_for(profile), config_for(profile)
    pgdata = os.open(directory / 'pgdata', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    quarantine = os.open(directory / 'quarantined-config', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    config = os.open(directory / 'config', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        quarantined = {}
        for name in sorted(QUARANTINE & set(os.listdir(pgdata))):
            value = os.stat(name, dir_fd=pgdata, follow_symlinks=False)
            if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_size > 2 * 1024 * 1024:
                raise fail()
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=pgdata)
            try:
                body = os.read(descriptor, 2 * 1024 * 1024 + 1)
                if len(body) != value.st_size or authority.seal(value) != authority.seal(os.fstat(descriptor)):
                    raise fail()
                quarantined[name] = {'bytes': len(body), 'sha256': digest(body)}
            finally:
                os.close(descriptor)
            os.rename(name, name, src_dir_fd=pgdata, dst_dir_fd=quarantine)
        write_exclusive(pgdata, 'postgresql.auto.conf', b'', profile['uid'], profile['gid'], 0o600)
        fixed = {}
        for name, body in configuration.items():
            write_exclusive(config, name, body, authority.OWNER, profile['gid'], 0o440)
            fixed[name] = {'bytes': len(body), 'sha256': digest(body)}
        os.fchown(config, authority.OWNER, profile['gid'])
        os.fchmod(config, 0o750)
        for descriptor in (pgdata, quarantine, config):
            os.fsync(descriptor)
        return {'schema': overlay_schema(profile), 'copy': copied, 'quarantined': quarantined,
                'autoConf': {'bytes': 0, 'sha256': digest(b'')}, 'fixed': fixed,
                'settingsSha256': digest(M.R.PACK.canonical(settings)), 'profile': profile, 'restoreAuthority': False}
    finally:
        os.close(pgdata)
        os.close(quarantine)
        os.close(config)


def prepared_copy_inventory(directory, profile, authority, *, maximum=64 * 1024 ** 3):
    """Pin sanitized, stopped working PGDATA before approval and before its first start."""
    try:
        profile = dict(validate_profile(profile))
        if type(maximum) is not int or not 1 <= maximum <= 64 * 1024 ** 3:
            raise fail()
        directory = Path(directory)
        deadline, total, count, metadata_bytes = time.monotonic() + 300, 0, 0, 0
        entries, inodes = [], set()

        def record(descriptor, path, kind, expected):
            if time.monotonic() > deadline or getattr(expected, 'st_flags', 0):
                raise fail()
            identity = (expected.st_dev, expected.st_ino)
            if identity in inodes or expected.st_dev != root_stat.st_dev:
                raise fail()
            inodes.add(identity)
            attrs = M.R.PACK.attributes(descriptor)
            if any(not base64.b64decode(name).startswith(b'user.') for name in attrs):
                raise fail()
            value = {'path': path, 'kind': kind, 'dev': expected.st_dev, 'ino': expected.st_ino,
                     'ctimeNs': expected.st_ctime_ns, 'uid': expected.st_uid, 'gid': expected.st_gid,
                     'mode': stat.S_IMODE(expected.st_mode), 'mtimeNs': expected.st_mtime_ns,
                     'xattrsSha256': digest(M.R.PACK.canonical(attrs))}
            if kind == 'file':
                hashed, size = hashlib.sha256(), 0
                while block := os.read(descriptor, min(65536, expected.st_size + 1 - size)):
                    size += len(block)
                    if size > expected.st_size or time.monotonic() > deadline:
                        raise fail()
                    hashed.update(block)
                if size != expected.st_size:
                    raise fail()
                value.update(bytes=size, sha256=hashed.hexdigest())
            if authority.seal(expected) != authority.seal(os.fstat(descriptor)):
                raise fail()
            return value

        def visit(descriptor, prefix):
            nonlocal total, count, metadata_bytes
            before, names = os.fstat(descriptor), sorted(os.listdir(descriptor))
            for name in names:
                count += 1
                if (count > 100000 or time.monotonic() > deadline or '/' in name or name in {'.', '..'}
                        or any(ord(char) < 32 or ord(char) == 127 for char in name)):
                    raise fail()
                expected = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                kind = 'directory' if stat.S_ISDIR(expected.st_mode) else 'file'
                if not stat.S_ISDIR(expected.st_mode) and (not stat.S_ISREG(expected.st_mode) or expected.st_nlink != 1):
                    raise fail()
                if kind == 'file':
                    total += expected.st_size
                    if total > maximum:
                        raise fail()
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
                                | (os.O_DIRECTORY if kind == 'directory' else 0), dir_fd=descriptor)
                try:
                    if authority.seal(expected) != authority.seal(os.fstat(child)):
                        raise fail()
                    path = str(PurePosixPath(prefix, name))
                    value = record(child, path, kind, expected)
                    metadata_bytes += len(M.R.PACK.canonical(value)) + 1
                    if metadata_bytes > M.R.PACK.METADATA_LIMIT:
                        raise fail()
                    entries.append(value)
                    if kind == 'directory':
                        visit(child, path)
                    if (authority.seal(expected) != authority.seal(os.fstat(child))
                            or authority.seal(expected) != authority.seal(os.stat(name, dir_fd=descriptor, follow_symlinks=False))):
                        raise fail()
                finally:
                    os.close(child)
            if authority.seal(before) != authority.seal(os.fstat(descriptor)) or names != sorted(os.listdir(descriptor)):
                raise fail()

        with authority.protected_directory(directory) as parent:
            outer_stat = os.fstat(parent)
            root = os.open('pgdata', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
            try:
                root_stat = os.fstat(root)
                if (root_stat.st_uid != profile['uid']
                        or profile['schema'] not in {ROLE_SCHEMA, EXECUTION_SCHEMA} and root_stat.st_gid != profile['gid']
                        or stat.S_IMODE(root_stat.st_mode) not in {0o700, 0o750}
                        or set(os.listdir(root)) & (REFUSE | (QUARANTINE - {'postgresql.auto.conf'}))):
                    raise fail()
                if regular_digest(root, 'PG_VERSION', authority, 3) not in [
                        {'bytes': len(body), 'sha256': digest(body)} for body in (str(profile['major']).encode(), (str(profile['major']) + '\n').encode())]:
                    raise fail()
                if regular_digest(root, 'postgresql.auto.conf', authority, 0) != {'bytes': 0, 'sha256': digest(b'')}:
                    raise fail()
                root_record = record(root, '.', 'directory', root_stat)
                visit(root, '')
                if (authority.seal(root_stat) != authority.seal(os.fstat(root))
                        or authority.seal(root_stat) != authority.seal(os.stat('pgdata', dir_fd=parent, follow_symlinks=False))
                        or authority.seal(outer_stat) != authority.seal(os.fstat(parent))
                        or authority.seal(outer_stat) != authority.seal(directory.lstat())):
                    raise fail()
                result = {'schema': 'orbis.core-inspection-prepared-pgdata.v1', 'profileSha256': digest(M.R.PACK.canonical(profile)),
                          'rootName': 'pgdata', 'root': root_record, 'entries': sorted(entries, key=lambda item: item['path']),
                          'fileBytes': total, 'entryCount': count}
                body = M.R.PACK.canonical(result)
                if len(body) > M.R.PACK.METADATA_LIMIT:
                    raise fail()
                return {**result, 'inventorySha256': digest(body)}
            finally:
                os.close(root)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
        raise fail() from None


def host(limits):
    return {'NetworkMode': 'none', 'ReadonlyRootfs': True, 'Privileged': False, 'AutoRemove': False,
            'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0}, 'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges'],
            'IpcMode': 'private', 'CgroupnsMode': 'private', 'PidsLimit': limits['pids'], 'Memory': limits['memory'], 'NanoCpus': 1_000_000_000,
            'LogConfig': {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '1', 'compress': 'false'}}}


def verify_overlay(directory, receipt, authority):
    if (not isinstance(receipt, dict) or set(receipt) != {'schema', 'copy', 'quarantined', 'autoConf', 'fixed', 'settingsSha256', 'profile', 'restoreAuthority'}):
        raise fail()
    profile = validate_profile(receipt['profile'])
    schema = overlay_schema(profile)
    fixed = {name: {'bytes': len(body), 'sha256': digest(body)} for name, body in config_for(profile).items()}
    if (receipt['schema'] != schema or receipt['restoreAuthority'] is not False or receipt['fixed'] != fixed
            or receipt['autoConf'] != {'bytes': 0, 'sha256': digest(b'')}
            or receipt['settingsSha256'] != digest(M.R.PACK.canonical(settings_for(profile)))):
        raise fail()
    directory = Path(directory)
    with authority.protected_directory(directory):
        for child in ('pgdata', 'config', 'quarantined-config'):
            descriptor = os.open(directory / child, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                if child == 'pgdata':
                    if profile['schema'] == EXECUTION_SCHEMA:
                        value = os.fstat(descriptor)
                        if (value.st_uid != profile['uid'] or stat.S_IMODE(value.st_mode) not in {0o700, 0o750}
                                or regular_digest(descriptor, 'PG_VERSION', authority, 3) not in [
                                    {'bytes': len(body), 'sha256': digest(body)} for body in (str(profile['major']).encode(), (str(profile['major']) + '\n').encode())]):
                            raise fail()
                    if set(os.listdir(descriptor)) & (REFUSE | (QUARANTINE - {'postgresql.auto.conf'})):
                        raise fail()
                    if regular_digest(descriptor, 'postgresql.auto.conf', authority, 2 * 1024 * 1024) != receipt['autoConf']:
                        raise fail()
                else:
                    expected = receipt['fixed'] if child == 'config' else receipt['quarantined']
                    if set(os.listdir(descriptor)) != set(expected):
                        raise fail()
                    for name, entry in expected.items():
                        if regular_digest(descriptor, name, authority, 2 * 1024 * 1024) != entry:
                            raise fail()
            finally:
                os.close(descriptor)
    return receipt


def coordinator_inventory(directory, authority):
    with authority.protected_directory(directory) as descriptor:
        names = sorted(os.listdir(descriptor))
        if (not 1 <= len(names) <= 64 or 'core-inspection-worker.mjs' not in names
                or any(not re.fullmatch('[a-z0-9-]+\\.mjs', name) for name in names)):
            raise fail()
        result = {name: regular_digest(descriptor, name, authority, 16 * 1024 ** 2) for name in names}
        if sum(item['bytes'] for item in result.values()) > 64 * 1024 ** 2:
            raise fail()
        for name in names:
            details = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            if details.st_uid != authority.OWNER or stat.S_IMODE(details.st_mode) not in {0o400, 0o600}:
                raise fail()
        return result


def mount(source, target, readonly):
    return {'Type': 'bind', 'Source': str(source), 'Target': target, 'ReadOnly': readonly, 'BindOptions': {'Propagation': 'rprivate'}}


def database_body(identifier, nonce, directory, profile):
    validate_profile(profile)
    if not re.fullmatch('[a-f0-9-]{36}', identifier) or not re.fullmatch('[a-f0-9]{64}', nonce):
        raise fail()
    directory = Path(directory)
    body = {'Image': profile['imageId'], 'User': str(profile['uid']) + ':' + str(profile['gid']),
            'Entrypoint': [binary_for(profile, 'postgres')], 'Cmd': ['-D', '/var/lib/postgresql/data'], 'Env': [],
            'Healthcheck': {'Test': ['NONE']},
            'Labels': {'io.orbis.core-inspection': identifier, 'io.orbis.core-inspection.nonce': nonce, 'io.orbis.core-inspection.role': 'database'},
            'HostConfig': host({'pids': 96, 'memory': 512 * 1024 ** 2})}
    for name, value in (settings_for(profile) | RESOURCE_SETTINGS).items():
        body['Cmd'].extend(['-c', name + '=' + value])
    body['HostConfig']['Mounts'] = [mount(directory / 'pgdata', '/var/lib/postgresql/data', False),
                                   mount(directory / 'config', '/inspection-config', True),
                                   mount(directory / 'socket', '/var/run/postgresql', False)]
    body['HostConfig']['Tmpfs'] = {'/tmp': 'rw,nosuid,nodev,noexec,size=16777216,mode=0700,uid=' + str(profile['uid']) + ',gid=' + str(profile['gid'])}
    return body


def coordinator_body(identifier, nonce, directory, profile, image):
    validate_profile(profile)
    if not re.fullmatch('sha256:[a-f0-9]{64}', image):
        raise fail()
    directory = Path(directory)
    return {'Image': image, 'User': '0:' + str(profile['gid']), 'Entrypoint': ['node'],
            'Cmd': ['/app/core-inspection/core-inspection-worker.mjs', '--inspect'], 'WorkingDir': '/app',
            'Healthcheck': {'Test': ['NONE']},
            'Env': ['NODE_ENV=production', 'TMPDIR=/inspection-output'],
            'Labels': {'io.orbis.core-inspection': identifier, 'io.orbis.core-inspection.nonce': nonce, 'io.orbis.core-inspection.role': 'coordinator'},
            'HostConfig': host({'pids': 128, 'memory': 768 * 1024 ** 2}) | {'Mounts': [
                mount(directory / 'coordinator', '/app/core-inspection', True), mount(directory / 'trusted-input', '/inspection-input', True),
                mount(directory / 'socket', '/var/run/postgresql', True), mount(directory / 'output', '/inspection-output', False)]}}
