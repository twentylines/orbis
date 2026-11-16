"""Durable Root enrollment over production installer files and synthetic engine I/O."""
import copy
from contextlib import contextmanager
from contextvars import ContextVar
import importlib.util
import os
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


S = load('orbis-host-core-runtime-service.py', 'runtime_enrollment_service_test')
F = load('test_orbis_host_core_runtime_install.py', 'runtime_enrollment_installer_fixture')
ID = 'a71c77d2-f420-440e-951b-083209514e72'
ACTOR = {'ownerId': 17, 'sessionBinding': 'b' * 64, 'securityBinding': 'c' * 64}


class DeferredWorker:
    def __init__(self, *, target, args, daemon):
        self.target, self.args, self.daemon = target, args, daemon
        self.started = False

    def start(self):
        self.started = True

    def run(self):
        self.target(*self.args)


class RuntimeServiceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = F.RuntimeInstallTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.enrollment = self.fixture.enrollment
        self.descriptor = os.open(self.enrollment.state / 'test-host-lock', os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, self.descriptor)
        self.host_mutex = threading.Lock()
        self.host = SimpleNamespace(LOCK_DESCRIPTOR=ContextVar('runtime_test_lock', default=None))
        self.host.host_lock = self.host_lock
        self.service = SimpleNamespace(HOST=self.host, root=self.enrollment.root, context=self.enrollment.context,
            state_dir=self.enrollment.state, lock=threading.Lock(), current_manifest=lambda: copy.deepcopy(self.fixture.publication))
        self.enterContext(mock.patch.object(S.R.POLICY.I, 'require_root'))
        original = S.R.ReleaseRuntimeInstaller

        def installer(enrollment, publication, guard):
            @contextmanager
            def checked_guard():
                with guard(), self.fixture.guard():
                    yield
            return original(enrollment, publication, checked_guard, verify_release=self.fixture.verifier)

        self.installer = self.enterContext(mock.patch.object(S.R, 'ReleaseRuntimeInstaller', side_effect=installer))
        self.manager = S.CoreRuntimeEnrollmentService(self.service, enrollment=self.enrollment, worker_factory=DeferredWorker)
        self.request = {'id': ID, 'actor': copy.deepcopy(ACTOR), 'action': S.ACTION}
        self.observe = {'id': ID, 'actor': copy.deepcopy(ACTOR)}

    @contextmanager
    def host_lock(self, root):
        self.assertEqual(root, self.service.root)
        if not self.host_mutex.acquire(blocking=False):
            raise ValueError('synthetic host exclusion contention')
        token = self.host.LOCK_DESCRIPTOR.set(self.descriptor)
        try:
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
        self.manager._active[ID].run()
        self.assertTrue((self.manager._directory(ID) / 'complete.json').exists())
        return self.status()

    def test_admission_persists_intent_before_deferred_daemon_and_duplicate_never_replays(self):
        self.assertEqual(self.prepare(), self.manager._public(ID, 'preparing'))
        worker = self.manager._active[ID]
        self.assertTrue(worker.started and worker.daemon)
        self.assertEqual(self.manager._intent(ID, ACTOR)['action'], S.ACTION)
        self.assertEqual(self.fixture.created, 0)
        self.assertEqual(self.prepare()['phase'], 'preparing')
        self.assertIs(self.manager._active[ID], worker)
        self.installer.assert_not_called()
        with self.service.lock, self.host_lock(self.service.root):
            self.assertEqual(self.status()['phase'], 'preparing')
            self.assertTrue(self.status()['enrollmentActive'])
        worker.run()
        self.assertEqual(self.prepare()['phase'], 'installed')
        self.assertEqual(self.fixture.created, 1)

    def test_actual_installer_generation_policy_and_cached_receipt_are_freshly_required(self):
        result = self.finish()
        self.assertEqual(result, self.manager._public(ID, 'installed'))
        self.assertEqual(set(result), {'version', 'id', 'phase', 'enrollmentActive', 'runtimeAvailable', *S.FLAGS})
        receipt = self.manager._read(ID, 'complete.json')
        self.assertEqual(receipt['intentSha256'], self.manager._sha(self.manager._intent(ID, ACTOR)))
        pointer = self.fixture.manager.registry.base / 'current.json'
        pointer.unlink()
        self.assertEqual(self.status()['phase'], 'recovery-required')
        self.assertEqual(self.prepare()['phase'], 'recovery-required')
        self.assertEqual(self.fixture.created, 1)

    def test_completed_checks_return_checking_under_either_exclusion_without_claiming_availability(self):
        self.finish()
        with self.service.lock:
            self.assertEqual(self.status(), self.manager._public(ID, 'checking'))
        with self.host_lock(self.service.root):
            self.assertEqual(self.status(), self.manager._public(ID, 'checking'))
        self.assertEqual(self.status()['phase'], 'installed')

    def test_changed_publication_policy_or_code_cannot_reuse_complete_receipt(self):
        self.finish()
        self.fixture.publication['digest'] = 'sha256:' + '7' * 64
        self.assertEqual(self.status()['phase'], 'recovery-required')
        self.fixture.publication['digest'] = 'sha256:' + '6' * 64
        receipt = self.manager._read(ID, 'complete.json')
        generation = self.fixture.manager.registry.base / 'generations' / receipt['result']['installedRuntime']['id']
        policy = generation / 'clean-target-migrations' / (F.IMAGE[7:] + '.json')
        policy.unlink()
        self.assertEqual(self.status()['phase'], 'recovery-required')

    def test_changed_installed_worker_bytes_and_completion_receipt_are_recovery_holds(self):
        self.finish()
        receipt = self.manager._read(ID, 'complete.json')
        selection = S.R.POLICY.I.InstalledSelection(receipt['result']['installedRuntime']['id'],
                                                   receipt['result']['installedRuntime']['installationSha256'])
        broker = S.R.POLICY.CleanTargetMigrationPolicies(self.enrollment).registry.configuration(F.IMAGE, selection)
        # Registry generations are private; an inode changed after enrollment
        # must invalidate availability even with unchanged manifest metadata.
        code = broker.trust.code_directory / 'core-inspection-worker.mjs'
        code.chmod(0o600)
        code.write_bytes(b'export const changed = true;')
        self.assertEqual(self.status()['phase'], 'recovery-required')
        completion = self.manager._directory(ID) / 'complete.json'
        completion.chmod(0o600)
        completion.write_bytes(b'{}')
        self.assertEqual(self.status()['phase'], 'recovery-required')

    def test_installer_held_guard_cannot_be_redeemed_after_worker_or_on_another_thread(self):
        self.finish()
        guard = self.installer.call_args_list[0].args[2]
        with self.assertRaises(ValueError), guard():
            pass
        errors = []
        def other_thread():
            token = self.host.LOCK_DESCRIPTOR.set(self.descriptor)
            try:
                with guard():
                    pass
            except ValueError:
                errors.append('rejected')
            finally:
                self.host.LOCK_DESCRIPTOR.reset(token)
        with self.service.lock:
            thread = threading.Thread(target=other_thread)
            thread.start()
            thread.join(2)
        self.assertEqual(errors, ['rejected'])

    def test_current_source_rechecked_after_install_and_mismatch_never_completes(self):
        original = self.fixture.engine
        def engine(method, route, *args, **kwargs):
            result = original(method, route, *args, **kwargs)
            if method == 'DELETE':
                self.fixture.publication['tag'] = 'v0.8.0-beta.4'
            return result
        self.enrollment.runtime.engine.side_effect = engine
        self.prepare()
        self.manager._active[ID].run()
        self.assertEqual(self.status()['phase'], 'recovery-required')
        self.assertFalse((self.manager._directory(ID) / 'complete.json').exists())

    def test_interrupted_intent_has_no_active_owner_and_never_autoruns(self):
        self.prepare()
        recovered = S.CoreRuntimeEnrollmentService(self.service, enrollment=self.enrollment, worker_factory=DeferredWorker)
        self.assertEqual(recovered.status(self.observe, privileged_peer=True)['phase'], 'recovery-required')
        self.assertEqual(recovered.prepare(self.request, privileged_peer=True)['phase'], 'recovery-required')
        self.assertEqual(self.fixture.created, 0)
        self.installer.assert_not_called()

    def test_new_id_cannot_take_over_an_interrupted_or_failed_intent(self):
        self.prepare()
        recovered = S.CoreRuntimeEnrollmentService(self.service, enrollment=self.enrollment, worker_factory=DeferredWorker)
        request = {**self.request, 'id': 'a71c77d2-f420-440e-951b-083209514e73'}
        with self.assertRaises((ValueError, FileNotFoundError)):
            recovered.prepare(request, privileged_peer=True)
        self.assertFalse(recovered._directory(request['id']).exists())
        self.installer.assert_not_called()

    def test_new_id_after_completed_proof_uses_verified_cached_installation(self):
        self.finish()
        request = {**self.request, 'id': 'a71c77d2-f420-440e-951b-083209514e73'}
        self.assertEqual(self.manager.prepare(request, privileged_peer=True)['phase'], 'preparing')
        self.manager._active[request['id']].run()
        self.assertEqual(self.manager.status({'id': request['id'], 'actor': ACTOR}, privileged_peer=True)['phase'], 'installed')
        self.assertEqual(self.fixture.created, 1)

    def test_no_label_old_version_is_not_supported_without_extraction_or_new_api(self):
        self.fixture.image['Config']['Labels'].pop(F.M.LABEL)
        self.assertEqual(self.finish(), self.manager._public(ID, 'not-supported'))
        self.assertEqual(self.fixture.created, 0)
        self.fixture.verifier.assert_not_called()

    def test_privilege_exact_actor_and_action_guards_precede_intent_or_install(self):
        for peer, request in ((False, self.request), (True, {**self.request, 'image': F.IMAGE}),
                              (True, {**self.request, 'action': 'activate'}), (True, {**self.request, 'id': 'bad'})):
            with self.subTest(request=request, peer=peer), self.assertRaises(ValueError):
                self.manager.prepare(request, privileged_peer=peer)
        self.assertFalse(self.manager._directory(ID).exists())
        with mock.patch.object(S.R.POLICY.I, 'require_root', side_effect=ValueError('not root')):
            with self.assertRaises(ValueError):
                self.prepare()
        self.prepare()
        for field in ACTOR:
            changed = copy.deepcopy(self.observe)
            changed['actor'][field] = 1 if field == 'ownerId' else '0' * 64
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.manager.status(changed, privileged_peer=True)
        self.assertEqual(self.fixture.created, 0)

    def test_parent_fsync_failure_never_admits_a_worker(self):
        with mock.patch.object(self.enrollment, 'sync', side_effect=OSError('synthetic fsync failure')):
            with self.assertRaises(OSError):
                self.prepare()
        self.assertEqual(self.manager._active, {})
        self.installer.assert_not_called()

    def test_wait_releases_condition_and_signals_on_worker_completion_without_polling(self):
        self.prepare()
        worker = self.manager._active[ID]
        ready, done = threading.Event(), threading.Event()
        results = []
        original = self.manager._condition.wait
        def wait(timeout=None):
            ready.set()
            return original(timeout)
        def observer():
            results.append(self.manager.wait(self.observe, privileged_peer=True))
            done.set()
        with mock.patch.object(self.manager._condition, 'wait', side_effect=wait) as condition_wait:
            thread = threading.Thread(target=observer)
            thread.start()
            self.assertTrue(ready.wait(2))
            self.assertTrue(self.service.lock.acquire(blocking=False))
            self.service.lock.release()
            worker.run()
            self.assertTrue(done.wait(5))
            thread.join(2)
            self.assertEqual(condition_wait.call_count, 1)
        self.assertEqual(results[0]['phase'], 'installed')

    def test_wait_timeout_returns_current_state_and_accepts_no_caller_timeout(self):
        self.prepare()
        with mock.patch.object(S, 'WAIT_SECONDS', 0):
            self.assertEqual(self.manager.wait(self.observe, privileged_peer=True)['phase'], 'preparing')
        with self.assertRaises(ValueError):
            self.manager.wait({**self.observe, 'waitMs': 1}, privileged_peer=True)

    def test_daemon_waiting_on_contended_service_lock_keeps_status_readable(self):
        self.manager.worker_factory = threading.Thread
        with self.service.lock:
            self.assertEqual(self.prepare()['phase'], 'preparing')
            worker = self.manager._active[ID]
            self.assertTrue(worker.is_alive())
            self.assertEqual(self.status()['phase'], 'preparing')
            self.assertEqual(self.fixture.created, 0)
        worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(self.status()['phase'], 'installed')

    def test_unknown_external_create_failure_holds_and_duplicate_never_replays(self):
        original = self.fixture.engine
        def engine(method, route, *args, **kwargs):
            result = original(method, route, *args, **kwargs)
            if method == 'POST':
                raise OSError('synthetic unknown create result')
            return result
        self.enrollment.runtime.engine.side_effect = engine
        self.prepare()
        self.manager._active[ID].run()
        self.assertEqual(self.status()['phase'], 'recovery-required')
        self.assertEqual(self.prepare()['phase'], 'recovery-required')
        self.assertEqual(self.fixture.created, 1)
        self.assertEqual(self.fixture.deleted, 0)


if __name__ == '__main__':
    unittest.main()
