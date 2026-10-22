import importlib.util
import io
import os
from pathlib import Path
import pty
import re
import select
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("orbis-install-ui.py")
SPEC = importlib.util.spec_from_file_location("installer_ui", SCRIPT)
UI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UI)


class TerminalStream(io.StringIO):
    def isatty(self):
        return True


class InstallerPresentationTests(unittest.TestCase):
    def test_piped_unattended_and_accessibility_output_stays_plain_and_readable(self):
        cases = [
            (io.StringIO(), {"TERM": "xterm-256color"}, True),
            (TerminalStream(), {"TERM": "dumb"}, True),
            (TerminalStream(), {"TERM": "xterm-256color", "NO_COLOR": ""}, True),
            (TerminalStream(), {"TERM": "xterm-256color", "CI": "true"}, True),
            (TerminalStream(), {"TERM": "xterm-256color"}, False),
        ]
        for output, env, interactive in cases:
            with self.subTest(env=env, interactive=interactive):
                ui = UI.Presentation(stream=output, environ=env, interactive=interactive)
                with ui.step("Checking existing applications"):
                    pass
                self.assertEqual(output.getvalue(), "Checking existing applications...\n")
                self.assertNotIn("\033", output.getvalue())
                self.assertNotIn("\r", output.getvalue())

    def test_narrow_terminal_uses_compact_branding_and_frames_fit_available_columns(self):
        output = TerminalStream()
        ui = UI.Presentation(stream=output, environ={"TERM": "xterm"}, color=False)
        for width in (20, 39, 40, 63, 64, 80):
            with self.subTest(width=width), mock.patch.object(ui, "width", return_value=width):
                for tick in range(24):
                    self.assertLessEqual(len(ui.frame("Reviewing app ownership and backup storage", tick)), width - 1)
                output.seek(0); output.truncate()
                ui.banner("v0.1.0-beta.68")
                self.assertIn("v0.1.0-beta.68", output.getvalue())
                if width < 32:
                    self.assertTrue(output.getvalue().startswith("Orbis\n"))
                elif width < 64:
                    self.assertTrue(output.getvalue().startswith("Orbis  "))
                else:
                    self.assertIn("(____( () )____)", output.getvalue())
                self.assertTrue(all(len(line) <= width for line in output.getvalue().splitlines()))

    def test_active_completed_and_failed_frames_fit_very_narrow_and_resized_terminals(self):
        ui = UI.Presentation(stream=TerminalStream(), environ={"TERM": "xterm"}, color=False)
        ui.set_remaining_steps(12)
        for width in (80, 18, 14, 12, 8, 39, 64, 120):
            with self.subTest(width=width), mock.patch.object(ui, "width", return_value=width):
                for status in (None, "[ok]", "[stopped]"):
                    value = ui.frame("Downloading", 5, 1234, status, detail="layers 12/4096")
                    self.assertLessEqual(len(value), width - 1)
        with mock.patch.object(ui, "width", return_value=80):
            self.assertIn("layers 3/8", ui.frame("Downloading", 4, detail="layers 3/8"))
            self.assertNotIn("%", ui.frame("Downloading", 4, detail="layers 3/8"))

    def test_layer_details_follow_incremental_private_log_updates_without_echoing_diagnostics(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "pull.log"
            progress = UI.PullProgress(path)
            self.assertIsNone(progress())
            path.write_bytes(b"abcdef123456: Pulling fs layer\n123456abcdef: Already exists\nabcdef123456: Download comp")
            self.assertEqual(progress(), "layers 1/2")
            with path.open("ab") as stream:
                stream.write(b"lete\nabcdef123456: Extracting [==>] 5MB/10MB\n")
                stream.write(b"abcdef123456: Pull complete\r\n\x1b[2Jsecret diagnostic\nStatus: Downloaded newer image\n")
            self.assertEqual(progress(), "layers 2/2")
            self.assertEqual(progress(), "layers 2/2")
            self.assertNotIn("secret", progress())
            self.assertNotIn("\033", progress())

    def test_noisy_or_unrecognized_pull_output_is_bounded_and_does_not_claim_download_progress(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "pull.log"
            progress = UI.PullProgress(path)
            path.write_bytes(b"x" * 100000)
            self.assertIsNone(progress())
            self.assertLessEqual(len(progress.pending), 4096)
            self.assertEqual(progress.offset, 65536)
            self.assertIsNone(progress())
            with path.open("ab") as stream:
                stream.write(b"\n" + b"".join(f"{index:012x}: Already exists\n".encode() for index in range(4200)))
            for _ in range(5):
                progress()
            self.assertEqual(progress(), "layers 4096/4096")

    def test_failure_and_interrupt_restore_cursor_and_never_report_success(self):
        for error in (ValueError("ownership needs review"), KeyboardInterrupt()):
            output = TerminalStream()
            ui = UI.Presentation(stream=output, environ={"TERM": "xterm"})
            with self.subTest(error=type(error)), self.assertRaises(type(error)):
                with ui.step("Reviewing ownership"):
                    raise error
            value = output.getvalue()
            self.assertIn("\033[?25h", value)
            self.assertIn("[stopped]", value)
            self.assertNotIn("[ok]", value)
            snapshot = output.getvalue()
            time.sleep(0.15)
            self.assertEqual(output.getvalue(), snapshot, "Display thread survived the operation")

    def test_nonzero_executor_result_is_not_shown_as_success(self):
        output = TerminalStream()
        ui = UI.Presentation(stream=output, environ={"TERM": "xterm"})
        with ui.step("Running replacement", completed=lambda: False):
            pass
        self.assertIn("[stopped]", output.getvalue())
        self.assertNotIn("[ok]", output.getvalue())

    def test_real_pty_shows_one_animated_bar_and_restores_cursor_before_prompt(self):
        import fcntl
        import termios
        master, slave = pty.openpty()
        code = (
            "import importlib.util,time; "
            f"s=importlib.util.spec_from_file_location('ui',{str(SCRIPT.resolve())!r}); "
            "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
            "u=m.Presentation(); u.banner('v0.1.0-beta.68'); "
            "exec(\"with u.step('Checking app ownership'):\\n time.sleep(.35)\"); "
            "print('Ready for confirmation',flush=True)"
        )
        process = None
        output = b""
        try:
            env = {key: value for key, value in os.environ.items() if key not in {"NO_COLOR", "CI", "ORBIS_NO_ANIMATION"}}
            env["TERM"] = "xterm-256color"
            def attach():
                os.setsid()
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            process = subprocess.Popen([sys.executable, "-u", "-c", code], stdin=subprocess.DEVNULL, stdout=slave, stderr=slave, env=env, pass_fds=(slave,), preexec_fn=attach)
            os.close(slave); slave = None
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and select.select([master], [], [], 1)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk
            process.wait(timeout=5)
            self.assertEqual(process.returncode, 0, output.decode(errors="replace"))
        finally:
            if process is not None and process.poll() is None:
                process.kill(); process.wait(timeout=5)
            os.close(master)
            if slave is not None:
                os.close(slave)
        self.assertGreaterEqual(len(re.findall(rb"\r\x1b\[2K", output)), 3, repr(output))
        self.assertIn(b"[ok]", output)
        self.assertNotIn(b".==>", output)
        self.assertLess(output.rfind(b"\x1b[?25h"), output.find(b"Ready for confirmation"))

    def test_progress_counts_completed_stages_and_does_not_fake_download_percentages(self):
        output = TerminalStream()
        ui = UI.Presentation(stream=output, environ={"TERM": "xterm"}, color=False)
        with ui.step("Detecting installations"):
            pass
        self.assertIn("=" * 54, ui.frame("Detected", 0, status="[ok]"))
        ui.set_remaining_steps(3)
        self.assertIn("1/4 stages", ui.frame("Downloading image", 2))
        self.assertNotIn("%", ui.frame("Downloading image", 20))
        with ui.step("Downloading image", completed=lambda: False):
            pass
        self.assertEqual(ui.completed, 1)
        for label in ("Downloading image", "Starting Orbis", "Enabling system administration"):
            with ui.step(label):
                pass
        self.assertEqual(ui.completed, ui.total)
        self.assertIn("[ok] 4/4", output.getvalue())
        self.assertEqual(output.getvalue().count("Step 02"), 2)
        self.assertEqual(ui.frame("Done", 0, status="[ok]").count("="), 54)


if __name__ == "__main__":
    unittest.main()
