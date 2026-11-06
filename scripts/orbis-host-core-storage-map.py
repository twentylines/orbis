"""Capture-time portable addresses for verified core checkpoint resources."""
import copy
from pathlib import Path, PurePosixPath
from types import SimpleNamespace

SCHEMA = 'orbis.time-machine-core-storage.v1'
ROLES = {'controller', 'database', 'queue'}
ARCHITECTURES = {'x86_64': 'amd64', 'amd64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}


class StorageMapError(ValueError):
    pass


def absolute(value):
    if (not isinstance(value, str) or len(value) > 4096 or not value.startswith('/')
            or value.startswith('//') or str(PurePosixPath(value)) != value
            or any(part == '..' for part in value.split('/'))
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise StorageMapError('A captured container path is not canonical')
    return PurePosixPath(value)


def relative(value):
    if (not isinstance(value, str) or len(value) > 4096 or not value
            or value.startswith('/') or str(PurePosixPath(value)) != value
            or '..' in value.split('/') or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise StorageMapError('A captured resource path is not canonical')
    return PurePosixPath(value)


def address(resources, source):
    matches = []
    for index, item in enumerate(resources):
        base = Path(item['source'])
        if not source.is_relative_to(base):
            continue
        offset = source.relative_to(base).as_posix()
        if any(source.is_relative_to(base / excluded) for excluded in item.get('excludedPaths', [])):
            continue
        if item['kind'] != 'directory' and offset != '.':
            raise StorageMapError('A captured mount is below a non-directory resource')
        matches.append({'resourceIndex': index, 'resourcePath': offset})
    if len(matches) > 1:
        raise StorageMapError('A captured mount has ambiguous resource coverage')
    return matches[0] if matches else None


def platform(reader):
    value = reader._object(['info', '--format', '{"os":{{json .OSType}},"architecture":{{json .Architecture}}}'])
    architecture = ARCHITECTURES.get(value.get('architecture'))
    if value.get('os') != 'linux' or architecture is None:
        raise StorageMapError('This core capture requires a supported Linux Docker platform')
    return {'os': 'linux', 'architecture': architecture}


def capture(tx, definitions, reader, checkpoint, original):
    tx.validate_review(checkpoint)
    storage = checkpoint['storage']
    if (storage.get('backupScope') != 'controller-live-proxy.v1'
            or set(checkpoint['roles'].values()) != ROLES or len(checkpoint['roles']) != 3):
        raise StorageMapError('Portable core storage requires the exact core capture scope')
    host = platform(reader)
    roles, images, database = {}, {}, None
    for identifier, role in sorted(checkpoint['roles'].items()):
        raw = reader._object(['container', 'inspect', '--format', '{{json .}}', identifier])
        prior = original[identifier]
        if (raw.get('Id') != identifier or raw.get('Image') != prior['imageId']
                or definitions.DockerRestoreRuntime.definition(SimpleNamespace(P=tx.APPS.HOST.IDENTITY.PUBLICATION), raw) != prior['definition']):
            raise StorageMapError('A core definition changed before storage mapping')
        image_id = prior['imageId']
        if image_id not in images:
            image = reader._object(['image', 'inspect', '--format', '{{json .}}', image_id])
            image_platform = {'os': image.get('Os'), 'architecture': image.get('Architecture')}
            if image.get('Id') != image_id or image_platform != host:
                raise StorageMapError('Core images and the Docker host must use the same supported platform')
            images[image_id] = image_platform
        mounts = []
        for mount in sorted(tx.APPS.DETECT.validate_mounts(raw.get('Mounts')), key=lambda item: item['Destination']):
            destination = absolute(mount['Destination'])
            if type(mount.get('RW')) is not bool:
                raise StorageMapError('A captured mount has invalid permissions')
            value = {'destination': str(destination), 'type': mount.get('Type'), 'writable': mount['RW']}
            source = tx.STORAGE.mount_source(reader, mount, controller=role == 'controller')
            if source is None:
                value['policy'] = 'runtime'
            else:
                tx.STORAGE.source_identity(source)
                covered = address(storage['resources'], source)
                if covered is not None:
                    value.update(covered)
                elif role == 'controller':
                    preserved = any(destination == absolute(target) or destination.is_relative_to(absolute(target))
                                    for target in {*tx.STORAGE.LIVE_CONTROLLER_DATA, tx.STORAGE.RESET.TARGET})
                    excluded = any(source.is_relative_to(Path(item['source']) / omitted)
                                   for item in storage['resources'] for omitted in item.get('excludedPaths', []))
                    if not preserved and not excluded:
                        raise StorageMapError('A controller mount is missing from the captured scope')
                    value['policy'] = 'preserve-current'
                else:
                    raise StorageMapError('A core mount is missing from the captured scope')
            mounts.append(value)
        roles[role] = {'containerId': identifier, 'definitionSha256': prior['definition'],
                       'imageId': image_id, 'platform': copy.deepcopy(images[image_id]), 'mounts': mounts}
        if role == 'database':
            environment = raw['Config'].get('Env')
            if not isinstance(environment, list) or any(not isinstance(item, str) for item in environment):
                raise StorageMapError('The database data directory is unavailable')
            values = [item[7:] for item in environment if item.startswith('PGDATA=')]
            if len(values) != 1:
                raise StorageMapError('The database must declare one data directory for this capture')
            pgdata = absolute(values[0])
            covering = [item for item in mounts if pgdata.is_relative_to(absolute(item['destination']))]
            if not covering:
                raise StorageMapError('The database data directory is not mounted in the capture')
            selected = max(covering, key=lambda item: len(absolute(item['destination']).parts))
            if 'policy' in selected:
                raise StorageMapError('The database data directory is excluded or volatile')
            index = selected['resourceIndex']
            offset = str(relative(selected['resourcePath']) / pgdata.relative_to(absolute(selected['destination'])))
            source = Path(storage['resources'][index]['source']) / offset
            if (address(storage['resources'], source) != {'resourceIndex': index, 'resourcePath': offset}
                    or not source.is_dir() or source.is_symlink() or source.resolve(strict=True) != source):
                raise StorageMapError('The database data directory is not a captured canonical directory')
            database = {'containerPath': str(pgdata), 'resourceIndex': index, 'resourcePath': offset}
    result = {'schema': SCHEMA, 'reviewSha256': tx.APPS.digest(checkpoint),
              'storageIdentitySha256': storage['identityHash'], 'hostPlatform': host,
              'resources': [{'index': index, 'kind': item['kind'], 'excludedPaths': item.get('excludedPaths', [])}
                            for index, item in enumerate(storage['resources'])],
              'roles': roles, 'database': database}
    return validate(tx, result, checkpoint, original)


def validate(tx, value, checkpoint, original):
    """Validate saved bindings without inspecting the resumed containers."""
    tx.validate_review(checkpoint)
    storage = checkpoint['storage']
    if (not isinstance(value, dict)
            or set(value) != {'schema', 'reviewSha256', 'storageIdentitySha256', 'hostPlatform', 'resources', 'roles', 'database'}
            or value['schema'] != SCHEMA or value['reviewSha256'] != tx.APPS.digest(checkpoint)
            or value['storageIdentitySha256'] != storage['identityHash']
            or value['hostPlatform'] not in ({'os': 'linux', 'architecture': 'amd64'}, {'os': 'linux', 'architecture': 'arm64'})
            or value['resources'] != [{'index': index, 'kind': item['kind'], 'excludedPaths': item.get('excludedPaths', [])}
                                      for index, item in enumerate(storage['resources'])]
            or not isinstance(value['roles'], dict) or set(value['roles']) != ROLES):
        raise StorageMapError('The saved core storage mapping is invalid')
    for role, entry in value['roles'].items():
        if not isinstance(entry, dict) or set(entry) != {'containerId', 'definitionSha256', 'imageId', 'platform', 'mounts'}:
            raise StorageMapError('The saved core role mapping is invalid')
        identifier = entry['containerId']
        prior = original.get(identifier)
        if (checkpoint['roles'].get(identifier) != role or not prior
                or entry['definitionSha256'] != prior['definition'] or entry['imageId'] != prior['imageId']
                or entry['platform'] != value['hostPlatform'] or not isinstance(entry['mounts'], list) or len(entry['mounts']) > 512):
            raise StorageMapError('The saved core role identity changed')
        destinations = []
        for mount in entry['mounts']:
            if not isinstance(mount, dict):
                raise StorageMapError('The saved core mount mapping is invalid')
            destinations.append(str(absolute(mount.get('destination'))))
            common = {'destination', 'type', 'writable'}
            fields = common | ({'policy'} if 'policy' in mount else {'resourceIndex', 'resourcePath'})
            if (mount.get('type') not in {'bind', 'volume', 'tmpfs'} or type(mount.get('writable')) is not bool
                    or set(mount) != fields):
                raise StorageMapError('The saved core mount mapping is invalid')
            if 'policy' in mount:
                if mount['policy'] not in {'runtime', 'preserve-current'} or mount['policy'] == 'preserve-current' and role != 'controller':
                    raise StorageMapError('The saved core mount policy is invalid')
            else:
                resource_address(storage['resources'], mount)
        if destinations != sorted(set(destinations)):
            raise StorageMapError('The saved core mount order or destinations changed')
    database = value['database']
    if not isinstance(database, dict) or set(database) != {'containerPath', 'resourceIndex', 'resourcePath'}:
        raise StorageMapError('The saved database location is invalid')
    pgdata = absolute(database['containerPath'])
    resource_address(storage['resources'], database)
    mounts = value['roles']['database']['mounts']
    covering = [item for item in mounts if pgdata.is_relative_to(absolute(item['destination']))]
    selected = max(covering, key=lambda item: len(absolute(item['destination']).parts)) if covering else {}
    if ('policy' in selected or selected.get('resourceIndex') != database['resourceIndex']
            or 'resourcePath' not in selected
            or str(relative(selected['resourcePath']) / pgdata.relative_to(absolute(selected['destination']))) != database['resourcePath']):
        raise StorageMapError('The saved database location differs from its captured mount')
    return copy.deepcopy(value)


def resource_address(resources, value):
    index = value.get('resourceIndex')
    if type(index) is not int or not 0 <= index < len(resources):
        raise StorageMapError('The saved resource index is invalid')
    offset = relative(value.get('resourcePath'))
    item = resources[index]
    if (item['kind'] != 'directory' and str(offset) != '.'
            or any(offset.is_relative_to(relative(excluded)) for excluded in item.get('excludedPaths', []))):
        raise StorageMapError('The saved resource address is excluded or invalid')
