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

    def passkeys(self):
        authentication = self.root / 'state/auth'
        authentication.mkdir(mode=0o700)
        file = authentication / 'passkeys.json'
        file.write_text(json.dumps({'version': 1, 'users': {'1': {'handle': 'Zm9ybWVy', 'credentials': [{'id': 'b2xkLWtleQ'}]}}}))
        file.chmod(0o600)
        return file

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
        passkeys = self.passkeys()
        (self.root / 'backups').mkdir()
        evidence = self.root / 'backups/recovery-material'
        evidence.write_text('retained recovery evidence')
        plan = self.plan()
        def truncate(command, **kwargs):
            self.assertNotEqual(FRESH.secret(self.root), "original-controller-secret")
            self.assertEqual(self.cache_count(), 0)
            self.assertFalse((self.root / "state/desktop").exists())
            self.assertFalse((self.root / "state/onboarding").exists())
            # The SQL command reuses account ID1. No former ID1 credential may
            # remain available to PasskeyStore when the new account is created.
            self.assertFalse(passkeys.exists())
            self.assertTrue(passkeys.parent.is_dir())
            self.assertEqual(evidence.read_text(), 'retained recovery evidence')
            self.assertEqual((self.root / "state/settings.json").read_text(), '{"domain":"example.test"}')
            self.assertIn("RESTART IDENTITY RESTRICT", command[-1])
            self.assertNotIn("CASCADE", command[-1])
            return SimpleNamespace(returncode=0)
        self.reader._read.side_effect = [json.dumps(accounts()), json.dumps(accounts(0, 0))]
        with mock.patch.object(FRESH.subprocess, "run", side_effect=truncate):
            result = FRESH.reset(self.root, self.reader, "database", plan)
        self.assertEqual(result["accountsRemoved"], 2)
        self.assertTrue(result["cacheRevoked"])
        self.assertTrue(result["passkeysRevoked"])
        self.assertEqual(result['reviewSha256'], FRESH.review_digest(plan))
        self.assertEqual(result['authenticationSha256'], FRESH.review_digest(FRESH.authentication(self.root)))
        self.assertNotIn(FRESH.secret(self.root), json.dumps(result))

    def test_passkey_review_is_read_only_contains_only_digests_and_binds_round_trip(self):
        file = self.passkeys()
        original = file.read_bytes()
        plan = self.plan()
        self.assertEqual(file.read_bytes(), original)
        self.assertNotIn('b2xkLWtleQ', json.dumps(plan))
        self.assertEqual(plan['authentication'], json.loads(json.dumps(plan))['authentication'])
        cleared = FRESH.authentication(self.root, clear=True, expected=plan['authentication'])
        self.assertFalse(file.exists())
        self.assertEqual(cleared, FRESH.authentication(self.root))

    def test_unsafe_or_unknown_authentication_state_refuses_without_revoking_anything(self):
        file = self.passkeys()
        original = file.read_bytes()
        unknown = file.parent / 'future-credential-store.json'
        unknown.write_text('keep evidence')
        with self.assertRaisesRegex(FRESH.FreshError, 'Unknown authentication state'):
            self.plan()
        self.assertEqual(unknown.read_text(), 'keep evidence')
        self.assertEqual(file.read_bytes(), original)
        self.assertEqual(FRESH.secret(self.root), 'original-controller-secret')
        unknown.unlink()
        file.chmod(0o640)
        with self.assertRaises(FRESH.FreshError):
            self.plan()
        self.assertEqual(file.read_bytes(), original)
        file.chmod(0o600)
        file.parent.chmod(0o750)
        with self.assertRaises(FRESH.FreshError):
            self.plan()
        self.assertEqual(file.read_bytes(), original)

    def test_passkey_owner_must_match_private_authentication_directory(self):
        file = self.passkeys()
        inode = file.stat().st_ino
        real = FRESH.os.fstat
        def changed(fd):
            info = real(fd)
            if info.st_ino != inode:
                return info
            value = {name: getattr(info, name) for name in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')}
            value['st_uid'] += 1
            return SimpleNamespace(**value)
        with mock.patch.object(FRESH.os, 'fstat', side_effect=changed):
            with self.assertRaisesRegex(FRESH.FreshError, 'custody review'):
                self.plan()
        self.assertTrue(file.exists())

    def test_passkey_symlink_hardlink_and_fifo_are_never_followed_or_removed(self):
        file = self.passkeys()
        file.unlink()
        outside = self.root / 'retained-credentials'
        outside.write_text('keep outside')
        outside.chmod(0o600)
        for kind in ('symlink', 'hardlink', 'fifo'):
            if kind == 'symlink':
                file.symlink_to(outside)
            elif kind == 'hardlink':
                os.link(outside, file)
            else:
                os.mkfifo(file, 0o600)
            with self.subTest(kind=kind), self.assertRaises(FRESH.FreshError):
                self.plan()
            self.assertTrue(file.exists() or file.is_symlink())
            self.assertEqual(outside.read_text(), 'keep outside')
            file.unlink()

    def test_auth_directory_symlink_and_mount_overrides_are_not_revoked(self):
        outside = self.root / 'retained-authentication'
        outside.mkdir(mode=0o700)
        target = self.root / 'state/auth'
        target.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(FRESH.FreshError):
            self.plan()
        self.assertTrue(target.is_symlink())
        target.unlink()
        for destination in ('/data/state/auth', '/data/state/auth/passkeys.json'):
            self.raw['Mounts'].append({'Destination': destination, 'Source': str(outside), 'Type': 'bind', 'RW': False})
            with self.subTest(destination=destination), self.assertRaisesRegex(FRESH.FreshError, 'Custom authentication mounts'):
                self.plan()
            self.raw['Mounts'].pop()

    def test_changed_passkey_bytes_or_directory_custody_hold_before_jwt_rotation(self):
        file = self.passkeys()
        plan = self.plan()
        file.write_text('changed credential state')
        with mock.patch.object(FRESH.subprocess, 'run') as run:
            with self.assertRaisesRegex(FRESH.FreshError, 'changed since review'):
                FRESH.reset(self.root, self.reader, 'database', plan)
            run.assert_not_called()
        self.assertEqual(FRESH.secret(self.root), 'original-controller-secret')
        self.assertEqual(self.cache_count(), 7)
        plan = self.plan()
        file.parent.rename(self.root / 'retained-old-auth')
        file.parent.mkdir(mode=0o700)
        with self.assertRaisesRegex(FRESH.FreshError, 'changed since review'):
            FRESH.reset(self.root, self.reader, 'database', plan)
        self.assertEqual((self.root / 'retained-old-auth/passkeys.json').read_text(), 'changed credential state')

    def test_nested_mount_and_same_inode_mount_replacement_hold_without_deletion(self):
        file = self.passkeys()
        auth_inode = file.parent.stat().st_ino
        with mock.patch.object(FRESH, '_mount_id', side_effect=lambda fd: 2 if os.fstat(fd).st_ino == auth_inode else 1):
            with self.assertRaisesRegex(FRESH.FreshError, 'custody review'):
                self.plan()
        plan = self.plan()
        with mock.patch.object(FRESH, '_mount_id', return_value=777):
            with self.assertRaisesRegex(FRESH.FreshError, 'changed since review'):
                FRESH.reset(self.root, self.reader, 'database', plan)
        self.assertTrue(file.exists())
        self.assertEqual(FRESH.secret(self.root), 'original-controller-secret')

    def test_unlink_failure_keeps_accounts_unreused_and_reports_stopped_recovery(self):
        file = self.passkeys()
        plan = self.plan()
        original = FRESH.os.unlink
        def refuse(path, *args, **kwargs):
            if path == 'passkeys.json':
                raise PermissionError('fixture revoke denied')
            return original(path, *args, **kwargs)
        with mock.patch.object(FRESH.os, 'unlink', side_effect=refuse), mock.patch.object(FRESH.subprocess, 'run') as run:
            with self.assertRaisesRegex(FRESH.FreshError, 'keep the installation stopped'):
                FRESH.reset(self.root, self.reader, 'database', plan)
            run.assert_not_called()
        self.assertTrue(file.exists())
        self.assertNotEqual(FRESH.secret(self.root), 'original-controller-secret')
        self.assertEqual(self.cache_count(), 0)

    def test_recreated_credential_before_success_keeps_stopped_installation_in_recovery(self):
        file = self.passkeys()
        original = file.read_bytes()
        plan = self.plan()
        def truncate(command, **kwargs):
            self.assertFalse(file.exists())
            file.write_bytes(original)
            file.chmod(0o600)
            return SimpleNamespace(returncode=0)
        self.reader._read.side_effect = [json.dumps(accounts()), json.dumps(accounts(0, 0))]
        with mock.patch.object(FRESH.subprocess, 'run', side_effect=truncate):
            with self.assertRaisesRegex(FRESH.FreshError, 'keep the installation stopped'):
                FRESH.reset(self.root, self.reader, 'database', plan)
        self.assertEqual(file.read_bytes(), original)

    def test_fsync_failure_after_unlink_reports_partial_revocation_without_reusing_accounts(self):
        file = self.passkeys()
        plan = self.plan()
        auth_inode = file.parent.stat().st_ino
        real = FRESH.os.fsync
        def refuse(fd):
            if os.fstat(fd).st_ino == auth_inode:
                raise OSError('fixture durable revocation failure')
            return real(fd)
        with mock.patch.object(FRESH.os, 'fsync', side_effect=refuse), mock.patch.object(FRESH.subprocess, 'run') as run:
            with self.assertRaisesRegex(FRESH.FreshError, 'keep the installation stopped'):
                FRESH.reset(self.root, self.reader, 'database', plan)
            run.assert_not_called()
        self.assertFalse(file.exists())
        self.assertNotEqual(FRESH.secret(self.root), 'original-controller-secret')

    def test_empty_auth_directory_is_retained_and_missing_directory_is_not_created(self):
        absent = FRESH.authentication(self.root)
        self.assertIsNone(absent['directory'])
        self.assertEqual(FRESH.authentication(self.root, clear=True, expected=absent), absent)
        self.assertFalse((self.root / 'state/auth').exists())
        (self.root / 'state/auth').mkdir(mode=0o700)
        empty = FRESH.authentication(self.root)
        self.assertIsNone(empty['passkeys'])
        self.assertEqual(FRESH.authentication(self.root, clear=True, expected=empty), empty)
        self.assertTrue((self.root / 'state/auth').is_dir())

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
