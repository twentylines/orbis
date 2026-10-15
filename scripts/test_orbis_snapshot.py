import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("orbis_snapshot", Path(__file__).with_name("orbis-snapshot.py"))
assert SPEC and SPEC.loader
SNAPSHOT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SNAPSHOT)


class OrbisSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "installation"
        (self.root / "data" / "postgres").mkdir(parents=True)
        (self.root / "data" / "postgres" / "record").write_bytes(b"database fixture")
        (self.root / ".env").write_text("SECRET=fixture\n")

    def test_stopped_tree_copy_is_complete_and_tamper_evident(self):
        (self.root / "data" / "current").symlink_to("postgres", target_is_directory=True)
        destination = self.base / "snapshot"
        record = SNAPSHOT.capture(self.root, destination, "v0.1.0-beta.5", "test-daemon")
        self.assertEqual(record["sourceRoot"], str(self.root.resolve()))
        self.assertEqual(record["files"], 2)
        self.assertEqual(destination.stat().st_mode & 0o777, 0o700)
        self.assertEqual(SNAPSHOT.verify(destination, self.root)["treeSha256"], record["treeSha256"])
        self.assertEqual((destination / "data" / "current").readlink(), Path("postgres"))

        (destination / "data" / "postgres" / "record").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "no longer matches"):
            SNAPSHOT.verify(destination, self.root)

    def test_refuses_nested_destinations_and_external_symlinks(self):
        with self.assertRaisesRegex(ValueError, "outside"):
            SNAPSHOT.capture(self.root, self.root / "backup", "v0.1.0-beta.5", "test-daemon")
        (self.root / "external").symlink_to(self.base, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "outside"):
            SNAPSHOT.capture(self.root, self.base / "backup", "v0.1.0-beta.5", "test-daemon")
        self.assertFalse((self.base / "backup").exists())

    def test_requires_sidecar_from_the_same_source(self):
        destination = self.base / "snapshot"
        SNAPSHOT.capture(self.root, destination, "v0.1.0-beta.5", "test-daemon")
        with self.assertRaisesRegex(ValueError, "another installation"):
            SNAPSHOT.verify(destination, self.base)
        SNAPSHOT.sidecar(destination).unlink()
        with self.assertRaisesRegex(ValueError, "sidecar"):
            SNAPSHOT.verify(destination, self.root)

    def test_preflight_reports_size_and_refuses_insufficient_space_before_copy(self):
        estimate = SNAPSHOT.preflight(self.root, self.base / "snapshot")
        self.assertEqual(estimate["files"], 2)
        self.assertGreater(estimate["bytes"], 0)
        self.assertFalse((self.base / "snapshot").exists())
        with mock.patch.object(SNAPSHOT.shutil, "disk_usage", return_value=mock.Mock(free=0)):
            with self.assertRaisesRegex(ValueError, "enough available space"):
                SNAPSHOT.preflight(self.root, self.base / "snapshot")

    def test_partial_copy_failure_has_a_safe_code_and_no_verification_sidecar(self):
        destination = self.base / "snapshot"
        secret = "PRIVATE_COPY_STDERR=must-not-be-exposed"

        def partial_copy(arguments, **kwargs):
            destination.mkdir()
            (destination / "partial").write_bytes(b"incomplete fixture")
            return subprocess.CompletedProcess(arguments, 1, b"", secret.encode())

        with mock.patch.object(SNAPSHOT.subprocess, "run", side_effect=partial_copy):
            with self.assertRaises(SNAPSHOT.SnapshotError) as raised:
                SNAPSHOT.capture(self.root, destination, "v0.1.0-beta.5", "test-daemon")

        self.assertEqual(raised.exception.code, "snapshot-copy-failed")
        self.assertNotIn(secret, str(raised.exception))
        self.assertTrue((destination / "partial").exists())
        self.assertFalse(SNAPSHOT.sidecar(destination).exists())
        with self.assertRaisesRegex(ValueError, "sidecar"):
            SNAPSHOT.verify(destination, self.root)

    def test_source_read_error_is_wrapped_without_disclosing_the_underlying_message(self):
        destination = self.base / "snapshot"
        secret = "PRIVATE_READ_PATH=must-not-be-exposed"
        with mock.patch.object(SNAPSHOT, "fingerprint", side_effect=PermissionError(secret)):
            with mock.patch.object(SNAPSHOT.subprocess, "run") as copy:
                with self.assertRaises(SNAPSHOT.SnapshotError) as raised:
                    SNAPSHOT.capture(self.root, destination, "v0.1.0-beta.5", "test-daemon")

        self.assertEqual(raised.exception.code, "snapshot-source-read-failed")
        self.assertNotIn(secret, str(raised.exception))
        copy.assert_not_called()
        self.assertFalse(destination.exists())
        self.assertFalse(SNAPSHOT.sidecar(destination).exists())

    def test_source_change_after_copy_never_seals_the_snapshot(self):
        destination = self.base / "snapshot"
        run_copy = SNAPSHOT.subprocess.run

        def copy_then_change_source(arguments, **kwargs):
            copied = run_copy(arguments, **kwargs)
            self.assertEqual(copied.returncode, 0)
            (self.root / "data" / "postgres" / "record").write_bytes(b"changed after copy")
            return copied

        with mock.patch.object(SNAPSHOT.subprocess, "run", side_effect=copy_then_change_source):
            with self.assertRaises(SNAPSHOT.SnapshotError) as raised:
                SNAPSHOT.capture(self.root, destination, "v0.1.0-beta.5", "test-daemon")

        self.assertEqual(raised.exception.code, "snapshot-source-changed")
        self.assertEqual((destination / "data" / "postgres" / "record").read_bytes(), b"database fixture")
        self.assertFalse(SNAPSHOT.sidecar(destination).exists())

    def test_copied_content_mismatch_never_seals_the_snapshot(self):
        destination = self.base / "snapshot"
        run_copy = SNAPSHOT.subprocess.run

        def copy_then_corrupt_destination(arguments, **kwargs):
            copied = run_copy(arguments, **kwargs)
            self.assertEqual(copied.returncode, 0)
            (destination / "data" / "postgres" / "record").write_bytes(b"damaged copy")
            return copied

        with mock.patch.object(SNAPSHOT.subprocess, "run", side_effect=copy_then_corrupt_destination):
            with self.assertRaises(SNAPSHOT.SnapshotError) as raised:
                SNAPSHOT.capture(self.root, destination, "v0.1.0-beta.5", "test-daemon")

        self.assertEqual(raised.exception.code, "snapshot-copy-mismatch")
        self.assertEqual((self.root / "data" / "postgres" / "record").read_bytes(), b"database fixture")
        self.assertFalse(SNAPSHOT.sidecar(destination).exists())

    def test_copied_permission_mismatch_is_not_accepted_even_when_bytes_match(self):
        destination = self.base / "snapshot"
        source_record = self.root / "data" / "postgres" / "record"
        source_record.chmod(0o600)
        run_copy = SNAPSHOT.subprocess.run

        def copy_then_change_permissions(arguments, **kwargs):
            copied = run_copy(arguments, **kwargs)
            self.assertEqual(copied.returncode, 0)
            (destination / "data" / "postgres" / "record").chmod(0o644)
            return copied

        with mock.patch.object(SNAPSHOT.subprocess, "run", side_effect=copy_then_change_permissions):
            with self.assertRaises(SNAPSHOT.SnapshotError) as raised:
                SNAPSHOT.capture(self.root, destination, "v0.1.0-beta.5", "test-daemon")

        self.assertEqual(raised.exception.code, "snapshot-copy-mismatch")
        self.assertEqual((destination / "data" / "postgres" / "record").read_bytes(), source_record.read_bytes())
        self.assertFalse(SNAPSHOT.sidecar(destination).exists())

    def test_sidecar_publish_failure_is_safe_and_leaves_no_sidecar_or_temporary_seal(self):
        destination = self.base / "snapshot"
        secret = "PRIVATE_SEAL_PATH=must-not-be-exposed"
        with mock.patch.object(SNAPSHOT.os, "replace", side_effect=OSError(secret)):
            with self.assertRaises(SNAPSHOT.SnapshotError) as raised:
                SNAPSHOT.capture(self.root, destination, "v0.1.0-beta.5", "test-daemon")

        self.assertEqual(raised.exception.code, "snapshot-seal-failed")
        self.assertNotIn(secret, str(raised.exception))
        self.assertTrue(destination.is_dir())
        self.assertFalse(SNAPSHOT.sidecar(destination).exists())
        self.assertEqual(list(self.base.glob(".snapshot.*")), [])

    def test_snapshot_chmod_failure_is_safe_and_does_not_create_a_sidecar(self):
        destination = self.base / "snapshot"
        secret = "PRIVATE_CHMOD_PATH=must-not-be-exposed"
        with mock.patch.object(SNAPSHOT.os, "chmod", side_effect=OSError(secret)):
            with self.assertRaises(SNAPSHOT.SnapshotError) as raised:
                SNAPSHOT.capture(self.root, destination, "v0.1.0-beta.5", "test-daemon")

        self.assertEqual(raised.exception.code, "snapshot-seal-failed")
        self.assertNotIn(secret, str(raised.exception))
        self.assertFalse(SNAPSHOT.sidecar(destination).exists())


if __name__ == "__main__":
    unittest.main()
