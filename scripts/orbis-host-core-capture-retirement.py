"""Retire one committed root capture lease while preserving its exact inode.

The root completion producer owns publication, continuation and worker-quiescence
verification. Its fixed protected completion-commit.json is the sole retirement
authority; this module has no caller-supplied grants or lock acquisition bypass.
"""
import ctypes
import errno
import hashlib
import os
import re
import stat
import sys
from pathlib import Path


SCHEMA = 'orbis.core-capture-completion-commit.v1'
IDENTITY_FIELDS = {'device', 'inode', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs'}
STAT_FIELDS = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns')
HASH_FIELDS = {'requestSha256', 'leaseSha256', 'completionSha256', 'sourceHoldSha256',
               'continuationSha256', 'pointReservationSha256'}
COMMIT_FIELDS = {'schema', 'id', 'root', 'context', 'leaseIdentity'} | HASH_FIELDS
REQUEST_FIELDS = {'schema', 'id', 'root', 'context', 'snapshots', 'sourceSha256', 'leaseNonce', 'handoffSha256'}
LEASE_FIELDS = {'schema', 'id', 'root', 'context', 'nonce', 'sourceSha256'}
HASH = re.compile('[a-f0-9]{64}')


def lease_identity(info):
    return dict(zip(('device', 'inode', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs'),
                    (getattr(info, key) for key in STAT_FIELDS)))


def directory_identity(info):
    return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid'))


def rename_noreplace(parent_fd, source_name, target_name):
    """An atomic same-directory rename that cannot replace an existing name."""
    if (type(parent_fd) is not int or not 0 <= parent_fd <= 2**31 - 1
            or any(not isinstance(name, str) or not name or name in {'.', '..'}
                   or '/' in name or '\0' in name for name in (source_name, target_name))):
        raise ValueError('Atomic retirement requires a pinned parent and two single-leaf names')
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform.startswith('linux'):
        name, flags = 'renameat2', 1  # RENAME_NOREPLACE
    elif sys.platform == 'darwin':
        name, flags = 'renameatx_np', 4  # RENAME_EXCL
    else:
        raise OSError(errno.ENOTSUP, 'Atomic no-replace retirement is unavailable')
    function = getattr(libc, name, None)
    if function is None and sys.platform.startswith('linux'):
        # Linux UAPI: x86 syscall_64.tbl and asm-generic/unistd.h. musl may omit
        # the wrapper even when the kernel supports the same atomic operation.
        number = {'x86_64': 316, 'aarch64': 276}.get(os.uname().machine)
        function = getattr(libc, 'syscall', None)
        if number is None or function is None or ctypes.sizeof(ctypes.c_void_p) != 8 or ctypes.sizeof(ctypes.c_long) != 8:
            raise OSError(errno.ENOTSUP, 'Atomic no-replace retirement is unavailable')
        function.argtypes = (ctypes.c_long, ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
        function.restype = ctypes.c_long
        result = function(number, parent_fd, os.fsencode(source_name), parent_fd, os.fsencode(target_name), flags)
    elif function is None:
        raise OSError(errno.ENOTSUP, 'Atomic no-replace retirement is unavailable')
    else:
        function.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
        function.restype = ctypes.c_int
        result = function(parent_fd, os.fsencode(source_name), parent_fd, os.fsencode(target_name), flags)
    if result:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


class CaptureRetirement:
    def __init__(self, worker, state, root, context, point):
        self.W, self.A, self.P = worker, worker.A, worker.P
        self.H = worker.CORE.HOST
        self.W.require_root()
        self.point = worker.identifier(point)
        self.root = Path(root)
        if (not self.root.is_absolute() or str(self.root) != str(self.root.resolve(strict=True))
                or not self.root.is_dir()):
            raise ValueError('A canonical capture retirement root is required')
        self.context = context
        self.H.IDENTITY.binding(str(self.root), self.context)
        self.state = Path(state)
        self.directory = self.authority_directory()
        self.authority_identities = {}
        for path in (self.state, self.directory.parent, self.directory):
            with self.A.protected_directory(path) as checked:
                self.authority_identities[path] = directory_identity(os.fstat(checked))
        self.seals = {}
        self.path = self.H.capture_fence_path(self.root)
        self.retired_name = self.path.name + '.retired-' + self.point
        self.parent_identity = None
        self._authority()

    def authority_directory(self):
        return self.state / 'core-capture-admissions' / self.point

    def _read(self, name):
        for path, expected in self.authority_identities.items():
            with self.A.protected_directory(path) as checked:
                if directory_identity(os.fstat(checked)) != expected:
                    raise ValueError('The completion authority directory changed')
        with self.A.protected_directory(self.directory) as checked:
            with self.A.protected_file(checked, name, 64 * 1024) as body:
                seal = self.A.seal(os.stat(name, dir_fd=checked, follow_symlinks=False))
                value = self.P.metadata(body, byte_limit=64 * 1024)
                if not isinstance(value, dict) or self.P.canonical(value) != body:
                    raise ValueError('Noncanonical completion authority')
                if name in self.seals and self.seals[name] != seal:
                    raise ValueError('The completion authority changed')
                self.seals[name] = seal
                return value, body

    def _authority(self):
        self.W.require_root()
        commit, _ = self._read('completion-commit.json')
        if (set(commit) != COMMIT_FIELDS or commit['schema'] != SCHEMA
                or commit['id'] != self.point or commit['root'] != str(self.root)
                or commit['context'] != self.context
                or any(not isinstance(commit[key], str) or not HASH.fullmatch(commit[key]) for key in HASH_FIELDS)):
            raise ValueError('Invalid capture completion commit')
        pinned = commit['leaseIdentity']
        if (not isinstance(pinned, dict) or set(pinned) != IDENTITY_FIELDS
                or any(type(value) is not int or not 0 <= value <= 2 ** 64 - 1 for value in pinned.values())
                or not stat.S_ISREG(pinned['mode']) or stat.S_IMODE(pinned['mode']) & 0o077
                or pinned['uid'] != self.A.OWNER or pinned['nlink'] != 1 or pinned['size'] > 8192):
            raise ValueError('Invalid committed capture lease identity')
        request, body = self._read('request.json')
        reserved = request.get('schema') == 'orbis.core-capture-admission.v2'
        extra = {'preparationSha256', 'decisionSha256'} if reserved else set()
        if (set(request) != REQUEST_FIELDS | extra
                or request['schema'] != ('orbis.core-capture-admission.v2' if reserved else 'orbis.core-capture-admission.v1')
                or request['id'] != self.point or request['root'] != str(self.root)
                or request['context'] != self.context
                or any(not isinstance(request[key], str) or not HASH.fullmatch(request[key])
                       for key in {'sourceSha256', 'leaseNonce', 'handoffSha256'} | extra)
                or not isinstance(request['snapshots'], str)
                or not Path(request['snapshots']).is_absolute()
                or str(Path(request['snapshots'])) != request['snapshots']
                or hashlib.sha256(body).hexdigest() != commit['requestSha256']):
            raise ValueError('The completion commit does not bind the original admission')
        lease = {'schema': 'orbis.core-capture-lease.v1', 'id': self.point, 'root': str(self.root),
                 'context': self.context, 'nonce': request['leaseNonce'], 'sourceSha256': request['sourceSha256']}
        lease_body = self.P.canonical(lease)
        if hashlib.sha256(lease_body).hexdigest() != commit['leaseSha256']:
            raise ValueError('The completion commit does not bind the original capture lease')
        return commit, lease, lease_body

    def _parent(self):
        if self.H.capture_fence_path(self.root) != self.path:
            raise ValueError('The canonical capture selector changed')
        parent = None
        try:
            with self.A.protected_directory(self.path.parent, private=False) as checked:
                current = directory_identity(os.fstat(checked))
                if self.parent_identity is not None and current != self.parent_identity:
                    raise ValueError('The capture authority parent changed')
                self.parent_identity = current
                parent = os.dup(checked)
            return parent
        except BaseException:
            if parent is not None:
                os.close(parent)
            raise

    def _parent_unchanged(self, parent):
        checked = self._parent()
        try:
            if directory_identity(os.fstat(parent)) != directory_identity(os.fstat(checked)):
                raise ValueError('The pinned capture authority parent changed')
        finally:
            os.close(checked)

    def _lease(self, parent, name, commit, expected_body):
        with self.A.protected_file(parent, name, 8192) as body:
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if body != expected_body or lease_identity(info) != commit['leaseIdentity']:
                raise ValueError('The committed capture lease changed')
            return info

    def _lock(self):
        descriptor = self.H.LOCK_DESCRIPTOR.get()
        if type(descriptor) is not int:
            raise ValueError('Capture retirement requires the existing host operation lock')
        held = os.fstat(descriptor)
        if (not stat.S_ISREG(held.st_mode) or held.st_uid != self.A.OWNER
                or held.st_nlink != 1 or stat.S_IMODE(held.st_mode) != 0o600):
            raise ValueError('The capture retirement host lock is no longer protected')
        # host_lock exposes descriptors[0], the legacy-first compatibility lock,
        # even when the selected authority namespace has a second lock.
        paths = self.H.AUTHORITY.LAYOUT.lock_paths(self.root)
        lock = paths[0]
        # host_lock validated this legacy-first descriptor. Adopted installations
        # can retain it below a shared ancestor; it is not publication authority.
        if self.A.seal(held) != self.A.seal(lock.lstat()):
            raise ValueError('Capture retirement does not own this installation lock')
        if paths != self.H.AUTHORITY.LAYOUT.lock_paths(self.root):
            raise ValueError('The installation lock selection changed')

    def _no_original_duplicate(self, parent, commit, lease, body):
        try:
            os.stat(self.path.name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return
        with self.A.protected_file(parent, self.path.name, 8192) as current_body:
            info = os.stat(self.path.name, dir_fd=parent, follow_symlinks=False)
            current = self.P.metadata(current_body, byte_limit=8192)
            if (current_body == body or lease_identity(info) == commit['leaseIdentity']
                    or not isinstance(current, dict) or set(current) != LEASE_FIELDS
                    or current.get('schema') != 'orbis.core-capture-lease.v1'
                    or current.get('root') != str(self.root)
                    or current.get('id') == lease['id'] or current.get('nonce') == lease['nonce']):
                raise ValueError('Active and retired capture evidence is contradictory')
            self.W.identifier(current['id'])
            self.H.IDENTITY.binding(str(self.root), current['context'])
            if any(not isinstance(current[key], str) or not HASH.fullmatch(current[key])
                   for key in ('nonce', 'sourceSha256')) or self.P.canonical(current) != current_body:
                raise ValueError('The newer capture selector is ambiguous')

    def inspect_retired(self):
        commit, lease, body = self._authority()
        parent = self._parent()
        try:
            self._lease(parent, self.retired_name, commit, body)
            self._no_original_duplicate(parent, commit, lease, body)
            self._parent_unchanged(parent)
            self._authority()
            os.fsync(parent)
            self._lease(parent, self.retired_name, commit, body)
            self._no_original_duplicate(parent, commit, lease, body)
            self._parent_unchanged(parent)
            self._authority()
            return commit
        finally:
            os.close(parent)

    def retire_committed(self):
        commit, lease, body = self._authority()
        self._lock()
        if self.H.core_capture_owner(self.root) != lease:
            raise ValueError('Capture retirement requires the original admitted capture owner')
        parent = self._parent()
        original = None
        try:
            self._lease(parent, self.path.name, commit, body)
            try:
                os.stat(self.retired_name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise ValueError('Existing retired capture evidence requires inspection')
            original = os.open(self.path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            if lease_identity(os.fstat(original)) != commit['leaseIdentity']:
                raise ValueError('The original open capture lease changed')
            os.fsync(parent)
            self._parent_unchanged(parent)
            self._authority()
            self._lock()
            if self.H.core_capture_owner(self.root) != lease:
                raise ValueError('The admitted capture owner changed')
            self._lease(parent, self.path.name, commit, body)
            if self.A.seal(os.fstat(original)) != self.A.seal(os.stat(self.path.name, dir_fd=parent, follow_symlinks=False)):
                raise ValueError('The original open capture lease changed')
            rename_noreplace(parent, self.path.name, self.retired_name)
            self._lease(parent, self.retired_name, commit, body)
            if lease_identity(os.fstat(original)) != commit['leaseIdentity']:
                raise ValueError('The preserved open capture lease changed')
            self._parent_unchanged(parent)
            self._authority()
            os.fsync(parent)
            self._lease(parent, self.retired_name, commit, body)
            self._no_original_duplicate(parent, commit, lease, body)
            self._parent_unchanged(parent)
            self._authority()
            return commit
        finally:
            if original is not None:
                os.close(original)
            os.close(parent)
