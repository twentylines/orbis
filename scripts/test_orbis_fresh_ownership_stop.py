"""Unbound and legacy Fresh calls cannot bypass the positive Root transaction."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location('fresh_stop_guide', Path(__file__).with_name('orbis-install.py'))
GUIDE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GUIDE)
REPLACE = GUIDE.REPLACE


class FreshOwnershipStopTests(unittest.TestCase):
    def test_fresh_review_stops_before_release_or_checkpoint_observation(self):
        reader = mock.Mock()
        with mock.patch.object(REPLACE.UPDATE, 'verify_release') as publication, \
                mock.patch.object(REPLACE.TX, 'review') as checkpoint, \
                mock.patch.object(REPLACE, 'Engine') as engine:
            with self.assertRaisesRegex(REPLACE.ReplacementError, 'Root ownership permit'):
                REPLACE.review(Path('/installation'), reader, {}, Path('/backup'), Path('/journal'), mode='fresh')
            publication.assert_not_called()
            checkpoint.assert_not_called()
            engine.assert_not_called()
        self.assertEqual(reader.mock_calls, [])

    def test_apply_stops_even_if_legacy_saved_review_passes_validation(self):
        value = {'mode': 'fresh', 'freshReset': {'cacheRevoked': True, 'passkeysRevoked': True}}
        before = copy.deepcopy(value)
        reader = mock.Mock()
        with mock.patch.object(REPLACE, 'validate_review'), mock.patch.object(REPLACE, 'review') as review, \
                mock.patch.object(REPLACE, 'save') as save, mock.patch.object(REPLACE.TX, 'checkpoint') as checkpoint:
            with self.assertRaisesRegex(REPLACE.ReplacementError, 'Root ownership permit'):
                REPLACE.apply(Path('/installation'), reader, value, host_writers_stopped=True)
            review.assert_not_called()
            save.assert_not_called()
            checkpoint.assert_not_called()
        self.assertEqual(value, before)
        self.assertEqual(reader.mock_calls, [])

    def test_precommit_labels_do_not_authorize_automatic_rollback(self):
        for stage in REPLACE.PRECOMMIT:
            record = {'stage': stage, 'review': {'mode': 'fresh'}}
            before = copy.deepcopy(record)
            with self.subTest(stage=stage), mock.patch.object(REPLACE, 'completed_checkpoint') as completed, \
                    mock.patch.object(REPLACE, 'save') as save, mock.patch.object(REPLACE.TX, 'recover') as recover:
                with self.assertRaisesRegex(REPLACE.ReplacementError, 'Root ownership permit'):
                    REPLACE.rollback(record, mock.Mock())
                completed.assert_not_called()
                save.assert_not_called()
                recover.assert_not_called()
            self.assertEqual(record, before)

    def test_interrupted_recovery_stops_before_any_write_for_every_nonterminal_stage(self):
        reader = SimpleNamespace(context='fixture')
        root, journal = Path('/installation'), Path('/journal')
        for stage in REPLACE.PRECOMMIT | {'committing'}:
            record = {'schema': REPLACE.SCHEMA, 'stage': stage, 'review': {
                'mode': 'fresh', 'root': str(root), 'dockerContext': reader.context, 'journal': str(journal)}}
            before = copy.deepcopy(record)
            with self.subTest(stage=stage), mock.patch.object(REPLACE.TX.RESTORE, 'private_json', return_value=record), \
                    mock.patch.object(REPLACE, 'validate_review'), mock.patch.object(REPLACE, 'finish') as finish, \
                    mock.patch.object(REPLACE, 'rollback') as rollback, mock.patch.object(REPLACE, 'save') as save, \
                    mock.patch.object(REPLACE, 'check_originals') as originals:
                with self.assertRaisesRegex(REPLACE.ReplacementError, 'Root ownership permit'):
                    REPLACE.recover(root, reader, journal, host_writers_stopped=True)
                for port in (finish, rollback, save, originals):
                    port.assert_not_called()
            self.assertEqual(record, before)

    def test_guided_recovery_cannot_dispatch_a_hash_correct_old_fresh_executor(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            journal = root / 'transaction.json'
            executor = root / 'orbis-install-replace.py'
            body = b"raise RuntimeError('old executor must not run')\n"
            executor.write_bytes(body)
            marker = {'schema': 'orbis.installer-pointer.v1', 'root': str(root), 'dockerContext': 'fixture',
                      'kind': 'replacement', 'journal': str(journal), 'executor': str(executor),
                      'executorSha256': hashlib.sha256(body).hexdigest()}
            GUIDE.APPS.write_journal(root / '.orbis-installation.json', marker)
            for mode in ('fresh', None, 'unsupported'):
                record = {'stage': 'committing', 'review': {'root': str(root), 'dockerContext': 'fixture', 'mode': mode}}
                GUIDE.APPS.write_journal(journal, record)
                before = {name: (root / name).read_bytes() for name in (journal.name, executor.name, '.orbis-installation.json')}
                with self.subTest(mode=mode), mock.patch.object(GUIDE, 'command') as execute:
                    with self.assertRaisesRegex(REPLACE.ReplacementError, 'Root ownership permit'):
                        GUIDE.recover_pending(root, SimpleNamespace(context='fixture'), root / 'private', None, writers_stopped=True)
                    execute.assert_not_called()
                self.assertEqual(before, {name: (root / name).read_bytes() for name in before})
            self.assertFalse((root / 'private').exists())

    def test_unbound_guard_supports_only_keep_and_unknown_modes_never_downgrade(self):
        REPLACE.require_ownership_authority('keep')
        for mode in ('fresh', None, '', 'unmanaged', False, {}, []):
            with self.subTest(mode=mode), self.assertRaises(REPLACE.ReplacementError):
                REPLACE.require_ownership_authority(mode)

    def test_guided_keep_recovery_still_verifies_and_dispatches_exact_executor(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            journal = root / 'transaction.json'
            executor = root / 'orbis-install-replace.py'
            body = b"raise RuntimeError('fixture executor is observed through the command port')\n"
            executor.write_bytes(body)
            marker = {'schema': 'orbis.installer-pointer.v1', 'root': str(root), 'dockerContext': 'fixture',
                      'kind': 'replacement', 'journal': str(journal), 'executor': str(executor),
                      'executorSha256': hashlib.sha256(body).hexdigest()}
            GUIDE.APPS.write_journal(root / '.orbis-installation.json', marker)
            GUIDE.APPS.write_journal(journal, {'stage': 'holding', 'review': {
                'root': str(root), 'dockerContext': 'fixture', 'mode': 'keep'}})

            def dispatch(arguments, out, err):
                self.assertEqual(arguments[0], str(executor))
                self.assertEqual(arguments[1], 'recover')
                self.assertIn('--host-writers-stopped', arguments)
                out.write_text('{"result":"original-runtipi-recovered"}')
                err.write_bytes(b'')
                return 0

            # The CLI's private-directory setup requires native Root ancestry.
            # This unprivileged dispatch fixture supplies only that setup port;
            # executor inode/owner/hash/name checks above remain real.
            directories = SimpleNamespace(private_directory=lambda path: path.mkdir(mode=0o700))
            with mock.patch.object(GUIDE, 'load', return_value=directories), \
                    mock.patch.object(GUIDE, 'command', side_effect=dispatch) as execute:
                result = GUIDE.recover_pending(root, SimpleNamespace(context='fixture'), root / 'private', None, writers_stopped=True)
                self.assertEqual(result, {'result': 'original-runtipi-recovered'})
                execute.assert_called_once()
            executor.write_bytes(body + b'# changed\n')
            with mock.patch.object(GUIDE, 'command') as execute, self.assertRaisesRegex(ValueError, 'missing or changed'):
                GUIDE.recover_pending(root, SimpleNamespace(context='fixture'), root / 'private', None, writers_stopped=True)
            execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
