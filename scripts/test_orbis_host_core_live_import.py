"""Protected files and real Root checked scope; upstream proof, Docker/SQL are seams."""
import copy
from contextlib import contextmanager
from contextvars import ContextVar
import fcntl
import hashlib
import os
from pathlib import Path
import threading
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import test_orbis_host_core_restoration as F

M = F.load('orbis-host-core-live-import.py', 'live_logical_import_test')
L = F.load('orbis-host-core-live-restoration.py', 'live_logical_import_scope_test')
ID, LIVE, ACTOR = F.ID, F.RECONCILIATION, F.ACTOR


class LiveImportTests(unittest.TestCase):
    def setUp(self):
        task_temp = Path(os.environ['TMPDIR']).parent / 'core-live-import-20261112.nosync' / 'child.nosync' / 'tmp'
        task_temp.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.enterContext(mock.patch.object(tempfile, 'tempdir', str(task_temp)))
        self.fixture = f = F.LogicalStageTests()
        f.setUp()
        self.addCleanup(f.doCleanups)
        self.enrollment, self.runtime, self.P = f.enrollment, f.runtime, f.P
        self.service = f.service
        self.live = live = object.__new__(L.CoreLiveRestorationService)
        live.service, live.enrollment, live.P, live.C = self.service, self.enrollment, self.P, F.C
        live.TARGET, live.SOURCE = F.C.R.TARGET, F.C.R.SOURCE
        live._graph = lambda: self.runtime
        live._identifier = lambda identifier: identifier if F.C.P.F.L.BASE.E.UUID.fullmatch(identifier) else F.C.require(False)
        live._condition, live._active, live._aborting = threading.Condition(), {}, set()
        host = SimpleNamespace(CORE_LIVE_TRANSACTION=ContextVar('live-import-transaction', default=None),
            LOCK_DESCRIPTOR=ContextVar('live-import-lock', default=None))
        @contextmanager
        def host_lock(root):
            fd = os.open(root / 'fixture-root.lock', os.O_RDWR | os.O_CREAT, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            token = host.LOCK_DESCRIPTOR.set(fd)
            try:
                yield fd
            finally:
                host.LOCK_DESCRIPTOR.reset(token)
                os.close(fd)
        host.host_lock = host_lock
        self.service.HOST, self.service.lock = host, threading.Lock()
        self.service.core_live_restorations = lambda: live
        self.service.core_live_restoration_module = L
        self.enterContext(mock.patch.object(live.C.P.F.I, 'require_root'))
        self.source_auth = self.P.canonical({'jwtSecret': 'private source fixture token '*3, 'passkeys': None})
        prepared = {'schema': 'orbis.core-clean-target-reconciliation.v2', 'id': LIVE,
            'authenticationSha256': hashlib.sha256(self.P.canonical({'jwtSecret': 'private source fixture token '*3})).hexdigest(),
            'restoreAuthority': False, 'environmentProved': False}
        self.connection = {'host': '192.0.2.20', 'port': 5432, 'user': 'tipi', 'password': 'private:fixture\\only', 'database': 'orbis'}
        target = {'directory': str(f.target), 'profile': copy.deepcopy(f.profile), 'workspace': {'allocation': {}, 'identities': {}}}
        intent = {'sourceInspectionId': F.REVIEW, 'installedRuntime': {'id': LIVE,
            'installationSha256': 'b'*64, 'sourceControllerImageId': 'sha256:'+'4'*64}, 'migrationPolicySha256': 'c'*64}
        self.admission = {'id': LIVE, 'actor': copy.deepcopy(ACTOR), 'reviewId': F.REVIEW,
            'targetPreparationId': 'af12a54b-0084-437e-b6a7-12040c52d72f', 'evidence': {
            'target': target, 'preparationIntent': intent, 'sourceSnapshot': {'captured': 'original-controller'},
            'connectionSha256': hashlib.sha256(self.P.canonical(self.connection)).hexdigest(),
            'sourceAuthenticationSha256': hashlib.sha256(self.source_auth).hexdigest(), 'broker': {'configuration': {'generation': 'installed'}}}}
        self.stage = {'id': LIVE, 'admissionSha256': live.digest(self.admission), 'target': copy.deepcopy(target),
            'admissionReopened': False, 'destinationEvidence': 'live-held-derived', 'prepared': prepared}
        self.record = {'id': LIVE, 'admissionSha256': live.digest(self.admission), 'stageSha256': live.digest(self.stage),
            'originalDatabase': {'id': self.runtime.live['Id'], 'definition': self.runtime.definition(self.runtime.live),
                'startedAt': self.runtime.live['State']['StartedAt']}, 'databaseProfile': copy.deepcopy(f.profile),
            'databaseRole': 'tipi', 'databaseName': 'orbis', 'network': {'name': 'installed-core', 'id': '2'*64, 'address': '192.0.2.20'}}
        live_dir = self.enrollment.child(self.enrollment.child(f.root, 'core-live-restorations'), LIVE)
        self.enrollment.child(live_dir, 'private')
        for name, value in [('admission.json', self.admission), ('job.json', self.record), ('live-held-stage.json', self.stage)]:
            self.enrollment.immutable(live_dir / name, self.P.canonical(value))
        self.enrollment.immutable(live_dir / 'private/connection.json', self.P.canonical(self.connection))
        self.enrollment.immutable(live_dir / 'private/source-authentication.json', self.source_auth)
        # Admission/output proof was qualified by the lifecycle suite; scope,
        # locking, claims and all importer protected files remain production code.
        live._admission = lambda identifier, actor=None: live._read(identifier, 'admission.json')
        live._record = lambda identifier, actor=None: live._read(identifier, 'job.json')
        self.fenced = True
        live._ready = lambda record, admission: L.require(self.fenced)
        live._check_broker = lambda admission: None
        f.broker.binding = lambda: {'generation': 'installed'}
        live.preparation = SimpleNamespace(_source=lambda *args, **kwargs: (SimpleNamespace(configuration=f.broker), None, None, None, None))
        self.runtime.reader = SimpleNamespace(_object=lambda args: {'Id': '2'*64, 'Name': 'installed-core', 'Driver': 'bridge',
            'Scope': 'local', 'Internal': False})
        self.manager = f.manager = M.CoreLiveDerivedLogicalStage(self.service)
        self.bad_result, self.fail_verify = False, False
        original_change = self.runtime.change
        def change(command):
            original_change(command)
            row = self.runtime.workers[command[-1]]
            row['State']['Pid'] = 123 if row['State']['Running'] else 0
            if command[0] == 'start' and row['role'] == 'verify-imported':
                record = self.manager.read(ID)
                result = {**self.manager.binding_for(record), 'schema': M.VERIFIED,
                    **{key: record[key] for key in ('liveJobId', 'liveAdmissionSha256', 'liveHeldStageSha256')},
                    'logicalTargetVerified': True, 'environmentProved': False, 'restoreAuthority': False, 'activation': False}
                if self.bad_result:
                    result['liveHeldStageSha256'] = 'f'*64
                path = self.manager._directory(ID) / 'verification/result.json'
                path.write_bytes(self.P.canonical(result))
                path.chmod(0o400)
                if self.fail_verify:
                    row['State']['ExitCode'] = 7
        self.runtime.change = change

    def stage_import(self):
        return self.manager.prepare(ID, LIVE, ACTOR)

    def test_positive_live_lineage_real_scope_and_distinct_verifier(self):
        binding = self.stage_import()
        record = self.manager.read(ID)
        self.assertEqual(binding['schema'], M.BINDING)
        self.assertEqual(record['destinationEvidence'], 'live-held-derived')
        self.assertNotIn('reviewId', record)
        self.assertEqual(set(self.manager._descriptor(record)), M.DESCRIPTOR_FIELDS)
        self.assertEqual(self.manager.binding(ID, ACTOR), binding)
        result = self.manager.verify_imported(ID, ACTOR)
        self.assertIs(type(result), M.ImportedLiveCoreStage)
        staged = self.manager.read(ID)
        self.assertEqual(staged['phase'], 'staged')
        self.assertIn('--verify-live-imported', staged['workers']['verify-imported']['body']['Cmd'])
        self.assertEqual(staged['workers']['dump']['body']['HostConfig']['NetworkMode'], 'none')
        self.assertTrue(self.manager.assert_settled_for_abort(LIVE, record['claim'], ACTOR))
        self.assertFalse(self.service.lock.locked())
        self.assertFalse(self.live._active)
        self.assertFalse(any('DROP DATABASE' in str(row) or 'ALTER DATABASE' in str(row) for row in self.runtime.events))
        for worker in staged['workers'].values():
            body = worker['body']['HostConfig']
            self.assertFalse(body.get('PortBindings'))
            self.assertFalse(any('/docker.sock' in str(mount) for mount in body['Mounts']))
        for role in ('dump', 'import'):
            self.assertTrue(any(mount['Target'] == '/var/lib/postgresql/data' for mount in staged['workers'][role]['body']['HostConfig']['Mounts']))

    def test_claim_precedes_first_create_and_second_prepare_refuses(self):
        original = self.runtime.engine
        def create(*args):
            claim = self.live._read(LIVE, 'import-claim.json')
            self.assertEqual(claim['stageId'], ID)
            self.assertEqual(self.manager.read(ID)['workers'][args[-1]['Labels'].get('io.orbis.core-logical.role', 'database')]['intent'], 'creating')
            return original(*args)
        self.runtime.engine = create
        self.stage_import()
        count = len(self.runtime.events)
        with self.assertRaises(ValueError):
            self.manager.prepare('af12a54b-0084-437e-b6a7-12040c52d740', LIVE, ACTOR)
        self.assertEqual(count, len(self.runtime.events))

    def test_sql_lost_ack_retains_unadopted_database_and_blocks_abort(self):
        self.runtime.lost_create = True
        with self.assertRaises(OSError):
            self.stage_import()
        record = self.manager.read(ID)
        self.assertEqual(record['operations'][0]['intent'], 'executing')
        self.assertIsNotNone(self.runtime.database)
        with self.assertRaises(ValueError):
            self.manager.assert_settled_for_abort(LIVE, record['claim'], ACTOR)
        with self.assertRaises(ValueError):
            self.stage_import()

    def test_worker_create_lost_ack_leaves_ambiguous_intent(self):
        original = self.runtime.engine
        def lost(*args):
            original(*args)
            raise OSError('fixture acknowledgement lost')
        self.runtime.engine = lost
        with self.assertRaises(OSError):
            self.stage_import()
        record = self.manager.read(ID)
        with self.assertRaises(ValueError):
            self.manager.assert_settled_for_abort(LIVE, record['claim'], ACTOR)
        self.assertIsNone(self.runtime.database)

    def test_fence_refusal_before_claim_or_mutation(self):
        self.fenced = False
        with self.assertRaises(ValueError):
            self.stage_import()
        self.assertFalse(self.runtime.events)
        self.assertFalse((self.live._directory(LIVE) / 'import-claim.json').exists())

    def test_mixed_live_lineage_refused(self):
        self.stage_import()
        record = self.manager.read(ID)
        record['liveHeldStageSha256'] = 'f'*64
        self.manager.save(record)
        with self.assertRaises(ValueError):
            self.manager.verify_imported(ID, ACTOR)
        self.assertNotIn('verify-imported', self.manager.read(ID)['workers'])

    def test_worker_failure_cannot_bless_result_presence(self):
        self.stage_import()
        self.fail_verify = True
        with self.assertRaises(ValueError):
            self.manager.verify_imported(ID, ACTOR)
        record = self.manager.read(ID)
        self.assertEqual(record['phase'], 'recovery-required')
        self.assertTrue((self.manager._directory(ID) / 'verification/result.json').exists())
        self.assertFalse((self.manager._directory(ID) / 'verification-receipt.json').exists())
        self.assertTrue(self.manager.assert_settled_for_abort(LIVE, record['claim'], ACTOR))

    def test_terminal_state_with_nonzero_pid_cannot_bless_result_or_abort(self):
        self.stage_import()
        real = self.runtime.change

        def inconsistent(command):
            real(command)
            row = self.runtime.workers[command[-1]]
            if command[0] == 'start' and row['role'] == 'verify-imported':
                row['State']['Pid'] = 777

        self.runtime.change = inconsistent
        with self.assertRaises(ValueError):
            self.manager.verify_imported(ID, ACTOR)
        record = self.manager.read(ID)
        self.assertEqual(record['phase'], 'recovery-required')
        self.assertTrue((self.manager._directory(ID) / 'verification/result.json').exists())
        self.assertFalse((self.manager._directory(ID) / 'verification-receipt.json').exists())
        with self.assertRaises(ValueError):
            self.manager.assert_settled_for_abort(LIVE, record['claim'], ACTOR)

    def test_result_mixed_lineage_refused(self):
        self.stage_import()
        self.bad_result = True
        with self.assertRaises(ValueError):
            self.manager.verify_imported(ID, ACTOR)
        self.assertEqual(self.manager.read(ID)['phase'], 'recovery-required')

    def test_wrong_bridge_refuses_before_import(self):
        self.runtime.wrong_network = True
        with self.assertRaises(ValueError):
            self.stage_import()
        self.assertEqual(self.manager.read(ID)['workers']['import']['intent'], 'created')

    def test_foreign_marker_refuses(self):
        self.runtime.bad_marker = True
        with self.assertRaises(ValueError):
            self.stage_import()
        self.assertNotIn('import', self.manager.read(ID)['workers'])

    def test_changed_dump_refuses_verification(self):
        self.stage_import()
        path = self.manager._directory(ID) / 'dump/target.dump'
        path.write_bytes(b'PGDMPdifferent')
        with self.assertRaises(ValueError):
            self.manager.verify_imported(ID, ACTOR)
        self.assertNotIn('verify-imported', self.manager.read(ID)['workers'])

    def test_output_swap_during_read_refuses(self):
        self.stage_import()
        original = self.enrollment.read
        def read(path, *args, **kwargs):
            result = original(path, *args, **kwargs)
            if Path(path) == self.manager._directory(ID) / 'verification/result.json':
                Path(path).chmod(0o600)
                Path(path).write_bytes(result)
                Path(path).chmod(0o400)
            return result
        self.enrollment.read = read
        with self.assertRaises(ValueError):
            self.manager.verify_imported(ID, ACTOR)
        self.assertFalse((self.manager._directory(ID) / 'verification-receipt.json').exists())

    def test_missing_claimed_stage_blocks_abort(self):
        claim = {'schema': M.CLAIM, 'liveJobId': LIVE, 'liveAdmissionSha256': self.live.digest(self.admission), 'stageId': ID}
        with self.assertRaises((OSError, ValueError)):
            self.manager.assert_settled_for_abort(LIVE, claim, ACTOR)

    def test_abort_refuses_unknown_or_still_running_worker_without_writes(self):
        self.stage_import()
        record = self.manager.read(ID)
        worker = self.runtime.workers[record['workers']['import']['id']]
        worker['State'].update(Status='running', Running=True)
        before = (self.manager._directory(ID) / 'stage.json').read_bytes()
        with self.assertRaises(ValueError):
            self.manager.assert_settled_for_abort(LIVE, record['claim'], ACTOR)
        self.assertEqual(before, (self.manager._directory(ID) / 'stage.json').read_bytes())

    def test_comment_lost_ack_blocks_retry_and_abort(self):
        original = self.runtime.bounded_output
        def output(command, maximum, timeout):
            result = original(command, maximum, timeout)
            if command[-1].startswith('COMMENT ON DATABASE'):
                raise OSError('fixture comment acknowledgement lost')
            return result
        self.runtime.bounded_output = output
        with self.assertRaises(OSError):
            self.stage_import()
        record = self.manager.read(ID)
        self.assertEqual([row['intent'] for row in record['operations']], ['complete', 'executing'])
        with self.assertRaises(ValueError):
            self.manager.assert_settled_for_abort(LIVE, record['claim'], ACTOR)

    def test_start_lost_ack_never_adopts_exited_worker(self):
        original = self.runtime.change
        def change(command):
            original(command)
            row = self.runtime.workers[command[-1]]
            if command[0] == 'start' and row['role'] == 'import':
                raise OSError('fixture start acknowledgement lost')
        self.runtime.change = change
        with self.assertRaises(OSError):
            self.stage_import()
        record = self.manager.read(ID)
        self.assertEqual(record['workers']['import']['intent'], 'starting')
        self.assertFalse(self.runtime.workers[record['workers']['import']['id']]['State']['Running'])
        with self.assertRaises(ValueError):
            self.manager.assert_settled_for_abort(LIVE, record['claim'], ACTOR)

    def test_changed_authentication_hash_refuses_before_database_creation(self):
        path = self.live._directory(LIVE) / 'private/source-authentication.json'
        path.chmod(0o600)
        path.write_bytes(self.P.canonical({'jwtSecret': 'changed', 'passkeys': None}))
        path.chmod(0o400)
        with self.assertRaises(ValueError):
            self.stage_import()
        self.assertFalse(self.runtime.events)
        self.assertFalse((self.live._directory(LIVE) / 'import-claim.json').exists())

    def test_changed_database_epoch_refuses_binding(self):
        self.stage_import()
        self.runtime.server['postmasterEpochUs'] += 1
        with self.assertRaises(ValueError):
            self.manager.binding(ID, ACTOR)

    def test_abort_independently_checks_stored_claim(self):
        self.stage_import()
        record = self.manager.read(ID)
        path = self.live._directory(LIVE) / 'import-claim.json'
        path.chmod(0o600)
        path.write_bytes(self.P.canonical({**record['claim'], 'stageId': F.REVIEW}))
        path.chmod(0o400)
        with self.assertRaises(ValueError):
            self.manager.assert_settled_for_abort(LIVE, record['claim'], ACTOR)

    def test_capability_cannot_escape_root_operation(self):
        with self.live._checked_stage(LIVE, ACTOR) as checked:
            with checked.guard():
                pass
        with self.assertRaises(ValueError):
            with checked.guard():
                pass


if __name__ == '__main__':
    unittest.main()
