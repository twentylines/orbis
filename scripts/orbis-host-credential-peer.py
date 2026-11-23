#!/usr/bin/env python3
"""Bind one credential-broker connection to the independently enrolled controller.

This proves process/container identity, not Main's SQL or passkey writer exclusion.
Only the host supervisor supplies the enrollment callback and trusted realm.
"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import socket
import stat
import struct
import subprocess
import sys
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


_PROC = Path('/proc')
_OWNER = 0
_HASH = re.compile(r'[a-f0-9]{64}\Z')
_CONTEXT = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]*\Z')
_NAMESPACES = ('mnt', 'pid', 'user')
_DEADLINE = 15


def _fail():
    raise ValueError('The credential producer could not be verified.') from None


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            _fail()
        result[key] = value
    return result


def _json(body):
    try:
        return json.loads(body, object_pairs_hook=_pairs,
                          parse_constant=lambda _: _fail())
    except (ValueError, UnicodeError, RecursionError):
        _fail()


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def _seal(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode)


def _read(directory, name, maximum):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != _OWNER:
            _fail()
        result = bytearray()
        while True:
            block = os.read(descriptor, min(4096, maximum + 1 - len(result)))
            if not block:
                break
            result.extend(block)
            if len(result) > maximum:
                _fail()
        if _seal(info) != _seal(os.fstat(descriptor)):
            _fail()
        return bytes(result)
    finally:
        os.close(descriptor)


def _run(service, arguments, deadline):
    """Fixed Docker observations with bounded pipes, no shell or caller selector."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        _fail()
    process = subprocess.Popen(['docker', '--context', service.context, *arguments], cwd=service.root,
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               close_fds=True)
    output, error = bytearray(), bytearray()
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, output)
            selector.register(process.stderr, selectors.EVENT_READ, error)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    _fail()
                for key, _ in selector.select(min(remaining, 0.1)):
                    block = os.read(key.fileobj.fileno(), 4096)
                    if not block:
                        selector.unregister(key.fileobj)
                        continue
                    key.data.extend(block)
                    if len(output) > 1024 * 1024 or len(error) > 8192:
                        _fail()
        remaining = deadline - time.monotonic()
        if remaining <= 0 or process.wait(timeout=remaining) != 0:
            _fail()
        return bytes(output)
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()
        process.stderr.close()


@contextmanager
def _enrollment_file(host, root):
    with host.AUTHORITY.protected_directory(root, private=False) as directory:
        with host.AUTHORITY.protected_file(directory, host.STATE_NAME, 16384, private=False) as body:
            value = _json(body)
            if type(value) is not dict:
                _fail()
            yield value, _seal(os.fstat(directory))


class _Process:
    def __init__(self, proc, pid):
        self.pid = pid
        self.fd = None
        self.namespaces = []
        try:
            self.fd = os.open(str(pid), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=proc)
            self.seal = _seal(os.fstat(self.fd))
            if self.seal[2] != _OWNER:
                _fail()
            for name in _NAMESPACES:
                # /proc namespace links are kernel capabilities, not paths supplied
                # by Main. Keep their opened inode identity for the whole witness.
                ns = os.open('ns/' + name, os.O_RDONLY | os.O_CLOEXEC, dir_fd=self.fd)
                self.namespaces.append(ns)
            self.identity = self.read()
            self.verify(proc)
        except BaseException:
            self.close()
            raise

    def read(self):
        body = _read(self.fd, 'stat', 65536).decode('utf-8', errors='strict')
        right = body.rfind(') ')
        if right < 0 or body[:body.find(' ')].strip() != str(self.pid):
            _fail()
        fields = body[right + 2:].split()
        if len(fields) < 20 or fields[0] not in {'R', 'S', 'D', 'I'} or not fields[19].isdecimal():
            _fail()
        start = int(fields[19])
        if start <= 0:
            _fail()
        status = _read(self.fd, 'status', 65536).decode('ascii', errors='strict')
        uid = re.findall(r'^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$', status, re.M)
        if len(uid) != 1 or any(int(item) != _OWNER for item in uid[0]):
            _fail()
        cgroup = _read(self.fd, 'cgroup', 65536).decode('ascii', errors='strict')
        groups = []
        for line in cgroup.splitlines():
            parts = line.split(':', 2)
            if len(parts) != 3 or not parts[0].isdecimal() or not parts[2].startswith('/'):
                _fail()
            groups.append(tuple(parts))
        if not groups or len(groups) > 64 or len(set(groups)) != len(groups):
            _fail()
        namespaces = tuple((os.fstat(fd).st_dev, os.fstat(fd).st_ino) for fd in self.namespaces)
        return (start, tuple(sorted(groups)), namespaces)

    def verify(self, proc):
        if self.fd is None or self.seal != _seal(os.fstat(self.fd)):
            _fail()
        if self.seal != _seal(os.stat(str(self.pid), dir_fd=proc, follow_symlinks=False)):
            _fail()
        for name, descriptor in zip(_NAMESPACES, self.namespaces):
            current = os.stat('ns/' + name, dir_fd=self.fd)
            retained = os.fstat(descriptor)
            if (current.st_dev, current.st_ino) != (retained.st_dev, retained.st_ino):
                _fail()
        if self.identity != self.read():
            _fail()

    def close(self):
        for descriptor in reversed(self.namespaces):
            os.close(descriptor)
        self.namespaces.clear()
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


class ControllerPeer:
    """An admitted connection witness; callers cannot construct one from JSON."""
    def __init__(self, service, connection, *, host, enrollment, _enrollment_reader=None):
        self._proc = None
        self._peer = self._controller = None
        self._service, self._connection, self._host, self._enrollment = service, connection, host, enrollment
        self._enrollment_reader = _enrollment_reader or (lambda: _enrollment_file(host, service.root))
        self._closed = False
        try:
            if (sys.platform != 'linux' or os.geteuid() != _OWNER or not callable(enrollment)
                    or type(service.context) is not str or not _CONTEXT.fullmatch(service.context)
                    or not isinstance(service.root, Path) or not service.root.is_absolute()
                    or service.root.resolve(strict=True) != service.root):
                _fail()
            self._credentials = self._peer_credentials()
            self._proc = os.open(_PROC, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            self._proc_seal = _seal(os.fstat(self._proc))
            if self._proc_seal[2] != _OWNER or self._proc_seal[4] & 0o022:
                _fail()
            self._snapshot = self._observe()
            self._peer = _Process(self._proc, self._credentials[0])
            self._controller = _Process(self._proc, self._snapshot['pid'])
            peer, controller = self._peer.identity, self._controller.identity
            if peer[1:] != controller[1:]:
                _fail()
            container = self._snapshot['controller']['id']
            if not all(any(part in {container, 'docker-' + container + '.scope'} for part in row[2].split('/')) for row in peer[1]):
                _fail()
            self._identity = {
                'installationId': _hash({key: self._snapshot['installation'][key]
                                         for key in ('root', 'context', 'daemon', 'rootIdentity')}),
                'controllerId': container, 'imageId': self._snapshot['controller']['imageId'],
                'controllerEpoch': _hash({'snapshot': self._snapshot, 'peerPid': self._credentials[0],
                                          'peerStart': peer[0], 'controllerStart': controller[0],
                                          'namespaces': peer[2]})}
            self.verify()
        except BaseException as error:
            self.close()
            if isinstance(error, Exception):
                raise ValueError('The credential producer could not be verified.') from None
            raise

    def _peer_credentials(self):
        if not hasattr(socket, 'SO_PEERCRED'):
            _fail()
        credentials = struct.unpack('3i', self._connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if credentials[0] <= 0 or credentials[1] != _OWNER or credentials[2] < 0:
            _fail()
        return credentials

    def _observe(self):
        previous = self._host.CAPTURE_READ_DEADLINE.get()
        deadline = min(time.monotonic() + _DEADLINE, previous) if previous is not None else time.monotonic() + _DEADLINE
        # Existing publication/retained authority stays authoritative. Its Docker
        # calls inherit this same absolute deadline through HOST.run.
        token = self._host.CAPTURE_READ_DEADLINE.set(deadline)
        try:
            with self._enrollment_reader() as (saved, root_identity):
                return self._observe_enrolled(saved, root_identity, deadline)
        finally:
            self._host.CAPTURE_READ_DEADLINE.reset(token)

    def _observe_enrolled(self, saved, root_identity, deadline):
        publication = self._enrollment()
        if (type(publication) is not dict or type(publication.get('tag')) is not str
                or not 1 <= len(publication['tag']) <= 128 or type(publication.get('digest')) is not str
                or not re.fullmatch(r'sha256:[a-f0-9]{64}', publication['digest'])
                or self._host.saved_state(self._service.root) != saved
                or saved.get('root') != str(self._service.root)
                or saved.get('dockerContext') != self._service.context):
            _fail()
        body = _run(self._service, ['inspect', '--format', '{{json .}}', 'runtipi'], deadline)
        value = _json(body)
        if type(value) is not dict:
            _fail()
        container, image = value.get('Id'), value.get('Image')
        runtime = value.get('State')
        if (type(container) is not str or not _HASH.fullmatch(container) or type(image) is not str
                or not re.fullmatch(r'sha256:[a-f0-9]{64}', image) or type(runtime) is not dict
                or type(runtime.get('Pid')) is not int or runtime['Pid'] <= 0
                or runtime.get('Running') is not True or runtime.get('Restarting') is not False
                or runtime.get('Paused') is not False or runtime.get('Dead') is not False
                or runtime.get('Status') != 'running' or (runtime.get('Health') or {}).get('Status') != 'healthy'):
            _fail()
        controller = self._service.controller_capture_identity(container, image, saved)
        if (type(controller) is not dict or controller.get('id') != container or controller.get('imageId') != image
                or controller.get('startedAt') != runtime.get('StartedAt')
                or controller.get('releaseTag') != publication.get('tag')
                or controller.get('releaseDigest') != publication.get('digest')):
            _fail()
        daemon = _json(_run(self._service, ['info', '--format', '{{json .ID}}'], deadline))
        if type(daemon) is not str or not 1 <= len(daemon) <= 256 or any(ord(c) < 33 or ord(c) > 126 for c in daemon):
            _fail()
        definition = CONTAINER_DEFINITION.normalize({name: value.get(name) for name in ('Config', 'HostConfig', 'Mounts', 'Path', 'Args')})
        if (any(type(definition[name]) is not dict for name in ('Config', 'HostConfig'))
                or type(definition['Mounts']) is not list or type(definition['Path']) is not str
                or type(definition['Args']) is not list):
            _fail()
        return {'controller': controller, 'pid': runtime['Pid'], 'definitionSha256': _hash(definition),
                'installation': {'root': str(self._service.root), 'context': self._service.context,
                                 'daemon': daemon, 'rootIdentity': root_identity, 'enrollmentSha256': _hash(saved),
                                 'publicationSha256': _hash(publication)}}

    def verify(self):
        try:
            if self._closed or self._credentials != self._peer_credentials():
                _fail()
            if (self._proc_seal != _seal(os.fstat(self._proc))
                    or self._proc_seal != _seal(os.lstat(_PROC))):
                _fail()
            self._peer.verify(self._proc)
            self._controller.verify(self._proc)
            if self._snapshot != self._observe():
                _fail()
            self._peer.verify(self._proc)
            self._controller.verify(self._proc)
        except Exception:
            _fail()

    def identity(self):
        self.verify()
        return dict(self._identity)

    def installation_binding(self):
        """Current verified scope, separate from a floor's issued stable ID."""
        self.verify()
        return {key: self._snapshot['installation'][key] for key in ('root', 'context', 'daemon')}

    def close(self):
        self._closed = True
        for process in (self._controller, self._peer):
            if process is not None:
                process.close()
        if self._proc is not None:
            os.close(self._proc)
            self._proc = None

    def __enter__(self):
        self.verify()
        return self

    def __exit__(self, *args):
        self.close()


def admit(service, connection, *, host, enrollment):
    return ControllerPeer(service, connection, host=host, enrollment=enrollment)


def _existing_module():
    spec = importlib.util.spec_from_file_location('orbis_existing_peer_scope', Path(__file__).with_name('orbis-host-existing-ownership.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _ExistingPeer(ControllerPeer):
    def __init__(self, service, connection, *, host, enrollment, proof):
        self._ownership = proof
        super().__init__(service, connection, host=host, enrollment=enrollment, _enrollment_reader=proof.enrollment)

    def ownership_binding(self):
        self.verify()
        return self._ownership.binding()


@contextmanager
def admit_existing(service, connection, *, host, enrollment, guard):
    # The Root entrypoint constructs the fixed proof reader itself. Neither
    # Main input nor a service attribute can supply an enrollment callback that
    # bypasses the default private reader without this independent Root scope.
    if service.HOST is not host: _fail()
    module = _existing_module()
    with module.RuntimeProof(service, guard) as proof:
        with _ExistingPeer(service, connection, host=host, enrollment=enrollment, proof=proof) as witness:
            yield witness


def _bootstrap_module():
    spec = importlib.util.spec_from_file_location('orbis_birth_peer_scope', Path(__file__).with_name('orbis-host-ownership-bootstrap.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextmanager
def admit_bootstrap(service, connection, *, host, enrollment, guard):
    if service.HOST is not host: _fail()
    module = _bootstrap_module()
    with module.BirthRuntime(service, guard) as proof:
        with ControllerPeer(service, connection, host=host, enrollment=enrollment,
                            _enrollment_reader=proof.enrollment) as witness:
            yield witness


@contextmanager
def admit_configured(service, connection, *, host, enrollment, scope):
    # scope is created by the configured Root service inside its live lifecycle
    # operation. It is never an HTTP argument or an absent-admission fallback.
    if service.HOST is not host or scope.service is not service: _fail()
    scope.verify()
    with ControllerPeer(service, connection, host=host, enrollment=enrollment,
                        _enrollment_reader=scope.enrollment) as witness:
        yield witness
    scope.verify()
