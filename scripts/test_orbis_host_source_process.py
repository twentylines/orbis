import importlib.util
import os
from pathlib import Path
import select
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location('source_process', Path(__file__).with_name('orbis-host-source-process.py'))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)


class SourceProcessTests(unittest.TestCase):
    def observe(self, body, flags=0, link='anon_inode:[pidfd]'):
        poll = mock.Mock()
        poll.poll.return_value = [(9, flags)] if flags else []
        with mock.patch.object(M.sys, 'platform', 'linux'), mock.patch.object(M.os, 'readlink', return_value=link), \
                mock.patch.object(M.os, 'dup', return_value=9), \
                mock.patch.object(M.select, 'poll', return_value=poll), mock.patch.object(M.os, 'open', return_value=10), \
                mock.patch.object(M.os, 'read', return_value=body), mock.patch.object(M.os, 'close'):
            return M.init_reaped(9, 123)

    def test_live_init_and_unreaped_exit_do_not_become_quiescence(self):
        self.assertFalse(self.observe(b'Pid:\t123\nNSpid:\t123\t1\n'))
        self.assertFalse(self.observe(b'Pid:\t123\nNSpid:\t123\t1\n', select.POLLIN))

    def test_reaped_pidfd_is_positive_without_newer_kernel_hup(self):
        self.assertTrue(self.observe(b'Pid:\t-1\nNSpid:\t-1\n', select.POLLIN))
        self.assertTrue(self.observe(b'Pid:\t-1\nNSpid:\t-1\n', select.POLLIN | select.POLLHUP))

    def test_missing_or_unrelated_process_information_is_never_death(self):
        for body, flags, link in [(b'Pid:\t-1\nNSpid:\t-1\n', 0, 'anon_inode:[pidfd]'),
                (b'Pid:\t0\nNSpid:\t0\n', select.POLLIN, 'anon_inode:[pidfd]'),
                (b'Pid:\t124\nNSpid:\t124\t1\n', 0, 'anon_inode:[pidfd]'),
                (b'Pid:\t123\nNSpid:\t123\t2\n', 0, 'anon_inode:[pidfd]'),
                (b'Pid:\t-1\nNSpid:\t-1\n', select.POLLIN, 'pipe:[123]'),
                (b'Pid:\t-1\nNSpid:\t-1\n', select.POLLNVAL, 'anon_inode:[pidfd]')]:
            with self.subTest(body=body, flags=flags, link=link), self.assertRaises(M.SourceProcessError):
                self.observe(body, flags, link)

    def test_malformed_or_duplicate_fields_are_preserved_as_errors(self):
        for body in (b'', b'Pid:\t-1\nPid:\t-1\nNSpid:\t-1\n', b'Pid:\t-1\n',
                     b'Pid:\t-1\nNSpid:\t-1\t1\n', b'Pid:\t-1\nNSpid:\tbad\n', b'x' * 8193):
            with self.subTest(body=body[:40]), self.assertRaises(M.SourceProcessError):
                self.observe(body, select.POLLIN)


if __name__ == '__main__':
    unittest.main()
