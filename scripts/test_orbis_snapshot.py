import importlib.util
import tempfile
import unittest
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()
