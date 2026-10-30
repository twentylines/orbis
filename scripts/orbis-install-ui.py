#!/usr/bin/env python3
"""Terminal presentation for the guided installer; never writes protocol output."""

import contextlib
import os
import math
import re
import signal
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


def display_release(tag):
    match = re.fullmatch(r"v?(\d+\.\d+\.\d+)(?:-(beta|rc)\.(\d+))?", tag) if isinstance(tag, str) else None
    if match is None:
        return "version unavailable"
    base = match[1]
    if match[2] is not None and base.endswith(".0"):
        base = base[:-2]
    return base if match[2] is None else f"{base} {match[2]} {match[3]}"


def spaceflight(width, tick):
    """Decorative perspective only; operation progress is displayed separately."""
    width = max(1, min(96, width))
    height, center = 6, width // 2
    cells = [[" " for _ in range(width)] for _ in range(height)]
    for index in range(36):
        depth = ((index * 37 - tick * 2) % 97 + 3) / 100
        x = center + round((((index * 53) % 101) - 50) / depth)
        y = 2 + round((((index * 17) % 23) - 11) / (6 * depth))
        if 0 <= x < width and 0 <= y < height:
            cells[y][x] = "." if depth > 0.65 else "+" if depth > 0.3 else "*"
    for row in (4, 5):
        distance = (row - 2) * max(3, width // 8)
        for x, value in ((center - distance, "/"), (center + distance, "\\")):
            if 0 <= x < width:
                cells[row][x] = value
    ship = ("   /\\   ", "  /__\\  ", " /|__|\\ ", "<_|__|_>")
    drift = round(math.sin(tick / 12))
    for row, line in enumerate(ship, 1):
        for column, value in enumerate(line):
            x = center - len(line) // 2 + column + drift
            if value != " " and 0 <= x < width:
                cells[row][x] = value
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

    def height(self):
        try:
            return os.get_terminal_size(self.stream.fileno()).lines
        except (AttributeError, OSError, ValueError):
            return shutil.get_terminal_size((80, 24)).lines

    def redraw(self, previous, lines):
        if previous:
            self.write("\r" + (f"\033[{previous - 1}A" if previous > 1 else ""))
            self.write("\n".join("\033[2K" for _ in range(previous)))
            self.write((f"\033[{previous - 1}A" if previous > 1 else "") + "\r")
        self.write("\n".join(lines))
        return len(lines)

    def banner(self, release):
        release = display_release(release)
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

    def frame(self, label, tick, elapsed=0, status=None, detail=None, fraction=None):
        width = max(1, self.width() - 1)
        caption = f"{status}  {elapsed:.1f}s" if status else f"{elapsed:.1f}s"
        if detail and not status and width >= 64:
            caption = f"{detail}  /  {elapsed:.1f}s"
        if width < 36:
            caption = status or f"{elapsed:.0f}s"
        if width < len(caption) + 8:
            return caption[:width]
        cells = max(4, min(54, width - len(caption) - 4))
        # The bar belongs to the current operation; the heading identifies its stage.
        # Layer counts are not byte percentages, and unknown work stays animated.
        done = cells if status == "[ok]" else min(cells, int(cells * fraction)) if fraction is not None else 0
        end = cells
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
                scene = [self.paint(line, "36") for line in spaceflight(self.width() - 1, tick)] if self.width() >= 72 and self.height() >= 18 else []
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
            scene = [self.paint(line, "36") for line in spaceflight(self.width() - 1, 0)] if self.width() >= 72 and self.height() >= 18 else []
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
