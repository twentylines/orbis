import copy
import unittest
from unittest import mock

import test_orbis_host_core_capture_empty_abort as E

W, R, F = E.W, E.R, E.F
U = W.load('orbis-host-core-capture-unused-abort.py', 'unused_abort_subject')


class UnusedAbortTests(unittest.TestCase):
    authority = R.ReservedCaptureTests.authority
    fence = R.ReservedCaptureTests.fence
    assert_held = R.ReservedCaptureTests.assert_held
    admission_dir = R.ReservedCaptureTests.admission_dir
    write_source = F.AbortTests.write_source
    root_file = F.AbortTests.root_file

    def setUp(self):
        E.EmptyAbortTests.setUp(self)
        self.terminal = {'schema': 'orbis.core-capture-source-abort-terminal.v3', 'id': self.point,
            'preparationSha256': self.prepared['preparationSha256'], 'decisionSha256': self.intent['decisionSha256'],
            'pointReservationSha256': self.prepared['pointReservationSha256'], 'controller': self.prepared['controller'],
            'operatorAuthorizationId': R.F.OTHER, 'sourceMarker': 'absent', 'sourceAttempt': 'not-started'}
        self.write_source(self.terminal_file, self.terminal)
        self.request['terminalSha256'] = W.digest(W.P.canonical(self.terminal))
        self.subject = U.CoreCaptureUnusedAbort(self.manager, W)
        self.enterContext(mock.patch.object(self.subject.namespace, 'CaptureNamespace',
            side_effect=lambda worker, reader, controller: F.FilesystemNamespace(worker, reader, controller, self.source)))

    def settle(self):
        return self.subject.settle(self.point, self.request)

    def test_success_preserves_only_original_retired_lease(self):
        identity = U.BASE.RETIRE.lease_identity(self.fence().stat())
        result = self.settle()
        retired = self.fence().with_name(self.fence().name + '.retired-' + self.point)
        self.assertEqual(U.BASE.RETIRE.lease_identity(retired.stat()), identity)
        self.assertFalse(self.fence().exists())
        self.assertFalse(self.marker_file.exists())
        self.assertEqual(self.fixture.docker.calls, [])
        self.assertEqual(set(result), {'version', 'id', 'state', 'sourceMarker', 'sourceAttempt',
            'preparationSha256', 'decisionSha256', 'terminalSha256', 'commitSha256', 'sourceSha256',
            'pointReservationSha256', 'controller'})
        self.assertEqual(result['version'], 3)
        self.assertEqual(self.subject.status(self.point, self.request), result)
        self.assertEqual(self.settle(), result)

    def test_real_idle_guard_allows_only_owned_unused_abort_settlement(self):
        R.ReservedCaptureTests.use_real_idle_guard(self)
        self.service.busy = True
        with self.assertRaisesRegex(ValueError, 'update'):
            self.settle()
        self.assertFalse(self.root_file('abort-unused-commit.json').exists())
        self.assert_held()
        self.service.busy = False
        self.assertEqual(self.settle()['state'], 'complete')
        self.assertIsNone(self.service.HOST.CORE_CAPTURE_OWNER.get())

    def test_bad_terminal_and_downgrades_are_refused(self):
        for change in (lambda x: x.update(schema='orbis.core-capture-source-abort-terminal.v2'),
                       lambda x: x.update(schema='orbis.core-capture-source-abort-terminal.v1'),
                       lambda x: x.update(sourceAttempt='started'), lambda x: x.update(queues=[]),
                       lambda x: x.update(operatorAuthorizationId='invalid'), lambda x: x.pop('controller')):
            value = copy.deepcopy(self.terminal)
            change(value)
            self.write_source(self.terminal_file, value)
            request = {**self.request, 'terminalSha256': W.digest(W.P.canonical(value))}
            with self.assertRaises((ValueError, OSError)):
                self.subject.settle(self.point, request)
        self.assert_held()

    def test_positive_history_remains_complete_without_touching_a_verified_newer_lease(self):
        completed = self.settle()
        with R.S.H.host_lock(self.fixture.root):
            W.LEASE.CoreCaptureLease.reserve(R.S.H, self.fixture.root, self.manager.context, R.F.OTHER, '9' * 64)
        newer = self.fence().read_bytes()
        self.assertEqual(self.subject.status(self.point, self.request), completed)
        self.assertEqual(self.fence().read_bytes(), newer)
        self.assert_held()

    def test_source_continuation_contradicts_a_never_started_terminal(self):
        self.write_source(self.source / self.point / 'abort-continuation-ready.json', {'schema': 'unexpected-continuation'})
        with self.assertRaises((ValueError, OSError)):
            self.settle()
        self.assert_held()

    def test_missing_terminal_and_markers_block(self):
        self.terminal_file.rename(self.terminal_file.with_name('preserved'))
        with self.assertRaises((ValueError, OSError)): self.settle()
        self.write_source(self.terminal_file, self.terminal)
        for name in ('source-hold.json', 'source-hold-retired-' + self.point + '.json'):
            marker = self.source / name
            marker.write_bytes(b'foreign partial')
            marker.chmod(0o600)
            with self.assertRaises((ValueError, OSError)): self.settle()
            self.assertEqual(marker.read_bytes(), b'foreign partial')
            marker.rename(self.source / ('preserved-' + name))
        self.assert_held()

    def test_admit_and_operation_authority_block(self):
        authority = self.authority()
        self.write_source(self.root_file('decision.json'), authority.expected('admit', 'a' * 64))
        with self.assertRaises((ValueError, OSError)): self.settle()
        self.assert_held()

    def test_sync_failure_reconciles_only_original_transaction(self):
        with mock.patch.object(U, 'durable_records', side_effect=OSError('sync failed')):
            with self.assertRaises(OSError): self.settle()
        self.assertTrue(self.root_file('abort-unused-commit.json').exists())
        self.assert_held()
        with self.assertRaises((ValueError, OSError)): self.subject.status(self.point, self.request)
        self.assertEqual(self.settle()['state'], 'complete')

    def test_replaced_terminal_prevents_reconciliation(self):
        with mock.patch.object(U.Retirement, 'retire_committed', side_effect=OSError('rename failed')):
            with self.assertRaises(OSError): self.settle()
        self.terminal_file.rename(self.terminal_file.with_name('original-terminal'))
        self.write_source(self.terminal_file, self.terminal)
        with self.assertRaises((ValueError, OSError)): self.settle()
        self.assert_held()

    def test_missing_selector_and_protected_evidence_never_succeed(self):
        with mock.patch.object(U.Retirement, 'retire_committed', side_effect=OSError('rename failed')):
            with self.assertRaises(OSError): self.settle()
        self.fence().rename(self.fence().with_name('preserved-lease'))
        with self.assertRaises((ValueError, OSError)): self.subject.status(self.point, self.request)
        with self.assertRaises((ValueError, OSError)): self.settle()

    def test_operation_authority_and_restarted_source_block(self):
        self.admission_dir().mkdir(parents=True, mode=0o700)
        with self.assertRaises((ValueError, OSError)): self.settle()
        self.admission_dir().rmdir()
        self.fixture.docker.starts[self.prepared['controller']['id']] = 'replacement-startup'
        with self.assertRaises((ValueError, OSError)): self.settle()
        self.assert_held()

    def test_changed_lease_blocks(self):
        self.fence().rename(self.fence().with_name('original-lease'))
        with self.assertRaises((ValueError, OSError)): self.settle()

    def test_foreign_retired_selector_blocks(self):
        target = self.fence().with_name(self.fence().name + '.retired-' + self.point)
        target.write_bytes(b'foreign selector')
        target.chmod(0o600)
        with self.assertRaises((ValueError, OSError)): self.settle()
        self.assertEqual(target.read_bytes(), b'foreign selector')
        self.assert_held()

    def test_missing_committed_terminal_refuses_reconciliation(self):
        with mock.patch.object(U, 'durable_records', side_effect=OSError('sync failed')):
            with self.assertRaises(OSError): self.settle()
        self.root_file('abort-terminal.json').rename(self.root_file('preserved-terminal'))
        with self.assertRaises((ValueError, OSError)): self.settle()
        with self.assertRaises((ValueError, OSError)): self.subject.status(self.point, self.request)
        self.assert_held()

    def test_prior_abort_record_is_not_reinterpreted(self):
        self.write_source(self.root_file('abort-commit.json'), {'schema': 'orbis.core-capture-abort-commit.v2'})
        with self.assertRaises((ValueError, OSError)): self.settle()
        self.assert_held()
