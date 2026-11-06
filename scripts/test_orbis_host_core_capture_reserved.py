import copy
import importlib.util
import json
import os
import sys
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


T = load('test_orbis_host_core_capture_service.py', 'reserved_admission_fixtures')
S, F = T.S, T.F


class ReservedCaptureTests(unittest.TestCase):
    def setUp(self):
        self.fixture = F.CoreCaptureTests('test_real_review_checkpoint_and_same_id_resume_exclude_all_apps_and_proxy')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.enterContext(mock.patch.object(S.W, 'require_root'))
        self.enterContext(mock.patch.object(S.C.CoreCapture, 'source', side_effect=lambda: copy.deepcopy(self.fixture.source)))
        self.enterContext(mock.patch.object(S.W.CHECKPOINT, 'build', return_value={'fixture': 'portable-checkpoint'}))
        self.service = SimpleNamespace(root=self.fixture.root, state_dir=self.fixture.state,
            snapshots=self.fixture.snapshots, context=self.fixture.docker.context,
            lock=threading.Lock(), require_idle_core=mock.Mock())
        self.manager = S.CoreCaptureService(self.service)
        self.enterContext(mock.patch.object(self.manager, 'require_publication_capability'))
        self.enterContext(mock.patch.object(self.manager, 'require_namespace_access'))
        self.point = F.POINT
        self.reservation = {'version': 3, 'id': self.point, 'ownerId': 1, 'createdAt': 1,
            'envelope': {'version': 1, 'keyId': 'a' * 64, 'nonce': 'b' * 24, 'tag': 'c' * 32, 'value': 'd' * 86}}
        self.enterContext(mock.patch.object(self.manager, 'controller_reservation', side_effect=lambda *_: copy.deepcopy(self.reservation)))
        self.marker = b''
        self.marker_read = self.enterContext(mock.patch.object(self.manager, 'controller_marker', side_effect=lambda _: self.marker))
        self.real_launch = S.W.launch_worker
        self.launch = self.enterContext(mock.patch.object(S.W, 'launch_worker', return_value={'id': self.point, 'state': 'launch-requested'}))

    def prepare(self):
        self.prepared = self.manager.prepare_reserved(self.point)
        self.hold = {'schema': 'orbis.core-capture-source-hold.v2', 'id': self.point,
            'operatorAuthorizationId': F.OTHER, 'drainReservationId': F.OTHER,
            'preparationSha256': self.prepared['preparationSha256'], 'sourceSha256': self.prepared['sourceSha256'],
            'controller': self.prepared['controller'], 'pointReservationSha256': self.prepared['pointReservationSha256'],
            'queueDrain': {'pauseId': F.OTHER, 'generation': 1,
                'queues': [{'name': name, 'messages': 0, 'consumers': 0} for name in sorted(S.QUEUES)]}}
        self.marker = S.P.canonical(self.hold)
        self.request = {'preparationSha256': self.prepared['preparationSha256'], 'sourceHoldSha256': S.W.digest(self.marker)}
        return self.prepared

    def authority(self):
        return S.W.RESERVED.ReservedPreparation(S.W, self.fixture.state, self.fixture.root, self.service.context, self.point)

    def fence(self):
        return S.H.capture_fence_path(self.fixture.root)

    def admission_dir(self):
        return self.fixture.state / 'core-capture-admissions' / self.point

    def assert_held(self):
        self.assertTrue(self.fence().exists())
        with self.assertRaises(ValueError):
            with S.H.host_lock(self.fixture.root):
                self.fail('Another host operation bypassed early capture exclusion')

    def abort(self):
        return self.manager.abort_reserved(self.point, {'preparationSha256': self.prepared['preparationSha256']})

    def test_prepare_returns_only_after_real_durable_lease_and_exact_pins(self):
        result = self.prepare()
        authority = self.authority()
        self.assertEqual(result['version'], 3)
        self.assertEqual(set(result), {'version', 'id', 'preparationSha256', 'sourceSha256', 'pointReservationSha256', 'controller'})
        self.assertEqual(authority.preparation['leaseSha256'], S.W.digest(self.fence().read_bytes()))
        self.assertEqual(authority.preparation['leaseIdentity'], S.W.RESERVED.lease_identity(self.fence().stat()))
        self.assertEqual(self.fixture.docker.calls, [])
        self.assertFalse(self.admission_dir().exists())
        self.assert_held()

    def test_other_thread_cannot_enter_pre_admission_gap(self):
        self.prepare()
        outcomes = []
        def competing():
            try:
                with S.H.host_lock(self.fixture.root):
                    outcomes.append('entered')
            except ValueError:
                outcomes.append('blocked')
        thread = threading.Thread(target=competing)
        thread.start()
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(outcomes, ['blocked'])

    def test_admit_commits_decision_before_artifacts_and_reuses_original_lease(self):
        self.prepare()
        before = S.A.seal(self.fence().stat())
        original_create = S.create
        def create(directory, name, value):
            if directory == self.admission_dir():
                authority = self.authority()
                authority.decision('admit', self.request['sourceHoldSha256'])
            return original_create(directory, name, value)
        with mock.patch.object(S, 'create', side_effect=create), mock.patch.object(S.W.LEASE.CoreCaptureLease, 'reserve', side_effect=AssertionError('second lease')):
            self.assertEqual(self.manager.admit(self.point, self.request)['state'], 'launch-requested')
        self.assertEqual(S.A.seal(self.fence().stat()), before)
        admission = S.W.Admission(self.fixture.state, self.point)
        self.assertEqual(admission.request['schema'], 'orbis.core-capture-admission.v2')
        self.assertEqual(admission.handoff['schema'], 'orbis.core-capture-handoff.v2')
        self.assertEqual(admission.request['decisionSha256'], S.W.digest(self.authority().read('decision.json')[1]))
        self.assert_held()

    @unittest.skipIf(sys.platform == 'darwin', 'Measured ctime-only live-lease drift on macOS; full strict path requires Linux qualification')
    def test_v3_worker_still_uses_existing_capture_and_keeps_exclusion(self):
        self.prepare()
        frame = {'unit': 'orbis-core-capture-' + self.point + '.service', 'invocationId': 'c' * 32, 'processId': os.getpid()}
        self.launch.side_effect = lambda state, point: S.W.run_worker(state, point)
        check_owner = S.H.core_capture_owner
        def measured_owner(root):
            try:
                return check_owner(root)
            except ValueError:
                proof = S.H.CORE_CAPTURE_OWNER.get()
                info = S.H.capture_fence_path(root).stat()
                names = S.W.RESERVED.IDENTITY_NAMES
                expected = dict(zip(names, proof[1])) if isinstance(proof, tuple) else {}
                actual = S.W.RESERVED.lease_identity(info)
                diagnostic = {'schema': 'orbis.test-reserved-lease-seal-diagnostic.v1', 'platform': sys.platform,
                    'changedFields': {key: {'expected': expected.get(key), 'actual': actual[key]}
                                      for key in names if expected.get(key) != actual[key]},
                    'sameBody': isinstance(proof, tuple) and proof[0] == S.H.capture_fence_path(root).read_bytes()}
                (self.fixture.parent / 'lease-seal-diagnostic.json').write_text(json.dumps(diagnostic, sort_keys=True))
                print(json.dumps(diagnostic, sort_keys=True), file=sys.stderr)
                raise
        try:
            with mock.patch.object(S.W, 'supervision_identity', return_value=frame), mock.patch.object(S.W, 'verify_supervision'), \
                    mock.patch.object(S.H, 'core_capture_owner', side_effect=measured_owner):
                self.assertEqual(self.manager.admit(self.point, self.request)['state'], 'resumed-awaiting-publication')
        except BaseException:
            # Preserve the failing private filesystem while still restoring all
            # injected host fixtures. The parent will qualify this path on Linux.
            self.fixture._cleanups = [item for item in self.fixture._cleanups if item[0] != self.fixture.temp.cleanup]
            self.fixture.temp._finalizer.detach()
            print('Preserved failing reserved-capture fixture: ' + str(self.fixture.parent), file=sys.stderr)
            raise
        self.assertEqual(self.fixture.storage_capture.call_count, 1)
        self.assert_held()

    def test_abort_is_positive_intent_and_cannot_release_or_admit(self):
        self.prepare()
        original = self.fence().read_bytes()
        result = self.abort()
        self.assertEqual(result['state'], 'abort-intent')
        self.authority().decision('abort')
        self.marker_read.assert_not_called()
        self.assertFalse(self.admission_dir().exists())
        with self.assertRaises(S.W.AdmissionError):
            self.manager.admit(self.point, self.request)
        self.launch.assert_not_called()
        self.assertEqual(self.fence().read_bytes(), original)
        self.assert_held()

    def test_admit_intent_forbids_abort_even_when_admission_write_did_not_start(self):
        self.prepare()
        authority = self.authority()
        with authority.lease().owner(), S.H.host_lock(self.fixture.root):
            authority.decide('admit', self.request['sourceHoldSha256'])
        self.assertFalse(self.admission_dir().exists())
        with self.assertRaises(FileExistsError):
            self.abort()
        self.authority().decision('admit', self.request['sourceHoldSha256'])
        self.assert_held()

    def test_decision_requires_exact_owner_existing_lock_and_root(self):
        self.prepare()
        authority = self.authority()
        with self.assertRaises(S.W.AdmissionError):
            authority.decide('abort')
        with authority.lease().owner(), self.assertRaises(S.W.AdmissionError):
            authority.decide('abort')
        other = self.fixture.parent / 'other-install'
        other.mkdir(mode=0o700)
        with S.H.host_lock(other), authority.lease().owner(), self.assertRaises(S.W.AdmissionError):
            authority.decide('abort')
        with mock.patch.object(S.W, 'require_root', side_effect=S.W.AdmissionError('root')):
            with self.assertRaises(S.W.AdmissionError):
                authority.decide('abort')
        self.assertFalse((authority.directory / 'decision.json').exists())

    def test_one_winner_admit_abort_race(self):
        self.prepare()
        barrier, outcomes = threading.Barrier(2), []
        def run(choice):
            barrier.wait(timeout=5)
            try:
                (self.abort() if choice == 'abort' else self.manager.admit(self.point, self.request))
                outcomes.append(choice)
            except (ValueError, OSError):
                outcomes.append('held')
        threads = [threading.Thread(target=run, args=(choice,)) for choice in ('admit', 'abort')]
        for thread in threads: thread.start()
        for thread in threads: thread.join(timeout=5)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(outcomes.count('held'), 1)
        decision = self.authority().read('decision.json')[0]
        self.assertIn(decision['decision'], outcomes)
        self.assert_held()

    def test_decision_uses_held_lock_identity_under_adopted_shared_legacy_parent(self):
        self.prepare()
        authority = self.authority()
        shared = self.fixture.parent / 'legacy-lock-parent'
        shared.mkdir(mode=0o775)
        shared.chmod(0o775)
        lock = shared / 'host.lock'
        with mock.patch.object(S.H.AUTHORITY.LAYOUT, 'lock_paths', return_value=[lock]):
            with authority.lease().owner(), S.H.host_lock(self.fixture.root):
                authority.decide('abort')
        authority.decision('abort')
        self.assertEqual(shared.stat().st_mode & 0o777, 0o775)
        self.assertEqual(lock.stat().st_mode & 0o777, 0o600)
        self.assert_held()

    def test_decision_rechecks_private_lock_mode_after_acquisition(self):
        self.prepare()
        authority = self.authority()
        with authority.lease().owner(), S.H.host_lock(self.fixture.root):
            lock = S.H.AUTHORITY.LAYOUT.lock_paths(self.fixture.root)[0]
            try:
                lock.chmod(0o644)
                with self.assertRaisesRegex(S.W.AdmissionError, 'no longer protected'):
                    authority.decide('abort')
            finally:
                lock.chmod(0o600)
        self.assertFalse((authority.directory / 'decision.json').exists())
        self.assert_held()

    def test_partial_decision_blocks_both_branches_without_overwrite(self):
        self.prepare()
        path = self.authority().directory / 'decision.json'
        path.write_bytes(b'{')
        path.chmod(0o600)
        with self.assertRaises((ValueError, OSError)):
            self.manager.admit(self.point, self.request)
        with self.assertRaises(FileExistsError):
            self.abort()
        self.assertEqual(path.read_bytes(), b'{')
        self.launch.assert_not_called()
        self.assert_held()

    def test_partial_preparation_after_reservation_is_not_replayed_or_downgraded(self):
        original_create = S.create
        def failed(directory, name, value):
            if name == 'preparation.json':
                raise OSError('interrupted preparation')
            return original_create(directory, name, value)
        with mock.patch.object(S, 'create', side_effect=failed), self.assertRaisesRegex(OSError, 'interrupted'):
            self.prepare()
        self.assert_held()
        for method in (self.manager.prepare_reserved, self.manager.prepare, self.manager.prepare_bound):
            with self.assertRaises((ValueError, OSError)):
                method(self.point)
        self.assertFalse(self.admission_dir().exists())

    def test_partial_admission_keeps_admit_winner_and_forbids_abort_or_replay(self):
        self.prepare()
        original_create = S.create
        def failed(directory, name, value):
            if name == 'request.json':
                raise OSError('interrupted admission')
            return original_create(directory, name, value)
        with mock.patch.object(S, 'create', side_effect=failed), self.assertRaises(OSError):
            self.manager.admit(self.point, self.request)
        with self.assertRaises(FileExistsError): self.abort()
        with self.assertRaises(S.W.AdmissionError): self.manager.admit(self.point, self.request)
        self.launch.assert_not_called()
        self.assert_held()

    def test_decision_sync_failure_keeps_winner_and_never_creates_admission(self):
        self.prepare()
        original_sync = os.fsync
        def failed_sync(fd):
            if (self.manager.directory(self.point) / 'decision.json').exists():
                raise OSError('decision durability unknown')
            return original_sync(fd)
        with mock.patch.object(S.W.RESERVED.os, 'fsync', side_effect=failed_sync), self.assertRaisesRegex(OSError, 'durability unknown'):
            self.manager.admit(self.point, self.request)
        self.assertFalse(self.admission_dir().exists())
        self.launch.assert_not_called()
        with self.assertRaises((ValueError, OSError)): self.abort()
        with self.assertRaises((ValueError, OSError)): self.manager.admit(self.point, self.request)
        self.assert_held()

    def test_changed_decision_after_admission_construction_blocks_claim_creation(self):
        self.prepare()
        self.manager.admit(self.point, self.request)
        admission = S.W.Admission(self.fixture.state, self.point)
        path = self.manager.directory(self.point) / 'decision.json'
        body = path.read_bytes()
        path.rename(path.with_name('decision-evidence'))
        path.write_bytes(body)
        path.chmod(0o600)
        with self.assertRaisesRegex(S.W.AdmissionError, 'authority changed'):
            admission.create('claim.json', admission.event('claim'))
        self.assertFalse((self.admission_dir() / 'claim.json').exists())

    def test_v3_request_missing_preparation_and_changed_reservation_are_held(self):
        self.prepare()
        self.manager.admit(self.point, self.request)
        directory = self.manager.directory(self.point)
        directory.rename(directory.with_name(self.point + '-evidence'))
        with self.assertRaisesRegex(S.W.AdmissionError, 'no preparation provenance'):
            S.W.Admission(self.fixture.state, self.point)

    def test_changed_saved_point_is_rejected_before_decision_or_launch(self):
        self.prepare()
        path = self.manager.directory(self.point) / 'point-reservation.json'
        changed = copy.deepcopy(self.reservation)
        changed['ownerId'] = 2
        path.write_bytes(S.P.canonical(changed))
        with self.assertRaises(S.W.AdmissionError): self.manager.admit(self.point, self.request)
        self.assertFalse((self.manager.directory(self.point) / 'decision.json').exists())
        self.launch.assert_not_called()
        self.assert_held()

    def test_existing_admission_authority_cannot_be_reused_for_early_reservation(self):
        base = self.fixture.state / 'core-capture-admissions'
        base.mkdir(mode=0o700)
        self.admission_dir().mkdir(mode=0o700)
        with self.assertRaisesRegex(S.W.AdmissionError, 'operation authority'):
            self.prepare()
        self.assertFalse(self.fence().exists())

    def test_worker_launch_rejects_abort_partial_or_changed_decision(self):
        self.prepare()
        self.manager.admit(self.point, self.request)
        authority = self.authority()
        original = (authority.directory / 'decision.json').read_bytes()
        for body in (b'{', S.P.canonical(authority.expected('abort'))):
            path = authority.directory / 'decision.json'
            path.write_bytes(body)
            with mock.patch.object(S.W.subprocess, 'run') as subprocess:
                with self.assertRaises((ValueError, OSError)):
                    self.real_launch(self.fixture.state, self.point)
                with self.assertRaises((ValueError, OSError)):
                    S.W.run_worker(self.fixture.state, self.point)
                subprocess.assert_not_called()
            path.write_bytes(original)
        self.assertFalse((self.admission_dir() / 'launch-intent.json').exists())

    def test_request_and_handoff_downgrade_cannot_bypass_v3_preparation(self):
        self.prepare()
        self.manager.admit(self.point, self.request)
        admission = S.W.Admission(self.fixture.state, self.point)
        request, handoff = copy.deepcopy(admission.request), copy.deepcopy(admission.handoff)
        for value in (request, handoff):
            for key in S.W.RESERVED_BINDINGS: value.pop(key)
        request['schema'], handoff['schema'] = 'orbis.core-capture-admission.v1', 'orbis.core-capture-handoff.v1'
        request['handoffSha256'] = S.W.digest(S.P.canonical(handoff))
        for name, value in (('request.json', request), ('handoff.json', handoff)):
            (self.admission_dir() / name).write_bytes(S.P.canonical(value))
        with self.assertRaisesRegex(S.W.AdmissionError, 'downgraded'):
            S.W.Admission(self.fixture.state, self.point)

    def test_changed_lease_inode_or_preparation_identity_is_not_adopted(self):
        self.prepare()
        body = self.fence().read_bytes()
        self.fence().rename(self.fence().with_name('original-fence'))
        self.fence().write_bytes(body)
        self.fence().chmod(0o600)
        with self.assertRaisesRegex(S.W.AdmissionError, 'original reserved'):
            self.abort()
        self.launch.assert_not_called()

    def test_symlink_decision_keeps_hold(self):
        self.prepare()
        authority = self.authority()
        evidence = authority.directory / 'decision-evidence'
        evidence.write_bytes(b'{}')
        evidence.chmod(0o600)
        (authority.directory / 'decision.json').symlink_to(evidence)
        with self.assertRaises((ValueError, OSError)): self.abort()
        with self.assertRaises((ValueError, OSError)): self.manager.admit(self.point, self.request)
        self.assertTrue((authority.directory / 'decision.json').is_symlink())
        self.assert_held()

    def observation_request(self):
        return {'pointReservationSha256': S.R.sha256(self.reservation)}

    def test_lost_preparation_reply_is_observed_without_repeating_reservation(self):
        with mock.patch.object(self.manager, 'public_preparation', side_effect=ConnectionResetError('lost reply')):
            with self.assertRaises(ConnectionResetError):
                self.manager.prepare_reserved(self.point)
        original = self.authority()
        expected = self.manager.public_preparation(original.preparation)
        lease = S.A.seal(self.fence().stat())
        files = {path.name: path.read_bytes() for path in original.directory.iterdir() if path.is_file()}
        with mock.patch.object(S.W.LEASE.CoreCaptureLease, 'reserve', side_effect=AssertionError('reserve replay')), \
                mock.patch.object(S, 'create', side_effect=AssertionError('record creation')):
            for _ in range(2):
                self.assertEqual(self.manager.observe_reserved(self.point, self.observation_request()), expected)
        self.assertEqual(S.A.seal(self.fence().stat()), lease)
        self.assertEqual({path.name: path.read_bytes() for path in original.directory.iterdir() if path.is_file()}, files)
        self.assertEqual(self.fixture.docker.calls, [])
        self.marker_read.assert_not_called()
        self.launch.assert_not_called()
        self.assert_held()

    def test_observation_rejects_invalid_request_and_wrong_saved_point(self):
        self.prepare()
        for request in (None, [], {}, {'pointReservationSha256': 'A' * 64},
                        {**self.observation_request(), 'retry': True}, {'pointReservationSha256': '0' * 64}):
            with self.subTest(request=request), self.assertRaises((ValueError, OSError)):
                self.manager.observe_reserved(self.point, request)
        self.assertFalse((self.authority().directory / 'decision.json').exists())
        self.launch.assert_not_called()
        self.assert_held()

    def test_observation_never_creates_a_missing_preparation(self):
        self.prepare()
        missing = self.manager.directory(F.OTHER)
        with self.assertRaises((ValueError, OSError)):
            self.manager.observe_reserved(F.OTHER, self.observation_request())
        self.assertFalse(missing.exists())
        self.assert_held()

    def test_observation_refuses_an_abort_decision(self):
        self.prepare()
        self.abort()
        with self.assertRaises(S.W.AdmissionError):
            self.manager.observe_reserved(self.point, self.observation_request())
        self.assert_held()

    def test_observation_refuses_an_admit_decision_without_worker_replay(self):
        self.prepare()
        authority = self.authority()
        with authority.lease().owner(), S.H.host_lock(self.fixture.root):
            authority.decide('admit', self.request['sourceHoldSha256'])
        with self.assertRaises(S.W.AdmissionError):
            self.manager.observe_reserved(self.point, self.observation_request())
        self.launch.assert_not_called()
        self.assert_held()

    def test_observation_refuses_missing_or_partial_record_and_preserves_lease(self):
        self.prepare()
        record = self.authority().directory / 'preparation.json'
        record.unlink()
        with self.assertRaises((ValueError, OSError)):
            self.manager.observe_reserved(self.point, self.observation_request())
        record.write_bytes(b'{"schema":')
        record.chmod(0o600)
        with self.assertRaises((ValueError, OSError)):
            self.manager.observe_reserved(self.point, self.observation_request())
        self.assertEqual(record.read_bytes(), b'{"schema":')
        self.assert_held()

    def test_observation_rejects_changed_source_and_saved_point(self):
        self.prepare()
        starts = self.fixture.docker.starts
        initial = starts.get(self.fixture.docker.controller_id, 'original-start')
        starts[self.fixture.docker.controller_id] = 'new-generation'
        with self.assertRaises(S.W.AdmissionError):
            self.manager.observe_reserved(self.point, self.observation_request())
        starts[self.fixture.docker.controller_id] = initial
        self.reservation['ownerId'] = 2
        with self.assertRaises(S.W.AdmissionError):
            self.manager.observe_reserved(self.point, {'pointReservationSha256': self.prepared['pointReservationSha256']})
        self.assert_held()

    def test_observation_requires_fresh_successful_durability_checks(self):
        self.prepare()
        lease = self.fence().read_bytes()
        with mock.patch.object(S.os, 'fsync', side_effect=OSError('injected sync failure')):
            with self.assertRaises(OSError):
                self.manager.observe_reserved(self.point, self.observation_request())
        self.assertEqual(self.fence().read_bytes(), lease)
        self.assertFalse((self.authority().directory / 'decision.json').exists())
        self.assert_held()

    def test_observation_refuses_existing_operation_authority(self):
        self.prepare()
        self.manager.capture.child(self.admission_dir().parent)
        self.manager.capture.child(self.admission_dir())
        with self.assertRaises(S.W.AdmissionError):
            self.manager.observe_reserved(self.point, self.observation_request())
        self.launch.assert_not_called()
        self.assert_held()

    def test_observation_refuses_same_content_replacement_of_original_lease(self):
        self.prepare()
        replacement = self.fence().with_name('replacement-fence')
        replacement.write_bytes(self.fence().read_bytes())
        replacement.chmod(0o600)
        replacement.replace(self.fence())
        with self.assertRaises(S.W.AdmissionError):
            self.manager.observe_reserved(self.point, self.observation_request())
        self.assert_held()

    def test_idle_guard_and_bad_request_are_not_bypassed_for_reserved_owner(self):
        self.prepare()
        self.service.require_idle_core.side_effect = ValueError('busy')
        with self.assertRaisesRegex(ValueError, 'busy'): self.abort()
        with self.assertRaisesRegex(ValueError, 'busy'): self.manager.admit(self.point, self.request)
        self.service.require_idle_core.side_effect = None
        for extra in ({'release': True}, {'path': '/tmp'}, {'sourceHoldSha256': 'a' * 64}):
            with self.assertRaises(S.W.AdmissionError):
                self.manager.abort_reserved(self.point, {'preparationSha256': self.prepared['preparationSha256'], **extra})
        self.assertFalse((self.authority().directory / 'decision.json').exists())


if __name__ == '__main__':
    unittest.main()
