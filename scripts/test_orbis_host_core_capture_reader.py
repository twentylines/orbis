"""Real joined sealed-copy/worker receipts and bounded archive transfers; no live Docker."""
import hashlib
import json
import os
import unittest
from unittest import mock

import test_orbis_host_core_checkpoint_worker as joined


W = joined.W
R = W.load('orbis-host-core-capture-reader.py', 'core_capture_reader_subject')


class CoreCaptureReaderTests(unittest.TestCase):
    def setUp(self):
        self.joined = joined.CheckpointWorkerTests('test_real_checkpoint_is_bound_by_worker_and_read_after_restart')
        self.joined.setUp()
        self.addCleanup(self.joined.doCleanups)
        self.worker = self.joined.worker
        self.fixture = self.worker.fixture
        self.reader = R.CoreCaptureReader(W, self.worker.state)
        self.hold = {'schema': 'orbis.core-capture-source-hold.v1', 'id': self.worker.point,
                     'sourceSha256': self.worker.request['sourceSha256'],
                     'operatorAuthorizationId': self.worker.handoff['operatorAuthorizationId'],
                     'drainReservationId': self.worker.handoff['drainReservationId'],
                     'preparationSha256': 'a' * 64, 'controller': self.worker.handoff['controller'],
                     'queueDrain': {'pauseId': self.worker.handoff['drainReservationId'], 'generation': 1,
                                    'queues': [{'name': name, 'messages': 0, 'consumers': 0}
                                               for name in ('a', 'b', 'c')]}}
        self.worker.write('source-hold.json', self.hold)
        self.source = {'sourceSha256': self.worker.request['sourceSha256'],
                       'sourceHoldSha256': W.digest(W.P.canonical(self.hold))}
        self.archive = self.fixture.directory / 'portable-checkpoint' / 'checkpoint.tar'

    def ready(self):
        self.worker.run_worker()
        self.status = self.reader.status(self.worker.point, self.source)
        self.request = {**self.source, **{key: self.status['ready'][key]
                       for key in ('captureReceiptSha256', 'checkpointArtifactSha256')}}
        return self.status

    def drain(self, stream):
        while stream.read(8192):
            pass

    def test_ready_receipt_uses_independent_canonical_settlement_and_exact_public_shape(self):
        result = self.ready()
        self.assertEqual(set(result), {'version', 'id', 'state', *R.SOURCE_FIELDS, 'ready'})
        ready = result['ready']
        self.assertEqual(set(ready), {'captureReceiptSha256', 'checkpointArtifactSha256', 'artifact'})
        settled = (self.worker.directory / 'settled.json').read_bytes()
        artifact = (self.archive.parent / 'artifact.json').read_bytes()
        self.assertEqual(ready['captureReceiptSha256'], hashlib.sha256(settled).hexdigest())
        self.assertEqual(ready['checkpointArtifactSha256'], hashlib.sha256(artifact).hexdigest())
        self.assertNotEqual(ready['captureReceiptSha256'], ready['checkpointArtifactSha256'])
        body = json.dumps(result)
        for private in (str(self.worker.root), str(self.worker.state), self.worker.request['leaseNonce']):
            self.assertNotIn(private, body)
        self.worker.assert_held()

    def test_status_does_not_read_archive_bytes(self):
        self.ready()
        actual_read = os.read

        def read(descriptor, size):
            details = os.fstat(descriptor)
            if (details.st_dev, details.st_ino) == (self.archive.stat().st_dev, self.archive.stat().st_ino):
                self.fail('Status read the checkpoint archive')
            return actual_read(descriptor, size)

        with mock.patch.object(R.os, 'read', side_effect=read):
            self.assertEqual(self.reader.status(self.worker.point, self.source), self.status)

    def test_real_bytes_stream_with_bounded_reads_and_approved_length_hash(self):
        self.ready()
        expected = self.archive.read_bytes()
        before = {path: (path.stat().st_mtime_ns, path.read_bytes())
                  for path in self.worker.state.rglob('*') if path.is_file()}
        actual_read = os.read
        with self.reader.open_checkpoint(self.worker.point, self.request) as stream:
            self.assertEqual(stream.bytes, len(expected))
            self.assertEqual(stream.sha256, hashlib.sha256(expected).hexdigest())
            chunks = []

            def read(descriptor, size):
                if descriptor == stream._descriptor:
                    self.assertLessEqual(size, R.CHUNK)
                return actual_read(descriptor, size)

            with mock.patch.object(R.os, 'read', side_effect=read):
                while data := stream.read(8192):
                    chunks.append(data)
            self.assertEqual(b''.join(chunks), expected)
            self.assertEqual(stream.delivered_count, len(expected))
            self.assertEqual(stream.delivered_sha256, stream.sha256)
        self.assertEqual(before, {path: (path.stat().st_mtime_ns, path.read_bytes())
                                 for path in self.worker.state.rglob('*') if path.is_file()})
        with self.assertRaises(R.CaptureReaderError):
            stream.read(1)
        self.worker.assert_held()

    def test_nonready_states_have_no_artifact_or_read_capability(self):
        self.assertEqual(self.reader.status(self.worker.point, self.source)['state'], 'reserved')
        with mock.patch.object(W.subprocess, 'run', return_value=mock.Mock(returncode=1)):
            W.launch_worker(self.worker.state, self.worker.point)
        status = self.reader.status(self.worker.point, self.source)
        self.assertEqual(status['state'], 'launch-unsettled')
        self.assertNotIn('ready', status)
        self.worker.supervision_check.side_effect = W.AdmissionError('fixture supervision failure')
        with self.assertRaises(W.AdmissionError):
            self.worker.run_worker()
        # A v2 launch cannot acquire a claim through a legacy supervision fixture.
        self.assertIsNone(W.Admission(self.worker.state, self.worker.point).read('claim.json', optional=True)[0])
        self.assertEqual(self.reader.status(self.worker.point, self.source)['state'], 'launch-unsettled')
        with self.assertRaises(R.CaptureReaderError):
            with self.reader.open_checkpoint(self.worker.point, {**self.source,
                    'captureReceiptSha256': 'a' * 64, 'checkpointArtifactSha256': 'b' * 64}):
                self.fail('A nonready capture streamed')

    def test_early_exit_and_cancellation_fail_without_releasing_lease(self):
        self.ready()
        for count in (0, 1):
            with self.subTest(count=count), self.assertRaises(R.CaptureReaderError):
                with self.reader.open_checkpoint(self.worker.point, self.request) as stream:
                    if count:
                        stream.read(count)
        with self.assertRaises(InterruptedError):
            with self.reader.open_checkpoint(self.worker.point, self.request) as stream:
                stream.read(1)
                raise InterruptedError('cancelled transfer')
        self.worker.assert_held()

    def test_invalid_read_sizes_poison_transfer_even_if_caught(self):
        self.ready()
        for size in (-1, 0, 65537, True, '1', None):
            with self.subTest(size=size), self.assertRaises(R.CaptureReaderError):
                with self.reader.open_checkpoint(self.worker.point, self.request) as stream:
                    with self.assertRaises(R.CaptureReaderError):
                        stream.read(size)

    def test_wrong_approvals_and_source_rejected(self):
        self.ready()
        for key in self.request:
            with self.subTest(key=key), self.assertRaises(ValueError):
                with self.reader.open_checkpoint(self.worker.point, {**self.request, key: '0' * 64}):
                    self.fail('A mismatched approval streamed')

    def test_unknown_fields_hash_shapes_and_path_traversal_rejected(self):
        for request in ({**self.source, 'path': '/etc/passwd'}, {}, None,
                        {**self.source, 'sourceSha256': 'A' * 64},
                        {**self.source, 'sourceSha256': True}):
            with self.subTest(request=request), self.assertRaises(ValueError):
                self.reader.status(self.worker.point, request)
        for point in ('../escape', '/etc/passwd', self.worker.point + '/checkpoint.tar',
                      'ABCDEFAB-0000-4000-8000-000000000001'):
            with self.subTest(point=point), self.assertRaises(ValueError):
                self.reader.status(point, self.source)

    def test_nonroot_status_and_transfer_rejected(self):
        self.ready()
        with mock.patch.object(W, 'require_root', side_effect=W.AdmissionError('Root required')):
            with self.assertRaises(W.AdmissionError):
                self.reader.status(self.worker.point, self.source)
            with self.assertRaises(W.AdmissionError):
                with self.reader.open_checkpoint(self.worker.point, self.request):
                    self.fail('Nonroot transfer opened')

    def test_legacy_settlement_without_artifact_is_unsupported(self):
        self.ready()
        job = self.fixture.capture.read(self.fixture.directory)
        del job['portableStorage']
        del job['settlement']['portableStorageSha256']
        self.fixture.capture.save(job)
        settled = json.loads((self.worker.directory / 'settled.json').read_bytes())
        del settled['checkpointArtifactSha256']
        settled['settlement'] = job['settlement']
        settled['captureJobSha256'] = W.digest(W.P.canonical(job))
        self.worker.write('settled.json', settled)
        status = self.reader.status(self.worker.point, self.source)
        self.assertEqual(status['state'], 'unsupported')
        self.assertNotIn('ready', status)
        with self.assertRaises(R.CaptureReaderError):
            with self.reader.open_checkpoint(self.worker.point, self.request):
                self.fail('Legacy capture streamed')

    def test_source_hold_schema_identity_and_binding_rejected(self):
        for key, value in (('schema', 'wrong'), ('id', 'wrong'), ('sourceSha256', '0' * 64)):
            hold = {**self.hold, key: value}
            self.worker.write('source-hold.json', hold)
            with self.subTest(key=key), self.assertRaises(R.CaptureReaderError):
                self.reader.status(self.worker.point, {**self.source,
                    'sourceHoldSha256': W.digest(W.P.canonical(hold))})

    def test_source_hold_or_request_change_during_stream_rejected(self):
        self.ready()
        for name in ('source-hold.json', 'request.json', 'handoff.json', 'settled.json'):
            file = self.worker.directory / name
            body = file.read_bytes()
            with self.subTest(name=name), self.assertRaises(ValueError):
                with self.reader.open_checkpoint(self.worker.point, self.request) as stream:
                    self.drain(stream)
                    file.write_bytes(body)
            file.write_bytes(body)

    def test_receipt_and_job_replacement_during_stream_rejected(self):
        self.ready()
        for file in (self.archive.parent / 'artifact.json', self.fixture.directory / 'job.json'):
            body = file.read_bytes()
            with self.subTest(file=file.name), self.assertRaises(ValueError):
                with self.reader.open_checkpoint(self.worker.point, self.request) as stream:
                    self.drain(stream)
                    file.write_bytes(body)

    def test_archive_content_mutation_and_trailing_bytes_rejected(self):
        self.ready()
        body = self.archive.read_bytes()
        for replacement in (bytes([body[0] ^ 1]) + body[1:], body + b'trailing', body[:-1]):
            with self.subTest(size=len(replacement)), self.assertRaises(ValueError):
                with self.reader.open_checkpoint(self.worker.point, self.request) as stream:
                    stream.read(1)
                    self.archive.write_bytes(replacement)
                    self.drain(stream)
            self.archive.write_bytes(body)

    def test_same_size_preexisting_corruption_fails_final_hash(self):
        self.ready()
        body = self.archive.read_bytes()
        self.archive.write_bytes(bytes([body[0] ^ 1]) + body[1:])
        self.assertEqual(self.reader.status(self.worker.point, self.source), self.status)
        with self.assertRaises(R.CaptureReaderError):
            with self.reader.open_checkpoint(self.worker.point, self.request) as stream:
                self.drain(stream)

    def test_short_read_fails_and_cannot_be_swallowed(self):
        self.ready()
        actual_read = os.read
        with self.assertRaises(R.CaptureReaderError):
            with self.reader.open_checkpoint(self.worker.point, self.request) as stream:
                def read(descriptor, size):
                    return b'' if descriptor == stream._descriptor else actual_read(descriptor, size)

                with mock.patch.object(R.os, 'read', side_effect=read), self.assertRaises(R.CaptureReaderError):
                    stream.read(8192)

    def test_changed_capture_receipt_binding_rejected_before_stream(self):
        self.ready()
        receipt = json.loads((self.worker.directory / 'settled.json').read_bytes())
        receipt['checkpointArtifactSha256'] = '0' * 64
        self.worker.write('settled.json', receipt)
        with self.assertRaises(ValueError):
            self.reader.status(self.worker.point, self.source)
        with self.assertRaises(ValueError):
            with self.reader.open_checkpoint(self.worker.point, self.request):
                self.fail('A changed receipt streamed')

    def test_lease_change_during_stream_rejected_and_never_removed(self):
        self.ready()
        with self.assertRaises(ValueError):
            with self.reader.open_checkpoint(self.worker.point, self.request) as stream:
                self.drain(stream)
                self.worker.fence.write_bytes(self.worker.fence.read_bytes())
        self.assertTrue(self.worker.fence.exists())

    def test_archive_path_replacement_symlink_hardlink_and_mode_rejected(self):
        self.ready()
        with self.assertRaises(ValueError):
            with self.reader.open_checkpoint(self.worker.point, self.request) as stream:
                self.drain(stream)
                replacement = self.archive.with_name('replacement')
                replacement.write_bytes(self.archive.read_bytes())
                replacement.chmod(0o600)
                replacement.replace(self.archive)
        original = self.archive.with_name('saved-original')
        self.archive.rename(original)
        self.archive.symlink_to(original)
        with self.assertRaises(OSError):
            with self.reader.open_checkpoint(self.worker.point, self.request):
                self.fail('A symlink streamed')
        self.archive.unlink()
        original.rename(self.archive)
        link = self.archive.with_name('additional-link')
        os.link(self.archive, link)
        with self.assertRaises(ValueError):
            with self.reader.open_checkpoint(self.worker.point, self.request):
                self.fail('A hardlinked archive streamed')
        link.unlink()
        self.archive.chmod(0o640)
        with self.assertRaises(ValueError):
            with self.reader.open_checkpoint(self.worker.point, self.request):
                self.fail('A nonprivate archive streamed')


if __name__ == '__main__':
    unittest.main()
