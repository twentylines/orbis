import importlib.util
import json
import os
import stat
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("orbis_host_service", Path(__file__).with_name("orbis-host-service.py"))
assert SPEC and SPEC.loader
SERVICE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVICE)


def manifest(tag: str, digit: str) -> dict[str, str]:
    return {
        "schema": "orbis.release.v1",
        "image": "ghcr.io/twentylines/orbis",
        "tag": tag,
        "commit": digit * 40,
        "digest": "sha256:" + digit * 64,
        "runtipiCompatibility": "4.10.1",
    }


class ReleaseChannelFileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "install"
        self.root.mkdir(mode=0o700)

    def test_absent_channel_defaults_to_stable_and_saved_file_is_private(self):
        self.assertEqual(SERVICE.read_channel(self.root), {"version": 1, "channel": "stable", "revision": "initial"})
        revision = str(uuid.uuid4())
        SERVICE.save_channel(self.root, "nightly", revision)
        channel = SERVICE.read_channel(self.root)
        file = self.root / "state" / "orbis-release-channel.json"
        self.assertEqual(channel, {"version": 1, "channel": "nightly", "revision": revision})
        self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(file.parent.stat().st_mode), 0o700)

    def test_symlink_hardlink_public_file_and_writable_parent_are_rejected(self):
        state = self.root / "state"
        state.mkdir(mode=0o700)
        channel = state / "orbis-release-channel.json"
        other = self.root / "other.json"
        other.write_text(json.dumps({"version": 1, "channel": "nightly", "revision": str(uuid.uuid4())}))

        channel.symlink_to(other)
        with self.assertRaises(OSError):
            SERVICE.read_channel(self.root)
        channel.unlink()

        channel.write_text(other.read_text())
        os.link(channel, self.root / "hardlink.json")
        with self.assertRaisesRegex(ValueError, "private regular file"):
            SERVICE.read_channel(self.root)
        (self.root / "hardlink.json").unlink()

        channel.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "private regular file"):
            SERVICE.read_channel(self.root)
        channel.chmod(0o600)

        state.chmod(0o777)
        with self.assertRaisesRegex(ValueError, "channel directory is invalid"):
            SERVICE.read_channel(self.root)


class HostReleaseChannelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name).resolve()
        self.root, self.snapshots, self.state = (base / name for name in ("install", "snapshots", "state"))
        for directory in (self.root, self.snapshots, self.state):
            directory.mkdir(mode=0o700)
        for name in ("docker-compose.yml", ".env", "orbis-compose.yml", "user-config/tipi-compose.yml"):
            file = self.root / name
            file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            file.write_text("fixture\n")
        self.service = SERVICE.HostService(self.root, "test-daemon", self.snapshots, self.state)
        self.current = manifest("v1.0.1-beta.10", "a")
        self.beta9 = manifest("v1.0.1-beta.9", "b")
        self.older_beta = manifest("v1.0.0-beta.12", "c")
        self.previous_stable = manifest("v1.0.0", "d")
        self.latest_stable = manifest("v1.0.1", "e")
        self.update_plan = mock.patch.object(SERVICE.UPDATE, "update_plan", return_value={"snapshotBytes": 123})
        self.update_plan_mock = self.update_plan.start()
        self.addCleanup(self.update_plan.stop)

    def _verified_installation(self, installed: dict[str, str]):
        saved = {
            "tag": installed["tag"],
            "digest": installed["digest"],
            "root": str(self.root),
            "dockerContext": "test-daemon",
            "files": {
                name: SERVICE.HOST.file_digest(self.root / name)
                for name in ("docker-compose.yml", ".env", "user-config/tipi-compose.yml", "orbis-compose.yml")
            },
        }
        stack = mock.patch.object(SERVICE.HOST, "saved_state", return_value=saved)
        core = mock.patch.object(
            SERVICE.HOST,
            "current_core",
            return_value={"state": "running", "health": "healthy", "image": f"{installed['image']}@{installed['digest']}"},
        )
        stack.start()
        core.start()
        self.addCleanup(stack.stop)
        self.addCleanup(core.stop)

    def test_channel_acknowledgement_revision_and_idle_guards(self):
        initial = SERVICE.read_channel(self.root)
        with mock.patch.object(self.service, "current_manifest", return_value=self.current):
            self._verified_installation(self.current)
            with self.assertRaisesRegex(ValueError, "confirm the Nightly warning"):
                self.service.select_channel("nightly", initial["revision"])
            with self.assertRaisesRegex(ValueError, "channel changed"):
                self.service.select_channel("nightly", str(uuid.uuid4()), True)
            self.assertEqual(self.service.select_channel("nightly", initial["revision"], True), {"channel": "nightly"})
            nightly = SERVICE.read_channel(self.root)
            self.assertEqual(nightly["channel"], "nightly")
            self.assertNotEqual(nightly["revision"], initial["revision"])

            SERVICE.write_private(self.service.job_file, {"state": "interrupted"})
            with self.assertRaisesRegex(ValueError, "finish or recover"):
                self.service.select_channel("stable", nightly["revision"])

    def test_stable_channel_rejects_a_beta_target_before_update_planning(self):
        with mock.patch.object(self.service, "current_manifest", return_value=self.current), mock.patch.object(
            SERVICE, "manifest_for_tag", return_value=self.beta9
        ):
            with self.assertRaisesRegex(ValueError, "selected update channel"):
                self.service.plan(self.beta9["tag"])
        self.update_plan_mock.assert_not_called()

    def test_nightly_allows_same_base_beta_and_prior_stable_but_rejects_older_base_beta(self):
        SERVICE.save_channel(self.root, "nightly", str(uuid.uuid4()))
        self._verified_installation(self.current)
        with mock.patch.object(self.service, "current_manifest", return_value=self.current), mock.patch.object(
            SERVICE, "manifest_for_tag", side_effect=lambda tag: {
                self.beta9["tag"]: self.beta9,
                self.older_beta["tag"]: self.older_beta,
                self.previous_stable["tag"]: self.previous_stable,
            }[tag]
        ):
            planned = self.service.plan(self.beta9["tag"])
            self.assertEqual(planned["targetTag"], self.beta9["tag"])
            with self.assertRaisesRegex(ValueError, "same version's beta revisions"):
                self.service.plan(self.older_beta["tag"])
            previous = self.service.plan(self.previous_stable["tag"])
            self.assertEqual(previous["targetTag"], self.previous_stable["tag"])

    def test_return_to_stable_must_target_latest_release_and_commits_only_after_success(self):
        SERVICE.save_channel(self.root, "nightly", str(uuid.uuid4()))
        with mock.patch.object(self.service, "current_manifest", return_value=self.current), mock.patch.object(
            SERVICE,
            "manifest_for_tag",
            side_effect=lambda tag: {self.previous_stable["tag"]: self.previous_stable, self.latest_stable["tag"]: self.latest_stable}[tag],
        ), mock.patch.object(SERVICE, "latest_stable_tag", return_value=self.latest_stable["tag"]):
            with self.assertRaisesRegex(ValueError, "latest Stable release"):
                self.service.plan(self.previous_stable["tag"], return_to_stable=True)
            plan = self.service.plan(self.latest_stable["tag"], return_to_stable=True)

        self.assertEqual(SERVICE.read_channel(self.root)["channel"], "nightly")
        started, finish = threading.Event(), threading.Event()

        def apply_update(*_args):
            started.set()
            if not finish.wait(2):
                raise RuntimeError("test update timed out")

        with mock.patch.object(SERVICE, "latest_stable_tag", return_value=self.latest_stable["tag"]), mock.patch.object(
            SERVICE.UPDATE, "apply_update", side_effect=apply_update
        ):
            self._verified_installation(self.current)
            with mock.patch.object(self.service, "current_manifest", return_value=self.current):
                _, launch = self.service.apply(plan["planId"])
                launch()
                self.assertTrue(started.wait(2))
                self.assertEqual(SERVICE.read_channel(self.root)["channel"], "nightly")
                finish.set()
                for _ in range(100):
                    job = SERVICE.read_private(self.service.job_file)
                    if job and job["state"] not in {"running", "recovering"}:
                        break
                    time.sleep(0.01)
                self.assertEqual(job["state"], "complete")
        channel = SERVICE.read_channel(self.root)
        self.assertEqual(channel, {"version": 1, "channel": "stable", "revision": plan["planId"]})
        completed = SERVICE.read_private(self.service.job_file)
        self.service.complete_channel_change(completed)
        self.assertEqual(SERVICE.read_channel(self.root), channel)

    def test_failed_stable_install_retains_nightly_channel(self):
        SERVICE.save_channel(self.root, "nightly", str(uuid.uuid4()))
        with mock.patch.object(self.service, "current_manifest", return_value=self.current), mock.patch.object(
            SERVICE, "manifest_for_tag", return_value=self.latest_stable
        ), mock.patch.object(SERVICE, "latest_stable_tag", return_value=self.latest_stable["tag"]):
            plan = self.service.plan(self.latest_stable["tag"], return_to_stable=True)
        self._verified_installation(self.current)
        with mock.patch.object(self.service, "current_manifest", return_value=self.current), mock.patch.object(
            SERVICE, "latest_stable_tag", return_value=self.latest_stable["tag"]
        ), mock.patch.object(SERVICE.UPDATE, "apply_update", side_effect=RuntimeError("synthetic update failure")):
            _, launch = self.service.apply(plan["planId"])
            launch()
            for _ in range(100):
                job = SERVICE.read_private(self.service.job_file)
                if job and job["state"] not in {"running", "recovering"}:
                    break
                time.sleep(0.01)
        self.assertEqual(job["state"], "failed")
        self.assertEqual(SERVICE.read_channel(self.root)["channel"], "nightly")

    def test_completed_stable_install_retries_channel_commit_after_restart(self):
        SERVICE.save_channel(self.root, "nightly", str(uuid.uuid4()))
        channel_before = SERVICE.read_channel(self.root)
        identifier = str(uuid.uuid4())
        snapshot = self.snapshots / f"orbis-{self.latest_stable['tag']}-{identifier}"
        job = {
            "schema": "orbis.host-service-job.v1",
            "id": identifier,
            "state": "interrupted",
            "targetTag": self.latest_stable["tag"],
            "startedAt": time.time(),
            "snapshot": str(snapshot),
            "current": self.current,
            "target": self.latest_stable,
            "channelState": channel_before,
            "returnToStable": True,
        }
        SERVICE.write_private(self.service.job_file, job)
        SERVICE.write_private(SERVICE.UPDATE.journal_path(snapshot), {"stage": "complete"})
        self._verified_installation(self.latest_stable)
        state = mock.patch.object(self.service, "state_matches", return_value=True)
        state.start()
        self.addCleanup(state.stop)
        real_save = SERVICE.save_channel
        saves = 0

        def fail_first_save(*args):
            nonlocal saves
            saves += 1
            if saves == 1:
                raise OSError("temporary write failure")
            return real_save(*args)

        with mock.patch.object(SERVICE, "save_channel", side_effect=fail_first_save):
            first = self.service.status()
            self.assertEqual(first["job"]["state"], "interrupted")
            self.assertIn("needs recovery", first["job"]["message"])
            self.assertEqual(SERVICE.read_channel(self.root), channel_before)
            recovered = self.service.status()

        self.assertEqual(recovered["job"]["state"], "complete")
        self.assertEqual(saves, 2)
        self.assertEqual(SERVICE.read_channel(self.root), {"version": 1, "channel": "stable", "revision": identifier})


if __name__ == "__main__":
    unittest.main()
