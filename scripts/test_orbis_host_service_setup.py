import copy
import importlib.util
import json
import os
import subprocess
import socket
import stat
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SPEC = importlib.util.spec_from_file_location("orbis_host_service_setup", Path(__file__).with_name("orbis-host-service-setup.py"))
assert SPEC and SPEC.loader
SETUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SETUP)


class OrbisHostServiceSetupTests(unittest.TestCase):
    def test_discovery_is_bundled_with_the_host_helper_without_new_unit_or_dependencies(self):
        files, unit = SETUP.source_files(Path(__file__).parent)
        self.assertIn("orbis-host-discovery.py", [item.name for item in files])
        self.assertEqual(unit.name, "orbis-host.service")
        self.assertIn("Environment=PYTHONDONTWRITEBYTECODE=1", unit.read_text().splitlines())

    def test_native_app_driver_and_diagnostic_closure_are_installed(self):
        files, _ = SETUP.source_files(Path(__file__).parent)
        names = {item.name for item in files}
        self.assertTrue({'orbis-host-retained-app-driver.py', 'orbis-host-retained-app-effects.py', 'orbis-host-app-create-intent.py',
                         'orbis-host-app-port-policy.py', 'orbis-host-app-port-observer.py', 'orbis-host-app-inet-diag.py',
                         'orbis-host-time-machine-capabilities.py'} <= names)

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

    def test_standalone_install_keeps_full_preflight_before_staging(self):
        with mock.patch.object(SETUP, "preflight", side_effect=ValueError("missing mounted socket")) as check, mock.patch.object(SETUP, "_stage_service_files") as stage, self.assertRaisesRegex(ValueError, "missing mounted socket"):
            SETUP.install_locked(Path("/srv/orbis"), "default", Path("/source"), resume=True)
        check.assert_called_once_with(Path("/srv/orbis"), "default", Path("/source"), allow_existing=True)
        stage.assert_not_called()

    def test_peer_credentials_reject_another_pid_or_nonroot_listener(self):
        connection = mock.Mock()
        connection.recv.side_effect = [b'HTTP/1.0 200 OK\r\n\r\n{"enrolled": true}', b'']
        for pid, uid in ((51, 0), (52, 1000)):
            with self.subTest(pid=pid, uid=uid), mock.patch.object(SETUP.socket, "SO_PEERCRED", 17, create=True), mock.patch.object(SETUP.socket, "socket", return_value=connection), self.assertRaisesRegex(ValueError, "expected root systemd process"):
                connection.getsockopt.return_value = struct.pack("3i", pid, uid, 0)
                SETUP.read_socket_status(expected_pid=52)
        connection.sendall.assert_not_called()
        with mock.patch.object(SETUP.socket, "SO_PEERCRED", 17, create=True), mock.patch.object(SETUP.socket, "socket", return_value=connection):
            connection.getsockopt.return_value = struct.pack("3i", 52, 0, 0)
            self.assertTrue(SETUP.read_socket_status(expected_pid=52)["enrolled"])

    def test_authentication_binds_status_to_stable_systemd_pid_and_private_socket(self):
        endpoint = SimpleNamespace(st_mode=stat.S_IFSOCK | 0o600, st_uid=0)
        parent = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)
        with mock.patch.object(Path, "lstat", side_effect=[endpoint, parent]), mock.patch.object(SETUP, "_systemd_main_pid", side_effect=[52, 52]), mock.patch.object(SETUP, "read_socket_status", return_value={"enrolled": True}) as read:
            self.assertTrue(SETUP.authenticated_socket_status(Path("/srv/orbis"), "default")["enrolled"])
            read.assert_called_once_with(expected_pid=52)
        with mock.patch.object(Path, "lstat", side_effect=[endpoint, parent]), mock.patch.object(SETUP, "_systemd_main_pid", side_effect=[52, 53]), mock.patch.object(SETUP, "read_socket_status", return_value={}), self.assertRaisesRegex(ValueError, "process changed"):
            SETUP.authenticated_socket_status(Path("/srv/orbis"), "default")
        with mock.patch.object(Path, "lstat", side_effect=[SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0), parent]), mock.patch.object(SETUP, "_systemd_main_pid") as pid, self.assertRaisesRegex(ValueError, "socket is not private"):
            SETUP.authenticated_socket_status(Path("/srv/orbis"), "default")
        pid.assert_not_called()

    def test_systemd_identity_rejects_missing_pid_dropins_or_changed_command(self):
        properties = {"ActiveState": "active", "SubState": "running", "MainPID": "52", "FragmentPath": str(SETUP.UNIT_FILE), "DropInPaths": "", "User": "root", "NeedDaemonReload": "no"}
        root = Path("/srv/orbis")
        command = ["/usr/bin/python3", str(SETUP.INSTALL_DIR / "orbis-host-service.py"), "--root", str(root), "--docker-context", "default", "--socket", str(SETUP.SOCKET_FILE), "--snapshots", "/var/lib/orbis/snapshots", "--state-dir", "/var/lib/orbis/state"]
        for changes in ({"MainPID": "0"}, {"ActiveState": "inactive"}, {"DropInPaths": "/etc/override.conf"}, {"User": "nobody"}, {"FragmentPath": "/other.service"}):
            body = "\n".join(key + "=" + value for key, value in (properties | changes).items())
            with self.subTest(changes=changes), mock.patch.object(SETUP.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=body)), mock.patch.object(Path, "stat", return_value=SimpleNamespace(st_uid=0)), mock.patch.object(Path, "read_bytes", return_value=b"\0".join(part.encode() for part in command) + b"\0"), self.assertRaises(ValueError):
                SETUP._systemd_main_pid(root, "default")
        body = "\n".join(key + "=" + value for key, value in properties.items())
        with mock.patch.object(SETUP.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=body)), mock.patch.object(Path, "stat", return_value=SimpleNamespace(st_uid=0)), mock.patch.object(Path, "read_bytes", return_value=b"changed command"), self.assertRaisesRegex(ValueError, "installed helper"):
            SETUP._systemd_main_pid(root, "default")

    def test_systemd_identity_accepts_only_protected_canonical_observer_drop_in(self):
        root = Path("/srv/orbis")
        command = ["/usr/bin/python3", str(SETUP.INSTALL_DIR / "orbis-host-service.py"), "--root", str(root), "--docker-context", "default", "--socket", str(SETUP.SOCKET_FILE), "--snapshots", "/var/lib/orbis/snapshots", "--state-dir", "/var/lib/orbis/state"]
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "orbis-host.service.d"
            directory.mkdir(mode=0o700)
            drop_in = directory / "sentinel-observer.conf"
            drop_in.write_bytes(SETUP.OBSERVER_DROP_IN_CONTENT)
            properties = {"ActiveState": "active", "SubState": "running", "MainPID": "52", "FragmentPath": str(SETUP.UNIT_FILE), "DropInPaths": str(drop_in), "User": "root", "NeedDaemonReload": "no"}
            def check(changes=None):
                body = "\n".join(key + "=" + value for key, value in (properties | (changes or {})).items())
                with mock.patch.object(SETUP.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=body)), mock.patch.object(SETUP, "OBSERVER_DROP_IN", drop_in), mock.patch.object(SETUP.HOST.AUTHORITY, "OWNER", os.getuid()), mock.patch.object(Path, "stat", autospec=True, side_effect=lambda path, *a, **kw: SimpleNamespace(st_uid=0) if str(path) == "/proc/52" else original_stat(path, *a, **kw)), mock.patch.object(Path, "read_bytes", autospec=True, side_effect=lambda path: b"\0".join(part.encode() for part in command) + b"\0" if str(path) == "/proc/52/cmdline" else original_read(path)):
                    return SETUP._systemd_main_pid(root, "default")
            original_stat, original_read = Path.stat, Path.read_bytes
            self.assertEqual(check(), 52)
            for changes in ({"DropInPaths": str(drop_in) + " /etc/other.conf"}, {"NeedDaemonReload": "yes"}):
                with self.subTest(changes=changes), self.assertRaises(ValueError):
                    check(changes)
            drop_in.write_bytes(SETUP.OBSERVER_DROP_IN_CONTENT + b"ExecStart=/evil\n")
            with self.assertRaises(ValueError):
                check()
            drop_in.write_bytes(SETUP.OBSERVER_DROP_IN_CONTENT)
            original_fstat = os.fstat
            drop_inode = drop_in.stat().st_ino
            def foreign_owner(fd):
                details = original_fstat(fd)
                if details.st_ino == drop_inode:
                    return SimpleNamespace(st_mode=details.st_mode, st_uid=os.getuid() + 1)
                return details
            with mock.patch.object(SETUP.HOST.AUTHORITY.os, "fstat", side_effect=foreign_owner), self.assertRaises(ValueError):
                check()
            drop_in.chmod(0o666)
            with self.assertRaises(ValueError):
                check()
            drop_in.chmod(0o600)
            directory.chmod(0o777)
            with self.assertRaises(ValueError):
                check()
            directory.chmod(0o700)
            drop_in.unlink()
            drop_in.symlink_to("/etc/passwd")
            with self.assertRaises((ValueError, OSError)):
                check()

    def test_final_verification_requires_both_host_and_container_digest(self):
        digest = "sha256:" + "a" * 64
        healthy = {"enrolled": True, "coreHealth": "healthy", "imageMatches": True, "currentDigest": digest}
        for status, inside_digest in ((healthy | {"currentDigest": "wrong"}, digest), (healthy, "wrong")):
            with self.subTest(status=status, inside_digest=inside_digest), mock.patch.object(SETUP, "authenticated_socket_status", return_value=status), mock.patch.object(SETUP.HOST, "docker", return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps({"currentDigest": inside_digest}))), mock.patch.object(SETUP.time, "monotonic", side_effect=[0, 1, 20]), mock.patch.object(SETUP.time, "sleep"), self.assertRaisesRegex(RuntimeError, "enrolled healthy core"):
                SETUP._verify_service(Path("/srv/orbis"), "default", {"digest": digest})

    def test_resumed_source_environment_and_unit_survive_interruption_and_failure(self):
        class Interrupted(BaseException):
            pass
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); root = base / "server"; root.mkdir()
            source = base / "scripts"; source.mkdir(); code = source / "owned.py"; code.write_text("# owned fixture\n")
            unit = base / "source.service"; unit.write_text("[Service]\nExecStart=/usr/bin/true\n")
            install = base / "opt/helper"; environment = base / "etc/helper.env"; target_unit = base / "systemd/orbis-host.service"
            stat_method, lstat_method = Path.stat, Path.lstat
            def owned(method, path, *args, **kwargs):
                values = list(method(path, *args, **kwargs)); values[4] = 0; values[5] = 0
                return os.stat_result(values)
            original_replace = SETUP.os.replace
            def partial_replace(source, destination):
                if Path(destination) == target_unit:
                    raise Interrupted()
                return original_replace(source, destination)
            with mock.patch.object(SETUP, "INSTALL_DIR", install), mock.patch.object(SETUP, "ENV_FILE", environment), mock.patch.object(SETUP, "UNIT_FILE", target_unit), mock.patch.object(SETUP, "source_files", return_value=([code], unit)), mock.patch.object(SETUP.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)), mock.patch.object(Path, "stat", autospec=True, side_effect=lambda path, *a, **kw: owned(stat_method, path, *a, **kw)), mock.patch.object(Path, "lstat", autospec=True, side_effect=lambda path, *a, **kw: owned(lstat_method, path, *a, **kw)):
                with mock.patch.object(SETUP.os, "replace", side_effect=partial_replace), self.assertRaises(Interrupted):
                    SETUP._stage_service_files(root, "fixture", source)
                identities = (install.stat().st_ino, environment.stat().st_ino)
                self.assertTrue(environment.is_file()); self.assertFalse(target_unit.exists())
                SETUP._stage_service_files(root, "fixture", source, resume=True)
                unit_inode = target_unit.stat().st_ino
                with mock.patch.object(SETUP.subprocess, "run", return_value=subprocess.CompletedProcess([], 1)), self.assertRaisesRegex(RuntimeError, "systemd rejected"):
                    SETUP._stage_service_files(root, "fixture", source, resume=True)
                self.assertEqual((install.stat().st_ino, environment.stat().st_ino), identities)
                self.assertEqual(target_unit.stat().st_ino, unit_inode)
                self.assertEqual((install / code.name).read_bytes(), code.read_bytes())
                (install / code.name).write_text("changed source")
                with self.assertRaisesRegex(ValueError, "configuration changed"):
                    SETUP._stage_service_files(root, "fixture", source, resume=True)


if __name__ == "__main__":
    unittest.main()
