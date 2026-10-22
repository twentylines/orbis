#!/usr/bin/env python3
"""Terminal presentation for the guided installer; never writes protocol output."""

import contextlib
import os
import re
import shutil
import sys
import threading
import time
import textwrap


WORDMARK = (
    r"  ___  ____  ____  ___ ____  ",
    r" / _ \|  _ \| __ )|_ _/ ___| ",
    r"| | | | |_) |  _ \ | |\___ \ ",
    r"| |_| |  _ <| |_) || | ___) |",
    r" \___/|_| \_\____/|___|____/ ",
)


class PullProgress:
    """Read bounded Docker layer updates from the existing private pull log."""

    def __init__(self, path):
        self.path = path
        self.offset = 0
        self.pending = b""
        self.layers = {}

    def __call__(self):
        try:
            with self.path.open("rb") as stream:
                stream.seek(self.offset)
                data = stream.read(65536)
                self.offset = stream.tell()
        except OSError:
            return None
        lines = (self.pending + data).split(b"\n")
        self.pending = lines.pop()[-4096:]
        for line in lines:
            match = re.fullmatch(rb"([0-9a-f]{6,64}): (Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)(?:\s+.*)?", line.rstrip(b"\r"))
            if match and (match[1] in self.layers or len(self.layers) < 4096):
                self.layers[match[1]] = match[2]
        if not self.layers:
            return None
        ready = sum(status in {b"Pull complete", b"Already exists"} for status in self.layers.values())
        return f"layers {ready}/{len(self.layers)}"


class Presentation:
    def __init__(self, *, stream=None, environ=None, interactive=True, color=True, animation=True):
        self.stream = stream if stream is not None else sys.stderr
        env = os.environ if environ is None else environ
        tty = interactive and self.stream.isatty() and env.get("TERM", "dumb") not in {"", "dumb", "unknown"} and not env.get("CI")
        self.color = bool(tty and color and "NO_COLOR" not in env)
        self.animation = bool(tty and animation and "NO_COLOR" not in env and not env.get("ORBIS_NO_ANIMATION"))
        self.tty = bool(tty)
        self.completed = 0
        self.total = None
        self.unicode = "utf" in (getattr(self.stream, "encoding", None) or env.get("LC_ALL") or env.get("LANG", "")).lower()

    def paint(self, value, code):
        return f"\033[{code}m{value}\033[0m" if self.color else value

    def write(self, value):
        self.stream.write(value)
        self.stream.flush()

    def width(self):
        try:
            columns = os.get_terminal_size(self.stream.fileno()).columns
            if columns > 0:
                return columns
        except (AttributeError, OSError, ValueError):
            pass
        return shutil.get_terminal_size((80, 24)).columns or 80

    def banner(self, release):
        if self.tty and self.width() < 32:
            self.write(self.paint("Orbis", "1;36") + f"\n{release}\n")
            return
        if not self.tty or self.width() < 64:
            self.write(self.paint("Orbis", "1;36") + f"  {release}\n")
            return
        planet = ("     .----.    ", " .--' .--. '--.", "(____( () )____)", " '--. '--' .--'", "     '----'    ")
        self.write("\n")
        for orbit, letters in zip(planet, WORDMARK):
            self.write(self.paint(orbit, "36") + "  " + self.paint(letters, "1;33") + "\n")
        self.write(f"  {release}  /  Server installation\n\n")

    def set_remaining_steps(self, count):
        if type(count) is not int or not 1 <= count <= 128:
            raise ValueError("Installation stage count is invalid")
        self.total = self.completed + count

    def frame(self, label, tick, elapsed=0, status=None, detail=None):
        width = max(1, self.width() - 1)
        count = f"{self.completed}/{self.total} stages" if self.total else "Working"
        caption = f"{status or count}  {elapsed:.1f}s"
        if status and self.total:
            caption = f"{status} {self.completed}/{self.total}  {elapsed:.1f}s"
        if detail and not status and width >= 64:
            caption = f"{count}  /  {detail}  /  {elapsed:.1f}s"
        if width < 36:
            caption = status or (f"{self.completed}/{self.total}" if self.total else f"{elapsed:.0f}s")
        if width < len(caption) + 8:
            return caption[:width]
        cells = max(4, min(54, width - len(caption) - 4))
        done = min(cells, int(cells * self.completed / self.total)) if self.total else (cells if status == "[ok]" else 0)
        end = min(cells, max(done + 1, int(cells * (self.completed + 1) / self.total))) if self.total else cells
        span = max(1, end - done)
        period = max(1, 2 * (span - 1))
        position = tick % period
        head = done + min(position, period - position)
        track = []
        for index in range(cells):
            if index < done:
                track.append(self.paint("█" if self.unicode else "=", "36"))
            elif status is None and done <= index < end and abs(index - head) < 3:
                distance = abs(index - head)
                track.append(self.paint(("█", "▓", "░")[distance] if self.unicode else ("#", "=", ".")[distance], "1;33" if distance == 0 else "33"))
            else:
                track.append(self.paint("─" if self.unicode else "-", "90"))
        return self.paint("[", "90") + "".join(track) + self.paint("]", "90") + "  " + caption

    @contextlib.contextmanager
    def step(self, label, *, completed=None, detail=None):
        if not self.animation:
            self.write(f"{label}...\n")
            yield
            if completed is None or completed():
                self.completed += 1
            return
        stopped = threading.Event()
        started = time.monotonic()

        def draw():
            tick = 1
            while not stopped.wait(0.1):
                self.write("\r\033[2K" + self.frame(label, tick, time.monotonic() - started, detail=detail() if detail else None))
                tick += 1

        worker = threading.Thread(target=draw, name="orbis-installer-display", daemon=True)
        success = False
        try:
            heading = f"Step {self.completed + 1:02d}  {label}"
            self.write(textwrap.fill(heading, width=max(16, self.width() - 1), subsequent_indent="  ", break_long_words=False, break_on_hyphens=False) + "\n")
            self.write("\033[?25l" + self.frame(label, 0))
            worker.start()
            yield
            success = completed is None or completed()
        finally:
            stopped.set()
            if worker.ident is not None:
                worker.join()
            if success:
                self.completed += 1
            # Keep the cursor usable after failure, cancellation or interruption.
            self.write("\r\033[2K\033[?25h")
            status = "[ok]" if success else "[stopped]"
            self.write(self.frame(label, 0, time.monotonic() - started, status) + "\n")
