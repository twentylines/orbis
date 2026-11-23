"""Guarded, controller-only recovery for a replaced local Docker socket."""

import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import subprocess
import time
from contextlib import contextmanager


def _container_definition_module():
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location('orbis_container_definition', Path(__file__).with_name('orbis-container-definition.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CONTAINER_DEFINITION = _container_definition_module()

SOCKETS = ('/var/run/docker.sock', '/run/docker.sock')
INTERVAL = 30
COOLDOWN = 120
ATTEMPT_WINDOW = 60 * 60
MAX_ATTEMPTS_PER_WINDOW = 3
OBSERVATION_TIMEOUT = 15
RESTART_TIMEOUT = 55
HEALTH_TIMEOUT = 45
FAILURES = (OSError, ValueError, RuntimeError, TypeError, KeyError, AttributeError,
            subprocess.TimeoutExpired, http.client.HTTPException)


def require(condition):
    if not condition:
        raise ValueError('Docker socket recovery identity could not be verified')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def socket_identity(details):
    require(stat.S_ISSOCK(details.st_mode) and details.st_uid == 0 and not details.st_mode & 0o007)
    return details.st_dev, details.st_ino, details.st_ctime_ns, details.st_mode, details.st_gid


def read_text(path, limit):
    with path.open('rb') as source:
        body = source.read(limit + 1)
    require(len(body) <= limit)
    return body.decode('ascii')


def process_start(process):
    # comm can contain spaces and parentheses. starttime is field 22.
    fields = read_text(process / 'stat', 4096).rsplit(')', 1)[-1].split()
    require(len(fields) >= 20 and fields[19].isdigit() and fields[0] not in {'Z', 'X'})
    return fields[19]


def socket_probe(path, *, ping):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as transport:
        transport.settimeout(1)
        try:
            transport.connect(str(path))
        except ConnectionRefusedError:
            return 'refused'
        if not ping:
            return 'listening'
        peer = transport.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
        pid, uid, _ = struct.unpack('3i', peer)
        require(pid > 0 and uid == 0)
        transport.sendall(b'GET /_ping HTTP/1.0\r\nHost: localhost\r\n\r\n')
        with http.client.HTTPResponse(transport) as response:
            response.begin()
            require(response.status == 200 and response.read(3) == b'OK')
        return 'ready'


class LocalDocker:
    def __init__(self, service, resolve_socket):
        self.service = service
        self.host = service.HOST
        self.resolve_socket = resolve_socket

    @contextmanager
    def deadline(self, seconds):
        token = self.host.CAPTURE_READ_DEADLINE.set(time.monotonic() + seconds)
        try:
            yield
        finally:
            self.host.CAPTURE_READ_DEADLINE.reset(token)

    def command(self, args, *, local=True):
        # Same Root subprocess and inherited installation lock as other Host
        # lifecycle actions. Effects always address the fixed local socket.
        selector = ['--host', 'unix:///var/run/docker.sock'] if local else ['--context', self.service.context]
        return self.host.run(['/usr/bin/docker', *selector, *args], self.service.root)

    def value(self, args, *, local=True):
        result = self.command(args, local=local)
        require(result.returncode == 0 and len(result.stdout) <= 256 * 1024)
        return json.loads(result.stdout)

    def engine(self):
        require(os.geteuid() == 0 and not any(os.environ.get(key) for key in (
            'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_API_VERSION'
        )))
        endpoint = self.value(['context', 'inspect', self.service.context, '--format',
                               '{{json .Endpoints.docker.Host}}'], local=False)
        require(endpoint in ('unix:///var/run/docker.sock', 'unix:///run/docker.sock'))
        path = Path(endpoint.removeprefix('unix://'))
        parent = Path('/run').stat()
        require(parent.st_uid == 0 and stat.S_ISDIR(parent.st_mode) and not parent.st_mode & 0o022
                and path.parent.resolve(strict=True) == Path('/run'))
        before = socket_identity(path.lstat())
        require(before == socket_identity(Path(SOCKETS[0]).lstat()))
        require(socket_probe(path, ping=True) == 'ready')
        daemon, security = self.value(['info', '--format', '[{{json .ID}},{{json .SecurityOptions}}]'])
        require(isinstance(daemon, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9:_.-]{0,255}', daemon)
                and isinstance(security, list)
                and all(isinstance(item, str) and 'rootless' not in item for item in security))
        require(before == socket_identity(path.lstat()))
        return path, daemon, before

    def inspect(self, identifier):
        return self.value(['container', 'inspect', '--format', '{{json .}}', identifier])

    def controller(self, engine):
        raw = self.inspect('runtipi')
        state, config = raw['State'], raw['Config']
        labels, identifier = config['Labels'], raw['Id']
        require(raw['Name'] == '/runtipi' and re.fullmatch(r'[a-f0-9]{64}', identifier)
                and re.fullmatch(r'sha256:[a-f0-9]{64}', raw['Image'])
                and labels.get('com.docker.compose.project') == 'runtipi'
                and labels.get('com.docker.compose.service') == 'runtipi'
                and labels.get('com.docker.compose.project.working_dir') == str(self.service.root)
                and raw['HostConfig'].get('AutoRemove') is False
                and all(state.get(key) is False for key in ('Restarting', 'Paused', 'Dead')))
        if state.get('Running') is False and state.get('Status') in {'exited', 'created'}:
            return None
        docker_hosts = [value for value in config['Env'] if value.startswith('DOCKER_HOST=')]
        require(not docker_hosts or docker_hosts == ['DOCKER_HOST='] or docker_hosts == [
            'DOCKER_HOST=unix:///var/run/docker.sock'])
        pid, started, created = state['Pid'], state['StartedAt'], raw['Created']
        require(state.get('Running') is True and state.get('Status') == 'running'
                and type(pid) is int and pid > 1 and isinstance(started, str) and isinstance(created, str)
                and all(re.fullmatch(r'\d{4}-\d\d-\d\dT[0-9:.]+Z', stamp) for stamp in (started, created)))
        mounts = [item for item in raw['Mounts'] if item['Destination'] in SOCKETS]
        require(len(mounts) == 1)
        mount = mounts[0]
        require(mount['Destination'] == SOCKETS[0] and mount['Type'] == 'bind' and mount['RW'] is False
                and mount['Source'] in SOCKETS and socket_identity(Path(mount['Source']).lstat()) == engine[2])
        process = Path('/proc') / str(pid)
        process_generation = process_start(process)
        cgroup = read_text(process / 'cgroup', 65536)
        require(re.search(r'(?:/|:)(?:docker-)?' + identifier + r'(?:\.scope)?(?:/|\n|$)', cgroup))
        table = read_text(process / 'mountinfo', 4 * 1024 * 1024)
        fd = os.open(process / 'root', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            canonical, details = self.resolve_socket(fd, mount['Destination'])
            require(canonical in SOCKETS)
            bound = socket_identity(details)
            entries = [entry for entry in map(str.split, table.splitlines())
                       if len(entry) >= 10 and entry[4] == canonical]
            device = f'{os.major(details.st_dev)}:{os.minor(details.st_dev)}'
            require(len(entries) == 1 and entries[0][2] == device
                    and entries[0][3].removesuffix('//deleted').endswith('/docker.sock')
                    and 'ro' in entries[0][5].split(','))
            path = Path(f'/proc/self/fd/{fd}{canonical}')
            require(socket_identity(path.lstat()) == bound)
            fresh = bound[:2] == engine[2][:2]
            probe = socket_probe(path, ping=fresh)
            require(socket_identity(path.lstat()) == bound)
        finally:
            os.close(fd)
        require(process_start(process) == process_generation and read_text(process / 'cgroup', 65536) == cgroup
                and read_text(process / 'mountinfo', 4 * 1024 * 1024) == table)
        # A full immutable-ID read catches role replacement, PID reuse and
        # lifecycle transitions during the local descriptor observations.
        latest = self.inspect(identifier)
        immutable = ('Id', 'Name', 'Image', 'Created', 'Config', 'HostConfig', 'Mounts', 'Path', 'Args')
        require(CONTAINER_DEFINITION.normalize({key: latest[key] for key in immutable}) == CONTAINER_DEFINITION.normalize({key: raw[key] for key in immutable})
                and all(latest['State'][key] == state[key] for key in
                        ('Pid', 'StartedAt', 'Running', 'Status', 'Restarting', 'Paused', 'Dead')))
        return {
            'id': identifier, 'creation': digest(CONTAINER_DEFINITION.normalize({key: raw[key] for key in immutable})),
            'incarnation': (pid, started, process_generation, digest(table)),
            'socket': bound, 'binding': 'fresh' if fresh and probe == 'ready' else
            'stale' if not fresh and probe == 'refused' else 'unverified',
            'health': (latest['State'].get('Health') or {}).get('Status'),
            'image': raw['Image'], 'reference': config['Image'],
        }

    def enrollment(self, controller):
        manifest = self.service.current_manifest()
        reference = self.host.controller_reference(self.service.root, manifest, self.service.context)
        require(controller['reference'] == reference)
        image = self.value(['image', 'inspect', '--format', '{{json .}}', reference])
        require(image['Id'] == controller['image']
                and (reference == image['Id'] or reference in (image.get('RepoDigests') or [])))
        return digest(manifest)

    def restart(self, identifier, engine):
        require(re.fullmatch(r'[a-f0-9]{64}', identifier)
                and socket_identity(Path(SOCKETS[0]).lstat()) == engine[2])
        result = self.command(['container', 'restart', '--time', '30', identifier])
        require(result.returncode == 0 and result.stdout.strip() == identifier)


class Recovery:
    def __init__(self, service, docker, package_locks, read_record, write_record, boot_id,
                 *, clock=time.monotonic):
        self.service, self.docker, self.package_locks = service, docker, package_locks
        self.read_record, self.write_record, self.boot_id = read_record, write_record, boot_id
        self.path = service.state_dir / 'docker-socket-recovery.json'
        self.clock = clock

    def admit_attempt(self, incident):
        boot, now = self.boot_id(), int(self.clock())
        previous = self.read_record(self.path)
        attempts = []
        if previous is not None:
            require(set(previous) == {'version', 'boot', 'attempts'} and type(previous['version']) is int and previous['version'] == 1
                    and isinstance(previous['boot'], str) and isinstance(previous['attempts'], list)
                    and len(previous['attempts']) <= MAX_ATTEMPTS_PER_WINDOW)
            if previous['boot'] == boot:
                attempts = previous['attempts']
                for item in attempts:
                    require(set(item) == {'incident', 'time'} and re.fullmatch(r'[a-f0-9]{64}', item['incident'])
                            and type(item['time']) is int and 0 <= item['time'] <= now)
        # Keep the last incident even after the rate window expires. Its
        # budget does not replenish while that socket generation persists.
        if attempts and attempts[-1]['incident'] == incident:
            return 'attempt-limit'
        recent = [item for item in attempts if now - item['time'] < ATTEMPT_WINDOW]
        if any(item['incident'] == incident for item in recent):
            return 'attempt-limit'
        if len(recent) >= MAX_ATTEMPTS_PER_WINDOW or (recent and now - recent[-1]['time'] < COOLDOWN):
            return 'cooldown'
        self.write_record(self.path, {'version': 1, 'boot': boot,
                                     'attempts': [*recent, {'incident': incident, 'time': now}]})
        return None

    def check(self, stop):
        if stop.is_set() or not self.service.lock.acquire(blocking=False):
            return 'deferred'
        try:
            with self.service.HOST.host_lock(self.service.root), self.package_locks():
                self.service.require_idle_core()
                return self.recover(stop)
        except FAILURES:
            return 'deferred'
        finally:
            self.service.lock.release()

    def recover(self, stop):
        docker = self.docker
        try:
            with docker.deadline(OBSERVATION_TIMEOUT):
                engine = docker.engine()
                source = docker.controller(engine)
                if source is None:
                    return 'stopped'
                if source['binding'] != 'stale':
                    return 'current' if source['binding'] == 'fresh' else 'unverified'
                enrollment = docker.enrollment(source)
                # Health may move independently of the stale bind. Identity,
                # mount and process incarnation must match at both reads.
                retained = {key: value for key, value in source.items() if key != 'health'}
                current = docker.controller(engine)
                if (current is None or {key: value for key, value in current.items() if key != 'health'} != retained
                        or docker.engine() != engine):
                    return 'unverified'
                self.service.require_idle_core()
                if stop.is_set():
                    return 'deferred'
                # One attempt for this Core and host socket generation, even if it
                # gets a different PID after a failed or ambiguous restart.
                incident = digest((source['id'], engine[1], engine[2]))
                hold = self.admit_attempt(incident)
                if hold:
                    return hold
                # Verify again after the durable reservation and before effect.
                self.service.require_idle_core()
                require(docker.enrollment(source) == enrollment and docker.engine() == engine)
                current = docker.controller(engine)
                if (stop.is_set() or current is None
                        or {key: value for key, value in current.items() if key != 'health'} != retained):
                    return 'unverified'
        except FAILURES:
            return 'unverified'

        try:
            with docker.deadline(RESTART_TIMEOUT):
                docker.restart(source['id'], engine)
            deadline = self.clock() + HEALTH_TIMEOUT
            while not stop.is_set() and self.clock() < deadline:
                with docker.deadline(min(OBSERVATION_TIMEOUT, max(0.01, deadline - self.clock()))):
                    if docker.engine() != engine:
                        return 'repair-unverified'
                    current = docker.controller(engine)
                    if current is None or current['creation'] != source['creation']:
                        return 'repair-unverified'
                    if (current['incarnation'][:3] != source['incarnation'][:3]
                            and current['binding'] == 'fresh' and current['health'] == 'healthy'):
                        if docker.enrollment(current) != enrollment or docker.engine() != engine:
                            return 'repair-unverified'
                        return 'recovered' if docker.controller(engine) == current else 'repair-unverified'
                stop.wait(2)
        except FAILURES:
            pass
        return 'repair-unverified'


def supervise(recovery, stop, log):
    previous = None
    while not stop.is_set():
        outcome = recovery.check(stop)
        if outcome != previous and outcome in {'recovered', 'repair-unverified', 'attempt-limit'}:
            log(outcome)
        previous = outcome
        stop.wait(INTERVAL)
