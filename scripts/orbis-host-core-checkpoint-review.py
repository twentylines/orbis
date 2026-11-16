"""Read-only validation of authenticated imported checkpoint data, never source-host authority."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
import time


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PACK = load('orbis-host-core-checkpoint.py', 'orbis_imported_checkpoint_format')
MAP = PACK.MAP
HEX = re.compile('[a-f0-9]{64}')
LIMIT = 64 * 1024 ** 3


class CheckpointReviewError(ValueError):
    pass


class BoundedTarInfo(tarfile.TarInfo):
    def _proc_member(self, archive):
        if self.type in {tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK, tarfile.GNUTYPE_SPARSE}:
            raise fail()
        if self.type == tarfile.XHDTYPE and not 1 <= self.size <= 16384:
            raise fail()
        return super()._proc_member(archive)


def fail():
    return CheckpointReviewError('The captured checkpoint has unsupported or inconsistent storage, links or PostgreSQL metadata')


def digest(value):
    return hashlib.sha256(value).hexdigest()


def exact(value, fields):
    return isinstance(value, dict) and set(value) == set(fields)


def valid_hash(value):
    return isinstance(value, str) and HEX.fullmatch(value) is not None


def storage(value, expected):
    if (not exact(value, {'schema', 'reviewSha256', 'storageIdentitySha256', 'hostPlatform', 'resources', 'roles', 'database'})
            or value['schema'] != MAP.SCHEMA or not valid_hash(value['reviewSha256']) or not valid_hash(value['storageIdentitySha256'])
            or value['hostPlatform'] != {key: expected['compatibility'][key] for key in ('os', 'architecture')}
            or not isinstance(value['resources'], list) or len(value['resources']) != expected['resourceCount']
            or not isinstance(value['roles'], dict) or set(value['roles']) != MAP.ROLES):
        raise fail()
    for index, resource in enumerate(value['resources']):
        if (not exact(resource, {'index', 'kind', 'excludedPaths'}) or type(resource['index']) is not int
                or resource['index'] != index or resource['kind'] not in {'directory', 'file'}
                or not isinstance(resource['excludedPaths'], list) or len(resource['excludedPaths']) > 4096):
            raise fail()
        paths = [MAP.relative(item) for item in resource['excludedPaths']]
        if any(str(item) == '.' for item in paths) or len(set(paths)) != len(paths):
            raise fail()
    for role, entry in value['roles'].items():
        if (not exact(entry, {'containerId', 'definitionSha256', 'imageId', 'platform', 'mounts'})
                or not valid_hash(entry['containerId']) or not valid_hash(entry['definitionSha256'])
                or entry['imageId'] != expected['images'][role] or entry['platform'] != value['hostPlatform']
                or not isinstance(entry['mounts'], list) or len(entry['mounts']) > 512):
            raise fail()
        destinations = []
        for mount in entry['mounts']:
            if not isinstance(mount, dict):
                raise fail()
            destinations.append(str(MAP.absolute(mount.get('destination'))))
            fields = {'destination', 'type', 'writable'} | ({'policy'} if 'policy' in mount else {'resourceIndex', 'resourcePath'})
            if (set(mount) != fields or mount['type'] not in {'bind', 'volume', 'tmpfs'}
                    or type(mount['writable']) is not bool):
                raise fail()
            if 'policy' in mount:
                if mount['policy'] not in {'runtime', 'preserve-current'} or mount['policy'] == 'preserve-current' and role != 'controller':
                    raise fail()
            else:
                MAP.resource_address(value['resources'], mount)
        if destinations != sorted(set(destinations)):
            raise fail()
    if len({entry['containerId'] for entry in value['roles'].values()}) != 3:
        raise fail()
    database = value['database']
    if not exact(database, {'containerPath', 'resourceIndex', 'resourcePath'}):
        raise fail()
    pgdata = MAP.absolute(database['containerPath'])
    MAP.resource_address(value['resources'], database)
    mounts = value['roles']['database']['mounts']
    covering = [item for item in mounts if pgdata.is_relative_to(MAP.absolute(item['destination']))]
    selected = max(covering, key=lambda item: len(MAP.absolute(item['destination']).parts)) if covering else {}
    if ('policy' in selected or selected.get('resourceIndex') != database['resourceIndex']
            or 'resourcePath' not in selected
            or str(MAP.relative(selected['resourcePath']) / pgdata.relative_to(MAP.absolute(selected['destination']))) != database['resourcePath']):
        raise fail()
    return value


def manifest_review(value, expected, observed, small):
    fields = {'schema', 'pointId', 'sourceSha256', 'checkpointSha256', 'captureJobSha256', 'portableStorageSha256',
              'resourceCount', 'portableStorage', 'compatibility', 'compatibilityEvidence', 'entries'}
    if (not exact(value, fields) or value['schema'] != PACK.SCHEMA
            or any(value[key] != expected[key] for key in ('pointId', 'sourceSha256', 'checkpointSha256', 'resourceCount', 'compatibility'))
            or not valid_hash(value['captureJobSha256']) or not valid_hash(value['portableStorageSha256'])
            or not isinstance(value['compatibilityEvidence'], str) or not 1 <= len(value['compatibilityEvidence']) <= 4096
            or not isinstance(value['entries'], list) or len(value['entries']) != len(observed)):
        raise fail()
    mapping = storage(value['portableStorage'], expected)
    if digest(PACK.canonical(mapping)) != value['portableStorageSha256']:
        raise fail()
    nodes = {}
    for entry, actual in zip(value['entries'], observed):
        common = {'path', 'mode', 'uid', 'gid', 'mtimeNs', 'type', 'xattrs'}
        kind = entry.get('type') if isinstance(entry, dict) else None
        fields = common | ({'bytes', 'sha256'} if kind == 'file' else {'bytes', 'sha256', 'target'} if kind == 'hardlink' else {'target'} if kind == 'symlink' else set())
        if (kind not in {'file', 'directory', 'hardlink', 'symlink'} or not exact(entry, fields)
                or any(type(entry[key]) is not int for key in ('mode', 'uid', 'gid', 'mtimeNs'))
                or not 0 <= entry['mode'] <= 0o7777 or not 0 <= entry['uid'] <= 2**32 - 1 or not 0 <= entry['gid'] <= 2**32 - 1
                or not -(2**63) <= entry['mtimeNs'] < 2**63 or not isinstance(entry['xattrs'], dict)
                or not isinstance(entry.get('path'), str) or entry['path'] in nodes):
            raise fail()
        path = PurePosixPath(PACK.relative(entry['path']))
        parts = path.parts
        if len(parts) < 2 or parts[0] != 'resources' or not re.fullmatch('[0-9]{4}', parts[1]):
            raise fail()
        index = int(parts[1])
        if not 0 <= index < len(mapping['resources']):
            raise fail()
        relative = PurePosixPath(*parts[2:]) if len(parts) > 2 else PurePosixPath('.')
        resource = mapping['resources'][index]
        MAP.resource_address(mapping['resources'], {'resourceIndex': index, 'resourcePath': str(relative)})
        if len(parts) == 2:
            if kind != resource['kind']:
                raise fail()
        elif nodes.get(str(path.parent), {}).get('type') != 'directory':
            raise fail()
        if (actual['path'] != entry['path'] or actual['type'] != kind
                or any(actual[key] != entry[key] for key in ('mode', 'uid', 'gid'))
                or actual['mtime'] != entry['mtimeNs'] // 1_000_000_000):
            raise fail()
        for name, encoded in entry['xattrs'].items():
            if not isinstance(name, str) or not isinstance(encoded, str):
                raise fail()
            try:
                decoded_name = base64.b64decode(name, validate=True)
                content = base64.b64decode(encoded, validate=True)
            except (ValueError, TypeError) as error:
                raise fail() from error
            if (not 1 <= len(decoded_name) <= 255 or b'\0' in decoded_name
                    or len(content) > PACK.METADATA_LIMIT
                    or base64.b64encode(decoded_name).decode() != name or base64.b64encode(content).decode() != encoded):
                raise fail()
        if kind in {'file', 'hardlink'}:
            if type(entry['bytes']) is not int or not 0 <= entry['bytes'] <= LIMIT or not valid_hash(entry['sha256']):
                raise fail()
            if kind == 'file' and any(actual[key] != entry[key] for key in ('bytes', 'sha256')):
                raise fail()
        if kind in {'hardlink', 'symlink'}:
            target = entry['target']
            if (not isinstance(target, str) or not target or target.startswith('/') or actual['target'] != target
                    or any(ord(char) < 32 or ord(char) == 127 for char in target)):
                raise fail()
            if kind == 'hardlink':
                prior = nodes.get(target)
                if (not prior or prior['type'] != 'file' or PurePosixPath(target).parts[:2] != parts[:2]
                        or any(prior[key] != entry[key] for key in ('bytes', 'sha256', 'mode', 'uid', 'gid', 'mtimeNs', 'xattrs'))):
                    raise fail()
        nodes[entry['path']] = entry
    if any('resources/' + f'{index:04d}' not in nodes for index in range(len(mapping['resources']))):
        raise fail()
    PACK.check_links(value['entries'])
    database = mapping['database']
    version_path = str(PurePosixPath('resources', f"{database['resourceIndex']:04d}") / MAP.relative(database['resourcePath']) / 'PG_VERSION')
    version_node = nodes.get(version_path)
    if version_node and version_node['type'] == 'hardlink':
        version_path = version_node['target']
    version = small.get(version_path)
    if (version is None or not re.fullmatch(rb'[1-9][0-9]?\n?', version)
            or int(version) != expected['compatibility']['database']['major']):
        raise fail()
    return {'schema': 'orbis.core-portable-checkpoint-review.v1', 'pointId': value['pointId'],
            'manifestSha256': digest(PACK.canonical(value)), 'portableStorageSha256': value['portableStorageSha256'],
            'resourceCount': value['resourceCount'], 'entryCount': len(observed),
            'compatibility': value['compatibility'], 'roleImages': expected['images'], 'restoreAuthority': False}


def review_checkpoint(path, expected, authority, *, consume=None):
    """Parse and compare every member; never extract, normalize or execute imported data."""
    if (not exact(expected, {'pointId', 'sourceSha256', 'checkpointSha256', 'resourceCount', 'compatibility', 'images', 'checkpoint'})
            or not isinstance(expected['pointId'], str) or not PACK.POINT.fullmatch(expected['pointId'])
            or not valid_hash(expected['sourceSha256']) or not valid_hash(expected['checkpointSha256'])
            or type(expected['resourceCount']) is not int or not 1 <= expected['resourceCount'] <= 4096
            or not exact(expected['images'], MAP.ROLES)
            or any(not isinstance(image, str) or not re.fullmatch('sha256:[a-f0-9]{64}', image) for image in expected['images'].values())
            or not exact(expected['checkpoint'], {'bytes', 'sha256'}) or type(expected['checkpoint']['bytes']) is not int
            or not 1024 <= expected['checkpoint']['bytes'] <= LIMIT or not valid_hash(expected['checkpoint']['sha256'])
            or not exact(expected['compatibility'], {'os', 'architecture', 'database', 'storageFormat'})
            or expected['compatibility']['os'] != 'linux' or expected['compatibility']['architecture'] not in {'amd64', 'arm64'}
            or expected['compatibility']['storageFormat'] != 'physical-pgdata.v1'
            or not exact(expected['compatibility']['database'], {'engine', 'major'})
            or expected['compatibility']['database']['engine'] != 'postgresql'
            or type(expected['compatibility']['database']['major']) is not int or not 1 <= expected['compatibility']['database']['major'] <= 99):
        raise fail()
    path = Path(path)
    with authority.protected_directory(path.parent):
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(descriptor)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != authority.OWNER or before.st_nlink != 1
                    or stat.S_IMODE(before.st_mode) & 0o077 or not 1024 <= before.st_size <= LIMIT
                    or before.st_size != expected['checkpoint']['bytes'] or before.st_size % 512):
                raise fail()
            deadline = time.monotonic() + 300
            with os.fdopen(os.dup(descriptor), 'rb') as stream:
                archive_sha = hashlib.sha256()
                for block in iter(lambda: stream.read(65536), b''):
                    if time.monotonic() > deadline:
                        raise fail()
                    archive_sha.update(block)
                if archive_sha.hexdigest() != expected['checkpoint']['sha256']:
                    raise fail()
                stream.seek(0)
                observed, small, body, end, budget = [], {}, None, None, 0
                with tarfile.open(fileobj=stream, mode='r:', tarinfo=BoundedTarInfo) as archive:
                    archive.copybufsize = 65536
                    for member in archive:
                        if time.monotonic() > deadline or len(observed) >= 100000 or body is not None:
                            raise fail()
                        if (not isinstance(member.name, str) or len(member.name) > 4096 or len(member.linkname) > 4096
                                or not set(member.pax_headers) <= {'path', 'linkpath', 'uid', 'gid', 'size', 'mtime'}
                                or member.uname or member.gname or member.sparse is not None):
                            raise fail()
                        if member.name == 'manifest.json':
                            if not member.isfile() or not 1 <= member.size <= PACK.METADATA_LIMIT:
                                raise fail()
                            body = archive.extractfile(member).read(PACK.METADATA_LIMIT + 1)
                            end = member.offset_data + ((member.size + 511) // 512) * 512
                            continue
                        kind = 'file' if member.isfile() else 'directory' if member.isdir() else 'symlink' if member.issym() else 'hardlink' if member.islnk() else None
                        if kind is None or not isinstance(member.mtime, (float, int)) or member.mtime != int(member.mtime):
                            raise fail()
                        item = {'path': member.name, 'type': kind, 'mode': member.mode,
                                'uid': member.uid, 'gid': member.gid, 'mtime': int(member.mtime)}
                        if kind == 'file':
                            if not 0 <= member.size <= LIMIT:
                                raise fail()
                            source, hashed, count, tiny = archive.extractfile(member), hashlib.sha256(), 0, bytearray()
                            while block := source.read(65536):
                                if time.monotonic() > deadline:
                                    raise fail()
                                hashed.update(block)
                                count += len(block)
                                if member.size <= 16:
                                    tiny.extend(block)
                            if count != member.size:
                                raise fail()
                            item.update(bytes=count, sha256=hashed.hexdigest())
                            if member.size <= 16:
                                small[member.name] = bytes(tiny)
                        elif member.size:
                            raise fail()
                        if kind in {'symlink', 'hardlink'}:
                            item['target'] = member.linkname
                        budget += len(PACK.canonical(item)) + 1
                        if budget > PACK.METADATA_LIMIT:
                            raise fail()
                        observed.append(item)
                if body is None or end is None or before.st_size - end < 1024:
                    raise fail()
                stream.seek(end)
                for block in iter(lambda: stream.read(65536), b''):
                    if block.strip(b'\0') or time.monotonic() > deadline:
                        raise fail()
                value = json.loads(body)
                if PACK.canonical(value) != body:
                    raise fail()
                result = manifest_review(value, expected, observed, small)
            if authority.seal(before) != authority.seal(os.fstat(descriptor)) or authority.seal(before) != authority.seal(path.lstat()):
                raise fail()
            if consume is not None:
                consume(descriptor, value, result)
                if authority.seal(before) != authority.seal(os.fstat(descriptor)) or authority.seal(before) != authority.seal(path.lstat()):
                    raise fail()
            return result
        finally:
            os.close(descriptor)
