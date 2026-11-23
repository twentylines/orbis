#!/usr/bin/env python3
"""Fixed Main credential routes backed by an explicitly admitted Root runtime.

The installation supervisor provisions the private admission record only after
qualifying its recovery store, retained worker, realm and runtime. This reader
never creates that record, a journal, or an unmanaged fallback.
"""
import base64
from contextlib import ExitStack, contextmanager
from contextvars import ContextVar
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
from types import ModuleType

OWNER = 0
CONFIG_NAME = 'credential-admission.json'
PROTOCOL = 1
REQUEST_LOCK_TIMEOUT = 20
RUNTIME_FILES = frozenset({'__init__.py', 'writer_broker.py', 'writer_control.py', 'writer_journal.py',
                           'recovery_sessions.py', 'recovery_config.py'})
_HASH = re.compile(r'[a-f0-9]{64}\Z')
ERROR = 'Credential synchronization is unavailable; protected recovery needs review.'
OWNERSHIP_RECOVERY = Path('/var/lib/orbis-sentinel/recovery')
OWNERSHIP_RECOVERY_ENV = Path('/etc/orbis-sentinel/recovery.env')
_DATA_KEY = object()


def fail():
    return ValueError(ERROR)


def acquire_request_lock(lock):
    # Short read-only supervision shares this lock with credential admission.
    # Wait within the RPC budget, then perform every live authority check under
    # the acquired lock. This never retries a dispatch or bypasses a durable hold.
    return lock.acquire(timeout=REQUEST_LOCK_TIMEOUT)


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise fail()
        result[key] = value
    return result


def json_body(body):
    def invalid(_):
        raise fail()
    try:
        value = json.loads(body, object_pairs_hook=pairs, parse_float=invalid, parse_constant=invalid)
        if type(value) is not dict:
            raise fail()
        return value
    except (ValueError, UnicodeError, RecursionError) as error:
        raise fail() from error


def seal(info):
    return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode',
                                               'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


class PinnedFile:
    def __init__(self, path, *, limit, private=False):
        self.path, self.fds, self.file = Path(path), [], None
        try:
            if (not self.path.is_absolute() or str(self.path) != os.path.realpath(self.path)
                    or '\0' in str(self.path)):
                raise fail()
            current = Path('/')
            for part in ('', *self.path.parent.parts[1:]):
                if part:
                    current /= part
                fd = os.open(current, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
                info = os.fstat(fd)
                self.fds.append((current, fd, seal(info)[:5]))
                if info.st_uid not in {0, OWNER} or info.st_mode & 0o022:
                    raise fail()
            self.file = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
            info = os.fstat(self.file)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER or info.st_nlink != 1
                    or (stat.S_IMODE(info.st_mode) != 0o600 if private else info.st_mode & 0o022)
                    or not 0 < info.st_size <= limit):
                raise fail()
            self.identity = seal(info)
            self.body = os.read(self.file, limit + 1)
            if len(self.body) != info.st_size:
                raise fail()
            self.verify()
        except BaseException:
            self.close()
            raise

    def verify(self):
        if self.file is None or os.path.realpath(self.path) != str(self.path):
            raise fail()
        for path, fd, identity in self.fds:
            if any(seal(info)[:5] != identity for info in (os.fstat(fd), os.lstat(path))):
                raise fail()
        if any(seal(info) != self.identity for info in (os.fstat(self.file), os.lstat(self.path))):
            raise fail()

    def close(self):
        if self.file is not None:
            os.close(self.file)
            self.file = None
        for _, fd, _ in reversed(self.fds):
            os.close(fd)
        self.fds.clear()


class Lifecycle:
    def __init__(self, service):
        self.service = service
        self.current = ContextVar('orbis_credential_host_guard', default=None)

    @contextmanager
    def operation(self):
        current = self.current.get()
        if current is not None:
            self.verify(current)
            yield current
            self.verify(current)
            return
        with self.service.HOST.credential_fence_lock(self.service.root, self.service.context) as guard:
            self.verify(guard)
            token = self.current.set(guard)
            try:
                yield guard
                self.verify(guard)
            finally:
                self.current.reset(token)

    def verify(self, guard):
        host = self.service.HOST
        if (not isinstance(guard, host.CREDENTIAL_FENCE._Guard)
                or guard._host.LOCK_DESCRIPTOR is not host.LOCK_DESCRIPTOR or guard._host.AUTHORITY is not host.AUTHORITY
                or guard._host.CREDENTIAL_FENCE is not host.CREDENTIAL_FENCE
                or guard._root != self.service.root or guard._context != self.service.context): raise fail()
        guard._check()


def _data_observations():
    spec = importlib.util.spec_from_file_location('orbis_configured_data_observations', Path(__file__).with_name('orbis-host-existing-ownership.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ConfiguredRuntime:
    """Current data observation inside the already admitted private Root scope.

    The configured service owns admission/runtime/recovery pins. This object
    verifies their live guard and protected layout; it cannot create admission,
    initialize a writer journal, or classify missing history as unmanaged.
    """
    def __init__(self, key, issuer, guard):
        if key is not _DATA_KEY or type(issuer) is not CredentialService: raise fail()
        self.issuer, self.service, self.guard = issuer, issuer.service, guard
        self.resources, self.closed = ExitStack(), False
        self.observed = _data_observations()
        try:
            self._guard()
            self.layout_pin = PinnedFile(guard._directory.path / 'layout.json', limit=65536, private=True)
            self.resources.callback(self.layout_pin.close)
            self.layout = json_body(self.layout_pin.body)
            self.verify()
        except BaseException:
            self.close(); raise

    def _guard(self):
        service, host, guard = self.service, self.service.HOST, self.guard
        self.issuer.lifecycle.verify(guard)
        namespace = host.AUTHORITY.LAYOUT.namespace(service.root)
        if (os.geteuid() != OWNER or self.closed or self.issuer.lifecycle.current.get() is not guard
                or service.state_dir != host.AUTHORITY.LAYOUT.STATE_ROOT
                or guard._directory.path != namespace or guard._selected != namespace / 'credential-fence.json'
                or not guard._directory.protected
                or self.issuer.config_pin.path != service.state_dir / CONFIG_NAME
                or self.issuer.value['journalDirectory'] != str(namespace / 'credential-journal')): raise fail()
        service.require_credential_idle(guard)

    def verify(self):
        self._guard()
        self.issuer.verify()
        if self.issuer.value != json_body(self.issuer.config_pin.body): raise fail()
        self.layout_pin.verify()
        namespace = self.guard._directory.path
        for name in ('recovery-admission-intent.json', 'credential-storage-migration.json',
                     'credential-bootstrap-intent.json', '.credential-bootstrap-intent.json.pending',
                     'credential-bootstrap-publication-hold.json', '.credential-bootstrap-publication-hold.json.pending'):
            if os.path.lexists(namespace / name): raise fail()

    @contextmanager
    def enrollment(self):
        self.verify()
        service, host, value = self.service, self.service.HOST, self.issuer.value
        with ExitStack() as resources:
            fd, _, verify = resources.enter_context(self.observed.data_root(service))
            identity = list(seal(os.fstat(fd))[:5])
            pin = self.observed.ObservedFile(service.root, fd, verify, service.root / host.STATE_NAME, limit=16384)
            resources.callback(pin.close)
            saved = json_body(pin.body)
            publication = host.PLAN.validate_manifest(service.current_manifest())
            daemon = self.observed._docker(service, ['info', '--format', '{{json .ID}}'])
            if (type(daemon) is not str or self.observed.K.digest({'root': str(service.root), 'context': service.context,
                    'daemon': daemon, 'rootIdentity': identity}) != value['installationId']
                    or host.AUTHORITY.LAYOUT.read(service.root, daemon, service.context) != self.layout
                    or host.saved_state(service.root) != saved): raise fail()
            protected = [self.issuer.config_pin.path, Path(value['runtimeDirectory']), Path(value['journalDirectory'])]
            if value['recoveryConfig'] is not None: protected.append(Path(value['recoveryConfig']))
            if self.issuer.recovery_config is not None: protected.append(Path(self.issuer.recovery_config.data['directory']))
            controller = self.observed._controller(service, publication, saved, daemon, protected=tuple(protected))
            yield saved, tuple(identity)
            if (service.current_manifest() != publication or host.saved_state(service.root) != saved
                    or host.AUTHORITY.LAYOUT.read(service.root, daemon, service.context) != self.layout
                    or self.observed._controller(service, publication, saved, daemon, protected=tuple(protected)) != controller): raise fail()
            pin.verify(); verify(); self.verify()

    def close(self):
        self.closed = True
        self.resources.close()

    def __enter__(self):
        self.verify(); return self

    def __exit__(self, *_):
        self.close()


class UnmanagedControl:
    def call(self, *_):
        raise fail()


class CredentialService:
    def __init__(self, service, *, enrollment):
        self.service, self.resources = service, ExitStack()
        self.peer = ContextVar('orbis_credential_peer', default=None)
        self.closed = False
        try:
            if not callable(enrollment):
                raise fail()
            self.enrollment = enrollment
            config = self.pin(service.state_dir / CONFIG_NAME, limit=16384, private=True)
            self.config_pin = config
            self.ownership_authority = None
            value = json_body(config.body)
            fields = {'schema', 'writerProtocol', 'root', 'context', 'installationId', 'mode', 'origin', 'recoveryEpoch',
                      'runtimeDirectory', 'runtimeFiles', 'journalDirectory', 'recoveryConfig', 'recoveryConfigSha256'}
            if (set(value) != fields or value['schema'] != 'orbis.host.credential-admission.v1'
                    or type(value['writerProtocol']) is not int or value['writerProtocol'] != PROTOCOL
                    or value['root'] != str(service.root) or value['context'] != service.context
                    or type(value['installationId']) is not str or not _HASH.fullmatch(value['installationId'])
                    or value['mode'] not in ('managed', 'unmanaged')
                    or type(value['runtimeFiles']) is not dict or set(value['runtimeFiles']) != RUNTIME_FILES
                    or any(type(h) is not str or not _HASH.fullmatch(h) for h in value['runtimeFiles'].values())):
                raise fail()
            self.value = value
            for key in ('runtimeDirectory', 'journalDirectory'):
                path = value[key]
                if (type(path) is not str or not Path(path).is_absolute() or path != os.path.realpath(path)
                        or Path(path).is_relative_to(service.root) or service.root.is_relative_to(Path(path))):
                    raise fail()
            if value['mode'] == 'managed':
                if (type(value['recoveryEpoch']) is not str or not _HASH.fullmatch(value['recoveryEpoch'])
                        or type(value['recoveryConfig']) is not str or type(value['recoveryConfigSha256']) is not str
                        or not _HASH.fullmatch(value['recoveryConfigSha256'])):
                    raise fail()
            elif any(value[key] is not None for key in ('recoveryEpoch', 'recoveryConfig', 'recoveryConfigSha256')):
                raise fail()
            runtime = Path(value['runtimeDirectory'])
            runtime_pins = {}
            for name in sorted(RUNTIME_FILES):
                pinned = self.pin(runtime / name, limit=262144)
                if hashlib.sha256(pinned.body).hexdigest() != value['runtimeFiles'][name]:
                    raise fail()
                runtime_pins[name] = pinned
            package_name = '_orbis_credential_' + hashlib.sha256(config.body).hexdigest()
            modules = self.load_runtime(package_name, runtime_pins)
            broker = modules['writer_broker']
            if getattr(broker, 'HOST_WRITER_PROTOCOL', None) != PROTOCOL:
                raise fail()
            if value['mode'] == 'managed':
                recovery_file = self.pin(value['recoveryConfig'], limit=16384, private=True)
                if hashlib.sha256(recovery_file.body).hexdigest() != value['recoveryConfigSha256']:
                    raise fail()
                recovery_config = modules['recovery_config'].RecoveryConfig(value['recoveryConfig'])
                self.resources.callback(recovery_config.close)
                if recovery_config.data['origin'] != value['origin']:
                    raise fail()
                directory = Path(recovery_config.data['directory'])
                journal = Path(value['journalDirectory'])
                if journal == directory or journal.is_relative_to(directory) or directory.is_relative_to(journal):
                    raise fail()
                control = modules['writer_control'].WriterControlClient(str(directory / 'control.sock'))
                self.recovery_config = recovery_config
            else:
                control, self.recovery_config = UnmanagedControl(), None
            # create=False: provisioning/adoption is a separate Root transition.
            self.lifecycle = Lifecycle(service)
            self.broker = broker.WriterBroker(value['journalDirectory'], control=control, admit=self.admitted,
                                               lifecycle=self.lifecycle, create=False)
            self.resources.callback(self.broker.close)
            self.verify()
        except BaseException as error:
            self.resources.close()
            self.closed = True
            if isinstance(error, Exception):
                raise fail() from None
            raise

    @staticmethod
    def load_runtime(package_name, pins):
        # Execute the exact pinned source bytes, never a pathname loader or pyc.
        # An empty package search path prevents extra unlisted relative imports.
        order = ('__init__', 'recovery_sessions', 'writer_journal', 'writer_control', 'recovery_config', 'writer_broker')
        names = [package_name if name == '__init__' else package_name + '.' + name for name in order]
        if all(name in sys.modules for name in names):
            return {short: sys.modules[name] for short, name in zip(order, names)}
        if any(name in sys.modules for name in names):
            raise fail()
        try:
            for short, name in zip(order, names):
                pin = pins[short + '.py']
                pin.verify()
                module = ModuleType(name)
                module.__file__ = str(pin.path)
                module.__package__ = package_name
                if short == '__init__':
                    module.__path__ = []
                module.__spec__ = importlib.util.spec_from_loader(name, loader=None, is_package=short == '__init__')
                sys.modules[name] = module
                exec(compile(pin.body, str(pin.path), 'exec', dont_inherit=True), module.__dict__)
                pin.verify()
                if short != '__init__':
                    setattr(sys.modules[package_name], short, module)
            return {short: sys.modules[name] for short, name in zip(order, names)}
        except BaseException:
            for name in names:
                sys.modules.pop(name, None)
            raise

    def pin(self, path, **kwargs):
        pinned = PinnedFile(path, **kwargs)
        self.resources.callback(pinned.close)
        if not hasattr(self, 'pins'):
            self.pins = []
        self.pins.append(pinned)
        return pinned

    def verify(self):
        if self.closed:
            raise fail()
        for pin in self.pins:
            pin.verify()
        if getattr(self, 'recovery_config', None) is not None:
            self.recovery_config.verify()

    def admitted(self):
        self.verify()
        witness = self.peer.get()
        if witness is None:
            raise fail()
        witness.verify()
        identity = witness.identity()
        if identity['installationId'] != self.value['installationId']:
            raise fail()
        self.service.require_credential_idle(self.lifecycle.current.get())
        return {'schema': 'orbis.sentinel-writer-admission.v1', 'mode': self.value['mode'], **identity,
                'origin': self.value['origin'], 'recoveryEpoch': self.value['recoveryEpoch']}

    @staticmethod
    def identity(value):
        if type(value) is not str or not 1 <= len(value) <= 87384:
            raise fail()
        try:
            body = base64.b64decode(value, validate=True)
        except (ValueError, TypeError) as error:
            raise fail() from error
        if not 1 <= len(body) <= 65536 or base64.b64encode(body).decode('ascii') != value:
            raise fail()
        return body

    def request(self, connection, operation, data, *, peer_module):
        if not acquire_request_lock(self.service.lock):
            raise fail()
        try:
            self.verify()
            with self.lifecycle.operation() as guard, self.data_scope(guard) as scope:
                with peer_module.admit_configured(self.service, connection, host=self.service.HOST,
                                                  enrollment=self.enrollment, scope=scope) as witness:
                    token = self.peer.set(witness)
                    try:
                        return self.dispatch(operation, data)
                    finally:
                        self.peer.reset(token)
        finally:
            self.service.lock.release()

    def data_scope(self, guard):
        return ConfiguredRuntime(_DATA_KEY, self, guard)

    def dispatch(self, operation, data):
        if operation == 'admission' and data == {}:
            return self.broker.admission()
        if operation == 'change-admission' and data == {}:
            return {**self.broker.admission(), 'protocol': 'prepared-identity'}
        if operation == 'prepare' and set(data) == {'requestId', 'admissionBinding', 'baselineIdentityBase64', 'plannedIdentityBase64'}:
            return self.broker.prepare(request_id=data['requestId'], admission_binding=data['admissionBinding'],
                                       baseline_identity=self.identity(data['baselineIdentityBase64']),
                                       planned_identity=self.identity(data['plannedIdentityBase64']))
        if operation == 'complete' and set(data) == {'operationId', 'admissionBinding', 'currentIdentityBase64'}:
            return self.broker.complete(operation_id=data['operationId'], admission_binding=data['admissionBinding'],
                                        current_identity=self.identity(data['currentIdentityBase64']))
        if operation in ('counter-challenge', 'counter-complete', 'counter-floors'):
            return self.counter_request(operation, data)
        if operation in ('ownership-prepare', 'ownership-check', 'ownership-complete'):
            return self.ownership_request(operation, data)
        raise fail()

    @contextmanager
    def ownership_scope(self):
        """An admitted never-managed policy, pinned under the shared host locks.

        Missing admission/history is unknown. Default first-setup and reviewed
        legacy deployment need their separate positive Root provisioning proof;
        this existing-admission issuer does not manufacture that fallback.
        """
        host = self.service.HOST
        namespace = host.AUTHORITY.LAYOUT.namespace(self.service.root)
        if (self.service.state_dir != host.AUTHORITY.LAYOUT.STATE_ROOT
                or self.value['journalDirectory'] != str(namespace / 'credential-journal')):
            raise fail()
        with self.lifecycle.operation() as guard, self.broker.journal.operation(), ExitStack() as pins:
            history = PinnedFile(namespace / 'recovery-admission-history.json', limit=4096, private=True)
            pins.callback(history.close)
            value = json_body(history.body)
            fields = {'schema', 'installationId', 'generation', 'managedEver', 'mode', 'configSha256',
                      'planSha256', 'sentinelVersion', 'writerProtocol'}
            if (set(value) != fields or value['schema'] != 'orbis.recovery-admission-history.v1'
                    or type(value['generation']) is not int or not 1 <= value['generation'] < 9007199254740991
                    or value['mode'] != 'unmanaged' or value['managedEver'] is not False
                    or type(value['writerProtocol']) is not int or value['writerProtocol'] != PROTOCOL
                    or any(type(value[key]) is not str or not _HASH.fullmatch(value[key])
                           for key in ('installationId', 'configSha256', 'planSha256'))
                    or type(value['sentinelVersion']) is not str or len(value['sentinelVersion']) > 128
                    or not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?', value['sentinelVersion'])
                    or value['configSha256'] != hashlib.sha256(self.config_pin.body).hexdigest()):
                raise fail()
            intent = None
            intent_path = namespace / 'recovery-admission-intent.json'
            if os.path.lexists(intent_path):
                intent = PinnedFile(intent_path, limit=2 * 1024 * 1024, private=True)
                pins.callback(intent.close)
                transaction = json_body(intent.body)
                if (transaction.get('phase') != 'complete' or transaction.get('planSha256') != value['planSha256']
                        or not isinstance(transaction.get('plan'), dict)
                        or transaction['plan'].get('request', {}).get('mode') != 'unmanaged'):
                    raise fail()

            def admitted():
                self.verify()
                history.verify()
                if intent is not None:
                    intent.verify()
                # Do not issue a legacy grant during partial recovery setup or
                # a storage/publication transition, even before admission moves.
                for name in ('credential-bootstrap-intent.json', '.credential-bootstrap-intent.json.pending',
                             'credential-bootstrap-publication-hold.json', '.credential-bootstrap-publication-hold.json.pending'):
                    if os.path.lexists(namespace / name):
                        raise fail()
                if os.path.lexists(OWNERSHIP_RECOVERY_ENV):
                    raise fail()
                if os.path.lexists(OWNERSHIP_RECOVERY):
                    with host.AUTHORITY.protected_directory(OWNERSHIP_RECOVERY) as directory:
                        if os.listdir(directory):
                            raise fail()
                current, binding = self.broker._admitted()
                if (current['mode'] != 'unmanaged' or current['installationId'] != value['installationId']
                        or self.broker.journal.read()['active'] is not None):
                    raise fail()
                return {'schema': 'orbis.main-ownership-admission.v1', 'mode': 'unmanaged', 'managedEver': False,
                        **{key: current[key] for key in ('installationId', 'controllerId', 'imageId', 'controllerEpoch')},
                        'authorityEpoch': hashlib.sha256(json.dumps({'admissionBinding': binding,
                            'historySha256': hashlib.sha256(history.body).hexdigest(),
                            'configSha256': value['configSha256']}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}

            yield guard, admitted
            admitted()

    def ownership_request(self, operation, data):
        fields = {'ownership-prepare': {'requestId', 'purpose'},
                  'ownership-check': {'operationId', 'admissionBinding', 'purpose'},
                  'ownership-complete': {'operationId', 'admissionBinding', 'purpose', 'disposition'}}
        if (type(data) is not dict or set(data) != fields[operation]
                or data['purpose'] not in ('first-registration', 'account-removal')):
            raise fail()
        hashes = ('requestId',) if operation == 'ownership-prepare' else ('operationId', 'admissionBinding')
        if (any(type(data[key]) is not str or not _HASH.fullmatch(data[key]) for key in hashes)
                or operation == 'ownership-complete' and data['disposition'] not in ('committed', 'not-written')):
            raise fail()
        if self.ownership_authority is None:
            module = self.service.HOST.load_script('orbis-host-ownership-authority.py', 'orbis_main_ownership_authority')
            self.ownership_authority = module.OwnershipAuthority(
                self.service.HOST, self.service.root, self.service.context, self.ownership_scope)
        if operation == 'ownership-prepare':
            return self.ownership_authority.prepare(data['requestId'], data['purpose'])
        if operation == 'ownership-check':
            return self.ownership_authority.check(data['operationId'], data['admissionBinding'], data['purpose'])
        return self.ownership_authority.complete(
            data['operationId'], data['admissionBinding'], data['purpose'], data['disposition'])

    def counter_request(self, operation, data):
        fields = {'counter-challenge': {'admissionBinding', 'purpose', 'ceremonyBinding'},
                  'counter-complete': {'admissionBinding', 'purpose', 'ceremonyBinding', 'challenge', 'response'},
                  'counter-floors': {'admissionBinding', 'identityBase64'}}
        if set(data) != fields[operation] or type(data['admissionBinding']) is not str or not _HASH.fullmatch(data['admissionBinding']):
            raise fail()
        if operation != 'counter-floors':
            if (data['purpose'] not in ('login', 'sensitive') or type(data['ceremonyBinding']) is not str
                    or not _HASH.fullmatch(data['ceremonyBinding'])):
                raise fail()
            if operation == 'counter-complete' and (type(data['challenge']) is not str
                    or not re.fullmatch(r'[A-Za-z0-9_-]{43}', data['challenge']) or type(data['response']) is not dict):
                raise fail()
        else:
            self.identity(data['identityBase64'])
        # Counter RPCs hold the SAME host locks, but do not revoke/re-enroll an
        # operator or pretend metadata advancement is an identity-change lease.
        # A pending identity change always excludes new counter ceremonies.
        with self.broker._operation() as (_, marker):
            admitted, binding = self.broker._admitted(data['admissionBinding'])
            if marker is not None or self.broker.journal.read()['active'] is not None:
                raise fail()
            if admitted['mode'] == 'unmanaged':
                if operation != 'counter-challenge':
                    raise fail()
                return {'mode': 'unmanaged', 'admissionBinding': binding}
            arguments = {key: value for key, value in data.items() if key != 'admissionBinding'}
            if operation == 'counter-floors':
                status = self.broker.control.call('operator-status', {})
                if (type(status) is not dict or set(status) != {'generation', 'revision', 'state'}
                        or status['state'] != 'enrolled' or type(status['generation']) is not int or status['generation'] < 1
                        or status['generation'] > 9007199254740991 or type(status['revision']) is not str
                        or not _HASH.fullmatch(status['revision'])):
                    raise fail()
                arguments.update(expectedGeneration=status['generation'], expectedRevision=status['revision'])
                result = self.broker.control.call('main-passkey-floors', arguments)
            else:
                arguments['admissionBinding'] = binding
                result = self.broker.control.call('main-passkey-' + ('challenge' if operation == 'counter-challenge' else 'complete'), arguments)
            self.broker._admitted(binding)
            if type(result) is not dict:
                raise fail()
            if operation == 'counter-challenge':
                return {**result, 'mode': 'managed', 'admissionBinding': binding}
            if operation == 'counter-floors':
                return {**result, 'schema': 'orbis.sentinel-main-counter-floors.v1', 'admissionBinding': binding}
            return {**result, 'admissionBinding': binding}

    def close(self):
        with self.service.lock:
            if not self.closed:
                self.closed = True
                self.resources.close()
