import importlib.util
import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("orbis_host_sensors", Path(__file__).with_name("orbis-host-sensors.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Clock:
    def __init__(self):
        self.now = 0

    def __call__(self):
        return self.now


class HostSensorsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.sys = self.root / "sys"
        self.sys.mkdir()
        self.clock = Clock()
        self.reader = MODULE.HostSensors(self.sys, clock=self.clock)

    @staticmethod
    def put(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(str(value))
        return path

    def chip(self, name="hwmon0"):
        path = self.sys / "class/hwmon" / name
        self.put(path / "name", "Test chip")
        return path

    def gpu(self, number=0, driver="amdgpu", vendor="0x1002"):
        device = self.sys / "devices/pci" / str(number)
        self.put(device / "vendor", vendor)
        target = self.sys / "bus/pci/drivers" / driver
        target.mkdir(parents=True, exist_ok=True)
        (device / "driver").symlink_to(target, target_is_directory=True)
        card = self.sys / "class/drm" / ("card" + str(number))
        card.mkdir(parents=True, exist_ok=True)
        (card / "device").symlink_to(device, target_is_directory=True)
        return device

    def test_absent_hardware_is_available_empty_not_failed(self):
        sample = self.reader.collect()
        self.assertTrue(sample["available"])
        self.assertEqual([sample[key] for key in ("temperatures", "fans", "gpus")], [[], [], []])
        self.assertEqual(sample["unavailable"], [])
        self.assertEqual(sample["unreadable"], 0)
        self.assertFalse(sample["limited"])

    def test_temperature_is_millidegrees_and_fan_zero_is_a_measurement(self):
        chip = self.chip()
        self.put(chip / "temp1_input", "-12500\n")
        self.put(chip / "temp1_crit", "97500\n")
        self.put(chip / "temp1_label", "CPU package")
        self.put(chip / "fan1_input", "0\n")
        sample = self.reader.collect()
        self.assertEqual(sample["temperatures"][0]["celsius"], -12.5)
        self.assertEqual(sample["temperatures"][0]["criticalCelsius"], 97.5)
        self.assertEqual(sample["temperatures"][0]["label"], "CPU package")
        self.assertEqual(sample["fans"][0]["rpm"], 0)
        self.assertEqual(sample["fans"][0]["status"], "available")

    def test_fault_and_disabled_channels_do_not_publish_the_input(self):
        chip = self.chip()
        for prefix, flag, value in [("temp1", "fault", 1), ("fan1", "enable", 0)]:
            self.put(chip / (prefix + "_input"), 50000)
            self.put(chip / (prefix + "_" + flag), value)
        sample = self.reader.collect()
        self.assertEqual(sample["temperatures"][0]["status"], "fault")
        self.assertIsNone(sample["temperatures"][0]["celsius"])
        self.assertEqual(sample["fans"][0]["status"], "disabled")
        self.assertIsNone(sample["fans"][0]["rpm"])

    def test_present_but_invalid_status_flags_never_look_healthy(self):
        chip = self.chip()
        self.put(chip / "temp1_input", 45000)
        for flag, value in [("fault", "private fault"), ("fault", "2"), ("enable", "-1"), ("enable", "2")]:
            with self.subTest(flag=flag, value=value):
                target = self.put(chip / ("temp1_" + flag), value)
                sample = self.reader.collect()
                self.assertEqual(sample["temperatures"][0]["status"], "unavailable")
                self.assertIsNone(sample["temperatures"][0]["celsius"])
                self.assertGreater(sample["unreadable"], 0)
                target.unlink()

    def test_invalid_values_and_units_stay_unavailable(self):
        chip = self.chip()
        for name, value in [("temp1_input", "NaN"), ("temp2_input", "42000.5"), ("temp3_input", "-273151"),
                            ("temp4_input", "1000001"), ("temp5_input", "0x123"), ("fan1_input", "-1"),
                            ("fan2_input", "1000001"), ("fan3_input", "1e3")]:
            self.put(chip / name, value)
        sample = self.reader.collect()
        self.assertEqual(len(sample["temperatures"]), 5)
        self.assertEqual(len(sample["fans"]), 3)
        self.assertTrue(all(row["status"] == "unavailable" and row["celsius"] is None for row in sample["temperatures"]))
        self.assertTrue(all(row["status"] == "unavailable" and row["rpm"] is None for row in sample["fans"]))
        self.assertGreaterEqual(sample["unreadable"], 8)

    def test_boundary_temperatures_and_safe_zero_are_preserved(self):
        chip = self.chip()
        for number, value in enumerate([-273150, 0, 1000000], 1):
            self.put(chip / f"temp{number}_input", value)
        self.assertEqual([row["celsius"] for row in self.reader.collect()["temperatures"]], [-273.15, 0, 1000])

    def test_oversized_and_invalid_utf8_attributes_are_not_numeric(self):
        chip = self.chip()
        self.put(chip / "temp1_input", "1" * 257)
        (chip / "temp2_input").write_bytes(b"\xff")
        sample = self.reader.collect()
        self.assertTrue(all(row["celsius"] is None for row in sample["temperatures"]))
        self.assertEqual(sample["unreadable"], 2)

    def test_labels_are_bounded_printable_and_no_other_files_or_commands_are_used(self):
        chip = self.chip()
        self.put(chip / "temp1_input", 45000)
        self.put(chip / "temp1_label", "CPU\n\x1b\u202e\u200b" + "x" * 200)
        secret = "RAW_SERIAL_BOOT_MAC_PRIVATE_SENTINEL"
        for name in ("serial", "uevent", "mac_address", "boot_id", "temp1_max_alarm"):
            self.put(chip / name, secret)
        before = {path: path.read_bytes() for path in chip.iterdir()}
        with mock.patch.object(subprocess, "run", side_effect=AssertionError("No commands")), \
             mock.patch.object(subprocess, "Popen", side_effect=AssertionError("No commands")), \
             mock.patch.object(os, "system", side_effect=AssertionError("No shell")):
            sample = self.reader.collect()
        label = sample["temperatures"][0]["label"]
        self.assertTrue(0 < len(label) <= 128 and all(character.isprintable() for character in label))
        self.assertNotIn(secret, json.dumps(sample))
        self.assertEqual(before, {path: path.read_bytes() for path in chip.iterdir()})
        self.assertEqual(set(sample["temperatures"][0]), {"id", "label", "chip", "status", "celsius", "criticalCelsius"})

    def test_symlink_input_escape_is_unavailable_and_does_not_read_private_value(self):
        chip = self.chip()
        outside = self.put(self.root / "private", 95000)
        (chip / "temp1_input").symlink_to(outside)
        sample = self.reader.collect()
        self.assertEqual(sample["temperatures"], [])
        self.assertIn("temperatures", sample["unavailable"])

    def test_escaped_chip_directory_is_failed_coverage_not_absent_hardware(self):
        chip = self.root / "private-chip"
        self.put(chip / "temp1_input", 95000)
        directory = self.sys / "class/hwmon"
        directory.mkdir(parents=True)
        (directory / "hwmon0").symlink_to(chip, target_is_directory=True)
        sample = self.reader.collect()
        self.assertEqual(sample["temperatures"], [])
        self.assertIn("temperatures", sample["unavailable"])
        self.assertIn("fans", sample["unavailable"])

    def test_fifo_attribute_cannot_hold_the_sampler_worker(self):
        chip = self.chip()
        fifo = chip / "temp1_input"
        os.mkfifo(fifo)
        done = threading.Event()
        output = []
        def collect():
            try:
                output.append(self.reader.collect())
            finally:
                done.set()
        worker = threading.Thread(target=collect, daemon=True)
        worker.start()
        completed = done.wait(0.3)
        if not completed:
            # Release only the disposable fixture FIFO before reporting failure.
            descriptor = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
            os.close(descriptor)
        worker.join(1)
        self.assertFalse(worker.is_alive(), "Fixture worker must be cleaned up")
        self.assertTrue(completed, "A FIFO read exceeded the nonblocking sensor budget")
        self.assertIsNone(output[0]["temperatures"][0]["celsius"])

    def test_internal_hwmon_aliases_have_one_stable_physical_channel_id(self):
        physical = self.sys / "devices/pci/chip"
        self.put(physical / "name", "Physical CPU")
        self.put(physical / "temp1_input", 45000)
        directory = self.sys / "class/hwmon"
        directory.mkdir(parents=True)
        (directory / "hwmon0").symlink_to(physical, target_is_directory=True)
        first = self.reader.collect()["temperatures"][0]
        (directory / "hwmon0").rename(directory / "hwmon8")
        (directory / "hwmon1").symlink_to(physical, target_is_directory=True)
        rows = self.reader.collect()["temperatures"]
        self.assertEqual(len(rows), 1, "Aliases must not duplicate the same physical sensor")
        self.assertEqual(rows[0]["id"], first["id"])
        self.assertRegex(rows[0]["id"], r"^temperature:[a-f0-9]{16}$")
        self.assertNotIn(str(self.sys), rows[0]["id"])

    def test_omitted_hwmon_channels_are_not_counted_again_through_aliases(self):
        chip = self.chip()
        for number in range(1, 41):
            self.put(chip / f"temp{number}_input", 45000)
        for number in range(900, 908):
            (chip / f"temp{number}_input").symlink_to(chip / "temp9_input")
        sample = self.reader.collect()
        self.assertEqual(len(sample["temperatures"]), 32)
        self.assertEqual(sample["omitted"]["temperatures"], 8)

    def test_amdgpu_fixed_abi_has_actual_percentage_and_byte_units(self):
        device = self.gpu()
        self.put(device / "gpu_busy_percent", 0)
        self.put(device / "mem_info_vram_total", 16 * 1024**3)
        self.put(device / "mem_info_vram_used", 3 * 1024**3)
        gpu = self.reader.collect()["gpus"][0]
        self.assertEqual(gpu["vendor"], "AMD")
        self.assertEqual(gpu["driver"], "amdgpu")
        self.assertEqual(gpu["utilizationPercent"], 0)
        self.assertEqual(gpu["memoryTotalBytes"], 16 * 1024**3)
        self.assertEqual(gpu["memoryUsedBytes"], 3 * 1024**3)
        self.assertRegex(gpu["id"], r"^gpu:[a-f0-9]{16}$")

    def test_other_drm_drivers_never_borrow_amdgpu_attribute_meanings(self):
        for number, (driver, vendor) in enumerate([("nvidia", "0x10de"), ("i915", "0x8086"), ("virtio_gpu", "0x1af4")]):
            device = self.gpu(number, driver, vendor)
            for field in ("gpu_busy_percent", "mem_info_vram_total", "mem_info_vram_used"):
                self.put(device / field, 10)
        rows = self.reader.collect()["gpus"]
        self.assertEqual([row["vendor"] for row in rows], ["NVIDIA", "Intel", "Virtio"])
        self.assertTrue(all(row[field] is None for row in rows for field in ("utilizationPercent", "memoryUsedBytes", "memoryTotalBytes")))

    def test_gpu_impossible_metrics_are_null_without_hiding_identity(self):
        device = self.gpu()
        self.put(device / "gpu_busy_percent", 101)
        self.put(device / "mem_info_vram_total", 100)
        self.put(device / "mem_info_vram_used", 101)
        row = self.reader.collect()["gpus"][0]
        self.assertEqual(row["driver"], "amdgpu")
        self.assertIsNone(row["utilizationPercent"])
        self.assertIsNone(row["memoryUsedBytes"])
        self.assertEqual(row["memoryTotalBytes"], 100)

    def test_drm_aliases_are_deduplicated_by_physical_device(self):
        device = self.gpu()
        card = self.sys / "class/drm/card1"
        card.mkdir()
        (card / "device").symlink_to(device, target_is_directory=True)
        rows = self.reader.collect()["gpus"]
        self.assertEqual(len(rows), 1, "DRM aliases must not emit duplicate IDs rejected by the API")

    def test_drm_omitted_count_is_physical_devices_not_aliases_after_the_row_limit(self):
        devices = [self.gpu(number, driver="i915", vendor="0x8086") for number in range(32)]
        for number in range(900, 908):
            card = self.sys / "class/drm" / f"card{number}"
            card.mkdir()
            (card / "device").symlink_to(devices[0], target_is_directory=True)
        sample = self.reader.collect()
        self.assertEqual(len(sample["gpus"]), 32)
        self.assertEqual(sample["omitted"]["gpus"], 0, "Aliases are not omitted physical GPUs")

    def test_gpu_output_limit_reports_additional_actual_devices(self):
        devices = [self.gpu(number, driver="i915", vendor="0x8086") for number in range(40)]
        for number in range(900, 908):
            card = self.sys / "class/drm" / f"card{number}"
            card.mkdir()
            (card / "device").symlink_to(devices[39], target_is_directory=True)
        sample = self.reader.collect()
        self.assertEqual(len(sample["gpus"]), 32)
        self.assertEqual(sample["omitted"]["gpus"], 8)

    def test_failed_directory_scan_is_distinct_from_missing_hardware(self):
        (self.sys / "class/hwmon").mkdir(parents=True)
        (self.sys / "class/drm").mkdir(parents=True)
        with mock.patch.object(MODULE.os, "scandir", side_effect=PermissionError("private failure")):
            sample = self.reader.collect()
        self.assertEqual(set(sample["unavailable"]), {"temperatures", "fans", "gpus"})
        self.assertNotIn("private failure", json.dumps(sample))

    def test_escaped_gpu_device_does_not_publish_host_identity_or_private_metrics(self):
        device = self.root / "private-gpu"
        self.put(device / "vendor", "0x1002")
        self.put(device / "gpu_busy_percent", 95)
        card = self.sys / "class/drm/card0"
        card.mkdir(parents=True)
        (card / "device").symlink_to(device, target_is_directory=True)
        sample = self.reader.collect()
        self.assertEqual(sample["gpus"], [])
        self.assertEqual(sample["unavailable"], ["gpus"])

    def test_connectors_and_render_nodes_are_not_additional_physical_gpus(self):
        device = self.gpu()
        for name in ("card0-DP-1", "card0-HDMI-A-1", "renderD128"):
            directory = self.sys / "class/drm" / name
            directory.mkdir()
            (directory / "device").symlink_to(device, target_is_directory=True)
        self.assertEqual(len(self.reader.collect()["gpus"]), 1)

    def test_unreadable_flag_cannot_expose_an_available_numeric_reading(self):
        chip = self.chip()
        self.put(chip / "temp1_input", 45000)
        (chip / "temp1_fault").mkdir()
        sample = self.reader.collect()
        self.assertEqual(sample["temperatures"][0]["status"], "unavailable")
        self.assertIsNone(sample["temperatures"][0]["celsius"])
        self.assertGreater(sample["unreadable"], 0)

    def test_output_and_directory_work_are_bounded(self):
        chip = self.chip()
        for number in range(1, 41):
            self.put(chip / f"temp{number}_input", 45000)
            self.put(chip / f"fan{number}_input", 1000)
        sample = self.reader.collect()
        self.assertEqual(len(sample["temperatures"]), 32)
        self.assertEqual(len(sample["fans"]), 32)
        self.assertEqual(sample["omitted"]["temperatures"], 8)
        self.assertEqual(sample["omitted"]["fans"], 8)
        for number in range(600):
            self.put(chip / f"irrelevant{number}", "private")
        self.assertTrue(self.reader.collect()["limited"])

    def test_scan_deadline_stops_new_work(self):
        chip = self.chip()
        for number in range(1, 20):
            self.put(chip / f"temp{number}_input", 45000)
        now = [0]
        def elapsed():
            now[0] += 0.1
            return now[0]
        self.reader.clock = elapsed
        sample = self.reader.collect()
        self.assertTrue(sample["limited"])
        self.assertLess(len(sample["temperatures"]), 19)

    def test_low_level_attribute_work_stops_after_the_shared_read_budget(self):
        chip = self.chip()
        attribute = self.put(chip / "temp1_input", 45000)
        original = os.open
        with mock.patch.object(MODULE.os, "open", wraps=original) as opened:
            values = [self.reader.text(attribute) for _ in range(2100)]
        self.assertLessEqual(opened.call_count, 2048)
        self.assertIsNone(values[-1])
        self.assertTrue(self.reader.limited)

    def test_many_chip_directories_share_a_bounded_total_scan(self):
        for number in range(80):
            chip = self.chip(f"hwmon{number}")
            for entry in range(64):
                self.put(chip / f"unrelated{entry}", "private")
        original = os.scandir
        visited = [0]
        class CountedEntries:
            def __init__(self, path):
                self.entries = original(path)
            def __enter__(self):
                return self
            def __exit__(self, *_):
                self.entries.close()
            def __iter__(self):
                return self
            def __next__(self):
                entry = next(self.entries)
                visited[0] += 1
                return entry
        with mock.patch.object(MODULE.os, "scandir", side_effect=CountedEntries):
            sample = self.reader.collect()
        self.assertTrue(sample["limited"])
        self.assertLessEqual(visited[0], 4300, "Scanning must stop globally rather than visiting every chip's full directory")

    def test_one_blocked_worker_never_blocks_or_multiplies_readers(self):
        started, release, done = threading.Event(), threading.Event(), threading.Event()
        sample = self.reader.collect()
        def blocked():
            started.set()
            release.wait(2)
            done.set()
            return sample
        with mock.patch.object(self.reader, "collect", side_effect=blocked) as collect:
            try:
                self.assertFalse(self.reader.read()["available"])
                self.assertTrue(started.wait(1))
                self.clock.now = 300
                began = time.monotonic()
                for _ in range(100):
                    self.assertFalse(self.reader.read()["available"])
                self.assertLess(time.monotonic() - began, 0.2)
                collect.assert_called_once()
            finally:
                release.set()
                self.assertTrue(done.wait(1))

    def test_refresh_cadence_and_failed_refresh_keep_stale_previous_readings(self):
        self.reader.sample = self.reader.collect()
        self.reader.last_attempt = 0
        with mock.patch.object(MODULE.threading, "Thread") as thread:
            self.clock.now = 29.999
            self.assertFalse(self.reader.read()["stale"])
            thread.assert_not_called()
            self.clock.now = 30
            self.reader.read()
            thread.assert_called_once()
        self.reader.running = False
        with mock.patch.object(self.reader, "collect", side_effect=OSError("private path")):
            self.reader.refresh()
        self.assertTrue(self.reader.read()["stale"])
        self.assertNotIn("private path", json.dumps(self.reader.read()))

    def test_ninety_second_stale_boundary_is_applied_to_cached_sample(self):
        self.reader.sample = self.reader.collect()
        self.reader.last_attempt = self.clock.now
        now = datetime.now(timezone.utc)
        for age, stale in [(89, False), (91, True)]:
            self.reader.sample["sampledAt"] = (now - timedelta(seconds=age)).isoformat()
            self.assertEqual(self.reader.read()["stale"], stale)


if __name__ == "__main__":
    unittest.main()
