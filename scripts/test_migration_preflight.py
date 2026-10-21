import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("migration_preflight", Path(__file__).with_name("migration-preflight.py"))
assert SPEC and SPEC.loader
PREFLIGHT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREFLIGHT)


class MigrationPreflightTests(unittest.TestCase):
    def test_native_orbis_json_layout_requires_the_local_writable_database(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / ".env").write_text(f"ROOT_FOLDER_HOST={root}\n")
            for name in [*PREFLIGHT.DATA_PATHS, "data/postgres"]:
                (root / name).mkdir(parents=True)
            mount = {"type": "bind", "source": str(root / "data/postgres"), "target": "/var/lib/postgresql/data", "read_only": False}
            config = {"services": {"runtipi": {"image": "ghcr.io/twentylines/orbis@sha256:" + "a" * 64}, "runtipi-db": {"volumes": [mount]}}}
            path = root / "docker-compose.yml"
            path.write_text(json.dumps(config))
            report = PREFLIGHT.inspect(root)
            self.assertEqual(report["layout"], "orbis-v1")
            self.assertEqual(report["result"], "inventory-only")
            for key, value in [("source", "/outside/postgres"), ("read_only", True), ("type", "volume")]:
                changed = json.loads(json.dumps(config))
                changed["services"]["runtipi-db"]["volumes"][0][key] = value
                path.write_text(json.dumps(changed))
                with self.subTest(key=key):
                    self.assertEqual(PREFLIGHT.inspect(root)["layout"], "unknown")
            path.write_text(json.dumps(config))
            (root / ".env").write_text("ROOT_FOLDER_HOST=/another/install\n")
            self.assertEqual(PREFLIGHT.inspect(root)["result"], "review-required")

    def test_inventory_never_returns_env_values(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".env").write_text(f"SECRET_TOKEN=private-value\nROOT_FOLDER_HOST={root}\n")
            (root / "docker-compose.yml").write_text("services:\n  runtipi-db:\n    volumes:\n      - ./data/postgres:/var/lib/postgresql/data\n")
            for name in PREFLIGHT.DATA_PATHS:
                (root / name).mkdir(parents=True)
            (root / "data" / "postgres").mkdir(parents=True)
            report = PREFLIGHT.inspect(root)
            self.assertEqual(report["result"], "inventory-only")
            self.assertNotIn("private-value", str(report))
            self.assertEqual(report["layout"], "cli-v4")
            self.assertEqual(report["rootFolderHost"], "matches-copy")
            self.assertEqual(report["directories"]["apps"]["status"], "present")
            self.assertEqual(report["database"]["status"], "present")

    def test_source_compose_reports_named_database_volume_as_uninspected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".env").touch()
            (root / "docker-compose.prod.yml").write_text("services:\n  runtipi-db:\n    volumes:\n      - pgdata:/var/lib/postgresql/data\n")
            for name in PREFLIGHT.DATA_PATHS:
                (root / ".internal" / name).mkdir(parents=True)
            report = PREFLIGHT.inspect(root)
            self.assertEqual(report["layout"], "source-compose")
            self.assertEqual(report["directories"]["apps"]["status"], "present")
            self.assertEqual(report["database"]["status"], "docker-volume-not-inspected")
            self.assertEqual(report["result"], "review-required")

    def test_copied_cli_root_with_stale_host_path_needs_review(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".env").write_text("ROOT_FOLDER_HOST=/original/runtipi\n")
            (root / "docker-compose.yml").write_text("services:\n  runtipi-db:\n    volumes:\n      - ./data/postgres:/var/lib/postgresql/data\n")
            for name in PREFLIGHT.DATA_PATHS:
                (root / name).mkdir()
            (root / "data" / "postgres").mkdir(parents=True)
            report = PREFLIGHT.inspect(root)
            self.assertEqual(report["rootFolderHost"], "points-elsewhere")
            self.assertEqual(report["result"], "review-required")

    def test_external_override_is_not_inspected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".env").write_text("RUNTIPI_APPS_PATH=/outside-this-copy\n")
            (root / "docker-compose.yml").write_text("services:\n  runtipi-db:\n    volumes:\n      - ./data/postgres:/var/lib/postgresql/data\n")
            report = PREFLIGHT.inspect(root)
            self.assertEqual(report["directories"]["apps"]["status"], "external-path-not-inspected")
            self.assertIn("apps", report["criticalDirectoriesNeedingReview"])

    def test_external_noncritical_path_needs_review(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".env").write_text(f"ROOT_FOLDER_HOST={root}\nRUNTIPI_MEDIA_PATH=/external/media\n")
            (root / "docker-compose.yml").write_text("services:\n  runtipi-db:\n    volumes:\n      - ./data/postgres:/var/lib/postgresql/data\n")
            for name in PREFLIGHT.DATA_PATHS:
                (root / name).mkdir()
            (root / "data" / "postgres").mkdir(parents=True)
            report = PREFLIGHT.inspect(root)
            self.assertEqual(report["result"], "review-required")
            self.assertIn("media", report["otherPathsNeedingReview"])


if __name__ == "__main__":
    unittest.main()
