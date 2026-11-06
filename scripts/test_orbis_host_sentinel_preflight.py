"""Publication selection before drain, with explicit custody/Engine seams."""
import contextlib
import copy
import os
import unittest
from unittest import mock

import test_orbis_host_sentinel_capture as fixtures

S = fixtures.S


class SentinelPreflightTests(unittest.TestCase):
    def setUp(self):
        fixtures.SentinelCustodyTests.setUp(self)
        self.recovery_capability = self.enterContext(mock.patch.object(self.manager, 'require_sentinel_recovery_capability'))
    source_hold = fixtures.SentinelCustodyTests.source_hold

    def enroll(self):
        base = self.fixture.parent / 'namespace-data'
        base.mkdir(mode=0o700)
        (base / 'keys').mkdir(mode=0o700)
        key = base / 'keys/master-v1.key'
        key.write_bytes(b'k' * 32)
        key.chmod(0o600)
        descriptor = os.open(base, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, descriptor)
        namespace = mock.MagicMock()
        namespace.directory.side_effect = lambda **kwargs: contextlib.nullcontext(descriptor)
        guard = mock.MagicMock()
        guard.__enter__.return_value = namespace
        self.enterContext(mock.patch.object(S.NAMESPACE, 'CaptureNamespace', return_value=guard))
        bridge = self.manager.sentinel
        self.profile = {'schema': 'orbis.host.sentinel-capture-profile.v1', 'installationId': 'a' * 64,
                        'catalogDirectory': str(self.fixture.parent / 'catalog'), 'recoveryImageId': 'sha256:' + 'b' * 64,
                        'bundleDirectory': str(self.fixture.parent / 'bundle'), 'bundleSha256': 'c' * 64}
        self.preflight = {'schema': 'orbis-sentinel.capture-image-preflight.v1', 'imageId': self.profile['recoveryImageId'],
                          'workers': copy.deepcopy(S.SENTINEL.IMAGE_WORKERS), 'lifecycleAuthority': False}
        self.enterContext(mock.patch.object(bridge, '_profile', side_effect=lambda: copy.deepcopy(self.profile)))
        self.enterContext(mock.patch.object(bridge, '_source_directories', return_value=[str(base)]))
        self.invoke = self.enterContext(mock.patch.object(bridge, '_invoke', side_effect=self.reply))

    def reply(self, profile, operation, request=None, fd=None):
        if operation == 'capability':
            return S.SENTINEL.CAPABILITY
        if operation == 'image-check-capability':
            return S.SENTINEL.IMAGE_CHECK_CAPABILITY
        if operation == 'publication-capability':
            return S.SENTINEL.PUBLICATION_CAPABILITY
        if operation == 'export-capability':
            return S.W.load('orbis-host-sentinel-reader.py', 'sentinel_preflight_export_fixture').EXPORT_CAPABILITY
        if operation == 'check-publication-image':
            self.assertIsNone(fd)
            return {'schema': 'orbis-sentinel.capture-custody-result.v1', 'operation': operation,
                    'result': copy.deepcopy(self.preflight)}
        self.assertIn(operation, {'reserve', 'reserve-for-publication'})
        self.assertEqual(os.fstat(fd).st_size, 32)
        self.assertEqual(request['schema'], 'orbis-sentinel.capture-' + operation + '.v1')
        result = {'id': self.point, 'jobId': self.point.replace('-', ''), 'installationId': profile['installationId'],
                  'sourceSha256': request['sourceSha256'], 'ownerId': self.reservation['ownerId'],
                  'createdAt': self.reservation['createdAt'], 'dataState': 'reserved', 'lifecycleState': 'unobserved',
                  'archiveBytes': 0, 'files': []}
        if operation == 'reserve-for-publication':
            result = {'custody': result, 'imagePreflight': copy.deepcopy(self.preflight)}
        return {'schema': 'orbis-sentinel.capture-custody-result.v1', 'operation': operation, 'result': result}

    def assert_not_started(self):
        self.assertFalse(S.H.capture_fence_path(self.fixture.root).exists())
        self.launch.assert_not_called()
        self.assertEqual(self.fixture.docker.calls, [])

    def test_explicit_publication_binds_four_workers_before_preparation_and_drain(self):
        self.enroll()
        prepared = self.manager.prepare_bound(self.point, publication='sentinel.v1')
        record = self.manager.read(self.manager.directory(self.point), 'preparation.json')[0]
        self.assertEqual(self.manager.sentinel.publication_mode(self.point, record), 'sentinel.v1')
        self.assertEqual(self.manager.sentinel.require_publication_reserved(self.point, record), self.profile)
        self.assertEqual(self.invoke.call_args_list[-1].args[1], 'reserve-for-publication')
        self.assertEqual(prepared['version'], 2)
        self.assert_not_started()
        calls = self.invoke.call_count
        self.assertEqual(self.manager.prepare_bound(self.point, publication='sentinel.v1'), prepared)
        self.assertEqual(self.invoke.call_count, calls)
        with self.assertRaises(S.W.AdmissionError): self.manager.prepare_bound(self.point)
        self.assert_not_started()

    def test_old_profile_still_uses_unchanged_custody_and_cannot_switch_publisher(self):
        self.enroll()
        self.manager.prepare_bound(self.point)
        record = self.manager.read(self.manager.directory(self.point), 'preparation.json')[0]
        self.assertEqual(self.manager.sentinel.publication_mode(self.point, record), 'controller-restart.v1')
        self.assertEqual([c.args[1] for c in self.invoke.call_args_list], ['capability', 'reserve'])
        with self.assertRaises(S.W.AdmissionError): self.manager.prepare_bound(self.point, publication='sentinel.v1')
        with self.assertRaises(S.W.AdmissionError): self.manager.sentinel.require_publication_reserved(self.point, record)
        self.assert_not_started()

    def test_unenrolled_sentinel_cannot_become_the_publisher(self):
        with self.assertRaises(S.W.AdmissionError): self.manager.prepare_bound(self.point, publication='sentinel.v1')
        self.assertFalse(self.manager.directory(self.point).exists())
        self.assert_not_started()

    def test_older_source_cannot_be_forced_into_new_recovery(self):
        self.enroll()
        self.recovery_capability.side_effect = S.W.AdmissionError('Source does not support Sentinel recovery')
        with self.assertRaises(S.W.AdmissionError): self.manager.prepare_bound(self.point, publication='sentinel.v1')
        self.assertFalse(self.manager.directory(self.point).exists())
        self.invoke.assert_not_called()
        self.assert_not_started()

    def test_source_recovery_capability_is_a_fixed_controller_probe(self):
        frame = {'id': 'd' * 64}
        operation = S.CoreCaptureService.require_sentinel_recovery_capability
        with mock.patch.object(S.C.D.DockerRestoreRuntime, 'bounded_output', return_value=S.P.canonical(S.SENTINEL_RECOVERY_CAPABILITY)) as bounded:
            operation(self.manager, frame)
        self.assertEqual(bounded.call_args.args[1], ['docker', '--context', self.manager.context, 'exec', frame['id'],
                         '/usr/local/bin/node', '/app/core-capture-publication.mjs', '--sentinel-recovery-capability'])
        with mock.patch.object(S.C.D.DockerRestoreRuntime, 'bounded_output', return_value=S.P.canonical({**S.SENTINEL_RECOVERY_CAPABILITY, 'version': True})):
            with self.assertRaises(S.W.AdmissionError): operation(self.manager, frame)

    def test_missing_image_worker_keeps_preparation_unpublished(self):
        self.enroll()
        del self.preflight['workers']['image-inventory']
        with self.assertRaises(S.W.AdmissionError): self.manager.prepare_bound(self.point, publication='sentinel.v1')
        self.assertFalse((self.manager.directory(self.point) / 'preparation.json').exists())
        self.assertFalse((self.manager.directory(self.point) / S.SENTINEL.RECEIPT).exists())
        self.assertFalse(self.manager.directory(self.point).exists())
        self.assert_not_started()

    def test_unsupported_image_can_be_corrected_without_consuming_the_point(self):
        self.enroll()
        inventory = self.preflight['workers'].pop('image-inventory')
        with self.assertRaises(S.W.AdmissionError): self.manager.prepare_bound(self.point, publication='sentinel.v1')
        self.assertFalse(self.manager.directory(self.point).exists())
        self.preflight['workers']['image-inventory'] = inventory
        self.manager.prepare_bound(self.point, publication='sentinel.v1')
        self.assert_not_started()

    def test_reserved_preparation_also_checks_before_consuming_its_identity(self):
        self.enroll()
        del self.preflight['workers']['image-inventory']
        with self.assertRaises(S.W.AdmissionError): self.manager.prepare_reserved(self.point, publication='sentinel.v1')
        self.assertFalse(self.manager.directory(self.point).exists())
        self.assert_not_started()

    def test_preflight_receipt_replacement_or_loss_cannot_be_admitted(self):
        self.enroll()
        prepared = self.manager.prepare_bound(self.point, publication='sentinel.v1')
        request = self.source_hold(prepared)
        receipt = self.manager.directory(self.point) / S.SENTINEL.IMAGE_PREFLIGHT
        receipt.write_bytes(S.P.canonical({**self.preflight, 'lifecycleAuthority': 0}))
        with self.assertRaises(S.W.AdmissionError): self.manager.admit(self.point, request)
        receipt.unlink()
        with self.assertRaises(FileNotFoundError): self.manager.admit(self.point, request)
        self.assert_not_started()

    def test_old_sentinel_is_not_asked_for_new_features_on_the_old_path(self):
        self.enroll()
        original = self.reply
        def old(profile, operation, request=None, fd=None):
            if operation == 'image-check-capability':
                raise S.W.AdmissionError('This older Sentinel has no image check')
            return original(profile, operation, request, fd)
        self.invoke.side_effect = old
        self.manager.prepare_bound(self.point)
        self.assert_not_started()


if __name__ == '__main__':
    unittest.main()
