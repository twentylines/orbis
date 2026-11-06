import copy
import importlib.util
import json
import subprocess
import sys
import threading
import unittest
from pathlib import Path


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


F = load('test_orbis_host_time_machine_core.py', 'lease_capture_fixtures')
L = load('orbis-host-core-capture-lease.py', 'lease_subject')


class CoreCaptureLeaseTests(unittest.TestCase):
    def setUp(self):
        self.fixture = F.CoreCaptureTests('test_real_review_checkpoint_and_same_id_resume_exclude_all_apps_and_proxy')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.capture = self.fixture.capture
        self.host = F.C.HOST
        self.root = self.fixture.root
        self.path = self.host.capture_fence_path(self.root)

    def reserve(self, source=None):
        with self.host.host_lock(self.root):
            return L.CoreCaptureLease.reserve(self.host, self.root, self.fixture.docker.context,
                                             F.POINT, source or F.C.TX.APPS.digest(self.fixture.source))

    def test_reservation_requires_this_installations_host_lock(self):
        with self.assertRaisesRegex(ValueError, 'operation lock'):
            L.CoreCaptureLease.reserve(self.host, self.root, self.fixture.docker.context, F.POINT, 'a' * 64)
        self.assertFalse(self.path.exists())

    def test_owner_runs_exact_capture_but_does_not_clear_publication_hold(self):
        lease = self.reserve()
        with self.assertRaisesRegex(ValueError, 'capture'):
            with self.host.host_lock(self.root):
                self.fail('Competing host operation entered')
        with lease.owner():
            receipt = self.fixture.run_capture()
        self.assertEqual(receipt['pointId'], F.POINT)
        self.assertTrue(self.path.exists())
        with self.assertRaisesRegex(ValueError, 'capture'):
            with self.host.host_lock(self.root):
                self.fail('Completed copy alone cannot release publication hold')

    def test_worker_reload_does_not_authorize_replay(self):
        lease = self.reserve()
        with lease.owner():
            self.fixture.run_capture()
        loaded = L.CoreCaptureLease.load(self.host, self.root)
        previous = copy.deepcopy(self.fixture.docker.calls)
        with loaded.owner(), self.assertRaisesRegex(ValueError, 'replayed'):
            self.fixture.run_capture()
        self.assertEqual(self.fixture.docker.calls, previous)

    def test_context_does_not_leak_to_another_host_thread(self):
        lease = self.reserve()
        outcomes = []
        def competing():
            try:
                with self.host.host_lock(self.root):
                    outcomes.append('entered')
            except ValueError:
                outcomes.append('blocked')
        with lease.owner():
            worker = threading.Thread(target=competing)
            worker.start()
            worker.join(timeout=2)
            self.assertFalse(worker.is_alive())
        self.assertEqual(outcomes, ['blocked'])

    def test_independent_process_cannot_enter_the_owned_host_operation(self):
        lease = self.reserve()
        script = '''import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('other_host',sys.argv[1]);host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
try:
 with host.host_lock(Path(sys.argv[2])):pass
except ValueError:sys.exit(17)
sys.exit(1)
'''
        with lease.owner():
            result = subprocess.run([sys.executable, '-B', '-c', script,
                                     str(Path(__file__).with_name('orbis-host.py')), str(self.root)],
                                    capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 17, result.stderr.decode())

    def test_worker_cannot_use_a_lease_from_another_docker_context(self):
        with self.host.host_lock(self.root):
            lease = L.CoreCaptureLease.reserve(self.host, self.root, 'another-context', F.POINT,
                                               F.C.TX.APPS.digest(self.fixture.source))
        with lease.owner(), self.assertRaisesRegex(ValueError, 'different operation'):
            self.fixture.run_capture()
        self.assertFalse((self.capture.base / F.POINT).exists())
        self.assertEqual(self.fixture.docker.calls, [])

    def test_nonprivate_or_symlinked_fence_cannot_grant_ownership(self):
        self.reserve()
        self.path.chmod(0o644)
        with self.assertRaises(ValueError):
            L.CoreCaptureLease.load(self.host, self.root)
        self.path.chmod(0o600)
        retained = self.path.with_suffix('.retained')
        self.path.rename(retained)
        self.path.symlink_to(retained)
        with self.assertRaises((OSError, ValueError)):
            L.CoreCaptureLease.load(self.host, self.root)

    def test_legacy_fence_cannot_be_adopted(self):
        self.path.write_text(json.dumps({'schema': 'orbis.controller-capture-fence.v1'}))
        self.path.chmod(0o600)
        with self.assertRaises(ValueError):
            L.CoreCaptureLease.load(self.host, self.root)
        with self.assertRaisesRegex(ValueError, 'capture'):
            self.host.require_no_capture_fence(self.root)

    def test_replaced_identical_file_invalidates_old_owner(self):
        lease = self.reserve()
        body = self.path.read_bytes()
        self.path.rename(self.path.with_suffix('.retained'))
        self.path.write_bytes(body)
        self.path.chmod(0o600)
        with self.assertRaises(ValueError), lease.owner():
            self.fail('Replaced authority accepted')

    def test_removed_fence_invalidates_an_existing_owner_context(self):
        lease = self.reserve()
        with lease.owner():
            self.path.unlink()
            with self.assertRaises(ValueError):
                with self.host.host_lock(self.root):
                    self.fail('Stale owner accepted')

    def test_wrong_point_is_rejected_without_creating_another_job(self):
        lease = self.reserve()
        with lease.owner(), self.assertRaisesRegex(ValueError, 'different operation'):
            self.fixture.run_capture(F.OTHER)
        self.assertFalse((self.capture.base / F.OTHER).exists())
        self.assertEqual(self.fixture.docker.calls, [])

    def test_source_change_cannot_stop_the_controller(self):
        lease = self.reserve('a' * 64)
        with lease.owner(), self.assertRaisesRegex(ValueError, 'source binding'):
            self.fixture.run_capture()
        self.assertEqual(self.fixture.docker.calls, [])
        self.assertEqual(self.fixture.record()['phase'], 'recovery-required')
        self.assertTrue(self.path.exists())

    def test_failed_capture_cannot_be_reclaimed_under_same_owner(self):
        lease = self.reserve()
        self.fixture.copy_hook = lambda: (_ for _ in ()).throw(OSError('fixture copy failure'))
        with lease.owner(), self.assertRaises(OSError):
            self.fixture.run_capture()
        previous = copy.deepcopy(self.fixture.docker.calls)
        with L.CoreCaptureLease.load(self.host, self.root).owner(), self.assertRaisesRegex(ValueError, 'unfinished'):
            self.fixture.run_capture()
        self.assertEqual(previous, self.fixture.docker.calls)
        self.assertTrue(self.path.exists())

    def test_owner_context_is_restored_after_exception(self):
        lease = self.reserve()
        with self.assertRaises(RuntimeError), lease.owner():
            raise RuntimeError('fixture')
        self.assertIsNone(self.host.CORE_CAPTURE_OWNER.get())

    def test_restore_owner_cannot_reserve_another_operation(self):
        token = self.host.RESTORE_TRANSACTION.set(F.OTHER)
        try:
            with self.assertRaisesRegex(ValueError, 'restore owner'):
                self.reserve()
        finally:
            self.host.RESTORE_TRANSACTION.reset(token)
        self.assertFalse(self.path.exists())

    def test_capture_owner_cannot_create_a_nested_reservation(self):
        lease = self.reserve()
        original = self.path.read_bytes()
        with lease.owner(), self.assertRaisesRegex(ValueError, 'second operation'):
            self.reserve()
        self.assertEqual(self.path.read_bytes(), original)

    def test_rejects_malformed_grant_and_unknown_lease_fields(self):
        lease = self.reserve()
        token = self.host.CORE_CAPTURE_OWNER.set('not a worker capability')
        try:
            with self.assertRaises(ValueError):
                self.host.require_no_capture_fence(self.root)
        finally:
            self.host.CORE_CAPTURE_OWNER.reset(token)
        value = json.loads(self.path.read_bytes())
        value['ignoreOtherWriters'] = True
        self.path.write_text(json.dumps(value))
        with self.assertRaises(ValueError):
            L.CoreCaptureLease.load(self.host, self.root)


if __name__ == '__main__':
    unittest.main()
