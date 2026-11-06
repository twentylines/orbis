"""Fixed capture receipts in a pinned, live controller mount namespace."""
import os
import re
import stat
import sys
from contextlib import contextmanager


FIELDS = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid')
FILES = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns')


class NamespaceError(ValueError):
    pass


def probe_retirement(worker, parent, point):
    """Check this filesystem before downtime, using only an exclusively owned empty file."""
    worker.require_root()
    worker.identifier(point)
    retire = worker.load('orbis-host-core-capture-retirement.py', 'namespace_retirement_probe')
    source = '.orbis-core-retirement-probe-' + point
    target = source + '.retired'
    descriptor, before = None, None
    try:
        try:
            os.stat(target, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise NamespaceError('An earlier filesystem probe requires local review')
        descriptor = os.open(source, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        before = os.fstat(descriptor)
        os.fsync(descriptor)
        os.fsync(parent)
        retire.rename_noreplace(parent, source, target)
        os.fsync(parent)
        after = os.stat(target, dir_fd=parent, follow_symlinks=False)
        if tuple(getattr(before, key) for key in FILES) != tuple(getattr(after, key) for key in FILES):
            raise NamespaceError('The filesystem probe did not preserve its exact inode')
    finally:
        try:
            if before is not None:
                expected = tuple(getattr(before, key) for key in FILES)
                for name in (source, target):
                    try:
                        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    except FileNotFoundError:
                        continue
                    if (tuple(getattr(current, key) for key in FILES) != expected
                            or not stat.S_ISREG(current.st_mode) or current.st_nlink != 1
                            or current.st_uid != worker.A.OWNER or stat.S_IMODE(current.st_mode) != 0o600
                            or current.st_size != 0):
                        raise NamespaceError('An ambiguous filesystem probe was preserved for review')
                    os.unlink(name, dir_fd=parent)
                os.fsync(parent)
        finally:
            if descriptor is not None:
                os.close(descriptor)


class CaptureNamespace:
    def __init__(self, worker, reader, controller):
        worker.require_root()
        if sys.platform != 'linux':
            raise NamespaceError('Capture namespace operations require Linux')
        if (not isinstance(controller, dict) or set(controller) != {'id', 'imageId', 'startedAt', 'definitionSha256'}
                or any(not isinstance(controller[key], str) or not worker.HASH.fullmatch(controller[key])
                       for key in ('id', 'definitionSha256'))
                or not isinstance(controller['imageId'], str) or not re.fullmatch('sha256:[a-f0-9]{64}', controller['imageId'])
                or not isinstance(controller['startedAt'], str) or not re.fullmatch(r'[\x20-\x7e]{1,128}', controller['startedAt'])):
            raise NamespaceError('A root-approved controller execution frame is required')
        self.W, self.reader, self.controller = worker, reader, controller
        self.proc = self.root = self.mount = None
        self.rename = worker.load('orbis-host-core-capture-retirement.py', 'namespace_retirement').rename_noreplace
        try:
            self.observed = self._container()
            self.pid = self.observed['pid']
            self.proc = os.open('/proc/' + str(self.pid), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            self.start = self._start()
            # These two links are kernel-provided namespace references. User
            # directory components below the pinned root are never followed.
            self.mount = os.open('ns/mnt', os.O_RDONLY | os.O_CLOEXEC, dir_fd=self.proc)
            self.root = os.open('root', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC, dir_fd=self.proc)
            self.mount_identity = self._identity(os.fstat(self.mount))
            self.root_identity = self._identity(os.fstat(self.root))
            self.unchanged()
        except BaseException:
            self.close()
            raise

    @staticmethod
    def _identity(value):
        return tuple(getattr(value, key) for key in FIELDS)

    def _container(self):
        frame = self.controller
        value = self.reader._object(['container', 'inspect', '--format', '{{json .}}', frame['id']])
        state = value['State']
        if (value['Id'] != frame['id'] or value['Image'] != frame['imageId']
                or state.get('Running') is not True or state.get('Status') != 'running'
                or state.get('Restarting') or state.get('Paused')
                or state.get('StartedAt') != frame['startedAt']
                or type(state.get('Pid')) is not int or state['Pid'] <= 0):
            raise NamespaceError('The controller namespace no longer belongs to this startup')
        return {'pid': state['Pid'], 'id': value['Id'], 'imageId': value['Image'], 'startedAt': state['StartedAt']}

    def _start(self):
        descriptor = os.open('stat', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.proc)
        try:
            body = os.read(descriptor, 8193)
            if not body or len(body) > 8192:
                raise NamespaceError('The controller process identity is unavailable')
            suffix = body[body.rfind(b')') + 2:].split()
            if len(suffix) < 20 or not suffix[19].isdigit():
                raise NamespaceError('Invalid controller process identity')
            return int(suffix[19])
        finally:
            os.close(descriptor)

    def unchanged(self):
        if (self._container() != self.observed or self._start() != self.start
                or self._identity(os.fstat(self.mount)) != self.mount_identity
                or self._identity(os.stat('ns/mnt', dir_fd=self.proc)) != self.mount_identity
                or self._identity(os.fstat(self.root)) != self.root_identity
                or self._identity(os.stat('root', dir_fd=self.proc)) != self.root_identity):
            raise NamespaceError('The pinned controller process or mount namespace changed')

    @contextmanager
    def directory(self, point=None, *, storage_only=False):
        names = ['data', 'backups', 'time-machine']
        if not storage_only:
            names.append('core-capture')
        if point is not None:
            names.append(self.W.identifier(point))
        handles, bindings = [], []
        try:
            self.unchanged()
            parent = self.root
            for index, name in enumerate(names):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
                handles.append(child)
                details = os.fstat(child)
                if (details.st_uid != self.W.A.OWNER or stat.S_IMODE(details.st_mode) & 0o022
                        or index >= 3 and stat.S_IMODE(details.st_mode) != 0o700):
                    raise NamespaceError('Capture continuation storage is not private')
                bindings.append((parent, name, child, self._identity(details)))
                parent = child
            yield parent
            for parent, name, child, expected in bindings:
                if (self._identity(os.fstat(child)) != expected
                        or self._identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != expected):
                    raise NamespaceError('The capture continuation directory changed')
            self.unchanged()
        finally:
            for handle in reversed(handles):
                os.close(handle)

    def verify_storage_root(self, point):
        with self.directory(storage_only=True) as directory:
            if stat.S_IMODE(os.fstat(directory).st_mode) != 0o700:
                raise NamespaceError('The Time Machine storage root is not private')
            probe_retirement(self.W, directory, point)

    def read(self, directory, name):
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
        try:
            before = os.fstat(descriptor)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != self.W.A.OWNER
                    or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) != 0o600
                    or not 0 < before.st_size <= 8192):
                raise NamespaceError('Capture continuation is not a private regular file')
            chunks, count = [], 0
            while count <= before.st_size:
                chunk = os.read(descriptor, min(8193 - count, before.st_size + 1 - count))
                if not chunk:
                    break
                chunks.append(chunk)
                count += len(chunk)
            body = b''.join(chunks)
            if (count != before.st_size or self.W.A.seal(before) != self.W.A.seal(os.fstat(descriptor))
                    or self.W.A.seal(before) != self.W.A.seal(os.stat(name, dir_fd=directory, follow_symlinks=False))):
                raise NamespaceError('The capture continuation file changed')
            value = self.W.P.metadata(body, byte_limit=8192)
            if not isinstance(value, dict) or self.W.P.canonical(value) != body:
                raise NamespaceError('Noncanonical capture continuation')
            return value, body, before
        finally:
            os.close(descriptor)

    def read_continuation(self, point):
        with self.directory(point) as directory:
            value, body, _ = self.read(directory, 'continuation-ready.json')
            return value, body

    def read_abort_terminal(self, point):
        with self.directory(point) as directory:
            return self.read(directory, 'abort-terminal.json')

    def read_abort_continuation(self, point):
        with self.directory(point) as directory:
            return self.read(directory, 'abort-continuation-ready.json')

    def read_source_hold(self, point, *, retired=False):
        self.W.identifier(point)
        with self.directory() as directory:
            return self.read(directory, 'source-hold-retired-' + point + '.json' if retired else 'source-hold.json')

    def verify_no_source_hold(self, point):
        """Consistency only; a positive producer terminal remains indispensable."""
        self.W.require_root()
        self.W.identifier(point)
        with self.directory() as directory:
            before = self._identity(os.fstat(directory))
            for _ in range(2):
                self.unchanged()
                for name in ('source-hold.json', 'source-hold-retired-' + point + '.json'):
                    try:
                        os.stat(name, dir_fd=directory, follow_symlinks=False)
                    except FileNotFoundError:
                        continue
                    raise NamespaceError('Existing source marker evidence forbids never-attempted-marker settlement')
                if self._identity(os.fstat(directory)) != before:
                    raise NamespaceError('The source marker directory changed')
            self.unchanged()
            return {'schema': 'orbis.core-capture-marker-absence.v1', 'id': point,
                    'controller': dict(self.controller), 'directoryIdentity': dict(zip(FIELDS, before))}

    def retire_hold(self, point, expected_sha256, *, identity=None):
        self.W.require_root()
        self.W.identifier(point)
        if not isinstance(expected_sha256, str) or not self.W.HASH.fullmatch(expected_sha256):
            raise NamespaceError('A root-bound source hold digest is required')
        name, target = 'source-hold.json', 'source-hold-retired-' + point + '.json'
        with self.directory() as directory:
            try:
                old = self.read(directory, name)
            except FileNotFoundError:
                old = None
            try:
                retired = self.read(directory, target)
            except FileNotFoundError:
                retired = None
            if old is not None and retired is not None:
                raise NamespaceError('Conflicting active and retired source holds require review')
            selected = old if old is not None else retired
            if (selected is None or selected[0].get('id') != point
                    or selected[0].get('schema') != 'orbis.core-capture-source-hold.v2'
                    or self.W.digest(selected[1]) != expected_sha256):
                raise NamespaceError('No matching positive source hold evidence is present')
            before = selected[2]
            if identity is not None:
                names = ('device', 'inode', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs')
                fields = FILES + ('st_ctime_ns',)
                if (not isinstance(identity, dict) or set(identity) != set(names)
                        or any(not isinstance(value, str) or not re.fullmatch(r'0|[1-9][0-9]{0,19}', value)
                               or int(value) > 2 ** 64 - 1 for value in identity.values())
                        or any(str(getattr(before, field)) != identity[key]
                               for key, field in zip(names if old is not None else names[:-1], fields))):
                    raise NamespaceError('The source hold inode differs from its committed original')
            if old is not None:
                self.unchanged()
                if identity is not None:
                    current = self.read(directory, name)
                    if current[:2] != selected[:2] or self.W.A.seal(current[2]) != self.W.A.seal(before):
                        raise NamespaceError('The original source hold changed before its retirement')
                self.rename(directory, name, target)
            os.fsync(directory)
            value, body, after = self.read(directory, target)
            if (tuple(getattr(before, key) for key in FILES) != tuple(getattr(after, key) for key in FILES)
                    or body != selected[1] or value != selected[0]):
                raise NamespaceError('The preserved source hold differs from its root approval')
            self.unchanged()
            return {'schema': 'orbis.core-capture-source-retirement.v1', 'id': point,
                    'sourceHoldSha256': expected_sha256, 'controller': self.controller,
                    'retiredIdentity': dict(zip(FILES, (getattr(after, key) for key in FILES)))}

    def close(self):
        for name in ('root', 'mount', 'proc'):
            descriptor = getattr(self, name, None)
            if descriptor is not None:
                os.close(descriptor)
                setattr(self, name, None)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
