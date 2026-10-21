import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("orbis_host_service_setup", Path(__file__).with_name("orbis-host-service-setup.py"))
assert SPEC and SPEC.loader
SETUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SETUP)


class OrbisHostServiceSetupTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "services": {
                "runtipi": {
                    "environment": {"ORBIS_HOST_SOCKET": "/run/orbis/host.sock"},
                    "volumes": [{"type": "bind", "source": "/run/orbis", "target": "/run/orbis", "read_only": True}],
                },
                "runtipi-db": {},
            }
        }

    def test_only_core_may_receive_the_read_only_host_socket(self):
        SETUP.validate_socket_mount(self.config)
        writable = copy.deepcopy(self.config)
        writable["services"]["runtipi"]["volumes"][0]["read_only"] = False
        with self.assertRaisesRegex(ValueError, "read-only"):
            SETUP.validate_socket_mount(writable)
        shared = copy.deepcopy(self.config)
        shared["services"]["runtipi-db"]["volumes"] = [{"type": "bind", "source": "/run/orbis", "target": "/host"}]
        with self.assertRaisesRegex(ValueError, "another service"):
            SETUP.validate_socket_mount(shared)

    def test_rejects_missing_socket_path_and_unsafe_environment_value(self):
        missing = copy.deepcopy(self.config)
        del missing["services"]["runtipi"]["environment"]["ORBIS_HOST_SOCKET"]
        with self.assertRaisesRegex(ValueError, "environment"):
            SETUP.validate_socket_mount(missing)
        self.assertEqual(SETUP.systemd_quote("/srv/my server"), '"/srv/my server"')
        with self.assertRaisesRegex(ValueError, "control"):
            SETUP.systemd_quote("/srv/unsafe\nvalue")

    def test_rejects_an_old_bind_mount_after_a_runtime_directory_was_replaced(self):
        SETUP.validate_running_mount(28, 3566, "28:3566\n")
        with self.assertRaisesRegex(ValueError, "stale host socket mount"):
            SETUP.validate_running_mount(28, 3566, "28:877\n")

    @unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "requires a root-owned Linux filesystem")
    def test_resumes_real_partial_source_and_environment_copy_without_deleting_them(self):
        class Interrupted(BaseException):
            pass
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); root = base / "server"; root.mkdir()
            source = base / "scripts"; source.mkdir(); code = source / "owned.py"; code.write_text("# owned fixture\n")
            unit = base / "source.service"; unit.write_text("[Service]\nExecStart=/usr/bin/true\n")
            install = base / "opt/helper"; environment = base / "etc/helper.env"; target_unit = base / "systemd/orbis-host.service"; target_unit.parent.mkdir()
            digest = "sha256:" + "a" * 64
            ready = {"digest": digest}
            original_copy, original_run = SETUP.shutil.copyfile, SETUP.subprocess.run
            def partial_copy(source, destination, *args, **kwargs):
                if Path(destination) == target_unit:
                    raise Interrupted()
                return original_copy(source, destination, *args, **kwargs)
            def safe_run(arguments, *args, **kwargs):
                if arguments[0] == "/usr/bin/systemctl":
                    return subprocess.CompletedProcess(arguments, 0)
                return original_run(arguments, *args, **kwargs)
            with mock.patch.object(SETUP, "INSTALL_DIR", install), mock.patch.object(SETUP, "ENV_FILE", environment), mock.patch.object(SETUP, "UNIT_FILE", target_unit), mock.patch.object(SETUP, "preflight", return_value=ready), mock.patch.object(SETUP, "source_files", return_value=([code], unit)), mock.patch.object(SETUP, "run_systemctl"), mock.patch.object(SETUP.subprocess, "run", side_effect=safe_run), mock.patch.object(SETUP, "read_socket_status", return_value={"enrolled": True, "coreHealth": "healthy", "imageMatches": True, "currentDigest": digest}), mock.patch.object(SETUP.HOST, "docker", return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps({"currentDigest": digest}))):
                with mock.patch.object(SETUP.shutil, "copyfile", side_effect=partial_copy), self.assertRaises(Interrupted):
                    SETUP.install_locked(root, "fixture", source)
                inode = install.stat().st_ino
                self.assertTrue(environment.is_file()); self.assertFalse(target_unit.exists())
                result = SETUP.install_locked(root, "fixture", source, resume=True)
                self.assertEqual(result["service"], "active")
                self.assertEqual(install.stat().st_ino, inode)
                self.assertEqual((install / code.name).read_bytes(), code.read_bytes())


if __name__ == "__main__":
    unittest.main()
