"""Read-only lifecycle gate contract, independent of the Host entry point."""
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest


spec = importlib.util.spec_from_file_location(
    '_credential_fence_contract', Path(__file__).with_name('orbis-host-credential-fence.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class CredentialFenceContract(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve() / 'installation'
        self.root.mkdir()
        self.namespace = self.root.parent / 'host-state'
        self.namespace.mkdir()
        self.legacy = self.root.parent / '.installation.orbis-credential-fence.json'
        self.selected = self.namespace / 'credential-fence.json'
        layout = SimpleNamespace(selected_path=lambda root, role: self.selected,
                                 legacy_path=lambda root, role: self.legacy,
                                 namespace=lambda root: self.namespace)
        self.host = SimpleNamespace(AUTHORITY=SimpleNamespace(LAYOUT=layout))

    def test_each_managed_selector_blocks_without_changing_fixture(self):
        self.assertEqual(gate.BOOTSTRAP_PUBLICATION_PROTOCOL, 1)
        self.assertEqual(gate.BOOTSTRAP_PUBLICATION_HOLD, 'credential-bootstrap-publication-hold.json')
        self.assertIsNone(gate.require_clear(self.host, self.root))
        for name in (
            'credential-fence.json',
            'credential-bootstrap-intent.json',
            '.credential-bootstrap-intent.json.pending',
            'credential-bootstrap-publication-hold.json',
            '.credential-bootstrap-publication-hold.json.pending',
        ):
            with self.subTest(name=name):
                selector = self.namespace / name
                selector.write_bytes(b'incomplete publication')
                before = selector.lstat()
                with self.assertRaises(ValueError):
                    gate.require_clear(self.host, self.root)
                after = selector.lstat()
                self.assertEqual((after.st_ino, after.st_mode, after.st_mtime_ns),
                                 (before.st_ino, before.st_mode, before.st_mtime_ns))
                self.assertEqual(selector.read_bytes(), b'incomplete publication')
                selector.unlink()
                self.assertIsNone(gate.require_clear(self.host, self.root))
                self.assertEqual(list(self.namespace.iterdir()), [])

    def test_legacy_selector_blocks_even_when_its_symlink_target_is_absent(self):
        self.selected = self.legacy
        self.assertIsNone(gate.require_clear(self.host, self.root))
        target = self.root.parent / 'missing-selector'
        self.legacy.symlink_to(target)
        with self.assertRaises(ValueError):
            gate.require_clear(self.host, self.root)
        self.assertEqual(self.legacy.readlink(), target)
        self.assertFalse(target.exists())


if __name__ == '__main__':
    unittest.main()
