"""Demand-only SMART collection and explicit, non-captive disk self-tests."""

import hashlib
import json
import os
import re
import stat
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

MAX_BYTES = 2 * 1024 * 1024
MAX_DRIVES = 32
MAX_PROBES = 4
DEVICE = re.compile(r"/dev/(?:sd[a-z]{1,3}|hd[a-z]|nvme[0-9]{1,4}(?:n[0-9]{1,4})?)\Z")
DRIVER = re.compile(r"(?:ata|scsi|sat(?:,[0-9]{1,2})?|nvme(?:,[0-9]{1,4})?|sntasmedia|sntjmicron|sntrealtek)\Z")
SAFE = 2**53 - 1


def text(value, fallback="Unavailable", limit=128):
    return " ".join("".join(c if c.isprintable() else " " for c in str(value or "")).split())[:limit] or fallback


def number(value, low=0, high=SAFE):
    return value if type(value) in (int, float) and low <= value <= high else None


def obj(value):
    return value if isinstance(value, dict) else {}


def entries(value):
    return value if isinstance(value, list) else []


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def identity(data, device):
    serial = data.get("serial_number") or json.dumps(data.get("wwn") or {}, sort_keys=True)
    stable = bool(serial and serial != "{}")
    material = [data.get("model_name") or data.get("product"), serial if stable else device]
    return "drive:" + hashlib.sha256(json.dumps(material).encode()).hexdigest()[:24], stable


def parse_drive(data, device, sampled_at):
    identifier, stable = identity(data, device)
    nvme = obj(data.get("nvme_smart_health_information_log"))
    ata = obj(data.get("ata_smart_data"))
    rows = obj(data.get("ata_smart_attributes")).get("table", [])
    rows = rows[:64] if isinstance(rows, list) else []
    attributes = []
    for row in rows:
        if not isinstance(row, dict) or type(row.get("id")) is not int:
            continue
        attributes.append({"id": row["id"], "name": text(row.get("name")), "value": number(row.get("value")),
                           "worst": number(row.get("worst")), "threshold": number(row.get("thresh")),
                           "raw": text(obj(row.get("raw")).get("string", obj(row.get("raw")).get("value")), "Unavailable", 64),
                           "failing": row.get("when_failed") in ("now", "past")})

    def sector(identifier, name):
        # Raw ATA units are vendor-specific. Only report recognized sector counters.
        for row in rows:
            if isinstance(row, dict) and row.get("id") == identifier and name in str(row.get("name", "")).lower():
                return number(obj(row.get("raw")).get("value"))
        return None

    pending = sector(197, "pending")
    reallocated = sector(5, "reallocated")
    uncorrectable = sector(198, "uncorrect")
    media_errors = number(nvme.get("media_errors"))
    used = number(obj(data.get("endurance_used")).get("current_percent", nvme.get("percentage_used")), high=255)
    spare = number(nvme.get("available_spare"), high=100)
    spare_threshold = number(nvme.get("available_spare_threshold"), high=100)
    reasons = []
    passed = obj(data.get("smart_status")).get("passed")
    health = "passed" if passed is True else "failed" if passed is False else "unavailable"
    code = obj(data.get("smartctl")).get("exit_status", 0)
    if type(code) is not int:
        code = 0
    power_mode = obj(data.get("power_mode"))
    sleeping = (code == 3 and not obj(data.get("smart_status"))) or str(power_mode.get("name", power_mode.get("string", ""))).lower().startswith(("standby", "sleep"))
    if sleeping:
        health = "sleeping"
        reasons.append("Sleeping; automatic checks do not wake this drive.")
    elif code == 5 and not obj(data.get("smart_status")):
        health = "unavailable"
        reasons.append("Power state detection is unsupported. Automatic SMART reads were skipped.")
    elif code & 3:
        health = "unavailable"
        reasons.append("The device could not be read. Check SMART support and host permissions.")
    elif health == "failed":
        reasons.append("The drive reports a failing SMART health check. Back up important data.")
    elif health == "unavailable":
        reasons.append("This device did not provide an overall SMART health result.")
    if number(nvme.get("critical_warning"), high=255):
        health = "failed"
        reasons.append("NVMe critical warning is active. Review the drive and back up important data.")
    if used is not None and used >= 100:
        reasons.append("The estimated endurance rating has been reached.")
    if spare is not None and spare_threshold is not None and spare < spare_threshold:
        reasons.append("Available spare capacity is below the drive threshold.")
    for value, label in ((pending, "Pending sectors"), (uncorrectable, "Uncorrectable sectors"),
                         (reallocated, "Reallocated sectors"), (media_errors, "Media/data integrity errors")):
        if value:
            reasons.append(f"{label}: {value:,.0f}.")
    if any(row["failing"] for row in attributes):
        reasons.append("A SMART attribute has crossed its manufacturer threshold.")
    if code & 4:
        reasons.append("Some SMART commands were not supported; readings may be incomplete.")
    if code & 64:
        reasons.append("The drive error log contains historical errors.")
    if code & 128:
        reasons.append("The self-test log contains a previous failed test.")
    if reasons and health == "passed":
        health = "warning"
    self_test = obj(ata.get("self_test"))
    status = obj(self_test.get("status"))
    nvme_test = obj(data.get("nvme_self_test_log"))
    operation = obj(nvme_test.get("current_self_test_operation"))
    running = status.get("value", 0) in range(240, 256) or bool(number(operation.get("value"), low=1, high=15))
    supported = stable and (obj(ata.get("capabilities")).get("self_tests_supported") is True
                            or obj(data.get("nvme_optional_admin_commands")).get("self_test") is True)
    polling = obj(self_test.get("polling_minutes"))
    remaining = number(status.get("remaining_percent"), high=100)
    completed = number(nvme_test.get("current_self_test_completion_percent"), high=100)
    if remaining is None and completed is not None:
        remaining = 100 - completed
    tests = []
    ata_logs = obj(data.get("ata_smart_self_test_log"))
    logs = (entries(obj(ata_logs.get("extended")).get("table"))
            or entries(obj(ata_logs.get("standard")).get("table"))
            or entries(nvme_test.get("table")))
    for row in logs[:10]:
        if not isinstance(row, dict):
            continue
        result = obj(row.get("status"))
        if result:
            passed_test = result.get("passed") if type(result.get("passed")) is bool else None
        else:
            result = obj(row.get("self_test_result"))
            result_code = result.get("value")
            passed_test = (result_code == 0 if result_code in (0, 5, 6, 7) else None) if type(result_code) is int else None
        tests.append({"type": text(obj(row.get("type")).get("string") or obj(row.get("self_test_code")).get("string")),
                      "status": text(result.get("string")), "passed": passed_test,
                      "hours": number(row.get("lifetime_hours", row.get("power_on_hours")))})
    errors = []
    ata_errors = obj(data.get("ata_smart_error_log"))
    extended_errors, summary_errors = obj(ata_errors.get("extended")), obj(ata_errors.get("summary"))
    error_rows = entries(extended_errors.get("table")) or entries(summary_errors.get("table"))
    for entry in error_rows[:20]:
        if isinstance(entry, dict):
            errors.append({"summary": text(entry.get("error_description"), "ATA error recorded", 256),
                           "hours": number(entry.get("lifetime_hours"))})
    for entry in entries(obj(data.get("nvme_error_information_log")).get("table"))[:20 - len(errors)]:
        if isinstance(entry, dict) and number(entry.get("error_count"), low=1):
            status = obj(entry.get("status_field"))
            errors.append({"summary": text(status.get("string"), "NVMe command error recorded", 256), "hours": None})
    return {
        "id": identifier, "device": device, "model": text(data.get("model_name") or data.get("product"), device),
        "firmware": text(data.get("firmware_version"), "") or None,
        "protocol": text(obj(data.get("device")).get("protocol"), "Unknown"),
        "capacityBytes": number(obj(data.get("user_capacity")).get("bytes", data.get("nvme_total_capacity"))),
        "health": health, "reasons": reasons[:12], "sampledAt": sampled_at,
        "temperature": number(obj(data.get("temperature")).get("current"), -100, 300),
        "powerOnHours": number(obj(data.get("power_on_time")).get("hours", nvme.get("power_on_hours"))),
        "percentageUsed": used, "availableSpare": spare, "spareThreshold": spare_threshold,
        "reallocatedSectors": reallocated, "pendingSectors": pending, "uncorrectableSectors": uncorrectable,
        "mediaErrors": media_errors, "errorCount": number(nvme.get("num_err_log_entries", extended_errors.get("count", summary_errors.get("count")))),
        "unsafeShutdowns": number(nvme.get("unsafe_shutdowns")),
        "bytesRead": number(nvme.get("data_units_read", -1) * 512000) if type(nvme.get("data_units_read")) is int else None,
        "bytesWritten": number(nvme.get("data_units_written", -1) * 512000) if type(nvme.get("data_units_written")) is int else None,
        "selfTest": {"supported": supported, "running": running,
                     "remainingPercent": remaining if running else None,
                     "shortMinutes": number(polling.get("short")), "extendedMinutes": number(polling.get("extended"))},
        "tests": tests, "errors": errors, "attributes": attributes, "history": [],
    }


class DriveHealth:
    def __init__(self, state_dir, clock=time.monotonic):
        self.state_dir, self.clock = Path(state_dir), clock
        self.lock = threading.Lock()
        self.sample = None
        self.devices = {}
        self.running = False
        self.failed = False
        self.last_attempt = float("-inf")
        self.last_test = float("-inf")

    @staticmethod
    def executable():
        for path in ("/usr/sbin/smartctl", "/usr/bin/smartctl", "/sbin/smartctl"):
            try:
                info = Path(path).stat()
                if stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and os.access(path, os.X_OK):
                    return path
            except OSError:
                pass
        raise ValueError("Install smartmontools on the host to read drive health.")

    def command(self, arguments):
        with tempfile.TemporaryFile() as output:
            process = subprocess.Popen([self.executable(), *arguments], stdout=output, stderr=subprocess.DEVNULL,
                                       stdin=subprocess.DEVNULL, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
            deadline = self.clock() + 10
            try:
                while process.poll() is None:
                    if self.clock() >= deadline or os.fstat(output.fileno()).st_size > MAX_BYTES:
                        raise ValueError("The drive did not return a bounded SMART response in time.")
                    time.sleep(0.05)
                if os.fstat(output.fileno()).st_size > MAX_BYTES:
                    raise ValueError("The SMART response exceeded its limit.")
                output.seek(0)
                data = json.loads(output.read(MAX_BYTES + 1))
                if not isinstance(data, dict):
                    raise ValueError("The drive returned an invalid SMART response.")
                return data
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()

    @staticmethod
    def valid_device(path):
        try:
            return bool(DEVICE.fullmatch(path) and stat.S_ISBLK(os.lstat(path).st_mode))
        except OSError:
            return False

    def scan(self):
        data = self.command(["--scan", "-j"])
        devices = data.get("devices")
        if not isinstance(devices, list):
            raise ValueError("The host could not enumerate SMART devices.")
        result = []
        for row in devices[:128]:
            if isinstance(row, dict) and self.valid_device(str(row.get("name", ""))) and DRIVER.fullmatch(str(row.get("type", ""))):
                result.append((row["name"], row["type"]))
        return sorted(set(result)), len(devices) > len(result)

    def collect(self):
        devices, limited = self.scan()
        stamp, rows, mapping = now(), [], {}
        previous = {row["device"]: row for row in (self.sample or {}).get("drives", [])}
        def probe(target):
            device, driver = target
            try:
                data = self.command(["-j", "-x", "-n", "standby,3,5", "-d", driver, device])
                row = parse_drive(data, device, stamp)
                known = previous.get(device)
                if known and not identity(data, device)[1] and row["health"] in ("sleeping", "unavailable"):
                    for key in ("id", "model", "firmware", "capacityBytes", "protocol"):
                        row[key] = known[key]
                    row["selfTest"]["supported"] = known["selfTest"]["supported"]
                return row, target
            except (OSError, ValueError, subprocess.SubprocessError):
                row = parse_drive({}, device, stamp)
                row["reasons"] = ["SMART readings could not be retrieved from this device."]
                return row, None

        with ThreadPoolExecutor(max_workers=MAX_PROBES, thread_name_prefix="orbis-smart") as pool:
            for row, target in pool.map(probe, devices[:MAX_DRIVES]):
                # Deduplicate namespaces that report the same controller-wide identity.
                if row["id"] in mapping:
                    continue
                if target is not None:
                    mapping[row["id"]] = target
                rows.append(row)
        history_available = self.history(rows)
        with self.lock:
            self.devices = mapping
        return {"available": True, "sampledAt": stamp, "stale": False, "limited": limited or len(devices) > MAX_DRIVES,
                "historyAvailable": history_available, "drives": rows}

    def history(self, rows):
        path = self.state_dir / "drive-health-history.json"
        try:
            saved = {}
            if path.exists():
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(descriptor) as source:
                    if not stat.S_ISREG(os.fstat(source.fileno()).st_mode) or os.fstat(source.fileno()).st_size > 2 * MAX_BYTES:
                        raise ValueError("Invalid drive history")
                    saved = json.load(source)
                if not isinstance(saved, dict):
                    raise ValueError("Invalid drive history")
            cutoff = time.time() - 7 * 86400
            active = {key: points[-168:] for key, points in saved.items() if re.fullmatch(r"drive:[a-f0-9]{24}", key) and isinstance(points, list) and points
                      and isinstance(points[-1], dict) and isinstance(points[-1].get("at"), str)
                      and datetime.fromisoformat(points[-1]["at"].replace("Z", "+00:00")).timestamp() >= cutoff}
            for row in rows:
                points = saved.get(row["id"], [])
                points = [p for p in points[-168:] if isinstance(p, dict) and isinstance(p.get("at"), str)
                          and datetime.fromisoformat(p["at"].replace("Z", "+00:00")).timestamp() >= cutoff]
                point = {"at": row["sampledAt"], **{key: row[key] for key in ("health", "temperature", "percentageUsed", "pendingSectors", "mediaErrors")}}
                if points and points[-1]["at"][:13] == point["at"][:13]:
                    previous = points[-1]
                    severity = {"sleeping": 0, "passed": 1, "unavailable": 2, "warning": 3, "failed": 4}
                    point["health"] = max((previous["health"], point["health"]), key=lambda health: severity[health])
                    for key in ("temperature", "percentageUsed", "pendingSectors", "mediaErrors"):
                        values = [number(value, low=-100 if key == "temperature" else 0) for value in (previous.get(key), point[key])]
                        point[key] = max((value for value in values if value is not None), default=None)
                    points[-1] = point
                else:
                    points.append(point)
                row["history"] = points[-168:]
                active[row["id"]] = row["history"]
            descriptor, temporary = tempfile.mkstemp(prefix="drive-history-", dir=self.state_dir)
            try:
                with os.fdopen(descriptor, "w") as target:
                    retained = sorted(active.items(), key=lambda item: item[1][-1]["at"], reverse=True)[:64]
                    json.dump(dict(retained), target, separators=(",", ":"))
                    target.flush()
                    os.fsync(target.fileno())
                os.replace(temporary, path)
            finally:
                Path(temporary).unlink(missing_ok=True)
            return True
        except (OSError, ValueError, TypeError, KeyError, OverflowError):
            return False

    def refresh(self):
        try:
            sample = self.collect()
            with self.lock:
                self.sample, self.failed = sample, False
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            with self.lock:
                self.failed = True
                if self.sample is None:
                    self.sample = {"available": False, "reason": str(error) if isinstance(error, ValueError) else "Drive readings are unavailable."}
        finally:
            with self.lock:
                self.running = False

    def read(self):
        with self.lock:
            if not self.running and self.clock() - self.last_attempt >= 60:
                self.running = True
                self.last_attempt = self.clock()
                threading.Thread(target=self.refresh, daemon=True, name="orbis-drive-health").start()
            if self.sample is None:
                return {"available": False, "reason": "Collecting drive health readings."}
            if not self.sample["available"]:
                return self.sample.copy()
            age = time.time() - datetime.fromisoformat(self.sample["sampledAt"].replace("Z", "+00:00")).timestamp()
            return {**self.sample, "stale": self.sample.get("stale", False) or self.failed or age > 180}

    def start_test(self, identifier, kind):
        if not isinstance(identifier, str) or not re.fullmatch(r"drive:[a-f0-9]{24}", identifier) or kind not in ("short", "extended", "abort"):
            raise ValueError("Choose a drive and a supported self-test.")
        with self.lock:
            if self.running or self.clock() - self.last_test < 5:
                raise ValueError("A drive operation is in progress. Wait and try again.")
            target = self.devices.get(identifier)
            if target is None:
                raise ValueError("Refresh drive health before starting a self-test.")
            self.running = True
        try:
            device, driver = target
            if (device, driver) not in self.scan()[0] or not self.valid_device(device):
                raise ValueError("The selected drive is no longer connected.")
            current = parse_drive(self.command(["-j", "-i", "-H", "-c", "-l", "selftest", "-d", driver, device]), device, now())
            if current["id"] != identifier or not current["selfTest"]["supported"] or current["health"] == "unavailable":
                raise ValueError("The drive changed or does not support self-tests. Refresh its readings.")
            if kind != "abort" and current["selfTest"]["running"]:
                raise ValueError("A self-test is already running on this drive.")
            if kind == "abort" and not current["selfTest"]["running"]:
                raise ValueError("This drive has no running self-test to stop.")
            arguments = ["-X"] if kind == "abort" else ["-t", "long" if kind == "extended" else "short"]
            result = self.command(["-j", *arguments, "-d", driver, device])
            code = obj(result.get("smartctl")).get("exit_status")
            if type(code) is not int or code & 7:
                raise ValueError("The drive did not accept the self-test request.")
            with self.lock:
                self.last_attempt = float("-inf")
                self.last_test = self.clock()
                if self.sample and self.sample.get("available"):
                    self.sample = {**self.sample, "stale": True}
            return {"accepted": True, "message": "Self-test stop requested." if kind == "abort" else "Self-test started. The drive will record its result."}
        finally:
            with self.lock:
                self.running = False
