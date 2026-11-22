"""Prepare trusted Sentinel tooling and activate its independently signed package."""

import argparse
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
TOOLKIT_COMMIT = '203bbb7594f59be179c569dbc6959ed5e6038b96'
TOOLKIT = {
    'activate_release.py': (28644, '0b4645072cb1de6251b27b5e063bdd38163078ea9c6b1ede7161ef89d71c924f'),
    'verify_release.py': (14462, '9461fb041d055bbae13cc3ce48f3daf09ff8835ceedb8a77c4bf15c237137629'),
    'stage_release.py': (23385, '4d4d52bfbfcc5891d6b1d17da9e14c7ff6c1559aa59e19db7aec5ae28adc50b2'),
    'bootstrap_verifier.py': (13977, '965002f855e940446951d27a2bd44a37043efa692d3e4ba56473bd5525de6e6c'),
    'LICENSE': (35149, '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986'),
}
RELEASE = {'version': '0.1.0-dev.20', 'sha256': '06a4f27aa6bb2424f86a5d6df9d857f2d037007059b9ce21258798e1166285d5', 'sourceCommit': '203bbb7594f59be179c569dbc6959ed5e6038b96'}
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_PREPARATIONS = weakref.WeakKeyDictionary()


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
            or frame.f_code.co_name != 'activate_release'):
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
        if name in ('verify-package', 'activate-sentinel'):
            prefix += f'_progress_observation = {name!r}\n' + _TOOLKIT_OBSERVER
            prefix += '_progress_sys.setprofile(_observe_toolkit)\n'
            if name == 'activate-sentinel':
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
        if progress and (name.startswith('download-') or name in {'verify-package', 'activate-sentinel'}):
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


def activate(prepared):
    require_host()
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
    with _observe_update(prepared.release['version'], 'installing', previous=getattr(prepared, 'progress', None)):
        result = _activate_files(prepared)
        _progress_phase('complete')
        return result


def _activate_files(prepared):
    with Directory(prepared.work, private=True) as directory:
        if directory.identity() != prepared.identity:
            raise SentinelInstallError('Prepared Sentinel namespace changed')
        _check_files(prepared.files)
        filename = 'orbis-sentinel-' + prepared.release['version'] + '.tar.gz'
        result = _json(_run(prepared.work, 'activate-sentinel',
            "import runpy,sys;sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')",
            [prepared.work / 'toolkit' / 'activate_release.py', '--artifact', prepared.work / 'inputs' / filename,
             '--bundle', prepared.work / 'inputs' / (filename + '.sigstore.json'), '--workspace', prepared.work / 'verification',
             '--verifier', prepared.verifier, '--sha256', prepared.release['sha256'], '--version', prepared.release['version'],
             '--source-commit', prepared.release['sourceCommit']], timeout=None))
        directory.check()
        _confirmed(result, prepared.release, activated=True)
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
