import contextlib
import copy
import ast
import hashlib
import importlib.util
import io
import json
import os
import pty
import select
import shutil
import subprocess
import sys
import tempfile
import time
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
MANIFEST = {"schema": "orbis.release.v1", "image": "ghcr.io/twentylines/orbis", "tag": "v1.0.1", "commit": "a" * 40, "digest": "sha256:" + "b" * 64, "runtipiCompatibility": "4.10.1", "installationProtocol": "orbis.installation-state.v1"}
NIGHTLY_MANIFEST = {**MANIFEST, "tag": "v1.0.1-beta.1"}
HEALTHY = {"state": "running", "health": "healthy", "image": MANIFEST["image"] + "@" + MANIFEST["digest"]}


class DockerPrerequisiteTests(unittest.TestCase):
    def test_missing_docker_has_official_actionable_help_without_executing_any_command(self):
        reader = mock.Mock()
        with mock.patch.object(GUIDE.shutil, "which", return_value=None), mock.patch.object(GUIDE.subprocess, "run") as execute:
            with self.assertRaisesRegex(ValueError, "Docker was not found") as failure:
                GUIDE.require_docker_prerequisites(reader)
        self.assertIn("https://docs.docker.com/engine/install/debian/", str(failure.exception))
        self.assertIn("https://docs.docker.com/engine/install/ubuntu/", str(failure.exception))
        self.assertIn("never upgraded", str(failure.exception))
        reader._read.assert_not_called(); execute.assert_not_called()

    def test_missing_or_legacy_compose_rejects_without_package_or_service_changes(self):
        for result in (None, "1.29.2", "unknown", ValueError("No plugin")):
            reader = mock.Mock()
            if isinstance(result, Exception): reader._read.side_effect = result
            else: reader._read.return_value = result
            with self.subTest(result=result), mock.patch.object(GUIDE.shutil, "which", return_value="/usr/bin/docker"), mock.patch.object(GUIDE.subprocess, "run") as execute:
                with self.assertRaisesRegex(ValueError, "Docker Compose plugin"):
                    GUIDE.require_docker_prerequisites(reader)
                execute.assert_not_called()
            reader._read.assert_called_once_with(["compose", "version", "--short"])

    def test_existing_docker25_api_and_modern_compose_need_no_prerequisite_mutation(self):
        reader = mock.Mock()
        reader.socket.return_value = "/run/docker.sock"
        for compose in ("v2.35.1", "5.6.1"):
            reader._read.side_effect = [compose, "1.44"]
            with mock.patch.object(GUIDE.shutil, "which", return_value="/usr/bin/docker"), mock.patch.object(Path, "is_socket", return_value=True), mock.patch.object(GUIDE.subprocess, "run") as execute:
                GUIDE.require_docker_prerequisites(reader)
                self.assertEqual(GUIDE.REPLACE.Engine(reader).version, "1.44")
                execute.assert_not_called()
        reader._read.side_effect = ["2.35.1", "1.43"]
        with mock.patch.object(GUIDE.shutil, "which", return_value="/usr/bin/docker"), mock.patch.object(Path, "is_socket", return_value=True), mock.patch.object(GUIDE.subprocess, "run") as execute:
            GUIDE.require_docker_prerequisites(reader)
            with self.assertRaisesRegex(ValueError, "API 1.44"):
                GUIDE.REPLACE.Engine(reader)
            execute.assert_not_called()


class GuidedTests(unittest.TestCase):
    def test_release_channel_acknowledgement_only_prompts_for_nightly_and_yes_does_not_imply_consent(self):
        ask = mock.Mock(return_value="y")
        GUIDE.acknowledge_release_channel(MANIFEST, ask=ask)
        ask.assert_not_called()

        with contextlib.redirect_stdout(io.StringIO()):
            GUIDE.acknowledge_release_channel(NIGHTLY_MANIFEST, accepted=True)
        with contextlib.redirect_stdout(io.StringIO()):
            GUIDE.acknowledge_release_channel(NIGHTLY_MANIFEST, ask=ask)
        self.assertIn("Nightly", ask.call_args.args[0])

        for accepted, answer in ((False, "n"), (False, None)):
            prompt = mock.Mock(return_value=answer) if answer is not None else None
            with self.subTest(accepted=accepted, answer=answer), self.assertRaisesRegex(ValueError, "not approved"):
                GUIDE.acknowledge_release_channel(NIGHTLY_MANIFEST, accepted=accepted, ask=prompt)

    def test_nightly_update_rejects_the_no_host_service_route(self):
        upgrade = SimpleNamespace(SERVICE=SimpleNamespace(
            installed_manifest=mock.Mock(return_value=MANIFEST),
            read_channel=mock.Mock(return_value={"channel": "stable", "revision": "initial"}),
        ))
        display = mock.Mock()
        with mock.patch.object(GUIDE, "load", return_value=upgrade), mock.patch.object(GUIDE.REPLACE.UPDATE, "verify_release") as verify:
            with self.assertRaisesRegex(ValueError, "require the host service"):
                GUIDE.update_existing(Path("/unused"), SimpleNamespace(context="test"), NIGHTLY_MANIFEST, display, without_host_service=True)
        verify.assert_not_called()

    def test_successful_nightly_install_commits_channel_only_after_installer_returns(self):
        for selected_manifest, failed in ((NIGHTLY_MANIFEST, False), (MANIFEST, False), (MANIFEST, True)):
            with tempfile.TemporaryDirectory() as folder:
                parent = Path(folder).resolve()
                root = parent / "server"
                root.mkdir()
                state = parent / "private"
                state.mkdir()
                manifest_file = parent / "manifest.json"
                manifest_file.write_text(json.dumps(selected_manifest))
                argv = ["installer", "--manifest", str(manifest_file), "--state-dir", str(state), "--yes",
                        "--accept-nightly", "--channel", "nightly", "--root", str(root), "--without-host-service", "--host-writers-stopped"]
                install = mock.Mock()
    
                def finish_install(*_args, **_kwargs):
                    self.assertEqual(GUIDE.CHANNELS.read_channel(root)["channel"], "stable")
                    if failed:
                        raise RuntimeError("Controlled install failure")
                    return {"result": "orbis-installed"}
    
                install.side_effect = finish_install
                new = SimpleNamespace(IMAGES={}, choose_ports=lambda *args: (80, 443), install=install)
                enable = SimpleNamespace(require_scoped_cleanup=mock.Mock())
                private = SimpleNamespace(private_directory=lambda _path: state)
                modules = {
                    "orbis-install-new.py": new,
                    "orbis-host-service-enable.py": enable,
                    "install-orbis.py": private,
                }
                display = SimpleNamespace(
                    banner=mock.Mock(), set_remaining_steps=mock.Mock(),
                    step=lambda *_args, **_kwargs: contextlib.nullcontext(),
                )
                report = {"installations": [], "unassignedManagedContainers": []}
                output = io.StringIO()
                with mock.patch.object(sys, "argv", argv), mock.patch.object(GUIDE.sys, "platform", "linux"), \
                     mock.patch.object(GUIDE.os, "geteuid", return_value=0), mock.patch.object(GUIDE, "require_docker_prerequisites"), mock.patch.object(GUIDE.APPS, "Docker"), \
                     mock.patch.object(GUIDE.REPLACE, "Engine"), mock.patch.object(GUIDE.APPS.DETECT, "discover", return_value=report), \
                     mock.patch.object(GUIDE.REPLACE.UPDATE, "verify_release"), mock.patch.object(GUIDE, "load", side_effect=lambda name, _: modules[name]), \
                     mock.patch.object(GUIDE.UI, "Presentation", return_value=display), mock.patch.object(GUIDE.UI, "PullProgress"), \
                     mock.patch.object(GUIDE, "prepare_backup_tools"), mock.patch.object(GUIDE.shutil, "which", return_value="/usr/bin/rsync"), \
                     mock.patch.object(GUIDE.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)), \
                     contextlib.redirect_stdout(output):
                    if failed:
                        with self.assertRaisesRegex(RuntimeError, "Controlled install failure"): GUIDE.main()
                    else:
                        self.assertEqual(GUIDE.main(), 0)
                self.assertEqual(install.call_count, 1)
                self.assertEqual(GUIDE.CHANNELS.read_channel(root)["channel"], "stable" if failed else "nightly")
                completion = f"Orbis {GUIDE.UI.display_release(selected_manifest['tag'])} is installed at {root}."
                self.assertEqual(completion in output.getvalue(), not failed)

    def test_present_backup_tool_does_not_touch_the_package_manager(self):
        with mock.patch.object(GUIDE.shutil, "which", return_value="/usr/bin/rsync"), mock.patch.object(GUIDE.subprocess, "run") as execute:
            GUIDE.prepare_backup_tools(mock.Mock())
            execute.assert_not_called()

    def test_missing_backup_tool_is_installed_without_upgrading_host_packages(self):
        display = mock.Mock()
        display.step.return_value = contextlib.nullcontext()
        for distribution in ("ubuntu", "debian"):
            with self.subTest(distribution=distribution), mock.patch.object(GUIDE.shutil, "which", return_value=None), mock.patch.object(GUIDE.platform, "freedesktop_os_release", return_value={"ID": distribution}), mock.patch.object(Path, "is_file", return_value=True), mock.patch.object(GUIDE.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as execute, mock.patch.object(GUIDE.REPLACE.TX.RESTORE, "runtime") as verify:
                GUIDE.prepare_backup_tools(display)
                commands = [call.args[0] for call in execute.call_args_list]
                self.assertEqual(len(commands), 2)
                self.assertEqual(commands[0][-1], "update")
                self.assertEqual(commands[1][-5:], ["install", "--yes", "--no-install-recommends", "--no-upgrade", "rsync"])
                self.assertTrue(all(command[0] == "/usr/bin/apt-get" and "upgrade" not in command for command in commands))
                self.assertTrue(all(call.kwargs["env"]["DEBIAN_FRONTEND"] == "noninteractive" and call.kwargs["timeout"] == 180 for call in execute.call_args_list))
                verify.assert_called_once()

    def test_unsupported_host_and_failed_package_refresh_stop_before_installation(self):
        display = mock.Mock()
        display.step.return_value = contextlib.nullcontext()
        with mock.patch.object(GUIDE.shutil, "which", return_value=None), mock.patch.object(GUIDE.platform, "freedesktop_os_release", return_value={"ID": "fedora"}), mock.patch.object(GUIDE.subprocess, "run") as execute:
            with self.assertRaisesRegex(ValueError, "required for Orbis update backups"):
                GUIDE.prepare_backup_tools(display)
            execute.assert_not_called()
        with mock.patch.object(GUIDE.shutil, "which", return_value=None), mock.patch.object(GUIDE.platform, "freedesktop_os_release", return_value={"ID": "ubuntu"}), mock.patch.object(Path, "is_file", return_value=True), mock.patch.object(GUIDE.subprocess, "run", return_value=subprocess.CompletedProcess([], 100)) as execute, mock.patch.object(GUIDE.REPLACE.TX.RESTORE, "runtime") as verify:
            with self.assertRaisesRegex(RuntimeError, "Orbis has not been replaced"):
                GUIDE.prepare_backup_tools(display)
            self.assertEqual(execute.call_count, 1)
            verify.assert_not_called()

    def test_inspection_keeps_stdout_json_without_starting_the_terminal_display(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = root / "manifest.json"; manifest.write_text(json.dumps(MANIFEST))
            argv = ["installer", "--manifest", str(manifest), "--state-dir", str(root / "private"), "--inspect"]
            output = io.StringIO()
            report = {"installations": [], "unassignedManagedContainers": []}
            with mock.patch.object(sys, "argv", argv), mock.patch.object(GUIDE.sys, "platform", "linux"), mock.patch.object(GUIDE.os, "geteuid", return_value=0), mock.patch.object(GUIDE, "require_docker_prerequisites"), mock.patch.object(GUIDE.APPS, "Docker"), mock.patch.object(GUIDE.REPLACE, "Engine"), mock.patch.object(GUIDE.APPS.DETECT, "discover", return_value=report), mock.patch.object(GUIDE.UI, "Presentation") as display, contextlib.redirect_stdout(output):
                self.assertEqual(GUIDE.main(), 0)
                self.assertEqual(json.loads(output.getvalue()), report)
                display.assert_not_called()

    def test_unassigned_container_error_precedes_downloads_and_replacement(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            manifest = root / "manifest.json"; manifest.write_text(json.dumps(MANIFEST))
            selected = {"installRoot": str(root), "product": "runtipi", "version": "4.10.1", "reviewRequired": []}
            argv = ["installer", "--manifest", str(manifest), "--state-dir", str(root / "private"), "--yes", "--root", str(root), "--mode", "keep"]
            message = "Unassigned: notes (123456789abc): Compose paths conflict"
            with mock.patch.object(sys, "argv", argv), mock.patch.object(GUIDE.sys, "platform", "linux"), mock.patch.object(GUIDE.os, "geteuid", return_value=0), mock.patch.object(GUIDE, "require_docker_prerequisites"), mock.patch.object(GUIDE.APPS, "Docker"), mock.patch.object(GUIDE.REPLACE, "Engine"), mock.patch.object(GUIDE.APPS.DETECT, "discover", return_value={"installations": [selected]}), mock.patch.object(GUIDE.APPS, "require_assigned", side_effect=ValueError(message)), mock.patch.object(GUIDE.REPLACE.UPDATE, "verify_release") as verify, mock.patch.object(GUIDE.subprocess, "run") as execute:
                with self.assertRaisesRegex(ValueError, "notes.*Compose paths conflict"):
                    GUIDE.main()
                verify.assert_not_called()
                execute.assert_not_called()

    def test_backup_tools_are_ready_before_keep_review_or_new_installation(self):
        for mode in (None, "keep", "fresh"):
            existing = mode is not None
            with self.subTest(existing=existing), tempfile.TemporaryDirectory() as folder:
                root = Path(folder).resolve()
                state = root / "private"; state.mkdir()
                manifest = root / "manifest.json"; manifest.write_text(json.dumps(MANIFEST))
                selected = {"installRoot": str(root), "product": "runtipi", "version": "4.10.1", "reviewRequired": []}
                argv = ["installer", "--manifest", str(manifest), "--state-dir", str(state), "--yes", "--root", str(root), "--without-host-service", "--host-writers-stopped"]
                if existing:
                    argv.extend(["--mode", mode])
                ready = []

                def install(*args, **kwargs):
                    if not existing:
                        args[5](root)
                    self.assertEqual(ready, ["rsync"], "Compatibility review cannot run until the missing backup tool is installed")
                    (root / ".env").write_text("INTERNAL_IP=192.0.2.40\nNGINX_PORT=80\n")
                    return {"result": "orbis-installed"}

                new = SimpleNamespace(IMAGES={}, choose_ports=lambda *args: (80, 443), install=mock.Mock(side_effect=install))
                modules = {"orbis-install-new.py": new, "orbis-host-service-enable.py": SimpleNamespace(require_scoped_cleanup=mock.Mock()), "install-orbis.py": SimpleNamespace(private_directory=lambda path: path)}
                output = io.StringIO()
                with mock.patch.object(sys, "argv", argv), mock.patch.object(GUIDE.sys, "platform", "linux"), mock.patch.object(GUIDE.os, "geteuid", return_value=0), mock.patch.object(GUIDE, "require_docker_prerequisites"), mock.patch.object(GUIDE.APPS, "Docker"), mock.patch.object(GUIDE.REPLACE, "Engine"), mock.patch.object(GUIDE.APPS.DETECT, "discover", return_value={"installations": [selected] if existing else [], "unassignedManagedContainers": []}), mock.patch.object(GUIDE.APPS, "require_assigned"), mock.patch.object(GUIDE.REPLACE.UPDATE, "verify_release"), mock.patch.object(GUIDE.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)), mock.patch.object(GUIDE.shutil, "which", return_value=None), mock.patch.object(GUIDE, "load", side_effect=lambda name, _: modules[name]), mock.patch.object(GUIDE, "prepare_backup_tools", side_effect=lambda _: ready.append("rsync")), mock.patch.object(GUIDE, "replacement", side_effect=install), contextlib.redirect_stdout(output):
                    self.assertEqual(GUIDE.main(), 0)
                self.assertIn("Open Orbis in your browser:\n  http://192.0.2.40\n", output.getvalue())
                self.assertNotIn("http://192.0.2.40:80", output.getvalue())

    def test_real_controlling_terminal_answers_are_independent_of_piped_stdin(self):
        import fcntl
        import termios
        master, slave = pty.openpty()
        script = str(Path(__file__).with_name("orbis-install.py").resolve())
        code = (
            "import importlib.util; "
            f"s=importlib.util.spec_from_file_location('guided_terminal', {script!r}); "
            "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
            "t=m.Terminal(); answer=t.ask('Choose a path: '); "
            "print('TTY-ANSWER:'+answer.strip(),flush=True); t.close()"
        )
        def attach():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        process = None
        try:
            process = subprocess.Popen([sys.executable, "-u", "-c", code], stdin=subprocess.PIPE, stdout=slave, stderr=slave, pass_fds=(slave,), preexec_fn=attach)
            os.close(slave)
            slave = None
            process.stdin.write(b"wrong-pipe-answer\n")
            process.stdin.close()
            output = b""
            answered = False
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output += chunk
                    if not answered and b"Choose a path: " in output:
                        os.write(master, b"/owned/test/path\n")
                        answered = True
            self.assertEqual(process.wait(timeout=2), 0, output.decode(errors="replace"))
            self.assertTrue(answered)
            self.assertIn(b"TTY-ANSWER:/owned/test/path", output)
            self.assertNotIn(b"TTY-ANSWER:wrong-pipe-answer", output)
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            os.close(master)
            if slave is not None:
                os.close(slave)

    def test_orphaned_managed_apps_are_not_treated_as_an_empty_server(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            manifest = root / "manifest.json"; manifest.write_text(json.dumps(MANIFEST))
            argv = ["installer", "--manifest", str(manifest), "--state-dir", str(root / "private"), "--yes", "--root", str(root / "new")]
            report = {"installations": [], "unassignedManagedContainers": [{"container": {"name": "orphan", "id": "a" * 64}, "ownershipReasons": ["No confirmed controller"]}]}
            with mock.patch.object(sys, "argv", argv), mock.patch.object(GUIDE.sys, "platform", "linux"), mock.patch.object(GUIDE.os, "geteuid", return_value=0), mock.patch.object(GUIDE, "require_docker_prerequisites"), mock.patch.object(GUIDE.APPS, "Docker"), mock.patch.object(GUIDE.REPLACE, "Engine"), mock.patch.object(GUIDE.APPS.DETECT, "discover", return_value=report), mock.patch.object(GUIDE.REPLACE.UPDATE, "verify_release") as verify, mock.patch.object(GUIDE.subprocess, "run") as execute:
                with self.assertRaisesRegex(ValueError, "orphan.*aaaaaaaaaaaa.*No confirmed controller"):
                    GUIDE.main()
                verify.assert_not_called()
                execute.assert_not_called()
            self.assertFalse((root / "new").exists())

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

    def test_executor_failures_are_reported_once_without_guessing_storage_churn(self):
        for rolled_back in (False, True):
            with self.subTest(rolled_back=rolled_back), tempfile.TemporaryDirectory() as folder:
                root = Path(folder) / "install"; root.mkdir()
                state = Path(folder) / "private"; state.mkdir(mode=0o700)
                reader = SimpleNamespace(context="default", lock_fd=None)
                review = {"checkpoint": {"storage": {"preservedAppContainers": []}}}
                def execute(arguments, output, errors):
                    errors.write_text(json.dumps({"schema": GUIDE.REPLACE.SCHEMA, "result": "replacement-failed", "message": "A reviewed setting differs: DnsOptions"}))
                    if rolled_back:
                        GUIDE.APPS.write_journal(Path(arguments[arguments.index("--journal") + 1]), {"stage": "rolled-back", "failure": {"message": "Host settings differ: DnsOptions"}})
                    return 2
                output = io.StringIO()
                with mock.patch.object(GUIDE.REPLACE.TX.RESTORE, "runtime"), mock.patch.object(GUIDE.HOST, "host_lock", return_value=contextlib.nullcontext(1)), mock.patch.object(GUIDE.REPLACE, "review", return_value=review), mock.patch.object(GUIDE, "command", side_effect=execute) as command, contextlib.redirect_stdout(output):
                    with self.assertRaisesRegex(ValueError, "DnsOptions") as failure:
                        GUIDE.replacement(root, reader, MANIFEST, state, "keep", lambda _: None)
                self.assertEqual(command.call_count, 1)
                self.assertNotIn("Storage usage changed", output.getvalue())
                self.assertNotIn("Recover with", str(failure.exception))
                self.assertIn("recovered" if rolled_back else "Nothing was replaced", str(failure.exception))

    def test_unstructured_executor_logs_remain_private(self):
        with tempfile.TemporaryDirectory() as folder:
            errors = Path(folder) / "stderr.json"
            for content in ("private fixture value", json.dumps({"schema": "wrong", "message": "private fixture value"}), "x" * 20000):
                errors.write_text(content)
                self.assertEqual(GUIDE.executor_failure(errors), "The replacement executor could not finish")

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
    @unittest.skipUnless(shutil.which("docker"), "Docker Compose is unavailable")
    def test_generated_stack_passes_the_real_release_planner(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            for name in [*NEW.HOST.PLAN.PREFLIGHT.DATA_PATHS, "data/postgres", "traefik/shared"]:
                (root / name).mkdir(parents=True, exist_ok=True)
            (root / ".env").write_text(f"ROOT_FOLDER_HOST='{root}'\nPOSTGRES_PASSWORD=owned-test-password\nRABBITMQ_PASSWORD=owned-test-password\n")
            (root / "VERSION").write_text("4.10.1\n")
            (root / "docker-compose.yml").write_text(json.dumps(NEW.compose(root, HEALTHY["image"], "/run/docker.sock", 18095, 19445)))
            (root / "orbis-compose.yml").write_text(NEW.HOST.STAGE.staged_content(MANIFEST))
            plan = NEW.HOST.PLAN.plan(root, MANIFEST)
            self.assertEqual(plan["result"], "plan-ready")
            self.assertEqual(plan["candidateImage"], HEALTHY["image"])

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

    def test_new_setup_offers_another_port_without_stopping_existing_services(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            reader = mock.Mock()
            reader.containers.return_value = []
            reader._read.return_value = ""
            published = [{"port": 18280, "container": "existing-web", "containerId": "a" * 64}]
            ask = mock.Mock(return_value="18281")
            with mock.patch.object(NEW.APPS.DETECT, "published_ports", side_effect=[published, []]) as ports, mock.patch.object(NEW.socket, "socket"):
                self.assertEqual(NEW.choose_ports(root, reader, 18280, 19443, ask), (18281, 19443))
            self.assertIn("existing-web", ask.call_args.args[0])
            self.assertEqual(ports.call_args_list[0].kwargs["wanted"], {18280, 19443})
            reader.change.assert_not_called()
            self.assertEqual(list(root.iterdir()), [])

    def test_unattended_port_conflicts_give_the_exact_port_flag(self):
        with mock.patch.object(NEW, "require_empty", side_effect=NEW.PortInUseError(19443, "Docker container existing-proxy")):
            with self.assertRaisesRegex(ValueError, "19443.*existing-proxy.*--https-port"):
                NEW.choose_ports(Path("/unused"), mock.Mock(), 18280, 19443)

    def test_port_typing_errors_retry_instead_of_aborting_setup(self):
        for http, https, conflict, valid, expected in [
            (18280, 19443, 18280, "18281", (18281, 19443)),
            (18280, 19443, 19443, "19444", (18280, 19444)),
        ]:
            other = https if conflict == http else http
            ask = mock.Mock(side_effect=["eighty", "０８０", "0", "65536", str(other), valid])
            reader = mock.Mock()
            with self.subTest(conflict=conflict), mock.patch.object(NEW, "require_empty", side_effect=[NEW.PortInUseError(conflict, "existing service"), None]) as preflight, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(NEW.choose_ports(Path("/unused"), reader, http, https, ask), expected)
                self.assertEqual(preflight.call_count, 2)
                self.assertEqual(ask.call_count, 6)
                reader.change.assert_not_called()

    def test_port_selection_cancellation_and_exhaustion_preserve_existing_services(self):
        for answers, reason in [([""], "cancelled"), (["invalid"] * 16, "Too many port attempts")]:
            reader = mock.Mock()
            with self.subTest(reason=reason), mock.patch.object(NEW, "require_empty", side_effect=NEW.PortInUseError(80, "existing proxy")), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaisesRegex(ValueError, reason):
                    NEW.choose_ports(Path("/unused"), reader, 80, 443, mock.Mock(side_effect=answers))
                reader.change.assert_not_called()

    def test_last_allowed_port_answer_is_still_checked(self):
        reader = mock.Mock()
        ask = mock.Mock(side_effect=["invalid"] * 15 + ["18080"])
        with mock.patch.object(NEW, "require_empty", side_effect=[NEW.PortInUseError(80), None]), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(NEW.choose_ports(Path("/unused"), reader, 80, 443, ask), (18080, 443))
        self.assertEqual(ask.call_count, 16)
        reader.change.assert_not_called()

    def test_cancel_and_failed_dependency_pulls_leave_the_installation_directory_untouched(self):
        for failure in ("cancel", "pull-error", "pull-timeout"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                parent = Path(folder); root = parent / "server"; root.mkdir()
                state = parent / "private"; state.mkdir()
                data = parent / "external-app-data"; data.write_bytes(b"existing application data")
                reader = mock.Mock(context="test")
                args = SimpleNamespace(http_port=18080, https_port=18443, server_ip=None)
                confirm = mock.Mock(side_effect=ValueError("Installation cancelled") if failure == "cancel" else None)
                result = subprocess.CompletedProcess([], 1)
                timeout = subprocess.TimeoutExpired("docker pull", 900)
                with mock.patch.object(NEW, "require_empty"), mock.patch.object(NEW, "server_ip", return_value="192.168.20.10"), mock.patch.object(NEW.REPLACE, "Engine", return_value=SimpleNamespace(endpoint="/run/docker.sock")), mock.patch.object(NEW.subprocess, "run", return_value=result, side_effect=timeout if failure == "pull-timeout" else None) as execute, contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises((ValueError, RuntimeError, subprocess.TimeoutExpired)):
                        NEW.install(root, reader, MANIFEST, state, args, confirm)
                    if failure == "cancel":
                        execute.assert_not_called()
                self.assertEqual(list(root.iterdir()), [])
                self.assertEqual(data.read_bytes(), b"existing application data")
                reader.change.assert_not_called()

    @unittest.skipUnless(NEW.socket.has_ipv6, "requires IPv6")
    def test_native_ipv6_only_listener_is_detected_before_installation(self):
        with tempfile.TemporaryDirectory() as temporary, NEW.socket.socket(NEW.socket.AF_INET6, NEW.socket.SOCK_STREAM) as listener:
            listener.setsockopt(NEW.socket.IPPROTO_IPV6, NEW.socket.IPV6_V6ONLY, 1)
            try:
                listener.bind(("::1", 0))
            except OSError:
                self.skipTest("IPv6 loopback is unavailable")
            port = listener.getsockname()[1]
            reader = mock.Mock()
            reader.containers.return_value = []
            reader._read.return_value = ""
            with mock.patch.object(NEW.APPS.DETECT, "published_ports", return_value=[]):
                with self.assertRaisesRegex(NEW.PortInUseError, str(port)):
                    NEW.require_empty(Path(temporary), reader, port, 443 if port != 443 else 444)
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


class CompletionAddressTests(unittest.TestCase):
    def test_default_port_quoted_values_and_custom_ipv4_ipv6_ports(self):
        for content, expected in [
            ('INTERNAL_IP="192.0.2.40"\nexport NGINX_PORT=80 # standard\n', 'http://192.0.2.40'),
            ('INTERNAL_IP=192.0.2.40\n', 'http://192.0.2.40'),
            ('INTERNAL_IP=192.0.2.40\nNGINX_PORT=8080\n', 'http://192.0.2.40:8080'),
            ('INTERNAL_IP=2001:db8::40\nNGINX_PORT=80\n', 'http://[2001:db8::40]'),
            ('INTERNAL_IP=2001:db8::40\nNGINX_PORT=8080\n', 'http://[2001:db8::40]:8080'),
        ]:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as folder:
                root = Path(folder); (root / '.env').write_text(content)
                self.assertEqual(GUIDE.browser_address(root), expected)

    def test_never_evaluates_configuration_or_prints_other_fields(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(GUIDE.subprocess, 'run') as execute:
            root = Path(folder)
            (root / '.env').write_text('UNRELATED=private-test-marker\nINTERNAL_IP=192.0.2.40\nNGINX_PORT=8080\n')
            output = io.StringIO()
            with contextlib.redirect_stdout(output): GUIDE.show_browser_address(root)
            self.assertIn('http://192.0.2.40:8080', output.getvalue())
            self.assertNotIn('private-test-marker', output.getvalue())
            for value in ['$(touch marker)', '0.0.0.0', '127.0.0.1', '::', '224.0.0.1', 'fe80::1%eth0', 'https://user:private-test-marker@example.com']:
                (root / '.env').write_text('INTERNAL_IP=' + value + '\nNGINX_PORT=80\n')
                self.assertIsNone(GUIDE.browser_address(root))
            for value in ['0', '65536', '${OTHER_PORT}', '80 81', 'broken"quote']:
                (root / '.env').write_text('INTERNAL_IP=192.0.2.40\nNGINX_PORT=' + value + '\n')
                self.assertIsNone(GUIDE.browser_address(root))
            execute.assert_not_called()
            self.assertFalse((root / 'marker').exists())

    def test_missing_unsafe_or_oversized_configuration_cannot_turn_success_into_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); config = root / '.env'
            self.assertIsNone(GUIDE.browser_address(root))
            target = root / 'private'; target.write_text('INTERNAL_IP=192.0.2.40\n')
            config.symlink_to(target)
            self.assertIsNone(GUIDE.browser_address(root))
            config.unlink(); os.mkfifo(config)
            self.assertIsNone(GUIDE.browser_address(root))
            config.unlink(); config.write_bytes(b'x' * (1024 * 1024 + 1))
            self.assertIsNone(GUIDE.browser_address(root))
            output = io.StringIO()
            with contextlib.redirect_stdout(output): GUIDE.show_browser_address(root)
            self.assertIn('could not be determined', output.getvalue())
            self.assertNotIn('http://', output.getvalue())

    def test_already_installed_path_shows_address_only_after_success(self):
        for failure in [False, True]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                root = Path(folder).resolve(); manifest = root / 'manifest.json'; manifest.write_text(json.dumps(MANIFEST))
                (root / '.env').write_text('INTERNAL_IP=192.0.2.40\nNGINX_PORT=8080\n')
                selected = {'installRoot': str(root), 'product': 'orbis', 'reviewRequired': []}
                argv = ['installer', '--manifest', str(manifest), '--state-dir', str(root / 'private'), '--yes', '--root', str(root), '--without-host-service']
                output = io.StringIO()
                with mock.patch.object(sys, 'argv', argv), mock.patch.object(GUIDE.sys, 'platform', 'linux'), mock.patch.object(GUIDE.os, 'geteuid', return_value=0), mock.patch.object(GUIDE, 'require_docker_prerequisites'), mock.patch.object(GUIDE.APPS, 'Docker'), mock.patch.object(GUIDE.REPLACE, 'Engine'), mock.patch.object(GUIDE.APPS.DETECT, 'discover', return_value={'installations': [selected]}), mock.patch.object(GUIDE, 'update_existing', side_effect=RuntimeError('Declared failure') if failure else None, return_value={'result': 'up-to-date'}), contextlib.redirect_stdout(output):
                    if failure:
                        with self.assertRaisesRegex(RuntimeError, 'Declared failure'): GUIDE.main()
                    else: self.assertEqual(GUIDE.main(), 0)
                self.assertEqual('http://192.0.2.40:8080' in output.getvalue(), not failure)



class ExplicitChannelTests(unittest.TestCase):
    def test_32_bit_guided_entry_stops_before_manifest_or_docker_inspection(self):
        argv = ["installer", "--manifest", "/nonexistent/manifest.json", "--state-dir", "/nonexistent/state"]
        with mock.patch.object(sys, "argv", argv), mock.patch.object(GUIDE.sys, "platform", "linux"), mock.patch.object(GUIDE.os, "geteuid", return_value=0), mock.patch.object(GUIDE.BOOT.platform, "machine", return_value="aarch64"), mock.patch.object(GUIDE.sys, "maxsize", 2**31 - 1), mock.patch.object(GUIDE, "require_docker_prerequisites"), mock.patch.object(GUIDE.APPS, "Docker") as docker, mock.patch.object(GUIDE, "prepare_backup_tools") as packages:
            with self.assertRaisesRegex(ValueError, "64-bit"):
                GUIDE.main()
            docker.assert_not_called(); packages.assert_not_called()

    def test_selecting_nightly_for_a_stable_artifact_still_requires_nightly_consent(self):
        with self.assertRaisesRegex(ValueError, "Nightly installation was not approved"):
            GUIDE.acknowledge_release_channel(MANIFEST, channel="nightly")
        with contextlib.redirect_stdout(io.StringIO()):
            GUIDE.acknowledge_release_channel(MANIFEST, accepted=True, channel="nightly")

    def test_stable_channel_cannot_install_prerelease_before_any_docker_inspection(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest = Path(folder) / "manifest.json"; manifest.write_text(json.dumps(NIGHTLY_MANIFEST))
            argv = ["installer", "--manifest", str(manifest), "--state-dir", str(Path(folder) / "state"), "--channel", "stable", "--yes"]
            with mock.patch.object(sys, "argv", argv), mock.patch.object(GUIDE.sys, "platform", "linux"), mock.patch.object(GUIDE.os, "geteuid", return_value=0), mock.patch.object(GUIDE, "require_docker_prerequisites"), mock.patch.object(GUIDE.APPS, "Docker") as docker:
                with self.assertRaisesRegex(ValueError, "selected update channel"): GUIDE.main()
                docker.assert_not_called()

    def test_same_tag_different_digest_stops_before_all_installer_mutations(self):
        current = {**MANIFEST, "digest": "sha256:" + "d" * 64}
        channel = {"channel": "stable", "revision": "initial"}
        upgrade = SimpleNamespace(SERVICE=SimpleNamespace(installed_manifest=lambda *_: current, read_channel=lambda *_: channel), upgrade=mock.Mock())
        display = SimpleNamespace(set_remaining_steps=mock.Mock(), step=mock.Mock())
        with mock.patch.object(GUIDE, "load", return_value=upgrade), mock.patch.object(GUIDE.REPLACE.UPDATE, "verify_release") as verify, mock.patch.object(GUIDE, "prepare_backup_tools") as packages, mock.patch.object(GUIDE, "host_request") as request:
            with self.assertRaisesRegex(ValueError, "same release tag"):
                GUIDE.update_existing(Path("/unused"), SimpleNamespace(context="test"), MANIFEST, display)
        verify.assert_not_called(); packages.assert_not_called(); request.assert_not_called(); upgrade.upgrade.assert_not_called(); display.step.assert_not_called()

    def test_stale_helper_capabilities_stop_before_channel_change_or_core_plan(self):
        current = {**MANIFEST, "tag": "v1.0.0", "digest": "sha256:" + "d" * 64}
        channel = {"channel": "stable", "revision": "initial"}
        upgrade = SimpleNamespace(SERVICE=SimpleNamespace(installed_manifest=lambda *_: current, read_channel=lambda *_: channel), SETUP=SimpleNamespace(SOCKET_FILE=Path("/unused/socket")), upgrade=mock.Mock())
        enable = SimpleNamespace(enable=mock.Mock())
        display = SimpleNamespace(set_remaining_steps=lambda _: None, step=lambda *_: contextlib.nullcontext())
        for capabilities in (None, [], ["restart.v1"], "restart.v1 packages.refresh.v1 release-channels.v1"):
            with self.subTest(capabilities=capabilities), mock.patch.object(GUIDE, "load", side_effect=lambda name, _: upgrade if name == "orbis-host-service-upgrade.py" else enable), mock.patch.object(GUIDE.REPLACE.UPDATE, "verify_release"), mock.patch.object(GUIDE, "prepare_backup_tools"), mock.patch.object(GUIDE.shutil, "which", return_value="/usr/bin/rsync"), mock.patch.object(GUIDE, "host_request", return_value={"capabilities": capabilities}) as request:
                with self.assertRaises(GUIDE.HostServiceCompatibilityError) as failure:
                    GUIDE.update_existing(Path("/unused"), SimpleNamespace(context="test"), MANIFEST, display, selected_channel="nightly")
                self.assertEqual(failure.exception.code, "host-service-capabilities-unsupported")
                request.assert_called_once_with(Path("/unused/socket"), "/v1/status")
        source = ast.parse(Path(__file__).with_name("orbis-host-service.py").read_text())
        declared = [{value.value for value in node.elts if isinstance(value, ast.Constant) and isinstance(value.value, str)} for node in ast.walk(source) if isinstance(node, ast.List)]
        required = {"restart.v1", "packages.refresh.v1", "release-channels.v1"}
        self.assertGreaterEqual(sum(required.issubset(values) for values in declared), 2)
        GUIDE.require_helper_capabilities({"capabilities": sorted(required)})

    def test_nightly_policy_keeps_following_nightly_when_latest_artifact_is_stable(self):
        current = {**MANIFEST, "tag": "v1.0.0", "digest": "sha256:" + "d" * 64}
        channel = {"channel": "nightly", "revision": "initial"}
        upgrade = SimpleNamespace(SERVICE=SimpleNamespace(installed_manifest=lambda *_: current, read_channel=lambda *_: channel), SETUP=SimpleNamespace(SOCKET_FILE=Path("/unused/socket")), upgrade=mock.Mock())
        enable = SimpleNamespace(enable=mock.Mock())
        identifier = "a-test-job"
        calls = []
        def request(_socket, path, data=None):
            calls.append((path, data))
            if path == "/v1/plan": return {"planId": identifier, "targetTag": MANIFEST["tag"], "targetDigest": MANIFEST["digest"]}
            if path == "/v1/apply": return {"jobId": identifier}
            if path == "/v1/status" and len(calls) == 1: return {"capabilities": ["restart.v1", "packages.refresh.v1", "release-channels.v1"], "currentDigest": current["digest"], "imageMatches": True, "coreHealth": "healthy", "job": None}
            if path == "/v1/status": return {"capabilities": ["restart.v1", "packages.refresh.v1", "release-channels.v1"], "job": {"id": identifier, "state": "complete"}, "currentDigest": MANIFEST["digest"], "imageMatches": True, "coreHealth": "healthy"}
            raise AssertionError("Unexpected channel mutation")
        display = SimpleNamespace(set_remaining_steps=lambda _: None, step=lambda *_: contextlib.nullcontext())
        with mock.patch.object(GUIDE, "load", side_effect=lambda name, _: upgrade if name == "orbis-host-service-upgrade.py" else enable), mock.patch.object(GUIDE.REPLACE.UPDATE, "verify_release"), mock.patch.object(GUIDE, "prepare_backup_tools"), mock.patch.object(GUIDE.shutil, "which", return_value="/usr/bin/rsync"), mock.patch.object(GUIDE, "host_request", side_effect=request):
            result = GUIDE.update_existing(Path("/unused"), SimpleNamespace(context="test"), MANIFEST, display, selected_channel="nightly")
        self.assertEqual(result["result"], "orbis-updated")
        self.assertEqual(calls[0], ("/v1/status", None))
        self.assertEqual(calls[1], ("/v1/plan", {"tag": MANIFEST["tag"]}))
        self.assertEqual(channel["channel"], "nightly")


if __name__ == "__main__":
    unittest.main()
