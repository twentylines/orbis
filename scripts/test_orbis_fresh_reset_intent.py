import hashlib
import json
import shutil
import unittest
from unittest import mock

import test_orbis_fresh_installer as fixture

M = fixture.M


class FreshResetIntentTests(unittest.TestCase):
    """Real public workflow and file restoration, with the parent IO ports.

    Docker and SQL observations plus the Linux copier remain synthetic. These
    tests establish source recovery behavior, not native database restoration.
    """
    def setUp(self):
        self.workflow = fixture.FreshInstallerTests('test_public_review_apply_uses_all_protected_phases_and_finishes_exact_target')
        self.addCleanup(self.workflow.doCleanups); self.workflow.setUp()
        self.c = self.workflow.c
        self.original = (self.c.root / '.env').read_bytes()

    def phase(self, name):
        record = json.loads(self.c.journal.read_text())
        return M.phase_path(self.c.root, record['ownershipPermit']['operationId'], name)

    def apply(self, guard):
        reviewed = self.workflow.review(guard)
        return self.workflow.apply(guard, reviewed)

    def assert_recovered(self, sql_calls):
        c = self.c
        self.assertEqual((c.root / '.env').read_bytes(), self.original)
        self.assertEqual(c.sql_calls, sql_calls)
        self.assertEqual(self.workflow.b.copy_calls, 1)
        self.assertTrue(self.phase('reset-intent').exists())
        self.assertFalse(self.phase('reset').exists())
        self.assertFalse(self.phase('birth').exists())
        before = c.journal.read_bytes()
        with c.b.guarded() as guard, mock.patch.object(c.r.FRESH, 'reset', side_effect=AssertionError('Reset must not repeat')):
            self.assertIsNone(guard.read())
            self.assertEqual(self.workflow.recover(guard)['result'], 'original-runtipi-recovered')
        self.assertEqual(c.journal.read_bytes(), before)
        self.assertEqual(c.sql_calls, sql_calls)

    def test_rotation_intent_precedes_first_revocation_write_and_contains_no_key(self):
        c = self.c
        cache = c.r.FRESH.cache
        def interrupted(path, **kwargs):
            if kwargs.get('clear'):
                intent = json.loads(self.phase('reset-intent').read_text())['data']
                self.assertNotEqual((c.root / '.env').read_bytes(), self.original)
                self.assertEqual(intent['jwtHash'], c.r.FRESH.key_hash(c.r.FRESH.secret(c.root)))
                self.assertEqual(intent['environment']['sha256'], hashlib.sha256((c.root / '.env').read_bytes()).hexdigest())
                self.assertNotIn(c.r.FRESH.secret(c.root), self.phase('reset-intent').read_text())
                raise OSError('fixture interruption after rotation')
            return cache(path, **kwargs)
        with c.b.guarded() as guard, mock.patch.object(c.r.FRESH, 'cache', side_effect=interrupted):
            with self.assertRaisesRegex(c.r.ReplacementError, 'original Runtipi installation was recovered'): self.apply(guard)
            self.assertIsNone(guard.read())
        self.assert_recovered(0)

    def test_failure_after_cache_revocation_restores_checkpoint(self):
        c = self.c
        cache = c.r.FRESH.cache
        def interrupted(path, **kwargs):
            result = cache(path, **kwargs)
            if kwargs.get('clear'): raise OSError('fixture interruption after cache write')
            return result
        with c.b.guarded() as guard, mock.patch.object(c.r.FRESH, 'cache', side_effect=interrupted):
            with self.assertRaisesRegex(c.r.ReplacementError, 'original Runtipi installation was recovered'): self.apply(guard)
            self.assertIsNone(guard.read())
        self.assert_recovered(0)

    def test_failure_after_passkey_revocation_restores_file(self):
        c = self.c
        auth = c.root / 'state/auth'; auth.mkdir(mode=0o700)
        file = auth / 'passkeys.json'; file.write_text('{"fixture":"retained-passkey"}'); file.chmod(0o600)
        before = file.read_bytes(); authentication = c.r.FRESH.authentication
        def interrupted(root, **kwargs):
            result = authentication(root, **kwargs)
            if kwargs.get('clear'):
                self.assertFalse(file.exists())
                raise OSError('fixture interruption after passkey removal')
            return result
        with c.b.guarded() as guard, mock.patch.object(c.r.FRESH, 'authentication', side_effect=interrupted):
            with self.assertRaisesRegex(c.r.ReplacementError, 'original Runtipi installation was recovered'): self.apply(guard)
            self.assertIsNone(guard.read())
        self.assertEqual(file.read_bytes(), before)
        self.assert_recovered(0)

    def test_unknown_sql_commit_restores_checkpoint_without_repeating_sql(self):
        c = self.c; sql = c.sql
        preferences = c.root / 'state/desktop'; preferences.mkdir()
        file = preferences / 'fixture.json'; file.write_text('{"fixture":"original-layout"}')
        before = file.read_bytes()
        def unknown(*args, **kwargs):
            self.assertFalse(preferences.exists())
            sql(*args, **kwargs)
            raise OSError('fixture lost SQL reply after commit')
        with c.b.guarded() as guard, mock.patch.object(c, 'sql', side_effect=unknown):
            with self.assertRaisesRegex(c.r.ReplacementError, 'original Runtipi installation was recovered'): self.apply(guard)
            self.assertIsNone(guard.read())
        self.assertEqual(file.read_bytes(), before)
        self.assert_recovered(1)

    def test_lost_reset_receipt_uses_prewrite_intent_for_rollback(self):
        c = self.c; publish = M.Permit._publish_phase
        def interrupted(permit, record, name, previous, data):
            if name == 'reset': raise OSError('fixture reset receipt not committed')
            return publish(permit, record, name, previous, data)
        with c.b.guarded() as guard, mock.patch.object(M.Permit, '_publish_phase', new=interrupted):
            with self.assertRaisesRegex(c.r.ReplacementError, 'original Runtipi installation was recovered'): self.apply(guard)
            self.assertIsNone(guard.read())
        self.assert_recovered(1)

    def interrupt_after_rotation(self):
        c = self.c; cache = c.r.FRESH.cache
        def interrupted(path, **kwargs):
            if kwargs.get('clear'): raise KeyboardInterrupt('fixture process interruption')
            return cache(path, **kwargs)
        with c.b.guarded() as guard, mock.patch.object(c.r.FRESH, 'cache', side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt): self.apply(guard)
            self.assertIsNotNone(guard.read())
        self.assertNotEqual((c.root / '.env').read_bytes(), self.original)

    def test_new_guard_recovers_interrupted_rotation_and_refuses_reset_retry(self):
        c = self.c; self.interrupt_after_rotation()
        with c.b.guarded() as guard:
            record = json.loads(c.journal.read_text())
            issuer = c.r.ownership_issuer(c.root, c.reader, guard)
            with issuer.transaction(guard, record, record['ownershipPermit']) as permit:
                with self.assertRaises(ValueError): permit.reset_accounts(record)
            self.assertEqual(self.workflow.recover(guard)['result'], 'original-runtipi-recovered')
            self.assertIsNone(guard.read())
        self.assert_recovered(0)

    def test_intent_committed_before_rename_recovers_original_environment(self):
        c = self.c; publish = M.Permit._publish_phase
        def interrupted(permit, record, name, previous, data):
            result = publish(permit, record, name, previous, data)
            if name == 'reset-intent': raise KeyboardInterrupt('fixture before rename')
            return result
        with c.b.guarded() as guard, mock.patch.object(M.Permit, '_publish_phase', new=interrupted):
            with self.assertRaises(KeyboardInterrupt): self.apply(guard)
            self.assertIsNotNone(guard.read())
        self.assertEqual((c.root / '.env').read_bytes(), self.original)
        with c.b.guarded() as guard:
            self.assertEqual(self.workflow.recover(guard)['result'], 'original-runtipi-recovered')
            self.assertIsNone(guard.read())
        self.assert_recovered(0)

    def test_same_bytes_replacement_inode_is_not_accepted_from_intent(self):
        c = self.c; self.interrupt_after_rotation()
        file = c.root / '.env'; other = c.root / 'fixture-other-env'; shutil.copy2(file, other); other.replace(file)
        before = c.journal.read_bytes()
        with c.b.guarded() as guard:
            with self.assertRaises(ValueError): self.workflow.recover(guard)
            self.assertIsNotNone(guard.read())
        self.assertEqual(c.journal.read_bytes(), before); self.assertEqual(self.workflow.b.copy_calls, 0)

    def test_changed_environment_or_partial_intent_stays_held(self):
        c = self.c; self.interrupt_after_rotation()
        file = c.root / '.env'; file.write_bytes(file.read_bytes() + b'FIXTURE_DRIFT=yes\n')
        with c.b.guarded() as guard:
            with self.assertRaises(ValueError): self.workflow.recover(guard)
            self.assertIsNotNone(guard.read())
        self.assertEqual(self.workflow.b.copy_calls, 0); self.assertTrue(file.read_bytes().endswith(b'FIXTURE_DRIFT=yes\n'))
        self.phase('reset-intent').write_bytes(b'{')
        with c.b.guarded() as guard:
            with self.assertRaises(ValueError): self.workflow.recover(guard)
            self.assertIsNotNone(guard.read())
        self.assertEqual(self.workflow.b.copy_calls, 0)

    def test_prepared_inode_replacement_is_refused_before_environment_rename(self):
        c = self.c
        def replaced(path, digest):
            other = c.root / 'fixture-copy'; shutil.copy2(path, other); other.replace(path)
        with self.assertRaises(c.r.FRESH.FreshError): c.r.FRESH.rotate_secret(c.root, before_replace=replaced)
        self.assertEqual((c.root / '.env').read_bytes(), self.original)
        self.assertEqual(list(c.root.glob('.orbis-fresh-env-*')), [])

    def test_protected_rotation_preserves_crlf_environment_content(self):
        c = self.c
        file = c.root / '.env'; file.write_bytes(self.original.replace(b'\n', b'\r\n'))
        suffix = file.read_bytes().split(b'\r\n', 1)[1]
        with c.b.guarded() as guard:
            self.assertEqual(self.apply(guard)['result'], 'orbis-installed')
            self.assertIsNone(guard.read())
        self.assertEqual(file.read_bytes().split(b'\r\n', 1)[1], suffix)
        self.assertEqual(c.sql_calls, 1)


if __name__ == '__main__': unittest.main()
