import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("orbis_host_adopt", Path(__file__).with_name("orbis-host-adopt.py"))
assert SPEC and SPEC.loader
ADOPT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ADOPT)

TARGET = {
    "schema": "orbis.release.v1",
    "image": "ghcr.io/twentylines/orbis",
    "tag": "v0.1.0-beta.7",
    "commit": "a" * 40,
    "digest": "sha256:" + "b" * 64,
    "runtipiCompatibility": "4.10.1",
}
TARGET_IMAGE = f"{TARGET['image']}@{TARGET['digest']}"
STOCK_ID = "sha256:" + "c" * 64


class FakeDocker:
    def __init__(self, root: Path, fail_target_start: bool = False, app_mount: dict | None = None, app_running: bool = False):
        self.root = root
        self.image = ADOPT.STOCK_IMAGE
        self.image_id = STOCK_ID
        self.states = {service: "running" for service in ADOPT.UPDATE.CORE_SERVICES}
        self.fail_target_start = fail_target_start
        self.app_mount = app_mount
        self.app_running = app_running
        if app_mount is not None or app_running:
            self.states["app"] = "running" if app_running else "exited"
        self.calls = []

    def __call__(self, context, arguments, root):
        self.calls.append(arguments)
        if arguments[0] == "info":
            return subprocess.CompletedProcess(arguments, 0, "test-daemon\n", "")
        if arguments[0] == "ps":
            names = [name for name, state in self.states.items() if "--all" in arguments or state == "running"]
            return subprocess.CompletedProcess(arguments, 0, "\n".join(names), "")
        if arguments[:2] == ["image", "inspect"]:
            return subprocess.CompletedProcess(arguments, 0, json.dumps(STOCK_ID) + "\n", "")
        if arguments[0] == "inspect":
            template, name = arguments[2], arguments[3]
            labels = (
                {"runtipi.managed": "true", "com.docker.compose.project": "app"}
                if name == "app"
                else {
                    "com.docker.compose.project": "runtipi",
                    "com.docker.compose.project.working_dir": str(self.root),
                    "com.docker.compose.service": name,
                }
            )
            if template == "{{json .Config.Image}}":
                value = json.dumps(self.image)
            elif template == "{{json .Config.Labels}}":
                value = json.dumps(labels)
            elif template == "{{json .Mounts}}":
                value = json.dumps([self.app_mount] if name == "app" and self.app_mount else [])
            elif template == "{{json .State}}":
                value = json.dumps({"Status": self.states[name], "Health": {"Status": "healthy"}})
            elif template == "{{json .Image}}":
                value = json.dumps(self.image_id)
            elif template == "{{.State.Status}}":
                value = self.states[name]
            else:
                raise AssertionError(f"unexpected inspect template: {template}")
            return subprocess.CompletedProcess(arguments, 0, value + "\n", "")
        if arguments[0] == "pull":
            return subprocess.CompletedProcess(arguments, 0, "pulled\n", "")
        if arguments[0] == "stop":
            self.states[arguments[1]] = "exited"
            return subprocess.CompletedProcess(arguments, 0, "stopped\n", "")
        if arguments[0] == "compose" and "up" in arguments:
            candidate = TARGET_IMAGE if (self.root / "orbis-compose.yml").exists() else ADOPT.STOCK_IMAGE
            if candidate == TARGET_IMAGE and self.fail_target_start:
                del self.states["runtipi"]
                return subprocess.CompletedProcess(arguments, 1, "", "synthetic failure")
            self.image = candidate
            self.image_id = STOCK_ID if candidate == ADOPT.STOCK_IMAGE else "sha256:" + "d" * 64
            for service in ADOPT.UPDATE.CORE_SERVICES:
                self.states[service] = "running"
            return subprocess.CompletedProcess(arguments, 0, "started\n", "")
        raise AssertionError(f"unexpected Docker command: {arguments}")


class OrbisHostAdoptionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = (Path(self.temp.name) / "install")
        self.root.mkdir()
        self.root = self.root.resolve()
        self.snapshot = self.root.parent / "stock-snapshot"
        for name in ("docker-compose.yml", ".env"):
            (self.root / name).write_text("safe fixture\n")
        (self.root / "data" / "postgres").mkdir(parents=True)
        (self.root / "data" / "postgres" / "record").write_text("stock database fixture\n")
        self.plan = mock.patch.object(ADOPT.HOST.PLAN, "plan", return_value={"configuredImage": ADOPT.STOCK_IMAGE, "standardOrbisOverrideIncluded": False})
        self.plan.start()
        self.addCleanup(self.plan.stop)
        self.release = mock.patch.object(
            ADOPT.UPDATE.CHECK,
            "check",
            return_value={"commit": TARGET["commit"], "image": TARGET_IMAGE, "runtipiCompatibility": "4.10.1"},
        )
        self.release.start()
        self.addCleanup(self.release.stop)

    def test_adoption_preserves_a_verified_stock_snapshot_and_enrolls_orbis(self):
        fake = FakeDocker(self.root)
        with mock.patch.object(ADOPT.HOST, "docker", side_effect=fake):
            result = ADOPT.apply_adoption(self.root, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(result["result"], "healthy")
        self.assertEqual(fake.image, TARGET_IMAGE)
        self.assertEqual(ADOPT.SNAPSHOT.verify(self.snapshot, self.root)["release"], ADOPT.STOCK_RELEASE)
        self.assertEqual(ADOPT.HOST.saved_state(self.root), ADOPT.HOST.installation_fingerprint(self.root, TARGET, "test-daemon"))
        self.assertEqual(ADOPT.read_journal(self.snapshot, self.root, "test-daemon", TARGET)["stage"], "complete")

    def test_failed_orbis_start_restores_stock_database_and_image(self):
        fake = FakeDocker(self.root, fail_target_start=True)
        with mock.patch.object(ADOPT.HOST, "docker", side_effect=fake):
            with self.assertRaisesRegex(RuntimeError, "stock Runtipi was restored"):
                ADOPT.apply_adoption(self.root, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(fake.image, ADOPT.STOCK_IMAGE)
        self.assertEqual(fake.image_id, STOCK_ID)
        self.assertEqual((self.root / "data" / "postgres" / "record").read_text(), "stock database fixture\n")
        self.assertFalse((self.root / "orbis-compose.yml").exists())
        self.assertIsNone(ADOPT.HOST.saved_state(self.root))
        self.assertEqual(ADOPT.read_journal(self.snapshot, self.root, "test-daemon", TARGET)["stage"], "rolled-back")

    def test_snapshot_failure_before_copy_restores_stock_without_sidecar(self):
        fake = FakeDocker(self.root)
        with mock.patch.object(ADOPT.HOST, "docker", side_effect=fake), mock.patch.object(
            ADOPT.SNAPSHOT, "capture", side_effect=RuntimeError("synthetic snapshot failure")
        ):
            with self.assertRaisesRegex(RuntimeError, "stock Runtipi was restored"):
                ADOPT.apply_adoption(self.root, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(fake.image, ADOPT.STOCK_IMAGE)
        self.assertEqual(fake.states["runtipi"], "running")
        self.assertFalse((self.root / "orbis-compose.yml").exists())
        self.assertEqual(ADOPT.read_journal(self.snapshot, self.root, "test-daemon", TARGET)["stage"], "rolled-back")

    def test_refuses_external_app_data_before_pull_or_downtime(self):
        fake = FakeDocker(self.root, app_mount={"Type": "bind", "Source": "/outside/app-data"})
        with mock.patch.object(ADOPT.HOST, "docker", side_effect=fake):
            with self.assertRaisesRegex(ValueError, "outside the installation snapshot"):
                ADOPT.apply_adoption(self.root, TARGET, "test-daemon", self.snapshot)
        self.assertFalse(ADOPT.journal_path(self.snapshot).exists())
        self.assertFalse(any(call[0] == "pull" for call in fake.calls))

    def test_refuses_external_tree_symlink_before_pull_or_downtime(self):
        (self.root / "external").symlink_to(self.root.parent, target_is_directory=True)
        fake = FakeDocker(self.root)
        with mock.patch.object(ADOPT.HOST, "docker", side_effect=fake):
            with self.assertRaisesRegex(ValueError, "outside its installation tree"):
                ADOPT.apply_adoption(self.root, TARGET, "test-daemon", self.snapshot)
        self.assertFalse(ADOPT.journal_path(self.snapshot).exists())
        self.assertFalse(any(call[0] == "pull" for call in fake.calls))

    def test_refuses_running_managed_app_before_pull_or_downtime(self):
        fake = FakeDocker(self.root, app_running=True)
        with mock.patch.object(ADOPT.HOST, "docker", side_effect=fake):
            with self.assertRaisesRegex(ValueError, "stop Runtipi-managed applications"):
                ADOPT.apply_adoption(self.root, TARGET, "test-daemon", self.snapshot)
        self.assertFalse(ADOPT.journal_path(self.snapshot).exists())
        self.assertFalse(any(call[0] == "pull" for call in fake.calls))

    def test_recover_restores_stock_after_interrupted_stage(self):
        fake = FakeDocker(self.root)
        fake.states = {service: "exited" for service in ADOPT.UPDATE.CORE_SERVICES}
        ADOPT.SNAPSHOT.capture(self.root, self.snapshot, ADOPT.STOCK_RELEASE, "test-daemon")
        ADOPT.HOST.STAGE.stage(self.root, TARGET)
        ADOPT.write_journal(
            self.snapshot,
            {
                "schema": ADOPT.JOURNAL_SCHEMA,
                "root": str(self.root),
                "snapshot": str(self.snapshot),
                "dockerContext": "test-daemon",
                "stockImage": ADOPT.STOCK_IMAGE,
                "stockImageId": STOCK_ID,
                "targetDigest": TARGET["digest"],
                "stage": "staged",
            },
        )
        with mock.patch.object(ADOPT.HOST, "docker", side_effect=fake):
            result = ADOPT.recover(self.root, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(result["result"], "rolled-back")
        self.assertEqual(fake.image, ADOPT.STOCK_IMAGE)
        self.assertFalse((self.root / "orbis-compose.yml").exists())

    def test_corrupted_stock_snapshot_prevents_automatic_restore(self):
        fake = FakeDocker(self.root)
        fake.states = {service: "exited" for service in ADOPT.UPDATE.CORE_SERVICES}
        ADOPT.SNAPSHOT.capture(self.root, self.snapshot, ADOPT.STOCK_RELEASE, "test-daemon")
        (self.snapshot / "data" / "postgres" / "record").write_text("corrupt")
        ADOPT.write_journal(
            self.snapshot,
            {
                "schema": ADOPT.JOURNAL_SCHEMA,
                "root": str(self.root),
                "snapshot": str(self.snapshot),
                "dockerContext": "test-daemon",
                "stockImage": ADOPT.STOCK_IMAGE,
                "stockImageId": STOCK_ID,
                "targetDigest": TARGET["digest"],
                "stage": "staged",
            },
        )
        with mock.patch.object(ADOPT.HOST, "docker", side_effect=fake):
            with self.assertRaisesRegex(RuntimeError, "stock recovery failed"):
                ADOPT.recover(self.root, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(fake.states["runtipi"], "exited")
        self.assertEqual(ADOPT.read_journal(self.snapshot, self.root, "test-daemon", TARGET)["stage"], "rollback-failed")


if __name__ == "__main__":
    unittest.main()
