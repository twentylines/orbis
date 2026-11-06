"""Real sealed copies, checkpoint bytes and supervisor receipts; no live Docker."""
import copy
import hashlib
import json
import os
import sys
import unittest
from unittest import mock

import test_orbis_host_core_capture_worker as workers
import test_orbis_host_core_checkpoint as checkpoints

W, P = workers.W, checkpoints.P


class CheckpointWorkerTests(unittest.TestCase):
    def setUp(self):
        self.worker = workers.CoreCaptureWorkerTests('test_real_capture_resumes_original_core_and_retains_lease')
        self.worker.setUp()
        self.addCleanup(self.worker.doCleanups)
        fixture = self.worker.fixture
        fixture.directory = fixture.capture.base / self.worker.point
        fixture.directory.mkdir(mode=0o700)
        fixture.bundle = fixture.snapshots / ('orbis-time-machine-core-' + self.worker.point)
        fixture.pgdata = fixture.docker.database_directory
        (fixture.pgdata / 'PG_VERSION').write_bytes(b'16\n')
        self.mapping = checkpoints.CheckpointTests.prepare(fixture)
        fixture.job['source'] = copy.deepcopy(fixture.source)
        fixture.job['settlement']['sourceSha256'] = W.CORE.TX.APPS.digest(fixture.source)
        fixture.capture.save(fixture.job)
        self.enterContext(mock.patch.object(W.CORE.TX.STORAGE, 'verified_manifest',
                                           side_effect=checkpoints.TX.STORAGE.verified_manifest))
        # Model the return from the already completed capture. Packaging, receipt
        # reads and worker/admission binding run their real implementations.
        self.enterContext(mock.patch.object(W.BoundCapture, 'capture', return_value=fixture.job['settlement']))
        self.worker.pack.side_effect = P.build
        self.worker.pack_read.side_effect = P.read_receipt
        if sys.platform != 'linux' or os.geteuid() != 0:
            self.enterContext(mock.patch.object(P, 'require_host'))
        if not hasattr(os, 'listxattr') or not hasattr(os, 'getxattr'):
            self.enterContext(mock.patch.object(P, 'attributes', return_value={}))

    def test_real_checkpoint_is_bound_by_worker_and_read_after_restart(self):
        fixture = self.worker.fixture
        (fixture.pgdata / 'PG_VERSION').write_bytes(b'99\n')
        result = self.worker.run_worker()
        artifact = result['artifact']
        self.assertEqual(artifact['compatibility']['database']['major'], 16)
        file = fixture.directory / 'portable-checkpoint' / 'checkpoint.tar'
        self.assertEqual(artifact['checkpoint']['sha256'], hashlib.sha256(file.read_bytes()).hexdigest())
        self.assertEqual(W.read_status(str(self.worker.state), self.worker.point), result)
        restarted = workers.load('orbis-host-core-capture-worker.py', 'checkpoint_worker_restart')
        with mock.patch.object(restarted, 'require_root'), mock.patch.object(restarted.A, 'OWNER', os.geteuid()), \
                mock.patch.object(restarted.CHECKPOINT, 'require_host'):
            self.assertEqual(restarted.read_status(str(self.worker.state), self.worker.point), result)
        self.worker.assert_held()

    def test_valid_shaped_changed_artifact_cannot_replace_supervisor_binding(self):
        self.worker.run_worker()
        fixture = self.worker.fixture
        receipt_path = fixture.directory / 'portable-checkpoint' / 'artifact.json'
        receipt = json.loads(receipt_path.read_bytes())
        receipt['checkpoint']['sha256'] = '0' * 64
        fixture.capture.a.atomic(receipt_path, fixture.capture.P.canonical(receipt))
        with self.assertRaisesRegex(W.AdmissionError, 'settlement authority'):
            W.read_status(str(self.worker.state), self.worker.point)
        self.worker.assert_held()


if __name__ == '__main__':
    unittest.main()
