import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("fingerprint", Path(__file__).with_name("orbis-migration-fingerprint.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FingerprintTests(unittest.TestCase):
    def test_published_beta90_ledger_is_recognised(self):
        root = Path(__file__).resolve().parent.parent / "packages/backend/src/core/database/drizzle"
        self.assertEqual(MODULE.fingerprint(root), "sha256:ed90c4f22eb28f9c594d4fa56f27eb7447dbd39962659f4a8657cf2a47cca5ae")

    def test_changed_sql_changes_identity_and_invalid_order_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "meta").mkdir()
            journal = {"dialect": "postgresql", "entries": [{"idx": 0, "when": 100, "tag": "0000_first"}]}
            (root / "meta/_journal.json").write_text(json.dumps(journal))
            (root / "0000_first.sql").write_text("select 1;")
            first = MODULE.fingerprint(root)
            (root / "0000_first.sql").write_text("select 2;")
            self.assertNotEqual(first, MODULE.fingerprint(root))
            journal["entries"].append({"idx": 1, "when": 100, "tag": "0001_second"})
            (root / "meta/_journal.json").write_text(json.dumps(journal))
            with self.assertRaises(ValueError):
                MODULE.fingerprint(root)
