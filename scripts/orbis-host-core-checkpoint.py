"""Unexposed portable packaging of a completed, protected core capture.

This reads sealed copies only. It grants no lifecycle authority and provides no
restore operation. Linux xattrs include POSIX ACLs; extraction must restore them
deliberately rather than trusting tar extraction defaults.
"""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile
import uuid


SPEC = importlib.util.spec_from_file_location('orbis_checkpoint_storage_map', Path(__file__).with_name('orbis-host-core-storage-map.py'))
MAP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MAP)
SCHEMA = 'orbis.time-machine-core-checkpoint.v1'
ARTIFACT_SCHEMA = 'orbis.time-machine-core-checkpoint-artifact.v1'
CHUNK = 64 * 1024
METADATA_LIMIT = 16 * 1024 * 1024
POINT = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')


class CheckpointError(ValueError):
    pass


def require_host():
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise CheckpointError('Portable core packaging requires the Linux root authority')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def seal(value):
    return tuple(getattr(value, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def relative(value):
    if (not isinstance(value, str) or not value or value.startswith('/')
            or str(PurePosixPath(value)) != value or '..' in value.split('/')
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise CheckpointError('A portable resource path is not canonical')
    return value


def attributes(target):
    if not hasattr(os, 'listxattr') or not hasattr(os, 'getxattr'):
        raise CheckpointError('Extended storage metadata cannot be read losslessly')
    options = {} if isinstance(target, int) else {'follow_symlinks': False}
    result = {}
    for name in sorted(os.listxattr(target, **options)):
        # Encode names too: Linux permits names which are not valid UTF-8.
        key = base64.b64encode(os.fsencode(name)).decode('ascii')
        result[key] = base64.b64encode(os.getxattr(target, name, **options)).decode('ascii')
    if len(canonical(result)) > METADATA_LIMIT:
        raise CheckpointError('Extended storage metadata exceeds the bounded manifest')
    return result


def metadata(details):
    if getattr(details, 'st_flags', 0):
        raise CheckpointError('Storage file flags are unsupported')
    return {'mode': stat.S_IMODE(details.st_mode), 'uid': details.st_uid,
            'gid': details.st_gid, 'mtimeNs': details.st_mtime_ns}


def pg_major(bundle, mapping):
    location = mapping['database']
    offset = relative(location['resourcePath'])
    descriptor = os.open(bundle, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in (f"resource-{location['resourceIndex']:04d}", *PurePosixPath(offset).parts):
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        file = os.open('PG_VERSION', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        try:
            before = os.fstat(file)
            if not stat.S_ISREG(before.st_mode) or not 1 <= before.st_size <= 16:
                raise CheckpointError('The copied PostgreSQL major version is unavailable')
            data = os.read(file, 17)
            if (len(data) != before.st_size or seal(before) != seal(os.fstat(file))
                    or seal(before) != seal(os.stat('PG_VERSION', dir_fd=descriptor, follow_symlinks=False))
                    or not re.fullmatch(rb'[1-9][0-9]?\n?', data)):
                raise CheckpointError('The copied PostgreSQL major version is invalid or changed')
            return int(data)
        finally:
            os.close(file)
    finally:
        os.close(descriptor)


class HashedReader:
    def __init__(self, descriptor):
        self.descriptor, self.hash, self.count = descriptor, hashlib.sha256(), 0

    def read(self, size):
        data = os.read(self.descriptor, min(size, CHUNK))
        self.hash.update(data)
        self.count += len(data)
        return data


def tar_entry(archive, entry, reader=None):
    info = tarfile.TarInfo(entry['path'])
    info.mode, info.uid, info.gid = entry['mode'], entry['uid'], entry['gid']
    info.mtime = entry['mtimeNs'] // 1_000_000_000
    info.uname = info.gname = ''
    kind = entry['type']
    info.type = {'directory': tarfile.DIRTYPE, 'file': tarfile.REGTYPE,
                 'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE}[kind]
    if kind == 'file':
        info.size = entry['bytes']
    elif kind in {'symlink', 'hardlink'}:
        info.linkname = entry['target']
    archive.addfile(info, reader)


def check_links(entries):
    """Resolve links against the captured namespace without following host paths."""
    nodes = {entry['path']: entry for entry in entries}
    for entry in entries:
        if entry['type'] != 'symlink':
            continue
        root = entry['path'].split('/')[:2]
        pending = entry['path'].split('/')[2:-1] + entry['target'].split('/')
        resolved, followed = [], 0
        while pending:
            component = pending.pop(0)
            if component in {'', '.'}:
                continue
            if component == '..':
                if not resolved:
                    raise CheckpointError('A symbolic link escapes its captured resource')
                resolved.pop()
                continue
            resolved.append(component)
            node = nodes.get('/'.join(root + resolved))
            if node and node['type'] == 'symlink':
                followed += 1
                if followed > 40:
                    raise CheckpointError('A symbolic link contains a cycle or excessive indirection')
                resolved.pop()
                pending = node['target'].split('/') + pending


def collect(bundle, resources, archive=None):
    entries, links, budget = [], {}, 0
    def append(entry):
        nonlocal budget
        budget += len(canonical(entry)) + 1
        if budget > METADATA_LIMIT or len(entries) >= 100_000:
            raise CheckpointError('The portable storage manifest exceeds its metadata bound')
        entries.append(entry)

    def visit(parent, name, path, portable, index):
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        entry = {'path': relative(portable), **metadata(before)}
        if stat.S_ISLNK(before.st_mode):
            target = os.readlink(name, dir_fd=parent)
            if (not target or target.startswith('/') or any(ord(char) < 32 or ord(char) == 127 for char in target)):
                raise CheckpointError('A symbolic link is not a contained relative link')
            # /proc anchors the metadata lookup to the already opened directory.
            anchored = Path('/proc/self/fd') / str(parent) / name if sys.platform == 'linux' else path
            entry.update(type='symlink', target=target, xattrs=attributes(anchored))
            if archive:
                tar_entry(archive, entry)
            if entry['xattrs'] != attributes(anchored):
                raise CheckpointError('Symbolic link metadata changed while packaging')
            append(entry)
        elif stat.S_ISDIR(before.st_mode) or stat.S_ISREG(before.st_mode):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if stat.S_ISDIR(before.st_mode):
                flags |= os.O_DIRECTORY
            descriptor = os.open(name, flags, dir_fd=parent)
            try:
                if seal(before) != seal(os.fstat(descriptor)):
                    raise CheckpointError('A copied resource changed while opening')
                entry['xattrs'] = attributes(descriptor)
                if stat.S_ISDIR(before.st_mode):
                    entry['type'] = 'directory'
                    append(entry)
                    if archive:
                        tar_entry(archive, entry)
                    for child in sorted(os.listdir(descriptor)):
                        relative(child)
                        visit(descriptor, child, path / child, portable + '/' + child, index)
                else:
                    key = (before.st_dev, before.st_ino)
                    group = links.setdefault(key, {'index': index, 'count': 0, 'expected': before.st_nlink, 'entry': None})
                    if group['index'] != index or group['expected'] != before.st_nlink:
                        raise CheckpointError('A hard link crosses captured resource boundaries')
                    group['count'] += 1
                    entry.update(type='file', bytes=before.st_size)
                    if group['entry'] is not None:
                        prior = group['entry']
                        entry.update(type='hardlink', target=prior['path'], sha256=prior['sha256'])
                        if archive:
                            tar_entry(archive, entry)
                    else:
                        reader = HashedReader(descriptor)
                        if archive:
                            tar_entry(archive, entry, reader)
                        else:
                            while reader.read(CHUNK):
                                pass
                        if reader.count != before.st_size:
                            raise CheckpointError('A copied file changed length while packaging')
                        entry['sha256'] = reader.hash.hexdigest()
                        group['entry'] = entry
                    append(entry)
                if seal(before) != seal(os.fstat(descriptor)) or entry['xattrs'] != attributes(descriptor):
                    raise CheckpointError('Copied storage or metadata changed while packaging')
            finally:
                os.close(descriptor)
        else:
            raise CheckpointError('Special storage files cannot be packaged')
        if seal(before) != seal(os.stat(name, dir_fd=parent, follow_symlinks=False)):
            raise CheckpointError('A copied resource was replaced while packaging')

    descriptor = os.open(bundle, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for index, resource in enumerate(resources):
            name = f'resource-{index:04d}'
            details = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            expected = stat.S_ISDIR(details.st_mode) if resource['kind'] == 'directory' else stat.S_ISREG(details.st_mode)
            if not expected:
                raise CheckpointError('A copied resource has the wrong type')
            visit(descriptor, name, bundle / name, f'resources/{index:04d}', index)
    finally:
        os.close(descriptor)
    if any(group['count'] != group['expected'] for group in links.values()):
        raise CheckpointError('A hard link is not wholly contained in its captured resource')
    if len({entry['path'] for entry in entries}) != len(entries):
        raise CheckpointError('The portable manifest contains duplicate paths')
    check_links(entries)
    return entries


def read_job(capture, directory, tx):
    job = capture.read(directory)
    with capture.a.protected_directory(directory) as descriptor:
        with capture.a.protected_file(descriptor, 'job.json', METADATA_LIMIT) as raw:
            if capture.P.metadata(raw, byte_limit=METADATA_LIMIT) != job:
                raise CheckpointError('The protected capture job changed while reading')
            job_hash = hashlib.sha256(raw).hexdigest()
    mapping = MAP.validate(tx, job.get('portableStorage'), job['checkpoint'], job['original'])
    if job['settlement'].get('portableStorageSha256') != tx.APPS.digest(mapping):
        raise CheckpointError('The completed capture has no sealed portable mapping')
    return job, job_hash, mapping


def inputs(capture, directory, tx):
    job, job_hash, mapping = read_job(capture, directory, tx)
    bundle = Path(job['checkpoint']['storage']['bundle'])
    if (bundle != Path(capture.snapshots) / ('orbis-time-machine-core-' + directory.name)
            or bundle == capture.root or bundle.is_relative_to(capture.root) or capture.root.is_relative_to(bundle)):
        raise CheckpointError('The capture does not address its sealed snapshot copies')
    capture.private(bundle)
    manifest = tx.STORAGE.verified_manifest(bundle)
    if manifest['plan'] != job['checkpoint']['storage'] or tx.APPS.digest(manifest) != job['checkpointSha256']:
        raise CheckpointError('The sealed storage copies differ from the completed capture')
    return job, job_hash, mapping, manifest, bundle


def write_new(directory, name, body, owned):
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    details = os.fstat(descriptor)
    owned[name] = details.st_dev, details.st_ino
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())


def archive_digest(directory, name):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    try:
        before = os.fstat(descriptor)
        reader = HashedReader(descriptor)
        while reader.read(CHUNK):
            pass
        if reader.count != before.st_size or seal(before) != seal(os.fstat(descriptor)):
            raise CheckpointError('The completed archive changed while verifying')
        return {'bytes': reader.count, 'sha256': reader.hash.hexdigest()}
    finally:
        os.close(descriptor)


def build(capture, point_id, *, tx):
    """Return a root artifact receipt; existing/partial destinations are holds."""
    require_host()
    if not isinstance(point_id, str) or not POINT.fullmatch(point_id):
        raise CheckpointError('The core point identifier is invalid')
    directory = capture.base / point_id
    capture.private(directory)
    destination = directory / 'portable-checkpoint'
    # mkdir is the exclusive claim. A prior empty/partial directory is never replayed.
    destination.mkdir(mode=0o700)
    details = destination.lstat()
    destination_identity = details.st_dev, details.st_ino
    descriptor = None
    published = False
    owned = {}
    temporary = '.checkpoint-' + uuid.uuid4().hex
    receipt_temp = '.artifact-' + uuid.uuid4().hex
    try:
        capture.private(destination)
        descriptor = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        original = inputs(capture, directory, tx)
        job, job_hash, mapping, native_manifest, bundle = original
        major = pg_major(bundle, mapping)
        compatibility = {'os': 'linux', 'architecture': mapping['hostPlatform']['architecture'],
                         'database': {'engine': 'postgresql', 'major': major}, 'storageFormat': 'physical-pgdata.v1'}
        manifest = {'schema': SCHEMA, 'pointId': point_id,
                    'sourceSha256': tx.APPS.digest(job['source']), 'checkpointSha256': job['checkpointSha256'],
                    'captureJobSha256': job_hash, 'portableStorageSha256': tx.APPS.digest(mapping),
                    'resourceCount': len(mapping['resources']), 'portableStorage': mapping,
                    'compatibility': compatibility,
                    'compatibilityEvidence': 'Captured Linux host/image platform and copied PG_VERSION only; historical PostgreSQL activation compatibility is unproven.'}
        file = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
        details = os.fstat(file)
        owned[temporary] = details.st_dev, details.st_ino
        with os.fdopen(file, 'wb') as stream:
            with tarfile.open(fileobj=stream, mode='w|', format=tarfile.PAX_FORMAT, bufsize=CHUNK) as archive:
                archive.copybufsize = CHUNK
                manifest['entries'] = collect(bundle, native_manifest['plan']['resources'], archive)
                body = canonical(manifest)
                if len(body) > METADATA_LIMIT:
                    raise CheckpointError('The portable manifest exceeds its metadata bound')
                info = tarfile.TarInfo('manifest.json')
                info.size, info.mode = len(body), 0o600
                archive.addfile(info, io.BytesIO(body))
            stream.flush()
            os.fsync(stream.fileno())
        checkpoint = archive_digest(descriptor, temporary)
        if (inputs(capture, directory, tx) != original or pg_major(bundle, mapping) != major
                or collect(bundle, native_manifest['plan']['resources']) != manifest['entries']):
            raise CheckpointError('The sealed capture changed before archive publication')
        receipt = {'schema': ARTIFACT_SCHEMA, 'pointId': point_id,
                   'sourceSha256': manifest['sourceSha256'], 'checkpointSha256': job['checkpointSha256'],
                   'captureJobSha256': job_hash, 'portableStorageSha256': manifest['portableStorageSha256'],
                   'manifestSha256': hashlib.sha256(body).hexdigest(), 'resourceCount': manifest['resourceCount'],
                   'roleImageIds': {role: entry['imageId'] for role, entry in mapping['roles'].items()},
                   'compatibility': compatibility, 'checkpoint': checkpoint}
        write_new(descriptor, receipt_temp, canonical(receipt), owned)
        os.fsync(descriptor)
        os.link(temporary, 'checkpoint.tar', src_dir_fd=descriptor, dst_dir_fd=descriptor, follow_symlinks=False)
        published = True
        os.unlink(temporary, dir_fd=descriptor)
        os.fsync(descriptor)
        os.link(receipt_temp, 'artifact.json', src_dir_fd=descriptor, dst_dir_fd=descriptor, follow_symlinks=False)
        os.unlink(receipt_temp, dir_fd=descriptor)
        os.fsync(descriptor)
        capture.sync(directory)
        capture.private(destination)
        return receipt
    finally:
        if descriptor is not None:
            for name, identity in owned.items():
                try:
                    details = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                    if (details.st_dev, details.st_ino) == identity:
                        os.unlink(name, dir_fd=descriptor)
                except FileNotFoundError:
                    pass
            os.close(descriptor)
        if not published:
            # rmdir refuses unexpected content; never remove an ambiguous record.
            try:
                details = destination.lstat()
                if (details.st_dev, details.st_ino) == destination_identity:
                    destination.rmdir()
            except OSError:
                pass


def read_receipt(capture, point_id, *, tx):
    """Check the protected receipt binding without rehashing checkpoint data.

    The supervisor pins this receipt independently. Transfer must verify the
    archive hash; a status read alone does not prove current archive contents.
    """
    require_host()
    if not isinstance(point_id, str) or not POINT.fullmatch(point_id):
        raise CheckpointError('The core point identifier is invalid')
    directory = capture.base / point_id
    job, job_hash, mapping = read_job(capture, directory, tx)
    destination = directory / 'portable-checkpoint'
    with capture.a.protected_directory(destination) as descriptor:
        with capture.a.protected_file(descriptor, 'artifact.json', METADATA_LIMIT) as body:
            receipt = capture.P.metadata(body, byte_limit=METADATA_LIMIT)
        fields = {'schema', 'pointId', 'sourceSha256', 'checkpointSha256', 'captureJobSha256',
                  'portableStorageSha256', 'manifestSha256', 'resourceCount', 'roleImageIds', 'compatibility', 'checkpoint'}
        if (not isinstance(receipt, dict) or set(receipt) != fields
                or receipt['schema'] != ARTIFACT_SCHEMA or receipt['pointId'] != point_id
                or receipt['sourceSha256'] != tx.APPS.digest(job['source'])
                or receipt['checkpointSha256'] != job['checkpointSha256']
                or receipt['captureJobSha256'] != job_hash
                or receipt['portableStorageSha256'] != tx.APPS.digest(mapping)
                or type(receipt['resourceCount']) is not int or receipt['resourceCount'] != len(mapping['resources'])
                or receipt['roleImageIds'] != {role: entry['imageId'] for role, entry in mapping['roles'].items()}
                or not isinstance(receipt['manifestSha256'], str) or not re.fullmatch('[a-f0-9]{64}', receipt['manifestSha256'])):
            raise CheckpointError('The portable artifact receipt differs from its completed capture')
        compatibility, checkpoint = receipt['compatibility'], receipt['checkpoint']
        if (not isinstance(compatibility, dict) or set(compatibility) != {'os', 'architecture', 'database', 'storageFormat'}
                or compatibility['os'] != 'linux' or compatibility['architecture'] != mapping['hostPlatform']['architecture']
                or compatibility['storageFormat'] != 'physical-pgdata.v1'
                or not isinstance(compatibility['database'], dict) or set(compatibility['database']) != {'engine', 'major'}
                or compatibility['database']['engine'] != 'postgresql'
                or type(compatibility['database']['major']) is not int or not 1 <= compatibility['database']['major'] <= 99
                or not isinstance(checkpoint, dict) or set(checkpoint) != {'bytes', 'sha256'}
                or type(checkpoint['bytes']) is not int or checkpoint['bytes'] <= 0
                or not isinstance(checkpoint['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', checkpoint['sha256'])):
            raise CheckpointError('The portable artifact receipt metadata is invalid')
        file = os.open('checkpoint.tar', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        try:
            details = os.fstat(file)
            if (not stat.S_ISREG(details.st_mode) or details.st_uid != capture.a.OWNER or details.st_nlink != 1
                    or stat.S_IMODE(details.st_mode) != 0o600 or details.st_size != checkpoint['bytes']):
                raise CheckpointError('The portable artifact archive is missing or not private')
        finally:
            os.close(file)
    return receipt
