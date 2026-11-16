"""Real protected journals and Root lifecycle; Docker, PostgreSQL and parser are fixtures."""
import copy
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module


L = load('orbis-host-core-live-restoration.py', 'live_restoration_test_subject')
F = load('test_orbis_host_core_restoration_review.py', 'live_restoration_review_fixture')
ID = 'af12a54b-0084-437e-b6a7-12040c52d72e'
TARGET = 'af12a54b-0084-437e-b6a7-12040c52d72f'
NONCE = 'af12a54b-0084-437e-b6a7-12040c52d730'
ACTOR = F.F.ACTOR


class Workers:
    def __init__(self):
        self.jobs = []

    def __call__(self, **values):
        self.jobs.append(values)
        return self

    def start(self):
        pass

    def run(self):
        job = self.jobs[-1]
        job['target'](*job['args'])


class LiveRestorationTests(unittest.TestCase):
    def setUp(self):
        task_temp = Path(os.environ['TMPDIR']).parent / 'core-live-lifecycle-20261112.nosync' / 'tmp'
        task_temp.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.enterContext(mock.patch.object(tempfile, 'tempdir', str(task_temp)))
        real_seals = F.F.F.M.CoreCleanTargetReconcile.seals
        def fixture_code_seals(manager, directory, names):
            result = real_seals(manager, directory, names)
            if Path(directory).name == 'code':
                # This file is synthetic installed code. macOS changes its ctime
                # asynchronously; code qualification is a fixture boundary here.
                # Production live journals and output seals keep every stat field.
                for row in result.values():
                    row[-1] = 0
            return result
        self.enterContext(mock.patch.object(F.F.F.M.CoreCleanTargetReconcile, 'seals', fixture_code_seals))
        self.fixture = f = F.RestorationReviewTests()
        f.setUp()
        self.addCleanup(f.doCleanups)
        self.service, self.runtime, self.enrollment = f.service, f.runtime, f.enrollment
        self.service.core_restoration_reviews = lambda: f.review
        self.service.core_restoration_review_module = F.V
        self.service.HOST.CORE_LIVE_TRANSACTION = ContextVar('live-test-transaction', default=None)
        self.service.HOST.restore_selector_path = lambda root: root / 'live-selector.json'
        f.raw['State'].update(Status='running', Pid=123, Dead=False, OOMKilled=False)
        f.raw['HostConfig']['RestartPolicy'] = {'Name': 'unless-stopped', 'MaximumRetryCount': 0}
        self.network_id = 'a' * 64
        self.network_name = 'runtipi-network'
        f.raw['NetworkSettings']['Networks'] = {self.network_name: {'NetworkID': self.network_id, 'IPAddress': '172.22.0.3'}}
        self.data = self.enrollment.child(self.enrollment.root, 'current-config')
        self.enrollment.child(self.data, 'state')
        self.enrollment.child(self.data / 'state', 'auth')
        self.enrollment.immutable(self.data / '.env', b'JWT_SECRET="file value with ordinary dotenv quoting"\n')
        f.raw['Mounts'] = [{'Type': 'bind', 'Source': str(self.data), 'Destination': '/data', 'RW': True}]
        f.raw['Config']['Env'] = ['JWT_SECRET=container-value-is-overridden-by-file', 'POSTGRES_USERNAME=tipi',
                                 'POSTGRES_DBNAME=orbis', 'POSTGRES_PASSWORD=synthetic-password']
        # The review and reconciliation graph are genuine production classes.
        f.perform()
        self.workers = Workers()
        self.live = L.CoreLiveRestorationService(self.service, worker_factory=self.workers)
        self.strict_review = f.review._checked_review
        @contextmanager
        def fixture_review(identifier, actor):
            # Repeated upstream qualification is synthetic. The strict admission
            # test below restores the genuine method; all live seals stay real.
            self.assertEqual(identifier, F.ID)
            self.assertEqual(actor, ACTOR)
            owner = f.reconciliation
            with owner._operation() as guard:
                admission = owner._admission(F.F.ID, actor)
                intent = owner._intent(admission)
                completion = owner._read(F.F.ID, 'complete.json')
                handle = f.review.C.R.ReconciledCleanTarget(F.F.ID, completion['receiptSha256'])
                checked = f.review.C.CheckedReconciliation(owner, f.fixture.fixture.manager, handle,
                    admission, intent, completion, guard)
                observation = f.review._observation(f.review._admission(F.ID, actor))
                yield F.V.CheckedRestorationReview(f.review, checked, observation, guard)
        self.enterContext(mock.patch.object(f.review, '_checked_review', fixture_review))
        self.live._check_broker = mock.Mock()  # Upstream generation qualification is synthetic.
        self.live._check_authentication = mock.Mock()  # Separately exercised real parser-projection custody below.
        self.live._socket = mock.Mock()  # Docker transport is synthetic; never native authority.
        self.admit_request = {'id': ID, 'reviewId': F.ID, 'targetPreparationId': TARGET, 'actor': copy.deepcopy(ACTOR), 'action': L.ADMIT}
        self.observe = {'id': ID, 'actor': copy.deepcopy(ACTOR)}
        self.calls, self.containers, self.counter = [], {}, 100
        self.mode = 'success'
        self.database_id = 'c' * 64
        self.database = {'Id': self.database_id, 'Image': L.CoreLiveRestorationService.__name__, 'Name': '/runtipi-db',
            'Config': {'Env': ['POSTGRES_USER=tipi', 'POSTGRES_DB=orbis', 'POSTGRES_PASSWORD=synthetic-password'],
                       'Labels': {'com.docker.compose.project': 'runtipi', 'com.docker.compose.service': 'runtipi-db',
                                  'com.docker.compose.project.working_dir': str(self.enrollment.root)}},
            'HostConfig': {'Privileged': False, 'AutoRemove': False}, 'Mounts': [],
            'NetworkSettings': {'Networks': {self.network_name: {'NetworkID': self.network_id, 'IPAddress': '172.22.0.2', 'Aliases': ['runtipi-db']}}},
            'State': {'Status': 'running', 'Running': True, 'Restarting': False, 'Paused': False, 'Dead': False,
                      'OOMKilled': False, 'StartedAt': 'database-original-start'}}
        self.profile = self.live.SOURCE.PG.execution_image_profile(self.runtime.image(self.live.SOURCE.PG.PG14_AMD64_IMAGE))
        self.database['Image'] = self.profile['imageId']
        self.facts = {'systemIdentifier': '300', 'database': 'orbis', 'databaseOid': '16384', 'role': 'tipi', 'roleOid': '10',
                      'serverVersionNum': 140023, 'postmasterEpochUs': '1794484401258726', 'allowConnections': True}
        self.runtime.inspect = mock.Mock(side_effect=self.inspect)
        self.runtime.engine = mock.Mock(side_effect=self.engine)
        self.runtime.change = mock.Mock(side_effect=self.change)
        self.runtime.bounded_output = mock.Mock(side_effect=self.output)
        self.runtime.never_started = lambda raw: raw['State']['Status'] == 'created'
        self.real_definition = self.runtime.definition
        self.runtime.definition = self.definition
        self.runtime.check_intent = self.check_intent
        self.runtime.validate_overlay = mock.Mock(side_effect=lambda record: self.live._worker(record, 'responder'))
        self.runtime.overlay_body = lambda record: self.body(record, 'responder', network=self.network_name)
        self.runtime.bootstrap_queue_binding = lambda record: {'id': 'e' * 64, 'generation': 'fixture-queue'}
        self.runtime.bootstrap_queues_quiet = mock.Mock(side_effect=self.queue_quiet)
        self.runtime.verify_networks = lambda record, raw: L.require(set(raw['NetworkSettings']['Networks']) == {self.network_name})
        self.runtime.require_reset_authority = mock.Mock()
        self.runtime.reader._object.side_effect = self.reader
        self.proof = mock.Mock(side_effect=self.make_proof)
        self.live._proof = self.proof
        self.preparation = self.live.preparation
        self.broker = type('BoundBroker', (), {})()
        self.broker.installed_authority = self.installed_authority
        self.broker.binding = lambda: self.evidence['broker']['configuration']
        previous_preparation = self.preparation._checked_preparation
        self.enterContext(mock.patch.object(self.preparation, '_checked_preparation', side_effect=lambda identifier, *args:
            type('Prepared', (), {'manager': type('Manager', (), {'broker': self.broker})()})()
            if identifier == TARGET else previous_preparation(identifier, *args)))
        self.enterContext(mock.patch.object(self.live.TARGET, 'verify_workspace'))
        self.live._auxiliary_body = lambda record, admission, role: self.body(record, role)
        self.addCleanup(self.assert_no_live_process)

    @contextmanager
    def installed_authority(self):
        yield

    def assert_no_live_process(self):
        self.assertTrue(all(call[0] in {'create', 'start', 'stop', 'update', 'sql', 'wait', 'probe'} for call in self.calls))

    def reader(self, args):
        if args[0] == 'info':
            return {'ID': 'synthetic-daemon'}
        return {'Id': self.network_id, 'Name': self.network_name, 'Driver': 'bridge', 'Scope': 'local', 'Internal': False}

    def definition(self, raw):
        if raw['Id'] == self.fixture.raw['Id']:
            return self.real_definition(raw)
        if raw['Id'] == self.database_id:
            return 'd' * 64
        if raw['Id'] in self.containers:
            return hashlib.sha256(self.enrollment.P.canonical(raw['definitionBody'])).hexdigest()
        return self.real_definition(raw)

    def inspect(self, identifier):
        if identifier in {'runtipi', self.fixture.raw['Id']}:
            return copy.deepcopy(self.fixture.raw)
        if identifier in {'runtipi-db', self.database_id}:
            return copy.deepcopy(self.database)
        if identifier in self.containers:
            return copy.deepcopy(self.containers[identifier])
        return self.fixture.old_runtime.inspect(identifier)

    def check_intent(self, raw, body):
        if raw['Id'] not in self.containers:
            return self.fixture.old_runtime.check_intent(raw, body)
        expected = copy.deepcopy(raw['actualBody'])
        expected['HostConfig']['RestartPolicy'] = raw['HostConfig'].get('RestartPolicy')
        L.require(expected == body)

    def body(self, record, role, network='none'):
        return {'Image': 'sha256:' + '1' * 64, 'User': '0:0', 'Entrypoint': ['node'], 'Cmd': [role], 'Env': [], 'WorkingDir': '/app',
            'Labels': {'role': role}, 'Healthcheck': {'Test': ['NONE']},
            'HostConfig': self.live.SOURCE.host({'pids': 64, 'memory': 512 * 1024 ** 2}) | {'NetworkMode': network, 'Mounts': []},
            'NetworkingConfig': {'EndpointsConfig': {network: {}}}}

    def make_proof(self, identifier, checked, target, actor):
        self.assertIs(type(checked), F.V.CheckedRestorationReview)
        self.assertIs(checked.owner, self.fixture.review)
        source = copy.deepcopy(checked.reconciliation.manager.approved['source'])
        target_endpoint = copy.deepcopy(checked.reconciliation.manager.approved['target'])
        target_endpoint['id'] = target
        target_endpoint['target']['systemIdentifier'] = '200'
        # Separate empty PGDATA allocation boundary; no populated saved target is reused.
        fresh = self.enrollment.child(self.enrollment.root, 'fresh-live-target')
        for name in ('pgdata', 'socket', 'config'):
            self.enrollment.child(fresh, name)
        target_endpoint['directory'] = str(fresh)
        target_endpoint['profile'] = target_endpoint['profile'] | {'role': 'tipi', 'database': 'orbis'}
        target_endpoint['target']['database'] = 'orbis'
        source['configuration']['configuration']['codeDirectory'] = source['directory']
        broker = copy.deepcopy(source['configuration'])
        broker['configuration']['codeDirectory'] = source['directory']
        snapshot = copy.deepcopy(checked.record['snapshot'])
        current = {'originalDatabase': {'id': self.database_id, 'imageId': self.database['Image'], 'definition': 'd' * 64,
            'startedAt': self.database['State']['StartedAt'], 'mounts': [], 'networks': {self.network_name: self.network_id}},
            'databaseProfile': self.profile, 'databaseRole': 'tipi', 'databaseName': 'orbis',
            'network': {'name': self.network_name, 'id': self.network_id, 'address': '172.22.0.2', 'driver': 'bridge', 'scope': 'local', 'internal': False},
            'databaseFacts': self.facts | {'allowConnections': True}}
        auth = self.enrollment.P.canonical({'jwtSecret': 'synthetic source authentication ' * 2, 'passkeys': None})
        connection = self.enrollment.P.canonical({'host': '172.22.0.2', 'port': 5432, 'user': 'tipi', 'password': 'synthetic-password', 'database': 'orbis'})
        intent = copy.deepcopy(checked.reconciliation.intent)
        intent['sourceInspectionId'] = F.F.SOURCE
        evidence = {'review': copy.deepcopy(checked.record), 'preparationIntent': intent, 'source': source, 'target': target_endpoint,
            'broker': broker, 'catalog': {}, 'ownership': copy.deepcopy(checked.reconciliation.manager.approved['ownership']),
            'catalogOwnerIds': [1], 'migrationsSha256': 'b' * 64, 'sourceSnapshot': snapshot,
            'queueBinding': {'id': 'e' * 64, 'generation': 'fixture-queue'},
            'originalRestartPolicy': copy.deepcopy(snapshot['container']['HostConfig']['RestartPolicy']), 'current': current,
            'connectionSha256': hashlib.sha256(connection).hexdigest(), 'sourceAuthenticationSha256': hashlib.sha256(auth).hexdigest(),
            'destinationAuthenticationSha256': hashlib.sha256(auth).hexdigest()}
        self.evidence = copy.deepcopy(evidence)
        return evidence, {'connection.json': connection, 'source-authentication.json': auth, 'destination-authentication.json': auth}

    def engine(self, method, route, body):
        self.calls.append(('create', copy.deepcopy(body)))
        if self.mode == 'lost-create' and body['Labels'].get('io.orbis.core-live.role') == 'live-worker':
            raise TimeoutError('synthetic create reply lost')
        self.counter += 1
        identifier = f'{self.counter:064x}'
        networks = {name: {'NetworkID': self.network_id} if name == self.network_name else {} for name in body['NetworkingConfig']['EndpointsConfig']}
        self.containers[identifier] = {'Id': identifier, 'Image': body['Image'], 'Name': '/' + route.split('name=')[1],
            'Config': {'Healthcheck': {'Test': ['NONE']}}, 'HostConfig': copy.deepcopy(body['HostConfig']),
            'NetworkSettings': {'Networks': networks}, 'actualBody': copy.deepcopy(body), 'definitionBody': copy.deepcopy(body),
            'State': {'Status': 'created', 'Running': False, 'Restarting': False, 'Paused': False, 'Dead': False, 'OOMKilled': False,
                'Pid': 0, 'ExitCode': 0, 'FinishedAt': '0001-01-01T00:00:00Z'}}
        return self.enrollment.P.canonical({'Id': identifier})

    def change(self, args):
        self.calls.append(tuple(args))
        raw = self.fixture.raw if args[-1] == self.fixture.raw['Id'] else self.containers[args[-1]]
        if args[0] == 'update':
            policy = args[args.index('--restart') + 1]
            raw['HostConfig']['RestartPolicy'] = {'Name': policy, 'MaximumRetryCount': 0}
        elif args[0] == 'start':
            raw['State'].update(Status='running', Running=True, Pid=123)
            if raw is self.fixture.raw:
                raw['State']['Health'] = {'Status': 'healthy'}
            elif raw['actualBody']['Labels'].get('io.orbis.core-live.role') == 'live-worker':
                self.publish_live(raw)
            elif raw['actualBody']['Labels'].get('io.orbis.core-live.role') == 'authentication':
                self.publish_auth(raw)
        elif args[0] == 'stop':
            raw['State'].update(Status='exited', Running=False, Pid=0, FinishedAt='2026-11-12T00:00:01Z')
        else:
            raise AssertionError(args)

    def queue_quiet(self, record):
        if self.mode == 'busy-queue':
            raise ValueError('synthetic queue is busy')

    def output(self, args, maximum, timeout):
        if 'wait' in args:
            self.calls.append(('wait', args[-1]))
            raw = self.containers[args[-1]]
            role = raw['actualBody']['Labels'].get('io.orbis.core-live.role')
            raw['State'].update(Status='exited', Running=False, Pid=0, FinishedAt='2026-11-12T00:00:01Z')
            if self.mode == 'failed-exit' and role == 'live-worker':
                raw['State']['ExitCode'] = 1
                return b'1\n'
            return b'0\n'
        if '-Atqc' in args:
            query = args[-1]
            self.calls.append(('sql', query))
            if query.startswith('ALTER DATABASE '):
                self.facts['allowConnections'] = True
                return b'{"changed":true}'
            if 'pg_control_system()' in query:
                return self.enrollment.P.canonical(self.facts)
            if 'pg_locks' in query and self.mode == 'startup-lock':
                return b'{"count":1}'
            if 'pg_stat_activity' in query and self.mode == 'unknown-client':
                return b'{"count":1}'
            if 'pg_prepared_xacts' in query and self.mode == 'prepared-xact':
                return b'{"count":1}'
            return b'{"count":0}'
        self.calls.append(('probe', args[-1]))
        return b'ok'

    def write(self, directory, name, value):
        self.enrollment.immutable(directory / name, self.enrollment.P.canonical(value))
        (directory / name).chmod(0o400)

    def publish_live(self, raw):
        mounts = {item['Target']: Path(item['Source']) for item in raw['actualBody']['HostConfig']['Mounts']}
        directory, inputs = mounts['/core-live-output'], mounts['/core-live-input']
        request, authorization = (json.loads((inputs / name).read_bytes()) for name in ('request.json', 'authorization.json'))
        bound = {'id': request['id'], 'nonce': request['nonce'], 'requestSha256': self.live.digest(request),
                 'authorizationSha256': self.live.digest(authorization), 'rootIntentSha256': request['rootIntentSha256'], **L.WORKER_FLAGS}
        identity = request['destination']['identity']
        fence = {'schema': 'orbis.core-live-database-fence.v1', 'id': request['id'], 'nonce': request['nonce'],
            'rootIntentSha256': request['rootIntentSha256'], 'identity': identity, 'livePid': '90', 'maintenancePid': '91',
            'originalAllowConnections': True, 'startedAt': '1794484401.258726'}
        fence_wrapper = {'schema': 'orbis.core-live-reconciliation-fence-intent.v1', **bound, 'fence': fence}
        descriptor = {'schema': 'orbis.core-clean-target-reconciliation.v2', 'id': request['id'], 'nonce': request['nonce'],
            'sourceIdentity': {'systemIdentifier': '100', 'databaseOid': '16384', 'database': request['source']['database']},
            'destinationIdentity': {key: identity[key] for key in ('systemIdentifier', 'databaseOid', 'database')},
            'targetIdentity': request['target']['identity'], 'sourceSha256': request['source']['snapshotSha256'],
            'destinationSha256': '8' * 64, 'catalogSha256': request['expected']['catalogSha256'],
            'sourceAccountsSha256': '7' * 64, 'destinationAppsSha256': '6' * 64, 'destinationRecoverySha256': '5' * 64,
            'sourceOwnerId': 1, 'destinationOwnerId': 1, 'catalogContext': 'pg_catalog', 'major': 14,
            'sequencePolicy': request['sequencePolicy'], 'environmentProved': False, 'restoreAuthority': False,
            'authenticationSha256': self.live.digest({'jwtSecret': 'synthetic source authentication ' * 2})}
        ownership = {'schema': 'orbis.core-catalog-ownership-compatibility.v1', 'sourceSha256': descriptor['sourceSha256'],
            'destinationSha256': descriptor['destinationSha256'], **{key: request['expected']['catalogOwnership'][key] for key in
                ('sourceOwnerId', 'destinationOwnerId', 'owners', 'aliases', 'restoreAuthority')}}
        descriptor['catalogOwnershipSha256'] = self.live.digest(ownership)
        prepared = descriptor | {'marker': 'orbis.core-clean-target.v2/' + request['id'] + '/' + request['nonce'] + '/' + self.live.digest(descriptor)}
        evidence = {'schema': 'orbis.core-live-target-reconciliation.v1', 'id': request['id'], 'nonce': request['nonce'],
            'rootIntentSha256': request['rootIntentSha256'], 'fenceIntentSha256': self.live.digest(fence),
            'preparedSha256': self.live.digest(prepared), 'destinationSha256': prepared['destinationSha256'], 'destinationEvidence': 'held-live-database', **L.FLAGS}
        intent = {'schema': 'orbis.core-live-reconciliation-write-intent.v1', **bound, 'fenceIntentSha256': self.live.digest(fence_wrapper),
            'prepared': prepared, 'evidence': evidence}
        result = {'schema': 'orbis.core-live-reconciliation-result.v1', **bound, 'fenceIntentSha256': self.live.digest(fence_wrapper),
            'writeIntentSha256': self.live.digest(intent), 'prepared': prepared, 'evidence': evidence,
            'targetVerified': True, 'admissionReopened': False, 'rootMustVerifyRetiredFence': True}
        if self.mode == 'bad-result':
            result['activation'] = True
        values = {'worker-start.json': {'schema': 'orbis.core-live-reconciliation-start.v1', **bound}, 'fence-intent.json': fence_wrapper,
            'write-intent.json': intent, 'completion.json': {'schema': 'orbis.core-live-reconciliation-completion.v1', **bound,
                'writeIntentSha256': self.live.digest(intent), 'preparedSha256': self.live.digest(prepared),
                'databaseCommitAcknowledged': True, 'targetVerified': False}, 'result.json': result}
        for name, value in values.items():
            self.write(directory, name, value)
        self.facts['allowConnections'] = False

    def publish_auth(self, raw):
        mounts = {item['Target']: Path(item['Source']) for item in raw['actualBody']['HostConfig']['Mounts']}
        inputs, outputs = mounts['/source-configuration-input'], mounts['/source-configuration-output']
        request = json.loads((inputs / 'request.json').read_bytes())
        auth = {'jwtSecret': 'fixture exact parser file overrides environment', 'passkeys': None}
        database = {'host': 'runtipi-db', 'port': 5432, 'user': 'tipi', 'password': 'synthetic-password', 'database': 'orbis'}
        projection = {'schema': 'orbis.core-live-authentication-projection.v1', **{key: request[key] for key in
            ('parserProfile', 'liveSnapshotSha256', 'publicationSha256', 'controllerId', 'controllerImageId', 'configurationSha256',
             'controllerEnvironmentSha256', 'databaseEnvironmentSha256', 'passkeysSha256')},
            'authenticationSha256': self.live.digest(auth), 'databaseSha256': self.live.digest(database),
            'basis': 'current-controller-configuration-candidate', **L.FLAGS}
        result = {'schema': 'orbis.core-live-authentication-result.v1', 'id': request['id'], 'nonce': request['nonce'],
            'inputSha256': self.live.digest(request), 'projection': projection, 'restoreAuthority': False}
        for name, value in (('authentication.json', auth), ('database.json', database), ('result.json', result)):
            self.write(outputs, name, value)

    def admit(self):
        return self.live.admit(self.admit_request, privileged_peer=True)

    def finish(self):
        self.admit()
        self.live.begin(self.observe | {'action': L.BEGIN}, privileged_peer=True)
        self.workers.run()
        return self.live.status(self.observe, privileged_peer=True)

    def test_admission_uses_genuine_checked_review_and_publishes_exact_shared_marker(self):
        self.enterContext(mock.patch.object(self.fixture.review, '_checked_review', self.strict_review))
        result = self.admit()
        self.assertEqual(result['phase'], 'admitted')
        self.assertEqual(json.loads(self.live._marker_path().read_bytes()), self.live._marker_value(ID))
        self.assertEqual(self.proof.call_count, 1)
        self.assertEqual(self.live.status(self.observe, privileged_peer=True), result)
        self.assertEqual(self.admit(), result)
        self.assertFalse(any(call[0] in {'create', 'start', 'stop', 'update', 'sql'} for call in self.calls))

    def test_complete_root_lifecycle_holds_original_and_emits_distinct_live_stage(self):
        result = self.finish()
        self.assertEqual(result['phase'], 'awaiting-import')
        self.assertTrue(result['readyForImport'])
        self.assertFalse(self.facts['allowConnections'])
        self.assertFalse(self.fixture.raw['State']['Running'])
        stage = self.live._read(ID, 'live-held-stage.json')
        self.assertEqual(stage['destinationEvidence'], 'live-held-derived')
        self.assertEqual(self.proof.call_count, 2)
        self.assertEqual(set(result), {'version', 'id', 'reviewId', 'targetPreparationId', 'phase', 'active', 'readyForImport', *L.FLAGS})
        for private in ('password', str(self.enrollment.root), 'Snapshot', 'sha256', 'actor'):
            self.assertNotIn(private, json.dumps(result))
        record = self.live._record(ID)
        self.assertTrue(all(operation['state'] == 'acknowledged' for operation in record['operations']))
        self.assertEqual(self.live.maintenance(), {'state': 'recovery'})
        self.assertTrue(self.live._marker_path().exists())
        self.assertTrue(all(result[flag] is False for flag in L.FLAGS))

    def test_explicit_abort_reopens_exact_original_only_after_retired_quiescence(self):
        self.finish()
        result = self.live.abort(self.observe | {'action': L.ABORT}, privileged_peer=True)
        self.assertEqual(result['phase'], 'aborted')
        self.assertTrue(self.facts['allowConnections'])
        self.assertTrue(self.fixture.raw['State']['Running'])
        self.assertEqual(self.fixture.raw['HostConfig']['RestartPolicy'], {'Name': 'unless-stopped', 'MaximumRetryCount': 0})
        self.assertFalse(self.live._marker_path().exists())
        self.assertEqual(self.live.maintenance(), {'state': 'idle'})
        self.assertEqual(self.live.abort(self.observe | {'action': L.ABORT}, privileged_peer=True), result)
        self.assertTrue((self.live._directory(ID) / 'live-held-stage.json').exists())
        operations = [item['name'] for item in self.live._record(ID)['operations']]
        self.assertLess(operations.index('abort-open-original-admission'), operations.index('abort-start-original'))

    def test_abort_before_downtime_preserves_original_and_requires_no_sql_mutation(self):
        self.admit()
        result = self.live.abort(self.observe | {'action': L.ABORT}, privileged_peer=True)
        self.assertEqual(result['phase'], 'aborted')
        self.assertFalse(any(call[0] in {'start', 'stop', 'update'} for call in self.calls))
        self.assertTrue(self.facts['allowConnections'])

    def test_queue_independently_busy_refuses_downtime(self):
        self.mode = 'busy-queue'
        result = self.finish()
        self.assertEqual(result['phase'], 'recovery-required')
        self.assertTrue(self.fixture.raw['State']['Running'])
        self.assertFalse(any(call[0] in {'start', 'stop', 'update'} for call in self.calls))

    def test_failed_exit_result_presence_cannot_authorize_stage(self):
        self.mode = 'failed-exit'
        result = self.finish()
        self.assertEqual(result['phase'], 'recovery-required')
        self.assertFalse(result['readyForImport'])
        self.assertTrue((self.live._directory(ID) / 'output/result.json').exists())
        self.assertFalse((self.live._directory(ID) / 'live-held-stage.json').exists())
        self.assertFalse(self.facts['allowConnections'])

    def test_exact_output_validation_rejects_true_activation(self):
        self.mode = 'bad-result'
        self.assertEqual(self.finish()['phase'], 'recovery-required')
        self.assertFalse((self.live._directory(ID) / 'live-held-stage.json').exists())

    def isolated_rejection(self, mode):
        self.mode = mode
        self.assertEqual(self.finish()['phase'], 'recovery-required')
        with self.assertRaises(ValueError):
            self.live.abort(self.observe | {'action': L.ABORT}, privileged_peer=True)
        self.assertFalse(self.facts['allowConnections'])
        self.assertTrue(self.live._marker_path().exists())

    def test_independent_startup_lock_blocks_stage_and_abort(self):
        self.isolated_rejection('startup-lock')

    def test_independent_unknown_client_blocks_stage_and_abort(self):
        self.isolated_rejection('unknown-client')

    def test_independent_prepared_transaction_blocks_stage_and_abort(self):
        self.isolated_rejection('prepared-xact')

    def test_lost_create_reply_stays_recovery_no_replay_or_reopen(self):
        self.mode = 'lost-create'
        self.assertEqual(self.finish()['phase'], 'recovery-required')
        before = copy.deepcopy(self.calls)
        self.live.resume_pending()
        self.live.begin(self.observe | {'action': L.BEGIN}, privileged_peer=True)
        self.assertEqual(self.calls, before)
        with self.assertRaises(ValueError):
            self.live.abort(self.observe | {'action': L.ABORT}, privileged_peer=True)
        self.assertTrue(self.live._marker_path().exists())

    def test_absent_marker_with_durable_job_never_goes_idle(self):
        self.admit()
        self.live._marker_path().unlink()
        self.assertEqual(self.live.resume_pending(), {'state': 'recovery'})
        self.assertEqual(self.live.status(self.observe, privileged_peer=True)['phase'], 'recovery-required')

    def test_exact_actor_request_action_and_id_guards(self):
        for value, peer in ((self.admit_request, False), (self.admit_request | {'action': 'activate'}, True),
                (self.admit_request | {'queueDrained': True}, True), (self.admit_request | {'id': '../escape'}, True)):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.live.admit(value, privileged_peer=peer)
        self.admit()
        with self.assertRaises(ValueError):
            self.live.status(self.observe | {'actor': ACTOR | {'sessionBinding': 'f' * 64}}, privileged_peer=True)
        with self.assertRaises(ValueError):
            self.live.admit(self.admit_request | {'targetPreparationId': NONCE}, privileged_peer=True)

    def test_worker_body_is_bounded_fixed_input_output_and_no_docker_socket(self):
        self.finish()
        body = self.live._record(ID)['workers']['live-worker']['body']
        self.assertEqual(body['HostConfig']['Memory'], 512 * 1024 ** 2)
        self.assertEqual(body['HostConfig']['CapDrop'], ['ALL'])
        self.assertTrue(body['HostConfig']['ReadonlyRootfs'])
        self.assertFalse(body['HostConfig']['PortBindings'])
        mounts = body['HostConfig']['Mounts']
        self.assertEqual([item['Target'] for item in mounts if not item['ReadOnly']], ['/core-live-output'])
        self.assertEqual({item['Target'] for item in mounts}, {'/app/core-live-code', '/core-live-input', '/core-live-output',
            '/core-live-source-socket', '/core-live-target-socket'})
        self.assertEqual(body['HostConfig']['NetworkMode'], self.network_id)

    def test_replaced_identical_output_inode_invalidates_ready_stage(self):
        self.finish()
        path = self.live._directory(ID) / 'output/result.json'
        body = path.read_bytes()
        path.unlink()
        self.enrollment.immutable(path, body)
        path.chmod(0o400)
        self.assertEqual(self.live.status(self.observe, privileged_peer=True)['phase'], 'recovery-required')

    def test_postmaster_restart_requires_explicit_abort_independent_identity(self):
        self.finish()
        self.database['State']['StartedAt'] = 'database-restarted'
        self.facts['postmasterEpochUs'] = '1794484402258726'
        self.assertEqual(self.live.status(self.observe, privileged_peer=True)['phase'], 'recovery-required')
        result = self.live.abort(self.observe | {'action': L.ABORT}, privileged_peer=True)
        self.assertEqual(result['phase'], 'aborted')
        self.assertTrue(self.facts['allowConnections'])

    def test_wrong_original_system_id_blocks_abort_reopen(self):
        self.finish()
        self.facts['systemIdentifier'] = '999'
        with self.assertRaises(ValueError):
            self.live.abort(self.observe | {'action': L.ABORT}, privileged_peer=True)
        self.assertFalse(self.facts['allowConnections'])

    def test_real_auth_projection_journal_and_outputs_bind_file_override_and_normal_bridge(self):
        snapshot = self.runtime.source_snapshot()
        broker = {'configuration': {'imageId': 'sha256:' + '1' * 64, 'codeDirectory': str(self.enrollment.root)}}
        record, connection, authentication, binding = self.live._current_material(ID, snapshot, self.profile, broker)
        self.assertFalse(record['network']['internal'])
        self.assertEqual(json.loads(connection)['host'], '172.22.0.2')
        self.assertEqual(json.loads(authentication)['jwtSecret'], 'fixture exact parser file overrides environment')
        self.assertEqual(binding['projection']['configurationSha256'], hashlib.sha256((self.data / '.env').read_bytes()).hexdigest())
        calls = copy.deepcopy(self.calls)
        self.assertEqual(self.live._current_material(ID, snapshot, self.profile, broker)[3], binding)
        self.assertEqual([call for call in self.calls if call[0] in {'create', 'start'}],
                         [call for call in calls if call[0] in {'create', 'start'}])

    def test_live_file_drift_does_not_replay_existing_auth_projection(self):
        snapshot = self.runtime.source_snapshot()
        broker = {'configuration': {'imageId': 'sha256:' + '1' * 64, 'codeDirectory': str(self.enrollment.root)}}
        self.live._current_material(ID, snapshot, self.profile, broker)
        path = self.data / '.env'
        path.chmod(0o600)
        path.write_bytes(b'JWT_SECRET=another current value with a changed file\n')
        before = copy.deepcopy(self.calls)
        with self.assertRaises(ValueError):
            self.live._current_material(ID, snapshot, self.profile, broker)
        self.assertEqual(self.calls, before)

    def test_genuine_proof_refuses_reusing_the_populated_review_target(self):
        with self.fixture.review._checked_review(F.ID, ACTOR) as checked:
            previous = checked.reconciliation.admission['sourcePreparationId']
            handoff = self.fixture.fixture.handoff
            with mock.patch.object(self.preparation, '_checked_preparation', return_value=handoff):
                with self.assertRaises(ValueError):
                    L.CoreLiveRestorationService._proof(self.live, ID, checked, previous, ACTOR)
        self.assertFalse(any(call[0] in {'start', 'stop'} for call in self.calls))

    def test_genuine_proof_refuses_new_target_from_foreign_policy(self):
        with self.fixture.review._checked_review(F.ID, ACTOR) as checked:
            intent = copy.deepcopy(checked.reconciliation.intent)
            intent['migrationPolicySha256'] = '0' * 64
            prepared = self.live.C.P.CheckedPreparation(self.fixture.fixture.bootstrap,
                self.live.C.P.POLICY.B.PreparedCleanTarget(TARGET, 'a' * 64), self.fixture.fixture.inspectors[0], intent)
            with mock.patch.object(self.preparation, '_checked_preparation', return_value=prepared):
                with self.assertRaises(ValueError):
                    L.CoreLiveRestorationService._proof(self.live, ID, checked, TARGET, ACTOR)
        self.assertFalse(self.live._marker_path().exists())

    def test_genuine_proof_refuses_plain_checked_capability(self):
        with self.assertRaises(ValueError):
            L.CoreLiveRestorationService._proof(self.live, ID, {}, TARGET, ACTOR)


if __name__ == '__main__':
    unittest.main()
