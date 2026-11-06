"""Joined v2 receipts with fake runtime/kernel and Docker/capture seams."""
import hashlib
import os
import unittest
from unittest import mock

import test_orbis_host_core_checkpoint_worker as checkpoint
import test_orbis_host_core_capture_supervisor as supervisor

W = checkpoint.W
S = W.SUPERVISOR
IDENTITY = W.supervision_identity
VERIFY = W.verify_supervision


class JoinedSupervisorWorkerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = checkpoint.CheckpointWorkerTests(
            'test_real_checkpoint_is_bound_by_worker_and_read_after_restart')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.capture = self.fixture.worker
        self.point, self.state, self.directory = self.capture.point, self.capture.state, self.capture.directory
        self.worker = W
        self.runtime = supervisor.FakeRuntime(self)
        self.enterContext(mock.patch.dict(os.environ, {'INVOCATION_ID': self.runtime.invocation}))
        # Replace the worker fixture's v1 mocks with the actual v2 dispatch.
        W.supervision_identity.side_effect = IDENTITY
        W.verify_supervision.side_effect = VERIFY
        enter, verify, validate = S.enter_worker, S.verify_worker, S.validate_frame
        self.enter_call = self.enterContext(mock.patch.object(S, 'enter_worker',
            side_effect=lambda admission, worker: enter(admission, worker=worker, runtime=self.runtime)))
        self.verify_call = self.enterContext(mock.patch.object(S, 'verify_worker',
            side_effect=lambda admission, frame, worker, runtime=None:
                verify(admission, frame, worker=worker, runtime=runtime or self.runtime)))
        self.enterContext(mock.patch.object(S, 'validate_frame',
            side_effect=lambda admission, frame, worker, runtime=None:
                validate(admission, frame, worker=worker, runtime=runtime or self.runtime)))
        self.legacy = self.enterContext(mock.patch.object(W, 'process_frame',
            side_effect=AssertionError('v2 must not use legacy supervision')))
        admission = self.admission()
        admission.create('launch-intent.json', admission.event('launch-intent',
            workerSha256=W.worker_hash(), unit='orbis-core-capture-' + self.point,
            supervisionProtocol=2, supervisorSha256=S.source_hash(W.worker_context())))
        self.worker_result = None
        self.worker_error = None
        self.runtime.on_wait = self.run_child

    def admission(self):
        return W.Admission(self.state, self.point)

    def successful_receipts(self):
        raise AssertionError('Synthetic receipts must not be used')

    def run_child(self):
        try:
            with mock.patch.object(S.os, 'getpid', return_value=self.runtime.child_pid):
                self.worker_result = W.run_worker(str(self.state), self.point)
        except Exception as error:
            self.worker_error = error
            self.runtime.exit_code = 1
        finally:
            self.runtime.population = 0

    def run_supervisor(self):
        return S.run_supervisor(W.worker_context(), self.state, self.point, runtime=self.runtime)

    def test_joined_success_reopens_after_parent_exit_and_never_replays(self):
        terminal = self.run_supervisor()
        self.assertIsNone(self.worker_error)
        self.assertEqual(terminal['state'], 'quiescent')
        self.assertTrue(terminal['workerQuiescent'])
        self.assertEqual(self.enter_call.call_count, 1)
        self.assertEqual(self.verify_call.call_count, 3)
        self.assertEqual(self.runtime.moves, [self.runtime.child_pid])
        self.assertEqual(self.admission().read('claim.json')[0]['supervision']['version'], 2)
        artifact = self.worker_result['artifact']
        archive = self.capture.fixture.directory / 'portable-checkpoint' / 'checkpoint.tar'
        self.assertEqual(artifact['checkpoint']['sha256'], hashlib.sha256(archive.read_bytes()).hexdigest())
        self.assertEqual(W.read_status(str(self.state), self.point), self.worker_result)
        with mock.patch.object(S.os, 'getpid', return_value=self.runtime.child_pid):
            with self.assertRaises((S.SupervisionError, FileExistsError)):
                W.run_worker(str(self.state), self.point)
        self.capture.pack.assert_called_once()
        self.runtime.processes.clear()
        self.runtime.unit_values = {}
        self.assertEqual(W.read_status(str(self.state), self.point), self.worker_result)
        self.assertEqual(S.read_terminal(self.admission(), worker=W.worker_context(), runtime=self.runtime), terminal)
        with self.assertRaises(S.SupervisionError):
            self.run_supervisor()
        self.assertEqual(len(self.runtime.spawns), 1)
        self.legacy.assert_not_called()
        self.capture.assert_held()

    def test_failed_actual_worker_is_held_and_cannot_replay(self):
        self.capture.pack.side_effect = RuntimeError('explicit checkpoint seam failure')
        terminal = self.run_supervisor()
        self.assertIsInstance(self.worker_error, RuntimeError)
        self.assertEqual(terminal['state'], 'recovery-required')
        self.assertEqual(terminal['workerExitCode'], 1)
        self.assertTrue(terminal['workerQuiescent'])
        self.assertEqual(W.read_status(str(self.state), self.point)['state'], 'recovery-required')
        self.assertIsNotNone(self.admission().read('failure.json')[0])
        self.assertIsNone(self.admission().read('settled.json', optional=True)[0])
        with self.assertRaises(S.SupervisionError):
            self.run_supervisor()
        self.assertEqual(len(self.runtime.spawns), 1)
        self.legacy.assert_not_called()
        self.capture.assert_held()

    def test_active_packaging_is_running_only_with_positive_live_supervision(self):
        observe = S.observe_worker
        build = self.capture.pack.side_effect
        seen = []
        def packaging(*args, **kwargs):
            seen.append(W.read_status(self.state, self.point)['state'])
            process = self.runtime.processes.pop(self.runtime.child_pid)
            try:
                seen.append(W.read_status(self.state, self.point)['state'])
            finally:
                self.runtime.processes[self.runtime.child_pid] = process
            return build(*args, **kwargs)
        self.capture.pack.side_effect = packaging
        with mock.patch.object(S, 'observe_worker', side_effect=lambda admission, frame, worker:
                observe(admission, frame, worker=worker, runtime=self.runtime)):
            terminal = self.run_supervisor()
        self.assertEqual(seen, ['running', 'recovery-required'])
        self.assertEqual(terminal['state'], 'quiescent')
        self.capture.assert_held()


if __name__ == '__main__':
    unittest.main()
