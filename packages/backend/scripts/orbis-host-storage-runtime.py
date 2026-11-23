#!/usr/bin/env python3
"""Qualify the real read-only Host/Core storage connection on a fresh Linux runner.

The fixture never configures recovery, systemd, production services or accounts.
It refuses existing installations and destroys only positively identified actors
created by this run. Generated environment files and raw process output stay local.
"""
import argparse
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import stat
import subprocess
import sys
import time

IMAGE = 'ghcr.io/twentylines/orbis'
SERVICES = ('runtipi-db', 'runtipi-queue', 'runtipi-reverse-proxy', 'runtipi')
NETWORK = 'runtipi_tipi_main_network'
DEPENDENCIES = {
    'library/postgres': {'reference': 'docker.io/library/postgres@sha256:c0e9c0e9bac7e4c1834b698217a03ee5c708de30d313c84a506972de0e24b059'},
    'library/rabbitmq': {'reference': 'docker.io/library/rabbitmq@sha256:3dbd31cb9e4d45dac44de7b73cc45b848028494e98bcab71477386cbd4dc7f56'},
    'library/traefik': {'reference': 'docker.io/library/traefik@sha256:171c9c3565b29f6c133f1c1b43c5d4e5853415198e9e1078c001f8702ff66aec'},
}


class Refused(Exception):
    pass


def require(value, code):
    if not value:
        raise Refused(code)


def canonical_reference(value):
    """Keep the exact digest while expanding Docker's familiar repository names."""
    if not isinstance(value, str) or len(value) > 1024:
        return None
    match = re.fullmatch(r'([^@]+)@(sha256:[a-f0-9]{64})', value)
    if match is None:
        return None
    parts, digest = match[1].split('/'), match[2]
    registry = 'docker.io'
    if len(parts) > 1 and (parts[0] == 'localhost' or '.' in parts[0] or ':' in parts[0]):
        registry = parts.pop(0)
        if not re.fullmatch(r'(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]{1,5})?', registry):
            return None
        port = registry.split(':')[1:]
        if port and not 1 <= int(port[0]) <= 65535:
            return None
    if registry == 'index.docker.io':
        registry = 'docker.io'
    if not parts or any(not re.fullmatch(r'[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*', part) for part in parts):
        return None
    if registry == 'docker.io' and len(parts) == 1:
        parts.insert(0, 'library')
    return registry + '/' + '/'.join(parts) + '@' + digest


def startup_signals(body, packages, private_values=()):
    """Return bounded diagnostics without configuration, paths or credentials."""
    # Node can print a very long minified source line before its actual error.
    # Keep both bounded ends so that line cannot hide the final failure marker.
    text = (body[:128 * 1024] + b'\n' + body[-128 * 1024:]).decode('utf-8', errors='replace')
    text = '\n'.join(line for line in text.splitlines() if len(line) <= 4096)
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    markers = {
        'missing-module': ('ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'Cannot find package', 'Cannot find module'),
        'native-module': ('ERR_DLOPEN_FAILED', 'invalid ELF header'),
        'syntax-error': ('SyntaxError:',),
        'reference-error': ('ReferenceError:',),
        'type-error': ('TypeError:',),
        'permission-denied': ('EACCES', 'EPERM'),
        'missing-file': ('ENOENT',),
        'busy-file': ('EBUSY',),
        'connection-refused': ('ECONNREFUSED',),
        'database-authentication': ('password authentication failed',),
        'cli-secret-storage': ('CLI authentication storage is invalid or not private',),
        'server-configuration': ('Invalid server configuration',),
        'settings-configuration': ('Invalid settings.json file',),
        'dependency-injection': ("Nest can't resolve dependencies",),
        'schema-parse': ('ParseError:',),
        'bundled-commonjs-wrapper': ('Expected CommonJS module to have a function wrapper',),
        'database-query': ('DrizzleQueryError:', 'QueryFailedError:'),
    }
    missing = set()
    for value in re.findall(r"Cannot find (?:package|module) ['\"]([^'\"\r\n]{1,200})['\"]", text):
        root = '/'.join(value.split('/')[:2]) if value.startswith('@') else value.split('/')[0]
        if root in packages:
            missing.add(root)
    messages = []
    for line in text.splitlines():
        if '[ExceptionHandler]' in line:
            line = line.split('[ExceptionHandler]', 1)[1].strip()
        elif not re.match(r'^[A-Za-z]{0,48}(?:Error|Exception)(?: \[[A-Z_]+\])?:', line):
            continue
        if re.search(r'password|token|secret|cookie|session|PRIVATE KEY', line, re.I):
            continue
        for value in private_values:
            if isinstance(value, str) and len(value) >= 4:
                line = line.replace(value, '<private>')
        line = re.sub(r"(['\"`]).*?\1", '<quoted>', line)
        line = re.sub(r'https?://\S+|/[\w./:@%+~=-]+|[\w.+-]+@[\w.-]+|[A-Za-z0-9_+/=-]{32,}', '<private>', line)
        line = ''.join(char for char in line if 32 <= ord(char) <= 126)[:320]
        if line and line not in messages:
            messages.append(line)
        if len(messages) == 3:
            break
    return {'markers': sorted(key for key, values in markers.items() if any(value in text for value in values)),
            'missingPackages': sorted(missing), 'messages': messages, 'logBytes': len(body)}


def load(file, name):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(arguments, root, *, timeout=60, accepted=(0,)):
    try:
        result = subprocess.run(arguments, cwd=root, capture_output=True, timeout=timeout,
                                env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
    except subprocess.TimeoutExpired:
        raise Refused('command-deadline') from None
    require(result.returncode in accepted, 'command-failed')
    # Raw output can contain generated credentials or environment configuration.
    # Callers must select strict public fields; never forward it into job logs.
    return result


class Runtime:
    def __init__(self, source, folder, manifest_path, probe):
        self.source, self.folder = source, folder
        self.manifest_path, self.probe = manifest_path, probe
        self.root = folder / 'install'
        self.socket = folder / 'socket/host.sock'
        self.host = None
        self.host_start = None
        self.host_log = None
        self.owned = {}
        self.network = None
        self.original_containers = None
        self.original_networks = None
        self.container_creation_started = False
        self.results = []
        self.failure_role = None

    def docker(self, *arguments, timeout=60):
        return run(['docker', '--context', 'default', *arguments], self.source, timeout=timeout)

    def identifiers(self, kind):
        arguments = ['ls', '--quiet', '--no-trunc']
        if kind == 'container':
            arguments.append('--all')
        output = self.docker(kind, *arguments).stdout.decode('ascii')
        result = set(output.split())
        require(all(re.fullmatch(r'[a-f0-9]{64}', item) for item in result), 'invalid-inventory')
        return result

    def inspect(self, identifier, *, kind='container'):
        body = self.docker(kind, 'inspect', '--format', '{{json .}}', identifier).stdout
        require(len(body) <= 512 * 1024, 'oversized-inspection')
        result = json.loads(body)
        require(type(result) is dict, 'invalid-inspection')
        return result

    def prepare(self):
        require(sys.platform == 'linux' and os.geteuid() == 0, 'linux-root-required')
        require(os.environ.get('ORBIS_HOST_STORAGE_TEST') == '1', 'explicit-fixture-gate-required')
        require(self.source.is_dir() and self.source == self.source.resolve(strict=True), 'physical-source-required')
        require(self.folder == self.folder.resolve(strict=True) and self.folder.parent == self.source
                and re.fullmatch(r'\.orbis-host-[A-Za-z0-9]{6,16}', self.folder.name), 'scoped-fixture-required')
        info = self.folder.lstat()
        require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700 and not list(self.folder.iterdir()), 'fresh-protected-fixture-required')
        require(not os.path.lexists('/var/lib/orbis/state'), 'existing-host-state-refused')
        require(len(os.fsencode(self.socket)) <= 107, 'unix-socket-path-too-long')
        endpoint = json.loads(self.docker('context', 'inspect', 'default', '--format', '{{json .Endpoints.docker.Host}}').stdout)
        require(endpoint in ('unix:///var/run/docker.sock', 'unix:///run/docker.sock'), 'local-engine-required')
        self.original_containers = self.identifiers('container')
        self.original_networks = self.identifiers('network')
        for identifier in self.original_containers:
            item = self.inspect(identifier)
            labels = item['Config'].get('Labels') or {}
            require(item.get('Name', '').lstrip('/') not in SERVICES
                    and labels.get('com.docker.compose.project') != 'runtipi', 'existing-controller-refused')
        for identifier in self.original_networks:
            item = self.inspect(identifier, kind='network')
            require(item.get('Name') != NETWORK and (item.get('Labels') or {}).get('com.docker.compose.project') != 'runtipi', 'existing-network-refused')
        fixture = load(Path(__file__).with_name('orbis-host-storage-fixture.py'), 'storage_runtime_fixture')
        fixture.SOURCE = self.source
        prepared = fixture.prepare(self.manifest_path, self.folder, DEPENDENCIES)
        self.manifest = prepared['manifest']
        require(self.manifest['image'] == IMAGE and re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+', self.manifest['tag']), 'candidate-required')
        # The workflow verifies the registry index/platform/config against the
        # publication receipt before this runner touches Docker.
        self.references = {name: value['image'] for name, value in prepared['config']['services'].items()}
        require(self.probe.is_file() and not self.probe.is_symlink() and self.probe.stat().st_size < 1024 * 1024, 'source-probe-required')
        target = self.folder / 'public-probe/probe.mjs'
        with target.open('xb') as output:
            output.write(self.probe.read_bytes())
        target.chmod(0o644)
        for reference in set(self.references.values()):
            self.docker('pull', '--quiet', reference, timeout=180)
        for name, reference in self.references.items():
            item = self.inspect(reference, kind='image')
            self.failure_role = name
            expected = canonical_reference(reference)
            require(expected is not None and expected in
                    {canonical_reference(value) for value in (item.get('RepoDigests') or [])}, 'pulled-digest-mismatch')
        self.failure_role = None
        core = self.inspect(self.references['runtipi'], kind='image')
        labels = core['Config'].get('Labels') or {}
        require(labels.get('org.opencontainers.image.source') == 'https://github.com/twentylines/orbis'
                and labels.get('org.opencontainers.image.revision') == self.manifest['commit']
                and labels.get('org.opencontainers.image.version') == self.manifest['tag'], 'pulled-candidate-identity-mismatch')

    def start_host(self):
        self.host_log = (self.folder / 'host.private.log').open('xb')
        self.host = subprocess.Popen([sys.executable, '-B', str(self.source / 'scripts/orbis-host-service.py'),
            '--root', str(self.root), '--docker-context', 'default', '--socket', str(self.socket),
            '--snapshots', str(self.folder / 'snapshots'), '--state-dir', str(self.folder / 'host-state')],
            cwd=self.source, stdout=self.host_log, stderr=self.host_log,
            env={**os.environ, 'TMPDIR': str(self.folder), 'PYTHONDONTWRITEBYTECODE': '1'})
        # A Popen handle plus process start time prevents name-based cleanup.
        self.host_start = self.process_start(self.host.pid)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            require(self.host.poll() is None, 'host-start-failed')
            if self.socket.exists():
                info = self.socket.lstat()
                require(stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600, 'invalid-host-socket')
                return
            time.sleep(0.1)
        raise Refused('host-socket-deadline')

    @staticmethod
    def process_start(pid):
        body = Path(f'/proc/{pid}/stat').read_text()
        return body[body.rfind(')') + 2:].split()[19]

    def compose(self, *arguments):
        return run(['docker', '--context', 'default', 'compose', '--project-name', 'runtipi',
                    '--project-directory', str(self.root), '-f', str(self.root / 'docker-compose.yml'),
                    '-f', str(self.root / 'user-config/tipi-compose.yml'), '-f', str(self.root / 'orbis-compose.yml'),
                    *arguments], self.root, timeout=300)

    def collect_owned(self):
        # Read-only inventory may discover actors from a partially failed up.
        # Validate every new ID before retaining it as cleanup authority.
        for identifier in self.identifiers('container') - self.original_containers:
            item = self.inspect(identifier)
            name = item.get('Name', '').lstrip('/')
            labels = item.get('Config', {}).get('Labels') or {}
            if labels.get('com.docker.compose.project') != 'runtipi':
                continue
            require(name in SERVICES and labels.get('com.docker.compose.service') == name
                    and labels.get('com.docker.compose.project.working_dir') == str(self.root)
                    and canonical_reference(item['Config'].get('Image')) == canonical_reference(self.references[name])
                    and re.fullmatch(r'sha256:[a-f0-9]{64}', item.get('Image', '')), 'unowned-fixture-container')
            identity = (name, item['Image'], item['Config']['Image'])
            require(identifier not in self.owned or self.owned[identifier] == identity, 'owned-container-changed')
            self.owned[identifier] = identity
        for identifier in self.identifiers('network') - self.original_networks:
            item = self.inspect(identifier, kind='network')
            labels = item.get('Labels') or {}
            if item.get('Name') != NETWORK:
                continue
            require(labels.get('com.docker.compose.project') == 'runtipi'
                    and labels.get('com.docker.compose.network') == 'tipi_main_network', 'unowned-fixture-network')
            require(self.network in (None, identifier), 'fixture-network-replaced')
            self.network = identifier

    def start_core(self):
        self.container_creation_started = True
        try:
            self.compose('up', '--detach', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '240')
        finally:
            self.collect_owned()
        require({value[0] for value in self.owned.values()} == set(SERVICES), 'missing-fixture-service')
        require(self.network is not None, 'missing-fixture-network')
        core = self.inspect(self.core_id())
        require(core['State']['Status'] == 'running' and core['State'].get('Health', {}).get('Status') == 'healthy', 'candidate-not-healthy')
        result = run([sys.executable, '-B', str(self.source / 'scripts/orbis-host.py'), 'enroll',
            str(self.root), str(self.manifest_path), '--docker-context', 'default', '--confirm-root', str(self.root)], self.source)
        require(json.loads(result.stdout).get('result') == 'enrolled', 'ordinary-enrollment-failed')

    def core_id(self):
        identifiers = [identifier for identifier, identity in self.owned.items() if identity[0] == 'runtipi']
        require(len(identifiers) == 1, 'ambiguous-core')
        return identifiers[0]

    def probe_core(self, mode):
        before = self.inspect(self.core_id())
        require(before['State']['Status'] == 'running' and before['State'].get('Health', {}).get('Status') == 'healthy', 'candidate-health-lost')
        result = self.docker('exec', self.core_id(), 'node', '/opt/orbis-test-probe/probe.mjs', mode, timeout=90)
        require(len(result.stdout) <= 16384 and not result.stderr, 'invalid-probe-output')
        record = json.loads(result.stdout)
        require(record.get('case') == mode and record.get('passed') is True, 'core-storage-probe-failed')
        if mode == 'positive':
            require(record.get('observation', {}).get('controllerId') == self.core_id(), 'probe-controller-mismatch')
        after = self.inspect(self.core_id())
        require(after['State']['StartedAt'] == before['State']['StartedAt'] and after['Image'] == before['Image'], 'controller-changed-during-probe')
        self.results.append({'case': mode, 'passed': True})

    def probe_outside(self):
        before = self.enrollment_hash()
        payload = json.dumps({'appUrn': 'probe:fixture', 'nonce': secrets.token_hex(32)}).encode()
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(30)
        try:
            client.connect(str(self.socket))
            client.sendall(b'POST /v1/app-storage/observe HTTP/1.1\r\nHost: orbis\r\nContent-Type: application/json\r\nContent-Length: '
                           + str(len(payload)).encode() + b'\r\nConnection: close\r\n\r\n' + payload)
            response = http.client.HTTPResponse(client)
            response.begin()
            body = response.read(16385)
            require(response.status == 409 and len(body) <= 16384
                    and json.loads(body) == {'error': 'The app storage binding could not be verified.'}, 'outside-peer-not-refused')
        finally:
            client.close()
        require(self.enrollment_hash() == before, 'outside-peer-mutated-enrollment')
        self.results.append({'case': 'outside-main-peer-refused', 'passed': True})

    def enrollment_hash(self):
        return hashlib.sha256((self.root / '.orbis-host-state.json').read_bytes()).hexdigest()

    def cleanup(self):
        if self.original_containers is None or self.original_networks is None:
            return False
        if self.container_creation_started:
            self.collect_owned()
        # Close only this Popen-owned service, never another pid/service by name.
        if self.host is not None and self.host.poll() is None:
            require(self.process_start(self.host.pid) == self.host_start, 'host-process-changed')
            self.host.send_signal(signal.SIGINT)
            try:
                self.host.wait(timeout=8)
            except subprocess.TimeoutExpired:
                require(self.process_start(self.host.pid) == self.host_start, 'host-process-changed')
                self.host.terminate()
                self.host.wait(timeout=5)
        if self.host_log is not None:
            self.host_log.close()
        # Preserve nonfixture actors and refuse ownership drift before mutations.
        for identifier, identity in self.owned.items():
            item = self.inspect(identifier)
            name, image_id, reference = identity
            labels = item['Config'].get('Labels') or {}
            require(item.get('Name') == '/' + name and item.get('Image') == image_id and item['Config'].get('Image') == reference
                    and labels.get('com.docker.compose.project') == 'runtipi'
                    and labels.get('com.docker.compose.service') == name
                    and labels.get('com.docker.compose.project.working_dir') == str(self.root), 'cleanup-identity-changed')
        for identifier in reversed(list(self.owned)):
            self.docker('stop', '--time', '10', identifier, timeout=25)
            self.docker('rm', identifier)
        if self.network is not None:
            item = self.inspect(self.network, kind='network')
            labels = item.get('Labels') or {}
            require(item.get('Name') == NETWORK and labels.get('com.docker.compose.project') == 'runtipi'
                    and labels.get('com.docker.compose.network') == 'tipi_main_network'
                    and not item.get('Containers'), 'cleanup-network-identity-changed')
            self.docker('network', 'rm', self.network)
        require(self.identifiers('container') == self.original_containers
                and self.identifiers('network') == self.original_networks, 'original-inventory-changed')
        (self.folder / 'cleanup-complete').write_text('Only positively identified fixture actors removed.\n')
        return True

    def diagnostics(self):
        # Record only bounded runtime state, never environment, raw inspect,
        # application output, Host logs or health-check command output.
        records = []
        for identifier, identity in self.owned.items():
            try:
                item = self.inspect(identifier)
                state = item.get('State') or {}
                status = state.get('Status')
                health = (state.get('Health') or {}).get('Status')
                records.append({'service': identity[0],
                    'status': status if status in ('created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead') else 'unknown',
                    'health': health if health in ('starting', 'healthy', 'unhealthy') else 'none',
                    'exitCode': state.get('ExitCode') if type(state.get('ExitCode')) is int else None})
                if identity[0] == 'runtipi' and status != 'running':
                    package = json.loads((self.source / 'packages/backend/package.json').read_bytes())
                    packages = set(package.get('dependencies', {}))
                    logs = self.docker('logs', '--tail', '100', identifier)
                    configuration = (self.root / '.env').read_text().splitlines()
                    private_values = [line.split('=', 1)[1] for line in configuration if '=' in line]
                    private_values.extend((str(self.root), str(self.folder), str(self.source)))
                    records[-1]['startup'] = startup_signals(logs.stdout + logs.stderr, packages, private_values)
            except (Refused, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
                records.append({'service': identity[0], 'status': 'unavailable'})
        return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--fixture', required=True, type=Path)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--probe', required=True, type=Path)
    args = parser.parse_args()
    runtime = Runtime(args.source, args.fixture, args.manifest, args.probe)
    failure, cleaned, phase, diagnostics = None, False, 'prepare', []
    try:
        runtime.prepare()
        phase = 'start-host'
        runtime.start_host()
        phase = 'start-core-and-enroll'
        runtime.start_core()
        original = runtime.enrollment_hash()
        phase = 'positive-storage-observation'
        runtime.probe_core('positive')
        phase = 'outside-main-refusal'
        runtime.probe_outside()
        phase = 'directory-drift-refusal'
        runtime.probe_core('directory-drift')
        require(runtime.enrollment_hash() == original, 'enrollment-changed')
        require((runtime.root / 'app-data/fixture/probe/marker').read_text() == 'scoped fixture\n', 'fixture-data-changed')
    except Refused as error:
        failure = str(error)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        failure = 'fixture-execution-failed'
    finally:
        if failure is not None:
            diagnostics = runtime.diagnostics()
        try:
            cleaned = runtime.cleanup()
        except (Refused, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            failure = 'positive-owned-cleanup-failed'
    result = {'schema': 'orbis.host-storage-runtime-test.v1', 'passed': failure is None and cleaned,
              'cases': runtime.results, 'cleanup': cleaned, 'error': failure,
              'failurePhase': phase if failure is not None else None, 'runtimeStates': diagnostics,
              'failureRole': runtime.failure_role if runtime.failure_role in SERVICES else None,
              'recoveryConfigured': False, 'productionTouched': False}
    # This receipt deliberately excludes raw Docker/Host/Core output and secrets.
    print(json.dumps(result, sort_keys=True))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
