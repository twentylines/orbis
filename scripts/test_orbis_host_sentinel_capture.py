import copy
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


T = load('test_orbis_host_core_capture_service.py', 'sentinel_custody_fixtures')
S, F = T.S, T.F
R = load('test_orbis_host_core_capture_reserved.py', 'sentinel_reserved_custody_fixtures')


class SentinelCustodyTests(unittest.TestCase):
    def setUp(self):
        self.fixture = F.CoreCaptureTests('test_real_review_checkpoint_and_same_id_resume_exclude_all_apps_and_proxy')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.enterContext(mock.patch.object(S.W, 'require_root'))
        self.enterContext(mock.patch.object(S.C.CoreCapture, 'source', side_effect=lambda: copy.deepcopy(self.fixture.source)))
        service = SimpleNamespace(root=self.fixture.root, state_dir=self.fixture.state,
                                  snapshots=self.fixture.snapshots, context=self.fixture.docker.context,
                                  lock=threading.Lock(), require_idle_core=mock.Mock())
        self.manager = S.CoreCaptureService(service)
        self.enterContext(mock.patch.object(self.manager, 'require_publication_capability'))
        self.enterContext(mock.patch.object(self.manager, 'require_namespace_access'))
        self.point = F.POINT
        self.reservation = {'version': 3, 'id': self.point, 'ownerId': 1, 'createdAt': 1,
                            'envelope': {'version': 1, 'keyId': 'a' * 64, 'nonce': 'b' * 24,
                                         'tag': 'c' * 32, 'value': 'd' * 86}}
        self.enterContext(mock.patch.object(self.manager, 'controller_reservation', return_value=self.reservation))
        self.launch = self.enterContext(mock.patch.object(S.W, 'launch_worker', return_value={'state': 'launch-requested'}))

    def source_hold(self, prepared):
        hold = {'schema': 'orbis.core-capture-source-hold.v2', 'id': self.point,
                'operatorAuthorizationId': F.OTHER, 'drainReservationId': F.OTHER,
                'preparationSha256': prepared['preparationSha256'], 'sourceSha256': prepared['sourceSha256'],
                'pointReservationSha256': prepared['pointReservationSha256'], 'controller': prepared['controller'],
                'queueDrain': {'pauseId': F.OTHER, 'generation': 1,
                               'queues': [{'name': name, 'messages': 0, 'consumers': 0} for name in sorted(S.QUEUES)]}}
        marker = S.P.canonical(hold)
        self.enterContext(mock.patch.object(self.manager, 'controller_marker', return_value=marker))
        return {'preparationSha256': prepared['preparationSha256'], 'sourceHoldSha256': S.W.digest(marker)}

    def test_absent_profile_preserves_existing_preparation(self):
        with mock.patch.object(self.manager.sentinel, '_invoke') as invoke:
            prepared = self.manager.prepare_bound(self.point)
            self.manager.admit(self.point, self.source_hold(prepared))
        invoke.assert_not_called()
        self.launch.assert_called_once()

    def test_key_custody_precedes_preparation_reply_and_drain(self):
        events = []
        original = S.create
        def create(directory, name, value):
            events.append(name)
            return original(directory, name, value)
        with mock.patch.object(S, 'create', side_effect=create), \
                mock.patch.object(self.manager.sentinel, 'reserve', side_effect=lambda *args: events.append('sentinel-reserve')):
            self.manager.prepare_bound(self.point)
        self.assertLess(events.index('point-reservation.json'), events.index('sentinel-reserve'))
        self.assertLess(events.index('sentinel-reserve'), events.index('preparation.json'))
        self.assertFalse(S.H.capture_fence_path(self.fixture.root).exists())
        self.launch.assert_not_called()

    def test_reservation_failure_never_publishes_preparation_or_launches(self):
        with mock.patch.object(self.manager.sentinel, 'reserve', side_effect=ValueError('custody unavailable')):
            with self.assertRaises(ValueError): self.manager.prepare_bound(self.point)
        self.assertFalse((self.manager.directory(self.point) / 'preparation.json').exists())
        self.assertTrue((self.manager.directory(self.point) / 'point-reservation.json').exists())
        self.assertFalse(S.H.capture_fence_path(self.fixture.root).exists())
        self.launch.assert_not_called()

    def test_draft_custody_failure_cannot_launch_capture(self):
        prepared = self.manager.prepare_bound(self.point)
        request = self.source_hold(prepared)
        with mock.patch.object(self.manager.sentinel, 'retain_draft', side_effect=ValueError('draft unavailable')):
            with self.assertRaises(ValueError): self.manager.admit(self.point, request)
        self.assertFalse((self.fixture.state / 'core-capture-admissions' / self.point).exists())
        self.assertFalse(S.H.capture_fence_path(self.fixture.root).exists())
        self.launch.assert_not_called()
        self.assertEqual(self.fixture.docker.calls, [])

    def test_retained_draft_precedes_worker_authority_and_launch(self):
        prepared = self.manager.prepare_bound(self.point)
        request = self.source_hold(prepared)
        def retained(reader, point, preparation, hold):
            self.assertEqual(point, self.point)
            self.assertEqual(preparation['pointReservationSha256'], prepared['pointReservationSha256'])
            self.assertEqual(hold, request['sourceHoldSha256'])
            self.assertFalse((self.fixture.state / 'core-capture-admissions' / self.point).exists())
            self.assertFalse(S.H.capture_fence_path(self.fixture.root).exists())
            self.launch.assert_not_called()
            return True
        with mock.patch.object(self.manager.sentinel, 'retain_draft', side_effect=retained) as retain:
            self.manager.admit(self.point, request)
        retain.assert_called_once()
        self.launch.assert_called_once()

    def test_marker_change_during_custody_refuses_admission(self):
        prepared = self.manager.prepare_bound(self.point)
        request = self.source_hold(prepared)
        def retain(*args):
            self.manager.controller_marker.return_value = b'changed marker'
            return True
        with mock.patch.object(self.manager.sentinel, 'retain_draft', side_effect=retain):
            with self.assertRaises(S.W.AdmissionError): self.manager.admit(self.point, request)
        self.launch.assert_not_called()
        self.assertFalse((self.fixture.state / 'core-capture-admissions' / self.point).exists())

    def test_external_backup_backing_is_verified_against_original_namespace(self):
        external = self.fixture.parent / 'external-backups'
        directory = external / 'time-machine'
        directory.mkdir(parents=True, mode=0o700)
        frame = {'id': 'a' * 64, 'imageId': 'sha256:' + 'b' * 64, 'startedAt': 'original'}
        source = SimpleNamespace(controller=frame, pid=123)
        row = {'Id': frame['id'], 'Image': frame['imageId'],
               'State': {'Running': True, 'StartedAt': 'original', 'Pid': 123},
               'Mounts': [{'Destination': '/data/backups', 'Source': str(external), 'Type': 'bind', 'RW': True}]}
        reader = SimpleNamespace(_object=mock.Mock(return_value=row))
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            self.assertEqual(self.manager.sentinel._source_directories(reader, source, fd), sorted((str(external), str(directory))))
            row['Mounts'][0]['Source'] = str(self.fixture.parent)
            with self.assertRaises((OSError, S.W.AdmissionError)):
                self.manager.sentinel._source_directories(reader, source, fd)
        finally:
            os.close(fd)

    def test_profile_removal_after_reservation_fails_closed(self):
        self.manager.prepare_bound(self.point)
        receipt = self.manager.directory(self.point) / S.SENTINEL.RECEIPT
        receipt.write_bytes(b'{}')
        receipt.chmod(0o600)
        with self.assertRaises(S.W.AdmissionError):
            self.manager.sentinel.require_reserved(self.point, self.manager.read(receipt.parent, 'preparation.json')[0])

    def test_output_limits_and_failure_are_sanitized(self):
        launcher = self.fixture.parent / 'custody-launcher'
        for body in ("import sys;sys.stdout.write('x'*8193)", "import sys;sys.stderr.write('/private/secret');sys.exit(1)"):
            with self.subTest(body=body):
                launcher.write_text(body)
                with mock.patch.object(self.manager.sentinel, '_bundle', return_value=launcher):
                    with self.assertRaises(S.W.AdmissionError) as error:
                        self.manager.sentinel._invoke({}, 'capability')
                self.assertNotIn('/private/secret', str(error.exception))

    def test_descriptor_is_passed_without_key_bytes_in_request(self):
        launcher = self.fixture.parent / 'custody-launcher'
        launcher.write_text("import os,sys,json;fd=int(sys.argv[-1]);body=sys.stdin.buffer.read();print(json.dumps({'length':len(os.read(fd,33)),'body':body.decode()}))")
        key = self.fixture.parent / 'private-key'
        key.write_bytes(b'k' * 32)
        fd = os.open(key, os.O_RDONLY)
        try:
            with mock.patch.object(self.manager.sentinel, '_bundle', return_value=launcher):
                result = self.manager.sentinel._invoke({}, 'reserve', {'binding': 'été'}, fd)
        finally:
            os.close(fd)
        self.assertEqual(result, {'length': 32, 'body': '{"binding":"été"}'})


class ReservedSentinelCustodyTests(unittest.TestCase):
    setUp = R.ReservedCaptureTests.setUp
    prepare = R.ReservedCaptureTests.prepare
    authority = R.ReservedCaptureTests.authority
    fence = R.ReservedCaptureTests.fence
    assert_held = R.ReservedCaptureTests.assert_held

    def test_draft_failure_keeps_original_reservation_undecided(self):
        self.prepare()
        with mock.patch.object(self.manager.sentinel, 'retain_draft', side_effect=ValueError('custody unavailable')):
            with self.assertRaises(ValueError): self.manager.admit(self.point, self.request)
        self.assertFalse((self.manager.directory(self.point) / 'decision.json').exists())
        self.launch.assert_not_called()
        self.assert_held()

    def test_marker_change_during_custody_does_not_select_admission(self):
        self.prepare()
        def retained(*args):
            self.marker = b'changed marker'
            return True
        with mock.patch.object(self.manager.sentinel, 'retain_draft', side_effect=retained):
            with self.assertRaises(R.S.W.AdmissionError): self.manager.admit(self.point, self.request)
        self.assertFalse((self.manager.directory(self.point) / 'decision.json').exists())
        self.launch.assert_not_called()
        self.assert_held()

    def test_unchanged_custody_allows_existing_reserved_admission(self):
        self.prepare()
        with mock.patch.object(self.manager.sentinel, 'retain_draft', return_value=True) as retained:
            result = self.manager.admit(self.point, self.request)
        self.assertEqual(result['state'], 'launch-requested')
        retained.assert_called_once()
        self.launch.assert_called_once()
        self.assert_held()


if __name__ == '__main__':
    unittest.main()
