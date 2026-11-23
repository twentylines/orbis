#!/usr/bin/env python3
"""Publish credential admission only from an exact, offline-qualified Root plan.

This is a Root installer operation, never a web API. It does not stop Main,
create an operator/key, install a TLS route, or infer unmanaged from absence.
Those transitions must finish before managed review. Interrupted publications
retain their intent and shared credential fence for explicit same-plan recovery.
"""
import argparse
import base64
import copy
import fcntl
import hashlib
import http.client
import importlib.util
import io
import ipaddress
import json
import os
from pathlib import Path
import re
from http.cookies import SimpleCookie
import socket
import sqlite3
import ssl
import stat
import subprocess
import sys
import time
from contextlib import ExitStack, contextmanager
from types import ModuleType, SimpleNamespace
from urllib.parse import quote, urlsplit


def _container_definition_module():
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location('orbis_container_definition', Path(__file__).with_name('orbis-container-definition.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CONTAINER_DEFINITION = _container_definition_module()


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


C = load('orbis-host-credential-service.py', 'orbis_recovery_admission_config')
OWNER = 0
ROOT = Path('/opt/orbis-sentinel')
STATE = Path('/var/lib/orbis-sentinel')
RECOVERY = STATE / 'recovery'
RECOVERY_CONFIG = RECOVERY / 'config.json'
RECOVERY_ENV = Path('/etc/orbis-sentinel/recovery.env')
RECOVERY_SETUP = Path('/etc/orbis-sentinel/recovery-setup.json')
RECOVERY_INTERPRETER = Path('/usr/bin/python3')
PROC = Path('/proc')
UNITS = Path('/etc/systemd/system')
HOST_SOCKET = Path('/run/orbis/host.sock')
HOST_SOURCE = Path('/opt/orbis/host-service')
HOST_ENV = Path('/etc/orbis/host-service.env')
OBSERVER_SOCKET = Path('/run/orbis-observer/progress.sock')
HOST_UNIT_SHA256 = '7aa0089ea90ab9174a7d3fe1591e5674a0f45fc8fa3763dbc9565cdb98f8df54'
UNIT = 'orbis-sentinel-recovery.service'
UNIT_SHA256 = '7169c18fc5d9dcc718bc8675f43a33ca6939c87c1d5f85ba12b3dda53396cf36'
MAIN_PROTOCOL = 'orbis.credentials.v1'
SCHEMA = 'orbis.recovery-admission-plan.v1'
HISTORY = 'recovery-admission-history.json'
INTENT = 'recovery-admission-intent.json'
STORAGE_INTENT = 'credential-storage-migration.json'
STORAGE_COMPLETE = 'credential-storage-migration-complete.json'
STORAGE_FILES = ('plan', 'predecessor', 'bridge', 'history')
STORAGE_PHASES = ('intent', 'archive-ready', 'bridge-ready', 'history-ready', 'config-verified', 'complete')
BOOTSTRAP_REVIEW = 'orbis.sentinel-bootstrap-review.v2'
BOOTSTRAP_REVIEW_FILE = 'review-plan.json'
BOOTSTRAP_REVIEW_LIMIT = 16384
ORIGIN_OPERATIONS = 'recovery-origin-operations'
ORIGIN_REVIEW = 'orbis.recovery-origin-review.v1'
ORIGIN_APPROVAL = 'orbis.recovery-origin-approval.v1'
ORIGIN_INTENT = 'orbis.recovery-origin-intent.v1'
ORIGIN_READY = 'orbis.recovery-origin-v1-ready.v1'
ORIGIN_ZERO_TIME = '0001-01-01T00:00:00Z'
ORIGIN_NETWORK_FIELDS = ('IPAMConfig', 'Aliases', 'Links', 'DriverOpts', 'GwPriority')
_ORIGIN_OWNER = object()
MAXIMUM = 2 * 1024 * 1024
HASH = re.compile(r'[a-f0-9]{64}\Z')
VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?\Z')


def fail():
    return ValueError('Recovery admission requires the exact qualified Root plan; preserve its private intent and hold for reconciliation.')


class _OriginAdmission:
    def __init__(self, key, service, guard, ready, plan, pins, successor, reused):
        if key is not _ORIGIN_OWNER:
            raise fail()
        self.service, self.guard, self.ready, self.plan, self.pins = service, guard, ready, plan, pins
        self.successor, self.reused = successor, reused

    def verify(self, service, guard, dependencies, plan_sha):
        if (service is not self.service or guard is not self.guard or self.plan['dependencies'] != dependencies
                or self.ready['planSha256'] != plan_sha or self.ready['main'] != dependencies['main']):
            raise fail()
        guard.check(self.ready['operationId'], self.ready['reviewSha256'])
        for pin in self.pins:
            pin.verify()

        def inspect(arguments):
            result = self.service.HOST.docker(self.service.context,
                [*arguments, '--format', '{{json .}}'], self.service.root)
            if result.returncode or len(result.stdout) > MAXIMUM:
                raise fail()
            return _metadata(result.stdout.encode())

        deadline = self.service.HOST.CAPTURE_READ_DEADLINE
        existing = deadline.get()
        end = time.monotonic() + 5
        token = deadline.set(end if existing is None else min(end, existing))
        try:
            raw = inspect(['container', 'inspect', dependencies['main']['id']])
            (_origin_stopped if self.reused else _origin_never_started)(raw)
            definition = CONTAINER_DEFINITION.normalize({key: raw[key] for key in ('Config', 'HostConfig', 'Mounts', 'Path', 'Args')})
            networks = _origin_networks(raw, lambda name: inspect(['network', 'inspect', name]))
            if (raw['Name'] != '/runtipi' or raw['Id'] != self.successor['id']
                    or digest(definition) != self.successor['definitionSha256']
                    or digest(networks) != self.successor['networksSha256']):
                raise fail()
        finally:
            deadline.reset(token)


def _origin_stopped(raw):
    state = raw['State']
    if (any(state.get(key) is not False for key in ('Running', 'Paused', 'Restarting', 'Dead'))
            or type(state.get('Pid')) is not int or state['Pid'] != 0 or state['Status'] not in ('created', 'exited')
            or raw['HostConfig']['RestartPolicy'] not in (
                {'Name': 'no', 'MaximumRetryCount': 0}, {'Name': '', 'MaximumRetryCount': 0})):
        raise fail()


def _origin_never_started(raw):
    _origin_stopped(raw)
    if (raw['State']['Status'] != 'created' or raw['State'].get('StartedAt') != ORIGIN_ZERO_TIME
            or raw['State'].get('FinishedAt') != ORIGIN_ZERO_TIME or type(raw.get('RestartCount')) is not int
            or raw['RestartCount'] != 0):
        raise fail()


def _origin_networks(raw, observe=None):
    values = raw['NetworkSettings']['Networks']
    if type(values) is not dict or not values or len(values) > 32:
        raise fail()
    result = {}
    for name, facts in values.items():
        if type(name) is not str or not re.fullmatch(r'[a-zA-Z0-9_.-]{1,128}', name):
            raise fail()
        identity = facts.get('NetworkID')
        if observe is not None:
            actual = observe(name)
            if (actual['Driver'] != 'bridge' or not valid_hash(actual['Id'])
                    or identity != actual['Id'] and (identity not in ('', None) or raw['State'].get('Running') is not False)):
                raise fail()
            identity=actual['Id']
        if not valid_hash(identity):
            raise fail()
        result[name] = {'NetworkID':identity, **{key:facts[key] for key in ORIGIN_NETWORK_FIELDS if facts.get(key) is not None}}
    return result


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(value if type(value) is bytes else canonical(value)).hexdigest()


def valid_hash(value):
    return type(value) is str and HASH.fullmatch(value) is not None


def _root():
    if sys.platform != 'linux' or os.getuid() != OWNER or os.geteuid() != OWNER:
        raise fail()


def _origin(value):
    if type(value) is not str or len(value) > 512 or any(ord(c) <= 32 or ord(c) == 127 for c in value):
        raise fail()
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None or parsed.password is not None
            or parsed.path or parsed.query or parsed.fragment or parsed.port == 0):
        raise fail()
    return parsed


def _order(version):
    match = VERSION.fullmatch(version) if type(version) is str else None
    if match is None:
        raise fail()
    a, b, c, suffix = match.groups()
    parts = tuple((0, int(p)) if p.isdecimal() else (1, p) for p in suffix.split('.')) if suffix else ()
    return int(a), int(b), int(c), suffix is None, parts


def _mount_id(fd):
    if sys.platform != 'linux':
        return None
    body = Path('/proc/self/fdinfo', str(fd)).read_bytes()
    matches = re.findall(rb'(?m)^mnt_id:\s*([0-9]+)$', body)
    if len(body) > 4096 or len(matches) != 1:
        raise fail()
    return int(matches[0])


@contextmanager
def _directory(path):
    """Pin protected ancestors/mounts while permitting expected child writes."""
    path = Path(path)
    if not path.is_absolute() or str(path) != os.path.realpath(path):
        raise fail()
    pins = []
    try:
        for current in (*reversed(path.parents), path):
            fd = os.open(current, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            info = os.fstat(fd)
            identity = (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode)
            pins.append((current, fd, identity, _mount_id(fd)))
            if info.st_uid not in {0, OWNER} or info.st_mode & 0o022:
                raise fail()
        if _private_identity(os.fstat(pins[-1][1]))['uid'] != OWNER:
            raise fail()
        yield pins[-1][1]
        for current, fd, identity, mounted in pins:
            now = os.open(current, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                for check in (fd, now):
                    info = os.fstat(check)
                    if (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode) != identity or _mount_id(check) != mounted:
                        raise fail()
            finally:
                os.close(now)
    finally:
        for _, fd, _, _ in reversed(pins):
            os.close(fd)


def _read(authority, directory, name, maximum=MAXIMUM):
    try:
        with authority.protected_file(directory, name, maximum) as body:
            return body
    except FileNotFoundError:
        return None


def _write(authority, directory, name, body, *, previous):
    """Compare named old bytes; preserve exclusive partial file on any failure."""
    if _read(authority, directory, name) != previous:
        raise fail()
    temporary = '.' + name + '.pending'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            os.fchmod(fd, 0o600)
            stream.write(body)
            stream.flush()
            os.fsync(fd)
        if _read(authority, directory, name) != previous:
            raise fail()
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(fd)


def _write_storage(authority, directory, name, body, *, previous):
    """Resume a complete, exact interrupted atomic write. Preserve other partials."""
    temporary = '.' + name + '.pending'
    staged = _read(authority, directory, temporary)
    if staged is None:
        _write(authority, directory, name, body, previous=previous)
        return
    if staged != body or _read(authority, directory, name) != previous:
        raise fail()
    fd = os.open(temporary, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                or _mount_id(fd) != _mount_id(directory) or info.st_size != len(body)):
            raise fail()
        identity = C.seal(info)
        os.fsync(fd)
        if (_read(authority, directory, temporary) != body
                or _read(authority, directory, name) != previous
                or C.seal(os.stat(temporary, dir_fd=directory, follow_symlinks=False)) != identity):
            raise fail()
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(fd)


def _metadata(body):
    return C.json_body(body)


def _encoded(value):
    return canonical(value) + b'\n'


def _status(value):
    return (type(value) is dict and set(value) == {'generation', 'revision', 'state'}
            and type(value['generation']) is int and 0 <= value['generation'] <= 9007199254740991
            and value['state'] == 'enrolled' and valid_hash(value['revision']))


def _capability(value):
    expected = {'schema':'orbis.sentinel-authentication-worker.v1','version':1,'methods':['password','passkey'],
              'role':'operator','maxIdentityBytes':65536,'maxRequestBytes':32768,'deadlineMs':10000,
              'databaseRequired':False,'mutations':'none','grantsAuthority':False,
              'identityContentProof':'orbis.sentinel-identity-content.v1',
              'effectiveIdentityContentProof':'orbis.sentinel-effective-identity-content.v1',
              'passkeyCounterProof':'orbis.sentinel-passkey-counter.v1'}
    if canonical(value)!=canonical(expected):raise fail()
    return value


def _private_identity(info):
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != OWNER or stat.S_IMODE(info.st_mode) != 0o700:
        raise fail()
    return {'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}


def _run(args, *, maximum=MAXIMUM, allowed=(0,), environment=None):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=False,env=environment)
    if result.returncode not in allowed or len(result.stdout) > maximum or len(result.stderr) > 8192:
        raise fail()
    return result.stdout


def _systemd(name, *, effective_recovery=False):
    if name not in ('orbis-host.service','orbis-host-observer.socket',UNIT):
        raise fail()
    names = ('LoadState', 'ActiveState', 'SubState', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload',
             'MainPID', 'ControlPID', 'InvocationID', 'KillMode')
    if effective_recovery:
        if name != UNIT:
            raise fail()
        names += ('ExecStart', 'User', 'Group', 'ProtectHome', 'ProtectProc', 'ProtectSystem',
                  'NoNewPrivileges', 'CapabilityBoundingSet')
    if name.endswith('.socket'):names=names[:6]
    body = _run(['/usr/bin/systemctl', 'show', '--no-pager', '--all', *['--property=' + p for p in names], name],
                maximum=32768, allowed=(0, 4) if name.endswith('.socket') else (0,),
                environment={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
    value = {}
    for line in body.decode('utf8').splitlines():
        key, sep, item = line.partition('=')
        if not sep or key in value:
            raise fail()
        value[key] = item
    if set(value) != set(names):
        raise fail()
    return value


def _recovery_process(pid, arguments, invocation):
    path = PROC / str(pid)
    directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        def read(name, maximum):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
            with os.fdopen(fd, 'rb') as stream:
                body = stream.read(maximum + 1)
            if not 0 < len(body) <= maximum:
                raise fail()
            return body

        def start_ticks():
            raw = read('stat', 4096)
            fields = raw.rsplit(b') ', 1)[-1].split()
            if not raw.startswith(str(pid).encode() + b' (') or len(fields) < 20 or not fields[19].isdigit():
                raise fail()
            return int(fields[19])

        before = start_ticks()
        if not before or read('cmdline', 16384) != b'\0'.join(os.fsencode(a) for a in arguments) + b'\0':
            raise fail()
        values = read('environ', 65536).split(b'\0')
        if [entry for entry in values if entry.startswith(b'INVOCATION_ID=')] != [b'INVOCATION_ID=' + invocation.encode()]:
            raise fail()
        if b'0::/system.slice/orbis-sentinel-recovery.service' not in read('cgroup', 16384).splitlines():
            raise fail()
        status = read('status', 16384)
        for name, pattern in ((b'Uid', rb'0\s+0\s+0\s+0'), (b'Gid', rb'0\s+0\s+0\s+0'),
                              (b'NoNewPrivs', b'1'), *((key, b'0{16}') for key in
                                (b'CapInh', b'CapPrm', b'CapEff', b'CapBnd', b'CapAmb'))):
            lines = re.findall(rb'(?m)^' + name + rb':[ \t]*([^\n]*)$', status)
            if len(lines) != 1 or re.fullmatch(pattern, lines[0]) is None:
                raise fail()
        executable = os.stat('exe', dir_fd=directory)
        expected = RECOVERY_INTERPRETER.stat()
        if (not stat.S_ISREG(executable.st_mode) or executable.st_uid != OWNER or executable.st_mode & 0o022
                or C.seal(executable) != C.seal(expected)
                or before != start_ticks()
                or not os.path.samestat(os.fstat(directory), path.stat())):
            raise fail()
        return {'pid': pid, 'startTicks': before, 'invocationId': invocation,
                'executableIdentity': [executable.st_dev, executable.st_ino]}
    finally:
        os.close(directory)


def _https_worker(request):
    """A bounded isolated TLS roundtrip; cookies/nonces stay on stdin/stdout."""
    origin = request['origin']; parsed = _origin(origin)
    conn = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, context=ssl.create_default_context(), timeout=5)
    try:
        certificates = set()
        def get(method, path, body=None, cookie=None):
            conn.close(); conn.connect()
            certificates.add(digest(conn.sock.getpeercert(binary_form=True)))
            if len(certificates) != 1: raise fail()
            headers = {'Host': parsed.netloc, 'Connection': 'close'}
            if body is not None:
                headers.update({'Content-Type': 'application/json', 'Origin': origin})
            if cookie: headers['Cookie'] = cookie
            conn.request(method, path, body=body, headers=headers)
            response = conn.getresponse()
            payload = response.read(32769)
            pairs = response.getheaders()
            if response.status != 200 or len(payload) > 32768 or sum(len(k)+len(v) for k,v in pairs) > 16384:
                raise fail()
            return payload, pairs
        _, headers = get('GET', '/sentinel/recovery/')
        jar = SimpleCookie()
        cookies = [v for k,v in headers if k.lower() == 'set-cookie']
        names = set()
        for item in cookies:
            part = SimpleCookie(); part.load(item)
            if len(part) != 1 or names.intersection(part): raise fail()
            names.update(part); jar.update(part)
        if not names <= {'__Host-orbis-sentinel-'+n for n in ('binding','session','csrf')}: raise fail()
        name = '__Host-orbis-sentinel-binding'
        binding = jar.get(name)
        if (binding is None or not re.fullmatch(r'[A-Za-z0-9_-]{43}', binding.value) or binding['path'] != '/'
                or not binding['secure'] or not binding['httponly'] or binding['domain'] or binding['samesite'] != 'Strict'):
            raise fail()
        cookie = name + '=' + binding.value
        body,_ = get('GET','/sentinel/recovery/api/v1/options',cookie=cookie)
        options = _metadata(body)
        if (set(options) != {'password','recoveryKey','passkey','totp'}
                or options['password'] is not True or options['recoveryKey'] is not True
                or type(options['passkey']) is not bool or type(options['totp']) is not dict
                or set(options['totp']) != {'password','passkey'}
                or any(type(v) is not bool for v in options['totp'].values())):
            raise fail()
        result = {'certificateSha256': next(iter(certificates)), 'optionsSha256': digest(body)}
        if request['prove']:
            body,_ = get('POST','/sentinel/recovery/api/v1/challenge',canonical({'method':'recovery-key'}),cookie)
            challenge = _metadata(body)
            if (set(challenge) != {'challenge','expiresAtMs'} or type(challenge['challenge']) is not str
                    or not re.fullmatch(r'[A-Za-z0-9_-]{43}',challenge['challenge']) or type(challenge['expiresAtMs']) is not int
                    or not int(time.time()*1000) < challenge['expiresAtMs'] <= int(time.time()*1000)+180000):
                raise fail()
            result.update(challenge=challenge['challenge'],binding=binding.value)
        return result
    finally:
        conn.close()


def _https(origin, *, prove=False):
    request = canonical({'origin': origin, 'prove': prove})
    result = subprocess.run([sys.executable, '-B', str(Path(__file__).resolve()), '--tls-probe'], input=request,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=12, check=False)
    if result.returncode or len(result.stdout) > 8192 or len(result.stderr) > 8192:
        raise fail()
    return _metadata(result.stdout)


class Supervisor:
    """Production observations; Root CLI never accepts caller-supplied facts."""
    def __init__(self, service):
        self.service, self.host = service, service.HOST
        self.authority, self.layout = self.host.AUTHORITY, self.host.AUTHORITY.LAYOUT

    def _runtime(self):
        with self._held_runtime() as (value, modules, _):
            return value, modules

    @contextmanager
    def _held_runtime(self, *, storage_floor=False):
        resources = ExitStack()
        try:
            def pin(path, **kw):
                p = C.PinnedFile(path, **kw); resources.callback(p.close); return p
            installed = pin(STATE / 'installed.json', limit=MAXIMUM, private=True)
            receipt = _metadata(installed.body)
            if (set(receipt) != {'schema','version','sha256','sourceCommit','files'}
                    or receipt['schema'] != 'orbis-sentinel.installation.v1' or not valid_hash(receipt['sha256'])
                    or type(receipt['sourceCommit']) is not str or not re.fullmatch(r'[a-f0-9]{40}',receipt['sourceCommit'])
                    or type(receipt['files']) is not dict or not 1 <= len(receipt['files']) <= 512):
                raise fail()
            _order(receipt['version'])
            release = ROOT / 'releases' / receipt['version']
            selector = os.lstat(ROOT / 'current')
            if (not stat.S_ISLNK(selector.st_mode) or selector.st_uid != OWNER
                    or os.readlink(ROOT / 'current') != 'releases/' + receipt['version']):
                raise fail()
            inventory = {}
            for name, expected in receipt['files'].items():
                if (type(name) is not str or name.startswith('/') or '..' in Path(name).parts
                        or type(expected) is not dict or set(expected) != {'bytes','sha256'}
                        or type(expected['bytes']) is not int or not 0 < expected['bytes'] <= 16*1024*1024
                        or not valid_hash(expected['sha256'])):
                    raise fail()
                item = pin(release / name, limit=16*1024*1024)
                if len(item.body) != expected['bytes'] or digest(item.body) != expected['sha256']:
                    raise fail()
                inventory[name] = item
            actual = set()
            for parent, dirs, files in os.walk(release, followlinks=False):
                for name in (*dirs, *files):
                    path = Path(parent)/name; info = path.lstat()
                    if stat.S_ISDIR(info.st_mode):
                        if info.st_uid != OWNER or stat.S_IMODE(info.st_mode) != 0o755: raise fail()
                    elif stat.S_ISREG(info.st_mode): actual.add(path.relative_to(release).as_posix())
                    else: raise fail()
            if actual != set(inventory): raise fail()
            for name,item in inventory.items():
                if stat.S_IMODE(os.fstat(item.file).st_mode)!=(0o755 if name.startswith('bin/') else 0o644):raise fail()
            runtime = release / 'src/orbis_sentinel'
            pins = {name: inventory['src/orbis_sentinel/' + name] for name in C.RUNTIME_FILES}
            package = '_orbis_admission_' + digest(installed.body) + ('_storage' if storage_floor else '')
            modules = C.CredentialService.load_runtime(package, pins)
            if storage_floor:
                extra = ['bootstrap_source', 'credential_storage', 'host_source_publication', 'credential_floor']
                # Older retained releases have no paired-publication module.
                # New consumers must execute its exact installed pinned bytes.
                if 'src/orbis_sentinel/bootstrap_publication.py' in inventory:
                    extra.append('bootstrap_publication')
                for short in extra:
                    source = inventory['src/orbis_sentinel/' + short + '.py']
                    fullname = package + '.' + short
                    source.verify()
                    if fullname not in sys.modules:
                        module = ModuleType(fullname)
                        module.__file__, module.__package__ = str(source.path), package
                        sys.modules[fullname] = module
                        try:
                            exec(compile(source.body, str(source.path), 'exec', dont_inherit=True), module.__dict__)
                            source.verify()
                        except BaseException:
                            sys.modules.pop(fullname, None)
                            raise
                        setattr(sys.modules[package], short, module)
                    modules[short] = sys.modules[fullname]
            if modules['writer_broker'].HOST_WRITER_PROTOCOL != C.PROTOCOL: raise fail()
            value = {'version':receipt['version'],'artifactSha256':receipt['sha256'],'sourceCommit':receipt['sourceCommit'],
                     'receiptSha256':digest(installed.body),'inventorySha256':digest(receipt['files']),
                     'runtimeDirectory':str(runtime),'runtimeFiles':{n:digest(p.body) for n,p in pins.items()}}
            def check():
                for item in inventory.values():
                    item.verify()
                installed.verify()
                if C.seal(os.lstat(ROOT/'current')) != C.seal(selector) or os.readlink(ROOT/'current') != 'releases/'+receipt['version']:
                    raise fail()
            check()
            yield value, modules, check
            check()
        finally:
            resources.close()

    @contextmanager
    def storage_floor(self, config):
        if self.service.state_dir != self.layout.STATE_ROOT or config.get('mode') != 'managed':
            raise fail()
        origin = config.get('origin')
        _origin(origin)
        _, main, daemon = self._main(origin, storage_transition=True)
        host = self._host_stopped()
        if self.layout.read(self.service.root, daemon, self.service.context) is None:
            raise fail()
        with self._held_runtime(storage_floor=True) as (_, modules, check_runtime), ExitStack() as resources:
            module = modules['credential_floor']
            reader = module.CredentialFloorReader(self.service.root, self.service.context, daemon,
                                                 host_state_directory=self.service.state_dir)
            path = self.layout.namespace(self.service.root) / 'credential-journal'
            journal = modules['writer_journal'].WriterJournal(path, create=False,
                validate_record=modules['writer_broker'].validate_record)
            resources.callback(journal.close)
            journal_state = journal.read()
            if journal_state['active'] is not None:
                raise fail()

            def check(before):
                check_runtime()
                _, observed, observed_daemon = self._main(origin, storage_transition=True)
                if (observed != main or observed_daemon != daemon or self._host_stopped() != host
                        or journal.read() != journal_state):
                    raise fail()
                return self._storage_creation_transition(before['current']['main'], main)

            yield module, reader, check

    @staticmethod
    def _storage_creation_transition(before, main):
        if before['imageId'] != main['imageId'] or before['publicationSha256'] != main['publicationSha256']:
            raise fail()
        expected = before['creationSha256']
        if expected == main['definitionSha256']:
            return None
        if expected != main['previousPolicyDefinitionSha256']:
            raise fail()
        return {'fromPolicy':'unless-stopped', 'toPolicy':main['storageRestartPolicy'],
                'beforeSha256':expected, 'afterSha256':main['definitionSha256']}

    def _main(self, origin, *, storage_transition=False):
        service,host=self.service,self.host
        manifest=service.current_manifest()
        raw=host.docker(service.context,['inspect','--format','{{json .}}','runtipi'],service.root)
        if raw.returncode or len(raw.stdout)>MAXIMUM:raise fail()
        value=_metadata(raw.stdout.encode());state=value.get('State',{});config=value.get('Config',{})
        labels=config.get('Labels') or {};environment=config.get('Env',[])
        if type(environment) is not list or any(type(x) is not str for x in environment):raise fail()
        origins=[x.split('=',1)[1] for x in environment if x.startswith('ORBIS_SENTINEL_RECOVERY_ORIGIN=')]
        expected=host.controller_reference(service.root,manifest,service.context)
        if (not valid_hash(value.get('Id')) or not re.fullmatch(r'sha256:[a-f0-9]{64}',value.get('Image',''))
                or config.get('Image')!=expected or labels.get('com.docker.compose.project')!='runtipi'
                or labels.get('com.docker.compose.service')!='runtipi' or labels.get('com.docker.compose.project.working_dir')!=str(service.root)
                or labels.get('io.orbis.credential-writer-protocol')!=MAIN_PROTOCOL
                or origins!=[origin]
                or state.get('Running') is not False or state.get('Paused') is not False or state.get('Restarting') is not False
                or state.get('Dead') is not False or type(state.get('Pid')) is not int or state.get('Pid')!=0 or state.get('Status') not in ('exited','created')):raise fail()
        definition = CONTAINER_DEFINITION.normalize({key:value.get(key) for key in ('Config','HostConfig','Mounts','Path','Args')})
        if storage_transition:
            host_config = definition['HostConfig']
            restart = host_config.get('RestartPolicy', {}) if type(host_config) is dict else {}
            if (type(restart) is not dict or restart.get('Name') not in ('', 'no')
                    or restart != {'Name':restart['Name'], 'MaximumRetryCount':0}
                    or self.layout.R.filesystem(service.state_dir)['fsType'] != 'ext4'):
                raise fail()
            previous_policy = {'Name':'unless-stopped', 'MaximumRetryCount':0}
            previous_definition = {**definition,'HostConfig':{**host_config,'RestartPolicy':previous_policy}}
        protected = (ROOT, STATE, RECOVERY_ENV.parent, UNITS, HOST_SOURCE, HOST_ENV.parent, service.state_dir)
        mounts=value.get('Mounts')
        if type(mounts) is not list: raise fail()
        for mount in mounts:
            source=mount.get('Source') if type(mount) is dict else None
            if type(source) is not str or not source.startswith('/'): raise fail()
            source=Path(source)
            if any(source==p or source in p.parents or p in source.parents for p in protected): raise fail()
        daemon=host.docker(service.context,['info','--format','{{json .ID}}'],service.root)
        if daemon.returncode or len(daemon.stdout)>4096:raise fail()
        daemon=json.loads(daemon.stdout)
        if type(daemon) is not str or not 1 <= len(daemon) <= 256 or any(ord(c)<33 or ord(c)>126 for c in daemon):raise fail()
        root_info=service.root.stat()
        local=json.loads(_run(['/usr/bin/docker','--config',str(HOST_SOURCE),'--host','unix:///var/run/docker.sock',
                               'info','--format','{{json .ID}}'],maximum=4096,environment={'PATH':'/usr/bin:/bin','LANG':'C'}))
        if type(local) is not str or local!=daemon:raise fail()
        installation={'root':str(service.root),'context':service.context,'daemon':daemon,
                      'rootIdentity':(root_info.st_dev,root_info.st_ino,root_info.st_uid,root_info.st_gid,root_info.st_mode)}
        descriptor={'id':value['Id'],'imageId':value['Image'],'publicationSha256':digest(manifest),
                    'definitionSha256':digest(definition),
                    'protocol':MAIN_PROTOCOL}
        if storage_transition:
            descriptor.update(previousPolicyDefinitionSha256=digest(previous_definition), storageRestartPolicy=restart['Name'])
        return digest(installation),descriptor,daemon

    def _host_stopped(self):
        unit=_systemd('orbis-host.service')
        if (unit['LoadState']!='loaded' or unit['ActiveState']!='inactive' or unit['SubState']!='dead'
                or unit['MainPID']!='0' or unit['ControlPID']!='0' or unit['NeedDaemonReload']!='no'
                or unit['FragmentPath']!=str(UNITS/'orbis-host.service')):raise fail()
        with ExitStack() as resources:
            def pin(path,**kw):
                value=C.PinnedFile(path,**kw);resources.callback(value.close);return value
            base_unit=pin(UNITS/'orbis-host.service',limit=32768)
            environment=pin(HOST_ENV,limit=16384,private=True)
            def quoted(value):return '"'+value.replace('\\','\\\\').replace('"','\\"')+'"'
            expected=('ORBIS_SERVICE_SOURCE='+quoted(str(HOST_SOURCE/'orbis-host-service.py'))+'\n'
                      'ORBIS_ROOT='+quoted(str(self.service.root))+'\n'
                      'ORBIS_DOCKER_CONTEXT='+quoted(self.service.context)+'\n').encode()
            if digest(base_unit.body)!=HOST_UNIT_SHA256 or environment.body!=expected:raise fail()
            drop=UNITS/'orbis-host.service.d/sentinel-observer.conf'
            if unit['DropInPaths']:
                if unit['DropInPaths']!=str(drop):raise fail()
                observer=pin(drop,limit=4096)
                if observer.body!=b'[Unit]\nRequires=orbis-host-observer.socket\nAfter=orbis-host-observer.socket\n\n[Service]\nSockets=orbis-host-observer.socket\n':raise fail()
            if Path(__file__).resolve()!=HOST_SOURCE/Path(__file__).name:raise fail()
            inventory={}
            with _directory(HOST_SOURCE) as directory:
                names=os.listdir(directory)
                required={'orbis-host-service.py','orbis-host.py','orbis-host-layout.py','orbis-host-retained-authority.py',
                          'orbis-host-credential-peer.py','orbis-host-credential-fence.py','orbis-host-credential-service.py',Path(__file__).name}
                if not required<=set(names) or not 1<=len(names)<=512 or any(not n.endswith('.py') and n not in {'orbis-controller-bootstrap-profile.mjs','orbis-host-maintenance-responder.mjs'} for n in names):raise fail()
                for name in names:
                    body=_read(self.authority,directory,name)
                    if body is None:raise fail()
                    inventory[name]=digest(body)
                if inventory[Path(__file__).name]!=digest(Path(__file__).read_bytes()):raise fail()
            custody={'unitSha256':digest(base_unit.body),'environmentSha256':digest(environment.body),'sourceFiles':inventory}
            base_unit.verify();environment.verify()
        activation=_systemd('orbis-host-observer.socket')
        if (activation['ActiveState']!='inactive' or activation['SubState']!='dead' or activation['DropInPaths']
                or activation['NeedDaemonReload']!='no'):raise fail()
        if activation['LoadState']=='not-found':
            if activation['FragmentPath'] or unit['DropInPaths']:raise fail()
        elif activation['LoadState']=='loaded':
            if activation['FragmentPath']!=str(UNITS/'orbis-host-observer.socket'):raise fail()
            observer_socket=C.PinnedFile(UNITS/'orbis-host-observer.socket',limit=4096)
            try:
                if digest(observer_socket.body)!='5a04369125cadf908e516715b790923a420572d963830f05f6fd7388cfc19f92':raise fail()
                observer_socket.verify()
            finally:observer_socket.close()
        else:raise fail()
        # Stop the activation socket as well as its service: read-only Sentinel
        # telemetry must not silently reactivate a previous helper during apply.
        if os.path.lexists(OBSERVER_SOCKET):raise fail()
        custody['activation']=activation
        if HOST_SOCKET.exists() or HOST_SOCKET.is_symlink():
            with _directory(HOST_SOCKET.parent) as directory:
                info=os.stat(HOST_SOCKET.name,dir_fd=directory,follow_symlinks=False)
                if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=OWNER or stat.S_IMODE(info.st_mode)!=0o600 or info.st_nlink!=1:raise fail()
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as probe:
                probe.settimeout(0.3)
                try:probe.connect(str(HOST_SOCKET))
                except ConnectionRefusedError:pass
                else:raise fail()
        return {'systemdSha256':digest(unit),'custody':custody}

    def _root_identity(self, challenge=None):
        with self.authority.protected_directory(RECOVERY) as directory:
            fd=os.open('recovery.sqlite3',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
            try:
                before=os.fstat(fd)
                if (not stat.S_ISREG(before.st_mode) or before.st_uid!=OWNER or before.st_nlink!=1
                        or stat.S_IMODE(before.st_mode)!=0o600):raise fail()
                with sqlite3.connect('file:'+quote(str(RECOVERY/'recovery.sqlite3'),safe='/')+'?mode=ro',uri=True,timeout=2) as db:
                    db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
                    keys=db.execute('SELECT revision,origin FROM recovery_keys WHERE active=1').fetchall()
                    enrollment=db.execute('SELECT generation,nonce,target,origin FROM operator_enrollment WHERE id=1').fetchall()
                    profiles=db.execute('SELECT revision,profile FROM identities WHERE active=1').fetchall()
                    if len(keys)!=1 or len(enrollment)!=1 or len(profiles)!=1 or enrollment[0][1] is not None:raise fail()
                    revision,origin=keys[0]
                    if not valid_hash(revision) or not valid_hash(profiles[0][0]):raise fail()
                    profile=_metadata(profiles[0][1])
                    if profile.get('origin')!=origin:raise fail()
                    if challenge is not None:
                        row=db.execute('SELECT binding,method,revision FROM challenges WHERE digest=?',(digest(challenge['challenge'].encode()),)).fetchall()
                        if row!=[(digest(challenge['binding'].encode()),'recovery-key',revision)]:raise fail()
                    result={'generation':enrollment[0][0],'revision':profiles[0][0],'origin':origin,'keyRevision':revision,
                            'databaseIdentity':[before.st_dev,before.st_ino,before.st_uid,before.st_gid,before.st_mode]}
                    db.execute('COMMIT')
                after=os.stat('recovery.sqlite3',dir_fd=directory,follow_symlinks=False)
                if C.seal(before)[:6]!=C.seal(after)[:6]:raise fail()
                return result
            finally:os.close(fd)

    def _operator_source_binding(self, installation, controller, identity):
        # Deliberately unavailable until a fixed stopped-controller collector
        # captures actual SQL/file credentials under the shared lifecycle guard
        # and Root operator-check-source verifies full content and counter floors.
        # Enrolled status, same realm, image labels, TLS, arbitrary Root hashes or
        # caller booleans cannot substitute for this missing qualified dependency.
        raise ValueError('The protected Main/operator source binding has not been qualified.')

    @contextmanager
    def bootstrap_recovery(self, origin, main, runtime, modules, *, installation_id=None, builtin_marker_sha=None):
        """Hold the installed recovery unit and corroborate its active invocation."""
        with ExitStack() as resources:
            pinned, absent = [], []

            def pin(path, *, optional=False, limit=16384, **options):
                try:
                    source = C.PinnedFile(path, limit=limit, **options)
                except FileNotFoundError:
                    if not optional:
                        raise
                    absent.append(path)
                    return None
                resources.callback(source.close)
                pinned.append(source)
                return source

            config = pin(RECOVERY_CONFIG, private=True)
            env = pin(RECOVERY_ENV, private=True)
            unit = pin(UNITS / UNIT)
            marker = pin(RECOVERY_SETUP, optional=True, private=True)
            value = _metadata(config.body)
            recovery_config = modules['recovery_config']
            recovery_config.RecoveryConfig._validate(value)
            if (value['directory'] != str(RECOVERY) or value['origin'] != origin
                    or value['imageId'] != main['imageId'] or value['statusSocket'] != '/run/orbis-sentinel/api.sock'):
                raise fail()
            config_sha = digest(config.body)
            builtin = False
            if marker is None:
                # A retained setup record cannot become a legacy listener by
                # losing its marker. These receipts never select built-in mode.
                if any(pin(RECOVERY / name, optional=True, private=True, limit=32768) is not None for name in (
                        'listener-setup-store.json', '.listener-setup-store.json.pending',
                        'paired-transport-receipt.json', 'listener-setup-receipt.json')):
                    raise fail()
            else:
                setup = _metadata(marker.body)
                if type(setup) is not dict or canonical(setup) != marker.body:
                    raise fail()
                fields = {'schema', 'operationId', 'installationId', 'origin', 'configSha256'}
                builtin = setup.get('schema') == 'orbis.sentinel-recovery-listener-setup.v2'
                reservation = None
                if builtin:
                    fields.add('transport')
                    transport = setup.get('transport')
                    if (type(transport) is not dict or set(transport) != {'mode', 'pairId'}
                            or transport['mode'] != 'builtin-private-tls.v1' or not valid_hash(transport['pairId'])):
                        raise fail()
                    reservation = pin(RECOVERY / 'listener-setup-store.json', optional=True, private=True)
                    if (reservation is None
                            or pin(RECOVERY / '.listener-setup-store.json.pending', optional=True, private=True) is not None):
                        raise fail()
                elif (setup.get('schema') != 'orbis.sentinel-recovery-listener-setup.v1'
                      or pin(RECOVERY / 'paired-transport-receipt.json', optional=True, private=True, limit=32768) is not None):
                    raise fail()
                if (set(setup) != fields or not all(valid_hash(setup[key]) for key in ('operationId', 'installationId'))
                        or installation_id is not None and setup['installationId'] != installation_id
                        or setup['origin'] != origin or setup['configSha256'] != config_sha
                        or reservation is not None and reservation.body != canonical({
                            'operationId': setup['operationId'], 'markerSha256': digest(marker.body)})):
                    raise fail()
            if builtin_marker_sha is not None and (not builtin or digest(marker.body) != builtin_marker_sha):
                raise fail()
            launcher = str(ROOT / 'releases' / runtime['version'] / 'bin/orbis-sentinel')
            arguments = (str(RECOVERY_INTERPRETER), '-I', launcher, '--recovery-profile', str(RECOVERY_CONFIG))
            environment = (f'ORBIS_SENTINEL_RECOVERY_RUNTIME={launcher}\n'
                           f'ORBIS_SENTINEL_RECOVERY_PROFILE={RECOVERY_CONFIG}\n').encode()
            unit_sha = digest(unit.body)
            if unit_sha != UNIT_SHA256 or env.body != environment:
                raise fail()

            expected = {'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'running',
                        'FragmentPath': str(UNITS / UNIT), 'DropInPaths': '', 'NeedDaemonReload': 'no',
                        'ControlPID': '0', 'KillMode': 'control-group', 'User': 'root', 'Group': 'root',
                        'ProtectHome': 'yes', 'ProtectProc': 'invisible', 'ProtectSystem': 'strict',
                        'NoNewPrivileges': 'yes', 'CapabilityBoundingSet': ''}
            literal = (str(RECOVERY_INTERPRETER) + ' -I ${ORBIS_SENTINEL_RECOVERY_RUNTIME}'
                       ' --recovery-profile ${ORBIS_SENTINEL_RECOVERY_PROFILE}')

            def observe():
                for source in pinned:
                    source.verify()
                if any(os.path.lexists(path) for path in absent):
                    raise fail()
                effective = _systemd(UNIT, effective_recovery=True)
                if (any(effective.get(key) != item for key, item in expected.items())
                        or not re.fullmatch(r'[1-9][0-9]{0,9}', effective.get('MainPID', ''))
                        or not re.fullmatch(r'[a-f0-9]{32}', effective.get('InvocationID', ''))):
                    raise fail()
                if builtin:
                    profile = recovery_config.builtin_effective_profile(effective, arguments)
                else:
                    start = re.fullmatch(r'\{ path=([^ ;]+) ; argv\[\]=(.+?) ; ignore_errors=no(?: ; [^{}]*)? \}',
                                         effective.get('ExecStart', ''))
                    if not start or start[1] != arguments[0] or start[2] not in (literal, ' '.join(arguments)):
                        raise fail()
                    profile = effective
                process = _recovery_process(int(effective['MainPID']), arguments, effective['InvocationID'])
                return {'configSha256': config_sha, 'environmentSha256': digest(env.body),
                        'unitSha256': unit_sha, 'effectiveSha256': digest(profile), 'process': process}

            observed = observe()

            def check():
                if observe() != observed:
                    raise fail()

            yield observed, check
            check()

    def snapshot(self, request):
        deadline=self.host.CAPTURE_READ_DEADLINE
        previous=deadline.get()
        token=deadline.set(min(time.monotonic()+45,previous) if previous is not None else time.monotonic()+45)
        try:return self._snapshot(request)
        finally:deadline.reset(token)

    def _snapshot(self, request):
        _root();origin=request['origin'];_origin(origin)
        if self.service.state_dir!=self.layout.STATE_ROOT:raise fail()
        installation,main,daemon=self._main(origin)
        layout=self.layout.read(self.service.root,daemon,self.service.context)
        if layout is None:raise fail()
        namespace=self.layout.namespace(self.service.root)
        with self.authority.protected_directory(namespace) as fd:namespace_identity=_private_identity(os.fstat(fd))
        runtime,modules=self._runtime()
        host_unit=self._host_stopped()
        storage={}
        for path in (ROOT,STATE,self.service.state_dir):
            fs=self.layout.R.filesystem(path)
            if fs['fsType']=='nsfs':raise fail()
            storage[str(path)]=self.layout.R._durable_filesystem(fs)
        result={'installationId':installation,'main':main,'layoutSha256':digest(layout),'namespaceIdentity':namespace_identity,
                'namespace':str(namespace),'sentinel':runtime,'hostService':host_unit,'storage':storage,'writerProtocol':C.PROTOCOL}
        existing = load('orbis-host-existing-ownership.py', 'orbis_admission_existing_ownership').retirement_reference(self.service)
        if existing is not None:
            if existing['installationId'] != installation: raise fail()
            result['existingOwnership'] = existing
        if request['mode']=='managed':
            config=C.PinnedFile(RECOVERY_CONFIG,limit=16384,private=True)
            try:
                value=_metadata(config.body)
                modules['recovery_config'].RecoveryConfig._validate(value)
                if value['directory']!=str(RECOVERY) or value['origin']!=origin or value['statusSocket']!='/run/orbis-sentinel/api.sock':raise fail()
                unit=_systemd(UNIT)
                if (unit['LoadState']!='loaded' or unit['ActiveState']!='active' or unit['SubState']!='running'
                        or unit['FragmentPath']!=str(UNITS/UNIT) or unit['DropInPaths'] or unit['NeedDaemonReload']!='no'
                        or not unit['MainPID'].isdecimal() or int(unit['MainPID'])<=0 or unit['ControlPID']!='0'
                        or unit['KillMode']!='control-group' or not re.fullmatch(r'[a-f0-9]{32}',unit['InvocationID'])):raise fail()
                unit_file=C.PinnedFile(UNITS/UNIT,limit=16384)
                env_file=C.PinnedFile(RECOVERY_ENV,limit=16384,private=True)
                try:
                    expected=('ORBIS_SENTINEL_RECOVERY_RUNTIME='+str(ROOT/'releases'/runtime['version']/'bin/orbis-sentinel')+'\n'
                              'ORBIS_SENTINEL_RECOVERY_PROFILE='+str(RECOVERY_CONFIG)+'\n').encode()
                    if digest(unit_file.body)!=UNIT_SHA256 or env_file.body!=expected:raise fail()
                    cmdline=Path('/proc',unit['MainPID'],'cmdline').read_bytes().split(b'\0')
                    expected_cmd=[b'/usr/bin/python3',b'-I',str(ROOT/'releases'/runtime['version']/'bin/orbis-sentinel').encode(),
                                  b'--recovery-profile',str(RECOVERY_CONFIG).encode(),b'']
                    if cmdline!=expected_cmd:raise fail()
                    listener=modules['writer_control'].WriterControlClient(str(RECOVERY/'control.sock'),timeout=5)
                    status=listener.call('operator-status',{})
                    identity=self._root_identity()
                    if not _status(status) or status['revision']!=identity['revision'] or status['generation']!=identity['generation'] or identity['origin']!=origin:raise fail()
                    self._operator_source_binding(installation,main,identity)
                    capability=_capability(modules['writer_control'].WriterControlClient(str(RECOVERY/'control.sock'),timeout=45).call('operator-capability',{}))
                    anchor_name='orbis-sentinel-retained-'+value['imageId'][7:39]
                    raw=self.host.docker(self.service.context,['inspect','--format','{{json .}}',anchor_name],self.service.root)
                    if raw.returncode:raise fail()
                    anchor=_metadata(raw.stdout.encode());cfg=anchor.get('Config',{});hc=anchor.get('HostConfig',{});state=anchor.get('State',{})
                    if (not valid_hash(anchor.get('Id')) or anchor.get('Name')!='/'+anchor_name or anchor.get('Image')!=value['imageId'] or cfg.get('Image')!=value['imageId']
                            or (cfg.get('Labels') or {}).get('io.orbis.sentinel.retained-worker')!=value['imageId']
                            or anchor.get('Mounts')!=[] or cfg.get('Volumes') not in (None,{}) or hc.get('Privileged') is not False
                            or hc.get('ReadonlyRootfs') is not True or hc.get('NetworkMode')!='none' or hc.get('CapDrop')!=['ALL']
                            or hc.get('RestartPolicy',{}).get('Name')!='no' or state.get('Running') is not False or state.get('Pid')!=0
                            or state.get('Paused') is not False or state.get('Restarting') is not False or state.get('Status')!='created'):raise fail()
                    image=self.host.docker(self.service.context,['image','inspect','--format','{{json .}}',value['imageId']],self.service.root)
                    if image.returncode:raise fail()
                    image=_metadata(image.stdout.encode());labels=(image.get('Config') or {}).get('Labels') or {}
                    if (value['imageId']!=main['imageId'] or image.get('Id')!=value['imageId'] or (image.get('Config') or {}).get('Volumes') not in (None,{})
                            or labels.get('org.opencontainers.image.source')!='https://github.com/twentylines/orbis'
                            or labels.get('io.orbis.credential-writer-protocol')!=MAIN_PROTOCOL):raise fail()
                    fs=self.layout.R.filesystem(RECOVERY)
                    if fs['fsType']=='nsfs':raise fail()
                    tls=_https(origin)
                    result['recovery']={'config':str(RECOVERY_CONFIG),'configSha256':digest(config.body),'identity':identity,
                                        'unitSha256':digest(unit),'worker':{'imageId':value['imageId'],'anchorId':anchor['Id'],'definitionSha256':digest(anchor),'capabilitySha256':digest(capability)},
                                        'filesystem':self.layout.R._durable_filesystem(fs),'tls':tls}
                    unit_file.verify();env_file.verify();config.verify()
                finally:unit_file.close();env_file.close()
            finally:config.close()
        else:
            if os.path.lexists(RECOVERY_CONFIG) or os.path.lexists(RECOVERY_ENV):raise fail()
            if RECOVERY.exists():
                with self.authority.protected_directory(RECOVERY) as fd:
                    if os.listdir(fd):raise fail()
            result['recovery']=None
        return _metadata(canonical(result)),modules

    def prove_route(self, expected):
        proof=_https(expected['request']['origin'],prove=True)
        if {k:proof[k] for k in ('certificateSha256','optionsSha256')}!=expected['dependencies']['recovery']['tls']:raise fail()
        current=self._root_identity(proof)
        if current!=expected['dependencies']['recovery']['identity']:raise fail()


class Admission:
    def __init__(self, service):
        self.service,self.host=service,service.HOST
        self.authority,self.layout=self.host.AUTHORITY,self.host.AUTHORITY.LAYOUT
        self.supervisor=Supervisor(service)

    def request(self, mode, origin, *, unmanaged_adoption=False):
        _origin(origin)
        if mode not in ('managed','unmanaged') or type(unmanaged_adoption) is not bool or unmanaged_adoption!=(mode=='unmanaged'):raise fail()
        return {'mode':mode,'origin':origin,'unmanagedAdoption':'root-approved-no-managed-claim.v1' if unmanaged_adoption else None}

    def _history(self, directory):
        body=_read(self.authority,directory,HISTORY)
        if body is None:return None,None
        value=_metadata(body)
        fields={'schema','installationId','generation','managedEver','mode','configSha256','planSha256','sentinelVersion','writerProtocol'}
        if (set(value)!=fields or value['schema']!='orbis.recovery-admission-history.v1' or not valid_hash(value['installationId'])
                or type(value['generation']) is not int or value['generation']<1 or type(value['managedEver']) is not bool
                or value['mode'] not in ('managed','unmanaged') or not valid_hash(value['configSha256']) or not valid_hash(value['planSha256'])
                or type(value['writerProtocol']) is not int or value['writerProtocol']<1):raise fail()
        _order(value['sentinelVersion'])
        return body,value

    def _request(self, request):
        if (type(request) is not dict or set(request) != {'mode','origin','unmanagedAdoption'}
                or request != self.request(request['mode'], request['origin'], unmanaged_adoption=request['mode']=='unmanaged')):
            raise fail()

    def _journal(self, dependencies, modules, *, history):
        path=Path(dependencies['namespace'])/'credential-journal'
        if not os.path.lexists(path):
            if history is not None: raise fail()
            return None
        if history is None: raise fail()
        with _directory(path) as fd:
            identity=_private_identity(os.fstat(fd))
            if set(os.listdir(fd))!={'writer.lock','sources','state.json'}: raise fail()
        journal=modules['writer_journal'].WriterJournal(path,create=False,validate_record=modules['writer_broker'].validate_record)
        try:
            state=journal.read()
            if state['active'] is not None: raise fail()
            return {'identity':identity,'stateSha256':digest(state)}
        finally:
            journal.close()

    def review(self, request):
        _root(); self._request(request)
        with self.host.credential_fence_lock(self.service.root,self.service.context) as guard:
            if guard.read() is not None:raise fail()
            self.service.require_credential_idle(guard)
            dependencies,modules=self.supervisor.snapshot(request)
            with _directory(dependencies['namespace']) as directory, _directory(self.service.state_dir) as config_dir:
                intent=_read(self.authority,directory,INTENT)
                if intent is not None and _metadata(intent).get('phase')!='complete':raise fail()
                return self.review_unlocked(request,dependencies,modules,directory,config_dir)

    def review_unlocked(self,request,dependencies,modules,directory,config_dir):
        old,history=self._history(directory);config=_read(self.authority,config_dir,C.CONFIG_NAME,16384)
        if history is None and config is not None or history is not None and (config is None or digest(config)!=history['configSha256']):raise fail()
        if history is not None and (history['installationId']!=dependencies['installationId'] or history['managedEver'] and request['mode']=='unmanaged'
                or dependencies['writerProtocol']<history['writerProtocol'] or _order(dependencies['sentinel']['version'])<_order(history['sentinelVersion'])):raise fail()
        journal=self._journal(dependencies,modules,history=history)
        return {'schema':SCHEMA,'root':str(self.service.root),'context':self.service.context,'request':request,'dependencies':dependencies,
                'journal':journal,'previousGeneration':history['generation'] if history else 0,'managedEver':bool(history and history['managedEver']),
                'previousHistorySha256':digest(old) if old is not None else None,'previousConfigSha256':digest(config) if config is not None else None}

    def _candidate(self,plan):
        d=plan['dependencies'];managed=plan['request']['mode']=='managed'
        return {'schema':'orbis.host.credential-admission.v1','writerProtocol':d['writerProtocol'],'root':plan['root'],'context':plan['context'],
                'installationId':d['installationId'],'mode':plan['request']['mode'],'origin':plan['request']['origin'],
                'recoveryEpoch':digest({'plan':digest(plan),'recovery':d['recovery']}) if managed else None,
                'runtimeDirectory':d['sentinel']['runtimeDirectory'],'runtimeFiles':d['sentinel']['runtimeFiles'],
                'journalDirectory':str(Path(d['namespace'])/'credential-journal'),
                'recoveryConfig':d['recovery']['config'] if managed else None,'recoveryConfigSha256':d['recovery']['configSha256'] if managed else None}

    def _authorization(self,path,expected_sha256,plan):
        # Independent private Root file, reviewed outside Main and never generated
        # by this program. Exact plan and installation bindings are all mandatory.
        if path is None: raise fail()
        path=Path(path)
        if path.parent != Path(plan['dependencies']['namespace'])/'recovery-admission-approvals' or path.suffix!='.json':raise fail()
        pinned=C.PinnedFile(path,limit=16384,private=True)
        try:
            value=_metadata(pinned.body)
            if (digest(pinned.body)!=expected_sha256 or set(value)!={'schema','planSha256','installationId','root','context','mode','approvalId'}
                    or value['schema']!='orbis.recovery-admission-authorization.v1' or not valid_hash(value['approvalId'])
                    or value['planSha256']!=digest(plan) or value['installationId']!=plan['dependencies']['installationId']
                    or value['root']!=plan['root'] or value['context']!=plan['context'] or value['mode']!=plan['request']['mode']):raise fail()
            fs=self.layout.R.filesystem(path)
            if fs['fsType']=='nsfs' or fs['identity']!=self.layout.R.filesystem(Path(plan['dependencies']['namespace']))['identity']:raise fail()
            storage=self.layout.R._durable_filesystem(fs)
            pinned.verify()
            return {'path':str(pinned.path),'sha256':digest(pinned.body),'identity':list(C.seal(os.fstat(pinned.file))[:6]),'filesystem':storage}
        finally:pinned.close()

    def _desired(self,plan,candidate):
        d=plan['dependencies']
        return {'schema':'orbis.recovery-admission-history.v1','installationId':d['installationId'],
                'generation':plan['previousGeneration']+1,'managedEver':plan['request']['mode']=='managed' or plan['managedEver'],
                'mode':plan['request']['mode'],'configSha256':digest(_encoded(candidate)),'planSha256':digest(plan),
                'sentinelVersion':d['sentinel']['version'],'writerProtocol':d['writerProtocol']}

    def apply(self,request,*,approved_plan_sha256,authorization,authorization_sha256):
        _root(); self._request(request)
        if not valid_hash(approved_plan_sha256) or not valid_hash(authorization_sha256):raise fail()
        with self.host.credential_fence_lock(self.service.root,self.service.context) as guard:
            return self._apply_locked(guard,request,approved_plan_sha256,authorization,authorization_sha256)

    def apply_retained_origin(self, guard, operation, *, approved_plan_sha256, authorization, authorization_sha256):
        """The exact existing-V1 transition keeps its original live Root fence."""
        _root()
        if not all(valid_hash(item) for item in (operation, approved_plan_sha256, authorization_sha256)):
            raise fail()
        self.service.require_credential_idle(guard)
        namespace = self.layout.namespace(self.service.root)
        sources = namespace / ORIGIN_OPERATIONS / operation
        with (_directory(sources) as directory, ExitStack() as resources):
            pins = []

            def read(name, maximum=16384, *, optional=False):
                if optional and not os.path.lexists(sources / name):
                    return None
                pin = C.PinnedFile(sources / name, limit=maximum, private=True)
                resources.callback(pin.close)
                if _mount_id(pin.file) != _mount_id(directory):
                    raise fail()
                pins.append(pin)
                return pin.body

            ready = _metadata(read('v1-ready.json'))
            review_body, approval_body, plan_body = read('review.json', 65536), read('approval.json'), read('v1-plan.json', 65536)
            review, approval, plan = map(_metadata, (review_body, approval_body, plan_body))
            review_sha, approval_sha = digest(review_body), digest(approval_body)
            prior_history, prior_config = read('prior-history.json'), read('prior-admission.json')
            binding = {'operationId': operation, 'installationId': plan['dependencies']['installationId'],
                       'reviewSha256': review_sha, 'approvalSha256': approval_sha}
            request = self.request('unmanaged', review['origin'], unmanaged_adoption=True)
            if (ready != {'schema': ORIGIN_READY, **binding, 'origin': request['origin'], 'main': plan['dependencies']['main'],
                          'envSha256': review['newEnvironmentSha256'], 'planSha256': approved_plan_sha256}
                    or review.get('schema') != ORIGIN_REVIEW or review.get('operationId') != operation
                    or (review.get('root'), review.get('context')) != (str(self.service.root), self.service.context)
                    or review.get('installationId') != binding['installationId']
                    or approval != {'schema': ORIGIN_APPROVAL, 'operationId': operation, 'installationId': binding['installationId'],
                                    'reviewSha256': review_sha, 'approvalId': approval.get('approvalId')}
                    or not valid_hash(approval.get('approvalId'))
                    or _metadata(read('intent.json')) != {'schema': ORIGIN_INTENT, **binding}
                    or digest(plan_body) != approved_plan_sha256 or canonical(plan) != plan_body
                    or plan['request'] != request or plan['managedEver'] is not False
                    or plan['previousGeneration'] < 1 or plan['previousGeneration'] != _metadata(prior_history).get('generation')
                    or plan['previousHistorySha256'] != digest(prior_history) or review['oldHistorySha256'] != digest(prior_history)
                    or plan['previousConfigSha256'] != digest(prior_config) or review['oldAdmissionSha256'] != digest(prior_config)):
                raise fail()
            candidate_body = read('candidate.json', optional=True)
            reused = candidate_body is None
            if reused and (review['oldOrigin'] != request['origin']
                    or review['oldEnvironmentSha256'] != review['newEnvironmentSha256']
                    or review['priorOriginFields'] != {'dotenv':True,'container':True}
                    or review['priorMain']['id'] != ready['main']['id']):
                raise fail()
            successor = ({key:ready['main'][key] for key in ('id','definitionSha256')}
                         | {'networksSha256':review['priorMain']['networksSha256']}
                         if reused else _metadata(candidate_body))
            if (set(successor) != {'id','definitionSha256','networksSha256'}
                    or successor['id'] != ready['main']['id']
                    or successor['definitionSha256'] != ready['main']['definitionSha256']
                    or not valid_hash(successor['networksSha256'])):
                raise fail()
            env_file = C.PinnedFile(self.service.root / '.env', limit=MAXIMUM, private=True)
            resources.callback(env_file.close)
            pins.append(env_file)
            if (authorization is None
                    or Path(authorization).parent != namespace / 'recovery-admission-approvals'
                    or Path(authorization).suffix != '.json'):
                raise fail()
            v1_authorization = C.PinnedFile(authorization, limit=16384, private=True)
            resources.callback(v1_authorization.close)
            pins.append(v1_authorization)
            if (digest(env_file.body) != ready['envSha256'] or digest(v1_authorization.body) != authorization_sha256):
                raise fail()
            owner = _OriginAdmission(_ORIGIN_OWNER, self.service, guard, ready, plan, tuple(pins), successor, reused)
            owner.verify(self.service, guard, plan['dependencies'], approved_plan_sha256)
            return self._apply_locked(guard, request, approved_plan_sha256, authorization, authorization_sha256, owner)

    def _apply_locked(self,guard,request,approved_plan_sha256,authorization,authorization_sha256,origin_owner=None):
        self.service.require_credential_idle(guard)
        dependencies,modules=self.supervisor.snapshot(request)
        def recheck_origin():
            if origin_owner is not None:
                if type(origin_owner) is not _OriginAdmission:
                    raise fail()
                origin_owner.verify(self.service, guard, dependencies, approved_plan_sha256)

        recheck_origin()
        publish = _write if origin_owner is None else _write_storage
        with _directory(dependencies['namespace']) as directory,_directory(self.service.state_dir) as config_dir:
            operation_id=digest({'plan':approved_plan_sha256,'authorization':authorization_sha256})
            archive='recovery-admission-'+operation_id+'.json'
            before=_read(self.authority,directory,INTENT)
            archived=_read(self.authority,directory,archive)
            if before is not None and archived is not None and before!=archived:raise fail()
            observed=before if before is not None else archived
            record=_metadata(observed) if observed is not None else None
            if archived is not None and (record.get('phase')!='complete' or record.get('planSha256')!=approved_plan_sha256):
                raise fail()
            if record is not None and record.get('planSha256')==approved_plan_sha256:
                fields={'schema','plan','planSha256','authorization','operationId','binding','phase','journalIdentity','candidate','history'}
                if (set(record)!=fields or record['schema']!='orbis.recovery-admission-intent.v1'
                        or record['phase'] not in ('intent','journal-allocated','journal-ready','history-ready','complete')
                        or record.get('plan',{}).get('request')!=request):raise fail()
                plan=record['plan']
                if plan['dependencies']!=dependencies:raise fail()
                auth=self._authorization(authorization,authorization_sha256,plan)
                if auth!=record['authorization']:raise fail()
            else:
                expected_binding=digest({'plan':approved_plan_sha256,'installation':dependencies['installationId']})
                if (record is not None or origin_owner is None and guard.read() not in
                        (None,guard._value(operation_id,expected_binding))):raise fail()
                plan=self.review_unlocked(request,dependencies,modules,directory,config_dir)
                if digest(plan)!=approved_plan_sha256:raise fail()
                auth=self._authorization(authorization,authorization_sha256,plan)
                candidate=self._candidate(plan)
                record={'schema':'orbis.recovery-admission-intent.v1','plan':plan,'planSha256':approved_plan_sha256,'authorization':auth,
                        'operationId':operation_id,
                        'binding':digest({'plan':approved_plan_sha256,'installation':dependencies['installationId']}),
                        'phase':'intent','journalIdentity':plan['journal']['identity'] if plan['journal'] else None,
                        'candidate':candidate,'history':self._desired(plan,candidate)}
                # The independently approved plan binds any existing ownership
                # proof. Retire it under the lifecycle hold before publishing
                # admission intent or any later recovery authority.
                if origin_owner is None: guard.begin(record['operationId'],record['binding'])
                self._retire_existing(guard,dependencies,approved_plan_sha256,authorization_sha256)
                body=_encoded(record);publish(self.authority,directory,INTENT,body,previous=before);before=body
            def save(phase):
                nonlocal before
                recheck_origin()
                record['phase']=phase;body=_encoded(record)
                publish(self.authority,directory,INTENT,body,previous=before);before=body
            if (digest(plan)!=approved_plan_sha256 or record['candidate']!=self._candidate(plan)
                    or record['history']!=self._desired(plan,record['candidate'])
                    or record['operationId']!=operation_id
                    or record['binding']!=digest({'plan':approved_plan_sha256,'installation':dependencies['installationId']})):raise fail()
            candidate=_encoded(record['candidate']);desired_body=_encoded(record['history'])
            if record['phase']=='complete':
                # Exact lost-reply recovery never advances history or creates a
                # second fence after the completed one was already retired.
                if (_read(self.authority,directory,HISTORY)!=desired_body or _read(self.authority,config_dir,C.CONFIG_NAME)!=candidate):raise fail()
            elif origin_owner is None:
                guard.begin(record['operationId'],record['binding'])
            if record['phase']!='complete':
                self._retire_existing(guard,dependencies,approved_plan_sha256,authorization_sha256)
            journal=Path(record['candidate']['journalDirectory'])
            if record['phase']=='intent':
                if plan['journal'] is None:
                    if os.path.lexists(journal):raise fail()
                    os.mkdir(journal.name,0o700,dir_fd=directory);os.fsync(directory)
                    with _directory(journal) as fd:record['journalIdentity']=_private_identity(os.fstat(fd))
                    save('journal-allocated')
                else:save('journal-ready')
            with _directory(journal) as fd:
                if _private_identity(os.fstat(fd))!=record['journalIdentity']:raise fail()
                # Existing/partial nonempty directories can never initialize.
                if record['phase']=='journal-allocated' and os.listdir(fd):raise fail()
            value=modules['writer_journal'].WriterJournal(journal,create=record['phase']=='journal-allocated',validate_record=modules['writer_broker'].validate_record)
            try:
                state=value.read()
                if state['active'] is not None:raise fail()
                if plan['journal'] is not None and digest(state)!=plan['journal']['stateSha256']:raise fail()
                if record['phase']=='journal-allocated':save('journal-ready')
                if record['phase']!='complete':
                    if request['mode']=='managed':self.supervisor.prove_route(plan)
                    current,_=self.supervisor.snapshot(request)
                    if current!=dependencies:raise fail()
                    old,_=self._history(directory)
                    config=_read(self.authority,config_dir,C.CONFIG_NAME,16384)
                    if old!=desired_body:
                        if (digest(old) if old is not None else None)!=plan['previousHistorySha256']:raise fail()
                        recheck_origin()
                        publish(self.authority,directory,HISTORY,desired_body,previous=old)
                    if record['phase']!='history-ready':save('history-ready')
                    # Credential config is the final dependency publication.
                    if config!=candidate:
                        if (digest(config) if config is not None else None)!=plan['previousConfigSha256']:raise fail()
                        recheck_origin()
                        publish(self.authority,config_dir,C.CONFIG_NAME,candidate,previous=config)
                    save('complete')
                def bound_terminal():
                    return (_read(self.authority,directory,HISTORY)==desired_body
                            and _read(self.authority,config_dir,C.CONFIG_NAME,16384)==candidate
                            and value.read()['active'] is None)

                terminal=_encoded(record)
                if not bound_terminal() or (before is not None and before!=terminal):
                    raise fail()
                current_guard=guard.read()
                recheck_origin()
                if origin_owner is None and current_guard is not None:
                    guard.check(operation_id,record['binding'])
                elif origin_owner is None and before is not None:
                    guard.begin(operation_id,record['binding'])
                if archived is None:
                    _write_storage(self.authority,directory,archive,terminal,previous=None)
                elif archived!=terminal:
                    raise fail()
                if before is not None:
                    if _read(self.authority,directory,INTENT)!=terminal:
                        raise fail()
                    os.unlink(INTENT,dir_fd=directory)
                    os.fsync(directory)

                def complete():
                    return (_read(self.authority,directory,archive)==terminal
                            and _read(self.authority,directory,INTENT) is None and bound_terminal())
                if origin_owner is None:
                    guard.finish(operation_id,record['binding'],verify_completed=complete)
                elif not complete():
                    raise fail()
                return {'schema':'orbis.recovery-admission-result.v1','mode':request['mode'],'state':'complete',
                        'planSha256':approved_plan_sha256,'configSha256':digest(candidate),'installationId':dependencies['installationId']}
            finally:value.close()

    def _retire_existing(self,guard,dependencies,plan_sha256,authorization_sha256):
        module=load('orbis-host-existing-ownership.py','orbis_admission_existing_retirement')
        expected=dependencies.get('existingOwnership')
        if module.retirement_reference(self.service)!=expected:raise fail()
        if expected is not None:
            module.retire_for_admission(self.service,guard,expected,plan_sha256=plan_sha256,
                                        authorization_sha256=authorization_sha256)


    def _bootstrap_predecessor(self, directory, history_body, admission, installation, origin, runtime):
        named, history = self._history(directory.fd)
        if (named != history_body or history['mode'] != 'unmanaged' or history['managedEver']
                or history['installationId'] != installation
                or history['configSha256'] != digest(admission)
                or _order(runtime['version']) < _order(history['sentinelVersion'])
                or C.PROTOCOL < history['writerProtocol']):
            raise fail()
        value = _metadata(admission)
        prior_runtime = ROOT / 'releases' / history['sentinelVersion'] / 'src/orbis_sentinel'
        expected = {'schema': 'orbis.host.credential-admission.v1', 'writerProtocol': history['writerProtocol'],
                    'root': str(self.service.root), 'context': self.service.context, 'installationId': installation,
                    'mode': 'unmanaged', 'origin': origin, 'recoveryEpoch': None, 'runtimeDirectory': str(prior_runtime),
                    'journalDirectory': str(directory.path / 'credential-journal'), 'recoveryConfig': None,
                    'recoveryConfigSha256': None}
        runtime_files = value.pop('runtimeFiles', None)
        if (value != expected or type(runtime_files) is not dict or set(runtime_files) != set(C.RUNTIME_FILES)
                or any(not valid_hash(item) for item in runtime_files.values())):
            raise fail()
        return history

    def _store_bootstrap_review(self, operation, body, recheck):
        with _directory(RECOVERY) as recovery:
            try:
                os.mkdir('bootstrap', 0o700, dir_fd=recovery)
                os.fsync(recovery)
            except FileExistsError:
                pass
        base = RECOVERY / 'bootstrap'
        with _directory(base) as operations:
            try:
                os.mkdir(operation, 0o700, dir_fd=operations)
                os.fsync(operations)
            except FileExistsError:
                pass
            with _directory(base / operation) as operation_directory:
                fcntl.flock(operation_directory, fcntl.LOCK_EX | fcntl.LOCK_NB)
                current = _read(self.authority, operation_directory, BOOTSTRAP_REVIEW_FILE, BOOTSTRAP_REVIEW_LIMIT)
                recheck()
                if current is None:
                    if set(os.listdir(operation_directory)) - {'.' + BOOTSTRAP_REVIEW_FILE + '.pending'}:
                        raise fail()
                    _write_storage(self.authority, operation_directory, BOOTSTRAP_REVIEW_FILE, body, previous=None)
                elif current != body:
                    raise fail()
                if _read(self.authority, operation_directory, BOOTSTRAP_REVIEW_FILE, BOOTSTRAP_REVIEW_LIMIT) != body:
                    raise fail()
                recheck()

    def review_bootstrap(self, operation, publication_operation, publication_sha256, origin):
        """Stage an eligible V1 review; issue no approval, lease, or writer authority."""
        _root()
        _origin(origin)
        if (self.service.state_dir != self.layout.STATE_ROOT
                or any(not valid_hash(value) for value in (operation, publication_operation, publication_sha256))):
            raise fail()
        root, context = self.service.root, self.service.context
        with self.host.credential_fence_lock(root, context) as guard, ExitStack() as resources:
            self.service.require_credential_idle(guard)
            if guard.read() is not None:
                raise fail()
            installation, main, daemon = self.supervisor._main(origin, storage_transition=True)
            host = self.supervisor._host_stopped()
            layout = self.layout.read(root, daemon, context)
            if layout is None:
                raise fail()
            runtime, modules, runtime_check = resources.enter_context(self.supervisor._held_runtime(storage_floor=True))
            private = modules['bootstrap_source']
            floor = modules['credential_floor']
            installation_root = floor._InstallationDirectory(root)
            resources.callback(installation_root.close)
            namespace = self.layout.namespace(root)
            roles = {'installation': installation_root}
            for key, path in (('namespace', namespace), ('journal', namespace / 'credential-journal'), ('recovery', RECOVERY)):
                roles[key] = resources.enter_context(private.PrivateDirectory(path))
            directory = roles['namespace']
            reader = floor.CredentialFloorReader(root, context, daemon, host_state_directory=self.service.state_dir)
            config = resources.enter_context(private.PrivateDirectory(self.service.state_dir))
            prior = resources.enter_context(private.PrivateFile(directory, HISTORY, 16384))
            admission = resources.enter_context(private.PrivateFile(config, C.CONFIG_NAME, 16384))
            history = self._bootstrap_predecessor(directory, prior.body, admission.body, installation, origin, runtime)
            if (reader._pending(namespace) or reader._storage_started(namespace)
                    or digest({'root': str(root), 'context': context, 'daemon': daemon,
                               'rootIdentity': installation_root.identity}) != installation):
                raise fail()
            journal = self._journal({'namespace': str(namespace)}, modules, history=history)
            recovery, recovery_check = resources.enter_context(
                self.supervisor.bootstrap_recovery(origin, main, runtime, modules, installation_id=installation))
            storage_reader = modules['credential_storage']
            storage = {key: storage_reader.observe(role) for key, role in roles.items()}
            copy = host['custody']
            host_binding = {'inventorySha256': digest(copy['sourceFiles']), 'unitSha256': copy['unitSha256'],
                            'environmentSha256': copy['environmentSha256']}
            published = modules['host_source_publication']
            evidence = resources.enter_context(published.read_completed_for_bootstrap_review(publication_operation,
                root=root, context=context, current={'main': main, 'host': host_binding},
                root_identity=installation_root.identity, receipt_sha256=publication_sha256))
            collector = copy['sourceFiles'].get('orbis-host-recovery-source.py')
            if not valid_hash(collector):
                raise fail()

            def recheck():
                self.service.require_credential_idle(guard)
                for pinned in (prior, admission):
                    pinned.verify()
                runtime_check()
                recovery_check()
                evidence.recheck()
                if (guard.read() is not None or reader._pending(namespace) or reader._storage_started(namespace)
                        or self.supervisor._main(origin, storage_transition=True) != (installation, main, daemon)
                        or self.supervisor._host_stopped() != host or self.layout.read(root, daemon, context) != layout
                        or self._journal({'namespace': str(namespace)}, modules, history=history) != journal
                        or {key: storage_reader.observe(role) for key, role in roles.items()} != storage):
                    raise fail()

            plan = {'schema': BOOTSTRAP_REVIEW, 'operationId': operation, 'root': str(root), 'context': context,
                    'installationId': installation, 'origin': origin, 'captureRoot': str(namespace / 'bootstrap-sources'),
                    'hostHistorySha256': digest(prior.body), 'previousGeneration': history['generation'],
                    'previousAdmissionSha256': digest(admission.body), 'previousSentinelVersion': history['sentinelVersion'],
                    'previousWriterProtocol': history['writerProtocol'], 'daemon': daemon, 'layoutSha256': digest(layout),
                    'main': main, 'host': {**host_binding, 'effectiveSha256': host['systemdSha256']},
                    'collector': {'protocol': 'orbis.stopped-main-source.v1', 'programSha256': collector,
                                  'imageId': main['imageId'], 'inventorySha256': host_binding['inventorySha256']},
                    'publisher': {'operationId': publication_operation, 'receiptSha256': publication_sha256},
                    'runtime': runtime, 'recovery': recovery, 'storage': storage, 'journal': journal}
            body = canonical(plan)
            if len(body) > BOOTSTRAP_REVIEW_LIMIT:
                raise fail()
            recheck()
            self._store_bootstrap_review(operation, body, recheck)
            return {'plan': plan, 'planSha256': digest(body), 'phase': 'v1-bootstrap-review'}

    def review_storage(self, publication_operation):
        _root()
        if not valid_hash(publication_operation):
            raise fail()
        with self.host.credential_fence_lock(self.service.root, self.service.context) as guard:
            self.service.require_credential_idle(guard)
            namespace = self.layout.namespace(self.service.root)
            with _directory(namespace) as directory, _directory(self.service.state_dir) as config_directory:
                if (guard.read() is not None or _read(self.authority, directory, STORAGE_INTENT) is not None
                        or _read(self.authority, directory, STORAGE_COMPLETE) is not None):
                    raise fail()
                config = _metadata(_read(self.authority, config_directory, C.CONFIG_NAME, 16384))
                with self.supervisor.storage_floor(config) as (module, reader, check):
                    with reader.snapshot() as snapshot:
                        if snapshot.report.classification!='record-consistent' or snapshot._value is None:
                            raise fail()
                        transition = check(snapshot._value)
                        with module.prepare_storage_upgrade(snapshot, publication_operation=publication_operation,
                                                            creation_transition=transition) as upgrade:
                            packet = _encoded({'schema':'orbis.credential-storage-upgrade-packet.v1',
                                'publisher':publication_operation, 'payload':{
                                    name:base64.b64encode(getattr(upgrade,name)).decode('ascii') for name in STORAGE_FILES}})
                            return {'plan':_metadata(upgrade.plan), 'planSha256':digest(upgrade.plan),
                                    'packet':packet.decode('ascii'), 'packetSha256':digest(packet)}

    def _storage_approval(self, namespace, path, expected, plan, packet_sha256):
        path = Path(path)
        if path.parent != namespace/'recovery-admission-approvals' or path.suffix != '.json':
            raise fail()
        pin = C.PinnedFile(path, limit=16384, private=True)
        try:
            actual = _metadata(pin.body)
            if (digest(pin.body) != expected or set(actual) != {'schema','planSha256','packetSha256','installationId','root','context','approvalId'}
                    or actual['schema'] != 'orbis.credential-storage-upgrade-approval.v1'
                    or actual['planSha256'] != digest(plan) or actual['packetSha256'] != packet_sha256
                    or actual['installationId'] != _metadata(plan)['installationId']
                    or actual['root'] != str(self.service.root) or actual['context'] != self.service.context
                    or not valid_hash(actual['approvalId'])
                    or self.layout.R.filesystem(path) != self.layout.R.filesystem(namespace)):
                raise fail()
            pin.verify()
            return pin
        except BaseException:
            pin.close()
            raise

    def _storage_upgrade(self, module, packet, publication_operation):
        if (type(packet) is not dict or set(packet) != {'schema','publisher','payload'}
                or packet['schema'] != 'orbis.credential-storage-upgrade-packet.v1'
                or packet['publisher'] != publication_operation
                or type(packet['payload']) is not dict or set(packet['payload']) != set(STORAGE_FILES)):
            raise fail()
        bodies = {}
        for name in STORAGE_FILES:
            value = packet['payload'][name]
            if type(value) is not str or not 0 < len(value) <= 87384:
                raise fail()
            raw = base64.b64decode(value, validate=True)
            if not 0 < len(raw) <= 65536 or base64.b64encode(raw).decode('ascii') != value:
                raise fail()
            bodies[name] = raw
        return module.StorageUpgrade(**bodies)

    def apply_storage(self, publication_operation, *, approved_plan_sha256, authorization, authorization_sha256):
        """Apply only an exact, reviewed offline v2 to v3 storage migration."""
        _root()
        if not all(valid_hash(item) for item in (publication_operation, approved_plan_sha256, authorization_sha256)):
            raise fail()
        authority = self.authority
        namespace = self.layout.namespace(self.service.root)
        with self.host.credential_fence_lock(self.service.root, self.service.context) as guard:
            self.service.require_credential_idle(guard)
            with _directory(namespace) as directory, _directory(self.service.state_dir) as config_directory, ExitStack() as resources:
                saved = _read(authority, directory, STORAGE_INTENT)
                complete = _read(authority, directory, STORAGE_COMPLETE)
                if saved is not None and complete is not None and saved != complete:
                    raise fail()
                config = _read(authority, config_directory, C.CONFIG_NAME, 16384)
                module, reader, check_source = resources.enter_context(self.supervisor.storage_floor(_metadata(config)))
                path = namespace/'recovery-admission-approvals'/(approved_plan_sha256+'.storage-packet.json')
                try:
                    packet_pin = C.PinnedFile(path, limit=512*1024, private=True)
                except FileNotFoundError:
                    raise fail() from None
                resources.callback(packet_pin.close)
                if self.layout.R.filesystem(path) != self.layout.R.filesystem(namespace):
                    raise fail()
                packet = _metadata(packet_pin.body)
                upgrade = self._storage_upgrade(module, packet, publication_operation)
                candidate, prior, plan = map(_metadata,(upgrade.history,upgrade.predecessor,upgrade.plan))
                if approved_plan_sha256 != digest(upgrade.plan) or digest(config) != prior['configSha256']:
                    raise fail()
                approval = self._storage_approval(namespace, authorization, authorization_sha256, upgrade.plan,
                                                   digest(packet_pin.body))
                resources.callback(approval.close)
                info = os.fstat(approval.file)
                expected = {'schema':'orbis.credential-storage-migration.v1',
                            'publisher':publication_operation, 'approvalSha256':authorization_sha256,
                            'packetSha256':digest(packet_pin.body), 'approvalIdentity':{
                                'path':str(approval.path), 'inode':str(info.st_ino),
                                'owner':[info.st_uid,info.st_gid,info.st_mode,info.st_nlink]},
                            'payload':packet['payload']}
                recorded = saved if saved is not None else complete
                record = {**expected,'phase':'intent'} if recorded is None else _metadata(recorded)
                if (record.get('phase') not in STORAGE_PHASES
                        or {key:value for key,value in record.items() if key!='phase'} != expected):
                    raise fail()
                recheck = resources.enter_context(reader.verify_storage_upgrade(upgrade, publication_operation=publication_operation))
                operation = digest({'storagePlan':approved_plan_sha256, 'approvalSha256':authorization_sha256})
                binding = digest({'installationId':prior['installationId'], 'historySha256':digest(upgrade.history)})
                def verify():
                    approval.verify()
                    packet_pin.verify()
                    recheck()
                    if check_source(prior) != plan['mainCreationTransition']:
                        raise fail()
                    if _read(authority,config_directory,C.CONFIG_NAME,16384) != config:
                        raise fail()

                verify()
                current_guard = guard.read()
                if current_guard is not None:
                    guard.check(operation,binding)
                if recorded is None:
                    if _read(authority,directory,HISTORY) != upgrade.predecessor:
                        raise fail()
                    if current_guard is None:
                        # A first apply must still hold and verify the original v2.
                        # Exact owned fence recovery instead reuses the same Root packet.
                        with reader.snapshot() as historical:
                            if historical.report.classification!='record-consistent' or historical.report.history_sha256!=digest(upgrade.predecessor):
                                raise fail()
                            verify()
                    guard.begin(operation,binding)
                    verify()
                    saved = _encoded(record)
                    _write_storage(authority,directory,STORAGE_INTENT,saved,previous=None)
                elif complete is None:
                    if current_guard is None:
                        raise fail()
                elif record['phase']!='complete':
                    raise fail()

                def advance(phase):
                    nonlocal saved
                    if STORAGE_PHASES.index(record['phase']) >= STORAGE_PHASES.index(phase):
                        return
                    verify()
                    guard.check(operation, binding)
                    record['phase'] = phase
                    next_body = _encoded(record)
                    _write_storage(authority, directory, STORAGE_INTENT, next_body, previous=saved)
                    saved = next_body

                def artifact(folder, name, body, phase):
                    path = namespace / folder
                    attained = STORAGE_PHASES.index(record['phase']) >= STORAGE_PHASES.index(phase)
                    if not os.path.lexists(path):
                        if attained:
                            raise fail()
                        os.mkdir(folder, 0o700, dir_fd=directory)
                        os.fsync(directory)
                    with _directory(path) as fd:
                        if _mount_id(fd) != _mount_id(directory):
                            raise fail()
                        actual = _read(authority, fd, name)
                        if actual != body:
                            if actual is not None or attained:
                                raise fail()
                            guard.check(operation, binding)
                            verify()
                            _write_storage(authority, fd, name, body, previous=None)
                        if _read(authority, fd, name) != body:
                            raise fail()
                    advance(phase)

                artifact(module.ARCHIVE, digest(upgrade.predecessor) + '.json', upgrade.predecessor, 'archive-ready')
                artifact(module.storage.BRIDGE_DIRECTORY, digest(upgrade.bridge) + '.json', upgrade.bridge, 'bridge-ready')
                actual = _read(authority, directory, HISTORY)
                if actual != upgrade.history:
                    if actual != upgrade.predecessor or STORAGE_PHASES.index(record['phase']) >= STORAGE_PHASES.index('history-ready'):
                        raise fail()
                    guard.check(operation, binding)
                    verify()
                    _write_storage(authority, directory, HISTORY, upgrade.history, previous=actual)
                advance('history-ready')
                # The storage-only migration must leave the protected credential
                # configuration byte-identical. Verify it LAST under the fence.
                if _read(authority, config_directory, C.CONFIG_NAME, 16384) != config or candidate['configSha256'] != digest(config):
                    raise fail()
                advance('config-verified')
                advance('complete')
                if complete is None:
                    complete = saved
                    _write_storage(authority, directory, STORAGE_COMPLETE, complete, previous=None)
                elif saved is not None and saved != complete:
                    raise fail()

                def completed():
                    verify()
                    return _read(authority, directory, STORAGE_COMPLETE) == complete and _read(authority, directory, HISTORY) == upgrade.history

                guard.finish(operation, binding, verify_completed=completed)
                if saved is not None:
                    if _read(authority, directory, STORAGE_INTENT) != complete:
                        raise fail()
                    os.unlink(STORAGE_INTENT, dir_fd=directory)
                    os.fsync(directory)
                return {'schema': 'orbis.credential-storage-migration-result.v1', 'planSha256': approved_plan_sha256,
                        'historySha256': digest(upgrade.history), 'generation': candidate['generation'],
                        'installationId': candidate['installationId']}


# Prospective recovery origin for an existing unmanaged V1 installation.
ORIGIN_REQUEST = 'orbis.recovery-origin-request.v1'
ORIGIN_INGRESS = 'orbis.recovery-origin-ingress.v1'
ORIGIN_COMPLETE = 'orbis.recovery-origin-complete.v1'
ORIGIN_ABORT = 'orbis.recovery-origin-abort.v1'
ORIGIN_EDGE_ROOT = Path('/var/lib/orbis-sentinel/recovery-https')
ORIGIN_KEY = 'ORBIS_SENTINEL_RECOVERY_ORIGIN'
ORIGIN_MAX_ENV = 1024 * 1024
ORIGIN_PROXY_NAMES = ('runtipi-reverse-proxy',)
ORIGIN_TRAEFIK_VERSIONS = ('3.6.12', '3.6.5')
ORIGIN_GUARD_FILE = 'orbis-sentinel-recovery-host.json'
ORIGIN_GUARD_NAMES = ('orbis-recovery-sink@file', 'orbis-recovery-tls-sink@file')
ORIGIN_TLS_OPTION = 'orbis-recovery-strict@file'
ORIGIN_GUARD_PRIORITY = 2147482000
ORIGIN_NOOP_STATUS = 418  # Traefik 3.6.5 and 3.6.12 internalhandler.go.
ORIGIN_DOTENV = re.compile(rb"([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)"
                    rb"('[^']*'|\"[^\"\\]*\"|[^'\"\\#]*?)([ \t]*(?:#.*)?)")
ORIGIN_HOST = r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+'
ORIGIN_MATCH_HOST = re.compile(r'Host\([`"](' + ORIGIN_HOST + r')[`"]\)(?: && PathPrefix\([`"]/[^"` ]*[`"]\))?\Z')
ORIGIN_TLS_ALERTS = frozenset(('TLSV1_UNRECOGNIZED_NAME', 'TLSV1_ALERT_UNRECOGNIZED_NAME'))


def _origin_fail():
    return ValueError('The retained recovery origin needs exact Root reconciliation.')


def _origin_value(body):
    value = _metadata(body)
    if not isinstance(value, dict) or canonical(value) != body:
        raise _origin_fail()
    return value


def _parse_prospective_origin(origin):
    url = _origin(origin)
    if (not re.fullmatch(ORIGIN_HOST, url.hostname) or url.hostname.replace('.', '').isdigit()
            or url.port is None or not 1024 <= url.port <= 65535 or origin != f'https://{url.hostname}:{url.port}'):
        raise _origin_fail()
    return url


def _origin_guard_spec(hostname):
    body = {'http': {'routers': {}}, 'tls': {'options': {'orbis-recovery-strict': {'sniStrict': True}}}}
    for name, port in zip(ORIGIN_GUARD_NAMES, ('web', 'websecure')):
        route = {'rule': f'Host("{hostname}")', 'entryPoints': [port], 'priority': ORIGIN_GUARD_PRIORITY,
                 'service': 'noop@internal'}
        if port == 'websecure':
            route['tls'] = {'options': ORIGIN_TLS_OPTION}
        body['http']['routers'][name.removesuffix('@file')] = route
    return body


def _origin_route_map(routes):
    if type(routes) is not list or len(routes) > 2048:
        raise _origin_fail()
    result = {}
    for route in routes:
        if (type(route) is not dict or type(route.get('name')) is not str or not 1 <= len(route['name']) <= 256
                or route['name'] in result):
            raise _origin_fail()
        result[route['name']] = route
    return result


def _origin_ordinary(route):
    return {name: route.get(name) for name in ('entryPoints', 'rule', 'priority', 'service', 'tls', 'middlewares', 'status')}


def _origin_guards(hostname, http, tcp, entries, *, present):
    """Validate the closed owned profile and the exact effective file-provider exclusion."""
    if set(entries) != {'web', 'websecure', 'traefik'}:
        raise _origin_fail()
    expected_endpoints = {'web': ':80', 'websecure': ':443', 'traefik': ':8080'}
    if any(entries[name].get('address') != address for name, address in expected_endpoints.items()):
        raise _origin_fail()
    for route in tcp.values():
        # A TCP match would run before the HTTP Host sink. The first supported
        # stock deployment has none on either published endpoint.
        if route.get('status') != 'disabled' and set(route.get('entryPoints') or []) & {'web', 'websecure'}:
            raise _origin_fail()
    spec = _origin_guard_spec(hostname)['http']['routers']
    redirects = False
    for name, route in http.items():
        ports = route.get('entryPoints')
        if type(ports) is not list or not ports or set(ports) - set(entries):
            raise _origin_fail()
        if route.get('status') != 'enabled':
            if route.get('status') != 'disabled' or name in ORIGIN_GUARD_NAMES or route.get('error'):
                raise _origin_fail()
            continue
        if not set(ports) & {'web', 'websecure'}:
            continue
        if name in ORIGIN_GUARD_NAMES:
            if not present:
                raise _origin_fail()
            expected = spec[name.removesuffix('@file')]
            if (any(route.get(field) != value for field, value in expected.items() if field not in ('tls', 'rule'))
                    or route.get('rule') not in (expected['rule'], expected['rule'].replace('"', '`'))
                    or route.get('tls') != expected.get('tls')
                    or route.get('middlewares') not in (None, [])):
                raise _origin_fail()
            continue
        if name == 'acme-http@internal':
            if ports != ['web'] or route.get('service') != 'acme-http@internal' or route.get('rule') not in (
                    'PathPrefix(`/.well-known/acme-challenge/`)', 'PathPrefix("/.well-known/acme-challenge/")'):
                raise _origin_fail()
            continue
        if name == 'web-to-websecure@internal':
            if (ports != ['web'] or route.get('service') != 'noop@internal'
                    or route.get('middlewares') != ['redirect-web-to-websecure@internal']
                    or type(route.get('priority')) is not int or route['priority'] <= ORIGIN_GUARD_PRIORITY):
                raise _origin_fail()
            redirects = True
            continue
        if type(route.get('priority')) is not int or route['priority'] >= ORIGIN_GUARD_PRIORITY:
            raise _origin_fail()
        match = ORIGIN_MATCH_HOST.fullmatch(route.get('rule', ''))
        if match is not None and match[1] != hostname:
            continue
        if (name not in ('dashboard@docker', 'dashboard-secure@docker')
                or route.get('service') not in ('dashboard', 'dashboard@docker')
                or ports != (['websecure'] if name == 'dashboard-secure@docker' else ['web'])
                or route.get('rule') not in ('PathPrefix(`/`)', 'PathPrefix("/")')):
            raise _origin_fail()
    if any(name not in http or http[name].get('status') != 'enabled' for name in ('dashboard@docker', 'dashboard-secure@docker')):
        raise _origin_fail()
    if present and any(name not in http for name in ORIGIN_GUARD_NAMES):
        raise _origin_fail()
    return {'routers': {name: _origin_ordinary(route) for name, route in http.items() if name not in ORIGIN_GUARD_NAMES},
            'tcpSha256': digest(tcp), 'entrypointSha256': digest(entries), 'redirect': redirects}


def _origin_common_ports(main, proxy, lan_address):
    main_host = main['HostConfig']
    if (main_host.get('PortBindings') not in (None, {}) or main_host.get('PublishAllPorts') is not False
            or main_host.get('NetworkMode') in ('host', 'none') or proxy['HostConfig'].get('NetworkMode') in ('host', 'none')
            or proxy['HostConfig'].get('PublishAllPorts') is not False):
        raise _origin_fail()
    declared, observed = proxy['HostConfig'].get('PortBindings'), proxy['NetworkSettings'].get('Ports')
    if (type(declared) is not dict or type(observed) is not dict or set(declared) != {'80/tcp', '443/tcp'}
            or set(observed) - {'80/tcp', '443/tcp', '8080/tcp'} or observed.get('8080/tcp') is not None):
        raise _origin_fail()
    endpoints = {}
    for named in ('80/tcp', '443/tcp'):
        ports = declared[named]
        if type(ports) is not list or len(ports) != 1 or type(ports[0]) is not dict or set(ports[0]) != {'HostIp', 'HostPort'}:
            raise _origin_fail()
        entry = ports[0]
        number = entry['HostPort']
        if (type(number) is not str or not re.fullmatch(r'[1-9][0-9]{0,4}', number) or int(number) > 65535
                or entry['HostIp'] not in ('', '0.0.0.0', lan_address)):
            raise _origin_fail()
        actual = observed.get(named)
        if (type(actual) is not list or not actual or len(actual) > 2 or any(type(row) is not dict
                or set(row) != {'HostIp', 'HostPort'} or row['HostPort'] != number for row in actual)):
            raise _origin_fail()
        addresses = {row['HostIp'] for row in actual}
        permitted = {lan_address} if entry['HostIp'] == lan_address else {'0.0.0.0', '::'}
        if not addresses <= permitted or len(addresses) != len(actual) or not addresses - {'::'}:
            raise _origin_fail()
        endpoints['http' if named == '80/tcp' else 'https'] = int(number)
    if len(set(endpoints.values())) != 2:
        raise _origin_fail()
    return endpoints


def _origin_deadline(stream, expires):
    remaining = expires - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('Retained recovery ingress probe expired')
    stream.settimeout(remaining)


def _origin_probe(address, port, *, host, name=None, context=None, unknown_sni=False, path='/', leaf_sha=None):
    expires = time.monotonic() + 3
    with ExitStack() as sockets:
        raw = sockets.enter_context(socket.socket(socket.AF_INET, socket.SOCK_STREAM))
        _origin_deadline(raw, expires)
        raw.connect((address, port))
        stream = raw
        if name is not None:
            _origin_deadline(raw, expires)
            try:
                stream = sockets.enter_context(context.wrap_socket(raw, server_hostname=name))
            except ssl.SSLError as error:
                if unknown_sni and error.reason in ORIGIN_TLS_ALERTS:
                    return {'tls': 'unknown-sni'}
                raise _origin_fail() from None
            if leaf_sha is not None and digest(stream.getpeercert(binary_form=True)) != leaf_sha:
                raise _origin_fail()
            if unknown_sni:
                # Any presented certificate for this name is unsafe for this
                # initial strict-SNI profile, including a SAN or wildcard match.
                raise _origin_fail()
        _origin_deadline(stream, expires)
        stream.sendall(f'GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n'.encode('ascii'))
        received = bytearray()
        while b'\r\n\r\n' not in received:
            _origin_deadline(stream, expires)
            data = stream.recv(min(4096, 16385 - len(received)))
            if not data:
                raise _origin_fail()
            received.extend(data)
            if len(received) > 16384:
                raise _origin_fail()
        source = SimpleNamespace(makefile=lambda *args: io.BytesIO(received))
        with http.client.HTTPResponse(source) as response:
            try:
                response.begin()
            except http.client.HTTPException:
                raise _origin_fail() from None
            pairs = response.getheaders()
            if (len(pairs) > 64 or sum(len(key) + len(item) for key, item in pairs) > 16384
                    or len(response.headers.get_all('Location') or []) > 1
                    or len(response.headers.get_all('Content-Type') or []) > 1):
                raise _origin_fail()
            return {'status': response.status, 'location': response.getheader('Location'),
                    'contentType': response.getheader('Content-Type'), 'cookies': bool(response.headers.get_all('Set-Cookie'))}


def _origin_plain_tls_context():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _origin_checks(address, ports, host, recovery_host, redirect, context, probe=_origin_probe):
    plain = probe(address, ports['http'], host=recovery_host)
    if plain['cookies']:
        raise _origin_fail()
    if redirect:
        target = urlsplit(plain['location'] or '')
        if (plain['status'] not in (301, 308) or target.scheme != 'https' or target.hostname != recovery_host
                or (target.port or 443) != ports['https'] or target.path not in ('', '/')
                or target.query or target.fragment or target.username is not None or target.password is not None):
            raise _origin_fail()
    elif plain['status'] != ORIGIN_NOOP_STATUS or plain['location'] is not None:
        raise _origin_fail()
    absent = probe(address, ports['https'], host=recovery_host, name=recovery_host, context=_origin_plain_tls_context(), unknown_sni=True)
    front = probe(address, ports['https'], host=recovery_host, name=host, context=context)
    dashboard = probe(address, ports['https'], host=host, name=host, context=context, path='/dashboard')
    if (absent != {'tls': 'unknown-sni'} or front['status'] not in (421, ORIGIN_NOOP_STATUS) or front['cookies'] or front['location'] is not None
            or dashboard['status'] != 200 or not (dashboard['contentType'] or '').startswith('text/html')):
        raise _origin_fail()
    return {'http': plain['status'], 'https': absent['tls'], 'crossSNI': front['status'], 'dashboard': dashboard['status']}


def _origin_environment(body, origin, old_origin):
    """Handle stock single-line dotenv, preserving all unrelated original bytes."""
    body.decode('utf8', errors='strict')
    origin_bytes = origin.encode('ascii')
    key = ORIGIN_KEY.encode('ascii')
    rows = body.splitlines(keepends=True)
    matches = 0
    updated = []
    for line in rows:
        ending = b'\r\n' if line.endswith(b'\r\n') else b'\n' if line.endswith(b'\n') else b''
        raw = line[:-len(ending)] if ending else line
        if b'\r' in raw or b'\x00' in raw:
            raise _origin_fail()
        if not raw.strip() or raw.lstrip().startswith(b'#'):
            updated.append(line)
            continue
        match = ORIGIN_DOTENV.fullmatch(raw)
        if match is None:
            raise _origin_fail()
        if match[2] != key:
            updated.append(line)
            continue
        matches += 1
        before = match[4]
        value = before[1:-1] if before.startswith((b"'", b'"')) else before
        if value.decode('ascii') != old_origin:
            raise _origin_fail()
        if value == origin_bytes:
            updated.append(line)
        else:
            updated.append(match[1] + key + match[3] + b"'" + origin_bytes + b"'" + match[5] + ending)
    if matches > 1:
        raise _origin_fail()
    if not matches:
        if body and not body.endswith(b'\n'):
            updated.append(b'\n')
        updated.append(key + b"='" + origin_bytes + b"'\n")
    return b''.join(updated), bool(matches)


def _origin_dashboard_hosts(raw, env):
    fields = {'LOCAL_DOMAIN', 'DOMAIN'}
    installed, deployment = {}, {}
    for entry in raw['Config']['Env']:
        key, _, value = entry.partition('=')
        if key in fields:
            if key in installed:
                raise _origin_fail()
            installed[key] = value
    for line in env.splitlines():
        match = ORIGIN_DOTENV.fullmatch(line)
        if match is not None and (key := match[2].decode('ascii')) in fields:
            if key in deployment:
                raise _origin_fail()
            item = match[4].decode('ascii')
            deployment[key] = item[1:-1] if item.startswith(('"', "'")) else item
    names = {value.lower().removesuffix('.') for value in (*installed.values(), *deployment.values()) if value}
    if not names or any(not re.fullmatch(ORIGIN_HOST, name) for name in names):
        raise _origin_fail()
    return sorted(names)


def _origin_new_config(raw, before, origin):
    config = copy.deepcopy(raw['Config'])
    source = config['Env']
    if type(source) is not list or any(type(item) is not str or '=' not in item for item in source):
        raise _origin_fail()
    keys = [item.split('=', 1)[0] for item in source]
    if len(keys) != len(set(keys)):
        raise _origin_fail()
    found = [item.split('=', 1)[1] for item in source if item.startswith(ORIGIN_KEY + '=')]
    if found not in ([], [before]):
        raise _origin_fail()
    replace = ORIGIN_KEY + '=' + origin
    config['Env'] = [replace if item.startswith(ORIGIN_KEY + '=') else item for item in source]
    if not found:
        config['Env'].append(replace)
    return config


def _origin_definition(raw):
    return digest(CONTAINER_DEFINITION.normalize({key: raw[key] for key in ('Config', 'HostConfig', 'Mounts', 'Path', 'Args')}))


def _origin_canonical_host(value):
    result = copy.deepcopy(value)
    if result.get('OomKillDisable') is None:
        result['OomKillDisable'] = False
    return result


def _origin_creation(raw, before, origin, observe):
    host = _origin_canonical_host(raw['HostConfig'])
    host['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}
    endpoints = {name: {key: item for key, item in facts.items() if key != 'NetworkID'}
                 for name, facts in _origin_networks(raw, observe).items()}
    return {**_origin_new_config(raw, before, origin), 'HostConfig': host, 'NetworkingConfig': {'EndpointsConfig': endpoints}}


def _origin_candidate(raw, original, body, name, observe):
    if raw is None:
        raise _origin_fail()
    _origin_never_started(raw)
    config = {key: item for key, item in body.items() if key not in ('HostConfig', 'NetworkingConfig')}
    if (not valid_hash(raw['Id']) or raw['Id'] == original['Id'] or raw['Name'] not in ('/' + name, '/runtipi')
            or raw['Image'] != original['Image'] or raw['Config'] != config
            or _origin_canonical_host(raw['HostConfig']) != body['HostConfig']
            or set(raw['NetworkSettings']['Networks']) != set(body['NetworkingConfig']['EndpointsConfig'])
            or raw['Path'] != original['Path'] or raw['Args'] != original['Args'] or CONTAINER_DEFINITION.mounts(raw['Mounts']) != CONTAINER_DEFINITION.mounts(original['Mounts'])):
        raise _origin_fail()
    networks = _origin_networks(raw, observe)
    if networks != _origin_networks(original, observe):
        raise _origin_fail()
    return {'id': raw['Id'], 'definitionSha256': _origin_definition(raw), 'networksSha256':digest(networks)}


def _origin_identity(root):
    info = root.lstat()
    return [info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode]


class OriginObservations:
    def __init__(self, service):
        self.proxy = load('orbis-proxy-identity.py', 'orbis_origin_proxy_identity')
        self.proxy_adoption = load('orbis-proxy-adoption.py', 'orbis_origin_proxy_adoption')
        retained = load('orbis-host-retained-restore-runtime.py', 'orbis_origin_retained_runtime')
        self.service = service
        self.root, self.context = service.root, service.context
        self.runtime = retained.DockerRestoreRuntime(SimpleNamespace(
            host=service.HOST, authority=service.HOST.AUTHORITY, root=self.root, context=self.context))
        self.reader = self.runtime.reader

    def local_daemon(self):
        selected = self.reader.socket()
        if selected != '/var/run/docker.sock' and selected != '/run/docker.sock':
            raise _origin_fail()
        observed = self.reader.daemon()
        if type(observed) is not str or not re.fullmatch(r'[!-~]{1,256}', observed):
            raise _origin_fail()
        return observed

    def inspect(self, identifier):
        return self.reader._object(['container', 'inspect', '--format', '{{json .}}', identifier])

    def named(self, name):
        lines = self.reader._read(['container', 'ls', '-a', '--no-trunc',
                                   '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}']).splitlines()
        if len(lines) > 1 or any(not valid_hash(item) for item in lines):
            raise _origin_fail()
        if not lines:
            return None
        value = self.inspect(lines[0])
        if value['Name'] != '/' + name or value['Id'] != lines[0]:
            raise _origin_fail()
        return value

    def _bridge(self, main, proxy):
        main_network = main['NetworkSettings']['Networks']
        proxy_network = proxy['NetworkSettings']['Networks']
        if len(main_network) != 1 or set(main_network) != set(proxy_network):
            raise _origin_fail()
        name = next(iter(main_network))
        value = self.reader._object(['network', 'inspect', '--format', '{{json .}}', name])
        if (value['Driver'] != 'bridge' or value['Id'] != main_network[name]['NetworkID']
                or value['Id'] != proxy_network[name]['NetworkID']):
            raise _origin_fail()
        return name

    def network(self, name):
        return self.reader._object(['network', 'inspect', '--format', '{{json .}}', name])

    def _api(self, main, proxy, network, path):
        address = ipaddress.IPv4Address(proxy['NetworkSettings']['Networks'][network]['IPAddress'])
        if path not in ('http/routers', 'tcp/routers', 'entrypoints'):
            raise _origin_fail()
        url = f'http://{address}:8080/api/{path}'
        code = ("const r=await fetch(" + json.dumps(url)
                + ",{redirect:'error',signal:AbortSignal.timeout(2000)});if(!r.ok)process.exit(2);"
                  "let size=0;for await(const chunk of r.body){size+=chunk.length;"
                  "if(size>1048576)process.exit(3);process.stdout.write(chunk);}")
        body = self.runtime.bounded_output(['docker', '--context', self.context, 'exec', main['Id'],
                                            'node', '--input-type=module', '-e', code], 1024 * 1024, 5)
        value = _metadata(b'{"items":' + body + b'}')
        if set(value) != {'items'}:
            raise _origin_fail()
        return _origin_route_map(value['items'])

    def ingress(self, request, *, present):
        main, proxy = self.named('runtipi'), self.named(ORIGIN_PROXY_NAMES[0])
        if main is None or proxy is None or not main['State']['Running'] or main['State']['Paused'] or main['State']['Restarting']:
            raise _origin_fail()
        proxy_identity = self.proxy.observe(self.root, self.context, proxy)
        version = self.runtime.bounded_output(['docker', '--context', self.context, 'exec', proxy['Id'], 'traefik', 'version'], 8192, 6)
        releases = re.findall(rb'(?m)^Version:[ \t]+([^\r\n]+)$', version)
        if len(releases) != 1 or releases[0].decode('ascii') not in ORIGIN_TRAEFIK_VERSIONS:
            raise _origin_fail()
        name = self._bridge(main, proxy)
        ports = _origin_common_ports(main, proxy, request['address'])
        if _parse_prospective_origin(request['origin']).port in ports.values():
            raise _origin_fail()
        http = self._api(main, proxy, name, 'http/routers')
        routes = _origin_guards(_parse_prospective_origin(request['origin']).hostname, http, self._api(main, proxy, name, 'tcp/routers'),
                         self._api(main, proxy, name, 'entrypoints'), present=present)
        directory = self.proxy.configuration_path(self.root)
        expected = {'version': releases[0].decode('ascii'), 'proxyId': proxy['Id'],
                    'proxyDefinitionSha256': _origin_definition(proxy), 'proxyImageId': proxy['Image'],
                    'proxyStartedAt': proxy['State']['StartedAt'], 'ports': ports, 'network': name,
                    'proxyRestartPolicy': proxy['HostConfig']['RestartPolicy'],
                    'proxyNetworksSha256': digest(_origin_networks(proxy)),
                    'proxyIdentitySha256': digest(proxy_identity), 'configurationDirectory': str(directory),
                    'ordinaryRoutesSha256': digest(routes), 'redirect': routes['redirect']}
        expected['configurationSha256'] = self.configuration(directory, present=present)
        if any(self._running_facts(self.inspect(item['Id'])) != self._running_facts(item) for item in (main, proxy)):
            raise _origin_fail()
        return expected, main

    @staticmethod
    def _running_facts(raw):
        state = raw['State']
        return (_origin_prior_runtime(raw), raw['Image'], tuple(state.get(key) for key in (
            'Running', 'Paused', 'Restarting', 'Pid', 'StartedAt')), raw['NetworkSettings']['Ports'],
                {name: item.get('IPAddress') for name, item in raw['NetworkSettings']['Networks'].items()})

    def configuration(self, path, *, present):
        path = Path(path)
        with (_directory(path), self.proxy_adoption.sealed_static(self.root) as (_, _, static),
                self.proxy_adoption.sealed_tree(path) as (tree, bodies, seal)):
            owned = 'dynamic/' + ORIGIN_GUARD_FILE
            pending = 'dynamic/.' + ORIGIN_GUARD_FILE + '.pending'
            if (owned in bodies) != present or pending in bodies:
                raise _origin_fail()
            seal()
            static()
            return digest({name: entry.get('sha256', {'directory': True})
                                   for name, entry in tree['entries'].items() if name != owned})

    def probes(self, request, ingress):
        # Use the approved installed local public chain (or ordinary trust), never issuance.
        configuration = Path(ingress['configurationDirectory'])
        cert = C.PinnedFile(configuration / 'tls' / 'cert.pem', limit=65536)
        try:
            context = ssl.create_default_context()
            context.load_verify_locations(cadata=cert.body.decode('ascii'))
            values = _origin_checks(request['address'], ingress['ports'], request['dashboardHost'],
                             _parse_prospective_origin(request['origin']).hostname, ingress['redirect'], context)
            cert.verify()
            return values
        finally:
            cert.close()

    def create(self, name, body):
        if not re.fullmatch(r'runtipi-origin-stage-[a-f0-9]{32}', name):
            raise _origin_fail()
        value = _metadata(self.runtime.engine('POST', '/containers/create?name=' + name, body, maximum=65536))
        if not valid_hash(value.get('Id')):
            raise _origin_fail()
        return value['Id']

    def rename(self, identity, name):
        self.runtime.change(['rename', identity, name])

    def has_responder(self):
        active = self.reader._read(['container', 'ls', '--filter', 'label=io.orbis.restore.role=responder',
                                    '--format', '{{.ID}}'])
        return bool(active)

    def registered_edge(self, request, *, live=False):
        # Consume a completed transport-only generation from the actual retained
        # package and its independently approved installer operation.
        generation = request['edge']['generation']
        operations = ORIGIN_EDGE_ROOT / 'operations' / generation
        files = ORIGIN_EDGE_ROOT / 'generations' / generation
        with ExitStack() as resources:
            pins = []

            def pin(path, maximum=65536):
                resource = C.PinnedFile(path, limit=maximum, private=True)
                resources.callback(resource.close)
                pins.append(resource)
                return resource
            edge_request = pin(operations / 'request.json')
            edge_review = pin(operations / 'review.json')
            edge_approval = pin(operations / 'approval.json')
            edge_intent = pin(operations / 'intent.json')
            edge_complete = pin(operations / 'complete.json')
            metadata = pin(files / 'facts.json')
            profile = pin(files / 'profile.json')
            installed = pin(STATE / 'installed.json', maximum=MAXIMUM)
            view, review, approval, receipt, facts = map(lambda item: _origin_value(item.body),
                (edge_request, edge_review, edge_approval, edge_complete, metadata))
            fields = {'certificateSha256', 'publicKeySha256', 'chainSha256', 'trustSha256', 'leafExpiresAtSec'}
            if (set(facts) != fields or any(not valid_hash(facts[key]) for key in
                    ('certificateSha256', 'publicKeySha256', 'chainSha256'))
                    or facts['trustSha256'] is not None and not valid_hash(facts['trustSha256'])
                    or type(facts['leafExpiresAtSec']) is not int or facts['leafExpiresAtSec'] <= time.time()):
                raise _origin_fail()
            expected_owner = {'operationId': generation, 'installationId': request['installationId']}
            expected_fence = {**expected_owner, 'reviewSha256': digest(edge_review.body),
                              'approvalSha256': digest(edge_approval.body)}
            required_members = ('src/orbis_sentinel/recovery_https_edge.py', 'src/orbis_sentinel/recovery_https_install.py',
                'packaging/systemd/orbis-sentinel-recovery-https.socket', 'packaging/systemd/orbis-sentinel-recovery-https.service')
            package = _metadata(installed.body)
            expected_package = {'version': package['version'], 'packageSha256': package['sha256'],
                                'sourceCommit':package['sourceCommit'],
                                'profileSha256':digest({key:package['files'][key] for key in required_members})}
            configured = _origin_value(profile.body)
            if (digest(edge_complete.body) != request['edge']['receiptSha256']
                    or receipt != {'schema':'orbis.sentinel-recovery-https-receipt.v1', 'scope':'https-transport-only',
                                   **expected_fence, 'profileSha256':digest(profile.body), 'mode':view['mode'], **facts}
                    or _origin_value(edge_intent.body) != {'schema':'orbis.sentinel-recovery-https-intent.v1', **expected_fence}
                    or approval != {'schema':'orbis.sentinel-recovery-https-approval.v1', **expected_owner,
                                    'reviewSha256':expected_fence['reviewSha256'], 'approvalId':approval.get('approvalId')}
                    or not valid_hash(approval.get('approvalId'))
                    or review.get('schema') != 'orbis.sentinel-recovery-https-review.v1'
                    or any(review.get(key) != item for key,item in expected_owner.items())
                    or review.get('requestSha256') != digest(edge_request.body) or review.get('package') != expected_package
                    or any(view.get(key) != item for key,item in expected_owner.items())
                    or (view['root'], view['context'], view['daemon']) != (str(self.root), self.context, request['daemon'])
                    or view['profile'] != configured or configured['origin'] != request['origin']
                    or configured['bind'] != request['address']):
                raise _origin_fail()
            def active():
                info=(ORIGIN_EDGE_ROOT/'active').lstat()
                if (not stat.S_ISLNK(info.st_mode) or info.st_uid != OWNER
                        or os.readlink(ORIGIN_EDGE_ROOT/'active') != 'generations/' + generation
                        or any(os.path.lexists(ORIGIN_EDGE_ROOT/name) for name in ('writer-fence.json','.active.pending'))):
                    raise _origin_fail()
            active()
            if live:
                trust = ssl.create_default_context()
                if view['mode'] == 'local':
                    ca = pin(files / 'trust.pem')
                    trust = ssl.create_default_context(cadata=ca.body.decode('ascii'))
                    if digest(ssl.PEM_cert_to_DER_cert(ca.body.decode('ascii'))) != facts['trustSha256']:
                        raise _origin_fail()
                elif view['mode'] != 'import':
                    raise _origin_fail()
                origin = _parse_prospective_origin(request['origin'])
                response = _origin_probe(request['address'], origin.port, host=origin.netloc, name=origin.hostname,
                                  context=trust, path='/sentinel/recovery/', leaf_sha=facts['certificateSha256'])
                if response['status'] != 503 or response['cookies'] or response['location'] is not None:
                    raise _origin_fail()
            active()
            for held in pins:
                held.verify()
            return {'generation':generation,'receiptSha256':request['edge']['receiptSha256'],
                    'profileSha256':digest(profile.body),'certificateSha256':facts['certificateSha256']}


def _origin_request(value, operation, root, context, daemon):
    fields = {'schema', 'operationId', 'root', 'context', 'daemon', 'installationId', 'origin',
              'address', 'dashboardHost', 'edge'}
    if (set(value) != fields or value['schema'] != ORIGIN_REQUEST or value['operationId'] != operation
            or (value['root'], value['context'], value['daemon']) != (str(root), context, daemon)
            or value['installationId'] != digest({'root': str(root), 'context': context, 'daemon': daemon,
                                                           'rootIdentity': _origin_identity(root)})):
        raise _origin_fail()
    origin = _parse_prospective_origin(value['origin'])
    address = ipaddress.IPv4Address(value['address'])
    host = value['dashboardHost']
    edge = value['edge']
    if (str(address) != value['address'] or address.is_loopback or address.is_multicast or address.is_unspecified
            or type(host) is not str or len(host) > 253 or not re.fullmatch(ORIGIN_HOST, host) or host == origin.hostname
            or type(edge) is not dict or set(edge) != {'generation', 'receiptSha256'}
            or any(not valid_hash(item) for item in edge.values())):
        raise _origin_fail()
    return value


def _origin_same_definition(raw, reviewed, observe):
    host = raw['HostConfig']
    policy = host['RestartPolicy']
    initial = reviewed['restartPolicy']
    if policy not in (initial, {'Name': 'no', 'MaximumRetryCount': 0}, {'Name': '', 'MaximumRetryCount': 0}):
        raise _origin_fail()
    normalized = {**raw, 'HostConfig': {**host, 'RestartPolicy': initial}}
    if (raw['Id'] != reviewed['id'] or _origin_definition(normalized) != reviewed['definitionSha256']
            or digest(_origin_networks(raw, observe)) != reviewed['networksSha256']):
        raise _origin_fail()


def _origin_prior_runtime(raw):
    return {'id': raw['Id'], 'definitionSha256': _origin_definition(raw),
            'restartPolicy': raw['HostConfig']['RestartPolicy'], 'networksSha256':digest(_origin_networks(raw))}


def _origin_capture_prior_main(service, raw, root, origin):
    host = service.HOST
    expected = host.controller_reference(root, service.current_manifest(), service.context)
    config = raw['Config']
    labels = config['Labels']
    if (not valid_hash(raw['Id']) or not re.fullmatch('sha256:[a-f0-9]{64}', raw['Image'])
            or config['Image'] != expected or labels.get('com.docker.compose.project') != 'runtipi'
            or labels.get('com.docker.compose.service') != 'runtipi'
            or labels.get('com.docker.compose.project.working_dir') != str(root)
            or labels.get('io.orbis.credential-writer-protocol') != MAIN_PROTOCOL
            or raw['HostConfig']['RestartPolicy'] not in (
                {'Name': 'unless-stopped', 'MaximumRetryCount': 0},
                {'Name': 'no', 'MaximumRetryCount': 0}, {'Name': '', 'MaximumRetryCount': 0})):
        raise _origin_fail()
    expected = [item for item in config['Env'] if item.startswith(ORIGIN_KEY + '=')]
    if expected not in ([], [ORIGIN_KEY + '=' + origin]):
        raise _origin_fail()
    return _origin_prior_runtime(raw)


def _origin_read_file(path, maximum, *, private=True):
    pin = C.PinnedFile(path, limit=maximum, private=private)
    try:
        pin.verify()
        return pin.body
    finally:
        pin.close()


@contextmanager
def _origin_retained_source(service, selection_sha, copy_sha):
    """Enter through the actual retained official selection and installed Host copy."""
    if not valid_hash(selection_sha) or not valid_hash(copy_sha):
        raise _origin_fail()
    source = Path(__file__).absolute().parent
    setup = load('orbis-host-service-setup.py', 'orbis_origin_setup')
    files, unit = setup.source_files(source)
    helpers = [source / name for name in ('install-orbis.py', 'orbis-host-service-setup.py')]
    with (setup.hold_source_selection(source, selection_sha) as selection,
          setup._SetupSources([*files, *helpers], unit) as selected, ExitStack() as pins):
        setup.require_selection_files(source, selection, selected, [*files, *helpers, unit])
        directory = Path(selection['directory'])
        receipt = C.PinnedFile(directory / 'host-copy-custody' / ('host-copy-' + copy_sha + '.json'),
                                       limit=MAXIMUM, private=True)
        pins.callback(receipt.close)
        actual, binding = setup._copy_snapshot(pins, setup.INSTALL_DIR, setup.UNIT_FILE)
        config = pins.enter_context(setup.HOST.AUTHORITY.protected_directory(setup.ENV_FILE.parent, private=False))
        env, binding['environment'] = setup._copy_file(pins, config, setup.ENV_FILE.name, 16384)
        inventory = {file.name: digest(selected.body(file)) for file in files}
        if actual != {'inventory': inventory, 'unitSha256': digest(selected.body(unit))}:
            raise _origin_fail()
        expected = {'schema': 'orbis.host-copy-custody.v1', 'root': str(service.root), 'context': service.context,
                    'selection': {key: item for key, item in selection.items() if key != 'inventory'},
                    'installed': {**actual, 'environmentSha256': digest(env)}, 'bindings': binding}
        if digest(receipt.body) != copy_sha or _metadata(receipt.body) != expected:
            raise _origin_fail()
        def verify():
            selected.verify()
            receipt.verify()
            for name, identity in binding['fileIdentities'].items():
                info = (setup.INSTALL_DIR / name).lstat()
                if [*setup._copy_binding(info), info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns] != identity:
                    raise _origin_fail()
        verify()
        yield {'selectionSha256': selection_sha, 'hostCopySha256': copy_sha}, verify
        verify()


class OriginTransition:
    def __init__(self, admission, observations):
        self.admission, self.observed = admission, observations
        self.service, self.authority, self.layout = admission.service, admission.authority, admission.layout
        self.root, self.context = self.service.root, self.service.context
        self.namespace = self.layout.namespace(self.root)

    def _read(self, descriptor, name, maximum=65536):
        return _read(self.authority, descriptor, name, maximum)

    def _save(self, descriptor, name, value):
        body = value if isinstance(value, bytes) else canonical(value)
        seen = self._read(descriptor, name, max(len(body), 65536))
        if seen != body:
            if seen is not None:
                raise _origin_fail()
            _write_storage(self.authority, descriptor, name, body, previous=None)
        if self._read(descriptor, name, max(len(body), 65536)) != body:
            raise _origin_fail()

    def _required(self, descriptor, name, maximum=65536):
        body = self._read(descriptor, name, maximum)
        if body is None:
            raise _origin_fail()
        return body

    def _guard(self, request, review):
        target = Path(review['ingress']['configurationDirectory']) / 'dynamic'
        config = canonical(_origin_guard_spec(_parse_prospective_origin(request['origin']).hostname))
        if digest(config) != review['guardSha256']:
            raise _origin_fail()
        return target, config

    def _v1(self, namespace, state):
        history = self._required(namespace, HISTORY)
        admission = self._required(state, C.CONFIG_NAME)
        return history, admission

    def _predecessor(self, namespace, state, request, runtime, modules):
        history, admission = self._v1(namespace, state)
        prior = _origin_value(admission.removesuffix(b'\n'))
        dependency = SimpleNamespace(fd=namespace, path=self.namespace)
        facts = self.admission._bootstrap_predecessor(dependency, history, admission, request['installationId'],
                                                       prior['origin'], runtime)
        if (any(self._read(namespace, name) is not None for name in (
                INTENT, '.' + INTENT + '.pending', STORAGE_INTENT, STORAGE_COMPLETE,
                '.' + HISTORY + '.pending'))
                or self._read(state, '.' + C.CONFIG_NAME + '.pending') is not None):
            raise _origin_fail()
        journal = self.admission._journal({'namespace':str(self.namespace)}, modules, history=facts)
        return history, admission, prior['origin'], journal

    def _approval(self, directory, request, review_body):
        approval_body = self._required(directory, 'approval.json')
        approval = _origin_value(approval_body)
        binding = {'operationId': request['operationId'], 'installationId': request['installationId'],
                   'reviewSha256': digest(review_body)}
        if (approval != {'schema': ORIGIN_APPROVAL, **binding, 'approvalId': approval.get('approvalId')}
                or not valid_hash(approval['approvalId'])):
            raise _origin_fail()
        return {**binding, 'approvalSha256': digest(approval_body)}

    def _ingress(self, directory, request, review, binding, verify):
        target, config = self._guard(request, review)
        intent = {'schema': ORIGIN_INGRESS + '.intent', **binding, 'guardSha256': digest(config)}
        with _directory(target) as dynamic:
            current = self._read(dynamic, ORIGIN_GUARD_FILE)
            staged = self._read(dynamic, '.' + ORIGIN_GUARD_FILE + '.pending')
            existing = self._read(directory, 'ingress-receipt.json')
            recorded = self._read(directory, 'ingress-intent.json')
            failure = self._read(directory, 'ingress-failed.json')

            def restore():
                verify()
                if self._read(dynamic, ORIGIN_GUARD_FILE) == config:
                    os.unlink(ORIGIN_GUARD_FILE, dir_fd=dynamic)
                    os.fsync(dynamic)
                if self._read(dynamic, ORIGIN_GUARD_FILE) is not None:
                    raise _origin_fail()

            if failure is not None:
                if failure != canonical({**intent, 'schema': ORIGIN_INGRESS + '.failed'}) or existing is not None:
                    raise _origin_fail()
                restore()
                raise _origin_fail()
            if current is None:
                if existing is not None or (staged is not None and
                        (staged != config or recorded != canonical(intent))):
                    raise _origin_fail()
                if staged is None:
                    initial, main = self.observed.ingress(request, present=False)
                    if initial != review['ingress'] or _origin_prior_runtime(main) != review['priorMain']:
                        raise _origin_fail()
                verify()
                self._save(directory, 'ingress-intent.json', intent)
                _write_storage(self.authority, dynamic, ORIGIN_GUARD_FILE, config, previous=None)
            elif current != config or recorded != canonical(intent) or staged is not None:
                raise _origin_fail()
            try:
                end = time.monotonic() + 6
                while True:
                    try:
                        observed, main = self.observed.ingress(request, present=True)
                        break
                    except ValueError:
                        if time.monotonic() >= end:
                            raise
                        time.sleep(min(0.1, max(0, end - time.monotonic())))
                if observed != review['ingress'] or _origin_prior_runtime(main) != review['priorMain']:
                    raise _origin_fail()
                tests = self.observed.probes(request, observed)
                edge = self.observed.registered_edge(request, live=True)
                if edge != review['edge'] or self.observed.ingress(request, present=True)[0] != observed:
                    raise _origin_fail()
                verify()
                if self._read(dynamic, ORIGIN_GUARD_FILE) != config:
                    raise _origin_fail()
            except (OSError, ValueError):
                if existing is None and self._read(dynamic, ORIGIN_GUARD_FILE) == config:
                    verify()
                    self._save(directory, 'ingress-failed.json', {**intent, 'schema': ORIGIN_INGRESS + '.failed'})
                    restore()
                raise
            receipt = {'schema': ORIGIN_INGRESS, **binding, 'guardSha256': digest(config),
                       'ingress': observed, 'evidence': tests, 'edge': edge}
            self._save(directory, 'ingress-receipt.json', receipt)
            return {'phase': 'ingress-registered', 'ingressSha256': digest(receipt)}

    def _stopped(self, directory, request, review, binding, *, removed=False):
        self.admission.supervisor._host_stopped()
        proxy = self.observed.named(ORIGIN_PROXY_NAMES[0])
        if proxy is None or self.observed.has_responder():
            raise _origin_fail()
        _origin_stopped(proxy)
        _origin_same_definition(proxy, {'id': review['ingress']['proxyId'],
            'definitionSha256': review['ingress']['proxyDefinitionSha256'],
            'restartPolicy': review['ingress']['proxyRestartPolicy'],
            'networksSha256': review['ingress']['proxyNetworksSha256']}, self.observed.network)
        target, config = self._guard(request, review)
        ingress = _origin_value(self._required(directory, 'ingress-receipt.json'))
        evidence = ingress.get('evidence')
        if (ingress != {'schema': ORIGIN_INGRESS, **binding, 'guardSha256': digest(config),
                        'ingress': review['ingress'], 'evidence': evidence, 'edge': review['edge']}
                or type(evidence) is not dict or set(evidence) != {'http','https','crossSNI','dashboard'}
                or evidence['https'] != 'unknown-sni' or evidence['dashboard'] != 200
                or evidence['crossSNI'] not in (421, ORIGIN_NOOP_STATUS)
                or evidence['http'] not in ((301, 308) if review['ingress']['redirect'] else (ORIGIN_NOOP_STATUS,))
                or self.observed.configuration(target.parent, present=not removed) != review['ingress']['configurationSha256']
                or not removed and _origin_read_file(target / ORIGIN_GUARD_FILE, 65536) != config
                or self.observed.registered_edge(request) != review['edge']):
            raise _origin_fail()

    def _stage(self, directory, namespace, state, root_fd, guard, request, review, binding, runtime, modules, verify):
        operation = binding['operationId']
        self._stopped(directory, request, review, binding)
        current_history, current_admission, old_origin, journal = self._predecessor(namespace, state, request, runtime, modules)
        if journal != review['priorJournal']:
            raise _origin_fail()
        if (digest(current_history), digest(current_admission), old_origin) != (
                review['oldHistorySha256'], review['oldAdmissionSha256'], review['oldOrigin']):
            raise _origin_fail()
        prior = self.observed.inspect(review['priorMain']['id'])
        _origin_stopped(prior)
        _origin_same_definition(prior, review['priorMain'], self.observed.network)
        old_env = self._read(directory, 'prior-environment.json', ORIGIN_MAX_ENV)
        current = self._required(root_fd, '.env', ORIGIN_MAX_ENV)
        if old_env is None:
            old_env = current
        new_env, had_dotenv_origin = _origin_environment(old_env, request['origin'], review['oldOrigin'])
        if review['priorOriginFields'] != {'dotenv':had_dotenv_origin, 'container': ORIGIN_KEY + '=' + old_origin in prior['Config']['Env']}:
            raise _origin_fail()
        if ((digest(old_env), digest(new_env)) != (
                review['oldEnvironmentSha256'], review['newEnvironmentSha256']) or current not in (old_env, new_env)):
            raise _origin_fail()
        if guard.read() is None and any(self._read(directory, name) is not None for name in (
                'intent.json', 'create-intent.json', 'v1-plan.json', 'v1-ready.json', 'complete.json', 'aborted.json')):
            raise _origin_fail()
        verify()
        guard.begin(operation, binding['reviewSha256'])
        self._save(directory, 'intent.json', {'schema': ORIGIN_INTENT, **binding})
        self._save(directory, 'prior-history.json', current_history)
        self._save(directory, 'prior-admission.json', current_admission)
        self._save(directory, 'prior-environment.json', old_env)
        if current != new_env:
            verify()
            guard.check(operation, binding['reviewSha256'])
            _write_storage(self.authority, root_fd, '.env', new_env, previous=old_env)
        stage_name = 'runtipi-origin-stage-' + operation[:32]
        prior_name = 'runtipi-origin-prior-' + operation[:32]
        reused = (review['oldOrigin'] == request['origin']
                  and old_env == new_env and ORIGIN_KEY + '=' + old_origin in prior['Config']['Env'])
        if reused:
            if prior['Name'] != '/runtipi' or any(self.observed.named(name) is not None for name in (stage_name, prior_name)):
                raise _origin_fail()
            successor = {'id': prior['Id'], 'definitionSha256': _origin_definition(prior),
                         'networksSha256':digest(_origin_networks(prior, self.observed.network))}
        else:
            body = _origin_creation(prior, old_origin, request['origin'], self.observed.network)
            marker = {'name': stage_name, 'priorName': prior_name, 'priorId': prior['Id'], 'bodySha256': digest(body)}
            existing = self._read(directory, 'create-intent.json')
            if existing is None and (prior['Name'] != '/runtipi' or any(self.observed.named(name) is not None
                                                                     for name in (stage_name, prior_name))):
                raise _origin_fail()
            self._save(directory, 'create-intent.json', marker)
            named = self.observed.named('runtipi')
            staged = self.observed.named(stage_name)
            if prior['Name'] not in ('/runtipi', '/' + prior_name) or (
                    named is not None and named['Id'] != prior['Id'] and staged is not None):
                raise _origin_fail()
            candidate = (named if named is not None and named['Id'] != prior['Id'] else staged)
            if candidate is None:
                if (prior['Name'] != '/runtipi' or self._read(directory, 'candidate.json') is not None
                        or self._read(directory, 'rename-intent.json') is not None):
                    raise _origin_fail()
                verify()
                guard.check(operation, binding['reviewSha256'])
                identity = self.observed.create(stage_name, body)
                candidate = self.observed.named(stage_name)
                if candidate is None or candidate['Id'] != identity:
                    raise _origin_fail()
            successor = _origin_candidate(candidate, prior, body, stage_name, self.observed.network)
            self._save(directory, 'candidate.json', successor)
            self._save(directory, 'rename-intent.json', {**marker, 'candidate': successor})
            if prior['Name'] == '/runtipi':
                verify()
                guard.check(operation, binding['reviewSha256'])
                self.observed.rename(prior['Id'], prior_name)
            other = self.observed.named(prior_name)
            if other is None or other['Id'] != prior['Id']:
                raise _origin_fail()
            _origin_stopped(other)
            _origin_same_definition(other, review['priorMain'], self.observed.network)
            if candidate['Name'] != '/runtipi':
                if self.observed.named('runtipi') is not None:
                    raise _origin_fail()
                verify()
                guard.check(operation, binding['reviewSha256'])
                self.observed.rename(successor['id'], 'runtipi')
            if _origin_candidate(self.observed.named('runtipi'), other, body, stage_name, self.observed.network) != successor:
                raise _origin_fail()
        verify()
        guard.check(operation, binding['reviewSha256'])
        plan_request = self.admission.request('unmanaged', request['origin'], unmanaged_adoption=True)
        dependencies, modules = self.admission.supervisor.snapshot(plan_request)
        if (dependencies['installationId'] != request['installationId'] or
                {key: dependencies['main'][key] for key in ('id', 'definitionSha256')} !=
                {key:successor[key] for key in ('id', 'definitionSha256')}):
            raise _origin_fail()
        plan = self.admission.review_unlocked(plan_request, dependencies, modules, namespace, state)
        if plan['journal'] != review['priorJournal']:
            raise _origin_fail()
        self._save(directory, 'v1-plan.json', plan)
        ready = {'schema': ORIGIN_READY, **binding, 'origin': request['origin'], 'main': dependencies['main'],
                 'envSha256': review['newEnvironmentSha256'], 'planSha256': digest(plan)}
        self._save(directory, 'v1-ready.json', ready)
        return {'phase': 'awaits-v1-approval', 'planSha256': ready['planSha256']}

    def _commit(self, directory, namespace, state, root_fd, guard, request, review, binding,
                authorization_sha, verify):
        self._stopped(directory, request, review, binding)
        if not valid_hash(authorization_sha) or self._read(directory, 'aborted.json') is not None:
            raise _origin_fail()
        operation = binding['operationId']
        ready = _origin_value(self._required(directory, 'v1-ready.json'))
        plan = _origin_value(self._required(directory, 'v1-plan.json'))
        if (ready != {'schema': ORIGIN_READY, **binding, 'origin': request['origin'],
                      'main': plan['dependencies']['main'], 'envSha256': review['newEnvironmentSha256'],
                      'planSha256': digest(plan)}
                or self._required(directory, 'intent.json') != canonical({'schema': ORIGIN_INTENT, **binding})):
            raise _origin_fail()
        approval = self.namespace / 'recovery-admission-approvals' / (operation + '.json')
        terminal = self._read(directory, 'complete.json')
        candidate = self._read(directory, 'candidate.json')
        expected_networks = (_origin_value(candidate)['networksSha256'] if candidate is not None
                             else review['priorMain']['networksSha256'])
        if candidate is not None and _origin_value(candidate)['id'] != ready['main']['id']:
            raise _origin_fail()

        def stable():
            verify()
            raw = self.observed.named('runtipi')
            if raw is None:
                raise _origin_fail()
            (_origin_never_started if candidate is not None else _origin_stopped)(raw)
            if (digest(_origin_networks(raw, self.observed.network)) != expected_networks or raw['Id'] != ready['main']['id'] or _origin_definition(raw) != ready['main']['definitionSha256']
                    or digest(self._required(root_fd, '.env', ORIGIN_MAX_ENV)) != ready['envSha256']):
                raise _origin_fail()

        def completed():
            stable()
            self._stopped(directory, request, review, binding)
            candidate = _encoded(self.admission._candidate(plan))
            desired = _encoded(self.admission._desired(plan, _metadata(candidate)))
            v1_operation = digest({'plan': ready['planSha256'], 'authorization': authorization_sha})
            archive = self._required(namespace, 'recovery-admission-' + v1_operation + '.json')
            archived = _metadata(archive)
            value = {'schema': ORIGIN_COMPLETE, **binding, 'main': ready['main'], 'origin': request['origin'],
                     'envSha256': ready['envSha256'], 'planSha256': ready['planSha256'],
                     'historySha256': digest(desired), 'admissionSha256': digest(candidate),
                     'v1ArchiveSha256': digest(archive), 'v1AuthorizationSha256': authorization_sha}
            if (self._v1(namespace, state) != (desired, candidate) or self._read(namespace, INTENT) is not None
                    or archived.get('phase') != 'complete' or archived.get('operationId') != v1_operation
                    or archived.get('authorization') != self.admission._authorization(approval, authorization_sha, plan)
                    or archived.get('plan') != plan or archived.get('history') != _metadata(desired)
                    or archived.get('candidate') != _metadata(candidate)):
                raise _origin_fail()
            return value

        stable()
        if terminal is None:
            guard.check(operation, binding['reviewSha256'])
            result = self.admission.apply_retained_origin(guard, operation,
                approved_plan_sha256=ready['planSha256'], authorization=approval, authorization_sha256=authorization_sha)
            value = completed()
            if (result['state'] != 'complete' or result['installationId'] != request['installationId']
                    or result['planSha256'] != ready['planSha256'] or result['configSha256'] != value['admissionSha256']):
                raise _origin_fail()
            self._save(directory, 'complete.json', value)
        else:
            value = completed()
        guard.finish(operation, binding['reviewSha256'],
                     verify_completed=lambda: self._read(directory, 'complete.json') == canonical(completed()))
        return {'phase': 'complete', 'receiptSha256': digest(value)}

    def _abort(self, directory, namespace, state, root_fd, guard, request, review, binding, abort_sha, verify):
        # The immutable old V1 history/selector must still be live. Once V1 is
        # pending or either dependency has advanced, only forward commit applies.
        old_env = self._required(directory, 'prior-environment.json', ORIGIN_MAX_ENV)
        old_history, old_config = self._v1(namespace, state)
        op = binding['operationId']
        approval = self._required(directory, 'abort.json')
        action = _origin_value(approval)
        if (not valid_hash(abort_sha) or digest(approval) != abort_sha
                or action != {'schema': ORIGIN_ABORT + '.approval', **binding, 'approvalId': action.get('approvalId')}
                or not valid_hash(action['approvalId'])
                or (digest(old_history), digest(old_config), digest(old_env)) != (
                    review['oldHistorySha256'], review['oldAdmissionSha256'], review['oldEnvironmentSha256'])
                or any(self._read(namespace, name) is not None for name in (
                    INTENT, '.' + INTENT + '.pending', '.' + HISTORY + '.pending'))
                or self._read(state, '.' + C.CONFIG_NAME + '.pending') is not None
                or self._read(directory, 'complete.json') is not None):
            raise _origin_fail()
        old_id = review['priorMain']['id']
        stage_name = 'runtipi-origin-stage-' + op[:32]
        prior_name = 'runtipi-origin-prior-' + op[:32]
        aborted_name = 'runtipi-origin-aborted-' + op[:32]
        terminal = {'schema': ORIGIN_ABORT, **binding, 'abortSha256': abort_sha, 'restoredMainId': old_id,
                    'envSha256': review['oldEnvironmentSha256']}
        target, guard_bytes = self._guard(request, review)
        abort_record = self._read(directory, 'aborted.json')
        existing_abort = self._read(directory, 'abort-intent.json')
        removed = not os.path.lexists(target / ORIGIN_GUARD_FILE)
        if (existing_abort not in (None, canonical(terminal))
                or removed and existing_abort is None):
            raise _origin_fail()
        self._stopped(directory, request, review, binding, removed=removed)
        if abort_record is None:
            verify()
            guard.check(op, binding['reviewSha256'])
            self._save(directory, 'abort-intent.json', terminal)
            original = self.observed.inspect(old_id)
            _origin_stopped(original)
            _origin_same_definition(original, review['priorMain'], self.observed.network)
            owned_create = self._read(directory, 'create-intent.json')
            candidates = [value for name in (stage_name, aborted_name, 'runtipi')
                          if (value := self.observed.named(name)) is not None and value['Id'] != old_id]
            if len(candidates) > 1 or candidates and owned_create is None or original['Name'] not in ('/runtipi', '/' + prior_name):
                raise _origin_fail()
            if candidates:
                current = candidates[0]
                body = _origin_creation(original, review['oldOrigin'], request['origin'], self.observed.network)
                expected = _origin_value(owned_create)
                if expected != {'name': stage_name, 'priorName': prior_name, 'priorId': old_id,
                                'bodySha256': digest(body)}:
                    raise _origin_fail()
                expected_readback = _origin_candidate(current, original, body, aborted_name if current['Name'] == '/' + aborted_name else stage_name,
                                               self.observed.network)
                recorded = self._read(directory, 'candidate.json')
                if recorded is not None and _origin_value(recorded) != expected_readback:
                    raise _origin_fail()
                if current['Name'] != '/' + aborted_name:
                    verify()
                    guard.check(op, binding['reviewSha256'])
                    self.observed.rename(current['Id'], aborted_name)
            if original['Name'] != '/runtipi':
                if self.observed.named('runtipi') is not None:
                    raise _origin_fail()
                verify()
                guard.check(op, binding['reviewSha256'])
                self.observed.rename(old_id, 'runtipi')
            seen = self._required(root_fd, '.env', ORIGIN_MAX_ENV)
            staged = self._read(root_fd, '..env.pending', ORIGIN_MAX_ENV)
            if staged is not None and digest(staged) == review['newEnvironmentSha256'] and staged != old_env:
                verify()
                guard.check(op, binding['reviewSha256'])
                if seen != old_env or self._read(root_fd, '..env.pending', ORIGIN_MAX_ENV) != staged:
                    raise _origin_fail()
                os.unlink('..env.pending', dir_fd=root_fd)
                os.fsync(root_fd)
            elif staged is not None and (staged != old_env or seen == old_env):
                raise _origin_fail()
            if seen != old_env:
                if digest(seen) != review['newEnvironmentSha256']:
                    raise _origin_fail()
                verify()
                guard.check(op, binding['reviewSha256'])
                _write_storage(self.authority, root_fd, '.env', old_env, previous=seen)
            if not removed:
                with _directory(target) as dynamic:
                    verify()
                    guard.check(op, binding['reviewSha256'])
                    if self._read(dynamic, ORIGIN_GUARD_FILE) != guard_bytes:
                        raise _origin_fail()
                    os.unlink(ORIGIN_GUARD_FILE, dir_fd=dynamic)
                    os.fsync(dynamic)
            self._stopped(directory, request, review, binding, removed=True)
            self._save(directory, 'aborted.json', terminal)

        def completed():
            verify()
            self._stopped(directory, request, review, binding, removed=True)
            main = self.observed.named('runtipi')
            if main is None:
                raise _origin_fail()
            _origin_stopped(main)
            _origin_same_definition(main, review['priorMain'], self.observed.network)
            return (self._read(directory, 'aborted.json') == canonical(terminal)
                    and self._required(root_fd, '.env', ORIGIN_MAX_ENV) == old_env
                    and self._read(root_fd, '..env.pending', ORIGIN_MAX_ENV) is None
                    and self._v1(namespace, state) == (old_history, old_config))
        guard.finish(op, binding['reviewSha256'], verify_completed=completed)
        return {'phase': 'aborted', 'receiptSha256': digest(terminal)}

    def run(self, command, operation, *, custody, source_check, review_sha=None, approval_sha=None,
            phase_sha=None):
        if not valid_hash(operation) or self.service.state_dir != self.layout.STATE_ROOT:
            raise _origin_fail()
        with (self.admission.host.credential_fence_lock(self.root, self.context) as guard,
              _directory(self.namespace) as namespace,
              _directory(self.namespace / ORIGIN_OPERATIONS / operation) as directory,
              _directory(self.service.state_dir) as state,
              _directory(self.root) as root_fd,
              self.admission.supervisor._held_runtime(storage_floor=True) as (runtime, modules, runtime_check)):
            self.service.require_credential_idle(guard)
            daemon = self.observed.local_daemon()
            body = self._required(directory, 'request.json')
            request = _origin_request(_origin_value(body), operation, self.root, self.context, daemon)

            def verify():
                self.service.require_credential_idle(guard)
                runtime_check()
                source_check()
                if (self._required(directory, 'request.json') != body or self.observed.local_daemon() != daemon
                        or _origin_request(request, operation, self.root, self.context, daemon) != request):
                    raise _origin_fail()

            verify()
            if command == 'review':
                if guard.read() is not None or any(value is not None for value in (review_sha, approval_sha, phase_sha)):
                    raise _origin_fail()
                history, admission, origin, journal = self._predecessor(namespace, state, request, runtime, modules)
                ingress, main = self.observed.ingress(request, present=False)
                runtime_facts = _origin_capture_prior_main(self.service, main, self.root, origin)
                env = self._required(root_fd, '.env', ORIGIN_MAX_ENV)
                new_env, dotenv = _origin_environment(env, request['origin'], origin)
                dashboard_hosts = _origin_dashboard_hosts(main, env)
                if request['dashboardHost'] not in dashboard_hosts or _parse_prospective_origin(request['origin']).hostname in dashboard_hosts:
                    raise _origin_fail()
                guard_bytes = canonical(_origin_guard_spec(_parse_prospective_origin(request['origin']).hostname))
                edge = self.observed.registered_edge(request, live=True)
                review = {'schema': ORIGIN_REVIEW, 'operationId': operation,
                          'installationId': request['installationId'], 'root': str(self.root), 'context': self.context,
                          'origin': request['origin'], 'requestSha256': digest(body), 'custody': custody,
                          'ingress': ingress, 'edge': edge, 'priorMain': runtime_facts, 'dashboardHosts':dashboard_hosts,
                          'guardSha256': digest(guard_bytes), 'oldOrigin': origin, 'priorJournal': journal,
                          'priorOriginFields': {'dotenv':dotenv, 'container': ORIGIN_KEY + '=' + origin in main['Config']['Env']},
                          'oldHistorySha256': digest(history), 'oldAdmissionSha256': digest(admission),
                          'oldEnvironmentSha256': digest(env), 'newEnvironmentSha256': digest(new_env)}
                verify()
                self._save(directory, 'review.json', review)
                return {'phase': 'awaits-origin-approval', 'reviewSha256': digest(review)}

            review_body = self._required(directory, 'review.json')
            review = _origin_value(review_body)
            binding = self._approval(directory, request, review_body)
            if (review_sha != binding['reviewSha256'] or approval_sha != binding['approvalSha256']
                    or review.get('schema') != ORIGIN_REVIEW or review['operationId'] != operation
                    or (review['root'], review['context']) != (str(self.root), self.context)
                    or review['installationId'] != request['installationId'] or review['origin'] != request['origin']
                    or review['requestSha256'] != digest(body) or review['custody'] != custody
                    or request['dashboardHost'] not in review['dashboardHosts']
                    or _parse_prospective_origin(request['origin']).hostname in review['dashboardHosts']):
                raise _origin_fail()
            if command == 'ingress' and phase_sha is None and guard.read() is None:
                return self._ingress(directory, request, review, binding, verify)
            if command == 'stage' and phase_sha is None and self._read(directory, 'abort-intent.json') is None:
                return self._stage(directory, namespace, state, root_fd, guard, request, review, binding, runtime, modules, verify)
            if command == 'commit' and self._read(directory, 'abort-intent.json') is None:
                return self._commit(directory, namespace, state, root_fd, guard, request, review, binding, phase_sha, verify)
            if command == 'abort':
                return self._abort(directory, namespace, state, root_fd, guard, request, review, binding, phase_sha, verify)
            raise _origin_fail()


def _origin_main(arguments):
    command = argparse.ArgumentParser(description="Prepare the retained Sentinel recovery origin for existing V1 admission.")
    command.add_argument('phase', choices=('review', 'ingress', 'stage', 'commit', 'abort'))
    command.add_argument('operation')
    command.add_argument('--root', type=Path, required=True)
    command.add_argument('--confirm-root', required=True)
    command.add_argument('--docker-context', required=True)
    command.add_argument('--snapshots', type=Path, required=True)
    command.add_argument('--selection-sha256', required=True)
    command.add_argument('--host-copy-sha256', required=True)
    command.add_argument('--review-sha256')
    command.add_argument('--approval-sha256')
    command.add_argument('--phase-sha256')
    args = command.parse_args(arguments)
    try:
        _root()
        if str(args.root) != args.confirm_root:
            raise _origin_fail()
        module = load('orbis-host-service.py', 'orbis_origin_service')
        service = module.HostService(args.root, args.docker_context, args.snapshots,
                                     module.HOST.AUTHORITY.LAYOUT.STATE_ROOT, recover_interrupted_job=False)
        admission = Admission(service)
        with _origin_retained_source(service, args.selection_sha256, args.host_copy_sha256) as (custody, check):
            result = OriginTransition(admission, OriginObservations(service)).run(args.phase, args.operation,
                custody=custody, source_check=check, review_sha=args.review_sha256,
                approval_sha=args.approval_sha256, phase_sha=args.phase_sha256)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.SubprocessError):
        print(str(_origin_fail()), file=sys.stderr)
        return 1


def main():
    if sys.argv[1:2] == ['origin']:
        return _origin_main(sys.argv[2:])
    if sys.argv[1:]==['--tls-probe']:
        try:
            body=sys.stdin.buffer.read(2049)
            request=_metadata(body)
            if len(body)>2048 or set(request)!= {'origin','prove'} or type(request['prove']) is not bool:raise fail()
            sys.stdout.buffer.write(canonical(_https_worker(request)));return 0
        except Exception:return 1
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation',choices=('review','apply','review-storage','apply-storage','review-bootstrap'))
    parser.add_argument('--root',type=Path,required=True);parser.add_argument('--docker-context',required=True)
    parser.add_argument('--state-dir',type=Path,required=True);parser.add_argument('--snapshots',type=Path,required=True)
    parser.add_argument('--mode',choices=('managed','unmanaged'));parser.add_argument('--origin')
    parser.add_argument('--publisher-operation')
    parser.add_argument('--publication-sha256')
    parser.add_argument('--bootstrap-operation')
    parser.add_argument('--unmanaged-adoption',action='store_true')
    parser.add_argument('--review-sha256');parser.add_argument('--authorization',type=Path);parser.add_argument('--authorization-sha256')
    args=parser.parse_args()
    try:
        _root();service_module=load('orbis-host-service.py','orbis_recovery_admission_host')
        service=service_module.HostService(args.root,args.docker_context,args.snapshots,args.state_dir,recover_interrupted_job=False)
        manager=Admission(service)
        if args.operation == 'review-bootstrap':
            if (args.mode is not None or args.unmanaged_adoption or args.review_sha256 is not None
                    or args.authorization is not None or args.authorization_sha256 is not None):
                raise fail()
            result = manager.review_bootstrap(args.bootstrap_operation, args.publisher_operation,
                                              args.publication_sha256, args.origin)
            print(json.dumps(result, sort_keys=True))
            return 0
        if args.bootstrap_operation is not None or args.publication_sha256 is not None:
            raise fail()
        if args.operation in ('review-storage', 'apply-storage'):
            if args.mode or args.origin or args.unmanaged_adoption:
                raise fail()
            if args.operation == 'review-storage':
                if args.review_sha256 or args.authorization or args.authorization_sha256:
                    raise fail()
                result = manager.review_storage(args.publisher_operation)
            else:
                result = manager.apply_storage(args.publisher_operation, approved_plan_sha256=args.review_sha256,
                    authorization=args.authorization, authorization_sha256=args.authorization_sha256)
            print(json.dumps(result, sort_keys=True))
            return 0
        if args.publisher_operation:
            raise fail()
        request=manager.request(args.mode,args.origin,unmanaged_adoption=args.unmanaged_adoption)
        if args.operation=='review':
            if args.review_sha256 or args.authorization or args.authorization_sha256:raise fail()
            plan=manager.review(request);result={'plan':plan,'planSha256':digest(plan)}
        else:result=manager.apply(request,approved_plan_sha256=args.review_sha256,authorization=args.authorization,authorization_sha256=args.authorization_sha256)
    except Exception:parser.exit(1,'Recovery admission did not complete. Preserve its Root intent and credential hold for reconciliation.\n')
    print(json.dumps(result,sort_keys=True));return 0


if __name__=='__main__':raise SystemExit(main())
