import importlib.util
import json
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SPEC = importlib.util.spec_from_file_location("orbis_host_telemetry", Path(__file__).with_name("orbis-host-telemetry.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class HostTelemetryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.proc, self.sys = self.root / "proc", self.root / "sys"
        self.usage = mock.Mock(return_value=SimpleNamespace(f_frsize=4096, f_bsize=4096, f_blocks=100, f_bfree=40, f_bavail=30))
        self.reader = MODULE.HostTelemetry(self.proc, self.sys, self.usage)
        self.put(self.proc / "self/mountinfo", "10 1 8:1 / / rw - ext4 /dev/secret-source rw,password=not-public\n11 1 0:1 / /proc rw - proc proc rw\n12 1 0:2 / /var/lib/docker/overlay2/test/merged rw - overlay overlay rw\n13 1 0:3 / /sys/fs/bpf rw - bpf bpf rw\n")
        self.put(self.sys / "class/net/eth0/ifindex", "2")
        self.put(self.sys / "class/net/eth0/operstate", "up")
        self.put(self.sys / "class/net/eth0/speed", "1000")
        self.put(self.sys / "class/block/sda/diskseq", "4")
        self.counters()

    def put(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def counters(self, received=1000, sent=2000, read=100, written=200, busy=400):
        self.put(self.proc / "net/dev", f"eth0: {received} 1 0 0 0 0 0 0 {sent} 1 0 0 0 0 0 0\nlo: 1 1 0 0 0 0 0 0 2 1 0 0 0 0 0 0\n")
        self.put(self.proc / "diskstats", f"8 0 sda 10 0 {read} 3 20 0 {written} 4 2 {busy} 20\n8 1 sda1 1 0 8 1 1 0 8 1 0 1 2\n7 0 loop0 1 0 8 1 1 0 8 1 0 1 2\n")
        self.put(self.sys / "class/block/sda1/partition", "1")

    def collect(self, now):
        with mock.patch.object(MODULE.time, "monotonic", return_value=now):
            return self.reader.collect()

    def test_battery_requires_one_present_physical_battery_and_valid_capacity(self):
        base = self.sys / "class/power_supply/BAT0"
        self.assertIsNone(self.reader.battery())
        for key, value in {"type": "Battery", "present": "1", "capacity": "19", "status": "Charging"}.items():
            self.put(base / key, value)
        self.assertEqual({key: self.collect(10)["battery"][key] for key in ("percent", "charging")}, {"percent": 19, "charging": True})
        self.put(base / "status", "Unknown")
        self.assertEqual({key: self.reader.battery()[key] for key in ("percent", "charging")}, {"percent": 19, "charging": None})
        self.put(base / "capacity", "101")
        self.assertIsNone(self.reader.battery())
        self.put(base / "capacity", "0")
        self.put(base / "present", "0")
        self.assertIsNone(self.reader.battery())
        self.put(base / "present", "1")
        other = self.sys / "class/power_supply/BAT1"
        for key, value in {"type": "Battery", "present": "1", "capacity": "80", "status": "Discharging"}.items():
            self.put(other / key, value)
        self.assertIsNone(self.reader.battery())
        for path, now, full in ((base, "100", "200"), (other, "600", "800")):
            self.put(path / "energy_now", now)
            self.put(path / "energy_full", full)
        self.assertEqual({key: self.reader.battery()[key] for key in ("percent", "charging")}, {"percent": 70, "charging": None})
        self.put(other / "energy_now", "801")
        self.assertIsNone(self.reader.battery())

    def test_peripheral_batteries_are_not_reported_as_host_power(self):
        peripheral = self.sys / "class/power_supply/mouse"
        for key, value in {"type": "Battery", "scope": "Device", "present": "1", "capacity": "95"}.items():
            self.put(peripheral / key, value)
        self.assertIsNone(self.reader.battery())
        host = self.sys / "class/power_supply/BAT0"
        for key, value in {"type": "Battery", "scope": "System", "present": "1", "capacity": "52", "status": "Discharging"}.items():
            self.put(host / key, value)
        self.assertEqual({key: self.reader.battery()[key] for key in ("percent", "charging")}, {"percent": 52, "charging": False})

    def test_battery_energy_health_power_and_remaining_time_use_kernel_units(self):
        base = self.sys / "class/power_supply/BAT0"
        for key, value in {"type": "Battery", "present": "1", "capacity": "76", "status": "Discharging",
                "energy_now": "38000000", "energy_full": "50000000", "energy_full_design": "62500000",
                "power_now": "10000000", "cycle_count": "173", "manufacturer": "Fixture", "model_name": "Laptop battery"}.items():
            self.put(base / key, value)
        sample = self.reader.battery()
        self.assertEqual(sample, {"percent": 76, "charging": False, "state": "discharging", "healthPercent": 80.0,
            "powerWatts": 10.0, "energyNowWh": 38.0, "energyFullWh": 50.0, "energyDesignWh": 62.5,
            "timeRemainingSeconds": 13680, "cycleCount": 173, "manufacturer": "Fixture", "model": "Laptop battery", "batteryCount": 1})
        self.put(base / "time_to_empty_now", "4200")
        self.assertEqual(self.reader.battery()["timeRemainingSeconds"], 4200)
        self.put(base / "status", "Full")
        self.assertIsNone(self.reader.battery()["timeRemainingSeconds"])

    def test_charge_only_driver_provides_health_and_estimate_without_inventing_energy(self):
        base = self.sys / "class/power_supply/BAT0"
        for key, value in {"type": "Battery", "status": "Discharging", "charge_now": "2000000", "charge_full": "4000000",
                "charge_full_design": "5000000", "current_now": "-1000000", "voltage_now": "12000000"}.items():
            self.put(base / key, value)
        sample = self.reader.battery()
        self.assertEqual(sample["percent"], 50)
        self.assertEqual(sample["healthPercent"], 80)
        self.assertEqual(sample["powerWatts"], 12)
        self.assertEqual(sample["timeRemainingSeconds"], 7200)
        self.assertIsNone(sample["energyNowWh"])
        self.assertIsNone(sample["energyFullWh"])
        self.put(base / "status", "Charging")
        self.assertEqual(self.reader.battery()["timeRemainingSeconds"], 7200)

    def test_optional_malformed_battery_details_do_not_hide_valid_charge(self):
        base = self.sys / "class/power_supply/BAT0"
        for key, value in {"type": "Battery", "capacity": "52", "status": "Unknown", "power_now": "NaN",
                "energy_full_design": "-1", "cycle_count": "-1", "model_name": "bad\nlabel"}.items():
            self.put(base / key, value)
        sample = self.reader.battery()
        self.assertEqual(sample["percent"], 52)
        self.assertIsNone(sample["charging"])
        for field in ("healthPercent", "powerWatts", "timeRemainingSeconds", "cycleCount", "model"):
            self.assertIsNone(sample[field])

    def test_multiple_batteries_do_not_invent_combined_discharge_or_health(self):
        for name, status, now in (("BAT0", "Charging", "25000000"), ("BAT1", "Discharging", "15000000")):
            base = self.sys / "class/power_supply" / name
            for key, value in {"type": "Battery", "capacity": "50", "status": status, "energy_now": now,
                    "energy_full": "40000000", "power_now": "10000000"}.items():
                self.put(base / key, value)
        sample = self.reader.battery()
        self.assertEqual(sample["percent"], 50)
        self.assertEqual(sample["batteryCount"], 2)
        self.assertEqual(sample["state"], "unknown")
        self.assertIsNone(sample["charging"])
        for field in ("powerWatts", "healthPercent", "timeRemainingSeconds", "cycleCount"):
            self.assertIsNone(sample[field])

    def test_host_scope_and_first_sample_do_not_invent_rates(self):
        sample = self.collect(10)
        self.assertTrue(sample["available"])
        self.assertEqual(sample["filesystems"], [{"mount": "/", "filesystem": "ext4", "sizeBytes": 409600, "usedBytes": 245760, "availableBytes": 122880, "readOnly": False}])
        self.usage.assert_called_once_with("/")
        self.assertEqual(len(sample["network"]), 1)
        self.assertEqual(sample["network"][0]["speedMbps"], 1000)
        self.assertIsNone(sample["network"][0]["rxBytesPerSecond"])
        self.assertEqual([d["device"] for d in sample["disks"]], ["sda"])
        self.assertEqual(sample["disks"][0]["readBytes"], 100 * 512)
        self.assertIsNone(sample["disks"][0]["busyPercent"])
        self.assertNotIn("secret", json.dumps(sample))
        self.assertNotIn("password", json.dumps(sample))

    def test_rates_use_actual_elapsed_time_and_kernel_sector_units(self):
        self.collect(10)
        self.counters(received=11000, sent=22000, read=300, written=600, busy=5400)
        sample = self.collect(20)
        self.assertEqual(sample["network"][0]["rxBytesPerSecond"], 1000)
        self.assertEqual(sample["network"][0]["txBytesPerSecond"], 2000)
        self.assertEqual(sample["disks"][0]["readBytesPerSecond"], 200 * 512 / 10)
        self.assertEqual(sample["disks"][0]["writeBytesPerSecond"], 400 * 512 / 10)
        self.assertEqual(sample["disks"][0]["busyPercent"], 50)

    def test_one_second_rates_do_not_repeat_filesystem_or_battery_probes(self):
        with mock.patch.object(self.reader, "battery", wraps=self.reader.battery) as battery:
            first = self.collect(10)
            self.assertIsNone(first["battery"])
            self.assertTrue(first["available"])
            self.counters(received=2000, sent=4000, read=110, written=220, busy=450)
            second = self.collect(11)
            self.assertEqual(second["network"][0]["rxBytesPerSecond"], 1000)
            self.assertEqual(second["network"][0]["txBytesPerSecond"], 2000)
            self.assertEqual(second["disks"][0]["readBytesPerSecond"], 10 * 512)
            self.assertEqual(second["disks"][0]["busyPercent"], 5)
            self.usage.assert_called_once()
            battery.assert_called_once()
            self.collect(20)
            self.assertEqual(self.usage.call_count, 2)
            self.assertEqual(battery.call_count, 2)

    def test_fast_samples_keep_counter_reset_gap_and_subsecond_guards(self):
        self.assertIsNone(MODULE.delta(2000, 1000, 0.1))
        self.assertEqual(MODULE.delta(2000, 1000, 1), 1000)
        self.assertIsNone(MODULE.delta(1, 1000, 1))
        self.assertIsNone(MODULE.delta(2000, 1000, 61))

    def test_read_admits_one_worker_near_each_second_and_coalesces_pending_reads(self):
        self.reader.sample = self.collect(10)
        self.reader.last_attempt = 10
        with mock.patch.object(MODULE.threading, "Thread") as worker:
            with mock.patch.object(MODULE.time, "monotonic", return_value=10.899):
                self.reader.read()
                worker.assert_not_called()
            with mock.patch.object(MODULE.time, "monotonic", return_value=10.901):
                for _ in range(100):
                    self.reader.read()
            worker.assert_called_once()
            worker.return_value.start.assert_called_once()

    def test_read_returns_new_counters_when_worker_finishes_within_budget(self):
        with mock.patch.object(MODULE.time, "monotonic", return_value=10):
            first = self.reader.read()
        self.assertTrue(first["available"])
        self.assertIsNone(first["network"][0]["rxBytesPerSecond"])
        self.counters(received=2000)
        with mock.patch.object(MODULE.time, "monotonic", return_value=11):
            second = self.reader.read()
        self.assertTrue(second["available"])
        self.assertGreater(second["sampledAt"], first["sampledAt"])
        self.assertEqual(second["network"][0]["rxBytesPerSecond"], 1000)

    def test_resets_replaced_devices_and_long_gaps_never_create_spikes(self):
        self.collect(10)
        self.counters(received=1, sent=1, read=1, written=1, busy=1)
        sample = self.collect(20)
        self.assertIsNone(sample["network"][0]["rxBytesPerSecond"])
        self.assertIsNone(sample["disks"][0]["readBytesPerSecond"])
        self.counters(received=1000, read=100)
        self.put(self.sys / "class/net/eth0/ifindex", "3")
        self.put(self.sys / "class/block/sda/diskseq", "5")
        sample = self.collect(30)
        self.assertIsNone(sample["network"][0]["rxBytesPerSecond"])
        self.assertIsNone(sample["disks"][0]["readBytesPerSecond"])
        sample = self.collect(100)
        self.assertIsNone(sample["disks"][0]["busyPercent"])

    def test_mount_escaping_partial_failures_and_limits(self):
        lines = [f"{n+10} 1 8:1 / /srv/disk{n} rw - ext4 /dev/private rw\n" for n in range(35)]
        lines[0] = "10 1 8:1 / /srv/a\\040drive ro - xfs /dev/private rw\n"
        self.put(self.proc / "self/mountinfo", "".join(lines))
        self.usage.side_effect = lambda mount: (_ for _ in ()).throw(OSError()) if mount == "/srv/disk1" else SimpleNamespace(f_frsize=4096, f_blocks=100, f_bfree=40, f_bavail=30)
        sample = self.collect(10)
        self.assertEqual(sample["omitted"]["filesystems"], 3)
        self.assertEqual(len(sample["filesystems"]), 31)
        self.assertEqual(self.usage.call_count, 32)
        self.assertEqual(sample["filesystems"][0]["mount"], "/srv/a drive")
        self.assertTrue(sample["filesystems"][0]["readOnly"])
        self.assertIn("filesystems", sample["unavailable"])

    def test_counter_file_limit_and_missing_sections_are_explicit(self):
        self.put(self.proc / "net/dev", "x" * (256 * 1024 + 1))
        (self.proc / "diskstats").unlink()
        sample = self.collect(10)
        self.assertTrue(sample["available"])
        self.assertEqual(sample["network"], [])
        self.assertEqual(sample["unavailable"], ["network", "disks"])

    def test_blocked_probe_has_one_worker_and_bounds_the_initiating_read(self):
        started, release, done = threading.Event(), threading.Event(), threading.Event()
        sample = self.collect(10)
        def blocked():
            started.set()
            release.wait(3)
            done.set()
            return sample
        with mock.patch.object(self.reader, "collect", side_effect=blocked) as collect:
            try:
                before_first = time.monotonic()
                first = self.reader.read()
                self.assertLess(time.monotonic() - before_first, 0.25)
                self.assertFalse(first["available"])
                self.assertTrue(started.wait(1))
                start = time.monotonic()
                with mock.patch.object(MODULE.time, "monotonic", return_value=start + 20):
                    for _ in range(100):
                        self.assertFalse(self.reader.read()["available"])
                self.assertLess(time.monotonic() - start, 0.2)
                collect.assert_called_once()
            finally:
                release.set()
                self.assertTrue(done.wait(1))

    def test_stale_previous_sample_is_never_reported_as_live(self):
        self.reader.sample = self.collect(10)
        self.reader.sample["sampledAt"] = (datetime.now(timezone.utc) - timedelta(seconds=40)).isoformat()
        self.reader.last_attempt = time.monotonic()
        self.assertTrue(self.reader.read()["stale"])


if __name__ == "__main__":
    unittest.main()
