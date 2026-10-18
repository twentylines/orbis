"""Read selected Linux hwmon and DRM attributes without commands or device writes."""

import hashlib
import os
import re
import stat
import threading
import time
from datetime import datetime, timezone
from pathlib import Path


LIMIT = 32
DIRECTORY_LIMIT = 512
SCAN_SECONDS = 1
MAX_SAFE_INTEGER = 2**53 - 1
NUMBER = re.compile(r"-?[0-9]{1,16}\Z")
CHANNEL = re.compile(r"(temp|fan)([1-9][0-9]{0,3})_input\Z")
VENDORS = {"0x1002": "AMD", "0x10de": "NVIDIA", "0x8086": "Intel", "0x1a03": "ASPEED", "0x1af4": "Virtio"}


class HostSensors:
    def __init__(self, sys=Path("/sys"), clock=time.monotonic):
        self.sys, self.clock = sys.resolve(), clock
        self.lock = threading.Lock()
        self.running = False
        self.last_attempt = float("-inf")
        self.sample = None
        self.failed = False
        self.limited = False
        self.unreadable = 0
        self.began = 0
        self.reads = 0
        self.scanned = 0

    def text(self, path, optional=False):
        if self.reads >= 2048 or self.clock() - self.began >= SCAN_SECONDS:
            self.limited = True
            return None
        self.reads += 1
        try:
            resolved = path.resolve(strict=True)
            if not resolved.is_relative_to(self.sys):
                raise ValueError("sensor attribute escapes sysfs")
            descriptor = os.open(resolved, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                    raise ValueError("sensor attribute is not a regular sysfs file")
                raw = os.read(descriptor, 257)
            finally:
                os.close(descriptor)
            if len(raw) > 256:
                raise ValueError("sensor attribute exceeds limit")
            return raw.decode("utf-8", errors="strict").strip()
        except FileNotFoundError:
            if not optional:
                self.unreadable += 1
        except (OSError, ValueError, UnicodeError):
            self.unreadable += 1
        return None

    def integer(self, path, low=0, high=MAX_SAFE_INTEGER, optional=False):
        text = self.text(path, optional)
        if text is None:
            return None
        if not NUMBER.fullmatch(text) or not low <= int(text) <= high:
            self.unreadable += 1
            return None
        return int(text)

    @staticmethod
    def label(value, fallback):
        cleaned = " ".join("".join(c if c.isprintable() else " " for c in (value or "")).split())
        return cleaned[:128] or fallback

    def identity(self, kind, path):
        resolved = path.resolve()
        if not resolved.is_relative_to(self.sys):
            raise ValueError("sensor identity escapes sysfs")
        return kind + ":" + hashlib.sha256(str(resolved).encode()).hexdigest()[:16]

    def entries(self, directory, pattern):
        result = []
        try:
            resolved = directory.resolve(strict=True)
            if not resolved.is_relative_to(self.sys):
                raise ValueError("sensor directory escapes sysfs")
            with os.scandir(resolved) as entries:
                for index, entry in enumerate(entries):
                    if index >= DIRECTORY_LIMIT or self.scanned >= 4096 or self.clock() - self.began >= SCAN_SECONDS:
                        self.limited = True
                        break
                    self.scanned += 1
                    if pattern.fullmatch(entry.name):
                        result.append(directory / entry.name)
        except FileNotFoundError:
            pass
        return sorted(result, key=lambda path: path.name)

    def hwmon(self, result):
        seen = {"temperatures": set(), "fans": set()}
        for chip in self.entries(self.sys / "class/hwmon", re.compile(r"hwmon[0-9]{1,6}\Z")):
            if self.clock() - self.began >= SCAN_SECONDS:
                self.limited = True
                break
            chip_name = self.label(self.text(chip / "name", optional=True), chip.name)
            for path in self.entries(chip, CHANNEL):
                if self.clock() - self.began >= SCAN_SECONDS or self.reads >= 2048:
                    self.limited = True
                    break
                match = CHANNEL.fullmatch(path.name)
                prefix = match[1] + match[2]
                kind = "temperatures" if match[1] == "temp" else "fans"
                identifier = self.identity("temperature" if kind == "temperatures" else "fan", path)
                if identifier in seen[kind]:
                    continue
                seen[kind].add(identifier)
                if len(result[kind]) >= LIMIT:
                    result["omitted"][kind] += 1
                    continue
                unreadable_before_flags = self.unreadable
                fault = self.integer(chip / (prefix + "_fault"), high=1, optional=True)
                enabled = self.integer(chip / (prefix + "_enable"), high=1, optional=True)
                status = "fault" if fault == 1 else "disabled" if enabled == 0 else "unavailable" if self.unreadable != unreadable_before_flags else "available"
                value = None
                if status == "available":
                    value = self.integer(path, low=-273150 if kind == "temperatures" else 0,
                                         high=1_000_000)
                    if value is None:
                        status = "unavailable"
                row = {
                    "id": identifier,
                    "label": self.label(self.text(chip / (prefix + "_label"), optional=True),
                                        ("Temperature " if kind == "temperatures" else "Fan ") + match[2]),
                    "chip": chip_name,
                    "status": status,
                }
                if kind == "temperatures":
                    critical = self.integer(chip / (prefix + "_crit"), low=-273150, high=1_000_000, optional=True)
                    row.update(celsius=value / 1000 if value is not None else None,
                               criticalCelsius=critical / 1000 if critical is not None else None)
                else:
                    row["rpm"] = value
                result[kind].append(row)

    def gpus(self, result):
        seen = set()
        for card in self.entries(self.sys / "class/drm", re.compile(r"card[0-9]{1,6}\Z")):
            if self.clock() - self.began >= SCAN_SECONDS:
                self.limited = True
                break
            device = card / "device"
            if not device.exists():
                continue
            identifier = self.identity("gpu", device)
            if identifier in seen:
                continue
            seen.add(identifier)
            if len(result["gpus"]) >= LIMIT:
                result["omitted"]["gpus"] += 1
                continue
            vendor_id = self.text(device / "vendor", optional=True)
            vendor = VENDORS.get(vendor_id)
            try:
                driver_path = (device / "driver").resolve(strict=True)
                driver = self.label(driver_path.name, "Unknown") if driver_path.is_relative_to(self.sys) else None
            except (OSError, ValueError):
                driver = None
            utilization = used = total = None
            # These units and meanings are the amdgpu ABI, not generic DRM attributes.
            if driver == "amdgpu":
                utilization = self.integer(device / "gpu_busy_percent", high=100, optional=True)
                total = self.integer(device / "mem_info_vram_total", low=1, optional=True)
                used = self.integer(device / "mem_info_vram_used", optional=True)
                if used is not None and total is not None and used > total:
                    self.unreadable += 1
                    used = None
            result["gpus"].append({
                "id": identifier,
                "label": card.name,
                "vendor": vendor,
                "driver": driver,
                "utilizationPercent": utilization,
                "memoryUsedBytes": used,
                "memoryTotalBytes": total,
            })

    def collect(self):
        self.began = self.clock()
        self.limited = False
        self.unreadable = 0
        self.reads = 0
        self.scanned = 0
        result = {
            "available": True,
            "sampledAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "temperatures": [], "fans": [], "gpus": [],
            "omitted": {"temperatures": 0, "fans": 0, "gpus": 0}, "unavailable": [],
        }
        for name, groups in (("hwmon", ("temperatures", "fans")), ("gpus", ("gpus",))):
            try:
                getattr(self, name)(result)
            except (OSError, ValueError, OverflowError):
                result["unavailable"].extend(groups)
        result.update(limited=self.limited, unreadable=self.unreadable)
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
            now = self.clock()
            if not self.running and now - self.last_attempt >= 30:
                self.running = True
                self.last_attempt = now
                threading.Thread(target=self.refresh, daemon=True, name="orbis-host-sensors").start()
            if self.sample is None:
                return {"available": False, "reason": "Collecting sensor readings." if self.running else "Sensor readings are unavailable."}
            age = datetime.now(timezone.utc).timestamp() - datetime.fromisoformat(self.sample["sampledAt"].replace("Z", "+00:00")).timestamp()
            return {**self.sample, "stale": self.failed or age > 90}
