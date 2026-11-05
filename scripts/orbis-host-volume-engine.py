"""Bounded local Docker transport for protected volume operations."""
import http.client
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import sys
import threading


class VolumeEngineError(ValueError):
    def __init__(self, status=None):
        super().__init__('App storage did not respond safely. No source volume was changed.')
        self.status = status


def _seal(details):
    return tuple(getattr(details, key) for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode'))


def _peer_uid(connection):
    if sys.platform != 'linux' or not hasattr(socket, 'SO_PEERCRED'):
        raise VolumeEngineError()
    pid, uid, _gid = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
    if pid <= 0:
        raise VolumeEngineError()
    return uid


class Connection(http.client.HTTPConnection):
    def __init__(self, endpoint, owner, timeout):
        super().__init__('localhost', timeout=timeout)
        self.endpoint, self.owner = endpoint, owner
        self.connected_socket = None
        self.expired = threading.Event()

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.connected_socket = self.sock
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.endpoint)
        if self.expired.is_set() or _peer_uid(self.sock) != self.owner:
            self.sock.close()
            raise VolumeEngineError()

    def interrupt(self):
        self.expired.set()
        if self.connected_socket is not None:
            try:
                self.connected_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


_ID = r'[a-f0-9]{64}'
_UUID = r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
_NAME = 'orbis-volume-reader-' + _UUID
_ROUTES = {
    'GET': re.compile(r'(?:/version|/info|/containers/json\?all=1|/containers/(?:' + _ID + '|' + _NAME + r')/json|/volumes/[A-Za-z0-9][A-Za-z0-9_.-]{0,254}|/images/sha256:' + _ID + r'/json)'),
    'POST': re.compile(r'(?:/containers/create\?name=' + _NAME + r'|/containers/' + _ID + r'/(?:start|stop\?t=5))'),
    'DELETE': re.compile(r'/containers/' + _ID + r'\?v=false'),
}


def _json(body):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise VolumeEngineError()
            result[key] = value
        return result
    def constant(_value):
        raise VolumeEngineError()
    try:
        result = json.loads(body.decode('utf-8', 'strict'), object_pairs_hook=pairs, parse_constant=constant)
        pending, count = [(result, 0)], 0
        while pending:
            value, depth = pending.pop(); count += 1
            if count > 500000 or depth > 32:
                raise VolumeEngineError()
            if isinstance(value, dict):
                pending.extend((child, depth + 1) for child in value.values())
            elif isinstance(value, list):
                pending.extend((child, depth + 1) for child in value)
            elif isinstance(value, str) and any(0xD800 <= ord(char) <= 0xDFFF for char in value):
                raise VolumeEngineError()
        return result
    except (UnicodeError, ValueError, RecursionError, OverflowError) as error:
        raise VolumeEngineError() from error


class DockerVolumeEngine:
    def __init__(self, endpoint, *, owner=0, timeout=30, maximum=8 * 1024 * 1024):
        if (type(owner) is not int or owner < 0 or type(timeout) not in (int, float) or not 0 < timeout <= 30
                or type(maximum) is not int or not 1024 <= maximum <= 16 * 1024 * 1024):
            raise VolumeEngineError()
        selected = Path(endpoint)
        if not selected.is_absolute() or '\x00' in str(selected):
            raise VolumeEngineError()
        try:
            self.endpoint = str(selected.resolve(strict=True))
            details = os.lstat(self.endpoint)
            if not stat.S_ISSOCK(details.st_mode) or details.st_uid != owner or details.st_mode & 0o002:
                raise VolumeEngineError()
        except (OSError, ValueError) as error:
            raise VolumeEngineError() from error
        self.identity = _seal(details)
        self.owner, self.timeout, self.maximum, self.version = owner, timeout, maximum, None
        version = self.request('GET', '/version')
        observed = version.get('ApiVersion') if isinstance(version, dict) else None
        if not isinstance(observed, str) or not re.fullmatch(r'1\.[0-9]{2,3}', observed) or int(observed.split('.')[1]) < 44:
            raise VolumeEngineError()
        self.version = observed

    def request(self, method, route, body=None):
        if (method not in _ROUTES or not isinstance(route, str) or _ROUTES[method].fullmatch(route) is None
                or body is not None and (method != 'POST' or not route.startswith('/containers/create?name='))):
            raise VolumeEngineError()
        connection = Connection(self.endpoint, self.owner, self.timeout)
        timer = threading.Timer(self.timeout, connection.interrupt)
        timer.daemon = True
        try:
            if _seal(os.lstat(self.endpoint)) != self.identity:
                raise VolumeEngineError()
            wire = None if body is None else json.dumps(body, allow_nan=False, ensure_ascii=False, separators=(',', ':')).encode('utf8')
            if wire is not None and len(wire) > 1024 * 1024:
                raise VolumeEngineError()
            timer.start()
            prefix = '' if route == '/version' else '/v' + self.version if self.version else ''
            connection.request(method, prefix + route, wire, {'Content-Type': 'application/json'} if wire is not None else {})
            response = connection.getresponse()
            length = response.getheader('Content-Length')
            if length is not None and (not re.fullmatch(r'[0-9]+', length) or int(length) > self.maximum):
                raise VolumeEngineError()
            chunks, size = [], 0
            while True:
                block = response.read1(min(65536, self.maximum + 1 - size))
                if not block:
                    break
                size += len(block)
                if size > self.maximum:
                    raise VolumeEngineError()
                chunks.append(block)
            if (connection.expired.is_set() or _seal(os.lstat(self.endpoint)) != self.identity
                    or length is not None and size != int(length)):
                raise VolumeEngineError()
            if not 200 <= response.status < 300:
                raise VolumeEngineError(response.status)
            data = b''.join(chunks)
            return _json(data) if data else None
        except VolumeEngineError:
            raise
        except (OSError, ValueError, TypeError, http.client.HTTPException) as error:
            raise VolumeEngineError() from error
        finally:
            timer.cancel()
            connection.close()
