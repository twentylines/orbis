import importlib.util
import tempfile
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("migration_preflight", Path(__file__).with_name("migration-preflight.py"))
assert SPEC and SPEC.loader
PREFLIGHT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREFLIGHT)


class MigrationPreflightTests(unittest.TestCase):
    def test_inventory_never_returns_env_values(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".env").write_text("SECRET_TOKEN=private-value\nRUNTIPI_APPS_PATH=.internal\n")
            (root / "docker-compose.yml").touch()
            for name in PREFLIGHT.DATA_PATHS:
                (root / ".internal" / name).mkdir(parents=True)
            report = PREFLIGHT.inspect(root)
            self.assertEqual(report["result"], "inventory-only")
            self.assertNotIn("private-value", str(report))
            self.assertEqual(report["directories"]["apps"]["status"], "present")

    def test_external_override_is_not_inspected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".env").write_text("RUNTIPI_APPS_PATH=/outside-this-copy\n")
            report = PREFLIGHT.inspect(root)
            self.assertEqual(report["directories"]["apps"]["status"], "external-path-not-inspected")
            self.assertIn("apps", report["criticalDirectoriesNeedingReview"])


if __name__ == "__main__":
    unittest.main()
