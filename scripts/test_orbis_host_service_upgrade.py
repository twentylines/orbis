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

    def test_candidate_scripts_distinguish_python_and_maintenance_javascript(self):
        python = self.base / "helper.py"
        javascript = self.base / "orbis-host-maintenance-responder.mjs"
        python.write_text("value = 1\n")
        javascript.write_text("export const value = 1;\n")
        UPGRADE.validate_candidate_scripts([python, javascript])
        python.write_text("def invalid(\n")
        with self.assertRaisesRegex(ValueError, "invalid Python syntax"):
            UPGRADE.validate_candidate_scripts([python, javascript])
        with self.assertRaisesRegex(ValueError, "unsupported candidate"):
            UPGRADE.validate_candidate_scripts([self.base / "other.mjs"])

    def test_running_or_interrupted_core_job_blocks_helper_upgrade(self):
        with mock.patch.object(UPGRADE, "STATE_DIR", self.base):
            job = self.base / "job.json"
            for state in ("running", "recovering", "interrupted"):
                UPGRADE.SERVICE.write_private(job, {"id": "one", "state": state})
                with self.assertRaisesRegex(ValueError, "resolve"):
                    UPGRADE.job_identity()
            UPGRADE.SERVICE.write_private(job, {"id": "one", "state": "complete"})
            self.assertEqual(UPGRADE.job_identity(), ("one", "complete"))

    def test_unresolved_package_job_blocks_helper_upgrade(self):
        with mock.patch.object(UPGRADE, "STATE_DIR", self.base):
            package_job = self.base / "package-job.json"
            for state in ("queued", "running", "failed", "interrupted"):
                UPGRADE.SERVICE.write_private(package_job, {"id": "one", "state": state})
                with self.assertRaisesRegex(ValueError, "host package transaction"):
                    UPGRADE.job_identity()
            UPGRADE.SERVICE.write_private(package_job, {"id": "one", "state": "complete"})
            self.assertIsNone(UPGRADE.job_identity())

    def test_pending_same_boot_restart_blocks_helper_upgrade(self):
        with mock.patch.object(UPGRADE, "STATE_DIR", self.base), mock.patch.object(UPGRADE.SERVICE, "boot_id", return_value="boot-one"):
            restart = self.base / "restart-job.json"
            UPGRADE.SERVICE.write_private(restart, {"state": "restarting", "bootId": "boot-one"})
            with self.assertRaisesRegex(ValueError, "server restart"):
                UPGRADE.job_identity()
            UPGRADE.SERVICE.write_private(restart, {"state": "restarting", "bootId": "previous-boot"})
            self.assertIsNone(UPGRADE.job_identity())

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

    def test_installed_old_helper_is_not_required_to_have_new_capture_modules(self):
        installed = self.base / 'installed'
        installed.mkdir()
        for name in UPGRADE.LEGACY_SCRIPTS:
            (installed / name).write_text('# installed legacy helper\n')
        root = self.base / 'installation'
        environment = self.base / 'helper.env'
        unit = self.base / 'helper.service'
        unit.write_text((Path(__file__).parent.parent / 'packaging/systemd/orbis-host.service').read_text())
        def systemctl(*args):
            return str(unit) if 'FragmentPath' in args else '' if 'DropInPaths' in args else 'no' if 'NeedDaemonReload' in args else 'active'
        with mock.patch.object(UPGRADE.SETUP, 'INSTALL_DIR', installed), mock.patch.object(UPGRADE.SETUP, 'ENV_FILE', environment), \
                mock.patch.object(UPGRADE.SETUP, 'UNIT_FILE', unit), mock.patch.object(UPGRADE, 'STATE_DIR', self.base), \
                mock.patch.object(UPGRADE, 'require_root_owned') as inspected, mock.patch.object(UPGRADE, 'systemctl_output', side_effect=systemctl):
            environment.write_text(UPGRADE.exact_environment(root, 'legacy'))
            UPGRADE.require_installed(root, 'legacy')
        checked = {call.args[0] for call in inspected.call_args_list}
        self.assertTrue({installed / name for name in UPGRADE.LEGACY_SCRIPTS} <= checked)
        self.assertNotIn(installed / 'orbis-host-core-capture-reader.py', checked)


if __name__ == "__main__":
    unittest.main()
