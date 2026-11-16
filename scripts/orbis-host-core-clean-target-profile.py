"""Fresh private PostgreSQL targets; no source-data promotion or public admission."""
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import stat
import sys
from dataclasses import dataclass


spec = importlib.util.spec_from_file_location('orbis_clean_target_source_profile', Path(__file__).with_name('orbis-host-core-inspection-profile.py'))
SOURCE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(SOURCE)
SCHEMA = 'orbis.core-clean-target-pg.v1'
BOUNDED_SCHEMA = 'orbis.core-clean-target-pg.v2'
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
HEX = re.compile(r'[a-f0-9]{64}')
LOCALES = {'C', 'POSIX', 'C.UTF-8', 'C.utf8', 'en_US.utf8', 'en_US.UTF-8'}


class TargetProfileError(ValueError):
    pass


def fail():
    return TargetProfileError('The new restore database could not be prepared. Existing data was preserved.')


def require_root():
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise fail()


def digest(body):
    return hashlib.sha256(body).hexdigest()


def canonical(value):
    return SOURCE.M.R.PACK.canonical(value)


def clean_target_profile(image, role, database, locale):
    """A fixed candidate profile; the Root caller must qualify initialization independently."""
    base = SOURCE.image_profile(image)
    if (not isinstance(role, str) or not SOURCE.NAME.fullmatch(role)
            or not isinstance(database, str) or not SOURCE.NAME.fullmatch(database)
            or database in {'postgres', 'template0', 'template1'}
            or not isinstance(locale, dict) or set(locale) != {'encoding', 'collate', 'ctype', 'provider'}
            or locale['encoding'] != 'UTF8' or locale['provider'] != 'c'
            or not isinstance(locale['collate'], str) or locale['collate'] not in LOCALES
            or not isinstance(locale['ctype'], str) or locale['ctype'] not in LOCALES):
        raise fail()
    return {**base, 'schema': SCHEMA, 'role': role, 'database': database, 'locale': dict(locale),
            'scope': 'prepare-clean-target-only', 'activation': False, 'environmentProved': False,
            'restoreAuthority': False}


def bounded_clean_target_profile(image, role, database, locale):
    base = SOURCE.execution_image_profile(image)
    if (not isinstance(role, str) or not SOURCE.NAME.fullmatch(role)
            or not isinstance(database, str) or not SOURCE.NAME.fullmatch(database)
            or database in {'postgres', 'template0', 'template1'}
            or not isinstance(locale, dict) or set(locale) != {'encoding', 'collate', 'ctype', 'provider'}
            or locale['encoding'] != 'UTF8' or locale['provider'] != 'c'
            or not isinstance(locale['collate'], str) or locale['collate'] not in SOURCE.PG.locales_for(base)
            or not isinstance(locale['ctype'], str) or locale['ctype'] not in SOURCE.PG.locales_for(base)):
        raise fail()
    return {**base, 'schema': BOUNDED_SCHEMA, 'role': role, 'database': database, 'locale': dict(locale),
            'scope': 'prepare-clean-target-only', 'activation': False, 'environmentProved': False,
            'restoreAuthority': False}


def binary_for(profile, tool):
    validate_profile(profile)
    if profile['schema'] == BOUNDED_SCHEMA:
        return SOURCE.PG.binary_for(profile, tool)
    if not isinstance(tool, str) or tool not in SOURCE.PG.TOOLS:
        raise fail()
    return '/usr/local/bin/' + tool


def locale_provider_options(profile):
    validate_profile(profile)
    return [] if profile['schema'] == BOUNDED_SCHEMA and profile['major'] == 14 else ['--locale-provider=libc']


def validate_profile(profile):
    if not isinstance(profile, dict):
        raise fail()
    image = {'Id': SOURCE.PG17_ARM64_IMAGE, 'Os': 'linux', 'Architecture': 'arm64',
             'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}}
    try:
        if profile.get('schema') == BOUNDED_SCHEMA:
            expected = bounded_clean_target_profile(SOURCE.PG.image_for_profile(profile), profile['role'], profile['database'], profile['locale'])
        else:
            expected = clean_target_profile(image, profile['role'], profile['database'], profile['locale'])
        if canonical(profile) != canonical(expected):
            raise fail()
    except (KeyError, TypeError, ValueError):
        raise fail() from None
    return profile


def settings_for(profile):
    validate_profile(profile)
    settings = dict(SOURCE.SETTINGS)
    if profile['schema'] == BOUNDED_SCHEMA and profile['major'] == 14:
        settings.pop('archive_library')
    return settings | SOURCE.RESOURCE_SETTINGS | {
        'config_file': '/clean-target-config/postgresql.conf',
        'hba_file': '/clean-target-config/pg_hba.conf', 'ident_file': '/clean-target-config/pg_ident.conf',
        'default_transaction_read_only': 'off', 'search_path': 'pg_catalog',
    }


def config_for(profile):
    validate_profile(profile)
    role, database = profile['role'], profile['database']
    hba = f'local "postgres" "{role}" trust\nlocal "{database}" "{role}" trust\nlocal all all reject\n'
    return {'postgresql.conf': b'# Fixed isolated Orbis Sentinel target configuration.\n',
            'pg_hba.conf': hba.encode('ascii'), 'pg_ident.conf': b''}


def directory_identity(details):
    return [details.st_dev, details.st_ino, details.st_mode, details.st_uid, details.st_gid]


@dataclass(frozen=True)
class TargetWorkspace:
    directory: Path
    profile: dict
    allocation: dict
    identities: dict


def allocate_workspace(directory, profile, authority, identifier, nonce, root_intent_sha256):
    require_root()
    validate_profile(profile)
    if (authority.OWNER != 0 or not all(isinstance(value, str) and UUID.fullmatch(value) for value in (identifier, nonce))
            or not isinstance(root_intent_sha256, str) or not HEX.fullmatch(root_intent_sha256)):
        raise fail()
    directory = Path(directory)
    allocation = {'schema': 'orbis.core-clean-target-allocation.v1', 'id': identifier, 'nonce': nonce,
                  'rootIntentSha256': root_intent_sha256, 'profile': profile,
                  'scope': 'prepare-clean-target-only', 'activation': False,
                  'environmentProved': False, 'restoreAuthority': False}
    with authority.protected_directory(directory) as target:
        if os.listdir(target):
            raise fail()
        original = directory_identity(os.fstat(target))
    # Seal the unchanged parent while mutating only the pinned new child.
    with authority.protected_directory(directory.parent) as parent:
        target = os.open(directory.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            if (directory_identity(os.fstat(target)) != original
                    or directory_identity(os.stat(directory.name, dir_fd=parent, follow_symlinks=False)) != original
                    or os.listdir(target)):
                raise fail()
            _populate_workspace(target, profile, allocation)
            if (directory_identity(os.fstat(target)) != original
                    or directory_identity(os.stat(directory.name, dir_fd=parent, follow_symlinks=False)) != original):
                raise fail()
        finally:
            os.close(target)
    names = ['', 'pgdata', 'socket', 'config']
    identities = {name: directory_identity((directory / name).lstat()) for name in names}
    workspace = TargetWorkspace(directory, profile, allocation, identities)
    verify_workspace(workspace, authority)
    return workspace


def _populate_workspace(target, profile, allocation):
    """Caller owns the pinned empty child; no pathname lookup can redirect writes."""
    # Interrupted allocation evidence is never reclaimed, even without a container.
    SOURCE.write_exclusive(target, 'allocation.json', canonical(allocation), 0, 0, 0o400)
    os.fsync(target)
    for name, uid, gid, mode in (('pgdata', profile['uid'], profile['gid'], 0o700),
                                 ('socket', profile['uid'], profile['gid'], 0o770),
                                 ('config', 0, profile['gid'], 0o550)):
        os.mkdir(name, 0o700, dir_fd=target)
        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=target)
        try:
            if name == 'config':
                for filename, body in config_for(profile).items():
                    SOURCE.write_exclusive(child, filename, body, 0, profile['gid'], 0o440)
            os.fchown(child, uid, gid)
            os.fchmod(child, mode)
            os.fsync(child)
        finally:
            os.close(child)
    os.fsync(target)


def verify_workspace(workspace, authority):
    require_root()
    if type(workspace) is not TargetWorkspace or authority.OWNER != 0:
        raise fail()
    profile = validate_profile(workspace.profile)
    directory = workspace.directory
    if (workspace.allocation.get('profile') != profile or not directory.is_absolute()
            or directory.resolve(strict=True) != directory):
        raise fail()
    with authority.protected_directory(directory) as parent:
        if set(os.listdir(parent)) != {'allocation.json', 'pgdata', 'socket', 'config'}:
            raise fail()
        for name in ('', 'pgdata', 'socket', 'config'):
            current = (directory / name).lstat()
            if not stat.S_ISDIR(current.st_mode) or directory_identity(current) != workspace.identities[name]:
                raise fail()
        expected = canonical(workspace.allocation)
        entry = SOURCE.regular_digest(parent, 'allocation.json', authority, 32768)
        mode = os.stat('allocation.json', dir_fd=parent, follow_symlinks=False)
        if (entry != {'bytes': len(expected), 'sha256': digest(expected)} or mode.st_uid != 0
                or stat.S_IMODE(mode.st_mode) != 0o400):
            raise fail()
        config = os.open('config', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            if set(os.listdir(config)) != set(config_for(profile)):
                raise fail()
            for name, body in config_for(profile).items():
                details = os.stat(name, dir_fd=config, follow_symlinks=False)
                if (details.st_uid != 0 or details.st_gid != profile['gid'] or stat.S_IMODE(details.st_mode) != 0o440
                        or SOURCE.regular_digest(config, name, authority, 32768) != {'bytes': len(body), 'sha256': digest(body)}):
                    raise fail()
        finally:
            os.close(config)
    return workspace


def body(workspace, phase, entrypoint, command, mounts):
    profile = validate_profile(workspace.profile)
    record = workspace.allocation
    return {'Image': profile['imageId'], 'User': f"{profile['uid']}:{profile['gid']}",
            'Entrypoint': [entrypoint], 'Cmd': command, 'Env': [], 'Healthcheck': {'Test': ['NONE']},
            'Labels': {'io.orbis.core-clean-target': record['id'], 'io.orbis.core-clean-target.nonce': record['nonce'],
                       'io.orbis.core-clean-target.intent': record['rootIntentSha256'], 'io.orbis.core-clean-target.phase': phase},
            'HostConfig': SOURCE.host({'pids': 128, 'memory': 512 * 1024 ** 2}) | {
                'Mounts': mounts, 'Tmpfs': {'/tmp': f"rw,nosuid,nodev,noexec,size=16777216,mode=0700,uid={profile['uid']},gid={profile['gid']}"}}}


def initialization_body(workspace, authority):
    verify_workspace(workspace, authority)
    if list((workspace.directory / 'pgdata').iterdir()) or list((workspace.directory / 'socket').iterdir()):
        raise fail()
    profile = workspace.profile
    locale = profile['locale']
    return body(workspace, 'initialize', binary_for(profile, 'initdb'), [
        '--pgdata=/var/lib/postgresql/data', '--username=' + profile['role'], '--encoding=' + locale['encoding'],
        *locale_provider_options(profile), '--lc-collate=' + locale['collate'], '--lc-ctype=' + locale['ctype'],
        '--auth-local=reject', '--auth-host=reject', '--no-instructions',
    ], [SOURCE.mount(workspace.directory / 'pgdata', '/var/lib/postgresql/data', False)])


def database_body(workspace, authority):
    """The supervising Root caller must first positively settle its exact initializer."""
    verify_workspace(workspace, authority)
    data = workspace.directory / 'pgdata'
    descriptor = os.open(data, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in ('PG_VERSION', 'postgresql.auto.conf'):
            handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
            try:
                before = os.fstat(handle)
                if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != workspace.profile['uid']
                        or before.st_gid != workspace.profile['gid']
                        or stat.S_IMODE(before.st_mode) & 0o077 or not 0 < before.st_size <= 4096):
                    raise fail()
                value = bytearray()
                while block := os.read(handle, 4097 - len(value)):
                    value.extend(block)
                    if len(value) > before.st_size:
                        raise fail()
                value = bytes(value)
                if (len(value) != before.st_size or authority.seal(before) != authority.seal(os.fstat(handle))
                        or authority.seal(before) != authority.seal(os.stat(name, dir_fd=descriptor, follow_symlinks=False))):
                    raise fail()
                if name == 'PG_VERSION':
                    if value != (str(workspace.profile['major']) + '\n').encode('ascii'):
                        raise fail()
                elif any(line.strip() and not line.lstrip().startswith(b'#') for line in value.splitlines()):
                    raise fail()
            finally:
                os.close(handle)
        if 'postmaster.pid' in os.listdir(descriptor):
            raise fail()
    finally:
        os.close(descriptor)
    command = ['-D', '/var/lib/postgresql/data']
    for name, value in settings_for(workspace.profile).items():
        command.extend(['-c', name + '=' + value])
    return body(workspace, 'database', binary_for(workspace.profile, 'postgres'), command, [
        SOURCE.mount(data, '/var/lib/postgresql/data', False),
        SOURCE.mount(workspace.directory / 'config', '/clean-target-config', True),
        SOURCE.mount(workspace.directory / 'socket', '/var/run/postgresql', False),
    ])


def creation_body(workspace, authority):
    verify_workspace(workspace, authority)
    profile, locale = workspace.profile, workspace.profile['locale']
    result = body(workspace, 'create-database', binary_for(profile, 'createdb'), [
        '--host=/var/run/postgresql', '--port=5432', '--username=' + profile['role'], '--no-password',
        '--maintenance-db=postgres', '--template=template0', '--owner=' + profile['role'],
        '--encoding=' + locale['encoding'], *locale_provider_options(profile), '--lc-collate=' + locale['collate'],
        '--lc-ctype=' + locale['ctype'], '--', profile['database'],
    ], [SOURCE.mount(workspace.directory / 'socket', '/var/run/postgresql', True),
        SOURCE.mount(workspace.directory / 'pgdata', '/var/lib/postgresql/data', True)])
    result['Env'] = ['PGCONNECT_TIMEOUT=10']
    return result
