import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("orbis_host_update", Path(__file__).with_name("orbis-host-update.py"))
assert SPEC and SPEC.loader
UPDATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPDATE)

CURRENT = {
    "schema": "orbis.release.v1",
    "image": "ghcr.io/twentylines/orbis",
    "tag": "v0.1.0-beta.4",
    "commit": "a" * 40,
    "digest": "sha256:" + "b" * 64,
    "runtipiCompatibility": "4.10.1",
}
TARGET = {**CURRENT, "tag": "v0.1.0-beta.5", "commit": "c" * 40, "digest": "sha256:" + "d" * 64}
CURRENT_IMAGE = f"{CURRENT['image']}@{CURRENT['digest']}"
TARGET_IMAGE = f"{TARGET['image']}@{TARGET['digest']}"


class FakeDocker:
    def __init__(self, root: Path, fail_target_start: bool = False, remove_on_failed_start: bool = False):
        self.root = root
        self.image = CURRENT_IMAGE
        self.states = {service: "running" for service in UPDATE.CORE_SERVICES}
        self.fail_target_start = fail_target_start
        self.remove_on_failed_start = remove_on_failed_start
        self.calls = []

    def __call__(self, context, arguments, root):
        self.calls.append(arguments)
        if arguments[0] == "info":
            return subprocess.CompletedProcess(arguments, 0, "test-daemon\n", "")
        if arguments[0] == "ps":
            names = [name for name, state in self.states.items() if "--all" in arguments or state == "running"]
            return subprocess.CompletedProcess(arguments, 0, "\n".join(names), "")
        if arguments[0] == "inspect":
            template, name = arguments[2], arguments[3]
            labels = {
                "com.docker.compose.project": "runtipi",
                "com.docker.compose.project.working_dir": str(self.root),
                "com.docker.compose.service": name,
            }
            if template == "{{json .Config.Image}}":
                value = json.dumps(self.image)
            elif template == "{{json .Config.Labels}}":
                value = json.dumps(labels)
            elif template == "{{json .Mounts}}":
                value = "[]"
            elif template == "{{json .State}}":
                value = json.dumps({"Status": self.states[name], "Health": {"Status": "healthy"}})
            elif template == "{{.State.Status}}":
                value = self.states[name]
            else:
                raise AssertionError(f"unexpected Docker inspect template: {template}")
            return subprocess.CompletedProcess(arguments, 0, value + "\n", "")
        if arguments[0] == "pull":
            return subprocess.CompletedProcess(arguments, 0, "pulled\n", "")
        if arguments[0] == "stop":
            self.states[arguments[1]] = "exited"
            return subprocess.CompletedProcess(arguments, 0, "stopped\n", "")
        if arguments[0] == "compose" and "up" in arguments:
            contents = (self.root / "orbis-compose.yml").read_text()
            candidate = TARGET_IMAGE if TARGET["digest"] in contents else CURRENT_IMAGE
            if candidate == TARGET_IMAGE and self.fail_target_start:
                if self.remove_on_failed_start:
                    del self.states["runtipi"]
                return subprocess.CompletedProcess(arguments, 1, "", "synthetic failure")
            self.image = candidate
            self.states = {service: "running" for service in UPDATE.CORE_SERVICES}
            return subprocess.CompletedProcess(arguments, 0, "started\n", "")
        raise AssertionError(f"unexpected Docker command: {arguments}")


class OrbisHostUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = (Path(self.temp.name) / "install")
        self.root.mkdir()
        self.root = self.root.resolve()
        self.snapshot = self.root.parent / "before-update"
        for name in ("docker-compose.yml", ".env"):
            (self.root / name).write_text("safe fixture\n")
        (self.root / "orbis-compose.yml").write_text(UPDATE.HOST.STAGE.staged_content(CURRENT))
        (self.root / "data" / "postgres").mkdir(parents=True)
        (self.root / "data" / "postgres" / "record").write_text("original database fixture\n")
        self.plan = mock.patch.object(UPDATE.HOST.PLAN, "plan", return_value={"configuredImage": CURRENT_IMAGE})
        self.plan.start()
        self.addCleanup(self.plan.stop)
        self.release = mock.patch.object(
            UPDATE.CHECK,
            "check",
            return_value={"commit": TARGET["commit"], "image": TARGET_IMAGE, "runtipiCompatibility": "4.10.1"},
        )
        self.release.start()
        self.addCleanup(self.release.stop)
        UPDATE.HOST.write_state(self.root, UPDATE.HOST.installation_fingerprint(self.root, CURRENT, "test-daemon"))

    def test_update_keeps_a_verified_previous_release_snapshot(self):
        fake = FakeDocker(self.root)
        with mock.patch.object(UPDATE.HOST, "docker", side_effect=fake):
            result = UPDATE.apply_update(self.root, CURRENT, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(result["result"], "healthy")
        self.assertEqual(fake.image, TARGET_IMAGE)
        self.assertEqual(UPDATE.SNAPSHOT.verify(self.snapshot, self.root)["release"], CURRENT["tag"])
        self.assertEqual(UPDATE.journal_path(self.snapshot).read_text().find('"stage": "complete"') >= 0, True)
        self.assertEqual(
            UPDATE.HOST.saved_state(self.root), UPDATE.HOST.installation_fingerprint(self.root, TARGET, "test-daemon")
        )

    def test_failed_target_start_restores_previous_database_and_core(self):
        fake = FakeDocker(self.root, fail_target_start=True)
        with mock.patch.object(UPDATE.HOST, "docker", side_effect=fake):
            with self.assertRaisesRegex(RuntimeError, "previous release was restored"):
                UPDATE.apply_update(self.root, CURRENT, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(fake.image, CURRENT_IMAGE)
        self.assertEqual(fake.states["runtipi"], "running")
        self.assertEqual((self.root / "data" / "postgres" / "record").read_text(), "original database fixture\n")
        self.assertIn(CURRENT["digest"], (self.root / "orbis-compose.yml").read_text())
        self.assertEqual(UPDATE.read_journal(self.snapshot, self.root, "test-daemon", CURRENT, TARGET)["stage"], "rolled-back")

    def test_failed_recreate_with_missing_core_container_restores_previous_release(self):
        fake = FakeDocker(self.root, fail_target_start=True, remove_on_failed_start=True)
        with mock.patch.object(UPDATE.HOST, "docker", side_effect=fake):
            with self.assertRaisesRegex(RuntimeError, "previous release was restored"):
                UPDATE.apply_update(self.root, CURRENT, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(fake.image, CURRENT_IMAGE)
        self.assertEqual(fake.states["runtipi"], "running")
        self.assertEqual(UPDATE.read_journal(self.snapshot, self.root, "test-daemon", CURRENT, TARGET)["stage"], "rolled-back")

    def test_refuses_a_running_managed_app_before_pull_or_stop(self):
        fake = FakeDocker(self.root)
        original = fake.__call__

        def with_app(context, arguments, root):
            if arguments[0] == "ps":
                return subprocess.CompletedProcess(arguments, 0, "runtipi\nruntipi-db\nruntipi-queue\nruntipi-reverse-proxy\napp", "")
            if arguments[0] == "inspect" and arguments[3] == "app":
                if arguments[2] == "{{json .Config.Labels}}":
                    return subprocess.CompletedProcess(arguments, 0, json.dumps({"runtipi.managed": "true"}), "")
                if arguments[2] == "{{json .Mounts}}":
                    return subprocess.CompletedProcess(arguments, 0, "[]", "")
            return original(context, arguments, root)

        with mock.patch.object(UPDATE.HOST, "docker", side_effect=with_app):
            with self.assertRaisesRegex(ValueError, "stop Runtipi-managed applications"):
                UPDATE.apply_update(self.root, CURRENT, TARGET, "test-daemon", self.snapshot)
        self.assertFalse(UPDATE.journal_path(self.snapshot).exists())
        self.assertFalse(any("pull" in call for call in fake.calls))

    def test_recover_restores_a_staged_transaction_after_interruption(self):
        fake = FakeDocker(self.root)
        fake.states = {service: "exited" for service in UPDATE.CORE_SERVICES}
        UPDATE.SNAPSHOT.capture(self.root, self.snapshot, CURRENT["tag"], "test-daemon")
        UPDATE.HOST.STAGE.stage(self.root, TARGET)
        record = {
            "schema": UPDATE.JOURNAL_SCHEMA,
            "root": str(self.root),
            "snapshot": str(self.snapshot),
            "dockerContext": "test-daemon",
            "previousDigest": CURRENT["digest"],
            "targetDigest": TARGET["digest"],
            "stage": "staged",
        }
        UPDATE.write_journal(self.snapshot, record)

        with mock.patch.object(UPDATE.HOST, "docker", side_effect=fake):
            result = UPDATE.recover(self.root, CURRENT, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(result["result"], "rolled-back")
        self.assertEqual(fake.image, CURRENT_IMAGE)
        self.assertEqual(UPDATE.read_journal(self.snapshot, self.root, "test-daemon", CURRENT, TARGET)["stage"], "rolled-back")

    def test_recover_before_downtime_leaves_healthy_core_running(self):
        fake = FakeDocker(self.root)
        record = {
            "schema": UPDATE.JOURNAL_SCHEMA,
            "root": str(self.root),
            "snapshot": str(self.snapshot),
            "dockerContext": "test-daemon",
            "previousDigest": CURRENT["digest"],
            "targetDigest": TARGET["digest"],
            "stage": "pulled",
        }
        UPDATE.write_journal(self.snapshot, record)
        with mock.patch.object(UPDATE.HOST, "docker", side_effect=fake):
            result = UPDATE.recover(self.root, CURRENT, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(result["result"], "aborted-before-downtime")
        self.assertEqual(fake.image, CURRENT_IMAGE)
        self.assertFalse(any(call[0] == "stop" for call in fake.calls))
        self.assertEqual(UPDATE.read_journal(self.snapshot, self.root, "test-daemon", CURRENT, TARGET)["stage"], "aborted")

    def test_corrupt_snapshot_blocks_recovery_before_restore(self):
        fake = FakeDocker(self.root)
        fake.states = {service: "exited" for service in UPDATE.CORE_SERVICES}
        UPDATE.SNAPSHOT.capture(self.root, self.snapshot, CURRENT["tag"], "test-daemon")
        (self.snapshot / "data" / "postgres" / "record").write_text("corrupt")
        record = {
            "schema": UPDATE.JOURNAL_SCHEMA,
            "root": str(self.root),
            "snapshot": str(self.snapshot),
            "dockerContext": "test-daemon",
            "previousDigest": CURRENT["digest"],
            "targetDigest": TARGET["digest"],
            "stage": "snapshot-ready",
        }
        UPDATE.write_journal(self.snapshot, record)
        with mock.patch.object(UPDATE.HOST, "docker", side_effect=fake):
            with self.assertRaisesRegex(RuntimeError, "recovery failed"):
                UPDATE.recover(self.root, CURRENT, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(fake.states["runtipi"], "exited")
        self.assertEqual(UPDATE.read_journal(self.snapshot, self.root, "test-daemon", CURRENT, TARGET)["stage"], "rollback-failed")


if __name__ == "__main__":
    unittest.main()
