#!/usr/bin/env python3
"""Terminal presentation for the guided installer; never writes protocol output."""

import contextlib
import os
import shutil
import sys
import threading
import time


WORDMARK = (
    r"  ___  ____  ____  ___ ____  ",
    r" / _ \|  _ \| __ )|_ _/ ___| ",
    r"| | | | |_) |  _ \ | |\___ \ ",
    r"| |_| |  _ <| |_) || | ___) |",
    r" \___/|_| \_\____/|___|____/ ",
)
ORBITS = ("   o   ", "    o  ", "     o ", "      o", "     o ", "    o  ", "   o   ", "  o    ", " o     ", "o      ", " o     ", "  o    ")


class Presentation:
    def __init__(self, *, stream=None, environ=None, interactive=True, color=True, animation=True):
        self.stream = stream if stream is not None else sys.stderr
        env = os.environ if environ is None else environ
        tty = interactive and self.stream.isatty() and env.get("TERM", "dumb") not in {"", "dumb", "unknown"} and not env.get("CI")
        self.color = bool(tty and color and "NO_COLOR" not in env)
        self.animation = bool(tty and animation and "NO_COLOR" not in env and not env.get("ORBIS_NO_ANIMATION"))
        self.tty = bool(tty)

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
        if not self.tty or self.width() < 64:
            self.write(self.paint("Orbis", "1;36") + f"  {release}\n")
            return
        planet = ("     .----.    ", " .--' .--. '--.", "(____( () )____)", " '--. '--' .--'", "     '----'    ")
        self.write("\n")
        for orbit, letters in zip(planet, WORDMARK):
            self.write(self.paint(orbit, "36") + "  " + self.paint(letters, "1;33") + "\n")
        self.write(self.paint(f"  {release}  /  Server installation", "2") + "\n\n")

    def frame(self, label, tick):
        width = max(1, self.width() - 1)
        if width < 40:
            return ("|/-\\"[tick % 4] + " " + label)[:width]
        trail = [" "] * 16
        head = tick % 22 - 3
        for offset, char in enumerate(".==>"):
            if 0 <= head + offset < len(trail):
                trail[head + offset] = char
        orbit = self.paint("(" + ORBITS[tick % len(ORBITS)] + ")", "36")
        scan = self.paint("[" + "".join(trail) + "]", "33")
        return f"{orbit} {scan} {label[:max(1, width - 30)]}"

    @contextlib.contextmanager
    def step(self, label, *, completed=None):
        if not self.animation:
            self.write(f"{label}...\n")
            yield
            return
        stopped = threading.Event()
        started = time.monotonic()

        def draw():
            tick = 1
            while not stopped.wait(0.1):
                self.write("\r\033[2K" + self.frame(label, tick))
                tick += 1

        worker = threading.Thread(target=draw, name="orbis-installer-display", daemon=True)
        success = False
        try:
            self.write("\033[?25l" + self.frame(label, 0))
            worker.start()
            yield
            success = completed is None or completed()
        finally:
            stopped.set()
            if worker.ident is not None:
                worker.join()
            # Keep the cursor usable after failure, cancellation or interruption.
            self.write("\r\033[2K\033[?25h")
            status = self.paint("[ok]", "36") if success else self.paint("[stopped]", "33")
            self.write(f"{status} {label} ({time.monotonic() - started:.1f}s)\n")
