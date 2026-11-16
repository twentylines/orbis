"""Private, exclusive checkpoint resource staging; no runtime or restore authority."""
import base64
from contextlib import contextmanager
import hashlib
import importlib.util
import os
from pathlib import Path, PurePosixPath
import stat
import tarfile
import time


spec = importlib.util.spec_from_file_location('orbis_materialize_checkpoint_review', Path(__file__).with_name('orbis-host-core-checkpoint-review.py'))
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)
SCHEMA = 'orbis.core-portable-resources.v1'
IDENTITY = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid')


class MaterializationError(ValueError):
    pass


def fail():
    return MaterializationError('The checkpoint resources cannot be staged losslessly; private interrupted staging was preserved')


def metadata_policy(manifest):
    for entry in manifest['entries']:
        if entry['type'] == 'symlink' and (entry['xattrs'] or entry['mode'] != 0o777 and os.chmod not in os.supports_follow_symlinks):
            raise fail()
        for name in entry['xattrs']:
            # ACLs, capabilities and security labels need an independently
            # qualified filesystem/profile. They are never silently stripped.
            if not base64.b64decode(name).startswith(b'user.'):
                raise fail()


@contextmanager
def parent(root, path):
    parts = PurePosixPath(R.PACK.relative(path)).parts
    if len(parts) < 2 or parts[0] != 'resources':
        raise fail()
    descriptor = os.dup(root)
    try:
        for component in parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor, parts[-1]
    finally:
        os.close(descriptor)


def sync(descriptor):
    os.fsync(descriptor)


def attributes(descriptor, entry):
    os.fchown(descriptor, entry['uid'], entry['gid'])
    os.fchmod(descriptor, entry['mode'])
    for name, value in entry['xattrs'].items():
        os.setxattr(descriptor, base64.b64decode(name), base64.b64decode(value))
    os.utime(descriptor, ns=(entry['mtimeNs'], entry['mtimeNs']))
    sync(descriptor)


def identity(value):
    return tuple(getattr(value, name) for name in IDENTITY)


def resource_receipt(directory, manifest, review, authority):
    """Rehash actual nodes and metadata; a stored marker alone never proves completion."""
    directory = Path(directory)
    metadata_policy(manifest)
    children, links = {'resources': set()}, {}
    for entry in manifest['entries']:
        path = PurePosixPath(entry['path'])
        children.setdefault(str(path.parent), set()).add(path.name)
        if entry['type'] == 'directory':
            children.setdefault(str(path), set())
        if entry['type'] == 'hardlink':
            links[entry['target']] = links.get(entry['target'], 1) + 1
    tree, files, size, inodes = hashlib.sha256(), 0, 0, {}
    deadline = time.monotonic() + 300
    with authority.protected_directory(directory) as outer:
        if set(os.listdir(outer)) != {'resources'}:
            raise fail()
        root = os.open('resources', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=outer)
        try:
            root_stat = os.fstat(root)
            if root_stat.st_uid != authority.OWNER or stat.S_IMODE(root_stat.st_mode) != 0o700:
                raise fail()
            if set(os.listdir(root)) != children['resources']:
                raise fail()
            for entry in manifest['entries']:
                if time.monotonic() > deadline:
                    raise fail()
                kind, path = entry['type'], entry['path']
                with parent(root, path) as (container, name):
                    before = os.stat(name, dir_fd=container, follow_symlinks=False)
                    if (before.st_dev != root_stat.st_dev or stat.S_IMODE(before.st_mode) != entry['mode']
                            or before.st_uid != entry['uid'] or before.st_gid != entry['gid'] or before.st_mtime_ns != entry['mtimeNs']):
                        raise fail()
                    if kind == 'symlink':
                        if not stat.S_ISLNK(before.st_mode) or os.readlink(name, dir_fd=container) != entry['target']:
                            raise fail()
                        observed_attrs = R.PACK.attributes(directory / path)
                    else:
                        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
                                             | (os.O_DIRECTORY if kind == 'directory' else 0), dir_fd=container)
                        try:
                            if authority.seal(before) != authority.seal(os.fstat(descriptor)):
                                raise fail()
                            if kind == 'directory':
                                if not stat.S_ISDIR(before.st_mode) or set(os.listdir(descriptor)) != children[path]:
                                    raise fail()
                            else:
                                if not stat.S_ISREG(before.st_mode) or before.st_size != entry['bytes']:
                                    raise fail()
                                expected_links = links.get(entry['target'] if kind == 'hardlink' else path, 1)
                                if before.st_nlink != expected_links:
                                    raise fail()
                                if kind == 'hardlink':
                                    if inodes.get(entry['target']) != (before.st_dev, before.st_ino):
                                        raise fail()
                                else:
                                    hashed = hashlib.sha256()
                                    while block := os.read(descriptor, 65536):
                                        if time.monotonic() > deadline:
                                            raise fail()
                                        hashed.update(block)
                                    if hashed.hexdigest() != entry['sha256']:
                                        raise fail()
                                    files += 1
                                    size += before.st_size
                                    inodes[path] = (before.st_dev, before.st_ino)
                            observed_attrs = R.PACK.attributes(descriptor)
                            if authority.seal(before) != authority.seal(os.fstat(descriptor)):
                                raise fail()
                        finally:
                            os.close(descriptor)
                    if observed_attrs != entry['xattrs'] or authority.seal(before) != authority.seal(os.stat(name, dir_fd=container, follow_symlinks=False)):
                        raise fail()
                    tree.update(R.PACK.canonical({'path': path, 'seal': authority.seal(before)}))
                    tree.update(b'\n')
            if identity(os.fstat(root)) != identity(root_stat) or identity(os.stat('resources', dir_fd=outer, follow_symlinks=False)) != identity(root_stat):
                raise fail()
            return {'schema': SCHEMA, 'pointId': review['pointId'], 'manifestSha256': review['manifestSha256'],
                    'entryCount': len(manifest['entries']), 'fileCount': files, 'fileBytes': size,
                    'treeSha256': tree.hexdigest(), 'rootSeal': list(authority.seal(os.fstat(outer))),
                    'resourcesSeal': list(authority.seal(os.fstat(root))), 'xattrPolicy': 'user-only.v1', 'restoreAuthority': False}
        finally:
            os.close(root)


def extract(descriptor, directory, manifest, review, authority):
    metadata_policy(manifest)
    directory = Path(directory)
    with authority.protected_directory(directory.parent):
        pass
    space = os.statvfs(directory.parent)
    needed = sum(entry['bytes'] for entry in manifest['entries'] if entry['type'] == 'file')
    if space.f_bavail * space.f_frsize < needed + len(manifest['entries']) * 8192 + 256 * 1024 * 1024:
        raise fail()
    directory.mkdir(mode=0o700)
    (directory / 'resources').mkdir(mode=0o700)
    # Only descendants change while the private custody root is pinned.
    with authority.protected_directory(directory) as outer:
        root = os.open('resources', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=outer)
        try:
            deadline = time.monotonic() + 300
            with os.fdopen(os.dup(descriptor), 'rb') as stream:
                stream.seek(0)
                with tarfile.open(fileobj=stream, mode='r:', tarinfo=R.BoundedTarInfo) as archive:
                    for entry in manifest['entries']:
                        member = archive.next()
                        if member is None or member.name != entry['path'] or time.monotonic() > deadline:
                            raise fail()
                        kind = entry['type']
                        with parent(root, entry['path']) as (container, name):
                            if kind == 'directory':
                                os.mkdir(name, 0o700, dir_fd=container)
                            elif kind == 'symlink':
                                os.symlink(entry['target'], name, dir_fd=container)
                                if stat.S_IMODE(os.stat(name, dir_fd=container, follow_symlinks=False).st_mode) != entry['mode']:
                                    os.chmod(name, entry['mode'], dir_fd=container, follow_symlinks=False)
                                os.chown(name, entry['uid'], entry['gid'], dir_fd=container, follow_symlinks=False)
                                os.utime(name, ns=(entry['mtimeNs'], entry['mtimeNs']), dir_fd=container, follow_symlinks=False)
                            elif kind == 'hardlink':
                                with parent(root, entry['target']) as (source, target):
                                    os.link(target, name, src_dir_fd=source, dst_dir_fd=container, follow_symlinks=False)
                            else:
                                output = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=container)
                                try:
                                    source, hashed, count = archive.extractfile(member), hashlib.sha256(), 0
                                    while block := source.read(65536):
                                        if time.monotonic() > deadline:
                                            raise fail()
                                        hashed.update(block)
                                        count += len(block)
                                        position = 0
                                        while position < len(block):
                                            written = os.write(output, block[position:])
                                            if written <= 0:
                                                raise fail()
                                            position += written
                                    if count != entry['bytes'] or hashed.hexdigest() != entry['sha256']:
                                        raise fail()
                                    sync(output)
                                finally:
                                    os.close(output)
                            sync(container)
            for entry in reversed(manifest['entries']):
                if entry['type'] in {'symlink', 'hardlink'}:
                    continue
                with parent(root, entry['path']) as (container, name):
                    target = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
                                     | (os.O_DIRECTORY if entry['type'] == 'directory' else 0), dir_fd=container)
                    try:
                        attributes(target, entry)
                    finally:
                        os.close(target)
            sync(root)
        finally:
            os.close(root)
    with authority.protected_directory(directory.parent) as outer:
        sync(outer)
    return resource_receipt(directory, manifest, review, authority)


def materialize_checkpoint(path, expected, directory, authority):
    result = []
    R.review_checkpoint(path, expected, authority, consume=lambda descriptor, manifest, review:
                        result.append(extract(descriptor, directory, manifest, review, authority)))
    if len(result) != 1:
        raise fail()
    return result[0]


def verify_checkpoint_resources(path, expected, directory, receipt, authority):
    result = []
    R.review_checkpoint(path, expected, authority, consume=lambda _descriptor, manifest, review:
                        result.append(resource_receipt(directory, manifest, review, authority)))
    if result != [receipt]:
        raise fail()
    return receipt
