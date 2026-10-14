import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("orbis_host", Path(__file__).with_name("orbis-host.py"))
assert SPEC and SPEC.loader
HOST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOST)

MANIFEST = {
    "schema": "orbis.release.v1",
    "image": "ghcr.io/twentylines/orbis",
    "tag": "v0.1.0-beta.3",
    "commit": "a" * 40,
    "digest": "sha256:" + "b" * 64,
    "runtipiCompatibility": "4.10.1",
}
IMAGE = f"{MANIFEST['image']}@{MANIFEST['digest']}"
HEALTHY = {"state": "running", "health": "healthy", "image": IMAGE}


class OrbisHostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ("docker-compose.yml", ".env"):
            (self.root / name).write_text("safe fixture\n")
        (self.root / "orbis-compose.yml").write_text(HOST.STAGE.staged_content(MANIFEST))
        patch = mock.patch.object(HOST.PLAN, "plan", return_value={"result": "plan-ready"})
        patch.start()
        self.addCleanup(patch.stop)

    def test_enrollment_requires_exact_healthy_image(self):
        with mock.patch.object(HOST, "docker", return_value=subprocess.CompletedProcess([], 0)), mock.patch.object(
            HOST, "current_core", return_value={**HEALTHY, "image": "ghcr.io/runtipi/runtipi:v4.10.1"}
        ):
            with self.assertRaisesRegex(ValueError, "running and healthy"):
                HOST.execute(self.root, MANIFEST, "runtipi-test", "enroll", str(self.root))
        self.assertFalse((self.root / HOST.STATE_NAME).exists())

    def test_start_requires_enrollment_and_uses_final_pinned_override(self):
        calls = []

        def fake_docker(context, arguments, root):
            calls.append(arguments)
            return subprocess.CompletedProcess(arguments, 0)

        with mock.patch.object(HOST, "docker", side_effect=fake_docker), mock.patch.object(
            HOST, "current_core", return_value=HEALTHY
        ):
            with self.assertRaisesRegex(ValueError, "not enrolled"):
                HOST.execute(self.root, MANIFEST, "runtipi-test", "start", str(self.root))
            self.assertFalse(any("up" in command for command in calls))
            HOST.execute(self.root, MANIFEST, "runtipi-test", "enroll", str(self.root))
            result = HOST.execute(self.root, MANIFEST, "runtipi-test", "start", str(self.root))

        self.assertEqual(result["result"], "healthy")
        up = next(command for command in calls if "up" in command)
        self.assertEqual(up[-2:], ["runtipi", "runtipi-reverse-proxy"])
        self.assertEqual(up[up.index("--pull") + 1], "never")
        self.assertIn(str(self.root / "orbis-compose.yml"), up)
        self.assertLess(up.index(str(self.root / "docker-compose.yml")), up.index(str(self.root / "orbis-compose.yml")))
        self.assertNotIn("--remove-orphans", up)

        (self.root / ".env").write_text("changed setting\n")
        with mock.patch.object(HOST, "docker", side_effect=fake_docker), mock.patch.object(
            HOST, "current_core", return_value=HEALTHY
        ):
            with self.assertRaisesRegex(ValueError, "changed since enrollment"):
                HOST.execute(self.root, MANIFEST, "runtipi-test", "start", str(self.root))
        self.assertEqual(sum("up" in command for command in calls), 1)

    def test_stop_refuses_unexpected_core_image(self):
        with mock.patch.object(HOST, "docker", return_value=subprocess.CompletedProcess([], 0)), mock.patch.object(
            HOST, "current_core", return_value=HEALTHY
        ):
            HOST.execute(self.root, MANIFEST, "runtipi-test", "enroll", str(self.root))
        with mock.patch.object(HOST, "docker", return_value=subprocess.CompletedProcess([], 0)) as docker, mock.patch.object(
            HOST, "current_core", return_value={**HEALTHY, "image": "ghcr.io/runtipi/runtipi:v4.10.1"}
        ):
            with self.assertRaisesRegex(ValueError, "unexpected image"):
                HOST.execute(self.root, MANIFEST, "runtipi-test", "stop", str(self.root))
        self.assertFalse(any("stop" in call.args[1] for call in docker.call_args_list))

    def test_stop_confirms_the_core_exited(self):
        with mock.patch.object(HOST, "docker", return_value=subprocess.CompletedProcess([], 0)), mock.patch.object(
            HOST, "current_core", return_value=HEALTHY
        ):
            HOST.execute(self.root, MANIFEST, "runtipi-test", "enroll", str(self.root))
        with mock.patch.object(HOST, "docker", return_value=subprocess.CompletedProcess([], 0)) as docker, mock.patch.object(
            HOST, "current_core", side_effect=[HEALTHY, {**HEALTHY, "state": "exited"}]
        ):
            result = HOST.execute(self.root, MANIFEST, "runtipi-test", "stop", str(self.root))
        self.assertEqual(result["result"], "stopped")
        stop = next(call.args[1] for call in docker.call_args_list if "stop" in call.args[1])
        self.assertEqual(stop[-2:], ["runtipi-reverse-proxy", "runtipi"])


if __name__ == "__main__":
    unittest.main()
