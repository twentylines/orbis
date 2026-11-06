import copy
from unittest import mock

import test_orbis_host_core_capture_unused_abort as T

W, U, R = T.W, T.U, T.R


class RefusedAbortTests(T.UnusedAbortTests):
    def setUp(self):
        super().setUp()
        self.terminal.update(schema='orbis.core-capture-source-abort-terminal.v5',
            sourceAttempt='setup-refused', localLease='not-acquired',
            queueRefusal={'setupId': R.F.OTHER, 'generation': 1, 'outcome': 'not-entered',
                'queues': [{'name': name, 'messages': 0, 'consumers': 1} for name in sorted(U.BASE.QUEUES)]})
        self.write_source(self.terminal_file, self.terminal)
        self.request['terminalSha256'] = W.digest(W.P.canonical(self.terminal))
        self.subject = U.CoreCaptureRefusedAbort(self.manager, W)
        self.enterContext(mock.patch.object(self.subject.namespace, 'CaptureNamespace',
            side_effect=lambda worker, reader, controller: T.F.FilesystemNamespace(worker, reader, controller, self.source)))

    def test_success_preserves_only_original_retired_lease(self):
        original = U.BASE.RETIRE.lease_identity(self.fence().stat())
        result = self.settle()
        self.assertEqual(result['version'], 5)
        self.assertEqual(result['sourceAttempt'], 'setup-refused')
        self.assertEqual(result['localLease'], 'not-acquired')
        self.assertEqual(result['queueRefusal'], self.terminal['queueRefusal'])
        retired = self.fence().with_name(self.fence().name + '.retired-' + self.point)
        self.assertEqual(U.BASE.RETIRE.lease_identity(retired.stat()), original)
        self.assertFalse(self.fence().exists())
        self.assertEqual(self.subject.status(self.point, self.request), result)
        self.assertEqual(self.settle(), result)
        for other in (U.CoreCaptureUnusedAbort, U.CoreCaptureSetupAbort):
            with self.assertRaises((ValueError, OSError)):
                other(self.manager, W).status(self.point, self.request)

    def test_malformed_or_owned_refusal_never_retires_lease(self):
        mutations = [lambda t: t.update(schema='orbis.core-capture-source-abort-terminal.v4'),
            lambda t: t.update(sourceAttempt='setup-unwound'), lambda t: t.update(localLease='acquired'),
            lambda t: t.pop('queueRefusal'), lambda t: t.update(extra=True),
            lambda t: t['queueRefusal'].update(setupId='bad'), lambda t: t['queueRefusal'].update(outcome='owned'),
            lambda t: t['queueRefusal'].update(outcome=[]), lambda t: t['queueRefusal'].update(generation=True),
            lambda t: t['queueRefusal'].update(generation=9007199254740992),
            lambda t: t['queueRefusal'].update(extra=True), lambda t: t['queueRefusal']['queues'].pop(),
            lambda t: t['queueRefusal']['queues'].append(copy.deepcopy(t['queueRefusal']['queues'][0])),
            lambda t: t['queueRefusal']['queues'][0].update(consumers=0),
            lambda t: t['queueRefusal']['queues'][0].update(messages=1)]
        for change in mutations:
            terminal = copy.deepcopy(self.terminal)
            change(terminal)
            self.write_source(self.terminal_file, terminal)
            request = {**self.request, 'terminalSha256': W.digest(W.P.canonical(terminal))}
            with self.subTest(terminal=terminal), self.assertRaises((ValueError, OSError)):
                self.subject.settle(self.point, request)
        self.assert_held()

    def test_queue_refused_outcome_has_the_same_original_inode_protection(self):
        self.terminal['queueRefusal']['outcome'] = 'queue-refused'
        self.write_source(self.terminal_file, self.terminal)
        self.request['terminalSha256'] = W.digest(W.P.canonical(self.terminal))
        self.assertEqual(self.settle()['queueRefusal']['outcome'], 'queue-refused')

    def test_commit_cannot_change_refusal_provenance_after_retirement(self):
        self.settle()
        path = self.manager.directory(self.point) / 'abort-unused-commit.json'
        record = W.P.metadata(path.read_bytes(), byte_limit=65536)
        record['queueRefusal']['outcome'] = 'queue-refused'
        path.write_bytes(W.P.canonical(record))
        with self.assertRaises((ValueError, OSError)):
            self.subject.status(self.point, self.request)
