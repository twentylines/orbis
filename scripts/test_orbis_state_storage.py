import copy
import importlib.util
import json
import os
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location('state_storage', Path(__file__).with_name('orbis-state-storage.py'))
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)


class Runtime:
    def __init__(self, root):
        self.root = root
        self.row = {'Id': 'a' * 64, 'Created': 'created', 'Image': 'sha256:fixture', 'Path': 'node', 'Args': [],
                    'Config': {'User': ''}, 'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0}, 'UsernsMode': ''},
                    'Mounts': [{'Destination': '/data/state', 'Source': str(root / 'state'), 'Type': 'bind', 'RW': True}],
                    'State': {'Running': True, 'Status': 'running', 'Paused': False, 'Restarting': False, 'Pid': 123, 'StartedAt': 'started'}}
        self.others = []
        self.view = root / 'state'
        self.aliases = {}
    def daemon_id(self):
        return 'fixture-daemon'
    def inspect(self, identifier):
        if identifier != self.row['Id']: raise AssertionError()
        return copy.deepcopy(self.row)
    def containers(self):
        return copy.deepcopy([self.row, *self.others])
    def mount_identity(self, row, mount):
        value = os.stat(self.aliases.get(row['Id'], mount['Source']))
        return value.st_dev, value.st_ino
    @contextmanager
    def mounted_state(self, row):
        descriptor = os.open(self.view, os.O_RDONLY | os.O_DIRECTORY)
        try: yield descriptor
        finally: os.close(descriptor)
    def stop(self):
        self.row['State'].update(Running=False, Status='exited', Pid=0)
        self.row['HostConfig']['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}


class StateStorageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.root = self.base / 'installation'
        self.root.mkdir(mode=0o775)
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o777)
        self.state.chmod(0o777)
        self.settings = self.state / 'settings.json'
        self.body = b'{"timeZone":"UTC","privateFixture":"unchanged"}\n'
        self.settings.write_bytes(self.body)
        self.settings.chmod(0o666)
        if hasattr(os, 'chflags'):
            os.chflags(self.settings, os.stat(self.settings).st_flags | 0x40)
        self.receipts = self.base / 'authority'
        self.receipts.mkdir(mode=0o700)
        patch = mock.patch.object(S, 'OWNER', os.geteuid())
        patch.start()
        self.addCleanup(patch.stop)
        self.runtime = Runtime(self.root)

    def prepare(self):
        return S.prepare(self.root, self.runtime, self.runtime.row['Id'])

    def test_changes_only_two_modes_and_preserves_data_and_restart_policy(self):
        saved = self.state / 'saved-capture'
        saved.write_bytes(b'preserved capture')
        with self.prepare() as prepared:
            approval = S.digest(prepared.plan)
            self.runtime.stop()
            result = S.apply_stopped(prepared, approval, self.receipts)
        self.assertEqual(result['phase'], 'complete')
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.settings.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.settings.read_bytes(), self.body)
        self.assertEqual(saved.read_bytes(), b'preserved capture')
        self.assertEqual(result['plan']['restartPolicy']['Name'], 'unless-stopped')
        self.assertEqual((self.receipts / (approval + '.json')).stat().st_mode & 0o777, 0o600)
        self.assertNotIn('privateFixture', json.dumps(result))

    def test_requires_exact_approval_and_positive_quiescence(self):
        with self.prepare() as prepared:
            with self.assertRaises(S.StateStorageError):
                S.apply_stopped(prepared, '0' * 64, self.receipts)
            with self.assertRaises(S.StateStorageError):
                S.apply_stopped(prepared, S.digest(prepared.plan), self.receipts)
            self.runtime.stop()
            self.runtime.row['HostConfig']['RestartPolicy']['Name'] = 'always'
            with self.assertRaises(S.StateStorageError):
                S.apply_stopped(prepared, S.digest(prepared.plan), self.receipts)
        self.assertFalse(list(self.receipts.iterdir()))
        self.assertEqual(self.settings.stat().st_mode & 0o777, 0o666)

    def test_rejects_another_writer_even_when_stopped(self):
        other = copy.deepcopy(self.runtime.row)
        other['Id'] = 'b' * 64
        other['State'].update(Running=False, Pid=0, Status='exited')
        self.runtime.others.append(other)
        with self.assertRaises(S.StateStorageError):
            with self.prepare(): pass

    def test_rejects_writable_directory_alias_by_loaded_mount_identity(self):
        other = copy.deepcopy(self.runtime.row)
        other['Id'] = 'b' * 64
        other['Mounts'][0]['Source'] = str(self.base)
        self.runtime.aliases[other['Id']] = self.state
        self.runtime.others.append(other)
        with self.assertRaises(S.StateStorageError):
            with self.prepare(): pass

    def test_rejects_unwitnessed_container_mount(self):
        self.runtime.view = self.receipts
        with self.assertRaises(S.StateStorageError):
            with self.prepare(): pass

    def test_rejects_loaded_bind_alias_of_a_state_descendant(self):
        descendant = self.state / 'desktop'
        descendant.mkdir(mode=0o700)
        other = copy.deepcopy(self.runtime.row)
        other['Id'] = 'b' * 64
        other['Mounts'][0]['Source'] = str(self.receipts)
        self.runtime.aliases[other['Id']] = descendant
        self.runtime.others.append(other)
        with self.assertRaises(S.StateStorageError):
            with self.prepare(): pass

    def test_rejects_linked_or_replaced_settings(self):
        os.link(self.settings, self.state / 'alias')
        with self.assertRaises(S.StateStorageError):
            with self.prepare(): pass
        (self.state / 'alias').unlink()
        with self.prepare() as prepared:
            replacement = self.state / 'replacement'
            replacement.write_bytes(self.body)
            replacement.chmod(0o666)
            os.replace(replacement, self.settings)
            self.runtime.stop()
            with self.assertRaises(S.StateStorageError):
                S.apply_stopped(prepared, S.digest(prepared.plan), self.receipts)
        self.assertEqual(self.settings.stat().st_mode & 0o777, 0o666)

    def test_interrupted_narrowing_resumes_from_private_receipt_without_reopening_modes(self):
        real = os.fchmod
        with self.prepare() as prepared:
            approval = S.digest(prepared.plan)
            self.runtime.stop()
            def interrupt(descriptor, mode):
                if descriptor == prepared.settings: raise OSError('fixture interruption')
                return real(descriptor, mode)
            with mock.patch.object(S.os, 'fchmod', side_effect=interrupt):
                with self.assertRaises(OSError):
                    S.apply_stopped(prepared, approval, self.receipts)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.settings.stat().st_mode & 0o777, 0o666)
        self.assertEqual(json.loads((self.receipts / (approval + '.json')).read_text())['phase'], 'recovery-required')
        with S.resume_stopped(self.root, self.runtime, approval, self.receipts) as prepared:
            S.apply_stopped(prepared, approval, self.receipts)
        self.assertEqual(self.settings.read_bytes(), self.body)
        self.assertEqual(self.settings.stat().st_mode & 0o777, 0o600)

    def test_resume_preserves_mismatched_settings_and_refuses_unprotected_receipts(self):
        with self.prepare() as prepared:
            approval = S.digest(prepared.plan)
            self.runtime.stop()
            S.apply_stopped(prepared, approval, self.receipts)
        self.settings.write_bytes(b'newer unrelated settings')
        with self.assertRaises(S.StateStorageError):
            with S.resume_stopped(self.root, self.runtime, approval, self.receipts): pass
        self.assertEqual(self.settings.read_bytes(), b'newer unrelated settings')
        self.receipts.chmod(0o777)
        with self.assertRaises(S.StateStorageError):
            with S.resume_stopped(self.root, self.runtime, approval, self.receipts): pass

    def test_durable_intent_survives_a_stop_before_any_permission_change(self):
        with self.prepare() as prepared:
            approval = S.digest(prepared.plan)
            S.record_plan(prepared, approval, self.receipts)
        self.runtime.stop()
        with S.resume_stopped(self.root, self.runtime, approval, self.receipts) as prepared:
            S.apply_stopped(prepared, approval, self.receipts)
        self.assertEqual(self.settings.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.settings.read_bytes(), self.body)

    def test_invalid_or_linked_existing_receipts_are_preserved(self):
        with self.prepare() as prepared:
            approval = S.digest(prepared.plan)
            target = self.receipts / (approval + '.json')
            target.write_bytes(b'{"unrelated":"preserve"}')
            target.chmod(0o600)
            with self.assertRaises(S.StateStorageError):
                S.record_plan(prepared, approval, self.receipts)
            self.assertEqual(target.read_bytes(), b'{"unrelated":"preserve"}')
            target.unlink()
            S.record_plan(prepared, approval, self.receipts)
            os.link(target, self.receipts / 'unrelated-link')
            with self.assertRaises(S.StateStorageError):
                S.record_plan(prepared, approval, self.receipts)
            self.assertEqual(target.stat().st_nlink, 2)


if __name__ == '__main__':
    unittest.main()
