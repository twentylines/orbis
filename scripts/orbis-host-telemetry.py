"""Bounded Linux counters. No commands, device probes or user-supplied paths."""

import hashlib
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path


LIMIT = 32
COUNTER_MIN_INTERVAL = 0.9
COUNTER_RESPONSE_BUDGET = 0.05
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
    if previous is None or elapsed is None or not 0.5 <= elapsed <= 60 or current < previous:
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
        self.slow_sample = None
        self.previous_network = {}
        self.previous_disks = {}
        boot = self.small(self.proc / "sys/kernel/random/boot_id")
        self.boot_identity = boot if boot and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", boot) else None

    def history_identity(self, kind: str, identity: tuple):
        if self.boot_identity is None or any(value is None for value in identity):
            return {}
        counter = str(identity[-1])
        if not re.fullmatch(r"[1-9][0-9]{0,19}", counter) or int(counter) >= (2**31 if kind == "network" else 2**64):
            return {}
        material = "\0".join((self.boot_identity, kind, *(str(value) for value in identity)))
        return {"historyId": hashlib.sha256(material.encode()).hexdigest()}

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
                **self.history_identity("network", identity),
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
                **self.history_identity("disk", identity),
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

    def battery_counter(self, base, name, *, signed=False):
        raw = self.small(base / name)
        if raw is None or re.fullmatch(r"-?[0-9]{1,16}" if signed else r"[0-9]{1,16}", raw) is None:
            return None
        value = int(raw)
        return abs(value) if abs(value) <= MAX_SAFE_INTEGER else None

    def battery(self):
        try:
            with os.scandir(self.sys / "class/power_supply") as entries:
                names = []
                for entry in entries:
                    if len(names) >= LIMIT or not name_valid(entry.name):
                        return None
                    names.append(entry.name)
            batteries = []
            for name in names:
                base = self.sys / "class/power_supply" / name
                kind = self.small(base / "type")
                if kind is None:
                    return None
                if kind != "Battery" or self.small(base / "scope") == "Device":
                    continue
                present = self.small(base / "present")
                if present == "0":
                    continue
                if present not in {None, "1"}:
                    return None
                raw_capacity = self.small(base / "capacity")
                capacity = self.battery_counter(base, "capacity")
                energy_now, energy_full, energy_design = (self.battery_counter(base, key) for key in
                    ("energy_now", "energy_full", "energy_full_design"))
                charge_now, charge_full, charge_design = (self.battery_counter(base, key) for key in
                    ("charge_now", "charge_full", "charge_full_design"))
                if raw_capacity is None:
                    now, full = (energy_now, energy_full) if energy_full else (charge_now, charge_full)
                    capacity = (now * 100 + full // 2) // full if now is not None and full and now <= full else None
                if capacity is None or capacity > 100:
                    return None
                status = self.small(base / "status")
                state = {"Charging": "charging", "Discharging": "discharging", "Full": "full", "Not charging": "idle"}.get(status, "unknown")
                charging = True if state == "charging" else False if state != "unknown" else None
                power = self.battery_counter(base, "power_now", signed=True)
                current = self.battery_counter(base, "current_now", signed=True)
                voltage = self.battery_counter(base, "voltage_now")
                watts = power / 1_000_000 if power is not None else current * voltage / 1_000_000_000_000 if current is not None and voltage else None
                if watts is not None and watts > 1_000_000:
                    watts = None
                if energy_now is not None and energy_full is not None and energy_now > energy_full:
                    energy_now = None
                health = energy_full * 100 / energy_design if energy_full is not None and energy_design else charge_full * 100 / charge_design if charge_full is not None and charge_design else None
                remaining = None
                if state in {"charging", "discharging"}:
                    remaining = self.battery_counter(base, "time_to_full_now" if charging else "time_to_empty_now")
                    if not remaining:
                        amount = energy_full - energy_now if charging and energy_full is not None and energy_now is not None else energy_now if not charging else None
                        if amount is not None and watts and watts > 0:
                            remaining = round(amount / 1_000_000 / watts * 3600)
                        elif current and charge_now is not None and (not charging or charge_full is not None and charge_full >= charge_now):
                            remaining = round((charge_full - charge_now if charging else charge_now) / current * 3600)
                    if remaining is not None and not 0 <= remaining <= 2_592_000:
                        remaining = None
                labels = {}
                for key, attribute in (("manufacturer", "manufacturer"), ("model", "model_name")):
                    value = self.small(base / attribute)
                    labels[key] = value if value and not re.search(r"[\x00-\x1f\x7f]", value) else None
                batteries.append({"percent": capacity, "charging": charging, "state": state,
                    "healthPercent": round(min(100, health), 1) if health is not None else None,
                    "powerWatts": round(watts, 3) if watts is not None else None,
                    "energyNowWh": energy_now / 1_000_000 if energy_now is not None else None,
                    "energyFullWh": energy_full / 1_000_000 if energy_full is not None else None,
                    "energyDesignWh": energy_design / 1_000_000 if energy_design is not None else None,
                    "timeRemainingSeconds": remaining, "cycleCount": self.battery_counter(base, "cycle_count"), **labels})
            if len(batteries) == 1:
                return {**batteries[0], "batteryCount": 1}
            if not batteries or any(row["energyNowWh"] is None or not row["energyFullWh"] or row["energyNowWh"] > row["energyFullWh"] for row in batteries):
                return None
            now, full = (sum(row[key] for row in batteries) for key in ("energyNowWh", "energyFullWh"))
            if full > MAX_SAFE_INTEGER / 1_000_000:
                return None
            flags, states = {row["charging"] for row in batteries}, {row["state"] for row in batteries}
            state = states.pop() if len(states) == 1 else "unknown"
            power = sum(row["powerWatts"] for row in batteries) if state != "unknown" and all(row["powerWatts"] is not None for row in batteries) else None
            design = sum(row["energyDesignWh"] for row in batteries) if all(row["energyDesignWh"] is not None for row in batteries) else None
            remaining = None
            if state == "discharging" and power:
                remaining = round(now / power * 3600)
            elif state == "charging" and all(row["timeRemainingSeconds"] is not None for row in batteries):
                remaining = max(row["timeRemainingSeconds"] for row in batteries)
            if remaining is not None and remaining > 2_592_000:
                remaining = None
            return {"percent": min(100, int(now * 100 / full + 0.5)), "charging": flags.pop() if len(flags) == 1 else None,
                "state": state, "healthPercent": round(min(100, full * 100 / design), 1) if design else None,
                "powerWatts": power, "energyNowWh": now, "energyFullWh": full, "energyDesignWh": design,
                "timeRemainingSeconds": remaining, "cycleCount": None, "manufacturer": None, "model": None, "batteryCount": len(batteries)}
        except (OSError, ValueError, OverflowError):
            return None

    def collect(self):
        now = time.monotonic()
        sampled_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        # Network/disk deltas need one-second counters; filesystem probes and
        # battery attributes retain a ten-second cadence in the same bounded worker.
        if self.slow_sample is None or now - self.slow_sample[0] >= 10:
            try:
                filesystems = self.filesystems()
            except (OSError, ValueError, OverflowError):
                filesystems = ([], 0, True)
            self.slow_sample = (now, self.battery(), filesystems)
        _, battery, filesystems = self.slow_sample
        result = {"available": True, "sampledAt": sampled_at, "battery": battery, "filesystems": filesystems[0], "network": [], "disks": [], "omitted": {"filesystems": filesystems[1]}, "unavailable": []}
        if len(filesystems) == 3 and filesystems[2]:
            result["unavailable"].append("filesystems")
        for section in ("network", "disks"):
            try:
                values = getattr(self, section)(now)
                result[section], result["omitted"][section] = values[:2]
            except (OSError, ValueError, OverflowError):
                result["unavailable"].append(section)
                result["omitted"][section] = 0
        result["available"] = any(result[section] for section in ("filesystems", "network", "disks")) or len(result["unavailable"]) < 3
        return result

    def refresh(self, done):
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
                done.set()

    def read(self):
        done = None
        with self.lock:
            now = time.monotonic()
            if not self.running and now - self.last_attempt >= COUNTER_MIN_INTERVAL:
                self.running = True
                self.last_attempt = now
                # One bounded worker prevents an unresponsive network filesystem from tying up HTTP handlers or spawning more probes.
                done = threading.Event()
                threading.Thread(target=self.refresh, args=(done,), daemon=True, name="orbis-host-counters").start()
        # Give the initiating request a short chance to receive the new counters.
        # Concurrent readers keep using the previous sample if a device probe stalls.
        if done is not None:
            done.wait(COUNTER_RESPONSE_BUDGET)
        with self.lock:
            if self.sample is None:
                return {"available": False, "reason": "Collecting host readings." if self.running else "Host readings are unavailable."}
            age = datetime.now(timezone.utc).timestamp() - datetime.fromisoformat(self.sample["sampledAt"].replace("Z", "+00:00")).timestamp()
            return {**self.sample, "stale": self.failed or age > 30}
