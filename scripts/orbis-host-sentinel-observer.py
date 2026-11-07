"""Read-only, narrowly scoped observer over an inherited Unix listener."""
import json
import math
import os
import re
import select
import socket
import stat
import struct
import threading
import time

_MAX_JSON = 16384
_MAX_SAFE = 2**53 - 1
_UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', re.ASCII)
_TAG = re.compile(r'v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?', re.ASCII)
_CAPTURE_ROUTE = re.compile(rb'/v2/core-captures/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})/progress')
CAPTURE_CAPABILITY = {'schema': 'orbis.sentinel-observer.capture.v1', 'protocolVersion': 1, 'kind': 'core-capture-progress'}


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
    def __init__(self, listener, provider, *, capture_provider=None):
        if listener.family != socket.AF_UNIX or listener.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM or not self._is_listening(listener):
            raise ValueError('Unavailable')
        name = listener.getsockname()
        if not isinstance(name, str) or not name or name.startswith('\0'):
            raise ValueError('Unavailable')
        self.path = os.path.abspath(name)
        self.identity = self._identity(self.path)
        self.provider = provider
        self.capture_provider = capture_provider
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
            if parts[1] not in (b'/v1/capability', b'/v1/core-operation/progress') and not capture and not capture_capability:
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


def activated_observer(provider, *, capture_provider=None):
    """Use only the explicitly enrolled systemd observer descriptor."""
    if os.environ.get('LISTEN_PID') != str(os.getpid()):
        return None
    if os.environ.get('LISTEN_FDS') != '1' or os.environ.get('LISTEN_FDNAMES') != 'orbis-observer-v1':
        raise ValueError('Observer activation is unavailable')
    os.set_inheritable(3, False)
    with socket.socket(fileno=3) as listener:
        result = ObserverServer(listener, provider, capture_provider=capture_provider)
    for key in ('LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES'):
        os.environ.pop(key, None)
    return result
