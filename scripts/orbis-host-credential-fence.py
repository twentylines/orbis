#!/usr/bin/env python3
"""Durable credential holds shared with the existing installation lifecycle locks.

Only the root broker may publish/retire a hold. A completed-journal/Root proof is
supplied by that trusted broker, never by HTTP input. Ordinary lifecycle callers
cannot acquire an exception to a credential hold.
"""
import os
import re
import stat
import threading
from contextlib import contextmanager
from pathlib import Path

OWNER = 0
SCHEMA = 'orbis.host-credential-fence.v1'
LIMIT = 4096
BOOTSTRAP_PUBLICATION_PROTOCOL = 1
BOOTSTRAP_PUBLICATION_HOLD = 'credential-bootstrap-publication-hold.json'
_KEY = object()


def fail():
    return ValueError('A protected credential change requires completion or explicit reconciliation')


def _identity(info):
    return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid'))


def _seal(info):
    return _identity(info) + (info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _mount(descriptor):
    path = Path('/proc/self/fdinfo') / str(descriptor)
    if not Path('/proc/self/fdinfo').is_dir():
        return None
    with path.open('rb') as source:
        data = source.read(8193)
    if len(data) > 8192:
        raise fail()
    values = re.findall(rb'^mnt_id:\s*(\d+)\s*$', data, re.M)
    if len(values) != 1:
        raise fail()
    return values[0]


class _Directory:
    """Pin relative ancestors; mutation requires protected Root-owned custody."""
    def __init__(self, path, *, protected):
        self.path, self.descriptors, self.bindings = Path(path), [], []
        self.protected = protected
        try:
            if (not self.path.is_absolute() or str(self.path) != os.path.realpath(self.path)
                    or not self.path.is_dir()):
                raise fail()
            descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            self.descriptors.append(descriptor)
            self.bindings.append((None, None, descriptor, _identity(os.fstat(descriptor)), _mount(descriptor)))
            for part in self.path.parts[1:]:
                parent = descriptor
                descriptor = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                self.descriptors.append(descriptor)
                self.bindings.append((parent, part, descriptor, _identity(os.fstat(descriptor)), _mount(descriptor)))
            self.fd = descriptor
            self.check()
        except BaseException:
            self.close()
            raise

    def check(self):
        if not self.descriptors:
            raise fail()
        for parent, name, descriptor, expected, mount in self.bindings:
            info = os.fstat(descriptor)
            if (_identity(info) != expected or _mount(descriptor) != mount
                    or not stat.S_ISDIR(info.st_mode)
                    or self.protected and (info.st_uid not in {0, OWNER} or info.st_mode & 0o022)):
                raise fail()
            if parent is not None:
                named = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if _identity(named) != expected:
                    raise fail()
                probe = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                try:
                    if _identity(os.fstat(probe)) != expected or _mount(probe) != mount:
                        raise fail()
                finally:
                    os.close(probe)
        if self.protected and os.fstat(self.fd).st_uid != OWNER:
            raise fail()

    def close(self):
        for descriptor in reversed(self.descriptors):
            os.close(descriptor)
        self.descriptors.clear()


def path(host, root):
    return host.AUTHORITY.LAYOUT.selected_path(root, 'credential-fence')


def require_clear(host, root):
    """Observe absence only; malformed/aliased entries always block lifecycle.

    Legacy installations without a hold are not enrolled or made unmanaged here.
    A broker cannot publish into an unprotected legacy parent; it must first use
    the existing reviewed layout transition.
    """
    selected = path(host, root)
    layout = host.AUTHORITY.LAYOUT
    names = (selected.name,)
    if selected != layout.legacy_path(root, 'credential-fence'):
        if selected != layout.namespace(root) / 'credential-fence.json':
            raise fail()
        names += ('credential-bootstrap-intent.json', '.credential-bootstrap-intent.json.pending',
                  BOOTSTRAP_PUBLICATION_HOLD, '.' + BOOTSTRAP_PUBLICATION_HOLD + '.pending')
    with _directory(selected.parent, protected=False) as directory:
        directory.check()
        for name in names:
            try:
                os.stat(name, dir_fd=directory.fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise fail()
        directory.check()


@contextmanager
def _directory(path, *, protected):
    opened = _Directory(path, protected=protected)
    try:
        yield opened
        opened.check()
    finally:
        opened.close()


class _Guard:
    def __init__(self, key, host, root, context, directory, selected, descriptors):
        if key is not _KEY:
            raise fail()
        self._host, self._root, self._context = host, root, context
        self._directory, self._selected, self._descriptors = directory, selected, descriptors
        self._pid, self._thread = os.getpid(), threading.get_ident()
        self._root_identity = _identity(root.lstat())
        self._live = True
        self._locks = tuple(host.AUTHORITY.LAYOUT._lock_identity(os.fstat(fd)) for fd in descriptors)

    def _check(self):
        if (not self._live or self._pid != os.getpid() or self._thread != threading.get_ident()
                or os.geteuid() != OWNER or self._host.LOCK_DESCRIPTOR.get() != self._descriptors[0]
                or str(self._root) != os.path.realpath(self._root)
                or _identity(self._root.lstat()) != self._root_identity
                or path(self._host, self._root) != self._selected
                or self._locks != tuple(self._host.AUTHORITY.LAYOUT._lock_identity(os.fstat(fd)) for fd in self._descriptors)):
            raise fail()
        self._directory.check()
        paths = self._host.AUTHORITY.LAYOUT.lock_paths(self._root)
        if len(paths) != len(self._descriptors):
            raise fail()
        for current, descriptor in zip(paths, self._descriptors):
            if self._host.AUTHORITY.LAYOUT._lock_identity(current.lstat()) != self._host.AUTHORITY.LAYOUT._lock_identity(os.fstat(descriptor)):
                raise fail()
        self._host._require_no_capture_restore_fence(self._root)

    def _value(self, operation_id, admission_binding):
        if (type(operation_id) is not str or not re.fullmatch(r'[a-f0-9]{64}', operation_id)
                or type(admission_binding) is not str or not re.fullmatch(r'[a-f0-9]{64}', admission_binding)):
            raise fail()
        return {'schema': SCHEMA, 'root': str(self._root), 'context': self._context,
                'operationId': operation_id, 'admissionBinding': admission_binding}

    def _read(self):
        self._check()
        try:
            descriptor = os.open(self._selected.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                 dir_fd=self._directory.fd)
        except FileNotFoundError:
            self._check()
            return None, None
        try:
            before = os.fstat(descriptor)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != OWNER or before.st_nlink != 1
                    or stat.S_IMODE(before.st_mode) != 0o600 or not 1 <= before.st_size <= LIMIT):
                raise fail()
            body = os.read(descriptor, LIMIT + 1)
            value = self._host.IDENTITY.PUBLICATION.metadata(body, byte_limit=LIMIT)
            if (type(value) is not dict or set(value) != {'schema', 'root', 'context', 'operationId', 'admissionBinding'}
                    or value != self._value(value.get('operationId'), value.get('admissionBinding'))
                    or body != self._host.IDENTITY.PUBLICATION.canonical(value) + b'\n'
                    or len(body) != before.st_size
                    or any(_seal(info) != _seal(before) for info in (os.fstat(descriptor), os.stat(
                        self._selected.name, dir_fd=self._directory.fd, follow_symlinks=False)))):
                raise fail()
            self._check()
            return value, _seal(before)
        finally:
            os.close(descriptor)

    def read(self):
        return self._read()[0]

    def check(self, operation_id, admission_binding):
        expected = self._value(operation_id, admission_binding)
        if self.read() != expected:
            raise fail()
        return expected

    def begin(self, operation_id, admission_binding):
        expected = self._value(operation_id, admission_binding)
        existing = self.read()
        if existing is not None:
            if existing != expected:
                raise fail()
            return existing
        body = self._host.IDENTITY.PUBLICATION.canonical(expected) + b'\n'
        self._check()
        # Write directly to the exclusive selector: any interrupted or failed
        # publication is itself a durable hold, never a disposable temp file.
        descriptor = os.open(self._selected.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=self._directory.fd)
        try:
            os.fchmod(descriptor, 0o600)
            remaining = memoryview(body)
            while remaining:
                written = os.write(descriptor, remaining)
                if written <= 0:
                    raise fail()
                remaining = remaining[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.fsync(self._directory.fd)
        return self.check(operation_id, admission_binding)

    def finish(self, operation_id, admission_binding, *, verify_completed):
        expected = self._value(operation_id, admission_binding)
        if not callable(verify_completed):
            raise fail()
        current, before = self._read()
        if current is not None and current != expected:
            raise fail()
        if verify_completed() is not True:
            raise fail()
        self._check()
        # Re-read after independent journal/Root checks, before retiring exactly
        # the selector that was checked. Absence is an idempotent completed replay.
        final, after = self._read()
        if final != current or after != before:
            raise fail()
        if current is not None:
            os.unlink(self._selected.name, dir_fd=self._directory.fd)
            os.fsync(self._directory.fd)
        self._check()
        return None


@contextmanager
def locked(host, root, context):
    root = Path(root)
    if (os.geteuid() != OWNER or not root.is_absolute() or not root.is_dir() or str(root) != os.path.realpath(root)
            or type(context) is not str or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', context)):
        raise fail()
    host._require_no_capture_restore_fence(root)
    descriptors, guard, token = [], None, None
    try:
        try:
            descriptors = host.AUTHORITY.LAYOUT.open_locks(root)
        except BlockingIOError as error:
            raise ValueError('another Orbis host operation is in progress') from error
        host._require_no_capture_restore_fence(root)
        selected = path(host, root)
        with _directory(selected.parent, protected=True) as directory:
            token = host.LOCK_DESCRIPTOR.set(descriptors[0])
            guard = _Guard(_KEY, host, root, context, directory, selected, descriptors)
            guard.read()
            try:
                yield guard
                guard._check()
                guard.read()
            finally:
                guard._live = False
    finally:
        if token is not None:
            host.LOCK_DESCRIPTOR.reset(token)
        for descriptor in reversed(descriptors):
            os.close(descriptor)
