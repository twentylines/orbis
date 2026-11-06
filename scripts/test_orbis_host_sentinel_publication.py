import copy
import importlib.util
import os
from pathlib import Path
import unittest
from unittest import mock

import test_orbis_host_core_capture_completion as fixtures


SPEC = importlib.util.spec_from_file_location('sentinel_publication_subject', Path(__file__).with_name('orbis-host-sentinel-publication.py'))
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)


class SentinelPublicationTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.CoreCompletionTests('test_root_derived_verification_persists_evidence_and_never_releases_exclusion')
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.enterContext(mock.patch.object(P, 'W', fixtures.W))
        self.profile = {'catalogDirectory': '/protected-catalog'}
        self.bridge = mock.Mock()
        self.bridge.require_reserved.return_value = self.profile
        self.bridge.require_publication_reserved.return_value = self.profile
        self.bridge.publication_mode.return_value = 'sentinel.v1'
        self.bridge._invoke.side_effect = self.reply
        self.f.manager.sentinel = self.bridge

    def reply(self, profile, operation, request=None, fd=None):
        self.assertEqual(profile, self.profile)
        if operation == 'publication-capability':
            return P.PUBLICATION_CAPABILITY
        self.assertEqual(operation, 'publish')
        self.assertEqual(os.fstat(fd).st_size, request['expectation']['checkpoint']['bytes'])
        core = self.f.cli(self.f.joined.admission(), self.f.preparation['controller'],
                          ['--verify', fixtures.W.P.canonical(request['expectation']).decode()])
        result = {'schema': 'orbis-sentinel.prepared-publication.v1', 'id': self.f.point,
                  'dataState': 'verified', 'lifecycleState': 'unobserved',
                  **{k: request[k] for k in ('preparationSha256', 'sourceHoldSha256', 'terminalSha256')},
                  'publication': {'schema': 'orbis.core-capture-catalog-publication.v1', 'core': core,
                                  'keyId': self.f.reservation['envelope']['keyId'],
                                  'files': {'point.json': {'bytes': 1000, 'sha256': core['pointSha256']},
                                            'metadata.orbis': {'bytes': 1000, 'sha256': core['metadataSha256']},
                                            'core.orbis': {'bytes': core['cipherBytes'], 'sha256': core['cipherSha256']},
                                            'capture-draft.orbis': {'bytes': 1000, 'sha256': 'd' * 64}}}}
        return {'schema': 'orbis-sentinel.capture-custody-result.v1', 'operation': 'publish', 'result': result}

    def publish(self):
        return P.publish_completed(self.f.manager, self.f.point)

    def assert_no_publication(self):
        self.assertFalse((self.f.capture.directory / 'sentinel-publication.json').exists())
        self.f.assert_held()

    def test_publication_needs_no_live_controller_and_cannot_release_holds(self):
        self.f.manager.controller_marker.side_effect = AssertionError('Live Orbis was consulted')
        result = self.publish()
        proof, _ = self.f.joined.admission().read('sentinel-publication.json')
        self.assertEqual(result['state'], 'verified-data-awaiting-continuation')
        self.assertFalse(result['lifecycleComplete'])
        self.assertEqual(proof['publication']['terminalSha256'], fixtures.W.digest(self.f.joined.admission().read('worker-terminal.json')[1]))
        self.assertEqual(self.publish(), result)
        self.f.manager.controller_marker.assert_not_called()
        self.assertFalse((self.f.capture.directory / 'completion-ready.json').exists())
        self.f.assert_held()

    def test_unknown_or_failed_terminal_cannot_start_publication(self):
        for terminal in (None, {'state': 'recovery-required', 'workerQuiescent': True, 'workerExitCode': 1},
                         {'state': 'quiescent', 'workerQuiescent': False, 'workerExitCode': 0}):
            with self.subTest(terminal=terminal), mock.patch.object(fixtures.W.SUPERVISOR, 'read_terminal', return_value=terminal):
                with self.assertRaises(fixtures.W.AdmissionError): self.publish()
                self.assert_no_publication()
        self.assertFalse(any(call.args[1] == 'publish' for call in self.bridge._invoke.call_args_list))

    def test_legacy_capture_cannot_acquire_a_second_publisher_after_capture(self):
        self.f.manager.sentinel = fixtures.SERVICE.SENTINEL.SentinelCaptureCustody(
            self.f.manager, fixtures.W, fixtures.SERVICE.NAMESPACE)
        with self.assertRaises(fixtures.W.AdmissionError): self.publish()
        self.bridge._invoke.assert_not_called()
        self.assert_no_publication()

    def test_continuation_requires_the_same_sentinel_publication(self):
        self.publish()
        result = self.f.subject.prepare(self.f.point)
        self.assertEqual(result['state'], 'verified-awaiting-continuation')
        self.f.assert_held()

    def test_controller_cannot_replace_the_selected_sentinel_point(self):
        self.publish()
        original = self.f.cli
        def different(admission, controller, arguments):
            result = original(admission, controller, arguments)
            if arguments[0] == '--verify':
                result['manifestSha256'] = '0' * 64
            return result
        self.f.invoke.side_effect = different
        with self.assertRaises(ValueError): self.f.subject.prepare(self.f.point)
        self.assertFalse((self.f.capture.directory / 'completion-ready.json').exists())
        self.f.assert_held()

    def test_continuation_cannot_start_before_selected_publisher_finishes(self):
        self.f.invoke.reset_mock()
        with self.assertRaises(ValueError): self.f.subject.prepare(self.f.point)
        self.f.invoke.assert_not_called()
        self.assert_no_publication()

    def test_sentinel_proof_cannot_be_used_as_a_legacy_publication(self):
        self.publish()
        self.bridge.publication_mode.return_value = 'controller-restart.v1'
        with self.assertRaises(ValueError): self.f.subject.prepare(self.f.point)
        self.assertFalse((self.f.capture.directory / 'completion-ready.json').exists())
        self.f.assert_held()

    def test_missing_custody_and_changed_original_reservation_are_held(self):
        self.bridge.require_publication_reserved.return_value = None
        with self.assertRaises(fixtures.W.AdmissionError): self.publish()
        self.bridge._invoke.assert_not_called()
        self.bridge.require_publication_reserved.return_value = self.profile
        changed = {**self.f.reservation, 'ownerId': 2}
        self.f.write(self.f.directory, 'point-reservation.json', changed)
        with self.assertRaises((ValueError, fixtures.W.AdmissionError)): self.publish()
        self.assert_no_publication()

    def test_forged_point_terminal_or_inventory_cannot_persist_evidence(self):
        original = self.reply
        for kind in ('terminal', 'point', 'inventory'):
            def forged(profile, operation, request=None, fd=None):
                value = original(profile, operation, request, fd)
                if operation == 'publish':
                    if kind == 'terminal': value['result']['terminalSha256'] = '0' * 64
                    if kind == 'point': value['result']['publication']['core']['pointReservationSha256'] = '0' * 64
                    if kind == 'inventory': value['result']['publication']['files']['core.orbis']['sha256'] = '0' * 64
                return value
            self.bridge._invoke.side_effect = forged
            with self.subTest(kind=kind), self.assertRaises(ValueError): self.publish()
            self.assert_no_publication()

    def test_checkpoint_replacement_during_publication_is_held(self):
        original = self.reply
        def mutate(profile, operation, request=None, fd=None):
            value = original(profile, operation, request, fd)
            if operation == 'publish':
                file = self.f.state / 'time-machine-core' / self.f.point / 'portable-checkpoint/checkpoint.tar'
                with open(file, 'ab') as output: output.write(b'changed')
            return value
        self.bridge._invoke.side_effect = mutate
        with self.assertRaises(ValueError): self.publish()
        self.assert_no_publication()

    def test_changed_profile_after_publication_is_held(self):
        self.bridge.require_publication_reserved.side_effect = [self.profile, {**self.profile, 'changed': True}]
        with self.assertRaises(fixtures.W.AdmissionError): self.publish()
        self.assert_no_publication()


if __name__ == '__main__':
    unittest.main()
