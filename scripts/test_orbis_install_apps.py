import copy
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("orbis_install_apps", Path(__file__).with_name("orbis-install-apps.py"))
assert SPEC and SPEC.loader
APPS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(APPS)
STOCK = "ghcr.io/runtipi/runtipi:v4.10.1"
TARGET = "ghcr.io/twentylines/orbis@sha256:" + "d" * 64


def identifier(value):
    return hashlib.sha256(value.encode()).hexdigest()


class Docker:
    context = "test-install-apps"

    def __init__(self, root, count=3):
        self.root = root
        self.daemon_id = "test-daemon"
        self.controller_id = identifier("controller")
        self.controller_image = STOCK
        self.controller_image_id = "sha256:" + "c" * 64
        self.controller_health = "healthy"
        self.controller_state = "running"
        self.apps = {}
        self.calls = []
        self.reads = 0
        self.fail = None
        for index in range(count):
            self.add_app(index, ["running", "exited", "created"][index % 3])

    def add_app(self, number, state="running"):
        name = f"app-{number}"
        self.apps[identifier(name)] = {
            "id": identifier(name), "name": "/" + name, "imageId": "sha256:" + "a" * 64,
            "image": "example/app:1", "autoRemove": False, "stopTimeout": 120,
            "labels": {
                "runtipi.managed": "true", "runtipi.appurn": f"app{number}:migrated",
                "com.docker.compose.project": f"app{number}_migrated",
                "com.docker.compose.service": "web",
                "com.docker.compose.project.working_dir": str(self.root / "apps" / "migrated" / name),
            },
            "mounts": [{"Type": "bind", "Source": str(self.root / "app-data" / name), "Destination": "/data", "RW": True}],
            "state": state,
            "restartPolicy": {"Name": ["unless-stopped", "always", "on-failure"][number % 3], "MaximumRetryCount": 4 if number % 3 == 2 else 0},
        }

    def daemon(self):
        self.reads += 1
        return self.daemon_id

    def containers(self):
        self.reads += 1
        rows = [{
            "id": self.controller_id, "name": "runtipi", "image": self.controller_image,
            "project": "runtipi", "service": "runtipi", "workingDir": str(self.root),
            "managed": "", "appUrn": "", "state": self.controller_state, "publishedPorts": "",
        }]
        for app in self.apps.values():
            labels = app["labels"]
            rows.append({
                "id": app["id"], "name": app["name"][1:], "image": app["image"],
                "project": labels["com.docker.compose.project"], "service": labels["com.docker.compose.service"],
                "workingDir": labels["com.docker.compose.project.working_dir"],
                "managed": labels["runtipi.managed"], "appUrn": labels["runtipi.appurn"],
                "configFiles": labels.get("com.docker.compose.project.config_files", ""),
                "state": app["state"], "publishedPorts": "",
            })
        return rows

    def core(self, container):
        self.reads += 1
        if container != self.controller_id:
            app = self.apps[container]
            return {"id": app["id"], "imageId": app["imageId"], "mounts": copy.deepcopy(app["mounts"])}
        return {
            "id": self.controller_id, "imageId": self.controller_image_id,
            "mounts": [
                {"Type": "bind", "Source": str(self.root / name), "Destination": destination}
                for name, destination in [(".env", "/data/.env"), ("docker-compose.yml", "/data/docker-compose.yml"), ("apps", "/data/apps")]
            ],
        }

    def image(self, _identifier):
        self.reads += 1
        return {"version": "4.10.1" if self.controller_image == STOCK else "v0.1.0-beta.63"}

    def app(self, container):
        self.reads += 1
        return copy.deepcopy(self.apps[container])

    def _object(self, _arguments):
        self.reads += 1
        return {
            "image": self.controller_image, "imageId": self.controller_image_id,
            "state": {"Status": self.controller_state, "Health": {"Status": self.controller_health}},
        }

    def change(self, arguments, timeout=90):
        self.calls.append((arguments, timeout))
        if self.fail is not None:
            self.fail(arguments)
        app = self.apps[arguments[-1]]
        if arguments[0] == "update":
            name, _, retry = arguments[2].partition(":")
            app["restartPolicy"] = {"Name": name, "MaximumRetryCount": int(retry or "0")}
        else:
            app["state"] = "running" if arguments[0] == "start" else "exited"


class InstallationAppTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        parent = Path(self.temp.name).resolve()
        self.root = parent / "install"
        self.root.mkdir()
        self.private = parent / "private"
        self.private.mkdir(mode=0o700)
        self.journal = self.private / "apps.json"
        self.docker = Docker(self.root)
        self.original = copy.deepcopy(self.docker.apps)

    def stop(self):
        reviewed = APPS.plan(self.root, self.docker)
        return APPS.stop(self.root, self.docker, self.journal, reviewed["reviewId"])

    def assert_original_states(self):
        for key, original in self.original.items():
            self.assertEqual(self.docker.apps[key]["state"], original["state"])
            self.assertEqual(self.docker.apps[key]["restartPolicy"], original["restartPolicy"])

    def test_stop_only_running_apps_and_disable_every_restart_policy(self):
        result = self.stop()
        self.assertEqual(result["runningContainersStopped"], 1)
        self.assertEqual([call[0] for call in self.docker.calls if call[0][0] == "stop"], [["stop", identifier("app-0")]])
        self.assertEqual({app["restartPolicy"]["Name"] for app in self.docker.apps.values()}, {"no"})
        self.assertEqual(self.docker.apps[identifier("app-2")]["state"], "created")
        self.assertEqual(APPS.read_journal(self.journal, self.root, self.docker.context)["stage"], "quiesced")
        self.assertEqual(stat.S_IMODE(self.journal.stat().st_mode), 0o600)
        stop_timeout = next(call[1] for call in self.docker.calls if call[0][0] == "stop")
        self.assertGreater(stop_timeout, 120)

    def test_resume_restores_running_stopped_created_and_retry_policies(self):
        self.stop()
        self.assertEqual(APPS.resume(self.root, self.docker, self.journal)["result"], "apps-resumed")
        self.assert_original_states()
        self.assertEqual([call[0] for call in self.docker.calls if call[0][0] == "start"], [["start", identifier("app-0")]])
        self.assertIn((["update", "--restart", "on-failure:4", identifier("app-2")], 90), self.docker.calls)
        with self.assertRaisesRegex(APPS.AppError, "cannot be replayed"):
            APPS.resume(self.root, self.docker, self.journal)

    def test_app_without_an_explicit_stop_timeout_can_stop_and_recover(self):
        self.docker.apps[identifier("app-0")]["stopTimeout"] = None
        self.stop()
        self.assertEqual(next(timeout for args, timeout in self.docker.calls if args[0] == "stop"), 90)
        APPS.resume(self.root, self.docker, self.journal)
        self.assert_original_states()

    def test_partial_stop_failure_can_recover_without_a_new_stop(self):
        def fail(arguments):
            if arguments[0] == "stop":
                raise RuntimeError("synthetic stop failure")
        self.docker.fail = fail
        with self.assertRaisesRegex(RuntimeError, "synthetic stop failure"):
            self.stop()
        self.assertEqual(APPS.read_journal(self.journal, self.root, self.docker.context)["stage"], "quiescing")
        self.docker.fail = None
        APPS.resume(self.root, self.docker, self.journal)
        self.assert_original_states()

    def test_interrupted_resume_is_idempotent_and_preserves_its_recovery_record(self):
        self.stop()
        def fail(arguments):
            if arguments[:3] == ["update", "--restart", "always"]:
                raise RuntimeError("synthetic policy failure")
        self.docker.fail = fail
        with self.assertRaises(RuntimeError):
            APPS.resume(self.root, self.docker, self.journal)
        self.assertEqual(APPS.read_journal(self.journal, self.root, self.docker.context)["stage"], "resuming")
        self.docker.fail = None
        APPS.resume(self.root, self.docker, self.journal)
        self.assert_original_states()
        self.assertEqual(sum(call[0][0] == "start" for call in self.docker.calls), 1)

    def test_stale_review_rejects_state_policy_identity_and_mount_changes_without_mutation(self):
        for change in ("state", "policy", "identity", "mount"):
            with self.subTest(change=change):
                self.docker = Docker(self.root)
                reviewed = APPS.plan(self.root, self.docker)
                app = self.docker.apps[identifier("app-0")]
                if change == "state": app["state"] = "exited"
                if change == "policy": app["restartPolicy"] = {"Name": "always", "MaximumRetryCount": 0}
                if change == "identity": self.docker.add_app(4)
                if change == "mount": app["mounts"][0]["Source"] += "-other"
                with self.assertRaisesRegex(APPS.AppError, "plan changed"):
                    APPS.stop(self.root, self.docker, self.journal, reviewed["reviewId"])
                self.assertEqual(self.docker.calls, [])
                self.assertFalse(self.journal.exists())

    def test_mount_order_changes_between_reads_do_not_invalidate_review_or_recovery(self):
        app = self.docker.apps[identifier("app-0")]
        app["mounts"].append({
            "Type": "volume", "Name": "app-cache", "Source": "/var/lib/docker/volumes/app-cache/_data",
            "Destination": "/cache", "RW": True, "Driver": "local",
        })
        original_read = self.docker.app
        reads = 0

        def reordered(container):
            nonlocal reads
            value = original_read(container)
            reads += 1
            if reads % 2:
                value["mounts"].reverse()
            return value

        with mock.patch.object(self.docker, "app", side_effect=reordered):
            reviewed = APPS.plan(self.root, self.docker)
            self.assertEqual(APPS.plan(self.root, self.docker)["reviewId"], reviewed["reviewId"])
            APPS.stop(self.root, self.docker, self.journal, reviewed["reviewId"])
            APPS.resume(self.root, self.docker, self.journal)
        self.assert_original_states()
        self.assertEqual(app["mounts"][0]["Destination"], "/data")

    def test_mount_changes_remain_bound_to_the_review_after_order_normalization(self):
        for field, value in [("Source", "/other/data"), ("Destination", "/other"), ("RW", False), ("Propagation", "rshared")]:
            with self.subTest(field=field):
                self.docker = Docker(self.root)
                app = self.docker.apps[identifier("app-0")]
                app["mounts"].append({"Type": "tmpfs", "Destination": "/cache", "RW": True})
                reviewed = APPS.plan(self.root, self.docker)
                app["mounts"][0][field] = value
                app["mounts"].reverse()
                with self.assertRaisesRegex(APPS.AppError, "plan changed"):
                    APPS.stop(self.root, self.docker, self.journal, reviewed["reviewId"])
                self.assertEqual(self.docker.calls, [])
                self.assertFalse(self.journal.exists())

    def test_unhealthy_controller_prevents_resume_without_mutating_apps(self):
        self.stop()
        self.docker.calls.clear()
        self.docker.controller_health = "unhealthy"
        with self.assertRaisesRegex(APPS.AppError, "must be healthy"):
            APPS.resume(self.root, self.docker, self.journal)
        self.assertEqual(self.docker.calls, [])

    def test_original_image_tag_cannot_silently_point_to_another_image(self):
        self.stop()
        self.docker.calls.clear()
        self.docker.controller_image_id = "sha256:" + "e" * 64
        with self.assertRaisesRegex(APPS.AppError, "must be healthy"):
            APPS.resume(self.root, self.docker, self.journal)
        self.assertEqual(self.docker.calls, [])

    def test_replaced_controller_requires_the_exact_immutable_orbis_target(self):
        self.stop()
        self.docker.controller_image = TARGET
        self.docker.controller_id = identifier("orbis-controller")
        self.docker.controller_image_id = "sha256:" + "f" * 64
        with self.assertRaisesRegex(APPS.AppError, "must be healthy"):
            APPS.resume(self.root, self.docker, self.journal)
        with self.assertRaisesRegex(APPS.AppError, "immutable Orbis"):
            APPS.resume(self.root, self.docker, self.journal, "example/other:latest")
        APPS.resume(self.root, self.docker, self.journal, TARGET)
        self.assert_original_states()

    def test_changed_daemon_or_removed_app_blocks_recovery(self):
        self.stop()
        for kind in ("daemon", "removed"):
            with self.subTest(kind=kind):
                before = copy.deepcopy(self.docker.apps)
                self.docker.calls.clear()
                if kind == "daemon": self.docker.daemon_id = "different-daemon"
                else: self.docker.apps.pop(identifier("app-0"))
                with self.assertRaisesRegex(APPS.AppError, "daemon differs|containers changed"):
                    APPS.resume(self.root, self.docker, self.journal)
                self.assertEqual(self.docker.calls, [])
                self.docker.daemon_id = "test-daemon"
                self.docker.apps = before

    def test_app_created_during_stop_is_not_stopped_or_accepted_as_quiesced(self):
        def change(arguments):
            if arguments[0] == "stop": self.docker.add_app(99)
        self.docker.fail = change
        with self.assertRaisesRegex(APPS.AppError, "containers changed"):
            self.stop()
        self.assertFalse(any(call[0][-1] == identifier("app-99") for call in self.docker.calls))
        self.assertEqual(APPS.read_journal(self.journal, self.root, self.docker.context)["stage"], "quiescing")

    def test_an_unexpected_running_previously_stopped_app_is_not_silently_stopped(self):
        self.stop()
        self.docker.calls.clear()
        self.docker.apps[identifier("app-1")]["state"] = "running"
        with self.assertRaisesRegex(APPS.AppError, "running unexpectedly"):
            APPS.resume(self.root, self.docker, self.journal)
        self.assertEqual(self.docker.calls, [])

    def test_unassigned_managed_apps_are_never_stopped(self):
        self.docker.apps[identifier("app-0")]["labels"]["com.docker.compose.project.working_dir"] = "/other/apps/app0"
        with self.assertRaisesRegex(APPS.AppError, "Unassigned") as raised:
            self.stop()
        self.assertIn(f"app-0 ({identifier('app-0')[:12]})", str(raised.exception))
        self.assertIn("Compose paths do not identify an app", str(raised.exception))
        self.assertIn("This review made no changes", str(raised.exception))
        self.assertEqual(self.docker.calls, [])
        self.assertFalse(self.journal.exists())

    def test_custom_project_directory_uses_config_files_and_preserves_app_definitions_and_data(self):
        app = self.docker.apps[identifier("app-0")]
        app["labels"].update({
            "com.docker.compose.project.working_dir": "/data",
            "com.docker.compose.project.config_files": "/data/apps/migrated/app0/docker-compose.generated.yml,/data/user-config/migrated/app0/docker-compose.yml",
        })
        sentinel = self.root / "app-data.bin"
        sentinel.write_bytes(b"\x00existing app data\xff")
        before = copy.deepcopy(self.docker.apps)
        self.stop()
        APPS.resume(self.root, self.docker, self.journal)
        self.assertEqual(self.docker.apps, before)
        self.assertEqual(sentinel.read_bytes(), b"\x00existing app data\xff")
        self.assertTrue(all(args[0] in {"update", "stop", "start"} for args, _ in self.docker.calls))

    def test_conflicting_compose_files_fail_before_any_journal_or_mutation(self):
        app = self.docker.apps[identifier("app-0")]
        app["labels"]["com.docker.compose.project.config_files"] = str(self.root / "apps/migrated/other/docker-compose.yml")
        before = copy.deepcopy(self.docker.apps)
        with self.assertRaisesRegex(APPS.AppError, "different apps"):
            self.stop()
        self.assertEqual(self.docker.calls, [])
        self.assertEqual(self.docker.apps, before)
        self.assertFalse(self.journal.exists())

    def test_controller_local_compose_paths_are_stopped_and_resumed(self):
        self.docker.apps[identifier("app-0")]["labels"]["com.docker.compose.project.working_dir"] = "/data/apps/migrated/app0"
        self.stop()
        APPS.resume(self.root, self.docker, self.journal)
        self.assert_original_states()

    def test_shared_alias_requires_a_unique_real_host_compose_directory(self):
        other = self.root.parent / "other"
        owners = [
            {"rootStatus": "confirmed-by-mounts", "storage": [{"type": "bind", "source": str(base / "apps"), "destination": "/data/apps"}]}
            for base in (self.root, other)
        ]
        row = {"workingDir": "/data/apps/local/notes", "appUrn": "notes:local"}
        self.assertEqual(APPS.local_app_owners(row, owners), [])
        first = self.root / "apps/local/notes"
        first.mkdir(parents=True)
        (first / "docker-compose.generated.yml").write_text("synthetic config\n")
        with mock.patch.object(Path, "read_text", side_effect=AssertionError("Do not read config contents")):
            self.assertEqual(APPS.local_app_owners(row, owners), owners[:1])
        second = other / "apps/local/notes"
        second.mkdir(parents=True)
        (second / "docker-compose.yml").write_text("synthetic config\n")
        self.assertEqual(APPS.local_app_owners(row, owners), owners)
        (first / "docker-compose.generated.yml").unlink()
        (first / "docker-compose.generated.yml").symlink_to(second / "docker-compose.yml")
        with self.assertRaisesRegex(APPS.AppError, "symlink"):
            APPS.local_app_owners(row, owners)

    def test_unmanaged_containers_are_left_untouched(self):
        foreign = self.docker.apps[identifier("app-1")]
        foreign["labels"]["runtipi.managed"] = "false"
        foreign["labels"]["com.docker.compose.project.working_dir"] = "/other/install"
        before = copy.deepcopy(foreign)
        self.stop()
        APPS.resume(self.root, self.docker, self.journal)
        self.assertEqual(self.docker.apps[identifier("app-1")], before)
        self.assertFalse(any(call[0][-1] == identifier("app-1") for call in self.docker.calls))

    def test_transient_states_auto_removal_and_unbounded_stop_are_rejected(self):
        for field, value in [("state", "paused"), ("state", "restarting"), ("autoRemove", True), ("stopTimeout", -1)]:
            with self.subTest(field=field, value=value):
                self.docker = Docker(self.root)
                self.docker.apps[identifier("app-0")][field] = value
                with self.assertRaises(APPS.AppError): self.stop()
                self.assertFalse(self.journal.exists())
                self.assertEqual(self.docker.calls, [])

    def test_external_mounts_can_be_quiesced_but_are_not_claimed_as_backed_up(self):
        self.docker.apps[identifier("app-0")]["mounts"][0]["Source"] = "/srv/external/media"
        result = self.stop()
        self.assertEqual(result["result"], "apps-quiesced")
        self.assertNotIn("snapshot", result)
        APPS.resume(self.root, self.docker, self.journal)
        self.assert_original_states()

    def test_journal_reuse_wrong_context_tampering_and_public_modes_are_rejected(self):
        self.stop()
        original = self.journal.read_bytes()
        with self.assertRaisesRegex(APPS.AppError, "already exists"):
            self.stop()
        with self.assertRaisesRegex(APPS.AppError, "another installation"):
            APPS.read_journal(self.journal, self.root, "other-context")
        record = json.loads(original)
        record["plan"]["apps"][0]["originalState"] = "running"
        record["plan"]["apps"][0]["restartPolicy"]["Name"] = "no"
        self.journal.write_text(json.dumps(record))
        with self.assertRaisesRegex(APPS.AppError, "fingerprint"):
            APPS.read_journal(self.journal, self.root, self.docker.context)
        self.journal.write_bytes(original)
        os.chmod(self.journal, 0o644)
        with self.assertRaisesRegex(APPS.AppError, "private regular file"):
            APPS.read_journal(self.journal, self.root, self.docker.context)

    def test_journal_must_be_private_outside_root_and_not_a_symlink(self):
        for target in [self.root / "apps.json", self.root.parent / "apps.json"]:
            with self.subTest(target=target):
                if target.parent == self.root.parent: os.chmod(target.parent, 0o755)
                with self.assertRaises(APPS.AppError):
                    APPS.stop(self.root, self.docker, target, APPS.plan(self.root, self.docker)["reviewId"])
        (self.private / "target").write_text("untouched")
        self.journal.symlink_to(self.private / "target")
        with self.assertRaises(APPS.AppError): self.stop()
        self.assertEqual((self.private / "target").read_text(), "untouched")

    def test_docker_mutations_always_use_the_explicit_context_and_suppress_output(self):
        reader = APPS.Docker("reviewed-context")
        with mock.patch.object(APPS.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            reader.change(["stop", "a" * 64], timeout=150)
        self.assertEqual(run.call_args.args[0][:4], ["docker", "--context", "reviewed-context", "container"])
        self.assertEqual(run.call_args.kwargs["stdout"], subprocess.DEVNULL)
        self.assertEqual(run.call_args.kwargs["stderr"], subprocess.DEVNULL)
        with mock.patch.object(APPS.subprocess, "run", side_effect=subprocess.TimeoutExpired(["docker"], 150, stderr="secret-value")):
            with self.assertRaises(RuntimeError) as error: reader.change(["stop", "a" * 64])
        self.assertNotIn("secret-value", str(error.exception))

    def test_invalid_journal_contents_do_not_reach_terminal_output(self):
        for body in [b'{"secret":"private-value"} invalid', b'private-value\xff']:
            with self.subTest(body=body):
                self.journal.write_bytes(body)
                os.chmod(self.journal, 0o600)
                output = io.StringIO()
                arguments = ["orbis-install-apps.py", "resume", str(self.root), "--docker-context", "test-install-apps", "--journal", str(self.journal), "--confirm-root", str(self.root)]
                with mock.patch("sys.argv", arguments), contextlib.redirect_stderr(output):
                    self.assertEqual(APPS.main(), 2)
                self.assertNotIn("private-value", output.getvalue())
                self.assertEqual(json.loads(output.getvalue())["result"], "app-operation-failed")

    def test_inventory_read_cost_scales_with_apps_instead_of_app_pairs(self):
        counts = []
        for count in [8, 16]:
            reader = Docker(self.root, count)
            path = self.private / f"apps-{count}.json"
            reviewed = APPS.plan(self.root, reader)
            APPS.stop(self.root, reader, path, reviewed["reviewId"])
            APPS.resume(self.root, reader, path)
            counts.append(reader.reads)
        self.assertLess(counts[1], counts[0] * 2.25)


if __name__ == "__main__":
    unittest.main()
