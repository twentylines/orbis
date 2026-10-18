"""Bounded Linux counters. No commands, device probes or user-supplied paths."""

import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path


LIMIT = 32
MAX_SAFE_INTEGER = 2**53 - 1
NAME = re.compile(r"[a-zA-Z0-9_.:@+!-]{1,128}\Z")
PSEUDO = {
    "proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "ramfs", "cgroup", "cgroup2",
    "securityfs", "debugfs", "tracefs", "configfs", "pstore", "efivarfs", "mqueue",
    "hugetlbfs", "fusectl", "autofs", "binfmt_misc", "nsfs", "rpc_pipefs", "squashfs",
    "overlay", "bpf", "resctrl", "selinuxfs",
}


def bounded_text(path: Path, limit: int = 1024 * 1024) -> str:
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("counter file exceeds limit")
    return data.decode("utf-8", errors="replace")


def number(value: int | float | None):
    return value if value is not None and 0 <= value <= MAX_SAFE_INTEGER else None


def name_valid(value: str) -> bool:
    return value not in {".", ".."} and NAME.fullmatch(value) is not None


def delta(current: int, previous: int | None, elapsed: float | None):
    if previous is None or elapsed is None or not 2 <= elapsed <= 60 or current < previous:
        return None
    return number((current - previous) / elapsed)


class HostTelemetry:
    def __init__(self, proc: Path = Path("/proc"), sys: Path = Path("/sys"), statvfs=os.statvfs):
        self.proc, self.sys, self.statvfs = proc, sys, statvfs
        self.lock = threading.Lock()
        self.running = False
        self.last_attempt = float("-inf")
        self.sample = None
        self.failed = False
        self.previous_network = {}
        self.previous_disks = {}

    def small(self, path: Path):
        try:
            return bounded_text(path, 128).strip()
        except (OSError, ValueError):
            return None

    def network(self, now: float):
        rows = []
        for line in bounded_text(self.proc / "net/dev", 256 * 1024).splitlines():
            if ":" not in line:
                continue
            label, values = line.rsplit(":", 1)
            label = label.strip()
            if label == "lo" or not name_valid(label):
                continue
            fields = values.split()
            if len(fields) < 16 or not all(v.isdecimal() for v in fields[:16]):
                continue
            rows.append((label, int(fields[0]), int(fields[8])))
        rows.sort()
        result, previous = [], {}
        for label, received, sent in rows[:LIMIT]:
            base = self.sys / "class/net" / label
            identity = (label, self.small(base / "ifindex"))
            old = self.previous_network.get(identity)
            elapsed = now - old[0] if old else None
            state = self.small(base / "operstate")
            speed = self.small(base / "speed")
            result.append({
                "interface": label,
                "state": state if state in {"up", "down"} else "unknown",
                "speedMbps": number(int(speed)) if speed and speed.isdecimal() else None,
                "receivedBytes": number(received), "transmittedBytes": number(sent),
                "rxBytesPerSecond": delta(received, old[1] if old else None, elapsed),
                "txBytesPerSecond": delta(sent, old[2] if old else None, elapsed),
            })
            previous[identity] = (now, received, sent)
        self.previous_network = previous
        return result, max(0, len(rows) - LIMIT)

    def disks(self, now: float):
        rows = []
        for line in bounded_text(self.proc / "diskstats", 256 * 1024).splitlines():
            fields = line.split()
            if len(fields) < 14 or not name_valid(fields[2]) or not all(v.isdecimal() for v in fields[:2] + fields[3:14]):
                continue
            label = fields[2]
            if re.match(r"^(loop|ram|zram|sr)\d", label) or (self.sys / "class/block" / label / "partition").exists():
                continue
            rows.append((label, fields))
        rows.sort()
        result, previous = [], {}
        for label, fields in rows[:LIMIT]:
            identity = (label, fields[0], fields[1], self.small(self.sys / "class/block" / label / "diskseq"))
            # Linux diskstats sectors are 512 bytes, independent of the device's physical sector size.
            read, written, busy = int(fields[5]) * 512, int(fields[9]) * 512, int(fields[12])
            old = self.previous_disks.get(identity)
            elapsed = now - old[0] if old else None
            busy_rate = delta(busy, old[3] if old else None, elapsed)
            result.append({
                "device": label, "readBytes": number(read), "writtenBytes": number(written),
                "readBytesPerSecond": delta(read, old[1] if old else None, elapsed),
                "writeBytesPerSecond": delta(written, old[2] if old else None, elapsed),
                "busyPercent": min(100, busy_rate / 10) if busy_rate is not None else None,
                "inFlight": number(int(fields[11])),
            })
            previous[identity] = (now, read, written, busy)
        self.previous_disks = previous
        return result, max(0, len(rows) - LIMIT)

    def filesystems(self):
        mounts = {}
        for line in bounded_text(self.proc / "self/mountinfo").splitlines():
            left, separator, right = line.partition(" - ")
            fields, details = left.split(), right.split()
            if not separator or len(fields) < 6 or len(details) < 3:
                continue
            if details[0] in PSEUDO and fields[4] != "/":
                continue
            mount = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), fields[4])
            if not mount.startswith("/") or len(mount) > 4096 or "\0" in mount:
                continue
            # Only the visible mount at a given path is queried. Sources/options may contain credentials and are never returned.
            mounts[mount] = (details[0][:128], "ro" in fields[5].split(","))
        rows = sorted(mounts.items(), key=lambda item: (item[0] != "/", item[0]))
        result, failed = [], 0
        for mount, (filesystem, read_only) in rows[:LIMIT]:
            try:
                usage = self.statvfs(mount)
                unit = usage.f_frsize or usage.f_bsize
                total, free, available = (number(unit * n) for n in (usage.f_blocks, usage.f_bfree, usage.f_bavail))
                if total is None or free is None or available is None or free > total or available > free:
                    raise ValueError("filesystem counters are invalid")
                if total == 0:
                    continue
                result.append({
                    "mount": re.sub(r"[\x00-\x1f\x7f]", "�", mount), "filesystem": filesystem,
                    "sizeBytes": total, "usedBytes": total - free, "availableBytes": available, "readOnly": read_only,
                })
            except (OSError, ValueError, OverflowError):
                failed += 1
        return result, max(0, len(rows) - LIMIT), failed

    def collect(self):
        now = time.monotonic()
        sampled_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        result = {"available": True, "sampledAt": sampled_at, "filesystems": [], "network": [], "disks": [], "omitted": {}, "unavailable": []}
        for section in ("network", "disks", "filesystems"):
            try:
                values = self.filesystems() if section == "filesystems" else getattr(self, section)(now)
                result[section], result["omitted"][section] = values[:2]
                if len(values) == 3 and values[2]:
                    result["unavailable"].append(section)
            except (OSError, ValueError, OverflowError):
                result["unavailable"].append(section)
                result["omitted"][section] = 0
        result["available"] = any(result[section] for section in ("filesystems", "network", "disks")) or len(result["unavailable"]) < 3
        return result

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
            now = time.monotonic()
            if not self.running and now - self.last_attempt >= 10:
                self.running = True
                self.last_attempt = now
                # One bounded worker prevents an unresponsive network filesystem from tying up HTTP handlers or spawning more probes.
                threading.Thread(target=self.refresh, daemon=True, name="orbis-host-counters").start()
            if self.sample is None:
                return {"available": False, "reason": "Collecting host readings." if self.running else "Host readings are unavailable."}
            age = datetime.now(timezone.utc).timestamp() - datetime.fromisoformat(self.sample["sampledAt"].replace("Z", "+00:00")).timestamp()
            return {**self.sample, "stale": self.failed or age > 30}
