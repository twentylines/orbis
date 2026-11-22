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
        journal = json.loads((root / "meta/_journal.json").read_text())
        entries = journal["entries"]
        self.assertEqual(len(entries[:32]), 32)
        self.assertEqual(entries[31]["tag"], "0031_editable_apps")
        with tempfile.TemporaryDirectory() as directory:
            historical = Path(directory)
            (historical / "meta").mkdir()
            (historical / "meta/_journal.json").write_text(json.dumps({**journal, "entries": entries[:32]}))
            for entry in entries[:32]:
                migration = entry["tag"] + ".sql"
                (historical / migration).write_bytes((root / migration).read_bytes())
            self.assertEqual(MODULE.fingerprint(historical), "sha256:ed90c4f22eb28f9c594d4fa56f27eb7447dbd39962659f4a8657cf2a47cca5ae")

    def test_published_reset_receipt_ledger_is_recognised(self):
        root = Path(__file__).resolve().parent.parent / "packages/backend/src/core/database/drizzle"
        journal = json.loads((root / "meta/_journal.json").read_text())
        entries = journal["entries"][:33]
        self.assertEqual(entries[-1]["tag"], "0032_orbis_reset_receipt")
        with tempfile.TemporaryDirectory() as directory:
            historical = Path(directory)
            (historical / "meta").mkdir()
            (historical / "meta/_journal.json").write_text(json.dumps({**journal, "entries": entries}))
            for entry in entries:
                migration = entry["tag"] + ".sql"
                (historical / migration).write_bytes((root / migration).read_bytes())
            self.assertEqual(MODULE.fingerprint(historical), "sha256:be16f8619e76a8b861389cf9b643c50aea7634a87e893b7a3590db77c58e9ce9")

    def test_current_ledger_includes_reset_and_app_migration_receipts(self):
        root = Path(__file__).resolve().parent.parent / "packages/backend/src/core/database/drizzle"
        entries = json.loads((root / "meta/_journal.json").read_text())["entries"]
        self.assertEqual(len(entries), 35)
        self.assertEqual([entry["tag"] for entry in entries[-3:]],
                         ["0032_orbis_reset_receipt", "0033_app_migration_ledger", "0034_app_migration_commit"])
        self.assertEqual(MODULE.fingerprint(root), "sha256:40fe7e4d5bc8f5243c2015e12639a64eefaed17ed29ab79f3962669db59d7794")

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
