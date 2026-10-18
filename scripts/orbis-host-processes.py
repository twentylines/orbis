"""Read bounded process rankings from host procfs without commands or arguments."""

import heapq
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path


PROCESS_LIMIT = 20
SCAN_LIMIT = 8192
SCAN_SECONDS = 1
MAX_SAFE_INTEGER = 2**53 - 1


class HostProcesses:
    def __init__(self, proc=Path("/proc"), clock=time.monotonic, ticks_per_second=None, page_size=None):
        self.proc, self.clock = proc, clock
        self.ticks = ticks_per_second if ticks_per_second is not None else os.sysconf("SC_CLK_TCK")
        self.page_size = page_size if page_size is not None else os.sysconf("SC_PAGE_SIZE")
        self.lock = threading.Lock()
        self.running = False
        self.last_attempt = float("-inf")
        self.sample = None
        self.failed = False
        self.previous = {}

    def process(self, pid):
        # Only numeric process directories and stat are read; cmdline/environ/exe are never opened.
        with (self.proc / str(pid) / "stat").open("rb") as stream:
            raw = stream.read(4097)
        if len(raw) > 4096:
            raise ValueError("process stat exceeds limit")
        text = raw.decode("utf-8", errors="replace")
        prefix, separator, rest = text.partition(" (")
        end = rest.rfind(") ")
        if not separator or prefix != str(pid) or end < 0:
            raise ValueError("invalid process identity")
        name = "".join(character if character.isprintable() else "�" for character in rest[:end])[:64] or "Unknown"
        fields = rest[end + 2:].split()
        # stat fields 14/15, 22 and 24, after removing pid and parenthesized comm.
        if len(fields) < 22 or len(fields[0]) != 1 or not all(fields[n].isascii() and fields[n].isdecimal() for n in (11, 12, 19, 21)):
            raise ValueError("invalid process counters")
        ticks = int(fields[11]) + int(fields[12])
        started, memory = int(fields[19]), int(fields[21]) * self.page_size
        if max(ticks, started, memory) > MAX_SAFE_INTEGER:
            raise ValueError("process counters exceed limit")
        return name, ticks, started, memory

    @staticmethod
    def keep(heap, value, row):
        entry = (value, -row["pid"], row)
        if len(heap) < PROCESS_LIMIT:
            heapq.heappush(heap, entry)
        elif entry[:2] > heap[0][:2]:
            heapq.heapreplace(heap, entry)

    def collect(self):
        if not 0 < self.ticks <= 1_000_000 or not 0 < self.page_size <= 1024 * 1024:
            raise ValueError("host units unavailable")
        began = self.clock()
        cpu, memory, previous = [], [], {}
        scanned = readable = unreadable = compared = 0
        limited = False
        # scandir streams directory entries; neither the full PID list nor full process rows are retained.
        with os.scandir(self.proc) as entries:
            for entry in entries:
                if not entry.name.isascii() or not entry.name.isdecimal() or not 0 < int(entry.name) <= 2**31 - 1:
                    continue
                if entry.name != str(int(entry.name)):
                    continue
                if scanned >= SCAN_LIMIT or self.clock() - began >= SCAN_SECONDS:
                    limited = True
                    break
                scanned += 1
                pid = int(entry.name)
                try:
                    name, ticks, started, resident = self.process(pid)
                    measured = self.clock()
                    old = self.previous.get((pid, started))
                    elapsed = measured - old[0] if old else None
                    percent = (ticks - old[1]) / self.ticks / elapsed * 100 if old and 2 <= elapsed <= 60 and ticks >= old[1] else None
                    previous[(pid, started)] = (measured, ticks)
                    row = {"pid": pid, "name": name, "cpuPercent": percent, "memoryBytes": resident}
                    readable += 1
                    self.keep(memory, resident, row)
                    if percent is not None:
                        compared += 1
                        self.keep(cpu, percent, row)
                except (OSError, ValueError, OverflowError):
                    unreadable += 1
        self.previous = previous
        return {
            "available": True,
            "sampledAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "scanned": scanned, "readable": readable, "unreadable": unreadable, "compared": compared, "limited": limited,
            "byCpu": [row for _, _, row in sorted(cpu, key=lambda item: item[:2], reverse=True)],
            "byMemory": [row for _, _, row in sorted(memory, key=lambda item: item[:2], reverse=True)],
        }

    def refresh(self):
        try:
            sample = self.collect()
            with self.lock:
                self.sample = sample
                self.failed = False
        except Exception:
            with self.lock:
                self.failed = True
        finally:
            with self.lock:
                self.running = False

    def read(self):
        with self.lock:
            now = self.clock()
            if not self.running and now - self.last_attempt >= 10:
                self.running = True
                self.last_attempt = now
                threading.Thread(target=self.refresh, daemon=True, name="orbis-host-processes").start()
            if self.sample is None:
                return {"available": False, "reason": "Collecting process readings." if self.running else "Process readings are unavailable."}
            age = datetime.now(timezone.utc).timestamp() - datetime.fromisoformat(self.sample["sampledAt"].replace("Z", "+00:00")).timestamp()
            return {**self.sample, "stale": self.failed or age > 30}
