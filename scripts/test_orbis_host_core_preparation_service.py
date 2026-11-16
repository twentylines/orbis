"""Real private admission files and policy custody; target execution is a fixture."""
import copy
from contextlib import contextmanager
import importlib.util
from pathlib import Path
import threading
from types import SimpleNamespace
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


M = load('orbis-host-core-preparation-service.py', 'preparation_service_test')
F = load('test_orbis_host_core_preparation_policy.py', 'preparation_service_policy_fixture')
ID = '31756677-7ab6-4971-ab38-5c9305d2795c'
OTHER = 'ab404cc8-1a0b-4424-8459-b445eb6a4e2d'
SOURCE = '5b004731-f52c-4c27-99f3-758e2c8210c0'
ACTOR = {'ownerId': 1, 'sessionBinding': 'a' * 64, 'securityBinding': 'b' * 64}


class Workers:
    def __init__(self):
        self.jobs = []

    def __call__(self, **values):
        self.jobs.append(values)
        return SimpleNamespace(start=lambda: None)

    def run(self, index=0):
        job = self.jobs[index]
        job['target'](*job['args'])


class PreparationServiceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = F.MigrationPolicyTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.enrollment = self.fixture.enrollment
        self.fixture.policies.install(self.fixture.approval())
        self.inspection = self.fixture.inspection()
        selected = self.inspection.configuration.installed_selection
        self.source_record = {'schema': F.M.B.CoreVersionedCleanTargetBootstrap.inspection_schema,
            'actor': copy.deepcopy(ACTOR), 'phase': 'inspection-complete', 'installedRuntime': {
                'id': selected.identifier, 'installationSha256': selected.installation_sha256,
                'sourceControllerImageId': F.SOURCE}}
        self.inspection.record = lambda identifier: copy.deepcopy(self.source_record)
        self.enterContext(mock.patch.object(M, 'POLICY', F.M))
        self.enterContext(mock.patch.object(M.F.I, 'require_root'))
        self.source_factory = self.enterContext(mock.patch.object(M.F, 'bootstrap_source_manager_for', return_value=self.inspection))
        self.service = SimpleNamespace(root=self.enrollment.root, state_dir=self.enrollment.state,
            context=self.enrollment.context, lock=threading.Lock(), HOST=SimpleNamespace(host_lock=self.host_lock))
        self.guard_depth = 0
        self.workers, self.records = Workers(), {}
        self.prepare_calls, self.checked_calls, self.factories = 0, 0, []
        self.capacity_error, self.prepare_error, self.checked_error = False, False, False
        self.entered, self.resume = None, None
        self.enterContext(mock.patch.object(F.M.B.CoreVersionedCleanTargetBootstrap, 'from_source_inspection', side_effect=self.factory))
        self.manager = self.coordinator()

    @contextmanager
    def host_lock(self, root):
        self.assertEqual(root, self.service.root)
        self.guard_depth += 1
        try:
            yield
        finally:
            self.guard_depth -= 1

    def coordinator(self):
        return M.CleanTargetPreparationService(self.service, enrollment=self.enrollment, worker_factory=self.workers)

    def factory(self, *args, **values):
        guard = values['guard']
        self.factories.append(values)
        test = self

        class Bootstrap:
            def validate(self, actor):
                test.assertEqual(test.guard_depth, 1)
                test.assertEqual(actor, ACTOR)

            def record(self, identifier):
                if identifier not in test.records:
                    raise FileNotFoundError(identifier)
                return copy.deepcopy(test.records[identifier])

            def capacity(self, directory):
                if test.capacity_error:
                    raise ValueError('capacity fixture')

            def prepare(self, identifier, actor):
                with guard():
                    test.assertEqual(test.guard_depth, 1)
                    test.prepare_calls += 1
                    test.records[identifier] = {'phase': 'initializing'}
                    if test.entered:
                        test.entered.set()
                        if not test.resume.wait(5):
                            raise ValueError('test did not release worker')
                    if test.prepare_error:
                        raise ValueError('execution fixture')
                    test.records[identifier] = {'phase': 'complete'}
                    return F.M.B.PreparedCleanTarget(identifier, 'c' * 64)

            def checked(self, prepared, actor):
                with guard():
                    test.assertEqual(test.guard_depth, 1)
                    test.assertEqual(prepared.receipt_sha256, 'c' * 64)
                    test.checked_calls += 1
                    if test.checked_error:
                        raise ValueError('receipt fixture')
                    return prepared

        return Bootstrap()

    def request(self, identifier=ID):
        return {'id': identifier, 'sourceInspectionId': SOURCE, 'actor': copy.deepcopy(ACTOR), 'action': M.ACTION}

    def prepare(self, identifier=ID):
        return self.manager.prepare(self.request(identifier), privileged_peer=True)

    def status(self, manager=None, actor=None):
        return (manager or self.manager).status({'id': ID, 'actor': actor or ACTOR}, privileged_peer=True)

    def test_admission_is_durable_and_returns_before_target_execution(self):
        result = self.prepare()
        self.assertEqual(result['phase'], 'queued')
        self.assertTrue(result['preparationActive'])
        self.assertFalse(result['preparedTargetAvailable'])
        self.assertEqual(self.prepare_calls, 0)
        self.assertEqual(len(self.workers.jobs), 1)
        intent = self.manager._intent(ID)
        self.assertEqual(intent['migrationPolicySha256'], self.fixture.policies.digest(self.fixture.policies.read(self.fixture.selection, F.SOURCE)))
        self.assertEqual(intent['sourceRecordSha256'], self.manager._digest(self.source_record))
        directory = self.manager._directory(ID)
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual((directory / 'intent.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.status(), result)
        self.assertNotIn('enrollment', self.source_factory.call_args.kwargs)

    def test_duplicate_request_observes_without_replaying(self):
        self.prepare()
        self.prepare()
        self.assertEqual(len(self.workers.jobs), 1)
        self.workers.run()
        self.assertEqual(self.prepare_calls, 1)
        self.assertTrue(self.prepare()['preparedTargetAvailable'])
        self.assertEqual(len(self.workers.jobs), 1)

    def test_first_index_and_job_are_synced_before_worker_admission(self):
        events = []
        original = self.enrollment.sync
        def sync(directory):
            original(directory)
            events.append(Path(directory))
        with mock.patch.object(self.enrollment, 'sync', side_effect=sync):
            self.prepare()
        state = Path(self.enrollment.state)
        self.assertEqual(events[:2], [state, state / 'core-clean-target-preparations'])
        self.assertEqual(self.prepare_calls, 0)

    def test_peer_action_identifiers_and_exact_request_precede_disk_work(self):
        requests = [(self.request(), False), ({**self.request(), 'action': 'authorize-core-inspection-only'}, True),
            ({**self.request(), 'id': SOURCE}, True), ({**self.request(), 'id': '../escape'}, True),
            ({**self.request(), 'path': '/arbitrary'}, True)]
        for request, peer in requests:
            with self.subTest(request=request), self.assertRaises(ValueError):
                self.manager.prepare(request, privileged_peer=peer)
        self.source_factory.assert_not_called()
        self.assertFalse((self.enrollment.state / 'core-clean-target-preparations').exists())
        self.assertFalse(self.workers.jobs)

    def test_source_schema_actor_phase_and_generation_are_not_promoted(self):
        initial = copy.deepcopy(self.source_record)
        for changes in ({'schema': 'orbis.core-restore-inspection.v2'}, {'actor': {**ACTOR, 'ownerId': 2}},
                        {'phase': 'inspection-authorized'}, {'installedRuntime': {**initial['installedRuntime'], 'installationSha256': '9' * 64}}):
            self.source_record = {**initial, **changes}
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.prepare()
        self.assertFalse(self.workers.jobs)
        self.assertFalse((self.enrollment.state / 'core-clean-target-preparations').exists())

    def test_missing_migration_policy_is_not_inspection_authority(self):
        self.fixture.path().unlink()
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.workers.jobs)

    def test_restarted_service_does_not_replay_queued_work(self):
        self.prepare()
        restarted = self.coordinator()
        result = self.status(restarted)
        self.assertEqual(result['phase'], 'recovery-required')
        self.assertFalse(result['preparationActive'])
        self.assertFalse(result['preparedTargetAvailable'])
        self.assertEqual(len(self.workers.jobs), 1)
        with self.assertRaises(ValueError):
            restarted.prepare(self.request(OTHER), privileged_peer=True)

    def test_thread_start_failure_leaves_recoverable_intent(self):
        self.manager.worker_factory = mock.Mock(return_value=SimpleNamespace(start=mock.Mock(side_effect=RuntimeError('start fixture'))))
        with self.assertRaises(RuntimeError):
            self.prepare()
        self.assertEqual(self.status()['phase'], 'recovery-required')
        self.assertFalse(self.manager._active)
        self.assertEqual(self.prepare_calls, 0)

    def test_active_status_is_readable_during_the_exclusive_operation(self):
        self.prepare()
        self.entered, self.resume = threading.Event(), threading.Event()
        worker = threading.Thread(target=self.workers.run)
        worker.start()
        self.addCleanup(worker.join, 5)
        self.addCleanup(self.resume.set)
        self.assertTrue(self.entered.wait(5))
        self.assertTrue(self.service.lock.locked())
        result = self.status()
        self.assertEqual(result['phase'], 'initializing')
        self.assertTrue(result['preparationActive'])
        self.assertFalse(result['preparedTargetAvailable'])
        self.resume.set()
        worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertTrue(self.status()['preparedTargetAvailable'])

    def test_queued_worker_waits_for_intervening_operation_without_losing_job(self):
        self.prepare()
        self.service.lock.acquire()
        worker = threading.Thread(target=self.workers.run)
        worker.start()
        try:
            self.assertEqual(self.status()['phase'], 'queued')
            self.assertTrue(self.status()['preparationActive'])
        finally:
            self.service.lock.release()
        worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertTrue(self.status()['preparedTargetAvailable'])

    def test_wait_signals_on_completion_without_holding_operation_or_ownership_locks(self):
        self.prepare()
        entered, done = threading.Event(), threading.Event()
        results = []
        original = self.manager._condition.wait
        def wait(timeout=None):
            entered.set()
            return original(timeout)
        def observer():
            results.append(self.manager.wait({'id': ID, 'actor': ACTOR}, privileged_peer=True))
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
        self.assertEqual(results[0], self.status())
        self.assertTrue(results[0]['preparedTargetAvailable'])

    def test_wait_timeout_retains_owned_worker_and_validates_peer_actor_and_exact_fields(self):
        self.prepare()
        request = {'id': ID, 'actor': ACTOR}
        for changed, peer in ((request, False), ({**request, 'waitMs': 1}, True),
                              ({**request, 'id': '../escape'}, True),
                              ({**request, 'actor': {**ACTOR, 'sessionBinding': 'c' * 64}}, True)):
            with self.subTest(request=changed, peer=peer), self.assertRaises(ValueError):
                self.manager.wait(changed, privileged_peer=peer)
        with mock.patch.object(M, 'WAIT_SECONDS', 0):
            self.assertEqual(self.manager.wait(request, privileged_peer=True), self.status())
        self.assertEqual(len(self.workers.jobs), 1)
        self.assertTrue(self.status()['preparationActive'])
        self.workers.run()
        self.assertTrue(self.manager.wait(request, privileged_peer=True)['preparedTargetAvailable'])

    def test_wait_failure_and_restart_are_terminal_observations_without_replay(self):
        self.prepare()
        self.prepare_error = True
        self.workers.run()
        restarted = self.coordinator()
        result = restarted.wait({'id': ID, 'actor': ACTOR}, privileged_peer=True)
        self.assertEqual(result['phase'], 'recovery-required')
        self.assertFalse(result['preparationActive'])
        self.assertEqual(self.prepare_calls, 1)
        self.assertEqual(len(self.workers.jobs), 1)

    def test_wait_returns_checked_completion_state_including_contention_or_changed_receipt(self):
        self.prepare()
        self.workers.run()
        request = {'id': ID, 'actor': ACTOR}
        with self.service.lock:
            result = self.manager.wait(request, privileged_peer=True)
        self.assertEqual(result['phase'], 'checking')
        self.assertFalse(result['preparedTargetAvailable'])
        self.checked_error = True
        self.assertEqual(self.manager.wait(request, privileged_peer=True)['phase'], 'recovery-required')

    def test_private_checked_handoff_requires_durable_completion_and_rechecks_policy_and_receipt(self):
        self.prepare()
        with self.assertRaises(ValueError):
            self.manager._checked_preparation(ID, ACTOR, self.host_lock_guard)
        self.workers.run()
        with self.manager._operation() as guard:
            checked = self.manager._checked_preparation(ID, ACTOR, guard)
            self.assertIs(type(checked), M.CheckedPreparation)
            self.assertEqual(checked.prepared_target.identifier, ID)
            self.assertIs(checked.source_inspection, self.inspection)
            self.assertEqual(checked.intent, self.manager._intent(ID))
            self.checked_error = True
            with self.assertRaises(ValueError):
                self.manager._checked_preparation(ID, ACTOR, guard)
        call = self.source_factory.call_args
        self.assertIs(call.kwargs['enrollment'], self.enrollment)

    @contextmanager
    def host_lock_guard(self):
        yield

    def test_capacity_failure_before_target_allows_a_fresh_job(self):
        self.prepare()
        self.capacity_error = True
        self.workers.run()
        self.assertEqual(self.status()['phase'], 'preparation-blocked')
        self.assertEqual(self.prepare_calls, 0)
        self.capacity_error = False
        self.assertEqual(self.prepare(OTHER)['phase'], 'queued')

    def test_bounded_queue_timeout_records_pre_execution_failure(self):
        self.prepare()
        lock = mock.Mock()
        lock.acquire.return_value = False
        with mock.patch.object(self.service, 'lock', lock):
            self.workers.run()
        lock.acquire.assert_called_once_with(timeout=30)
        lock.release.assert_not_called()
        self.assertEqual(self.status()['phase'], 'preparation-blocked')
        self.assertEqual(self.prepare_calls, 0)
        self.assertEqual(self.prepare(OTHER)['phase'], 'queued')

    def test_nonblocking_host_contention_before_execution_records_blocked(self):
        self.prepare()
        with mock.patch.object(self.service.HOST, 'host_lock', side_effect=ValueError('host operation fixture')):
            self.workers.run()
        self.assertEqual(self.status()['phase'], 'preparation-blocked')
        self.assertFalse(self.manager._active)
        self.assertEqual(self.prepare_calls, 0)

    def test_revocation_before_execution_never_runs_target(self):
        self.prepare()
        self.fixture.policies.registry.revoke(self.fixture.selection)
        self.workers.run()
        self.assertEqual(self.status()['phase'], 'preparation-blocked')
        self.assertEqual(self.prepare_calls, 0)

    def test_preparation_failure_is_never_hidden_by_a_complete_marker(self):
        self.prepare()
        self.workers.run()
        intent = self.manager._intent(ID)
        failure = {'schema': M.FAILURE, 'id': ID, 'intentSha256': self.manager._digest(intent),
                   'failureClass': 'ExitGuardError', 'targetExecutionAdmitted': True, **M.FLAGS}
        self.enrollment.immutable(self.manager._directory(ID) / 'failure.json', self.manager.P.canonical(failure))
        self.assertEqual(self.status()['phase'], 'recovery-required')
        self.assertFalse(self.status()['preparedTargetAvailable'])

    def test_failure_after_target_admission_blocks_fresh_jobs(self):
        self.prepare()
        self.prepare_error = True
        self.workers.run()
        self.assertEqual(self.status()['phase'], 'recovery-required')
        with self.assertRaises(ValueError):
            self.prepare(OTHER)
        self.assertEqual(self.prepare_calls, 1)

    def test_existing_target_record_never_replays_or_permits_fresh_work(self):
        self.prepare()
        self.records[ID] = {'phase': 'initializing'}
        self.workers.run()
        self.assertEqual(self.status()['phase'], 'recovery-required')
        with self.assertRaises(ValueError):
            self.prepare(OTHER)
        self.assertEqual(self.prepare_calls, 0)

    def test_source_record_changed_after_admission_stops_before_execution(self):
        self.prepare()
        self.source_record['unexpected'] = True
        self.workers.run()
        self.assertEqual(self.status()['phase'], 'preparation-blocked')
        self.assertEqual(self.prepare_calls, 0)

    def test_completed_status_rechecks_receipt_and_expired_guard_refuses(self):
        self.prepare()
        self.workers.run()
        before = self.checked_calls
        self.assertTrue(self.status()['preparedTargetAvailable'])
        self.assertGreater(self.checked_calls, before)
        with self.assertRaises(ValueError):
            with self.factories[-1]['guard']():
                self.fail('expired guard admitted work')
        self.checked_error = True
        self.assertEqual(self.status()['phase'], 'recovery-required')

    def test_complete_is_not_available_while_another_operation_holds_exclusion(self):
        self.prepare()
        self.workers.run()
        with self.service.lock:
            result = self.status()
        self.assertEqual(result['phase'], 'checking')
        self.assertFalse(result['preparedTargetAvailable'])

    def test_actor_change_never_reads_or_reuses_another_sessions_job(self):
        self.prepare()
        for changes in ({'ownerId': 2}, {'sessionBinding': 'd' * 64}, {'securityBinding': 'e' * 64}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.status(actor={**ACTOR, **changes})

    def test_completion_and_intent_flags_require_exact_types(self):
        self.prepare()
        self.workers.run()
        directory = self.manager._directory(ID)
        for filename in ('complete.json', 'intent.json'):
            path = directory / filename
            body = path.read_bytes()
            record = self.manager.P.metadata(body)
            path.write_bytes(self.manager.P.canonical({**record, 'activation': 0}))
            with self.subTest(filename=filename), self.assertRaises(ValueError):
                self.status()
            path.write_bytes(body)


if __name__ == '__main__':
    unittest.main()
