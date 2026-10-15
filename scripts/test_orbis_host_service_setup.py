import copy
import importlib.util
import unittest
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()
