"""Durable supervisor failure tests; all engine/current-authority responses are synthetic."""
import copy
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Barrier
from types import SimpleNamespace
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


E = load('orbis-host-core-inspection-executor.py', 'core_inspection_executor_test')
A = load('orbis-host-retained-authority.py', 'core_inspection_executor_authority')
ID = 'a71c77d2-f420-440e-951b-083209514e72'
NODE = 'sha256:' + 'c' * 64


def actual_migration_ledger():
    directory = Path(__file__).resolve().parents[1] / 'packages/backend/src/core/database/drizzle'
    journal = json.loads((directory / 'meta/_journal.json').read_bytes())
    return [{'id': i + 4, 'hash': hashlib.sha256((directory / (entry['tag'] + '.sql')).read_bytes()).hexdigest(),
             'created_at': str(entry['when'])} for i, entry in enumerate(journal['entries'])]


class Runtime:
    def __init__(self, manager):
        self.manager, self.workers, self.calls = manager, {}, []
        self.failure = None

    def image(self, identifier):
        return {'Id': identifier, 'Os': 'linux', 'Architecture': 'arm64',
                'Config': {'Volumes': {'/var/lib/postgresql/data': {}} if identifier == E.PROFILE.PG17_ARM64_IMAGE else None}}

    def engine(self, method, route, body):
        self.calls.append(('create', copy.deepcopy(body)))
        role = body['Labels']['io.orbis.core-inspection.role']
        if self.failure == 'create':
            raise subprocess.TimeoutExpired('synthetic create', 1)
        identifier = ('a' if role == 'database' else 'b') * 64
        self.workers[identifier] = {'Id': identifier, 'Image': body['Image'], 'Name': '/' + route.partition('name=')[2],
            'Config': {key: copy.deepcopy(value) for key, value in body.items() if key != 'HostConfig'},
            'HostConfig': copy.deepcopy(body['HostConfig']), 'Body': copy.deepcopy(body), 'NetworkSettings': {'Networks': {'none': {}}},
            'State': {'Status': 'created', 'Running': False, 'Restarting': False, 'Paused': False, 'Dead': False,
                      'OOMKilled': False, 'ExitCode': 0, 'FinishedAt': '0001-01-01T00:00:00Z'}}
        return json.dumps({'Id': identifier}).encode()

    def inspect(self, identifier):
        raw = copy.deepcopy(self.workers[identifier])
        if self.failure == 'isolation':
            raw['HostConfig']['NetworkMode'] = 'host'
        return raw

    def check_intent(self, raw, body):
        expected = copy.deepcopy(body)
        expected.pop('NetworkingConfig')
        expected['Healthcheck'] = raw['Body']['Healthcheck']
        if raw['Body'] != expected or raw['HostConfig'] != expected['HostConfig']:
            raise E.ExecutorError('Synthetic changed definition')

    def never_started(self, raw):
        return raw['State']['Status'] == 'created'

    def definition(self, raw):
        return self.manager.digest(raw['Body'])

    def change(self, command):
        self.calls.append(tuple(command))
        worker = self.workers[command[-1]]
        if self.failure == 'start' and command[0] == 'start':
            raise subprocess.TimeoutExpired('synthetic start', 1)
        if command[0] == 'start':
            worker['State'].update(Status='running', Running=True)
            if worker['Body']['Labels']['io.orbis.core-inspection.role'] == 'coordinator':
                self.manager.output()
        elif command[0] == 'stop':
            worker['State'].update(Status='exited', Running=False, FinishedAt='2026-11-07T10:00:00Z')

    def bounded_output(self, arguments, maximum, timeout):
        worker = self.workers[arguments[-1]]
        if self.failure == 'wait':
            raise subprocess.TimeoutExpired('synthetic wait', 1)
        if self.failure == 'nonterminal':
            return b'0\n'
        worker['State'].update(Status='exited', Running=False, FinishedAt='2026-11-07T10:00:00Z')
        if self.failure == 'oom':
            worker['State'].update(OOMKilled=True, ExitCode=137)
            return b'137\n'
        return b'0\n'


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='core-inspection-supervisor-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        for child in ('trusted-input', 'output', 'coordinator'):
            (self.directory / child).mkdir(mode=0o700)
        self.enterContext(mock.patch.object(A, 'OWNER', os.geteuid()))
        self.a, self.P, self.context = A, A.P, 'synthetic'
        self.runtime = Runtime(self)
        self.profile = E.PROFILE.image_profile(self.runtime.image(E.PROFILE.PG17_ARM64_IMAGE))
        self.enrollment = SimpleNamespace(runtime=self.runtime, json=self.json, read=self.read, immutable=self.immutable)
        self.request = {'schema': 'orbis.core-inspection-worker-input.v1', 'id': ID, 'nonce': '1' * 64, 'permitSha256': '2' * 64,
                        'resourcesSha256': '3' * 64, 'sourceManifestSha256': '4' * 64, 'database': 'orbis_core_fixture_source',
                        'sourceOwnerId': 11, 'sourceImageId': E.PROFILE.PG17_ARM64_IMAGE, 'sourceAuthenticationSha256': None,
                        'settingsSha256': self.digest(E.PROFILE.SETTINGS)}
        self.write(self.directory / 'trusted-input/request.json', self.P.canonical(self.request))
        self.overlay = {'synthetic': True, 'profile': self.profile}
        self.write(self.directory / 'overlay.json', self.P.canonical(self.overlay))
        self.write(self.directory / 'coordinator/core-inspection-worker.mjs', b'not executed; synthetic coordinator fixture')
        self.value = {'id': ID, 'phase': 'inspecting', 'scope': 'inspection-only', 'activationAuthorized': False,
                      'executionClaimSha256': '9' * 64,
                      'executionPermitSha256': self.request['permitSha256'], 'executionRequestSha256': self.digest(self.request),
                      'executionOverlaySha256': self.digest(self.overlay),
                      'executionCoordinatorSha256': self.digest(E.PROFILE.coordinator_inventory(self.directory / 'coordinator', self.a)),
                      'evidence': {'destination': {'imageId': NODE}, 'source': {'sourceOwnerId': 11,
                          'resourcesSha256': self.request['resourcesSha256'], 'payload': {'manifestSha256': self.request['sourceManifestSha256']}}}}
        details = self.directory.stat()
        self.value['executionDirectory'] = {'path': str(self.directory), **{key: getattr(details, 'st_' + field) for key, field in (
            ('device', 'dev'), ('inode', 'ino'), ('mode', 'mode'), ('uid', 'uid'), ('gid', 'gid'))}}
        self.supervisor = E.InspectionSupervisor(self, copy.deepcopy(self.value))
        self.enterContext(mock.patch.object(E.PROFILE, 'verify_overlay', return_value={'synthetic': True}))
        self.enterContext(mock.patch.object(self.supervisor, 'socket_available', return_value=None))

    def digest(self, value):
        return E.PROFILE.digest(self.P.canonical(value))

    def write(self, path, body):
        path.write_bytes(body)
        path.chmod(0o600)
        if sys.platform == 'darwin':
            os.chflags(path, path.stat().st_flags | 0x40 | 0x8000, follow_symlinks=False)

    def read(self, path, maximum):
        with self.a.protected_directory(path.parent) as parent:
            with self.a.protected_file(parent, path.name, maximum) as body:
                return body

    def json(self, path, maximum=2 * 1024 * 1024):
        return self.P.metadata(self.read(path, maximum), byte_limit=maximum)

    def immutable(self, path, body):
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(body)

    def record(self, identifier):
        self.assertEqual(identifier, ID)
        return copy.deepcopy(self.value)

    def save(self, value):
        self.value = copy.deepcopy(value)

    def require_current(self, record):
        self.assertEqual(record['id'], ID)

    def runtime_authority(self):
        return nullcontext()

    def validate_execution_claim(self, record):
        self.assertEqual(record['executionDirectory'], self.value['executionDirectory'])

    def validate_prepared_execution(self, record, directory):
        self.assertEqual(str(directory), record['executionDirectory']['path'])

    def output(self):
        report = {'schema': 'orbis.core-inspection-worker-result.v1',
                  **{key: self.request[key] for key in ('id', 'nonce', 'permitSha256', 'resourcesSha256', 'sourceManifestSha256', 'sourceImageId', 'settingsSha256', 'sourceAuthenticationSha256')},
                  'inputSha256': self.digest(self.request), 'sourceOwner': None, 'compatibilityRefusal': 'source-authentication-unavailable',
                  'restoreAuthority': False, 'structure': {'schema': 'orbis.core-database-structure.v1', 'sha256': '5' * 64,
                      'catalogSha256': '6' * 64, 'major': 17, 'authenticationVerified': False, 'restoreAuthority': False,
                      'rows': {key: 1 for key in ('user', 'link', 'app', 'app_store', 'orbis_reset_receipt', '__drizzle_migrations')}}}
        if self.request['schema'] in {'orbis.core-inspection-worker-input.v2', 'orbis.core-inspection-worker-input.v3', 'orbis.core-inspection-worker-input.v4'}:
            report.update(schema='orbis.core-inspection-worker-result.v2', role=self.request['role'],
                          sourceProjectionSha256=self.request['sourceProjectionSha256'], compatibilityRefusal='source-effective-environment-unproved',
                          sourceOwner={'schema': 'orbis.core-source-owner.v1', 'sourceOwnerId': 11, 'sourceSha256': '5' * 64,
                                       'identitySha256': '7' * 64, 'authenticationSha256': '8' * 64, 'restoreAuthority': False})
        if self.request['schema'] in {'orbis.core-inspection-worker-input.v3', 'orbis.core-inspection-worker-input.v4'}:
            report.update(schema='orbis.core-inspection-worker-result.v3', evidenceScope=self.request['evidenceScope'],
                          bootstrapSource={'schema': 'orbis.core-source-bootstrap-evidence.v1', 'sourceSha256': '5' * 64,
                            'catalogSha256': '6' * 64, 'authenticationSha256': '8' * 64, 'sourceOwnerId': 11,
                            'identitySha256': '7' * 64, 'database': self.request['database'], 'systemIdentifier': '7000000000000000001',
                            'migrationLedger': [{'id': 2, 'hash': 'a' * 64, 'created_at': '1700000000000'}],
                            'authenticationVerified': True, 'environmentProved': False, 'restoreAuthority': False})
        if self.request['schema'] == 'orbis.core-inspection-worker-input.v4':
            report.update(schema='orbis.core-inspection-worker-result.v4', executionProfile=self.profile['profileId'],
                          databaseExecution={'schema': 'orbis.core-pg-execution-observation.v1', 'profileId': self.profile['profileId'],
                            'serverVersionNum': self.profile['major'] * 10000 + 23, 'major': self.profile['major'], 'database': self.request['database'],
                            'locale': {'encoding': 'UTF8', 'collate': 'en_US.utf8', 'ctype': 'en_US.utf8', 'provider': 'c'},
                            'localeProviderEvidence': 'postgresql14-libc-database-default' if self.profile['major'] == 14 else 'pg_database.datlocprovider'})
            report['structure']['major'] = self.profile['major']
            report['bootstrapSource'].update(schema='orbis.core-source-bootstrap-evidence.v2', catalogUserIdentities=[{'ownerId': 11, 'identitySha256': '7' * 64}])
        if hasattr(self, 'structure_profile'):
            schema, ledger, migration_count = self.structure_profile
            report['structure']['schema'] = schema
            report['structure']['rows']['__drizzle_migrations'] = len(ledger)
            if schema == E.STRUCTURE_V3:
                report['structure']['rows']['app_migration_commit'] = 0
            if 'bootstrapSource' in report:
                report['bootstrapSource']['migrationLedger'] = ledger
            if migration_count is not None:
                report['structure']['rows']['app_migration'] = migration_count
        self.write(self.directory / 'output/result.json', self.P.canonical(report))

    def run_workers(self):
        return self.supervisor.run_workers(self.directory, self.profile, self.request)

    def role_bound(self):
        authentication = self.P.canonical({'jwtSecret': 'synthetic-only-source-key-for-role-inspection', 'passkeys': None})
        projection = {'schema': 'orbis.core-source-environment.v2', 'role': 'all', 'database': self.request['database'],
                      'sourceManifestSha256': self.request['sourceManifestSha256'],
                      'sourceAuthenticationSha256': E.PROFILE.digest(authentication)}
        self.profile = E.PROFILE.role_bound_image_profile(self.runtime.image(E.PROFILE.PG17_ARM64_IMAGE), 'all', self.digest(projection))
        self.request.update(schema='orbis.core-inspection-worker-input.v2', role='all', sourceProjectionSha256=self.digest(projection),
                            sourceAuthenticationSha256=projection['sourceAuthenticationSha256'], settingsSha256=self.digest(E.PROFILE.settings_for(self.profile)))
        self.value['evidence']['source']['environmentProjection'] = projection
        self.overlay = {'synthetic': True, 'profile': self.profile}
        self.write(self.directory / 'overlay.json', self.P.canonical(self.overlay))
        self.write(self.directory / 'trusted-input/source-authentication.json', authentication)
        self.bind_request()

    def bind_request(self):
        self.write(self.directory / 'trusted-input/request.json', self.P.canonical(self.request))
        self.value['executionRequestSha256'] = self.digest(self.request)
        self.value['executionOverlaySha256'] = self.digest(self.overlay)
        self.supervisor.record = copy.deepcopy(self.value)

    def bootstrap_source(self):
        self.role_bound()
        self.request.update(schema='orbis.core-inspection-worker-input.v3', evidenceScope='authenticated-bootstrap-source')
        self.value['schema'] = 'orbis.core-restore-inspection.v3'
        self.value['evidence']['destination']['inspectionCoordinatorImageId'] = NODE
        self.bind_request()

    def test_v3_completion_exports_bound_catalog_and_ledger_without_replay(self):
        self.bootstrap_source()
        report = self.run_workers()
        calls = copy.deepcopy(self.runtime.calls)
        self.assertEqual(report['schema'], 'orbis.core-inspection-worker-result.v3')
        self.assertEqual(report['bootstrapSource']['migrationLedger'][0]['id'], 2)
        self.assertEqual(self.supervisor.checked_completion(self.directory, self.profile), report)
        self.assertEqual(self.runtime.calls, calls)
        self.assertFalse(report['bootstrapSource']['restoreAuthority'])

    def test_v3_replays_only_a_structure_matching_the_bound_actual_migrations(self):
        self.bootstrap_source()
        ledger = actual_migration_ledger()
        self.structure_profile = (E.STRUCTURE_V3, ledger, 0)
        report = self.run_workers()
        self.assertEqual(report['structure']['rows']['app_migration'], 0)
        self.assertEqual(self.supervisor.checked_completion(self.directory, self.profile), report)

    def test_v3_rejects_wrong_modern_schema_shape_or_partial_marker(self):
        self.bootstrap_source()
        ledger = actual_migration_ledger()
        self.assertEqual(ledger[-1]['hash'], E.APP_COMMIT_SQL_SHA256)
        for schema, rows, count in (
            (E.STRUCTURE_V2, ledger, None),
            (E.STRUCTURE_V1, ledger, None),
            (E.STRUCTURE_V3, ledger[:-1], 0),
            (E.STRUCTURE_V2, ledger[:-1] + [ledger[-1] | {'hash': '0' * 64}], 0),
            (E.STRUCTURE_V2, ledger[:-1] + [ledger[-1] | {'created_at': '1795203554059'}], 0),
            (E.STRUCTURE_V1, ledger[:-1], 0),
        ):
            self.structure_profile = (schema, rows, count)
            self.output()
            with self.subTest(schema=schema,count=count), self.assertRaises(E.ExecutorError):
                self.supervisor.checked_result(self.directory, self.request, self.profile)
        self.assertEqual(self.runtime.calls, [])

    def test_older_inspection_inputs_use_the_explicit_trusted_worker_catalog_schema(self):
        for legacy_request in (True, False):
            if not legacy_request:
                self.role_bound()
            self.structure_profile = (E.STRUCTURE_V3, actual_migration_ledger(), 1)
            self.output()
            report = self.supervisor.checked_result(self.directory, self.request, self.profile)
            self.assertEqual(report['structure']['schema'], E.STRUCTURE_V3)
            self.assertEqual(report['structure']['rows']['app_migration'], 1)
            self.assertNotIn('bootstrapSource', report)
        self.assertEqual(self.runtime.calls, [])

    def test_v3_requires_fresh_scope_and_never_reinterprets_an_old_request(self):
        self.bootstrap_source()
        for attack in ('missing', 'wrong', 'v2', 'v1'):
            request = copy.deepcopy(self.request)
            if attack == 'missing': request.pop('evidenceScope')
            if attack == 'wrong': request['evidenceScope'] = 'restore'
            if attack == 'v2': request['schema'] = 'orbis.core-inspection-worker-input.v2'
            if attack == 'v1': request['schema'] = 'orbis.core-inspection-worker-input.v1'
            with self.subTest(attack=attack), self.assertRaises(E.ExecutorError):
                self.supervisor.require_request(self.profile, request)
        self.assertEqual(self.runtime.calls, [])

    def test_v3_checks_v2_catalog_identity_projection_and_preserves_v1(self):
        self.bootstrap_source()
        self.output()
        path = self.directory / 'output/result.json'
        original = self.json(path)
        self.supervisor.checked_result(self.directory, self.request, self.profile)
        value = copy.deepcopy(original)
        value['bootstrapSource'].update(schema='orbis.core-source-bootstrap-evidence.v2',
            catalogUserIdentities=[{'ownerId': 11, 'identitySha256': '7' * 64}])
        self.write(path, self.P.canonical(value))
        self.assertEqual(self.supervisor.checked_result(self.directory, self.request, self.profile), value)
        self.assertEqual(self.runtime.calls, [])

        invalid = [None, [], [{'ownerId': True, 'identitySha256': '7' * 64}],
                   [{'ownerId': 12, 'identitySha256': '7' * 64}],
                   [{'ownerId': 11, 'identitySha256': 'x' * 64}],
                   [{'ownerId': 11, 'identitySha256': '8' * 64}],
                   [{'ownerId': 11, 'identitySha256': '7' * 64, 'username': 'private'}],
                   [{'ownerId': 11, 'identitySha256': '7' * 64}] * 2]
        for rows in invalid:
            bad = copy.deepcopy(value)
            bad['bootstrapSource']['catalogUserIdentities'] = rows
            self.write(path, self.P.canonical(bad))
            with self.subTest(rows=rows), self.assertRaises(E.ExecutorError):
                self.supervisor.checked_result(self.directory, self.request, self.profile)
        for schema in ('orbis.core-source-bootstrap-evidence.v1', 'unknown'):
            bad = copy.deepcopy(value)
            bad['bootstrapSource']['schema'] = schema
            self.write(path, self.P.canonical(bad))
            with self.subTest(schema=schema), self.assertRaises(E.ExecutorError):
                self.supervisor.checked_result(self.directory, self.request, self.profile)

    def test_v2_catalog_projection_requires_all_users_sorted_without_duplicates(self):
        self.bootstrap_source()
        self.output()
        path = self.directory / 'output/result.json'
        value = self.json(path)
        value['structure']['rows']['user'] = 2
        value['bootstrapSource'].update(schema='orbis.core-source-bootstrap-evidence.v2',
            catalogUserIdentities=[{'ownerId': 2, 'identitySha256': 'a' * 64}, {'ownerId': 11, 'identitySha256': '7' * 64}])
        self.write(path, self.P.canonical(value))
        self.supervisor.checked_result(self.directory, self.request, self.profile)
        for rows in (value['bootstrapSource']['catalogUserIdentities'][::-1],
                     [value['bootstrapSource']['catalogUserIdentities'][1]] * 2,
                     value['bootstrapSource']['catalogUserIdentities'][:1]):
            bad = copy.deepcopy(value)
            bad['bootstrapSource']['catalogUserIdentities'] = rows
            self.write(path, self.P.canonical(bad))
            with self.subTest(rows=rows), self.assertRaises(E.ExecutorError):
                self.supervisor.checked_result(self.directory, self.request, self.profile)

    def test_v3_rejects_unbound_or_invalid_catalog_ledger_and_authority(self):
        self.bootstrap_source()
        self.output()
        path = self.directory / 'output/result.json'
        original = self.json(path)
        attacks = {
            'catalogSha256': 'f' * 64, 'sourceSha256': 'f' * 64, 'authenticationSha256': 'f' * 64,
            'identitySha256': 'f' * 64, 'sourceOwnerId': 12, 'database': 'another',
            'systemIdentifier': '018', 'authenticationVerified': False, 'environmentProved': True,
            'restoreAuthority': True, 'migrationLedger': [], 'unknown': True,
        }
        for key, bad in attacks.items():
            value = copy.deepcopy(original)
            value['bootstrapSource'][key] = bad
            self.write(path, self.P.canonical(value))
            with self.subTest(field=key), self.assertRaises(E.ExecutorError):
                self.supervisor.checked_result(self.directory, self.request, self.profile)
        for rows in ([{'id': True, 'hash': 'a' * 64, 'created_at': '1700000000000'}],
                     [{'id': 2, 'hash': 'a' * 64, 'created_at': '01700000000000'}],
                     [{'id': 2, 'hash': 'a' * 64, 'created_at': '9007199254740992'}],
                     [{'id': 2, 'hash': 'a' * 64, 'created_at': '1700000000000', 'sql': 'forbidden'}]):
            value = copy.deepcopy(original)
            value['bootstrapSource']['migrationLedger'] = rows
            self.write(path, self.P.canonical(value))
            with self.subTest(rows=rows), self.assertRaises(E.ExecutorError):
                self.supervisor.checked_result(self.directory, self.request, self.profile)

    def test_completed_reader_requires_unchanged_positive_owned_terminals_and_receipt(self):
        self.bootstrap_source()
        with self.assertRaises(E.ExecutorError):
            self.supervisor.checked_completion(self.directory, self.profile)
        self.run_workers()
        record = copy.deepcopy(self.value)
        raw = copy.deepcopy(self.runtime.workers)
        for attack in ('running', 'restarted', 'missing-terminal', 'extra-worker', 'result-hash', 'terminal-hash'):
            self.value = copy.deepcopy(record)
            self.runtime.workers = copy.deepcopy(raw)
            self.supervisor.record = copy.deepcopy(record)
            if attack == 'running': self.runtime.workers['a' * 64]['State']['Running'] = True
            if attack == 'restarted': self.runtime.workers['a' * 64]['State']['StartedAt'] = 'later'
            if attack == 'missing-terminal': self.value['inspectionWorkers']['database'].pop('terminal')
            if attack == 'extra-worker': self.value['inspectionWorkers']['alien'] = {}
            if attack == 'result-hash': self.value['inspectionResultSha256'] = 'f' * 64
            if attack == 'terminal-hash': self.value['inspectionTerminalSha256'] = 'f' * 64
            self.supervisor.record = copy.deepcopy(self.value)
            with self.subTest(attack=attack), self.assertRaises(E.ExecutorError):
                self.supervisor.checked_completion(self.directory, self.profile)
        self.value = copy.deepcopy(record)
        self.runtime.workers = copy.deepcopy(raw)
        self.supervisor.record = copy.deepcopy(record)
        path = self.directory / 'inspection-complete.json'
        receipt = self.json(path)
        receipt['restoreAuthority'] = True
        self.write(path, self.P.canonical(receipt))
        with self.assertRaises(E.ExecutorError):
            self.supervisor.checked_completion(self.directory, self.profile)

    def test_completion_requires_both_independent_positive_terminal_records_and_bound_output(self):
        report = self.run_workers()
        self.assertFalse(report['restoreAuthority'])
        self.assertEqual(self.value['phase'], 'inspection-complete')
        for role in ('database', 'coordinator'):
            worker = self.value['inspectionWorkers'][role]
            self.assertEqual(worker['intent'], 'complete')
            self.assertFalse(worker['terminal']['state']['Running'])
        self.assertTrue((self.directory / 'inspection-complete.json').is_file())
        with self.assertRaises(E.ExecutorError):
            self.run_workers()

    def test_two_supervisors_cannot_consume_one_claim_or_overwrite_the_winner(self):
        barrier = Barrier(2)
        immutable = self.immutable
        def reserve(path, body):
            if path.name == 'supervisor-start.json':
                barrier.wait(timeout=5)
            return immutable(path, body)
        supervisors = [E.InspectionSupervisor(self, copy.deepcopy(self.value)) for _ in range(2)]
        def run(supervisor):
            try:
                return supervisor.run_workers(self.directory, self.profile, self.request)
            except E.ExecutorError:
                return None
        with mock.patch.object(self.enrollment, 'immutable', side_effect=reserve):
            with mock.patch.object(E.InspectionSupervisor, 'socket_available', return_value=None):
                with ThreadPoolExecutor(max_workers=2) as workers:
                    results = list(workers.map(run, supervisors))
        self.assertEqual(sum(result is not None for result in results), 1)
        self.assertEqual(self.value['phase'], 'inspection-complete')
        self.assertEqual(sum(call[0] == 'create' for call in self.runtime.calls), 2)
        marker = self.json(self.directory / 'supervisor-start.json')
        self.assertEqual(self.digest(marker), self.value['inspectionSupervisorSha256'])

    def test_crash_after_supervisor_reservation_never_replays_or_writes_a_stale_hold(self):
        with mock.patch.object(self, 'save', side_effect=OSError('synthetic failed job write')):
            with self.assertRaises(OSError):
                self.run_workers()
        self.assertEqual(self.value['phase'], 'inspecting')
        self.assertEqual(self.runtime.calls, [])
        replacement = E.InspectionSupervisor(self, copy.deepcopy(self.value))
        with mock.patch.object(self, 'save', side_effect=AssertionError('duplicate must not write')):
            with self.assertRaises(E.ExecutorError):
                replacement.run_workers(self.directory, self.profile, self.request)
        self.assertEqual(self.runtime.calls, [])

    def test_local_v2_uses_the_bound_independent_coordinator_image(self):
        self.role_bound()
        independent = 'sha256:' + 'e' * 64
        self.value['schema'] = 'orbis.core-restore-inspection.v2'
        self.value['evidence']['source']['origin'] = 'genuine-root-local-capture'
        self.value['evidence']['destination']['inspectionCoordinatorImageId'] = independent
        self.bind_request()
        self.run_workers()
        workers = self.value['inspectionWorkers']
        self.assertEqual(workers['database']['body']['Image'], E.PROFILE.PG17_ARM64_IMAGE)
        self.assertEqual(workers['coordinator']['body']['Image'], independent)
        self.assertNotEqual(workers['coordinator']['body']['Image'], NODE)
        self.assertTrue(all(worker['intent'] == 'complete' for worker in workers.values()))

    def test_legacy_execution_does_not_use_a_local_coordinator_override(self):
        self.value['evidence']['destination']['inspectionCoordinatorImageId'] = 'sha256:' + 'e' * 64
        self.bind_request()
        self.run_workers()
        self.assertEqual(self.value['inspectionWorkers']['coordinator']['body']['Image'], NODE)

    def test_a_different_execution_path_cannot_create_any_worker(self):
        before = copy.deepcopy(self.value)
        with tempfile.TemporaryDirectory(prefix='alternate-inspection-') as alternate:
            with self.assertRaises(E.ExecutorError):
                self.supervisor.run_workers(Path(alternate).resolve(), self.profile, self.request)
        self.assertEqual(self.runtime.calls, [])
        self.assertEqual(self.value, before)
        self.assertFalse((self.directory / 'supervisor-start.json').exists())

    def test_a_replaced_execution_directory_cannot_create_any_worker(self):
        previous = self.directory.with_name(self.directory.name + '-original')
        self.directory.rename(previous)
        self.addCleanup(__import__('shutil').rmtree, previous)
        self.directory.mkdir(mode=0o700)
        with self.assertRaises(E.ExecutorError):
            self.run_workers()
        self.assertEqual(self.runtime.calls, [])

    def test_prestart_data_revalidation_runs_before_any_container_creation(self):
        with mock.patch.object(self, 'validate_prepared_execution', side_effect=E.ExecutorError('changed prepared data')):
            with self.assertRaises(E.ExecutorError):
                self.run_workers()
        self.assertEqual(self.runtime.calls, [])
        self.assertEqual(self.value['phase'], 'recovery-required')

    def test_timeout_never_establishes_exit_or_permits_a_worker_retry(self):
        self.runtime.failure = 'wait'
        with self.assertRaises(subprocess.TimeoutExpired):
            self.run_workers()
        self.assertEqual(self.value['phase'], 'recovery-required')
        self.assertNotIn('terminal', self.value['inspectionWorkers']['coordinator'])
        self.assertTrue(self.runtime.workers['a' * 64]['State']['Running'])
        before = len(self.runtime.calls)
        with self.assertRaises(E.ExecutorError):
            self.run_workers()
        self.assertEqual(len(self.runtime.calls), before)

    def test_ambiguous_create_retains_intent_without_adopting_or_retrying(self):
        self.runtime.failure = 'create'
        with self.assertRaises(subprocess.TimeoutExpired):
            self.run_workers()
        self.assertEqual(self.value['phase'], 'recovery-required')
        self.assertEqual(self.value['inspectionWorkers']['database']['intent'], 'creating')
        self.assertNotIn('id', self.value['inspectionWorkers']['database'])

    def test_ambiguous_start_retains_the_exact_worker_id_and_start_intent(self):
        self.runtime.failure = 'start'
        with self.assertRaises(subprocess.TimeoutExpired):
            self.run_workers()
        worker = self.value['inspectionWorkers']['database']
        self.assertEqual(worker['id'], 'a' * 64)
        self.assertEqual(worker['intent'], 'starting')
        self.assertNotIn('terminal', worker)

    def test_zero_wait_status_does_not_override_a_nonterminal_inspect_state(self):
        self.runtime.failure = 'nonterminal'
        with self.assertRaises(E.ExecutorError):
            self.run_workers()
        self.assertEqual(self.value['phase'], 'recovery-required')
        self.assertNotIn('terminal', self.value['inspectionWorkers']['coordinator'])

    def test_oom_cannot_produce_completion_authority(self):
        self.runtime.failure = 'oom'
        with self.assertRaises(E.ExecutorError):
            self.run_workers()
        self.assertFalse((self.directory / 'inspection-complete.json').exists())

    def test_changed_isolation_refuses_before_the_bound_worker_can_start(self):
        self.runtime.failure = 'isolation'
        with self.assertRaises(E.ExecutorError):
            self.run_workers()
        self.assertEqual(self.value['phase'], 'recovery-required')
        self.assertFalse(any(call[0] == 'start' for call in self.runtime.calls))

    def test_enabled_health_command_is_not_hidden_by_image_merge_metadata(self):
        original = self.runtime.inspect
        def changed(identifier):
            raw = original(identifier)
            raw['Config']['Healthcheck'] = {'Test': ['CMD', 'unapproved-probe']}
            return raw
        self.runtime.inspect = changed
        with self.assertRaises(E.ExecutorError):
            self.run_workers()
        self.assertFalse(any(call[0] == 'start' for call in self.runtime.calls))

    def test_compression_policy_is_strictly_bound_before_worker_start(self):
        original = self.runtime.inspect
        def changed(identifier):
            raw = original(identifier)
            raw['HostConfig']['LogConfig']['Config'].pop('compress')
            return raw
        self.runtime.inspect = changed
        with self.assertRaises(E.ExecutorError):
            self.run_workers()
        self.assertFalse(any(call[0] == 'start' for call in self.runtime.calls))

    def test_terminal_coordinator_with_wrong_output_nonce_does_not_settle_database(self):
        original = self.output
        def changed_output():
            original()
            path = self.directory / 'output/result.json'
            report = json.loads(path.read_bytes())
            report['nonce'] = '0' * 64
            self.write(path, self.P.canonical(report))
        self.output = changed_output
        with self.assertRaises(E.ExecutorError):
            self.run_workers()
        self.assertEqual(self.value['phase'], 'recovery-required')
        self.assertIn('terminal', self.value['inspectionWorkers']['coordinator'])
        self.assertNotIn('terminal', self.value['inspectionWorkers']['database'])
        self.assertTrue(self.runtime.workers['a' * 64]['State']['Running'])

    def test_unclaimed_or_legacy_permit_is_rejected_before_any_container(self):
        self.supervisor.record['phase'] = 'inspection-authorized'
        with self.assertRaises(E.ExecutorError):
            self.run_workers()
        self.assertEqual(self.runtime.calls, [])

    def test_changed_request_or_coordinator_custody_refuses_before_container_create(self):
        self.write(self.directory / 'coordinator/core-inspection-worker.mjs', b'replaced synthetic coordinator')
        with self.assertRaises(E.ExecutorError):
            self.run_workers()
        self.assertEqual(self.runtime.calls, [])
        self.assertEqual(self.value['phase'], 'recovery-required')


    def test_role_bound_completion_preserves_both_positive_terminal_requirements(self):
        self.role_bound()
        report = self.run_workers()
        self.assertEqual(report['schema'], 'orbis.core-inspection-worker-result.v2')
        self.assertEqual(report['role'], 'all')
        self.assertEqual(report['sourceProjectionSha256'], self.profile['sourceProjectionSha256'])
        self.assertEqual(report['compatibilityRefusal'], 'source-effective-environment-unproved')
        self.assertEqual(self.value['phase'], 'inspection-complete')
        self.assertTrue(all(w['intent'] == 'complete' for w in self.value['inspectionWorkers'].values()))

    def test_v2_projection_role_database_auth_schema_and_digest_are_independently_bound(self):
        for key, replacement in [('role', 'postgres'), ('database', 'other_db'), ('sourceManifestSha256', 'f' * 64), ('sourceAuthenticationSha256', 'f' * 64),
                                 ('schema', 'orbis.core-source-environment.v1')]:
            self.role_bound()
            projection = self.value['evidence']['source']['environmentProjection']
            projection[key] = replacement
            self.request['sourceProjectionSha256'] = self.digest(projection)
            self.profile['sourceProjectionSha256'] = self.digest(projection)
            self.bind_request()
            with self.subTest(key=key), self.assertRaises(ValueError): self.run_workers()
            self.assertEqual(self.runtime.calls, [])
            self.value['phase'] = 'inspecting'
        self.role_bound()
        self.request['sourceProjectionSha256'] = 'f' * 64
        self.profile['sourceProjectionSha256'] = 'f' * 64
        self.bind_request()
        with self.assertRaises(ValueError): self.run_workers()
        self.assertEqual(self.runtime.calls, [])

    def test_role_bound_request_rejects_null_auth_missing_extra_fields_and_version_fallback(self):
        for attack in ('null-auth', 'missing-role', 'extra-key', 'v1-schema', 'bad-role', 'bad-database', 'old-settings'):
            self.role_bound()
            if attack == 'null-auth': self.request['sourceAuthenticationSha256'] = None
            if attack == 'missing-role': self.request.pop('role')
            if attack == 'extra-key': self.request['password'] = 'forbidden'
            if attack == 'v1-schema': self.request['schema'] = 'orbis.core-inspection-worker-input.v1'
            if attack == 'bad-role': self.request['role'] = 'all reject'
            if attack == 'bad-database': self.request['database'] = 'not-a-name'
            if attack == 'old-settings': self.request['settingsSha256'] = self.digest(E.PROFILE.SETTINGS)
            self.bind_request()
            with self.subTest(attack=attack), self.assertRaises(ValueError): self.run_workers()
            self.assertEqual(self.runtime.calls, [])
            self.request.pop('password', None)
            self.request['database'] = 'orbis_core_fixture_source'
            self.value['phase'] = 'inspecting'

    def test_v1_rejects_v2_fields_and_v2_rejects_wrong_overlay_profile(self):
        self.request.update(role='all', sourceProjectionSha256='d' * 64)
        self.bind_request()
        with self.assertRaises(ValueError): self.run_workers()
        self.assertEqual(self.runtime.calls, [])
        self.value['phase'] = 'inspecting'
        self.role_bound()
        self.overlay['profile'] = E.PROFILE.image_profile(self.runtime.image(E.PROFILE.PG17_ARM64_IMAGE))
        self.bind_request()
        self.write(self.directory / 'overlay.json', self.P.canonical(self.overlay))
        with self.assertRaises(ValueError): self.run_workers()
        self.assertEqual(self.runtime.calls, [])

    def test_v2_result_role_projection_missing_extra_or_schema_cannot_fall_back(self):
        self.role_bound()
        for attack in ('role', 'projection', 'missing', 'extra', 'schema', 'null-refusal', 'old-refusal', 'authority'):
            self.output()
            path = self.directory / 'output/result.json'
            value = json.loads(path.read_bytes())
            if attack == 'role': value['role'] = 'postgres'
            if attack == 'projection': value['sourceProjectionSha256'] = 'f' * 64
            if attack == 'missing': value.pop('role')
            if attack == 'extra': value['password'] = 'forbidden'
            if attack == 'schema': value['schema'] = 'orbis.core-inspection-worker-result.v1'
            if attack == 'null-refusal': value['compatibilityRefusal'] = None
            if attack == 'old-refusal': value['compatibilityRefusal'] = 'source-authentication-unavailable'
            if attack == 'authority': value['restoreAuthority'] = True
            self.write(path, self.P.canonical(value))
            with self.subTest(attack=attack), self.assertRaises(ValueError):
                self.supervisor.checked_result(self.directory, self.request, self.profile)

    def test_v2_profile_and_request_cannot_diverge_or_accept_a_result_without_profile(self):
        for key, value in [('role', 'postgres'), ('sourceProjectionSha256', 'e' * 64)]:
            self.role_bound()
            self.profile[key] = value
            self.bind_request()
            with self.subTest(key=key), self.assertRaises(ValueError): self.run_workers()
            self.assertEqual(self.runtime.calls, [])
            self.value['phase'] = 'inspecting'
        self.role_bound()
        self.output()
        with self.assertRaises(ValueError):
            self.supervisor.checked_result(self.directory, self.request)

    def test_v2_timeout_retains_exact_roles_and_projection_without_completion(self):
        self.role_bound()
        self.runtime.failure = 'wait'
        with self.assertRaises(subprocess.TimeoutExpired): self.run_workers()
        self.assertEqual(self.value['phase'], 'recovery-required')
        self.assertNotIn('terminal', self.value['inspectionWorkers']['coordinator'])
        self.assertFalse((self.directory / 'inspection-complete.json').exists())


class VersionedSupervisorTests(unittest.TestCase):
    def setUp(self):
        self.fixture = SupervisorTests('test_v3_completion_exports_bound_catalog_and_ledger_without_replay')
        self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.configure(14)

    def configure(self, major):
        f = self.fixture
        if not hasattr(self, 'old_image'):
            f.bootstrap_source();self.old_image = f.runtime.image
        def image(identifier):
            if identifier == E.PROFILE.PG.PG14_AMD64_IMAGE:
                return {'Id': identifier, 'Os': 'linux', 'Architecture': 'amd64', 'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}}
            value = self.old_image(identifier)
            if identifier == NODE:value['Architecture'] = 'amd64' if major == 14 else 'arm64'
            return value
        f.runtime.image = image
        projection = f.value['evidence']['source']['environmentProjection']
        identifier = E.PROFILE.PG.PG14_AMD64_IMAGE if major == 14 else E.PROFILE.PG17_ARM64_IMAGE
        f.profile = E.PROFILE.role_bound_execution_profile(image(identifier), 'all', f.digest(projection))
        f.request.update(schema='orbis.core-inspection-worker-input.v4', executionProfile=f.profile['profileId'],
                         sourceImageId=identifier, settingsSha256=f.digest(E.PROFILE.settings_for(f.profile)))
        f.value.update(schema='orbis.core-restore-inspection.v4', sandboxProfile=E.PROFILE.EXECUTION_SCHEMA)
        f.value['evidence']['profile'] = copy.deepcopy(f.profile)
        f.value['evidence']['source'].update(origin='genuine-root-local-capture', images={'database': identifier},
            compatibility={'os': 'linux', 'architecture': f.profile['architecture'], 'database': {'engine': 'postgresql', 'major': major}})
        f.overlay = {'synthetic': True, 'profile': f.profile}
        f.write(f.directory / 'overlay.json', f.P.canonical(f.overlay));f.bind_request()

    def test_v4_14_workers_and_completion_bind_actual_observation_and_closed_profile(self):
        self.check_run(14)

    def test_v4_binds_the_modern_profile_independent_of_pg_major_and_ledger_id(self):
        f = self.fixture
        f.structure_profile = (E.STRUCTURE_V3, actual_migration_ledger(), 0)
        report = f.run_workers()
        self.assertEqual(report['structure']['major'], 14)
        self.assertEqual(report['structure']['schema'], E.STRUCTURE_V3)
        self.assertEqual(f.supervisor.checked_completion(f.directory, f.profile), report)

    def test_v4_17_workers_and_completion_keep_new_protocol_separate(self):
        self.configure(17);self.check_run(17)

    def check_run(self, major):
        f = self.fixture;report = f.run_workers()
        self.assertEqual(report['schema'], 'orbis.core-inspection-worker-result.v4')
        self.assertEqual(report['structure']['major'], major)
        self.assertEqual(report['databaseExecution']['major'], major)
        self.assertEqual(report['executionProfile'], f.profile['profileId'])
        calls = copy.deepcopy(f.runtime.calls)
        self.assertEqual(f.supervisor.checked_completion(f.directory, f.profile), report)
        self.assertEqual(f.runtime.calls, calls)
        created = [call[1] for call in calls if call[0] == 'create']
        self.assertEqual(created[0]['Entrypoint'], [E.PROFILE.binary_for(f.profile, 'postgres')])
        self.assertEqual(created[0]['User'], '999:999' if major == 14 else '70:70')
        self.assertEqual('archive_library=' in created[0]['Cmd'], major == 17)
        self.assertFalse(report['restoreAuthority'])
        self.assertFalse(report['bootstrapSource']['environmentProved'])

    def test_new_request_profile_and_record_bindings_refuse_downgrade_before_workers(self):
        f = self.fixture
        for changed in ({'schema': 'orbis.core-inspection-worker-input.v3'}, {'executionProfile': 'pg17-alpine-arm64.v1'},
                        {'executionProfile': 'unknown'}, {'sourceImageId': E.PROFILE.PG17_ARM64_IMAGE},
                        {'settingsSha256': 'a' * 64}, {'evidenceScope': 'restore'}, {'database': '--help'}):
            with self.subTest(changed=changed), self.assertRaises(E.ExecutorError):
                f.supervisor.require_request(f.profile, f.request | changed)
        missing = copy.deepcopy(f.request);missing.pop('executionProfile')
        with self.assertRaises(E.ExecutorError):f.supervisor.require_request(f.profile, missing)
        for schema in ('orbis.core-restore-inspection.v2', 'orbis.core-restore-inspection.v3'):
            f.supervisor.record['schema'] = schema
            with self.subTest(schema=schema), self.assertRaises(E.ExecutorError):f.supervisor.require_request(f.profile, f.request)
        self.assertEqual(f.runtime.calls, [])

    def test_profile_image_major_architecture_and_settings_are_not_caller_allowances(self):
        f = self.fixture;original = copy.deepcopy(f.supervisor.record)
        for change in ({'architecture': 'arm64'}, {'database': {'engine': 'postgresql', 'major': 17}}, {'os': 'darwin'}):
            f.supervisor.record = copy.deepcopy(original)
            f.supervisor.record['evidence']['source']['compatibility'].update(change)
            with self.subTest(change=change), self.assertRaises(E.ExecutorError):f.supervisor.require_request(f.profile, f.request)
        f.supervisor.record = original
        for change in ({'uid': 70}, {'gid': 0}, {'major': 17}, {'archive_library': ''}):
            with self.subTest(change=change), self.assertRaises(ValueError):f.supervisor.require_request(f.profile | change, f.request)
        self.assertEqual(f.runtime.calls, [])

    def test_v4_observation_rejects_malformed_version_identity_locale_and_provider(self):
        f = self.fixture;f.output();path = f.directory / 'output/result.json';original = f.json(path)
        values = [None, [], original['databaseExecution'] | {'extra': True}]
        for key, value in [('schema', 'old'), ('profileId', 'pg17-alpine-arm64.v1'), ('major', 17), ('major', True),
                           ('serverVersionNum', True), ('serverVersionNum', '140023'), ('serverVersionNum', 170023),
                           ('serverVersionNum', 1400000), ('database', 'other'), ('localeProviderEvidence', 'pg_database.datlocprovider')]:
            values.append(original['databaseExecution'] | {key: value})
        for change in ({'encoding': 'LATIN1'}, {'provider': 'i'}, {'collate': ''}, {'ctype': 'x\n'},
                       {'collate': 'é' * 129}, {'ctype': '\ud800'}, {'extra': True}):
            values.append(original['databaseExecution'] | {'locale': original['databaseExecution']['locale'] | change})
        for value in values:
            report = copy.deepcopy(original);report['databaseExecution'] = value;f.write(path, f.P.canonical(report))
            with self.subTest(value=value), self.assertRaises(ValueError):f.supervisor.checked_result(f.directory, f.request, f.profile)
        self.assertEqual(f.runtime.calls, [])

    def test_v4_refuses_old_result_catalog_and_unbound_structure_major(self):
        f = self.fixture;f.output();path = f.directory / 'output/result.json';original = f.json(path)
        changes = [{'schema': 'orbis.core-inspection-worker-result.v3'}, {'executionProfile': 'pg17-alpine-arm64.v1'},
                   {'structure': original['structure'] | {'major': 17}}, {'structure': original['structure'] | {'major': True}},
                   {'bootstrapSource': None}]
        legacy = copy.deepcopy(original['bootstrapSource']);legacy.pop('catalogUserIdentities');legacy['schema'] = 'orbis.core-source-bootstrap-evidence.v1';changes.append({'bootstrapSource': legacy})
        for change in changes:
            f.write(path, f.P.canonical(original | change))
            with self.subTest(change=change), self.assertRaises(E.ExecutorError):f.supervisor.checked_result(f.directory, f.request, f.profile)
        downgraded = copy.deepcopy(original);downgraded.pop('databaseExecution')
        f.write(path, f.P.canonical(downgraded))
        with self.assertRaises(E.ExecutorError):f.supervisor.checked_result(f.directory, f.request, f.profile)

    def test_v4_node_architecture_drift_creates_no_worker(self):
        f = self.fixture;image = f.runtime.image
        f.runtime.image = lambda identifier: image(identifier) | ({'Architecture': 'arm64'} if identifier == NODE else {})
        with self.assertRaises(E.ExecutorError):f.run_workers()
        self.assertEqual(f.runtime.calls, [])
        self.assertEqual(f.value['phase'], 'recovery-required')

    def test_v4_completed_observation_drift_is_not_adopted_or_replayed(self):
        f = self.fixture;f.run_workers();calls = copy.deepcopy(f.runtime.calls)
        path = f.directory / 'output/result.json';report = f.json(path);report['databaseExecution']['locale']['collate'] = 'C'
        f.write(path, f.P.canonical(report))
        with self.assertRaises(E.ExecutorError):f.supervisor.checked_completion(f.directory, f.profile)
        self.assertEqual(f.runtime.calls, calls)


class StructureCommitProfileTests(unittest.TestCase):
    def test_keeps_legacy_profiles_and_requires_both_exact_markers_for_commit_profile(self):
        ledger = actual_migration_ledger()
        self.assertEqual(E.structure_history_schema(ledger[:-2]), E.STRUCTURE_V1)
        self.assertEqual(E.structure_history_schema(ledger[:-1]), E.STRUCTURE_V2)
        self.assertEqual(E.structure_history_schema(ledger), E.STRUCTURE_V3)
        self.assertEqual(E.structure_row_tables(E.STRUCTURE_V3), E.structure_row_tables(E.STRUCTURE_V2) | {'app_migration_commit'})
        for changed in (
                ledger[:-1] + [ledger[-1] | {'hash': '0' * 64}],
                ledger[:-1] + [ledger[-1] | {'created_at': '1795305600001'}],
                ledger[:-2] + [ledger[-1]],
                ledger + [ledger[-1] | {'id': ledger[-1]['id'] + 1}]):
            with self.subTest(rows=len(changed)):
                self.assertIsNone(E.structure_history_schema(changed))


if __name__ == '__main__':
    unittest.main()
