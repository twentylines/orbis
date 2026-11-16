import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


S = load('orbis-host-selected-capture.py', 'bounded_selected_subject')
B = S.IO


class SelectedCaptureIOTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        if not hasattr(os, 'listxattr') or not hasattr(os, 'getxattr'):
            self.enterContext(mock.patch.object(S.PACK, 'attributes', return_value={}))

    def budget(self, maximum=1024 ** 2, seconds=5):
        return B.Budget(maximum, seconds, self.root, 0)

    def produce(self, body_size, budget, path):
        with path.open('wb') as stream:
            B.process([sys.executable, '-c', 'import os; os.write(1, b"x" * ' + str(body_size) + ')'],
                      budget, 1024 ** 2, writer=B.Writer(stream, budget, 1024 ** 2))

    def test_actual_sources_stream_same_portable_entries_and_preserve_links(self):
        source = self.root / 'resource-0000'
        source.mkdir()
        (source / 'data').write_bytes(b'actual selected bytes')
        (source / 'data').chmod(0o640)
        os.link(source / 'data', source / 'hardlink')
        (source / 'symlink').symlink_to('data')
        budget = self.budget()
        expected = S.PACK.collect(self.root, [{'kind': 'directory'}])
        artifact = self.root / 'apps.tar'
        with artifact.open('wb') as stream:
            with tarfile.open(fileobj=B.Writer(stream, budget, 1024 ** 2), mode='w|') as archive:
                actual = B.collect([source], S.PACK, budget, archive)
        self.assertEqual(actual, expected)
        self.assertEqual(actual, B.collect([source], S.PACK, budget))
        self.assertEqual(budget.written, artifact.stat().st_size)
        with tarfile.open(artifact) as archive:
            self.assertEqual(archive.extractfile('resources/0000/data').read(), b'actual selected bytes')
            item = archive.getmember('resources/0000/data')
            self.assertEqual((item.uid, item.gid, item.mode), (os.getuid(), os.getgid(), 0o640))
            self.assertTrue(archive.getmember('resources/0000/hardlink').islnk())
            self.assertTrue(archive.getmember('resources/0000/symlink').issym())

    def test_growth_after_preflight_cannot_exceed_actual_tar_write_budget(self):
        source = self.root / 'source'
        source.mkdir()
        (source / 'data').write_bytes(b'small')
        budget = self.budget(32768)
        B.collect([source], S.PACK, budget, hash_files=False)
        with (source / 'data').open('ab') as stream:
            stream.write(b'growth' * 20000)
        artifact = self.root / 'partial.tar'
        with self.assertRaisesRegex(B.BoundsError, 'aggregate write budget'):
            with artifact.open('wb') as stream:
                with tarfile.open(fileobj=B.Writer(stream, budget, 1024 ** 2), mode='w|') as archive:
                    B.collect([source], S.PACK, budget, archive)
        self.assertLessEqual(artifact.stat().st_size, 32768)
        self.assertEqual(artifact.stat().st_size, budget.written)

    def test_multiple_real_image_exports_and_final_spool_share_one_cap(self):
        budget = self.budget(80 * 1024)
        first, second, final = [self.root / name for name in ('image1', 'image2', 'apps.tar')]
        self.produce(32768, budget, first)
        self.produce(32768, budget, second)
        with self.assertRaisesRegex(B.BoundsError, 'aggregate write budget'):
            with final.open('wb') as stream:
                with tarfile.open(fileobj=B.Writer(stream, budget, 1024 ** 2), mode='w|') as archive:
                    for path in (first, second):
                        info = tarfile.TarInfo(path.name)
                        info.size = path.stat().st_size
                        with path.open('rb') as source:
                            archive.addfile(info, source)
        sizes = sum(path.stat().st_size for path in (first, second, final))
        self.assertEqual(sizes, budget.written)
        self.assertLessEqual(sizes, 80 * 1024)

    def test_source_read_and_hash_share_existing_monotonic_deadline(self):
        clock = mock.Mock(return_value=0)
        budget = B.Budget(1024 ** 2, 2, self.root, 0, clock=clock)
        source = self.root / 'source'
        source.mkdir()
        (source / 'data').write_bytes(b'contents')
        original = B.Reader.read
        def expire(reader, size):
            body = original(reader, size)
            clock.return_value = 3
            return body
        with mock.patch.object(B.Reader, 'read', expire), self.assertRaisesRegex(B.BoundsError, 'aggregate deadline'):
            B.collect([source], S.PACK, budget)
        with self.assertRaisesRegex(B.BoundsError, 'aggregate deadline'):
            B.file_hash(source / 'data', budget)

    def test_image_exports_do_not_reset_deadline(self):
        budget = self.budget(seconds=0.2)
        self.produce(1, budget, self.root / 'image1')
        with self.assertRaises(B.BoundsError):
            B.process([sys.executable, '-c', 'import time; time.sleep(2)'], budget, 1024)
        self.assertLess(budget.remaining() if budget.deadline > budget.clock() else 0, 0.05)

    def test_timeout_kills_and_positively_waits_for_owned_child(self):
        children = []
        popen = subprocess.Popen
        def record(*args, **kwargs):
            child = popen(*args, **kwargs)
            children.append(child)
            return child
        started = time.monotonic()
        with mock.patch.object(B.subprocess, 'Popen', side_effect=record), self.assertRaises(B.BoundsError):
            B.process([sys.executable, '-c', 'import time; time.sleep(10)'], self.budget(seconds=0.1), 1024)
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].returncode)
        self.assertIsNotNone(children[0].poll())

    def test_unreaped_child_is_explicitly_recovery_required(self):
        child = mock.Mock(stdout=io.BytesIO(), pid=123)
        child.returncode = None
        with mock.patch.object(B.subprocess, 'Popen', return_value=child), mock.patch.object(B.os, 'set_blocking', side_effect=RuntimeError('interrupted')), mock.patch.object(B.os, 'killpg'), mock.patch.object(B.os, 'waitpid', side_effect=ChildProcessError('fixture missing kernel status')), self.assertRaisesRegex(B.BoundsError, 'could not be reaped'):
            B.process(['owned-fixture'], self.budget(), 1024)
        child.wait.assert_not_called()

    def test_failed_cancellation_still_attempts_positive_wait(self):
        child = mock.Mock(stdout=io.BytesIO(), pid=123)
        child.returncode = None
        with mock.patch.object(B.subprocess, 'Popen', return_value=child), mock.patch.object(B.os, 'set_blocking', side_effect=RuntimeError('interrupted')), mock.patch.object(B.os, 'killpg', side_effect=PermissionError('fixture')), mock.patch.object(B.os, 'waitpid', side_effect=ChildProcessError('fixture missing kernel status')), self.assertRaisesRegex(B.BoundsError, 'could not be reaped'):
            B.process(['owned-fixture'], self.budget(), 1024)
        child.wait.assert_not_called()

    def test_free_space_guard_preserves_reserved_headroom(self):
        budget = B.Budget(100, 5, self.root, 256)
        stream = io.BytesIO()
        with mock.patch.object(B.os, 'statvfs', return_value=type('Usage', (), {'f_bavail': 260, 'f_frsize': 1})()), self.assertRaisesRegex(B.BoundsError, 'free recovery storage'):
            B.Writer(stream, budget, 100).write(b'12345')
        self.assertEqual(stream.getvalue(), b'')
        self.assertEqual(budget.written, 0)


if __name__ == '__main__':
    unittest.main()
