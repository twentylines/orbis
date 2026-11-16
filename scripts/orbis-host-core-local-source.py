"""Read completed local capture authority; never grant execution or repair records."""
import copy
import hashlib
import importlib.util
import os
from pathlib import Path, PurePosixPath
import re
import stat
import time
from contextlib import contextmanager
from dataclasses import dataclass, field


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


W = load('orbis-host-core-capture-worker.py', 'orbis_local_source_capture_worker')
RETIRE = load('orbis-host-core-capture-retirement.py', 'orbis_local_source_retirement')
COMPLETION = load('orbis-host-core-capture-completion.py', 'orbis_local_source_completion')
INSPECTION = load('orbis-host-core-inspection-profile.py', 'orbis_local_source_inspection_profile')
SCHEMA = 'orbis.core-local-inspection-source.v1'
INSPECTION_SCHEMA = 'orbis.core-local-inspection-binding.v1'
RESOURCE_SCHEMA = 'orbis.core-local-inspection-resources.v1'
CONFIGURATION_SCHEMA = 'orbis.core-local-configuration-source.v1'
CONFIGURATION_PROFILE = 'orbis.source-configuration.dotenv-17.2.3.v1'
HEX = re.compile(r'[a-f0-9]{64}')
LIMIT = 64 * 1024 ** 3
_DATABASE_CAPABILITY = object()


class LocalSourceError(ValueError):
    pass


@dataclass(frozen=True)
class OptionalResourceRead:
    """An FD or authenticated absence, valid only after its scope exits cleanly."""
    present: bool
    descriptor: int | None


@dataclass(frozen=True)
class ConfigurationSourceRead:
    """Private captured candidates; accept only after the read scope exits cleanly."""
    configuration: bytes = field(repr=False)
    passkeys: bytes | None = field(repr=False)
    witness: dict


class _DatabaseSource:
    """A live, scoped copy capability; neither a pathname nor a serialized grant."""
    def __init__(self, token, source, descriptor, checked, binding):
        if token is not _DATABASE_CAPABILITY:
            raise fail()
        self._source, self._descriptor, self._checked, self._binding = source, descriptor, checked, binding
        self._active = True

    def copy_to(self, destination, qualified_profile):
        try:
            if not self._active:
                raise fail()
            self._checked()
            profile = INSPECTION.validate_profile(qualified_profile)
            compatibility = self._binding['compatibility']
            if (profile['imageId'] != self._binding['images']['database']
                    or profile['os'] != compatibility['os'] or profile['architecture'] != compatibility['architecture']
                    or compatibility['database']['engine'] != 'postgresql' or profile['major'] != compatibility['database']['major']):
                raise fail()
            destination = Path(destination)
            if not destination.is_absolute() or destination.resolve(strict=False) != destination:
                raise fail()
            protected = (self._source.root, self._source.bundle, self._source.capture.base, self._source.capture.snapshots,
                         self._source.state / 'core-capture-admissions', self._source.state / 'core-capture-preparations')
            if any(W.CORE.TX.STORAGE.overlaps(destination, path) for path in protected):
                raise fail()
            receipt = INSPECTION.prepare_copy_from_fd(self._descriptor, destination, profile, self._source.a)
            self._checked()
            INSPECTION.verify_overlay(destination, receipt, self._source.a)
            self._checked()
            return receipt
        except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
            raise fail() from None


def fail():
    return LocalSourceError('The original completed local capture is unavailable or changed.')


def actor_value(actor):
    if (not isinstance(actor, dict) or set(actor) != {'ownerId', 'sessionBinding', 'securityBinding'}
            or type(actor['ownerId']) is not int or not 1 <= actor['ownerId'] <= 2147483647
            or any(not isinstance(actor[key], str) or not HEX.fullmatch(actor[key]) for key in ('sessionBinding', 'securityBinding'))):
        raise fail()
    return dict(actor)


class CoreLocalInspectionSource:
    """A Root-local read capability; serialized basis data is not a file capability."""
    def __init__(self, root, state_dir, context, point, actor):
        self._pins, self._directories, self._resource_roots, self._archive_digest = {}, {}, {}, None
        try:
            W.require_root()
            self.root, self.state = Path(root), Path(state_dir)
            self.context, self.point, self.actor = context, W.identifier(point), actor_value(actor)
            W.CORE.HOST.IDENTITY.binding(str(self.root), context)
            self.a, self.P = W.A, W.P
            with self.a.protected_directory(self.root, private=False):
                pass
            with self.a.protected_directory(self.state):
                pass
            if W.CORE.TX.STORAGE.overlaps(self.root, self.state):
                raise fail()
            self.retirement = RETIRE.CaptureRetirement(W, self.state, self.root, context, self.point)
            self._verify()
        except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
            raise fail() from None

    def _directory(self, path, descriptor):
        details = os.fstat(descriptor)
        identity = tuple(getattr(details, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid'))
        if path in self._directories and self._directories[path] != identity:
            raise fail()
        self._directories[path] = identity

    def _pin(self, path, details):
        value = self.a.seal(details)
        if path in self._pins and self._pins[path] != value:
            raise fail()
        self._pins[path] = value

    def _read(self, directory, name, maximum=65536, canonical=True):
        with self.a.protected_directory(directory) as parent:
            self._directory(directory, parent)
            with self.a.protected_file(parent, name, maximum) as body:
                value = self.P.metadata(body, byte_limit=maximum)
                if not isinstance(value, dict) or canonical and self.P.canonical(value) != body:
                    raise fail()
                self._pin(directory / name, os.stat(name, dir_fd=parent, follow_symlinks=False))
                return value, body

    def _no_active(self):
        with self.a.protected_directory(self.retirement.path.parent, private=False) as parent:
            try:
                os.stat(self.retirement.path.name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                return
            raise fail()

    def _hash(self, descriptor, maximum):
        hashed, count, deadline = hashlib.sha256(), 0, time.monotonic() + 300
        os.lseek(descriptor, 0, os.SEEK_SET)
        while True:
            if time.monotonic() > deadline:
                raise fail()
            block = os.read(descriptor, min(65536, maximum + 1 - count))
            if not block:
                break
            count += len(block)
            if count > maximum:
                raise fail()
            hashed.update(block)
        os.lseek(descriptor, 0, os.SEEK_SET)
        return {'bytes': count, 'sha256': hashed.hexdigest()}

    def _checkpoint(self, artifact):
        parent_path = self.capture.base / self.point / 'portable-checkpoint'
        with self.a.protected_directory(parent_path) as parent:
            self._directory(parent_path, parent)
            descriptor = os.open('checkpoint.tar', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                before = os.fstat(descriptor)
                if (not stat.S_ISREG(before.st_mode) or before.st_uid != self.a.OWNER or before.st_nlink != 1
                        or stat.S_IMODE(before.st_mode) != 0o600 or not 1 <= before.st_size <= LIMIT):
                    raise fail()
                self._pin(parent_path / 'checkpoint.tar', before)
                if self._archive_digest is None:
                    self._archive_digest = self._hash(descriptor, LIMIT)
                if self._archive_digest != artifact['checkpoint']:
                    raise fail()
                if (self.a.seal(before) != self.a.seal(os.fstat(descriptor))
                        or self.a.seal(before) != self.a.seal(os.stat('checkpoint.tar', dir_fd=parent, follow_symlinks=False))):
                    raise fail()
            finally:
                os.close(descriptor)

    def _verify(self):
        self._no_active()
        commit = self.retirement.inspect_retired()
        directory = self.state / 'core-capture-admissions' / self.point
        records, bodies = {}, {}
        with self.a.protected_directory(directory) as parent:
            try:
                os.stat('failure.json', dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise fail()
        for name in ('request', 'source-hold', 'handoff', 'acceptance', 'supervisor', 'claim', 'settled',
                     'worker-terminal', 'completion-ready', 'completion-commit', 'source-continuation', 'source-retired'):
            records[name], bodies[name] = self._read(directory, name + '.json')
        preparation_directory = self.state / 'core-capture-preparations' / self.point
        for name in ('preparation', 'point-reservation'):
            records[name], bodies[name] = self._read(preparation_directory, name + '.json')
        h = lambda name: hashlib.sha256(bodies[name]).hexdigest()
        request, proof, terminal = records['request'], records['completion-ready'], records['worker-terminal']
        if records['completion-commit'] != commit:
            raise fail()
        self.capture = object.__new__(W.CORE.CoreCapture)
        self.capture.root, self.capture.context, self.capture.a, self.capture.P = self.root, self.context, self.a, self.P
        self.capture.base, self.capture.state = self.state / 'time-machine-core', self.state
        self.capture.snapshots = Path(request['snapshots'])
        job = self.capture.read(self.capture.base / self.point)
        saved_job, raw_job = self._read(self.capture.base / self.point, 'job.json', 16 * 1024 * 1024)
        if saved_job != job or W.CORE.TX.APPS.digest(job['source']) != request['sourceSha256']:
            raise fail()
        artifact = W.CHECKPOINT.read_receipt(self.capture, self.point, tx=W.CORE.TX)
        saved_artifact, _ = self._read(self.capture.base / self.point / 'portable-checkpoint', 'artifact.json', 16 * 1024 * 1024)
        if saved_artifact != artifact or artifact['captureJobSha256'] != hashlib.sha256(raw_job).hexdigest():
            raise fail()
        settled = records['settled']
        if (settled.get('settlement') != job['settlement'] or settled.get('captureJobSha256') != artifact['captureJobSha256']
                or settled.get('checkpointArtifactSha256') != W.digest(self.P.canonical(artifact))):
            raise fail()
        if (set(terminal) != W.SUPERVISOR.TERMINAL_KEYS or terminal['schema'] != 'orbis.core-capture-worker-terminal.v2'
                or terminal['id'] != self.point or terminal['state'] != 'quiescent' or terminal['workerQuiescent'] is not True
                or type(terminal['workerExitCode']) is not int or terminal['workerExitCode'] != 0 or terminal['failureClass'] is not None
                or any(terminal[key] != h(name) for key, name in [('requestSha256', 'request'), ('supervisorSha256', 'supervisor'),
                                                              ('claimSha256', 'claim'), ('settledSha256', 'settled')])
                or any(terminal[key] != records['supervisor'][key] for key in ('bootId', 'unit', 'invocationId', 'supervisorProcessId', 'workerLeaf'))):
            raise fail()
        if (proof.get('schema') != 'orbis.core-capture-completion-ready.v1' or proof.get('id') != self.point
                or proof.get('requestSha256') != h('request') or proof.get('terminalSha256') != h('worker-terminal')
                or proof.get('sourceHoldSha256') != h('source-hold')
                or any(commit[key] != h(name) for key, name in [('requestSha256', 'request'), ('completionSha256', 'completion-ready'),
                     ('continuationSha256', 'source-continuation'), ('pointReservationSha256', 'point-reservation'), ('sourceHoldSha256', 'source-hold')])):
            raise fail()
        reservation = W.load('orbis-host-core-capture-reservation.py', 'orbis_local_source_reservation').validate_reservation(records['point-reservation'], self.point)
        prep, hold, acceptance = records['preparation'], records['source-hold'], records['acceptance']
        if (prep.get('schema') not in {'orbis.core-capture-preparation.v2', 'orbis.core-capture-preparation.v3'}
                or any(prep.get(key) != request[key] for key in ('id', 'root', 'context', 'sourceSha256'))
                or prep.get('scope') != W.CORE.SCOPE or prep.get('pointReservationSha256') != h('point-reservation')
                or hold.get('schema') != 'orbis.core-capture-source-hold.v2' or hold.get('id') != self.point
                or hold.get('sourceSha256') != request['sourceSha256'] or hold.get('controller') != prep['controller']
                or hold.get('preparationSha256') != h('preparation') or hold.get('pointReservationSha256') != h('point-reservation')
                or acceptance.get('schema') != 'orbis.core-capture-acceptance.v1' or acceptance.get('id') != self.point
                or acceptance.get('preparationSha256') != h('preparation') or acceptance.get('sourceHoldSha256') != h('source-hold')
                or acceptance.get('workerRequestSha256') != h('request')
                or proof.get('pointReservationSha256') != h('point-reservation')
                or records['handoff'].get('controller') != prep['controller']):
            raise fail()
        controller = job['original'].get(prep['controller']['id'])
        if (not controller or job['checkpoint']['roles'].get(prep['controller']['id']) != 'controller'
                or controller['imageId'] != prep['controller']['imageId'] or controller['startedAt'] != prep['controller']['startedAt']
                or W.CORE.TX.APPS.digest(controller['definition']) != prep['controller']['definitionSha256']):
            raise fail()
        expected_controller = job['expected'][prep['controller']['id']]
        if (any(proof.get('controller', {}).get(key) != prep['controller'][key] for key in ('id', 'imageId', 'definitionSha256'))
                or proof['controller'].get('startedAt') != expected_controller['startedAt']):
            raise fail()
        completion = COMPLETION.CoreCaptureCompletion(None, W)
        expected = {'sourceSha256': request['sourceSha256'], 'checkpointSha256': artifact['checkpointSha256'],
                    'captureReceiptSha256': h('settled'), 'checkpoint': artifact['checkpoint'], 'resourceCount': artifact['resourceCount'],
                    'images': artifact['roleImageIds']}
        publication = completion.validate_publication(type('LocalAdmission', (), {'point': self.point})(), proof['publication'], expected, reservation)
        completion.continuation(records['source-continuation'], proof, commit['continuationSha256'])
        retired = records['source-retired']
        if (retired.get('schema') != 'orbis.core-capture-retirement-witness.v1' or retired.get('id') != self.point
                or any(retired.get(key) != commit[key] for key in ('completionSha256', 'continuationSha256', 'sourceHoldSha256'))
                or not isinstance(retired.get('namespace'), dict)
                or retired['namespace'].get('schema') != 'orbis.core-capture-source-retirement.v1'
                or retired['namespace'].get('id') != self.point or retired['namespace'].get('sourceHoldSha256') != h('source-hold')):
            raise fail()
        self.bundle = Path(job['checkpoint']['storage']['bundle'])
        saved_storage, _ = self._read(self.bundle, 'storage.json', 16 * 1024 * 1024, canonical=False)
        if (sum(item['record']['bytes'] for item in saved_storage['copies']) > LIMIT
                or W.CORE.TX.APPS.digest(saved_storage) != job['checkpointSha256']):
            raise fail()
        _, _, mapping, storage, bundle = W.CHECKPOINT.inputs(self.capture, self.capture.base / self.point, tx=W.CORE.TX)
        if storage != saved_storage or bundle != self.bundle:
            raise fail()
        with self.a.protected_directory(self.bundle) as parent:
            for index, resource in enumerate(storage['plan']['resources']):
                details = os.stat('resource-' + str(index).zfill(4), dir_fd=parent, follow_symlinks=False)
                current = self.a.seal(details)
                if index in self._resource_roots and self._resource_roots[index] != current:
                    raise fail()
                self._resource_roots[index] = current
        self._checkpoint(artifact)
        witness = {'schema': SCHEMA, 'origin': 'genuine-root-local-capture', 'pointId': self.point,
                   'installationBindingSha256': W.digest(self.P.canonical({'root': str(self.root), 'context': self.context})),
                   'sourceOwnerId': reservation['ownerId'], 'createdAt': reservation['createdAt'],
                   'sourceSha256': request['sourceSha256'], 'sourceManifestSha256': publication['manifestSha256'],
                   'checkpointManifestSha256': artifact['manifestSha256'], 'checkpoint': artifact['checkpoint'],
                   'captureJobSha256': artifact['captureJobSha256'], 'checkpointStorageSha256': job['checkpointSha256'],
                   'recordHashes': {name: h(name) for name in records}, 'roles': copy.deepcopy(mapping['roles']),
                   'sourceControllerFrame': copy.deepcopy(prep['controller']), 'resumedControllerFrame': copy.deepcopy(proof['controller']),
                   'storageProfile': copy.deepcopy(artifact['compatibility']), 'resourceCount': artifact['resourceCount'],
                   'resources': [{'index': row['index'], 'kind': row['kind'], 'excludedPaths': storage['plan']['resources'][row['index']].get('excludedPaths', []),
                                  'recordSha256': W.CORE.TX.APPS.digest(row['record'])} for row in storage['copies']],
                   'sourceConfigurationFileSha256': job['source'].get('enrollment', {}).get('files', {}).get('.env'),
                   'sourceAuthority': True, 'environmentProved': False, 'currentCreateEnvProved': False,
                   'activationAuthorized': False, 'restoreAuthority': False}
        self._basis = {**witness, 'sourceWitnessSha256': W.digest(self.P.canonical(witness)), 'actor': dict(self.actor)}
        self._storage, self._artifact, self._mapping = storage, artifact, mapping
        if self.retirement.inspect_retired() != commit:
            raise fail()
        self._no_active()

    def basis(self):
        try:
            self._verify()
            return copy.deepcopy(self._basis)
        except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
            raise fail() from None

    def inspection_binding(self):
        try:
            basis = self.basis()
            resources = {'schema': RESOURCE_SCHEMA, 'sourceWitnessSha256': basis['sourceWitnessSha256'],
                         'captureJobSha256': basis['captureJobSha256'], 'checkpointStorageSha256': basis['checkpointStorageSha256'],
                         'portableStorageSha256': self._artifact['portableStorageSha256'],
                         'database': copy.deepcopy(self._mapping['database']), 'resources': copy.deepcopy(basis['resources'])}
            return {'schema': INSPECTION_SCHEMA, 'origin': basis['origin'],
                    **{key: value for key, value in resources.items() if key != 'schema'},
                    'pointId': basis['pointId'], 'sourceOwnerId': basis['sourceOwnerId'],
                    'checkpointManifestSha256': basis['checkpointManifestSha256'],
                    'images': {role: entry['imageId'] for role, entry in basis['roles'].items()},
                    'compatibility': copy.deepcopy(basis['storageProfile']), 'resourcesSha256': W.digest(self.P.canonical(resources)),
                    'sourceAuthority': True, 'environmentProved': False, 'restoreAuthority': False}
        except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
            raise fail() from None

    @contextmanager
    def open_database_source(self):
        try:
            binding = self.inspection_binding()
            location = binding['database']
            W.CORE.MAP.resource_address(self._storage['plan']['resources'], location)
            if self._storage['plan']['resources'][location['resourceIndex']]['kind'] != 'directory':
                raise fail()
            names = ['resource-' + str(location['resourceIndex']).zfill(4), *PurePosixPath(location['resourcePath']).parts]
            opened, capability = [], None
            with self.a.protected_directory(self.bundle) as parent:
                self._directory(self.bundle, parent)
                current = parent
                try:
                    for name in names:
                        descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=current)
                        before = os.fstat(descriptor)
                        opened.append((current, name, descriptor, before)); current = descriptor

                    def checked():
                        for parent_fd, name, fd, expected in opened:
                            if self.a.seal(expected) != self.a.seal(os.fstat(fd)) or self.a.seal(expected) != self.a.seal(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)):
                                raise fail()
                        if self.inspection_binding() != binding:
                            raise fail()
                        self._directory(self.bundle, parent)
                        for parent_fd, name, fd, expected in opened:
                            if self.a.seal(expected) != self.a.seal(os.fstat(fd)) or self.a.seal(expected) != self.a.seal(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)):
                                raise fail()

                    checked()
                    capability = _DatabaseSource(_DATABASE_CAPABILITY, self, descriptor, checked, binding)
                    yield capability
                    checked()
                finally:
                    if capability is not None:
                        capability._active = False
                    for _, _, fd, _ in reversed(opened): os.close(fd)
        except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
            raise fail() from None

    def _configuration_address(self, controller, container_path):
        target = PurePosixPath(container_path)
        covering = [mount for mount in controller['mounts'] if target.is_relative_to(PurePosixPath(mount['destination']))]
        if not covering:
            raise fail()
        depth = max(len(PurePosixPath(mount['destination']).parts) for mount in covering)
        selected = [mount for mount in covering if len(PurePosixPath(mount['destination']).parts) == depth]
        if len(selected) != 1 or 'policy' in selected[0] or selected[0]['type'] not in {'bind', 'volume'}:
            raise fail()
        mount = selected[0]
        relative = str(PurePosixPath(mount['resourcePath']) / target.relative_to(PurePosixPath(mount['destination'])))
        address = {'resourceIndex': mount['resourceIndex'], 'resourcePath': relative}
        W.CORE.MAP.resource_address(self._storage['plan']['resources'], address)
        binding = {'mountSha256': W.digest(self.P.canonical(mount)),
                   'addressSha256': W.digest(self.P.canonical(address)),
                   'resourceRecordSha256': W.CORE.TX.APPS.digest(self._storage['copies'][address['resourceIndex']]['record'])}
        return address, binding

    def _configuration_bytes(self, descriptor, maximum):
        value = bytearray()
        os.lseek(descriptor, 0, os.SEEK_SET)
        while block := os.read(descriptor, min(65536, maximum + 1 - len(value))):
            value.extend(block)
            if len(value) > maximum:
                raise fail()
        return bytes(value)

    @contextmanager
    def open_configuration_source(self, expected_controller_image_id, parser_profile):
        """Bind a caller-qualified image/profile to sealed bytes, never effective keys."""
        try:
            before = self.basis()
            controller = before['roles']['controller']
            if (not isinstance(expected_controller_image_id, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', expected_controller_image_id)
                    or parser_profile != CONFIGURATION_PROFILE or expected_controller_image_id != controller['imageId']
                    or expected_controller_image_id != before['sourceControllerFrame']['imageId']
                    or not isinstance(before['sourceConfigurationFileSha256'], str) or not HEX.fullmatch(before['sourceConfigurationFileSha256'])):
                raise fail()
            configuration, configuration_binding = self._configuration_address(controller, '/data/.env')
            passkeys, passkeys_binding = self._configuration_address(controller, '/data/state/auth/passkeys.json')
            if configuration['resourceIndex'] == passkeys['resourceIndex']:
                left, right = [PurePosixPath(address['resourcePath']) for address in (configuration, passkeys)]
                if left.is_relative_to(right) or right.is_relative_to(left):
                    raise fail()
            with self.open_resource(configuration['resourceIndex'], configuration['resourcePath'], 1024 * 1024) as configuration_fd:
                with self.open_optional_resource(passkeys['resourceIndex'], passkeys['resourcePath'], 512 * 1024) as passkey_read:
                    configuration_bytes = self._configuration_bytes(configuration_fd, 1024 * 1024)
                    configuration_sha = W.digest(configuration_bytes)
                    if configuration_sha != before['sourceConfigurationFileSha256']:
                        raise fail()
                    passkey_bytes = self._configuration_bytes(passkey_read.descriptor, 512 * 1024) if passkey_read.present else None
                    if self.basis() != before:
                        raise fail()
                    witness = {'schema': CONFIGURATION_SCHEMA, 'sourceWitnessSha256': before['sourceWitnessSha256'],
                               'sourceManifestSha256': before['sourceManifestSha256'], 'controllerImageId': expected_controller_image_id,
                               'parserProfile': parser_profile, 'sourceConfigurationFileSha256': before['sourceConfigurationFileSha256'],
                               'configuration': {**configuration_binding, 'present': True, 'sha256': configuration_sha, 'bytes': len(configuration_bytes)},
                               'passkeys': {**passkeys_binding, 'present': passkey_read.present,
                                           'sha256': W.digest(passkey_bytes) if passkey_read.present else None,
                                           'bytes': len(passkey_bytes) if passkey_read.present else 0},
                               'environmentProved': False, 'restoreAuthority': False}
                    yield ConfigurationSourceRead(configuration_bytes, passkey_bytes, witness)
                    if self.basis() != before:
                        raise fail()
        except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
            raise fail() from None

    @contextmanager
    def open_checkpoint(self):
        try:
            self._verify()
            parent_path = self.capture.base / self.point / 'portable-checkpoint'
            with self.a.protected_directory(parent_path) as parent:
                descriptor = os.open('checkpoint.tar', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    before = os.fstat(descriptor); self._pin(parent_path / 'checkpoint.tar', before)
                    yield descriptor
                    if self.a.seal(before) != self.a.seal(os.fstat(descriptor)) or self.a.seal(before) != self.a.seal(os.stat('checkpoint.tar', dir_fd=parent, follow_symlinks=False)):
                        raise fail()
                    self._verify()
                finally:
                    os.close(descriptor)
        except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
            raise fail() from None

    @contextmanager
    def open_resource(self, index, relative='.', maximum=2 * 1024 * 1024):
        with self._resource_read(index, relative, maximum, optional=False) as result:
            yield result.descriptor

    @contextmanager
    def open_optional_resource(self, index, relative='.', maximum=2 * 1024 * 1024):
        with self._resource_read(index, relative, maximum, optional=True) as result:
            yield result

    @contextmanager
    def _resource_read(self, index, relative, maximum, *, optional):
        try:
            self._verify()
            if type(index) is not int or not 0 <= index < len(self._storage['copies']) or type(maximum) is not int or not 1 <= maximum <= LIMIT:
                raise fail()
            if (not isinstance(relative, str) or not relative or any(ord(c) < 32 or ord(c) == 127 for c in relative)
                    or PurePosixPath(relative).is_absolute() or '..' in PurePosixPath(relative).parts or str(PurePosixPath(relative)) != relative):
                raise fail()
            resource = self._storage['plan']['resources'][index]
            if any(PurePosixPath(relative) == PurePosixPath(p) or PurePosixPath(relative).is_relative_to(PurePosixPath(p)) for p in resource.get('excludedPaths', [])):
                raise fail()
            names = ['resource-' + str(index).zfill(4)] + ([] if relative == '.' else list(PurePosixPath(relative).parts))
            if resource['kind'] == 'file' and relative != '.':
                raise fail()
            opened = []
            missing = None
            with self.a.protected_directory(self.bundle) as parent:
                self._directory(self.bundle, parent)
                current = parent
                try:
                    for position, name in enumerate(names):
                        last = position == len(names) - 1
                        try:
                            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | (0 if last else os.O_DIRECTORY), dir_fd=current)
                        except FileNotFoundError:
                            # A missing captured resource itself is never optional.
                            if not optional or position == 0 or resource['kind'] != 'directory':
                                raise fail() from None
                            missing = (current, name)
                            break
                        before = os.fstat(descriptor)
                        opened.append((current, name, descriptor, before)); current = descriptor
                    if missing is None and (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > maximum):
                        raise fail()

                    def unchanged():
                        self._directory(self.bundle, parent)
                        for parent_fd, name, fd, expected in opened:
                            if self.a.seal(expected) != self.a.seal(os.fstat(fd)) or self.a.seal(expected) != self.a.seal(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)):
                                raise fail()
                        if missing is not None:
                            try:
                                os.stat(missing[1], dir_fd=missing[0], follow_symlinks=False)
                            except FileNotFoundError:
                                pass
                            else:
                                raise fail()

                    unchanged()
                    self._verify()
                    unchanged()
                    yield OptionalResourceRead(missing is None, descriptor if missing is None else None)
                    unchanged()
                    self._verify()
                    unchanged()
                finally:
                    for _, _, fd, _ in reversed(opened): os.close(fd)
        except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
            raise fail() from None
