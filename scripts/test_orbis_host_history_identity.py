import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "orbis_host_history_identity", Path(__file__).with_name("orbis-host-telemetry.py")
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
BOOT = "c5d77e28-2dcb-4c88-a4be-137f8e301f2a"
OTHER_BOOT = "81fb23a1-7058-41d5-b65d-ccdc9d606ff2"


class HostHistoryIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.proc, self.sys = self.root / "proc", self.root / "sys"
        self.usage = mock.Mock(
            return_value=SimpleNamespace(
                f_frsize=4096, f_bsize=4096, f_blocks=100, f_bfree=40, f_bavail=30
            )
        )
        self.boot_file = self.proc / "sys/kernel/random/boot_id"
        self.put(self.boot_file, BOOT + "\n")
        self.put(self.proc / "self/mountinfo", "10 1 8:1 / / rw - ext4 /dev/private-source rw,password=private-options\n")
        self.configure()

    @staticmethod
    def put(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding="utf-8")

    def configure(self, interface="eth0", device="sda", ifindex="2", diskseq="4", major="8", minor="0", increment=0):
        self.interface, self.device = interface, device
        self.put(
            self.proc / "net/dev",
            "Inter-| Receive | Transmit\n"
            f"{interface}: {1000 + increment} 1 0 0 0 0 0 0 {2000 + increment * 2} 1 0 0 0 0 0 0\n",
        )
        self.put(
            self.proc / "diskstats",
            f"{major} {minor} {device} 10 0 {100 + increment} 3 20 0 {200 + increment * 2} 4 2 {400 + increment} 20\n",
        )
        network = self.sys / "class/net" / interface
        disk = self.sys / "class/block" / device
        self.put(network / "operstate", "up\n")
        self.put(network / "speed", "1000\n")
        for file, value in [(network / "ifindex", ifindex), (disk / "diskseq", diskseq)]:
            if value is None:
                file.unlink(missing_ok=True)
            else:
                self.put(file, value + "\n")

    def reader(self):
        return MODULE.HostTelemetry(self.proc, self.sys, self.usage)

    def collect(self, reader, now=10):
        with mock.patch.object(MODULE.time, "monotonic", return_value=now):
            result = reader.collect()
        self.assertTrue(result["available"])
        self.assertEqual(result["unavailable"], [])
        self.assertEqual(len(result["network"]), 1)
        self.assertEqual(len(result["disks"]), 1)
        return result

    def identities(self, sample):
        identities = (sample["network"][0]["historyId"], sample["disks"][0]["historyId"])
        for identity in identities:
            self.assertRegex(identity, r"^[0-9a-f]{64}$")
            self.assertEqual(len(identity), 64)
        return identities

    def assert_live_readings(self, sample, increment=0):
        self.assertEqual(sample["network"][0]["receivedBytes"], 1000 + increment)
        self.assertEqual(sample["network"][0]["transmittedBytes"], 2000 + increment * 2)
        self.assertEqual(sample["disks"][0]["readBytes"], (100 + increment) * 512)
        self.assertEqual(sample["disks"][0]["writtenBytes"], (200 + increment * 2) * 512)
        self.assertEqual(sample["filesystems"][0]["sizeBytes"], 409600)

    def test_ids_survive_repeated_samples_and_new_collectors_in_one_boot(self):
        reader = self.reader()
        first = self.collect(reader)
        unchanged = self.collect(reader, 20)
        restarted = self.collect(self.reader(), 30)
        self.assertEqual(self.identities(first), self.identities(unchanged))
        self.assertEqual(self.identities(first), self.identities(restarted))
        self.assert_live_readings(restarted)
        self.assertIsNone(restarted["network"][0]["rxBytesPerSecond"])
        self.assertIsNone(restarted["disks"][0]["readBytesPerSecond"])

    def test_counter_activity_and_counter_reset_do_not_rename_the_device(self):
        reader = self.reader()
        original = self.identities(self.collect(reader))
        self.configure(increment=100)
        changed = self.collect(reader, 20)
        self.assertEqual(self.identities(changed), original)
        self.assertEqual(changed["network"][0]["rxBytesPerSecond"], 10)
        self.assertEqual(changed["disks"][0]["readBytesPerSecond"], 5120)
        self.configure(increment=0)
        reset = self.collect(reader, 30)
        self.assertEqual(self.identities(reset), original)
        self.assertIsNone(reset["network"][0]["rxBytesPerSecond"])
        self.assertIsNone(reset["disks"][0]["readBytesPerSecond"])

    def test_new_boot_changes_both_generations_without_changing_readings(self):
        original = self.collect(self.reader())
        self.put(self.boot_file, OTHER_BOOT + "\n")
        rebooted = self.collect(self.reader())
        old_ids, new_ids = self.identities(original), self.identities(rebooted)
        self.assertNotEqual(old_ids[0], new_ids[0])
        self.assertNotEqual(old_ids[1], new_ids[1])
        self.assert_live_readings(rebooted)
        self.assertNotIn(BOOT, json.dumps(original))
        self.assertNotIn(OTHER_BOOT, json.dumps(rebooted))

    def test_replaced_interface_gets_new_generation_and_fresh_rate_baseline(self):
        reader = self.reader()
        original = self.identities(self.collect(reader))
        self.configure(ifindex="3", increment=100)
        replacement = self.collect(reader, 20)
        identities = self.identities(replacement)
        self.assertNotEqual(identities[0], original[0])
        self.assertEqual(identities[1], original[1])
        self.assertIsNone(replacement["network"][0]["rxBytesPerSecond"])
        self.assert_live_readings(replacement, 100)

    def test_replaced_disk_gets_new_generation_and_fresh_rate_baseline(self):
        reader = self.reader()
        original = self.identities(self.collect(reader))
        self.configure(diskseq="5", increment=100)
        replacement = self.collect(reader, 20)
        identities = self.identities(replacement)
        self.assertNotEqual(identities[1], original[1])
        self.assertEqual(identities[0], original[0])
        self.assertIsNone(replacement["disks"][0]["readBytesPerSecond"])
        self.assert_live_readings(replacement, 100)

    def test_disk_kernel_number_changes_do_not_reuse_history(self):
        reader = self.reader()
        original = self.identities(self.collect(reader))
        self.configure(minor="16", increment=100)
        changed = self.collect(reader, 20)
        self.assertNotEqual(self.identities(changed)[1], original[1])
        self.assertIsNone(changed["disks"][0]["readBytesPerSecond"])

    def test_renamed_resources_change_only_their_own_generation(self):
        original = self.identities(self.collect(self.reader()))
        self.configure(interface="enp1s0")
        renamed_network = self.identities(self.collect(self.reader()))
        self.assertNotEqual(renamed_network[0], original[0])
        self.assertEqual(renamed_network[1], original[1])
        self.configure(device="nvme0n1")
        renamed_disk = self.identities(self.collect(self.reader()))
        self.assertEqual(renamed_disk[0], original[0])
        self.assertNotEqual(renamed_disk[1], original[1])

    def test_network_and_disk_with_same_visible_name_are_distinct(self):
        self.configure(interface="shared0", device="shared0", ifindex="7", diskseq="7")
        sample = self.collect(self.reader())
        network, disk = self.identities(sample)
        self.assertNotEqual(network, disk)
        self.assertEqual(sample["network"][0]["interface"], sample["disks"][0]["device"])

    def test_mac_serial_link_state_and_speed_are_not_history_identity_inputs(self):
        address = self.sys / "class/net/eth0/address"
        serial = self.sys / "class/block/sda/device/serial"
        self.put(address, "de:ad:be:ef:12:34\n")
        self.put(serial, "private-disk-serial-A\n")
        original = self.identities(self.collect(self.reader()))
        self.put(address, "de:ad:be:ef:56:78\n")
        self.put(serial, "private-disk-serial-B\n")
        self.put(self.sys / "class/net/eth0/operstate", "down\n")
        self.put(self.sys / "class/net/eth0/speed", "100\n")
        sample = self.collect(self.reader())
        self.assertEqual(self.identities(sample), original)
        self.assertEqual(sample["network"][0]["state"], "down")
        self.assertEqual(sample["network"][0]["speedMbps"], 100)

    def test_private_identifiers_are_never_opened_or_returned(self):
        private = [self.sys / "class/net/eth0/address", self.sys / "class/block/sda/device/serial", self.sys / "class/block/sda/wwid"]
        for index, file in enumerate(private):
            self.put(file, f"private-hardware-marker-{index}\n")
        real_open = Path.open
        opened = []
        def guarded_open(file, *args, **kwargs):
            self.assertTrue(file.is_relative_to(self.root), "Collector must not inspect the actual host")
            self.assertNotIn(file, private, "Collector must not read private hardware identifiers")
            opened.append(file)
            return real_open(file, *args, **kwargs)
        with mock.patch.object(Path, "open", guarded_open):
            sample = self.collect(self.reader())
        self.assertIn(self.boot_file, opened)
        encoded = json.dumps(sample)
        for marker in [BOOT, "private-hardware-marker", "private-source", "private-options", "boot_id", "ifindex", "diskseq", "serial", "address"]:
            self.assertNotIn(marker, encoded)
        self.identities(sample)

    def test_missing_or_malformed_boot_omits_only_history_capability(self):
        for boot in [None, "", "bad-boot", BOOT.upper(), BOOT.replace("-", ""), BOOT + "extra", "x" * 129]:
            with self.subTest(boot=boot):
                if boot is None:
                    self.boot_file.unlink(missing_ok=True)
                else:
                    self.put(self.boot_file, boot + "\n")
                sample = self.collect(self.reader())
                self.assertNotIn("historyId", sample["network"][0])
                self.assertNotIn("historyId", sample["disks"][0])
                self.assert_live_readings(sample)

    def test_invalid_kernel_ids_omit_only_the_affected_capability(self):
        invalid = [None, "", "0", "00", "02", "-1", "+2", "1.5", "1e3", "invalid", str(2**64), "1" * 129, "2\x00", "٢"]
        for field in ["ifindex", "diskseq"]:
            for value in invalid:
                with self.subTest(field=field, value=value):
                    kwargs = {field: value}
                    self.configure(**kwargs)
                    sample = self.collect(self.reader())
                    affected = "network" if field == "ifindex" else "disks"
                    unaffected = "disks" if affected == "network" else "network"
                    self.assertNotIn("historyId", sample[affected][0])
                    self.assertRegex(sample[unaffected][0]["historyId"], r"^[0-9a-f]{64}$")
                    self.assert_live_readings(sample)

    def test_missing_identity_metadata_keeps_current_rates_working(self):
        self.configure(ifindex=None, diskseq=None)
        reader = self.reader()
        self.collect(reader)
        self.configure(ifindex=None, diskseq=None, increment=100)
        sample = self.collect(reader, 20)
        self.assertNotIn("historyId", sample["network"][0])
        self.assertNotIn("historyId", sample["disks"][0])
        self.assertEqual(sample["network"][0]["rxBytesPerSecond"], 10)
        self.assertEqual(sample["disks"][0]["readBytesPerSecond"], 5120)
        self.assert_live_readings(sample, 100)

    def test_network_kernel_id_respects_positive_signed_32_bit_boundary(self):
        self.configure(ifindex=str(2**31 - 1))
        self.identities(self.collect(self.reader()))
        self.configure(ifindex=str(2**31))
        sample = self.collect(self.reader())
        self.assertNotIn("historyId", sample["network"][0])
        self.assertIn("historyId", sample["disks"][0])
        self.assert_live_readings(sample)

    def test_uint64_disk_sequence_boundary_is_supported(self):
        self.configure(diskseq=str(2**64 - 1))
        self.identities(self.collect(self.reader()))


if __name__ == "__main__":
    unittest.main()
