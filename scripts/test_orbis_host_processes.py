import importlib.util
import json
import math
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location("orbis_host_processes", Path(__file__).with_name("orbis-host-processes.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Clock:
    def __init__(self, now=0):
        self.now = now

    def __call__(self):
        return self.now


class HostProcessesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.proc = Path(self.temp.name) / "proc"
        self.proc.mkdir()
        self.clock = Clock()
        self.reader = MODULE.HostProcesses(self.proc, clock=self.clock, ticks_per_second=100, page_size=4096)

    @staticmethod
    def stat(pid, name="worker", utime=100, stime=0, started=42, rss=2, children=0, threads=1):
        fields = ["S"] + ["0"] * 21
        for index, value in {11: utime, 12: stime, 13: children, 14: children, 17: threads, 19: started, 20: 999999999, 21: rss}.items():
            fields[index] = str(value)
        name = name if isinstance(name, bytes) else name.encode("utf-8")
        return str(pid).encode() + b" (" + name + b") " + " ".join(fields).encode() + b"\n"

    def put(self, pid, **values):
        directory = self.proc / str(pid)
        directory.mkdir(exist_ok=True)
        (directory / "stat").write_bytes(self.stat(pid, **values))
        return directory

    def collect(self, now):
        self.clock.now = now
        return self.reader.collect()

    def rows(self, sample):
        return {row["pid"]: row for row in sample["byMemory"]}

    def assert_counts(self, sample, scanned, readable, unreadable, compared):
        self.assertEqual({key: sample[key] for key in ("scanned", "readable", "unreadable", "compared")},
                         {"scanned": scanned, "readable": readable, "unreadable": unreadable, "compared": compared})
        self.assertEqual(sample["scanned"], sample["readable"] + sample["unreadable"])
        self.assertLessEqual(sample["compared"], sample["readable"])
        for key in ("scanned", "readable", "unreadable", "compared"):
            self.assertIs(type(sample[key]), int)
        self.assertEqual(len(sample["byMemory"]), min(MODULE.PROCESS_LIMIT, readable))
        self.assertEqual(len(sample["byCpu"]), min(MODULE.PROCESS_LIMIT, compared))

    def test_empty_proc_is_an_available_empty_sample(self):
        sample = self.collect(10)
        self.assertTrue(sample["available"])
        self.assertFalse(sample["limited"])
        self.assertNotIn("stale", sample)
        self.assertIsNotNone(datetime.fromisoformat(sample["sampledAt"].replace("Z", "+00:00")).tzinfo)
        self.assert_counts(sample, 0, 0, 0, 0)

    def test_first_memory_sample_and_last_parenthesis_stat_parsing(self):
        self.put(123, name="queue ) worker (nested)", utime=120, stime=30, rss=7)
        sample = self.collect(10)
        self.assert_counts(sample, 1, 1, 0, 0)
        self.assertEqual(sample["byMemory"], [{"pid": 123, "name": "queue ) worker (nested)", "cpuPercent": None, "memoryBytes": 7 * 4096}])

    def test_cpu_uses_user_plus_system_and_allows_more_than_one_core(self):
        self.put(3, utime=100, stime=40)
        self.collect(10)
        self.put(3, utime=700, stime=340)
        sample = self.collect(13)
        self.assertEqual(sample["byCpu"][0]["cpuPercent"], 300)
        self.assert_counts(sample, 1, 1, 0, 1)

    def test_clock_ticks_and_page_size_are_explicit_host_units(self):
        self.reader = MODULE.HostProcesses(self.proc, clock=self.clock, ticks_per_second=250, page_size=16384)
        self.put(4, utime=1000, rss=9)
        self.collect(10)
        self.put(4, utime=1500, rss=11)
        row = self.collect(18)["byCpu"][0]
        self.assertEqual(row["cpuPercent"], 25)
        self.assertEqual(row["memoryBytes"], 11 * 16384)
        self.assertIs(type(row["memoryBytes"]), int)

    def test_each_process_uses_its_actual_counter_read_time(self):
        for pid in (1, 2):
            self.put(pid, utime=100)
        original = self.reader.process
        measured = [{}, {}]
        phase = [0]

        def delayed(pid):
            value = original(pid)
            self.clock.now += (0.3, 0.1)[phase[0]]
            measured[phase[0]][pid] = self.clock.now
            return value

        with mock.patch.object(self.reader, "process", side_effect=delayed):
            self.collect(0)
            for pid in (1, 2):
                self.put(pid, utime=1100)
            phase[0] = 1
            sample = self.collect(10)
        actual = {row["pid"]: row["cpuPercent"] for row in sample["byCpu"]}
        for pid in (1, 2):
            self.assertAlmostEqual(actual[pid], 1000 / 100 / (measured[1][pid] - measured[0][pid]) * 100)
        self.assertNotEqual(actual[1], actual[2])

    def test_cpu_elapsed_bounds_are_inclusive_and_invalid_intervals_rebaseline(self):
        for elapsed, comparable in ((-1, False), (0, False), (1.999, False), (2, True), (60, True), (60.001, False)):
            with self.subTest(elapsed=elapsed):
                self.reader = MODULE.HostProcesses(self.proc, clock=self.clock, ticks_per_second=100, page_size=4096)
                self.put(1, utime=100)
                self.collect(100)
                self.put(1, utime=300)
                sample = self.collect(100 + elapsed)
                self.assert_counts(sample, 1, 1, 0, int(comparable))
                self.assertEqual(self.rows(sample)[1]["cpuPercent"] is not None, comparable)
                self.put(1, utime=500)
                self.assertAlmostEqual(self.collect(110 + elapsed)["byCpu"][0]["cpuPercent"], 20)

    def test_counter_reset_is_memory_only_then_cpu_recovers(self):
        self.put(1, utime=1000, rss=4)
        self.collect(10)
        self.put(1, utime=2, rss=6)
        reset = self.collect(20)
        self.assertIsNone(self.rows(reset)[1]["cpuPercent"])
        self.assertEqual(reset["byCpu"], [])
        self.put(1, utime=102, rss=7)
        self.assertEqual(self.collect(30)["byCpu"][0]["cpuPercent"], 10)

    def test_pid_reuse_uses_start_time_and_does_not_compare_old_process(self):
        self.put(7, utime=100, started=42)
        self.collect(10)
        self.put(7, utime=10000, started=43)
        reused = self.collect(20)
        self.assertIsNone(self.rows(reused)[7]["cpuPercent"])
        self.assertEqual(reused["byCpu"], [])
        self.put(7, utime=10200, started=43)
        self.assertEqual(self.collect(30)["byCpu"][0]["cpuPercent"], 20)

    def test_only_comparable_rows_enter_cpu_ranking(self):
        self.put(1, utime=100)
        self.put(2, utime=100)
        self.collect(10)
        self.put(1, utime=150)
        self.put(2, utime=0)
        self.put(3, utime=9999)
        sample = self.collect(20)
        self.assert_counts(sample, 3, 3, 0, 1)
        self.assertEqual([row["pid"] for row in sample["byCpu"]], [1])
        self.assertIsNone(self.rows(sample)[2]["cpuPercent"])
        self.assertIsNone(self.rows(sample)[3]["cpuPercent"])

    def test_children_and_nested_threads_are_not_double_counted(self):
        directory = self.put(11, utime=100, children=100000, threads=128, rss=3)
        task = directory / "task/999"
        task.mkdir(parents=True)
        (task / "stat").write_bytes(self.stat(999, utime=1000000, rss=1000000))
        self.put(12, utime=100, rss=4)
        self.collect(10)
        self.put(11, utime=200, children=10000000, threads=128, rss=3)
        self.put(12, utime=200, rss=4)
        sample = self.collect(20)
        self.assert_counts(sample, 2, 2, 0, 2)
        self.assertEqual(sum(row["cpuPercent"] for row in sample["byCpu"]), 20)
        self.assertEqual(sum(row["memoryBytes"] for row in sample["byMemory"]), 7 * 4096)

    def test_stat_only_reads_never_open_arguments_environment_or_exe(self):
        directory = self.put(17, name="log-broker")
        secret = "ARGUMENT_ENVIRONMENT_PRIVATE_SENTINEL"
        for filename in ("cmdline", "environ", "status", "statm"):
            (directory / filename).write_text(secret)
        target = Path(self.temp.name) / "private-executable"
        target.write_text(secret)
        (directory / "exe").symlink_to(target)
        opened = []
        original = Path.open

        def guarded(path, *args, **kwargs):
            self.assertEqual(path, directory / "stat", "Only the selected fixed stat file may be opened")
            opened.append(path)
            return original(path, *args, **kwargs)

        with mock.patch.object(Path, "open", guarded), mock.patch.object(MODULE.os, "readlink", side_effect=AssertionError("No executable links")), mock.patch.object(MODULE.os, "statvfs", side_effect=AssertionError("No device probes")):
            sample = self.collect(10)
        self.assertEqual(opened, [directory / "stat"])
        self.assertNotIn(secret, json.dumps(sample))
        self.assertEqual(set(sample["byMemory"][0]), {"pid", "name", "cpuPercent", "memoryBytes"})

    def test_names_are_printable_bounded_and_do_not_leak_raw_controls(self):
        self.put(1, name=b"worker\x00\x1b\x7f\xff" + b"x" * 100)
        self.put(2, name="unicode\u0085\u202e\u200bworker")
        for row in self.collect(10)["byMemory"]:
            self.assertTrue(0 < len(row["name"]) <= 64)
            self.assertTrue(all(character.isprintable() for character in row["name"]), repr(row["name"]))
            self.assertNotIn("\x1b", row["name"])

    def test_disappearing_process_is_counted_unreadable_without_losing_others(self):
        self.put(1)
        self.put(2)
        original = self.reader.process

        def disappear(pid):
            if pid == 2:
                (self.proc / "2/stat").unlink()
            return original(pid)

        with mock.patch.object(self.reader, "process", side_effect=disappear):
            sample = self.collect(10)
        self.assert_counts(sample, 2, 1, 1, 0)
        self.assertEqual([row["pid"] for row in sample["byMemory"]], [1])

    def test_malformed_selected_fields_are_isolated_and_counts_remain_honest(self):
        self.put(1)
        bad = {
            2: b"wrong pid and missing fields\n",
            3: self.stat(99),
            4: self.stat(4, utime="not-a-number"),
            5: self.stat(5, stime=-1),
            6: self.stat(6, rss=-1),
            7: self.stat(7, started="１２３"),
            8: self.stat(8, utime=2**53),
            9: self.stat(9, rss=2**53),
            10: b"10 (unclosed S 0 0 0\n",
        }
        for pid, payload in bad.items():
            directory = self.proc / str(pid)
            directory.mkdir()
            (directory / "stat").write_bytes(payload)
        (self.proc / "11").mkdir()
        sample = self.collect(10)
        self.assert_counts(sample, 11, 1, 10, 0)
        self.assertEqual([row["pid"] for row in sample["byMemory"]], [1])

    def test_invalid_pid_directory_names_are_not_read(self):
        self.put(2**31 - 1)
        for name in ("0", "-1", "self", "thread-self", "１２", "2.0", "2extra", str(2**31)):
            directory = self.proc / name
            directory.mkdir()
            (directory / "stat").write_bytes(self.stat(1))
        sample = self.collect(10)
        self.assert_counts(sample, 1, 1, 0, 0)
        self.assertEqual(sample["byMemory"][0]["pid"], 2**31 - 1)

    def test_numeric_aliases_cannot_double_count_the_same_pid(self):
        self.put(12)
        (self.proc / "012").mkdir()
        sample = self.collect(10)
        self.assertEqual([row["pid"] for row in sample["byMemory"]], [12])
        self.assertEqual(sample["readable"], 1)

    def test_exact_stat_byte_limit_and_bounded_read_size(self):
        original = Path.open
        requested = []
        self.put(1)
        payload = self.stat(2)
        self.put(2)
        (self.proc / "2/stat").write_bytes(payload + b" " * (4096 - len(payload)))
        self.put(3)
        payload = self.stat(3)
        (self.proc / "3/stat").write_bytes(payload + b" " * (4097 - len(payload)))

        class Reader:
            def __init__(self, stream):
                self.stream = stream

            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.stream.close()

            def read(self, size=-1):
                requested.append(size)
                return self.stream.read(size)

        with mock.patch.object(Path, "open", lambda path, *args, **kwargs: Reader(original(path, *args, **kwargs))):
            sample = self.collect(10)
        self.assert_counts(sample, 3, 2, 1, 0)
        self.assertEqual(len(requested), 3)
        self.assertTrue(all(0 < size <= 4097 for size in requested), requested)

    def test_top_twenty_are_deterministic_with_pid_ascending_ties(self):
        self.assertEqual(MODULE.PROCESS_LIMIT, 20)
        expected = []
        for pid in range(25, 0, -1):
            self.put(pid, utime=100, rss=pid // 3)
        self.collect(10)
        for pid in range(25, 0, -1):
            self.put(pid, utime=100 + (pid % 4) * 100, rss=pid // 3)
            expected.append({"pid": pid, "name": "worker", "cpuPercent": (pid % 4) * 10, "memoryBytes": (pid // 3) * 4096})
        sample = self.collect(20)
        self.assert_counts(sample, 25, 25, 0, 25)
        self.assertEqual(sample["byCpu"], sorted(expected, key=lambda row: (-row["cpuPercent"], row["pid"]))[:20])
        self.assertEqual(sample["byMemory"], sorted(expected, key=lambda row: (-row["memoryBytes"], row["pid"]))[:20])
        common = set(row["pid"] for row in sample["byCpu"]) & set(row["pid"] for row in sample["byMemory"])
        for pid in common:
            self.assertEqual(next(row for row in sample["byCpu"] if row["pid"] == pid), self.rows(sample)[pid])
        self.assertTrue(all(math.isfinite(row["cpuPercent"]) for row in sample["byCpu"]))

    def test_scan_read_cap_uses_small_patched_limit(self):
        self.assertEqual(MODULE.SCAN_LIMIT, 8192)
        for pid in range(1, 6):
            self.put(pid)
        with mock.patch.object(MODULE, "SCAN_LIMIT", 2), mock.patch.object(self.reader, "process", wraps=self.reader.process) as process:
            sample = self.collect(10)
        self.assert_counts(sample, 2, 2, 0, 0)
        self.assertEqual(process.call_count, 2)
        self.assertTrue(sample["limited"])
        self.assertLessEqual(len(self.reader.previous), 2)

    def test_one_second_budget_stops_further_reads(self):
        self.assertEqual(MODULE.SCAN_SECONDS, 1)
        for pid in range(1, 6):
            self.put(pid)
        original = self.reader.process

        def slow(pid):
            value = original(pid)
            self.clock.now += 0.6
            return value

        with mock.patch.object(self.reader, "process", side_effect=slow) as process:
            sample = self.collect(10)
        self.assert_counts(sample, 2, 2, 0, 0)
        self.assertEqual(process.call_count, 2)
        self.assertTrue(sample["limited"])

    def test_invalid_host_units_do_not_produce_division_errors_or_bad_memory(self):
        self.put(1)
        for ticks, page in ((0, 4096), (-1, 4096), (1000001, 4096), (float("nan"), 4096), (float("inf"), 4096), (100, 0), (100, 1048577)):
            with self.subTest(ticks=ticks, page=page):
                reader = MODULE.HostProcesses(self.proc, clock=self.clock, ticks_per_second=ticks, page_size=page)
                with self.assertRaises(ValueError):
                    reader.collect()

    def wait_finished(self):
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            with self.reader.lock:
                if not self.reader.running:
                    return
            time.sleep(0.005)
        self.fail("Process worker did not finish")

    def test_one_blocked_daemon_worker_does_not_block_or_duplicate_readers(self):
        self.put(1)
        cached = self.collect(10)
        self.reader.sample = cached
        self.reader.last_attempt = 0
        self.clock.now = 10
        started, release = threading.Event(), threading.Event()
        threads = []
        original_thread = threading.Thread

        def blocked():
            started.set()
            release.wait(2)
            return cached

        def create(*args, **kwargs):
            self.assertTrue(kwargs.get("daemon"), "The one on-demand worker must be a daemon")
            thread = original_thread(*args, **kwargs)
            threads.append(thread)
            return thread

        with mock.patch.object(self.reader, "collect", side_effect=blocked) as collect, mock.patch.object(MODULE.threading, "Thread", side_effect=create):
            try:
                self.assertTrue(self.reader.read()["available"])
                self.assertTrue(started.wait(1))
                self.clock.now = 100
                began = time.perf_counter()
                for _ in range(100):
                    self.assertTrue(self.reader.read()["available"])
                self.assertLess(time.perf_counter() - began, 0.25)
                collect.assert_called_once()
                self.assertEqual(len(threads), 1)
            finally:
                release.set()
                for thread in threads:
                    thread.join(1)
                    self.assertFalse(thread.is_alive())
        self.wait_finished()

    def test_worker_interval_and_initial_collecting_response(self):
        self.put(1)
        sample = self.collect(0)
        started, release = threading.Event(), threading.Event()

        def blocked():
            started.set()
            release.wait(2)
            return sample

        with mock.patch.object(self.reader, "collect", side_effect=blocked) as collect:
            try:
                first = self.reader.read()
                self.assertFalse(first["available"])
                self.assertIn("Collecting", first["reason"])
                self.assertTrue(started.wait(1))
            finally:
                release.set()
                self.wait_finished()
            self.clock.now = 9.999
            self.assertTrue(self.reader.read()["available"])
            self.assertEqual(collect.call_count, 1)
            self.clock.now = 10
            self.reader.read()
            self.wait_finished()
            self.assertEqual(collect.call_count, 2)

    def test_failed_refresh_keeps_old_sample_and_marks_it_stale(self):
        self.put(1)
        sample = self.collect(10)
        self.reader.sample = sample
        self.reader.last_attempt = 0
        with mock.patch.object(self.reader, "collect", side_effect=OSError("PRIVATE_FAILURE_SENTINEL")):
            self.reader.read()
            self.wait_finished()
            result = self.reader.read()
        self.assertTrue(result["available"])
        self.assertTrue(result["stale"])
        self.assertEqual(result["byMemory"], sample["byMemory"])
        self.assertNotIn("stale", sample)
        self.assertNotIn("PRIVATE_FAILURE_SENTINEL", json.dumps(result))

    def test_stale_age_boundary_is_thirty_seconds(self):
        self.put(1)
        sample = self.collect(10)
        now = datetime(2026, 10, 18, 12, tzinfo=timezone.utc)
        self.reader.last_attempt = self.clock.now

        class FrozenDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return now if tz is not None else now.replace(tzinfo=None)

        for age, expected in ((29.999, False), (30, False), (30.001, True)):
            with self.subTest(age=age), mock.patch.object(MODULE, "datetime", FrozenDateTime):
                self.reader.sample = {**sample, "sampledAt": (now - timedelta(seconds=age)).isoformat()}
                self.assertEqual(self.reader.read()["stale"], expected)

    def test_no_sample_failure_returns_honest_unavailable_without_details(self):
        with mock.patch.object(self.reader, "collect", side_effect=OSError("PRIVATE_FAILURE_SENTINEL")):
            self.reader.read()
            self.wait_finished()
            result = self.reader.read()
        self.assertFalse(result["available"])
        self.assertIn("unavailable", result["reason"].lower())
        self.assertNotIn("PRIVATE_FAILURE_SENTINEL", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
