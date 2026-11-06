import copy
import importlib.util
import os
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location('preparation_recovery_fixtures', Path(__file__).with_name('test_orbis_host_core_capture_reserved.py'))
R = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(R)
S = R.S


class PreparationRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.case = R.ReservedCaptureTests('test_prepare_returns_only_after_real_durable_lease_and_exact_pins')
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.manager, self.point = self.case.manager, self.case.point
        self.directory = self.manager.directory(self.point)
        self.stage = self.case.fence().with_name(S.W.LEASE.CoreCaptureLease.staging_name(self.point))

    def fresh(self):
        manager = S.CoreCaptureService(self.case.service)
        self.enterContext(mock.patch.object(manager, 'require_publication_capability'))
        self.enterContext(mock.patch.object(manager, 'require_namespace_access'))
        self.enterContext(mock.patch.object(manager, 'controller_reservation', side_effect=lambda *_: copy.deepcopy(self.case.reservation)))
        self.enterContext(mock.patch.object(manager, 'controller_marker', side_effect=AssertionError('No source-marker action')))
        return manager

    def pending(self, phase='intent'):
        if phase == 'intent':
            patch = mock.patch.object(self.manager, 'finish_reserved_preparation', side_effect=OSError('interrupted after intent'))
        elif phase == 'lease':
            original = S.W.RESERVED.PreparationIntent.publish
            def publish(intent):
                original(intent)
                raise OSError('interrupted after lease')
            patch = mock.patch.object(S.W.RESERVED.PreparationIntent, 'publish', publish)
        elif phase == 'preparation':
            patch = mock.patch.object(self.manager, 'public_preparation', side_effect=OSError('interrupted after preparation'))
        else:
            original = S.create
            def create(directory, name, value):
                if name == 'preparation.json':
                    raise OSError('interrupted before preparation')
                return original(directory, name, value)
            patch = mock.patch.object(S, 'create', side_effect=create)
        with patch, self.assertRaisesRegex(OSError, 'interrupted'):
            self.manager.prepare_reserved(self.point)
        self.case.launch.assert_not_called()

    def recover(self, manager=None):
        return (manager or self.fresh()).reconcile_reserved(self.point, self.case.observation_request())

    def assert_no_operation(self):
        self.case.launch.assert_not_called()
        self.case.marker_read.assert_not_called()
        self.assertFalse(self.case.admission_dir().exists())
        self.assertFalse((self.manager.capture.base / self.point).exists())
        self.assertEqual(self.case.fixture.docker.calls, [])

    def test_fresh_service_finishes_original_staged_lease_without_second_reservation(self):
        self.pending()
        original = self.stage.stat()
        body = self.stage.read_bytes()
        self.assertFalse(self.case.fence().exists())
        with mock.patch.object(S.W.LEASE.CoreCaptureLease, 'grant', side_effect=AssertionError('new reservation')):
            result = self.recover()
        self.assertEqual(result['version'], 3)
        self.assertEqual((self.case.fence().stat().st_dev, self.case.fence().stat().st_ino), (original.st_dev, original.st_ino))
        self.assertEqual(self.case.fence().read_bytes(), body)
        self.assertFalse(self.stage.exists())
        self.assertEqual(self.case.authority().preparation['leaseIdentity'], S.W.RESERVED.lease_identity(self.case.fence().stat()))
        self.case.assert_held()
        self.assert_no_operation()

    def test_fresh_service_finishes_exact_already_published_lease(self):
        self.pending('lease')
        original = S.A.seal(self.case.fence().stat())
        result = self.recover()
        self.assertEqual(result, self.recover())
        self.assertEqual(S.A.seal(self.case.fence().stat()), original)
        self.case.assert_held()
        self.assert_no_operation()

    def test_final_preparation_write_failure_is_recoverable(self):
        self.pending('before-preparation')
        self.assertFalse((self.directory / 'preparation.json').exists())
        self.recover()
        self.case.assert_held()
        self.assert_no_operation()

    def test_lost_final_reply_returns_identical_preparation_without_creating_records(self):
        self.pending('preparation')
        files = {path.name: path.read_bytes() for path in self.directory.iterdir()}
        expected = self.manager.public_preparation(self.case.authority().preparation)
        with mock.patch.object(S, 'create', side_effect=AssertionError('record replay')):
            self.assertEqual(self.recover(), expected)
        self.assertEqual({path.name: path.read_bytes() for path in self.directory.iterdir()}, files)
        self.assert_no_operation()

    def test_observation_remains_read_only_for_partial_new_intent(self):
        self.pending()
        before = self.stage.read_bytes()
        with self.assertRaises((ValueError, OSError)):
            self.manager.observe_reserved(self.point, self.case.observation_request())
        self.assertEqual(self.stage.read_bytes(), before)
        self.assertFalse(self.case.fence().exists())
        self.assertFalse((self.directory / 'preparation.json').exists())

    def test_stage_without_committed_intent_cannot_publish_a_fence(self):
        original = S.create
        def create(directory, name, value):
            if name == 'preparation-intent.json':
                raise OSError('no intent authority')
            return original(directory, name, value)
        with mock.patch.object(S, 'create', side_effect=create), self.assertRaises(OSError):
            self.manager.prepare_reserved(self.point)
        self.assertTrue(self.stage.exists())
        with self.assertRaises((ValueError, OSError)):
            self.recover()
        self.assertFalse(self.case.fence().exists())
        with S.H.host_lock(self.case.fixture.root):
            pass
        self.assert_no_operation()

    def test_old_partial_preparation_without_intent_stays_held(self):
        self.pending('before-preparation')
        (self.directory / 'preparation-intent.json').rename(self.directory / 'old-intent-evidence')
        with self.assertRaises((ValueError, OSError)):
            self.recover()
        self.case.assert_held()
        self.assertFalse((self.directory / 'preparation.json').exists())

    def test_changed_original_controller_or_point_never_promotes_stage(self):
        self.pending()
        starts = self.case.fixture.docker.starts
        controller = self.case.fixture.docker.controller_id
        starts[controller] = 'changed-start'
        with self.assertRaises(ValueError):
            self.recover()
        starts.pop(controller)
        self.case.reservation['ownerId'] = 2
        with self.assertRaises(ValueError):
            self.recover()
        self.assertFalse(self.case.fence().exists())
        self.assertTrue(self.stage.exists())
        self.assert_no_operation()

    def test_changed_database_state_is_rejected_before_promotion(self):
        self.pending()
        database = self.case.fixture.docker.services[R.F.identifier('runtipi-db')]
        database['state'] = 'exited'
        with self.assertRaises(ValueError):
            self.recover()
        self.assertFalse(self.case.fence().exists())
        self.assert_no_operation()

    def test_changed_semantic_storage_review_is_not_rebound(self):
        self.pending()
        original = S.C.TX.review
        def review(*args, **kwargs):
            value = original(*args, **kwargs)
            value['storage']['identityHash'] = 'f' * 64
            return value
        with mock.patch.object(S.C.TX, 'review', side_effect=review), self.assertRaisesRegex(ValueError, 'storage or writers'):
            self.recover()
        self.assertFalse(self.case.fence().exists())
        self.assert_no_operation()

    def test_decision_admission_and_job_authority_each_refuse_recovery(self):
        self.pending()
        for path in (self.directory / 'decision.json', self.case.admission_dir(), self.manager.capture.base / self.point):
            with self.subTest(path=path.name):
                path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                path.symlink_to(self.directory / 'nonexistent')
                with self.assertRaisesRegex(ValueError, 'operation authority'):
                    self.recover()
                self.assertTrue(path.is_symlink())
                path.unlink()
        self.assertFalse(self.case.fence().exists())
        self.assert_no_operation()

    def test_same_bytes_on_replacement_staged_inode_are_rejected(self):
        self.pending()
        self.stage.rename(self.stage.with_suffix('.evidence'))
        self.stage.write_bytes(self.stage.with_suffix('.evidence').read_bytes())
        self.stage.chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'original lease inode'):
            self.recover()
        self.assertFalse(self.case.fence().exists())

    def test_same_bytes_on_replacement_published_inode_are_rejected(self):
        self.pending('lease')
        path = self.case.fence()
        path.rename(path.with_name('original-lease-evidence'))
        path.write_bytes(path.with_name('original-lease-evidence').read_bytes())
        path.chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'original lease inode'):
            self.recover()
        self.case.assert_held()

    def test_both_names_present_and_both_absent_are_ambiguous(self):
        self.pending()
        self.case.fence().write_bytes(self.stage.read_bytes())
        self.case.fence().chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'Ambiguous'):
            self.recover()
        self.case.fence().unlink()
        self.stage.rename(self.stage.with_suffix('.evidence'))
        with self.assertRaisesRegex(ValueError, 'Ambiguous'):
            self.recover()
        self.assertFalse((self.directory / 'preparation.json').exists())

    def test_stage_symlink_and_extra_hardlink_are_refused(self):
        self.pending()
        evidence = self.stage.with_suffix('.evidence')
        self.stage.rename(evidence)
        self.stage.symlink_to(evidence)
        with self.assertRaises((ValueError, OSError)):
            self.recover()
        self.stage.unlink()
        evidence.rename(self.stage)
        os.link(self.stage, evidence)
        with self.assertRaises(ValueError):
            self.recover()
        self.assertFalse(self.case.fence().exists())

    def test_partial_final_preparation_is_preserved_without_overwrite(self):
        self.pending('lease')
        path = self.directory / 'preparation.json'
        path.write_bytes(b'{')
        path.chmod(0o600)
        with self.assertRaises((ValueError, OSError)):
            self.recover()
        self.assertEqual(path.read_bytes(), b'{')
        self.case.assert_held()

    def test_invalid_requests_cannot_publish_the_staged_lease(self):
        self.pending()
        for request in (None, [], {}, {'pointReservationSha256': 'A' * 64},
                        {'pointReservationSha256': '0' * 64}, {**self.case.observation_request(), 'release': True}):
            with self.subTest(request=request), self.assertRaises(ValueError):
                self.fresh().reconcile_reserved(self.point, request)
        self.assertFalse(self.case.fence().exists())

    def test_restore_owner_cannot_complete_a_preparation(self):
        self.pending()
        token = S.H.RESTORE_TRANSACTION.set(R.F.OTHER)
        try:
            with self.assertRaises(ValueError):
                self.recover()
        finally:
            S.H.RESTORE_TRANSACTION.reset(token)
        self.assertFalse(self.case.fence().exists())

    def test_sync_failure_never_returns_success_or_clears_authority(self):
        self.pending()
        with mock.patch.object(S.os, 'fsync', side_effect=OSError('sync failed')):
            with self.assertRaises(OSError):
                self.recover()
        self.assertTrue(self.stage.exists())
        self.assertFalse(self.case.fence().exists())
        self.assertFalse((self.directory / 'preparation.json').exists())
        self.recover()
        self.case.assert_held()

    def test_fence_parent_sync_failure_remains_recoverable_with_original_intent(self):
        self.pending()
        original = os.fsync
        expected = S.W.identity(self.case.fence().parent.stat())
        def fsync(descriptor):
            if self.case.fence().exists() and S.W.identity(os.fstat(descriptor)) == expected:
                raise OSError('fence parent durability unknown')
            return original(descriptor)
        with mock.patch.object(S.os, 'fsync', side_effect=fsync), self.assertRaisesRegex(OSError, 'durability unknown'):
            self.recover()
        self.assertTrue(self.case.fence().exists())
        self.assertFalse(self.stage.exists())
        self.assertFalse((self.directory / 'preparation.json').exists())
        self.recover()
        self.case.assert_held()

    def test_final_preparation_parent_sync_failure_reuses_exact_published_authority(self):
        self.pending('lease')
        original = os.fsync
        expected = S.W.identity(self.directory.stat())
        def fsync(descriptor):
            if (self.directory / 'preparation.json').exists() and S.W.identity(os.fstat(descriptor)) == expected:
                raise OSError('preparation parent durability unknown')
            return original(descriptor)
        with mock.patch.object(S.os, 'fsync', side_effect=fsync), self.assertRaisesRegex(OSError, 'durability unknown'):
            self.recover()
        path = self.directory / 'preparation.json'
        body, seal = path.read_bytes(), S.A.seal(path.stat())
        with mock.patch.object(S, 'create', side_effect=AssertionError('published authority must not be replaced')):
            result = self.recover()
        self.assertEqual(result['preparationSha256'], S.W.digest(body))
        self.assertEqual(path.read_bytes(), body)
        self.assertEqual(S.A.seal(path.stat()), seal)
        self.case.assert_held()

    def test_wrong_installation_lock_and_changed_lock_permissions_cannot_promote_stage(self):
        self.pending()
        intent = S.W.RESERVED.PreparationIntent(S.W, self.case.fixture.state, self.case.fixture.root,
                                               self.case.service.context, self.point)
        other = self.case.fixture.parent / 'other-installation'
        other.mkdir(mode=0o700)
        with S.H.host_lock(other) as descriptor:
            reader = S.C.TX.APPS.Docker(self.case.service.context)
            reader.lock_fd = descriptor
            with self.assertRaisesRegex(ValueError, 'this installation lock'):
                self.manager.finish_reserved_preparation(reader, self.point, intent)
        with S.H.host_lock(self.case.fixture.root) as descriptor:
            os.fchmod(descriptor, 0o644)
            try:
                with self.assertRaisesRegex(ValueError, 'no longer protected'):
                    self.manager.finish_reserved_preparation(reader, self.point, intent)
            finally:
                os.fchmod(descriptor, 0o600)
        self.assertFalse(self.case.fence().exists())

    def test_malformed_intent_is_never_repaired_or_rebound(self):
        self.pending()
        path = self.directory / 'preparation-intent.json'
        original = S.P.metadata(path.read_bytes(), byte_limit=65536)
        for mutate in (lambda value: value.update(extra=True),
                       lambda value: value['preparation'].update(scope='full'),
                       lambda value: value['grant'].update(nonce='A' * 64),
                       lambda value: value['leaseIdentity'].update(inode=True),
                       lambda value: value.update(parentIdentity=[0, 0, 0, 0, 0])):
            value = copy.deepcopy(original)
            mutate(value)
            body = S.P.canonical(value)
            path.write_bytes(body)
            with self.assertRaises((ValueError, OSError)):
                self.recover()
            self.assertEqual(path.read_bytes(), body)
            self.assertFalse(self.case.fence().exists())

    def test_atomic_record_has_no_partial_final_and_never_clobbers_an_existing_one(self):
        directory = self.case.fixture.state
        target = directory / 'atomic-test.json'
        original_load = S.W.load
        def load(path, name):
            module = original_load(path, name)
            if name != 'preparation_atomic_publication':
                return module
            rename = module.rename_noreplace
            def check(parent, source, destination):
                self.assertFalse(target.exists())
                self.assertEqual((directory / source).read_bytes(), S.P.canonical({'complete': True}))
                return rename(parent, source, destination)
            return SimpleNamespace(rename_noreplace=check)
        with mock.patch.object(S.W, 'load', side_effect=load):
            S.W.RESERVED.create_atomic(S.W, directory, target.name, {'complete': True})
        original = S.A.seal(target.stat())
        with self.assertRaises(FileExistsError):
            S.W.RESERVED.create_atomic(S.W, directory, target.name, {'replacement': True})
        self.assertEqual(target.read_bytes(), S.P.canonical({'complete': True}))
        self.assertEqual(S.A.seal(target.stat()), original)
        self.assertFalse(any(directory.glob('.pending-*')))

    def test_atomic_sync_failure_leaves_no_partial_final(self):
        directory = self.case.fixture.state
        with mock.patch.object(S.os, 'fsync', side_effect=OSError('sync failed')):
            with self.assertRaises(OSError):
                S.W.RESERVED.create_atomic(S.W, directory, 'failed.json', {'complete': True})
        self.assertFalse((directory / 'failed.json').exists())
        self.assertFalse(any(directory.glob('.pending-*')))

    @unittest.skipUnless(sys.platform == 'linux', 'Linux process-interruption proof')
    def test_recovery_after_preparing_process_exits_at_each_committed_boundary(self):
        # Every child has its own point and service-lock instance. No source
        # drain or worker is launched; only durable root preparation is tested.
        for index, phase in enumerate(('intent', 'lease', 'preparation'), 10):
            point = '00000000-0000-4000-8000-' + str(index).zfill(12)
            self.case.reservation['id'] = point
            pid = os.fork()
            if pid == 0:
                try:
                    if phase == 'intent':
                        self.manager.finish_reserved_preparation = lambda *_: os._exit(37)
                    elif phase == 'lease':
                        original = S.W.RESERVED.PreparationIntent.publish
                        def publish(intent):
                            original(intent)
                            os._exit(37)
                        S.W.RESERVED.PreparationIntent.publish = publish
                    else:
                        self.manager.public_preparation = lambda *_: os._exit(37)
                    self.manager.prepare_reserved(point)
                except BaseException:
                    os._exit(38)
                os._exit(39)
            _, status = os.waitpid(pid, 0)
            self.assertTrue(os.WIFEXITED(status))
            self.assertEqual(os.WEXITSTATUS(status), 37)
            result = self.fresh().reconcile_reserved(point, {'pointReservationSha256': S.R.sha256(self.case.reservation)})
            self.assertEqual(result['id'], point)
            # Preserve each committed lease as evidence, outside the active
            # selector, so the next independent fixture can prepare its point.
            self.case.fence().rename(self.case.fence().with_name('test-lease-evidence-' + point))
        self.assert_no_operation()


if __name__ == '__main__':
    unittest.main()
