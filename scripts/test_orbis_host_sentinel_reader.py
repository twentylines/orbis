"""Joined protected publication records and actual bounded exporter subprocesses."""
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import test_orbis_host_sentinel_publication as fixture

SPEC = importlib.util.spec_from_file_location('sentinel_reader_subject', Path(__file__).with_name('orbis-host-sentinel-reader.py'))
R = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(R)


class PublicationReaderTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture.SentinelPublicationTests('runTest')
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.W = fixture.fixtures.W
        self.reader = R.SentinelPublicationReader(self.f.f.manager, self.W)
        self.point = self.f.f.point
        self.source = {'sourceSha256': self.f.f.preparation['sourceSha256'],
                       'sourceHoldSha256': self.W.digest(self.f.f.hold_body)}

    def test_selected_unpublished_job_reports_waiting_without_mutation(self):
        status = self.reader.status(self.point, self.source)
        self.assertEqual(status, {'version': 1, 'id': self.point, 'publisher': 'sentinel.v1',
                                 'state': 'awaiting-publication', **self.source})
        self.f.assert_no_publication()
        self.f.bridge._invoke.assert_not_called()

    def test_verified_status_is_bound_to_original_protected_records(self):
        self.f.publish()
        status = self.reader.status(self.point, self.source)
        self.assertEqual(status['state'], 'verified')
        proof, body = self.f.f.joined.admission().read('sentinel-publication.json')
        self.assertEqual(status['receiptSha256'], self.W.digest(body))
        self.assertEqual(status['publication'], proof['publication']['publication'])
        self.assertEqual(status['publicationSha256'], self.W.digest(self.W.P.canonical(status['publication'])))
        self.f.f.assert_held()

    def automatic_profile(self):
        self.f.profile['schema'] = 'orbis.host.sentinel-capture-profile.v2'
        self.f.profile['publication'] = 'sentinel.v1'

    def automatic_event(self, *, result=None):
        admission = self.f.f.joined.admission()
        self.f.f.write(admission.directory, 'sentinel-auto-launch.json', admission.event('sentinel-auto-launch',
            terminalSha256=self.W.digest(admission.read('worker-terminal.json')[1]), publicationSourceSha256='a' * 64))
        if result is not None:
            self.f.f.write(admission.directory, 'sentinel-auto-result.json', admission.event('sentinel-auto-result',
                state=result, returnCode=0 if result == 'verified' else 1,
                proofSha256=self.W.digest(admission.read('sentinel-publication.json')[1]) if result == 'verified' else None))

    def test_automatic_profile_needs_original_launch_and_success_before_continuation(self):
        self.automatic_profile()
        self.f.publish()
        for result in (None, 'pending', 'unsettled'):
            if result == 'pending': self.automatic_event()
            if result == 'unsettled': self.automatic_event(result='unsettled')
            self.assertEqual(self.reader.status(self.point, self.source)['state'],
                             'recovery-required' if result == 'unsettled' else 'awaiting-publication')
            with self.assertRaises(ValueError): self.f.f.subject.prepare(self.point)
            self.f.f.assert_held()
        self.automatic_event(result='verified')
        self.assertEqual(self.reader.status(self.point, self.source)['state'], 'verified')
        self.assertEqual(self.f.f.subject.prepare(self.point)['state'], 'verified-awaiting-continuation')
        self.f.f.assert_held()

    def test_automatic_outcome_is_rechecked_before_committing_retirement(self):
        self.automatic_profile()
        self.f.publish()
        self.automatic_event(result='verified')
        request = self.f.f.finish_request()
        self.automatic_event(result='unsettled')
        with self.assertRaises(ValueError): self.f.f.subject.finish(self.point, request)
        self.assertFalse((self.f.f.capture.directory / 'completion-commit.json').exists())
        self.f.f.assert_held()

    def test_legacy_path_is_explicit_and_never_accepts_independent_evidence(self):
        self.f.bridge.publication_mode.return_value = 'controller-restart.v1'
        self.assertEqual(self.reader.status(self.point, self.source)['state'], 'controller-publication')
        self.f.publish()
        with self.assertRaises(ValueError): self.reader.status(self.point, self.source)
        self.f.f.assert_held()

    def test_changed_source_or_terminal_cannot_be_read(self):
        self.f.publish()
        with self.assertRaises(ValueError): self.reader.status(self.point, {**self.source, 'sourceHoldSha256': '0' * 64})
        with mock.patch.object(self.W.SUPERVISOR, 'read_terminal', return_value=None):
            with self.assertRaises(ValueError): self.reader.status(self.point, self.source)
        self.f.f.assert_held()

    def test_fixed_names_and_publication_receipt_are_required_before_export(self):
        self.f.publish()
        status = self.reader.status(self.point, self.source)
        request = {**self.source, 'receiptSha256': status['receiptSha256'],
                   'publicationSha256': status['publicationSha256'], 'fileName': 'core.orbis'}
        for change in ({'fileName': 'master-v1.key'}, {'fileName': '../core.orbis'},
                       {'fileName': []}, {'receiptSha256': '0' * 64}, {'publicationSha256': '0' * 64}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                with self.reader.open_file(self.point, {**request, **change}): pass
        self.f.f.assert_held()


class ExportStreamTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sentinel-export-')
        self.addCleanup(self.temp.cleanup)
        self.launcher = Path(self.temp.name) / 'export.py'
        self.bridge = SimpleNamespace(_bundle=mock.Mock(return_value=self.launcher))
        self.recheck = mock.Mock()

    def stream(self, payload=b'x' * 150000, suffix='', expected=None):
        self.launcher.write_text('import sys\nsys.stdin.buffer.read()\nsys.stdout.buffer.write(' + repr(payload) + ')\nsys.stdout.buffer.flush()\n' + suffix)
        stream = R.ExportStream(self.bridge, {}, {}, {'bytes': len(payload) if expected is None else expected,
                                'sha256': hashlib.sha256(payload).hexdigest()}, self.recheck)
        self.addCleanup(stream.close)
        return stream

    def test_exact_bytes_and_final_acknowledgement_before_final_chunk(self):
        stream = self.stream()
        chunks = []
        while block := stream.read(65536): chunks.append(block)
        self.assertEqual(b''.join(chunks), b'x' * 150000)
        self.recheck.assert_called_once()
        stream.complete()

    def test_final_read_preserves_the_requested_bound(self):
        stream = self.stream(b'abc')
        self.assertEqual(stream.read(1), b'a')
        self.assertEqual(stream.read(1), b'b')
        self.assertEqual(stream.read(1), b'c')
        self.assertEqual(stream.read(1), b'')
        stream.complete()

    def test_late_failure_never_delivers_the_final_chunk(self):
        stream = self.stream(suffix='sys.exit(1)\n')
        delivered = bytearray()
        with self.assertRaises(R.PublicationReadError):
            while block := stream.read(65536): delivered.extend(block)
        self.assertEqual(len(delivered), 150000 - 65536)
        self.recheck.assert_not_called()
        with self.assertRaises(R.PublicationReadError): stream.read(65536)
        with self.assertRaises(R.PublicationReadError): stream.complete()

    def test_wrong_length_or_root_recheck_failure_never_completes(self):
        for expected in (149999, 150001):
            with self.subTest(expected=expected):
                stream = self.stream(expected=expected)
                with self.assertRaises(R.PublicationReadError):
                    while stream.read(65536): pass
                stream.close()
        self.recheck.side_effect = ValueError('changed root authority')
        stream = self.stream(b'abc')
        with self.assertRaises(ValueError): stream.read(65536)
        with self.assertRaises(R.PublicationReadError): stream.complete()


if __name__ == '__main__':
    unittest.main()
