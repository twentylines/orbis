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

    def test_blocked_probe_has_one_worker_and_never_blocks_readers(self):
        started, release, done = threading.Event(), threading.Event(), threading.Event()
        sample = self.collect(10)
        def blocked():
            started.set()
            release.wait(3)
            done.set()
            return sample
        with mock.patch.object(self.reader, "collect", side_effect=blocked) as collect:
            try:
                first = self.reader.read()
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
