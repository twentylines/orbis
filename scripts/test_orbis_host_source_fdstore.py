import array
import importlib.util
import json
import os
import socket
import tempfile
import threading
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('fdstore', os.path.join(os.path.dirname(__file__), 'orbis-host-source-fdstore.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NAME = 'orbis-source-12345678-1234-4234-8234-123456789abc-init'
OTHER = 'orbis-source-12345678-1234-4234-8234-123456789abc-root'


class Fake:
    def __init__(self):
        self.records = {}
        self.cap = 4
        self.mode = 'accept'
        self.calls = []

    def validate(self, unit):
        if self.mode == 'unsupported':
            raise m.CustodyError('unsupported')
        return self.cap

    def inventory(self, unit):
        return dict(self.records)

    def notify(self, message, fd=None):
        self.calls.append(message)
        name = message.split('FDNAME=')[1]
        if self.mode == 'accept':
            if fd is None:
                self.records.pop(name, None)
            else:
                self.records[name] = (name, *m._metadata(fd), '/private', 0)
        elif self.mode == 'partial':
            self.records[OTHER] = (OTHER, *m._metadata(fd), '/private', 0)

    def barrier(self):
        pass


class Tests(unittest.TestCase):
    def setUp(self):
        self.rt = Fake()
        self.store = m.DescriptorStore(runtime=self.rt)
        self.fd = os.open('/dev/null', os.O_RDONLY)

    def tearDown(self):
        os.close(self.fd)

    def test_deposit_remove_and_dedup(self):
        self.store.deposit(NAME, self.fd)
        with self.assertRaises(m.CustodyError):
            self.store.deposit(NAME, self.fd)
        self.assertEqual(len(self.rt.calls), 1)
        self.store.remove(NAME)
        self.assertEqual(self.rt.records, {})

    def test_refused_partial_full_unsupported(self):
        for mode in ('refused', 'partial', 'unsupported'):
            self.rt = Fake()
            self.rt.mode = mode
            with self.assertRaises(m.CustodyError):
                m.DescriptorStore(runtime=self.rt).deposit(NAME, self.fd)
            if mode == 'unsupported':
                self.assertEqual(self.rt.calls, [])
        self.rt = Fake()
        self.rt.cap = 0
        with self.assertRaises(m.CustodyError):
            m.DescriptorStore(runtime=self.rt).deposit(NAME, self.fd)
        self.assertEqual(self.rt.calls, [])

    def test_deduplicated_descriptor_and_failed_removal(self):
        self.store.deposit(NAME, self.fd)
        self.rt.mode = 'refused'  # Manager may deduplicate and retain the existing slot only.
        with self.assertRaises(m.CustodyError):
            self.store.deposit(OTHER, self.fd)
        self.assertEqual(set(self.rt.records), {NAME})
        with self.assertRaises(m.CustodyError):
            self.store.remove(NAME)
        self.assertEqual(set(self.rt.records), {NAME})

    def test_inventory_schema_and_malformed(self):
        row = [NAME, *m._metadata(self.fd), '/private', 0]
        raw = json.dumps({'type': 'a(suuutuusu)', 'data': [[row]]})
        self.assertEqual(m._parse_inventory(raw)[NAME], tuple(row))
        for invalid in ({'type': 'a(suuutuusu)', 'data': [[row, row]]},
                        {'type': 'wrong', 'data': [[]]},
                        {'type': 'a(suuutuusu)', 'data': [[[NAME + '\n', *row[1:]]]]}):
            with self.assertRaises(m.CustodyError):
                m._parse_inventory(json.dumps(invalid))
        with self.assertRaises(m.CustodyError):
            m._parse_inventory('{"type":"wrong","type":"a(suuutuusu)","data":[[]]}')

    def test_real_context_rejects_wrong_owner_generation_and_unpinned_manager_before_notification(self):
        values = {'MainPID': str(os.getpid()), 'InvocationID': 'a' * 32, 'NotifyAccess': 'main',
                  'FileDescriptorStoreMax': '4', 'FileDescriptorStorePreserve': 'yes', 'ActiveState': 'active',
                  'NeedDaemonReload': 'no', 'WantedBy': 'multi-user.target'}
        def query(args):
            if args[2] == m._ANCHOR:
                return 'ActiveState=active\n'
            return ''.join(key + '=' + value + '\n' for key, value in values.items())
        with mock.patch.object(m.sys, 'platform', 'linux'), mock.patch.object(m.os, 'geteuid', return_value=0), \
                mock.patch.dict(os.environ, {'INVOCATION_ID': 'a' * 32, 'NOTIFY_SOCKET': '/run/systemd/notify'}), \
                mock.patch.object(m, '_command', side_effect=query), mock.patch.object(m._Runtime, 'notify') as notify:
            self.assertEqual(m._Runtime().validate(m._UNIT), 4)
            for key, changed in [('MainPID', str(os.getpid() + 1)), ('InvocationID', 'b' * 32), ('NotifyAccess', 'all'),
                                 ('FileDescriptorStoreMax', '0'), ('FileDescriptorStoreMax', '4097'),
                                 ('FileDescriptorStorePreserve', 'restart'), ('NeedDaemonReload', 'yes'),
                                 ('ActiveState', 'failed'), ('WantedBy', '')]:
                original = values[key]
                values[key] = changed
                try:
                    with self.subTest(key=key), self.assertRaises(m.CustodyError):
                        m.DescriptorStore().deposit(NAME, self.fd)
                finally:
                    values[key] = original
            notify.assert_not_called()

    def test_inactive_custody_anchor_is_not_accepted(self):
        values = {'MainPID': str(os.getpid()), 'InvocationID': 'a' * 32, 'NotifyAccess': 'main',
                  'FileDescriptorStoreMax': '4', 'FileDescriptorStorePreserve': 'yes', 'ActiveState': 'active',
                  'NeedDaemonReload': 'no', 'WantedBy': 'multi-user.target'}
        with mock.patch.object(m.sys, 'platform', 'linux'), mock.patch.object(m.os, 'geteuid', return_value=0), \
                mock.patch.dict(os.environ, {'INVOCATION_ID': 'a' * 32, 'NOTIFY_SOCKET': '/run/systemd/notify'}), \
                mock.patch.object(m, '_command', side_effect=[''.join(k + '=' + v + '\n' for k, v in values.items()), 'ActiveState=inactive\n']):
            with self.assertRaises(m.CustodyError):
                m._Runtime().validate(m._UNIT)

    def test_inherited_rejection_preserves_environment(self):
        for count, names in [('2', NAME + ':' + OTHER), ('2', NAME + ':' + NAME), ('1', OTHER), ('1', NAME)]:
            env = {'LISTEN_PID': str(os.getpid()), 'LISTEN_FDS': count, 'LISTEN_FDNAMES': names}
            with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(m.fcntl, 'fcntl', side_effect=OSError('closed')):
                with self.assertRaises(m.CustodyError):
                    self.store.take_inherited([NAME])
                self.assertEqual(os.environ['LISTEN_FDNAMES'], names)

    def test_inherited_success_consumes_after_validation(self):
        env = {'LISTEN_PID': str(os.getpid()), 'LISTEN_FDS': '2', 'LISTEN_FDNAMES': NAME + ':' + OTHER}
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(m.fcntl, 'fcntl', return_value=0) as f:
            self.assertEqual(self.store.take_inherited([NAME, OTHER]), {NAME: 3, OTHER: 4})
            self.assertNotIn('LISTEN_FDS', os.environ)
            self.assertEqual(f.call_count, 6)

    def test_real_unix_rights_and_barrier(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'notify.sock')
            receiver = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
            receiver.bind(path)
            receiver.settimeout(5)
            received = []
            errors = []
            def serve():
                try:
                    for _ in range(2):
                        message, anc, flags, _ = receiver.recvmsg(4096, socket.CMSG_SPACE(array.array('i').itemsize))
                        self.assertEqual(flags, 0)
                        rights = array.array('i')
                        rights.frombytes(anc[0][2][:rights.itemsize])
                        fd = rights[0]
                        received.append((message, os.fstat(fd).st_ino))
                        os.close(fd)
                except BaseException as exc:
                    errors.append(exc)
            thread = threading.Thread(target=serve)
            thread.start()
            try:
                with mock.patch.dict(os.environ, {'NOTIFY_SOCKET': path}):
                    runtime = m._Runtime()
                    runtime.notify('FDSTORE=1\nFDPOLL=0\nFDNAME=' + NAME, self.fd)
                    runtime.barrier()
                thread.join(5)
                self.assertFalse(thread.is_alive())
                self.assertFalse(errors)
                self.assertEqual(received[0], (('FDSTORE=1\nFDPOLL=0\nFDNAME=' + NAME).encode(), os.fstat(self.fd).st_ino))
                self.assertEqual(received[1][0], b'BARRIER=1')
            finally:
                receiver.close()
                thread.join(5)


if __name__ == '__main__':
    unittest.main()
