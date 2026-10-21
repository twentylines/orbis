import contextlib
import copy
import hashlib
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GUIDE = load("orbis-install")
NEW = load("orbis-install-new")
ENABLE = load("orbis-host-service-enable")
SCOPED_CHECK = ENABLE.require_scoped_cleanup
MANIFEST = {"schema": "orbis.release.v1", "image": "ghcr.io/twentylines/orbis", "tag": "v0.1.0-beta.65", "commit": "a" * 40, "digest": "sha256:" + "b" * 64, "runtipiCompatibility": "4.10.1", "installationProtocol": "orbis.installation-state.v1"}
HEALTHY = {"state": "running", "health": "healthy", "image": MANIFEST["image"] + "@" + MANIFEST["digest"]}


class GuidedTests(unittest.TestCase):
    def test_multiple_controllers_cannot_be_selected_silently(self):
        report = {"installations": [{"installRoot": "/opt/a", "product": "runtipi"}, {"installRoot": "/opt/b", "product": "runtipi"}]}
        with self.assertRaisesRegex(ValueError, "Several"):
            GUIDE.select_installation(report)
        self.assertEqual(GUIDE.select_installation(report, Path("/opt/a")), report["installations"][0])
        with self.assertRaisesRegex(ValueError, "Another controller"):
            GUIDE.select_installation(report, Path("/opt/c"))
        report["installations"][1]["installRoot"] = "/opt/a"
        with self.assertRaisesRegex(ValueError, "Multiple controllers"):
            GUIDE.select_installation(report, Path("/opt/a"))

    def test_review_refresh_ignores_only_derived_size_and_hash_fields(self):
        value = {"reviewId": "old", "mode": "keep", "checkpoint": {"reviewId": "old", "roles": {"core": "controller"}, "storage": {"reviewId": "old", "estimatedBytes": 50, "resources": [{"source": "/opt/data", "inode": 1}]}}}
        original = copy.deepcopy(value)
        changed = copy.deepcopy(value)
        changed["reviewId"] = "new"; changed["checkpoint"]["reviewId"] = "new"
        changed["checkpoint"]["storage"].update(reviewId="new", estimatedBytes=60)
        self.assertEqual(GUIDE.semantic_review(value), GUIDE.semantic_review(changed))
        changed["checkpoint"]["storage"]["resources"][0]["inode"] = 2
        self.assertNotEqual(GUIDE.semantic_review(value), GUIDE.semantic_review(changed))
        self.assertEqual(value, original)

    def test_wrong_recovery_executor_never_runs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            journal = root / "journal.json"
            GUIDE.APPS.write_journal(journal, {"root": str(root), "dockerContext": "test", "stage": "starting"})
            executor = root / "orbis-install-new.py"; executor.write_text("raise RuntimeError('must not execute')")
            GUIDE.APPS.write_journal(root / ".orbis-installation.json", {"schema": "orbis.installer-pointer.v1", "root": str(root), "dockerContext": "test", "kind": "new", "journal": str(journal), "executor": str(executor), "executorSha256": "0" * 64})
            with mock.patch.object(GUIDE, "command") as execute, self.assertRaisesRegex(ValueError, "missing or changed"):
                GUIDE.recover_pending(root, SimpleNamespace(context="test"), root / "state", None)
            execute.assert_not_called()


class NewInstallationTests(unittest.TestCase):
    def test_new_stack_pins_every_image_and_keeps_database_ports_private(self):
        config = NEW.compose(Path("/opt/orbis/server"), HEALTHY["image"], "/run/selected-docker.sock", 18170, 18171)
        services = config["services"]
        self.assertEqual(set(services), NEW.APPS.DETECT.CORE_SERVICES)
        self.assertTrue(all("@sha256:" in service["image"] for service in services.values()))
        self.assertNotIn("ports", services["runtipi-db"])
        self.assertNotIn("ports", services["runtipi-queue"])
        socket = next(m for m in services["runtipi"]["volumes"] if m["target"] == "/var/run/docker.sock")
        self.assertEqual(socket["source"], "/run/selected-docker.sock")
        self.assertTrue(socket["read_only"])
        self.assertEqual(services["runtipi-reverse-proxy"]["ports"], ["18170:80", "18171:443"])

    def test_nonempty_root_and_invalid_ports_fail_before_docker_reads(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / "existing-data").write_bytes(b"keep")
            reader = mock.Mock()
            with self.assertRaisesRegex(ValueError, "empty directory"):
                NEW.require_empty(root, reader, 80, 443)
            self.assertEqual((root / "existing-data").read_bytes(), b"keep")
            reader.containers.assert_not_called()
            (root / "existing-data").unlink()
            for ports in [(80, 80), (0, 443), (80, 65536)]:
                with self.subTest(ports=ports), self.assertRaisesRegex(ValueError, "valid HTTP"):
                    NEW.require_empty(root, reader, *ports)
            reader.containers.assert_not_called()

    def test_server_address_does_not_accept_loopback_or_unspecified_values(self):
        for value in ["127.0.0.1", "::", "0.0.0.0", "224.0.0.1"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                NEW.server_ip(value)
        self.assertEqual(NEW.server_ip("192.168.20.10"), "192.168.20.10")

    def test_resume_after_public_start_preserves_environment_and_app_writes(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary); root = parent / "server"; root.mkdir()
            run = parent / "run"; run.mkdir(); journal = run / "transaction.json"
            files = {"docker-compose.yml": b"{\"services\":{}}", "VERSION": b"4.10.1\n", "orbis-compose.yml": NEW.HOST.STAGE.staged_content(MANIFEST).encode(), ".env": b"initial"}
            for name, data in files.items():
                (root / name).write_bytes(data); (root / name).chmod(0o600)
            (root / ".env").write_bytes(b"server-generated environment retained")
            app = root / "accepted-app-write"; app.write_bytes(b"new application data")
            NEW.APPS.write_journal(root / ".orbis-installation.json", {"root": str(root), "dockerContext": "test", "journal": str(journal)})
            record = {"schema": NEW.SCHEMA, "root": str(root), "dockerContext": "test", "daemon": "selected", "manifest": MANIFEST, "stage": "starting", "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
            with mock.patch.object(NEW.APPS, "digest_daemon", return_value="selected"), mock.patch.object(NEW.HOST.PLAN, "plan", return_value={}), mock.patch.object(NEW.HOST, "current_core", return_value=HEALTHY), mock.patch.object(NEW.HOST, "docker", return_value=subprocess.CompletedProcess([], 0)):
                self.assertEqual(NEW.finish(record, SimpleNamespace(context="test"), journal)["result"], "orbis-installed")
            self.assertEqual((root / ".env").read_bytes(), b"server-generated environment retained")
            self.assertEqual(app.read_bytes(), b"new application data")
            self.assertEqual(json.loads(journal.read_text())["stage"], "complete")


class Interrupted(BaseException):
    pass


class HostEnableTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name).resolve(); self.root = self.parent / "server"; self.root.mkdir()
        for name in ["docker-compose.yml", ".env"]:
            (self.root / name).write_text("unchanged server configuration\n")
        (self.root / "orbis-compose.yml").write_text(ENABLE.HOST.STAGE.staged_content(MANIFEST))
        self.app = self.root / "app-data.bin"; self.app.write_bytes(b"accepted app data")
        stat_method, lstat_method = Path.stat, Path.lstat
        def owned(method, path, *args, **kwargs):
            values = list(method(path, *args, **kwargs)); values[4] = 0; values[5] = 0
            return os.stat_result(values)
        patches = [mock.patch.object(Path, "stat", autospec=True, side_effect=lambda path, *a, **kw: owned(stat_method, path, *a, **kw)), mock.patch.object(Path, "lstat", autospec=True, side_effect=lambda path, *a, **kw: owned(lstat_method, path, *a, **kw)), mock.patch.object(ENABLE.os, "geteuid", return_value=0), mock.patch.object(ENABLE, "available", return_value=False), mock.patch.object(ENABLE, "healthy_existing", return_value=False), mock.patch.object(ENABLE, "existing_owner", return_value=False), mock.patch.object(ENABLE, "source_hashes", return_value={"source": "a" * 64}), mock.patch.object(ENABLE, "require_scoped_cleanup"), mock.patch.object(ENABLE.HOST, "host_lock", side_effect=lambda root: contextlib.nullcontext()), mock.patch.object(ENABLE.HOST.PLAN, "plan", return_value={}), mock.patch.object(ENABLE.HOST, "current_core", return_value=HEALTHY), mock.patch.object(ENABLE.SETUP.SERVICE, "installed_manifest", return_value=MANIFEST)]
        for name, path in [("INSTALL_DIR", self.parent / "installed-helper"), ("ENV_FILE", self.parent / "etc/helper.env"), ("UNIT_FILE", self.parent / "units/helper.service"), ("SOCKET_FILE", self.parent / "run/host.sock")]:
            patches.append(mock.patch.object(ENABLE.SETUP, name, path))
        for patch in patches:
            patch.start(); self.addCleanup(patch.stop)
        before = ENABLE.HOST.installation_fingerprint(self.root, MANIFEST, "test")
        ENABLE.HOST.write_state(self.root, before)

    def test_interrupted_helper_enable_recovers_forward_without_rewinding_app_data(self):
        with mock.patch.object(ENABLE.HOST, "docker", return_value=subprocess.CompletedProcess([], 0)) as docker, mock.patch.object(ENABLE.SETUP, "install_locked", side_effect=Interrupted):
            with self.assertRaises(Interrupted):
                ENABLE.enable(self.root, "test", self.parent)
        journal = ENABLE.journal_path(self.root, "test")
        self.assertEqual(json.loads(journal.read_text())["stage"], "installing-service")
        self.assertEqual(json.loads((self.root / "orbis-host-compose.yml").read_text())["services"]["runtipi"]["volumes"][0]["read_only"], True)
        self.assertEqual(docker.call_args.args[1][-1], "runtipi")
        self.assertIn("--no-deps", docker.call_args.args[1])
        self.app.write_bytes(b"accepted after interruption")
        with mock.patch.object(ENABLE.HOST, "docker", return_value=subprocess.CompletedProcess([], 0)), mock.patch.object(ENABLE.SETUP, "install_locked", return_value={"socket": "/run/orbis/host.sock"}) as setup:
            self.assertEqual(ENABLE.enable(self.root, "test", self.parent)["result"], "host-service-active")
            self.assertTrue(setup.call_args.kwargs["resume"])
        self.assertEqual(self.app.read_bytes(), b"accepted after interruption")
        self.assertEqual(json.loads(journal.read_text())["stage"], "complete")

    def test_legacy_image_is_refused_before_socket_configuration_is_written(self):
        with mock.patch.object(ENABLE, "require_scoped_cleanup", SCOPED_CHECK), mock.patch.object(ENABLE.HOST, "docker", return_value=subprocess.CompletedProcess([], 0, stdout="{}")), self.assertRaisesRegex(ValueError, "external-network protection"):
            ENABLE.enable(self.root, "test", self.parent)
        self.assertFalse((self.root / "orbis-host-compose.yml").exists())
        self.assertFalse(ENABLE.journal_path(self.root, "test").exists())
        self.assertEqual(self.app.read_bytes(), b"accepted app data")

    def test_configuration_drift_after_interruption_refuses_before_another_restart(self):
        with mock.patch.object(ENABLE.HOST, "docker", return_value=subprocess.CompletedProcess([], 0)), mock.patch.object(ENABLE.SETUP, "install_locked", side_effect=Interrupted):
            with self.assertRaises(Interrupted):
                ENABLE.enable(self.root, "test", self.parent)
        (self.root / ".env").write_text("operator changed this configuration")
        with mock.patch.object(ENABLE.HOST, "docker") as docker, self.assertRaisesRegex(ValueError, "configuration changed"):
            ENABLE.enable(self.root, "test", self.parent)
        docker.assert_not_called()
        self.assertEqual(self.app.read_bytes(), b"accepted app data")


if __name__ == "__main__":
    unittest.main()
