import hashlib
import json
from pathlib import Path
import socket
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

import test_orbis_host_time_machine_capabilities as C


class BackupArchiveCapabilityTests(unittest.TestCase):
    def setUp(self):
        self.fixture = C.CapabilityTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_exact_archive_contract_is_separate_from_legacy_contracts(self):
        archive = self.fixture.capability('archive')
        unsigned = {key: value for key, value in archive.items() if key != 'contractSha256'}
        self.assertEqual(archive['contractSha256'], hashlib.sha256(C.M.ARCHIVE_DOMAIN + C.M.canonical(unsigned)).hexdigest())
        self.assertEqual({key: value for key, value in unsigned.items() if key != 'sourceSha256'}, {
            'version': 1, 'format': 'orbis-full-backup', 'manifestVersion': 2,
            'mediaPolicy': 'explicit-inclusion.v1', 'appDataLinks': 'confined-relative.v1',
        })
        for kind in ('capture', 'restore'):
            legacy = self.fixture.capability(kind)
            self.assertEqual(archive['sourceSha256'], legacy['sourceSha256'])
            self.assertNotIn('manifestVersion', legacy)
            self.assertNotEqual(archive['contractSha256'], legacy['contractSha256'])

    def test_archive_support_requires_the_complete_unchanged_protected_installation(self):
        before = self.fixture.capability('archive')
        runtime = self.fixture.path / 'orbis-host-retained-restore-runtime.py'
        runtime.write_bytes(runtime.read_bytes() + b'# changed\n')
        self.assertNotEqual(before['contractSha256'], self.fixture.capability('archive')['contractSha256'])
        runtime.chmod(0o666)
        with self.assertRaises(ValueError):
            self.fixture.capability('archive')

    def test_new_route_is_peer_protected_and_fails_closed(self):
        with tempfile.TemporaryDirectory(prefix='archive-cap-') as folder:
            endpoint = Path(folder).resolve() / 'host.sock'
            server = C.S.UnixHTTPServer(str(endpoint), C.S.Handler)
            server.service = SimpleNamespace(time_machine_capability=self.fixture.capability)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)

            def get():
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    connection.settimeout(2)
                    connection.connect(str(endpoint))
                    connection.sendall(b'GET /v1/backup-archive/capability HTTP/1.0\r\n\r\n')
                    response = bytearray()
                    while True:
                        block = connection.recv(65536)
                        if not block:
                            break
                        response.extend(block)
                return bytes(response).split(b'\r\n\r\n', 1)

            with mock.patch.object(C.S, 'trusted_capture_peer', return_value=True):
                header, body = get()
                self.assertIn(b'200 OK', header)
                self.assertEqual(json.loads(body), self.fixture.capability('archive'))
                (self.fixture.path / 'orbis-host-retained-restore-runtime.py').chmod(0o666)
                self.assertIn(b'409', get()[0])
            with mock.patch.object(C.S, 'trusted_capture_peer', return_value=False):
                self.assertIn(b'403', get()[0])


if __name__ == '__main__':
    unittest.main()
