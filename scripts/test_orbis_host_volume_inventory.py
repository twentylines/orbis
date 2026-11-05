import hashlib
import importlib.util
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('volume_inventory', Path(__file__).with_name('orbis-host-volume-inventory.py'))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='volume-inventory-')
        self.root = Path(self.temp.name)
        self.fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)

    def tearDown(self):
        os.close(self.fd)
        self.temp.cleanup()

    def scan(self, **kwargs):
        return inventory.scan_directory(self.fd, **kwargs)

    def file(self, name, data=b'hello'):
        file = self.root / name
        file.write_bytes(data)
        # Prime platform-managed flags before the scanner takes its seals.
        file.read_bytes()
        return file

    @unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'O_PATH'), 'regular-file inventory requires Linux O_PATH and procfs')
    def test_files_hardlinks_symlinks_and_socket_are_read_only(self):
        (self.root / 'sub').mkdir()
        file = self.file('sub/file')
        os.link(file, self.root / 'hard')
        os.symlink('sub/file', self.root / 'link')
        sock = socket.socket(socket.AF_UNIX)
        self.addCleanup(sock.close)
        sock.bind(str(self.root / 'sock'))
        names = [self.root, self.root / 'sub', file, self.root / 'hard', self.root / 'link', self.root / 'sock']
        before = {str(p): inventory._seal(p.lstat()) for p in names}
        result = self.scan()
        digest = hashlib.sha256(b'hello').hexdigest()
        self.assertEqual(result, [
            {'name': '.', 'kind': 'directory'},
            {'name': 'hard', 'kind': 'file', 'bytes': 5, 'sha256': digest},
            {'name': 'link', 'kind': 'symlink', 'target': 'sub/file'},
            {'name': 'sock', 'kind': 'socket'},
            {'name': 'sub', 'kind': 'directory'},
            {'name': 'sub/file', 'kind': 'file', 'bytes': 5, 'sha256': digest},
        ])
        self.assertEqual(before, {str(p): inventory._seal(p.lstat()) for p in names})
        self.assertEqual(file.read_bytes(), b'hello')
        self.assertEqual(self.scan(), result)

    @unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'O_PATH'), 'regular-file inventory requires Linux O_PATH and procfs')
    def test_invalid_and_chained_links_fail(self):
        (self.root / 'dir').mkdir()
        self.file('dir/file')
        for target in ['/etc/passwd', '../outside', '../dir/file', 'missing', 'loop', 'via/file', 'via/../dir/file', '.']:
            with self.subTest(target=target):
                os.symlink('dir', self.root / 'via')
                os.symlink(target, self.root / 'loop')
                with self.assertRaisesRegex(inventory.VolumeInventoryError, '^Volume inventory could not be verified\\.$'):
                    self.scan()
                (self.root / 'loop').unlink()
                (self.root / 'via').unlink()

    def test_canonical_names_bounds_cancellation_and_special_types(self):
        self.file('a')
        for options in ({'maximum_entries': 1}, {'maximum_path_bytes': 1}, {'maximum_bytes': 4}, {'cancelled': lambda: True}):
            with self.subTest(options=options), self.assertRaises(inventory.VolumeInventoryError):
                self.scan(**options)
        (self.root / 'a').unlink()
        self.assertEqual(self.scan(maximum_bytes=0), [{'name': '.', 'kind': 'directory'}])
        self.file('bad\nname')
        with self.assertRaises(inventory.VolumeInventoryError):
            self.scan()
        (self.root / 'bad\nname').unlink()
        os.mkfifo(self.root / 'fifo')
        with self.assertRaises(inventory.VolumeInventoryError):
            self.scan()

    @unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'O_PATH'), 'regular-file inventory requires Linux O_PATH and procfs')
    def test_file_substitution_during_read_fails(self):
        self.file('file')
        self.file('replacement', b'world')
        original = os.read
        changed = False
        def read(fd, size):
            nonlocal changed
            result = original(fd, size)
            if not changed:
                changed = True
                os.replace(self.root / 'replacement', self.root / 'file')
            return result
        with mock.patch.object(inventory.os, 'read', side_effect=read), self.assertRaises(inventory.VolumeInventoryError):
            self.scan()

    @unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'O_PATH'), 'regular-file inventory requires Linux O_PATH and procfs')
    def test_substituted_symlink_is_never_opened_for_data(self):
        self.file('file')
        self.file('replacement')
        original = os.open
        calls = []
        swapped = False

        def opening(name, flags, *args, **kwargs):
            nonlocal swapped
            calls.append((name, flags))
            if name == 'file' and flags & os.O_PATH and not swapped:
                swapped = True
                (self.root / 'file').unlink()
                os.symlink('replacement', self.root / 'file')
            return original(name, flags, *args, **kwargs)

        with mock.patch.object(inventory.os, 'open', side_effect=opening), self.assertRaises(inventory.VolumeInventoryError):
            self.scan()
        self.assertTrue(swapped)
        self.assertFalse(any(isinstance(name, str) and name.startswith('/proc/self/fd/') for name, _flags in calls))

    @unittest.skipIf(sys.platform == 'linux' and hasattr(os, 'O_PATH'), 'non-Linux fail-closed check')
    def test_regular_file_unavailable_without_linux_path_descriptors(self):
        self.file('file')
        with self.assertRaises(inventory.VolumeInventoryError):
            self.scan()

    def test_directory_substitution_during_visit_fails(self):
        (self.root / 'a').mkdir()
        (self.root / 'b').mkdir()
        original = os.scandir
        count = 0
        def scandir(fd):
            nonlocal count
            count += 1
            if count == 2:
                os.rename(self.root / 'a', self.root / 'old')
                os.rename(self.root / 'b', self.root / 'a')
            return original(fd)
        with mock.patch.object(inventory.os, 'scandir', side_effect=scandir), self.assertRaises(inventory.VolumeInventoryError):
            self.scan()

    @unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'O_PATH'), 'regular-file inventory requires Linux O_PATH and procfs')
    def test_symlink_substitution_during_readlink_fails(self):
        self.file('file')
        os.symlink('file', self.root / 'link')
        original = os.readlink
        def readlink(name, **kwargs):
            target = original(name, **kwargs)
            (self.root / 'link').unlink()
            os.symlink('file', self.root / 'link')
            return target
        with mock.patch.object(inventory.os, 'readlink', side_effect=readlink), self.assertRaises(inventory.VolumeInventoryError):
            self.scan()

    @unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'O_PATH'), 'regular-file inventory requires Linux O_PATH and procfs')
    def test_read_error_is_generic_and_releases_descriptors(self):
        self.file('file')
        with mock.patch.object(inventory.os, 'read', side_effect=OSError('private path and data')):
            with self.assertRaises(inventory.VolumeInventoryError) as error:
                self.scan()
        self.assertEqual(str(error.exception), 'Volume inventory could not be verified.')
        self.assertEqual(len(self.scan()), 2)


if __name__ == '__main__':
    unittest.main()
