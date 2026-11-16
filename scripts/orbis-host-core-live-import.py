"""Import a held live-derived target into a separate marked database.

The Root live capability owns the outage and original database fence. This
stage grants no activation authority and never replays an uncertain mutation.
"""
import copy
from dataclasses import dataclass
import hashlib
import importlib.util
import ipaddress
import os
from pathlib import Path
import sys
import uuid


_spec = importlib.util.spec_from_file_location('orbis_live_import_primitives', Path(__file__).with_name('orbis-host-core-restoration.py'))
BASE = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = BASE
_spec.loader.exec_module(BASE)
require, quote, literal = BASE.require, BASE.quote, BASE.literal
SCHEMA = 'orbis.core-live-derived-logical-stage.v1'
VERIFIED = 'orbis.core-live-imported-database-verification.v1'
BINDING = BASE.BINDING
FLAGS = {'scope': 'core-live-derived-logical-stage-only', 'activation': False, 'restoreAuthority': False,
    'environmentProved': False, 'sourceWrites': False, 'liveDestinationProved': False,
    'destinationEvidence': 'live-held-derived'}
CLAIM = 'orbis.core-live-import-claim.v1'
HEX = BASE.HEX
DESCRIPTOR_FIELDS = frozenset({'schema', 'id', 'nonce', 'liveJobId', 'liveAdmissionSha256', 'liveHeldStageSha256',
    'preparedSha256', 'sourceControllerImageId', 'installedRuntime', 'migrationPolicySha256', 'currentSnapshotSha256',
    'currentDatabase', 'server', 'dump', 'targetProfile', 'databaseName', 'databaseRole', 'network', *FLAGS})


@dataclass(frozen=True)
class ImportedLiveCoreStage:
    identifier: str
    stage_sha256: str
    receipt_sha256: str


class CoreLiveDerivedLogicalStage(BASE.CoreDerivedLogicalStage):
    def __init__(self, service):
        self.service = service
        self.live = service.core_live_restorations()
        self.L = service.core_live_restoration_module
        require(type(self.live) is self.L.CoreLiveRestorationService and self.live.service is service)
        self.runtime = self.live._graph()
        self.enrollment, self.P = self.live.enrollment, self.live.P
        self.C, self.TARGET, self.SOURCE = self.live.C, self.live.TARGET, self.live.SOURCE

    def _directory(self, identifier):
        self.live._identifier(identifier)
        return Path(self.enrollment.state) / 'core-live-derived-logical-stages' / identifier

    def read(self, identifier):
        body = self.enrollment.read(self._directory(identifier) / 'stage.json', 4 * 1024 ** 2)
        value = self.P.metadata(body, byte_limit=4 * 1024 ** 2, string_limit=2 * 1024 ** 2)
        require(body == self.P.canonical(value) and value.get('schema') == SCHEMA and value.get('id') == identifier
            and value.get('root') == str(self.enrollment.root) and value.get('context') == self.enrollment.context
            and all(type(value.get(key)) is type(expected) and value.get(key) == expected for key, expected in FLAGS.items())
            and type(value.get('workers')) is dict and len(value['workers']) <= 4
            and set(value['workers']) <= {'database', 'dump', 'import', 'verify-imported'}
            and type(value.get('operations')) is list and len(value['operations']) <= 2)
        self.live._identifier(value['liveJobId'])
        return value

    def _checked(self, checked, record=None):
        require(self.service.core_live_restorations() is self.live and self.service.core_live_restoration_module is self.L
            and type(checked) is self.L.CheckedLiveRestoration and checked.owner is self.live
            and checked.record['id'] == checked.admission['id'] == checked.stage['id']
            and checked.record['admissionSha256'] == self.digest(checked.admission)
            and checked.record['stageSha256'] == self.digest(checked.stage)
            and checked.stage['admissionSha256'] == checked.record['admissionSha256']
            and checked.stage['target'] == checked.admission['evidence']['target']
            and checked.stage['admissionReopened'] is False
            and checked.stage['destinationEvidence'] == 'live-held-derived')
        if record is not None:
            require(record['liveJobId'] == checked.record['id'] and record['actor'] == checked.admission['actor']
                and record['liveAdmissionSha256'] == checked.record['admissionSha256']
                and record['liveHeldStageSha256'] == checked.record['stageSha256']
                and record['prepared'] == checked.stage['prepared']
                and record['claim'] == self._claim(record['id'], checked))

    def _claim(self, identifier, checked):
        return {'schema': CLAIM, 'liveJobId': checked.record['id'],
            'liveAdmissionSha256': checked.record['admissionSha256'], 'stageId': identifier}

    def _descriptor(self, record):
        descriptor = {key: record[key] for key in DESCRIPTOR_FIELDS if key != 'preparedSha256'}
        descriptor['preparedSha256'] = self.digest(record['prepared'])
        return descriptor

    def _sealed_descriptor(self, record):
        body = self.enrollment.read(self._directory(record['id']) / 'descriptor.json', 65536)
        require(body == self.P.canonical(self._descriptor(record)) and hashlib.sha256(body).hexdigest() == record['stageSha256'])
        require(record['databaseMarker'] == 'orbis.core-derived-logical.v1/' + record['id'] + '/' + record['nonce'] + '/' + record['stageSha256'])
        return body

    def _authentication(self, record, body):
        auth = self.P.metadata(body, byte_limit=2 * 1024 ** 2)
        require(body == self.P.canonical(auth) and self.P.exact(auth, {'jwtSecret', 'passkeys'}))
        normalized = {'jwtSecret': auth['jwtSecret']}
        if auth['passkeys'] is not None:
            normalized['passkeys'] = auth['passkeys']
        require(self.digest(normalized) == record['prepared']['authenticationSha256'])

    def _sql_command(self, record, query):
        require(len(record['operations']) < 2 and all(row['intent'] == 'complete' for row in record['operations']))
        operation = {'querySha256': hashlib.sha256(query.encode()).hexdigest(), 'intent': 'executing'}
        record['operations'].append(operation)
        self.save(record)
        super()._sql_command(record, query)
        operation['intent'] = 'complete'
        self.save(record)

    def _worker(self, record, role):
        raw = super()._worker(record, role)
        networks = raw.get('NetworkSettings', {}).get('Networks') or {}
        require(set(networks) == ({record['network']['name']} if role in {'import', 'verify-imported'} else {'none'}))
        return raw

    def _wait(self, record, role, timeout):
        super()._wait(record, role, timeout)
        state = self._worker(record, role)['State']
        require(type(state.get('Pid')) is int and state['Pid'] == 0
                and record['workers'][role]['terminal'] == state)

    def _body(self, *args, **kwargs):
        body = super()._body(*args, **kwargs)
        body['Labels']['io.orbis.core-live-import'] = args[0]['liveJobId']
        return body

    def _network(self, record):
        current = self._current_database(record)
        expected = record['network']
        endpoint = current['NetworkSettings']['Networks'].get(expected['name']) or {}
        require(endpoint.get('NetworkID') == expected['id'] and endpoint.get('IPAddress') == expected['address'])
        raw = self.runtime.reader._object(['network', 'inspect', '--format', '{{json .}}', expected['id']])
        require(raw.get('Id') == expected['id'] and raw.get('Name') == expected['name']
            and raw.get('Driver') == 'bridge' and raw.get('Scope') == 'local'
            and type(raw.get('Internal')) is bool and raw.get('Ingress') in {None, False})

    def _broker(self, checked):
        self.live._check_broker(checked.admission)
        intent = checked.admission['evidence']['preparationIntent']
        inspection, _, _, _, _ = self.live.preparation._source(intent['sourceInspectionId'], checked.admission['actor'], intent,
            enrollment=self.enrollment)
        broker = inspection.configuration
        require(broker.binding() == checked.admission['evidence']['broker']['configuration']
            and 'core-restoration-worker.mjs' in broker.code())
        return broker

    def prepare(self, identifier, live_job_id, actor):
        self.live._identifier(identifier)
        require(identifier != live_job_id)
        directory = self._directory(identifier)
        require(not directory.exists() and not directory.is_symlink())
        record = None
        with self.live._checked_stage(live_job_id, actor) as checked:
            self._checked(checked)
            with checked.guard():
                self._broker(checked)
                evidence = checked.admission['evidence']
                target = evidence['target']
                current = checked.record['originalDatabase']
                profile = self.TARGET.validate_profile(target['profile'])
                current_profile = copy.deepcopy(checked.record['databaseProfile'])
                require(all(profile[key] == current_profile[key] for key in self.SOURCE.PG.BASE_FIELDS))
                connection_body = self.enrollment.read(self.live._directory(live_job_id) / 'private/connection.json', 2 * 1024 ** 2)
                require(hashlib.sha256(connection_body).hexdigest() == evidence['connectionSha256'])
                connection = self.P.metadata(connection_body, byte_limit=2 * 1024 ** 2)
                require(connection_body == self.P.canonical(connection)
                    and self.P.exact(connection, {'host', 'port', 'user', 'password', 'database'})
                    and connection['database'] == checked.record['databaseName'] and connection['user'] == checked.record['databaseRole']
                    and type(connection['password']) is str and 1 <= len(connection['password'].encode()) <= 4096
                    and all(char not in connection['password'] for char in '\r\n\0') and connection['port'] == 5432
                    and type(connection['host']) is str and str(ipaddress.IPv4Address(connection['host'])) == connection['host'])
                require(BASE.NAME.fullmatch(connection['user']) and connection['host'] == checked.record['network']['address'])
                authentication = self.enrollment.read(self.live._directory(live_job_id) / 'private/source-authentication.json', 2 * 1024 ** 2)
                require(hashlib.sha256(authentication).hexdigest() == evidence['sourceAuthenticationSha256'])
                claim = checked.claim(identifier)
                require(claim == self._claim(identifier, checked))
                base = self.enrollment.child(Path(self.enrollment.state), directory.parent.name)
                self.enrollment.sync(Path(self.enrollment.state))
                directory.mkdir(mode=0o700)
                self.enrollment.sync(base)
                for child in ('dump', 'private', 'verification', 'tool-data'):
                    self.enrollment.child(directory, child)
                intent = evidence['preparationIntent']
                record = {'schema': SCHEMA, 'id': identifier, 'liveJobId': live_job_id, 'root': str(self.enrollment.root),
                    'context': self.enrollment.context, 'actor': copy.deepcopy(actor), 'nonce': str(uuid.uuid4()), 'phase': 'dumping',
                    'liveAdmissionSha256': checked.record['admissionSha256'], 'liveHeldStageSha256': checked.record['stageSha256'],
                    'claim': claim, 'prepared': copy.deepcopy(checked.stage['prepared']),
                    'sourceControllerImageId': intent['installedRuntime']['sourceControllerImageId'],
                    'installedRuntime': copy.deepcopy(intent['installedRuntime']), 'migrationPolicySha256': intent['migrationPolicySha256'],
                    'currentSnapshotSha256': self.digest(evidence['sourceSnapshot']), 'targetDirectory': target['directory'],
                    'targetProfile': profile, 'workspace': copy.deepcopy(target['workspace']),
                    'currentDatabase': {'id': current['id'], 'definition': current['definition'], 'startedAt': current['startedAt']},
                    'currentProfile': current_profile, 'databaseRole': connection['user'], 'databaseName': 'orbis_restore_' + identifier.replace('-', ''),
                    'network': {key: checked.record['network'][key] for key in ('name', 'id', 'address')},
                    'workers': {}, 'operations': [], **FLAGS}
                self.save(record)
                try:
                    self._checked(checked, record)
                    self._authentication(record, authentication)
                    self.enrollment.immutable(directory / 'private/authentication.json', authentication)
                    self.enrollment.immutable(directory / 'private/connection.json', self.P.canonical({**connection, 'database': record['databaseName']}))
                    password = connection['password'].replace('\\', '\\\\').replace(':', '\\:')
                    self.enrollment.immutable(directory / 'private/pgpass', (connection['host'] + ':5432:' + record['databaseName'] + ':'
                        + record['databaseRole'] + ':' + password + '\n').encode())
                    self._network(record)
                    self._export(record)
                    record['server'] = self._facts(record)
                    descriptor = self._descriptor(record)
                    self.enrollment.immutable(directory / 'descriptor.json', self.P.canonical(descriptor))
                    record['stageSha256'] = self.digest(descriptor)
                    record['databaseMarker'] = 'orbis.core-derived-logical.v1/' + identifier + '/' + record['nonce'] + '/' + record['stageSha256']
                    self.save(record)
                    self._create_database(record)
                    self._network(record)
                    self._import(record)
                    record['phase'] = 'awaiting-verification'
                    self.save(record)
                    binding = self.binding_for(record)
                except BaseException:
                    record['phase'] = 'recovery-required'
                    self.save(record)
                    raise
        return binding

    def binding_for(self, record):
        self._sealed_descriptor(record)
        return super().binding_for(record)

    def binding(self, identifier, actor):
        record = self.read(identifier)
        require(record['actor'] == actor and record['phase'] in {'awaiting-verification', 'staged'})
        with self.live._checked_stage(record['liveJobId'], actor) as checked:
            self._checked(checked, record)
            with checked.guard():
                require(self.live._read(record['liveJobId'], 'import-claim.json') == record['claim'])
                self._network(record)
                return self.binding_for(record)

    def verify_imported(self, identifier, actor):
        record = self.read(identifier)
        require(record['actor'] == actor and record['phase'] == 'awaiting-verification'
            and all(row['intent'] == 'complete' for row in record['operations']))
        with self.live._checked_stage(record['liveJobId'], actor) as checked:
            self._checked(checked, record)
            with checked.guard():
                require(self.live._read(record['liveJobId'], 'import-claim.json') == record['claim'])
                broker = self._broker(checked)
                self._network(record)
                binding = self.binding_for(record)
                require(self._seal_dump(self._directory(identifier) / 'dump/target.dump') == record['dump'])
                input_dir = self.enrollment.child(self._directory(identifier), 'verify-input')
                for name in ('authentication.json', 'connection.json'):
                    self.enrollment.immutable(input_dir / name, self.enrollment.read(self._directory(identifier) / 'private' / name, 2 * 1024 ** 2))
                authentication = self.enrollment.read(input_dir / 'authentication.json', 2 * 1024 ** 2)
                require(hashlib.sha256(authentication).hexdigest() == checked.admission['evidence']['sourceAuthenticationSha256'])
                self._authentication(record, authentication)
                self.enrollment.immutable(input_dir / 'descriptor.json', self._sealed_descriptor(record))
                request = {'schema': 'orbis.core-live-imported-database-worker-input.v1', 'binding': binding,
                    'prepared': record['prepared'], 'authenticationSha256': hashlib.sha256(authentication).hexdigest()}
                self.enrollment.immutable(input_dir / 'request.json', self.P.canonical(request))
                seals = self.live._seals(input_dir, {'authentication.json', 'connection.json', 'descriptor.json', 'request.json'})
                mounts = [self.SOURCE.mount(broker.trust.code_directory, '/app/core-restoration-code', True),
                    self.SOURCE.mount(input_dir, '/core-restoration-input', True),
                    self.SOURCE.mount(self._directory(identifier) / 'verification', '/core-restoration-output', False)]
                body = self._body(record, 'verify-imported', broker.trust.image_id, 'node',
                    ['/app/core-restoration-code/core-restoration-worker.mjs', '--verify-live-imported'], mounts,
                    network=record['network']['name'], environment=['NODE_ENV=production', 'TMPDIR=/core-restoration-output'])
                body['Labels']['io.orbis.core-import.stage'] = record['stageSha256']
                record['phase'] = 'verifying-import'
                self.save(record)
                try:
                    self._start(record, 'verify-imported', body)
                    self._wait(record, 'verify-imported', 180)
                    require(self.binding_for(record) == binding)
                    require(self.live._seals(input_dir, set(seals)) == seals)
                    output_dir = self._directory(identifier) / 'verification'
                    output_seals = self.live._seals(output_dir, {'result.json'}, output=True)
                    value_body = self.enrollment.read(output_dir / 'result.json', 65536)
                    expected = {**binding, 'schema': VERIFIED, 'liveJobId': record['liveJobId'],
                        'liveAdmissionSha256': record['liveAdmissionSha256'], 'liveHeldStageSha256': record['liveHeldStageSha256'],
                        'logicalTargetVerified': True, 'environmentProved': False, 'restoreAuthority': False, 'activation': False}
                    require(value_body == self.P.canonical(expected)
                        and self.live._seals(output_dir, {'result.json'}, output=True) == output_seals
                        and self._seal_dump(self._directory(identifier) / 'dump/target.dump') == record['dump'])
                    self.enrollment.immutable(self._directory(identifier) / 'verification-receipt.json', value_body)
                    record.update(phase='staged', verificationSha256=hashlib.sha256(value_body).hexdigest(), verificationSeals=output_seals)
                    self.save(record)
                except BaseException:
                    record['phase'] = 'recovery-required'
                    self.save(record)
                    raise
        return ImportedLiveCoreStage(identifier, record['stageSha256'], record['verificationSha256'])

    def assert_settled_for_abort(self, live_job_id, claim, actor):
        """Read-only worker custody check; caller already owns the live lock."""
        require(type(claim) is dict and self.P.exact(claim, {'schema', 'liveJobId', 'liveAdmissionSha256', 'stageId'})
            and claim['schema'] == CLAIM and claim['liveJobId'] == live_job_id)
        record = self.read(claim['stageId'])
        require(record['claim'] == claim and record['liveJobId'] == live_job_id and record['actor'] == actor
            and record['liveAdmissionSha256'] == claim['liveAdmissionSha256']
            and all(row.get('intent') == 'complete' for row in record['operations']))
        require(self.live._read(live_job_id, 'import-claim.json') == claim
            and self.digest(self.live._admission(live_job_id, actor)) == record['liveAdmissionSha256']
            and self.digest(self.live._read(live_job_id, 'live-held-stage.json')) == record['liveHeldStageSha256'])
        require(bool(record['workers']) and all(worker.get('intent') in {'created', 'running', 'waiting', 'complete'}
            and worker.get('definition') for worker in record['workers'].values()))
        self._sealed_descriptor(record)
        require(self._seal_dump(self._directory(record['id']) / 'dump/target.dump') == record['dump'])
        for role, worker in record['workers'].items():
            require(worker.get('intent') in {'created', 'running', 'waiting', 'complete'} and worker.get('definition'))
            raw = self._worker(record, role)
            state = raw.get('State') or {}
            require(type(state.get('Pid')) is int and state['Pid'] == 0
                and all(state.get(key) is False for key in ('Running', 'Restarting', 'Paused', 'Dead', 'OOMKilled')))
            if worker['intent'] == 'created':
                require(self.runtime.never_started(raw))
            else:
                require(state.get('Status') == 'exited' and type(state.get('ExitCode')) is int
                    and type(state.get('FinishedAt')) is str and not state['FinishedAt'].startswith('0001-')
                    and bool(state['FinishedAt']))
                if worker['intent'] == 'complete':
                    require(worker.get('terminal') == state)
        return True
