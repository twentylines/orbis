import copy
import importlib.util
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location("orbis_drives_test", Path(__file__).with_name("orbis-host-drives.py"))
DRIVES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVES)


def nvme():
    return {"model_name": "Test NVMe", "serial_number": "PRIVATE_DEVICE_ID", "device": {"protocol": "NVMe"},
            "smartctl": {"exit_status": 0}, "smart_status": {"passed": True}, "temperature": {"current": 42},
            "user_capacity": {"bytes": 2_000_000_000_000}, "nvme_optional_admin_commands": {"self_test": True},
            "nvme_smart_health_information_log": {"percentage_used": 8, "available_spare": 100,
                "available_spare_threshold": 10, "media_errors": 0, "critical_warning": 0,
                "data_units_written": 10, "power_on_hours": 1500, "num_err_log_entries": 0},
            "nvme_self_test_log": {"current_self_test_operation": {"value": 0}, "table": []}}


class DriveHealthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.reader = DRIVES.DriveHealth(Path(self.temp.name))

    def parse(self, data):
        return DRIVES.parse_drive(data, "/dev/nvme0", DRIVES.now())

    def test_nvme_preserves_units_without_leaking_serial_or_inventing_ata_counters(self):
        row = self.parse(nvme())
        self.assertEqual(row["health"], "passed")
        self.assertEqual(row["temperature"], 42)
        self.assertEqual(row["bytesWritten"], 5_120_000)
        self.assertEqual(row["percentageUsed"], 8)
        self.assertIsNone(row["pendingSectors"])
        self.assertNotIn("PRIVATE_DEVICE_ID", json.dumps(row))
        self.assertTrue(row["selfTest"]["supported"])

    def test_identity_survives_device_renaming_but_changes_on_replacement(self):
        data = nvme()
        self.assertEqual(DRIVES.identity(data, "/dev/nvme0"), DRIVES.identity(data, "/dev/nvme2"))
        replaced = {**data, "serial_number": "OTHER_DEVICE"}
        self.assertNotEqual(self.parse(data)["id"], self.parse(replaced)["id"])
        del data["serial_number"]
        self.assertFalse(self.parse(data)["selfTest"]["supported"])

    def test_missing_smart_result_is_never_a_pass(self):
        self.assertEqual(self.parse({})["health"], "unavailable")
        data = nvme()
        data["smartctl"]["exit_status"] = 2
        self.assertEqual(self.parse(data)["health"], "unavailable")
        data["power_mode"] = {"string": "STANDBY"}
        self.assertEqual(self.parse(data)["health"], "sleeping")

    def test_smartctl_power_modes_and_unsupported_detection_do_not_look_like_health(self):
        self.assertEqual(self.parse({"smartctl": {"exit_status": 3}, "power_mode": {"name": "STANDBY_Y"}})["health"], "sleeping")
        row = self.parse({"smartctl": {"exit_status": 5}})
        self.assertEqual(row["health"], "unavailable")
        self.assertIn("skipped", " ".join(row["reasons"]))

    def test_disconnected_drive_history_is_retained_for_its_return(self):
        row = self.parse(nvme())
        self.assertTrue(self.reader.history([row]))
        self.assertTrue(self.reader.history([]))
        saved = json.loads((Path(self.temp.name) / "drive-health-history.json").read_text())
        self.assertIn(row["id"], saved)

    def test_failed_health_and_nvme_warnings_are_actionable(self):
        for change in ({"smart_status": {"passed": False}}, {"nvme_smart_health_information_log": {"critical_warning": 1}}):
            row = self.parse({**nvme(), **change})
            self.assertEqual(row["health"], "failed")
            self.assertTrue(row["reasons"])

    def test_endurance_spare_and_media_errors_do_not_hide_behind_a_pass(self):
        for change in ({"percentage_used": 100}, {"available_spare": 2}, {"media_errors": 5}):
            data = nvme()
            data["nvme_smart_health_information_log"].update(change)
            self.assertEqual(self.parse(data)["health"], "warning")

    def test_ata_counters_require_recognized_names_and_preserve_missing_values(self):
        data = nvme()
        data["ata_smart_attributes"] = {"table": [
            {"id": 5, "name": "Reallocated_Sector_Ct", "raw": {"value": 3}},
            {"id": 197, "name": "Current_Pending_Sector", "raw": {"value": 1}},
            {"id": 198, "name": "Vendor_Specific", "raw": {"value": 12345}},
        ]}
        row = self.parse(data)
        self.assertEqual((row["reallocatedSectors"], row["pendingSectors"]), (3, 1))
        self.assertIsNone(row["uncorrectableSectors"])
        self.assertEqual(row["health"], "warning")

    def test_historical_errors_are_warnings_rather_than_current_failure(self):
        data = nvme()
        data["smartctl"]["exit_status"] = 192
        row = self.parse(data)
        self.assertEqual(row["health"], "warning")
        self.assertIn("historical", " ".join(row["reasons"]))

    def test_optional_malformed_error_tables_do_not_drop_other_readings(self):
        data = nvme()
        data.update(ata_smart_error_log={"extended": {"table": None}}, nvme_error_information_log={"table": False})
        row = self.parse(data)
        self.assertEqual(row["errors"], [])
        self.assertEqual(row["temperature"], 42)

    def test_nvme_test_progress_is_completed_to_remaining_not_reversed(self):
        data = nvme()
        data["nvme_self_test_log"] = {"current_self_test_operation": {"value": 2}, "current_self_test_completion_percent": 30,
            "table": [{"self_test_code": {"string": "Short"}, "self_test_result": {"string": "Completed without error", "value": 0}, "power_on_hours": 1400}]}
        row = self.parse(data)
        self.assertTrue(row["selfTest"]["running"])
        self.assertEqual(row["selfTest"]["remainingPercent"], 70)
        self.assertTrue(row["tests"][0]["passed"])

    def test_ata_extended_logs_preserve_recent_results_and_error_counts(self):
        data = nvme()
        data.pop("nvme_self_test_log")
        data.pop("nvme_smart_health_information_log")
        data["ata_smart_self_test_log"] = {
            "extended": {"table": [
                {"type": {"string": "Extended offline"}, "status": {"string": "Completed: read failure", "value": 112, "passed": False}, "lifetime_hours": 1600},
                {"type": {"string": "Short offline"}, "status": {"string": "Aborted by host", "value": 16}, "lifetime_hours": 1500},
            ]},
            "standard": {"table": [{"type": {"string": "Short offline"}, "status": {"string": "Completed without error", "passed": True}, "lifetime_hours": 1400}]},
        }
        data["ata_smart_error_log"] = {"extended": {"count": 7, "table": [{"error_description": "UNC at LBA = 42", "lifetime_hours": 1590}]}}
        row = self.parse(data)
        self.assertEqual([entry["hours"] for entry in row["tests"]], [1600, 1500])
        self.assertEqual([entry["passed"] for entry in row["tests"]], [False, None])
        self.assertEqual(row["errorCount"], 7)
        self.assertEqual(row["errors"], [{"summary": "UNC at LBA = 42", "hours": 1590}])

    def test_ata_empty_or_malformed_extended_tables_fall_back_to_standard(self):
        for table in (None, False, []):
            data = nvme()
            data["ata_smart_self_test_log"] = {"extended": {"table": table}, "standard": {"table": [
                {"type": {"string": "Short offline"}, "status": {"string": "Interrupted by reset", "value": 32}, "lifetime_hours": 1500},
            ]}}
            data["ata_smart_error_log"] = {"extended": {"table": table}, "summary": {"count": 2, "table": [
                {"error_description": "ATA command error", "lifetime_hours": 1200},
            ]}}
            data["nvme_smart_health_information_log"].pop("num_err_log_entries")
            row = self.parse(data)
            self.assertEqual(row["tests"][0]["hours"], 1500)
            self.assertIsNone(row["tests"][0]["passed"])
            self.assertEqual(row["errorCount"], 2)
            self.assertEqual(len(row["errors"]), 1)

    def test_nvme_aborted_or_unknown_results_are_neither_passed_nor_failed(self):
        for value in (1, 2, 3, 4, 8, 9, 10, 15, None, True):
            data = nvme()
            data["nvme_self_test_log"]["table"] = [{"self_test_code": {"string": "Short"}, "self_test_result": {"string": "Interrupted or unknown", "value": value}}]
            self.assertIsNone(self.parse(data)["tests"][0]["passed"])
        for value, expected in ((0, True), (5, False), (6, False), (7, False)):
            data = nvme()
            data["nvme_self_test_log"]["table"] = [{"self_test_result": {"string": "Test result", "value": value}}]
            self.assertIs(self.parse(data)["tests"][0]["passed"], expected)

    def test_history_is_private_bounded_hourly_and_keeps_real_unavailable_values(self):
        row = self.parse(nvme())
        self.assertTrue(self.reader.history([row]))
        self.assertTrue(self.reader.history([copy.deepcopy(row)]))
        history_path = Path(self.temp.name) / "drive-health-history.json"
        saved = json.loads(history_path.read_text())
        self.assertEqual(len(saved[row["id"]]), 1)
        self.assertIsNone(saved[row["id"]][0]["pendingSectors"])
        self.assertEqual(history_path.stat().st_mode & 0o777, 0o600)

    def test_escaped_history_symlink_is_not_read(self):
        outside = Path(self.temp.name) / "other"
        outside.write_text('{"private":true}')
        (Path(self.temp.name) / "drive-health-history.json").symlink_to(outside)
        self.assertFalse(self.reader.history([self.parse(nvme())]))
        self.assertEqual(outside.read_text(), '{"private":true}')

    def test_hourly_history_keeps_warnings_and_temperature_peaks_after_recovery(self):
        first = self.parse(nvme())
        first.update(health="warning", temperature=70, mediaErrors=2)
        self.assertTrue(self.reader.history([first]))
        later = self.parse(nvme())
        self.assertTrue(self.reader.history([later]))
        self.assertEqual(later["history"][-1]["health"], "warning")
        self.assertEqual(later["history"][-1]["temperature"], 70)
        self.assertEqual(later["history"][-1]["mediaErrors"], 2)

    def test_collection_is_only_started_by_reads_and_uses_standby_safe_arguments(self):
        self.assertIsNone(self.reader.sample)
        with mock.patch.object(self.reader, "scan", return_value=([("/dev/nvme0", "nvme")], False)), \
             mock.patch.object(self.reader, "command", return_value=nvme()) as command:
            result = self.reader.collect()
        self.assertTrue(result["available"])
        self.assertEqual(command.call_args.args[0], ["-j", "-x", "-n", "standby,3,5", "-d", "nvme", "/dev/nvme0"])

    def test_scan_rejects_paths_flags_symlinks_and_unsupported_types(self):
        data = {"devices": [{"name": "/dev/sda", "type": "sat"}, {"name": "/tmp/private", "type": "sat"},
            {"name": "/dev/sdb", "type": "sat; rm -rf /"}, {"name": "--help", "type": "ata"}]}
        with mock.patch.object(self.reader, "command", return_value=data), mock.patch.object(self.reader, "valid_device", side_effect=lambda path: bool(DRIVES.DEVICE.fullmatch(path))):
            self.assertEqual(self.reader.scan(), ([("/dev/sda", "sat")], True))

    def test_collection_probes_are_bounded_and_one_failed_disk_does_not_hide_others(self):
        barrier = threading.Barrier(DRIVES.MAX_PROBES)
        lock = threading.Lock()
        active, peak = 0, 0
        devices = [(f"/dev/nvme{i}", "nvme") for i in range(8)]

        def command(arguments):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            try:
                barrier.wait(timeout=3)
                if arguments[-1] == "/dev/nvme0":
                    raise ValueError("Declared unreadable device")
                return {**nvme(), "serial_number": arguments[-1]}
            finally:
                with lock:
                    active -= 1

        with mock.patch.object(self.reader, "scan", return_value=(devices, False)), mock.patch.object(self.reader, "command", side_effect=command):
            sample = self.reader.collect()
        self.assertEqual(peak, DRIVES.MAX_PROBES)
        self.assertEqual(len(sample["drives"]), 8)
        self.assertEqual(sum(row["health"] == "passed" for row in sample["drives"]), 7)
        self.assertEqual(len(self.reader.devices), 7)

    def test_self_test_is_explicit_and_refuses_hot_swapped_or_unsupported_disks(self):
        row = self.parse(nvme())
        self.reader.devices[row["id"]] = ("/dev/nvme0", "nvme")
        replaced = {**nvme(), "serial_number": "REPLACED"}
        with mock.patch.object(self.reader, "scan", return_value=([("/dev/nvme0", "nvme")], False)), \
             mock.patch.object(self.reader, "valid_device", return_value=True), mock.patch.object(self.reader, "command", return_value=replaced) as command:
            with self.assertRaisesRegex(ValueError, "changed"):
                self.reader.start_test(row["id"], "short")
            self.assertEqual(command.call_count, 1)
        with self.assertRaises(ValueError):
            self.reader.start_test(row["id"], "destructive")

    def test_self_test_sends_only_the_reviewed_non_captive_command(self):
        row = self.parse(nvme())
        self.reader.devices[row["id"]] = ("/dev/nvme0", "nvme")
        with mock.patch.object(self.reader, "scan", return_value=([("/dev/nvme0", "nvme")], False)), \
             mock.patch.object(self.reader, "valid_device", return_value=True), \
             mock.patch.object(self.reader, "command", side_effect=[nvme(), {"smartctl": {"exit_status": 0}}]) as command:
            self.assertTrue(self.reader.start_test(row["id"], "extended")["accepted"])
            self.assertEqual(command.call_args.args[0], ["-j", "-t", "long", "-d", "nvme", "/dev/nvme0"])

    def test_repeated_reads_share_collection_and_stale_sample_is_marked(self):
        self.reader.sample = {"available": True, "sampledAt": "2020-01-01T00:00:00Z", "drives": []}
        with mock.patch.object(DRIVES.threading, "Thread") as thread:
            self.assertTrue(self.reader.read()["stale"])
            self.reader.read()
            self.assertEqual(thread.call_count, 1)


if __name__ == "__main__":
    unittest.main()
