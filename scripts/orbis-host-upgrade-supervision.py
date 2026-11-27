"""Fresh systemd/process/source binding for the independent upgrade executor.

This reader never launches a unit, grants a version override, or repairs a job.
The accepting Host and verified executor separately own admission publication.
An immutable journal or caller PID cannot replace these live kernel checks.
"""
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

PYTHON = Path('/usr/bin/python3')
UNITS = Path('/etc/systemd/system')
HASH = re.compile(r'[a-f0-9]{64}\Z')
INVOCATION = re.compile(r'[a-f0-9]{32}\Z')
UUID4 = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\Z')
BOOT = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')
PROPERTIES = ('LoadState', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload', 'Type', 'Restart',
              'RemainAfterExit', 'KillMode', 'User', 'Group', 'ControlGroup', 'ActiveState', 'SubState',
              'MainPID', 'ControlPID', 'InvocationID', 'Job')


class UpgradeSupervisionError(ValueError):
    def __init__(self):
        super().__init__('The independent upgrade execution requires reconciliation; preserve its custody.')


def require(value):
    if not value:
        raise UpgradeSupervisionError()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode('ascii')


def sha(body):
    return hashlib.sha256(body).hexdigest()


def path(value):
    require(type(value) is str and value.startswith('/') and value == os.path.normpath(value)
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))
    return Path(value)


def quote(value):
    value = str(value)
    require(not any(ord(char) < 32 or ord(char) == 127 for char in value))
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'


def unit_name(operation):
    require(type(operation) is str and UUID4.fullmatch(operation))
    return 'orbis-upgrade-' + operation + '.service'


def reconciliation_unit_name(operation):
    unit_name(operation)
    return 'orbis-upgrade-reconcile-' + operation + '.service'


def operation_directory(state_directory, operation):
    unit_name(operation)
    return path(str(state_directory)) / 'component-upgrades' / operation


def launcher_argv(state_directory, operation, *, reconciling=False):
    require(type(reconciling) is bool)
    directory = operation_directory(state_directory, operation)
    return [str(PYTHON), '-I', '-B', str(directory / 'bootstrap/scripts/orbis-host-upgrade-launcher.py'),
            'reconcile' if reconciling else 'run', operation, '--state-dir', str(state_directory)]


def unit_body(state_directory, operation, *, reconciling=False):
    require(type(reconciling) is bool)
    command = ' '.join(quote(item) for item in launcher_argv(state_directory, operation, reconciling=reconciling))
    return (f'[Unit]\nDescription=Orbis coordinated upgrade {operation}\nAfter=docker.service\nRequires=docker.service\n\n'
            '[Service]\nType=exec\nUser=root\nGroup=root\nRestart=no\nRemainAfterExit=no\nKillMode=control-group\n'
            'NoNewPrivileges=yes\nUMask=0077\nRuntimeDirectory=orbis-upgrade\nRuntimeDirectoryMode=0755\n'
            'Environment="PATH=/usr/sbin:/usr/bin:/sbin:/bin" "PYTHONDONTWRITEBYTECODE=1"\n'
            'UnsetEnvironment=PYTHONPATH PYTHONHOME LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV\n'
            f'ExecStart={command}\n\n[Install]\nWantedBy=multi-user.target\n').encode('utf-8')


def executor_argv(state_directory, operation, selection_sha, request_sha, channel):
    require(type(selection_sha) is str and HASH.fullmatch(selection_sha)
            and type(request_sha) is str and HASH.fullmatch(request_sha) and channel in ('stable', 'nightly'))
    selected = operation_directory(state_directory, operation) / 'selection'
    return [str(PYTHON), str(selected / 'scripts/orbis-install.py'), '--manifest', str(selected / 'release-manifest.json'),
            '--state-dir', str(selected / 'transactions'), '--channel', channel,
            '--installer-custody-sha256', selection_sha, '--coordinated-upgrade', operation,
            '--coordinated-request-sha256', request_sha]


class Runtime:
    """All observations below are read from Linux, never supplied by a request."""
    def supported(self):
        require(sys.platform == 'linux' and os.getuid() == os.geteuid() == 0)
        require(self.read(Path('/proc/1/comm'), 64).strip() == b'systemd')

    def read(self, location, limit):
        descriptor = os.open(location, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            body = bytearray()
            while len(body) <= limit:
                chunk = os.read(descriptor, min(16384, limit + 1 - len(body)))
                if not chunk:
                    break
                body.extend(chunk)
            require(0 < len(body) <= limit)
            return bytes(body)
        finally:
            os.close(descriptor)

    def boot(self):
        value = self.read(Path('/proc/sys/kernel/random/boot_id'), 64).decode('ascii').strip()
        require(BOOT.fullmatch(value))
        return value

    def generation_gone(self, frame, current_boot):
        if frame['bootId'] != current_boot:
            return True
        try:
            body = self.read(Path('/proc') / str(frame['pid']) / 'stat', 8192).decode('ascii')
        except FileNotFoundError:
            return True
        prefix, separator, suffix = body.rpartition(') ')
        fields = suffix.split()
        require(separator and prefix.startswith(str(frame['pid']) + ' (') and len(fields) >= 20
                and fields[19].isdecimal() and int(fields[19]) > 0)
        return int(fields[19]) != frame['startTime']

    def cgroup_empty(self, name):
        require(re.fullmatch(r'orbis-upgrade-(?:reconcile-)?[a-f0-9-]{36}\.service', name))
        group = Path('/sys/fs/cgroup/system.slice') / name
        try:
            # The populated flag includes descendants in nested cgroups.
            body = self.read(group / 'cgroup.events', 4096)
        except FileNotFoundError:
            try:
                group.lstat()
            except FileNotFoundError:
                return True
            return False
        return [line for line in body.splitlines() if line.startswith(b'populated ')] == [b'populated 0']

    def process(self, pid):
        require(type(pid) is int and 1 < pid < 2**31)
        directory = Path('/proc') / str(pid)
        def identity():
            body = self.read(directory / 'stat', 8192).decode('ascii')
            prefix, separator, suffix = body.rpartition(') ')
            require(separator and prefix.startswith(str(pid) + ' ('))
            fields = suffix.split()
            require(len(fields) >= 20 and fields[1].isdecimal() and fields[19].isdecimal()
                    and int(fields[19]) > 0)
            return int(fields[1]), int(fields[19])
        parent, start = identity()
        command = self.read(directory / 'cmdline', 131072)
        environment = self.read(directory / 'environ', 131072).split(b'\0')
        invocation = [value[14:].decode('ascii') for value in environment if value.startswith(b'INVOCATION_ID=')]
        membership = self.read(directory / 'cgroup', 8192).decode('ascii').splitlines()
        executable = os.readlink(directory / 'exe')
        require(command.endswith(b'\0') and len(invocation) == 1 and INVOCATION.fullmatch(invocation[0])
                and len(membership) == 1 and membership[0].startswith('0::/')
                and identity() == (parent, start))
        return {'pid': pid, 'parent': parent, 'startTime': start, 'argv': command[:-1].split(b'\0'),
                'executable': executable, 'invocationId': invocation[0], 'cgroup': membership[0][3:]}

    def unit(self, name):
        try:
            result = subprocess.run(['/usr/bin/systemctl', 'show', name, '--no-pager',
                                     '--property=' + ','.join(PROPERTIES)], capture_output=True, timeout=5,
                                    check=False, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
        except subprocess.TimeoutExpired as error:
            raise UpgradeSupervisionError() from error
        require(result.returncode == 0 and 0 < len(result.stdout) <= 8192)
        pairs = [line.split('=', 1) for line in result.stdout.decode('ascii').splitlines()]
        require(all(len(pair) == 2 for pair in pairs) and len({pair[0] for pair in pairs}) == len(pairs))
        values = dict(pairs)
        require(set(values) == set(PROPERTIES))
        return values


def observe_invocation(authority, state_directory, operation, expected_argv, *, runtime=None, current=False,
                       reconciling=False):
    """Observe a fixed unit's real process, including from the Host reader."""
    runtime = Runtime() if runtime is None else runtime
    runtime.supported()
    require(type(reconciling) is bool)
    name = reconciliation_unit_name(operation) if reconciling else unit_name(operation)
    require(expected_argv == launcher_argv(state_directory, operation, reconciling=reconciling))
    with ExitStack() as resources:
        directory = resources.enter_context(authority.protected_directory(UNITS, private=False))
        body = resources.enter_context(authority.protected_file(directory, name, 16384, private=False))
        require(body == unit_body(state_directory, operation, reconciling=reconciling))
        interpreter = PYTHON.resolve(strict=True)
        folder = resources.enter_context(authority.protected_directory(interpreter.parent, private=False))
        resources.enter_context(authority.protected_file(folder, interpreter.name, 64 * 1024 * 1024,
                                                         private=False, digest_only=True))
        details = interpreter.lstat()
        require(stat.S_ISREG(details.st_mode) and details.st_uid == 0 and details.st_mode & 0o111
                and not details.st_mode & 0o7022)
        unit = runtime.unit(name)
        value = unit['MainPID']
        require(value.isascii() and value.isdecimal() and str(int(value)) == value and int(value) > 1)
        pid = int(value)
        require(not current or pid == os.getpid())
        process, boot = runtime.process(pid), runtime.boot()
        cgroup = '/system.slice/' + name
        expected = {'LoadState': 'loaded', 'FragmentPath': str(UNITS / name), 'DropInPaths': '',
                    'NeedDaemonReload': 'no', 'Type': 'exec', 'Restart': 'no', 'RemainAfterExit': 'no',
                    'KillMode': 'control-group', 'User': 'root', 'Group': 'root', 'ControlGroup': cgroup,
                    'ActiveState': 'active', 'SubState': 'running', 'MainPID': str(pid),
                    'ControlPID': '0', 'InvocationID': process['invocationId']}
        require({key: value for key, value in unit.items() if key != 'Job'} == expected
                and process['pid'] == pid and process['parent'] == 1
                and process['argv'] == [os.fsencode(value) for value in expected_argv]
                and process['executable'] == str(interpreter) and process['cgroup'] == cgroup
                and type(process['startTime']) is int and process['startTime'] > 0
                and INVOCATION.fullmatch(process['invocationId']) and BOOT.fullmatch(boot))
        require(runtime.unit(name) == unit and runtime.process(pid) == process and runtime.boot() == boot)
        return {'bootId': boot, 'pid': pid, 'startTime': process['startTime'],
                'invocationId': process['invocationId'], 'unit': name, 'unitSha256': sha(body)}


def observe_quiescence(authority, state_directory, operation, original, *, runtime=None):
    """Prove the original generation and every member of its unit are gone.

    Before a worker claims the job, there is no recorded generation. Still
    require an empty unit cgroup and no pending or live activation.
    """
    runtime = Runtime() if runtime is None else runtime
    runtime.supported()
    name = unit_name(operation)
    require(original is None or type(original) is dict and set(original) == {
        'bootId', 'pid', 'startTime', 'invocationId', 'unit', 'unitSha256'}
        and type(original['pid']) is int and 1 < original['pid'] < 2**31
        and type(original['startTime']) is int and original['startTime'] > 0
        and BOOT.fullmatch(original['bootId']) and INVOCATION.fullmatch(original['invocationId'])
        and original['unit'] == name)
    with ExitStack() as resources:
        directory = resources.enter_context(authority.protected_directory(UNITS, private=False))
        try:
            body = resources.enter_context(authority.protected_file(directory, name, 16384, private=False))
        except FileNotFoundError:
            require(original is None)
            body = None
        if body is not None:
            require(body == unit_body(state_directory, operation)
                    and (original is None or original['unitSha256'] == sha(body)))
        unit, boot = runtime.unit(name), runtime.boot()
        require(not unit['Job'] and unit['MainPID'] == unit['ControlPID'] == '0' and runtime.cgroup_empty(name))
        if unit['LoadState'] == 'not-found':
            require(original is None)
            require(not unit['FragmentPath'] and not unit['DropInPaths']
                    and unit['ActiveState'] == 'inactive' and unit['SubState'] == 'dead'
                    and not unit['ControlGroup'] and not unit['InvocationID'])
        else:
            require(body is not None and unit['LoadState'] == 'loaded' and unit['FragmentPath'] == str(UNITS / name)
                    and unit['DropInPaths'] == '' and unit['NeedDaemonReload'] == 'no'
                    and unit['Type'] == 'exec' and unit['Restart'] == 'no' and unit['RemainAfterExit'] == 'no'
                    and unit['KillMode'] == 'control-group' and unit['User'] == unit['Group'] == 'root'
                    and unit['ActiveState'] in ('inactive', 'failed') and unit['SubState'] in ('dead', 'failed')
                    and unit['ControlGroup'] in ('', '/system.slice/' + name)
                    and (not unit['InvocationID'] or (
                        unit['InvocationID'] == original['invocationId'] if original else INVOCATION.fullmatch(unit['InvocationID'])))
                    and (original is None or runtime.generation_gone(original, boot)))
        require(runtime.unit(name) == unit and runtime.boot() == boot
                and (original is None or runtime.generation_gone(original, boot)) and runtime.cgroup_empty(name))
        return {'bootId': boot, 'original': dict(original) if original else None, 'quiescent': True}


class BoundSupervisor:
    """Pin the verified execution lease and the same real independent invocation.

    The target is the actual held TargetSet, not an HTTP observation or a JSON
    object. The accepting factory must additionally bind its durable intake and
    plan before giving this scope to the sequencing engine.
    """
    def __init__(self, authority, target, state_directory, operation, request_sha, channel, *, runtime=None):
        self.authority, self.target = authority, target
        self.state_directory = path(str(state_directory))
        self.operation, self.request_sha, self.channel = operation, request_sha, channel
        self.name = unit_name(operation)
        self.runtime = Runtime() if runtime is None else runtime
        self.frame = None
        self.verify()

    def verify(self):
        self.runtime.supported()
        self.target.verify()
        selected = self.target.manifest()
        require(selected['selectionDirectory'] == str(operation_directory(self.state_directory, self.operation) / 'selection'))
        selection = selected['sourceSelectionSha256']
        require(type(selected['sourceExecutionSha256']) is str and HASH.fullmatch(selected['sourceExecutionSha256']))
        expected_argv = executor_argv(self.state_directory, self.operation, selection, self.request_sha, self.channel)
        with ExitStack() as resources:
            directory = resources.enter_context(self.authority.protected_directory(UNITS, private=False))
            body = resources.enter_context(self.authority.protected_file(directory, self.name, 16384, private=False))
            require(body == unit_body(self.state_directory, self.operation))
            interpreter = PYTHON.resolve(strict=True)
            executable = resources.enter_context(self.authority.protected_directory(interpreter.parent, private=False))
            resources.enter_context(self.authority.protected_file(executable, interpreter.name, 64 * 1024 * 1024,
                                                                 private=False, digest_only=True))
            details = interpreter.lstat()
            require(stat.S_ISREG(details.st_mode) and details.st_uid == 0 and details.st_mode & 0o111
                    and not details.st_mode & 0o7022)
            unit = self.runtime.unit(self.name)
            require(unit['MainPID'].isascii() and unit['MainPID'].isdecimal()
                    and str(int(unit['MainPID'])) == unit['MainPID'] and int(unit['MainPID']) == os.getpid())
            process = self.runtime.process(os.getpid())
            boot = self.runtime.boot()
            cgroup = '/system.slice/' + self.name
            expected = {'LoadState': 'loaded', 'FragmentPath': str(UNITS / self.name), 'DropInPaths': '',
                        'NeedDaemonReload': 'no', 'Type': 'exec', 'Restart': 'no', 'RemainAfterExit': 'no',
                        'KillMode': 'control-group', 'User': 'root', 'Group': 'root', 'ControlGroup': cgroup,
                        'ActiveState': 'active', 'SubState': 'running', 'MainPID': str(os.getpid()),
                        'ControlPID': '0', 'InvocationID': process['invocationId']}
            require({key: value for key, value in unit.items() if key != 'Job'} == expected and process['pid'] == os.getpid()
                    and process['parent'] == 1
                    and process['argv'] == [os.fsencode(value) for value in expected_argv]
                    and process['executable'] == str(interpreter) and process['cgroup'] == cgroup
                    and type(process['startTime']) is int and process['startTime'] > 0
                    and INVOCATION.fullmatch(process['invocationId']) and BOOT.fullmatch(boot))
            frame = {'bootId': boot, 'pid': process['pid'], 'startTime': process['startTime'],
                     'invocationId': process['invocationId'], 'unit': self.name,
                     'unitSha256': sha(body), 'targetManifestSha256': self.target.sha256,
                     'sourceSelectionSha256': selection, 'sourceExecutionSha256': selected['sourceExecutionSha256']}
            require(self.frame is None or self.frame == frame)
            self.target.verify()
            require(self.runtime.unit(self.name) == unit and self.runtime.process(os.getpid()) == process
                    and self.runtime.boot() == boot)
            self.frame = frame
            return dict(frame)
