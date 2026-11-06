#!/usr/bin/env python3
"""Delegated, root-only worker quiescence witness; never releases capture authority.

The caller injects its worker module so admission and lease checks use that
worker's HOST ContextVars. This protocol requires a live supervising process in
its own systemd cgroup and an exclusively created worker child cgroup. Missing
units, PIDs, paths, and unreadable kernel events are never quiescence evidence.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


SUPERVISOR = Path(__file__).absolute()
CGROUP = Path('/sys/fs/cgroup')
BOOT = re.compile('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
HASH = re.compile('[a-f0-9]{64}')
INVOCATION = re.compile('[a-f0-9]{32}')
FRAME_KEYS = {'version', 'unit', 'invocationId', 'processId', 'processStartTime',
              'parentProcessId', 'parentStartTime', 'bootId', 'workerLeaf'}
RECORD_KEYS = {'schema', 'id', 'requestSha256', 'bootId', 'unit', 'invocationId',
               'supervisorProcessId', 'supervisorStartTime', 'workerSha256',
               'supervisorSha256', 'workerLeaf'}
TERMINAL_KEYS = {'schema', 'id', 'requestSha256', 'supervisorSha256', 'bootId',
                 'unit', 'invocationId', 'supervisorProcessId', 'workerProcessId',
                 'workerExitCode', 'workerLeaf', 'claimSha256', 'settledSha256',
                 'workerQuiescent', 'state', 'failureClass'}


class SupervisionError(ValueError):
    pass


def _positive(value):
    return type(value) is int and value > 0


def _unit(admission):
    return 'orbis-core-capture-' + admission.point + '.service'


def _leaf(admission):
    return '/system.slice/' + _unit(admission) + '/worker'


def _event(admission, kind, **fields):
    return {'schema': 'orbis.core-capture-' + kind + '.v2', 'id': admission.point,
            'requestSha256': admission.request_sha256, **fields}


def _worker(admission, worker):
    result = worker if worker is not None else getattr(admission, 'worker', None)
    if result is None:
        raise SupervisionError('The admitting worker must be injected')
    return result


def source_hash(worker):
    with worker.A.protected_directory(SUPERVISOR.parent, private=False) as parent:
        with worker.A.protected_file(parent, SUPERVISOR.name, 2 * 1024 * 1024, private=False) as body:
            return worker.digest(body)


def _argv(script, admission):
    return ['/usr/bin/python3', '-B', str(script), 'run', admission.point,
            '--state-dir', str(admission.state)]


class Leaf:
    """Pins both the delegated directory and its kernel event file."""
    def __init__(self, runtime, path, *, create=False):
        self.runtime, self.path = runtime, path
        self.directory = self.events = None
        mount = runtime.mount()
        directory = os.open(CGROUP, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            details = os.fstat(directory)
            if (os.major(details.st_dev), os.minor(details.st_dev)) != mount:
                raise SupervisionError('The opened directory is not the cgroup v2 mount')
            for name in path.strip('/').split('/'):
                if name == 'worker' and create:
                    os.mkdir(name, 0o755, dir_fd=directory)
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                dir_fd=directory)
                os.close(directory)
                directory = child
                details = os.fstat(directory)
                if details.st_uid != 0 or stat.S_IMODE(details.st_mode) & 0o022:
                    raise SupervisionError('The delegated cgroup is not root controlled')
            self.directory, directory = directory, None
            details = os.fstat(self.directory)
            self.binding = {'path': path, 'device': details.st_dev, 'inode': details.st_ino}
            self.events = os.open('cgroup.events', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                  dir_fd=self.directory)
            self.event_identity = self._identity(os.fstat(self.events))
            self.verify()
        except BaseException:
            self.close()
            raise
        finally:
            if directory is not None:
                os.close(directory)

    @staticmethod
    def _identity(details):
        return details.st_dev, details.st_ino

    def verify(self):
        mount = self.runtime.mount()
        fresh = LeafDirectory(self.path, mount)
        try:
            if self._identity(os.fstat(fresh.descriptor)) != (self.binding['device'], self.binding['inode']):
                raise SupervisionError('The delegated cgroup identity changed')
            if (self._identity(os.fstat(self.directory)) != (self.binding['device'], self.binding['inode'])
                    or self._identity(os.fstat(self.events)) != self.event_identity
                    or self._identity(os.stat('cgroup.events', dir_fd=self.directory, follow_symlinks=False))
                    != self.event_identity):
                raise SupervisionError('The pinned kernel observation changed')
        finally:
            fresh.close()

    def empty(self):
        self.verify()
        os.lseek(self.events, 0, os.SEEK_SET)
        data = os.read(self.events, 4097)
        if not data or len(data) > 4096:
            raise SupervisionError('The kernel population observation is unavailable')
        try:
            pairs = [line.split() for line in data.decode('ascii').splitlines()]
            if (any(len(pair) != 2 or not re.fullmatch('[a-z_]+', pair[0])
                    or not re.fullmatch('[0-9]+', pair[1]) for pair in pairs)
                    or len({pair[0] for pair in pairs}) != len(pairs)):
                raise ValueError()
            values = dict(pairs)
            if values.get('populated') not in {'0', '1'}:
                raise ValueError()
        except (UnicodeError, ValueError):
            raise SupervisionError('Invalid kernel population observation') from None
        self.verify()
        return values['populated'] == '0'

    def enter(self, pid):
        self.verify()
        if pid != os.getpid():
            raise SupervisionError('A worker may only move itself')
        descriptor = os.open('cgroup.procs', os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                             dir_fd=self.directory)
        try:
            body = str(pid).encode('ascii') + b'\n'
            if os.write(descriptor, body) != len(body):
                raise SupervisionError('The worker cgroup move was incomplete')
        finally:
            os.close(descriptor)
        self.verify()

    def close(self):
        for name in ('events', 'directory'):
            descriptor = getattr(self, name, None)
            if descriptor is not None:
                os.close(descriptor)
                setattr(self, name, None)


class LeafDirectory:
    def __init__(self, path, mount):
        self.descriptor = os.open(CGROUP, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            details = os.fstat(self.descriptor)
            if (os.major(details.st_dev), os.minor(details.st_dev)) != mount:
                raise SupervisionError('The reopened directory is not the cgroup v2 mount')
            for name in path.strip('/').split('/'):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                dir_fd=self.descriptor)
                os.close(self.descriptor)
                self.descriptor = child
                details = os.fstat(child)
                if details.st_uid != 0 or stat.S_IMODE(details.st_mode) & 0o022:
                    raise SupervisionError('The delegated cgroup is not root controlled')
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.descriptor is not None:
            os.close(self.descriptor)
            self.descriptor = None


class Runtime:
    """Linux observations; tests replace this boundary, never the receipts."""
    def supported(self):
        if sys.platform != 'linux' or os.geteuid() != 0:
            raise SupervisionError('Delegated capture requires Linux root and cgroup v2')
        self.mount()

    def mount(self):
        candidates = []
        for line in Path('/proc/self/mountinfo').read_text().splitlines():
            fields = line.split()
            if len(fields) < 10 or '-' not in fields:
                raise SupervisionError('Invalid kernel mount observation')
            separator = fields.index('-')
            if fields[4] == str(CGROUP):
                candidates.append((fields, separator))
        if (len(candidates) != 1 or candidates[0][0][3] != '/'
                or candidates[0][0][candidates[0][1] + 1] != 'cgroup2'):
            raise SupervisionError('A unified cgroup v2 mount is required')
        # A second mount under the unit could hide a different hierarchy.
        if any(line.split()[4].startswith(str(CGROUP) + '/')
               for line in Path('/proc/self/mountinfo').read_text().splitlines()):
            raise SupervisionError('Nested cgroup mounts are unsupported')
        device = candidates[0][0][2].split(':')
        if len(device) != 2 or any(not value.isdigit() for value in device):
            raise SupervisionError('Invalid cgroup mount device identity')
        return tuple(int(value) for value in device)

    def boot(self):
        value = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        if not BOOT.fullmatch(value):
            raise SupervisionError('The kernel boot identity is unavailable')
        return value

    def process(self, pid):
        directory = Path('/proc') / str(pid)
        before = (directory / 'stat').read_text()
        suffix = before[before.rfind(')') + 2:].split()
        if len(suffix) < 20 or not suffix[1].isdigit() or not suffix[19].isdigit():
            raise SupervisionError('Invalid process identity observation')
        command = (directory / 'cmdline').read_bytes()
        environment = (directory / 'environ').read_bytes().split(b'\0')
        invocations = [item.split(b'=', 1)[1].decode('ascii') for item in environment
                       if item.startswith(b'INVOCATION_ID=')]
        membership = (directory / 'cgroup').read_text().splitlines()
        executable = os.readlink(directory / 'exe')
        if (directory / 'stat').read_text() != before:
            # CPU counters change while a process runs; only identity fields matter.
            after = (directory / 'stat').read_text()
            after_suffix = after[after.rfind(')') + 2:].split()
            if len(after_suffix) < 20 or (suffix[1], suffix[19]) != (after_suffix[1], after_suffix[19]):
                raise SupervisionError('The observed process identity changed')
        if (not command.endswith(b'\0') or len(invocations) != 1 or len(membership) != 1
                or not membership[0].startswith('0::/')):
            raise SupervisionError('The process is outside delegated supervision')
        return {'pid': pid, 'parent': int(suffix[1]), 'startTime': int(suffix[19]),
                'argv': command[:-1].split(b'\0'), 'executable': executable,
                'invocationId': invocations[0], 'cgroup': membership[0][3:]}

    def unit(self, unit):
        fields = ('InvocationID', 'MainPID', 'Type', 'Restart', 'RemainAfterExit', 'KillMode',
                  'Delegate', 'ControlGroup', 'ActiveState', 'SubState')
        result = subprocess.run(['/usr/bin/systemctl', 'show', unit, '--no-pager',
                                 '--property=' + ','.join(fields)], capture_output=True, timeout=5, check=False)
        if result.returncode or len(result.stdout) > 8192:
            raise SupervisionError('The supervising unit is unavailable')
        try:
            pairs = [line.split('=', 1) for line in result.stdout.decode('ascii').splitlines()]
            if any(len(pair) != 2 for pair in pairs) or len({pair[0] for pair in pairs}) != len(pairs):
                raise ValueError()
            values = dict(pairs)
            if set(values) != set(fields):
                raise ValueError()
            return values
        except (UnicodeError, ValueError):
            raise SupervisionError('Invalid supervising unit observation') from None

    def pin(self, path, *, create=False):
        return Leaf(self, path, create=create)

    def spawn(self, command):
        return subprocess.Popen(command, close_fds=True)

    def wait(self, child):
        # Popen.wait may synthesize exit zero on ECHILD. Only a returned kernel
        # status for this exact child can establish its observed terminal exit.
        while True:
            try:
                pid, status = os.waitpid(child.pid, 0)
                break
            except InterruptedError:
                continue
        if pid != child.pid:
            raise SupervisionError('The kernel wait returned a different process')
        code = os.waitstatus_to_exitcode(status)
        child.returncode = code
        return code


def _execution(runtime, pid, script, admission, invocation, cgroup):
    process = runtime.process(pid)
    if (process['pid'] != pid or process['argv'] != [os.fsencode(value) for value in _argv(script, admission)]
            or process['executable'] != str(Path('/usr/bin/python3').resolve(strict=True))
            or process['invocationId'] != invocation or process['cgroup'] != cgroup
            or not _positive(process['startTime'])):
        raise SupervisionError('The process execution frame differs from admission')
    return process


def _supervising_unit(runtime, record):
    expected = {'InvocationID': record['invocationId'], 'MainPID': str(record['supervisorProcessId']),
                'Type': 'exec', 'Restart': 'no', 'RemainAfterExit': 'yes', 'KillMode': 'control-group',
                'Delegate': 'yes', 'ControlGroup': '/system.slice/' + record['unit'],
                'ActiveState': 'active', 'SubState': 'running'}
    if runtime.unit(record['unit']) != expected:
        raise SupervisionError('The supervising invocation changed')


def _validate_launch(admission, worker, *, worker_sha=None, supervisor_sha=None):
    launch, _ = admission.read('launch-intent.json')
    expected = {'schema': 'orbis.core-capture-launch-intent.v1', 'id': admission.point,
                'requestSha256': admission.request_sha256,
                'workerSha256': worker_sha if worker_sha is not None else worker.worker_hash(),
                'unit': 'orbis-core-capture-' + admission.point, 'supervisionProtocol': 2,
                'supervisorSha256': supervisor_sha if supervisor_sha is not None else source_hash(worker)}
    if launch != expected or type(launch.get('supervisionProtocol')) is not int:
        raise SupervisionError('The delegated launch intent changed')


def _validate_record(admission, record, worker, runtime):
    if (not isinstance(record, dict) or set(record) != RECORD_KEYS
            or record['schema'] != 'orbis.core-capture-supervisor.v2'
            or record['id'] != admission.point or record['requestSha256'] != admission.request_sha256
            or record['unit'] != _unit(admission) or not isinstance(record['invocationId'], str)
            or not INVOCATION.fullmatch(record['invocationId']) or not isinstance(record['bootId'], str)
            or not BOOT.fullmatch(record['bootId']) or record['bootId'] != runtime.boot()
            or not _positive(record['supervisorProcessId']) or not _positive(record['supervisorStartTime'])
            or record['workerSha256'] != worker.worker_hash() or record['supervisorSha256'] != source_hash(worker)):
        raise SupervisionError('The immutable supervisor binding changed')
    leaf = record['workerLeaf']
    if (not isinstance(leaf, dict) or set(leaf) != {'path', 'device', 'inode'}
            or leaf['path'] != _leaf(admission) or type(leaf['device']) is not int or leaf['device'] < 0
            or not _positive(leaf['inode'])):
        raise SupervisionError('Invalid delegated worker leaf binding')
    _validate_launch(admission, worker, worker_sha=record['workerSha256'],
                     supervisor_sha=record['supervisorSha256'])


def _frame(record, process):
    return {'version': 2, 'unit': record['unit'], 'invocationId': record['invocationId'],
            'processId': process['pid'], 'processStartTime': process['startTime'],
            'parentProcessId': record['supervisorProcessId'], 'parentStartTime': record['supervisorStartTime'],
            'bootId': record['bootId'], 'workerLeaf': record['workerLeaf']}


def _validate_frame(record, frame, *, pid=None):
    if (not isinstance(frame, dict) or set(frame) != FRAME_KEYS or type(frame['version']) is not int
            or frame['version'] != 2 or not _positive(frame['processId']) or not _positive(frame['processStartTime'])
            or frame['processId'] == record['supervisorProcessId']
            or (pid is not None and frame['processId'] != pid)
            or frame != _frame(record, {'pid': frame['processId'], 'startTime': frame['processStartTime']})):
        raise SupervisionError('The worker claim differs from delegated supervision')


def _parent(runtime, admission, record):
    _supervising_unit(runtime, record)
    process = _execution(runtime, record['supervisorProcessId'], SUPERVISOR, admission,
                         record['invocationId'], '/system.slice/' + record['unit'])
    if process['startTime'] != record['supervisorStartTime']:
        raise SupervisionError('The supervising parent process changed')
    return process


def validate_frame(admission, frame, *, worker=None, runtime=None):
    """Validate saved execution bindings without asserting a live worker exists."""
    worker, runtime = _worker(admission, worker), runtime or Runtime()
    runtime.supported()
    record, body = admission.read('supervisor.json')
    _validate_record(admission, record, worker, runtime)
    _validate_frame(record, frame)
    if admission.read('supervisor.json')[1] != body:
        raise SupervisionError('The supervisor binding changed while reading')
    admission.unchanged()
    return frame


def enter_worker(admission, *, worker=None, runtime=None):
    """Validate the real parent and move only this child, before claim/mutation."""
    worker, runtime = _worker(admission, worker), runtime or Runtime()
    runtime.supported()
    record, _ = admission.read('supervisor.json')
    _validate_record(admission, record, worker, runtime)
    _parent(runtime, admission, record)
    pid = os.getpid()
    process = _execution(runtime, pid, worker.WORKER, admission, record['invocationId'],
                         '/system.slice/' + record['unit'])
    if process['parent'] != record['supervisorProcessId']:
        raise SupervisionError('The worker is not the supervising process child')
    leaf = runtime.pin(_leaf(admission))
    try:
        if leaf.binding != record['workerLeaf']:
            raise SupervisionError('The admitted worker leaf changed')
        admission.unchanged()
        leaf.enter(pid)
        frame = _frame(record, process)
        verify_worker(admission, frame, worker=worker, runtime=runtime)
        return frame
    finally:
        leaf.close()


def verify_worker(admission, frame, *, worker=None, runtime=None):
    """Execution identity only; it never establishes terminal quiescence."""
    worker, runtime = _worker(admission, worker), runtime or Runtime()
    runtime.supported()
    record, _ = admission.read('supervisor.json')
    _validate_record(admission, record, worker, runtime)
    _validate_frame(record, frame, pid=os.getpid())
    _parent(runtime, admission, record)
    process = _execution(runtime, os.getpid(), worker.WORKER, admission, record['invocationId'], _leaf(admission))
    if process['parent'] != record['supervisorProcessId'] or process['startTime'] != frame['processStartTime']:
        raise SupervisionError('The worker parent or process identity changed')
    leaf = runtime.pin(_leaf(admission))
    try:
        if leaf.binding != record['workerLeaf']:
            raise SupervisionError('The admitted worker leaf changed')
        leaf.verify()
        admission.unchanged()
    finally:
        leaf.close()


def observe_worker(admission, frame, *, worker=None, runtime=None):
    """Observe this live child from root; this grants no terminal authority."""
    worker, runtime = _worker(admission, worker), runtime or Runtime()
    runtime.supported()
    record, _ = admission.read('supervisor.json')
    _validate_record(admission, record, worker, runtime)
    _validate_frame(record, frame)
    _parent(runtime, admission, record)
    process = _execution(runtime, frame['processId'], worker.WORKER, admission,
                         record['invocationId'], _leaf(admission))
    if process['parent'] != record['supervisorProcessId'] or process['startTime'] != frame['processStartTime']:
        raise SupervisionError('The observed worker process identity changed')
    leaf = runtime.pin(_leaf(admission))
    try:
        if leaf.binding != record['workerLeaf']:
            raise SupervisionError('The observed worker leaf changed')
        leaf.verify()
        admission.unchanged()
        return frame
    finally:
        leaf.close()


def _receipts(admission, record, worker, *, pid):
    claim, claim_body = admission.read('claim.json', optional=True)
    settled, settled_body = admission.read('settled.json', optional=True)
    if claim is not None:
        frame = claim.get('supervision')
        _validate_frame(record, frame, pid=pid)
        expected = {'schema': 'orbis.core-capture-claim.v1', 'id': admission.point,
                    'requestSha256': admission.request_sha256, 'workerSha256': record['workerSha256'],
                    'supervision': frame}
        if claim != expected:
            raise SupervisionError('The consumed worker claim changed')
    return claim, settled, (worker.digest(claim_body) if claim_body is not None else None), \
        (worker.digest(settled_body) if settled_body is not None else None)


def run_supervisor(worker, state_dir, point, *, runtime=None):
    """One attempt, one real child wait, one pinned kernel population witness."""
    runtime = runtime or Runtime()
    runtime.supported()
    worker.require_root()
    admission = worker.Admission(state_dir, point)
    _validate_launch(admission, worker)
    for name in ('supervisor.json', 'claim.json', 'settled.json', 'failure.json', 'worker-terminal.json'):
        if admission.read(name, optional=True)[0] is not None:
            raise SupervisionError('Existing or partial attempts cannot be replayed')
    invocation = os.environ.get('INVOCATION_ID', '')
    if not INVOCATION.fullmatch(invocation):
        raise SupervisionError('A systemd invocation identity is required')
    process = _execution(runtime, os.getpid(), SUPERVISOR, admission, invocation, '/system.slice/' + _unit(admission))
    record = _event(admission, 'supervisor', bootId=runtime.boot(), unit=_unit(admission), invocationId=invocation,
                    supervisorProcessId=os.getpid(), supervisorStartTime=process['startTime'],
                    workerSha256=worker.worker_hash(), supervisorSha256=source_hash(worker),
                    workerLeaf={'path': _leaf(admission), 'device': 0, 'inode': 1})
    _supervising_unit(runtime, record)
    leaf = runtime.pin(_leaf(admission), create=True)
    try:
        record['workerLeaf'] = leaf.binding
        _validate_record(admission, record, worker, runtime)
        if not leaf.empty():
            raise SupervisionError('The newly delegated worker leaf is populated')
        admission.create('supervisor.json', record)
        _, supervisor_body = admission.read('supervisor.json')
        child, exit_code, quiescent, failure = None, None, False, None
        claim_hash = settled_hash = None
        try:
            _parent(runtime, admission, record)
            child = runtime.spawn(_argv(worker.WORKER, admission))
            if not _positive(child.pid) or child.pid == record['supervisorProcessId']:
                raise SupervisionError('Invalid spawned worker identity')
            exit_code = runtime.wait(child)
            if type(exit_code) is not int:
                raise SupervisionError('The worker wait did not return an exit status')
            _validate_record(admission, record, worker, runtime)
            _parent(runtime, admission, record)
            if leaf.binding != record['workerLeaf'] or not leaf.empty():
                raise SupervisionError('The worker leaf still contains descendants')
            claim, settled, claim_hash, settled_hash = _receipts(admission, record, worker, pid=child.pid)
            # Capture success and observed quiescence are separate facts. An
            # unsuccessful child can still have a trustworthy empty-leaf witness.
            try:
                if exit_code != 0 or claim is None or settled is None:
                    raise SupervisionError('The worker has no successful settled exit')
                status = worker.read_status(admission.state, admission.point)
                if (status.get('id') != admission.point or status.get('state') != 'resumed-awaiting-publication'
                        or not isinstance(status.get('artifact'), dict)):
                    raise SupervisionError('The worker has no validated settled artifact')
            except BaseException as error:
                failure = type(error).__name__
            if _receipts(admission, record, worker, pid=child.pid)[2:] != (claim_hash, settled_hash):
                raise SupervisionError('The worker receipts changed after validation')
            _validate_record(admission, record, worker, runtime)
            _parent(runtime, admission, record)
            if not leaf.empty():
                raise SupervisionError('The worker leaf population changed')
            quiescent = True
        except BaseException as error:
            failure = type(error).__name__
            # Contradictory or unavailable identity/population evidence fails closed.
            quiescent = False
            try:
                _, _, claim_hash, settled_hash = _receipts(admission, record, worker,
                                                         pid=child.pid if child is not None else None)
            except BaseException:
                claim_hash = settled_hash = None
        terminal = _event(admission, 'worker-terminal', supervisorSha256=worker.digest(supervisor_body),
                          bootId=record['bootId'], unit=record['unit'], invocationId=record['invocationId'],
                          supervisorProcessId=record['supervisorProcessId'],
                          workerProcessId=child.pid if child is not None else None, workerExitCode=exit_code,
                          workerLeaf=record['workerLeaf'], claimSha256=claim_hash, settledSha256=settled_hash,
                          workerQuiescent=quiescent, state='quiescent' if failure is None else 'recovery-required',
                          failureClass=failure)
        admission.create('worker-terminal.json', terminal)
        return terminal
    finally:
        leaf.close()


def read_terminal(admission, *, worker=None, runtime=None):
    """Read the immutable witness. This receipt grants no finalization authority."""
    worker, runtime = _worker(admission, worker), runtime or Runtime()
    runtime.supported()
    admission.unchanged()
    record, supervisor_body = admission.read('supervisor.json')
    _validate_record(admission, record, worker, runtime)
    terminal, body = admission.read('worker-terminal.json', optional=True)
    if terminal is None:
        return None
    if (not isinstance(terminal, dict) or set(terminal) != TERMINAL_KEYS
            or terminal['schema'] != 'orbis.core-capture-worker-terminal.v2'
            or terminal['id'] != admission.point or terminal['requestSha256'] != admission.request_sha256
            or terminal['supervisorSha256'] != worker.digest(supervisor_body)
            or any(terminal[key] != record[key] for key in
                   ('bootId', 'unit', 'invocationId', 'supervisorProcessId', 'workerLeaf'))
            or (terminal['workerProcessId'] is not None and
                (not _positive(terminal['workerProcessId'])
                 or terminal['workerProcessId'] == record['supervisorProcessId']))
            or (terminal['workerExitCode'] is not None and type(terminal['workerExitCode']) is not int)
            or type(terminal['workerQuiescent']) is not bool
            or terminal['state'] not in {'quiescent', 'recovery-required'}
            or (terminal['failureClass'] is not None and
                (not isinstance(terminal['failureClass'], str) or not re.fullmatch('[A-Za-z_][A-Za-z_0-9]{0,127}',
                                                                               terminal['failureClass'])))
            or (terminal['workerQuiescent'] and (terminal['workerProcessId'] is None
                                                or terminal['workerExitCode'] is None))):
        raise SupervisionError('Invalid immutable worker terminal witness')
    claim, settled, claim_hash, settled_hash = _receipts(admission, record, worker,
                                                       pid=terminal['workerProcessId'])
    if (claim_hash, settled_hash) != (terminal['claimSha256'], terminal['settledSha256']):
        raise SupervisionError('The terminal worker receipts changed')
    if terminal['state'] == 'quiescent':
        if (terminal['failureClass'] is not None or terminal['workerExitCode'] != 0
                or not terminal['workerQuiescent'] or claim is None or settled is None):
            raise SupervisionError('The terminal worker witness is not successful')
        status = worker.read_status(admission.state, admission.point)
        if (status.get('id') != admission.point or status.get('state') != 'resumed-awaiting-publication'
                or not isinstance(status.get('artifact'), dict)):
            raise SupervisionError('The terminal worker artifact is invalid')
    elif terminal['failureClass'] is None:
        raise SupervisionError('A failed witness must preserve its failure')
    if admission.read('worker-terminal.json')[1] != body or admission.read('supervisor.json')[1] != supervisor_body:
        raise SupervisionError('The terminal authority changed while reading')
    _receipts(admission, record, worker, pid=terminal['workerProcessId'])
    admission.unchanged()
    return terminal


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('run',))
    parser.add_argument('point')
    parser.add_argument('--state-dir', required=True)
    arguments = parser.parse_args()
    try:
        # Import only in the CLI: production integrations inject their own worker.
        spec = importlib.util.spec_from_file_location('orbis_supervised_capture_worker',
                                                      SUPERVISOR.with_name('orbis-host-core-capture-worker.py'))
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
        result = run_supervisor(worker, arguments.state_dir, arguments.point)
        if result['state'] != 'quiescent':
            return 1
        spec = importlib.util.spec_from_file_location('orbis_auto_publication',
            SUPERVISOR.with_name('orbis-host-sentinel-auto-publication.py'))
        auto = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(auto)
        publication = auto.publish_after_terminal(worker, arguments.state_dir, arguments.point, result)
        return 0 if publication['state'] in {'skipped', 'verified'} else 1
    except BaseException as error:
        print(type(error).__name__, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
