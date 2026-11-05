"""Read-only inventory of an already-authorized, quiescent directory descriptor."""
import hashlib
import os
import stat
import sys


class VolumeInventoryError(Exception):
    pass


_FIELDS = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_size', 'st_nlink', 'st_mtime_ns', 'st_ctime_ns')
_MAX_DEPTH = 128


def _seal(info):
    return tuple(getattr(info, name) for name in _FIELDS)


def _text(value, limit):
    if not isinstance(value, str) or not value or any(ord(c) < 32 or ord(c) == 127 or c == '\\' or 0xD800 <= ord(c) <= 0xDFFF or c == '\ufffd' for c in value):
        raise ValueError()
    encoded = value.encode('utf-8', 'strict')
    if len(encoded) > limit:
        raise ValueError()
    return len(encoded)


def scan_directory(fd, *, maximum_entries=250000, maximum_path_bytes=33554432, maximum_bytes=1099511627776, cancelled=lambda: False):
    """Return verified entries; ownership, source identity, and quiescence belong to caller."""
    try:
        if any(not isinstance(value, int) or isinstance(value, bool) or value < 1 for value in (maximum_entries, maximum_path_bytes)) or not isinstance(maximum_bytes, int) or isinstance(maximum_bytes, bool) or maximum_bytes < 0:
            raise ValueError()
        if not callable(cancelled):
            raise ValueError()
        return _scan(fd, maximum_entries, maximum_path_bytes, maximum_bytes, cancelled)
    except Exception:
        raise VolumeInventoryError('Volume inventory could not be verified.') from None


def _scan(fd, maximum_entries, maximum_path_bytes, maximum_bytes, cancelled):
    entries = []
    paths = 0
    total = 0
    links = []
    kinds = {}

    def check():
        if cancelled():
            raise ValueError()

    def add(entry):
        nonlocal paths
        check()
        paths += len(entry['name'].encode('utf-8')) + len(entry.get('target', '').encode('utf-8'))
        if len(entries) >= maximum_entries or paths > maximum_path_bytes:
            raise ValueError()
        entries.append(entry)
        kinds[entry['name']] = entry['kind']

    def named(parent, component):
        return _seal(os.stat(component, dir_fd=parent, follow_symlinks=False))

    def visit(directory, name, initial, depth):
        nonlocal total
        if depth > _MAX_DEPTH or not stat.S_ISDIR(os.fstat(directory).st_mode) or _seal(os.fstat(directory)) != initial:
            raise ValueError()
        check()
        add({'name': name, 'kind': 'directory'})
        children = []
        pending_paths = 0
        with os.scandir(directory) as iterator:
            for entry in iterator:
                check()
                component = entry.name
                _text(component, 255)
                if component in ('.', '..') or '/' in component:
                    raise ValueError()
                full = component if name == '.' else name + '/' + component
                _text(full, 4096)
                pending_paths += len(full.encode('utf-8'))
                if paths + pending_paths > maximum_path_bytes or len(entries) + len(children) >= maximum_entries:
                    raise ValueError()
                children.append((component, full))
        children.sort(key=lambda item: item[0].encode('utf-16-be'))
        for component, full in children:
            check()
            info = os.stat(component, dir_fd=directory, follow_symlinks=False)
            before = _seal(info)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                try:
                    if _seal(os.fstat(child)) != before:
                        raise ValueError()
                    visit(child, full, before, depth + 1)
                    if _seal(os.fstat(child)) != before or named(directory, component) != before:
                        raise ValueError()
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode):
                total += info.st_size
                if info.st_size < 0 or total > maximum_bytes:
                    raise ValueError()
                if sys.platform != 'linux' or not hasattr(os, 'O_PATH'):
                    raise ValueError()
                pinned = os.open(component, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
                try:
                    if _seal(os.fstat(pinned)) != before:
                        raise ValueError()
                    child = os.open(f'/proc/self/fd/{pinned}', os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
                    try:
                        if _seal(os.fstat(child)) != before or _seal(os.fstat(pinned)) != before:
                            raise ValueError()
                        digest = hashlib.sha256()
                        read = 0
                        while True:
                            check()
                            chunk = os.read(child, min(1024 * 1024, info.st_size - read + 1))
                            if not chunk:
                                break
                            read += len(chunk)
                            if read > info.st_size:
                                raise ValueError()
                            digest.update(chunk)
                        if read != info.st_size or _seal(os.fstat(child)) != before or _seal(os.fstat(pinned)) != before or named(directory, component) != before:
                            raise ValueError()
                        add({'name': full, 'kind': 'file', 'bytes': read, 'sha256': digest.hexdigest()})
                    finally:
                        os.close(child)
                finally:
                    os.close(pinned)
            elif stat.S_ISLNK(info.st_mode):
                target = os.readlink(component, dir_fd=directory)
                _text(target, 4096)
                if target.startswith('/'):
                    raise ValueError()
                resolved = [] if name == '.' else name.split('/')
                for part in target.split('/'):
                    if not part:
                        raise ValueError()
                    _text(part, 255)
                    if part == '..':
                        if not resolved:
                            raise ValueError()
                        resolved.pop()
                    elif part != '.':
                        resolved.append(part)
                if named(directory, component) != before:
                    raise ValueError()
                add({'name': full, 'kind': 'symlink', 'target': target})
                links.append(([] if name == '.' else name.split('/'), target.split('/')))
            elif stat.S_ISSOCK(info.st_mode):
                if named(directory, component) != before:
                    raise ValueError()
                add({'name': full, 'kind': 'socket'})
            else:
                raise ValueError()
        if _seal(os.fstat(directory)) != initial:
            raise ValueError()

    root = os.dup(fd)
    try:
        initial = _seal(os.fstat(root))
        visit(root, '.', initial, 0)
        for base, parts in links:
            check()
            resolved = list(base)
            for index, part in enumerate(parts):
                if part == '..':
                    resolved.pop()
                elif part != '.':
                    resolved.append(part)
                current = '/'.join(resolved) if resolved else '.'
                kind = kinds.get(current)
                if kind is None or kind == 'symlink' or (index < len(parts) - 1 and kind != 'directory'):
                    raise ValueError()
            if not resolved or kind not in ('directory', 'file') or (kind == 'directory' and base[:len(resolved)] == resolved):
                raise ValueError()
        if _seal(os.fstat(root)) != initial:
            raise ValueError()
        return sorted(entries, key=lambda entry: entry['name'].encode('utf-16-be'))
    finally:
        os.close(root)
