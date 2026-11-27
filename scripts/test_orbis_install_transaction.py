import copy
import importlib.util
import json
import os
import shutil
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
            rows.append({"id": item["id"], "name": item["name"][1:], "image": item["image"], "project": "runtipi", "service": item["name"][1:], "workingDir": str(self.root), "managed": item["labels"].get("runtipi.managed", ""), "appUrn": "", "state": item["state"], "publishedPorts": ""})
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

    def no_backup_review(self):
        config = self.root / "traefik"
        config.mkdir(exist_ok=True)
        self.docker.services[identifier("runtipi-reverse-proxy")]["mounts"] = [
            {"Type": "bind", "Source": str(config), "Destination": "/etc/traefik", "RW": True}]
        return TX.review(self.root, self.docker, self.bundle, self.journal, scope=TX.STORAGE.LIVE_PROXY_SCOPE, backup=False)

    def test_no_backup_handoff_never_copies_storage_and_cannot_be_legacy_recovery(self):
        with mock.patch.object(TX.STORAGE.SNAPSHOT, "preflight", side_effect=AssertionError("No backup sizing")):
            value = self.no_backup_review()
            original_apps = copy.deepcopy(self.docker.apps)
            self.assertEqual(value["storage"]["estimatedBytes"], 0)
            self.assertFalse(self.journal.exists())
            with mock.patch.object(TX.STORAGE, "capture", side_effect=AssertionError("No data copy")), mock.patch.object(TX.RESTORE, "runtime", side_effect=AssertionError("No restore runtime")):
                record = TX.quiesce_without_backup(self.root, self.docker, value, host_writers_stopped=True)
        self.assertFalse(self.bundle.exists())
        self.assertFalse(record["backupCreated"])
        self.assertEqual(TX.read_no_backup_handoff(self.journal, self.root, self.docker), record)
        with self.assertRaises(TX.TransactionError):
            TX.read_record(self.journal, self.root, self.docker)
        self.assertEqual(self.docker.services[identifier("runtipi-reverse-proxy")]["state"], "running")
        self.assertEqual(self.docker.apps, original_apps)
        self.assertEqual(self.docker.controller_state, "exited")

    def test_no_backup_policy_requires_explicit_confirmation_and_rejects_checkpoint_use(self):
        value = self.no_backup_review()
        with self.assertRaises(TX.TransactionError):
            TX.quiesce_without_backup(self.root, self.docker, value, host_writers_stopped=False)
        with self.assertRaises(TX.TransactionError):
            TX.checkpoint(self.root, self.docker, value, host_writers_stopped=True)
        self.assertFalse(self.journal.exists())
        self.assertEqual(self.docker.calls, [])
        with self.assertRaises(TX.TransactionError):
            TX.review(self.root, self.docker, self.bundle, self.journal, backup=False)

    def runtipi_configuration_fixture(self):
        plan = TX.APPS.HOST.PLAN
        current = {"schema": "orbis.release.v1", "image": plan.IMAGE, "tag": "v0.9.1",
                   "commit": "a" * 40, "digest": "sha256:" + "b" * 64, "runtipiCompatibility": "4.10.1",
                   "installationProtocol": plan.INSTALLATION_PROTOCOL}
        target = {**current, "tag": "v0.9.2-rc.1", "commit": "c" * 40, "digest": "sha256:" + "d" * 64,
                  "runtipiCompatibility": "4.12.0"}
        operation = "00000000-0000-4000-8000-000000000001"
        self.bundle = self.private / f"orbis-{target['tag']}-{operation}"
        self.journal = self.bundle.with_name(self.bundle.name + ".checkpoint.json")
        for folder in plan.PREFLIGHT.DATA_PATHS:
            (self.root / folder).mkdir(exist_ok=True)
        (self.root / "data/postgres").mkdir(parents=True)
        (self.root / "docker-compose.yml").write_text(json.dumps({"services": {
            "runtipi": {"image": "example/placeholder:1", "env_file": [".env"], "volumes": ["./.env:/data/.env"]},
            "runtipi-db": {"image": "postgres:14", "volumes": ["./data/postgres:/var/lib/postgresql/data"]},
            "runtipi-queue": {"image": "rabbitmq:4-alpine"},
            "runtipi-reverse-proxy": {"image": "traefik:v3.6"},
        }}))
        (self.root / ".env").write_text(f"ROOT_FOLDER_HOST='{self.root}'\nTIPI_VERSION='4.10.1'\nEXAMPLE=synthetic-fixture-value\n")
        (self.root / "VERSION").write_text("4.10.1\n")
        (self.root / "orbis-compose.yml").write_text(TX.APPS.HOST.STAGE.staged_content(current))
        approval = plan.review_412(self.root, current, target)
        binding = {"operationId": operation, "approvedReviewSha256": TX.APPS.digest(approval),
                   "sourceReceiptSha256": "e" * 64, "targetReceiptSha256": "f" * 64}
        return current, target, binding

    @unittest.skipUnless(shutil.which("docker"), "Docker Compose is unavailable")
    def test_runtipi_pair_is_prepared_only_from_its_sealed_backup_and_reconciles_mixed_files(self):
        current, target, binding = self.runtipi_configuration_fixture()
        originals = {name: (self.root / name).read_bytes() for name in TX.RUNTIPI_CONFIGURATION_FILES}
        reviewed = self.review()
        TX.checkpoint(self.root, self.docker, reviewed, host_writers_stopped=True)
        self.docker.calls.clear()
        args = (self.root, self.docker, self.journal, current, target, binding)
        receipt = TX.prepare_runtipi_configuration(*args)
        self.assertEqual(TX.prepare_runtipi_configuration(*args), receipt)
        self.assertEqual(TX.read_record(self.journal, self.root, self.docker)["runtipiConfiguration"], receipt)
        self.assertNotIn("synthetic-fixture-value", self.journal.read_text())
        self.assertEqual({name: (self.root / name).read_bytes() for name in originals}, originals)
        self.assertEqual(self.docker.calls, [])
        with self.assertRaisesRegex(TX.TransactionError, "has changed"):
            TX.runtipi_configuration_recovery_state(*args[:-1], {**binding, "sourceReceiptSha256": "1" * 64})
        (self.root / ".env").write_bytes(originals[".env"].replace(b"4.10.1", b"4.12.0"))
        self.assertEqual(TX.runtipi_configuration_recovery_state(*args),
                         {".env": "target", "VERSION": "source", "orbis-compose.yml": "source"})
        (self.root / "VERSION").write_text("unreviewed\n")
        with self.assertRaisesRegex(TX.TransactionError, "differs from both approved"):
            TX.runtipi_configuration_recovery_state(*args)

    @unittest.skipUnless(sys.platform == "linux" and shutil.which("docker"), "requires Linux rsync and Docker Compose")
    def test_runtipi_configuration_is_back_to_source_before_original_writers_restart(self):
        current, target, binding = self.runtipi_configuration_fixture()
        originals = {name: (self.root / name).read_bytes() for name in TX.RUNTIPI_CONFIGURATION_FILES}
        TX.checkpoint(self.root, self.docker, self.review(), host_writers_stopped=True)
        args = (self.root, self.docker, self.journal, current, target, binding)
        TX.prepare_runtipi_configuration(*args)
        for name, body in TX.APPS.HOST.PLAN.configuration_412(current, target, originals[".env"], originals["VERSION"])[0].items():
            (self.root / name).write_bytes(body)
        override = TX.APPS.HOST.STAGE.HEADER + TX.APPS.HOST.PLAN.override_412(target)
        (self.root / "orbis-compose.yml").write_text(override)
        self.assertEqual(TX.runtipi_configuration_recovery_state(*args), {name: "target" for name in originals})

        def verify_before_originals_start():
            self.assertEqual(self.docker.controller_state, "exited")
            self.assertEqual(TX.runtipi_configuration_recovery_state(*args), {name: "source" for name in originals})
        TX.recover(self.root, self.docker, self.journal, host_writers_stopped=True,
                   before_originals_start=verify_before_originals_start)
        with self.assertRaisesRegex(TX.TransactionError, "No active"):
            TX.runtipi_configuration_recovery_state(*args)
        self.assertEqual({name: (self.root / name).read_bytes() for name in originals}, originals)

    @unittest.skipUnless(shutil.which("docker"), "Docker Compose is unavailable")
    def test_runtipi_pair_refuses_unready_or_different_operation_and_changed_backup(self):
        current, target, binding = self.runtipi_configuration_fixture()
        record = self.prepare()
        args = (self.root, self.docker, self.journal, current, target, binding)
        with self.assertRaisesRegex(TX.TransactionError, "completed stopped checkpoint"):
            TX.prepare_runtipi_configuration(*args)
        self.journal.unlink()
        TX.checkpoint(self.root, self.docker, record["review"], host_writers_stopped=True)
        self.docker.calls.clear()
        other = {**binding, "operationId": "00000000-0000-4000-8000-000000000002"}
        with self.assertRaisesRegex(TX.TransactionError, "this operation's verified backup"):
            TX.prepare_runtipi_configuration(*args[:-1], other)
        backup_root = self.bundle / "resource-0000"
        (backup_root / "VERSION").write_text("4.12.0\n")
        with self.assertRaises(ValueError):
            TX.prepare_runtipi_configuration(*args)
        self.assertEqual(self.docker.calls, [])
        self.assertNotIn("runtipiConfiguration", TX.read_record(self.journal, self.root, self.docker))

    def test_incomplete_no_backup_handoff_is_not_ready_or_recoverable_as_a_backup(self):
        value = self.no_backup_review()
        def interrupt(arguments):
            if arguments[0] == "stop":
                raise Interrupted()
        self.docker.fail = interrupt
        with self.assertRaises(Interrupted):
            TX.quiesce_without_backup(self.root, self.docker, value, host_writers_stopped=True)
        self.assertEqual(TX.RESTORE.private_json(self.journal)["stage"], "quiescing")
        with self.assertRaises(TX.TransactionError):
            TX.read_no_backup_handoff(self.journal, self.root, self.docker)
        with self.assertRaises(TX.TransactionError):
            TX.read_record(self.journal, self.root, self.docker)
        self.assertFalse(self.bundle.exists())

    def test_no_backup_handoff_rejects_resumed_writer_or_claimed_backup(self):
        value = self.no_backup_review()
        record = TX.quiesce_without_backup(self.root, self.docker, value, host_writers_stopped=True)
        self.docker.controller_state = "running"
        with self.assertRaises(TX.STORAGE.StorageError):
            TX.read_no_backup_handoff(self.journal, self.root, self.docker)
        self.docker.controller_state = "exited"
        record["backupFingerprint"] = "0" * 64
        TX.save(record)
        with self.assertRaises(TX.TransactionError):
            TX.read_no_backup_handoff(self.journal, self.root, self.docker)

    def test_review_is_read_only_and_covers_core_and_apps_without_secret_values(self):
        value = self.review()
        self.assertEqual(len(value["roles"]), 7)
        self.assertEqual(set(value["roles"].values()), {"controller", "proxy", "database", "queue", "app"})
        self.assertFalse(self.journal.exists())
        self.assertEqual(self.docker.calls, [])
        self.assertNotIn("private-value-not-for-output", json.dumps(value))

    def test_managed_core_labels_remain_in_backup_and_recover_as_core_services(self):
        for item in self.docker.services.values():
            item["labels"]["runtipi.managed"] = "true"
        before = copy.deepcopy(self.docker.apps)
        sentinel = self.root / "app-data/app-0/existing.bin"
        sentinel.write_bytes(b"preserved existing application data\x00")
        record = self.quiesce()
        roles = record["review"]["roles"]
        self.assertEqual(roles[identifier("runtipi-db")], "database")
        self.assertEqual(roles[identifier("runtipi-queue")], "queue")
        self.assertEqual(roles[identifier("runtipi-reverse-proxy")], "proxy")
        self.assertEqual(len(record["review"]["storage"]["containerStates"]), 7)
        self.recover()
        self.assertEqual(self.states(), self.original)
        self.assertEqual(self.docker.apps, before)
        self.assertEqual(sentinel.read_bytes(), b"preserved existing application data\x00")

    def test_requires_healthy_original_and_all_required_services(self):
        self.docker.controller_health = "unhealthy"
        with self.assertRaisesRegex(TX.TransactionError, "healthy"):
            self.review()
        self.docker.controller_health = "healthy"
        del self.docker.services[identifier("runtipi-db")]
        with self.assertRaisesRegex(TX.TransactionError, "Exactly one"):
            self.review()
        self.assertEqual(self.docker.calls, [])

    def test_live_size_estimates_do_not_invalidate_an_unchanged_review(self):
        original = TX.STORAGE.review
        calls = []
        def growing(*args, **kwargs):
            value = original(*args, **kwargs)
            calls.append(kwargs)
            value["estimatedBytes"] += len(calls) * 4096
            value["reviewId"] = TX.APPS.digest({key: item for key, item in value.items() if key != "reviewId"})
            return value
        with mock.patch.object(TX.STORAGE, "review", side_effect=growing):
            self.review()
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call.get("check_capacity", True) for call in calls))
        self.assertEqual(self.docker.calls, [])

    def test_live_size_changes_cannot_hide_storage_identity_changes(self):
        original = TX.STORAGE.review
        calls = 0
        def changed(*args, **kwargs):
            nonlocal calls
            value = original(*args, **kwargs)
            calls += 1
            if calls == 2:
                value["estimatedBytes"] += 4096
                value["resources"][0]["inode"] += 1
            return value
        with mock.patch.object(TX.STORAGE, "review", side_effect=changed), self.assertRaisesRegex(TX.TransactionError, "changed during review"):
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

    def test_source_bootstrap_gate_runs_after_database_queue_and_before_controller_start(self):
        self.quiesce()
        self.docker.calls = []
        def deny():
            self.assertEqual(self.docker.services[identifier('runtipi-db')]['state'], 'running')
            self.assertEqual(self.docker.services[identifier('runtipi-queue')]['state'], 'running')
            self.assertEqual(self.docker.controller_state, 'exited')
            raise ValueError('source bootstrap not proven')
        with self.assertRaisesRegex(ValueError, 'not proven'):
            TX.recover(self.root, self.docker, self.journal, host_writers_stopped=True, before_controller_start=deny)
        self.assertNotIn(['start', self.docker.controller_id], [args for args, _ in self.docker.calls])
        self.assertEqual(self.docker.controller_state, 'exited')
        called = []
        TX.recover(self.root, self.docker, self.journal, host_writers_stopped=True,
                   before_controller_start=lambda: called.append(True))
        self.assertEqual(called, [True])
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
        observed = []
        def progress(phase):
            observed.append((phase, json.loads(self.journal.read_text())["stage"]))
        with mock.patch.object(TX.STORAGE, "capture", side_effect=RuntimeError("disk full")):
            with self.assertRaisesRegex(RuntimeError, "disk full"):
                TX.checkpoint(self.root, self.docker, value, host_writers_stopped=True, progress=progress)
        self.assertEqual(observed, [("stopping", "quiescing"), ("snapshotting", "snapshotting")])
        self.assertEqual(json.loads(self.journal.read_text())["stage"], "snapshotting")
        self.recover()
        self.assertEqual(self.states(), self.original)

    def test_progress_reports_ready_only_after_verified_backup_is_durable(self):
        value = self.review()
        observed = []
        def progress(phase):
            saved = json.loads(self.journal.read_text())
            observed.append((phase, saved['stage']))
            if phase == 'snapshot-ready':
                self.assertIn('backupFingerprint', saved)
                self.assertTrue(all(state != 'running' for state, _ in self.states().values()))
                verified.assert_called_once_with(self.bundle)
        with mock.patch.object(TX.STORAGE, 'capture'), \
                mock.patch.object(TX.STORAGE, 'verified_manifest', return_value={'plan': value['storage'], 'copies': []}) as verified:
            TX.checkpoint(self.root, self.docker, value, host_writers_stopped=True, progress=progress)
        self.assertEqual(observed, [('stopping', 'quiescing'), ('snapshotting', 'snapshotting'), ('snapshot-ready', 'ready')])

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
