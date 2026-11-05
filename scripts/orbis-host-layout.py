#!/usr/bin/env python3
"""Root-reviewed legacy installation layout, separate from config authority."""
import hashlib
import fcntl
import importlib.util
import json
import os
import stat
from pathlib import Path
from contextlib import contextmanager

_spec = importlib.util.spec_from_file_location('orbis_layout_reset_authority', Path(__file__).with_name('orbis-reset-authority.py'))
R = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R)

STATE_ROOT = Path('/var/lib/orbis/state')
PLAN_SCHEMA = 'orbis.installation-layout-review.v1'
SCHEMA = 'orbis.installation-layout.v1'
PURPOSES = {'retained-authority': 'retained-authority', 'capture-fence': 'capture-fence.json',
            'restore-selector': 'restore-selector.json', 'host-lock': 'host.lock',
            'proxy-config': 'proxy-config', 'proxy-identity': 'proxy-identity'}
FILES = frozenset({'docker-compose.yml', 'orbis-compose.yml', 'orbis-host-compose.yml', '.env',
                   'user-config/tipi-compose.yml', 'VERSION'})
LIMIT = 1024 * 1024
RECEIPT_LIMIT = 65536
LayoutError = R.ResetAuthorityError


def legacy_path(root, purpose):
    root = Path(root)
    suffixes = {'retained-authority': 'retained-authority', 'capture-fence': 'capture-fence.json',
                'restore-selector': 'retained-restore.json', 'host-lock': 'host.lock'}
    if purpose not in suffixes:
        raise LayoutError('Unsupported legacy authority purpose')
    return root.parent / ('.' + root.name + '.orbis-' + suffixes[purpose])


def _no_legacy_authority(root):
    for purpose in ('retained-authority', 'capture-fence', 'restore-selector'):
        path = legacy_path(root, purpose)
        try:
            path.lstat()
        except FileNotFoundError:
            continue
        raise LayoutError('Legacy installation authority requires explicit reconciliation before layout adoption')


def selected_path(root, purpose):
    """Select storage only; this does not authorize Docker or Compose execution."""
    fallback = legacy_path(root, purpose)
    if not STATE_ROOT.exists() and not STATE_ROOT.is_symlink():
        return fallback
    receipt = read(root)
    if receipt is None:
        return fallback
    _no_legacy_authority(root)
    return namespace(root) / PURPOSES[purpose]


def lock_paths(root):
    legacy = legacy_path(root, 'host-lock')
    selected = selected_path(root, 'host-lock')
    return [legacy] if selected == legacy else [legacy, selected]


def _lock_identity(info):
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600):
        raise LayoutError('Installation lock is not protected')
    return {'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid,
            'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}


def open_locks(root, *, create=True):
    """Hold the legacy lock first so previously loaded helpers remain serialized."""
    paths = lock_paths(root)
    descriptors = []
    try:
        for path in paths:
            descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW | (os.O_CREAT if create else 0), 0o600)
            descriptors.append(descriptor)
            before = _lock_identity(os.fstat(descriptor))
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if before != _lock_identity(path.lstat()) or before != _lock_identity(os.fstat(descriptor)):
                raise LayoutError('Installation lock changed')
        if paths != lock_paths(root):
            raise LayoutError('Installation authority changed while acquiring its locks')
        return descriptors
    except BaseException:
        for descriptor in reversed(descriptors):
            os.close(descriptor)
        raise


def _operator():
    if os.geteuid() != 0:
        raise LayoutError('Installation layout review requires a root operator')


def namespace(root):
    root = Path(root)
    if not root.is_absolute() or str(root) != os.path.realpath(root):
        raise LayoutError('Installation path must be canonical')
    path = STATE_ROOT / 'installations' / hashlib.sha256(os.fsencode(str(root))).hexdigest()
    if path.is_relative_to(root) or root.is_relative_to(path):
        raise LayoutError('Installation authority must be outside installation storage')
    return path


def _filesystem(path, mountinfo):
    view = R.filesystem(path, mountinfo)
    if view['fsType'] == 'nsfs':
        raise LayoutError('Installation authority requires a persistent filesystem')
    return R._durable_filesystem(view)


def _plan(root, daemon, context, ancestry, mountinfo):
    if not isinstance(daemon, str) or not daemon or not isinstance(context, str) or not context:
        raise LayoutError('Docker daemon and context are required')
    authority_view = R.filesystem(STATE_ROOT, mountinfo)
    if authority_view != R.filesystem(namespace(root), mountinfo) or authority_view != R.filesystem(STATE_ROOT / 'installations', mountinfo):
        raise LayoutError('Installation authority cannot use an aliased mount')
    return {'schema': PLAN_SCHEMA, 'root': str(root), 'ancestry': ancestry, 'daemon': daemon,
            'context': context, 'namespace': str(namespace(root)),
            'installationFilesystem': _filesystem(root, mountinfo),
            'authorityFilesystem': _filesystem(STATE_ROOT, mountinfo)}


def plan_sha256(plan):
    return hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def review(root, daemon, context, mountinfo=None):
    """Return a read-only plan. Its digest must be approved separately by root."""
    _operator()
    root = Path(root)
    with R._reviewed_ancestry(root) as (ancestry, seal):
        plan = _plan(root, daemon, context, ancestry, mountinfo)
        seal()
        return plan


def prepare(root, daemon, context, approved_plan_sha256, mountinfo=None):
    """Allocate a fresh namespace only for the exact independently approved plan."""
    _operator()
    root = Path(root)
    with R._reviewed_ancestry(root) as (ancestry, seal):
        proposed = _plan(root, daemon, context, ancestry, mountinfo)
        if not isinstance(approved_plan_sha256, str) or approved_plan_sha256 != plan_sha256(proposed):
            raise LayoutError('Exact root-operator plan approval is required')
        seal()
    with enrollment_lock(root) as legacy_lock, R._reviewed_ancestry(root) as (ancestry, seal):
        plan = _plan(root, daemon, context, ancestry, mountinfo)
        if not isinstance(approved_plan_sha256, str) or approved_plan_sha256 != plan_sha256(plan):
            raise LayoutError('Exact root-operator plan approval is required')
        def check():
            seal()
            _no_legacy_authority(root)
            if _plan(root, daemon, context, ancestry, mountinfo) != plan:
                raise LayoutError('Installation layout changed during enrollment')
        check()
        # STATE_ROOT is existing protected service state, never created here.
        with R._control_descriptor(STATE_ROOT) as state:
            R._require_private(os.fstat(state))
            try:
                os.mkdir('installations', 0o700, dir_fd=state)
                os.fsync(state)
            except FileExistsError:
                pass
            with R._control_descriptor(STATE_ROOT / 'installations') as base:
                R._require_private(os.fstat(base))
                check()
                try:
                    os.mkdir(namespace(root).name, 0o700, dir_fd=base)
                except FileExistsError as error:
                    raise LayoutError('Installation enrollment exists or is interrupted; preserve for review') from error
                os.fsync(base)
                fd = os.open(namespace(root).name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=base)
                try:
                    R._require_private(os.fstat(fd))
                    receipt = {'schema': SCHEMA, 'plan': plan, 'approvedPlanSha256': approved_plan_sha256,
                               'legacyLock': legacy_lock}
                    body = (json.dumps(receipt, sort_keys=True, separators=(',', ':')) + '\n').encode()
                    if len(body) > RECEIPT_LIMIT:
                        raise LayoutError('Installation enrollment is too large')
                    check()
                    out = os.open('layout.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                    with os.fdopen(out, 'wb') as stream:
                        os.fchmod(stream.fileno(), 0o600)
                        stream.write(body)
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.fsync(fd)
                    R._assert_entry_named(base, fd, namespace(root).name)
                    check()
                    return receipt
                finally:
                    os.close(fd)


def read(root, daemon=None, context=None, mountinfo=None):
    """Return None only for an absent namespace; invalid enrollment fails closed."""
    _operator()
    root = Path(root)
    path = namespace(root)
    try:
        with R._control_descriptor(STATE_ROOT) as state:
            R._require_private(os.fstat(state))
            try:
                base = os.open('installations', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=state)
            except FileNotFoundError:
                return None
            try:
                R._require_private(os.fstat(base))
                try:
                    fd = os.open(path.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=base)
                except FileNotFoundError:
                    return None
                try:
                    R._require_private(os.fstat(fd))
                    receipt_fd = os.open('layout.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        before = os.fstat(receipt_fd)
                        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.geteuid()
                                or stat.S_IMODE(before.st_mode) != 0o600):
                            raise LayoutError('Installation enrollment is not protected')
                        with os.fdopen(receipt_fd, 'rb', closefd=False) as source:
                            body = source.read(RECEIPT_LIMIT + 1)
                        after = os.stat('layout.json', dir_fd=fd, follow_symlinks=False)
                        if len(body) > RECEIPT_LIMIT:
                            raise LayoutError('Installation enrollment is invalid')
                        if (before.st_dev, before.st_ino, before.st_mode, before.st_uid, before.st_gid, before.st_nlink, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_mode, after.st_uid, after.st_gid, after.st_nlink, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                            raise LayoutError('Installation enrollment changed')
                        value = json.loads(body)
                    finally:
                        os.close(receipt_fd)
                    if (not isinstance(value, dict) or set(value) != {'schema', 'plan', 'approvedPlanSha256', 'legacyLock'}
                            or value['schema'] != SCHEMA
                            or body != (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()):
                        raise LayoutError('Installation enrollment is invalid')
                    with R._reviewed_ancestry(root) as (ancestry, seal):
                        recorded = value['plan']
                        if not isinstance(recorded, dict):
                            raise LayoutError('Installation enrollment is invalid')
                        plan = _plan(root, daemon if daemon is not None else recorded.get('daemon'),
                                     context if context is not None else recorded.get('context'), ancestry, mountinfo)
                        if value['plan'] != plan or value['approvedPlanSha256'] != plan_sha256(plan):
                            raise LayoutError('Installation enrollment identity changed')
                        if value['legacyLock'] != _lock_identity(legacy_path(root, 'host-lock').lstat()):
                            raise LayoutError('Legacy installation lock identity changed')
                        seal()
                    R._assert_entry_named(base, fd, path.name)
                    R._assert_entry_named(state, base, 'installations')
                    _no_legacy_authority(root)
                    return value
                finally:
                    os.close(fd)
            finally:
                os.close(base)
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise LayoutError('Installation enrollment is unavailable or invalid; preserve it for review') from error


@contextmanager
def enrollment_lock(root):
    """Serialize adoption with the existing host lock; retain every legacy file."""
    _no_legacy_authority(root)
    path = legacy_path(root, 'host-lock')
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = _lock_identity(os.fstat(descriptor))
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if _lock_identity(path.lstat()) != info:
            raise LayoutError('Legacy installation lock changed')
        _no_legacy_authority(root)
        yield info
        if _lock_identity(path.lstat()) != info or _lock_identity(os.fstat(descriptor)) != info:
            raise LayoutError('Legacy installation lock changed')
    finally:
        os.close(descriptor)


def purpose_path(root, daemon, context, purpose, mountinfo=None):
    if not isinstance(purpose, str) or purpose not in PURPOSES:
        raise LayoutError('Unsupported installation authority purpose')
    if read(root, daemon, context, mountinfo) is None:
        return None
    return namespace(root) / PURPOSES[purpose]


def observe_files(root, daemon, context, names, mountinfo=None):
    """Hash bounded root-owned files as observations, never as execution authority."""
    if (not isinstance(names, (list, tuple)) or any(not isinstance(name, str) for name in names)
            or len(names) != len(set(names)) or any(name not in FILES for name in names)):
        raise LayoutError('Unsupported installation observation')
    receipt = read(root, daemon, context, mountinfo)
    if receipt is None:
        raise LayoutError('Reviewed installation enrollment is required')
    root = Path(root)
    result = {}
    def seal_file(value):
        return tuple(getattr(value, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid',
                                                    'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))
    with R._reviewed_ancestry(root) as (ancestry, seal):
        if _plan(root, daemon, context, ancestry, mountinfo) != receipt['plan']:
            raise LayoutError('Installation enrollment identity changed')
        rootfd = os.open(str(root), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        opened, files, directories, absent = [], [], [], []
        try:
            info = os.fstat(rootfd)
            if (info.st_dev, info.st_ino) != (ancestry[-1]['device'], ancestry[-1]['inode']):
                raise LayoutError('Installation root changed')
            for name in names:
                parts = name.split('/')
                parent = rootfd
                if len(parts) == 2:
                    try:
                        parent = os.open(parts[0], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=rootfd)
                    except FileNotFoundError:
                        result[name] = None
                        absent.append((rootfd, parts[0]))
                        continue
                    opened.append(parent)
                    directories.append((rootfd, parts[0], parent, os.fstat(parent)))
                try:
                    filefd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                except FileNotFoundError:
                    result[name] = None
                    absent.append((parent, parts[-1]))
                    continue
                opened.append(filefd)
                before = os.fstat(filefd)
                if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.geteuid()
                        or not 0 <= before.st_size <= LIMIT):
                    raise LayoutError('Installation observation is not a root-owned bounded regular file')
                with os.fdopen(filefd, 'rb', closefd=False) as source:
                    body = source.read(LIMIT + 1)
                if len(body) > LIMIT or len(body) != before.st_size:
                    raise LayoutError('Installation observation changed')
                files.append((parent, parts[-1], filefd, seal_file(before)))
                result[name] = hashlib.sha256(body).hexdigest()
            for parent, name, descriptor, expected in files:
                if any(seal_file(info) != expected for info in
                       (os.fstat(descriptor), os.stat(name, dir_fd=parent, follow_symlinks=False))):
                    raise LayoutError('Installation observation changed')
            for parent, name in absent:
                try:
                    os.stat(name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                raise LayoutError('Installation observation absence changed')
            for parent, name, descriptor, before in directories:
                keys = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid')
                if any(tuple(getattr(info, key) for key in keys) != tuple(getattr(before, key) for key in keys)
                       for info in (os.fstat(descriptor), os.stat(name, dir_fd=parent, follow_symlinks=False))):
                    raise LayoutError('Installation observation directory changed')
            seal()
            if _plan(root, daemon, context, ancestry, mountinfo) != receipt['plan']:
                raise LayoutError('Installation enrollment identity changed')
            return result
        finally:
            for descriptor in reversed(opened):
                os.close(descriptor)
            os.close(rootfd)
