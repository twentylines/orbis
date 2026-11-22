import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from test_orbis_host_service_upgrade import UPGRADE
from test_orbis_installer_bundle import BOOT, BUILD
from test_orbis_sentinel_install import INSTALL


class HostSourceReviewEntryTests(unittest.TestCase):
    def setUp(self):
        resources = contextlib.ExitStack()
        self.addCleanup(resources.close)
        self.base = Path(resources.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.root = self.base / "server"
        self.root.mkdir()
        self.selection = self.base / "installer"
        self.selection.mkdir(mode=0o700)
        setup = UPGRADE.SETUP
        self.host = self.base / "host"
        self.unit = self.base / "orbis-host.service"
        self.env = self.base / "host.env"
        self.host.mkdir(mode=0o700)
        resources.enter_context(mock.patch.multiple(
            setup, INSTALL_DIR=self.host, UNIT_FILE=self.unit, ENV_FILE=self.env,
            SCRIPTS=("orbis-host-service.py",)))
        resources.enter_context(mock.patch.object(setup.HOST.AUTHORITY, "OWNER", os.geteuid()))
        resources.enter_context(mock.patch.object(UPGRADE, "MAINTENANCE", self.base / "maintenance.json"))
        self.lock = UPGRADE.HOST.AUTHORITY.LAYOUT.legacy_path(self.root, "host-lock")
        self.lock.touch(mode=0o600)
        resources.enter_context(mock.patch.object(UPGRADE.HOST.AUTHORITY.LAYOUT, "lock_paths",
                                                 return_value=[self.lock]))
        resources.enter_context(mock.patch.multiple(
            INSTALL, OWNER=os.geteuid(), require_host=lambda: None,
            INSTALLED_STATE=self.base / "sentinel-state", INSTALLED_ROOT=self.base / "sentinel"))
        load = setup.load_script
        resources.enter_context(mock.patch.object(setup, "load_script", side_effect=lambda name, module:
            INSTALL if name == "orbis-sentinel-install.py" else load(name, module)))
        interpreter = Path(sys.executable).resolve()
        resources.enter_context(mock.patch.object(INSTALL, "_python",
            return_value=(interpreter, INSTALL._seal(interpreter.lstat()))))

        release = {"schema": "orbis.release.v1", "tag": "v1.0.0", "commit": "a" * 40,
                   "image": "ghcr.io/twentylines/orbis", "digest": "sha256:" + "b" * 64,
                   "installationProtocol": "orbis.installation-state.v1", "runtipiCompatibility": "4.10.1"}
        core = json.dumps(release).encode()
        initial = b"# synthetic selected source\n"
        files = {name: initial for name in BUILD.REQUIRED}
        files["scripts/install-orbis.py"] = Path(BOOT.__file__).read_bytes()
        assets = BUILD.build(files, core)
        identity = {"tag": release["tag"], "commit": release["commit"],
                    "manifestSha256": BUILD.sha(assets[BUILD.MANIFEST])}
        self.selection_sha = BOOT.stage_verified_installer(
            self.selection, mode="release", identity=identity, channel="stable",
            release=core, manifest=assets[BUILD.MANIFEST], archive=assets[BUILD.ARCHIVE], files=files)
        launcher = self.selection / BOOT.SOURCE_LAUNCHER
        with (launcher.open("rb") as held, mock.patch.object(BOOT, "OWNER", os.geteuid()),
              mock.patch.object(BOOT, "__file__", f"/proc/self/fd/{held.fileno()}"),
              mock.patch.object(BOOT, "private_directory", return_value=self.selection),
              mock.patch.object(BOOT, "EXPECTED_RELEASE", identity), mock.patch.object(BOOT, "_exec_guided")):
            BOOT._continue_verified_installer([str(self.selection), self.selection_sha, "stable"])
        self.put(self.host / "orbis-host-service.py", initial, 0o600)
        self.put(self.unit, initial, 0o644)
        self.put(self.env, UPGRADE.exact_environment(self.root, "test").encode(), 0o600)
        with setup.hold_source_selection(self.selection / "scripts", self.selection_sha) as selected:
            self.copy_sha = setup.record_source_copy(self.root, "test", selected, setup.actual_copy(self.host, self.unit))
        self.receipt = self.selection / "host-copy-custody" / f"host-copy-{self.copy_sha}.json"
        self.provenance()

    @staticmethod
    def put(path, body, mode):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        path.chmod(mode)

    def provenance(self):
        state = INSTALL.INSTALLED_STATE
        state.mkdir(mode=0o700)
        self.put(state / "activation.lock", b"", 0o600)
        version = "0.1.0-dev.19"
        base = INSTALL.INSTALLED_ROOT / "releases" / version
        files = {}
        names = ("bin/orbis-sentinel", "src/orbis_sentinel/host_source_publication.py",
                 "src/orbis_sentinel/runtime.py", "src/orbis_sentinel/__init__.py")
        for name in names:
            body = f"# fixture {name}\n".encode()
            self.put(base / name, body, 0o755 if name.startswith("bin/") else 0o644)
            files[name] = {"bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}
        manifest = json.dumps({"format": 1, "component": "orbis-sentinel", "version": version,
                               "python": ">=3.10", "files": files}).encode()
        self.put(base / "release.json", manifest, 0o644)
        files["release.json"] = {"bytes": len(manifest), "sha256": hashlib.sha256(manifest).hexdigest()}
        installed = {"schema": "orbis-sentinel.installation.v1", "version": version,
                     "sha256": "a" * 64, "sourceCommit": "b" * 40, "files": files}
        activation = {"schema": "orbis-sentinel.activation.v1", "id": "c" * 32, "phase": "complete",
                      "candidate": installed, "previous": None, "previousUnits": {}}
        for name, value in (("installed.json", installed), ("activation.json", activation),
                            (f"admission-{activation['id']}.json", {**activation, "phase": "prepared"})):
            self.put(state / name, json.dumps(value).encode(), 0o600)
        self.selector = INSTALL.INSTALLED_ROOT / "current"
        self.selector.symlink_to(f"releases/{version}")
        self.launcher = base / "bin/orbis-sentinel"

    def arguments(self, **overrides):
        options = {"docker-context": "test", "confirm-root": str(self.root),
                   "installer-selection": str(self.selection), "installer-selection-sha256": self.selection_sha,
                   "host-copy-sha256": self.copy_sha, **overrides}
        return ["review-host-source", str(self.root), *(item for key, value in options.items()
                                                         for item in (f"--{key}", value))]

    def cli(self, args):
        with (mock.patch.object(sys, "argv", ["orbis-host-service-upgrade.py", *args]),
              contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err):
            code = UPGRADE.main()
        return code, out.getvalue(), err.getvalue()

    def accept(self, args, **options):
        self.assertEqual(args, [str(Path(sys.executable).resolve()), "-I", "-B", str(self.launcher),
                               "--review-host-source", args[5], "--installer-selection", str(self.selection),
                               "--host-copy-sha256", self.copy_sha])
        self.assertEqual(options["stdin"], subprocess.DEVNULL)
        review = {"schema": INSTALL.HOST_SOURCE_PLAN, "operationId": args[5],
                  "planSha256": "f" * 64, "phase": "review-required"}
        return subprocess.CompletedProcess(args, 0, json.dumps(review).encode(), b"")

    def test_cli_reports_exact_review_and_stable_operation(self):
        with mock.patch.object(INSTALL.subprocess, "run", side_effect=self.accept) as run:
            first = self.cli(self.arguments())
            self.assertEqual(first, self.cli(self.arguments()))
        self.assertEqual(first[0], 0)
        expected = {"schema": "orbis.installer.host-source-review.v1", "root": str(self.root), "context": "test",
                    "selectionDirectory": str(self.selection), "selectionSha256": self.selection_sha,
                    "hostCopySha256": self.copy_sha}
        self.assertEqual(json.loads(first[1]), {"schema": INSTALL.HOST_SOURCE_PLAN,
            "operationId": hashlib.sha256(UPGRADE.SETUP._receipt_bytes(expected)).hexdigest(),
            "planSha256": "f" * 64, "phase": "review-required"})
        self.assertEqual(run.call_count, 2)

    def test_ordinary_maintenance_actions_do_not_enter_review(self):
        cases = {"plan": "preflight", "upgrade": "upgrade", "recover": "recover"}
        with mock.patch.object(UPGRADE, "review_host_source") as review:
            for action, name in cases.items():
                with self.subTest(action=action), mock.patch.object(UPGRADE, name, return_value={"ok": True}) as ordinary:
                    self.assertEqual(self.cli([action, str(self.root), "--docker-context", "test"])[0], 0)
                    ordinary.assert_called_once()
            review.assert_not_called()

    def test_refuses_malformed_or_substituted_tuple(self):
        wrong = self.base / "other"
        wrong.mkdir()
        alias = self.base / "alias"
        alias.symlink_to(self.selection, target_is_directory=True)
        with mock.patch.object(INSTALL.subprocess, "run") as run:
            for change in ({"host-copy-sha256": "../bad"}, {"host-copy-sha256": "1" * 64},
                           {"installer-selection-sha256": "2" * 64}, {"docker-context": "other"},
                           {"confirm-root": str(wrong)}, {"installer-selection": str(alias)}):
                with self.subTest(change=change):
                    self.assertEqual(self.cli(self.arguments(**change))[0], 2)
            self.put(self.receipt, self.receipt.read_bytes() + b" ", 0o600)
            self.assertEqual(self.cli(self.arguments())[0], 2)
            run.assert_not_called()

    def test_refuses_pending_maintenance_or_missing_lock_without_creating_it(self):
        with mock.patch.object(INSTALL.subprocess, "run") as run:
            self.put(UPGRADE.MAINTENANCE, b'{"stage":"replaced"}', 0o600)
            self.assertEqual(self.cli(self.arguments())[0], 2)
            retained = UPGRADE.MAINTENANCE.with_suffix(".retained")
            UPGRADE.MAINTENANCE.rename(retained)
            self.lock.rename(self.lock.with_suffix(".retained"))
            self.assertEqual(self.cli(self.arguments())[0], 2)
            self.assertFalse(self.lock.exists())
            self.assertEqual(retained.read_bytes(), b'{"stage":"replaced"}')
            run.assert_not_called()

    def test_refuses_same_bytes_replaced_at_installed_host_path(self):
        helper = self.host / "orbis-host-service.py"
        helper.rename(self.base / "prior-host-source")
        self.put(helper, (self.base / "prior-host-source").read_bytes(), 0o600)
        with mock.patch.object(INSTALL.subprocess, "run") as run:
            self.assertEqual(self.cli(self.arguments())[0], 2)
            run.assert_not_called()

    def test_refuses_missing_or_untrusted_installed_provenance(self):
        with mock.patch.object(INSTALL.subprocess, "run") as run:
            admission = next(INSTALL.INSTALLED_STATE.glob("admission-*.json"))
            admission.rename(admission.with_suffix(".missing"))
            self.assertEqual(self.cli(self.arguments())[0], 2)
            admission.with_suffix(".missing").rename(admission)
            self.launcher.chmod(0o775)
            self.assertEqual(self.cli(self.arguments())[0], 2)
            self.launcher.chmod(0o755)
            self.launcher.write_bytes(b"substituted launcher")
            self.assertEqual(self.cli(self.arguments())[0], 2)
            run.assert_not_called()

    def test_failure_keeps_installed_files_and_custody_exact(self):
        protected = (self.receipt, self.unit, self.env, self.host / "orbis-host-service.py", self.launcher)
        before = [(path.read_bytes(), path.stat().st_ino, path.stat().st_mtime_ns) for path in protected]
        cases = [subprocess.CompletedProcess([], 1, b"", b"private failure"),
                 subprocess.CompletedProcess([], 0, b'{"phase":"complete"}', b""),
                 subprocess.TimeoutExpired([], 60)]
        for response in cases:
            with self.subTest(response=response), mock.patch.object(INSTALL.subprocess, "run", side_effect=[response]):
                code, out, err = self.cli(self.arguments())
                self.assertEqual((code, out), (2, ""))
                self.assertIn("retain", err)
                self.assertNotIn("private failure", err)
        self.assertEqual(before, [(path.read_bytes(), path.stat().st_ino, path.stat().st_mtime_ns) for path in protected])
        self.assertFalse(UPGRADE.MAINTENANCE.exists())
