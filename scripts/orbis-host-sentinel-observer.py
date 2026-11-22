"""Read-only, narrowly scoped observer over an inherited Unix listener."""
from contextlib import contextmanager
import json
import math
import os
import re
import select
import socket
import stat
import struct
import subprocess
import threading
import time

_MAX_JSON = 16384
_MAX_SAFE = 2**53 - 1
_UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', re.ASCII)
_TAG = re.compile(r'v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?', re.ASCII)
_CAPTURE_ROUTE = re.compile(rb'/v2/core-captures/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})/progress')
CAPTURE_CAPABILITY = {'schema': 'orbis.sentinel-observer.capture.v1', 'protocolVersion': 1, 'kind': 'core-capture-progress'}
COMPONENT_CAPABILITY = {'schema': 'orbis.sentinel-observer.component.v1', 'protocolVersion': 1, 'kind': 'core-component-status'}
_VERSION = re.compile(r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\Z', re.ASCII)


def validate_component(value):
    if (type(value) is not dict or set(value) != {'installedVersion', 'availableVersion', 'state'}
            or value['availableVersion'] is not None
            or type(value['state']) is not str
            or value['state'] not in {'unknown', 'healthy', 'unavailable', 'updating', 'recovering'}):
        raise ValueError('Component status is unavailable')
    version = value['installedVersion']
    if version is not None and (type(version) is not str or len(version) > 128 or not _VERSION.fullmatch(version)):
        raise ValueError('Component status is unavailable')
    return dict(value)


_HANDOFF_STATES = ('accepted', 'stopping', 'held', 'returning', 'complete', 'attention')
_HASH = re.compile(r'[a-f0-9]{64}', re.ASCII)
_HANDOFF_ROUTE = b'/v4/controller-handoff/status'


def validate_handoff(value):
    if (type(value) is not dict or set(value) != {'version', 'handoff'}
            or type(value['version']) is not int or value['version'] != 1):
        raise ValueError('Handoff status is unavailable')
    handoff = value['handoff']
    if handoff is None:
        return {'version': 1, 'handoff': None}
    if (type(handoff) is not dict or type(handoff.get('state')) is not str
            or handoff['state'] not in _HANDOFF_STATES
            or type(handoff.get('planId')) is not str or not _UUID.fullmatch(handoff['planId'])):
        raise ValueError('Handoff status is unavailable')
    held = handoff['state'] == 'held'
    if set(handoff) != ({'planId', 'state', 'returnScope'} if held else {'planId', 'state'}):
        raise ValueError('Handoff status is unavailable')
    public = dict(handoff)
    if held:
        scope = handoff['returnScope']
        if (type(scope) is not dict or set(scope) != {'planId', 'installationId', 'handoffSha256'}
                or scope['planId'] != handoff['planId']
                or any(type(scope[key]) is not str or not _HASH.fullmatch(scope[key])
                       for key in ('installationId', 'handoffSha256'))):
            raise ValueError('Handoff status is unavailable')
        public['returnScope'] = dict(scope)
    return {'version': 1, 'handoff': public}


def _startup(value):
    seconds, _, fraction = value[:-1].partition('.')
    return seconds, fraction.ljust(9, '0')


class HandoffObservation:
    """Observe only the selector and, briefly, the exact plan it just selected."""

    def __init__(self, manager):
        self.load_manager = manager
        self.manager = None
        self.lock = threading.Lock()
        self.selected = None
        self.terminal_until = None

    @staticmethod
    @contextmanager
    def _installation(manager, record, current):
        # Use the protected floor reader directly. Action qualification also
        # opens the writer journal and can contact the public recovery edge.
        provider, service = manager.provider, manager.service
        if service.state_dir != provider.supervisor.layout.STATE_ROOT:
            raise ValueError('Handoff installation is unavailable')
        with provider.supervisor._held_runtime(storage_floor=True) as (runtime, modules, _):
            floor = modules['credential_floor']
            reader = floor.CredentialFloorReader(service.root, service.context, current['daemon'],
                                                 host_state_directory=service.state_dir)
            with reader.snapshot() as snapshot:
                history = snapshot._value
                entry = history['current']
                if (snapshot.report.classification != 'record-consistent' or history['schema'] != floor.SCHEMA
                        or history['mode'] != 'managed' or snapshot.report.history_sha256 != record['proof']['floor']
                        or history['installationId'] != record['proof']['installationId']
                        or entry['main'] != current['main'] or entry['recoveryOrigin'] != current['origin']
                        or any(entry['sentinel'][key] != runtime[key] for key in ('version', 'inventorySha256'))
                        or entry['sentinel']['runtimeSha256'] != provider.product.digest(runtime['runtimeFiles'])):
                    raise ValueError('Handoff installation is unavailable')
                yield

    def __call__(self, deadline):
        # Abandoned clients cannot accumulate concurrent Host inspections.
        if not self.lock.acquire(blocking=False):
            raise ValueError('Handoff observation is busy')
        try:
            if self.manager is None:
                self.manager = self.load_manager()
            manager = self.manager
            token = manager.host.CAPTURE_READ_DEADLINE.set(deadline)
            try:
                return self._observe(manager, deadline)
            finally:
                manager.host.CAPTURE_READ_DEADLINE.reset(token)
        finally:
            self.lock.release()

    def _observe(self, manager, deadline):
        idle = {'version': 1, 'handoff': None}
        selected = manager._selected()
        if selected is not None and (self.selected is None or selected != self.selected[0]):
            self.selected, self.terminal_until = None, None
        if selected is None and (self.selected is None
                                 or self.terminal_until is not None and time.monotonic() >= self.terminal_until):
            self.selected, self.terminal_until = None, None
            return idle
        identifier = selected if selected is not None else self.selected[0]
        record = manager._record(identifier)
        binding = (identifier, record['source'], record['proof'])
        if self.selected is not None and binding != self.selected:
            raise ValueError('Handoff binding changed')
        phase = record['phase']
        if selected is None and phase == 'cancelled':
            self.selected, self.terminal_until = None, None
            return idle
        # Retain only an in-memory cursor, never the previous public result;
        # after selector retirement the same record and current identity are read again.
        if selected is not None:
            self.selected = binding
        elif phase == 'complete' and self.terminal_until is None:
            self.terminal_until = time.monotonic() + 300
        # The provider's unwrapped read uses this observer's tighter deadline.
        current = manager.provider._current()
        source = manager._same_core(record, current, returning=phase in ('returning', 'complete'))
        with self._installation(manager, record, current):
            state = 'attention'
            if phase == 'complete':
                if (selected is None and current['startedAt'] == record['returnedStartedAt']
                        and manager._returned(record, current)):
                    state = 'complete'
            elif selected is not None:
                with manager.worker_lock:
                    active = identifier in manager.workers
                original = (current['startedAt'] == source['startedAt']
                            and (current['state'] == 'stopped' or current['pid'] == source['pid']))
                if phase in ('held', 'return-accepted') and manager._stopped(record, current):
                    state = 'held'
                elif phase == 'accepted' and active and original and current['state'] == 'healthy':
                    state = 'accepted'
                elif phase == 'stopping' and active and original:
                    state = 'stopping'
                elif phase == 'returning' and active and (
                        manager._stopped(record, current) if current['state'] == 'stopped'
                        else _startup(current['startedAt']) > _startup(record['stoppedAt'])):
                    state = 'returning'
            handoff = {'planId': identifier, 'state': state}
            if state == 'held':
                return_scope = getattr(manager, 'return_scope', None)
                if not callable(return_scope):
                    raise ValueError('Handoff scope is unavailable')
                scope = return_scope(record)
                if scope['installationId'] != record['proof']['installationId']:
                    raise ValueError('Handoff installation changed')
                handoff['returnScope'] = scope
        if (manager.provider._current() != current
                or manager._record(identifier) != record or manager._selected() != selected
                or time.monotonic() >= deadline):
            raise ValueError('Handoff changed during observation')
        return validate_handoff({'version': 1, 'handoff': handoff})


def _inspect(root, context, arguments, deadline):
    """Cap stdout while reading and discard stderr; own and reap the fixed CLI child."""
    process = subprocess.Popen(['docker', '--context', context, *arguments], cwd=root,
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        output = bytearray()
        os.set_blocking(process.stdout.fileno(), False)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
                raise TimeoutError('Component inspection expired')
            try:
                block = os.read(process.stdout.fileno(), min(4096, _MAX_JSON + 1 - len(output)))
            except BlockingIOError:
                continue
            if not block:
                break
            output.extend(block)
            if len(output) > _MAX_JSON:
                raise ValueError('Component inspection exceeds limit')
        if process.wait(timeout=max(0.001, deadline - time.monotonic())) != 0:
            raise ValueError('Component inspection is unavailable')
        return json.loads(output)
    finally:
        if process.poll() is None:
            process.kill()
        try:
            process.wait(timeout=0.25)
        finally:
            process.stdout.close()


def observe_component(root, context):
    """Observe a fixed container and its immutable image, without reconciling state."""
    if type(context) is not str or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', context):
        raise ValueError('Component status is unavailable')
    deadline = time.monotonic() + 1.5
    labels = {'project': 'com.docker.compose.project', 'root': 'com.docker.compose.project.working_dir',
              'service': 'com.docker.compose.service'}
    fields = {'id': '.Id', 'image': '.Image', 'reference': '.Config.Image', 'state': '.State.Status'}
    template = '{' + ','.join('"' + key + '":{{json ' + value + '}}' for key, value in fields.items())
    template += ',' + ','.join('"' + key + '":{{json (index .Config.Labels "' + value + '")}}'
                                for key, value in labels.items())
    template += ',"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}'
    value = _inspect(root, context, ['inspect', '--type', 'container', '--format', template, 'runtipi'], deadline)
    if (type(value) is not dict or set(value) != {*fields, *labels, 'health'}
            or value['project'] != 'runtipi' or value['service'] != 'runtipi' or value['root'] != str(root)
            or type(value['id']) is not str or not re.fullmatch(r'[a-f0-9]{64}', value['id'])
            or type(value['image']) is not str or not re.fullmatch(r'sha256:[a-f0-9]{64}', value['image'])
            or type(value['reference']) is not str
            or not re.fullmatch(r'(?:ghcr\.io/twentylines/orbis@sha256:[a-f0-9]{64}|sha256:[a-f0-9]{64})', value['reference'])
            or type(value['state']) is not str or value['state'] not in {'created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'}
            or value['health'] not in (None, 'none', 'starting', 'healthy', 'unhealthy')):
        raise ValueError('Component status is unavailable')
    if value['reference'].startswith('sha256:') and value['reference'] != value['image']:
        raise ValueError('Component image differs from its creation reference')
    # Container labels can override image labels. Read version/source from the
    # image's immutable ID and bind registry references to its RepoDigests.
    template = ('{"id":{{json .Id}},"digests":{{json .RepoDigests}},'
                '"source":{{json (index .Config.Labels "org.opencontainers.image.source")}},'
                '"version":{{json (index .Config.Labels "org.opencontainers.image.version")}}}')
    image = _inspect(root, context, ['image', 'inspect', '--format', template, value['image']], deadline)
    if type(image) is dict and image.get('digests') is None:
        image = {**image, 'digests': []}
    if (type(image) is not dict or set(image) != {'id', 'digests', 'source', 'version'}
            or image['id'] != value['image'] or image['source'] != 'https://github.com/twentylines/orbis'
            or type(image['version']) is not str or not image['version'].startswith('v')
            or type(image['digests']) is not list or len(image['digests']) > 64
            or any(type(item) is not str or len(item) > 256 for item in image['digests'])
            or value['reference'].startswith('ghcr.io/') and value['reference'] not in image['digests']):
        raise ValueError('Component image metadata is unavailable')
    state = ('healthy' if value['state'] == 'running' and value['health'] == 'healthy'
             else 'recovering' if value['state'] == 'restarting'
             else 'unavailable' if value['state'] in {'paused', 'removing', 'exited', 'dead'}
                  or value['health'] == 'unhealthy' else 'unknown')
    return validate_component({'installedVersion': image['version'][1:], 'availableVersion': None, 'state': state})


def validate_capture(value, point):
    fields = {'version', 'id', 'state', 'phase', 'completedBytes', 'totalBytes', 'restartVerified'}
    phases = {'preparing', 'stopping-orbis', 'saving-orbis', 'starting-orbis',
              'stopping-apps', 'saving-apps', 'starting-apps', 'sealing', 'complete'}
    count = lambda x: type(x) is int and 0 <= x <= _MAX_SAFE
    if (type(value) is not dict or set(value) != fields or type(value['version']) is not int or value['version'] != 1
            or value['id'] != point or not _UUID.fullmatch(point)
            or type(value['state']) is not str or value['state'] not in {'waiting', 'running', 'recovery-required', 'complete'}
            or type(value['phase']) is not str or value['phase'] not in phases
            or not count(value['completedBytes']) or not (value['totalBytes'] is None or count(value['totalBytes']))
            or value['totalBytes'] is not None and value['completedBytes'] > value['totalBytes']
            or type(value['restartVerified']) is not bool
            or (value['state'] == 'complete') != (value['phase'] == 'complete')
            or value['restartVerified'] != (value['state'] == 'complete')):
        raise ValueError('Capture progress is unavailable')
    return dict(value)


def validate_progress(value):
    def count(x):
        return type(x) is int and 0 <= x <= _MAX_SAFE
    def invalid():
        raise ValueError('Unavailable')
    if type(value) is not dict or set(value) != {'version', 'job'} or type(value['version']) is not int or value['version'] != 1:
        invalid()
    job = value['job']
    if job is None:
        return {'version': 1, 'job': None}
    if type(job) is not dict or not {'id', 'state', 'targetTag', 'phase'} <= set(job) or set(job) - {'id', 'state', 'targetTag', 'phase', 'download'}:
        invalid()
    if (type(job['id']) is not str or not _UUID.fullmatch(job['id']) or
        type(job['targetTag']) is not str or len(job['targetTag']) > 100 or not _TAG.fullmatch(job['targetTag']) or
        job['state'] not in ('queued', 'running', 'recovering', 'complete', 'failed', 'interrupted') or
        job['phase'] not in (None, 'downloading', 'installing', 'restarting', 'verifying', 'recovering')):
        invalid()
    result = {key: job[key] for key in ('id', 'state', 'targetTag', 'phase')}
    if 'download' in job:
        d = job['download']
        keys = {'schema', 'phase', 'currentBytes', 'totalBytes', 'totalKnown', 'alreadyCached', 'layersComplete', 'layersTotal', 'updatedAt'}
        if type(d) is not dict or set(d) != keys:
            invalid()
        if (d['schema'] != 'orbis.download-progress.v1' or d['phase'] not in ('downloading', 'extracting', 'complete') or
            not count(d['currentBytes']) or not (d['totalBytes'] is None or count(d['totalBytes'])) or
            type(d['totalKnown']) is not bool or d['totalKnown'] != (d['totalBytes'] is not None) or
            (d['totalBytes'] is not None and d['currentBytes'] > d['totalBytes']) or
            type(d['alreadyCached']) is not bool or
            (d['alreadyCached'] and (d['phase'] != 'complete' or d['currentBytes'] != 0 or d['totalBytes'] != 0)) or
            not count(d['layersComplete']) or not count(d['layersTotal']) or
            d['layersComplete'] > d['layersTotal'] or d['layersTotal'] > 4096 or
            type(d['updatedAt']) not in (int, float) or not 0 < d['updatedAt'] <= _MAX_SAFE or not math.isfinite(d['updatedAt'])):
            invalid()
        result['download'] = dict(d)
    return {'version': 1, 'job': result}


def _stat_identity(st):
    return (st.st_dev, st.st_ino, st.st_uid, st.st_gid, st.st_mode, st.st_ctime_ns)


def _identity(path):
    if not os.path.isabs(path) or os.path.normpath(path) != path or os.path.realpath(path) != path:
        raise ValueError('Unavailable')
    parent = os.path.dirname(path)
    current = '/'
    ancestors = []
    for part in parent.split('/'):
        if not part:
            continue
        current = os.path.join(current, part)
        info = os.lstat(current)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Unavailable')
        ancestors.append(_stat_identity(info)[:-1])
    root = os.lstat('/')
    if root.st_uid != 0 or root.st_mode & 0o022:
        raise ValueError('Unavailable')
    directory = os.lstat(parent)
    endpoint = os.lstat(path)
    if (not stat.S_ISSOCK(endpoint.st_mode) or endpoint.st_uid != 0 or endpoint.st_gid <= 0 or
        stat.S_IMODE(endpoint.st_mode) != 0o660 or endpoint.st_nlink != 1):
        raise ValueError('Unavailable')
    return (_stat_identity(directory), _stat_identity(endpoint), (_stat_identity(root)[:-1], *ancestors))


def _peer(conn):
    return struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))[1:]


class ObserverServer:
    def __init__(self, listener, provider, *, capture_provider=None, component_provider=None, handoff_provider=None):
        if listener.family != socket.AF_UNIX or listener.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM or not self._is_listening(listener):
            raise ValueError('Unavailable')
        name = listener.getsockname()
        if not isinstance(name, str) or not name or name.startswith('\0'):
            raise ValueError('Unavailable')
        self.path = os.path.abspath(name)
        self.identity = self._identity(self.path)
        self.provider = provider
        self.capture_provider = capture_provider
        self.component_provider = component_provider
        self.handoff_provider = handoff_provider
        self.listener = listener.dup()
        self._stop = threading.Event()
        self._done = threading.Event()
        self._slots = threading.BoundedSemaphore(8)

    _is_listening = staticmethod(lambda listener: bool(listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN)))
    _identity = staticmethod(_identity)
    _peer = staticmethod(_peer)

    def serve_forever(self, poll_interval=0.1):
        try:
            while not self._stop.is_set():
                if not self._slots.acquire(timeout=min(poll_interval, 0.1)):
                    continue
                try:
                    ready, _, _ = select.select([self.listener], [], [], min(poll_interval, 0.1))
                    if not ready or self._stop.is_set():
                        self._slots.release()
                        continue
                    conn, _ = self.listener.accept()
                    threading.Thread(target=self._handle, args=(conn,), daemon=True).start()
                except (OSError, ValueError):
                    self._slots.release()
                    if not self._stop.is_set():
                        raise
        finally:
            self._done.set()

    def shutdown(self):
        self._stop.set()
        self._done.wait()

    def server_close(self):
        self.listener.close()

    def _handle(self, conn):
        try:
            deadline = time.monotonic() + 2
            uid, gid = self._peer(conn)
            if uid != 0 and gid != self.identity[1][3]:
                raise ValueError('Unavailable')
            data = b''
            while b'\r\n\r\n' not in data:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError('Unavailable')
                conn.settimeout(remaining)
                part = conn.recv(min(4096, 16385 - len(data)))
                if not part:
                    raise ValueError('Unavailable')
                data += part
                if len(data) > 16384:
                    raise ValueError('Unavailable')
            header, extra = data.split(b'\r\n\r\n', 1)
            lines = header.split(b'\r\n')
            if extra or len(lines[0]) > 8192:
                raise ValueError('Unavailable')
            parts = lines[0].split(b' ')
            if len(parts) != 3 or parts[0] != b'GET' or parts[2] not in (b'HTTP/1.0', b'HTTP/1.1'):
                raise ValueError('Unavailable')
            capture = _CAPTURE_ROUTE.fullmatch(parts[1]) if self.capture_provider is not None else None
            capture_capability = parts[1] == b'/v2/capture-capability' and self.capture_provider is not None
            component_capability = parts[1] == b'/v3/component-capability' and self.component_provider is not None
            component = parts[1] == b'/v3/orbis/status' and self.component_provider is not None
            handoff = parts[1] == _HANDOFF_ROUTE and self.handoff_provider is not None
            if parts[1] not in (b'/v1/capability', b'/v1/core-operation/progress') and not any((capture, capture_capability, component, component_capability, handoff)):
                raise ValueError('Unavailable')
            seen_length = False
            for line in lines[1:]:
                if b':' not in line:
                    raise ValueError('Unavailable')
                key, val = line.split(b':', 1)
                if not re.fullmatch(rb'[!#$%&\'*+.^_`|~0-9A-Za-z-]+', key) or any(c < 32 and c != 9 or c == 127 for c in val):
                    raise ValueError('Unavailable')
                key = key.lower()
                if key == b'transfer-encoding':
                    raise ValueError('Unavailable')
                if key == b'content-length':
                    if seen_length or val.strip() != b'0':
                        raise ValueError('Unavailable')
                    seen_length = True
            if self._identity(self.path) != self.identity:
                raise ValueError('Unavailable')
            if parts[1] == b'/v1/capability':
                payload = {'schema': 'orbis.sentinel-observer.v1', 'protocolVersion': 1, 'kind': 'core-update-progress'}
            elif capture_capability:
                payload = CAPTURE_CAPABILITY
            elif component_capability:
                payload = COMPONENT_CAPABILITY
            elif component:
                payload = validate_component(self.component_provider())
            elif handoff:
                payload = validate_handoff(self.handoff_provider(deadline - 0.1))
            elif capture:
                point = capture[1].decode('ascii')
                payload = validate_capture(self.capture_provider(point), point)
            else:
                payload = validate_progress(self.provider())
            if self._identity(self.path) != self.identity:
                raise ValueError('Unavailable')
            body = json.dumps(payload, separators=(',', ':'), allow_nan=False).encode('utf-8')
            if len(body) > _MAX_JSON:
                raise ValueError('Unavailable')
            status = b'200 OK'
        except Exception:
            status = b'400 Bad Request'
            body = b'{"error":"Unavailable"}'
        try:
            remaining = deadline - time.monotonic()
            if remaining > 0:
                conn.settimeout(remaining)
                conn.sendall(b'HTTP/1.1 ' + status + b'\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
        except (OSError, UnboundLocalError):
            pass
        finally:
            conn.close()
            self._slots.release()


def activated_observer(provider, *, capture_provider=None, component_provider=None, handoff_provider=None):
    """Use only the explicitly enrolled systemd observer descriptor."""
    if os.environ.get('LISTEN_PID') != str(os.getpid()):
        return None
    if os.environ.get('LISTEN_FDS') != '1' or os.environ.get('LISTEN_FDNAMES') != 'orbis-observer-v1':
        raise ValueError('Observer activation is unavailable')
    os.set_inheritable(3, False)
    with socket.socket(fileno=3) as listener:
        result = ObserverServer(listener, provider, capture_provider=capture_provider,
                                component_provider=component_provider, handoff_provider=handoff_provider)
    for key in ('LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES'):
        os.environ.pop(key, None)
    return result
