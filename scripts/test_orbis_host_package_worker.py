import importlib.util
import tempfile
import time
import unittest
import uuid
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SPEC = importlib.util.spec_from_file_location("orbis_host_package_worker", Path(__file__).with_name("orbis-host-package-worker.py"))
assert SPEC and SPEC.loader
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)


class HostPackageWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name).resolve()
        self.root = self.state / "install"
        self.root.mkdir()
        self.job_id = str(uuid.uuid4())
        self.simulation = {
            "selected": [{"name": "base-files:arm64", "candidateVersion": "13ubuntu10.5"}],
            "operations": [{"name": "base-files", "candidateVersion": "13ubuntu10.5", "action": "upgrade"}],
        }
        WORKER.SERVICE.write_private(
            self.state / f"package-plan-{self.job_id}.json",
            {"schema": "orbis.package-plan.v1", "id": self.job_id, "root": str(self.root), "createdAt": time.time(), **self.simulation},
        )
        WORKER.SERVICE.write_private(
            self.state / "package-job.json",
            {"schema": "orbis.package-job.v1", "id": self.job_id, "state": "queued", "createdAt": time.time()},
        )

    def test_runs_only_the_revalidated_pinned_apt_transaction(self):
        with mock.patch.object(WORKER, "STATE_DIR", self.state), mock.patch.object(
            WORKER.PACKAGES, "simulate_upgrades", return_value=self.simulation
        ), mock.patch.object(WORKER.SERVICE.HOST, "host_lock", return_value=nullcontext()), mock.patch.object(
            WORKER.subprocess, "run", return_value=SimpleNamespace(returncode=0)
        ) as apt:
            WORKER.run(self.job_id)
        command = apt.call_args.args[0]
        self.assertEqual(command[0], "/usr/bin/apt-get")
        self.assertEqual(command[-3:], ["--only-upgrade", "--", "base-files:arm64=13ubuntu10.5"])
        self.assertIn("--no-remove", command)
        self.assertNotIn("--simulate", command)
        self.assertEqual(WORKER.SERVICE.read_private(self.state / "package-job.json")["state"], "complete")
        self.assertTrue((self.state / f"package-job-{self.job_id}.log").is_file())

    def test_rejects_a_candidate_change_before_apt_runs(self):
        changed = {"selected": [{"name": "base-files:arm64", "candidateVersion": "later"}], "operations": []}
        with mock.patch.object(WORKER, "STATE_DIR", self.state), mock.patch.object(
            WORKER.PACKAGES, "simulate_upgrades", return_value=changed
        ), mock.patch.object(WORKER.SERVICE.HOST, "host_lock", return_value=nullcontext()), mock.patch.object(
            WORKER.subprocess, "run"
        ) as apt:
            with self.assertRaisesRegex(ValueError, "changed"):
                WORKER.run(self.job_id)
        apt.assert_not_called()

    def test_records_apt_failure_without_claiming_rollback(self):
        with mock.patch.object(WORKER, "STATE_DIR", self.state), mock.patch.object(
            WORKER.PACKAGES, "simulate_upgrades", return_value=self.simulation
        ), mock.patch.object(WORKER.SERVICE.HOST, "host_lock", return_value=nullcontext()), mock.patch.object(
            WORKER.subprocess, "run", return_value=SimpleNamespace(returncode=100)
        ):
            WORKER.run(self.job_id)
        job = WORKER.SERVICE.read_private(self.state / "package-job.json")
        self.assertEqual(job["state"], "failed")
        self.assertEqual(job["exitCode"], 100)
        self.assertIn("dpkg state", job["message"])


if __name__ == "__main__":
    unittest.main()
