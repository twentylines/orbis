import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("orbis_host_service_upgrade", Path(__file__).with_name("orbis-host-service-upgrade.py"))
assert SPEC and SPEC.loader
UPGRADE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPGRADE)


class OrbisHostServiceUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def test_running_or_interrupted_core_job_blocks_helper_upgrade(self):
        with mock.patch.object(UPGRADE, "STATE_DIR", self.base):
            job = self.base / "job.json"
            for state in ("running", "recovering", "interrupted"):
                UPGRADE.SERVICE.write_private(job, {"id": "one", "state": state})
                with self.assertRaisesRegex(ValueError, "resolve"):
                    UPGRADE.job_identity()
            UPGRADE.SERVICE.write_private(job, {"id": "one", "state": "complete"})
            self.assertEqual(UPGRADE.job_identity(), ("one", "complete"))

    def test_unit_must_preserve_the_socket_directory_across_restarts(self):
        unit = (Path(__file__).parent.parent / "packaging/systemd/orbis-host.service").read_text()
        UPGRADE.validate_unit(unit)
        with self.assertRaisesRegex(ValueError, "runtime directory"):
            UPGRADE.validate_unit(unit.replace("RuntimeDirectoryPreserve=yes", "RuntimeDirectoryPreserve=no"))

    def test_recovery_record_cannot_point_outside_the_helper_directory(self):
        parent = self.base / "opt"
        parent.mkdir()
        workspace = parent / ".host-service-upgrade-test"
        workspace.mkdir(mode=0o700)
        root = self.base / "install"
        record = {
            "schema": "orbis.helper-upgrade.v1",
            "root": str(root),
            "dockerContext": "test",
            "workspace": str(workspace),
        }
        with mock.patch.object(UPGRADE.SETUP, "INSTALL_DIR", parent / "host-service"):
            with mock.patch.object(UPGRADE, "require_root_owned"):
                self.assertEqual(UPGRADE.workspace_from_record(record, root, "test"), workspace)
                record["workspace"] = str(self.base / "other" / workspace.name)
                with self.assertRaisesRegex(ValueError, "outside"):
                    UPGRADE.workspace_from_record(record, root, "test")
                record["workspace"] = str(workspace)
                with self.assertRaisesRegex(ValueError, "does not match"):
                    UPGRADE.workspace_from_record(record, root, "other")

    def test_legacy_helper_digest_allows_new_optional_package_reader(self):
        self.assertIn("orbis-host-packages.py", UPGRADE.SETUP.SCRIPTS)
        self.assertNotIn("orbis-host-packages.py", UPGRADE.LEGACY_SCRIPTS)
        for name in UPGRADE.LEGACY_SCRIPTS:
            (self.base / name).write_text(name)
        before = UPGRADE.digest_files(self.base)
        (self.base / "orbis-host-packages.py").write_text("new helper")
        self.assertNotEqual(before, UPGRADE.digest_files(self.base))


if __name__ == "__main__":
    unittest.main()
