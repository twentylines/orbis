"""Production reconciliation and receipts; authenticated inspectors and engine are fixtures."""
import copy
from contextlib import contextmanager
from contextvars import ContextVar
from email.message import Message
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module


S = load('orbis-host-core-reconciliation-service.py', 'reconciliation_service_test')
F = load('test_orbis_host_core_clean_target_reconcile.py', 'reconciliation_service_real_fixtures')
A = load('orbis-host-retained-authority.py', 'reconciliation_service_publication_fixture')
ID = F.ID
PREPARATION = '31756677-7ab6-4971-ab38-5c9305d2795c'
SOURCE = '5b004731-f52c-4c27-99f3-758e2c8210c0'
DESTINATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
OTHER = 'ab404cc8-1a0b-4424-8459-b445eb6a4e2d'
ACTOR = F.ACTOR


class Workers:
    def __init__(self):
        self.jobs = []

    def __call__(self, **values):
        self.jobs.append(values)
        return SimpleNamespace(start=lambda: None)

    def run(self):
        job = self.jobs[-1]
        job['target'](*job['args'])


class ReconciliationServiceTests(unittest.TestCase):
    def setUp(self):
        self.versioned = F.VersionedReconcileTests()
        self.versioned.setUp()
        self.addCleanup(self.versioned.doCleanups)
        self.fixture = f = self.versioned.fixture
        self.inspectors, self.bootstrap, original = self.versioned.versioned_factory_fixture()
        self.bootstrap.ledger_hash = f.bootstrap.ledger_hash
        self.bootstrap.capacity = f.bootstrap.capacity
        self.enrollment = f.enrollment
        self.enrollment.P = A.P
        publish = f.runtime.publish
        def authenticated_publish(body, verify):
            publish(body, verify)
            if verify:
                return
            output = next(Path(row['Source']) for row in body['HostConfig']['Mounts'] if row['Target'] == '/clean-target-output')
            intent = json.loads((output / 'write-intent.json').read_bytes())
            prepared = intent['prepared']
            prepared['authenticationSha256'] = f.manager.approved['source']['evidence']['authenticationSha256']
            descriptor = {key: value for key, value in prepared.items() if key != 'marker'}
            prepared['marker'] = 'orbis.core-clean-target.v2/' + ID + '/' + prepared['nonce'] + '/' + f.manager.digest(descriptor)
            changes = {'write-intent.json': intent}
            for name in ('completion.json', 'result.json'):
                if (output / name).exists():
                    value = json.loads((output / name).read_bytes())
                    value['writeIntentSha256'] = f.manager.digest(intent)
                    if name == 'completion.json':
                        value['preparedSha256'] = f.manager.digest(prepared)
                    else:
                        value['prepared'] = prepared
                    changes[name] = value
            for name, value in changes.items():
                (output / name).chmod(0o600)
                (output / name).write_bytes(self.enrollment.P.canonical(value))
                (output / name).chmod(0o400)
        f.runtime.publish = authenticated_publish
        self.descriptor = os.open(f.root / 'service-test-lock', os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, self.descriptor)
        self.host_mutex = threading.Lock()
        self.host = SimpleNamespace(LOCK_DESCRIPTOR=ContextVar('reconciliation_test_lock', default=None), host_lock=self.host_lock)
        self.service = SimpleNamespace(HOST=self.host, root=f.root, context=self.enrollment.context,
                                       state_dir=self.enrollment.state, lock=threading.Lock())
        self.enterContext(mock.patch.object(S.P.F.I, 'require_root'))
        self.enterContext(mock.patch.object(S, 'R', F.M))
        self.enterContext(f.factory_boundaries())
        self.preparation = S.P.CleanTargetPreparationService(self.service, enrollment=self.enrollment)
        self.source_intent = {'sourceInspectionId': SOURCE, 'installedRuntime': {'id': OTHER,
            'installationSha256': 'd' * 64, 'sourceControllerImageId': f.runtime.controller},
            'migrationPolicySha256': 'e' * 64}
        f.broker.installed_selection = SimpleNamespace(identifier=OTHER, installation_sha256='d' * 64)
        f.broker.installed_authority = self.installed_authority
        self.handle = S.P.POLICY.B.PreparedCleanTarget(PREPARATION, original.receipt_sha256)
        self.bootstrap._checked = lambda record, actor, finalize: self.handle
        self.handoff = S.P.CheckedPreparation(self.bootstrap, self.handle, self.inspectors[0], self.source_intent)
        self.handoff_factory = self.enterContext(mock.patch.object(self.preparation, '_checked_preparation', return_value=self.handoff))
        self.destination_factory = self.enterContext(mock.patch.object(S.P.F, 'bootstrap_source_manager_for', return_value=self.inspectors[1]))
        self.workers = Workers()
        self.manager = S.CleanTargetReconciliationService(self.service, preparation=self.preparation, worker_factory=self.workers)
        self.request = {'id': ID, 'sourcePreparationId': PREPARATION, 'destinationInspectionId': DESTINATION,
                        'actor': copy.deepcopy(ACTOR), 'action': S.ACTION}
        self.observe = {'id': ID, 'actor': copy.deepcopy(ACTOR)}
        actual = F.M.CoreVersionedCleanTargetReconcile.from_inspections
        def factory(*args, **kwargs):
            manager = actual(*args, **kwargs)
            f.runtime.manager = f.manager = manager
            self.enterContext(mock.patch.object(manager, 'socket_available'))
            self.enterContext(mock.patch.object(F.M.TARGET, 'database_body', side_effect=self.versioned.target_body))
            return manager
        self.factory = self.enterContext(mock.patch.object(F.M.CoreVersionedCleanTargetReconcile, 'from_inspections', side_effect=factory))

    @contextmanager
    def installed_authority(self):
        yield

    @contextmanager
    def host_lock(self, root):
        if not self.host_mutex.acquire(blocking=False):
            raise ValueError('synthetic host contention')
        token = self.host.LOCK_DESCRIPTOR.set(self.descriptor)
        try:
            with self.fixture.guard():
                yield self.descriptor
        finally:
            self.host.LOCK_DESCRIPTOR.reset(token)
            self.host_mutex.release()

    def prepare(self):
        return self.manager.prepare(self.request, privileged_peer=True)

    def status(self):
        return self.manager.status(self.observe, privileged_peer=True)

    def finish(self):
        self.prepare()
        self.workers.run()
        result = self.status()
        self.assertEqual(result['phase'], 'reconciliation-complete')
        return result

    def test_durable_admission_claim_and_actual_versioned_receipt_before_availability(self):
        result = self.prepare()
        self.assertEqual(result['phase'], 'queued')
        self.assertTrue(result['reconciliationActive'])
        self.assertEqual(self.fixture.runtime.calls, [])
        admission = self.manager._admission(ID, ACTOR)
        intent = self.manager._intent(admission)
        self.manager._check_claim(admission, intent)
        self.assertEqual(intent['sourceInspectionId'], SOURCE)
        self.assertEqual(intent['migrationPolicySha256'], 'e' * 64)
        self.assertEqual(self.destination_factory.call_args.kwargs, {'enrollment': self.enrollment})
        self.workers.run()
        result = self.status()
        self.assertEqual(result, self.manager._public(admission, 'reconciliation-complete', available=True))
        receipt = self.fixture.manager.P.metadata(self.fixture.manager.read(self.fixture.manager.directory(ID) / 'receipt.json'))
        self.assertEqual(receipt['schema'], 'orbis.core-clean-target-reconcile-receipt.v2')
        self.assertEqual([call[0] for call in self.fixture.runtime.calls].count('start'), 4)
        self.assertEqual([call[0] for call in self.fixture.runtime.calls].count('stop'), 3)
        self.assertFalse(any(result[key] for key in ('activation', 'environmentProved', 'restoreAuthority', 'sourceWrites')))
        self.assertEqual(set(result), {'version', 'id', 'sourcePreparationId', 'destinationInspectionId', 'phase',
            'reconciliationActive', 'reconciledTargetAvailable', *S.FLAGS})

    def test_duplicate_and_lost_response_observe_without_new_worker_or_write(self):
        self.prepare()
        self.assertEqual(self.prepare()['phase'], 'queued')
        self.assertEqual(len(self.workers.jobs), 1)
        self.workers.run()
        calls = copy.deepcopy(self.fixture.runtime.calls)
        self.assertTrue(self.prepare()['reconciledTargetAvailable'])
        self.assertEqual(self.fixture.runtime.calls, calls)
        self.assertEqual(len(self.workers.jobs), 1)
        restarted = S.CleanTargetReconciliationService(self.service, preparation=self.preparation, worker_factory=self.workers)
        self.assertTrue(restarted.status(self.observe, privileged_peer=True)['reconciledTargetAvailable'])

    def test_duplicate_race_admits_only_one_worker_after_durable_request(self):
        entered, release, results, errors = threading.Event(), threading.Event(), [], []
        def handoff(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise TimeoutError('synthetic admission was not released')
            return self.handoff
        self.handoff_factory.side_effect = handoff
        def admission():
            try:
                results.append(self.prepare())
            except BaseException as error:
                errors.append(type(error).__name__)
        thread = threading.Thread(target=admission)
        thread.start()
        self.assertTrue(entered.wait(2))
        try:
            duplicate = self.prepare()
            self.assertTrue(duplicate['reconciliationActive'])
            self.assertFalse(self.workers.jobs)
        finally:
            release.set()
            thread.join(5)
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 1)
        self.assertEqual(len(self.workers.jobs), 1)
        self.assertFalse(self.fixture.runtime.calls)

    def test_lost_completion_acknowledgement_holds_without_replay(self):
        self.prepare()
        immutable = self.enrollment.immutable
        def lost(path, body):
            immutable(path, body)
            if path.name == 'complete.json':
                raise OSError('synthetic lost receipt acknowledgement')
        with mock.patch.object(self.enrollment, 'immutable', side_effect=lost):
            self.workers.run()
        self.assertTrue((self.manager._directory(ID) / 'complete.json').exists())
        self.assertEqual(self.status()['phase'], 'recovery-required')
        calls = copy.deepcopy(self.fixture.runtime.calls)
        self.assertEqual(self.prepare()['phase'], 'recovery-required')
        self.assertEqual(calls, self.fixture.runtime.calls)

    def test_interrupted_intent_and_new_id_cannot_take_over(self):
        self.prepare()
        restarted = S.CleanTargetReconciliationService(self.service, preparation=self.preparation, worker_factory=self.workers)
        self.assertEqual(restarted.status(self.observe, privileged_peer=True)['phase'], 'recovery-required')
        self.assertEqual(restarted.prepare(self.request, privileged_peer=True)['phase'], 'recovery-required')
        with self.assertRaises((ValueError, FileNotFoundError)):
            restarted.prepare({**self.request, 'id': OTHER}, privileged_peer=True)
        self.assertEqual(len(self.workers.jobs), 1)
        self.assertEqual(self.fixture.runtime.calls, [])

    def test_completed_prepared_target_has_one_durable_writer_even_after_restart(self):
        self.finish()
        restarted = S.CleanTargetReconciliationService(self.service, preparation=self.preparation, worker_factory=self.workers)
        with self.assertRaises(ValueError):
            restarted.prepare({**self.request, 'id': OTHER}, privileged_peer=True)
        self.assertFalse(self.manager._directory(OTHER).exists())
        self.assertEqual(len(self.workers.jobs), 1)

    def test_active_status_stays_available_under_shared_exclusion_and_terminal_is_still_verifying(self):
        self.prepare()
        with self.service.lock, self.host_lock(self.service.root):
            self.assertTrue(self.status()['reconciliationActive'])
        original = self.enrollment.immutable
        states = []
        def immutable(path, body):
            if path.name == 'complete.json':
                states.append(self.status())
            return original(path, body)
        with mock.patch.object(self.enrollment, 'immutable', side_effect=immutable):
            self.workers.run()
        self.assertEqual(states[0]['phase'], 'verifying-reconciliation')
        self.assertTrue(states[0]['reconciliationActive'])
        self.assertFalse(states[0]['reconciledTargetAvailable'])
        with self.service.lock:
            self.assertEqual(self.status()['phase'], 'checking')
        with self.host_lock(self.service.root):
            self.assertEqual(self.status()['phase'], 'checking')

    def test_unknown_worker_acknowledgement_preserves_receipts_and_never_recovers_or_replays(self):
        self.fixture.runtime.mode = 'uncertain'
        self.prepare()
        states = []
        failure = self.manager._failure
        def observe_failure(admission, execution):
            states.append(self.status())
            failure(admission, execution)
        self.enterContext(mock.patch.object(self.manager, '_failure', side_effect=observe_failure))
        with mock.patch.object(F.M.CoreVersionedCleanTargetReconcile, 'recover_committed', side_effect=AssertionError('no recovery RPC')):
            self.workers.run()
            self.assertEqual(self.status()['phase'], 'recovery-required')
            calls = copy.deepcopy(self.fixture.runtime.calls)
            self.assertEqual(self.prepare()['phase'], 'recovery-required')
            self.assertEqual(self.fixture.runtime.calls, calls)
        self.assertEqual(states[0]['phase'], 'verifying-reconciliation')
        self.assertTrue(states[0]['reconciliationActive'])
        self.assertTrue((self.fixture.manager.directory(ID) / 'output/write-intent.json').exists())
        with self.assertRaises(ValueError):
            self.manager.prepare({**self.request, 'id': OTHER}, privileged_peer=True)

    def test_missing_or_old_inspection_evidence_fails_before_any_execution_and_holds_admission(self):
        self.inspectors[1].schema = 'orbis.core-restore-inspection.v3'
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(self.status()['phase'], 'reconciliation-blocked')
        self.assertFalse(self.workers.jobs)
        self.assertFalse(self.fixture.runtime.calls)
        with self.assertRaises(ValueError):
            self.manager.prepare({**self.request, 'id': OTHER}, privileged_peer=True)

    def test_actor_ids_actions_and_raw_handles_are_rejected_before_admission(self):
        for request, peer in ((self.request, False), ({**self.request, 'action': 'activate'}, True),
            ({**self.request, 'sourcePreparationId': ID}, True), ({**self.request, 'destinationInspectionId': PREPARATION}, True),
            ({**self.request, 'receiptSha256': 'a' * 64}, True), ({**self.request, 'id': '../escape'}, True)):
            with self.subTest(request=request), self.assertRaises(ValueError):
                self.manager.prepare(request, privileged_peer=peer)
        self.assertFalse(self.manager._base().exists())
        self.prepare()
        changed = {'id': ID, 'actor': {**ACTOR, 'sessionBinding': 'd' * 64}}
        with self.assertRaises(ValueError):
            self.manager.status(changed, privileged_peer=True)
        with self.assertRaises(ValueError):
            self.manager.wait(changed, privileged_peer=True)

    def test_source_inspection_cannot_also_be_destination(self):
        self.source_intent['sourceInspectionId'] = DESTINATION
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.workers.jobs)
        self.assertFalse(self.fixture.runtime.calls)

    def test_catalog_drift_before_worker_prevents_dispatch_and_complete_recheck_rejects_drift(self):
        self.prepare()
        self.inspectors[1].report['bootstrapSource']['catalogUserIdentities'][0]['identitySha256'] = '0' * 64
        self.workers.run()
        self.assertEqual(self.status()['phase'], 'reconciliation-blocked')
        self.assertFalse(self.fixture.runtime.calls)

    def test_installed_generation_and_policy_are_pinned_before_execution(self):
        self.prepare()
        self.source_intent['migrationPolicySha256'] = 'f' * 64
        self.workers.run()
        self.assertEqual(self.status()['phase'], 'reconciliation-blocked')
        self.assertFalse(self.fixture.runtime.calls)

    def test_positive_completion_rechecks_actual_receipt_and_claim(self):
        self.finish()
        path = self.fixture.manager.directory(ID) / 'receipt.json'
        path.chmod(0o600)
        path.write_bytes(b'{}')
        self.assertEqual(self.status()['phase'], 'recovery-required')
        self.assertFalse(self.status()['reconciledTargetAvailable'])

    def test_orphan_corrupt_admissions_and_claims_block_new_ids(self):
        base = self.enrollment.child(self.enrollment.state, self.manager._base().name)
        orphan = self.enrollment.child(base, OTHER)
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.prepare()
        self.assertFalse(self.workers.jobs)
        self.enrollment.immutable(orphan / 'admission.json', b'{}')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.fixture.runtime.calls)

    def test_orphan_claim_without_admission_or_with_corrupt_binding_cannot_be_taken_over(self):
        claims = self.enrollment.child(self.enrollment.state, self.manager._claims().name)
        self.enrollment.immutable(claims / (PREPARATION + '.json'), self.enrollment.P.canonical(
            {'schema': S.CLAIM, 'id': OTHER, 'sourcePreparationId': PREPARATION, 'intentSha256': 'e' * 64}))
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.prepare()
        self.assertFalse(self.workers.jobs)
        self.assertFalse(self.fixture.runtime.calls)

    def test_complete_status_rechecks_generation_and_live_catalog(self):
        self.finish()
        self.fixture.broker.installed_selection.installation_sha256 = '0' * 64
        self.assertEqual(self.status()['phase'], 'recovery-required')
        self.fixture.broker.installed_selection.installation_sha256 = 'd' * 64
        point = self.fixture.root / 'library/points' / ID / 'point.json'
        point.chmod(0o600)
        point.write_bytes(self.enrollment.P.canonical({'ownerId': 2}))
        self.assertEqual(self.status()['phase'], 'recovery-required')
        self.assertFalse(self.status()['reconciledTargetAvailable'])

    def test_parent_sync_failure_has_no_daemon_or_native_execution(self):
        with mock.patch.object(self.enrollment, 'sync', side_effect=OSError('synthetic durability failure')):
            with self.assertRaises(OSError):
                self.prepare()
        self.assertFalse(self.workers.jobs)
        self.assertFalse(self.manager._active)
        self.assertFalse(self.fixture.runtime.calls)

    def test_wait_uses_condition_releases_locks_and_signals_after_real_completion(self):
        self.prepare()
        entered, done, results = threading.Event(), threading.Event(), []
        original = self.manager._condition.wait
        def wait(timeout=None):
            entered.set()
            return original(timeout)
        def observer():
            results.append(self.manager.wait(self.observe, privileged_peer=True))
            done.set()
        with mock.patch.object(self.manager._condition, 'wait', side_effect=wait) as condition_wait:
            thread = threading.Thread(target=observer)
            thread.start()
            self.assertTrue(entered.wait(2))
            self.assertTrue(self.service.lock.acquire(blocking=False))
            self.service.lock.release()
            self.workers.run()
            self.assertTrue(done.wait(5))
            thread.join(2)
            self.assertEqual(condition_wait.call_count, 1)
        self.assertEqual(results[0]['phase'], 'reconciliation-complete')

    def test_wait_timeout_keeps_owned_job_and_rejects_caller_timeout(self):
        self.prepare()
        with mock.patch.object(S, 'WAIT_SECONDS', 0):
            self.assertEqual(self.manager.wait(self.observe, privileged_peer=True)['phase'], 'queued')
        with self.assertRaises(ValueError):
            self.manager.wait({**self.observe, 'waitMs': 1}, privileged_peer=True)
        self.assertEqual(len(self.workers.jobs), 1)
        self.assertEqual(self.fixture.runtime.calls, [])


class ReconciliationRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.host = load('orbis-host-service.py', 'reconciliation_route_test_service')

    def handler(self, action):
        request = {'id': ID, 'actor': ACTOR}
        if action == 'prepare':
            request.update(sourcePreparationId=PREPARATION, destinationInspectionId=DESTINATION, action=S.ACTION)
        body = json.dumps(request).encode()
        handler = object.__new__(self.host.Handler)
        handler.path = '/v1/core-clean-target-reconciliation/' + action
        handler.headers = Message()
        handler.headers['Content-Type'] = 'application/json'
        handler.headers['Content-Length'] = str(len(body))
        handler.connection, handler.server, handler.send_json = mock.Mock(), mock.Mock(), mock.Mock()
        handler.rfile = io.BytesIO(body)
        self.enterContext(mock.patch.object(self.host, 'trusted_capture_peer', return_value=True))
        return handler, request

    def test_exact_routes_keep_async_status_codes_and_only_wait_has_long_timeout(self):
        for action in ('prepare', 'status', 'wait'):
            with self.subTest(action=action):
                handler, request = self.handler(action)
                manager = handler.server.service.core_clean_target_reconciliations.return_value
                getattr(manager, action).return_value = {'phase': 'queued'}
                handler.do_POST()
                getattr(manager, action).assert_called_once_with(request, privileged_peer=True)
                handler.send_json.assert_called_once_with(202 if action == 'prepare' else 200, {'phase': 'queued'})
                self.assertEqual([call.args[0] for call in handler.connection.settimeout.call_args_list],
                    [15, 1900] if action == 'wait' else [15])

    def test_peer_framing_and_action_guards_precede_body_read_and_factory(self):
        for kind in ('peer', 'activate', 'prepare?x=1', 'truncated', 'transfer', 'encoding', 'type',
                     'empty', 'large', 'nondecimal', 'nonascii', 'duplicate-length', 'duplicate-type'):
            with self.subTest(kind=kind):
                handler, _ = self.handler('prepare')
                if kind in {'activate', 'prepare?x=1'}:
                    handler.path = '/v1/core-clean-target-reconciliation/' + kind
                if kind in {'empty', 'large', 'nondecimal', 'nonascii', 'truncated'}:
                    value = {'empty': '0', 'large': '16385', 'nondecimal': '-1', 'nonascii': '١',
                        'truncated': str(int(handler.headers['Content-Length']) + 1)}[kind]
                    handler.headers.replace_header('Content-Length', value)
                if kind in {'transfer', 'encoding', 'type'}:
                    field = {'transfer': 'Transfer-Encoding', 'encoding': 'Content-Encoding', 'type': 'Content-Type'}[kind]
                    if kind == 'type':
                        handler.headers.replace_header(field, 'text/plain')
                    else:
                        handler.headers[field] = 'chunked' if kind == 'transfer' else 'gzip'
                if kind in {'duplicate-length', 'duplicate-type'}:
                    field = 'Content-Length' if kind == 'duplicate-length' else 'Content-Type'
                    handler.headers[field] = handler.headers[field]
                if kind != 'truncated':
                    handler.rfile = mock.Mock()
                with mock.patch.object(self.host, 'trusted_capture_peer', return_value=kind != 'peer'):
                    handler.do_POST()
                if kind != 'truncated':
                    handler.rfile.read.assert_not_called()
                handler.server.service.core_clean_target_reconciliations.assert_not_called()
                self.assertEqual(handler.send_json.call_args.args[0], 409)

    def test_singleton_and_setup_closure_retain_actual_ownership_helper(self):
        service = object.__new__(self.host.HostService)
        service.core_reconciliation_factory_lock = threading.Lock()
        service.core_reconciliation_service = None
        module = mock.Mock()
        with mock.patch.object(self.host, 'load_script', return_value=module):
            first = service.core_clean_target_reconciliations()
            self.assertIs(first, service.core_clean_target_reconciliations())
        module.CleanTargetReconciliationService.assert_called_once_with(service)
        setup = load('orbis-host-service-setup.py', 'reconciliation_route_setup_test')
        sources, _ = setup.source_files(Path(__file__).parent)
        self.assertIn('orbis-host-core-reconciliation-service.py', {path.name for path in sources})


if __name__ == '__main__':
    unittest.main()
