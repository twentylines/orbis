import copy
import os
import unittest
from unittest import mock

import test_orbis_host_core_capture_abort as F
import test_orbis_host_core_capture_reserved as R


S, W = R.S, R.S.W
E = W.load('orbis-host-core-capture-empty-abort.py', 'empty_abort_subject')


class EmptyAbortTests(unittest.TestCase):
    authority = R.ReservedCaptureTests.authority
    fence = R.ReservedCaptureTests.fence
    assert_held = R.ReservedCaptureTests.assert_held
    admission_dir = R.ReservedCaptureTests.admission_dir
    write_source = F.AbortTests.write_source
    root_file = F.AbortTests.root_file

    def setUp(self):
        R.ReservedCaptureTests.setUp(self)
        R.ReservedCaptureTests.prepare(self)
        self.intent = R.ReservedCaptureTests.abort(self)
        self.source = self.fixture.parent / 'never-attempted-source'
        self.source.mkdir(mode=0o700)
        (self.source / self.point).mkdir(mode=0o700)
        self.marker_file = self.source / 'source-hold.json'
        self.terminal = {'schema': 'orbis.core-capture-source-abort-terminal.v2', 'id': self.point,
            'preparationSha256': self.prepared['preparationSha256'], 'decisionSha256': self.intent['decisionSha256'],
            'pointReservationSha256': self.prepared['pointReservationSha256'], 'controller': self.prepared['controller'],
            'operatorAuthorizationId': R.F.OTHER, 'drainReservationId': R.F.OTHER, 'queueGeneration': 1,
            'queues': [{'name': name, 'messages': 0, 'consumers': 0} for name in sorted(E.BASE.QUEUES)], 'sourceMarker': 'absent'}
        self.terminal_file = self.source / self.point / 'abort-terminal.json'
        self.write_source(self.terminal_file, self.terminal)
        self.request = {'preparationSha256': self.prepared['preparationSha256'], 'decisionSha256': self.intent['decisionSha256'],
                        'terminalSha256': W.digest(W.P.canonical(self.terminal))}
        self.subject = E.CoreCaptureEmptyAbort(self.manager, W)
        self.enterContext(mock.patch.object(self.subject.namespace, 'CaptureNamespace',
            side_effect=lambda worker, reader, controller: F.FilesystemNamespace(worker, reader, controller, self.source)))

    def prepare_abort(self):
        self.approved = self.subject.prepare(self.point, self.request)
        return self.approved

    def ready(self):
        if not hasattr(self, 'approved'):
            self.prepare_abort()
        self.continuation = {'schema': 'orbis.core-capture-source-abort-continuation.v2', 'id': self.point,
            **{key: self.approved[key] for key in E.REQUEST | {'approvalSha256', 'pointReservationSha256', 'controller'}},
            'queueGeneration': 1, 'sourceMarker': 'absent',
            'queues': [{'name': name, 'messages': 0, 'consumers': 1} for name in sorted(E.BASE.QUEUES)]}
        self.ready_file = self.source / self.point / 'abort-continuation-ready.json'
        self.write_source(self.ready_file, self.continuation)
        self.finish_request = {**self.request, 'approvalSha256': self.approved['approvalSha256'],
                               'continuationSha256': W.digest(W.P.canonical(self.continuation))}

    def finish(self):
        return self.subject.finish(self.point, self.finish_request)

    def test_positive_terminal_approval_public_shape_and_read_like_reprepare(self):
        self.assertEqual(self.subject.intent_status(self.point, {'preparationSha256': self.prepared['preparationSha256']}), self.intent)
        approval = self.prepare_abort()
        before = W.A.seal(self.root_file('abort-approval.json').stat())
        self.assertEqual(self.prepare_abort(), approval)
        self.assertEqual(self.subject.status(self.point, self.request), approval)
        self.assertEqual(W.A.seal(self.root_file('abort-approval.json').stat()), before)
        self.assertEqual(set(approval), {'version', 'id', 'state', 'preparationSha256', 'decisionSha256', 'terminalSha256',
            'approvalSha256', 'sourceSha256', 'pointReservationSha256', 'controller', 'sourceMarker'})
        self.assertEqual(approval['version'], 2)
        self.assertEqual(approval['sourceMarker'], 'absent')
        self.assertFalse(self.marker_file.exists())
        self.assertEqual(self.fixture.docker.calls, [])
        self.assert_held()

    def test_marker_absence_without_positive_terminal_or_abort_never_authorizes(self):
        self.terminal_file.rename(self.terminal_file.with_name('terminal-evidence'))
        with self.assertRaises((ValueError, OSError)): self.prepare_abort()
        self.write_source(self.terminal_file, self.terminal)
        authority = self.authority()
        self.write_source(self.root_file('decision.json'), authority.expected('admit', 'a' * 64))
        with self.assertRaises(ValueError): self.prepare_abort()
        self.assertFalse(self.root_file('abort-approval.json').exists())
        self.assert_held()

    def test_every_active_marker_entry_is_preserved_and_refused(self):
        for index, body in enumerate((b'', b'{', self.marker)):
            self.marker_file.write_bytes(body)
            self.marker_file.chmod(0o600)
            with self.assertRaises(ValueError): self.prepare_abort()
            self.assertEqual(self.marker_file.read_bytes(), body)
            self.marker_file.rename(self.source / ('preserved-marker-' + str(index)))
        self.marker_file.symlink_to(self.source / 'missing-target')
        with self.assertRaises(ValueError): self.prepare_abort()
        self.assertTrue(self.marker_file.is_symlink())
        self.assert_held()

    def test_same_id_retired_marker_is_never_reinterpreted_as_never_attempted(self):
        target = self.source / ('source-hold-retired-' + self.point + '.json')
        target.write_bytes(b'preserved retired marker')
        target.chmod(0o600)
        with self.assertRaises(ValueError): self.prepare_abort()
        self.assertEqual(target.read_bytes(), b'preserved retired marker')
        self.assert_held()

    def test_terminal_version_audit_generation_and_drain_are_strict(self):
        changes = [lambda v: v.update(schema='orbis.core-capture-source-abort-terminal.v1'),
            lambda v: v.update(sourceHoldSha256='0' * 64), lambda v: v.update(operatorAuthorizationId='not-uuid'),
            lambda v: v.update(drainReservationId='not-uuid'), lambda v: v.update(queueGeneration=True),
            lambda v: v['queues'][0].update(consumers=1), lambda v: v['queues'][0].update(messages=False),
            lambda v: v['queues'].pop(), lambda v: v.update(sourceMarker='never-created')]
        for mutate in changes:
            value = copy.deepcopy(self.terminal)
            mutate(value)
            self.write_source(self.terminal_file, value)
            request = {**self.request, 'terminalSha256': W.digest(W.P.canonical(value))}
            with self.assertRaises(ValueError): self.subject.prepare(self.point, request)
        self.assertFalse(self.root_file('abort-approval.json').exists())
        self.assert_held()

    def test_finish_preserves_only_global_lease_and_positive_settlement(self):
        self.ready()
        expected = E.BASE.RETIRE.lease_identity(self.fence().stat())
        result = self.finish()
        retired = self.fence().with_name(self.fence().name + '.retired-' + self.point)
        self.assertFalse(self.fence().exists())
        self.assertEqual(E.BASE.RETIRE.lease_identity(retired.stat()), expected)
        self.assertFalse(self.marker_file.exists())
        self.assertFalse((self.source / ('source-hold-retired-' + self.point + '.json')).exists())
        self.assertFalse(self.root_file('abort-source-retired.json').exists())
        self.assertFalse(self.root_file('completion-commit.json').exists())
        self.assertEqual(result['state'], 'complete')
        self.assertEqual(result['version'], 2)
        self.assertNotIn('sourceHoldSha256', result)
        settled = self.subject.records(self.point).read('abort-source-settled.json')[0]
        self.assertEqual(settled['schema'], 'orbis.core-capture-abort-source-settled.v2')
        with mock.patch.object(W.RESERVED, 'ReservedPreparation', side_effect=AssertionError('historical read used live lease')):
            self.assertEqual(self.subject.status(self.point, self.request), result)
            self.assertEqual(self.finish(), result)

    def test_replaced_terminal_and_changed_original_source_are_held(self):
        self.ready()
        self.terminal_file.rename(self.terminal_file.with_name('terminal-evidence'))
        self.write_source(self.terminal_file, self.terminal)
        with self.assertRaises(ValueError): self.finish()
        self.assertFalse(self.root_file('abort-commit.json').exists())
        self.assert_held()

    def test_restarted_original_controller_cannot_be_settled(self):
        self.ready()
        self.fixture.docker.starts[self.prepared['controller']['id']] = 'replacement-startup'
        with self.assertRaises(ValueError): self.finish()
        self.assert_held()

    def test_wrong_ready_version_queues_or_generation_never_commit(self):
        self.ready()
        changes = [lambda v: v.update(schema='orbis.core-capture-source-abort-continuation.v1'),
            lambda v: v.update(queueGeneration=True), lambda v: v.update(queueGeneration=2),
            lambda v: v['queues'][0].update(consumers=True), lambda v: v['queues'].pop(),
            lambda v: v.update(sourceMarker='present')]
        for mutate in changes:
            value = copy.deepcopy(self.continuation)
            mutate(value)
            self.write_source(self.ready_file, value)
            request = {**self.finish_request, 'continuationSha256': W.digest(W.P.canonical(value))}
            with self.assertRaises(ValueError): self.subject.finish(self.point, request)
            self.assertFalse(self.root_file('abort-commit.json').exists())
        self.assert_held()

    def test_missing_or_partial_protected_authority_never_recreated_after_approval(self):
        self.prepare_abort()
        self.root_file('abort-terminal.json').rename(self.root_file('terminal-evidence'))
        with self.assertRaises(FileNotFoundError): self.prepare_abort()
        with self.assertRaises(FileNotFoundError): self.subject.status(self.point, self.request)
        self.assertFalse(self.root_file('abort-terminal.json').exists())
        self.assert_held()

    def test_lost_response_after_commit_before_source_settled_reconciles_exact_cleanup(self):
        self.ready()
        persist = E.EmptyRecords.persist
        def interrupted(records, name, value):
            if name == 'abort-source-settled.json': raise OSError('before source settlement')
            return persist(records, name, value)
        with mock.patch.object(E.EmptyRecords, 'persist', interrupted), self.assertRaises(OSError): self.finish()
        self.assertTrue(self.root_file('abort-commit.json').exists())
        self.assertFalse(self.root_file('abort-source-settled.json').exists())
        self.assert_held()
        with self.assertRaises(FileNotFoundError): self.subject.status(self.point, self.request)
        self.assertEqual(self.finish()['state'], 'complete')

    def test_settled_witness_precedes_global_lease_retirement(self):
        self.ready()
        def interrupted(retirement):
            self.assertTrue(self.root_file('abort-source-settled.json').exists())
            raise OSError('before root retirement')
        with mock.patch.object(E.EmptyAbortRetirement, 'retire_committed', interrupted), self.assertRaises(OSError): self.finish()
        self.assert_held()
        self.assertEqual(self.finish()['state'], 'complete')

    def test_late_foreign_marker_blocks_committed_cleanup_and_is_preserved(self):
        self.ready()
        persist = E.EmptyRecords.persist
        def late(records, name, value):
            result = persist(records, name, value)
            if name == 'abort-source-settled.json':
                self.marker_file.write_bytes(b'foreign partial marker')
                self.marker_file.chmod(0o600)
            return result
        with mock.patch.object(E.EmptyRecords, 'persist', late), self.assertRaises(ValueError): self.finish()
        self.assertEqual(self.marker_file.read_bytes(), b'foreign partial marker')
        self.assert_held()
        with self.assertRaises(ValueError): self.finish()
        self.assertEqual(self.marker_file.read_bytes(), b'foreign partial marker')

    def test_same_body_ready_replacement_cannot_reconcile_commit(self):
        self.ready()
        with mock.patch.object(E.EmptyAbortRetirement, 'retire_committed', side_effect=OSError('before root rename')), self.assertRaises(OSError): self.finish()
        self.ready_file.rename(self.ready_file.with_name('ready-evidence'))
        self.write_source(self.ready_file, self.continuation)
        with self.assertRaisesRegex(ValueError, 'continuation inode'): self.finish()
        self.assert_held()

    def test_marker_added_at_retirement_entry_is_rechecked_and_preserved(self):
        self.ready()
        retire = E.EmptyAbortRetirement.retire_committed
        def late(retirement):
            self.marker_file.write_bytes(b'foreign marker before final rename')
            self.marker_file.chmod(0o600)
            return retire(retirement)
        with mock.patch.object(E.EmptyAbortRetirement, 'retire_committed', late), self.assertRaises(ValueError): self.finish()
        self.assertEqual(self.marker_file.read_bytes(), b'foreign marker before final rename')
        self.assert_held()

    def test_lost_response_after_root_rename_is_observed_without_source_replay(self):
        self.ready()
        retire = E.EmptyAbortRetirement.retire_committed
        def lost(retirement):
            retire(retirement)
            raise OSError('lost complete reply')
        with mock.patch.object(E.EmptyAbortRetirement, 'retire_committed', lost), self.assertRaises(OSError): self.finish()
        with mock.patch.object(self.manager, 'observe', side_effect=AssertionError('source replay')):
            self.assertEqual(self.subject.status(self.point, self.request)['state'], 'complete')
            self.assertEqual(self.finish()['state'], 'complete')

    def test_missing_both_selector_names_is_not_success(self):
        self.ready()
        with mock.patch.object(E.EmptyAbortRetirement, 'retire_committed', side_effect=OSError('hold')), self.assertRaises(OSError): self.finish()
        self.fence().rename(self.fence().with_name('unexpected-lease-evidence'))
        with self.assertRaises((ValueError, OSError)): self.subject.status(self.point, self.request)
        with self.assertRaises((ValueError, OSError)): self.finish()

    def test_no_clobber_preserves_unrelated_retired_root_target(self):
        self.ready()
        target = self.fence().with_name(self.fence().name + '.retired-' + self.point)
        target.write_bytes(b'unrelated preserved root evidence')
        target.chmod(0o600)
        with self.assertRaises(ValueError): self.finish()
        self.assertEqual(target.read_bytes(), b'unrelated preserved root evidence')
        self.assert_held()

    def test_foreign_newer_selector_is_preserved_by_positive_history(self):
        self.ready()
        result = self.finish()
        with S.H.host_lock(self.fixture.root):
            W.LEASE.CoreCaptureLease.reserve(S.H, self.fixture.root, self.service.context, R.F.OTHER, '9' * 64)
        body = self.fence().read_bytes()
        self.assertEqual(self.subject.status(self.point, self.request), result)
        self.assertEqual(self.fence().read_bytes(), body)

    def test_changed_or_missing_settled_witness_is_not_historical_success(self):
        self.ready()
        self.finish()
        path = self.root_file('abort-source-settled.json')
        value = self.subject.records(self.point).read('abort-source-settled.json')[0]
        value['namespace']['directoryIdentity']['st_uid'] = False
        self.write_source(path, value)
        with self.assertRaises(ValueError): self.subject.status(self.point, self.request)
        path.rename(self.root_file('settled-evidence'))
        with self.assertRaises(FileNotFoundError): self.subject.status(self.point, self.request)
        with self.assertRaises((ValueError, OSError)): self.finish()
        self.assertFalse(path.exists())

    def test_version_one_commit_cannot_authorize_empty_abort_history(self):
        self.ready()
        self.finish()
        records = self.subject.records(self.point)
        value = records.read('abort-commit.json')[0]
        value['schema'] = E.BASE.SCHEMA
        self.write_source(self.root_file('abort-commit.json'), value)
        with self.assertRaises(ValueError): self.subject.status(self.point, self.request)

    def test_commit_file_sync_failure_is_resynced_before_any_lease_retirement(self):
        self.ready()
        sync, failed, resynced = os.fsync, False, []
        def checked(fd):
            nonlocal failed
            commit = self.root_file('abort-commit.json')
            if commit.exists() and os.fstat(fd).st_ino == commit.stat().st_ino:
                if not failed:
                    failed = True
                    raise OSError('unknown commit file durability')
                self.assertTrue(self.fence().exists())
                resynced.append(True)
            return sync(fd)
        with mock.patch.object(E.os, 'fsync', side_effect=checked):
            with self.assertRaisesRegex(OSError, 'unknown commit'): self.finish()
            self.assert_held()
            self.assertEqual(self.finish()['state'], 'complete')
        self.assertTrue(resynced)

    def test_default_records_names_stay_closed_and_empty_records_add_only_fixed_settled(self):
        records = E.BASE.Records(W, self.manager, self.point)
        with self.assertRaises(ValueError): records.read('abort-source-settled.json', optional=True)
        self.assertEqual(self.subject.records(self.point).read('abort-source-settled.json', optional=True), (None, None))
        for name in ('../escape', '/absolute', 'arbitrary.json'):
            with self.assertRaises(ValueError): self.subject.records(self.point).read(name, optional=True)


if __name__ == '__main__':
    unittest.main()
