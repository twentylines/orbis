"""Durable capture exclusion for a trusted supervisor; no admission or reclaim API."""
import os
import re
import secrets
import stat
from contextlib import contextmanager
from pathlib import Path


class CoreCaptureLease:
    def __init__(self, host, root, proof):
        self.host, self.root, self.proof = host, Path(root), proof

    @classmethod
    def require_installation_lock(cls, host, root):
        root = Path(root)
        descriptor = host.LOCK_DESCRIPTOR.get()
        if descriptor is None:
            raise ValueError('Core capture reservation requires the host operation lock')
        if host.RESTORE_TRANSACTION.get() is not None:
            raise ValueError('A restore owner cannot start a core capture')
        held = os.fstat(descriptor)
        if (not stat.S_ISREG(held.st_mode) or held.st_uid != host.AUTHORITY.OWNER
                or held.st_nlink != 1 or stat.S_IMODE(held.st_mode) != 0o600):
            raise ValueError('Core capture installation lock is no longer protected')
        if not any((held.st_dev, held.st_ino) == (info.st_dev, info.st_ino)
                   for info in (path.lstat() for path in host.AUTHORITY.LAYOUT.lock_paths(root))):
            raise ValueError('Core capture reservation does not own this installation lock')

    @classmethod
    def require_reservation_lock(cls, host, root):
        cls.require_installation_lock(host, root)
        host.require_no_capture_fence(root)
        if host.CORE_CAPTURE_OWNER.get() is not None:
            raise ValueError('A capture owner cannot reserve a second operation')

    @classmethod
    def grant(cls, host, root, context, identifier, source_sha256):
        root = Path(root)
        host.IDENTITY.binding(str(root), context)
        cls.staging_name(identifier)
        if not isinstance(source_sha256, str) or not re.fullmatch('[a-f0-9]{64}', source_sha256):
            raise ValueError('A bound core capture identity is required')
        cls.require_reservation_lock(host, root)
        return {'schema': 'orbis.core-capture-lease.v1', 'id': identifier, 'root': str(root),
                'context': context, 'nonce': secrets.token_hex(32), 'sourceSha256': source_sha256}

    @staticmethod
    def staging_name(identifier):
        if (not isinstance(identifier, str)
                or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', identifier)):
            raise ValueError('A bound core capture identity is required')
        return '.orbis-core-capture-' + identifier + '.prepared'

    @classmethod
    def reserve(cls, host, root, context, identifier, source_sha256):
        """Excludes other host operations; it does not prove writers have stopped."""
        root = Path(root)
        value = cls.grant(host, root, context, identifier, source_sha256)
        path = host.capture_fence_path(root)
        body = host.IDENTITY.PUBLICATION.canonical(value)
        with host.AUTHORITY.protected_directory(path.parent, private=False) as checked:
            parent = os.dup(checked)
            expected_parent = tuple(getattr(os.fstat(checked), key) for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode'))
        try:
            fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                with os.fdopen(fd, 'wb', closefd=False) as output:
                    output.write(body)
                    output.flush()
                    os.fsync(fd)
                os.fsync(parent)
            finally:
                os.close(fd)
            with host.AUTHORITY.protected_directory(path.parent, private=False) as checked:
                if tuple(getattr(os.fstat(checked), key) for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode')) != expected_parent:
                    raise ValueError('The capture authority directory changed')
        finally:
            os.close(parent)
        return cls.load(host, root)

    @classmethod
    def load(cls, host, root):
        path = host.capture_fence_path(Path(root))
        with host.AUTHORITY.protected_directory(path.parent, private=False) as parent:
            identity = os.fstat(parent)
            parent_identity = tuple(getattr(identity, key) for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode'))
            with host.AUTHORITY.protected_file(parent, path.name, 8192) as body:
                proof = (body, host.AUTHORITY.seal(os.stat(path.name, dir_fd=parent, follow_symlinks=False)), parent_identity)
        lease = cls(host, root, proof)
        with lease.owner():
            pass
        return lease

    @contextmanager
    def owner(self):
        token = self.host.CORE_CAPTURE_OWNER.set(self.proof)
        try:
            yield self.host.core_capture_owner(self.root)
        finally:
            self.host.CORE_CAPTURE_OWNER.reset(token)
