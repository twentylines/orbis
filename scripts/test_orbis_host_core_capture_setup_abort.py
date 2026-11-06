import copy
from unittest import mock

import test_orbis_host_core_capture_unused_abort as T

W, U, R = T.W, T.U, T.R


class SetupAbortTests(T.UnusedAbortTests):
    def setUp(self):
        super().setUp()
        self.terminal.update(schema='orbis.core-capture-source-abort-terminal.v4',
            sourceAttempt='setup-unwound', localLease='not-acquired',
            queueUnwind={'pauseId': R.F.OTHER, 'generation': 1,
                'queues': [{'name': name, 'messages': 0, 'consumers': 1} for name in sorted(U.BASE.QUEUES)]})
        self.write_source(self.terminal_file, self.terminal)
        self.request['terminalSha256'] = W.digest(W.P.canonical(self.terminal))
        self.subject = U.CoreCaptureSetupAbort(self.manager, W)
        self.enterContext(mock.patch.object(self.subject.namespace, 'CaptureNamespace',
            side_effect=lambda worker, reader, controller: T.F.FilesystemNamespace(worker, reader, controller, self.source)))

    def test_success_preserves_only_original_retired_lease(self):
        identity = U.BASE.RETIRE.lease_identity(self.fence().stat())
        result = self.settle()
        retired = self.fence().with_name(self.fence().name + '.retired-' + self.point)
        self.assertEqual(U.BASE.RETIRE.lease_identity(retired.stat()), identity)
        self.assertFalse(self.fence().exists())
        self.assertEqual(result['version'], 4)
        self.assertEqual(result['sourceAttempt'], 'setup-unwound')
        self.assertEqual(result['localLease'], 'not-acquired')
        self.assertEqual(result['queueUnwind'], self.terminal['queueUnwind'])
        self.assertEqual(self.subject.status(self.point, self.request), result)
        self.assertEqual(self.settle(), result)
        with self.assertRaises((ValueError, OSError)):
            U.CoreCaptureUnusedAbort(self.manager, W).status(self.point, self.request)

    def test_bad_terminal_and_downgrades_are_refused(self):
        mutations = [lambda t: t.update(schema='orbis.core-capture-source-abort-terminal.v3'),
            lambda t: t.update(localLease='acquired'), lambda t: t.pop('localLease'),
            lambda t: t.update(extra=True), lambda t: t['queueUnwind'].update(extra=True),
            lambda t: t['queueUnwind'].pop('pauseId'), lambda t: t['queueUnwind'].update(pauseId='bad'),
            lambda t: t['queueUnwind'].update(generation=True),
            lambda t: t['queueUnwind'].update(generation=9007199254740992),
            lambda t: t['queueUnwind']['queues'].pop(),
            lambda t: t['queueUnwind']['queues'].append(copy.deepcopy(t['queueUnwind']['queues'][0])),
            lambda t: t['queueUnwind']['queues'][0].update(name='other'),
            lambda t: t['queueUnwind']['queues'][0].update(messages=1),
            lambda t: t['queueUnwind']['queues'][0].update(consumers=0),
            lambda t: t['queueUnwind']['queues'][0].update(consumers=True),
            lambda t: t['queueUnwind']['queues'][0].update(extra=0)]
        for change in mutations:
            value = copy.deepcopy(self.terminal)
            change(value)
            self.write_source(self.terminal_file, value)
            request = {**self.request, 'terminalSha256': W.digest(W.P.canonical(value))}
            with self.subTest(value=value), self.assertRaises((ValueError, OSError)):
                self.subject.settle(self.point, request)
        self.assert_held()

    def test_cross_version_terminal_rejected(self):
        v3_subject = U.CoreCaptureUnusedAbort(self.manager, W)
        with mock.patch.object(v3_subject.namespace, 'CaptureNamespace',
                side_effect=lambda worker, reader, controller: T.F.FilesystemNamespace(worker, reader, controller, self.source)):
            with self.assertRaises((ValueError, OSError)):
                v3_subject.settle(self.point, self.request)
        v3 = {key: value for key, value in self.terminal.items() if key not in ('localLease', 'queueUnwind')}
        v3.update(schema='orbis.core-capture-source-abort-terminal.v3', sourceAttempt='not-started')
        self.write_source(self.terminal_file, v3)
        request = {**self.request, 'terminalSha256': W.digest(W.P.canonical(v3))}
        with self.assertRaises((ValueError, OSError)):
            self.subject.settle(self.point, request)
        self.assert_held()

    def test_v3_commit_cannot_be_adopted_by_v4(self):
        v3 = {key: value for key, value in self.terminal.items() if key not in ('localLease', 'queueUnwind')}
        v3.update(schema='orbis.core-capture-source-abort-terminal.v3', sourceAttempt='not-started')
        self.write_source(self.terminal_file, v3)
        request = {**self.request, 'terminalSha256': W.digest(W.P.canonical(v3))}
        v3_subject = U.CoreCaptureUnusedAbort(self.manager, W)
        with mock.patch.object(v3_subject.namespace, 'CaptureNamespace',
                side_effect=lambda worker, reader, controller: T.F.FilesystemNamespace(worker, reader, controller, self.source)):
            v3_subject.settle(self.point, request)
        with self.assertRaises((ValueError, OSError)):
            self.subject.status(self.point, request)
        with self.assertRaises((ValueError, OSError)):
            self.subject.settle(self.point, request)
