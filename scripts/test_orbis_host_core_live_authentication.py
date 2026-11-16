"""Actual protected-file reads for optional current authentication storage."""
from contextlib import contextmanager
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


L = load('orbis-host-core-live-restoration.py', 'live_authentication_file_subject')
A = load('orbis-host-retained-authority.py', 'live_authentication_file_authority')


class LiveAuthenticationFileTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch.object(A, 'OWNER', os.geteuid()))
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.root.chmod(0o700)
        self.subject = object.__new__(L.CoreLiveRestorationService)
        self.subject.enrollment = SimpleNamespace(a=A, P=A.P, read=self.read)
        self.subject.P = A.P
        self.snapshot = {'container': {'Mounts': [{'Type': 'bind', 'Source': str(self.root), 'Destination': '/data', 'RW': True}],
                                       'Config': {'Env': ['JWT_SECRET=synthetic-inherited-value']}}}
        self.database = {'Config': {'Env': ['POSTGRES_USER=tipi']}}
        (self.root / '.env').write_bytes(b'')
        (self.root / '.env').chmod(0o600)

    def read(self, path, maximum):
        with A.protected_directory(path.parent) as descriptor:
            with A.protected_file(descriptor, path.name, maximum) as body:
                return body

    def directory(self, name):
        path = self.root / name
        path.mkdir(mode=0o700, parents=True)
        return path

    def files(self):
        return self.subject._live_files(self.snapshot, self.database)

    def test_never_configured_passkeys_do_not_require_creating_state(self):
        files = self.files()
        self.assertEqual(files['configuration.env'], b'')
        self.assertNotIn('passkeys.json', files)
        self.assertFalse((self.root / 'state').exists())

    def test_absent_auth_directory_and_absent_file_are_both_optional(self):
        self.directory('state')
        self.assertNotIn('passkeys.json', self.files())
        self.assertFalse((self.root / 'state/auth').exists())
        self.directory('state/auth')
        self.assertNotIn('passkeys.json', self.files())
        self.assertFalse((self.root / 'state/auth/passkeys.json').exists())

    def test_existing_private_passkey_bytes_are_preserved(self):
        auth = self.directory('state/auth')
        body = b'{"version":1,"users":{}}\n'
        (auth / 'passkeys.json').write_bytes(body)
        (auth / 'passkeys.json').chmod(0o600)
        self.assertEqual(self.files()['passkeys.json'], body)

    def test_optional_absence_never_bypasses_unsafe_ancestor_or_leaf(self):
        state = self.directory('state')
        state.chmod(0o777)
        with self.assertRaises(ValueError):
            self.files()
        state.chmod(0o700)
        auth = self.directory('state/auth')
        auth.chmod(0o755)
        with self.assertRaises(ValueError):
            self.files()

    def test_symlinked_directory_or_passkey_is_never_treated_as_absent(self):
        outside = self.directory('outside')
        state = self.directory('state')
        (state / 'auth').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.files()
        (state / 'auth').unlink()
        auth = self.directory('state/auth')
        (auth / 'passkeys.json').symlink_to(outside / 'absent.json')
        with self.assertRaises(ValueError):
            self.files()

    def test_path_inserted_during_absence_observation_invalidates_read(self):
        state = self.directory('state')
        real = A.protected_directory

        @contextmanager
        def inserted(path, **options):
            with real(path, **options) as descriptor:
                yield descriptor
                if Path(path) == state:
                    (state / 'auth').mkdir(mode=0o700)

        with mock.patch.object(A, 'protected_directory', inserted), self.assertRaises(ValueError):
            self.files()

    def test_disappearing_existing_file_is_not_downgraded_to_optional_absence(self):
        auth = self.directory('state/auth')
        file = auth / 'passkeys.json'
        file.write_bytes(b'{"version":1,"users":{}}')
        file.chmod(0o600)
        real = A.protected_file

        @contextmanager
        def removed(descriptor, name, *args, **options):
            with real(descriptor, name, *args, **options) as body:
                yield body
                if name == 'passkeys.json':
                    file.unlink()

        with mock.patch.object(A, 'protected_file', removed), self.assertRaises((OSError, ValueError)):
            self.files()


if __name__ == '__main__':
    unittest.main()
