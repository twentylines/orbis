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
        self.assertIn("local default Docker context", str(failure.exception))
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

    def test_interactive_setup_error_can_retry_through_prepare_and_recheck(self):
        reader = mock.Mock(context="default")
        reader._read.return_value = "2.35.1"
        terminal = mock.Mock()
        terminal.ask.side_effect = ["typo", "yes"]
        with mock.patch.object(GUIDE, "Terminal", return_value=terminal), mock.patch.object(GUIDE.PREREQUISITES, "prepare", side_effect=[GUIDE.PREREQUISITES.PrerequisiteError("recovery journal retained"), None]) as prepare, mock.patch.object(GUIDE.shutil, "which", return_value="/usr/bin/docker"), contextlib.redirect_stderr(io.StringIO()):
            GUIDE.require_docker_prerequisites(reader, state_dir=Path("/private"))
        self.assertEqual(prepare.call_count, 2)
        self.assertEqual(terminal.ask.call_count, 2)
        reader._read.assert_called_once_with(["compose", "version", "--short"])
        terminal.close.assert_called_once()

    def test_engine_failure_is_rechecked_after_retry(self):
        reader = mock.Mock(context="default")
        reader._read.return_value = "2.35.1"
        terminal = mock.Mock()
        terminal.ask.return_value = "y"
        with mock.patch.object(GUIDE, "Terminal", return_value=terminal), mock.patch.object(GUIDE.PREREQUISITES, "prepare") as prepare, mock.patch.object(GUIDE.shutil, "which", return_value="/usr/bin/docker"), mock.patch.object(GUIDE.REPLACE, "Engine", side_effect=[GUIDE.REPLACE.ReplacementError("Engine unavailable"), mock.Mock()]) as engine, contextlib.redirect_stderr(io.StringIO()):
            GUIDE.require_docker_prerequisites(reader, state_dir=Path("/private"), check_engine=True)
        self.assertEqual(prepare.call_count, 2)
        self.assertEqual(engine.call_count, 2)
        terminal.close.assert_called_once()

    def test_setup_consent_reprompts_typing_errors(self):
        reader = mock.Mock(context="default")
        reader._read.return_value = "2.35.1"
        terminal = mock.Mock()
        terminal.ask.side_effect = ["perhaps", "yes"]
        def prepare(*args, ask, **kwargs):
            self.assertEqual(ask("Continue? [y/N]: "), "y")
        with mock.patch.object(GUIDE, "Terminal", return_value=terminal), mock.patch.object(GUIDE.PREREQUISITES, "prepare", side_effect=prepare), mock.patch.object(GUIDE.shutil, "which", return_value="/usr/bin/docker"), contextlib.redirect_stderr(io.StringIO()):
            GUIDE.require_docker_prerequisites(reader, state_dir=Path("/private"))
        self.assertEqual(terminal.ask.call_count, 2)
        terminal.close.assert_called_once()

    def test_retry_does_not_override_cancellation_or_unattended_modes(self):
        for accepted, inspect_only in ((True, False), (False, True)):
            with self.subTest(accepted=accepted, inspect_only=inspect_only), mock.patch.object(GUIDE, "Terminal") as terminal, mock.patch.object(GUIDE.PREREQUISITES, "prepare", side_effect=GUIDE.PREREQUISITES.PrerequisiteError("recovery required")) as prepare:
                with self.assertRaisesRegex(ValueError, "recovery required"):
                    GUIDE.require_docker_prerequisites(mock.Mock(context="default"), state_dir=Path("/private"), accepted=accepted, inspect_only=inspect_only)
                prepare.assert_called_once()
                terminal.assert_not_called()
        terminal = mock.Mock()
        terminal.ask.return_value = "n"
        def cancelled(*args, ask, **kwargs):
            ask("Continue? [y/N]: ")
            raise GUIDE.PREREQUISITES.PrerequisiteError("Required setup was cancelled")
        with mock.patch.object(GUIDE, "Terminal", return_value=terminal), mock.patch.object(GUIDE.PREREQUISITES, "prepare", side_effect=cancelled):
            with self.assertRaisesRegex(ValueError, "cancelled"):
                GUIDE.require_docker_prerequisites(mock.Mock(context="default"), state_dir=Path("/private"))
        terminal.ask.assert_called_once()
        terminal.close.assert_called_once()

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


class GuidedFixture(unittest.TestCase):
    def setUp(self):
        for target, name in ((GUIDE, 'prepare_sentinel'), (GUIDE, 'activate_sentinel'), (GUIDE.SENTINEL, 'require_host')):
            patch = mock.patch.object(target, name)
            patch.start()
            self.addCleanup(patch.stop)


class GuidedTests(GuidedFixture):
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
                enable = SimpleNamespace(require_scoped_cleanup=mock.Mock(), available=mock.Mock(), enable=mock.Mock())
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
                enable.available.assert_called_once()
                if failed:
                    enable.enable.assert_not_called()
                else:
                    self.assertTrue(enable.enable.call_args.kwargs['credentials_only'])
                self.assertEqual(GUIDE.CHANNELS.read_channel(root)["channel"], "stable" if failed else "nightly")
                completion = f"Orbis {GUIDE.UI.display_release(selected_manifest['tag'])} is installed at {root}."
                self.assertEqual(completion in output.getvalue(), not failed)

    def test_backup_tool_gate_rechecks_runtime_without_another_package_transaction(self):
        with mock.patch.object(GUIDE.REPLACE.TX.RESTORE, "runtime") as verify, mock.patch.object(GUIDE.subprocess, "run") as execute:
            GUIDE.prepare_backup_tools(mock.Mock())
        verify.assert_called_once();execute.assert_not_called()

    def test_backup_runtime_failure_is_preserved_without_an_unreviewed_apt_fallback(self):
        with mock.patch.object(GUIDE.REPLACE.TX.RESTORE, "runtime", side_effect=ValueError("unsupported rsync")), mock.patch.object(GUIDE.subprocess, "run") as execute:
            with self.assertRaisesRegex(ValueError, "unsupported rsync"):
                GUIDE.prepare_backup_tools(mock.Mock())
        execute.assert_not_called()

    def test_setup_adapter_prepares_selected_context_before_final_readonly_checks(self):
        reader=mock.Mock(context="default");reader._read.side_effect=["5.6.1","1.56"]
        with mock.patch.object(GUIDE.PREREQUISITES,"prepare") as prepare, mock.patch.object(GUIDE.shutil,"which",return_value="/usr/bin/docker"), mock.patch.object(Path,"is_socket",return_value=True):
            GUIDE.require_docker_prerequisites(reader,state_dir=Path("/private-installer"),accepted=True)
        prepare.assert_called_once_with("default",Path("/private-installer"),accepted=True,ask=None,inspect_only=False)
        self.assertEqual(reader._read.call_count,1)

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
                security = SimpleNamespace(require_scoped_cleanup=mock.Mock(), available=mock.Mock(), enable=mock.Mock())
                modules = {"orbis-install-new.py": new, "orbis-host-service-enable.py": security, "install-orbis.py": SimpleNamespace(private_directory=lambda path: path)}
                output = io.StringIO()
                with mock.patch.object(sys, "argv", argv), mock.patch.object(GUIDE.sys, "platform", "linux"), mock.patch.object(GUIDE.os, "geteuid", return_value=0), mock.patch.object(GUIDE, "require_docker_prerequisites"), mock.patch.object(GUIDE.APPS, "Docker"), mock.patch.object(GUIDE.REPLACE, "Engine"), mock.patch.object(GUIDE.APPS.DETECT, "discover", return_value={"installations": [selected] if existing else [], "unassignedManagedContainers": []}), mock.patch.object(GUIDE.APPS, "require_assigned"), mock.patch.object(GUIDE.REPLACE.UPDATE, "verify_release"), mock.patch.object(GUIDE.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)), mock.patch.object(GUIDE.shutil, "which", return_value=None), mock.patch.object(GUIDE, "load", side_effect=lambda name, _: modules[name]), mock.patch.object(GUIDE, "prepare_backup_tools", side_effect=lambda _: ready.append("rsync")), mock.patch.object(GUIDE, "replacement", side_effect=install), contextlib.redirect_stdout(output):
                    self.assertEqual(GUIDE.main(), 0)
                self.assertIn("Open Orbis in your browser:\n  http://192.0.2.40\n", output.getvalue())
                self.assertNotIn("http://192.0.2.40:80", output.getvalue())
                self.assertTrue(security.enable.call_args.kwargs['credentials_only'])

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

    def test_internal_data_artifacts_require_protected_recovery_instead_of_install_selection(self):
        report = {'installations': [], 'recoveryTargets': [{'root': '/opt/a', 'role': 'candidate'}]}
        with self.assertRaisesRegex(ValueError, 'Protected controller recovery'):
            GUIDE.select_installation(report)
        with self.assertRaisesRegex(ValueError, 'Protected controller recovery'):
            GUIDE.select_installation(report, Path('/opt/a'))
        self.assertIsNone(GUIDE.select_installation(report, Path('/opt/b')))
        report['installations'] = [{'installRoot': '/opt/a', 'product': 'orbis'}]
        with self.assertRaisesRegex(ValueError, 'Protected controller recovery'):
            GUIDE.select_installation(report, Path('/opt/a'))

    def test_non_data_internal_probe_never_becomes_a_numbered_install_choice(self):
        installation = {'installRoot': '/opt/a', 'product': 'orbis'}
        report = {'installations': [installation], 'internalContainers': [{'role': 'probe'}], 'recoveryTargets': []}
        ask = mock.Mock()
        self.assertIs(GUIDE.select_installation(report, ask=ask), installation)
        ask.assert_not_called()

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

    def test_interactive_installation_selection_reprompts_after_invalid_choice(self):
        report = {"installations": [{"installRoot": "/opt/a", "product": "runtipi"}, {"installRoot": "/opt/b", "product": "runtipi"}]}
        ask = mock.Mock(side_effect=["0", "9" * 5000, "bad", "2"])
        self.assertIs(GUIDE.select_installation(report, ask=ask), report["installations"][1])
        self.assertEqual(ask.call_count, 4)




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

    def test_new_stack_mounts_host_cgroup_read_only_without_creating_it(self):
        with mock.patch.object(NEW.Path, "is_dir", return_value=True):
            config = NEW.compose(Path("/opt/orbis/server"), HEALTHY["image"], "/run/selected-docker.sock", 18170, 18171)
        mount = next(m for m in config["services"]["runtipi"]["volumes"] if m["target"] == "/host/sys/fs/cgroup")
        self.assertEqual(mount["source"], "/sys/fs/cgroup")
        self.assertTrue(mount["read_only"])
        self.assertEqual(mount["bind"], {"create_host_path": False})
        with mock.patch.object(NEW.Path, "is_dir", return_value=False):
            unavailable = NEW.compose(Path("/opt/orbis/server"), HEALTHY["image"], "/run/selected-docker.sock", 18170, 18171)
        self.assertFalse(any(m["target"] == "/host/sys/fs/cgroup" for m in unavailable["services"]["runtipi"]["volumes"]))

    def test_new_stack_isolates_database_and_queue_while_preserving_the_dashboard_external_network(self):
        root = Path('/opt/orbis/server')
        config = NEW.compose(root, HEALTHY['image'], '/run/selected-docker.sock', 18170, 18171)
        services, networks = config['services'], config['networks']
        self.assertEqual(services['runtipi']['networks'], ['tipi_main_network', 'tipi_core_network'])
        self.assertEqual(services['runtipi-reverse-proxy']['networks'], ['tipi_main_network'])
        for name in ('runtipi-db', 'runtipi-queue'):
            self.assertEqual(services[name]['networks'], ['tipi_core_network'])
            self.assertNotIn('ports', services[name])
        self.assertTrue(networks['tipi_core_network']['internal'])
        self.assertEqual(networks['tipi_core_network']['name'], NEW.CORE_NETWORK)
        self.assertFalse(networks['tipi_main_network'].get('internal', False))
        self.assertEqual(networks['tipi_core_network']['labels']['io.orbis.root.sha256'], hashlib.sha256(str(root).encode()).hexdigest())

    def test_either_existing_controller_network_blocks_new_install_before_allocating_storage(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            reader = mock.Mock()
            reader.containers.return_value = []
            for name in (NEW.NETWORK, NEW.CORE_NETWORK):
                with self.subTest(name=name):
                    reader._read.return_value = name + '\n'
                    with self.assertRaisesRegex(ValueError, 'network already exists'):
                        NEW.require_empty(root, reader, 18170, 18171)
                    self.assertEqual(list(root.iterdir()), [])

    def test_new_stack_keeps_cli_credentials_in_a_dedicated_persistent_bind(self):
        root = Path('/opt/orbis/server')
        config = NEW.compose(root, HEALTHY['image'], '/run/selected-docker.sock', 18170, 18171)
        selected = next(m for m in config['services']['runtipi']['volumes'] if m['target'] == '/data/.secrets')
        self.assertEqual(selected['source'], str(root / '.secrets'))
        self.assertFalse(selected['read_only'])
        self.assertEqual(selected['bind'], {'create_host_path': False})
        self.assertFalse(any(m.get('source') == selected['source'] for m in config['services']['runtipi-reverse-proxy']['volumes']))

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

    def test_port_selection_cancellation_preserves_existing_services(self):
        reader = mock.Mock()
        with mock.patch.object(NEW, "require_empty", side_effect=NEW.PortInUseError(80, "existing proxy")):
            with self.assertRaisesRegex(ValueError, "cancelled"):
                NEW.choose_ports(Path("/unused"), reader, 80, 443, mock.Mock(return_value=""))
        reader.change.assert_not_called()

    def test_port_selection_keeps_retrying_invalid_answers(self):
        reader = mock.Mock()
        ask = mock.Mock(side_effect=["invalid"] * 20 + ["18080"])
        with mock.patch.object(NEW, "require_empty", side_effect=[NEW.PortInUseError(80), None]), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(NEW.choose_ports(Path("/unused"), reader, 80, 443, ask), (18080, 443))
        self.assertEqual(ask.call_count, 21)
        reader.change.assert_not_called()

    def test_dependency_pull_retry_reuses_pinned_image_and_preserves_logs(self):
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder); root = parent / "server"; root.mkdir()
            state = parent / "private"; state.mkdir()
            reader = mock.Mock(context="test")
            args = SimpleNamespace(http_port=18080, https_port=18443, server_ip=None)
            ask = mock.Mock(side_effect=["typo", "y", "n"])
            outcomes = [subprocess.CompletedProcess([], 1), subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 1)]
            with mock.patch.object(NEW, "require_empty"), mock.patch.object(NEW, "server_ip", return_value="192.168.20.10"), mock.patch.object(NEW.REPLACE, "Engine", return_value=SimpleNamespace(endpoint="/run/docker.sock")), mock.patch.object(NEW.subprocess, "run", side_effect=outcomes) as execute, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaisesRegex(ValueError, "cancelled"):
                    NEW.install(root, reader, MANIFEST, state, args, mock.Mock(), ask=ask)
            self.assertEqual(execute.call_count, 3)
            self.assertEqual(execute.call_args_list[0].args[0], execute.call_args_list[1].args[0])
            self.assertEqual(execute.call_args_list[0].args[0][-1], NEW.IMAGES["postgres"])
            self.assertEqual(len(list(state.glob("new-*/*-pull-*.log"))), 3)
            self.assertEqual(list(root.iterdir()), [])
            reader.change.assert_not_called()

    def test_download_timeout_can_retry_and_unattended_failure_propagates(self):
        action = mock.Mock(side_effect=[subprocess.TimeoutExpired("docker pull", 900), "ok"])
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(GUIDE.UI.retry_download(action, mock.Mock(return_value="y")), "ok")
        self.assertEqual(action.call_count, 2)
        with self.assertRaises(subprocess.TimeoutExpired):
            GUIDE.UI.retry_download(mock.Mock(side_effect=subprocess.TimeoutExpired("docker pull", 900)))

    def test_fresh_install_stages_both_version_files_from_the_same_release(self):
        for base in ("4.10.1", "4.12.0"):
            with self.subTest(base=base), tempfile.TemporaryDirectory() as folder, contextlib.ExitStack() as stack:
                parent = Path(folder)
                root, state = parent / "server", parent / "private"
                state.mkdir()
                manifest = dict(MANIFEST, runtipiCompatibility=base)
                approved = "a" * 64
                args = SimpleNamespace(http_port=18080, https_port=18443, server_ip=None, approved_reset_plan_sha256=approved)
                for target, name, result in [
                    (NEW, "require_empty", None), (NEW, "server_ip", "192.0.2.1"),
                    (NEW.REPLACE, "Engine", SimpleNamespace(endpoint="/run/docker.sock")),
                    (NEW.OWNERSHIP, "installer_storage", {"fixture": True}), (NEW.OWNERSHIP, "verify_installer_storage", None),
                    (NEW.RESET, "review_external_legacy", {}), (NEW.RESET, "review_plan_sha256", approved),
                    (NEW.RESET, "prepare_external_reviewed", {}), (NEW.RESET, "external_directory", parent / "unused" / "reset"),
                    (NEW.OWNERSHIP, "prepare_new", {}), (NEW.APPS, "digest_daemon", "b" * 64),
                    (NEW.HOST, "host_lock", contextlib.nullcontext()), (NEW.PROXY, "declaration", {"mutableIdentity": {"source": str(parent)}}),
                    (NEW.subprocess, "run", subprocess.CompletedProcess([], 0)), (NEW, "pointer", None),
                    (NEW, "finish", {"result": "fixture-prepared"}),
                ]:
                    stack.enter_context(mock.patch.object(target, name, return_value=result))
                stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                reader = mock.Mock(context="test")
                self.assertEqual(NEW.install(root, reader, manifest, state, args, mock.Mock())["result"], "fixture-prepared")
                files = next(state.glob("new-*/files"))
                self.assertEqual((files / "VERSION").read_text(), base + "\n")
                self.assertIn(f"TIPI_VERSION='{base}'", (files / ".env").read_text().splitlines())
                self.assertEqual(json.loads((files.parent / "transaction.json").read_bytes())["manifest"], manifest)

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
            ownership = {"fixture": "root-protected-proxy-ownership"}
            record["proxyHostIdentitySha256"] = hashlib.sha256(NEW.PROXY.P.canonical(ownership)).hexdigest()
            observed = {"mutableIdentity": {"ownershipSha256": record["proxyHostIdentitySha256"]}}
            with mock.patch.object(NEW.APPS, "digest_daemon", return_value="selected"), mock.patch.object(NEW.HOST.PLAN, "plan", return_value={}), mock.patch.object(NEW.HOST, "current_core", return_value=HEALTHY), mock.patch.object(NEW.HOST, "docker", return_value=subprocess.CompletedProcess([], 0)), mock.patch.object(NEW.PROXY, "owned", return_value=ownership), mock.patch.object(NEW.PROXY, "observe_current", return_value=observed) as observe:
                self.assertEqual(NEW.finish(record, SimpleNamespace(context="test"), journal)["result"], "orbis-installed")
                observe.assert_called_once_with(root, "test")
            self.assertEqual((root / ".env").read_bytes(), b"server-generated environment retained")
            self.assertEqual(app.read_bytes(), b"new application data")
            self.assertEqual(json.loads(journal.read_text())["stage"], "complete")


class Interrupted(BaseException):
    pass


class HostEnableTests(unittest.TestCase):
    def setUp(self):
        self.stage_service_files = ENABLE.SETUP._stage_service_files
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name).resolve(); self.root = self.parent / "server"; self.root.mkdir()
        for name in ["docker-compose.yml", ".env"]:
            (self.root / name).write_text("unchanged server configuration\n")
        (self.root / "orbis-compose.yml").write_text(ENABLE.HOST.STAGE.staged_content(MANIFEST))
        self.app = self.root / "app-data.bin"; self.app.write_bytes(b"accepted app data")
        self.events = []
        self.status = {"enrolled": True, "coreHealth": "healthy", "imageMatches": True, "currentDigest": MANIFEST["digest"], "job": None}
        stat_method, lstat_method = Path.stat, Path.lstat
        def owned(method, path, *args, **kwargs):
            values = list(method(path, *args, **kwargs)); values[4] = 0; values[5] = 0
            return os.stat_result(values)
        patches = [mock.patch.object(Path, "stat", autospec=True, side_effect=lambda path, *a, **kw: owned(stat_method, path, *a, **kw)), mock.patch.object(Path, "lstat", autospec=True, side_effect=lambda path, *a, **kw: owned(lstat_method, path, *a, **kw)), mock.patch.object(ENABLE.os, "geteuid", return_value=0), mock.patch.object(ENABLE, "_require_host"), mock.patch.object(ENABLE, "STATE_DIR", self.parent / "state"), mock.patch.object(ENABLE, "available", return_value=False), mock.patch.object(ENABLE, "healthy_existing", return_value=False), mock.patch.object(ENABLE, "existing_owner", return_value=False), mock.patch.object(ENABLE, "source_hashes", return_value={"source": "a" * 64}), mock.patch.object(ENABLE, "require_scoped_cleanup"), mock.patch.object(ENABLE.HOST, "host_lock", side_effect=lambda root: contextlib.nullcontext()), mock.patch.object(ENABLE.HOST.PLAN, "plan", return_value={}), mock.patch.object(ENABLE.HOST, "current_core", return_value=HEALTHY), mock.patch.object(ENABLE.SETUP.SERVICE, "installed_manifest", return_value=MANIFEST), mock.patch.object(ENABLE.SETUP, "_stage_service_files", side_effect=lambda *a, **kw: self.events.append("staged")), mock.patch.object(ENABLE.SETUP, "_start_service", side_effect=lambda: self.events.append("started")), mock.patch.object(ENABLE.SETUP, "authenticated_socket_status", side_effect=lambda *a: self.authenticated()), mock.patch.object(ENABLE.SETUP, "preflight", return_value={"digest": MANIFEST["digest"]}), mock.patch.object(ENABLE.SETUP, "_verify_service", return_value={"socket": "/run/orbis/host.sock"}), mock.patch.object(ENABLE.HOST, "docker", side_effect=self.docker)]
        for name, path in [("INSTALL_DIR", self.parent / "installed-helper"), ("ENV_FILE", self.parent / "etc/helper.env"), ("UNIT_FILE", self.parent / "units/helper.service"), ("SOCKET_FILE", self.parent / "run/host.sock")]:
            patches.append(mock.patch.object(ENABLE.SETUP, name, path))
        for patch in patches:
            patch.start(); self.addCleanup(patch.stop)
        self.before = ENABLE.HOST.installation_fingerprint(self.root, MANIFEST, "test")
        ENABLE.HOST.write_state(self.root, self.before)

    def authenticated(self):
        self.events.append("authenticated")
        return self.status

    def docker(self, context, arguments, root):
        self.events.append("recreated")
        self.assertGreaterEqual(self.events.count("authenticated"), 2)
        self.assertLess(self.events.index("started"), self.events.index("authenticated"))
        self.assertIn("--no-deps", arguments); self.assertIn("--wait", arguments)
        self.assertIn("never", arguments); self.assertEqual(arguments[-1], "runtipi")
        return subprocess.CompletedProcess([], 0)

    def run_enable(self):
        return ENABLE.enable(self.root, "test", self.parent)

    def record(self):
        return json.loads(ENABLE.journal_path(self.root, "test").read_text())

    def interrupt_start(self):
        with mock.patch.object(ENABLE.SETUP, "_start_service", side_effect=Interrupted), self.assertRaises(Interrupted):
            self.run_enable()
        self.assertEqual(self.record()["stage"], "service-starting")
        self.assertFalse((self.root / "orbis-host-compose.yml").exists())
        self.assertEqual(ENABLE.HOST.saved_state(self.root), self.before)
        self.assertNotIn("recreated", self.events)

    def test_listener_is_authenticated_before_override_and_controller_recreation(self):
        original = self.authenticated
        def observe():
            if self.events.count("authenticated") == 0:
                self.assertFalse((self.root / "orbis-host-compose.yml").exists())
            return original()
        with mock.patch.object(self, "authenticated", side_effect=observe):
            self.assertEqual(self.run_enable()["result"], "host-service-active")
        self.assertEqual(self.record()["schema"], "orbis.host-enable.v2")
        self.assertEqual(self.record()["stage"], "complete")
        ENABLE.SETUP.preflight.assert_called_once_with(self.root, "test", self.parent, allow_existing=True)
        self.assertEqual(self.app.read_bytes(), b"accepted app data")

    def test_narrow_enable_binds_role_through_journal_copy_listener_and_final_verification(self):
        self.status.update(serviceRole='credentials-only', credentialProtocol=1, capabilities=[])
        ENABLE.SETUP.authenticated_socket_status.side_effect = lambda *args, **kwargs: self.authenticated()
        result = ENABLE.enable(self.root, 'test', self.parent, credentials_only=True)
        self.assertEqual(result['result'], 'account-security-active')
        self.assertIs(self.record()['credentialsOnly'], True)
        self.assertIs(ENABLE.SETUP._stage_service_files.call_args.kwargs['credentials_only'], True)
        self.assertIs(ENABLE.SETUP._verify_service.call_args.kwargs['credentials_only'], True)
        self.assertTrue(all(call.kwargs == {'credentials_only': True}
                            for call in ENABLE.SETUP.authenticated_socket_status.call_args_list))
        self.assertEqual(self.app.read_bytes(), b'accepted app data')

    def test_interrupted_narrow_setup_cannot_resume_as_full_administration(self):
        with mock.patch.object(ENABLE.SETUP, '_start_service', side_effect=Interrupted), self.assertRaises(Interrupted):
            ENABLE.enable(self.root, 'test', self.parent, credentials_only=True)
        original = ENABLE.journal_path(self.root, 'test').read_bytes()
        count = ENABLE.SETUP._stage_service_files.call_count
        with self.assertRaisesRegex(ValueError, 'original verified installer sources'):
            ENABLE.enable(self.root, 'test', self.parent)
        self.assertEqual(ENABLE.SETUP._stage_service_files.call_count, count)
        self.assertEqual(ENABLE.journal_path(self.root, 'test').read_bytes(), original)
        self.assertEqual(self.app.read_bytes(), b'accepted app data')

    def test_interrupted_helper_enable_recovers_forward_without_rewinding_app_data(self):
        self.interrupt_start()
        self.app.write_bytes(b"accepted after interruption")
        self.run_enable()
        self.assertEqual(self.app.read_bytes(), b"accepted after interruption")
        self.assertEqual(self.record()["stage"], "complete")
        self.assertTrue(ENABLE.SETUP._stage_service_files.call_args.kwargs["resume"])
        self.assertEqual(ENABLE.SETUP._stage_service_files.call_args.kwargs["expected_sources"], self.record()["sources"])

    def test_verified_setup_resume_binds_original_extraction_and_copy_before_start(self):
        extraction = self.parent / "verified"
        source = extraction / "scripts"
        crossed = self.parent / "crossed" / "scripts"
        selection, receipt = "c" * 64, "e" * 64
        start = ENABLE.SETUP._start_service
        with mock.patch.object(ENABLE.SETUP, "hold_source_selection", return_value=contextlib.nullcontext()):
            ENABLE.SETUP._stage_service_files.side_effect = None
            ENABLE.SETUP._stage_service_files.return_value = receipt
            with mock.patch.object(ENABLE.SETUP, "_start_service", side_effect=Interrupted), self.assertRaises(Interrupted):
                ENABLE.enable(self.root, "test", source, source_custody=selection)
            self.assertEqual(self.record()["sourceCustodyDirectory"], str(extraction))
            self.assertEqual(self.record()["sourceCustodySha256"], selection)
            self.assertEqual(self.record()["hostCopyCustodySha256"], receipt)
            with self.assertRaisesRegex(ValueError, "original verified installer sources"):
                ENABLE.enable(self.root, "test", crossed, source_custody=selection)
            ENABLE.SETUP._stage_service_files.return_value = "f" * 64
            with self.assertRaisesRegex(ValueError, "installed Host copy changed"):
                ENABLE.enable(self.root, "test", source, source_custody=selection)
            start.assert_not_called()
            ENABLE.SETUP._stage_service_files.return_value = receipt
            result = ENABLE.enable(self.root, "test", source, source_custody=selection)
            self.assertEqual(result["hostCopyCustodySha256"], receipt)
            self.assertEqual(self.record()["stage"], "complete")

    def _assert_changed_journal_sources_refuse(self, verify_only):
        code = self.parent / "source.py"; unit = self.parent / "source.service"
        driver = self.parent / "orbis-host-service-setup.py"; enable = self.parent / "orbis-host-service-enable.py"
        paths = [code, driver, enable, unit]
        for path in paths:
            path.write_bytes(b"inert reviewed " + path.name.encode())
        hashes = {str(path.relative_to(self.parent.parent)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
        ENABLE.source_hashes.return_value = hashes
        if verify_only:
            with mock.patch.object(ENABLE.SETUP, "_verify_service", side_effect=Interrupted), self.assertRaises(Interrupted):
                self.run_enable()
            self.assertEqual(self.record()["stage"], "verifying")
        starts = self.events.count("started")
        def change_before_pin(*args, **kwargs):
            code.write_bytes(b"different unreviewed source")
            return self.stage_service_files(*args, **kwargs)
        with mock.patch.object(ENABLE.SETUP, "source_files", return_value=([code], unit)), \
                mock.patch.object(ENABLE.SETUP, "_stage_service_files", side_effect=change_before_pin):
            with self.assertRaisesRegex(ValueError, "reviewed setup journal"):
                self.run_enable()
        self.assertEqual(self.events.count("started"), starts)
        self.assertFalse(ENABLE.SETUP.INSTALL_DIR.exists())
        self.assertEqual(self.record()["sources"], hashes)
        self.assertEqual(self.app.read_bytes(), b"accepted app data")

    def test_source_changed_after_journal_check_refuses_before_first_start(self):
        self._assert_changed_journal_sources_refuse(False)

    def test_source_changed_after_journal_check_refuses_verification_only_restart(self):
        self._assert_changed_journal_sources_refuse(True)

    def test_interruption_between_override_and_enrollment_resumes_exact_transition(self):
        with mock.patch.object(ENABLE.HOST, "write_state", side_effect=Interrupted), self.assertRaises(Interrupted):
            self.run_enable()
        self.assertEqual(self.record()["stage"], "attaching")
        self.assertTrue((self.root / "orbis-host-compose.yml").exists())
        self.assertEqual(ENABLE.HOST.saved_state(self.root), self.before)
        self.run_enable()
        self.assertEqual(ENABLE.HOST.saved_state(self.root), self.record()["after"])
        self.assertEqual(self.app.read_bytes(), b"accepted app data")

    def test_healthy_existing_v1_helper_reuses_without_journal_or_unit_migration(self):
        path = ENABLE.journal_path(self.root, "test"); path.parent.mkdir(mode=0o700)
        old = {"schema": "orbis.host-enable.v1", "stage": "complete", "root": str(self.root), "dockerContext": "test", "sources": {"old": "source"}}
        ENABLE.APPS.write_journal(path, old)
        with mock.patch.object(ENABLE, "existing_owner", return_value=True), mock.patch.object(ENABLE, "healthy_existing", return_value=True), mock.patch.object(ENABLE, "source_hashes", side_effect=AssertionError("must not gate healthy older helper reuse")):
            self.assertEqual(self.run_enable()["result"], "host-service-active")
        self.assertEqual(self.record(), old)
        ENABLE.SETUP._start_service.assert_not_called()
        self.assertNotIn("recreated", self.events)

    def test_interrupted_recreation_can_recover_owned_stopped_controller(self):
        with mock.patch.object(ENABLE.HOST, "docker", side_effect=Interrupted), self.assertRaises(Interrupted):
            self.run_enable()
        self.assertEqual(self.record()["stage"], "restarting-controller")
        stopped = {**HEALTHY, "state": "exited", "health": "none"}
        self.status = {**self.status, "coreHealth": "none"}
        def recreate(context, arguments, root):
            ENABLE.HOST.current_core.return_value = HEALTHY
            self.status = {**self.status, "coreHealth": "healthy"}
            return self.docker(context, arguments, root)
        with mock.patch.object(ENABLE.HOST, "current_core", return_value=stopped), mock.patch.object(ENABLE.HOST, "docker", side_effect=recreate):
            self.run_enable()
        self.assertEqual(self.record()["stage"], "complete")
        self.assertEqual(self.app.read_bytes(), b"accepted app data")

    def test_resume_never_recreates_absent_or_foreign_controller(self):
        with mock.patch.object(ENABLE.HOST, "docker", side_effect=Interrupted), self.assertRaises(Interrupted):
            self.run_enable()
        for core in ({"state": "absent"}, {**HEALTHY, "image": "foreign@sha256:unknown"}):
            with self.subTest(core=core), mock.patch.object(ENABLE.HOST, "current_core", return_value=core), mock.patch.object(ENABLE.HOST, "docker") as docker, self.assertRaisesRegex(ValueError, "healthy at its published image"):
                self.run_enable()
            docker.assert_not_called()

    def test_post_transition_enrollment_rewind_is_not_adopted(self):
        with mock.patch.object(ENABLE.HOST, "docker", side_effect=Interrupted), self.assertRaises(Interrupted):
            self.run_enable()
        ENABLE.HOST.write_state(self.root, self.before)
        with mock.patch.object(ENABLE.HOST, "docker") as docker, self.assertRaisesRegex(ValueError, "journal-bound"):
            self.run_enable()
        docker.assert_not_called()
        self.assertEqual(self.app.read_bytes(), b"accepted app data")

    def test_recovery_stage_survives_another_listener_interruption(self):
        with mock.patch.object(ENABLE.HOST, "docker", side_effect=Interrupted), self.assertRaises(Interrupted):
            self.run_enable()
        stopped = {**HEALTHY, "state": "exited", "health": "none"}
        with mock.patch.object(ENABLE.HOST, "current_core", return_value=stopped), mock.patch.object(ENABLE, "_require_listener", side_effect=[None, Interrupted]), self.assertRaises(Interrupted):
            self.run_enable()
        self.assertEqual(self.record()["stage"], "restarting-controller")

    def test_final_healthy_verification_resume_does_not_recreate_again(self):
        with mock.patch.object(ENABLE.SETUP, "_verify_service", side_effect=Interrupted), self.assertRaises(Interrupted):
            self.run_enable()
        count = self.events.count("recreated")
        self.run_enable()
        self.assertEqual(self.events.count("recreated"), count)
        self.assertEqual(self.record()["stage"], "complete")

    def test_legacy_image_is_refused_before_socket_configuration_is_written(self):
        with mock.patch.object(ENABLE, "require_scoped_cleanup", SCOPED_CHECK), mock.patch.object(ENABLE.HOST, "docker", return_value=subprocess.CompletedProcess([], 0, stdout="{}")), self.assertRaisesRegex(ValueError, "external-network protection"):
            self.run_enable()
        self.assertFalse((self.root / "orbis-host-compose.yml").exists())
        self.assertFalse(ENABLE.journal_path(self.root, "test").exists())
        self.assertEqual(self.app.read_bytes(), b"accepted app data")

    def test_configuration_drift_after_interruption_refuses_before_another_restart(self):
        self.interrupt_start()
        (self.root / ".env").write_text("operator changed this configuration")
        with self.assertRaisesRegex(ValueError, "configuration changed"):
            self.run_enable()
        self.assertNotIn("recreated", self.events)
        self.assertEqual(self.app.read_bytes(), b"accepted app data")

    def test_source_drift_and_v1_journal_cannot_resume(self):
        self.interrupt_start()
        with mock.patch.object(ENABLE, "source_hashes", return_value={"source": "b" * 64}), self.assertRaisesRegex(ValueError, "original verified"):
            self.run_enable()
        record = self.record(); record["schema"] = "orbis.host-enable.v1"
        ENABLE.APPS.write_journal(ENABLE.journal_path(self.root, "test"), record)
        with self.assertRaisesRegex(ValueError, "incompatible journals"):
            self.run_enable()
        self.assertNotIn("recreated", self.events)

    def test_enrollment_drift_and_unjournaled_override_cannot_resume(self):
        self.interrupt_start()
        ENABLE.HOST.write_state(self.root, {**self.before, "digest": "sha256:" + "c" * 64})
        with self.assertRaisesRegex(ValueError, "original enrollment changed"):
            self.run_enable()
        ENABLE.HOST.write_state(self.root, self.before)
        (self.root / "orbis-host-compose.yml").write_text(ENABLE.content())
        with self.assertRaisesRegex(ValueError, "original enrollment changed"):
            self.run_enable()
        self.assertNotIn("recreated", self.events)

    def test_changed_override_cannot_resume(self):
        with mock.patch.object(ENABLE.HOST, "write_state", side_effect=Interrupted), self.assertRaises(Interrupted):
            self.run_enable()
        (self.root / "orbis-host-compose.yml").write_text("changed")
        with self.assertRaisesRegex(ValueError, "override changed"):
            self.run_enable()
        self.assertNotIn("recreated", self.events)

    def test_missing_spoofed_or_wrong_digest_listener_never_recreates_controller(self):
        for response in (OSError("absent"), ValueError("spoofed PID"), {**self.status, "currentDigest": "sha256:" + "c" * 64}, {**self.status, "enrolled": False}, {**self.status, "job": {"state": "running"}}):
            with self.subTest(response=response), mock.patch.object(ENABLE.SETUP, "authenticated_socket_status", side_effect=response if isinstance(response, Exception) else None, return_value=response), mock.patch.object(ENABLE.time, "monotonic", side_effect=[0, 20, 20]), self.assertRaises(RuntimeError):
                self.run_enable()
            self.assertNotIn("recreated", self.events)
            self.assertFalse((self.root / "orbis-host-compose.yml").exists())
        self.assertEqual(self.app.read_bytes(), b"accepted app data")

    def test_pending_selector_and_retained_enrollment_fail_before_service_start(self):
        selector = ENABLE.HOST.restore_selector_path(self.root)
        selector.write_text("pending protected recovery")
        with self.assertRaisesRegex(ValueError, "pending host operation"):
            self.run_enable()
        selector.unlink()
        with mock.patch.object(ENABLE.HOST, "retained_state", return_value=True), self.assertRaisesRegex(ValueError, "retained host socket"):
            self.run_enable()
        ENABLE.SETUP._start_service.assert_not_called()
        self.assertEqual(self.app.read_bytes(), b"accepted app data")

    def test_existing_job_fails_before_service_start(self):
        ENABLE.STATE_DIR.mkdir(); (ENABLE.STATE_DIR / "job.json").write_text("existing operation")
        with self.assertRaisesRegex(ValueError, "pending host operation"):
            self.run_enable()
        ENABLE.SETUP._start_service.assert_not_called()

    def test_final_mount_or_digest_failure_preserves_journal_for_diagnosis(self):
        with mock.patch.object(ENABLE.SETUP, "preflight", side_effect=ValueError("stale host socket mount")), self.assertRaisesRegex(ValueError, "stale host socket mount"):
            self.run_enable()
        self.assertEqual(self.record()["stage"], "verifying")
        self.assertEqual(self.app.read_bytes(), b"accepted app data")
        with mock.patch.object(ENABLE.SETUP, "_verify_service", side_effect=RuntimeError("digest mismatch")), self.assertRaisesRegex(RuntimeError, "digest mismatch"):
            self.run_enable()
        self.assertEqual(self.record()["stage"], "verifying")
        self.assertTrue((self.root / "orbis-host-compose.yml").exists())
        self.assertEqual(self.app.read_bytes(), b"accepted app data")


class CompletionAddressTests(GuidedFixture):
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



class ExplicitChannelTests(GuidedFixture):
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
        upgrade = SimpleNamespace(SERVICE=SimpleNamespace(installed_manifest=lambda *_: current, read_channel=lambda *_: channel), SETUP=SimpleNamespace(SOCKET_FILE=Path("/unused/socket"), installed_credentials_only=lambda *_: False), upgrade=mock.Mock())
        enable = SimpleNamespace(enable=mock.Mock())
        display = SimpleNamespace(set_remaining_steps=lambda _: None, step=lambda *_: contextlib.nullcontext())
        for capabilities in (None, [], ["restart.v1"], "restart.v1 packages.refresh.v1 release-channels.v1"):
            with self.subTest(capabilities=capabilities), mock.patch.object(GUIDE, "load", side_effect=lambda name, _: upgrade if name == "orbis-host-service-upgrade.py" else enable), mock.patch.object(GUIDE.REPLACE.UPDATE, "verify_release"), mock.patch.object(GUIDE, "prepare_backup_tools"), mock.patch.object(GUIDE.shutil, "which", return_value="/usr/bin/rsync"), mock.patch.object(GUIDE, "host_request", return_value={"capabilities": capabilities}) as request:
                with self.assertRaises(GUIDE.HostServiceCompatibilityError) as failure:
                    GUIDE.update_existing(Path("/unused"), SimpleNamespace(context="test"), MANIFEST, display, selected_channel="nightly")
                self.assertEqual(failure.exception.code, "host-service-capabilities-unsupported")
                request.assert_called_once_with(Path("/unused/socket"), "/v1/status")
        required = {"restart.v1", "packages.refresh.v1", "release-channels.v1"}
        for enrolled in (False, True):
            service = SimpleNamespace(root=Path("/unused"), context="test", job_file=Path("/unused/job"),
                                      state_matches=lambda _saved: enrolled)
            with mock.patch.object(GUIDE.CHANNELS.HOST, "saved_state", return_value=MANIFEST), mock.patch.object(GUIDE.CHANNELS.HOST, "current_core", return_value=HEALTHY), mock.patch.object(GUIDE.CHANNELS, "read_private", return_value=None), mock.patch.object(GUIDE.CHANNELS.PACKAGES, "smart_tools_supported", return_value=False):
                actual = GUIDE.CHANNELS.HostService.status(service)
            self.assertEqual(actual["enrolled"], enrolled)
            GUIDE.require_helper_capabilities(actual)
        GUIDE.require_helper_capabilities({"capabilities": sorted(required)})

    def test_modern_update_does_not_install_unused_backup_tools(self):
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                target = dict(MANIFEST)
                if legacy:
                    target.pop('installationProtocol')
                current = {**target, 'tag': 'v1.0.0', 'digest': 'sha256:' + 'd' * 64}
                channel = {'channel': 'stable', 'revision': 'initial'}
                upgrade = SimpleNamespace(SERVICE=SimpleNamespace(installed_manifest=lambda *_: current,
                    read_channel=lambda *_: channel), SETUP=SimpleNamespace(SOCKET_FILE=Path('/unused/socket'), installed_credentials_only=lambda *_: False),
                    upgrade=mock.Mock())
                enable = SimpleNamespace(enable=mock.Mock())
                calls, steps = [], []
                def request(_socket, route, data=None):
                    calls.append(route)
                    if route == '/v1/plan':
                        return {'planId': 'fixture', 'targetTag': target['tag'], 'targetDigest': target['digest']}
                    if route == '/v1/apply':
                        return {'jobId': 'fixture'}
                    return {'capabilities': ['restart.v1', 'packages.refresh.v1', 'release-channels.v1'],
                            'job': None if len(calls) == 1 else {'id': 'fixture', 'state': 'complete'},
                            'currentDigest': target['digest'], 'imageMatches': True, 'coreHealth': 'healthy'}
                def step(label):
                    steps.append(label)
                    return contextlib.nullcontext()
                display = SimpleNamespace(set_remaining_steps=mock.Mock(), step=step)
                with mock.patch.object(GUIDE, 'load', side_effect=lambda name, _: upgrade if name == 'orbis-host-service-upgrade.py' else enable), \
                        mock.patch.object(GUIDE.REPLACE.UPDATE, 'verify_release'), \
                        mock.patch.object(GUIDE, 'prepare_backup_tools') as packages, \
                        mock.patch.object(GUIDE.shutil, 'which', return_value=None), \
                        mock.patch.object(GUIDE, 'host_request', side_effect=request):
                    result = GUIDE.update_existing(Path('/unused'), SimpleNamespace(context='test'), target, display)
                self.assertEqual(result['result'], 'orbis-updated')
                self.assertEqual(packages.call_count, int(legacy))
                display.set_remaining_steps.assert_called_once_with(7 if legacy else 6)
                upgrade.upgrade.assert_called_once()
                self.assertEqual(calls, ['/v1/status', '/v1/plan', '/v1/apply', '/v1/status'])
                self.assertIn('Checking the release and update readiness', steps)

    def test_same_base_bridge_installs_custodied_host_before_dispatch(self):
        current = {**MANIFEST, "tag": "v0.9.1", "digest": "sha256:" + "d" * 64}
        channel = {"channel": "stable", "revision": "initial"}
        root = Path("/unused")
        source = Path(GUIDE.__file__).parent
        socket = Path("/unused/socket")
        custody = "a" * 64
        operations = mock.Mock()
        upgrade = SimpleNamespace(SERVICE=SimpleNamespace(installed_manifest=lambda *_: current, read_channel=lambda *_: channel),
            SETUP=SimpleNamespace(SOCKET_FILE=socket, installed_credentials_only=lambda *_: False), upgrade=operations.upgrade)
        enable = SimpleNamespace(enable=operations.enable)
        operations.prepare_sentinel.return_value = mock.sentinel.prepared
        operations.request.side_effect = [
            {"capabilities": ["restart.v1", "packages.refresh.v1", "release-channels.v1", "runtipi-412-update.v1"]},
            {"planId": "bridge", "targetTag": MANIFEST["tag"], "targetDigest": MANIFEST["digest"]},
            {"jobId": "bridge"},
            {"currentDigest": MANIFEST["digest"], "coreHealth": "healthy", "imageMatches": True,
             "job": {"id": "bridge", "state": "complete"}},
        ]
        display = SimpleNamespace(set_remaining_steps=mock.Mock(), step=lambda *_: contextlib.nullcontext())
        with mock.patch.object(GUIDE, "load", side_effect=lambda name, _: upgrade if name == "orbis-host-service-upgrade.py" else enable), \
                mock.patch.object(GUIDE.REPLACE.UPDATE, "verify_release", operations.verify), \
                mock.patch.object(GUIDE, "prepare_sentinel", operations.prepare_sentinel), \
                mock.patch.object(GUIDE, "activate_sentinel", operations.activate), \
                mock.patch.object(GUIDE, "host_request", operations.request):
            result = GUIDE.update_existing(root, SimpleNamespace(context="test"), MANIFEST, display, source_custody=custody)
        self.assertEqual(result, {"result": "orbis-updated", "releaseTag": MANIFEST["tag"], "jobId": "bridge"})
        self.assertEqual(operations.mock_calls, [
            mock.call.verify(MANIFEST),
            mock.call.prepare_sentinel(display, None),
            mock.call.activate(display, mock.sentinel.prepared),
            mock.call.enable(root, "test", source, source_custody=custody),
            mock.call.upgrade(root, "test", source, str(root), source_custody=custody),
            mock.call.request(socket, "/v1/status"),
            mock.call.request(socket, "/v1/plan", {"tag": MANIFEST["tag"]}),
            mock.call.request(socket, "/v1/apply", {"planId": "bridge"}),
            mock.call.request(socket, "/v1/status"),
        ])

    def test_412_installer_requires_the_coordinating_bridge_and_its_backup_receipt(self):
        target = {**MANIFEST, "runtipiCompatibility": "4.12.0"}
        current = {**MANIFEST, "tag": "v1.0.0", "digest": "sha256:" + "d" * 64}
        channel = {"channel": "stable", "revision": "initial"}
        upgrade = SimpleNamespace(SERVICE=SimpleNamespace(installed_manifest=lambda *_: current, read_channel=lambda *_: channel),
            SETUP=SimpleNamespace(SOCKET_FILE=Path("/unused/socket"), installed_credentials_only=lambda *_: False), upgrade=mock.Mock())
        helper = {"enrolled": True, "currentDigest": current["digest"], "imageMatches": True, "coreHealth": "healthy",
                  "capabilities": ["restart.v1", "packages.refresh.v1", "release-channels.v1", "runtipi-412-update.v1"]}
        plan = {"planId": "fixture", "targetTag": target["tag"], "targetDigest": target["digest"], "backupPolicy": "automatic"}
        complete = {**helper, "currentDigest": target["digest"], "coreHealth": "healthy",
                    "job": {"id": plan["planId"], "state": "complete"}}
        display = SimpleNamespace(set_remaining_steps=mock.Mock(), step=lambda *_: contextlib.nullcontext())
        with mock.patch.object(GUIDE, "load", return_value=upgrade), \
                mock.patch.object(GUIDE.REPLACE.UPDATE, "verify_release"), \
                mock.patch.object(GUIDE, "prepare_backup_tools") as packages, \
                mock.patch.object(GUIDE, "prepare_sentinel") as sentinel, mock.patch.object(GUIDE.time, "sleep") as sleep, \
                mock.patch.object(GUIDE, "host_request") as request:
            for failed_status in ({**helper, "capabilities": []}, {**helper, "capabilities": "runtipi-412-update.v1"},
                                  {**helper, "coreHealth": "starting"}, FileNotFoundError()):
                with self.subTest(failed_status=failed_status):
                    request.side_effect = [failed_status]
                    with self.assertRaisesRegex(GUIDE.HostServiceCompatibilityError, "same-base"):
                        GUIDE.update_existing(Path("/unused"), SimpleNamespace(context="test"), target, display)
            packages.assert_not_called()
            request.side_effect = [helper, helper, {**plan, "backupPolicy": "none"}]
            with self.assertRaisesRegex(ValueError, "confirm the required"):
                GUIDE.update_existing(Path("/unused"), SimpleNamespace(context="test"), target, display)
            request.reset_mock()
            request.side_effect = [helper, helper, plan, {"jobId": plan["planId"]}, FileNotFoundError(), complete]
            self.assertEqual(GUIDE.update_existing(Path("/unused"), SimpleNamespace(context="test"), target, display)["result"],
                             "orbis-updated")
            sleep.assert_called_once_with(1)
            self.assertEqual([call.args[1] for call in request.call_args_list].count("/v1/apply"), 1)
        upgrade.upgrade.assert_not_called()
        sentinel.assert_not_called()

    def test_nightly_policy_keeps_following_nightly_when_latest_artifact_is_stable(self):
        current = {**MANIFEST, "tag": "v1.0.0", "digest": "sha256:" + "d" * 64}
        channel = {"channel": "nightly", "revision": "initial"}
        upgrade = SimpleNamespace(SERVICE=SimpleNamespace(installed_manifest=lambda *_: current, read_channel=lambda *_: channel), SETUP=SimpleNamespace(SOCKET_FILE=Path("/unused/socket"), installed_credentials_only=lambda *_: False), upgrade=mock.Mock())
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

    def test_launcher_channel_selection_reprompts_after_invalid_choice(self):
        catalog = {"schema": "orbis.installer-channels.v1", "channels": {"stable": {"tag": "v1.2.3", "commit": "a" * 40, "launcherSha256": "b" * 64}, "nightly": {"tag": "v1.2.4-beta.1", "commit": "c" * 40, "launcherSha256": "d" * 64}}}
        ask = mock.Mock(side_effect=["0", "stable"])
        self.assertEqual(GUIDE.BOOT.select_channel(catalog, ask=ask), ("stable", catalog["channels"]["stable"], True))
        self.assertEqual(ask.call_count, 2)


    def test_interactive_unavailable_channel_reprompts_but_explicit_channel_fails(self):
        catalog = {"schema": "orbis.installer-channels.v1", "channels": {"stable": None, "nightly": {"tag": "v1.2.4-beta.1", "commit": "c" * 40, "launcherSha256": "d" * 64}}}
        ask = mock.Mock(side_effect=["1", "2"])
        self.assertEqual(GUIDE.BOOT.select_channel(catalog, ask=ask), ("nightly", catalog["channels"]["nightly"], True))
        self.assertEqual(ask.call_count, 2)
        with self.assertRaisesRegex(ValueError, "Stable is not available yet"):
            GUIDE.BOOT.select_channel(catalog, requested="stable")


    def test_interactive_launcher_download_error_returns_to_channel_choice(self):
        identity = {"tag": "v1.2.4-beta.1", "commit": "c" * 40, "manifestSha256": "e" * 64}
        data = ("EXPECTED_RELEASE = " + repr(identity) + "\n").encode()
        nightly = {"tag": identity["tag"], "commit": identity["commit"], "launcherSha256": hashlib.sha256(data).hexdigest()}
        catalog = {"schema": "orbis.installer-channels.v1", "channels": {"stable": None, "nightly": nightly}}
        ask = mock.Mock(side_effect=["2", "2"])
        fetcher = mock.Mock(side_effect=[OSError("temporary download failure"), data])
        with contextlib.redirect_stderr(io.StringIO()):
            result = GUIDE.BOOT.select_verified_channel_launcher(catalog, ask=ask, fetch_launcher=fetcher)
        self.assertEqual(result, ("nightly", nightly, True, data, identity))
        self.assertEqual(ask.call_count, 2)
        self.assertEqual(fetcher.call_count, 2)


    def test_interactive_launcher_error_can_be_cancelled_cleanly(self):
        identity = {"tag": "v1.2.4-beta.1", "commit": "c" * 40, "manifestSha256": "e" * 64}
        data = ("EXPECTED_RELEASE = " + repr(identity) + "\n").encode()
        nightly = {"tag": identity["tag"], "commit": identity["commit"], "launcherSha256": hashlib.sha256(data).hexdigest()}
        catalog = {"schema": "orbis.installer-channels.v1", "channels": {"stable": None, "nightly": nightly}}
        ask = mock.Mock(side_effect=["2", ValueError("Installation cancelled")])
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "Installation cancelled"):
                GUIDE.BOOT.select_verified_channel_launcher(catalog, ask=ask, fetch_launcher=mock.Mock(side_effect=OSError("offline")))
        self.assertEqual(ask.call_count, 2)


    def test_interactive_launcher_integrity_error_returns_to_choice_without_accepting_bad_data(self):
        identity = {"tag": "v1.2.4-beta.1", "commit": "c" * 40, "manifestSha256": "e" * 64}
        good_data = ("EXPECTED_RELEASE = " + repr(identity) + "\n").encode()
        nightly = {"tag": identity["tag"], "commit": identity["commit"], "launcherSha256": hashlib.sha256(good_data).hexdigest()}
        catalog = {"schema": "orbis.installer-channels.v1", "channels": {"stable": None, "nightly": nightly}}
        ask = mock.Mock(side_effect=["2", "2"])
        fetcher = mock.Mock(side_effect=[b"not the published launcher", good_data])
        with contextlib.redirect_stderr(io.StringIO()):
            result = GUIDE.BOOT.select_verified_channel_launcher(catalog, ask=ask, fetch_launcher=fetcher)
        self.assertEqual(result[3:], (good_data, identity))
        self.assertEqual(fetcher.call_count, 2)




if __name__ == "__main__":
    unittest.main()
