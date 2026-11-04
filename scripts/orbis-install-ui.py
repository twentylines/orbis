#!/usr/bin/env python3
"""Terminal presentation for the guided installer; never writes protocol output."""

import contextlib
import os
import math
import re
import signal
import shutil
import sys
import subprocess
import threading
import time
import textwrap


def retry_download(action, ask=None):
    while True:
        try:
            return action()
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            if ask is None:
                raise
            print(f"Download did not finish: {error}", file=sys.stderr)
            while True:
                answer = ask("Retry this download? [y/N]: ").strip().lower()
                if answer in {"y", "yes"}:
                    break
                if answer in {"", "n", "no"}:
                    raise ValueError("Installation cancelled; private download logs were preserved") from error
                print("Enter y to retry or n to cancel.", file=sys.stderr)


def display_release(tag):
    match = re.fullmatch(r"v?(\d+\.\d+\.\d+)(?:-(beta|rc)\.(\d+))?", tag) if isinstance(tag, str) else None
    if match is None:
        return "version unavailable"
    base = match[1]
    if match[2] is not None and base.endswith(".0"):
        base = base[:-2]
    return base if match[2] is None else f"{base} {match[2]} {match[3]}"


def star_position(index, tick, width, height=12):
    # A terminal cell is roughly twice as tall as it is wide.
    angle = index * math.pi * (3 - math.sqrt(5))
    phase = (tick + index * 29) % 96
    depth = 1 - phase / 104
    radius = 0.14 + (index % 7) * 0.023
    scale = height * 1.4
    return ((width - 1) / 2 + math.cos(angle) * radius / depth * scale,
            (height - 1) / 2 + math.sin(angle) * radius / depth * scale / 2,
            depth)


def spaceflight(width, tick, height=12, unicode=False):
    """A bounded forward starfield, unrelated to operation completion."""
    width = max(1, min(96, width))
    height = max(6, min(13, height))
    cells = [[" " for _ in range(width)] for _ in range(height)]
    for index in range(72):
        x, y, depth = star_position(index, tick, width, height)
        if depth < 0.4:
            for age in (3, 6, 9):
                old_x, old_y, old_depth = star_position(index, tick - age, width, height)
                column, row = round(old_x), round(old_y)
                if old_depth >= depth and 0 <= column < width and 0 <= row < height and cells[row][column] == " ":
                    cells[row][column] = "·" if unicode else "."
        column, row = round(x), round(y)
        if 0 <= column < width and 0 <= row < height:
            cells[row][column] = ("." if depth > 0.65 else "·" if depth > 0.3 else "•") if unicode else ("." if depth > 0.3 else "*")
    return ["".join(row).rstrip() for row in cells]


class PullProgress:
    """Read bounded Docker layer updates from the existing private pull log."""

    def __init__(self, path):
        self.path = path
        self.offset = 0
        self.pending = b""
        self.layers = {}
        self.fraction = None

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
        self.fraction = ready / len(self.layers)
        return f"layers {ready}/{len(self.layers)}"


# The circle, tilted orbit and centre reflect the application mark using ASCII cells.
ORBIS_MARK = (
    r"   .---. /",
    r"  /  .  X",
    "  \\    /",
    r"   '---'",
)


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
        self._frame_lines = []
        self._frame_width = None
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

    def height(self):
        try:
            return os.get_terminal_size(self.stream.fileno()).lines
        except (AttributeError, OSError, ValueError):
            return shutil.get_terminal_size((80, 24)).lines

    def redraw(self, previous, lines):
        width = self.width()
        if not previous:
            self._frame_lines = list(lines)
            self._frame_width = width
            self.write("\n".join(lines))
            return len(lines)

        old = self._frame_lines if len(self._frame_lines) == previous else []
        repaint = self._frame_width != width
        output = ["\r", f"\033[{previous - 1}A" if previous > 1 else ""]
        count = max(previous, len(lines))
        for index in range(count):
            if index:
                output.append("\n" if index >= previous else "\033[1B\r")
            value = lines[index] if index < len(lines) else ""
            if repaint or index >= len(old) or value != old[index] or index >= len(lines):
                output.extend(("\033[2K", value))
        if count > len(lines):
            output.extend((f"\033[{count - len(lines)}A", "\r"))
        self._frame_lines = list(lines)
        self._frame_width = width
        self.write("".join(output))
        return len(lines)

    def banner(self, release):
        release = display_release(release)
        if self.tty and self.width() < 32:
            self.write(self.paint("Orbis", "1;36") + f"\n{release}\n")
            return
        if self.tty and self.width() >= 40:
            available = max(1, self.width() - 1 - len(ORBIS_MARK[1]) - len("  Orbis  "))
            release_lines = textwrap.wrap(release, width=available, break_long_words=True, break_on_hyphens=False) or [""]
            for index, line in enumerate(ORBIS_MARK):
                suffix = f"  Orbis  {release_lines[0]}" if index == 1 else ""
                self.write(self.paint(line, "36") + suffix + "\n")
            for line in release_lines[1:]:
                self.write(" " * (len(ORBIS_MARK[1]) + len("  Orbis  ")) + line + "\n")
            self.write("\n")
            return
        self.write(self.paint("Orbis", "1;36") + f"  {release}\n")

    def scene(self, tick):
        width, height = self.width(), self.height()
        if width < 40 or height < 18:
            return []
        field_width = min(96, width - 1)
        lines = spaceflight(field_width, tick, min(13, height - 12), self.unicode)
        def color_run(match):
            value = match.group(0)
            return self.paint(value, "37" if value[0] in {"*", "•"} else "36" if value[0] == "·" else "90")
        return [re.sub(r"([.*·•])\1*", color_run, line) for line in lines]

    def set_remaining_steps(self, count):
        if type(count) is not int or not 1 <= count <= 128:
            raise ValueError("Installation stage count is invalid")
        self.total = self.completed + count

    def frame(self, label, tick, elapsed=0, status=None, detail=None, fraction=None):
        width = max(1, self.width() - 1)
        if status:
            return (self.paint(status, "36" if status == "[ok]" else "33") + f"  {elapsed:.1f}s") if width >= len(status) + len(f"  {elapsed:.1f}s") else status[:width]
        caption = f"{elapsed:.1f}s"
        if detail and width >= 36:
            caption = f"{detail}  /  {caption}"
        if fraction is not None and width >= len(caption) + 12:
            cells = min(24, width - len(caption) - 4)
            done = max(0, min(cells, int(cells * fraction)))
            fill, empty = ("━", "─") if self.unicode else ("=", "-")
            return "[" + self.paint(fill * done, "36") + self.paint(empty * (cells - done), "90") + "]  " + caption
        pulse = ("·", "o", "O", "o") if self.unicode else (".", "o", "O", "o")
        value = f"{pulse[(tick // 3) % len(pulse)]}  Working  /  {caption}"
        return self.paint(value, "90") if len(value) <= width else caption[:width]

    @contextlib.contextmanager
    def step(self, label, *, completed=None, detail=None):
        heading = f"[{self.completed + 1}/{self.total}] {label}" if self.total else label
        if not self.animation:
            self.write(f"{heading}...\n")
            yield
            if completed is None or completed():
                self.completed += 1
            return
        stopped = threading.Event()
        started = time.monotonic()
        rows = 0
        previous_handlers = {}

        def terminate(signum, _frame):
            raise SystemExit(128 + signum)

        def draw():
            nonlocal rows
            tick = 1
            while not stopped.wait(0.1):
                summary = detail() if detail else None
                scene = self.scene(tick)
                rows = self.redraw(rows, [*scene, self.frame(label, tick, time.monotonic() - started, detail=summary, fraction=getattr(detail, "fraction", None))])
                tick += 1

        worker = threading.Thread(target=draw, name="orbis-installer-display", daemon=True)
        success = False
        try:
            if threading.current_thread() is threading.main_thread():
                for signum in (signal.SIGTERM, signal.SIGHUP):
                    previous_handlers[signum] = signal.signal(signum, terminate)
            self.write(textwrap.fill(heading, width=max(16, self.width() - 1), subsequent_indent="  ", break_long_words=False, break_on_hyphens=False) + "\n")
            self.write("\033[?25l")
            scene = self.scene(0)
            rows = self.redraw(0, [*scene, self.frame(label, 0)])
            worker.start()
            yield
            success = completed is None or completed()
        finally:
            stopped.set()
            if worker.ident is not None:
                worker.join()
            for signum, previous in previous_handlers.items():
                signal.signal(signum, previous)
            if success:
                self.completed += 1
            # Keep the cursor usable after failure, cancellation or interruption.
            status = "[ok]" if success else "[stopped]"
            self.redraw(rows, [self.frame(label, 0, time.monotonic() - started, status)])
            self.write("\033[?25h\n")
