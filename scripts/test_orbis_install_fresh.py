import importlib.util
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SPEC = importlib.util.spec_from_file_location("install_fresh", Path(__file__).with_name("orbis-install-fresh.py"))
assert SPEC and SPEC.loader
FRESH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FRESH)


def accounts(users=2, links=3):
    return {"users": users, "links": links, "references": ["link"], "customTriggers": 0, "descendants": 0, "apps": "a" * 64, "stores": "b" * 64}


class FreshTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        (self.root / "state").mkdir()
        (self.root / "cache").mkdir()
        self.environment = "JWT_SECRET='original-controller-secret'\nPOSTGRES_PASSWORD=database-fixture\nDOMAIN=example.test\n"
        (self.root / ".env").write_text(self.environment)
        for name in ("desktop", "onboarding"):
            (self.root / "state" / name).mkdir()
            (self.root / "state" / name / "1.json").write_text('{"version":1}')
        (self.root / "state/seed").write_bytes(b"persistent-application-seed")
        (self.root / "state/settings.json").write_text('{"domain":"example.test"}')
        self.db = self.root / "cache/cache.sqlite"
        with closing(sqlite3.connect(self.db)) as db:
            db.execute("CREATE TABLE keyv (key TEXT PRIMARY KEY, value TEXT)")
            db.executemany("INSERT INTO keyv VALUES (?,?)", [(key, '"credential-fixture"') for key in (
                "session:old", "session:1:old", "forward-auth-session:old", "forward-auth-grant:old", "totp-attempts:old", "358d7dc2-10c0-44b5-a1af-6e5bfa542773", "buster")])
            db.commit()
        self.reader = SimpleNamespace(context="explicit-context", _read=mock.Mock(return_value=json.dumps(accounts())))
        self.raw = {"Mounts": [{"Destination": destination, "Type": "bind", "Source": str(self.root / source), "RW": True} for destination, source in (
            ("/data/.env", ".env"), ("/data/state", "state"), ("/cache", "cache"))], "Config": {"Env": ["JWT_SECRET=original-controller-secret"]}}

    def plan(self):
        with mock.patch.object(FRESH, "compose_intent"):
            return FRESH.review(self.root, self.reader, self.raw, "database")

    def cache_count(self):
        with closing(sqlite3.connect(self.db)) as db:
            return db.execute("SELECT count(*) FROM keyv").fetchone()[0]

    def test_review_does_not_change_files_or_cache_and_contains_no_credential(self):
        value = self.plan()
        self.assertEqual((self.root / ".env").read_text(), self.environment)
        self.assertEqual(self.cache_count(), 7)
        self.assertNotIn("original-controller-secret", json.dumps(value))
        self.assertNotIn("credential-fixture", json.dumps(value))

    def test_cache_revokes_every_credential_form_including_unprefixed_totp(self):
        FRESH.cache(self.db, clear=True)
        self.assertEqual(self.cache_count(), 0)
        self.assertTrue((self.root / "state/seed").exists())

    def test_unknown_sqlite_tables_and_triggers_refuse_without_deleting_data(self):
        with closing(sqlite3.connect(self.db)) as db:
            db.execute("CREATE TABLE unrelated (value TEXT)")
        with self.assertRaisesRegex(FRESH.FreshError, "unknown cache format"):
            FRESH.cache(self.db, clear=True)
        self.assertEqual(self.cache_count(), 7)

    def test_cache_sidecar_symlink_is_not_opened(self):
        outside = self.root / "application-data"
        outside.write_text("retained")
        Path(str(self.db) + "-journal").symlink_to(outside)
        with self.assertRaises(FRESH.FreshError):
            FRESH.cache(self.db, clear=True)
        self.assertEqual(outside.read_text(), "retained")

    def test_missing_cache_is_allowed_without_creating_a_database(self):
        self.db.unlink()
        FRESH.cache(self.db, clear=True)
        self.assertFalse(self.db.exists())

    def test_missing_cache_with_old_sidecar_is_not_treated_as_a_fresh_database(self):
        self.db.unlink()
        Path(str(self.db) + "-wal").write_bytes(b"old-cache-state")
        with self.assertRaisesRegex(FRESH.FreshError, "Orphaned authentication cache"):
            FRESH.cache(self.db, clear=True)
        self.assertFalse(self.db.exists())

    def test_rotation_preserves_other_environment_values_and_seed(self):
        (self.root / ".env").chmod(0o640)
        digest = FRESH.rotate_secret(self.root)
        key = FRESH.secret(self.root)
        self.assertRegex(key, r"^[0-9a-f]{128}$")
        self.assertEqual(digest, FRESH.key_hash(key))
        self.assertEqual((self.root / ".env").read_text().splitlines()[1:], self.environment.splitlines()[1:])
        self.assertEqual((self.root / "state/seed").read_bytes(), b"persistent-application-seed")
        self.assertEqual((self.root / ".env").stat().st_mode & 0o777, 0o640)

    def test_duplicate_missing_and_malformed_signing_keys_refuse(self):
        for text in ["JWT_SECRET=a\nJWT_SECRET=b\n", "DOMAIN=example.test\n", "JWT_SECRET=\n", "JWT_SECRET='unfinished\n"]:
            with self.subTest(text=text):
                (self.root / ".env").write_text(text)
                with self.assertRaises(FRESH.FreshError):
                    FRESH.rotate_secret(self.root)
                self.assertEqual((self.root / ".env").read_text(), text)

    def test_symlink_or_hardlinked_auth_state_is_not_followed(self):
        outside = self.root / "app-state"
        outside.write_text("app-data")
        target = self.root / "state/desktop/1.json"
        target.unlink()
        target.symlink_to(outside)
        with self.assertRaises(FRESH.FreshError):
            self.plan()
        target.unlink()
        os.link(outside, target)
        with self.assertRaises(FRESH.FreshError):
            self.plan()
        self.assertEqual(outside.read_text(), "app-data")

    def test_custom_state_mount_or_running_key_mismatch_refuses(self):
        self.raw["Mounts"][0]["Source"] = str(self.root / "other.env")
        with self.assertRaisesRegex(FRESH.FreshError, "Custom controller state mounts"):
            self.plan()
        self.raw["Mounts"][0]["Source"] = str(self.root / ".env")
        self.raw["Config"]["Env"] = ["JWT_SECRET=another-key"]
        with self.assertRaisesRegex(FRESH.FreshError, "different signing key"):
            self.plan()

    def test_unknown_user_references_triggers_or_inheritance_refuse(self):
        for changed in [{"references": ["link", "custom_app_owner"]}, {"customTriggers": 1}, {"descendants": 1}]:
            self.reader._read.return_value = json.dumps({**accounts(), **changed})
            with self.subTest(changed=changed), self.assertRaisesRegex(FRESH.FreshError, "Custom account tables"):
                self.plan()

    def test_compose_must_load_the_rotated_environment_not_a_literal_key(self):
        for config, allowed in [
            ({"env_file": [{"path": str(self.root / ".env")}]}, True),
            ({"environment": {"JWT_SECRET": "${JWT_SECRET}"}}, True),
            ({"environment": {"JWT_SECRET": "literal-old-key"}}, False),
            ({"env_file": [{"path": str(self.root / "another.env")}]}, False),
        ]:
            result = SimpleNamespace(returncode=0, stdout=json.dumps({"services": {"runtipi": config}}))
            with self.subTest(config=config), mock.patch.object(FRESH.subprocess, "run", return_value=result) as run:
                if allowed:
                    FRESH.compose_intent(self.root, self.reader)
                else:
                    with self.assertRaises(FRESH.FreshError):
                        FRESH.compose_intent(self.root, self.reader)
                self.assertEqual(run.call_args.args[0][1:3], ["--context", "explicit-context"])

    def test_revocation_precedes_reused_ids_and_only_account_state_is_removed(self):
        plan = self.plan()
        def truncate(command, **kwargs):
            self.assertNotEqual(FRESH.secret(self.root), "original-controller-secret")
            self.assertEqual(self.cache_count(), 0)
            self.assertFalse((self.root / "state/desktop").exists())
            self.assertFalse((self.root / "state/onboarding").exists())
            self.assertEqual((self.root / "state/settings.json").read_text(), '{"domain":"example.test"}')
            self.assertIn("RESTART IDENTITY RESTRICT", command[-1])
            self.assertNotIn("CASCADE", command[-1])
            return SimpleNamespace(returncode=0)
        self.reader._read.side_effect = [json.dumps(accounts()), json.dumps(accounts(0, 0))]
        with mock.patch.object(FRESH.subprocess, "run", side_effect=truncate):
            result = FRESH.reset(self.root, self.reader, "database", plan)
        self.assertEqual(result["accountsRemoved"], 2)
        self.assertTrue(result["cacheRevoked"])
        self.assertNotIn(FRESH.secret(self.root), json.dumps(result))

    def test_database_failure_does_not_claim_fresh_success(self):
        plan = self.plan()
        with mock.patch.object(FRESH.subprocess, "run", return_value=SimpleNamespace(returncode=1)):
            with self.assertRaisesRegex(FRESH.FreshError, "recover the stopped installation"):
                FRESH.reset(self.root, self.reader, "database", plan)

    def test_app_metadata_drift_is_a_failure_not_a_successful_reset(self):
        plan = self.plan()
        self.reader._read.side_effect = [json.dumps(accounts()), json.dumps({**accounts(0, 0), "apps": "c" * 64})]
        with mock.patch.object(FRESH.subprocess, "run", return_value=SimpleNamespace(returncode=0)):
            with self.assertRaisesRegex(FRESH.FreshError, "preserve the installed app metadata"):
                FRESH.reset(self.root, self.reader, "database", plan)


if __name__ == "__main__":
    unittest.main()
