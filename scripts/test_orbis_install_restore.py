import copy
import importlib.util
import json
import os
import stat
import struct
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location("orbis_install_restore", Path(__file__).with_name("orbis-install-restore.py"))
assert SPEC and SPEC.loader
RESTORE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RESTORE)
STORAGE = RESTORE.STORAGE
FIXTURES = RESTORE.APPS.load_script("test_orbis_install_storage.py", "storage_restore_fixtures")


class InstallationRestoreTests(unittest.TestCase):
    setUp = FIXTURES.InstallationStorageTests.setUp
    quiet = FIXTURES.InstallationStorageTests.quiet
    foreign = FIXTURES.InstallationStorageTests.foreign

    def backup(self):
        self.quiet()
        reviewed = STORAGE.review(self.root, self.docker, self.bundle)
        STORAGE.capture(self.root, self.docker, reviewed, host_writers_stopped=True)
        self.manifest = STORAGE.verified_manifest(self.bundle)
        self.journal = self.private / "restore.json"
        return self.manifest

    def prepare(self):
        with mock.patch.object(RESTORE, "runtime"):
            return RESTORE.review(self.root, self.docker, self.bundle)

    def restore(self, saved, *, recover=False):
        return RESTORE.restore(self.root, self.docker, saved, self.journal, host_writers_stopped=True, recover=recover)

    def test_read_only_review_binds_existing_backup_destinations_and_all_writers(self):
        self.backup()
        saved = self.prepare()
        self.assertEqual(len(saved["writers"]), 4)
        self.assertEqual(saved["backupFingerprint"], RESTORE.APPS.digest(self.manifest))
        self.assertTrue(saved["hostWriterReviewRequired"])
        self.assertFalse(self.journal.exists())
        self.assertEqual(self.docker.calls, [])

    def test_root_daemon_and_context_must_match_backup(self):
        self.backup()
        for field, value in [("root", self.external), ("daemon_id", "another-daemon"), ("context", "other-context")]:
            with self.subTest(field=field), mock.patch.object(RESTORE, "runtime"):
                if field == "root":
                    with self.assertRaisesRegex(RESTORE.RestoreError, "different root"):
                        RESTORE.review(value, self.docker, self.bundle)
                else:
                    old = getattr(self.docker, field)
                    setattr(self.docker, field, value)
                    try:
                        with self.assertRaisesRegex(RESTORE.RestoreError, "different root"):
                            RESTORE.review(self.root, self.docker, self.bundle)
                    finally:
                        setattr(self.docker, field, old)

    def test_running_or_restart_enabled_original_and_foreign_writers_prevent_review(self):
        self.backup()
        for case in ["core", "app", "policy", "foreign"]:
            with self.subTest(case=case):
                self.quiet()
                if case == "core": self.docker.controller_state = "running"
                if case == "app": self.docker.apps[FIXTURES.FIXTURES.identifier("app-0")]["state"] = "running"
                if case == "policy": self.docker.controller_policy = {"Name": "always", "MaximumRetryCount": 0}
                if case == "foreign": self.foreign()
                with self.assertRaisesRegex(RESTORE.RestoreError, "Stop every"):
                    self.prepare()
                self.docker.apps.pop(FIXTURES.FIXTURES.identifier("app-99"), None)
                self.docker.controller_policy = {"Name": "no", "MaximumRetryCount": 0}

    def test_changed_writers_or_review_are_rejected_before_any_data_write(self):
        self.backup()
        saved = self.prepare()
        self.foreign(stopped=True)
        with mock.patch.object(RESTORE, "runtime"), mock.patch.object(RESTORE, "copy_resource") as copying:
            with self.assertRaisesRegex(RESTORE.RestoreError, "writers or destinations changed"):
                self.restore(saved)
            copying.assert_not_called()
        self.assertFalse(self.journal.exists())
        self.docker.apps.pop(FIXTURES.FIXTURES.identifier("app-99"))
        edited = copy.deepcopy(saved)
        edited["root"] = str(self.external)
        with self.assertRaisesRegex(RESTORE.RestoreError, "invalid or was edited"):
            self.restore(edited)

    def test_recovery_can_review_a_replaced_stopped_controller_without_discovery_guessing(self):
        self.backup()
        self.docker.controller_id = FIXTURES.FIXTURES.identifier("replacement")
        self.docker.controller_image = FIXTURES.FIXTURES.TARGET
        self.docker.controller_image_id = "sha256:" + "d" * 64
        saved = self.prepare()
        self.assertIn(self.docker.controller_id, {item["id"] for item in saved["writers"]})
        self.assertEqual(len(saved["writers"]), 4)

    def test_replaced_destination_symlink_and_top_level_hard_link_are_rejected(self):
        self.backup()
        moved = self.file.with_name("original-config")
        self.file.rename(moved)
        for case in ["file", "symlink", "hardlink"]:
            with self.subTest(case=case):
                if case == "file": self.file.write_bytes(b"unreviewed replacement")
                if case == "symlink": self.file.symlink_to(moved)
                if case == "hardlink": os.link(moved, self.file)
                with self.assertRaises(ValueError): self.prepare()
                self.file.unlink()
        moved.rename(self.file)

    def test_changed_host_mounts_and_corrupt_bundle_prevent_review(self):
        self.backup()
        with mock.patch.object(STORAGE, "host_mounts", return_value=[STORAGE.source_identity(self.external)]):
            with self.assertRaisesRegex(RESTORE.RestoreError, "Host mounts changed"):
                self.prepare()
        index = next(i for i, item in enumerate(self.manifest["plan"]["resources"]) if item["kind"] == "file")
        (self.bundle / f"resource-{index:04d}").write_bytes(b"changed backup")
        with self.assertRaises(ValueError): self.prepare()

    def test_confirmation_and_private_nonoverlapping_journal_are_required(self):
        self.backup()
        saved = self.prepare()
        with self.assertRaisesRegex(RESTORE.RestoreError, "native host"):
            RESTORE.restore(self.root, self.docker, saved, self.journal, host_writers_stopped=False)
        for path in [self.bundle / "restore.json", self.external / "restore.json", self.root / "restore.json"]:
            with self.subTest(path=path), mock.patch.object(RESTORE, "runtime"), mock.patch.object(RESTORE, "copy_resource") as copying:
                with self.assertRaises(ValueError):
                    RESTORE.restore(self.root, self.docker, saved, path, host_writers_stopped=True)
                copying.assert_not_called()
                self.assertFalse(path.exists())

    def test_file_mount_copy_keeps_its_inode_and_exact_bytes_metadata(self):
        self.backup()
        index, item = next((i, item) for i, item in enumerate(self.manifest["plan"]["resources"]) if item["kind"] == "file")
        source = self.bundle / f"resource-{index:04d}"
        self.file.write_bytes(b"different current data")
        os.chmod(self.file, 0o640)
        RESTORE.copy_resource(source, self.file, item, self.manifest["copies"][index])
        RESTORE.verify_destination(self.file, item, self.manifest["copies"][index])
        self.assertEqual(self.file.stat().st_ino, item["inode"])

    @unittest.skipUnless(sys.platform == "linux", "requires Linux xattrs and POSIX ACLs")
    def test_file_attributes_and_root_directory_acl_survive_restore(self):
        entries = [(1, 7, 0xFFFFFFFF), (2, 5, 1234), (4, 0, 0xFFFFFFFF), (16, 5, 0xFFFFFFFF), (32, 0, 0xFFFFFFFF)]
        acl = struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in entries)
        os.setxattr(self.external, "system.posix_acl_access", acl)
        os.setxattr(self.file, "system.posix_acl_access", acl)
        os.setxattr(self.file, "user.orbis-file", b"saved file attribute")
        self.backup()
        saved = self.prepare()
        self.assertTrue(saved["extendedMetadataSealed"])
        os.chmod(self.external, 0o700)
        os.removexattr(self.file, "system.posix_acl_access")
        os.setxattr(self.file, "user.orbis-file", b"changed attribute")
        os.setxattr(self.file, "user.orbis-extra", b"must be removed")
        self.file.write_bytes(b"changed bytes")
        self.assertEqual(self.restore(saved)["result"], "storage-restored")
        self.assertEqual(os.getxattr(self.external, "system.posix_acl_access"), acl)
        self.assertEqual(os.getxattr(self.file, "system.posix_acl_access"), acl)
        self.assertEqual(os.getxattr(self.file, "user.orbis-file"), b"saved file attribute")
        self.assertNotIn("user.orbis-extra", os.listxattr(self.file))

    def test_capacity_failure_and_completed_or_mismatched_journal_never_copy(self):
        self.backup()
        saved = self.prepare()
        with mock.patch.object(RESTORE, "runtime"), mock.patch.object(RESTORE, "capacity", side_effect=RESTORE.RestoreError("more free space")), mock.patch.object(RESTORE, "copy_resource") as copying:
            with self.assertRaisesRegex(RESTORE.RestoreError, "more free space"):
                self.restore(saved)
            copying.assert_not_called()
        self.assertEqual(json.loads(self.journal.read_text())["stage"], "prepared")
        with mock.patch.object(RESTORE, "runtime"), mock.patch.object(RESTORE, "copy_resource") as copying:
            with self.assertRaisesRegex(RESTORE.RestoreError, "already exists"):
                self.restore(saved)
            record = json.loads(self.journal.read_text())
            record["stage"] = "complete"
            self.journal.write_text(json.dumps(record))
            with self.assertRaisesRegex(RESTORE.RestoreError, "invalid, complete"):
                self.restore(saved, recover=True)
            copying.assert_not_called()

    @unittest.skipUnless(sys.platform == "linux", "requires Linux rsync with ACL/xattr support")
    def test_actual_multi_resource_restore_preserves_links_metadata_and_external_files(self):
        hardlink = self.external / "linked-database.bin"
        os.link(self.external / "database.bin", hardlink)
        os.setxattr(hardlink, "user.orbis-restore", b"preserve xattr")
        self.backup()
        saved = self.prepare()
        outside = self.parent / "unrelated"
        outside.write_bytes((self.external / "database.bin").read_bytes())
        os.chmod(outside, 0o600)
        outside_before = STORAGE.file_fingerprint(outside)
        (self.external / "database.bin").unlink()
        os.link(outside, self.external / "database.bin")
        (self.root / ".env").unlink()
        (self.root / ".env").symlink_to(outside)
        (self.root / "extra.txt").write_text("discard staged files")
        self.file.write_bytes(b"changed file")
        (self.volume / "cache.bin").write_bytes(b"changed volume")
        result = self.restore(saved)
        self.assertEqual(result["resources"], 4)
        self.assertEqual(json.loads(self.journal.read_text())["stage"], "complete")
        self.assertEqual(STORAGE.file_fingerprint(outside), outside_before)
        self.assertEqual((self.external / "database.bin").stat().st_ino, hardlink.stat().st_ino)
        self.assertNotEqual(outside.stat().st_ino, hardlink.stat().st_ino)
        self.assertEqual(os.getxattr(hardlink, "user.orbis-restore"), b"preserve xattr")
        self.assertFalse((self.root / ".env").is_symlink())
        self.assertFalse((self.root / "extra.txt").exists())
        self.assertEqual(self.docker.calls, [])
        self.assertEqual(stat.S_IMODE(self.journal.stat().st_mode), 0o600)

    @unittest.skipUnless(sys.platform == "linux", "requires Linux rsync")
    def test_directory_nanoseconds_are_restored_when_integer_seconds_match(self):
        nested = self.root / "nested"
        nested.mkdir()
        (nested / "file").write_bytes(b"unchanged bytes")
        original_ns = 1_700_000_000_123_456_789
        os.utime(nested, ns=(original_ns, original_ns))
        self.backup()
        saved = self.prepare()
        os.utime(nested, ns=(original_ns, original_ns + 37))
        self.assertEqual(self.restore(saved)["result"], "storage-restored")
        self.assertEqual(nested.stat().st_mtime_ns, original_ns)

    @unittest.skipUnless(sys.platform == "linux", "requires Linux rsync")
    def test_interrupted_copy_is_recoverable_and_rechecks_earlier_resources(self):
        self.backup()
        saved = self.prepare()
        original = RESTORE.copy_resource
        count = 0
        def interrupted(*args):
            nonlocal count
            count += 1
            original(*args)
            if count == 2: raise RuntimeError("interrupted after data write")
        with mock.patch.object(RESTORE, "copy_resource", side_effect=interrupted):
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                self.restore(saved)
        record = json.loads(self.journal.read_text())
        self.assertEqual(record["stage"], "restoring")
        self.assertEqual(record["active"], 1)
        self.assertEqual(record["completed"], [0])
        first = self.manifest["plan"]["resources"][0]
        if first["kind"] == "file": Path(first["source"]).write_bytes(b"changed again")
        else: (Path(first["source"]) / "extra").write_text("changed again")
        self.assertEqual(self.restore(saved, recover=True)["result"], "storage-restored")
        with self.assertRaisesRegex(RESTORE.RestoreError, "invalid, complete"):
            self.restore(saved, recover=True)

    @unittest.skipUnless(sys.platform == "linux", "requires Linux rsync")
    def test_writer_restart_during_restore_keeps_recovery_incomplete(self):
        self.backup()
        saved = self.prepare()
        original = RESTORE.copy_resource
        def restarted(*args):
            original(*args)
            self.docker.controller_state = "running"
        with mock.patch.object(RESTORE, "copy_resource", side_effect=restarted):
            with self.assertRaisesRegex(RESTORE.RestoreError, "Stop every"):
                self.restore(saved)
        self.assertNotEqual(json.loads(self.journal.read_text())["stage"], "complete")
        self.quiet()
        self.assertEqual(self.restore(saved, recover=True)["result"], "storage-restored")

    def test_old_or_unsupported_rsync_is_rejected(self):
        for version in ["openrsync: protocol version 29", "rsync version 3.1.2 protocol version 31"]:
            with mock.patch.object(RESTORE.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, version, "")):
                with self.assertRaisesRegex(RESTORE.RestoreError, "3.1.3"):
                    RESTORE.runtime()


if __name__ == "__main__":
    unittest.main()
