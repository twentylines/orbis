"""Coordinator ownership and progress; worker execution and Root are explicit seams."""
import copy
from contextlib import contextmanager
import importlib.util
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location('bootstrap_inspection_service_test',
    Path(__file__).with_name('orbis-host-core-bootstrap-inspection-service.py'))
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)
ID = 'a71c77d2-f420-440e-951b-083209514e72'
POINT = 'd5d82d7c-1f6a-429e-90ea-787833c06fe3'
ACTOR = {'ownerId': 1, 'sessionBinding': 'a' * 64, 'securityBinding': 'b' * 64}


class CoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(self.temp)
        self.operation_depth = 0
        self.authority_depth = 0
        self.events = []
        self.service = SimpleNamespace(root=self.root, lock=threading.Lock(),
            HOST=SimpleNamespace(host_lock=mock.Mock(side_effect=self.operation)))
        self.coordinator = S.BootstrapSourceInspectionService(self.service)
        self.enterContext(mock.patch.object(S.FACTORY.I, 'require_root'))
        self.record = self.make_record('awaiting-approval')
        self.worker_request = {'id': ID, 'permitSha256': 'c' * 64}
        self.manager = SimpleNamespace(
            configuration=SimpleNamespace(installed_authority=self.authority),
            P=SimpleNamespace(exact=lambda body, keys: isinstance(body, dict) and set(body) == set(keys)),
            enrollment=SimpleNamespace(actor=copy.deepcopy, json=mock.Mock(return_value=self.worker_request)),
            runtime_authority=self.authority, record=mock.Mock(side_effect=self.read_record),
            directory=lambda identifier: self.root / identifier,
            public=mock.Mock(side_effect=self.public), prepare=mock.Mock(side_effect=self.prepare),
            approve=mock.Mock(side_effect=self.approve), claim_execution=mock.Mock(side_effect=self.claim),
            bootstrap_catalog=mock.Mock(side_effect=self.catalog), status=mock.Mock(side_effect=self.legacy_status))
        self.factory = self.enterContext(mock.patch.object(S.FACTORY, 'bootstrap_source_manager_for', return_value=self.manager))
        self.supervisor = mock.Mock()
        self.supervisor.run_workers.side_effect = self.run_workers
        self.supervisor_factory = self.enterContext(mock.patch.object(S.EXECUTOR, 'InspectionSupervisor', return_value=self.supervisor))
        self.request = {'id': ID, 'pointId': POINT, 'actor': ACTOR}
        self.approval = {'id': ID, 'actor': ACTOR, 'reviewSha256': 'd' * 64,
                         'approvalNonce': 'e' * 64, 'executionConsent': {'scope': 'inspection-only'},
                         'action': 'authorize-core-inspection-only'}

    def make_record(self, phase):
        return {'schema': 'orbis.core-restore-inspection.v4', 'id': ID, 'actor': copy.deepcopy(ACTOR),
                'pointId': POINT, 'phase': phase, 'scope': 'inspection-only', 'activationAuthorized': False,
                'evidence': {'source': {'pointId': POINT}, 'profile': {'profileId': 'fixture'}}}

    @contextmanager
    def operation(self, root):
        self.assertEqual(root, self.root)
        self.assertFalse(self.service.lock.acquire(blocking=False))
        self.operation_depth += 1
        try:
            yield
        finally:
            self.operation_depth -= 1

    @contextmanager
    def authority(self):
        self.authority_depth += 1
        try:
            yield
        finally:
            self.authority_depth -= 1

    def read_record(self, identifier):
        self.assertEqual(identifier, ID)
        if self.record is None:
            raise FileNotFoundError()
        return copy.deepcopy(self.record)

    def public(self, record):
        held = {'preparing', 'authorizing', 'inspecting', 'inspection-complete'}
        return {'schema': record['schema'], 'version': 4, 'id': ID,
                'phase': 'recovery-required' if record['phase'] in held else record['phase'],
                'scope': 'inspection-only', 'restoreSupported': False, 'activationAuthorized': False,
                'workerExecutionAvailable': False}

    def prepare(self, request, *, privileged_peer):
        self.assertTrue(privileged_peer)
        self.assertEqual(self.operation_depth, 1)
        self.record = self.make_record('awaiting-approval')
        return self.public(self.record)

    def approve(self, request, *, privileged_peer):
        self.assertTrue(privileged_peer)
        self.assertEqual(self.operation_depth, 1)
        self.assertGreater(self.authority_depth, 0)
        if self.record['phase'] != 'awaiting-approval' or request != self.approval:
            raise ValueError('fresh approval required')
        self.events.append('approve')
        self.record['phase'] = 'inspection-authorized'

    def claim(self, identifier, actor):
        self.assertEqual((identifier, actor), (ID, ACTOR))
        self.assertEqual(self.record['phase'], 'inspection-authorized')
        self.events.append('claim')
        self.record['phase'] = 'inspecting'
        return copy.deepcopy(self.record)

    def run_workers(self, directory, profile, request):
        self.assertEqual(self.operation_depth, 1)
        self.assertGreater(self.authority_depth, 0)
        self.assertEqual(directory, self.root / ID / 'execution')
        self.assertEqual(profile, self.record['evidence']['profile'])
        self.assertEqual(request, self.worker_request)
        self.events.append('workers')
        self.record['phase'] = 'inspection-complete'

    def catalog(self, identifier, actor):
        self.assertEqual((identifier, actor), (ID, ACTOR))
        self.assertEqual(self.record['phase'], 'inspection-complete')
        self.assertGreater(self.authority_depth, 0)
        self.events.append('catalog')
        return {'restoreAuthority': False}

    def legacy_status(self, request, *, privileged_peer):
        self.assertTrue(privileged_peer)
        if self.record['phase'] == 'inspection-complete':
            raise AssertionError('completed PGDATA must not use pre-start inventory validation')
        return self.public(self.record)

    def assert_no_restore(self, result):
        self.assertEqual(result['scope'], 'inspection-only')
        self.assertIs(result['restoreSupported'], False)
        self.assertIs(result['activationAuthorized'], False)

    def test_fresh_prepare_advertises_only_approved_inspection_execution(self):
        self.record = None
        result = self.coordinator.prepare(self.request, privileged_peer=True)
        self.assertEqual(result['phase'], 'awaiting-approval')
        self.assertTrue(result['workerExecutionAvailable'])
        self.assertFalse(result['bootstrapCatalogAvailable'])
        self.assert_no_restore(result)
        self.supervisor_factory.assert_not_called()

    def test_approval_claim_workers_and_verified_catalog_are_ordered_under_exclusion(self):
        result = self.coordinator.approve(self.approval, privileged_peer=True)
        self.assertEqual(self.events, ['approve', 'claim', 'workers', 'catalog'])
        self.assertEqual(result['phase'], 'inspection-complete')
        self.assertTrue(result['bootstrapCatalogAvailable'])
        self.assertFalse(result['workerExecutionAvailable'])
        self.assert_no_restore(result)
        self.assertEqual(self.operation_depth, 0)
        self.assertEqual(self.authority_depth, 0)

    def test_invalid_or_repeated_approval_never_reaches_execution(self):
        with self.assertRaises(ValueError):
            self.coordinator.approve(self.approval | {'approvalNonce': 'f' * 64}, privileged_peer=True)
        self.manager.claim_execution.assert_not_called()
        self.supervisor_factory.assert_not_called()
        self.coordinator.approve(self.approval, privileged_peer=True)
        with self.assertRaises(ValueError):
            self.coordinator.approve(self.approval, privileged_peer=True)
        self.assertEqual(self.supervisor.run_workers.call_count, 1)

    def test_untrusted_peer_never_reaches_factory_or_runtime_lock(self):
        for action, request in (('prepare', self.request), ('approve', self.approval), ('status', {'id': ID, 'actor': ACTOR})):
            with self.subTest(action=action), self.assertRaises(ValueError):
                getattr(self.coordinator, action)(request)
        self.factory.assert_not_called()
        self.service.HOST.host_lock.assert_not_called()

    def test_missing_installed_authority_cannot_approve_or_claim(self):
        self.manager.configuration.installed_authority = None
        with self.assertRaises(ValueError):
            self.coordinator.approve(self.approval, privileged_peer=True)
        self.manager.approve.assert_not_called()
        self.manager.claim_execution.assert_not_called()

    def test_repeated_prepare_never_makes_abandoned_work_look_active(self):
        for phase in ('preparing', 'authorizing', 'inspection-authorized', 'inspecting'):
            self.record = self.make_record(phase)
            with self.subTest(phase=phase):
                result = self.coordinator.prepare(self.request, privileged_peer=True)
                self.assertEqual(result['phase'], 'recovery-required')
                self.assertFalse(result['workerExecutionAvailable'])
                self.assertFalse(result['bootstrapCatalogAvailable'])
        self.manager.prepare.assert_not_called()
        self.supervisor_factory.assert_not_called()

    def test_failed_worker_stays_held_and_is_never_replayed(self):
        self.supervisor.run_workers.side_effect = ValueError('worker exit is unknown')
        with self.assertRaises(ValueError):
            self.coordinator.approve(self.approval, privileged_peer=True)
        result = self.coordinator.status({'id': ID, 'actor': ACTOR}, privileged_peer=True)
        self.assertEqual(result['phase'], 'recovery-required')
        self.assertFalse(result['bootstrapCatalogAvailable'])
        self.assertEqual(self.record['phase'], 'inspecting')
        with self.assertRaises(ValueError):
            self.coordinator.approve(self.approval, privileged_peer=True)
        self.assertEqual(self.supervisor.run_workers.call_count, 1)

    def test_completed_status_rechecks_terminal_catalog_without_prestart_reads(self):
        self.record = self.make_record('inspection-complete')
        result = self.coordinator.status({'id': ID, 'actor': ACTOR}, privileged_peer=True)
        self.assertEqual(result['phase'], 'inspection-complete')
        self.assertTrue(result['bootstrapCatalogAvailable'])
        self.manager.status.assert_not_called()
        self.service.HOST.host_lock.assert_not_called()
        self.supervisor_factory.assert_not_called()
        self.assert_no_restore(result)

    def test_changed_catalog_or_completed_record_cannot_report_readiness(self):
        self.record = self.make_record('inspection-complete')
        self.manager.bootstrap_catalog.side_effect = ValueError('terminal custody changed')
        with self.assertRaises(ValueError):
            self.coordinator.status({'id': ID, 'actor': ACTOR}, privileged_peer=True)
        self.manager.public.assert_not_called()
        def change_record(*args):
            self.record['changed'] = True
        self.manager.bootstrap_catalog.side_effect = change_record
        with self.assertRaises(ValueError):
            self.coordinator.status({'id': ID, 'actor': ACTOR}, privileged_peer=True)
        self.manager.public.assert_not_called()

    def test_status_rejects_another_actor_or_caller_selected_paths(self):
        for request in ({'id': ID, 'actor': ACTOR | {'ownerId': 2}},
                        {'id': ID, 'actor': ACTOR, 'executionDirectory': '/untrusted'}):
            with self.subTest(request=request), self.assertRaises(ValueError):
                self.coordinator.status(request, privileged_peer=True)
        self.manager.bootstrap_catalog.assert_not_called()

    def test_status_remains_available_while_worker_holds_operation_lock(self):
        started, finish, status_done = threading.Event(), threading.Event(), threading.Event()
        failures, responses = [], []
        def worker(*args):
            started.set()
            if not finish.wait(5):
                raise AssertionError('worker test was not released')
            self.run_workers(*args)
        self.supervisor.run_workers.side_effect = worker
        def approve():
            try:
                self.coordinator.approve(self.approval, privileged_peer=True)
            except BaseException as error:
                failures.append(error)
        def status():
            try:
                responses.append(self.coordinator.status({'id': ID, 'actor': ACTOR}, privileged_peer=True))
            except BaseException as error:
                failures.append(error)
            finally:
                status_done.set()
        execution = threading.Thread(target=approve, daemon=True)
        execution.start()
        self.assertTrue(started.wait(2))
        reader = threading.Thread(target=status, daemon=True)
        reader.start()
        try:
            self.assertTrue(status_done.wait(2), 'status waited for the runtime operation lock')
            self.assertEqual(responses[0]['phase'], 'inspecting')
            self.assertFalse(responses[0]['bootstrapCatalogAvailable'])
            self.assertTrue(responses[0]['workerExecutionAvailable'])
            self.assert_no_restore(responses[0])
        finally:
            finish.set()
            execution.join(3)
            reader.join(3)
        self.assertFalse(execution.is_alive())
        self.assertFalse(reader.is_alive())
        self.assertEqual(failures, [])


if __name__ == '__main__':
    unittest.main()
