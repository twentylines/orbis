import copy
import importlib.util
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


spec = importlib.util.spec_from_file_location('terminal_retirement_tests', Path(__file__).with_name('orbis-host-maintenance-retire.py'))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)


class RetirementTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.state = self.base / 'state'; self.state.mkdir(mode=0o700)
        self.identifier = str(uuid.uuid4())
        self.directory = self.state / 'core-overlays' / self.identifier
        self.directory.mkdir(parents=True, mode=0o700)
        self.directory.parent.chmod(0o700)
        self.authority = M.SERVICE.HOST.AUTHORITY
        self.enterContext(mock.patch.object(self.authority, 'OWNER', os.geteuid()))
        self.job = {'schema': 'orbis.host-service-job.v1', 'id': self.identifier, 'overlayId': self.identifier,
                    'state': 'complete', 'current': {'tag': 'previous'}, 'target': {'tag': 'current'}}
        self.job_file = self.state / 'job.json'
        M.SERVICE.write_private(self.job_file, self.job)
        self.raw = {'Id': 'a' * 64, 'Name': '/orbis-retained-' + self.identifier + '-responder', 'Image': 'sha256:' + 'b' * 64,
                    'Config': {'Labels': {'io.orbis.restore': self.identifier, 'io.orbis.restore.nonce': 'private-fixture-nonce',
                                          'io.orbis.restore.role': 'responder'}},
                    'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0}},
                    'State': {'Running': True, 'Paused': False, 'Restarting': False, 'StartedAt': 'fixture-generation-1'},
                    'seal': 'c' * 64}
        self.record = {'id': self.identifier, 'current': self.job['current'], 'target': self.job['target'],
                       'phase': 'active', 'decision': None,
                       'nonce': 'private-fixture-nonce', 'responderId': self.raw['Id'],
                       'source': {'imageId': self.raw['Image'], 'daemonId': 'selected-daemon'},
                       'definitions': {'responder': 'd' * 64},
                       'intents': {'responder': {'name': self.raw['Name'][1:], 'body': {'HostConfig': copy.deepcopy(self.raw['HostConfig'])}}}}
        self.runtime = mock.Mock()
        self.runtime.inspect.side_effect = lambda identifier: (
            {'Id': 'f' * 64, 'Name': '/runtipi', 'Config': {'Image': 'published'}} if identifier == 'runtipi' else copy.deepcopy(self.raw))
        self.runtime.bounded_output.return_value = b'{"state":"idle"}'
        self.runtime.definition.side_effect = lambda raw: raw['seal']
        self.runtime.reader._object.return_value = {'ID': 'selected-daemon'}
        def check_intent(raw, body):
            if raw['HostConfig']['RestartPolicy'] != body['HostConfig']['RestartPolicy']:
                raise ValueError('intent mismatch')
        self.runtime.check_intent.side_effect = check_intent
        self.runtime.change.side_effect = self.change
        self.overlay = SimpleNamespace(runtime=self.runtime, P=M.SERVICE.HOST.IDENTITY.PUBLICATION,
                                       authority=self.authority, read=lambda _: copy.deepcopy(self.record))
        self.service = SimpleNamespace(root=self.base, context='fixture', state_dir=self.state, job_file=self.job_file,
                                       maintenance_file=self.state / 'helper-maintenance.json',
                                       current_manifest=lambda: {'tag': 'current'}, core_overlays=lambda: self.overlay,
                                       require_restart_clear=mock.Mock(), require_package_clear=mock.Mock(),
                                       HOST=SimpleNamespace(current_core=lambda *_: {'state': 'running', 'health': 'healthy', 'image': 'published'},
                                                            LOCK_DESCRIPTOR=SimpleNamespace(get=lambda: 'held-test-lock'),
                                                            controller_reference=lambda *_: 'published'))
        self.retirement = M.Retirement(self.service)

    def change(self, arguments):
        self.assertEqual(arguments[-1], self.raw['Id'])
        if arguments[0] == 'update':
            self.raw['HostConfig']['RestartPolicy']['Name'] = 'no'
        elif arguments[0] == 'stop':
            self.raw['State']['Running'] = False
        else:
            self.fail('unexpected Docker mutation')

    def approval(self):
        plan, _ = self.retirement.review(self.identifier)
        return M.digest(self.overlay.P, plan)

    def test_review_is_read_only_and_wrong_approval_changes_nothing(self):
        before = self.job_file.read_bytes()
        self.approval()
        self.assertEqual(self.job_file.read_bytes(), before)
        self.assertFalse((self.directory / 'retirement.json').exists())
        with self.assertRaisesRegex(ValueError, 'exact retirement plan'):
            self.retirement.apply(self.identifier, 'unapproved')
        self.runtime.change.assert_not_called()
        self.assertFalse((self.directory / 'retirement.json').exists())
        other = str(uuid.uuid4())
        self.assertIsNone(self.retirement.receipt(other))
        self.assertFalse((self.state / 'core-overlays' / other).exists())

    def test_explicit_retirement_preserves_original_creation_seal_and_is_idempotent(self):
        original = copy.deepcopy(self.record)
        approval = self.approval()
        receipt = self.retirement.apply(self.identifier, approval)
        self.assertEqual(receipt['phase'], 'complete')
        self.assertEqual(self.record, original)
        self.assertEqual(receipt['plan']['storedDefinition'], 'd' * 64)
        self.assertEqual(receipt['plan']['approvedDefinition'], 'c' * 64)
        self.assertFalse(self.raw['State']['Running'])
        self.assertEqual((self.directory / 'retirement.json').stat().st_mode & 0o777, 0o600)
        self.runtime.change.reset_mock()
        self.assertEqual(self.retirement.apply(self.identifier, approval), receipt)
        self.runtime.change.assert_not_called()

    def test_stop_failure_preserves_approval_and_resumes_after_restart_policy_change(self):
        approval = self.approval()
        def fail_stop(arguments):
            if arguments[0] == 'stop':
                raise RuntimeError('interrupted stop')
            self.change(arguments)
        self.runtime.change.side_effect = fail_stop
        with self.assertRaises(RuntimeError):
            self.retirement.apply(self.identifier, approval)
        self.assertEqual(self.retirement.receipt(self.identifier)['phase'], 'approved')
        self.assertTrue(self.raw['State']['Running'])
        self.runtime.change.side_effect = self.change
        self.retirement = M.Retirement(self.service)
        self.assertEqual(self.retirement.apply(self.identifier, approval)['phase'], 'complete')

    def test_identity_generation_daemon_and_intent_changes_never_gain_stop_authority(self):
        original = copy.deepcopy(self.raw)
        for field, value in [('Id', 'e' * 64), ('Image', 'sha256:' + 'e' * 64), ('Name', '/other-service')]:
            self.raw = {**copy.deepcopy(original), field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.retirement.review(self.identifier)
        self.raw = copy.deepcopy(original)
        approval = self.approval()
        self.raw['State']['StartedAt'] = 'another-generation'
        with self.assertRaises(ValueError):
            self.retirement.apply(self.identifier, approval)
        self.raw = copy.deepcopy(original)
        self.raw['Config']['Labels']['io.orbis.restore.role'] = 'worker'
        with self.assertRaises(ValueError): self.retirement.review(self.identifier)
        self.raw = copy.deepcopy(original)
        self.runtime.reader._object.return_value = {'ID': 'another-daemon'}
        with self.assertRaises(ValueError): self.retirement.review(self.identifier)
        self.runtime.change.assert_not_called()

    def test_changed_definition_after_stop_never_writes_a_completion_receipt(self):
        approval = self.approval()
        def replace_seal(arguments):
            self.change(arguments)
            if arguments[0] == 'stop':self.raw['seal'] = 'e' * 64
        self.runtime.change.side_effect = replace_seal
        with self.assertRaises(ValueError): self.retirement.apply(self.identifier, approval)
        self.assertEqual(self.retirement.receipt(self.identifier)['phase'], 'approved')
        self.assertEqual(self.record['definitions']['responder'], 'd' * 64)

    def test_previously_disabled_restart_can_be_reviewed_but_an_unlocked_caller_cannot_apply(self):
        self.raw['HostConfig']['RestartPolicy']['Name'] = 'no'
        approval = self.approval()
        self.service.HOST.LOCK_DESCRIPTOR.get = lambda: None
        with self.assertRaisesRegex(ValueError, 'host operation lock'):
            self.retirement.apply(self.identifier, approval)
        self.runtime.change.assert_not_called()
        self.assertFalse((self.directory / 'retirement.json').exists())
        self.service.HOST.LOCK_DESCRIPTOR.get = lambda: 'held-test-lock'
        self.assertEqual(self.retirement.apply(self.identifier, approval)['phase'], 'complete')

    def test_overlay_consumes_only_complete_identity_bound_root_review(self):
        spec = importlib.util.spec_from_file_location('retirement_overlay_consumer', Path(__file__).with_name('orbis-host-maintenance-overlay.py'))
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        consumer = object.__new__(module.CoreOverlay)
        consumer.root, consumer.context = self.service.root, self.service.context
        consumer.runtime, consumer.P, consumer.authority = self.runtime, self.overlay.P, self.authority
        consumer.directory = lambda _: self.directory
        consumer.read = lambda _: copy.deepcopy(self.record)
        self.assertFalse(consumer.settled(self.job))
        self.retirement.apply(self.identifier, self.approval())
        self.assertTrue(consumer.settled(self.job))
        self.raw['State']['Running'] = True
        self.assertFalse(consumer.settled(self.job))
        self.raw['State']['Running'] = False
        self.record['nonce'] = 'different-intent'
        self.assertFalse(consumer.settled(self.job))
        self.record['nonce'] = 'private-fixture-nonce'
        self.runtime.change.reset_mock()
        self.raw['seal'] = 'e' * 64
        self.assertFalse(consumer.settled(self.job))
        self.runtime.change.assert_not_called()

    def test_backend_maintenance_or_changed_intent_blocks_retirement(self):
        self.runtime.bounded_output.return_value = b'{"state":"restoring"}'
        with self.assertRaises(ValueError):self.retirement.review(self.identifier)
        self.runtime.bounded_output.return_value = b'{"state":"idle"}'
        self.runtime.check_intent.side_effect = ValueError('changed creation intent')
        with self.assertRaises(ValueError):self.retirement.review(self.identifier)
        self.runtime.change.assert_not_called()

    def test_nonterminal_or_unhealthy_controller_and_unprotected_receipts_are_rejected(self):
        self.job['state'] = 'running';M.SERVICE.write_private(self.job_file, self.job)
        with self.assertRaises(ValueError):self.retirement.review(self.identifier)
        self.job['state'] = 'complete';M.SERVICE.write_private(self.job_file, self.job)
        self.service.HOST.current_core = lambda *_: {'state': 'running', 'health': 'unhealthy', 'image': 'published'}
        with self.assertRaises(ValueError):self.retirement.review(self.identifier)
        (self.directory / 'retirement.json').symlink_to(self.job_file)
        with self.assertRaises((OSError, ValueError)):self.retirement.receipt(self.identifier)
        self.runtime.change.assert_not_called()


if __name__ == '__main__':
    unittest.main()
