"""Prepare trusted Sentinel tooling and activate its independently signed package."""

import argparse
import ast
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import socket
import stat
import subprocess
import sys
import time
import uuid
import weakref
from contextlib import ExitStack, contextmanager
from contextvars import ContextVar


OWNER = 0
PYTHON = Path('/usr/bin/python3')
INSTALLED_ROOT = Path('/opt/orbis-sentinel')
INSTALLED_STATE = Path('/var/lib/orbis-sentinel')
HOST_SOURCE_PLAN = 'orbis.host-source-publication-plan.v2'
TOOLKIT_COMMIT = '79df3acbdadb35630f471a35d17cd4d6a711eccb'
TOOLKIT = {
    'activate_release.py': (74445, 'd296f5969569d894976345f66d38247e04948bed5acc82d655e12eac8d88b147'),
    'verify_release.py': (14462, '9461fb041d055bbae13cc3ce48f3daf09ff8835ceedb8a77c4bf15c237137629'),
    'stage_release.py': (23385, '4d4d52bfbfcc5891d6b1d17da9e14c7ff6c1559aa59e19db7aec5ae28adc50b2'),
    'bootstrap_verifier.py': (13977, '965002f855e940446951d27a2bd44a37043efa692d3e4ba56473bd5525de6e6c'),
    'LICENSE': (35149, '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986'),
}
# The coordinated updater reads this identity without importing the target script.
RELEASE = {'version': '0.1.0-dev.25', 'sha256': 'f6a90314f76a9e9367741e16ce55fc2bf8dd88105ac6964aea3d2c6ffb6c1f16', 'sourceCommit': '79df3acbdadb35630f471a35d17cd4d6a711eccb'}
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_PREPARATIONS = weakref.WeakKeyDictionary()
_RETENTIONS = weakref.WeakKeyDictionary()
_LEASES = weakref.WeakKeyDictionary()
_OBSERVERS = weakref.WeakKeyDictionary()
_OBSERVER_ATTEMPTS = weakref.WeakKeyDictionary()
ACTIVATION_LEASE_PROTOCOL = 'orbis-sentinel.activation-lease.v1'
OBSERVER_CHANGE_PROTOCOL = 'orbis-sentinel.observer-change.v1'


class SentinelInstallError(ValueError):
    pass


def _seal(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class Directory:
    def __init__(self, path, *, private=False):
        self.path = Path(path)
        self.private = private
        if (not self.path.is_absolute() or Path(os.path.abspath(self.path)) != self.path
                or any(ord(character) < 32 or ord(character) == 127 for character in str(self.path))):
            raise SentinelInstallError('Sentinel preparation requires a canonical protected directory')
        self.handles = [os.open('/', DIRECTORY_FLAGS)]
        try:
            for name in self.path.parts[1:]:
                self.handles.append(os.open(name, DIRECTORY_FLAGS, dir_fd=self.handles[-1]))
            self.check()
            if private and stat.S_IMODE(os.fstat(self.fd).st_mode) != 0o700:
                raise SentinelInstallError('Sentinel preparation requires a private directory')
        except BaseException:
            self.close()
            raise

    @property
    def fd(self):
        return self.handles[-1]

    def identity(self):
        return tuple((info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode)
                     for info in map(os.fstat, self.handles))

    def check(self):
        for descriptor in self.handles:
            info = os.fstat(descriptor)
            if info.st_uid not in {0, OWNER} or info.st_mode & 0o022:
                raise SentinelInstallError('Sentinel preparation has an untrusted ancestor')
        if self.private and stat.S_IMODE(os.fstat(self.fd).st_mode) != 0o700:
            raise SentinelInstallError('Sentinel preparation directory is no longer private')
        for parent, child, name in zip(self.handles, self.handles[1:], self.path.parts[1:]):
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            info = os.fstat(child)
            if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                raise SentinelInstallError('Sentinel preparation directory changed')

    def mkdir(self, name, *, existing=False):
        if not re.fullmatch(r'[a-z][a-z0-9-]*', name):
            raise SentinelInstallError('Sentinel preparation directory name is invalid')
        self.check()
        created = False
        try:
            os.mkdir(name, 0o700, dir_fd=self.fd)
            created = True
        except FileExistsError:
            if not existing:
                raise
        if created:
            descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=self.fd)
            try:
                os.fchmod(descriptor, 0o700)
            finally:
                os.close(descriptor)
        self.check()
        with Directory(self.path / name, private=True) as child:
            if os.fstat(child.fd).st_uid != OWNER:
                raise SentinelInstallError('Sentinel preparation directory has a foreign owner')
        return self.path / name

    def close(self):
        for descriptor in reversed(self.handles):
            os.close(descriptor)
        self.handles.clear()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def require_host():
    if (sys.platform != 'linux' or os.getuid() != 0 or os.geteuid() != 0
            or platform.machine().lower() not in {'x86_64', 'amd64', 'aarch64', 'arm64'}):
        raise SentinelInstallError('Sentinel installation requires a Linux AMD64 or ARM64 root operator')
    with Directory(Path('/run/systemd/system')):
        pass


# Observation is best effort and never grants installation or activation authority.
PROGRESS_ROOT = Path('/run/orbis-sentinel-update-progress')
PROGRESS_SLOTS = 16
PROGRESS_MAX = 72 * 1024 * 1024
_PROGRESS = ContextVar('sentinel_update_progress', default=None)
_ACTIVE_PHASES = {'preparing', 'downloading', 'verifying', 'staging', 'installing', 'rolling-back'}
_FINAL_PHASES = {'prepared', 'complete', 'failed', 'rolled-back', 'recovery-required', 'interrupted'}
_TOOLKIT_DOWNLOADS = {
    'activate_release.py': 'activation-tool', 'verify_release.py': 'verification-tool',
    'stage_release.py': 'staging-tool', 'bootstrap_verifier.py': 'verifier-bootstrap', 'LICENSE': 'toolkit-license',
}
_DOWNLOAD_FILES = {*_TOOLKIT_DOWNLOADS.values(), 'verifier', 'release', 'signature'}


def _process_identity(pid):
    try:
        proc = Path('/proc') / str(pid)
        if proc.stat().st_uid != OWNER:
            return None
        stat_fields = (proc / 'stat').read_text().rsplit(') ', 1)[1].split()
        if stat_fields[0] in {'Z', 'X', 'x'}:
            return None
        return f"{Path('/proc/sys/kernel/random/boot_id').read_text().strip()}:{int(stat_fields[19])}"
    except (OSError, ValueError, IndexError):
        return None


def _read_progress(directory, slot):
    try:
        descriptor = os.open(f'job-{slot}.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                             dir_fd=directory.fd)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER or info.st_nlink > 1
                or stat.S_IMODE(info.st_mode) != 0o600 or not 0 < info.st_size <= 1024):
            raise ValueError('Invalid Sentinel progress file')
        body = stream.read(1025)
        if len(body) != info.st_size:
            raise ValueError('Invalid Sentinel progress length')
    record = _json(body)
    if not isinstance(record, dict) or set(record) != {'job', 'pid', 'incarnation'}:
        raise ValueError('Invalid Sentinel progress envelope')
    pid, incarnation, job = record['pid'], record['incarnation'], record['job']
    if (type(pid) is not int or not 1 <= pid <= 2**31 - 1 or not isinstance(incarnation, str)
            or not re.fullmatch(r'[a-f0-9-]{36}:[0-9]{1,20}', incarnation)
            or not isinstance(job, dict) or set(job) != {'id', 'version', 'phase', 'startedAt', 'updatedAt', 'download'}):
        raise ValueError('Invalid Sentinel progress identity')
    if (not isinstance(job['id'], str) or not re.fullmatch(r'[a-f0-9]{32}', job['id'])
            or not isinstance(job['phase'], str) or job['phase'] not in _ACTIVE_PHASES | _FINAL_PHASES
            or type(job['startedAt']) is not int or type(job['updatedAt']) is not int
            or not 0 < job['startedAt'] <= job['updatedAt'] <= 2**53 - 1):
        raise ValueError('Invalid Sentinel progress phase')
    # Reuse the installer version grammar. No digest or path is returned to callers.
    _release_identity({'version': job['version'], 'sha256': '0' * 64, 'sourceCommit': '0' * 40})
    if job['phase'] == 'downloading':
        if _download_progress(job['download']) is None:
            raise ValueError('Invalid Sentinel byte counts')
    elif job['download'] is not None:
        raise ValueError('Unexpected Sentinel byte counts')
    return record


def _download_progress(value):
    if not isinstance(value, dict) or set(value) != {'file', 'currentBytes', 'totalBytes'}:
        return None
    filename, count, total = value['file'], value['currentBytes'], value['totalBytes']
    if (not isinstance(filename, str) or filename not in _DOWNLOAD_FILES or type(count) is not int
            or not 0 <= count <= PROGRESS_MAX
            or (total is not None and (type(total) is not int or not max(1, count) <= total <= PROGRESS_MAX))):
        return None
    return value


def read_update_progress():
    jobs = []
    available = True
    try:
        with Directory(PROGRESS_ROOT, private=True) as directory:
            if os.fstat(directory.fd).st_uid != OWNER:
                raise ValueError('Untrusted Sentinel progress directory')
            for slot in range(PROGRESS_SLOTS):
                try:
                    record = _read_progress(directory, slot)
                except (OSError, ValueError):
                    available = False
                    continue
                if record is None:
                    continue
                job = record['job']
                if job['phase'] in _ACTIVE_PHASES and _process_identity(record['pid']) != record['incarnation']:
                    # Prefer a terminal write that raced the process exit.
                    try:
                        latest = _read_progress(directory, slot)
                    except (OSError, ValueError):
                        latest = None
                    if latest and latest['job']['id'] == job['id'] and latest['job']['phase'] in _FINAL_PHASES:
                        job = latest['job']
                    else:
                        job = {**job, 'phase': 'interrupted', 'download': None}
                jobs.append(job)
            directory.check()
    except FileNotFoundError:
        # A current helper can observe progress before the first installer run.
        pass
    except (OSError, ValueError):
        return {'version': 1, 'available': False, 'jobs': []}
    return {'version': 1, 'available': available, 'jobs': jobs}


class UpdateProgress:
    def __init__(self, directory, slot, version, incarnation, previous):
        timestamp = time.time_ns() // 1_000_000
        self.directory, self.slot = directory, slot
        self.incarnation = incarnation
        timestamp = max(timestamp, previous['updatedAt']) if previous else timestamp
        self.job = {'id': previous['id'] if previous else uuid.uuid4().hex, 'version': version,
                    'startedAt': previous['startedAt'] if previous else timestamp, 'updatedAt': timestamp}
        self.activation_phase = None

    def publish(self, phase, download=None):
        self.job.update(phase=phase, download=download,
                        updatedAt=max(self.job['updatedAt'], time.time_ns() // 1_000_000))
        scratch = f'job-{self.slot}.new'
        try:
            self.directory.check()
            descriptor = os.open(scratch, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                                 0o600, dir_fd=self.directory.fd)
            try:
                with os.fdopen(descriptor, 'wb') as output:
                    os.fchmod(output.fileno(), 0o600)
                    output.write(json.dumps({'job': self.job, 'pid': os.getpid(),
                                             'incarnation': self.incarnation}).encode())
                os.replace(scratch, f'job-{self.slot}.json', src_dir_fd=self.directory.fd, dst_dir_fd=self.directory.fd)
            finally:
                try:
                    os.unlink(scratch, dir_fd=self.directory.fd)
                except FileNotFoundError:
                    pass
        except (OSError, ValueError):
            pass

    def observe(self, name, payload):
        if name.startswith('download-'):
            current = self.job['download']
            if not current or not isinstance(payload, list) or len(payload) != 2 or type(payload[0]) is not int:
                return
            count, total = payload
            if count < current['currentBytes'] or (current['totalBytes'] is not None and current['totalBytes'] != total):
                return
            download = _download_progress({'file': current['file'], 'currentBytes': count, 'totalBytes': total})
            if download is not None:
                self.publish('downloading', download)
        elif name == 'verify-package' and payload == 'staging':
            self.publish('staging')
        elif payload in ('rolling-back', 'rolled-back', 'recovery-required'):
            self.activation_phase = payload
            if payload == 'rolling-back':
                self.publish('rolling-back')

    def failure(self):
        if self.activation_phase == 'rolled-back':
            return 'rolled-back'
        if self.activation_phase in {'rolling-back', 'recovery-required'}:
            return 'recovery-required'
        return 'failed'


def _reserve_progress(stack, version, previous):
    incarnation = _process_identity(os.getpid())
    if incarnation is None:
        return None
    with Directory(PROGRESS_ROOT.parent) as parent:
        parent.mkdir(PROGRESS_ROOT.name, existing=True)
    directory = stack.enter_context(Directory(PROGRESS_ROOT, private=True))
    if os.fstat(directory.fd).st_uid != OWNER:
        return None
    candidates = []
    for slot in range(PROGRESS_SLOTS):
        try:
            record = _read_progress(directory, slot)
            job = record['job'] if record else None
        except (OSError, ValueError):
            job = None
        preferred = previous is not None and job is not None and job['id'] == previous['id'] and job['phase'] == 'prepared'
        candidates.append((not preferred, job['updatedAt'] if job else 0, slot, job))
    for _, _, slot, observed in sorted(candidates):
        descriptor = os.open(f'job-{slot}.lock', os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                             0o600, dir_fd=directory.fd)
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER or info.st_nlink != 1
                    or stat.S_IMODE(info.st_mode) != 0o600):
                continue
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            # Recheck the snapshot after acquiring the exclusive observation slot.
            try:
                record = _read_progress(directory, slot)
            except (OSError, ValueError):
                record = None
            job = record['job'] if record else None
            continuation = job if previous and job and job['id'] == previous['id'] and job['phase'] == 'prepared' else None
            if job != observed:
                continue
            try:
                os.unlink(f'job-{slot}.new', dir_fd=directory.fd)
            except FileNotFoundError:
                pass
            stack.callback(os.close, descriptor)
            descriptor = None
            return UpdateProgress(directory, slot, version, incarnation, continuation)
        finally:
            if descriptor is not None:
                os.close(descriptor)
    return None


@contextmanager
def _observe_update(version, phase, *, previous=None):
    with ExitStack() as stack:
        try:
            progress = _reserve_progress(stack, version, previous)
        except (OSError, ValueError):
            progress = None
        token = _PROGRESS.set(progress)
        if progress:
            progress.publish(phase)
        try:
            yield progress
        except BaseException as failure:
            if progress:
                phase = progress.failure()
                progress.publish('interrupted' if isinstance(failure, KeyboardInterrupt) and phase == 'failed' else phase)
            raise
        finally:
            _PROGRESS.reset(token)


def _progress_phase(phase):
    progress = _PROGRESS.get()
    if progress:
        progress.publish(phase)


def _file(path, size, digest, *, mode=0o600, expected=None, maximum=None, read_body=False, allow_empty=False):
    with Directory(path.parent) as parent:
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent.fd)
        try:
            before = os.fstat(descriptor)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != OWNER or before.st_nlink != 1
                    or stat.S_IMODE(before.st_mode) != mode or not (0 if allow_empty else 1) <= before.st_size <= (maximum or size)
                    or (size and before.st_size != size)):
                raise SentinelInstallError('Sentinel preparation file has an untrusted identity')
            actual = hashlib.sha256()
            count = 0
            body = bytearray() if read_body else None
            while chunk := os.read(descriptor, 65536):
                count += len(chunk)
                if count > before.st_size:
                    raise SentinelInstallError('Sentinel preparation file exceeds its size')
                actual.update(chunk)
                if body is not None:
                    body.extend(chunk)
            identity = _seal(before)
            parent.check()
            if ((digest and actual.hexdigest() != digest) or count != before.st_size or _seal(os.fstat(descriptor)) != identity
                    or _seal(os.stat(path.name, dir_fd=parent.fd, follow_symlinks=False)) != identity
                    or (expected is not None and identity != expected)):
                raise SentinelInstallError('Sentinel preparation file changed')
            if body is not None:
                return bytes(body)
            return {'path': path, 'bytes': count, 'sha256': actual.hexdigest(), 'mode': mode, 'identity': identity}
        finally:
            os.close(descriptor)


def _python():
    path = PYTHON.resolve(strict=True)
    with Directory(path.parent):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER or info.st_mode & 0o7022 or not info.st_mode & 0o111:
            raise SentinelInstallError('The system Python interpreter is not trusted')
        return path, _seal(info)


def _environment(work):
    return {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'TMPDIR': str(work / 'tmp'),
            'XDG_CACHE_HOME': str(work / 'cache'), 'XDG_CONFIG_HOME': str(work / 'config'),
            'XDG_STATE_HOME': str(work / 'state'), 'XDG_DATA_HOME': str(work / 'data'),
            'PYTHONDONTWRITEBYTECODE': '1'}


_REPORTER = """
import json as _progress_json, os as _progress_os, socket as _progress_socket, sys as _progress_sys
_progress_channel = _progress_socket.socket(fileno=int(_progress_sys.argv.pop()))
_progress_channel.setblocking(False)
_progress_os.set_inheritable(_progress_channel.fileno(), False)
def _report(value):
    try:
        _progress_channel.send(_progress_json.dumps(value).encode())
    except OSError:
        pass
"""

# The immutable toolkit commits its journal in persist(), under its own activation lock.
# Observe this child's committed phase in-process, never a sibling's global journal.
# If the toolkit shape changes we still report the grouped install and its confirmed outcome.
_TOOLKIT_OBSERVER = """
def _observe_activation_refusal(frame, event, value):
    if (frame.f_code.co_filename != _progress_sys.argv[0]
            or frame.f_code.co_name not in ('activate_release', 'restore_retained')):
        return None
    if (event == 'exception' and isinstance(value, tuple) and len(value) == 3
            and type(value[1]) is frame.f_globals.get('RecoveryRequired')):
        _report('recovery-required')
    return _observe_activation_refusal

def _observe_toolkit(frame, event, _):
    if _progress_observation == 'verify-package':
        if (event == 'call' and frame.f_code.co_name == 'stage_release'
                and frame.f_back and frame.f_back.f_code.co_name == 'verify_release'
                and frame.f_back.f_code.co_filename == _progress_sys.argv[0]
                and frame.f_code.co_filename == _progress_os.path.join(
                    _progress_os.path.dirname(_progress_sys.argv[0]), 'stage_release.py')):
            _report('staging')
        return
    if (event == 'return' and frame.f_code.co_name == 'persist'
            and frame.f_code.co_filename == _progress_sys.argv[0]):
        phase = frame.f_locals.get('phase')
        body = frame.f_locals.get('body')
        if phase in ('rolling-back', 'rolled-back', 'recovery-required') and isinstance(body, bytes) and body == frame.f_locals.get('journal'):
            _report(phase)
"""


def _observed_command(command, options, progress, name, timeout):
    try:
        incoming, outgoing = socket.socketpair(type=socket.SOCK_DGRAM)
    except OSError:
        return subprocess.run(command, **options, capture_output=True, timeout=timeout)
    with incoming, outgoing:
        incoming.setblocking(False)
        prefix = _REPORTER
        if name in ('verify-package', 'activate-sentinel', 'restore-sentinel'):
            prefix += f'_progress_observation = {name!r}\n' + _TOOLKIT_OBSERVER
            prefix += '_progress_sys.setprofile(_observe_toolkit)\n'
            if name in ('activate-sentinel', 'restore-sentinel'):
                prefix += '_progress_sys.settrace(_observe_activation_refusal)\n'
        else:
            prefix += '_download_report = _report\n'
        configured = [*command[:4], prefix + command[4], *command[5:], str(outgoing.fileno())]

        def drain():
            # The child never blocks on progress and sends only a bounded scalar frame.
            for _ in range(128):
                try:
                    payload = incoming.recv(128)
                except OSError:
                    break
                try:
                    progress.observe(name, json.loads(payload))
                except (ValueError, UnicodeError):
                    continue

        with subprocess.Popen(configured, **{**options, 'pass_fds': (*options['pass_fds'], outgoing.fileno())},
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
            outgoing.close()
            deadline = time.monotonic() + timeout if timeout is not None else None
            try:
                while True:
                    remaining = deadline - time.monotonic() if deadline is not None else 0.2
                    if deadline is not None and remaining <= 0:
                        raise subprocess.TimeoutExpired(command, timeout)
                    try:
                        stdout, stderr = child.communicate(timeout=min(0.2, remaining))
                        break
                    except subprocess.TimeoutExpired:
                        drain()
            except BaseException:
                child.kill()
                child.communicate()
                raise
            finally:
                drain()
            return subprocess.CompletedProcess(command, child.returncode, stdout, stderr)


def _run(work, name, code, arguments, *, timeout=60, descriptors=()):
    interpreter, identity = _python()
    with Directory(work, private=True) as directory:
        command = [str(interpreter), '-I', '-B', '-c', code, *map(str, arguments)]
        options = dict(cwd=work, env=_environment(work), stdin=subprocess.DEVNULL, pass_fds=descriptors)
        progress = _PROGRESS.get()
        if progress and (name.startswith('download-') or name in {'verify-package', 'activate-sentinel', 'restore-sentinel'}):
            result = _observed_command(command, options, progress, name, timeout)
        else:
            result = subprocess.run(command, **options, capture_output=True, timeout=timeout)
        directory.check()
        if _seal(interpreter.lstat()) != identity:
            raise SentinelInstallError('The system Python interpreter changed')
        if len(result.stdout) > 65536 or len(result.stderr) > 16384:
            raise SentinelInstallError('Sentinel preparation command exceeded its output limit')
        for extension, body in (('stdout', result.stdout), ('stderr', result.stderr)):
            descriptor = os.open(name + '.' + extension, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o600, dir_fd=directory.fd)
            with os.fdopen(descriptor, 'wb') as output:
                os.fchmod(output.fileno(), 0o600)
                output.write(body)
                output.flush()
                os.fsync(output.fileno())
        if result.returncode:
            raise SentinelInstallError('Sentinel preparation or activation did not complete; private files were retained')
        return result.stdout


DOWNLOAD = r'''
import hashlib, os, sys, time
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
url, descriptor, maximum, size, expected = sys.argv[1:]
descriptor, maximum, size = int(descriptor), int(maximum), int(size)
assert urlsplit(url).scheme == 'https'
digest, count = hashlib.sha256(), 0
report = globals().get('_download_report')
last_report = 0
with urlopen(Request(url, headers={'User-Agent': 'Orbis-Sentinel-installer/1'}), timeout=15) as response:
    assert response.status == 200
    final = urlsplit(response.geturl())
    assert final.scheme == 'https' and final.hostname in {
        'raw.githubusercontent.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}
    total = size or None
    if report:
        lengths = response.headers.get_all('Content-Length', [])
        if (total is None and not response.headers.get('Transfer-Encoding') and len(lengths) == 1
                and lengths[0].isascii() and lengths[0].isdigit() and len(lengths[0]) <= 9):
            length = int(lengths[0])
            total = length if 0 < length <= maximum else None
        report([0, total])
    with os.fdopen(descriptor, 'wb', closefd=False) as output:
        while chunk := response.read(65536):
            count += len(chunk)
            assert count <= maximum
            digest.update(chunk)
            output.write(chunk)
            if report and time.monotonic() - last_report >= 0.15:
                output.flush()
                report([os.fstat(descriptor).st_size, total])
                last_report = time.monotonic()
        assert count > 0 and (size == 0 or count == size) and (total is None or count == total) and (not expected or digest.hexdigest() == expected)
        output.flush()
        os.fsync(output.fileno())
        if report:
            report([count, total])
'''


def _download(work, path, url, maximum, *, size=0, digest=''):
    progress = _PROGRESS.get()
    if progress:
        filename = _TOOLKIT_DOWNLOADS.get(path.name)
        if filename is None:
            filename = 'verifier' if path.name == 'github-cli.tar.gz' else 'signature' if path.name.endswith('.sigstore.json') else 'release'
        progress.publish('downloading', {'file': filename, 'currentBytes': 0, 'totalBytes': size or None})
    with Directory(path.parent, private=True) as parent:
        descriptor = os.open(path.name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                             0o600, dir_fd=parent.fd)
        before = os.fstat(descriptor)
        try:
            os.fchmod(descriptor, 0o600)
            _run(work, 'download-' + path.stem.replace('_', '-'), DOWNLOAD,
                 [url, descriptor, maximum, size, digest], descriptors=(descriptor,))
            parent.check()
            after = os.stat(path.name, dir_fd=parent.fd, follow_symlinks=False)
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                raise SentinelInstallError('Sentinel download destination changed')
        finally:
            os.close(descriptor)
    _progress_phase('preparing')
    return _file(path, size, digest, maximum=maximum)


def _check_files(files):
    for record in files:
        _file(record['path'], record['bytes'], record['sha256'], mode=record['mode'], expected=record['identity'])


def _json(body):
    def pairs(items):
        result = dict(items)
        if len(result) != len(items):
            raise SentinelInstallError('Sentinel preparation returned ambiguous metadata')
        return result
    return json.loads(body, object_pairs_hook=pairs)


class ActivationLease:
    """Opaque live serialization lease, never package or operation authority."""
    def verify(self):
        _activation_lease_descriptor(self)


def _activation_lease_descriptor(lease):
    require_host()
    registered = _LEASES.get(lease) if type(lease) is ActivationLease else None
    if registered is None:
        raise SentinelInstallError('The Sentinel activation lease is not held')
    directory, namespace, descriptor, identity = registered
    directory.check()
    if (directory.path != INSTALLED_STATE or directory.identity() != namespace
            or _seal(os.fstat(descriptor)) != identity
            or _seal(os.stat('activation.lock', dir_fd=directory.fd, follow_symlinks=False)) != identity):
        raise SentinelInstallError('The Sentinel activation lease changed')
    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    directory.check()
    if _seal(os.stat('activation.lock', dir_fd=directory.fd, follow_symlinks=False)) != identity:
        raise SentinelInstallError('The Sentinel activation lease changed')
    return descriptor


@contextmanager
def activation_lease():
    """Hold the existing managed collector's normal update lock across stages.

    No lock file or installation is created here. The caller must separately
    establish its source, accepted operation and component effect authority.
    """
    require_host()
    with Directory(INSTALLED_STATE, private=True) as directory:
        descriptor = os.open('activation.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                             dir_fd=directory.fd)
        lease = ActivationLease()
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER or info.st_nlink != 1
                    or stat.S_IMODE(info.st_mode) != 0o600):
                raise SentinelInstallError('The Sentinel activation lock is untrusted')
            _LEASES[lease] = (directory, directory.identity(), descriptor, _seal(info))
            lease.verify()
            yield lease
            lease.verify()
        finally:
            _LEASES.pop(lease, None)
            # Never LOCK_UN: a verified child may still hold the same open
            # description after an interrupted reply. Closing is sufficient.
            os.close(descriptor)


def _require_toolkit_protocol(prepared, name, expected, failure):
    require_host()
    sealed = _PREPARATIONS.get(prepared) if type(prepared) is Prepared else None
    if sealed is None and type(prepared) is Prepared:
        retained = _RETENTIONS.get(prepared)
        sealed = retained[0] if retained else None
    try:
        current = _preparation_identity(prepared) if sealed is not None else None
    except (TypeError, KeyError, AttributeError):
        raise SentinelInstallError('Prepared Sentinel identity changed') from None
    if (sealed is None or current != sealed[0]
            or sealed[1] and prepared.release != RELEASE):
        raise SentinelInstallError('Prepared Sentinel identity changed')
    with Directory(prepared.work, private=True) as directory:
        if directory.identity() != prepared.identity:
            raise SentinelInstallError('Prepared Sentinel namespace changed')
        _check_files(prepared.files)
        selected = [entry for entry in prepared.files if entry['path'] == prepared.work / 'toolkit/activate_release.py']
        if len(selected) != 1:
            raise SentinelInstallError('The verified Sentinel toolkit is missing')
        entry = selected[0]
        body = _file(entry['path'], entry['bytes'], entry['sha256'], mode=entry['mode'],
                     expected=entry['identity'], read_body=True)
        try:
            syntax = ast.parse(body)
        except SyntaxError:
            raise SentinelInstallError('The verified Sentinel toolkit protocol is invalid') from None
        declarations = [node for node in syntax.body if
                        isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)) and
                        any(isinstance(target, ast.Name) and target.id == name
                            for target in (node.targets if isinstance(node, ast.Assign) else [node.target]))]
        if (len(declarations) != 1 or not isinstance(declarations[0], ast.Assign)
                or len(declarations[0].targets) != 1 or not isinstance(declarations[0].value, ast.Constant)
                or declarations[0].value.value != expected):
            raise SentinelInstallError(failure)
        _check_files(prepared.files)
        directory.check()


def require_activation_lease_support(prepared):
    """Check the authenticated toolkit before committing component intents."""
    _require_toolkit_protocol(prepared, 'ACTIVATION_LEASE_PROTOCOL', ACTIVATION_LEASE_PROTOCOL,
        'The verified Sentinel toolkit does not support coordinated activation leases')


def require_observer_change_support(prepared):
    require_activation_lease_support(prepared)
    _require_toolkit_protocol(prepared, 'OBSERVER_CHANGE_PROTOCOL', OBSERVER_CHANGE_PROTOCOL,
        'The verified Sentinel toolkit does not support managed observer changes')


class Prepared:
    def __init__(self, work, identity, files, release, verifier):
        self.work, self.identity, self.files = work, identity, files
        self.release, self.verifier, self.used = release, verifier, False


def prepare(state_dir):
    return _prepare(state_dir, _release_identity(RELEASE), pinned=True)


def prepare_release(state_dir, release):
    return _prepare(state_dir, _release_identity(release), pinned=False)


def _release_identity(value):
    if (type(value) is not dict or set(value) != {'version', 'sha256', 'sourceCommit'}
            or any(type(item) is not str for item in value.values())):
        raise SentinelInstallError('Choose one complete Sentinel release identity')
    version = value['version']
    if (not 0 < len(version) <= 128 or not re.fullmatch(
            r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', version)
            or not re.fullmatch(r'[0-9a-f]{64}', value['sha256'])
            or not re.fullmatch(r'[0-9a-f]{40}', value['sourceCommit'])):
        raise SentinelInstallError('Sentinel release version, checksum or source revision is invalid')
    prerelease = version.split('+', 1)[0].partition('-')[2]
    build = version.partition('+')[2]
    for identifiers, numeric in ((prerelease, True), (build, False)):
        if identifiers and any(not part or (numeric and part.isdigit() and len(part) > 1 and part.startswith('0'))
                               for part in identifiers.split('.')):
            raise SentinelInstallError('Sentinel release version is not canonical')
    return dict(value)


def _preparation_identity(prepared):
    return (prepared.work, prepared.identity, prepared.verifier,
            tuple(sorted(prepared.release.items())),
            tuple((record['path'], record['bytes'], record['sha256'], record['mode'], record['identity'])
                  for record in prepared.files))


def _prepare(state_dir, release, *, pinned):
    require_host()
    with _observe_update(release['version'], 'preparing') as progress:
        prepared = _prepare_files(state_dir, release, pinned=pinned)
        if progress:
            progress.publish('prepared')
            prepared.progress = dict(progress.job)
        return prepared


def _prepare_files(state_dir, release, *, pinned):
    with Directory(state_dir, private=True) as state:
        work = state.mkdir('sentinel-install-' + uuid.uuid4().hex)
        verifiers = state.mkdir('sentinel-verifiers', existing=True)
    with Directory(work, private=True) as directory:
        for name in ('toolkit', 'inputs', 'tmp', 'cache', 'config', 'state', 'data', 'validated-releases'):
            directory.mkdir(name)
        files = []
        for name, (size, digest) in TOOLKIT.items():
            source = name if name == 'LICENSE' else 'packaging/' + name
            url = 'https://raw.githubusercontent.com/twentylines/orbis-sentinel/' + TOOLKIT_COMMIT + '/' + source
            files.append(_download(work, work / 'toolkit' / name, url, size, size=size, digest=digest))
        _check_files(files)
        spec = _json(_run(work, 'verifier-spec',
            "import json,sys;sys.path.insert(0,sys.argv[1]);import bootstrap_verifier as b;print(json.dumps(b.verifier_spec()))",
            [work / 'toolkit']))
        if (not isinstance(spec, dict) or spec.get('version') != '2.103.3' or spec.get('architecture') not in {'amd64', 'arm64'}
                or type(spec.get('archiveBytes')) is not int or not 0 < spec['archiveBytes'] < 32 * 1024 * 1024
                or not re.fullmatch(r'[0-9a-f]{64}', str(spec.get('archiveSha256', '')))
                or type(spec.get('binaryBytes')) is not int or not 0 < spec['binaryBytes'] < 64 * 1024 * 1024
                or not re.fullmatch(r'[0-9a-f]{64}', str(spec.get('binarySha256', '')))
                or spec.get('url') != 'https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_' + spec['architecture'] + '.tar.gz'):
            raise SentinelInstallError('Pinned verifier metadata is unavailable')
        files.append(_download(work, work / 'inputs' / 'github-cli.tar.gz', spec['url'], spec['archiveBytes'],
                               size=spec['archiveBytes'], digest=spec['archiveSha256']))
        _check_files(files)
        result = _json(_run(work, 'bootstrap-verifier',
            "import json,pathlib,sys;sys.path.insert(0,sys.argv[1]);import bootstrap_verifier as b;print(json.dumps({'verifier':str(b.bootstrap_verifier(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3])))}))",
            [work / 'toolkit', work / 'inputs' / 'github-cli.tar.gz', verifiers]))
        verifier = Path(result['verifier'])
        if not verifier.is_absolute() or not verifier.is_relative_to(verifiers):
            raise SentinelInstallError('Prepared verifier is outside its protected cache')
        files.append(_file(verifier, spec['binaryBytes'], spec['binarySha256'], mode=0o555))
        filename = 'orbis-sentinel-' + release['version'] + '.tar.gz'
        url = 'https://github.com/twentylines/orbis-sentinel/releases/download/v' + release['version'] + '/' + filename
        files.append(_download(work, work / 'inputs' / filename, url, 72 * 1024 * 1024, digest=release['sha256']))
        files.append(_download(work, work / 'inputs' / (filename + '.sigstore.json'), url + '.sigstore.json', 4 * 1024 * 1024))
        _progress_phase('verifying')
        _check_files(files)
        validated = _json(_run(work, 'verify-package',
            "import runpy,sys;sys.path.insert(0,sys.argv[1]);sys.argv=sys.argv[2:];runpy.run_path(sys.argv[0],run_name='__main__')",
            [work / 'toolkit', work / 'toolkit' / 'verify_release.py', '--artifact', work / 'inputs' / filename,
             '--bundle', work / 'inputs' / (filename + '.sigstore.json'), '--workspace', work / 'publisher-verification',
             '--releases', work / 'validated-releases', '--verifier', verifier, '--sha256', release['sha256'],
             '--version', release['version'], '--source-commit', release['sourceCommit']], timeout=90))
        _confirmed(validated, release, activated=False)
        _check_files(files)
        directory.check()
        prepared = Prepared(work, directory.identity(), files, release, verifier)
        _PREPARATIONS[prepared] = (_preparation_identity(prepared), pinned)
        return prepared


def _confirmed(result, release, *, activated):
    if (not isinstance(result, dict) or result.get('activated') is not activated or result.get('publisherVerified') is not True
            or any(result.get(key) != release[key] for key in ('version', 'sha256', 'sourceCommit'))
            or (activated and (type(result.get('retainedVersionsRemoved')) is not int or result['retainedVersionsRemoved'] != 0))):
        raise SentinelInstallError('Sentinel did not confirm the verified component identity')


def _retention_binding(value):
    if (type(value) is not dict or set(value) != {'operationId', 'planSha256', 'targetDigest'}
            or type(value['operationId']) is not str
            or type(value['planSha256']) is not str or not re.fullmatch(r'[a-f0-9]{64}', value['planSha256'])
            or type(value['targetDigest']) is not str or not re.fullmatch(r'sha256:[a-f0-9]{64}', value['targetDigest'])):
        raise SentinelInstallError('An exact coordinated operation binding is required')
    try:
        operation = uuid.UUID(value['operationId'])
    except ValueError as error:
        raise SentinelInstallError('The coordinated operation ID is invalid') from error
    if operation.version != 4 or str(operation) != value['operationId']:
        raise SentinelInstallError('The coordinated operation ID is invalid')
    return dict(value)


def _retention_ticket(value, binding, *, activation_id=None):
    if (type(value) is not dict or set(value) != {'schema', 'activationId', 'sha256', 'binding'}
            or value['schema'] != 'orbis-sentinel.upgrade-retention-ticket.v1'
            or type(value['activationId']) is not str or not re.fullmatch(r'[a-f0-9]{32}', value['activationId'])
            or type(value['sha256']) is not str or not re.fullmatch(r'[a-f0-9]{64}', value['sha256'])
            or value['binding'] != binding
            or activation_id is not None and value['activationId'] != activation_id):
        raise SentinelInstallError('Sentinel did not confirm the operation-bound retained activation')
    return {**value, 'binding': dict(binding)}


def _consume_preparation(prepared):
    if not isinstance(prepared, Prepared) or prepared.used:
        raise SentinelInstallError('Sentinel preparation has already been consumed')
    prepared.used = True
    sealed = _PREPARATIONS.pop(prepared, None)
    try:
        current = _preparation_identity(prepared)
    except (TypeError, KeyError, AttributeError):
        raise SentinelInstallError('Prepared Sentinel identity changed') from None
    if sealed is None or current != sealed[0] or (sealed[1] and prepared.release != RELEASE):
        raise SentinelInstallError('Prepared Sentinel identity changed')
    return sealed


def activate(prepared, *, retain=None, lease=None):
    require_host()
    binding = _retention_binding(retain) if retain is not None else None
    if lease is not None:
        if binding is None:
            raise SentinelInstallError('A coordinated Sentinel activation requires retained return custody')
        _activation_lease_descriptor(lease)
        require_activation_lease_support(prepared)
    sealed = _consume_preparation(prepared)
    with _observe_update(prepared.release['version'], 'installing', previous=getattr(prepared, 'progress', None)):
        result = (_activate_files(prepared, retain=binding, lease=lease) if lease is not None else
                  _activate_files(prepared, retain=binding) if binding is not None else _activate_files(prepared))
        if binding is not None:
            ticket = _retention_ticket(result.get('retainedRollback'), binding, activation_id=result.get('activationId'))
            if result.get('activationId') != ticket['activationId']:
                raise SentinelInstallError('Sentinel retained activation identity is missing')
            _RETENTIONS[prepared] = (sealed, ticket)
        _progress_phase('complete')
        return result


_ACTIVATE_RETAINED = '''
import json,pathlib,runpy,sys
sys.argv=sys.argv[1:]
sys.path.insert(0,str(pathlib.Path(sys.argv[0]).parent))
api=runpy.run_path(sys.argv[0])
options=json.loads(sys.argv[1])
if 'activation_lock_fd' in options and api.get('ACTIVATION_LEASE_PROTOCOL')!='orbis-sentinel.activation-lease.v1':
    raise ValueError('The verified Sentinel toolkit lacks activation lease support')
for key in ('artifact','bundle','workspace','verifier'):
    options[key]=pathlib.Path(options[key])
print(json.dumps(api['activate_release'](**options),sort_keys=True))
'''


_RESTORE_RETAINED = '''
import hashlib,json,pathlib,runpy,sys
sys.argv=sys.argv[1:]
sys.path.insert(0,str(pathlib.Path(sys.argv[0]).parent))
api=runpy.run_path(sys.argv[0])
ticket,expected=json.loads(sys.argv[1]),json.loads(sys.argv[2])
state=api['_Parent'](api['STATE'])
try:
    body=api['_read'](state,'retention-'+ticket['activationId']+'.json',0o600)
finally:
    state.close()
if body is None or hashlib.sha256(body).hexdigest()!=ticket['sha256']:
    raise api['RecoveryRequired']('The retained Sentinel admission changed')
record=api['_json'](body)
candidate=record['activation']['candidate']
if {key:candidate[key] for key in expected}!=expected:
    raise api['RecoveryRequired']('The verified preparation differs from the retained activation')
previous={key:record['activation']['previous'][key] for key in expected}
lease={}
if len(sys.argv)==4:
    if api.get('ACTIVATION_LEASE_PROTOCOL')!='orbis-sentinel.activation-lease.v1':
        raise ValueError('The verified Sentinel toolkit lacks activation lease support')
    lease={'activation_lock_fd':int(sys.argv[3])}
result=api['restore_retained'](ticket,**lease)
print(json.dumps({**result,'previousRelease':previous},sort_keys=True))
'''


def _activate_files(prepared, *, retain=None, lease=None):
    with Directory(prepared.work, private=True) as directory:
        if directory.identity() != prepared.identity:
            raise SentinelInstallError('Prepared Sentinel namespace changed')
        _check_files(prepared.files)
        filename = 'orbis-sentinel-' + prepared.release['version'] + '.tar.gz'
        if retain is None:
            code = "import runpy,sys;sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')"
            arguments = [prepared.work / 'toolkit' / 'activate_release.py', '--artifact', prepared.work / 'inputs' / filename,
                         '--bundle', prepared.work / 'inputs' / (filename + '.sigstore.json'), '--workspace', prepared.work / 'verification',
                         '--verifier', prepared.verifier, '--sha256', prepared.release['sha256'], '--version', prepared.release['version'],
                         '--source-commit', prepared.release['sourceCommit']]
        else:
            code = _ACTIVATE_RETAINED
            options = {'artifact': str(prepared.work / 'inputs' / filename),
                       'bundle': str(prepared.work / 'inputs' / (filename + '.sigstore.json')),
                       'workspace': str(prepared.work / 'verification'), 'verifier': str(prepared.verifier),
                       'sha256': prepared.release['sha256'], 'version': prepared.release['version'],
                       'source_commit': prepared.release['sourceCommit'], 'retain': retain}
            if lease is not None:
                options['activation_lock_fd'] = _activation_lease_descriptor(lease)
            arguments = [prepared.work / 'toolkit' / 'activate_release.py', json.dumps(options)]
        descriptors = {'descriptors': (_activation_lease_descriptor(lease),)} if lease is not None else {}
        result = _json(_run(prepared.work, 'activate-sentinel', code, arguments, timeout=None, **descriptors))
        if lease is not None:
            lease.verify()
        directory.check()
        _confirmed(result, prepared.release, activated=True)
        return result


def restore_retained(prepared, ticket, *, binding, lease=None):
    """Use the verified toolkit's exact return API; never select a version here.

    The coordinator must separately hold its source and operation admission.
    An unused authenticated preparation supports restart reconciliation. A live
    successful retained activation can reuse its pinned preparation directly.
    """
    require_host()
    binding = _retention_binding(binding)
    ticket = _retention_ticket(ticket, binding)
    if lease is not None:
        _activation_lease_descriptor(lease)
        require_activation_lease_support(prepared)
    retained = _RETENTIONS.get(prepared) if isinstance(prepared, Prepared) else None
    if retained is None:
        sealed = _consume_preparation(prepared)
    else:
        sealed, original_ticket = retained
        try:
            current = _preparation_identity(prepared)
        except (TypeError, KeyError, AttributeError):
            raise SentinelInstallError('Prepared Sentinel retention changed') from None
        if (not prepared.used or current != sealed[0]
                or sealed[1] and prepared.release != RELEASE or ticket != original_ticket):
            raise SentinelInstallError('Prepared Sentinel retention changed')
    with _observe_update(prepared.release['version'], 'rolling-back', previous=getattr(prepared, 'progress', None)) as progress:
        if progress:
            progress.activation_phase = 'rolling-back'
        with Directory(prepared.work, private=True) as directory:
            if directory.identity() != prepared.identity:
                raise SentinelInstallError('Prepared Sentinel namespace changed')
            _check_files(prepared.files)
            # Every observation attempt has exclusive output files. A lost
            # reply never overwrites earlier evidence or repeats activation.
            attempt = directory.mkdir('return-' + uuid.uuid4().hex)
            with Directory(attempt, private=True) as output:
                for name in ('tmp', 'cache', 'config', 'state', 'data'):
                    output.mkdir(name)
                arguments = [prepared.work / 'toolkit' / 'activate_release.py', json.dumps(ticket), json.dumps(prepared.release)]
                descriptors = {}
                if lease is not None:
                    descriptor = _activation_lease_descriptor(lease)
                    arguments.append(str(descriptor))
                    descriptors['descriptors'] = (descriptor,)
                result = _json(_run(attempt, 'restore-sentinel', _RESTORE_RETAINED, arguments, timeout=None, **descriptors))
                if lease is not None:
                    lease.verify()
                output.check()
            _check_files(prepared.files)
            directory.check()
        previous = _release_identity(result.get('previousRelease')) if type(result) is dict else None
        if (type(result) is not dict or result.get('restored') is not True or previous is None
                or result.get('version') != previous['version'] or result.get('restoredActivationId') != ticket['activationId']
                or type(result.get('activationId')) is not str or not re.fullmatch(r'[a-f0-9]{32}', result['activationId'])
                or result['activationId'] == ticket['activationId']
                or type(result.get('retainedVersionsRemoved')) is not int or result['retainedVersionsRemoved'] != 0):
            raise SentinelInstallError('Sentinel did not confirm the exact retained return')
        _RETENTIONS[prepared] = (sealed, ticket)
        _progress_phase('rolled-back')
        return result


_OBSERVER_COMMAND = '''
import hashlib,json,os,pathlib,runpy,sys
tool,action,expected,retained,returned,descriptor=sys.argv[1:]
sys.path.insert(0,str(pathlib.Path(tool).parent))
api=runpy.run_path(tool)
if (api.get('ACTIVATION_LEASE_PROTOCOL')!='orbis-sentinel.activation-lease.v1'
        or api.get('OBSERVER_CHANGE_PROTOCOL')!='orbis-sentinel.observer-change.v1'):
    raise ValueError('The verified toolkit lacks managed observer support')
if action=='spec':
    result={'schema':'orbis-sentinel.observer-spec.v1','profile':'orbis-observer-v2',
            'groupName':'orbis-observer','files':api['OBSERVER_PROFILES']['orbis-observer-v2']}
elif action=='observe':
    api['_operator']()
    parents=[]
    lock=None
    try:
        for path in (api['ROOT'],api['STATE'],api['UNITS']):
            parents.append(api['_Parent'](path))
        root,state,units=parents
        lock=api['_activation_lock'](state,int(descriptor))
        installed=api['_receipt'](api['_json'](api['_read'](state,'installed.json',0o600)))
        activation=api['_json'](api['_read'](state,'activation.json',0o600))
        if (activation.get('phase')!='complete' or activation.get('candidate')!=installed
                or api['_read'](state,'admission-'+activation['id']+'.json',0o600)
                   !=api['_encoded']({**activation,'phase':'prepared'})
                or (api['_selector'](root) or {}).get('target')!='releases/'+installed['version']):
            raise api['RecoveryRequired']('The installed collector has no completed activation')
        for name,digest in api['UNIT_HASHES'].items():
            body=api['_read'](units,name,0o644)
            if body is None or hashlib.sha256(body).hexdigest()!=digest:
                raise api['RecoveryRequired']('The collector unit bytes changed')
        systemd=api['Systemd']()
        observed=api['_profile'](systemd,True)
        if any(not observed[name]['active'] for name in api['UNIT_HASHES']):
            raise api['RecoveryRequired']('The collector units are not active')
        host=api['_observer_host'](systemd,observed.get('observerProfile'))
        api['_health'](installed['version'],10)
        result={'release':{key:installed[key] for key in ('version','sha256','sourceCommit')},
                'inventorySha256':hashlib.sha256(api['_encoded'](installed['files'])).hexdigest(),
                'profile':observed.get('observerProfile'),'host':host}
        for parent in parents:
            parent.assert_current()
    finally:
        if lock is not None:
            os.close(lock)
        for parent in reversed(parents):
            parent.close()
else:
    expected=json.loads(expected)
    parent=api['_Parent'](api['STATE'])
    try:
        installed=api['_json'](api['_read'](parent,'installed.json',0o600))
    finally:
        parent.close()
    if {key:installed[key] for key in expected}!=expected:
        raise api['RecoveryRequired']('The observer differs from the authenticated Sentinel preparation')
    if action=='prepare':
        result=api['prepare_observer_profile'](json.loads(retained),activation_lock_fd=int(descriptor))
    elif action=='activate':
        result=api['activate_observer_profile'](json.loads(returned),activation_lock_fd=int(descriptor))
    elif action=='return':
        result=api['restore_observer_profile'](json.loads(returned),activation_lock_fd=int(descriptor))
    else:
        raise ValueError('Unsupported managed observer action')
print(json.dumps(result,sort_keys=True))
'''


_RECONCILE_RETAINED = '''
import hashlib,json,os,pathlib,runpy,sys
tool,action,expected,retained,returned,descriptor=sys.argv[1:]
sys.path.insert(0,str(pathlib.Path(tool).parent))
api=runpy.run_path(tool)
api['_operator']()
if (action!='reconcile' or api.get('ACTIVATION_LEASE_PROTOCOL')!='orbis-sentinel.activation-lease.v1'
        or api.get('OBSERVER_CHANGE_PROTOCOL')!='orbis-sentinel.observer-change.v1'):
    raise ValueError('The verified toolkit lacks retained observer support')
expected=json.loads(expected)
request=json.loads(retained)
binding=api['_retention_binding'](request['binding'])
parents=[]
lock=None
try:
    for path in (api['ROOT'],api['STATE'],api['UNITS']):
        parents.append(api['_Parent'](path))
    root,state,units=parents
    lock=api['_activation_lock'](state,int(descriptor))
    if set(request)=={'binding'}:
        activation=api['_json'](api['_read'](state,'activation.json',0o600))
        if (type(activation) is not dict or activation.get('schema')!='orbis-sentinel.activation.v1'
                or activation.get('phase')!='complete' or type(activation.get('id')) is not str
                or len(activation['id'])!=32 or any(c not in '0123456789abcdef' for c in activation['id'])):
            raise api['RecoveryRequired']('The interrupted collector has no completed activation')
        retained_body=api['_read'](state,'retention-'+activation['id']+'.json',0o600)
        if retained_body is None:
            raise api['RecoveryRequired']('The collector has no retained activation for this operation')
        ticket={'schema':'orbis-sentinel.upgrade-retention-ticket.v1','activationId':activation['id'],
                'sha256':hashlib.sha256(retained_body).hexdigest(),'binding':binding}
    else:
        ticket=request
    retained_body=api['_read'](state,'retention-'+ticket['activationId']+'.json',0o600)
    if retained_body is None or hashlib.sha256(retained_body).hexdigest()!=ticket['sha256']:
        raise api['RecoveryRequired']('The retained collector admission changed')
    retained_value=api['_json'](retained_body)
    if (type(retained_value) is not dict or set(retained_value)!={'schema','binding','activation'}
            or retained_value['schema']!='orbis-sentinel.upgrade-retention.v1' or retained_value['binding']!=binding):
        raise api['RecoveryRequired']('The retained collector belongs to another operation')
    original=retained_value['activation']
    if (type(original) is not dict or set(original)!={'schema','id','phase','candidate','previous','previousUnits'}
            or original['schema']!='orbis-sentinel.activation.v1' or original['phase']!='prepared'
            or original['id']!=ticket['activationId'] or original['previous'] is None
            or api['_retention_ticket'](original,binding)!=(retained_body,ticket)
            or api['_read'](state,'admission-'+original['id']+'.json',0o600)!=api['_encoded'](original)):
        raise api['RecoveryRequired']('The retained collector original admission changed')
    candidate=api['_receipt'](original['candidate'])
    previous=api['_receipt'](original['previous'])
    if {key:candidate[key] for key in expected}!=expected:
        raise api['RecoveryRequired']('The retained collector differs from the verified target')
    restoration=api['_read'](state,'restoration-'+original['id']+'.json',0o600)
    if restoration is None:
        installed=api['_current_retention'](root,state,ticket)
        activation_state='candidate'
        restoration_result=None
    else:
        # This API's existing-restoration branch only observes an exact
        # completed restoration; incomplete or superseded records refuse.
        # Its admission is already present under the same held lease, so this
        # cannot enter the branch which creates a restoration or has effects.
        result=api['restore_retained'](ticket,activation_lock_fd=int(descriptor))
        if result.get('restored') is not True or result.get('restoredActivationId')!=original['id']:
            raise api['RecoveryRequired']('The collector restoration is not positively reconciled')
        installed=previous
        activation_state='returned'
        restoration_result={**result,'previousRelease':{key:previous[key] for key in expected}}
    for name,digest in api['UNIT_HASHES'].items():
        body=api['_read'](units,name,0o644)
        if body is None or hashlib.sha256(body).hexdigest()!=digest:
            raise api['RecoveryRequired']('The retained collector unit bytes changed')
    systemd=api['Systemd']()
    observer=None
    observer_body=api['_read'](state,'observer-change.json',0o600,32768)
    if observer_body is not None:
        record=api['_json'](observer_body)
        if (type(record) is not dict or set(record)!={'schema','ticket','phase','profile'}
                or record['schema']!=api['OBSERVER_CHANGE_PROTOCOL'] or type(record['ticket']) is not dict):
            raise api['RecoveryRequired']('The retained observer receipt is invalid')
        if record['ticket'].get('binding')==binding:
            observed_ticket=record['ticket']
            admission=api['_observer_admission'](state,observed_ticket)
            if (admission['retainedActivation']!=ticket or record['phase'] not in ('installed','complete','returned')
                    or activation_state=='returned' and record['phase']!='returned'):
                raise api['RecoveryRequired']('The observer effect is not positively reconciled')
            supplied=json.loads(returned)
            if supplied is not None and supplied!=observed_ticket:
                raise api['RecoveryRequired']('The retained observer ticket changed')
            if record['phase']=='installed':
                api['_observer_pending'](systemd,admission,installed['version'])
                expected_files={role:body.hex() for role,body in api['_observer_bodies'](installed['version']).items()}
            else:
                observed=api['_profile'](systemd,True)
                desired=record['profile'] if record['phase']=='complete' else admission['originalProfile']
                if observed.get('observerProfile')!=desired:
                    raise api['RecoveryRequired']('The retained observer loaded profile changed')
                if record['phase']=='complete':
                    host=api['_observer_host'](systemd,desired)
                    deferred=admission['originalProfile'] is None or admission.get('originalSocketDeferred') is True
                    api['_observer_socket'](systemd,not deferred or host!=admission['originalHost'])
                    expected_files={role:body.hex() for role,body in api['_observer_bodies'](installed['version']).items()}
                else:
                    expected_files=admission['originalFiles']
                api['_ready'](systemd,installed['version'])
            if api['_observer_files']()!=expected_files:
                raise api['RecoveryRequired']('The retained observer file bytes changed')
            observer={'ticket':observed_ticket,'phase':record['phase'],'profile':record['profile'],
                      'originalProfile':admission['originalProfile']}
        elif record['phase'] not in ('complete','returned'):
            raise api['RecoveryRequired']('Another observer change requires reconciliation')
    if observer is None:
        if json.loads(returned) is not None:
            raise api['RecoveryRequired']('The recorded observer change disappeared')
        observed=api['_profile'](systemd,True)
        if observed.get('observerProfile')!=original['previousUnits'].get('observerProfile'):
            raise api['RecoveryRequired']('The original observer profile changed before enrollment')
        api['_ready'](systemd,installed['version'])
    result={'retainedRollback':ticket,'candidateRelease':{key:candidate[key] for key in expected},
            'previousRelease':{key:previous[key] for key in expected},'observer':observer,'activation':activation_state,
            'restoration':restoration_result}
    if activation_state=='candidate':
        api['_current_retention'](root,state,ticket)
    elif api['_read'](state,'restoration-'+original['id']+'.json',0o600)!=restoration:
        raise api['RecoveryRequired']('The collector restoration receipt changed')
    for parent in parents:
        parent.assert_current()
finally:
    if lock is not None:
        os.close(lock)
    for parent in reversed(parents):
        parent.close()
print(json.dumps(result,sort_keys=True))
'''


def _observer_profile(value, *, optional=False):
    if value is None and optional:
        return None
    if (type(value) is not dict or set(value) != {'schema', 'profile', 'groupId', 'files'}
            or value['schema'] != 'orbis-sentinel.observer-profile.v1'
            or value['profile'] not in {'orbis-observer-v1', 'orbis-observer-v2'}
            or type(value['groupId']) is not int or not 0 < value['groupId'] < 2**31):
        raise SentinelInstallError('The verified toolkit returned an invalid observer profile')
    _observer_hashes(value['files'])
    return value


def _observer_hashes(value):
    if (type(value) is not dict or set(value) != {'collector', 'host', 'socket', 'sysusers'}
            or any(type(digest) is not str or not re.fullmatch(r'[a-f0-9]{64}', digest) for digest in value.values())):
        raise SentinelInstallError('The verified toolkit returned invalid observer file identities')
    return value


def _observer_ticket(value, retained):
    if (type(value) is not dict or set(value) != {'schema', 'id', 'activationId', 'binding', 'sha256'}
            or value['schema'] != 'orbis-sentinel.observer-change-ticket.v1'
            or type(value['id']) is not str or not re.fullmatch(r'[a-f0-9]{32}', value['id'])
            or value['activationId'] != retained['activationId'] or value['binding'] != retained['binding']
            or type(value['sha256']) is not str or not re.fullmatch(r'[a-f0-9]{64}', value['sha256'])):
        raise SentinelInstallError('The verified toolkit returned an invalid observer retention ticket')
    return json.loads(json.dumps(value))


def _observer_call(prepared, action, *, retained=None, returned=None, lease=None):
    require_observer_change_support(prepared)
    descriptors = () if action == 'spec' else (_activation_lease_descriptor(lease),)
    with Directory(prepared.work, private=True) as directory:
        if directory.identity() != prepared.identity:
            raise SentinelInstallError('Prepared Sentinel namespace changed')
        _check_files(prepared.files)
        attempt = directory.mkdir('observer-' + action + '-' + uuid.uuid4().hex)
        with Directory(attempt, private=True) as output:
            for name in ('tmp', 'cache', 'config', 'state', 'data'):
                output.mkdir(name)
            arguments = [prepared.work / 'toolkit/activate_release.py', action, json.dumps(prepared.release),
                         json.dumps(retained), json.dumps(returned), str(descriptors[0]) if descriptors else '']
            code = _RECONCILE_RETAINED if action == 'reconcile' else _OBSERVER_COMMAND
            result = _json(_run(attempt, 'observer-' + action, code, arguments,
                                timeout=30 if action == 'spec' else None, descriptors=descriptors))
            output.check()
        _check_files(prepared.files)
        directory.check()
    if lease is not None:
        lease.verify()
    return result


def observer_profile_spec(prepared):
    """Read the authenticated toolkit's static target before component effects."""
    result = _observer_call(prepared, 'spec')
    if (type(result) is not dict or set(result) != {'schema', 'profile', 'groupName', 'files'}
            or result['schema'] != 'orbis-sentinel.observer-spec.v1'
            or result['profile'] != 'orbis-observer-v2' or result['groupName'] != 'orbis-observer'):
        raise SentinelInstallError('The verified toolkit returned an invalid observer specification')
    _observer_hashes(result['files'])
    return result


def observe_installation(prepared, *, lease):
    """Re-read the real installed inventory, loaded profile and exact health.

    The authenticated toolkit is only an observer here. This never consumes a
    preparation, changes a selector, creates an admission or restarts a unit.
    The caller still owns the accepted operation and installation locks.
    """
    require_observer_change_support(prepared)
    _activation_lease_descriptor(lease)
    _installed_payload(INSTALLED_STATE, INSTALLED_ROOT)
    before = _file(INSTALLED_STATE / 'installed.json', None, None, maximum=1024 * 1024, read_body=True)
    installed = _json(before)
    result = _observer_call(prepared, 'observe', lease=lease)
    if (type(result) is not dict or set(result) != {'release', 'inventorySha256', 'profile', 'host'}
            or _release_identity(result['release']) != {key: installed[key] for key in RELEASE}
            or result['inventorySha256'] != hashlib.sha256(
                (json.dumps(installed['files'], sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n').encode('ascii')).hexdigest()
            or type(result['host']) is not dict or set(result['host']) != {'MainPID', 'InvocationID', 'ControlGroup'}
            or type(result['host']['MainPID']) is not str or not result['host']['MainPID'].isascii()
            or not result['host']['MainPID'].isdecimal() or int(result['host']['MainPID']) <= 0
            or type(result['host']['InvocationID']) is not str or not re.fullmatch(r'[a-f0-9]{32}', result['host']['InvocationID'])
            or result['host']['ControlGroup'] != '/system.slice/orbis-host.service'):
        raise SentinelInstallError('The installed collector observation is not bound to its inventory and live Host')
    _observer_profile(result['profile'], optional=True)
    _installed_payload(INSTALLED_STATE, INSTALLED_ROOT)
    if _file(INSTALLED_STATE / 'installed.json', None, None, maximum=1024 * 1024, read_body=True) != before:
        raise SentinelInstallError('The installed collector changed during observation')
    _activation_lease_descriptor(lease)
    return json.loads(json.dumps(result))


def _observer_retention(prepared, retained, binding):
    binding = _retention_binding(binding)
    retained = _retention_ticket(retained, binding)
    known = _RETENTIONS.get(prepared) if type(prepared) is Prepared else None
    if known is None or not prepared.used or known[1] != retained:
        raise SentinelInstallError('Managed observer changes require this retained Sentinel activation')
    require_observer_change_support(prepared)
    return retained


def reconcile_retained(prepared, *, binding, lease, retained=None, observer=None):
    """Authenticate existing Root receipts in a fresh preparation without effects.

    Registration follows verified toolkit observation, never supplied JSON.
    Activation and enrollment are spent; a confirmed remaining return may run
    once under this lease. Uncertain or returned effects are not replayed.
    """
    require_host()
    binding = _retention_binding(binding)
    if type(prepared) is not Prepared or prepared.used or prepared not in _PREPARATIONS:
        raise SentinelInstallError('Retained reconciliation requires a fresh verified preparation')
    request = {'binding': binding} if retained is None else _retention_ticket(retained, binding)
    if observer is not None and retained is not None:
        observer = _observer_ticket(observer, retained)
    _activation_lease_descriptor(lease)
    _installed_payload(INSTALLED_STATE, INSTALLED_ROOT)
    before = _file(INSTALLED_STATE / 'installed.json', None, None, maximum=1024 * 1024, read_body=True)
    result = _observer_call(prepared, 'reconcile', retained=request, returned=observer, lease=lease)
    if (type(result) is not dict or set(result) != {'retainedRollback', 'candidateRelease', 'previousRelease', 'observer', 'activation', 'restoration'}
            or result['activation'] not in ('candidate', 'returned')
            or _release_identity(result['candidateRelease']) != prepared.release):
        raise SentinelInstallError('The retained collector observation differs from the authenticated target')
    ticket = _retention_ticket(result['retainedRollback'], binding)
    if retained is not None and ticket != retained:
        raise SentinelInstallError('The retained collector ticket changed during reconciliation')
    _release_identity(result['previousRelease'])
    restoration = result['restoration']
    if result['activation'] == 'returned':
        if (type(restoration) is not dict or restoration.get('restored') is not True
                or restoration.get('restoredActivationId') != ticket['activationId']
                or restoration.get('previousRelease') != result['previousRelease']
                or restoration.get('version') != result['previousRelease']['version']
                or type(restoration.get('activationId')) is not str
                or not re.fullmatch(r'[a-f0-9]{32}', restoration['activationId'])
                or restoration['activationId'] == ticket['activationId']
                or restoration.get('retainedVersionsRemoved') != 0):
            raise SentinelInstallError('The existing collector restoration is not positively verified')
    elif restoration is not None:
        raise SentinelInstallError('The active collector cannot claim an existing restoration')
    observed = result['observer']
    if observed is not None:
        if (type(observed) is not dict or set(observed) != {'ticket', 'phase', 'profile', 'originalProfile'}
                or observed['phase'] not in ('installed', 'complete', 'returned')):
            raise SentinelInstallError('The retained observer state is not positively reconciled')
        _observer_ticket(observed['ticket'], ticket)
        _observer_profile(observed['profile'])
        _observer_profile(observed['originalProfile'], optional=True)
        if observer is not None and observed['ticket'] != observer:
            raise SentinelInstallError('The retained observer ticket changed during reconciliation')
    elif observer is not None:
        raise SentinelInstallError('The recorded observer change disappeared during reconciliation')
    _installed_payload(INSTALLED_STATE, INSTALLED_ROOT)
    if _file(INSTALLED_STATE / 'installed.json', None, None, maximum=1024 * 1024, read_body=True) != before:
        raise SentinelInstallError('The retained collector changed during reconciliation')
    sealed = _consume_preparation(prepared)
    _RETENTIONS[prepared] = (sealed, ticket)
    _OBSERVER_ATTEMPTS[prepared] = {'enroll'}
    if observed is not None:
        _OBSERVERS[prepared] = json.dumps(observed['ticket'], sort_keys=True)
        if observed['phase'] == 'returned' or result['activation'] == 'returned':
            _OBSERVER_ATTEMPTS[prepared].add('return')
    lease.verify()
    return json.loads(json.dumps(result))


def enroll_observer(prepared, retained, *, binding, lease, ready=None):
    retained = _observer_retention(prepared, retained, binding)
    _activation_lease_descriptor(lease)
    if not callable(ready):
        raise SentinelInstallError('Start independent update progress before reloading the collector')
    attempts = _OBSERVER_ATTEMPTS.setdefault(prepared, set())
    if 'enroll' in attempts:
        raise SentinelInstallError('The observer enrollment requires reconciliation before any retry')
    attempts.add('enroll')
    result = _observer_call(prepared, 'prepare', retained=retained, lease=lease)
    if type(result) is not dict or set(result) != {'ticket', 'profile', 'prepared'} or result['prepared'] is not True:
        raise SentinelInstallError('The verified toolkit did not confirm observer preparation')
    ticket = _observer_ticket(result['ticket'], retained)
    profile = _observer_profile(result['profile'])
    if profile['profile'] != 'orbis-observer-v2':
        raise SentinelInstallError('The verified toolkit did not enroll independent update progress')
    _OBSERVERS[prepared] = json.dumps(ticket, sort_keys=True)
    ready(json.loads(json.dumps(profile)), json.loads(json.dumps(ticket)))
    result = _observer_call(prepared, 'activate', retained=retained, returned=ticket, lease=lease)
    if (type(result) is not dict or set(result) != {'ticket', 'profile', 'enrolled'}
            or result['enrolled'] is not True or result['ticket'] != ticket or result['profile'] != profile):
        raise SentinelInstallError('The verified toolkit did not confirm observer enrollment')
    return result


def return_observer(prepared, retained, ticket, *, binding, lease):
    retained = _observer_retention(prepared, retained, binding)
    ticket = _observer_ticket(ticket, retained)
    if _OBSERVERS.get(prepared) != json.dumps(ticket, sort_keys=True):
        raise SentinelInstallError('The observer return differs from this completed enrollment')
    _activation_lease_descriptor(lease)
    attempts = _OBSERVER_ATTEMPTS.setdefault(prepared, set())
    if 'return' in attempts:
        raise SentinelInstallError('The observer return requires reconciliation before any retry')
    attempts.add('return')
    result = _observer_call(prepared, 'return', retained=retained, returned=ticket, lease=lease)
    if (type(result) is not dict or set(result) != {'ticket', 'profile', 'restored'}
            or result['restored'] is not True or result['ticket'] != ticket):
        raise SentinelInstallError('The verified toolkit did not confirm observer return')
    _observer_profile(result['profile'], optional=True)
    return result


def _installed_payload(state, root):
    def metadata(path, mode=0o600, maximum=1024 * 1024):
        return _json(_file(path, None, None, mode=mode, maximum=maximum, read_body=True))

    installed = metadata(state / 'installed.json')
    if (type(installed) is not dict or set(installed) != {'schema', 'version', 'sha256', 'sourceCommit', 'files'}
            or installed['schema'] != 'orbis-sentinel.installation.v1'):
        raise SentinelInstallError('Invalid Sentinel installation receipt')
    identity = _release_identity({key: installed[key] for key in RELEASE})
    version = identity['version']
    activation = metadata(state / 'activation.json')
    if (type(activation) is not dict or set(activation) != {'schema', 'id', 'phase', 'candidate', 'previous', 'previousUnits'}
            or activation['schema'] != 'orbis-sentinel.activation.v1' or activation['phase'] != 'complete'
            or type(activation['id']) is not str or not re.fullmatch(r'[a-f0-9]{32}', activation['id'])
            or activation['candidate'] != installed
            or metadata(state / f"admission-{activation['id']}.json") != {**activation, 'phase': 'prepared'}):
        raise SentinelInstallError('Sentinel activation and admission receipts do not match the installation')

    with Directory(root) as parent:
        selector = os.stat('current', dir_fd=parent.fd, follow_symlinks=False)
        if (not stat.S_ISLNK(selector.st_mode) or selector.st_uid != OWNER
                or os.readlink('current', dir_fd=parent.fd) != f'releases/{version}'):
            raise SentinelInstallError('Sentinel current selector does not match the installation')
        parent.check()
    base = root / 'releases' / version
    files = installed['files']
    required = {'release.json', 'bin/orbis-sentinel', 'src/orbis_sentinel/host_source_publication.py',
                'src/orbis_sentinel/runtime.py', 'src/orbis_sentinel/__init__.py'}
    if type(files) is not dict or len(files) > 513 or not required <= files.keys():
        raise SentinelInstallError('Installed Sentinel lacks the Host source review payload')

    children = {}
    total = 0
    for name, receipt in files.items():
        maximum = 256 * 1024 if name == 'release.json' else 16 * 1024 * 1024
        if (len(name) > 512 or not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*', name)
                or type(receipt) is not dict or set(receipt) != {'bytes', 'sha256'}
                or type(receipt['bytes']) is not int or not 0 <= receipt['bytes'] <= maximum
                or type(receipt['sha256']) is not str or not re.fullmatch(r'[a-f0-9]{64}', receipt['sha256'])):
            raise SentinelInstallError('Invalid installed Sentinel inventory')
        total += receipt['bytes']
        if total > 65 * 1024 * 1024:
            raise SentinelInstallError('Installed Sentinel inventory exceeds its size limit')
        path = base / name
        _file(path, receipt['bytes'], receipt['sha256'], mode=0o755 if name.startswith('bin/') else 0o644, allow_empty=True)
        while path != base:
            children.setdefault(path.parent, set()).add(path.name)
            path = path.parent
    for path, expected in children.items():
        with Directory(path) as directory:
            info = os.fstat(directory.fd)
            if info.st_uid != OWNER or stat.S_IMODE(info.st_mode) != 0o755 or set(os.listdir(directory.fd)) != expected:
                raise SentinelInstallError('Installed Sentinel release contains unexpected entries')
            directory.check()
    manifest = metadata(base / 'release.json', mode=0o644, maximum=256 * 1024)
    if manifest != {'format': 1, 'component': 'orbis-sentinel', 'version': version, 'python': '>=3.10',
                    'files': {name: record for name, record in files.items() if name != 'release.json'}}:
        raise SentinelInstallError('Sentinel installed manifest differs from its receipt')
    return base / 'bin/orbis-sentinel'


@contextmanager
def _installed_review_launcher():
    with Directory(INSTALLED_STATE, private=True) as state:
        descriptor = os.open('activation.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=state.fd)
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER or info.st_nlink != 1
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size != 0):
                raise SentinelInstallError('Sentinel activation lock is untrusted')
            fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
            if _seal(os.stat('activation.lock', dir_fd=state.fd, follow_symlinks=False)) != _seal(info):
                raise SentinelInstallError('Sentinel activation lock changed')
            launcher = _installed_payload(state.path, INSTALLED_ROOT)
            state.check()
            yield launcher
        finally:
            os.close(descriptor)


def review_host_source(operation, selection_directory, copy_sha):
    if (not all(type(value) is str and re.fullmatch(r'[a-f0-9]{64}', value) for value in (operation, copy_sha))
            or not Path(selection_directory).is_absolute()):
        raise SentinelInstallError('Host source review requires an exact operation and custody tuple')
    try:
        with _installed_review_launcher() as launcher:
            interpreter, identity = _python()
            result = subprocess.run(
                [str(interpreter), '-I', '-B', str(launcher), '--review-host-source', operation,
                 '--installer-selection', str(selection_directory), '--host-copy-sha256', copy_sha],
                cwd='/', env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'HOME': '/'},
                stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
            if _seal(interpreter.lstat()) != identity:
                raise SentinelInstallError('The system Python interpreter changed during review')
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise SentinelInstallError(
            f'Host source review {operation} could not finish. Check the installed Sentinel activation and inventory, '
            f'and retain the selection and any staged plan before retrying. {error}') from error
    if result.returncode or len(result.stdout) > 4096:
        raise SentinelInstallError(f'Sentinel did not confirm Host source review {operation}; retain its custody and check for a staged plan before retrying')
    try:
        review = _json(result.stdout)
    except ValueError:
        review = None
    if (type(review) is not dict or set(review) != {'schema', 'operationId', 'planSha256', 'phase'}
            or review['schema'] != HOST_SOURCE_PLAN or review['operationId'] != operation
            or review['phase'] != 'review-required' or type(review['planSha256']) is not str
            or not re.fullmatch(r'[a-f0-9]{64}', review['planSha256'])):
        raise SentinelInstallError(f'Sentinel returned an invalid review for operation {operation}; inspect the retained plan')
    return review


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--release-version')
    parser.add_argument('--release-sha256')
    parser.add_argument('--release-source-commit')
    args = parser.parse_args()
    try:
        selected = (args.release_version, args.release_sha256, args.release_source_commit)
        if any(value is not None for value in selected):
            if any(value is None for value in selected):
                raise SentinelInstallError('Choose a release version, checksum and source revision together')
            prepared = prepare_release(args.state_dir, {
                'version': args.release_version, 'sha256': args.release_sha256, 'sourceCommit': args.release_source_commit})
        else:
            prepared = prepare(args.state_dir)
        result = {'prepared': True, 'activated': False, 'version': prepared.release['version']} if args.prepare_only else activate(prepared)
    except (OSError, ValueError, subprocess.SubprocessError):
        parser.exit(1, 'Sentinel setup did not complete; retained preparation and activation records require inspection.\n')
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
