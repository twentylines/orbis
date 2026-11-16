"""Root handoff to the installed clean-target worker, on three isolated copies.

This module has no RPC admission and grants no activation or restore authority.
The installation/runtime guard is supplied independently by the Root caller.
Interrupted writes are never replayed, reclaimed or silently treated as rolled back.
"""
import copy
from dataclasses import dataclass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import time
import uuid


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module


BOOTSTRAP = load('orbis-host-core-clean-target-bootstrap.py', 'orbis_reconcile_bootstrap')
TARGET, SUPERVISOR = BOOTSTRAP.TARGET, BOOTSTRAP.SUPERVISOR
SOURCE = SUPERVISOR.PROFILE
POLICIES = {'scope': 'prepare-clean-target-only', 'activation': False,
            'environmentProved': False, 'restoreAuthority': False}
SCHEMA = 'orbis.core-clean-target-reconcile-job.v1'


class ReconciliationError(ValueError):
    pass


def require(value):
    if not value:
        raise ReconciliationError('Clean target reconciliation requires protected review; evidence was preserved')


@dataclass(frozen=True)
class RootReconciliationApproval:
    """Programmatic Root decision; never construct from deserialized RPC input."""
    actor: dict
    source_inspection: object
    source_identifier: str
    destination_inspection: object
    destination_identifier: str
    bootstrap: object
    prepared_target: object
    binding: dict
    guard: object


@dataclass(frozen=True)
class ReconciledCleanTarget:
    identifier: str
    receipt_sha256: str


class CoreCleanTargetReconcile:
    schema = SCHEMA
    inspection_schema = 'orbis.core-restore-inspection.v3'
    root_intent_schema = 'orbis.core-clean-target-reconcile-root-intent.v1'
    receipt_schema = 'orbis.core-clean-target-reconcile-receipt.v1'

    @classmethod
    def from_inspections(cls, configuration_broker, source_inspection, source_identifier,
                         destination_inspection, destination_identifier, bootstrap, prepared_target,
                         actor, *, guard):
        """Authenticate actual completed inspectors, catalog and bootstrap under Root exclusion.

Catalog support is deliberately limited to genuinely completed local captures.
An unsupported, imported, missing or unretired point blocks the whole invocation.
"""
        require(callable(guard) and bootstrap.broker is configuration_broker
                and callable(getattr(bootstrap, '_checked', None)))
        actor = configuration_broker.enrollment.actor(actor)
        for inspection in (source_inspection, destination_inspection):
            require(inspection.configuration.enrollment is configuration_broker.enrollment
                    and inspection.enrollment is configuration_broker.enrollment
                    and inspection.schema == cls.inspection_schema
                    and callable(getattr(inspection, 'bootstrap_catalog', None)))
        require(source_identifier != destination_identifier)
        approval = RootReconciliationApproval(actor, source_inspection, source_identifier,
            destination_inspection, destination_identifier, bootstrap, prepared_target, {}, guard)
        instance = cls(configuration_broker, approval)
        with guard():
            binding = instance.current_binding()
        approval = RootReconciliationApproval(actor, source_inspection, source_identifier,
            destination_inspection, destination_identifier, bootstrap, prepared_target, binding, guard)
        return cls(configuration_broker, approval)

    def __init__(self, configuration_broker, approval):
        require(type(approval) is RootReconciliationApproval and callable(approval.guard))
        self.broker, self.approval = configuration_broker, approval
        self.enrollment = configuration_broker.enrollment
        self.a, self.P = self.enrollment.a, self.enrollment.P
        self.runtime, self.context = self.enrollment.runtime, self.enrollment.context
        self.approved = copy.deepcopy(approval.binding)

    def digest(self, value):
        return hashlib.sha256(self.P.canonical(value)).hexdigest()

    def read(self, path, maximum=65536):
        return self.approval.bootstrap.read(path, maximum)

    def identity(self, path):
        path = Path(path)
        require(path.is_absolute() and path.resolve(strict=True) == path)
        value = path.lstat()
        require(stat.S_ISDIR(value.st_mode))
        return {'path': str(path), **{k: getattr(value, 'st_' + k) for k in ('dev', 'ino', 'mode', 'uid', 'gid')}}

    def seals(self, directory, names):
        with self.a.protected_directory(directory) as descriptor:
            require(set(os.listdir(descriptor)) == set(names))
            return {name: list(self.a.seal(os.stat(name, dir_fd=descriptor, follow_symlinks=False))) for name in names}

    def endpoint(self, inspection, identifier):
        actor = self.approval.actor
        coordinator = self.coordinator_binding(inspection.configuration)
        # bootstrap_catalog also revalidates the original genuine capture and configuration.
        catalog = inspection.bootstrap_catalog(identifier, actor)
        record = inspection.record(identifier)
        require(record['actor'] == actor and record['phase'] == 'inspection-complete')
        directory = inspection.directory(identifier) / 'execution'
        report = SUPERVISOR.InspectionSupervisor(inspection, record).checked_completion(directory, record['evidence']['profile'])
        evidence = report['bootstrapSource']
        require(evidence.get('schema') == 'orbis.core-source-bootstrap-evidence.v2'
                and evidence['authenticationVerified'] is True and evidence['environmentProved'] is False
                and evidence['restoreAuthority'] is False and evidence['catalogSha256'] == catalog['catalogSha256']
                and evidence['systemIdentifier'] == catalog['systemIdentifier']
                and evidence['sourceOwnerId'] == actor['ownerId'])
        require(catalog['sourceControllerImageId'] == inspection.configuration.trust.source_controller_image_id)
        users = evidence.get('catalogUserIdentities')
        require(type(users) is list and 1 <= len(users) <= 250000)
        previous = 0
        for row in users:
            require(isinstance(row, dict) and set(row) == {'ownerId', 'identitySha256'}
                    and type(row['ownerId']) is int and previous < row['ownerId'] <= 2147483647
                    and isinstance(row['identitySha256'], str) and BOOTSTRAP.HEX.fullmatch(row['identitySha256']))
            previous = row['ownerId']
        require({'ownerId': actor['ownerId'], 'identitySha256': evidence['identitySha256']} in users)
        request = self.enrollment.json(directory / 'trusted-input/request.json', 16384)
        authentication_path = directory / 'trusted-input/source-authentication.json'
        authentication_details = authentication_path.lstat()
        require(stat.S_ISREG(authentication_details.st_mode) and authentication_details.st_uid == os.geteuid()
                and authentication_details.st_nlink == 1 and stat.S_IMODE(authentication_details.st_mode) in {0o400, 0o600})
        authentication_seal = list(self.a.seal(authentication_details))
        authentication = inspection.enrollment.read(authentication_path, 2 * 1024 ** 2)
        require(list(self.a.seal(authentication_path.lstat())) == authentication_seal)
        require(hashlib.sha256(authentication).hexdigest() == request['sourceAuthenticationSha256'])
        decoded = self.P.metadata(authentication, byte_limit=2 * 1024 ** 2, string_limit=2 * 1024 ** 2)
        require(isinstance(decoded, dict) and set(decoded) == {'jwtSecret', 'passkeys'}
                and self.P.canonical(decoded) == authentication)
        normalized = {'jwtSecret': decoded['jwtSecret']}
        if decoded['passkeys'] is not None:
            normalized['passkeys'] = decoded['passkeys']
        require(self.digest(normalized) == evidence['authenticationSha256'])
        profile = SOURCE.validate_profile(record['evidence']['profile'])
        directories = {name: self.identity(directory / name) for name in ('', 'pgdata', 'socket', 'config')}
        result = {'id': identifier, 'pointId': record['pointId'], 'directory': str(directory), 'profile': profile,
                'configuration': coordinator,
                'directories': directories, 'catalog': catalog, 'reportSha256': self.digest(report),
                'evidence': copy.deepcopy(evidence), 'request': {'role': request['role'], 'database': request['database'],
                    'snapshotSha256': evidence['sourceSha256'], 'authenticationSha256': request['sourceAuthenticationSha256']},
                'authenticationSeal': authentication_seal}
        return self.endpoint_binding(result, report, record)

    def endpoint_binding(self, result, report, record):
        return result

    def catalog(self):
        destination = self.enrollment.destination()
        result = []
        for identifier, expected in sorted(destination['catalog'].items()):
            require(TARGET.UUID.fullmatch(identifier))
            # Root's actual genuine-local reader verifies capture publication and retirement.
            basis = self.approval.source_inspection.source(identifier, self.approval.actor).basis()
            point_path = Path(destination['library']) / 'points' / identifier / 'point.json'
            body = self.enrollment.read(point_path, 32768)
            point = self.P.metadata(body, byte_limit=32768)
            require(expected == {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
                    and basis['pointId'] == identifier and basis['sourceAuthority'] is True
                    and basis['environmentProved'] is False and basis['restoreAuthority'] is False
                    and point['ownerId'] == basis['sourceOwnerId']
                    and type(point['ownerId']) is int and 1 <= point['ownerId'] <= 2147483647)
            result.append({'pointId': identifier, 'ownerId': point['ownerId'],
                           'pointSha256': expected['sha256'], 'sourceWitnessSha256': basis['sourceWitnessSha256']})
        require(self.enrollment.destination() == destination)
        return {'destination': destination, 'points': result}

    def current_binding(self, active=False):
        TARGET.require_root()
        require(self.a.OWNER == 0)
        coordinator = self.coordinator_binding(self.broker)
        configuration = coordinator['configuration']
        require('core-clean-target-worker.mjs' in configuration['inventory'])
        code = self.broker.trust.code_directory
        code_seals = self.seals(code, configuration['inventory'])
        source = self.endpoint(self.approval.source_inspection, self.approval.source_identifier)
        destination = self.endpoint(self.approval.destination_inspection, self.approval.destination_identifier)
        # Migrations and sequence policy qualify the authenticated historical source,
        # independently of the coordinator's current executing image or destination.
        require(source['catalog']['sourceControllerImageId']
                == self.approval.source_inspection.configuration.trust.source_controller_image_id
                == self.broker.trust.source_controller_image_id
                == self.approval.bootstrap.broker.trust.source_controller_image_id)
        for endpoint in (source, destination):
            qualified = endpoint['configuration']
            # Source qualification may differ; the executing coordinator generation may not.
            require(all(qualified[key] == coordinator[key] for key in ('installedRuntime', 'codeDirectory', 'codeSeals'))
                    and all(qualified['configuration'][key] == configuration[key] for key in ('imageId', 'architecture', 'inventory')))
        bootstrap = self.approval.bootstrap
        handle = self.approval.prepared_target
        if not active:
            require(bootstrap._checked(bootstrap.record(handle.identifier), self.approval.actor, finalize=False) == handle)
        else:
            bootstrap.validate(self.approval.actor)
        require(handle == self.approval.prepared_target)
        target_record = bootstrap.record(handle.identifier)
        target_directory = bootstrap.directory(handle.identifier) / 'target'
        receipt = bootstrap.read(bootstrap.directory(handle.identifier) / 'receipt.json', 65536)
        require(hashlib.sha256(receipt).hexdigest() == handle.receipt_sha256)
        original_supervisor = SUPERVISOR.InspectionSupervisor(bootstrap, target_record)
        for role in target_record['inspectionWorkers']:
            if role == 'migration-carrier':
                raw = original_supervisor.inspect(role)
                worker = target_record['inspectionWorkers'][role]
                require(worker['intent'] == 'created-never-start' and self.runtime.never_started(raw)
                        and self.runtime.definition(raw) == worker['definitionSha256'])
            else:
                self.settled(original_supervisor, role)
        TARGET.verify_workspace(TARGET.TargetWorkspace(target_directory, bootstrap.approved['profile'],
            target_record['workspace']['allocation'], target_record['workspace']['identities']), self.a)
        target = {'id': handle.identifier, 'receiptSha256': handle.receipt_sha256,
                  'recordSha256': self.digest(target_record),
                  'target': target_record['request']['target'], 'workspace': target_record['workspace'],
                  'directory': str(target_directory), 'profile': bootstrap.approved['profile']}
        require(source['catalog'] == bootstrap.approved['catalog']
                and source['evidence']['catalogSha256'] == destination['evidence']['catalogSha256'])
        catalog = self.catalog()
        before = {row['ownerId']: row['identitySha256'] for row in destination['evidence']['catalogUserIdentities']}
        after = {row['ownerId']: row['identitySha256'] for row in source['evidence']['catalogUserIdentities']}
        owners = sorted(set(before) | {row['ownerId'] for row in catalog['points']})
        require(len(owners) <= 4096 and all(owner in before and before[owner] == after.get(owner) for owner in owners))
        ownership = {'schema': 'orbis.core-catalog-ownership-compatibility.v1',
            'sourceSha256': source['request']['snapshotSha256'], 'destinationSha256': destination['request']['snapshotSha256'],
            'sourceOwnerId': self.approval.actor['ownerId'], 'destinationOwnerId': self.approval.actor['ownerId'],
            'owners': [{'ownerId': owner, 'identitySha256': before[owner]} for owner in owners],
            'aliases': False, 'restoreAuthority': False}
        roots = [source['directories']['pgdata'], destination['directories']['pgdata'],
                 self.identity(target_directory / 'pgdata')]
        require(len({(row['dev'], row['ino']) for row in roots}) == 3)
        paths = [Path(row['path']) for row in roots]
        require(all(not a.is_relative_to(b) for a in paths for b in paths if a != b))
        binding = {'configuration': configuration, 'codeDirectory': self.identity(code), 'codeSeals': code_seals,
                'installedRuntime': coordinator['installedRuntime'],
                'source': source, 'destination': destination, 'target': target, 'catalog': catalog,
                'ownership': ownership, 'catalogOwnerIds': owners}
        return self.versioned_binding(binding)

    def versioned_binding(self, binding):
        return binding

    def coordinator_binding(self, configuration):
        require(configuration.enrollment is self.enrollment)
        selected = getattr(configuration, 'installed_selection', None)
        installed = None
        if selected is not None:
            require(callable(getattr(configuration, 'installed_authority', None)))
            # This is the installed Root capability's own revocation/code-generation guard.
            # The separately supplied guard still owns installation/runtime writer exclusion.
            with configuration.installed_authority():
                configuration.image()
                binding = configuration.binding()
            installed = {'id': selected.identifier, 'installationSha256': selected.installation_sha256}
        else:
            # Explicit independently trusted standalone brokers remain supported only as
            # the very same capability; cross-release inputs require installed enrollment.
            require(configuration is self.broker)
            configuration.image()
            binding = configuration.binding()
        directory = configuration.trust.code_directory
        return {'configuration': binding, 'installedRuntime': installed, 'codeDirectory': self.identity(directory),
                'codeSeals': self.seals(directory, binding['inventory'])}

    def validate(self, actor, active=False):
        require(self.enrollment.actor(actor) == self.approval.actor
                and self.P.canonical(self.current_binding(active=active)) == self.P.canonical(self.approved))

    def source_controller_image(self):
        image = self.approved['source']['catalog']['sourceControllerImageId']
        require(isinstance(image, str) and BOOTSTRAP.IMAGE.fullmatch(image))
        return image

    def source_authentication(self, role):
        require(role in {'source', 'destination'})
        endpoint = self.approved[role]
        path = Path(endpoint['directory']) / 'trusted-input/source-authentication.json'
        with self.a.protected_directory(path.parent):
            details = path.lstat()
            require(stat.S_ISREG(details.st_mode) and details.st_uid == os.geteuid() and details.st_nlink == 1
                    and stat.S_IMODE(details.st_mode) in {0o400, 0o600}
                    and list(self.a.seal(details)) == endpoint['authenticationSeal'])
            body = self.enrollment.read(path, 2 * 1024 ** 2)
            require(hashlib.sha256(body).hexdigest() == endpoint['request']['authenticationSha256']
                    and list(self.a.seal(path.lstat())) == endpoint['authenticationSeal'])
            return body

    def directory(self, identifier, create=False):
        require(isinstance(identifier, str) and TARGET.UUID.fullmatch(identifier))
        base = self.enrollment.state / 'core-clean-target-reconciliations'
        if create:
            base = self.enrollment.child(self.enrollment.state, base.name)
        with self.a.protected_directory(base):
            pass
        path = base / identifier
        if create:
            path.mkdir(mode=0o700)
            self.enrollment.sync(base)
        with self.a.protected_directory(path):
            pass
        return path

    def save(self, record):
        self.a.atomic(self.directory(record['id']) / 'job.json', self.P.canonical(record))

    def record(self, identifier):
        record = self.enrollment.json(self.directory(identifier) / 'job.json', 4 * 1024 ** 2)
        require(record.get('schema') == self.schema and record.get('id') == identifier
                and record.get('root') == str(self.enrollment.root) and record.get('context') == self.context)
        return record

    def workspace(self):
        target = self.approved['target']
        return TARGET.TargetWorkspace(Path(target['directory']), target['profile'],
            target['workspace']['allocation'], target['workspace']['identities'])

    def database_body(self, record, role):
        if role == 'target-database':
            body = TARGET.database_body(self.workspace(), self.a)
        else:
            endpoint = self.approved[role.removesuffix('-database')]
            body = SOURCE.database_body(record['id'], self.digest(record['rootIntent']),
                                        Path(endpoint['directory']), endpoint['profile'])
        body['Labels'] = {**body['Labels'], 'io.orbis.core-reconciliation': record['id'],
                          'io.orbis.core-reconciliation.nonce': record['request']['nonce'],
                          'io.orbis.core-reconciliation.intent': self.digest(record['rootIntent']),
                          'io.orbis.core-reconciliation.role': role}
        return body

    def worker_body(self, record, verify=False):
        directory = self.directory(record['id'])
        input_name, output_name = ('verify-input', 'verify-output') if verify else ('input', 'output')
        mounts = [SOURCE.mount(self.broker.trust.code_directory, '/app/core-clean-target', True),
                  SOURCE.mount(directory / input_name, '/clean-target-' + input_name, True),
                  SOURCE.mount(directory / output_name, '/clean-target-' + output_name, False),
                  SOURCE.mount(Path(self.approved['target']['directory']) / 'socket', '/clean-target-target-socket', True)]
        if not verify:
            for role in ('source', 'destination'):
                mounts.append(SOURCE.mount(Path(self.approved[role]['directory']) / 'socket', '/clean-target-' + role + '-socket', True))
        body = TARGET.body(self.workspace(), 'verify' if verify else 'reconcile', 'node',
            ['/app/core-clean-target/core-clean-target-worker.mjs', '--verify-v2' if verify else '--prepare'], mounts)
        body.update(Image=self.broker.trust.image_id, User='0:' + str(self.approved['target']['profile']['gid']), WorkingDir='/app',
                    Env=['NODE_ENV=production', 'TMPDIR=/clean-target-' + output_name])
        body['Labels'] = {'io.orbis.core-reconciliation': record['id'], 'io.orbis.core-reconciliation.nonce': record['request']['nonce'],
                          'io.orbis.core-reconciliation.intent': self.digest(record['rootIntent']),
                          'io.orbis.core-reconciliation.role': 'verify' if verify else 'reconcile'}
        body['HostConfig']['LogConfig'] = {'Type': 'none', 'Config': {}}
        return body

    def socket_available(self, supervisor, role):
        endpoint = self.approved['target' if role in {'target-database', 'verify-database'} else role.removesuffix('-database')]
        deadline = time.monotonic() + 15
        while True:
            state = supervisor.inspect(role).get('State') or {}
            require(state.get('Status') == 'running' and state.get('Running') is True
                    and state.get('Restarting') is False and state.get('Paused') is False)
            try:
                details = (Path(endpoint['directory']) / 'socket/.s.PGSQL.5432').lstat()
            except FileNotFoundError:
                details = None
            if details is not None:
                require(stat.S_ISSOCK(details.st_mode) and details.st_uid == endpoint['profile']['uid']
                        and details.st_gid == endpoint['profile']['gid'] and stat.S_IMODE(details.st_mode) == 0o770)
                return
            require(time.monotonic() < deadline)
            time.sleep(0.1)

    def settled(self, supervisor, role, success=True):
        worker = supervisor.record['inspectionWorkers'][role]
        raw = supervisor.inspect(role)
        state, terminal = raw.get('State') or {}, worker.get('terminal') or {}
        require(worker.get('intent') == 'complete' and terminal == {'id': worker['id'],
            'definitionSha256': worker['definitionSha256'], 'state': state}
            and self.runtime.definition(raw) == worker['definitionSha256']
            and state.get('Status') == 'exited'
            and all(state.get(key) is False for key in ('Running', 'Restarting', 'Paused', 'Dead', 'OOMKilled'))
            and type(state.get('ExitCode')) is int and (not success or state['ExitCode'] == 0)
            and isinstance(state.get('FinishedAt'), str) and not state['FinishedAt'].startswith('0001-'))

    def stop(self, supervisor, role):
        worker = supervisor.record['inspectionWorkers'][role]
        state = supervisor.inspect(role).get('State') or {}
        require(state.get('Status') == 'running' and state.get('Running') is True and state.get('Restarting') is False)
        worker['intent'] = 'stopping'
        supervisor.save()
        self.runtime.change(['stop', '--time', '20', worker['id']])
        supervisor.wait(role, 45)
        self.settled(supervisor, role)

    def observe_interrupted_writer(self, supervisor):
        """Persist positive terminal observation; an exit code never decides commit state."""
        worker = supervisor.record['inspectionWorkers']['reconcile']
        if worker.get('intent') == 'complete':
            self.settled(supervisor, 'reconcile', success=False)
            return
        raw = supervisor.inspect('reconcile')
        state = raw.get('State') or {}
        require(self.runtime.definition(raw) == worker['definitionSha256']
                and state.get('Status') == 'exited'
                and all(state.get(key) is False for key in ('Running', 'Restarting', 'Paused', 'Dead', 'OOMKilled'))
                and type(state.get('ExitCode')) is int and isinstance(state.get('FinishedAt'), str)
                and not state['FinishedAt'].startswith('0001-'))
        observed = supervisor.inspect('reconcile')
        require(observed.get('State') == state and self.runtime.definition(observed) == worker['definitionSha256'])
        worker.update(intent='complete', terminal={'id': worker['id'], 'definitionSha256': worker['definitionSha256'],
                                                  'state': copy.deepcopy(state)})
        supervisor.save()

    def bound(self, record):
        request = record['request']
        return {key: request[key] for key in ('id', 'nonce', 'rootPreparationSha256', 'rootIntentSha256',
            'sourceControllerImageId', 'sequencePolicy')} | {'requestSha256': self.digest(request),
            'authorizationSha256': self.digest(record['authorization']), **POLICIES}

    def prepared(self, value, record):
        request = record['request']
        fields = {'schema', 'id', 'nonce', 'sourceIdentity', 'destinationIdentity', 'targetIdentity', 'sourceSha256',
            'destinationSha256', 'catalogSha256', 'authenticationSha256', 'sourceAccountsSha256', 'destinationAppsSha256',
            'destinationRecoverySha256', 'sourceOwnerId', 'destinationOwnerId', 'catalogOwnershipSha256',
            'catalogContext', 'major', 'environmentProved', 'restoreAuthority', 'marker', 'sequencePolicy'}
        require(isinstance(value, dict) and set(value) == fields)
        for key, expected in {'schema': 'orbis.core-clean-target-reconciliation.v2', 'id': request['id'], 'nonce': request['nonce'],
            'targetIdentity': request['target'], 'sourceSha256': request['source']['snapshotSha256'],
            'destinationSha256': request['destination']['snapshotSha256'], 'catalogSha256': request['expected']['catalogSha256'],
            'catalogOwnershipSha256': request['expected']['catalogOwnershipSha256'],
            'authenticationSha256': self.approved['source']['evidence']['authenticationSha256'],
            'sourceOwnerId': request['sourceOwnerId'], 'destinationOwnerId': request['destinationOwnerId'],
            'catalogContext': 'pg_catalog', 'major': self.reconciliation_major(), 'sequencePolicy': request['sequencePolicy'],
            'environmentProved': False, 'restoreAuthority': False}.items():
            require(self.P.canonical(value.get(key)) == self.P.canonical(expected))
        for role in ('source', 'destination'):
            identity = value[role + 'Identity']
            require(isinstance(identity, dict) and set(identity) == {'database', 'databaseOid', 'systemIdentifier'}
                    and identity['database'] == request[role]['database']
                    and identity['systemIdentifier'] == self.approved[role]['evidence']['systemIdentifier']
                    and BOOTSTRAP.CoreCleanTargetBootstrap.number(identity['databaseOid'], 4294967295)
                    and identity['systemIdentifier'] != request['target']['systemIdentifier'])
        for key in ('sourceAccountsSha256', 'destinationAppsSha256', 'destinationRecoverySha256'):
            require(isinstance(value[key], str) and BOOTSTRAP.HEX.fullmatch(value[key]))
        descriptor = {key: item for key, item in value.items() if key != 'marker'}
        require(value['marker'] == 'orbis.core-clean-target.v2/' + request['id'] + '/' + request['nonce'] + '/' + self.digest(descriptor))
        return value

    def output(self, record, *, intent_only=False, verify=False):
        directory = self.directory(record['id']) / ('verify-output' if verify else 'output')
        names = {'result.json'} if verify else {'worker-start.json', 'write-intent.json', 'completion.json', 'result.json'}
        if intent_only:
            require(not verify)
            names = {'write-intent.json'}
        with self.a.protected_directory(directory) as descriptor:
            actual = set(os.listdir(descriptor))
            require((names <= actual <= {'worker-start.json', 'write-intent.json', 'completion.json', 'result.json'}) if intent_only else actual == names)
        values, hashes = {}, {}
        for name in names:
            body = self.read(directory / name)
            value = self.P.metadata(body)
            require(body == self.P.canonical(value))
            values[name], hashes[name] = value, hashlib.sha256(body).hexdigest()
        bound = self.bound(record)
        for value in values.values():
            require(isinstance(value, dict) and all(self.P.canonical(value.get(key)) == self.P.canonical(item) for key, item in bound.items()))
        if verify:
            expected = {'schema': 'orbis.core-clean-target-verification-result.v2', **bound,
                'writeIntentSha256': record['writeIntentSha256'], 'prepared': record['prepared'],
                'targetVerified': True, 'databaseCommitObserved': True, 'serverQuiescenceProved': False}
            require(self.P.canonical(values['result.json']) == self.P.canonical(expected))
            return hashes
        intent = values['write-intent.json']
        require(set(intent) == {'schema', 'prepared'} | set(bound)
                and intent == {'schema': 'orbis.core-clean-target-write-intent.v2', **bound, 'prepared': self.prepared(intent['prepared'], record)})
        if intent_only:
            return intent['prepared'], hashes['write-intent.json']
        expected = {'worker-start.json': {'schema': 'orbis.core-clean-target-worker-start.v2', **bound},
                'completion.json': {'schema': 'orbis.core-clean-target-completion.v2', **bound,
                    'writeIntentSha256': hashes['write-intent.json'], 'preparedSha256': self.digest(intent['prepared']),
                    'databaseCommitAcknowledged': True, 'targetVerified': False},
                'result.json': {'schema': 'orbis.core-clean-target-worker-result.v2', **bound,
                    'writeIntentSha256': hashes['write-intent.json'], 'prepared': intent['prepared'],
                    'targetVerified': True, 'serverQuiescenceProved': False}}
        require(all(self.P.canonical(values[name]) == self.P.canonical(value) for name, value in expected.items()))
        return hashes

    def check_inputs(self, record, verify=False):
        directory = self.directory(record['id']) / ('verify-input' if verify else 'input')
        names = ('request.json', 'authorization.json', 'write-intent.json') if verify else (
            'request.json', 'authorization.json', 'source-authentication.json', 'destination-authentication.json')
        require(self.seals(directory, names) == record['verifyInputSeals' if verify else 'inputSeals'])
        expected = {'request.json': record['request'], 'authorization.json': record['authorization']}
        for name, value in expected.items():
            require(self.read(directory / name) == self.P.canonical(value))
        if verify:
            require(hashlib.sha256(self.read(directory / 'write-intent.json')).hexdigest() == record['writeIntentSha256'])
        else:
            for role in ('source', 'destination'):
                require(hashlib.sha256(self.read(directory / (role + '-authentication.json'), 2 * 1024 ** 2)).hexdigest()
                        == record['request'][role]['authenticationSha256'])

    def reconcile(self, identifier, actor):
        with self.approval.guard():
            self.validate(actor)
            directory = self.directory(identifier, create=True)
            nonce = str(uuid.uuid4())
            intent = {'schema': self.root_intent_schema, 'id': identifier,
                      'nonce': nonce, 'actor': self.approval.actor, 'binding': self.approved, **POLICIES}
            request = {'schema': 'orbis.core-clean-target-worker-input.v2', 'id': identifier, 'nonce': nonce,
                'rootPreparationSha256': self.approved['target']['receiptSha256'], 'rootIntentSha256': self.digest(intent),
                'source': self.approved['source']['request'], 'destination': self.approved['destination']['request'],
                'target': {key: self.approved['target']['target'][key] for key in ('systemIdentifier', 'databaseOid', 'database')},
                'targetRole': self.approved['target']['profile']['role'], 'sourceOwnerId': actor['ownerId'], 'destinationOwnerId': actor['ownerId'],
                'catalogOwnerIds': self.approved['catalogOwnerIds'], 'sourceControllerImageId': self.source_controller_image(),
                'sequencePolicy': {'schema': 'orbis.core-clean-target-sequence-policy.v2',
                    'sourceControllerImageId': self.source_controller_image(),
                    'catalogSha256': self.approved['source']['evidence']['catalogSha256']},
                'expected': {'catalogSha256': self.approved['source']['evidence']['catalogSha256'],
                    'migrationsSha256': self.approval.bootstrap.ledger_hash(self.approved['source']['catalog']['ledger']),
                    'catalogOwnershipSha256': self.digest(self.approved['ownership'])}, **POLICIES}
            authorization = {'schema': 'orbis.core-clean-target-authorization.v2', 'decision': 'approved',
                **{key: request[key] for key in ('id', 'nonce', 'rootPreparationSha256', 'rootIntentSha256', 'target', 'sourceControllerImageId', 'sequencePolicy')},
                'requestSha256': self.digest(request), 'sourceSha256': request['source']['snapshotSha256'],
                'destinationSha256': request['destination']['snapshotSha256'],
                'catalogOwnershipSha256': request['expected']['catalogOwnershipSha256'], **POLICIES}
            require(len(self.P.canonical(request)) <= 32768 and len(self.P.canonical(authorization)) <= 32768
                    and len(self.P.canonical(intent)) <= 2 * 1024 ** 2)
            record = {'schema': self.schema, 'id': identifier, 'actor': self.approval.actor, 'root': str(self.enrollment.root),
                'context': self.context, 'phase': 'allocating', 'rootIntent': intent, 'request': request,
                'authorization': authorization, **POLICIES}
            self.save(record)
            try:
                self.approval.bootstrap.publish(directory / 'root-intent.json', self.P.canonical(intent))
                for name in ('input', 'output'):
                    self.enrollment.child(directory, name)
                for name, value in (('request.json', request), ('authorization.json', authorization)):
                    self.approval.bootstrap.publish(directory / 'input' / name, self.P.canonical(value))
                for role in ('source', 'destination'):
                    self.approval.bootstrap.publish(directory / 'input' / (role + '-authentication.json'), self.source_authentication(role))
                record['inputSeals'] = self.seals(directory / 'input', ('request.json', 'authorization.json', 'source-authentication.json', 'destination-authentication.json'))
                record['directories'] = {name: self.identity(directory / name) for name in ('', 'input', 'output')}
                self.save(record)
                supervisor = SUPERVISOR.InspectionSupervisor(self, record)
                for role in ('source-database', 'destination-database', 'target-database'):
                    self.validate(actor, active=True)
                    self.approval.bootstrap.capacity(directory)
                    supervisor.create_start(role, self.database_body(record, role))
                    self.socket_available(supervisor, role)
                record['phase'] = 'writing'
                self.save(record)
                self.validate(actor, active=True)
                self.check_inputs(record)
                supervisor.create_start('reconcile', self.worker_body(record))
                supervisor.wait('reconcile', 330)
                self.settled(supervisor, 'reconcile')
                outputs = self.output(record)
                record['prepared'], record['writeIntentSha256'] = self.output(record, intent_only=True)
                for role in ('target-database', 'destination-database', 'source-database'):
                    self.stop(supervisor, role)
                return self.finish(record, outputs, recovered=False)
            except BaseException as error:
                record.update(phase='recovery-required', failureClass=type(error).__name__)
                self.save(record)
                raise ReconciliationError('Clean target reconciliation requires protected recovery review; no write was replayed') from None

    def finish(self, record, outputs, recovered):
        self.validate(record['actor'])
        self.check_record(record)
        supervisor = SUPERVISOR.InspectionSupervisor(self, record)
        for role in record['inspectionWorkers']:
            self.settled(supervisor, role, success=role != 'reconcile' or not recovered)
        record['outputSeals'] = self.seals(self.directory(record['id']) / ('verify-output' if recovered else 'output'), outputs)
        receipt = self.receipt(record, outputs, recovered)
        self.approval.bootstrap.publish(self.directory(record['id']) / 'receipt.json', self.P.canonical(receipt))
        record.update(phase='complete', receiptSha256=self.digest(receipt))
        self.save(record)
        return ReconciledCleanTarget(record['id'], record['receiptSha256'])

    def receipt(self, record, outputs, recovered):
        return {'schema': self.receipt_schema, 'id': record['id'],
            'rootIntentSha256': self.digest(record['rootIntent']), 'requestSha256': self.digest(record['request']),
            'preparedSha256': self.digest(record['prepared']), 'writeIntentSha256': record['writeIntentSha256'],
            'outputs': outputs, 'workersSha256': self.digest(record['inspectionWorkers']),
            'ownedWorkersSettled': True, 'targetVerified': True, 'recoveredByVerification': recovered, **POLICIES, **self.receipt_fields()}

    def reconciliation_major(self):
        return 17

    def receipt_fields(self):
        return {}

    def recover_committed(self, identifier, actor):
        """Verify the SAME target after Root has positively settled every prior worker.

No automatic stop, insert replay, directory cleanup or uncertain-writer takeover.
If a worker lacks a positive terminal receipt, recovery stays blocked.
"""
        with self.approval.guard():
            self.validate(actor)
            record = self.record(identifier)
            require(record['phase'] == 'recovery-required' and record['actor'] == actor)
            self.check_record(record)
            supervisor = SUPERVISOR.InspectionSupervisor(self, record)
            require(set(record.get('inspectionWorkers', {})) == {'source-database', 'destination-database', 'target-database', 'reconcile'})
            # No worker is stopped here. The writer must already be conclusively exited.
            self.observe_interrupted_writer(supervisor)
            for role in record['inspectionWorkers']:
                self.settled(supervisor, role, success=role != 'reconcile')
            record['prepared'], record['writeIntentSha256'] = self.output(record, intent_only=True)
            directory = self.directory(identifier)
            # mkdir is intentionally exclusive: an interrupted verification is never replayed.
            for name in ('verify-input', 'verify-output'):
                (directory / name).mkdir(mode=0o700)
                self.enrollment.sync(directory)
            for name in ('request.json', 'authorization.json'):
                self.approval.bootstrap.publish(directory / 'verify-input' / name, self.read(directory / 'input' / name))
            self.approval.bootstrap.publish(directory / 'verify-input/write-intent.json', self.read(directory / 'output/write-intent.json'))
            record['verifyInputSeals'] = self.seals(directory / 'verify-input', ('request.json', 'authorization.json', 'write-intent.json'))
            record['verifyDirectories'] = {name: self.identity(directory / name) for name in ('verify-input', 'verify-output')}
            record['phase'] = 'verifying-commit'
            self.save(record)
            try:
                supervisor.create_start('verify-database', self.database_body(record, 'target-database'))
                # Same target profile and transport; the new owned DB has a distinct worker id.
                self.socket_available(supervisor, 'verify-database')
                self.check_inputs(record, verify=True)
                supervisor.create_start('verify', self.worker_body(record, verify=True))
                supervisor.wait('verify', 330)
                self.settled(supervisor, 'verify')
                outputs = self.output(record, verify=True)
                self.stop(supervisor, 'verify-database')
                return self.finish(record, outputs, recovered=True)
            except BaseException as error:
                record.update(phase='recovery-required', failureClass=type(error).__name__)
                self.save(record)
                raise ReconciliationError('Committed target verification requires protected review; no preparation was replayed') from None

    def check_record(self, record):
        intent = record['rootIntent']
        require(intent == {'schema': self.root_intent_schema, 'id': record['id'],
            'nonce': record['request']['nonce'], 'actor': self.approval.actor, 'binding': self.approved, **POLICIES}
            and self.read(self.directory(record['id']) / 'root-intent.json', 4 * 1024 ** 2) == self.P.canonical(intent)
            and all(record.get(key) == value for key, value in POLICIES.items()))
        request = record['request']
        require(set(request) == {'schema', 'id', 'nonce', 'rootPreparationSha256', 'rootIntentSha256', 'source', 'destination',
            'target', 'targetRole', 'sourceOwnerId', 'destinationOwnerId', 'catalogOwnerIds', 'sourceControllerImageId',
            'sequencePolicy', 'expected', *POLICIES}
            and request['schema'] == 'orbis.core-clean-target-worker-input.v2'
            and request['id'] == record['id'] and TARGET.UUID.fullmatch(request['nonce'])
            and request['rootIntentSha256'] == self.digest(intent)
            and request['rootPreparationSha256'] == self.approved['target']['receiptSha256']
            and request['source'] == self.approved['source']['request'] and request['destination'] == self.approved['destination']['request']
            and request['sourceOwnerId'] == request['destinationOwnerId'] == self.approval.actor['ownerId']
            and request['catalogOwnerIds'] == self.approved['catalogOwnerIds']
            and request['target'] == {key: self.approved['target']['target'][key] for key in ('systemIdentifier', 'databaseOid', 'database')}
            and request['targetRole'] == self.approved['target']['profile']['role']
            and request['sourceControllerImageId'] == self.source_controller_image()
            and request['sequencePolicy'] == {'schema': 'orbis.core-clean-target-sequence-policy.v2',
                'sourceControllerImageId': self.source_controller_image(),
                'catalogSha256': self.approved['source']['evidence']['catalogSha256']}
            and request['expected'] == {'catalogSha256': self.approved['source']['evidence']['catalogSha256'],
                'migrationsSha256': self.approval.bootstrap.ledger_hash(self.approved['source']['catalog']['ledger']),
                'catalogOwnershipSha256': self.digest(self.approved['ownership'])}
            and all(request.get(key) is value if type(value) is bool else request.get(key) == value for key, value in POLICIES.items()))
        authorization = {'schema': 'orbis.core-clean-target-authorization.v2', 'decision': 'approved',
            **{key: request[key] for key in ('id', 'nonce', 'rootPreparationSha256', 'rootIntentSha256', 'target', 'sourceControllerImageId', 'sequencePolicy')},
            'requestSha256': self.digest(request), 'sourceSha256': request['source']['snapshotSha256'],
            'destinationSha256': request['destination']['snapshotSha256'],
            'catalogOwnershipSha256': request['expected']['catalogOwnershipSha256'], **POLICIES}
        require(self.P.canonical(record['authorization']) == self.P.canonical(authorization))
        for name, identity in record['directories'].items():
            require(self.identity(self.directory(record['id']) / name) == identity)
        self.check_inputs(record)
        if 'verifyInputSeals' in record:
            self.check_inputs(record, verify=True)
            for name, identity in record['verifyDirectories'].items():
                require(self.identity(self.directory(record['id']) / name) == identity)
        for role, worker in record.get('inspectionWorkers', {}).items():
            expected = self.worker_body(record, verify=role == 'verify') if role in {'reconcile', 'verify'} else self.database_body(record, 'target-database' if role == 'verify-database' else role)
            require(worker['body'] == expected)

    def checked(self, prepared, actor):
        require(type(prepared) is ReconciledCleanTarget)
        with self.approval.guard():
            self.validate(actor)
            record = self.record(prepared.identifier)
            require(record['phase'] == 'complete' and record['actor'] == actor and record['receiptSha256'] == prepared.receipt_sha256)
            self.check_record(record)
            supervisor = SUPERVISOR.InspectionSupervisor(self, record)
            for role in record['inspectionWorkers']:
                self.settled(supervisor, role, success=role != 'reconcile' or 'verify' not in record['inspectionWorkers'])
            receipt = self.P.metadata(self.read(self.directory(record['id']) / 'receipt.json'))
            outputs = self.output(record, verify=receipt['recoveredByVerification'])
            require(self.seals(self.directory(record['id']) / ('verify-output' if receipt['recoveredByVerification'] else 'output'), outputs) == record['outputSeals']
                    and receipt == self.receipt(record, outputs, receipt['recoveredByVerification'])
                    and self.digest(receipt) == prepared.receipt_sha256
                    and receipt['outputs'] == outputs and receipt['workersSha256'] == self.digest(record['inspectionWorkers'])
                    and receipt['preparedSha256'] == self.digest(record['prepared'])
                    and receipt['requestSha256'] == self.digest(record['request'])
                    and receipt['writeIntentSha256'] == record['writeIntentSha256'])
            return prepared


class CoreVersionedCleanTargetReconcile(CoreCleanTargetReconcile):
    """Same-profile Root binding around the existing same-major worker protocol2."""
    schema = 'orbis.core-clean-target-reconcile-job.v2'
    inspection_schema = 'orbis.core-restore-inspection.v4'
    root_intent_schema = 'orbis.core-clean-target-reconcile-root-intent.v2'
    receipt_schema = 'orbis.core-clean-target-reconcile-receipt.v2'

    def endpoint_binding(self, result, report, record):
        profile = SOURCE.validate_profile(result['profile'])
        catalog = result['catalog']
        require(record['schema'] == self.inspection_schema and record['sandboxProfile'] == SOURCE.EXECUTION_SCHEMA
                and profile['schema'] == SOURCE.EXECUTION_SCHEMA
                and report['schema'] == 'orbis.core-inspection-worker-result.v4'
                and report['executionProfile'] == profile['profileId']
                and catalog['schema'] == 'orbis.core-root-authenticated-bootstrap-source.v2'
                and catalog['executionProfile'] == profile)
        observation = SUPERVISOR.validate_database_execution(profile,
            {'database': result['request']['database']}, report['databaseExecution'])
        require(observation == catalog['databaseExecution'])
        return {**result, 'databaseExecution': copy.deepcopy(observation)}

    def versioned_binding(self, binding):
        bootstrap = self.approval.bootstrap
        require(getattr(bootstrap, 'schema', None) == BOOTSTRAP.CoreVersionedCleanTargetBootstrap.schema
                and getattr(bootstrap, 'worker_version', None) == 2)
        target = TARGET.validate_profile(binding['target']['profile'])
        require(target['schema'] == TARGET.BOUNDED_SCHEMA
                and binding['configuration']['architecture'] == target['architecture']
                and binding['target']['target'].get('role') == target['role']
                and binding['target']['target'].get('database') == target['database']
                and binding['target']['target'].get('locale') == target['locale'])
        for role in ('source', 'destination'):
            endpoint = binding[role]
            profile = SOURCE.validate_profile(endpoint['profile'])
            require(profile['schema'] == SOURCE.EXECUTION_SCHEMA
                    and all(profile[key] == target[key] for key in SOURCE.PG.BASE_FIELDS)
                    and endpoint['catalog']['executionProfile'] == profile
                    and endpoint['catalog']['schema'] == 'orbis.core-root-authenticated-bootstrap-source.v2')
            observation = SUPERVISOR.validate_database_execution(profile,
                {'database': endpoint['request']['database']}, endpoint['databaseExecution'])
            require(observation == endpoint['catalog']['databaseExecution'] and observation['locale'] == target['locale'])
        return {**binding, 'executionProfile': target['profileId']}

    def validate(self, actor, active=False):
        require(self.versioned_binding(self.approved) == self.approved)
        return super().validate(actor, active=active)

    def reconciliation_major(self):
        return self.approved['target']['profile']['major']

    def receipt_fields(self):
        return {'executionProfile': self.approved['target']['profile']['profileId']}
