import copy
from contextlib import contextmanager
import os
from pathlib import Path
import unittest
from unittest import mock

import test_orbis_host_core_capture_reserved as R


S, W = R.S, R.S.W
B = W.load('orbis-host-core-capture-abort.py', 'abort_subject')
N = W.load('orbis-host-core-capture-namespace.py', 'abort_filesystem_fixture')


class FilesystemNamespace(N.CaptureNamespace):
    """Inject controller/proc identity only; all fixed-file operations are real."""
    def __init__(self, worker, reader, controller, folder):
        self.W, self.reader, self.controller, self.folder = worker, reader, controller, folder
        self.rename = B.RETIRE.rename_noreplace

    def unchanged(self):
        pass

    @contextmanager
    def directory(self, point=None, *, storage_only=False):
        folder = self.folder / point if point else self.folder
        with self.W.A.protected_directory(folder) as checked:
            before = B.RETIRE.directory_identity(os.fstat(checked))
            parent = os.dup(checked)
        try:
            yield parent
            with self.W.A.protected_directory(folder) as checked:
                if B.RETIRE.directory_identity(os.fstat(checked)) != before:
                    raise N.NamespaceError('Fixture namespace directory changed')
        finally:
            os.close(parent)

    def close(self):
        pass


class AbortTests(unittest.TestCase):
    authority = R.ReservedCaptureTests.authority
    fence = R.ReservedCaptureTests.fence
    assert_held = R.ReservedCaptureTests.assert_held
    admission_dir = R.ReservedCaptureTests.admission_dir

    def setUp(self):
        R.ReservedCaptureTests.setUp(self)
        R.ReservedCaptureTests.prepare(self)
        self.intent = R.ReservedCaptureTests.abort(self)
        self.source = self.fixture.parent / 'controller-source'
        self.source.mkdir(mode=0o700)
        (self.source / self.point).mkdir(mode=0o700)
        self.marker_file = self.source / 'source-hold.json'
        self.marker_file.write_bytes(self.marker)
        self.marker_file.chmod(0o600)
        self.marker_identity = B.identity(self.marker_file.stat())
        self.terminal = {'schema': 'orbis.core-capture-source-abort-terminal.v1', 'id': self.point,
            'preparationSha256': self.prepared['preparationSha256'], 'decisionSha256': self.intent['decisionSha256'],
            'sourceHoldSha256': W.digest(self.marker), 'pointReservationSha256': self.prepared['pointReservationSha256'],
            'controller': self.prepared['controller'], 'queueGeneration': 1, 'sourceHoldIdentity': self.marker_identity}
        self.terminal_file = self.source / self.point / 'abort-terminal.json'
        self.write_source(self.terminal_file, self.terminal)
        self.request = {'preparationSha256': self.prepared['preparationSha256'],
            'decisionSha256': self.intent['decisionSha256'], 'terminalSha256': W.digest(W.P.canonical(self.terminal))}
        self.abort_manager = B.CoreCaptureAbort(self.manager, W)
        self.enterContext(mock.patch.object(self.abort_manager.namespace, 'CaptureNamespace',
            side_effect=lambda worker, reader, controller: FilesystemNamespace(worker, reader, controller, self.source)))

    def write_source(self, path, value):
        path.write_bytes(W.P.canonical(value))
        path.chmod(0o600)

    def prepare_abort(self):
        self.approved = self.abort_manager.prepare(self.point, self.request)
        return self.approved

    def ready(self):
        if not hasattr(self, 'approved'):
            self.prepare_abort()
        self.continuation = {'schema': 'orbis.core-capture-source-abort-continuation.v1', 'id': self.point,
            **{key: self.approved[key] for key in B.REQUEST | {'approvalSha256', 'sourceHoldSha256', 'pointReservationSha256', 'controller'}},
            'queueGeneration': 1,
            'queues': [{'name': name, 'messages': 0, 'consumers': 1} for name in sorted(B.QUEUES)]}
        self.ready_file = self.source / self.point / 'abort-continuation-ready.json'
        self.write_source(self.ready_file, self.continuation)
        self.finish_request = {**self.request, 'approvalSha256': self.approved['approvalSha256'],
                               'continuationSha256': W.digest(W.P.canonical(self.continuation))}

    def root_file(self, name):
        return self.manager.directory(self.point) / name

    def finish(self):
        return self.abort_manager.finish(self.point, self.finish_request)

    def test_prepare_intent_status_and_repeated_exact_approval_do_not_replay_source(self):
        self.assertEqual(self.abort_manager.intent_status(self.point, {'preparationSha256': self.prepared['preparationSha256']}), self.intent)
        approval = self.prepare_abort()
        before = W.A.seal(self.root_file('abort-approval.json').stat())
        self.assertEqual(self.prepare_abort(), approval)
        self.assertEqual(self.abort_manager.status(self.point, self.request), approval)
        self.assertEqual(W.A.seal(self.root_file('abort-approval.json').stat()), before)
        self.assertEqual(set(approval), {'version', 'id', 'state', 'preparationSha256', 'decisionSha256', 'terminalSha256',
            'approvalSha256', 'sourceSha256', 'sourceHoldSha256', 'pointReservationSha256', 'controller'})
        self.assertEqual(approval['state'], 'verified-abort-awaiting-continuation')
        self.assertEqual(self.fixture.docker.calls, [])
        self.assert_held()

    def test_real_idle_guard_allows_only_owned_abort_settlement(self):
        R.ReservedCaptureTests.use_real_idle_guard(self)
        self.service.busy = True
        with self.assertRaisesRegex(ValueError, 'update'):
            self.prepare_abort()
        self.assertFalse(self.root_file('abort-approval.json').exists())
        self.assert_held()
        self.service.busy = False
        self.ready()
        self.assertEqual(self.finish()['state'], 'complete')
        self.assertIsNone(self.service.HOST.CORE_CAPTURE_OWNER.get())

    def test_finish_preserves_marker_before_lease_and_historical_status_needs_no_live_authority(self):
        self.ready()
        lease_identity = B.RETIRE.lease_identity(self.fence().stat())
        result = self.finish()
        marker = self.source / ('source-hold-retired-' + self.point + '.json')
        lease = self.fence().with_name(self.fence().name + '.retired-' + self.point)
        self.assertFalse(self.marker_file.exists())
        self.assertFalse(self.fence().exists())
        self.assertEqual({key: B.identity(marker.stat())[key] for key in B.NAMES[:-1]},
                         {key: self.marker_identity[key] for key in B.NAMES[:-1]})
        self.assertEqual(B.RETIRE.lease_identity(lease.stat()), lease_identity)
        self.assertEqual(result['state'], 'complete')
        self.assertEqual(result['continuationSha256'], self.finish_request['continuationSha256'])
        self.assertFalse(self.admission_dir().exists())
        self.assertFalse(self.root_file('completion-commit.json').exists())
        with mock.patch.object(W.RESERVED, 'ReservedPreparation', side_effect=AssertionError('historical read used live lease')):
            self.assertEqual(self.abort_manager.status(self.point, self.request), result)
            self.assertEqual(self.finish(), result)

    def test_historical_status_preserves_different_newer_capture_selector(self):
        self.ready()
        result = self.finish()
        with S.H.host_lock(self.fixture.root):
            W.LEASE.CoreCaptureLease.reserve(S.H, self.fixture.root, self.service.context, R.F.OTHER, '7' * 64)
        original = self.fence().read_bytes()
        self.assertEqual(self.abort_manager.status(self.point, self.request), result)
        self.assertEqual(self.fence().read_bytes(), original)

    def test_absent_or_partial_source_terminal_and_marker_never_release(self):
        self.terminal_file.rename(self.terminal_file.with_name('terminal-evidence'))
        with self.assertRaises((ValueError, OSError)): self.prepare_abort()
        self.write_source(self.terminal_file, self.terminal)
        self.marker_file.write_bytes(b'{')
        with self.assertRaises((ValueError, OSError)): self.prepare_abort()
        self.marker_file.rename(self.source / 'partial-marker-evidence')
        with self.assertRaises((ValueError, OSError)): self.prepare_abort()
        self.assert_held()

    def test_changed_original_controller_or_saved_point_blocks_approval(self):
        self.fixture.docker.starts[self.prepared['controller']['id']] = 'different-startup'
        with self.assertRaises(ValueError): self.prepare_abort()
        self.assertFalse(self.root_file('abort-approval.json').exists())
        self.assert_held()

    def test_positive_abort_decision_and_exact_request_are_mandatory(self):
        for extra in ({'release': True}, {'path': '/elsewhere'}):
            with self.assertRaises(B.AbortError): self.abort_manager.prepare(self.point, {**self.request, **extra})
        self.write_source(self.root_file('decision.json'), self.authority().expected('admit', W.digest(self.marker)))
        with self.assertRaises(ValueError): self.prepare_abort()
        self.assert_held()

    def test_replaced_identical_marker_or_terminal_inode_cannot_finish(self):
        self.ready()
        self.terminal_file.rename(self.terminal_file.with_name('terminal-evidence'))
        self.write_source(self.terminal_file, self.terminal)
        with self.assertRaises(B.AbortError): self.finish()
        self.assertFalse(self.root_file('abort-commit.json').exists())
        self.assert_held()

    def test_replaced_identical_marker_inode_cannot_be_adopted(self):
        self.ready()
        self.marker_file.rename(self.source / 'marker-evidence')
        self.marker_file.write_bytes(self.marker)
        self.marker_file.chmod(0o600)
        with self.assertRaises(B.AbortError): self.finish()
        self.assertTrue(self.marker_file.exists())
        self.assert_held()

    def test_wrong_or_boolean_queue_coverage_and_changed_approval_are_rejected(self):
        self.ready()
        original = copy.deepcopy(self.continuation)
        variants = [lambda v: v.update(queueGeneration=True), lambda v: v['queues'][0].update(consumers=True),
                    lambda v: v['queues'][0].update(messages=1), lambda v: v['queues'].pop(),
                    lambda v: v.update(approvalSha256='0' * 64)]
        for mutate in variants:
            value = copy.deepcopy(original)
            mutate(value)
            self.write_source(self.ready_file, value)
            self.finish_request['continuationSha256'] = W.digest(W.P.canonical(value))
            with self.assertRaises(B.AbortError): self.finish()
            self.assertFalse(self.root_file('abort-commit.json').exists())
        self.assert_held()

    def test_partial_root_approval_is_not_rewritten(self):
        self.root_file('abort-approval.json').write_bytes(b'{')
        self.root_file('abort-approval.json').chmod(0o600)
        with self.assertRaises(ValueError): self.prepare_abort()
        self.assertEqual(self.root_file('abort-approval.json').read_bytes(), b'{')
        self.assert_held()

    def test_existing_approval_cannot_recreate_missing_terminal_authority(self):
        self.prepare_abort()
        terminal = self.root_file('abort-terminal.json')
        terminal.rename(terminal.with_name('root-terminal-evidence'))
        with self.assertRaises(FileNotFoundError): self.prepare_abort()
        with self.assertRaises(FileNotFoundError): self.abort_manager.status(self.point, self.request)
        self.assertFalse(terminal.exists())
        self.assert_held()

    def test_lost_response_after_source_rename_reconciles_only_committed_cleanup(self):
        self.ready()
        persist = B.Records.persist
        def interrupted(records, name, value):
            if name == 'abort-source-retired.json':
                raise OSError('source rename response lost')
            return persist(records, name, value)
        with mock.patch.object(B.Records, 'persist', interrupted), self.assertRaisesRegex(OSError, 'response lost'):
            self.finish()
        self.assertFalse(self.marker_file.exists())
        self.assertTrue(self.root_file('abort-commit.json').exists())
        self.assertFalse(self.root_file('abort-source-retired.json').exists())
        self.assert_held()
        with self.assertRaises((ValueError, OSError)): self.abort_manager.status(self.point, self.request)
        self.assertEqual(self.finish()['state'], 'complete')

    def test_source_retirement_witness_is_durable_before_global_lease_retirement(self):
        self.ready()
        def inspected(retirement):
            self.assertFalse(self.marker_file.exists())
            self.assertTrue(self.root_file('abort-source-retired.json').exists())
            raise OSError('before root rename')
        with mock.patch.object(B.AbortRetirement, 'retire_committed', inspected), self.assertRaisesRegex(OSError, 'before root'):
            self.finish()
        self.assert_held()
        self.assertEqual(self.finish()['state'], 'complete')

    def test_lost_response_after_global_retirement_has_positive_complete_status(self):
        self.ready()
        original = B.AbortRetirement.retire_committed
        def interrupted(retirement):
            original(retirement)
            raise OSError('after root rename response lost')
        with mock.patch.object(B.AbortRetirement, 'retire_committed', interrupted), self.assertRaisesRegex(OSError, 'response lost'):
            self.finish()
        self.assertEqual(self.abort_manager.status(self.point, self.request)['state'], 'complete')
        self.assertEqual(self.finish()['state'], 'complete')

    def test_missing_original_and_retired_lease_is_not_completion(self):
        self.ready()
        with (mock.patch.object(B.AbortRetirement, 'retire_committed', side_effect=OSError('hold before root rename')),
              self.assertRaises(OSError)):
            self.finish()
        self.fence().rename(self.fence().with_name('unexpected-lease-evidence'))
        with self.assertRaises((ValueError, OSError)): self.abort_manager.status(self.point, self.request)
        with self.assertRaises((ValueError, OSError)): self.finish()

    def test_source_no_clobber_conflict_preserves_unrelated_evidence_and_root_hold(self):
        self.ready()
        target = self.source / ('source-hold-retired-' + self.point + '.json')
        target.write_bytes(b'unrelated preserved source evidence')
        target.chmod(0o600)
        with self.assertRaises((ValueError, OSError)): self.finish()
        self.assertEqual(target.read_bytes(), b'unrelated preserved source evidence')
        self.assertTrue(self.marker_file.exists())
        self.assert_held()

    def test_root_no_clobber_conflict_preserves_source_witness_and_other_target(self):
        self.ready()
        target = self.fence().with_name(self.fence().name + '.retired-' + self.point)
        target.write_bytes(b'unrelated preserved root evidence')
        target.chmod(0o600)
        with self.assertRaises(ValueError): self.finish()
        self.assertEqual(target.read_bytes(), b'unrelated preserved root evidence')
        self.assertTrue(self.root_file('abort-source-retired.json').exists())
        self.assert_held()

    def test_replaced_retired_lease_and_changed_retirement_witness_are_rejected(self):
        self.ready()
        self.finish()
        target = self.fence().with_name(self.fence().name + '.retired-' + self.point)
        body = target.read_bytes()
        target.rename(target.with_name('retired-root-evidence'))
        target.write_bytes(body)
        target.chmod(0o600)
        with self.assertRaises(ValueError): self.abort_manager.status(self.point, self.request)

    def test_symlinked_source_witness_and_unsupported_complete_schema_are_held(self):
        self.ready()
        self.ready_file.rename(self.ready_file.with_name('ready-evidence'))
        self.ready_file.symlink_to(self.ready_file.with_name('ready-evidence'))
        with self.assertRaises((ValueError, OSError)): self.finish()
        self.assert_held()

    def test_terminal_schema_generation_and_decimal_identity_are_strict(self):
        for mutate in (lambda v: v.update(schema='orbis.core-capture-source-continuation.v1'),
                       lambda v: v.update(queueGeneration=True),
                       lambda v: v['sourceHoldIdentity'].update(inode=1),
                       lambda v: v['sourceHoldIdentity'].update(uid='00')):
            terminal = copy.deepcopy(self.terminal)
            mutate(terminal)
            self.write_source(self.terminal_file, terminal)
            request = {**self.request, 'terminalSha256': W.digest(W.P.canonical(terminal))}
            with self.assertRaises(ValueError): self.abort_manager.prepare(self.point, request)
        self.assertFalse(self.root_file('abort-approval.json').exists())
        self.assert_held()

    def test_missing_source_retirement_witness_after_completion_is_held(self):
        self.ready()
        self.finish()
        file = self.root_file('abort-source-retired.json')
        file.rename(file.with_name('source-retirement-evidence'))
        with self.assertRaises((ValueError, OSError)): self.abort_manager.status(self.point, self.request)
        with self.assertRaises((ValueError, OSError)): self.finish()
        self.assertFalse(file.exists())

    def test_abort_commit_cannot_be_reinterpreted_as_success_or_boolean_identity(self):
        self.ready()
        with mock.patch.object(FilesystemNamespace, 'retire_hold', side_effect=OSError('before source rename')), self.assertRaises(OSError):
            self.finish()
        records = self.abort_manager.records(self.point)
        commit = records.read('abort-commit.json')[0]
        for mutate in (lambda v: v.update(schema=B.RETIRE.SCHEMA), lambda v: v['leaseIdentity'].update(uid=False)):
            changed = copy.deepcopy(commit)
            mutate(changed)
            self.write_source(self.root_file('abort-commit.json'), changed)
            with self.assertRaises(ValueError): self.finish()
        self.assertTrue(self.marker_file.exists())
        self.assert_held()

    def test_marker_changed_immediately_before_rename_is_preserved(self):
        self.ready()
        different = W.P.canonical({**self.hold, 'sourceSha256': '8' * 64})
        changed = False
        def replace(namespace):
            nonlocal changed
            if not changed:
                changed = True
                self.marker_file.rename(self.source / 'original-marker-evidence')
                self.marker_file.write_bytes(different)
                self.marker_file.chmod(0o600)
        with mock.patch.object(FilesystemNamespace, 'unchanged', replace), self.assertRaises(N.NamespaceError):
            self.finish()
        self.assertEqual(self.marker_file.read_bytes(), different)
        self.assertFalse((self.source / ('source-hold-retired-' + self.point + '.json')).exists())
        self.assert_held()

    def test_source_fsync_failure_after_rename_requires_positive_reconciliation(self):
        self.ready()
        source_inode = self.source.stat().st_ino
        sync = os.fsync
        def interrupted(fd):
            if os.fstat(fd).st_ino == source_inode and not self.marker_file.exists():
                raise OSError('source rename sync failed')
            return sync(fd)
        with mock.patch.object(N.os, 'fsync', side_effect=interrupted), self.assertRaisesRegex(OSError, 'sync failed'):
            self.finish()
        self.assertFalse(self.marker_file.exists())
        self.assertFalse(self.root_file('abort-source-retired.json').exists())
        self.assert_held()
        self.assertEqual(self.finish()['state'], 'complete')

    def test_replaced_identical_ready_inode_cannot_reconcile_committed_abort(self):
        self.ready()
        with mock.patch.object(FilesystemNamespace, 'retire_hold', side_effect=OSError('before source rename')), self.assertRaises(OSError):
            self.finish()
        self.ready_file.rename(self.ready_file.with_name('original-ready-evidence'))
        self.write_source(self.ready_file, self.continuation)
        with self.assertRaisesRegex(B.AbortError, 'continuation inode'):
            self.finish()
        self.assertTrue(self.marker_file.exists())
        self.assert_held()


if __name__ == '__main__':
    unittest.main()
