"""Private Root broker for captured configuration; no restore authority is granted.

The caller assembles TrustedCoordinator from independently approved installed code,
image and source-parser qualification. It must never be constructed from an RPC.
"""
import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import secrets
import stat
from dataclasses import dataclass


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SUPERVISOR = load('orbis-host-core-inspection-executor.py', 'orbis_configuration_supervisor')
PROFILE = SUPERVISOR.PROFILE
HEX = re.compile(r'[a-f0-9]{64}')
IMAGE = re.compile(r'sha256:[a-f0-9]{64}')
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
NAME = re.compile(r'[a-zA-Z_][a-zA-Z0-9_]{0,62}')
PARSER = 'orbis.source-configuration.dotenv-17.2.3.v1'
SCHEMA = 'orbis.core-source-configuration-preparation.v1'
TARGET_SCHEMA = 'orbis.core-target-configuration-preparation.v1'


class PreparationError(ValueError):
    pass


def fail():
    return PreparationError('Captured configuration preparation requires protected review')


def sha(body):
    return hashlib.sha256(body).hexdigest()


@dataclass(frozen=True)
class TrustedCoordinator:
    """Root-selected capability; inventory is independently approved, not self-attested."""
    image_id: str
    architecture: str
    code_directory: Path
    inventory: dict
    source_controller_image_id: str
    parser_profile: str


@dataclass(frozen=True)
class PreparedConfiguration:
    """Private capability handle; authentication is never represented in this value."""
    identifier: str
    receipt_sha256: str


@dataclass(frozen=True)
class RootTargetConfiguration:
    """Destination bytes and witness selected by the Root caller, never an RPC input."""
    configuration: bytes
    database_name: str
    witness_sha256: str


@dataclass(frozen=True)
class PreparedTargetConfiguration:
    identifier: str
    receipt_sha256: str


class CoreSourceConfigurationPreparation:
    def __init__(self, enrollment, trusted_coordinator, *, target=None):
        self.enrollment, self.trust = enrollment, trusted_coordinator
        self.a, self.P = enrollment.a, enrollment.P
        self.context, self.runtime = enrollment.context, enrollment.runtime
        t = trusted_coordinator
        if (type(t) is not TrustedCoordinator or not IMAGE.fullmatch(t.image_id)
                or not IMAGE.fullmatch(t.source_controller_image_id) or t.parser_profile != PARSER
                or t.architecture not in {'amd64', 'arm64'} or not isinstance(t.inventory, dict)
                or not isinstance(t.code_directory, Path) or not t.code_directory.is_absolute()
                or str(t.code_directory) != os.path.realpath(t.code_directory)):
            raise fail()
        self.inventory = copy.deepcopy(t.inventory)
        self.target = target
        self.target_binding()

    def target_binding(self):
        target = self.target
        if target is None:
            return None
        if (type(target) is not RootTargetConfiguration
                or type(target.configuration) is not bytes or not 1 <= len(target.configuration) <= 1024 * 1024
                or b'\0' in target.configuration
                or not isinstance(target.database_name, str) or not NAME.fullmatch(target.database_name)
                or target.database_name.lower() in {'postgres', 'template0', 'template1'}
                or not isinstance(target.witness_sha256, str) or not HEX.fullmatch(target.witness_sha256)):
            raise fail()
        try:
            target.configuration.decode('utf-8', errors='strict')
        except UnicodeError:
            raise fail() from None
        return {'destinationWitnessSha256': target.witness_sha256,
                'destinationConfigurationSha256': sha(target.configuration), 'targetDatabaseName': target.database_name}

    def schema(self):
        return TARGET_SCHEMA if self.target_binding() is not None else SCHEMA

    def worker_role(self):
        return 'target-configuration' if self.target_binding() is not None else 'configuration'

    def digest(self, value):
        return sha(self.P.canonical(value))

    def directory(self, identifier, create=False):
        if not isinstance(identifier, str) or not UUID.fullmatch(identifier):
            raise fail()
        name = 'core-target-configuration-preparations' if self.target_binding() is not None else 'core-source-configuration-preparations'
        base = self.enrollment.child(self.enrollment.state, name) if create else self.enrollment.state / name
        with self.a.protected_directory(base):
            pass
        directory = base / identifier
        if create:
            directory.mkdir(mode=0o700)
            self.enrollment.sync(base)
        with self.a.protected_directory(directory):
            pass
        return directory

    def save(self, record):
        self.a.atomic(self.directory(record['id']) / 'job.json', self.P.canonical(record))

    def record(self, identifier):
        record = self.enrollment.json(self.directory(identifier) / 'job.json', 4 * 1024 * 1024)
        if (record.get('schema') != self.schema() or record.get('id') != identifier
                or record.get('root') != str(self.enrollment.root) or record.get('context') != self.context):
            raise fail()
        return record

    def code(self):
        path = self.trust.code_directory
        with self.a.protected_directory(path) as descriptor:
            names = sorted(os.listdir(descriptor))
            if (not 1 <= len(names) <= 64 or 'core-source-configuration-worker.mjs' not in names
                    or any(not re.fullmatch(r'[a-z0-9-]+\.mjs', n) for n in names)):
                raise fail()
            actual = {}
            for name in names:
                details = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                if details.st_uid != self.a.OWNER or stat.S_IMODE(details.st_mode) not in {0o400, 0o600}:
                    raise fail()
                actual[name] = PROFILE.regular_digest(descriptor, name, self.a, 16 * 1024 * 1024)
            if sum(x['bytes'] for x in actual.values()) > 64 * 1024 * 1024 or actual != self.inventory:
                raise fail()
            return actual

    def image(self):
        image = self.runtime.image(self.trust.image_id)
        if (image.get('Id') != self.trust.image_id or image.get('Os') != 'linux'
                or image.get('Architecture') != self.trust.architecture
                or (image.get('Config') or {}).get('Volumes') not in (None, {})):
            raise fail()

    def binding(self):
        binding = {'imageId': self.trust.image_id, 'architecture': self.trust.architecture,
                'sourceControllerImageId': self.trust.source_controller_image_id, 'parserProfile': PARSER,
                'codeDirectory': str(self.trust.code_directory), 'inventory': self.code()}
        target = self.target_binding()
        if target is not None:
            binding['target'] = target
        return binding

    def source(self, source):
        basis = source.basis()
        if (basis.get('origin') != 'genuine-root-local-capture' or basis.get('sourceAuthority') is not True
                or basis.get('environmentProved') is not False or basis.get('restoreAuthority') is not False
                or basis.get('roles', {}).get('controller', {}).get('imageId') != self.trust.source_controller_image_id
                or basis.get('sourceControllerFrame', {}).get('imageId') != self.trust.source_controller_image_id):
            raise fail()
        with source.open_configuration_source(self.trust.source_controller_image_id, PARSER) as selected:
            configuration, passkeys, witness = selected.configuration, selected.passkeys, copy.deepcopy(selected.witness)
            if (not isinstance(configuration, bytes) or not 1 <= len(configuration) <= 1024 * 1024
                    or (passkeys is not None and (not isinstance(passkeys, bytes) or not 1 <= len(passkeys) <= 2 * 1024 * 1024))):
                raise fail()
            if (set(witness) != {'schema', 'sourceWitnessSha256', 'sourceManifestSha256', 'controllerImageId', 'parserProfile',
                                 'sourceConfigurationFileSha256', 'configuration', 'passkeys', 'environmentProved', 'restoreAuthority'}
                    or witness['schema'] != 'orbis.core-local-configuration-source.v1'
                    or witness['sourceWitnessSha256'] != basis['sourceWitnessSha256']
                    or witness['sourceManifestSha256'] != basis['sourceManifestSha256']
                    or witness['controllerImageId'] != self.trust.source_controller_image_id or witness['parserProfile'] != PARSER
                    or witness['sourceConfigurationFileSha256'] != sha(configuration)
                    or witness['environmentProved'] is not False or witness['restoreAuthority'] is not False):
                raise fail()
            for key, value in (('configuration', configuration), ('passkeys', passkeys)):
                item = witness[key]
                if (not isinstance(item, dict) or set(item) != {'mountSha256', 'addressSha256', 'resourceRecordSha256', 'present', 'sha256', 'bytes'}
                        or any(not isinstance(item[k], str) or not HEX.fullmatch(item[k]) for k in ('mountSha256', 'addressSha256', 'resourceRecordSha256'))
                        or item['present'] is not (value is not None) or item['sha256'] != (sha(value) if value is not None else None)
                        or type(item['bytes']) is not int or item['bytes'] != (len(value) if value is not None else 0)):
                    raise fail()
        if source.basis() != basis:
            raise fail()
        return basis, witness, configuration, passkeys

    def body(self, directory, identifier, nonce):
        host = PROFILE.host({'pids': 64, 'memory': 256 * 1024 ** 2})
        host['LogConfig'] = {'Type': 'none', 'Config': {}}
        host['Mounts'] = [PROFILE.mount(self.trust.code_directory, '/app/core-source-configuration', True),
                          PROFILE.mount(directory / 'input', '/source-configuration-input', True),
                          PROFILE.mount(directory / 'output', '/source-configuration-output', False)]
        return {'Image': self.trust.image_id, 'User': '0:0', 'Entrypoint': ['node'],
                'Cmd': ['/app/core-source-configuration/core-source-configuration-worker.mjs',
                        '--project-target' if self.target_binding() is not None else '--project'],
                'WorkingDir': '/app', 'Env': ['NODE_ENV=production'], 'Healthcheck': {'Test': ['NONE']},
                'Labels': {'io.orbis.core-inspection': identifier, 'io.orbis.core-inspection.nonce': nonce,
                           'io.orbis.core-inspection.role': self.worker_role()}, 'HostConfig': host}

    def prepare(self, identifier, actor, source):
        actor = self.enrollment.actor(actor)
        directory = self.directory(identifier, create=True)
        record = {'schema': self.schema(), 'id': identifier, 'root': str(self.enrollment.root), 'context': self.context,
                  'actor': actor, 'phase': 'preparing', 'restoreAuthority': False}
        self.save(record)
        try:
            binding = self.binding()
            self.image()
            basis, witness, configuration, passkeys = self.source(source)
            if basis.get('actor') != record['actor']:
                raise fail()
            request = {'schema': 'orbis.core-source-configuration-worker-input.v1', 'id': identifier,
                       'nonce': secrets.token_hex(32), 'parserProfile': PARSER,
                       'sourceWitnessSha256': witness['sourceWitnessSha256'], 'sourceManifestSha256': witness['sourceManifestSha256'],
                       'controllerImageId': witness['controllerImageId'], 'configurationSha256': sha(configuration),
                       'passkeysSha256': sha(passkeys) if passkeys is not None else None}
            target = self.target_binding()
            if target is not None:
                request.update(target, schema='orbis.core-target-configuration-worker-input.v1')
            for part in ('input', 'output'):
                (directory / part).mkdir(mode=0o700)
            self.enrollment.sync(directory)
            for name, value in [('request.json', self.P.canonical(request)), ('configuration.env', configuration)] + ([] if passkeys is None else [('passkeys.json', passkeys)]):
                self.enrollment.immutable(directory / 'input' / name, value)
            if target is not None:
                self.enrollment.immutable(directory / 'input/destination.env', self.target.configuration)
            record.update(binding=binding, basis=basis, witness=witness, request=request, phase='running')
            self.save(record)
            supervisor = SUPERVISOR.InspectionSupervisor(self, record)
            role = self.worker_role()
            supervisor.create_start(role, self.body(directory, identifier, request['nonce']))
            supervisor.wait(role, 30)
            record['phase'] = 'terminal'
            self.save(record)
            return self._checked(record, actor, source, finalize=True)
        except BaseException:
            record['phase'] = 'recovery-required'
            self.save(record)
            raise fail() from None

    def checked(self, identifier, actor, source):
        try:
            return self._checked(self.record(identifier), actor, source, finalize=False)
        except BaseException:
            raise fail() from None

    def _checked(self, record, actor, source, finalize):
        directory = self.directory(record['id'])
        if (record['actor'] != self.enrollment.actor(actor) or record['phase'] != ('terminal' if finalize else 'complete')
                or record['binding'] != self.binding() or record['restoreAuthority'] is not False):
            raise fail()
        self.image()
        basis, witness, configuration, passkeys = self.source(source)
        if basis != record['basis'] or witness != record['witness'] or basis.get('actor') != record['actor']:
            raise fail()
        request = record['request']
        target = self.target_binding()
        request_fields = {'schema', 'id', 'nonce', 'parserProfile', 'sourceWitnessSha256', 'sourceManifestSha256',
                          'controllerImageId', 'configurationSha256', 'passkeysSha256'}
        if target is not None:
            request_fields.update(target)
        request_schema = 'orbis.core-target-configuration-worker-input.v1' if target is not None else 'orbis.core-source-configuration-worker-input.v1'
        if (not self.P.exact(request, request_fields)
                or request['schema'] != request_schema or request['id'] != record['id']
                or not isinstance(request['nonce'], str) or not HEX.fullmatch(request['nonce'])
                or request['parserProfile'] != PARSER or request['controllerImageId'] != self.trust.source_controller_image_id
                or request['sourceWitnessSha256'] != witness['sourceWitnessSha256']
                or request['sourceManifestSha256'] != witness['sourceManifestSha256']
                or request['configurationSha256'] != sha(configuration)
                or request['passkeysSha256'] != (sha(passkeys) if passkeys is not None else None)):
            raise fail()
        if target is not None and any(request[key] != value for key, value in target.items()):
            raise fail()
        expected = {'request.json': self.P.canonical(request), 'configuration.env': configuration}
        if target is not None:
            expected['destination.env'] = self.target.configuration
        if passkeys is not None:
            expected['passkeys.json'] = passkeys
        with self.a.protected_directory(directory / 'input') as fd:
            if set(os.listdir(fd)) != set(expected):
                raise fail()
        for name, body in expected.items():
            if self.enrollment.read(directory / 'input' / name, 2 * 1024 * 1024) != body:
                raise fail()
        workers = record.get('inspectionWorkers')
        role = self.worker_role()
        if not isinstance(workers, dict) or set(workers) != {role} or workers[role].get('intent') != 'complete':
            raise fail()
        worker = workers[role]
        if worker.get('body') != self.body(directory, record['id'], request['nonce']):
            raise fail()
        raw = SUPERVISOR.InspectionSupervisor(self, record).inspect(role)
        state = raw.get('State') or {}
        if (self.runtime.definition(raw) != worker.get('definitionSha256') or raw.get('State') != worker.get('terminal', {}).get('state')
                or worker['terminal'].get('id') != worker['id'] or worker['terminal'].get('definitionSha256') != worker['definitionSha256']
                or state.get('Status') != 'exited' or state.get('Running') is not False or state.get('Restarting') is not False
                or state.get('Dead') is not False or state.get('OOMKilled') is not False or state.get('ExitCode') != 0
                or not isinstance(state.get('FinishedAt'), str) or state['FinishedAt'].startswith('0001-')):
            raise fail()
        with self.a.protected_directory(directory / 'output') as fd:
            expected_outputs = {'source-authentication.json', 'result.json'}
            if target is not None:
                expected_outputs.update({'target.env', 'target-settings.json'})
            if set(os.listdir(fd)) != expected_outputs:
                raise fail()
            for name in os.listdir(fd):
                details = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if not stat.S_ISREG(details.st_mode) or details.st_uid != self.a.OWNER or details.st_nlink != 1 or stat.S_IMODE(details.st_mode) != 0o400:
                    raise fail()
        auth = self.enrollment.read(directory / 'output/source-authentication.json', 2 * 1024 * 1024)
        report_body = self.enrollment.read(directory / 'output/result.json', 2 * 1024 * 1024)
        auth_value = self.P.metadata(auth, byte_limit=2 * 1024 * 1024, string_limit=2 * 1024 * 1024)
        report = self.P.metadata(report_body, byte_limit=2 * 1024 * 1024, string_limit=2 * 1024 * 1024)
        if (auth != self.P.canonical(auth_value) or not self.P.exact(auth_value, {'jwtSecret', 'passkeys'})
                or not isinstance(auth_value['jwtSecret'], str) or not 32 <= len(auth_value['jwtSecret']) <= 4096
                or (auth_value['passkeys'] is not None and not isinstance(auth_value['passkeys'], dict))
                or (passkeys is None) != (auth_value['passkeys'] is None)
                or report_body != self.P.canonical(report)
                or not self.P.exact(report, {'schema', 'id', 'nonce', 'inputSha256', 'projection', 'restoreAuthority'} | ({'target'} if target is not None else set()))
                or report['schema'] != ('orbis.core-target-configuration-worker-result.v1' if target is not None else 'orbis.core-source-configuration-worker-result.v1')
                or report['id'] != record['id'] or report['nonce'] != request['nonce']
                or report['inputSha256'] != self.digest(request) or report['restoreAuthority'] is not False):
            raise fail()
        p = report['projection']
        fields = {'schema', 'parserProfile', 'sourceWitnessSha256', 'sourceManifestSha256', 'controllerImageId', 'configurationSha256',
                  'controllerEnvironmentSha256', 'databaseEnvironmentSha256', 'passkeysSha256', 'role', 'database',
                  'sourceAuthenticationSha256', 'basis', 'environmentBasis', 'environmentProved', 'restoreAuthority'}
        if (not self.P.exact(p, fields) or p['schema'] != 'orbis.core-source-environment.v2'
                or any(p[k] != request[k] for k in ('parserProfile', 'sourceWitnessSha256', 'sourceManifestSha256', 'controllerImageId', 'configurationSha256', 'passkeysSha256'))
                or p['controllerEnvironmentSha256'] is not None or p['databaseEnvironmentSha256'] is not None
                or p['sourceAuthenticationSha256'] != sha(auth) or p['basis'] != 'captured-configuration-candidate'
                or p['environmentBasis'] != 'captured-complete-configuration' or p['environmentProved'] is not False or p['restoreAuthority'] is not False
                or any(not isinstance(p[k], str) or not NAME.fullmatch(p[k]) for k in ('role', 'database'))):
            raise fail()
        target_receipt = {}
        if target is not None:
            environment = self.enrollment.read(directory / 'output/target.env', 1024 * 1024)
            settings = self.enrollment.read(directory / 'output/target-settings.json', 1024 * 1024)
            try:
                environment.decode('utf-8', errors='strict')
            except UnicodeError:
                raise fail() from None
            if not environment or b'\0' in environment or not isinstance(self.P.metadata(settings, byte_limit=1024 * 1024), dict):
                raise fail()
            expected_target = {'schema': 'orbis.core-target-configuration.v1', **{k: target[k] for k in ('destinationWitnessSha256', 'destinationConfigurationSha256')},
                               'databaseName': target['targetDatabaseName'], 'configurationSha256': sha(environment),
                               'settingsSha256': sha(settings), 'sourceAuthenticationSha256': sha(auth),
                               'sessionPolicy': 'new-empty-cache-required', 'environmentProved': False,
                               'restoreAuthority': False, 'activation': False}
            if self.P.canonical(report.get('target')) != self.P.canonical(expected_target):
                raise fail()
            target_receipt = {'targetConfigurationSha256': sha(environment), 'targetSettingsSha256': sha(settings),
                              'destinationWitnessSha256': target['destinationWitnessSha256'],
                              'destinationConfigurationSha256': target['destinationConfigurationSha256'],
                              'targetDatabaseName': target['targetDatabaseName'], 'sessionPolicy': 'new-empty-cache-required'}
        receipt = {'schema': 'orbis.core-target-configuration-receipt.v1' if target is not None else 'orbis.core-source-configuration-receipt.v1', 'id': record['id'],
                   'sourceBasisSha256': self.digest(basis), 'sourceWitnessSha256': self.digest(witness),
                   'bindingSha256': self.digest(record['binding']), 'inputSha256': self.digest(request),
                   'resultSha256': sha(report_body), 'authenticationSha256': sha(auth),
                   'terminalSha256': self.digest(worker['terminal']), 'restoreAuthority': False, **target_receipt}
        receipt_sha = self.digest(receipt)
        if finalize:
            self.enrollment.immutable(directory / 'receipt.json', self.P.canonical(receipt))
            record.update(phase='complete', receiptSha256=receipt_sha)
            self.save(record)
        elif (record.get('receiptSha256') != receipt_sha or self.enrollment.read(directory / 'receipt.json', 16384) != self.P.canonical(receipt)):
            raise fail()
        prepared = PreparedTargetConfiguration if target is not None else PreparedConfiguration
        return prepared(record['id'], receipt_sha)
