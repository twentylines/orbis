import copy
import hashlib
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

from test_orbis_installer_bundle import BOOT, BUILD


SPEC = importlib.util.spec_from_file_location("orbis_host_service_setup", Path(__file__).with_name("orbis-host-service-setup.py"))
assert SPEC and SPEC.loader
SETUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SETUP)


class OrbisHostServiceSetupTests(unittest.TestCase):
    def test_verified_selection_journals_actual_copy_and_refuses_unit_or_environment_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root = base / "server"
            root.mkdir()
            extraction = base / "installer"
            extraction.mkdir(mode=0o700)
            install = base / "opt/host-service"
            environment = base / "etc/host-service.env"
            unit = base / "systemd/orbis-host.service"
            release = {"schema": "orbis.release.v1", "tag": "v1.0.0", "commit": "a" * 40,
                       "image": "ghcr.io/twentylines/orbis", "digest": "sha256:" + "b" * 64,
                       "installationProtocol": "orbis.installation-state.v1", "runtipiCompatibility": "4.10.1"}
            core = json.dumps(release).encode()
            files = {name: b"# verified test source\n" for name in BUILD.REQUIRED}
            files["scripts/install-orbis.py"] = Path(BOOT.__file__).read_bytes()
            assets = BUILD.build(files, core)
            identity = {"tag": release["tag"], "commit": release["commit"],
                        "manifestSha256": BUILD.sha(assets[BUILD.MANIFEST])}
            digest = BOOT.stage_verified_installer(extraction, mode="release", identity=identity, channel="stable",
                release=core, manifest=assets[BUILD.MANIFEST], archive=assets[BUILD.ARCHIVE], files=files)
            launcher = extraction / BOOT.SOURCE_LAUNCHER
            with (launcher.open("rb") as held, mock.patch.object(BOOT, "OWNER", os.geteuid()),
                  mock.patch.object(BOOT, "__file__", f"/proc/self/fd/{held.fileno()}"),
                  mock.patch.object(BOOT, "private_directory", return_value=extraction),
                  mock.patch.object(BOOT, "EXPECTED_RELEASE", identity), mock.patch.object(BOOT, "_exec_guided")):
                BOOT._continue_verified_installer([str(extraction), digest, "stable"])

            stat_method = Path.stat

            def root_owned(path, *args, **kwargs):
                values = list(stat_method(path, *args, **kwargs))
                values[4] = 0
                return os.stat_result(values)

            with (mock.patch.multiple(SETUP, INSTALL_DIR=install, UNIT_FILE=unit, ENV_FILE=environment,
                                      SCRIPTS=("orbis-host-service.py",)),
                  mock.patch.object(SETUP.HOST.AUTHORITY, "OWNER", os.geteuid()),
                  mock.patch.object(SETUP.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as systemd,
                  mock.patch.object(Path, "stat", autospec=True, side_effect=root_owned)):
                source = extraction / "scripts"
                receipt = SETUP._stage_service_files(root, "test", source, source_custody=digest)
                systemd.assert_called_once_with(["/usr/bin/systemd-analyze", "verify", str(unit)],
                                               capture_output=True, check=False)
                copy = extraction / BOOT.SOURCE_COPIES / f"host-copy-{receipt}.json"
                document = json.loads(copy.read_bytes())
                self.assertEqual(receipt, BUILD.sha(copy.read_bytes()))
                self.assertEqual(document["selection"]["selectionSha256"], digest)
                self.assertEqual(document["installed"], {
                    "inventory": {"orbis-host-service.py": BUILD.sha((install / "orbis-host-service.py").read_bytes())},
                    "unitSha256": BUILD.sha(unit.read_bytes()),
                    "environmentSha256": BUILD.sha(environment.read_bytes()),
                })
                self.assertEqual(document["bindings"]["unit"][1], unit.stat().st_ino)
                self.assertEqual(document["bindings"]["environment"][1], environment.stat().st_ino)
                with SETUP.hold_source_selection(source, digest) as selected:
                    expected = SETUP.actual_copy(install, unit)
                    self.assertEqual(SETUP.record_source_copy(root, "test", selected, expected), receipt)
                    original = environment.read_bytes()
                    environment.write_bytes(original + b"# changed\n")
                    with self.assertRaisesRegex(ValueError, "environment differs"):
                        SETUP.record_source_copy(root, "test", selected, expected)
                    environment.write_bytes(original)
                    unit.write_bytes(unit.read_bytes() + b"# changed unit\n")
                    with self.assertRaisesRegex(ValueError, "installed Host copy differs"):
                        SETUP.record_source_copy(root, "test", selected, expected)

    def test_copy_snapshot_keeps_original_descriptors_until_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); code = base / "source.py"; unit = base / "source.service"
            code.write_bytes(b"original source\n"); unit.write_bytes(b"original unit\n")
            with SETUP._SetupSources([code], unit) as inputs:
                descriptors = list(inputs.descriptors)
                with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("reopened input")):
                    self.assertEqual(inputs.body(code), b"original source\n")
                    self.assertEqual(inputs.body(unit), b"original unit\n")
                    inputs.verify()
                self.assertTrue(all(os.fstat(descriptor) for descriptor in descriptors))
            for descriptor in descriptors:
                with self.assertRaises(OSError):
                    os.fstat(descriptor)

    def test_copy_snapshot_rejects_identical_bytes_replacing_an_original_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); code = base / "source.py"; unit = base / "source.service"
            code.write_bytes(b"same source"); unit.write_bytes(b"unit")
            with SETUP._SetupSources([code], unit) as inputs:
                replacement = base / "replacement.py"; replacement.write_bytes(code.read_bytes())
                os.replace(replacement, code)
                with self.assertRaisesRegex(ValueError, "source changed"):
                    inputs.verify()
                self.assertEqual(inputs.body(code), b"same source")

    def test_copy_snapshot_rejects_in_place_changes_with_restored_mtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); code = base / "source.py"; unit = base / "source.service"
            code.write_bytes(b"original"); unit.write_bytes(b"unit")
            with SETUP._SetupSources([code], unit) as inputs:
                details = code.stat()
                code.write_bytes(b"modified")
                os.utime(code, ns=(details.st_atime_ns, details.st_mtime_ns))
                with self.assertRaisesRegex(ValueError, "source changed"):
                    inputs.verify()

    def test_copy_snapshot_rejects_replaced_parent_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); source = base / "input"; source.mkdir()
            code = source / "source.py"; unit = source / "source.service"
            code.write_bytes(b"source"); unit.write_bytes(b"unit")
            with SETUP._SetupSources([code], unit) as inputs:
                source.rename(base / "retained")
                source.mkdir(); code.write_bytes(b"source"); unit.write_bytes(b"unit")
                with self.assertRaisesRegex(ValueError, "source directory changed"):
                    inputs.verify()

    def test_copy_snapshot_refuses_file_and_directory_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); code = base / "source.py"; unit = base / "source.service"
            code.write_bytes(b"source"); unit.write_bytes(b"unit")
            symlink = base / "linked.py"; symlink.symlink_to(code)
            with self.assertRaisesRegex(ValueError, "regular file without links"):
                SETUP._SetupSources([symlink], unit)
            hardlink = base / "hard.py"; os.link(code, hardlink)
            with self.assertRaisesRegex(ValueError, "regular file without links"):
                SETUP._SetupSources([code], unit)
            hardlink.unlink()
            alias = base / "alias"; alias.symlink_to(base, target_is_directory=True)
            with self.assertRaises(OSError):
                SETUP._SetupSources([alias / code.name], unit)

    def test_copy_snapshot_bounds_each_file_and_complete_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); code = base / "source.py"; unit = base / "source.service"
            code.write_bytes(b"x" * (1024 * 1024 + 1)); unit.write_bytes(b"unit")
            with self.assertRaisesRegex(ValueError, "bounded regular file"):
                SETUP._SetupSources([code], unit)
            code.unlink()
            files = [base / f"source-{index}.py" for index in range(9)]
            for file in files:
                file.write_bytes(b"x" * 1024 * 1024)
            with self.assertRaisesRegex(ValueError, "inventory exceeds"):
                SETUP._SetupSources(files, unit)

    def test_failed_snapshot_closes_every_opened_descriptor(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); code = base / "source.py"; unit = base / "source.service"
            code.write_bytes(b"source"); unit.write_bytes(b"unit")
            original = SETUP.os.open; descriptors = []
            def opened(*args, **kwargs):
                descriptor = original(*args, **kwargs); descriptors.append(descriptor)
                return descriptor
            with mock.patch.object(SETUP.os, "open", side_effect=opened), mock.patch.object(SETUP.os, "pread", side_effect=OSError("read interrupted")):
                with self.assertRaisesRegex(OSError, "read interrupted"):
                    SETUP._SetupSources([code], unit)
            self.assertTrue(descriptors)
            for descriptor in descriptors:
                with self.assertRaises(OSError):
                    os.fstat(descriptor)

    def test_journal_binding_covers_actual_snapshot_and_setup_drivers_before_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); source = base / "scripts"; source.mkdir()
            code = source / "source.py"; unit = base / "source.service"
            driver = source / "orbis-host-service-setup.py"; enable = source / "orbis-host-service-enable.py"
            paths = [code, driver, enable, unit]
            for path in paths:
                path.write_bytes(b"reviewed " + path.name.encode())
            hashes = {str(path.relative_to(base)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
            for changed in (code, driver, enable, unit):
                before = changed.read_bytes(); changed.write_bytes(b"changed input")
                with self.subTest(changed=changed.name), mock.patch.object(SETUP, "source_files", return_value=([code], unit)), \
                        mock.patch.object(SETUP, "_stage_source_snapshot") as stage:
                    with self.assertRaisesRegex(ValueError, "reviewed setup journal"):
                        SETUP._stage_service_files(base, "fixture", source, expected_sources=hashes)
                    stage.assert_not_called()
                changed.write_bytes(before)
            with mock.patch.object(SETUP, "source_files", return_value=([code], unit)), mock.patch.object(SETUP, "_stage_source_snapshot") as stage:
                SETUP._stage_service_files(base, "fixture", source, expected_sources=hashes)
                stage.assert_called_once()

    def test_source_replacement_during_staging_never_starts_the_service(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); root = base / "server"; root.mkdir()
            source = base / "scripts"; source.mkdir(); code = source / "source.py"; code.write_bytes(b"reviewed source")
            unit = base / "source.service"; unit.write_bytes(b"reviewed unit")
            install = base / "opt/helper"; environment = base / "etc/helper.env"; target_unit = base / "systemd/orbis-host.service"
            stat_method, lstat_method, replace = Path.stat, Path.lstat, SETUP.os.replace
            def owned(method, path, *args, **kwargs):
                values = list(method(path, *args, **kwargs)); values[4] = 0; values[5] = 0
                return os.stat_result(values)
            def replace_then_change(staged, destination):
                result = replace(staged, destination)
                if Path(destination) == install:
                    code.write_bytes(b"unreviewed source")
                    unit.write_bytes(b"unreviewed unit")
                return result
            with mock.patch.object(SETUP, "INSTALL_DIR", install), mock.patch.object(SETUP, "ENV_FILE", environment), \
                    mock.patch.object(SETUP, "UNIT_FILE", target_unit), mock.patch.object(SETUP, "source_files", return_value=([code], unit)), \
                    mock.patch.object(SETUP, "preflight", return_value={}), mock.patch.object(SETUP, "_start_service") as start, \
                    mock.patch.object(SETUP.os, "replace", side_effect=replace_then_change), \
                    mock.patch.object(Path, "stat", autospec=True, side_effect=lambda path, *a, **kw: owned(stat_method, path, *a, **kw)), \
                    mock.patch.object(Path, "lstat", autospec=True, side_effect=lambda path, *a, **kw: owned(lstat_method, path, *a, **kw)):
                with self.assertRaisesRegex(ValueError, "source changed"):
                    SETUP.install_locked(root, "fixture", source)
                start.assert_not_called()
            self.assertEqual((install / code.name).read_bytes(), b"reviewed source")
            self.assertEqual(target_unit.read_bytes(), b"reviewed unit")

    def test_discovery_is_bundled_with_the_host_helper_without_new_unit_or_dependencies(self):
        files, unit = SETUP.source_files(Path(__file__).parent)
        self.assertIn("orbis-host-discovery.py", [item.name for item in files])
        self.assertIn("orbis-host-core-capture-progress.py", [item.name for item in files])
        self.assertIn("orbis-host-core-capture-restart-retirement.py", [item.name for item in files])
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

    def test_release_runtime_enrollment_follows_healthy_service_verification(self):
        events = []
        ready = {'root': '/srv/orbis', 'dockerContext': 'default'}
        runtime = mock.Mock()
        runtime.install_current_locked.side_effect = lambda *args: events.append('runtime')
        with mock.patch.object(SETUP, 'preflight', return_value=ready), \
                mock.patch.object(SETUP, '_stage_service_files', side_effect=lambda *args, **values: events.append('stage')), \
                mock.patch.object(SETUP, '_start_service', side_effect=lambda: events.append('start')), \
                mock.patch.object(SETUP, '_verify_service', side_effect=lambda *args: events.append('healthy') or ready), \
                mock.patch.object(SETUP, 'load_script', return_value=runtime) as loader:
            self.assertEqual(SETUP.install_locked(Path('/srv/orbis'), 'default', Path('/source')), ready)
        self.assertEqual(events, ['stage', 'start', 'healthy', 'runtime'])
        loader.assert_called_once_with('orbis-host-core-runtime-install.py', 'orbis_core_runtime_setup')
        arguments = runtime.install_current_locked.call_args.args
        self.assertEqual(arguments[:3], (Path('/srv/orbis'), 'default', SETUP.HOST))
        with mock.patch.object(SETUP.SERVICE, 'installed_manifest', return_value=ready) as current:
            self.assertEqual(arguments[3](), ready)
        current.assert_called_once_with(Path('/srv/orbis'), 'default')

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
