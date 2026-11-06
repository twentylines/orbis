import copy
import importlib.util
import json
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


S = load('orbis-host-core-capture-service.py', 'core_admission_subject')
F = load('test_orbis_host_time_machine_core.py', 'core_admission_fixtures')
F.C = S.C


class CoreAdmissionTests(unittest.TestCase):
    bound = False

    def setUp(self):
        self.fixture = F.CoreCaptureTests('test_real_review_checkpoint_and_same_id_resume_exclude_all_apps_and_proxy')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.enterContext(mock.patch.object(S.W, 'require_root'))
        self.enterContext(mock.patch.object(S.W.CHECKPOINT, 'build', return_value={'fixture': 'portable-checkpoint'}))
        self.enterContext(mock.patch.object(S.C.CoreCapture, 'source', side_effect=lambda: copy.deepcopy(self.fixture.source)))
        self.service = SimpleNamespace(root=self.fixture.root, state_dir=self.fixture.state,
                      snapshots=self.fixture.snapshots, context=self.fixture.docker.context,
                      lock=threading.Lock(), require_idle_core=mock.Mock())
        self.manager = S.CoreCaptureService(self.service)
        self.capability = self.enterContext(mock.patch.object(self.manager, 'require_publication_capability'))
        self.namespace_access = self.enterContext(mock.patch.object(self.manager, 'require_namespace_access'))
        self.point = F.POINT
        self.reservation = {'version': 3, 'id': self.point, 'ownerId': 1, 'createdAt': 1,
                            'envelope': {'version': 1, 'keyId': 'a' * 64, 'nonce': 'b' * 24,
                                         'tag': 'c' * 32, 'value': 'd' * 86}}
        self.reservation_reader = self.enterContext(mock.patch.object(self.manager, 'controller_reservation',
            side_effect=lambda controller, point: copy.deepcopy(self.reservation)))
        self.marker = b''
        self.marker_reader = self.enterContext(mock.patch.object(self.manager, 'controller_marker', side_effect=lambda frame: self.marker))
        self.prepare = self.manager.prepare_bound if self.bound else self.manager.prepare
        self.prepared = self.prepare(self.point)
        self.hold = {'schema': 'orbis.core-capture-source-hold.v1', 'id': self.point,
                     'operatorAuthorizationId': F.OTHER, 'drainReservationId': F.OTHER,
                     'preparationSha256': self.prepared['preparationSha256'],
                     'sourceSha256': self.prepared['sourceSha256'], 'controller': self.prepared['controller'],
                     'queueDrain': {'pauseId': F.OTHER, 'generation': 1,
                                    'queues': [{'name': name, 'messages': 0, 'consumers': 0}
                                               for name in sorted(S.QUEUES)]}}
        if self.bound:
            self.hold.update(schema='orbis.core-capture-source-hold.v2',
                             pointReservationSha256=self.prepared['pointReservationSha256'])
        self.update_marker()
        self.launch = self.enterContext(mock.patch.object(S.W, 'launch_worker', return_value={
            'id': self.point, 'state': 'launch-requested'}))

    def update_marker(self):
        self.marker = S.P.canonical(self.hold)
        self.request = {'preparationSha256': self.prepared['preparationSha256'],
                        'sourceHoldSha256': S.W.digest(self.marker)}

    def fence(self):
        return S.H.capture_fence_path(self.fixture.root)

    def test_prepare_is_read_only_for_core_and_retries_only_identical_source(self):
        self.assertEqual(self.prepare(self.point), self.prepared)
        self.assertEqual(self.fixture.docker.calls, [])
        self.assertFalse(self.fence().exists())
        self.fixture.docker.starts[self.fixture.docker.controller_id] = 'changed-generation'
        with self.assertRaises(S.W.AdmissionError):
            self.prepare(self.point)
        self.assertEqual(self.fixture.docker.calls, [])

    def test_actual_source_drain_handoff_produces_worker_receipts_before_launch(self):
        def launch(state, point):
            self.assertIsNone(S.H.LOCK_DESCRIPTOR.get())
            admission = S.W.Admission(state, point)
            self.assertEqual(admission.handoff['controller'], self.prepared['controller'])
            self.assertTrue(self.fence().exists())
            self.assertEqual((admission.directory / 'source-hold.json').read_bytes(), self.marker)
            self.assertEqual(json.loads((admission.directory / 'acceptance.json').read_bytes())['sourceHoldSha256'], self.request['sourceHoldSha256'])
            with self.assertRaises(ValueError):
                with S.H.host_lock(self.fixture.root):
                    self.fail('The durable root reservation was released')
            return {'id': point, 'state': 'launch-requested'}
        self.launch.side_effect = launch
        result = self.manager.admit(self.point, self.request)
        self.assertEqual(result['state'], 'launch-requested')
        self.assertEqual(result['sourceHoldSha256'], S.W.digest(self.marker))
        self.assertEqual(self.fixture.docker.calls, [])
        self.launch.assert_called_once()

    def test_admission_runs_existing_worker_capture_without_releasing_library_hold(self):
        frame = {'unit': 'orbis-core-capture-' + self.point + '.service', 'invocationId': 'c' * 32, 'processId': os.getpid()}
        def launch(state, point):
            result = S.W.run_worker(state, point)
            self.assertEqual(result['state'], 'resumed-awaiting-publication')
            return result
        self.launch.side_effect = launch
        with mock.patch.object(S.W, 'supervision_identity', return_value=frame), mock.patch.object(S.W, 'verify_supervision'):
            result = self.manager.admit(self.point, self.request)
        self.assertEqual(result['state'], 'resumed-awaiting-publication')
        self.assertEqual(self.fixture.storage_capture.call_count, 1)
        self.fixture.restore.assert_not_called()
        self.assertTrue(self.fence().exists())
        with self.assertRaises(ValueError):
            with S.H.host_lock(self.fixture.root):
                self.fail('A copied checkpoint is not a published recovery point')

    def test_request_cannot_supply_a_path_command_or_drain_boolean(self):
        for extra in ({'path': '/elsewhere'}, {'writersStopped': True}, {'command': ['id']}, {'operatorAuthorizationId': F.OTHER}):
            with self.subTest(extra=extra), self.assertRaises(S.W.AdmissionError):
                self.manager.admit(self.point, {**self.request, **extra})
        self.marker_reader.assert_not_called()
        self.launch.assert_not_called()
        self.assertFalse(self.fence().exists())

    def test_marker_must_come_from_current_controller_and_match_exact_bytes(self):
        self.request['sourceHoldSha256'] = 'a' * 64
        with self.assertRaises(S.W.AdmissionError):
            self.manager.admit(self.point, self.request)
        self.launch.assert_not_called()
        self.assertFalse(self.fence().exists())

    def test_stale_source_or_controller_generation_cannot_reserve(self):
        self.fixture.source['creationReference'] = 'changed-source'
        with self.assertRaises(S.W.AdmissionError):
            self.manager.admit(self.point, self.request)
        self.marker_reader.assert_not_called()
        self.assertFalse(self.fence().exists())

    def test_frame_changed_during_marker_read_cannot_reserve(self):
        def changed(frame):
            self.fixture.docker.starts[frame['id']] = 'changed-during-read'
            return self.marker
        self.marker_reader.side_effect = changed
        with self.assertRaises(S.W.AdmissionError):
            self.manager.admit(self.point, self.request)
        self.assertFalse(self.fence().exists())
        self.launch.assert_not_called()

    def test_all_three_drained_queues_and_private_operator_binding_are_required(self):
        original = copy.deepcopy(self.hold)
        mutations = [lambda h: h['queueDrain']['queues'].pop(),
                     lambda h: h['queueDrain']['queues'][0].update(messages=1),
                     lambda h: h['queueDrain']['queues'][0].update(consumers=True),
                     lambda h: h['queueDrain'].update(pauseId=self.point),
                     lambda h: h['queueDrain'].update(generation=True),
                     lambda h: h.update(operatorAuthorizationId='not-authorized'),
                     lambda h: h.update(writersStopped=True)]
        for mutate in mutations:
            self.hold = copy.deepcopy(original)
            mutate(self.hold)
            self.update_marker()
            with self.assertRaises((ValueError, TypeError)):
                self.manager.admit(self.point, self.request)
            self.assertFalse(self.fence().exists())
        self.launch.assert_not_called()

    def test_root_idle_and_storage_review_fail_before_reservation(self):
        self.service.require_idle_core.side_effect = ValueError('busy')
        with self.assertRaises(ValueError):
            self.manager.admit(self.point, self.request)
        self.marker_reader.assert_not_called()
        self.assertFalse(self.fence().exists())

    def test_partial_authority_write_keeps_reserved_recovery_hold_and_never_launches(self):
        original = S.create
        def failed(directory, name, value):
            if name == 'request.json':
                raise OSError('write interrupted')
            return original(directory, name, value)
        with mock.patch.object(S, 'create', side_effect=failed), self.assertRaises(OSError):
            self.manager.admit(self.point, self.request)
        self.assertTrue(self.fence().exists())
        self.launch.assert_not_called()
        with self.assertRaises(ValueError):
            self.manager.admit(self.point, self.request)
        self.assertEqual(self.fixture.docker.calls, [])

    def test_lost_launch_response_or_repeated_acceptance_never_reserves_twice(self):
        self.launch.return_value = {'id': self.point, 'state': 'launch-unsettled'}
        self.assertEqual(self.manager.admit(self.point, self.request)['state'], 'launch-unsettled')
        with self.assertRaises(ValueError):
            self.manager.admit(self.point, self.request)
        self.launch.assert_called_once()
        self.assertTrue(self.fence().exists())

    def test_marker_read_failure_cannot_fall_back_to_request_claims(self):
        self.marker_reader.side_effect = OSError('source unavailable')
        with self.assertRaises(OSError):
            self.manager.admit(self.point, self.request)
        self.launch.assert_not_called()
        self.assertFalse(self.fence().exists())

    def test_symlinked_preparation_and_unknown_authority_names_rejected(self):
        path = self.manager.directory(self.point) / 'preparation.json'
        retained = path.with_name('retained.json')
        path.rename(retained)
        path.symlink_to(retained)
        with self.assertRaises((ValueError, OSError)):
            self.manager.admit(self.point, self.request)
        with self.assertRaises(S.W.AdmissionError):
            S.create(self.manager.directory(self.point), '../outside.json', {})
        self.assertFalse(self.fence().exists())


class BoundCoreAdmissionTests(CoreAdmissionTests):
    bound = True

    def test_namespace_or_filesystem_failure_precedes_reservation_and_downtime(self):
        self.reservation_reader.reset_mock()
        self.namespace_access.side_effect = OSError('namespace or filesystem unavailable')
        with self.assertRaises(OSError):
            self.manager.prepare_bound(F.OTHER)
        self.reservation_reader.assert_not_called()
        self.assertFalse(self.manager.directory(F.OTHER).exists())
        self.assertFalse(self.fence().exists())
        self.assertEqual(self.fixture.docker.calls, [])

    def test_unsupported_controller_is_rejected_before_reservation_drain_or_lease(self):
        self.reservation_reader.reset_mock()
        self.capability.side_effect = ValueError('unsupported controller')
        with self.assertRaises(ValueError):
            self.manager.prepare_bound(F.OTHER)
        self.reservation_reader.assert_not_called()
        self.assertFalse(self.manager.directory(F.OTHER).exists())
        self.assertFalse(self.fence().exists())
        self.assertEqual(self.fixture.docker.calls, [])

    def test_capability_probe_is_fixed_bounded_and_rejects_type_substitution(self):
        with mock.patch.object(S.C.D.DockerRestoreRuntime, 'bounded_output',
                               return_value=S.P.canonical(S.COMPLETION.CAPABILITY)) as output:
            S.CoreCaptureService.require_publication_capability(self.manager, self.prepared['controller'])
            self.assertEqual(output.call_args.args[1], ['docker', '--context', self.manager.context, 'exec',
                self.prepared['controller']['id'], '/usr/local/bin/node', '/app/core-capture-publication.mjs', '--capability'])
            self.assertEqual(output.call_args.args[2:], (8192, 10))
            output.return_value = S.P.canonical({**S.COMPLETION.CAPABILITY, 'version': True})
            with self.assertRaises(ValueError):
                S.CoreCaptureService.require_publication_capability(self.manager, self.prepared['controller'])

    def test_public_preparation_only_exposes_reservation_hash_and_v2(self):
        self.assertEqual(set(self.prepared), {'version', 'id', 'preparationSha256', 'sourceSha256',
                                             'controller', 'pointReservationSha256'})
        self.assertEqual(self.prepared['version'], 2)
        self.assertEqual(self.prepared['pointReservationSha256'], S.R.sha256(self.reservation))
        retained, body = self.manager.read(self.manager.directory(self.point), 'point-reservation.json')
        self.assertEqual(retained, self.reservation)
        self.assertEqual(body, S.R.canonical(retained))
        self.assertEqual((self.manager.directory(self.point) / 'point-reservation.json').stat().st_mode & 0o777, 0o600)

    def test_v2_preparation_cannot_be_reinterpreted_as_v1(self):
        with self.assertRaises(ValueError):
            self.manager.prepare(self.point)
        self.assertFalse(self.fence().exists())

    def test_reservation_changed_during_preparation_is_not_pinned(self):
        self.reservation['id'] = F.OTHER
        reads = []
        def changed(controller, point):
            reads.append(point)
            if len(reads) > 1:
                self.reservation['ownerId'] += 1
            return copy.deepcopy(self.reservation)
        self.reservation_reader.side_effect = changed
        with self.assertRaises(ValueError):
            self.manager.prepare_bound(F.OTHER)
        self.assertFalse((self.manager.directory(F.OTHER) / 'preparation.json').exists())
        self.assertFalse((self.manager.directory(F.OTHER) / 'point-reservation.json').exists())
        self.assertFalse(self.fence().exists())

    def test_source_changed_during_preparation_is_not_pinned(self):
        self.reservation['id'] = F.OTHER
        review = S.C.TX.review
        def changed(*args, **kwargs):
            result = review(*args, **kwargs)
            self.fixture.docker.starts[self.fixture.docker.controller_id] = 'changed-during-preparation'
            return result
        with mock.patch.object(S.C.TX, 'review', side_effect=changed), self.assertRaises(ValueError):
            self.manager.prepare_bound(F.OTHER)
        self.assertFalse((self.manager.directory(F.OTHER) / 'preparation.json').exists())
        self.assertFalse((self.manager.directory(F.OTHER) / 'point-reservation.json').exists())
        self.assertFalse(self.fence().exists())

    def test_change_after_pinning_fails_closed_without_replacing_original_reservation(self):
        self.reservation['id'] = F.OTHER
        original = copy.deepcopy(self.reservation)
        create = S.create
        def changed(directory, name, value):
            create(directory, name, value)
            if name == 'point-reservation.json':
                self.reservation['ownerId'] += 1
        with mock.patch.object(S, 'create', side_effect=changed), self.assertRaises(ValueError):
            self.manager.prepare_bound(F.OTHER)
        retained, _ = self.manager.read(self.manager.directory(F.OTHER), 'point-reservation.json')
        self.assertEqual(retained, original)
        with self.assertRaises(ValueError):
            self.manager.prepare_bound(F.OTHER)
        self.assertFalse(self.fence().exists())

    def test_reservation_change_blocks_reprepare_and_admit(self):
        for key, replacement in [('ownerId', 2), ('createdAt', 2), ('envelope', {**self.reservation['envelope'], 'value': 'e' * 86})]:
            with self.subTest(key=key):
                original = copy.deepcopy(self.reservation)
                self.reservation[key] = replacement
                with self.assertRaises(ValueError):
                    self.prepare(self.point)
                with self.assertRaises(ValueError):
                    self.manager.admit(self.point, self.request)
                self.reservation = original
                self.assertFalse(self.fence().exists())
        self.launch.assert_not_called()

    def test_marker_v1_or_wrong_reservation_hash_cannot_gain_v2_authority(self):
        original = copy.deepcopy(self.hold)
        for hold in [{key: value for key, value in original.items() if key != 'pointReservationSha256'},
                     {**original, 'schema': 'orbis.core-capture-source-hold.v1'},
                     {**original, 'pointReservationSha256': 'e' * 64}]:
            self.hold = hold
            self.update_marker()
            with self.assertRaises(ValueError):
                self.manager.admit(self.point, self.request)
            self.assertFalse(self.fence().exists())
        self.launch.assert_not_called()

    def test_reservation_changed_during_marker_read_never_reserves(self):
        def changed(controller):
            self.reservation['ownerId'] += 1
            return self.marker
        self.marker_reader.side_effect = changed
        with self.assertRaises(ValueError):
            self.manager.admit(self.point, self.request)
        self.launch.assert_not_called()
        self.assertFalse(self.fence().exists())

    def test_source_changed_during_reservation_read_never_reserves(self):
        def changed(controller, point):
            self.fixture.docker.starts[controller['id']] = 'changed-during-point-read'
            return copy.deepcopy(self.reservation)
        self.reservation_reader.side_effect = changed
        with self.assertRaises(ValueError):
            self.manager.admit(self.point, self.request)
        self.marker_reader.assert_not_called()
        self.assertFalse(self.fence().exists())

    def test_retained_reservation_cannot_be_missing_symlinked_or_changed(self):
        path = self.manager.directory(self.point) / 'point-reservation.json'
        retained = path.with_name('retained-reservation.json')
        path.rename(retained)
        with self.assertRaises((ValueError, OSError)):
            self.manager.admit(self.point, self.request)
        path.symlink_to(retained)
        with self.assertRaises((ValueError, OSError)):
            self.manager.admit(self.point, self.request)
        path.unlink()
        S.create(path.parent, path.name, {**self.reservation, 'ownerId': 2})
        with self.assertRaises(ValueError):
            self.manager.admit(self.point, self.request)
        self.launch.assert_not_called()
        self.assertFalse(self.fence().exists())

    def test_fixed_controller_reader_bounds_and_validates_point(self):
        point = {**self.reservation, 'kind': 'orbis-core', 'coreFormat': 'orbis.time-machine-core.v1',
                 'core': None, 'status': 'capturing', 'backupJobId': None, 'issue': None,
                 'archiveBytes': 0, 'archiveSha256': None, 'metadataSha256': None}
        with mock.patch.object(S.C.D.DockerRestoreRuntime, 'bounded_output', return_value=json.dumps(point).encode()) as output:
            result = S.CoreCaptureService.controller_reservation(self.manager, self.prepared['controller'], self.point)
            self.assertEqual(result, self.reservation)
            arguments = output.call_args.args
            self.assertEqual(arguments[1], ['docker', '--context', self.manager.context, 'exec',
                             self.prepared['controller']['id'], '/usr/local/bin/node', '-e', S.R.POINT_READER, self.point])
            self.assertEqual(arguments[2:], (32768, 10))
            with self.assertRaises(ValueError):
                S.CoreCaptureService.controller_reservation(self.manager, self.prepared['controller'], '../point')
            self.assertEqual(output.call_count, 1)

    def test_reservation_is_written_before_preparation_and_failure_never_upgrades(self):
        point = F.OTHER
        self.reservation['id'] = point
        original = S.create
        writes = []
        def interrupted(directory, name, value):
            writes.append(name)
            if name == 'preparation.json':
                raise OSError('interrupted after pinning')
            return original(directory, name, value)
        with mock.patch.object(S, 'create', side_effect=interrupted), self.assertRaises(OSError):
            self.manager.prepare_bound(point)
        self.assertEqual(writes, ['point-reservation.json', 'preparation.json'])
        self.assertTrue((self.manager.directory(point) / 'point-reservation.json').is_file())
        self.assertFalse((self.manager.directory(point) / 'preparation.json').exists())
        with self.assertRaises((ValueError, OSError)):
            self.manager.prepare_bound(point)
        self.assertFalse(self.fence().exists())


class LegacyPreparationTests(unittest.TestCase):
    bound = False
    setUp = CoreAdmissionTests.setUp
    update_marker = CoreAdmissionTests.update_marker

    def test_legacy_preparation_does_not_read_or_publish_reservation(self):
        self.reservation_reader.assert_not_called()
        self.assertEqual(self.prepared['version'], 1)
        self.assertNotIn('pointReservationSha256', self.prepared)
        self.assertFalse((self.manager.directory(self.point) / 'point-reservation.json').exists())
        with self.assertRaises(ValueError):
            self.manager.prepare_bound(self.point)


if __name__ == '__main__':
    unittest.main()
