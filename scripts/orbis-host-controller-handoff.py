"""Fixed Root transaction for parking and resuming the enrolled Orbis controller."""

from contextlib import ExitStack, contextmanager, nullcontext
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import select
import socket
import struct
import subprocess
import sys
import threading
import time
from types import ModuleType
import uuid

SCHEMA = 'orbis.controller-recovery-handoff.v1'
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
HASH = re.compile(r'[a-f0-9]{64}')
IMAGE = re.compile(r'sha256:[a-f0-9]{64}')
TIME = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z', re.ASCII)
PHASES = {'planned', 'accepted', 'stopping', 'held', 'return-accepted', 'returning', 'complete', 'cancelled'}
PENDING = {'accepted', 'stopping', 'return-accepted', 'returning'}
TERMINAL = {'complete', 'cancelled'}
TTL_MS = 5 * 60 * 1000
APPROVAL_TTL_MS = 60 * 1000
OPERATION_ERRORS = (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.SubprocessError)
PORTAL_ASSETS = ('recovery.html', 'recovery.css', 'recovery.js')

# Only these verified package modules are needed for the independent HTTPS
# observation. The isolated package has no filesystem import search path.
PORTAL_MODULES = (
    'collector_execution', 'recovery_worker', 'recovery_worker_provision',
    'recovery_listener_install', 'contracts', 'telemetry', 'collector', 'status',
    'observer', 'recovery_gateway', 'recovery_https_edge', 'recovery_https_install',
    'recovery_backend_tls', 'bootstrap_control',
)
RETURN_PORTAL_MODULES = ('controller_return_transport', 'controller_return_readiness')


def require(condition, message='The controller recovery handoff needs review.'):
    if not condition:
        raise ValueError(message)


def matches(pattern, value):
    return type(value) is str and pattern.fullmatch(value) is not None


def timestamp(value):
    require(matches(TIME, value))
    seconds, _, fraction = value[:-1].partition('.')
    require(seconds != '0001-01-01T00:00:00')
    return seconds, fraction.ljust(9, '0')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def root_operator(connection):
    """The return route is for a Root process in the Host namespaces."""
    if sys.platform != 'linux' or os.geteuid() != 0:
        return False
    try:
        pid, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if pid <= 0 or uid != 0:
            return False
        namespaces = ('pid', 'mnt', 'user')
        before = tuple(os.stat(f'/proc/{pid}/ns/{name}') for name in namespaces)
        own = tuple(os.stat(f'/proc/self/ns/{name}') for name in namespaces)
        return all(os.path.samestat(peer, helper) and os.path.samestat(peer, os.stat(f'/proc/{pid}/ns/{name}'))
                   for name, peer, helper in zip(namespaces, before, own))
    except (OSError, ValueError, struct.error):
        return False


@contextmanager
def recovery_peer(connection):
    """Hold the kernel's original AF_UNIX peer identity across qualification."""
    require(sys.platform == 'linux' and os.geteuid() == 0)
    try:
        pid, uid, gid = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    except (AttributeError, struct.error) as error:
        raise ValueError('The recovery listener peer is unavailable.') from error
    require(pid > 0 and uid == gid == 0)
    # Linux UAPI, including AMD64 and ARM64. Older Python may lack the name.
    # A numeric PID alone could refer to a replacement after the peer exits.
    fd = connection.getsockopt(socket.SOL_SOCKET, getattr(socket, 'SO_PEERPIDFD', 77))
    try:
        os.set_inheritable(fd, False)
        poll = select.poll()
        poll.register(fd, select.POLLIN)

        def check(expected_pid):
            require(pid == expected_pid and not poll.poll(0))
            with open(f'/proc/self/fdinfo/{fd}', 'rb') as info:
                body = info.read(4097)
            require(len(body) <= 4096 and re.findall(rb'(?m)^Pid:[ \t]+(-?[0-9]+)$', body)
                    == [str(pid).encode()] and not poll.poll(0))

        check(pid)
        yield check
    finally:
        os.close(fd)


class ControllerProvider:
    """Use current enrolled Core, managed floor and installed recovery providers."""

    def __init__(self, service, product, peer, boot_id):
        self.service, self.host, self.product, self.peer = service, service.HOST, product, peer
        self.boot_id = boot_id
        self.supervisor = product.Supervisor(service)
        self.docker = product.OriginObservations(service)
        self._return_probe_lock = threading.Lock()
        self._return_probe = None

    def producer(self, connection):
        return self.peer.admit(self.service, connection, host=self.host, enrollment=self.service.current_manifest)

    def _local(self, arguments):
        # These callers provide fixed observations or one verified full ID.
        return self.host.run(['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C', '/usr/bin/docker',
                              '--config', str(self.product.HOST_SOURCE), '--host', 'unix:///var/run/docker.sock',
                              *arguments], self.service.root)

    def _daemon(self):
        selected = self.docker.local_daemon()
        value = self._local(['info', '--format', '{{json .ID}}'])
        require(value.returncode == 0 and len(value.stdout) <= 4096)
        require(self.product.C.json_body(('{"id":' + value.stdout + '}').encode())['id'] == selected)
        return selected

    def current(self):
        token = self.host.CAPTURE_READ_DEADLINE.set(time.monotonic() + 20)
        try:
            return self._current()
        finally:
            self.host.CAPTURE_READ_DEADLINE.reset(token)

    def _current(self):
        root, context = self.service.root, self.service.context
        daemon = self._daemon()
        manifest = self.service.current_manifest()
        expected_reference = self.host.controller_reference(root, manifest, context)
        raw = self.docker.inspect('runtipi')
        image_id = raw['Image']
        config, state = raw['Config'], raw['State']
        labels = config['Labels']
        origins = [item.split('=', 1)[1] for item in config['Env'] if item.startswith('ORBIS_SENTINEL_RECOVERY_ORIGIN=')]
        require(matches(HASH, raw['Id']) and matches(IMAGE, image_id) and raw['Name'] == '/runtipi'
                and labels['com.docker.compose.project'] == labels['com.docker.compose.service'] == 'runtipi'
                and labels['com.docker.compose.project.working_dir'] == str(root)
                and labels['io.orbis.credential-writer-protocol'] == self.product.MAIN_PROTOCOL
                and config['Image'] == expected_reference and len(origins) == 1)
        image = self.docker.runtime.image(image_id)
        require(image['Id'] == image_id and (image_id == expected_reference
                or expected_reference in (image.get('RepoDigests') or [])))
        restart = raw['HostConfig']['RestartPolicy']
        require(restart in ({'Name': name, 'MaximumRetryCount': 0} for name in ('', 'no', 'unless-stopped'))
                and raw['HostConfig']['AutoRemove'] is False
                and all(state[key] is False for key in ('Paused', 'Restarting', 'Dead'))
                and type(raw['RestartCount']) is int and raw['RestartCount'] >= 0
                and type(state['Pid']) is int)
        running = state['Running'] is True and state['Status'] == 'running' and state['Pid'] > 0
        stopped = state['Running'] is False and state['Status'] == 'exited' and state['Pid'] == 0
        require(running or stopped)
        timestamp(state['StartedAt'])
        if stopped:
            require(timestamp(state['FinishedAt']) > timestamp(state['StartedAt']))
        origin = origins[0]
        self.product._origin(origin)
        return {
            'boot': self.boot_id(), 'daemon': daemon, 'id': raw['Id'], 'origin': origin,
            'main': {'imageId': image_id, 'publicationSha256': self.product.digest(manifest),
                     'creationSha256': self.product.digest({key: raw[key] for key in
                                                           ('Config', 'HostConfig', 'Mounts', 'Path', 'Args')})},
            'startedAt': state['StartedAt'], 'finishedAt': state['FinishedAt'],
            'restartCount': raw['RestartCount'], 'pid': state['Pid'],
            'state': 'stopped' if stopped else 'healthy' if (state.get('Health') or {}).get('Status') == 'healthy' else 'starting',
        }

    def _portal_modules(self, runtime, modules, resources):
        product = self.product
        receipt = product.C.PinnedFile(product.STATE / 'installed.json', limit=product.MAXIMUM, private=True)
        resources.callback(receipt.close)
        require(product.digest(receipt.body) == runtime['receiptSha256'])
        inventory = product.C.json_body(receipt.body)['files']
        names = PORTAL_MODULES
        if 'src/orbis_sentinel/controller_return.py' in inventory:
            names = ('controller_return', *names)
        if 'src/orbis_sentinel/controller_return_readiness.py' in inventory:
            gateway = names.index('recovery_gateway')
            names = (*names[:gateway], *RETURN_PORTAL_MODULES, *names[gateway:])
        pins = {}
        for short in names:
            name = 'src/orbis_sentinel/' + short + '.py'
            pin = product.C.PinnedFile(Path(runtime['runtimeDirectory']) / (short + '.py'), limit=262144)
            resources.callback(pin.close)
            desc = inventory[name]
            require(len(pin.body) == desc['bytes'] and product.digest(pin.body) == desc['sha256'])
            pins[short] = pin
        package = modules['recovery_sessions'].__package__
        parent = sys.modules[package]
        installed = []
        try:
            for short, pin in pins.items():
                pin.verify()
                key = package + '.' + short
                if key not in sys.modules:
                    module = ModuleType(key)
                    module.__file__, module.__package__ = str(pin.path), package
                    sys.modules[key] = module
                    installed.append(short)
                    exec(compile(pin.body, str(pin.path), 'exec', dont_inherit=True), module.__dict__)
                    setattr(parent, short, module)
                pin.verify()
            receipt.verify()
        except BaseException:
            for short in reversed(installed):
                sys.modules.pop(package + '.' + short, None)
                if hasattr(parent, short):
                    delattr(parent, short)
            raise
        assets = {name: inventory['web/' + name]['sha256'] for name in PORTAL_ASSETS}
        return {short: sys.modules[package + '.' + short] for short in pins}, assets

    @contextmanager
    def qualification(self, core, *, portal):
        with self._qualification(core, portal=portal) as (proof, check, _):
            yield proof, check

    @contextmanager
    def park_qualification(self, core):
        with self._qualification(core, portal=True, before_stop=True) as qualified:
            yield qualified

    @contextmanager
    def return_qualification(self, core, connection):
        with recovery_peer(connection) as peer, self._qualification(core, portal=True, listener_peer=peer) as held:
            yield held

    @contextmanager
    def _qualification(self, core, *, portal, listener_peer=None, before_stop=False):
        """Hold a stable managed floor and, before stop, prove the independent portal."""
        product, service = self.product, self.service
        require(service.state_dir == self.supervisor.layout.STATE_ROOT)
        require(self.supervisor.layout.read(service.root, core['daemon'], service.context) is not None)
        with ExitStack() as resources:
            runtime, modules, check_runtime = resources.enter_context(self.supervisor._held_runtime(storage_floor=True))
            floor = modules['credential_floor']
            reader = floor.CredentialFloorReader(service.root, service.context, core['daemon'],
                                                 host_state_directory=service.state_dir)
            snapshot = resources.enter_context(reader.snapshot())
            require(snapshot.report.classification == 'record-consistent' and snapshot._value['schema'] == floor.SCHEMA
                    and snapshot._value['mode'] == 'managed',
                    'Complete managed Sentinel enrollment before restarting to recovery.')
            history = snapshot._value
            current = history['current']
            require(current['main'] == core['main'] and current['recoveryOrigin'] == core['origin']
                    and all(current['sentinel'][key] == runtime[key] for key in ('version', 'inventorySha256'))
                    and current['sentinel']['runtimeSha256'] == product.digest(runtime['runtimeFiles']))
            namespace = self.supervisor.layout.namespace(service.root)
            admission = product.Admission(service)
            dependencies = {'namespace': str(namespace)}
            journal = admission._journal(dependencies, modules, history=history)
            require(journal is not None)
            result = {'floor': snapshot.report.history_sha256, 'installationId': history['installationId']}
            return_deadline = None
            client = None
            if portal:
                extra, assets = self._portal_modules(runtime, modules, resources)
                observe_portal = getattr(extra['recovery_listener_install'], 'held_controller_handoff_portal', None)
                require(callable(observe_portal), 'The paired Sentinel recovery provider is unavailable.')
                if before_stop:
                    verify_return = getattr(extra['recovery_listener_install'], 'verify_controller_return_portal', None)
                    readiness = extra.get('controller_return_readiness')
                    require(callable(verify_return) and readiness is not None,
                            'Install Sentinel with independent controller return before parking Orbis.')
                listener, check_listener = resources.enter_context(self.supervisor.bootstrap_recovery(
                    core['origin'], core['main'], runtime, modules, installation_id=history['installationId']))
                pid = listener['process']['pid']
                if listener_peer is not None:
                    listener_peer(pid)
                config = resources.enter_context(modules['recovery_config'].RecoveryConfig(str(product.RECOVERY_CONFIG)))
                marker = product.C.PinnedFile(product.RECOVERY_SETUP, limit=16384, private=True)
                resources.callback(marker.close)
                require(listener['unitSha256'] == current['sentinel']['unitSha256']
                        and listener['environmentSha256'] == current['sentinel']['environmentSha256']
                        and listener['configSha256'] == current['configuration']['recoveryConfigSha256']
                        and config.data['origin'] == core['origin'] and config.data['imageId'] == core['main']['imageId'])
                client = extra['bootstrap_control'].RootBootstrapControlClient(
                    str(product.RECOVERY / 'bootstrap-control.sock'), timeout=3, expected_pid=pid)

                def enrolled():
                    require(client.call('bootstrap-enrollment-state', {}) == {'origin': core['origin'], 'stage': 'activated'},
                            'Activate the Orbis sign-in and confirm the saved emergency key in Sentinel first.')

                def listener_socket():
                    return extra['recovery_https_install'].socket_identity(
                        listener['process']['pid'], '127.0.0.1', config.data['listenPort'])

                backend_socket = listener_socket()
                enrolled()
                self._anchor(core, current, extra['recovery_worker_provision'])
                proof, check_portal = resources.enter_context(observe_portal(config, marker.body, assets))
                require(HASH.fullmatch(proof['certificateSha256']))
                result['portal'] = product.digest({'proof': proof, 'listener': listener, 'socket': backend_socket})

            def check():
                check_runtime()
                snapshot.recheck()
                require(admission._journal(dependencies, modules, history=history) == journal)
                if portal:
                    check_portal()
                    check_listener()
                    config.verify()
                    marker.verify()
                    require(listener_socket() == backend_socket)
                    enrolled()
                    self._anchor(core, current, extra['recovery_worker_provision'])
                    if listener_peer is not None:
                        listener_peer(pid)
                if before_stop and return_deadline is not None:
                    require(time.monotonic() < return_deadline, 'Controller return readiness expired.')

            def check_return():
                nonlocal return_deadline
                request = readiness.readiness_request({
                    'challenge': secrets.token_hex(32), 'installationId': history['installationId'],
                    'invocationId': listener['process']['invocationId'], 'markerSha256': product.digest(marker.body),
                })
                deadline = self._prove_return_readiness(
                    request, pid, client, readiness.PROBE_SECONDS,
                    lambda arm: verify_return(config, marker.body, proof, request, arm))
                check_listener()
                marker.verify()
                require(listener_socket() == backend_socket and time.monotonic() < deadline)
                return_deadline = deadline
                return deadline

            yield result, check, check_return if before_stop else client
            check()

    def _prove_return_readiness(self, request, pid, client, timeout, exchange):
        deadline = time.monotonic() + timeout
        def arm():
            with self._return_probe_lock:
                require(self._return_probe is None and time.monotonic() < deadline)
                self._return_probe = request, pid, deadline, False
            require(client.call('controller-return-readiness-arm', request) == request)

        try:
            exchange(arm)
            with self._return_probe_lock:
                challenge = self._return_probe
                require(challenge is not None and challenge[:2] == (request, pid)
                        and challenge[3] and time.monotonic() < challenge[2],
                        'The paired browser controller return path is unavailable.')
                return challenge[2]
        finally:
            with self._return_probe_lock:
                if self._return_probe is not None and self._return_probe[0] is request:
                    self._return_probe = None

    def return_readiness(self, connection, request):
        with self._return_probe_lock:
            challenge = self._return_probe
            require(challenge is not None and request == challenge[0] and not challenge[3]
                    and time.monotonic() < challenge[2])
            with recovery_peer(connection) as check:
                check(challenge[1])
                require(time.monotonic() < challenge[2])
                self._return_probe = (*challenge[:3], True)
        return {'schema': 'orbis.controller-return-readiness.v1', **request}

    def _anchor(self, core, current, worker):
        image = core['main']['imageId']
        raw = self.docker.reader._object(['container', 'inspect', '--format', '{{json .}}', worker._anchor_name(image)])
        state = raw['State']
        require(raw['Image'] == image and state['Status'] == 'created' and state['Pid'] == 0 and state['ExitCode'] == 0
                and all(state[key] is False for key in ('Running', 'Paused', 'Restarting', 'Dead')))
        require(self.product.digest({key: raw[key] for key in ('Id', 'Name', 'Image', 'Config', 'HostConfig', 'Mounts', 'Path', 'Args')})
                == current['authWorker']['anchorSha256'], 'The retained recovery sign-in worker is unavailable.')

    def effect(self, operation, core, *, before_dispatch):
        require(operation in ('stop', 'start') and matches(HASH, core['id']))
        arguments = ['container', operation, *(['--time', '30'] if operation == 'stop' else []), core['id']]
        token = self.host.CAPTURE_READ_DEADLINE.set(time.monotonic() + 45)
        try:
            require(self._daemon() == core['daemon'])
            before_dispatch()
            result = self._local(arguments)
            require(result.returncode == 0)
        finally:
            self.host.CAPTURE_READ_DEADLINE.reset(token)


class ControllerHandoff:
    def __init__(self, service, provider, read, write, *, clock=time.time, sleep=time.sleep):
        self.service, self.provider, self.host = service, provider, service.HOST
        self.read, self.write, self.clock, self.sleep = read, write, clock, sleep
        self.workers = set()
        self.worker_lock = threading.Lock()

    @property
    def selector(self):
        return self.host.controller_handoff_path(self.service.root)

    @contextmanager
    def _directory(self):
        # The credential fence's path pin permits owned content changes and
        # rechecks the protected ancestry and mount identity on exit.
        with self.host.CREDENTIAL_FENCE._directory(self.selector.parent, protected=True) as directory:
            yield directory.fd

    def _selected(self):
        with self._directory() as directory:
            try:
                with self.host.AUTHORITY.protected_file(directory, self.selector.name, 64) as body:
                    identifier = body.decode('ascii').strip()
            except FileNotFoundError:
                return None
        require(matches(UUID, identifier) and body == (identifier + '\n').encode('ascii'))
        return identifier

    def _record(self, identifier):
        require(matches(UUID, identifier), 'Choose one reviewed controller recovery handoff.')
        path = self.selector.with_name(f'controller-recovery-{identifier}.json')
        with self._directory() as directory:
            with self.host.AUTHORITY.protected_file(directory, path.name, 16384) as body:
                record = self.read(body)
        require(type(record) is dict)
        require(set(record) - {'returnClaimId'} ==
                {'schema', 'id', 'root', 'context', 'phase', 'expiresAtMs', 'source', 'proof', 'stoppedAt', 'returnedStartedAt'}
                and record['schema'] == SCHEMA and record['id'] == identifier and record['root'] == str(self.service.root)
                and record['context'] == self.service.context and record['phase'] in PHASES and type(record['expiresAtMs']) is int
                and matches(HASH, record['proof']['floor']) and matches(HASH, record['proof']['portal'])
                and matches(HASH, record['proof']['installationId']) and matches(HASH, record['source']['id']))
        require((matches(TIME, record['stoppedAt']) if record['phase'] in {'held', 'return-accepted', 'returning', 'complete'}
                 else record['stoppedAt'] is None)
                and ((record['returnedStartedAt'] is None and record['phase'] != 'complete')
                or (record['phase'] == 'complete' and matches(TIME, record['returnedStartedAt']))))
        if 'returnClaimId' in record:
            require(record['phase'] in {'return-accepted', 'returning', 'complete'}
                    and matches(HASH, record['returnClaimId']))
        return record

    def _save(self, record):
        path = self.selector.with_name(f"controller-recovery-{record['id']}.json")
        with self._directory():
            self.write(path, record)

    def _move(self, record, phase, *, stopped=None, returned=None):
        record = {**record, 'phase': phase, 'stoppedAt': stopped or record['stoppedAt'], 'returnedStartedAt': returned}
        self._save(record)
        return record

    def _select(self, identifier):
        # The Host lock serializes selectors. Publish only complete, durable
        # bytes; an interrupted temporary write must not create a lifecycle hold.
        temporary = '.controller-recovery-selector-' + uuid.uuid4().hex
        with self._directory() as directory:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write((identifier + '\n').encode('ascii'))
                    stream.flush()
                    os.fsync(stream.fileno())
                require(self._selected() is None)
                os.rename(temporary, self.selector.name, src_dir_fd=directory, dst_dir_fd=directory)
                os.fsync(directory)
            finally:
                try:
                    os.unlink(temporary, dir_fd=directory)
                except FileNotFoundError:
                    pass

    def _clear(self, identifier):
        require(self._selected() == identifier and self._record(identifier)['phase'] in TERMINAL)
        with self._directory() as directory:
            os.unlink(self.selector.name, dir_fd=directory)
            os.fsync(directory)

    @contextmanager
    def _locked(self, identifier=None):
        require(self.service.lock.acquire(blocking=False), 'Another Host operation is in progress. Try again shortly.')
        try:
            owner = self.host.controller_handoff_owner(self.service.root, identifier) if identifier else nullcontext()
            with owner, self.host.host_lock(self.service.root):
                self.service.require_idle_core()
                yield
        finally:
            self.service.lock.release()

    @staticmethod
    def _same_core(record, current, *, returning=False):
        source = record['source']
        counts = (source['restartCount'], 0) if returning and current['state'] != 'stopped' else (source['restartCount'],)
        require(all(current[key] == source[key] for key in ('boot', 'daemon', 'id', 'origin', 'main'))
                and current['restartCount'] in counts,
                'The enrolled controller runtime changed. Review the handoff on the host.')
        return source

    def _stopped(self, record, current):
        source = self._same_core(record, current)
        return (current['state'] == 'stopped' and current['startedAt'] == source['startedAt']
                and timestamp(current['finishedAt']) > timestamp(source['startedAt'])
                and record['stoppedAt'] in (None, current['finishedAt']))

    def _returned(self, record, current):
        source = self._same_core(record, current, returning=True)
        return (current['state'] == 'healthy' and current['startedAt'] != source['startedAt']
                and timestamp(current['startedAt']) > timestamp(record['stoppedAt']) > timestamp(source['startedAt']))

    @staticmethod
    def _public(record, state=None):
        return {'version': 1, 'planId': record['id'], 'state': state or record['phase'],
                'phase': record['phase'], 'portalUrl': record['source']['origin'] + '/sentinel/recovery/',
                'expiresAtMs': record['expiresAtMs']}

    def _progress(self, record):
        phase = record['phase']
        with self.worker_lock:
            active = record['id'] in self.workers
        if phase in PENDING and not active:
            return self._public(record, 'attention')
        expects_hold = phase not in TERMINAL and phase != 'planned'
        try:
            if (self._selected() == record['id']) != expects_hold:
                return self._public(record, 'attention')
        except OPERATION_ERRORS:
            return self._public(record, 'attention')
        if phase == 'held':
            try:
                if not self._stopped(record, self.provider.current()):
                    return self._public(record, 'attention')
            except OPERATION_ERRORS:
                return self._public(record, 'attention')
        return self._public(record)

    def review(self, connection, request):
        require(request == {}, 'Controller recovery review does not accept options.')
        with self._locked(), self.provider.producer(connection) as peer:
            core = self.provider.current()
            self._check_producer(peer, core)
            require(core['state'] == 'healthy', 'A healthy enrolled Orbis controller is required.')
            with self.provider.park_qualification(core) as (proof, check, check_return):
                check()
                self._check_producer(peer, core)
                require(self.provider.current() == core)
                readiness_deadline = check_return()
            record = {'schema': SCHEMA, 'id': str(uuid.uuid4()), 'root': str(self.service.root),
                      'context': self.service.context, 'phase': 'planned', 'source': core, 'proof': proof,
                      'expiresAtMs': int(self.clock() * 1000) + TTL_MS, 'stoppedAt': None, 'returnedStartedAt': None}
            require(time.monotonic() < readiness_deadline, 'Controller return readiness expired.')
            self._save(record)
            return self._public(record)

    def _check_producer(self, peer, core):
        peer.verify()
        identity = peer.identity()
        binding = peer.installation_binding()
        require(identity['controllerId'] == core['id'] and identity['imageId'] == core['main']['imageId']
                and binding['root'] == str(self.service.root) and binding['context'] == self.service.context
                and binding['daemon'] == core['daemon'])
        # The held v3 floor/storage bridge establishes its stable installation ID.
        # ControllerPeer separately proves the current live root/context/daemon.
        peer.verify()

    def apply(self, connection, identifier):
        with self._locked(identifier), self.provider.producer(connection) as peer:
            record = self._record(identifier)
            core = self.provider.current()
            self._check_producer(peer, core)
            if record['phase'] not in ('planned', 'accepted'):
                return self._progress(record), None
            require(core == record['source'] and (record['phase'] == 'accepted' or int(self.clock() * 1000) < record['expiresAtMs']),
                    'The reviewed controller or recovery readiness expired. Review a new handoff.')
            selected = self._selected()
            require(selected == identifier or (selected is None and record['phase'] == 'planned'))
            with self.provider.park_qualification(core) as (proof, check, check_return):
                self._verify_entry(record, core, proof, check)
                self._check_producer(peer, core)
                readiness_deadline = check_return()
            require(time.monotonic() < readiness_deadline
                    and (record['phase'] != 'planned' or int(self.clock() * 1000) < record['expiresAtMs']),
                    'Controller recovery review expired. Review a new handoff.')
            if selected is None:
                self._select(identifier)
            if record['phase'] == 'planned':
                record = self._move(record, 'accepted')
            return self._public(record), self._reserve(identifier, self._park)

    def _verify_entry(self, record, core, proof, check):
        require(proof == record['proof'], 'The independent recovery portal changed. Review the handoff again.')
        check()
        require(core == record['source'] == self.provider.current())

    def status(self, identifier):
        return self._progress(self._record(identifier))

    @staticmethod
    def return_scope(record):
        plan, installation = record['id'], record['proof']['installationId']
        require(matches(UUID, plan) and matches(HASH, installation) and matches(TIME, record['stoppedAt']))
        return {'planId': plan, 'installationId': installation,
                'handoffSha256': digest({key: record[key] for key in ('root', 'context', 'source', 'proof', 'stoppedAt')})}

    def _claim_return(self, client, arguments, check):
        started = time.monotonic()
        wall_started = int(self.clock() * 1000)
        reply = client.call('controller-return-claim', arguments)
        fields = {'approved', 'expiresAtMs', 'principal', 'method', 'revision'} | arguments.keys()
        require(type(reply) is dict and set(reply) == fields and reply['approved'] is True
                and all(reply[key] == value for key, value in arguments.items())
                and (reply['principal'], reply['method']) in (('recovery-key', 'recovery-key'),
                                                             ('orbis-operator', 'password'), ('orbis-operator', 'passkey'))
                and matches(HASH, reply['revision']) and type(reply['expiresAtMs']) is int)
        check()
        now = time.monotonic()
        wall_remaining = reply['expiresAtMs'] - int(self.clock() * 1000)
        elapsed_remaining = reply['expiresAtMs'] - wall_started - int((now - started) * 1000)
        require(0 < wall_remaining <= APPROVAL_TTL_MS and elapsed_remaining > 0)
        return now + min(wall_remaining, elapsed_remaining) / 1000, reply['expiresAtMs']

    def return_approved(self, connection, identifier, approval_id):
        require(matches(UUID, identifier) and matches(HASH, approval_id))
        with self._locked(identifier):
            record = self._record(identifier)
            phase = record['phase']
            require(phase in {'held', 'return-accepted', 'returning', 'complete'})
            selected = self._selected()
            require(selected == identifier or (phase == 'complete' and selected is None))
            scope = self.return_scope(record)
            # Deterministic for exactly one approval and held incarnation.
            # An IPC or journal reply can be lost before either side can tell.
            claim = digest(['orbis.controller-return-claim.v1', scope, approval_id])
            previous = record.get('returnClaimId')
            require(phase == 'held' or previous is not None)
            core = self.provider.current()
            if phase in {'held', 'return-accepted'}:
                require(self._stopped(record, core))
            else:
                self._same_core(record, core, returning=True)
                require(previous == claim)
            approval_deadline = None
            with self.provider.return_qualification(core, connection) as (proof, check, client):
                require(proof == record['proof'])
                check()
                require(self.provider.current() == core)
                if phase == 'complete':
                    require(self._returned(record, core) and core['startedAt'] == record['returnedStartedAt'])
                    if selected == identifier:
                        self._clear(identifier)
                    return self._public(record), None
                with self.worker_lock:
                    active = identifier in self.workers
                if active:
                    require(previous == claim)
                    return self._public(record), None
                if phase != 'returning':
                    def verify_held():
                        require(self.provider.current() == core and self._selected() == identifier)
                        check()

                    approval_deadline = self._claim_return(
                        client, {'scope': scope, 'approvalId': approval_id, 'claimId': claim}, verify_held)
                    record = self._move({**record, 'returnClaimId': claim}, 'return-accepted')
            return self._public(record), self._reserve(
                identifier, lambda plan: self._return(plan, approved=True, approval_deadline=approval_deadline))

    def _reserve(self, identifier, target):
        with self.worker_lock:
            if identifier in self.workers:
                return None
            self.workers.add(identifier)

        def run():
            try:
                target(identifier)
            except OPERATION_ERRORS:
                # Keep the last intent; status shows attention when its worker is gone.
                pass
            finally:
                with self.worker_lock:
                    self.workers.discard(identifier)

        def launch():
            try:
                threading.Thread(target=run, daemon=True).start()
            except RuntimeError:
                with self.worker_lock:
                    self.workers.discard(identifier)

        return launch

    def _attempt(self, operation, current, before_dispatch):
        try:
            self.provider.effect(operation, current, before_dispatch=before_dispatch)
        except OPERATION_ERRORS:
            # Docker may have accepted the request before the transport failed.
            # Only a later observation can settle the intent.
            pass

    def _park(self, identifier):
        with self._locked(identifier):
            record = self._record(identifier)
            require(self._selected() == identifier and record['phase'] == 'accepted')
            core = self.provider.current()
            with self.provider.park_qualification(core) as (proof, check, check_return):
                self._verify_entry(record, core, proof, check)
                def dispatch():
                    check()
                    require(self.provider.current() == core)
                    readiness_deadline = check_return()
                    require(time.monotonic() < readiness_deadline, 'Controller return readiness expired.')
                    self._move(record, 'stopping')
                self._attempt('stop', core, dispatch)
            record = self._record(identifier)
            if record['phase'] != 'stopping':
                return
            stopped = self.provider.current()
            require(self._stopped(record, stopped))
            with self.provider.qualification(stopped, portal=True) as (proof, check):
                require(proof == record['proof'])
                check()
                require(self.provider.current() == stopped)
            self._move(record, 'held', stopped=stopped['finishedAt'])

    def return_to_orbis(self, identifier):
        with self._locked(identifier):
            record = self._record(identifier)
            selected = self._selected()
            if record['phase'] in TERMINAL:
                if selected == identifier:
                    self._clear(identifier)
                return self._public(record), None
            require(selected == identifier)
            with self.worker_lock:
                if identifier in self.workers:
                    return self._public(record), None
            core = self.provider.current()
            source = self._same_core(record, core, returning=record['phase'] == 'returning')
            if record['phase'] in ('planned', 'accepted') and core == source:
                record = self._move(record, 'cancelled')
                self._clear(identifier)
                return self._public(record), None
            if record['phase'] == 'stopping' and self._stopped(record, core):
                record = self._move(record, 'held', stopped=core['finishedAt'])
            if record['phase'] == 'held':
                require(self._stopped(record, core))
                record = self._move(record, 'return-accepted')
            require(record['phase'] == 'returning' or (record['phase'] == 'return-accepted' and self._stopped(record, core)))
            # Replaying a durable returning intent only observes. A new start is
            # allowed exclusively in the worker for a confirmed held controller.
            return self._public(record), self._reserve(identifier, self._return)

    def _return(self, identifier, *, approved=False, approval_deadline=None):
        with self._locked(identifier):
            record = self._record(identifier)
            require(self._selected() == identifier and record['phase'] in ('return-accepted', 'returning'))
            if approved:
                require(matches(HASH, record.get('returnClaimId')))
            core = self.provider.current()
            self._same_core(record, core, returning=record['phase'] == 'returning')
            portal = approved and record['phase'] == 'return-accepted'
            expected = record['proof'] if portal else {key: record['proof'][key] for key in ('floor', 'installationId')}
            with self.provider.qualification(core, portal=portal) as (proof, check):
                require(proof == expected)
                check()
                if record['phase'] == 'return-accepted':
                    require(self._stopped(record, core) and self.provider.current() == core)
                    def dispatch():
                        if portal:
                            require(self.provider.current() == core)
                        check()
                        if portal:
                            require(approval_deadline is not None
                                    and time.monotonic() < approval_deadline[0]
                                    and int(self.clock() * 1000) < approval_deadline[1])
                        self._move(record, 'returning')
                    self._attempt('start', core, dispatch)
                    record = self._record(identifier)
                    if record['phase'] != 'returning':
                        return
                deadline = time.monotonic() + 45
                while not self._returned(record, current := self.provider.current()):
                    if current['state'] == 'stopped' or time.monotonic() >= deadline:
                        return
                    self.sleep(1)
                check()
                require(self.provider.current() == current)
            self._move(record, 'complete', returned=current['startedAt'])
            self._clear(identifier)
