#!/usr/bin/env python3
"""Fixed Docker/data operations for the root retained restore transaction."""
import base64
import copy
import hashlib
import http.client
import importlib.util
import io
import ipaddress
import json
import math
import os
import re
import select
import socket
import stat
import subprocess
import tarfile
import time
from contextlib import ExitStack
from pathlib import Path


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


APPS = load('orbis-install-apps.py', 'orbis_apps_for_retained_runtime')
COMPAT = load('orbis-install-compat.py', 'orbis_compat_for_retained_runtime')
BOOTSTRAP = load('orbis-host-normal-bootstrap.py', 'orbis_bootstrap_for_retained_runtime')
RESET = load('orbis-reset-authority.py', 'orbis_reset_for_retained_runtime')
ROOTS = {'state', 'apps', 'repos', 'media', 'user-config', 'traefik', 'app-data'}
CAPABILITY = {'schema': 'orbis.retained-worker-phase.v1', 'version': 1,
              'phases': ['prepare', 'promote', 'verify', 'rollback', 'commit'], 'commitStages': ['authorize', 'finish']}
CAPABILITY_COMMAND = "import {retainedWorkerCapability as c} from 'file:///app/retained-worker-capability.mjs';process.stdout.write(JSON.stringify(c))"
TERMINAL_CAPABILITY = {'schema': 'orbis.retained-terminal-settlement.v1', 'version': 1,
                       'states': ['staging', 'discarded', 'rolled-back', 'completed'], 'beforeUnlock': True}
TERMINAL_CAPABILITY_PATH = '/app/retained-terminal-capability.json'
APP_ACTIVATION_CAPABILITY = {'schema': 'orbis.retained-app-activation.v1', 'version': 1,
                             'authority': 'root-candidate-resume.v1', 'execution': 'direct-retained-app-start.v1',
                             'ordinaryMutationsHeld': True, 'normalBootstrap': 'idempotent-after-root-settlement.v1'}
APP_ACTIVATION_CAPABILITY_PATH = '/app/retained-app-activation-capability.json'
APP_ENGINE_CAPABILITY = {'schema': 'orbis.retained-app-engine.v1', 'version': 1,
                         'authority': 'root-candidate-app-result.v1', 'execution': 'verify-only-root-engine.v1',
                         'ordinaryMutationsHeld': True, 'normalBootstrap': 'idempotent-after-root-settlement.v1'}
APP_ENGINE_CAPABILITY_PATH = '/app/retained-app-engine-capability.json'
MAX_METADATA = 64 * 1024 * 1024
MAX_STAGE = 64 * 1024 ** 3


def fail():
    return ValueError('Retained restore runtime or staged ownership could not be verified')


def hashed(body):
    return hashlib.sha256(body).hexdigest()


def normalized(value):
    result = copy.deepcopy(value)
    if isinstance(result, dict) and result.get('OomKillDisable') is None:
        result['OomKillDisable'] = False
    return result


class Connection(http.client.HTTPConnection):
    def __init__(self, endpoint):
        super().__init__('localhost', timeout=30)
        self.endpoint = endpoint
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.endpoint)


class DockerRestoreRuntime:
    def __init__(self, manager):
        self.manager, self.host, self.a = manager, manager.host, manager.authority
        self.root, self.context = manager.root, manager.context
        self.P = self.host.IDENTITY.PUBLICATION
        self.reader = APPS.Docker(self.context)
        self.endpoint = None

    def inspect(self, identifier):
        if not re.fullmatch(r'[a-f0-9]{64}|runtipi(?:-db|-queue|-reverse-proxy)?', str(identifier)):
            raise fail()
        return self.reader._object(['container', 'inspect', '--format', '{{json .}}', identifier])

    def image(self, identifier):
        if not self.host.IDENTITY.hashed(identifier):
            raise fail()
        return self.reader._object(['image', 'inspect', '--format', '{{json .}}', identifier])

    def require_capability(self, identifier):
        capability = self.bounded_output(['docker', '--context', self.context, 'exec', identifier, 'node', '--input-type=module', '-e', CAPABILITY_COMMAND], 8192, 20)
        if self.P.metadata(capability) != CAPABILITY:
            raise fail()
        terminal = self.bounded_output(['docker', '--context', self.context, 'exec', identifier, 'node', '-e',
            "process.stdout.write(require('node:fs').readFileSync('/app/retained-terminal-capability.json'))"], 4096, 20)
        self.validate_terminal_capability(terminal)
        return hashed(self.P.canonical({'phase': CAPABILITY, 'terminal': TERMINAL_CAPABILITY}))

    def validate_terminal_capability(self, body):
        observed = self.P.metadata(body, byte_limit=4096)
        if self.P.canonical(observed) != self.P.canonical(TERMINAL_CAPABILITY):
            raise fail()

    def require_target_settlement(self, identifier, *, historical_apps=False):
        digests = {}
        app_path, app_capability = (APP_ENGINE_CAPABILITY_PATH, APP_ENGINE_CAPABILITY) if historical_apps else (APP_ACTIVATION_CAPABILITY_PATH, APP_ACTIVATION_CAPABILITY)
        for path, expected in ((TERMINAL_CAPABILITY_PATH, TERMINAL_CAPABILITY),
                               (app_path, app_capability)):
            output = self.bounded_output(['docker', '--context', self.context, 'container', 'cp', identifier + ':' + path, '-'], 16384, 20)
            with tarfile.open(fileobj=io.BytesIO(output), mode='r:') as archive:
                entries = list(archive)
                if (len(entries) != 1 or entries[0].name != Path(path).name
                        or not entries[0].isfile() or not 0 < entries[0].size <= 4096):
                    raise fail()
                body = archive.extractfile(entries[0]).read(4097)
                if len(body) != entries[0].size or self.P.canonical(self.P.metadata(body, byte_limit=4096)) != self.P.canonical(expected):
                    raise fail()
                digests[path] = hashed(body)
        return hashed(self.P.canonical(digests))

    def bounded_output(self, arguments, maximum, timeout):
        lock = self.host.LOCK_DESCRIPTOR.get()
        process = subprocess.Popen(arguments, cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   pass_fds=(lock,) if lock is not None else ())
        deadline, chunks, count = time.monotonic() + timeout, [], 0
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise fail()
                ready, _, _ = select.select([process.stdout], [], [], remaining)
                if not ready:
                    raise fail()
                block = os.read(process.stdout.fileno(), min(1024 * 1024, maximum + 1 - count))
                if not block:
                    break
                count += len(block)
                if count > maximum:
                    raise fail()
                chunks.append(block)
            if process.wait(timeout=max(0.01, deadline - time.monotonic())):
                raise fail()
            return b''.join(chunks)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdout.close()

    def change(self, args):
        self.reader.lock_fd = self.host.LOCK_DESCRIPTOR.get()
        self.reader.change(args, timeout=180)

    def read_file(self, path, limit=MAX_METADATA):
        with self.a.protected_directory(path.parent) as directory:
            with self.a.protected_file(directory, path.name, limit, private=True) as body:
                return body

    def json(self, path, limit=MAX_METADATA):
        return self.json_bytes(self.read_file(path, limit))

    def json_bytes(self, body):
        # Legacy file metadata includes finite fractional mtimes. Other trusted
        # host schemas remain on the stricter integer-only metadata parser.
        def constant(_):
            raise fail()
        value = json.loads(body, object_pairs_hook=self.P.pairs, parse_constant=constant)
        pending = [(value, 0)]
        nodes = 0
        while pending:
            item, depth = pending.pop()
            nodes += 1
            if depth > 32 or nodes > 2_500_000:
                raise fail()
            if isinstance(item, dict):
                pending.extend((child, depth + 1) for child in item.values())
            elif isinstance(item, list):
                pending.extend((child, depth + 1) for child in item)
            elif isinstance(item, float) and not math.isfinite(item):
                raise fail()
        return value

    def map_path(self, source, destination):
        if not destination.startswith('/') or '..' in destination.split('/'):
            raise fail()
        covering = [item for item in source['Mounts'] if destination == item.get('Destination') or destination.startswith(str(item.get('Destination')) + '/')]
        if not covering:
            raise fail()
        mount = max(covering, key=lambda item: len(item['Destination']))
        if mount.get('Type') != 'bind' or mount.get('RW') is not True:
            raise fail()
        path = Path(mount['Source']) / destination.removeprefix(mount['Destination']).lstrip('/')
        if not path.is_absolute() or path.resolve(strict=True) != path:
            raise fail()
        with self.a.protected_directory(path if path.is_dir() else path.parent, private=False):
            pass
        return path

    def definition(self, raw):
        host = normalized(raw['HostConfig'])
        host.pop('RestartPolicy', None)
        return hashed(self.P.canonical({'id': raw['Id'], 'Config': raw['Config'], 'HostConfig': host,
                       'Mounts': sorted(raw['Mounts'], key=lambda item: item['Destination']),
                       'Networks': sorted(raw['NetworkSettings']['Networks'])}))

    def verify_networks(self, record, raw):
        expected = record['source']['container']['NetworkSettings']['Networks']
        for name, endpoint in raw['NetworkSettings']['Networks'].items():
            identity = expected.get(name, {}).get('NetworkID')
            actual = endpoint.get('NetworkID')
            if (not isinstance(identity, str) or not re.fullmatch(r'[a-f0-9]{64}', identity)
                    or actual != identity and (raw['State'].get('Running') or actual not in {'', None})):
                raise fail()

    def source_snapshot(self, *, policy="retained-restore.v1"):
        if policy not in {"retained-restore.v1", "controller-overlay.v1"}:
            raise fail()
        endpoint = self.reader.socket()
        if not isinstance(endpoint, str) or not endpoint.startswith('/'):
            raise fail()
        manifest = self.manager.service.current_manifest()
        raw = self.inspect('runtipi')
        labels, state = raw['Config'].get('Labels') or {}, raw['State']
        if (labels.get('com.docker.compose.project') != 'runtipi' or labels.get('com.docker.compose.service') != 'runtipi'
                or labels.get('com.docker.compose.project.working_dir') != str(self.root)
                or raw.get('Name') != '/runtipi' or state.get('Running') is not True or state.get('Restarting') or state.get('Paused')
                or (state.get('Health') or {}).get('Status') != 'healthy' or raw['HostConfig'].get('Privileged')
                or raw['HostConfig'].get('AutoRemove') or raw['Config'].get('Image') != self.host.controller_reference(self.root, manifest, self.context)):
            raise fail()
        image = self.image(raw['Image'])
        if image.get('Id') != raw['Image']:
            raise fail()
        if self.host.retained_state(self.root):
            self.host.resolve_current_identity(self.root, self.context, manifest)
        files = {name: self.host.file_digest(self.root / name) for name in self.host.IDENTITY.FILES | {'orbis-host-compose.yml'}}
        daemon = self.reader._object(['info', '--format', '{{json .}}'])
        if not isinstance(daemon.get('ID'), str) or not daemon['ID']:
            raise fail()
        stable = copy.deepcopy(raw)
        mounts = stable.get('Mounts')
        if (not isinstance(mounts, list) or any(not isinstance(item, dict) or not isinstance(item.get('Destination'), str) for item in mounts)
                or len({item['Destination'] for item in mounts}) != len(mounts)):
            raise fail()
        stable['Mounts'] = sorted(mounts, key=lambda item: item['Destination'])
        stable['State'] = {key: state.get(key) for key in ('Running', 'Restarting', 'Paused', 'StartedAt')}
        stable['State']['Health'] = {'Status': state['Health']['Status']}
        reset_authority = self.reset_authority_snapshot(raw)
        if reset_authority is not None:
            RESET.require_docker_isolation(self.root, self.reader, reset_authority, raw['Id'])
        result = {'controllerId': raw['Id'], 'imageId': raw['Image'], 'definition': self.definition(raw), 'files': files,
                'daemonId': daemon['ID'], 'daemonSocket': endpoint,
                'coordinatorCapabilitySha256': self.require_capability(raw['Id']),
                'enrollment': base64.b64encode(self.host.enrollment_bytes(self.root)).decode(), 'publication': manifest,
                'container': stable, 'imageConfiguration': image.get('Config') or {},
                'overlay': self.overlay_preflight(raw, policy=policy)}
        if policy == 'retained-restore.v1':
            result['proxyHostIdentity'] = self.manager.service.proxy_host_identity()['descriptor']
        else:
            result['controllerOverlayPolicy'] = 'orbis.controller-overlay-preserve-live-proxy.v1'
        if reset_authority is not None:
            result['resetAuthority'] = reset_authority
        return result

    def reset_authority_snapshot(self, original):
        mounts = original.get('Mounts') or []
        selected = [item for item in mounts if item.get('Destination') == RESET.TARGET]
        if any(str(item.get('Destination', '')).startswith(RESET.TARGET + '/') for item in mounts):
            raise fail()
        if not selected:
            return None
        binding = RESET.read_external_enrollment(self.root, APPS.digest_daemon(self.reader), self.context)
        RESET.require_runtime(self.root, mounts, binding)
        return binding

    def require_reset_authority(self, record):
        original = record['source']['container']
        observed = self.reset_authority_snapshot(original)
        if observed != record['source'].get('resetAuthority'):
            raise fail()
        return observed

    def proxy_routers(self, container, proxy, network):
        address = proxy['NetworkSettings']['Networks'][network].get('IPAddress')
        if not isinstance(ipaddress.ip_address(address), ipaddress.IPv4Address):
            raise fail()
        url = 'http://' + address + ':8080/api/http/routers'
        command = "const r=await fetch(" + json.dumps(url) + ",{signal:AbortSignal.timeout(2000)});if(!r.ok)process.exit(2);process.stdout.write(await r.text());"
        body = self.bounded_output(['docker', '--context', self.context, 'exec', container, 'node', '--input-type=module', '-e', command], 1024 * 1024, 5)
        return self.parse_proxy_routers(body)

    def parse_proxy_routers(self, body):
        if not isinstance(body, bytes) or not 1 <= len(body) <= 1024 * 1024:
            raise fail()
        # Publication metadata remains dictionary-only. This one Docker API
        # response uses an array and retains its parser's strict resource bounds.
        wrapped = self.P.metadata(b'{"routers":' + body + b'}', byte_limit=1024 * 1024 + 12)
        if not self.P.exact(wrapped, {'routers'}) or not isinstance(wrapped['routers'], list):
            raise fail()
        result = wrapped['routers']
        if (len(result) > 2048 or any(not isinstance(item, dict) or not isinstance(item.get('name'), str) or not 1 <= len(item['name']) <= 256 for item in result)
                or len({item['name'] for item in result}) != len(result)):
            raise fail()
        return {item['name']: item for item in result}

    def proxy_static_digest(self, proxy):
        mounts = [item for item in proxy.get('Mounts', []) if item.get('Destination') == '/etc/traefik']
        if (len(mounts) != 1 or mounts[0].get('Type') != 'bind'
                or mounts[0].get('Source') != str(self.root / 'traefik') or mounts[0].get('RW') is not False):
            raise fail()
        with self.a.protected_directory(self.root / 'traefik', private=False) as directory:
            with self.a.protected_file(directory, 'traefik.yml', 1024 * 1024, private=False) as body:
                return hashed(body)

    def observed_proxy_static_digest(self, proxy):
        # This is a drift observation, never configuration authority. The scoped
        # updater preserves this running proxy and never executes these bytes.
        mounts = [item for item in proxy.get('Mounts', []) if item.get('Destination') == '/etc/traefik']
        if (len(mounts) != 1 or mounts[0].get('Type') != 'bind'
                or mounts[0].get('Source') != str(self.root / 'traefik')):
            raise fail()
        output = self.bounded_output(['docker', '--context', self.context, 'container', 'cp',
                                      proxy['Id'] + ':/etc/traefik/traefik.yml', '-'], 2 * 1024 * 1024, 20)
        with tarfile.open(fileobj=io.BytesIO(output), mode='r:') as archive:
            entries = list(archive)
            if len(entries) != 1 or entries[0].name != 'traefik.yml' or not entries[0].isfile() or not 0 < entries[0].size <= 1024 * 1024:
                raise fail()
            body = archive.extractfile(entries[0]).read(1024 * 1024 + 1)
            if len(body) != entries[0].size:
                raise fail()
        return hashed(body)

    def controller_proxy_policy(self, proxy):
        mounts = proxy.get('Mounts')
        if not isinstance(mounts, list) or len({m.get('Destination') for m in mounts}) != len(mounts):
            raise fail()
        by_target = {m.get('Destination'): m for m in mounts}
        config, shared = by_target.get('/etc/traefik', {}), by_target.get('/shared', {})
        if (config.get('Type') != 'bind' or config.get('Source') != str(self.root / 'traefik')
                or type(config.get('RW')) is not bool or shared.get('Type') != 'bind'
                or shared.get('Source') not in {str(self.root / 'traefik/shared'), str(self.root.parent / ('.' + self.root.name + '.orbis-proxy-identity'))}
                or shared.get('RW') is not True):
            raise fail()
        for mount in mounts:
            target = mount.get('Destination')
            if (not isinstance(target, str) or type(mount.get('RW')) is not bool
                    or (target not in {'/etc/traefik', '/shared'} and mount.get('RW') is not False)
                    or any(target.startswith(prefix + '/') for prefix in ('/etc/traefik', '/shared'))):
                raise fail()
        state = proxy['State']
        if (state.get('Running') is not True or state.get('Paused') or state.get('Restarting')
                or not isinstance(state.get('StartedAt'), str) or not state['StartedAt']):
            raise fail()
        return {'schema': 'orbis.controller-overlay-preserve-live-proxy.v1',
                'startedAt': state['StartedAt'], 'observedStaticSha256': self.observed_proxy_static_digest(proxy),
                'configuration': 'preserve-live-excluded', 'mutableIdentity': 'preserve-live-excluded'}

    def overlay_preflight(self, original, *, policy='retained-restore.v1'):
        host = original['HostConfig']
        labels = original['Config'].get('Labels') or {}
        sockets = [item for item in original['Mounts'] if item.get('Destination') == '/run/orbis']
        if (host.get('PortBindings') or host.get('NetworkMode') == 'host' or labels.get('traefik.enable') != 'true'
                or len(sockets) != 1 or sockets[0].get('Type') != 'bind' or sockets[0].get('Source') != '/run/orbis'
                or sockets[0].get('RW') is not False):
            raise fail()
        proxy = self.inspect('runtipi-reverse-proxy')
        proxy_labels = proxy['Config'].get('Labels') or {}
        if (proxy_labels.get('com.docker.compose.project.working_dir') != str(self.root)
                or proxy_labels.get('com.docker.compose.service') != 'runtipi-reverse-proxy'
                or proxy_labels.get('com.docker.compose.project') != 'runtipi' or not proxy['State'].get('Running')):
            raise fail()
        common = set(original['NetworkSettings']['Networks']) & set(proxy['NetworkSettings']['Networks'])
        selected = labels.get('traefik.docker.network')
        if selected is None and len(common) == 1:
            selected = next(iter(common))
        if selected not in common:
            raise fail()
        observed = self.proxy_routers(original['Id'], proxy, selected)
        routers = {}
        for name, entrypoint in (('dashboard', 'web'), ('dashboard-secure', 'websecure')):
            prefix = 'traefik.http.routers.' + name + '.'
            rule = labels.get(prefix + 'rule')
            resolver = labels.get(prefix + 'tls.certresolver')
            if (not isinstance(rule, str) or not re.fullmatch(r'(?:Host\(`[A-Za-z0-9.-]+`\)\s*&&\s*)?PathPrefix\(`/`\)', rule.replace('"', '`'))
                    or labels.get(prefix + 'entrypoints') != entrypoint
                    or labels.get(prefix + 'service') != 'dashboard'
                    or labels.get('traefik.http.services.dashboard.loadbalancer.server.port') != '3000'
                    or (resolver is not None and (entrypoint != 'websecure' or not re.fullmatch(r'[A-Za-z0-9_-]+', resolver)))
                    or any(key.startswith(prefix) and key[len(prefix):] not in {'rule', 'entrypoints', 'service', 'tls', 'tls.certresolver', 'priority'} for key in labels)):
                raise fail()
            actual = observed.get(name + '@docker') or {}
            if (actual.get('status') != 'enabled' or actual.get('rule') != labels[prefix + 'rule']
                    or actual.get('entryPoints') != [entrypoint] or actual.get('service') != 'dashboard'
                    or type(actual.get('priority')) is not int or not 0 < actual['priority'] < 1_000_000
                    or (isinstance(actual.get('tls'), dict)) != (entrypoint == 'websecure')
                    or (resolver is not None and (actual.get('tls') or {}).get('certResolver') != resolver)
                    or (entrypoint == 'websecure' and labels.get(prefix + 'tls') != 'true' and not resolver)):
                raise fail()
            routers[name] = {'rule': actual['rule'], 'entrypoint': entrypoint, 'priority': actual['priority'] + 1,
                             'tls': entrypoint == 'websecure'}
        continuity = self.controller_proxy_policy(proxy) if policy == 'controller-overlay.v1' else None
        static_sha = self.proxy_static_digest(proxy) if continuity is None else None
        result = {'proxyId': proxy['Id'], 'proxyDefinition': self.definition(proxy), 'network': selected,
                'proxyNetworks': {name: item.get('NetworkID') for name, item in proxy['NetworkSettings']['Networks'].items()},
                'routers': routers}
        if continuity is None:
            result['staticSha256'] = static_sha
        else:
            result['controllerProxyPolicy'] = continuity
        return result

    def overlay_body(self, record):
        configuration = record['source']['overlay']
        service = 'orbis-maintenance-' + record['id'].replace('-', '')
        labels = {'traefik.enable': 'true', 'traefik.docker.network': configuration['network'],
                  'traefik.http.services.' + service + '.loadbalancer.server.port': '3000',
                  'io.orbis.restore': record['id'], 'io.orbis.restore.nonce': record['nonce'], 'io.orbis.restore.role': 'responder'}
        for name, router in configuration['routers'].items():
            prefix = 'traefik.http.routers.' + service + '-' + name + '.'
            labels.update({prefix + 'rule': router['rule'], prefix + 'entrypoints': router['entrypoint'],
                           prefix + 'service': service, prefix + 'priority': str(router['priority'])})
            if router['tls']:
                labels[prefix + 'tls'] = 'true'
        code_file = Path(__file__).with_name('orbis-host-maintenance-responder.mjs')
        with self.a.protected_directory(code_file.parent, private=False) as directory:
            with self.a.protected_file(directory, code_file.name, 32768, private=False) as code:
                code = code.decode('utf8')
        return {'Image': record['source']['imageId'], 'Entrypoint': ['node'], 'Cmd': ['--input-type=module', '-e', code], 'User': '0',
                'Env': ['NODE_ENV=production', 'ORBIS_MAINTENANCE_RESPONDER=1'], 'WorkingDir': '/app', 'Labels': labels,
                'Healthcheck': {'Test': ['NONE']},
                'HostConfig': {'NetworkMode': configuration['network'], 'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0},
                               'ReadonlyRootfs': True, 'Privileged': False, 'AutoRemove': False, 'PublishAllPorts': False, 'PortBindings': {},
                               'CapDrop': ['ALL'], 'CapAdd': [], 'SecurityOpt': ['no-new-privileges:true'], 'Memory': 256 * 1024 * 1024,
                               'PidsLimit': 64, 'LogConfig': {'Type': 'none', 'Config': {}},
                               'Mounts': [{'Type': 'bind', 'Source': '/run/orbis', 'Target': '/run/orbis', 'ReadOnly': True, 'BindOptions': {'Propagation': 'rprivate'}}]},
                'NetworkingConfig': {'EndpointsConfig': {configuration['network']: {}}}}

    def validate_overlay(self, record, *, routes=True):
        configuration = record['source']['overlay']
        proxy = self.inspect(configuration['proxyId'])
        responder = self.inspect(record['responderId'])
        if (self.definition(proxy) != configuration['proxyDefinition'] or not proxy['State'].get('Running')
                or self.definition(responder) != record['definitions']['responder'] or not responder['State'].get('Running')
                or responder['Image'] != record['source']['imageId']):
            raise fail()
        if {name: item.get('NetworkID') for name, item in proxy['NetworkSettings']['Networks'].items()} != configuration['proxyNetworks']:
            raise fail()
        self.verify_networks(record, responder)
        self.check_intent(responder, record['intents']['responder']['body'])
        if 'controllerProxyPolicy' in configuration:
            if self.controller_proxy_policy(proxy) != configuration['controllerProxyPolicy']:
                raise fail()
        elif self.proxy_static_digest(proxy) != configuration['staticSha256']:
            raise fail()
        if routes:
            observed = self.proxy_routers(responder['Id'], proxy, configuration['network'])
            service = 'orbis-maintenance-' + record['id'].replace('-', '')
            for name, router in configuration['routers'].items():
                actual = observed.get(service + '-' + name + '@docker') or {}
                if (actual.get('status') != 'enabled' or actual.get('rule') != router['rule'] or actual.get('priority') != router['priority']
                        or actual.get('entryPoints') != [router['entrypoint']] or actual.get('service') != service):
                    raise fail()
                if isinstance(actual.get('tls'), dict) != router['tls']:
                    raise fail()

    def prepare_overlay(self, record):
        raw = self.create(record, 'responder', self.overlay_body(record))
        self.change(['start', raw['Id']])
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                self.validate_overlay(record)
                result = self.bounded_output(['docker', '--context', self.context, 'exec', raw['Id'], 'node', '--input-type=module', '-e',
                    "const r=await fetch('http://127.0.0.1:3000/dashboard',{headers:{accept:'text/html'},signal:AbortSignal.timeout(2000)});if(!r.ok||!(r.headers.get('content-type')||'').startsWith('text/html'))process.exit(2);process.stdout.write('ok');"], 1024, 5)
                if result != b'ok':
                    raise fail()
                return
            except (ValueError, RuntimeError):
                time.sleep(0.5)
        raise fail()

    def finish_overlay(self, record):
        if self.manager.read(record['id'])['phase'] not in {'complete', 'rolled-back'}:
            raise fail()
        if record['decision'] == 'commit':
            self.assert_active(record)
        else:
            self.restore_original_controller(record)
        if record.get('responderId'):
            raw = self.inspect(record['responderId'])
            if self.definition(raw) != record['definitions']['responder']:
                raise fail()
            self.change(['update', '--restart', 'no', raw['Id']])
            if raw['State'].get('Running'):
                self.change(['stop', raw['Id']])

    def restore_overlay(self, record):
        if not record.get('responderId'):
            if record.get('dataTouched'):
                raise fail()
            return
        raw = self.inspect(record['responderId'])
        if self.definition(raw) != record['definitions']['responder']:
            raise fail()
        self.check_intent(raw, record['intents']['responder']['body'])
        if not raw['State'].get('Running'):
            self.change(['start', raw['Id']])
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                self.validate_overlay(record)
                return
            except (ValueError, RuntimeError):
                time.sleep(0.5)
        raise fail()

    def journal_directory(self, source, identifier):
        return self.map_path(source['container'], '/data/backups') / 'restores' / identifier

    def provisional_auxiliaries(self, source, journal, bootstrap):
        record = {'source': source}
        result = {}
        for role, field in (('worker', 'worker'), ('verifier', 'verifierController')):
            identifier = journal.get(field)
            snapshot = bootstrap.get('identity', {}).get(role, {})
            if not isinstance(identifier, str) or not re.fullmatch(r'[a-f0-9]{64}', identifier) or identifier == source['controllerId']:
                raise fail()
            raw = self.inspect(identifier)
            labels = dict(source['imageConfiguration'].get('Labels') or {})
            labels.update({'io.orbis.restore': journal['id'], 'io.orbis.restore.nonce': journal['nonce'],
                           'io.orbis.restore.role': role, 'traefik.enable': 'false'})
            config, host = raw['Config'], raw['HostConfig']
            if (not self.never_started(raw) or raw['Image'] != source['imageId'] or raw['Name'] != '/orbis-restore-' + journal['id'] + '-' + role
                    or config.get('Labels') != labels or config.get('Entrypoint') != ['node'] or config.get('User') != '0'
                    or config.get('WorkingDir') != '/app' or config.get('Cmd') != (['/app/restore-worker.mjs', journal['id']] if role == 'worker' else ['/app/main.mjs'])
                    or host.get('ReadonlyRootfs') is not True or host.get('Privileged') or host.get('AutoRemove')
                    or host.get('PortBindings') or host.get('PublishAllPorts') or host.get('Devices') or host.get('VolumesFrom') or host.get('Binds')
                    or host.get('NetworkMode') not in source['container']['NetworkSettings']['Networks']
                    or set(host.get('CapDrop') or []) != {'ALL'}
                    or set(host.get('CapAdd') or []) != ({'CHOWN', 'DAC_OVERRIDE', 'FOWNER'} if role == 'worker' else set())
                    or host.get('SecurityOpt') != ['no-new-privileges:true']
                    or host.get('RestartPolicy') != {'Name': 'unless-stopped' if role == 'worker' else 'no', 'MaximumRetryCount': 0}):
                raise fail()
            expected = self.storage_mounts(record, 'coordinator' if role == 'worker' else 'verifier')
            expected = [item for item in expected if item['Target'] != '/run/orbis']
            wanted = sorted((item['Source'], item['Target'], not item['ReadOnly']) for item in expected)
            actual = sorted((item['Source'], item['Destination'], item['RW']) for item in raw['Mounts'])
            if wanted != actual or snapshot.get('id') != identifier or snapshot.get('fingerprint') != self.node_fingerprint(raw):
                raise fail()
            self.verify_networks(record, raw)
            result[role] = {'id': identifier, 'definition': self.definition(raw)}
        if len({item['id'] for item in result.values()}) != 2:
            raise fail()
        return result

    def never_started(self, raw):
        state = raw['State']
        return (not state.get('Running') and not state.get('Restarting') and not state.get('Paused') and raw.get('RestartCount') == 0
                and state.get('StartedAt') in {'0001-01-01T00:00:00Z', '0001-01-01T00:00:00.000000000Z'})

    def node_fingerprint(self, raw):
        host = copy.deepcopy(raw['HostConfig'])
        host.pop('RestartPolicy', None)
        host['OomKillDisable'] = host.get('OomKillDisable') is True
        def utf16(value):
            return value.encode('utf-16-be')
        value = {'id': raw['Id'], 'name': raw['Name'], 'image': raw['Image'], 'config': raw['Config'], 'host': host,
                 'mounts': sorted(raw['Mounts'], key=lambda item: utf16(item['Destination'])),
                 'networks': sorted(raw['NetworkSettings']['Networks'], key=utf16)}
        def property_order(key):
            if re.fullmatch(r'0|[1-9][0-9]{0,9}', key) and int(key) <= 4294967294:
                return (0, int(key))
            return (1, utf16(key))
        def ordered(value):
            if isinstance(value, dict):
                return {key: ordered(value[key]) for key in sorted(value, key=property_order)}
            if isinstance(value, list):
                return [ordered(item) for item in value]
            return value
        return hashed(json.dumps(ordered(value), ensure_ascii=False, separators=(',', ':')).encode('utf8'))

    def destination_app_runtime(self, request, source, bootstrap):
        app = self.manager.CAPTURE.APP
        configuration = self.manager.service._capture_controller_config_locked(request['pointId'], source['controllerId'], source['imageId'])
        image = self.image(source['imageId'])
        platform = {'os': image.get('Os'), 'architecture': image.get('Architecture')}
        if image.get('Variant'): platform['variant'] = image['Variant']
        app.platform(platform)
        preparation = hashed(b'orbis.retained-destination-app-observation.v1\n' + self.P.canonical({
            'pointId': request['pointId'], 'controllerId': source['controllerId'], 'imageId': source['imageId'],
            'configurationSetSha256': configuration['configurationSetSha256'], 'daemonId': source['daemonId']}))
        prepared = {'configuration': configuration, 'publicationReceipt': {'preparationSha256': preparation, 'proof': {'platform': platform}}}
        observed = app.observe(self.manager.service, prepared, self.host, request['pointId'], driver=self)
        if observed['daemonSha256'] != hashed(source['daemonId'].encode()): raise fail()
        expected = bootstrap.get('identity', {}).get('apps')
        if not isinstance(expected, list) or len(expected) != len(observed['containers']): raise fail()
        indexed = {}
        for item in expected:
            raw = item.get('container') if isinstance(item, dict) else None
            if (not isinstance(raw, dict) or raw.get('id') in indexed or not app.hash_value(raw.get('id'))
                    or not self.P.exact(item, {'container', 'project'})): raise fail()
            indexed[raw['id']] = item
        for container in observed['containers']:
            raw = container['inspect']; planned = indexed.get(raw['Id'])
            restart = raw['HostConfig'].get('RestartPolicy') or {}
            snapshot = {'id': raw['Id'], 'fingerprint': self.node_fingerprint(raw), 'running': container['wasRunning'],
                        'restart': {'Name': restart.get('Name') or 'no', 'MaximumRetryCount': restart.get('MaximumRetryCount', 0)}}
            if planned != {'container': snapshot, 'project': container['appUrn'].replace(':', '_')}: raise fail()
        bindings = app.observe_bindings(observed)
        return observed, bindings

    def destination_app_digest(self, observed, bindings):
        stable = {key: value for key, value in observed.items() if key not in {'sha256', 'capturedAt'}}
        return hashed(self.manager.CAPTURE.APP.canonical({'runtime': stable, 'bindings': bindings}))

    def pin_destination_apps(self, record):
        observed, bindings = self.destination_app_runtime({'pointId': record['pointId']}, record['source'], record['stage']['bootstrap'])
        if self.destination_app_digest(observed, bindings) != record['stage']['destinationAppRuntimeSha256']: raise fail()
        path = self.manager.directory(record['id'])
        self.manager.CAPTURE.immutable(path / 'destination-app-runtime.json', self.manager.CAPTURE.APP.canonical(observed))
        self.manager.CAPTURE.immutable(path / 'destination-app-bindings.json', self.P.canonical(bindings))
        record['destinationAppRuntimeSha256'] = hashed(self.manager.CAPTURE.APP.canonical(observed))
        record['destinationAppBindingsSha256'] = hashed(self.P.canonical(bindings))
        self.manager.save(record)

    def review_app_runtime(self, request, authority, metadata, capture, retained, content, manifest):
        try:
            return self._review_app_runtime(request, authority, metadata, capture, retained, content, manifest)
        except (KeyError, TypeError, AttributeError) as error:
            raise fail() from error

    def _review_app_runtime(self, request, authority, metadata, capture, retained, content, manifest):
        capture_authority = self.manager.CAPTURE
        app = capture_authority.APP
        prepared = capture_authority.load_preparation(self.manager.state, request['pointId'])
        independent = capture_authority.load_app_preparation(self.manager.state, request['pointId'], prepared)
        if prepared['rootSha256'] != hashed(str(self.root).encode()) or prepared['contextSha256'] != hashed(self.context.encode()): raise fail()
        original = capture_authority.read(capture_authority.directory(self.manager.state, request['pointId']), 'app-runtime.json', app.MAX_BYTES)
        body = self.read_file(retained / 'app-runtime.json', app.MAX_BYTES)
        if (authority.get('schema') != 'orbis.controller-capture-authority.v4' or authority.get('version') != 4
                or body != original or hashed(body) != independent['appRuntimeSha256']
                or hashed(body) != authority.get('appRuntimeSha256') or hashed(body) != metadata.get('appRuntimeSha256')
                or independent['appRuntimeDaemonSha256'] != authority.get('appRuntimeDaemonSha256')):
            raise fail()
        observed = app.validate(app.parse(body), capture_authority.app_expectations(prepared, authority['appRuntimeDaemonSha256']))
        if app.canonical(observed) != body or capture.get('schema') != 'orbis.time-machine-image-capture.v2':
            raise fail()
        containers, inventory = capture.get('containers'), capture.get('inventory')
        if (not isinstance(containers, list) or len(containers) > 1024 or not isinstance(inventory, dict)
                or not self.P.exact(inventory, {'version', 'images', 'bindings'}) or type(inventory['version']) is not int or inventory['version'] != 1
                or not isinstance(inventory['images'], list) or len(inventory['images']) > 256
                or not isinstance(inventory['bindings'], list) or len(inventory['bindings']) > 1024):
            raise fail()
        images, bindings, ids, keys = {}, {}, set(), set()
        for image in inventory['images']:
            if (not isinstance(image, dict) or not self.P.exact(image, {'imageId', 'repoDigests', 'archive', 'bytes', 'sha256', 'identity'})
                    or not isinstance(image['imageId'], str) or app.IMAGE.fullmatch(image['imageId']) is None or image['imageId'] in images
                    or image['archive'] != 'image-' + image['imageId'][7:] + '.tar'
                    or not app.integer(image['bytes'], 1, MAX_STAGE) or not app.hash_value(image['sha256'])
                    or not isinstance(image['repoDigests'], list) or len(image['repoDigests']) > 256
                    or any(not isinstance(item, str) or len(item) > 2048 for item in image['repoDigests'])):
                raise fail()
            identity = image['identity']
            if (not self.P.exact(identity, {'kind', 'configId', 'manifestId', 'archiveRootId', 'platform', 'expandedBytes'})
                    or identity['kind'] not in {'oci', 'docker'} or not app.integer(identity['expandedBytes'], 0, MAX_STAGE)
                    or any(not isinstance(identity[key], str) or app.IMAGE.fullmatch(identity[key]) is None for key in ('configId', 'archiveRootId'))):
                raise fail()
            if identity['kind'] == 'oci':
                if not isinstance(identity['manifestId'], str) or app.IMAGE.fullmatch(identity['manifestId']) is None: raise fail()
                app.platform(identity['platform'])
            elif (identity['configId'] != image['imageId'] or identity['archiveRootId'] != image['imageId']
                    or identity['manifestId'] is not None or identity['platform'] is not None):
                raise fail()
            images[image['imageId']] = image
        for binding in inventory['bindings']:
            if (not self.P.exact(binding, {'key', 'imageId'}) or not isinstance(binding['key'], str) or not 0 < len(binding['key']) <= 512
                    or binding['key'] in bindings or binding['imageId'] not in images): raise fail()
            bindings[binding['key']] = binding['imageId']
        for item in containers:
            fields = {'id', 'imageId', 'reference', 'project', 'service', 'oneOff', 'running', 'paused', 'restarting', 'role', 'appUrn', 'key', 'ordinal', 'wasRunning'}
            if (not self.P.exact(item, fields) or not app.hash_value(item['id']) or item['id'] in ids or item['key'] in keys
                    or type(item['running']) is not bool or type(item['wasRunning']) is not bool or item['oneOff'] is not False
                    or item['paused'] is not False or item['restarting'] is not False or bindings.get(item['key']) != item['imageId']): raise fail()
            ids.add(item['id']); keys.add(item['key'])
        if set(bindings) != keys or set(images) != set(bindings.values()): raise fail()
        expected_apps = []
        represented = {item['appUrn'] for item in observed['containers']}
        for item in observed['apps']:
            if item['urn'] in represented:
                expected_apps.append({key: item[key] for key in ('project', 'userConfigEnabled', 'sourceSha256', 'configurationSha256')})
                expected_apps[-1].update(urn=item['urn'], services=[service['name'] for service in item['services'] if service['replicas'] > 0])
        if capture.get('apps') != expected_apps: raise fail()
        actual_apps = [item for item in containers if item['role'] == 'app']
        if len(actual_apps) != len(observed['containers']): raise fail()
        for expected in observed['containers']:
            raw, selected = expected['inspect'], expected['image']
            key = 'apps/' + expected['appUrn'] + '/' + expected['service'] + '/' + str(expected['ordinal'])
            actual = next((item for item in actual_apps if item['id'] == raw['Id']), None)
            required = dict(id=raw['Id'], imageId=selected['sourceImageId'], reference=raw['Config']['Image'],
                            project=expected['appUrn'].replace(':', '_'), service=expected['service'], oneOff=False,
                            running=False, paused=False, restarting=False, role='app', appUrn=expected['appUrn'], key=key,
                            ordinal=expected['ordinal'], wasRunning=expected['wasRunning'])
            if actual != required: raise fail()
            identity = images[selected['sourceImageId']]['identity']
            if selected['selection'] == 'docker29-platform-manifest.v1':
                if (identity['kind'] != 'oci' or identity['manifestId'] != selected['creationReference']
                        or identity['platform'] != selected['platform']): raise fail()
            elif identity['kind'] != 'docker' or identity['configId'] != selected['creationReference']:
                raise fail()
        if (not isinstance(manifest, dict) or manifest.get('format') != 'orbis-full-backup'
                or type(manifest.get('version')) is not int or manifest['version'] != 1): raise fail()
        files = manifest.get('files')
        if not isinstance(files, list) or len(files) > 250000: raise fail()
        by_name = {}
        for file in files:
            if not isinstance(file, dict) or not isinstance(file.get('name'), str) or file['name'] in by_name: raise fail()
            by_name[file['name']] = file
        for item in observed['apps']:
            saved = {file['name']: file for file in item['savedFiles']}
            if set(saved) != app.saved_names(item['urn']) & set(by_name): raise fail()
            for name in app.saved_names(item['urn']) - set(saved):
                try: self.read_file(content / name, 16 * 1024 * 1024)
                except FileNotFoundError: pass
                else: raise fail()
            for name, expected in saved.items():
                if {key: by_name[name].get(key) for key in ('name', 'bytes', 'sha256')} != expected: raise fail()
                if self.read_hash(content / name, 16 * 1024 * 1024) != {key: expected[key] for key in ('bytes', 'sha256')}: raise fail()
        return body

    def review_stage(self, request, origin, source):
        path = self.journal_directory(source, request['restoreId'])
        with self.a.protected_directory(path):
            pass
        journal = self.json(path / 'restore.json', 16384)
        bootstrap = self.json(path / 'bootstrap.json', 1024 * 1024)
        admission = self.json(path / 'time-machine-admission.json', 8192)
        if (journal.get('id') != request['restoreId'] or journal.get('phase') != 'staging' or journal.get('decision') is not None
                or journal.get('originalController') != source['controllerId'] or journal.get('candidateController') != source['controllerId']
                or not isinstance(journal.get('roots'), list) or bootstrap.get('identity', {}).get('id') != journal['id']
                or bootstrap['identity'].get('nonce') != journal.get('nonce') or bootstrap['identity'].get('image') != source['imageId']
                or bootstrap['identity'].get('original', {}).get('id') != source['controllerId']
                or admission.get('restoreId') != journal['id'] or admission.get('nonce') != journal['nonce']
                or admission.get('importId') != request['importId'] or admission.get('binding', {}).get('pointId') != request['pointId']
                or type(admission.get('ownerId')) is not int or admission['ownerId'] != bootstrap.get('ownerId')):
            raise fail()
        # This record is bounded account-admission evidence from the existing
        # privileged peer, not controller image/publication authority.
        retained = path / 'retained'
        names = ['image-capture.json', 'runtime-manifest.json', 'controller-config.json', 'controller-publication.json',
                 'controller-authority.json', 'coherence.json']
        bodies = {name: self.read_file(retained / name, 16 * 1024 * 1024) for name in names}
        metadata = self.P.metadata(bodies['runtime-manifest.json'], byte_limit=1024 * 1024)
        configuration = self.P.metadata(bodies['controller-config.json'], byte_limit=16 * 1024 * 1024, string_limit=2 * 1024 * 1024)
        publication = self.P.metadata(bodies['controller-publication.json'], byte_limit=self.P.PROOF_WIRE_BYTES, string_limit=2 * 1024 * 1024)
        authority = self.P.metadata(origin.authority_bytes)
        if (metadata.get('schema') not in {'orbis.time-machine-runtime.v3', 'orbis.time-machine-runtime.v4', 'orbis.time-machine-runtime.v6'} or metadata.get('pointId') != request['pointId']
                or self.P.canonical(configuration) != origin.configuration_bytes
                or self.P.canonical(publication) != origin.publication_receipt_bytes
                or self.P.metadata(bodies['controller-authority.json']) != authority
                or metadata.get('configurationSetSha256') != authority['configurationSetSha256']
                or metadata.get('publicationProofSha256') != authority['publicationProofSha256']):
            raise fail()
        expected_roots = ROOTS - {'traefik'} if metadata['schema'] in {'orbis.time-machine-runtime.v4', 'orbis.time-machine-runtime.v6'} else ROOTS
        if len(journal['roots']) != len(expected_roots) or set(journal['roots']) != expected_roots:
            raise fail()
        if metadata['schema'] in {'orbis.time-machine-runtime.v4', 'orbis.time-machine-runtime.v6'}:
            policy_body = self.read_file(retained / 'proxy-host-identity.json', 16384)
            policy = self.P.metadata(policy_body, byte_limit=16384)
            self.manager.CAPTURE.proxy_descriptor(policy, hashed(str(self.root).encode()), hashed(self.context.encode()))
            if (authority.get('schema') != ('orbis.controller-capture-authority.v4' if metadata['schema'] == 'orbis.time-machine-runtime.v6' else 'orbis.controller-capture-authority.v2') or authority.get('proxyHostIdentity') != policy
                    or hashed(policy_body) != metadata.get('proxyHostIdentitySha256')):
                raise fail()
            current_policy = source.get('proxyHostIdentity')
            self.manager.CAPTURE.proxy_descriptor(current_policy, hashed(str(self.root).encode()), hashed(self.context.encode()))
            if current_policy['mutableIdentity'] != policy['mutableIdentity']:
                raise fail()
            bodies['proxy-host-identity.json'] = policy_body
        elif authority.get('schema') != 'orbis.controller-capture-authority.v1':
            raise fail()
        # Every auxiliary runtime entry is hash-bound to the authenticated point
        # manifest supplied through account admission. Root origin independently
        # authorizes controller/config/proof/archive; data uses the reviewed seal.
        entries = metadata.get('entries')
        if not isinstance(entries, list) or len(entries) > (267 if metadata['schema'] == 'orbis.time-machine-runtime.v6' else 266 if metadata['schema'] == 'orbis.time-machine-runtime.v4' else 265):
            raise fail()
        mapped = {item.get('name'): item for item in entries if isinstance(item, dict)}
        if len(mapped) != len(entries) or any(not isinstance(name, str) for name in mapped): raise fail()
        expected_entries = {'image-capture/capture.json': bodies['image-capture.json'], 'coherence/receipt.json': bodies['coherence.json'],
                            'controller-authority/receipt.json': bodies['controller-authority.json'],
                            'controller-publication/proof.json': bodies['controller-publication.json']}
        if metadata['schema'] in {'orbis.time-machine-runtime.v4', 'orbis.time-machine-runtime.v6'}:
            expected_entries['host-identity/proxy.json'] = bodies['proxy-host-identity.json']
        if metadata['schema'] == 'orbis.time-machine-runtime.v6':
            bodies['app-runtime.json'] = self.read_file(retained / 'app-runtime.json', self.manager.CAPTURE.APP.MAX_BYTES)
            expected_entries['app-runtime/create-intents.json'] = bodies['app-runtime.json']
        for name, body in expected_entries.items():
            item = mapped.get(name)
            if not item or item.get('bytes') != len(body) or item.get('sha256') != hashed(body):
                raise fail()
        capture = self.P.metadata(bodies['image-capture.json'], byte_limit=4 * 1024 * 1024)
        if (capture.get('pointId') != request['pointId'] or not isinstance(capture.get('inventory'), dict)
                or hashed(bodies['image-capture.json']) != metadata.get('imageCaptureSha256')
                or hashed(self.P.canonical(capture['inventory'])) != metadata.get('imageInventorySha256')):
            raise fail()
        coherence = self.P.metadata(bodies['coherence.json'], byte_limit=1024 * 1024)
        unhashed = {key: value for key, value in coherence.items() if key != 'sha256'}
        if (coherence.get('schema') != 'orbis.capture-coherence.v1' or coherence.get('pointId') != request['pointId']
                or coherence.get('scope') != 'orbis-managed-writers.v1'
                or coherence.get('sha256') != hashlib.sha256(b'orbis.capture-coherence.v1\n' + self.P.canonical(unhashed)).hexdigest()
                or coherence.get('controllerAuthoritySha256') != hashed(bodies['controller-authority.json'])
                or coherence.get('publicationProofSha256') != authority['publicationProofSha256']
                or coherence.get('imageCaptureSha256') != metadata['imageCaptureSha256']
                or coherence.get('imageInventorySha256') != metadata['imageInventorySha256']
                or coherence.get('hostFence', {}).get('configurationSetSha256') != authority['configurationSetSha256']
                or coherence.get('hostFence', {}).get('preparationSha256') != authority['preparationSha256']):
            raise fail()
        content = path / 'source' / 'payload' / 'content'
        if (metadata['schema'] in {'orbis.time-machine-runtime.v4', 'orbis.time-machine-runtime.v6'}
                and hashed(self.read_file(content / 'data/traefik/traefik.yml', 1024 * 1024)) != policy['configuration']['staticSha256']):
            raise fail()
        manifest_body = self.read_file(content / 'manifest.json')
        database = self.read_hash(content / 'database.dump', 128 * 1024 ** 3)
        if metadata['schema'] == 'orbis.time-machine-runtime.v6':
            self.review_app_runtime(request, authority, metadata, capture, retained, content,
                                    self.json_bytes(manifest_body))
        seal = bootstrap.get('source') or {}
        if (hashed(manifest_body) != seal.get('manifest', {}).get('sha256') or len(manifest_body) != seal.get('manifest', {}).get('bytes')
                or hashed(manifest_body) != metadata.get('legacy', {}).get('manifestSha256')
                or hashed(manifest_body) != coherence.get('manifestSha256')
                or hashed(manifest_body) != admission.get('binding', {}).get('manifestSha256')
                or metadata.get('legacy', {}).get('cipherSha256') != admission.get('binding', {}).get('archiveSha256')
                or database != seal.get('database') or database != {key: coherence.get('database', {}).get(key) for key in ('bytes', 'sha256')}):
            raise fail()
        app_destination = {}
        if metadata['schema'] == 'orbis.time-machine-runtime.v6':
            observed, bindings = self.destination_app_runtime(request, source, bootstrap)
            app_destination['destinationAppRuntimeSha256'] = self.destination_app_digest(observed, bindings)
            app_destination['executionContractSha256'] = self.manager.service.time_machine_capability('restore')['contractSha256']
        return {'journal': journal, 'bootstrap': bootstrap, 'admission': admission, 'journalPath': str(path), **app_destination,
                'provisional': self.provisional_auxiliaries(source, journal, bootstrap),
                'sourceBinding': {'originalJournalSha256': hashed(self.P.canonical(journal)),
                                  'bootstrapSha256': hashed(self.read_file(path / 'bootstrap.json', 1024 * 1024)),
                                  'admissionSha256': hashed(self.read_file(path / 'time-machine-admission.json', 8192)),
                                  'sourceSealSha256': hashed(self.P.canonical(bootstrap['source'])),
                                  'legacyManifestSha256': hashed(manifest_body), 'runtimeManifestSha256': hashed(bodies['runtime-manifest.json'])},
                'metadataSha256': hashed(bodies['runtime-manifest.json']), 'metadata': metadata,
                'files': {name: hashed(body) for name, body in bodies.items()}, 'legacyManifestSha256': hashed(manifest_body),
                'database': database}

    def read_hash(self, path, limit):
        with self.a.protected_directory(path.parent) as directory:
            with self.a.protected_file(directory, path.name, limit, digest_only=True) as value:
                details = os.stat(path, follow_symlinks=False)
                return {'bytes': details.st_size, 'sha256': value.removeprefix('sha256:')}

    def copy_file(self, source, target, limit):
        with self.a.protected_directory(source.parent) as directory:
            descriptor = os.open(source.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            try:
                before = os.fstat(descriptor)
                if (not stat.S_ISREG(before.st_mode) or before.st_uid != self.a.OWNER or before.st_nlink != 1
                        or stat.S_IMODE(before.st_mode) & 0o077 or not 0 <= before.st_size <= limit):
                    raise fail()
                space = os.statvfs(target.parent)
                if space.f_bavail * space.f_frsize < before.st_size + 256 * 1024 * 1024 or (space.f_files and space.f_favail < 64):
                    raise fail()
                output = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                try:
                    count = 0
                    while True:
                        block = os.read(descriptor, 1024 * 1024)
                        if not block:
                            break
                        offset = 0
                        while offset < len(block):
                            written = os.write(output, block[offset:])
                            if not written:
                                raise fail()
                            offset += written
                        count += len(block)
                    os.fsync(output)
                finally:
                    os.close(output)
                if count != before.st_size or self.a.seal(before) != self.a.seal(os.fstat(descriptor)) or self.a.seal(before) != self.a.seal(source.lstat()):
                    raise fail()
            finally:
                os.close(descriptor)

    def freeze_tree(self, source, target, maximum):
        target.mkdir(mode=0o700)
        inventory, total = [], 0
        def walk(current, destination, prefix=''):
            nonlocal total
            with self.a.protected_directory(current) as directory:
                names = os.listdir(directory)
                if len(names) > 250_000:
                    raise fail()
                for name in sorted(names):
                    if (name in {'.', '..'} or len(name.encode('utf-8')) > 255 or any(ord(char) < 32 or ord(char) == 127 or 0xD800 <= ord(char) <= 0xDFFF for char in name)):
                        raise fail()
                    before = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    relative = prefix + name
                    if len(inventory) >= 250_000:
                        raise fail()
                    if stat.S_ISDIR(before.st_mode):
                        (destination / name).mkdir(mode=0o700)
                        walk(current / name, destination / name, relative + '/')
                        (destination / name).chmod(0o500)
                    elif stat.S_ISREG(before.st_mode):
                        total += before.st_size
                        if total > maximum:
                            raise fail()
                        self.copy_file(current / name, destination / name, maximum)
                        (destination / name).chmod(0o400)
                    else:
                        raise fail()
                    details = (destination / name).lstat()
                    inventory.append({'path': relative, 'seal': list(self.a.seal(details))})
        space = os.statvfs(target.parent)
        if space.f_bavail * space.f_frsize < 256 * 1024 * 1024:
            raise fail()
        walk(source, target)
        target.chmod(0o500)
        return inventory, total

    def check_source(self, record):
        path = Path(record['stage']['journalPath'])
        binding = record['stage']['sourceBinding']
        if (hashed(self.read_file(path / 'bootstrap.json', 1024 * 1024)) != binding['bootstrapSha256']
                or hashed(self.read_file(path / 'time-machine-admission.json', 8192)) != binding['admissionSha256']):
            raise fail()
        for name, expected in record['stage']['files'].items():
            if hashed(self.read_file(Path(record['retainedPath']) / name, 16 * 1024 * 1024)) != expected:
                raise fail()
        if hashed(self.read_file(Path(record['frozenSourcePath']) / 'content' / 'manifest.json')) != binding['legacyManifestSha256']:
            raise fail()
        inventory = self.json(self.manager.directory(record['id']) / 'frozen-source.json')
        if hashed(self.P.canonical(inventory)) != record['frozenSourceInventorySha256']:
            raise fail()
        for group, root in (('source', Path(record['frozenSourcePath'])), ('retained', Path(record['retainedPath']))):
            for item in inventory[group]:
                if list(self.a.seal((root / item['path']).lstat())) != item['seal']:
                    raise fail()

    def preflight_images(self, record, required):
        self.check_source(record)
        capture_body = self.read_file(Path(record['retainedPath']) / 'image-capture.json', 4 * 1024 * 1024)
        capture = self.P.metadata(capture_body, byte_limit=4 * 1024 * 1024)
        metadata = record['stage']['metadata']
        inventory = capture.get('inventory')
        if (hashed(capture_body) != metadata.get('imageCaptureSha256') or not isinstance(inventory, dict)
                or hashed(self.P.canonical(inventory)) != metadata.get('imageInventorySha256')
                or not self.P.exact(inventory, {'version', 'images', 'bindings'}) or inventory['version'] != 1
                or not isinstance(inventory['images'], list) or len(inventory['images']) > 256):
            raise fail()
        expected = 256 * 1024 * 1024
        for image in inventory['images']:
            size = image.get('bytes') if isinstance(image, dict) else None
            identity = image.get('identity') if isinstance(image, dict) else None
            expanded = identity.get('expandedBytes') if isinstance(identity, dict) else None
            if type(size) is not int or not 0 < size <= MAX_STAGE or type(expanded) is not int or not 0 <= expanded <= MAX_STAGE:
                raise fail()
            expected += size + expanded * 2
        if expected != required or required > 2 ** 53 - 1:
            raise fail()
        daemon = self.reader._object(['info', '--format', '{{json .}}'])
        path = Path(daemon.get('DockerRootDir', ''))
        if daemon.get('ID') != record['source']['daemonId'] or not path.is_absolute() or path.resolve(strict=True) != path:
            raise fail()
        # This helper runs on the daemon host, never statfs inside a controller.
        with self.a.protected_directory(path, private=False):
            space = os.statvfs(path)
        available = space.f_bavail * space.f_frsize
        inodes = space.f_favail if space.f_files else None
        if available < required or (inodes is not None and inodes < 64) or available > 2 ** 53 - 1:
            raise fail()
        return {'version': 1, 'transactionId': record['id'], 'requiredBytes': required,
                'availableBytes': available, 'availableInodes': inodes}

    def engine(self, method, route, body=None, *, maximum=8 * 1024 * 1024, allow_missing=False):
        if self.endpoint is None:
            self.endpoint = self.reader.socket()
        if not self.endpoint:
            raise fail()
        version = self.reader._read(['version', '--format', '{{.Server.APIVersion}}'])
        if not re.fullmatch(r'1\.[0-9]{2,3}', version) or int(version.split('.')[1]) < 44:
            raise fail()
        connection = Connection(self.endpoint)
        try:
            wire = None if body is None else self.P.canonical(body)
            connection.request(method, '/v' + version + route, wire, {'Content-Type': 'application/json'} if body is not None else {})
            response = connection.getresponse()
            data = response.read(maximum + 1)
            if len(data) > maximum: raise fail()
            if response.status == 404 and allow_missing: return None
            if not 200 <= response.status < 300: raise fail()
            return data
        finally:
            connection.close()

    def create(self, record, role, body):
        name = 'orbis-retained-' + record['id'] + '-' + role
        record.setdefault('intents', {})[role] = {'name': name, 'body': body}
        self.manager.save(record)
        response = self.P.metadata(self.engine('POST', '/containers/create?name=' + name, body))
        identifier = response.get('Id')
        if not isinstance(identifier, str) or not re.fullmatch(r'[a-f0-9]{64}', identifier):
            raise fail()
        record[{'coordinator': 'workerId', 'candidate': 'candidateId', 'verifier': 'verifierId', 'responder': 'responderId'}[role]] = identifier
        self.manager.save(record)
        raw = self.inspect(identifier)
        self.check_intent(raw, body)
        self.verify_networks(record, raw)
        record.setdefault('definitions', {})[role] = self.definition(raw)
        self.manager.save(record)
        return raw

    def check_intent(self, raw, body):
        for key, value in body.items():
            if key in {'HostConfig', 'NetworkingConfig'}:
                continue
            actual = raw['Config'].get(key)
            if key == 'Env':
                expected = dict(item.split('=', 1) for item in self.image(raw['Image']).get('Config', {}).get('Env', []) if '=' in item)
                expected.update(dict(item.split('=', 1) for item in value))
                if dict(item.split('=', 1) for item in actual) != expected:
                    raise fail()
            elif key == 'Labels':
                expected = dict(self.image(raw['Image']).get('Config', {}).get('Labels') or {})
                expected.update(value)
                if actual != expected:
                    raise fail()
            elif actual != value:
                raise fail()
        host = body['HostConfig']
        structured, binds, observed = host.get('Mounts'), host.get('Binds'), raw.get('Mounts')
        structured = [] if structured is None else structured
        binds = [] if binds is None else binds
        if (not isinstance(structured, list) or not isinstance(binds, list) or not isinstance(observed, list)
                or len(structured) + len(binds) > 256 or len(observed) > 256):
            raise fail()
        propagation = {'rprivate', 'private', 'rshared', 'shared', 'rslave', 'slave'}
        def path(value):
            return (isinstance(value, str) and value.startswith('/') and len(value.encode()) <= 4096
                    and not any(ord(char) < 32 or ord(char) == 127 for char in value) and os.path.normpath(value) == value)
        intended, actual = {}, {}
        def add(target, source, destination, writable, mode):
            if (not path(source) or not path(destination) or type(writable) is not bool
                    or not isinstance(mode, str) or mode not in propagation or destination in target):
                raise fail()
            target[destination] = (source, writable, mode)
        for item in structured:
            if not isinstance(item, dict) or item.get('Type') != 'bind' or type(item.get('ReadOnly', False)) is not bool:
                raise fail()
            options = item.get('BindOptions')
            options = {} if options is None else options
            if not isinstance(options, dict):
                raise fail()
            mode = options.get('Propagation', 'rprivate')
            add(intended, item.get('Source'), item.get('Target'), not item.get('ReadOnly', False), 'rprivate' if mode == '' else mode)
        for item in binds:
            if not isinstance(item, str):
                raise fail()
            parts = item.split(':')
            if len(parts) not in {2, 3}:
                raise fail()
            options = parts[2].split(',') if len(parts) == 3 else []
            if (len(set(options)) != len(options) or set(options) - propagation - {'ro', 'rw', 'z', 'Z'}
                    or len(set(options) & {'ro', 'rw'}) > 1 or len(set(options) & propagation) > 1
                    or len(set(options) & {'z', 'Z'}) > 1):
                raise fail()
            add(intended, parts[0], parts[1], 'ro' not in options, next(iter(set(options) & propagation), 'rprivate'))
        for item in observed:
            if not isinstance(item, dict) or item.get('Type') != 'bind':
                raise fail()
            add(actual, item.get('Source'), item.get('Destination'), item.get('RW'), item.get('Propagation'))
        if intended != actual:
            raise fail()
        actual_host = normalized(raw['HostConfig'])
        for key, value in host.items():
            if key == 'Mounts':
                # Docker exposes structured mounts and legacy Binds together in
                # inspect.Mounts. Their complete union was checked above.
                continue
            if actual_host.get(key) != normalized({key: value}).get(key):
                raise fail()
        if set(raw['NetworkSettings']['Networks']) != set(body['NetworkingConfig']['EndpointsConfig']):
            raise fail()

    def storage_mounts(self, record, role):
        if role not in {'coordinator', 'verifier'}:
            raise fail()
        original = record['source']['container']
        authority = self.require_reset_authority(record)
        destinations = ['/data/' + name for name in ('state', 'apps', 'repos', 'media', 'user-config', 'traefik', 'backups', 'logs', '.env')] + ['/app-data', '/cache']
        selected = {}
        for destination in destinations:
            matches = [item for item in original['Mounts'] if destination == item.get('Destination') or destination.startswith(str(item.get('Destination')) + '/')]
            if not matches:
                raise fail()
            item = max(matches, key=lambda value: len(value['Destination']))
            if item.get('Type') != 'bind' or item.get('RW') is not True:
                raise fail()
            selected[item['Destination']] = item
        if authority is not None:
            mount = next(item for item in original['Mounts'] if item.get('Destination') == RESET.TARGET)
            selected[RESET.TARGET] = mount
        for item in original['Mounts']:
            if item['Destination'] not in selected and any(item['Destination'].startswith(parent + '/') for parent in selected):
                raise fail()
        result = [{'Type': 'bind', 'Source': item['Source'], 'Target': item['Destination'],
                   'ReadOnly': (item['Destination'] not in {'/cache', '/data/logs'}) if role == 'verifier' else not item['RW'],
                   'BindOptions': {'Propagation': 'rprivate'}} for item in selected.values()]
        if role == 'verifier':
            if not any(item['Target'] == '/data/logs' for item in result):
                result.append({'Type': 'bind', 'Source': str(self.map_path(original, '/data/logs')), 'Target': '/data/logs',
                               'ReadOnly': False, 'BindOptions': {'Propagation': 'rprivate'}})
        else:
            for destination in ('/var/run/docker.sock', '/run/orbis'):
                matches = [item for item in original['Mounts'] if item.get('Destination') == destination]
                if len(matches) != 1 or matches[0].get('Type') != 'bind':
                    raise fail()
                item = matches[0]
                if destination == '/run/orbis' and (item.get('Source') != '/run/orbis' or item.get('RW') is not False):
                    raise fail()
                result.append({'Type': 'bind', 'Source': item['Source'], 'Target': destination, 'ReadOnly': not item['RW'],
                               'BindOptions': {'Propagation': 'rprivate'}})
        return sorted(result, key=lambda item: (item['Target'].count('/'), item['Target']))

    def base_body(self, record, role, target_config):
        original = record['source']['container']
        body = copy.deepcopy(original['Config'])
        prior = record['source']['imageConfiguration']
        for key in ('Cmd', 'Entrypoint', 'User', 'WorkingDir', 'Healthcheck', 'StopSignal', 'StopTimeout', 'Shell'):
            if body.get(key) == prior.get(key):
                if key in target_config:
                    body[key] = target_config[key]
                else:
                    body.pop(key, None)
        body.pop('Hostname', None)
        body['Image'] = record['target']['creationReference']
        defaults = dict(item.split('=', 1) for item in target_config.get('Env', []) if '=' in item)
        old_defaults = dict(item.split('=', 1) for item in prior.get('Env', []) if '=' in item)
        for entry in original['Config'].get('Env', []):
            key, separator, value = entry.partition('=')
            if separator and (key not in old_defaults or old_defaults[key] != value):
                defaults[key] = value
        reset = {'ORBIS_VERSION', 'ORBIS_COMMIT', 'ORBIS_IMAGE_DIGEST', 'ORBIS_INSTALLER_PHASE', 'ORBIS_INSTALLER_TRANSACTION', 'HOSTNAME'}
        defaults = {key: value for key, value in defaults.items() if key not in reset}
        publication = record['target']['publication']
        defaults.update(ORBIS_VERSION=publication['tag'], ORBIS_COMMIT=publication['commit'], ORBIS_IMAGE_DIGEST=publication['digest'])
        if role == 'verifier':
            defaults.update(ORBIS_INSTALLER_PHASE='hold', ORBIS_INSTALLER_TRANSACTION=record['id'])
        body['Env'] = [key + '=' + value for key, value in sorted(defaults.items())]
        labels = dict(target_config.get('Labels') or {})
        labels.update({key: value for key, value in (original['Config'].get('Labels') or {}).items()
                       if key not in (prior.get('Labels') or {}) or prior['Labels'][key] != value})
        labels.update({'io.orbis.restore': record['id'], 'io.orbis.restore.nonce': record['nonce'], 'io.orbis.restore.role': role})
        if role == 'verifier':
            labels['traefik.enable'] = 'false'
        body['Labels'] = labels
        host = normalized(original['HostConfig'])
        host['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}
        host['AutoRemove'] = False
        if role == 'verifier':
            host['ReadonlyRootfs'] = True
            host['Privileged'] = False
            host['PortBindings'] = {}
            host['PublishAllPorts'] = False
            for key in ('Binds', 'VolumesFrom', 'Mounts'):
                host.pop(key, None)
            host['Mounts'] = self.storage_mounts(record, 'verifier')
        body['HostConfig'] = host
        body['NetworkingConfig'] = {'EndpointsConfig': {name: {} for name in original['NetworkSettings']['Networks']}}
        return body

    def allocate(self, record, origin):
        record['nonce'] = record['stage']['journal']['nonce']
        if record['stage']['metadata']['schema'] == 'orbis.time-machine-runtime.v6':
            self.pin_destination_apps(record)
        authority = json.loads(origin.authority_bytes)
        publication = authority['publication']
        if publication.get('installationProtocol') != self.host.PLAN.INSTALLATION_PROTOCOL:
            raise fail()
        graph = self.P.verify_publication_proof(publication, json.loads(origin.publication_receipt_bytes)['proof'])
        path = self.manager.directory(record['id'])
        source_path = Path(record['stage']['journalPath'])
        record['retainedPath'] = str(path / 'retained')
        record['frozenSourcePath'] = str(path / 'source')
        source_inventory, source_bytes = self.freeze_tree(source_path / 'source' / 'payload', path / 'source', 129 * 1024 ** 3)
        retained_inventory, retained_bytes = self.freeze_tree(source_path / 'retained', path / 'retained', MAX_STAGE + (48 if record['stage']['metadata']['schema'] == 'orbis.time-machine-runtime.v6' else 32) * 1024 * 1024)
        inventory = {'source': source_inventory, 'retained': retained_inventory}
        inventory_bytes = self.P.canonical(inventory)
        if len(inventory_bytes) > MAX_METADATA:
            raise fail()
        self.a.atomic(path / 'frozen-source.json', inventory_bytes)
        record['frozenSourceInventorySha256'] = hashed(inventory_bytes)
        record['frozenBytes'] = source_bytes + retained_bytes
        self.manager.save(record)
        archive = path / 'retained' / 'controller-image.tar'
        verified = self.manager.CAPTURE.verify_archive(archive, graph, time.monotonic() + 300) if hasattr(self.manager, 'CAPTURE') else None
        if verified is None:
            capture = load('orbis-host-capture-authority.py', 'orbis_capture_verifier_for_restore_runtime')
            capture.AUTHORITY = self.a
            verified = capture.verify_archive(archive, graph, time.monotonic() + 300)
        if any(verified[key] != authority['archive'][key] for key in ('kind', 'sha256', 'bytes', 'archiveRootId', 'configDigest', 'platformManifestDigest', 'creationReference')):
            raise fail()
        # Load only the independently original-point-authorized archive. No pull,
        # tag, canonical RepoDigest alias or caller bare image ID is introduced.
        result = self.host.run(['docker', '--context', self.context, 'image', 'load', '--input', str(archive)], self.root)
        if result.returncode:
            raise fail()
        target = {'publication': publication, 'creationReference': verified['creationReference'], 'platform': json.loads(graph.platform_bytes),
                  'platformManifestDigest': graph.manifest_digest, 'configDigest': graph.config_digest}
        record['target'] = target
        self.manager.save(record)
        observed = self.image(target['creationReference'])
        if (observed.get('Id') != target['creationReference'] or observed.get('Os') != target['platform']['os']
                or observed.get('Architecture') != target['platform']['architecture']
                or (observed.get('RootFS') or {}).get('Layers') != list(graph.rootfs_diff_ids)):
            raise fail()
        # The never-started historical verifier supplies a bounded immutable
        # migration tree. Coordinator code itself always comes from CURRENT image.
        verifier = self.create(record, 'verifier', self.base_body(record, 'verifier', observed['Config']))
        if record['stage']['metadata']['schema'] == 'orbis.time-machine-runtime.v6':
            record['targetSettlementCapabilitySha256'] = self.require_target_settlement(verifier['Id'], historical_apps=True)
        else:
            record['targetSettlementCapabilitySha256'] = self.require_target_settlement(verifier['Id'])
        record['normalBootstrapQueue'] = self.bootstrap_queue_binding(record)
        record['normalBootstrapRequired'] = True
        self.manager.save(record)
        self.copy_migrations(record, verifier['Id'], graph)
        candidate = self.create(record, 'candidate', self.base_body(record, 'candidate', observed['Config']))
        mount_key = lambda values: sorted((item['Type'], item['Source'], item['Destination'], item['RW']) for item in values)
        if mount_key(candidate['Mounts']) != mount_key(record['source']['container']['Mounts']):
            raise fail()
        worker = self.create(record, 'coordinator', self.coordinator_body(record))
        self.change(['start', worker['Id']])
        record['workerSnapshot'] = self.inspect(worker['Id'])
        self.manager.save(record)
        if self.require_capability(worker['Id']) != record['source']['coordinatorCapabilitySha256']:
            raise fail()
        self.validate_worker(record)
        self.prepare_overlay(record)

    def coordinator_body(self, record):
        original = record['source']['container']
        path = self.manager.directory(record['id']) / 'retained'
        socket_mount = [item for item in original['Mounts'] if item.get('Destination') == '/run/orbis']
        if (len(socket_mount) != 1 or socket_mount[0].get('Type') != 'bind' or socket_mount[0].get('Source') != '/run/orbis'
                or socket_mount[0].get('RW') is not False):
            raise fail()
        mounts = self.storage_mounts(record, 'coordinator')
        mounts.append({'Type': 'bind', 'Source': str(path), 'Target': '/data/backups/restores/' + record['id'] + '/retained',
                       'ReadOnly': True, 'BindOptions': {'Propagation': 'rprivate'}})
        mounts.append({'Type': 'bind', 'Source': record['frozenSourcePath'], 'Target': '/data/backups/restores/' + record['id'] + '/source/payload',
                       'ReadOnly': True, 'BindOptions': {'Propagation': 'rprivate'}})
        return {'Image': record['source']['imageId'], 'Entrypoint': ['node'], 'Cmd': ['-e', 'setInterval(()=>{},1000)'], 'User': '0',
                'WorkingDir': '/app', 'Env': ['NODE_ENV=production', 'ORBIS_HOST_SOCKET=/run/orbis/host.sock'],
                'Labels': {'io.orbis.restore': record['id'], 'io.orbis.restore.nonce': record['nonce'], 'io.orbis.restore.role': 'worker', 'traefik.enable': 'false'},
                'Healthcheck': {'Test': ['NONE']},
                'HostConfig': {'NetworkMode': original['HostConfig']['NetworkMode'], 'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0},
                               'ReadonlyRootfs': True, 'Privileged': False, 'AutoRemove': False, 'PublishAllPorts': False, 'PortBindings': {},
                               'CapDrop': ['ALL'], 'CapAdd': ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'], 'SecurityOpt': ['no-new-privileges:true'],
                               'Tmpfs': {'/tmp': 'rw,nosuid,nodev,noexec,size=32m,mode=1777'}, 'Memory': 1024 * 1024 * 1024,
                               'PidsLimit': 256, 'LogConfig': {'Type': 'none', 'Config': {}}, 'Mounts': mounts},
                'NetworkingConfig': {'EndpointsConfig': {name: {} for name in original['NetworkSettings']['Networks']}}}

    def copy_migrations(self, record, identifier, graph):
        output = self.bounded_output(['docker', '--context', self.context, 'container', 'cp', identifier + ':/app/assets/migrations/.', '-'],
                                     32 * 1024 * 1024, 30)
        destination = self.manager.directory(record['id']) / 'retained' / 'migrations'
        destination.parent.chmod(0o700)
        destination.mkdir(mode=0o700)
        files, auxiliary, seen, total = {}, {}, set(), 0
        with tarfile.open(fileobj=io.BytesIO(output), mode='r:') as archive:
            for item in archive:
                name = item.name.removeprefix('./').removeprefix('migrations/')
                if item.isdir():
                    if name not in {'.', '', 'meta'}:
                        raise fail()
                    if name == 'meta':
                        (destination / 'meta').mkdir(mode=0o700, exist_ok=True)
                    continue
                runtime_file = re.fullmatch(r'[0-9]{4}_[A-Za-z0-9_-]+\.sql', name) or name == 'meta/_journal.json'
                auxiliary_file = re.fullmatch(r'meta/[0-9]{4}_snapshot\.json', name) or name in {'schema.ts', 'relations.ts', 'types.ts'}
                if (not item.isfile() or len(seen) >= 8192 or not (runtime_file or auxiliary_file)
                        or name in seen or not 0 <= item.size <= 4 * 1024 * 1024):
                    raise fail()
                seen.add(name)
                body = archive.extractfile(item).read(4 * 1024 * 1024 + 1)
                total += len(body)
                if total > 16 * 1024 * 1024 or len(body) != item.size:
                    raise fail()
                if auxiliary_file:
                    # Drizzle snapshots/source are image-owned audit data. They
                    # never enter the executable migration directory or ledger.
                    auxiliary[name] = hashed(body)
                    continue
                (destination / name).parent.mkdir(mode=0o700, exist_ok=True)
                self.a.atomic(destination / name, body)
                files[name] = hashed(body)
        journal = self.json(destination / 'meta' / '_journal.json', 4 * 1024 * 1024)
        entries = journal.get('entries')
        if journal.get('dialect') != 'postgresql' or not isinstance(entries, list) or not 1 <= len(entries) <= 4096:
            raise fail()
        ledger = []
        for index, item in enumerate(entries):
            if item.get('idx') != index or not isinstance(item.get('tag'), str) or item['tag'] + '.sql' not in files:
                raise fail()
            ledger.append({'createdAt': item.get('when'), 'hash': files[item['tag'] + '.sql']})
        destination.chmod(0o500)
        destination.parent.chmod(0o500)
        record['migrationFiles'] = files
        record['migrationAuxiliaryFiles'] = auxiliary
        record['migrationLedger'] = COMPAT.ledger(ledger)
        self.manager.save(record)

    def validate_worker(self, record):
        self.check_source(record)
        raw = self.inspect(record['workerId'])
        self.verify_networks(record, raw)
        if self.definition(raw) != record['definitions']['coordinator'] or raw['Image'] != record['source']['imageId']:
            raise fail()
        self.check_intent(raw, record['intents']['coordinator']['body'])
        directory = self.manager.directory(record['id']) / 'retained' / 'migrations'
        for name, expected in record['migrationFiles'].items():
            if hashed(self.read_file(directory / name, 4 * 1024 * 1024)) != expected:
                raise fail()

    def validate_rebind(self, record):
        self.validate_overlay(record)
        path = Path(record['stage']['journalPath'])
        journal = self.json(path / 'restore.json', 16384)
        bootstrap = self.json(path / 'bootstrap.json', 1024 * 1024)
        if (journal.get('id') != record['id'] or journal.get('nonce') != record['nonce'] or journal.get('phase') != 'staging'
                or journal.get('decision') is not None or journal.get('originalController') != record['source']['controllerId']
                or journal.get('candidateController') != record['candidateId'] or journal.get('verifierController') != record['verifierId']
                or journal.get('worker') != record['workerId'] or bootstrap.get('ownerId') != record['stage']['bootstrap']['ownerId']
                or bootstrap.get('source') != record['stage']['bootstrap']['source']):
            raise fail()
        self.validate_worker(record)

    def execute_phase(self, record, phase, capsule):
        self.validate_worker(record)
        if self.require_capability(record['workerId']) != record['source']['coordinatorCapabilitySha256']:
            raise fail()
        result = subprocess.run(['docker', '--context', self.context, 'container', 'exec', '--interactive', record['workerId'],
                                 'node', '/app/restore-worker.mjs', record['id'], '--retained-phase', phase],
                                input=self.P.canonical(capsule), cwd=self.root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=1200, check=False,
                                pass_fds=(self.host.LOCK_DESCRIPTOR.get(),) if self.host.LOCK_DESCRIPTOR.get() is not None else ())
        if result.returncode:
            # The root completion record, not a CLI exit alone, decides whether
            # the complete acknowledgement survived a disconnected client.
            fresh = self.manager.read(record['id'])
            grant = fresh.get('grant') or {}
            if grant.get('sequence') != record['sequence'] or grant.get('status') != 'complete':
                raise fail()

    def pin_phase_operation(self, record, phase, commit_stage):
        if phase not in {'prepare', 'rollback'} and not (phase == 'commit' and commit_stage == 'finish'):
            return
        path = Path(record['stage']['journalPath'])
        journal_body = self.read_file(path / 'restore.json', 16384)
        journal = self.json_bytes(journal_body)
        expected_phase = {'prepare': {'prepared'}, 'rollback': {'discarded', 'rolled-back'}, 'commit': {'completed'}}[phase]
        expected_decision = None if phase == 'prepare' else 'rollback' if phase == 'rollback' else 'commit'
        if (journal.get('id') != record['id'] or journal.get('nonce') != record['nonce'] or journal.get('phase') not in expected_phase
                or journal.get('decision') != expected_decision or journal.get('worker') != record['workerId']
                or journal.get('originalController') != record['source']['controllerId'] or journal.get('candidateController') != record['candidateId']
                or journal.get('verifierController') != record['verifierId']):
            raise fail()
        try:
            body = self.read_file(path / 'runtime.json', 1024 * 1024)
        except FileNotFoundError:
            if phase != 'rollback' or journal['phase'] != 'discarded':
                raise
            record['phaseOperationSha256'] = None
        else:
            operation = self.json_bytes(body)
            if (operation.get('id') != record['id'] or operation.get('nonce') != record['nonce'] or type(operation.get('version')) is not int or operation.get('version') != 1
                    or operation.get('image') != record['source']['imageId']
                    or operation.get('apps') != record['stage']['bootstrap']['identity']['apps']
                    or operation.get('queue') != record['stage']['bootstrap']['identity']['queue']
                    or operation.get('originalEnvSha256') != record['source']['files']['.env']
                    or hashed(self.read_file(path / 'incoming.env', 1024 * 1024)) != operation.get('incomingEnvSha256')):
                raise fail()
            for role, identifier in (('original', record['source']['controllerId']), ('candidate', record['candidateId']),
                                     ('verifier', record['verifierId']), ('worker', record['workerId'])):
                raw = self.inspect(identifier)
                self.verify_networks(record, raw)
                if phase == 'commit':
                    names = {'original': ('/orbis-retained-' + record['id'] + '-previous', '/runtipi'),
                             'candidate': ('/runtipi', '/orbis-retained-' + record['id'] + '-candidate')}
                    if role in names:
                        actual, normalized_name = names[role]
                        if raw['Name'] != actual:
                            raise fail()
                        raw = copy.deepcopy(raw)
                        raw['Name'] = normalized_name
                expected = operation.get(role) or {}
                if expected.get('id') != identifier or expected.get('fingerprint') != self.node_fingerprint(raw):
                    raise fail()
            digest = hashed(body)
            if record.get('preparedOperationSha256') not in (None, digest) or record.get('phaseOperationSha256') not in (None, digest):
                raise fail()
            self.manager.CAPTURE.immutable(self.manager.directory(record['id']) / 'node-runtime.json', body)
            record['phaseOperationSha256'] = digest
        record['nodePhaseAtAcknowledgement'] = journal['phase']
        record['nodeJournalSha256AtAcknowledgement'] = hashed(journal_body)

    def historical_apps(self, record, action, *, recovery=False):
        if record['stage']['metadata']['schema'] != 'orbis.time-machine-runtime.v6': return None
        if action == 'rollback':
            progress = self.manager.directory(record['id']) / 'historical-app-effects' / 'progress.json'
            if not progress.exists() and not progress.is_symlink(): return None
        module = load('orbis-host-retained-app-driver.py', 'root_historical_apps_for_restore')
        driver = module.HistoricalAppDriver(self, record)
        if action == 'activate': return driver.activate(recovery=recovery)
        if action not in {'probe', 'precommit', 'rollback', 'verify'}: raise fail()
        return getattr(driver, action)()

    def validate_prepared(self, record):
        self.validate_worker(record)
        if record.get('normalBootstrapRequired'):
            self.bootstrap_queues_quiet(record)
        path = Path(record['stage']['journalPath'])
        journal = self.json(path / 'restore.json', 16384)
        operation_body = self.read_file(path / 'runtime.json', 1024 * 1024)
        operation = self.json_bytes(operation_body)
        if (journal.get('phase') != 'prepared' or journal.get('decision') is not None or operation.get('id') != record['id']
                or operation.get('nonce') != record['nonce'] or operation.get('worker', {}).get('id') != record['workerId']
                or operation.get('original', {}).get('id') != record['source']['controllerId']
                or operation.get('candidate', {}).get('id') != record['candidateId'] or operation.get('verifier', {}).get('id') != record['verifierId']
                or operation.get('database', {}).get('owner', {}).get('name') != 'orbis_restore_' + record['id'].replace('-', '')
                or operation['database']['owner'].get('marker') != 'orbis.restore.v1/' + record['id'] + '/' + record['nonce']):
            raise fail()
        record['preparedOperationSha256'] = hashed(operation_body)
        record['incomingEnvSha256'] = hashed(self.read_file(path / 'incoming.env', 1024 * 1024))
        if record['incomingEnvSha256'] != operation.get('incomingEnvSha256'):
            raise fail()
        self.manager.save(record)
        self.verify_database(record, operation)

    def captured_app_rows(self, record):
        capture = self.manager.CAPTURE
        prepared = capture.load_preparation(self.manager.state, record['pointId'])
        receipt = capture.load_app_preparation(self.manager.state, record['pointId'], prepared)
        body = capture.read(capture.directory(self.manager.state, record['pointId']), 'app-runtime.json', capture.APP.MAX_BYTES)
        if hashed(body) != receipt['appRuntimeSha256'] or hashed(body) != record['stage']['metadata']['appRuntimeSha256']: raise fail()
        authority = self.P.metadata(self.manager.origin(record).authority_bytes)
        if (authority.get('schema') != 'orbis.controller-capture-authority.v4' or authority.get('appRuntimeSha256') != hashed(body)
                or authority.get('appRuntimeDaemonSha256') != receipt['appRuntimeDaemonSha256']): raise fail()
        descriptor = capture.APP.validate(capture.APP.parse(body), capture.app_expectations(prepared, receipt['appRuntimeDaemonSha256']))
        return [{key: item[key] for key in ('id', 'urn', 'status', 'pendingRestart', 'userConfigEnabled')} for item in descriptor['apps']]

    def app_rows_query(self):
        return ("SELECT json_build_object('apps',COALESCE(json_agg(json_build_object('id',id,'urn',app_name||':'||app_store_slug,"
                "'status',status::text,'pendingRestart',pending_restart,'userConfigEnabled',COALESCE(user_config_enabled,true)) "
                "ORDER BY app_name,app_store_slug),'[]'::json)) FROM public.app")

    def verify_app_rows(self, record, operation, database, *, restored=False):
        expected = self.captured_app_rows(record)
        if not restored: expected = [{**item, 'status': 'stopped'} for item in expected]
        result = self.P.metadata(self.reader._read(['exec', database['Id'], 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U',
            operation['database']['connection']['user'], '-d', operation['database']['owner']['name'], '-Atqc', self.app_rows_query()]).encode(), byte_limit=2 * 1024 * 1024)
        actual = result.get('apps')
        if (not self.P.exact(result, {'apps'}) or not isinstance(actual, list) or len(actual) != len(expected)
                or any(not self.P.exact(item, {'id', 'urn', 'status', 'pendingRestart', 'userConfigEnabled'}) or type(item['id']) is not int
                       or not isinstance(item['urn'], str) or type(item['pendingRestart']) is not bool or type(item['userConfigEnabled']) is not bool for item in actual)
                or sorted(actual, key=lambda item: item['urn']) != expected): raise fail()
        return expected

    def restore_app_statuses(self, record):
        if record['decision'] != 'commit' or record['stage']['metadata']['schema'] != 'orbis.time-machine-runtime.v6': raise fail()
        operation_body = self.read_file(self.manager.directory(record['id']) / 'node-runtime.json', 1024 * 1024)
        if hashed(operation_body) != record['preparedOperationSha256']: raise fail()
        operation = self.json_bytes(operation_body)
        owner, user = operation['database']['owner'], operation['database']['connection']['user']
        if (type(owner.get('oid')) is not int or not 0 < owner['oid'] <= 2 ** 32 - 1
                or owner.get('marker') != 'orbis.restore.v1/' + record['id'] + '/' + record['nonce']
                or owner.get('name') != 'orbis_restore_' + record['id'].replace('-', '') or not isinstance(user, str)
                or re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,62}', user) is None): raise fail()
        expected = self.captured_app_rows(record)
        intent = {'version': 1, 'transactionId': record['id'], 'operationSha256': record['preparedOperationSha256'],
                  'databaseOid': owner['oid'], 'appsSha256': hashed(self.P.canonical(expected))}
        self.manager.CAPTURE.immutable(self.manager.directory(record['id']) / 'app-status-intent.json', self.P.canonical(intent))
        record['appStatusIntent'] = intent
        self.manager.save(record)
        database = self.inspect('runtipi-db')
        labels = database['Config'].get('Labels') or {}
        if (not database['State'].get('Running') or labels.get('com.docker.compose.project.working_dir') != str(self.root)
                or labels.get('com.docker.compose.service') != 'runtipi-db'): raise fail()
        # Exact historical rows come from the original root receipt. Saved Compose
        # and destination DB state cannot choose statuses or pending preferences.
        staged = [{**item, 'status': 'stopped'} for item in expected]
        order = lambda item: tuple(item['urn'].split(':'))
        original_wire = self.P.canonical(sorted(expected, key=order)).decode()
        staged_wire = self.P.canonical(sorted(staged, key=order)).decode()
        projection = ("COALESCE(jsonb_agg(jsonb_build_object('id',id,'urn',app_name||':'||app_store_slug,'status',status::text,"
                      "'pendingRestart',pending_restart,'userConfigEnabled',COALESCE(user_config_enabled,true)) ORDER BY app_name,app_store_slug),'[]'::jsonb)")
        marker = owner['marker'].replace("'", "''")
        ownership = ("IF NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND oid=" + str(owner['oid']) +
                     " AND pg_get_userbyid(datdba)=current_user AND pg_catalog.shobj_description(oid,'pg_database')='" + marker +
                     "') THEN RAISE EXCEPTION 'database ownership mismatch'; END IF; ")
        query = ("BEGIN; LOCK TABLE public.app IN EXCLUSIVE MODE; DO $orbis$ DECLARE actual jsonb; BEGIN " + ownership + "SELECT " + projection +
                 " INTO actual FROM public.app; IF actual<>$captured$" + staged_wire + "$captured$::jsonb AND actual<>$captured$" + original_wire +
                 "$captured$::jsonb THEN RAISE EXCEPTION 'app capture mismatch'; END IF; ")
        for item in expected:
            query += "UPDATE public.app SET status='" + item['status'] + "' WHERE id=" + str(item['id']) + "; "
        query += "END $orbis$; COMMIT;"
        self.reader._read(['exec', database['Id'], 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', owner['name'], '-Atqc', query])
        self.verify_app_rows(record, operation, database, restored=True)
        record['appStatusRestored'] = True
        self.manager.save(record)

    def verify_database(self, record, operation):
        database = self.inspect('runtipi-db')
        labels = database['Config'].get('Labels') or {}
        if (labels.get('com.docker.compose.project.working_dir') != str(self.root) or labels.get('com.docker.compose.service') != 'runtipi-db'
                or not database['State'].get('Running')):
            raise fail()
        owner = operation['database']['owner']
        expected_name = 'orbis_restore_' + record['id'].replace('-', '')
        query = ("SELECT json_build_object('oid',oid::bigint,'marker',pg_catalog.shobj_description(oid,'pg_database'),'owner',pg_get_userbyid(datdba)) "
                 "FROM pg_database WHERE datname='" + expected_name + "'")
        user = operation['database']['connection']['user']
        if not isinstance(user, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,62}', user):
            raise fail()
        actual = self.P.metadata(self.reader._read(['exec', database['Id'], 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', 'postgres', '-Atqc', query]).encode())
        if (type(owner.get('oid')) is not int or not 0 < owner['oid'] <= 2 ** 32 - 1 or type(actual.get('oid')) is not int
                or actual != {'oid': owner['oid'], 'marker': owner['marker'], 'owner': user}):
            raise fail()
        counts = operation['database']['counts']
        if set(counts) != {'user', 'app', 'app_store', 'link'} or any(type(value) is not int or not 0 <= value <= 2 ** 53 - 1 for value in counts.values()):
            raise fail()
        pairs = ','.join("'" + table + "',(SELECT count(*) FROM public.\"" + table + '\")' for table in sorted(counts))
        query = "SELECT json_build_object(" + pairs + ", 'pendingApps',(SELECT count(*) FROM app WHERE status<>'stopped'))"
        actual = self.P.metadata(self.reader._read(['exec', database['Id'], 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', expected_name, '-Atqc', query]).encode())
        pending_apps = 0
        if record.get('stage', {}).get('metadata', {}).get('schema') == 'orbis.time-machine-runtime.v6' and record.get('appStatusRestored') is True:
            pending_apps = sum(item['status'] != 'stopped' for item in self.captured_app_rows(record))
        if any(type(value) is not int for value in actual.values()) or actual != {**counts, 'pendingApps': pending_apps}:
            raise fail()
        query = "SELECT coalesce(json_agg(json_build_object('createdAt',created_at,'hash',hash) ORDER BY id),'[]') FROM drizzle.__drizzle_migrations"
        ledger = json.loads(self.reader._read(['exec', database['Id'], 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', expected_name, '-Atqc', query]))
        if COMPAT.ledger(ledger) != record['migrationLedger']:
            raise fail()
        if record.get('stage', {}).get('metadata', {}).get('schema') == 'orbis.time-machine-runtime.v6':
            self.verify_app_rows(record, operation, database, restored=record.get('appStatusRestored') is True)

    def health(self, record, identifier, phase):
        deadline = time.monotonic() + (1200 if phase == 'resume' else 180)
        while time.monotonic() < deadline:
            raw = self.inspect(identifier)
            self.verify_networks(record, raw)
            if raw['State'].get('Running') and not raw['State'].get('Restarting') and not raw['State'].get('Paused'):
                try:
                    status = self.P.metadata(self.reader._read(['exec', identifier, 'node', '--input-type=module', '-e',
                        "const a=await fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(1500)});if(!a.ok)process.exit(2);const b=await fetch('http://127.0.0.1:3000/api/installation/status',{signal:AbortSignal.timeout(1500)});if(!b.ok)process.exit(3);process.stdout.write(JSON.stringify(await b.json()));"]).encode())
                    if status.get('schema') == self.host.PLAN.INSTALLATION_PROTOCOL and status.get('phase') == phase and status.get('transactionId') == record['id']:
                        return
                    if (phase == 'resume' and record['decision'] == 'commit' and self.node_complete(record)
                            and status.get('schema') == self.host.PLAN.INSTALLATION_PROTOCOL and status.get('phase') == 'normal'
                            and status.get('transactionId') is None):
                        return
                except (ValueError, RuntimeError):
                    pass
            time.sleep(0.5)
        raise fail()

    def verify_historical_hold(self, record):
        raw = self.inspect(record['verifierId'])
        if self.definition(raw) != record['definitions']['verifier'] or raw['Image'] != record['target']['creationReference']:
            raise fail()
        if not raw['State'].get('Running'):
            self.change(['start', raw['Id']])
        try:
            self.health(record, raw['Id'], 'hold')
        finally:
            self.change(['stop', raw['Id']])

    def validate_promoted(self, record):
        self.validate_overlay(record)
        if record.get('normalBootstrapRequired'):
            self.bootstrap_queues_quiet(record)
        path = Path(record['stage']['journalPath'])
        operation_body = self.read_file(path / 'runtime.json', 1024 * 1024)
        if hashed(operation_body) != record['preparedOperationSha256']:
            raise fail()
        operation = self.json_bytes(operation_body)
        self.verify_database(record, operation)
        environment = self.map_path(record['source']['container'], '/data/.env')
        if hashed(self.read_file(environment, 1024 * 1024)) != record['incomingEnvSha256']:
            raise fail()
        for name, expected in record['source']['files'].items():
            if name not in {'.env', 'orbis-compose.yml'} and self.host.file_digest(self.root / name) != expected:
                raise fail()

    def compile_authority(self, record):
        self.validate_promoted(record)
        path = self.manager.directory(record['id'])
        proof = json.loads(self.manager.origin(record).publication_receipt_bytes)['proof']
        self.a.atomic(path / 'target-proof.json', self.P.canonical(proof))
        prepared = {'schema': 'orbis.retained-restore-prepared.v1', 'transactionId': record['id'], 'pointId': record['pointId'],
                    'root': str(self.root), 'dockerContext': self.context, 'originAuthoritySha256': record['originSha256'],
                    'runtimeManifestDigest': 'sha256:' + record['stage']['metadataSha256'], 'target': record['target'],
                    'incomingEnvSha256': record['incomingEnvSha256'], 'preparedOperationSha256': record['preparedOperationSha256']}
        self.manager.CAPTURE.immutable(path / 'prepared-authority.json', self.P.canonical(prepared))
        record['preparedAuthorityDigest'] = self.P.digest(self.P.canonical(prepared))
        self.manager.save(record)

    def commit_controller(self, record):
        if record['decision'] != 'commit':
            raise fail()
        path = self.manager.directory(record['id'])
        commit = {'schema': 'orbis.retained-restore-commit.v1', 'transactionId': record['id'], 'pointId': record['pointId'],
                  'root': str(self.root), 'dockerContext': self.context, 'decision': 'commit',
                  'originAuthoritySha256': record['originSha256'], 'preparedAuthorityDigest': record['preparedAuthorityDigest']}
        self.manager.CAPTURE.immutable(path / 'commit.json', self.P.canonical(commit))
        original = self.inspect(record['source']['controllerId'])
        candidate = self.inspect(record['candidateId'])
        self.verify_networks(record, original)
        self.verify_networks(record, candidate)
        if original['Name'] == '/runtipi':
            self.change(['rename', original['Id'], 'orbis-retained-' + record['id'] + '-previous'])
        elif original['Name'] != '/orbis-retained-' + record['id'] + '-previous':
            raise fail()
        if candidate['Name'] != '/runtipi':
            if candidate['Name'] != '/orbis-retained-' + record['id'] + '-candidate':
                raise fail()
            self.change(['rename', candidate['Id'], 'runtipi'])
        self.a.atomic(self.root / 'orbis-compose.yml', self.a.override_content(record['target']['publication'], record['target']['creationReference']).encode())

    def activate_candidate(self, record):
        if record['decision'] != 'commit':
            raise fail()
        raw = self.inspect(record['candidateId'])
        self.verify_networks(record, raw)
        if raw['Image'] != record['target']['creationReference']:
            raise fail()
        started = int(time.time() * 1000)
        record['candidateActivationLease'] = {'startedAt': started, 'expiresAt': started + 15 * 60 * 1000}
        self.manager.save(record)
        if not raw['State'].get('Running'):
            self.change(['start', raw['Id']])
        self.health(record, raw['Id'], 'resume')
        self.enroll_committed(record)

    def enroll_committed(self, record):
        # The transaction authority writer is a root-only generation compiler;
        # unlike manual enrollment it derives changed DB/env bindings from the
        # independently verified restore and its already durable commit decision.
        method = getattr(self.a, 'commit_restore_generation', None)
        if method is None:
            raise fail()
        method(self.manager, record)

    def assert_active(self, record):
        if record['decision'] != 'commit':
            raise fail()
        raw = self.inspect(record['candidateId'])
        if raw['Name'] != '/runtipi' or raw['Image'] != record['target']['creationReference']:
            raise fail()
        self.health(record, raw['Id'], 'resume')
        self.host.resolve_current_identity(self.root, self.context, record['target']['publication'])

    def set_terminal_policy(self, record):
        if record['decision'] != 'commit' or not self.node_complete(record):
            raise fail()
        policy = record['source']['container']['HostConfig']['RestartPolicy']
        if (policy.get('Name') not in {'no', 'always', 'unless-stopped', 'on-failure'}
                or type(policy.get('MaximumRetryCount')) is not int or not 0 <= policy['MaximumRetryCount'] <= 1000000):
            raise fail()
        record['terminalRestartPolicy'] = policy
        self.manager.save(record)
        flag = policy['Name'] + (':' + str(policy['MaximumRetryCount']) if policy['Name'] == 'on-failure' else '')
        self.change(['update', '--restart', flag, record['candidateId']])

    def candidate_app_result_material(self, record):
        if record['stage']['metadata']['schema'] != 'orbis.time-machine-runtime.v6' or record.get('appStatusRestored') is not True: raise fail()
        result = self.historical_apps(record, 'verify')
        if result['operationSha256'] != record['preparedOperationSha256'] or result['appRuntimeSha256'] != record['stage']['metadata']['appRuntimeSha256']: raise fail()
        return {key: result[key] for key in ('appRuntimeSha256', 'appEffectsSha256', 'containers')}

    def candidate_resume_material(self, record):
        self.check_source(record)
        operation, digest = self.terminal_operation(record)
        if (operation is None or digest != record.get('preparedOperationSha256')
                or operation.get('id') != record['id'] or operation.get('nonce') != record['nonce']):
            raise fail()
        journal = self.json(Path(record['stage']['journalPath']) / 'restore.json', 16384)
        expected_journal = {**record['stage']['journal'], 'candidateController': record['candidateId'],
                            'worker': record['workerId'], 'verifierController': record['verifierId'],
                            'phase': 'committing', 'decision': 'commit'}
        if self.P.canonical(journal) != self.P.canonical(expected_journal):
            raise fail()
        raw = self.inspect(record['candidateId'])
        self.verify_networks(record, raw)
        state = raw['State']
        if (raw['Name'] != '/runtipi' or raw['Image'] != record['target']['creationReference']
                or self.definition(raw) != record['definitions']['candidate']
                or state.get('Running') is not True or state.get('Restarting') or state.get('Paused')):
            raise fail()
        metadata = record['stage']['metadata']
        hashes = [digest, metadata.get('imageCaptureSha256'), metadata.get('imageInventorySha256')]
        if any(not isinstance(value, str) or re.fullmatch(r'[a-f0-9]{64}', value) is None for value in hashes):
            raise fail()
        return {'operationSha256': hashes[0], 'imageCaptureSha256': hashes[1], 'imageInventorySha256': hashes[2]}

    def bootstrap_queue_binding(self, record):
        raw = self.inspect('runtipi-queue')
        labels, state = raw['Config'].get('Labels') or {}, raw['State']
        if (raw.get('Name') != '/runtipi-queue' or labels.get('com.docker.compose.project') != 'runtipi'
                or labels.get('com.docker.compose.service') != 'runtipi-queue'
                or labels.get('com.docker.compose.project.working_dir') != str(self.root)
                or state.get('Running') is not True or state.get('Restarting') or state.get('Paused')
                or (state.get('Health') or {}).get('Status') != 'healthy'):
            raise fail()
        networks = {name: item.get('NetworkID') for name, item in raw['NetworkSettings']['Networks'].items()}
        if (not networks or any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value) for value in networks.values())
                or not any(networks.get(name) == item.get('NetworkID')
                           for name, item in record['source']['container']['NetworkSettings']['Networks'].items())):
            raise fail()
        return {'id': raw['Id'], 'imageId': raw['Image'], 'definitionSha256': self.definition(raw),
                'restartPolicy': copy.deepcopy(raw['HostConfig']['RestartPolicy']), 'networks': networks}

    def normal_bootstrap_material(self, record, proof):
        policy = record['source'].get('proxyHostIdentity')
        if not isinstance(policy, dict) or self.manager.service.proxy_host_identity()['descriptor'] != policy:
            raise fail()
        survivor, database = self.terminal_survivor_database(record, sealed=proof)
        if survivor != proof['survivor'] or any(database[key] != proof['database'][key] for key in database if key != 'environmentSha256'):
            raise fail()
        raw = self.inspect(record['candidateId'])
        broker = self.inspect('runtipi-queue')
        if self.bootstrap_queue_binding(record) != record.get('normalBootstrapQueue'):
            raise fail()
        result = {'candidateStartedAt': raw['State'].get('StartedAt'), 'brokerStartedAt': broker['State'].get('StartedAt')}
        if any(not isinstance(value, str) or not value or value.startswith('0001-') for value in result.values()):
            raise fail()
        return result

    def bootstrap_rows(self, record, command, deadline):
        fields = {'list_queues': ['name', 'messages_ready', 'messages_unacknowledged', 'consumers'],
                  'list_consumers': [], 'list_channels': ['pid', 'connection', 'vhost', 'consumer_count', 'messages_unacknowledged'],
                  'list_connections': ['pid', 'peer_host', 'vhost', 'state']}
        remaining = deadline - time.monotonic()
        identifier = record.get('normalBootstrapQueue', {}).get('id')
        if command not in fields or remaining <= 0 or not isinstance(identifier, str) or not re.fullmatch(r'[a-f0-9]{64}', identifier):
            raise fail()
        args = ['docker', '--context', self.context, 'exec', identifier, 'rabbitmqctl', '--quiet',
                '--timeout', '5', '--formatter=json', command]
        if command in {'list_queues', 'list_consumers'}:
            args += ['-p', '/']
        output = self.bounded_output(args + fields[command], 1024 * 1024, min(7, remaining))
        return self.P.metadata(b'{"rows":' + output + b'}', byte_limit=1024 * 1024 + 16)['rows']

    def bootstrap_queues_quiet(self, record):
        if self.bootstrap_queue_binding(record) != record.get('normalBootstrapQueue'):
            raise fail()
        BOOTSTRAP.queues(self.bootstrap_rows(record, 'list_queues', time.monotonic() + 7), 0)

    def normal_bootstrap_ready(self, record, proof, lease):
        path = Path(record['stage']['journalPath']) / 'normal-bootstrap' / lease['id'] / 'ready.json'
        body = self.read_file(path, 8192)
        value = self.P.metadata(body, byte_limit=8192)
        BOOTSTRAP.receipt(value, record, proof, lease, int(time.time() * 1000))
        expected = {key: lease[key] for key in ('candidateStartedAt', 'brokerStartedAt')}
        if self.normal_bootstrap_material(record, proof) != expected:
            raise fail()
        candidate, broker = self.inspect(record['candidateId']), self.inspect('runtipi-queue')
        peers = []
        for name, endpoint in candidate['NetworkSettings']['Networks'].items():
            if endpoint.get('NetworkID') == broker['NetworkSettings']['Networks'].get(name, {}).get('NetworkID'):
                peers.extend(endpoint[key] for key in ('IPAddress', 'GlobalIPv6Address')
                             if isinstance(endpoint.get(key), str) and endpoint[key])
        deadline = time.monotonic() + 25
        def rows(command):
            remaining = min(deadline - time.monotonic(), (lease['expiresAt'] - int(time.time() * 1000)) / 1000)
            if remaining <= 0:
                raise fail()
            return self.bootstrap_rows(record, command, time.monotonic() + remaining)
        before = BOOTSTRAP.queues(rows('list_queues'), 1)
        observed_consumers = rows('list_consumers')
        channels = rows('list_channels')
        connections = rows('list_connections')
        BOOTSTRAP.consumers(observed_consumers, channels, connections, peers)
        after = BOOTSTRAP.queues(rows('list_queues'), 1)
        if (before != after
                or self.normal_bootstrap_material(record, proof) != expected or int(time.time() * 1000) >= lease['expiresAt']):
            raise fail()
        attestation = {'schema': 'orbis.normal-bootstrap-broker.v1', 'version': 1, 'transactionId': record['id'], 'pointId': record['pointId'],
                       'bootstrapLeaseId': lease['id'], 'nodeReceiptSha256': hashed(body), 'candidateId': record['candidateId'],
                       'candidateStartedAt': lease['candidateStartedAt'], 'brokerId': broker['Id'], 'brokerImageId': broker['Image'],
                       'brokerStartedAt': lease['brokerStartedAt'], 'brokerDefinitionSha256': record['normalBootstrapQueue']['definitionSha256'],
                       'queues': after, 'consumersSha256': hashed(self.P.canonical(sorted(observed_consumers, key=lambda row: row['consumer_tag']))),
                       'channelsSha256': hashed(self.P.canonical(sorted(channels, key=lambda row: row['pid']))),
                       'connectionsSha256': hashed(self.P.canonical(sorted(connections, key=lambda row: row['pid'])))}
        parent = self.manager.directory(record['id']) / 'normal-bootstrap-evidence'
        parent.mkdir(mode=0o700, exist_ok=True)
        with self.a.protected_directory(parent):
            pass
        path = parent / lease['id']; path.mkdir(mode=0o700, exist_ok=True)
        with self.a.protected_directory(path):
            pass
        try:
            prior = self.P.metadata(self.read_file(path / 'broker.json', 8192), byte_limit=8192)
        except FileNotFoundError:
            prior = None
        if prior is not None:
            descriptor = {key: value for key, value in prior.items() if key != 'sha256'}
            if (set(prior) != set(attestation) | {'observedAt', 'sha256'}
                    or {key: value for key, value in prior.items() if key not in {'observedAt', 'sha256'}} != attestation
                    or type(prior['observedAt']) is not int or not lease['startedAt'] <= prior['observedAt'] <= int(time.time() * 1000) < lease['expiresAt']
                    or prior['sha256'] != hashed(b'orbis.normal-bootstrap-broker.v1\n' + self.P.canonical(descriptor))):
                raise fail()
            attestation = prior
        else:
            attestation['observedAt'] = int(time.time() * 1000)
            attestation['sha256'] = hashed(b'orbis.normal-bootstrap-broker.v1\n' + self.P.canonical(attestation))
        broker_body = self.P.canonical(attestation)
        self.manager.CAPTURE.immutable(path / 'node-receipt.json', body)
        self.manager.CAPTURE.immutable(path / 'broker.json', broker_body)
        return {'nodeReceiptSha256': hashed(body), 'brokerAttestationSha256': hashed(broker_body)}

    def restart_normal_bootstrap(self, record, proof):
        raw = self.inspect(record['candidateId'])
        self.verify_networks(record, raw)
        if (raw['Name'] != '/runtipi' or raw['Image'] != record['target']['creationReference']
                or self.definition(raw) != proof['survivor']['definitionSha256']):
            raise fail()
        if raw['State'].get('Running'):
            self.change(['stop', '--time', '30', raw['Id']])
        stopped = self.inspect(raw['Id'])
        if self.definition(stopped) != proof['survivor']['definitionSha256'] or stopped['State'].get('Running') is not False:
            raise fail()
        # No health wait under the operation lock: candidate startup redeems its
        # separate bounded bootstrap lease through this same protected socket.
        self.change(['start', raw['Id']])

    def verify_normal_bootstrap_decision(self, record, proof):
        lease = record.get('normalBootstrapLease')
        if (not self.P.exact(lease, {'id', 'startedAt', 'expiresAt', 'candidateStartedAt', 'brokerStartedAt'})
                or self.manager.CAPTURE.point_id(lease.get('id')) != lease['id']
                or type(lease.get('startedAt')) is not int or type(lease.get('expiresAt')) is not int
                or lease['expiresAt'] - lease['startedAt'] != 900000
                or any(not isinstance(lease[key], str) or not 1 <= len(lease[key]) <= 128 for key in ('candidateStartedAt', 'brokerStartedAt'))):
            raise fail()
        path = self.manager.directory(record['id']) / 'normal-bootstrap-evidence' / lease['id']
        node_body = self.read_file(path / 'node-receipt.json', 8192)
        broker_body = self.read_file(path / 'broker.json', 8192)
        if (hashed(node_body) != record.get('normalBootstrapReceiptSha256')
                or hashed(broker_body) != record.get('normalBootstrapBrokerSha256')):
            raise fail()
        observed = self.P.metadata(broker_body, byte_limit=8192)
        fields = {'schema', 'version', 'transactionId', 'pointId', 'bootstrapLeaseId', 'nodeReceiptSha256', 'candidateId',
                  'candidateStartedAt', 'brokerId', 'brokerImageId', 'brokerStartedAt', 'brokerDefinitionSha256', 'queues',
                  'consumersSha256', 'channelsSha256', 'connectionsSha256', 'observedAt', 'sha256'}
        expected = {'schema': 'orbis.normal-bootstrap-broker.v1', 'version': 1, 'transactionId': record['id'], 'pointId': record['pointId'],
                    'bootstrapLeaseId': lease['id'], 'nodeReceiptSha256': hashed(node_body), 'candidateId': record['candidateId'],
                    'candidateStartedAt': lease['candidateStartedAt'], 'brokerStartedAt': lease['brokerStartedAt'],
                    'brokerId': record['normalBootstrapQueue']['id'], 'brokerImageId': record['normalBootstrapQueue']['imageId'],
                    'brokerDefinitionSha256': record['normalBootstrapQueue']['definitionSha256'],
                    'queues': [{'name': name, 'messagesReady': 0, 'messagesUnacknowledged': 0, 'consumers': 1} for name in BOOTSTRAP.QUEUES]}
        if (not self.P.exact(observed, fields) or type(observed['version']) is not int
                or any(observed[key] != value for key, value in expected.items())
                or type(observed['observedAt']) is not int or not lease['startedAt'] <= observed['observedAt'] < lease['expiresAt']
                or any(not isinstance(observed[key], str) or not re.fullmatch(r'[a-f0-9]{64}', observed[key])
                       for key in ('consumersSha256', 'channelsSha256', 'connectionsSha256'))
                or observed['sha256'] != hashed(b'orbis.normal-bootstrap-broker.v1\n' + self.P.canonical({key: value for key, value in observed.items() if key != 'sha256'}))):
            raise fail()
        # This is permanent as-of evidence. It must remain usable after normal
        # configuration/data writes and after the original lease expires.
        BOOTSTRAP.receipt(self.P.metadata(node_body, byte_limit=8192), record, proof, lease, observed['observedAt'])

    def terminal_operation(self, record):
        pin = record.get('preparedOperationSha256') or record.get('phaseOperationSha256')
        if record.get('preparedOperationSha256') and record.get('phaseOperationSha256') and record['preparedOperationSha256'] != record['phaseOperationSha256']:
            raise fail()
        protected = self.manager.directory(record['id']) / 'node-runtime.json'
        try:
            body = self.read_file(protected, 1024 * 1024)
        except FileNotFoundError:
            try:
                body = self.read_file(Path(record['stage']['journalPath']) / 'runtime.json', 1024 * 1024)
            except FileNotFoundError:
                if pin is not None:
                    raise
                return None, None
            if pin is None or hashed(body) != pin:
                raise fail()
            # This archives an already root-pinned byte sequence. An unpinned
            # mutable backend file can never establish terminal authority.
            self.manager.CAPTURE.immutable(protected, body)
        if pin is None or hashed(body) != pin:
            raise fail()
        backend = Path(record['stage']['journalPath']) / 'runtime.json'
        try:
            current = self.read_file(backend, 1024 * 1024)
        except FileNotFoundError:
            pass
        else:
            if hashed(current) != pin:
                raise fail()
        return self.json_bytes(body), pin

    def terminal_survivor_database(self, record, sealed=None):
        committed = record['decision'] == 'commit'
        survivor_id = record['candidateId'] if committed else record['source']['controllerId']
        raw = self.inspect(survivor_id)
        self.verify_networks(record, raw)
        expected_definition = record['definitions']['candidate'] if committed else record['source']['definition']
        expected_image = record['target']['creationReference'] if committed else record['source']['imageId']
        state = raw['State']
        if (raw['Name'] != '/runtipi' or raw['Image'] != expected_image or self.definition(raw) != expected_definition
                or state.get('Running') is not True or state.get('Paused') or state.get('Restarting')
                or (state.get('Health') or {}).get('Status') != 'healthy'):
            raise fail()
        if committed and sealed is None:
            self.assert_active(record)
        elif not committed and sealed is None:
            for name, digest in record['source']['files'].items():
                if self.host.file_digest(self.root / name) != digest:
                    raise fail()
        path = Path(record['stage']['journalPath'])
        operation, pin = self.terminal_operation(record)
        connection = copy.deepcopy(operation['database']['connection'] if committed and operation is not None else record['stage']['bootstrap']['connection'])
        if committed:
            if operation is None:
                raise fail()
            connection['database'] = operation['database']['owner']['name']
        user, name = connection.get('user'), connection.get('database')
        if any(not isinstance(value, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,62}', value) for value in (user, name)):
            raise fail()
        database = self.inspect('runtipi-db')
        labels = database['Config'].get('Labels') or {}
        if (labels.get('com.docker.compose.project.working_dir') != str(self.root)
                or labels.get('com.docker.compose.service') != 'runtipi-db' or database['State'].get('Running') is not True):
            raise fail()
        query = ("SELECT json_build_object('oid',oid::bigint,'marker',pg_catalog.shobj_description(oid,'pg_database'),'owner',pg_get_userbyid(datdba)) "
                 "FROM pg_database WHERE datname='" + name + "'")
        observed = self.P.metadata(self.reader._read(['exec', database['Id'], 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', 'postgres', '-Atqc', query]).encode())
        if (not self.P.exact(observed, {'oid', 'marker', 'owner'}) or type(observed['oid']) is not int
                or not 0 < observed['oid'] <= 2 ** 32 - 1 or observed['owner'] != user
                or observed['marker'] is not None and not isinstance(observed['marker'], str)):
            raise fail()
        if committed:
            owner = operation['database']['owner']
            if observed['oid'] != owner['oid'] or observed['marker'] != owner['marker']:
                raise fail()
        environment = self.map_path(record['source']['container'], '/data/.env')
        environment_sha = hashed(self.read_file(environment, 1024 * 1024))
        expected_environment = self.host.saved_state(self.root).get('files', {}).get('.env') if committed else record['source']['files']['.env']
        if sealed is None and environment_sha != expected_environment:
            raise fail()
        return ({'id': survivor_id, 'imageId': raw['Image'], 'definitionSha256': expected_definition,
                 'role': 'candidate' if committed else 'original'},
                {'containerId': database['Id'], 'imageId': database['Image'], 'name': name, 'user': user, 'oid': observed['oid'],
                 'marker': observed['marker'], 'connectionSha256': hashed(self.P.canonical(connection)), 'environmentSha256': environment_sha})

    def terminal_material(self, record):
        path = Path(record['stage']['journalPath'])
        journal_body = self.read_file(path / 'restore.json', 16384)
        journal = self.json_bytes(journal_body)
        phase = journal.get('phase')
        if (journal.get('id') != record['id'] or journal.get('nonce') != record.get('nonce', record['stage']['journal']['nonce'])
                or (record['decision'] == 'commit' and (phase != 'completed' or journal.get('decision') != 'commit'))
                or (record['decision'] == 'rollback' and phase not in {'discarded', 'rolled-back', 'staging'})):
            raise fail()
        if phase == 'staging':
            original = record['stage']['journal']
            rebound = {**original, 'candidateController': record.get('candidateId'), 'worker': record.get('workerId'), 'verifierController': record.get('verifierId')}
            if (record.get('dataTouched') or hashed(self.P.canonical(original)) != record['stage']['sourceBinding']['originalJournalSha256']
                    or self.P.canonical(journal) not in {self.P.canonical(original), self.P.canonical(rebound)}):
                raise fail()
        else:
            if (journal.get('decision') != record['decision'] or journal.get('originalController') != record['source']['controllerId']
                    or journal.get('candidateController') != record.get('candidateId') or journal.get('worker') != record.get('workerId')
                    or journal.get('verifierController') != record.get('verifierId')):
                raise fail()
        operation, operation_sha = self.terminal_operation(record)
        if operation is None and phase not in {'discarded', 'staging'}:
            raise fail()
        retired = []
        roles = {'previous', 'candidate', 'verifier', 'coordinator', 'provisional-worker', 'provisional-verifier'}
        cleaned = record.get('cleaned') or {}
        if set(cleaned) - roles:
            raise fail()
        expected = {}
        survivor_role = 'previous' if record['decision'] == 'commit' else 'candidate'
        survivor_retired = record['source']['controllerId'] if record['decision'] == 'commit' else record.get('candidateId')
        if survivor_retired:
            expected[survivor_role] = survivor_retired
        for role, field in (('verifier', 'verifierId'), ('coordinator', 'workerId')):
            if record.get(field):
                expected[role] = record[field]
        expected.update({'provisional-' + role: item['id'] for role, item in record.get('stage', {}).get('provisional', {}).items()})
        if cleaned != expected:
            raise fail()
        for role, identifier in sorted(cleaned.items()):
            if not isinstance(identifier, str) or not re.fullmatch(r'[a-f0-9]{64}', identifier):
                raise fail()
            found = self.reader._read(['container', 'ls', '--all', '--no-trunc', '--filter', 'id=' + identifier, '--format', '{{.ID}}']).splitlines()
            if found:
                raise fail()
            retired.append({'role': role, 'id': identifier})
        survivor, database = self.terminal_survivor_database(record)
        return {'_journalBody': journal_body, 'nodePhase': phase, 'nodeJournalSha256': hashed(journal_body), 'operationSha256': operation_sha,
                'survivor': survivor, 'database': database, 'retired': retired}

    def finalize_terminal_metadata(self, record, proof):
        path = Path(record['stage']['journalPath'])
        receipt_body = self.read_file(path / 'retained-terminal-reconciliation.json', 4096)
        receipt = self.P.metadata(receipt_body, byte_limit=4096)
        expected = {'version': 1, 'transactionId': record['id'], 'pointId': record['pointId'], 'proofSha256': proof['proofSha256'],
                    'nodeJournalSha256': proof['nodeJournalSha256'], 'operationSha256': proof['operationSha256'], 'decision': proof['decision'],
                    'survivorId': proof['survivor']['id'], 'databaseOid': proof['database']['oid']}
        if type(receipt.get('version')) is not int or type(receipt.get('databaseOid')) is not int or self.P.canonical(receipt) != self.P.canonical(expected):
            raise fail()
        original_body = self.read_file(self.manager.directory(record['id']) / 'node-terminal-journal.json', 16384)
        if hashed(original_body) != proof['nodeJournalSha256']:
            raise fail()
        original = self.json_bytes(original_body)
        current = self.json(path / 'restore.json', 16384)
        expected_journal = {**original, 'phase': 'discarded', 'decision': 'rollback'} if proof['nodePhase'] == 'staging' else original
        if self.P.canonical(current) != self.P.canonical(expected_journal):
            raise fail()
        with self.a.protected_directory(path.parent) as directory:
            try:
                os.stat('active.json', dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise fail()
        survivor, database = self.terminal_survivor_database(record, sealed=proof)
        if survivor != proof['survivor'] or any(database[key] != proof['database'][key] for key in database if key != 'environmentSha256'):
            raise fail()
        return hashed(receipt_body)

    def node_commit_authorized(self, record):
        journal = self.json(Path(record['stage']['journalPath']) / 'restore.json', 16384)
        return (record.get('commitAuthorized') is True and record.get('decision') == 'commit'
                and journal.get('id') == record['id'] and journal.get('nonce') == record['nonce']
                and journal.get('originalController') == record['source']['controllerId']
                and journal.get('candidateController') == record.get('candidateId')
                and journal.get('verifierController') == record.get('verifierId') and journal.get('worker') == record.get('workerId')
                and journal.get('decision') == 'commit' and journal.get('phase') in {'committing', 'completed'})

    def node_complete(self, record):
        journal = self.json(Path(record['stage']['journalPath']) / 'restore.json', 16384)
        return (journal.get('id') == record['id'] and journal.get('nonce') == record['nonce']
                and journal.get('originalController') == record['source']['controllerId']
                and journal.get('candidateController') == record.get('candidateId')
                and journal.get('verifierController') == record.get('verifierId') and journal.get('worker') == record.get('workerId')
                and journal.get('decision') == 'commit' and journal.get('phase') == 'completed')

    def quiesce_owned(self, record):
        if record.get('decision') == 'commit':
            # Revoke startup authority before stopping the previous process tree.
            record['candidateActivationLease'] = None
            self.manager.save(record)
        # Allocation may crash between Docker's response and saving its ID, or
        # between saving the ID and its verified definition. Reconcile only the
        # fixed name and complete protected create intent, never caller discovery.
        for role, field in (('coordinator', 'workerId'), ('verifier', 'verifierId'), ('candidate', 'candidateId'), ('responder', 'responderId')):
            intent = record.get('intents', {}).get(role)
            if intent is None:
                continue
            if not record.get(field):
                expected_name = 'orbis-retained-' + record['id'] + '-' + role
                if intent.get('name') != expected_name:
                    raise fail()
                found = self.reader._read(['container', 'ls', '--all', '--no-trunc', '--filter', 'name=^/' + expected_name + '$', '--format', '{{.ID}}']).splitlines()
                if not found:
                    continue
                if len(found) != 1 or not re.fullmatch(r'[a-f0-9]{64}', found[0]):
                    raise fail()
                record[field] = found[0]
            raw = self.inspect(record[field])
            self.verify_networks(record, raw)
            body = intent['body']
            if role == 'candidate' and record['decision'] == 'commit' and record.get('terminalRestartPolicy'):
                policy = record['source']['container']['HostConfig']['RestartPolicy']
                actual = raw['HostConfig'].get('RestartPolicy')
                if record['terminalRestartPolicy'] != policy or actual not in (body['HostConfig']['RestartPolicy'], policy):
                    raise fail()
                body = copy.deepcopy(body)
                body['HostConfig']['RestartPolicy'] = actual
            self.check_intent(raw, body)
            observed = self.definition(raw)
            previous = record.setdefault('definitions', {}).get(role)
            if previous is not None and observed != previous:
                raise fail()
            record['definitions'][role] = observed
            self.manager.save(record)
        for role, field in (('coordinator', 'workerId'), ('verifier', 'verifierId'), ('candidate', 'candidateId')):
            if not record.get(field):
                continue
            raw = self.inspect(record[field])
            if self.definition(raw) != record['definitions'].get(role) or raw['Config'].get('Labels', {}).get('io.orbis.restore') != record['id']:
                raise fail()
            self.change(['update', '--restart', 'no', raw['Id']])
            if raw['State'].get('Running'):
                self.change(['stop', '--time', '30', raw['Id']])
            stopped = self.inspect(raw['Id'])
            self.verify_networks(record, stopped)
            if (self.definition(stopped) != record['definitions'][role]
                    or stopped['State'].get('Running') or stopped['State'].get('Restarting') or stopped['State'].get('Paused')):
                raise fail()

    def retire_provisional(self, record):
        provisional = record.get('stage', {}).get('provisional', {})
        if not isinstance(provisional, dict) or set(provisional) - {'worker', 'verifier'}:
            raise fail()
        roles = [('provisional-' + role, item['id'], item['definition'], '/orbis-restore-' + record['id'] + '-' + role, True)
                 for role, item in provisional.items()]
        self.retire_roles(record, roles)

    def retire_roles(self, record, roles):
        for role, identifier, definition, name, provisional in roles:
            if not identifier:
                continue
            if record.setdefault('cleaned', {}).get(role) == identifier:
                continue
            if not definition:
                raise fail()
            record.setdefault('cleanupIntents', {})[role] = identifier
            self.manager.save(record)
            found = self.reader._read(['container', 'ls', '--all', '--no-trunc', '--filter', 'id=' + identifier, '--format', '{{.ID}}']).splitlines()
            if found:
                if found != [identifier]:
                    raise fail()
                raw = self.inspect(identifier)
                self.verify_networks(record, raw)
                if (raw['Name'] != name or self.definition(raw) != definition or provisional and not self.never_started(raw)
                        or identifier == record.get('candidateId') and record['decision'] == 'commit'
                        or identifier == record['source']['controllerId'] and record['decision'] != 'commit'):
                    raise fail()
                self.change(['update', '--restart', 'no', identifier])
                if raw['State'].get('Running'):
                    self.change(['stop', identifier])
                # No --volumes and no filesystem cleanup: the root/Node durable
                # commit has already decided data ownership independently.
                self.change(['rm', identifier])
            record['cleaned'][role] = identifier
            self.manager.save(record)

    def retire_auxiliary(self, record):
        if self.manager.read(record['id'])['phase'] not in {'complete', 'rolled-back'}:
            raise fail()
        if record['decision'] == 'commit':
            self.assert_active(record)
            roles = [('previous', record['source']['controllerId'], record['source']['definition'], '/orbis-retained-' + record['id'] + '-previous', False)]
        elif record['decision'] == 'rollback':
            self.restore_original_controller(record)
            roles = [('candidate', record.get('candidateId'), record.get('definitions', {}).get('candidate'), '/orbis-retained-' + record['id'] + '-candidate', False)]
        else:
            raise fail()
        roles.extend((role, record.get(field), record.get('definitions', {}).get(role), '/orbis-retained-' + record['id'] + '-' + role, False)
                     for role, field in (('verifier', 'verifierId'), ('coordinator', 'workerId')))
        roles.extend(('provisional-' + role, item['id'], item['definition'], '/orbis-restore-' + record['id'] + '-' + role, True)
                     for role, item in record.get('stage', {}).get('provisional', {}).items())
        self.retire_roles(record, roles)

    def restart_coordinator(self, record):
        self.validate_worker(record)
        raw = self.inspect(record['workerId'])
        if raw['State'].get('Running'):
            self.change(['stop', raw['Id']])
        self.change(['start', raw['Id']])

    def restore_original_controller(self, record):
        if record['decision'] == 'commit':
            raise fail()
        source = record['source']
        for name, expected in source['files'].items():
            if self.host.file_digest(self.root / name) != expected:
                raise fail()
        raw = self.inspect(source['controllerId'])
        self.verify_networks(record, raw)
        if raw['Name'] != '/runtipi' or self.definition(raw) != source['definition']:
            raise fail()
        if not raw['State'].get('Running'):
            self.change(['start', raw['Id']])
        policy = source['container']['HostConfig']['RestartPolicy']
        flag = policy['Name'] + (':' + str(policy['MaximumRetryCount']) if policy['Name'] == 'on-failure' else '')
        self.change(['update', '--restart', flag, raw['Id']])
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            current = self.inspect(raw['Id'])
            self.verify_networks(record, current)
            state = current['State']
            if self.definition(current) != source['definition'] or current['Name'] != '/runtipi':
                raise fail()
            if state.get('Running') is True and not state.get('Paused') and not state.get('Restarting') and (state.get('Health') or {}).get('Status') == 'healthy':
                return
            time.sleep(0.5)
        raise fail()
