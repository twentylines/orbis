"""Actual exclusive files/links and interrupted staging; Linux metadata needs native proof."""
import base64
import importlib.util
import os
from pathlib import Path
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


M = load('orbis-host-core-checkpoint-materialize.py', 'core_checkpoint_materialize_test')
F = load('test_orbis_host_core_checkpoint_review.py', 'core_checkpoint_materialize_fixtures')


class MaterializationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = F.CheckpointReviewTests('test_actual_packer_bytes_preserve_nanosecond_metadata_links_and_pg_version')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.path, self.expected, self.authority = self.fixture.file, self.fixture.expected, self.fixture.authority
        self.target = self.path.parent.parent / 'candidate'
        if not hasattr(os, 'listxattr') or not hasattr(os, 'getxattr'):
            # Same explicit limitation as the producer fixture on this Python.
            self.enterContext(mock.patch.object(M.R.PACK, 'attributes', return_value={}))

    def materialize(self):
        return M.materialize_checkpoint(self.path, self.expected, self.target, self.authority)

    def verify(self, receipt):
        return M.verify_checkpoint_resources(self.path, self.expected, self.target, receipt, self.authority)

    def test_actual_files_hardlinks_symlinks_metadata_and_reverification(self):
        receipt = self.materialize()
        self.assertFalse(receipt['restoreAuthority'])
        self.assertEqual(receipt['schema'], M.SCHEMA)
        self.assertEqual(self.verify(receipt), receipt)
        data = next(path for path in self.target.rglob('data') if path.is_file())
        self.assertEqual(data.read_bytes(), b'actual synthetic checkpoint file')
        self.assertEqual(data.stat().st_ino, (data.parent / 'linked').stat().st_ino)
        self.assertEqual(os.readlink(data.parent / 'symbolic'), 'data')
        with self.assertRaises(FileExistsError):
            self.materialize()

    def test_preexisting_symlink_destination_and_resource_escape_never_followed(self):
        outside = self.path.parent / 'outside'
        outside.mkdir(mode=0o700)
        (outside / 'sentinel').write_bytes(b'preserve outside')
        self.target.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(FileExistsError):
            self.materialize()
        self.assertEqual((outside / 'sentinel').read_bytes(), b'preserve outside')
        self.assertEqual(set(os.listdir(outside)), {'sentinel'})
        self.target.unlink()
        def mutate(rows, manifest):
            entry = next(item for item in manifest['entries'] if item['type'] == 'file')
            next(member for member, _body in rows if member.name == entry['path']).name = 'resources/0000/../../outside/sentinel'
            entry['path'] = 'resources/0000/../../outside/sentinel'
        self.fixture.rewrite(mutate)
        with self.assertRaises(ValueError):
            self.materialize()
        self.assertFalse(self.target.exists())
        self.assertEqual((outside / 'sentinel').read_bytes(), b'preserve outside')

    def test_unsupported_security_xattr_refuses_before_any_candidate_is_created(self):
        def mutate(_rows, manifest):
            next(item for item in manifest['entries'] if item['type'] == 'file')['xattrs'] = {
                base64.b64encode(b'security.capability').decode(): base64.b64encode(b'unsupported capability').decode()}
        self.fixture.rewrite(mutate)
        with self.assertRaises(M.MaterializationError):
            self.materialize()
        self.assertFalse(self.target.exists())

    def test_partial_write_is_retained_and_cannot_be_replayed_as_fresh_staging(self):
        real_write = M.os.write
        calls = 0
        def interrupt(descriptor, body):
            nonlocal calls
            calls += 1
            if calls > 1:
                raise OSError('synthetic interrupted private staging')
            return real_write(descriptor, body[:1])
        with mock.patch.object(M.os, 'write', side_effect=interrupt):
            with self.assertRaises(OSError):
                self.materialize()
        retained = [(str(path.relative_to(self.target)), path.stat().st_size) for path in self.target.rglob('*') if path.is_file()]
        self.assertTrue(retained)
        with self.assertRaises(FileExistsError):
            self.materialize()
        self.assertEqual(retained, [(str(path.relative_to(self.target)), path.stat().st_size) for path in self.target.rglob('*') if path.is_file()])

    def test_tampered_data_and_same_bytes_after_mutation_refuse(self):
        receipt = self.materialize()
        data = next(path for path in self.target.rglob('data') if path.is_file())
        original = data.read_bytes()
        data.write_bytes(b'damaged copied data')
        with self.assertRaises(ValueError):
            self.verify(receipt)
        data.write_bytes(original)
        with self.assertRaises(ValueError):
            self.verify(receipt)

    def test_unexpected_node_refuses_with_otherwise_unchanged_resources(self):
        receipt = self.materialize()
        (self.target / 'resources/unexpected').write_bytes(b'undeclared')
        with self.assertRaises(ValueError):
            self.verify(receipt)

    def test_identical_replacement_inode_refuses(self):
        receipt = self.materialize()
        version = next(self.target.rglob('PG_VERSION'))
        before, body = version.stat(), version.read_bytes()
        version.unlink()
        version.write_bytes(body)
        os.chmod(version, before.st_mode & 0o7777)
        os.utime(version, ns=(before.st_atime_ns, before.st_mtime_ns))
        with self.assertRaises(ValueError):
            self.verify(receipt)

    def test_swapped_directory_symlink_cannot_read_or_modify_outside(self):
        receipt = self.materialize()
        resource = next(path for path in (self.target / 'resources').iterdir() if path.is_dir())
        retained = resource.with_name(resource.name + '-retained')
        resource.rename(retained)
        outside = self.path.parent / 'outside'
        outside.mkdir(mode=0o700)
        (outside / 'sentinel').write_bytes(b'preserve outside')
        resource.symlink_to(outside, target_is_directory=True)
        with self.assertRaises((ValueError, OSError)):
            self.verify(receipt)
        self.assertEqual((outside / 'sentinel').read_bytes(), b'preserve outside')


if __name__ == '__main__':
    unittest.main()
