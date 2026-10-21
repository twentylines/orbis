import copy
import importlib.util
import json
import os
import tempfile
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("installation_transaction", Path(__file__).with_name("orbis-install-transaction.py"))
assert SPEC and SPEC.loader
TX = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TX)
FIXTURES = TX.APPS.load_script("test_orbis_install_storage.py", "transaction_storage_fixtures")
identifier = FIXTURES.FIXTURES.identifier


class Interrupted(BaseException):
    pass


class Docker(FIXTURES.Docker):
    def __init__(self, root):
        super().__init__(root)
        self.controller_policy = {"Name": "unless-stopped", "MaximumRetryCount": 0}
        self.services = {}
        for name in ("runtipi-db", "runtipi-queue", "runtipi-reverse-proxy"):
            self.services[identifier(name)] = {
                "id": identifier(name), "name": "/" + name, "imageId": "sha256:" + "b" * 64,
                "image": "example/fixture:1", "autoRemove": False, "stopTimeout": 60,
                "labels": {"com.docker.compose.project": "runtipi", "com.docker.compose.service": name, "com.docker.compose.project.working_dir": str(root)},
                "mounts": [], "state": "running", "restartPolicy": {"Name": "unless-stopped", "MaximumRetryCount": 0},
            }

    def containers(self):
        rows = super().containers()
        for item in self.services.values():
            rows.append({"id": item["id"], "name": item["name"][1:], "image": item["image"], "project": "runtipi", "service": item["name"][1:], "workingDir": str(self.root), "managed": "", "appUrn": "", "state": item["state"], "publishedPorts": ""})
        return rows

    def app(self, key):
        if key in self.services:
            return copy.deepcopy(self.services[key])
        value = super().app(key)
        if key == self.controller_id:
            value["labels"].update({"com.docker.compose.service": "runtipi", "com.docker.compose.project.working_dir": str(self.root)})
        return value

    def _object(self, arguments):
        if arguments[-2] == "{{json .State}}":
            return {"Status": self.controller_state, "Health": {"Status": self.controller_health}}
        return super()._object(arguments)

    def change(self, arguments, timeout=90):
        self.calls.append((arguments, timeout))
        if self.fail:
            self.fail(arguments)
        key = arguments[-1]
        value = self.services.get(key, self.apps.get(key))
        if arguments[0] == "update":
            name, _, retry = arguments[2].partition(":")
            policy = {"Name": name, "MaximumRetryCount": int(retry or "0")}
            if key == self.controller_id:
                self.controller_policy = policy
            else:
                value["restartPolicy"] = policy
        elif key == self.controller_id:
            self.controller_state = "running" if arguments[0] == "start" else "exited"
        else:
            value["state"] = "running" if arguments[0] == "start" else "exited"


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name).resolve()
        self.root = self.parent / "install"
        self.root.mkdir()
        for name in (".env", "docker-compose.yml"):
            (self.root / name).write_text("private-value-not-for-output")
        (self.root / "apps").mkdir()
        for index in range(3):
            (self.root / "app-data" / f"app-{index}").mkdir(parents=True)
        self.private = self.parent / "private"
        self.private.mkdir(mode=0o700)
        self.journal = self.private / "install.json"
        self.bundle = self.private / "backup"
        self.docker = Docker(self.root)
        self.original = self.states()
        runtime = mock.patch.object(TX.RESTORE, "runtime")
        runtime.start()
        self.addCleanup(runtime.stop)

    def states(self):
        return {row["id"]: (row["state"], self.docker.app(row["id"])["restartPolicy"]) for row in self.docker.containers()}

    def review(self):
        return TX.review(self.root, self.docker, self.bundle, self.journal)

    def prepare(self):
        value = self.review()
        record = {"schema": TX.SCHEMA, "id": "00000000-0000-4000-8000-000000000001", "stage": "quiescing", "review": value}
        TX.save(record)
        return record

    def quiesce(self):
        record = self.prepare()
        TX.quiesce(self.root, self.docker, record)
        return record

    def recover(self):
        return TX.recover(self.root, self.docker, self.journal, host_writers_stopped=True)

    def test_review_is_read_only_and_covers_core_and_apps_without_secret_values(self):
        value = self.review()
        self.assertEqual(len(value["roles"]), 7)
        self.assertEqual(set(value["roles"].values()), {"controller", "proxy", "database", "queue", "app"})
        self.assertFalse(self.journal.exists())
        self.assertEqual(self.docker.calls, [])
        self.assertNotIn("private-value-not-for-output", json.dumps(value))

    def test_requires_healthy_original_and_all_required_services(self):
        self.docker.controller_health = "unhealthy"
        with self.assertRaisesRegex(TX.TransactionError, "healthy"):
            self.review()
        self.docker.controller_health = "healthy"
        del self.docker.services[identifier("runtipi-db")]
        with self.assertRaisesRegex(TX.TransactionError, "Exactly one"):
            self.review()
        self.assertEqual(self.docker.calls, [])

    def test_journal_cannot_be_in_app_storage(self):
        self.journal = self.root / "app-data" / "journal.json"
        with self.assertRaises(ValueError):
            self.review()
        self.assertEqual(self.docker.calls, [])

    def test_changed_review_or_missing_host_acknowledgement_cannot_stop_anything(self):
        value = self.review()
        with self.assertRaisesRegex(TX.TransactionError, "Confirm"):
            TX.checkpoint(self.root, self.docker, value, host_writers_stopped=False)
        value["roles"][self.docker.controller_id] = "app"
        with self.assertRaisesRegex(TX.TransactionError, "edited"):
            TX.checkpoint(self.root, self.docker, value, host_writers_stopped=True)
        self.assertEqual(self.docker.calls, [])

    def test_stale_plan_cannot_stop_changed_container(self):
        value = self.review()
        self.docker.apps[identifier("app-0")]["imageId"] = "sha256:" + "d" * 64
        with self.assertRaisesRegex(TX.TransactionError, "changed"):
            TX.checkpoint(self.root, self.docker, value, host_writers_stopped=True)
        self.assertEqual(self.docker.calls, [])

    def test_disable_all_restart_policies_before_stopping_controller_apps_queue_database(self):
        record = self.quiesce()
        calls = [args for args, _ in self.docker.calls]
        self.assertTrue(all(args[0] == "update" for args in calls[:7]))
        stopped = [args[-1] for args in calls if args[0] == "stop"]
        self.assertEqual([record["review"]["roles"][key] for key in stopped], ["controller", "proxy", "app", "queue", "database"])
        self.assertEqual(self.docker.apps[identifier("app-2")]["state"], "created")
        self.assertTrue(all(policy == TX.NO_RESTART for _, policy in self.states().values()))

    def test_each_mutation_has_a_durable_private_journal(self):
        self.prepare()
        def inspect(_):
            self.assertEqual(os.stat(self.journal).st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(self.journal.read_text())["stage"], "quiescing")
        self.docker.fail = inspect
        record = TX.read_record(self.journal, self.root, self.docker)
        TX.quiesce(self.root, self.docker, record)

    def test_interruption_mid_stop_recovers_all_original_states_and_policies(self):
        self.prepare()
        def crash(args):
            if args == ["stop", identifier("app-0")]: raise Interrupted()
        self.docker.fail = crash
        with self.assertRaises(Interrupted):
            TX.quiesce(self.root, self.docker, TX.read_record(self.journal, self.root, self.docker))
        self.docker.fail = None
        self.assertEqual(self.recover()["storageRestored"], False)
        self.assertEqual(self.states(), self.original)

    def test_recovery_starts_database_queue_apps_before_controller_and_proxy(self):
        self.quiesce()
        self.docker.calls = []
        self.recover()
        started = [args[-1] for args, _ in self.docker.calls if args[0] == "start"]
        self.assertEqual(started, [identifier("runtipi-db"), identifier("runtipi-queue"), identifier("app-0"), self.docker.controller_id, identifier("runtipi-reverse-proxy")])
        self.assertEqual(self.states(), self.original)

    def test_interrupted_policy_restoration_can_be_recovered_again(self):
        self.quiesce()
        def crash(args):
            if args == ["update", "--restart", "always", identifier("app-1")]: raise Interrupted()
        self.docker.fail = crash
        with self.assertRaises(Interrupted): self.recover()
        self.docker.fail = None
        self.recover()
        self.assertEqual(self.states(), self.original)

    def test_different_daemon_cannot_recover_or_change_any_container(self):
        self.quiesce()
        self.docker.calls = []
        self.docker.daemon_id = "another-daemon"
        with self.assertRaisesRegex(TX.TransactionError, "Docker changed"):
            self.recover()
        self.assertEqual(self.docker.calls, [])

    def test_replaced_container_or_policy_drift_blocks_recovery_before_mutation(self):
        self.quiesce()
        self.docker.calls = []
        self.docker.controller_image_id = "sha256:" + "e" * 64
        with self.assertRaisesRegex(TX.TransactionError, "definitions"):
            self.recover()
        self.assertEqual(self.docker.calls, [])

    def test_foreign_restart_policy_cannot_be_silently_overwritten(self):
        self.quiesce()
        self.docker.calls = []
        self.docker.controller_policy = {"Name": "always", "MaximumRetryCount": 0}
        with self.assertRaisesRegex(TX.TransactionError, "policy changed"):
            self.recover()
        self.assertEqual(self.docker.calls, [])

    def test_ready_transaction_requires_a_verified_backup_and_keeps_writers_stopped_on_corruption(self):
        record = self.quiesce()
        record.update(stage="ready", backupFingerprint="a" * 64)
        TX.save(record)
        with self.assertRaises(TX.STORAGE.StorageError): self.recover()
        self.assertTrue(all(state != "running" for state, _ in self.states().values()))

    def test_failed_snapshot_retains_recoverable_quiesced_services(self):
        value = self.review()
        with mock.patch.object(TX.STORAGE, "capture", side_effect=RuntimeError("disk full")):
            with self.assertRaisesRegex(RuntimeError, "disk full"):
                TX.checkpoint(self.root, self.docker, value, host_writers_stopped=True)
        self.assertEqual(json.loads(self.journal.read_text())["stage"], "snapshotting")
        self.recover()
        self.assertEqual(self.states(), self.original)

    def test_completed_recovery_cannot_be_replayed(self):
        self.quiesce()
        self.recover()
        self.docker.calls = []
        with self.assertRaisesRegex(TX.TransactionError, "already recovered"):
            self.recover()
        self.assertEqual(self.docker.calls, [])

    def test_native_child_retains_the_operation_lock_after_parent_releases_it(self):
        with TX.APPS.HOST.host_lock(self.root) as descriptor:
            child = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.buffer.read(1)"], stdin=subprocess.PIPE, pass_fds=(descriptor,))
        try:
            with self.assertRaisesRegex(ValueError, "operation is in progress"):
                with TX.APPS.HOST.host_lock(self.root):
                    self.fail("Native child lost the installation lock")
        finally:
            child.communicate(b"x", timeout=5)
        with TX.APPS.HOST.host_lock(self.root):
            pass


if __name__ == "__main__":
    unittest.main()
