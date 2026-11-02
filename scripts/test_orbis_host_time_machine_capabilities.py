import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

import test_orbis_host_capture_authority as C
S = C.S


def load(name):
    spec = importlib.util.spec_from_file_location('native_capability_' + name.replace('-', '_'), Path(__file__).with_name(name))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


M = load('orbis-host-time-machine-capabilities.py')
A = load('orbis-host-retained-authority.py')


class CapabilityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='.capability-test-', dir=Path(__file__).parent)
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name).resolve(); self.path.chmod(0o700)
        self.enterContext(mock.patch.object(A, 'OWNER', os.geteuid()))
        for name in M.REQUIRED:
            file = self.path / name; file.write_bytes(b'# fixture source\n'); file.chmod(0o600)

    def capability(self, kind='capture'): return M.capability(kind, A, directory=self.path)

    def test_exact_contract_domains_and_ascii_canonicalization(self):
        for kind, version, domain in [('capture', 3, M.CAPTURE_DOMAIN), ('restore', 2, M.RESTORE_DOMAIN)]:
            value = self.capability(kind)
            self.assertEqual(value['version'], version)
            body = {key: item for key, item in value.items() if key != 'contractSha256'}
            self.assertEqual(value['contractSha256'], hashlib.sha256(domain + M.canonical(body)).hexdigest())
            self.assertEqual(value['runtimeSchema'], 'orbis.time-machine-runtime.v6')
        self.assertNotEqual(self.capability()['contractSha256'], self.capability('restore')['contractSha256'])

    def test_contract_changes_with_any_protected_helper_byte(self):
        before = self.capability()
        file = self.path / 'orbis-host-app-inet-diag.py'; file.write_bytes(file.read_bytes() + b'# changed\n')
        after = self.capability()
        self.assertNotEqual(before['sourceSha256'], after['sourceSha256'])
        self.assertNotEqual(before['contractSha256'], after['contractSha256'])

    def test_missing_empty_corrupt_or_writable_helper_refuses_support(self):
        file = self.path / 'orbis-host-retained-app-driver.py'
        for body in (b'', b'def broken('):
            file.write_bytes(body)
            with self.subTest(body=body), self.assertRaises(ValueError): self.capability()
        file.write_bytes(b'# source\n'); file.chmod(0o660)
        with self.assertRaises(ValueError): self.capability()
        file.unlink()
        with self.assertRaises(ValueError): self.capability()

    def test_symlink_or_hardlink_cannot_supply_a_helper(self):
        file = self.path / 'orbis-host-app-inet-diag.py'
        file.unlink(); file.symlink_to('orbis-host-service.py')
        with self.assertRaises((ValueError, OSError)): self.capability()
        file.unlink(); os.link(self.path / 'orbis-host-service.py', file)
        with self.assertRaises(ValueError): self.capability()

    def test_nonhelper_files_do_not_expand_capability_inputs(self):
        before = self.capability()
        (self.path / 'private-point.json').write_bytes(b'not a capability')
        self.assertEqual(self.capability(), before)
        with self.assertRaises(ValueError): self.capability('untrusted-feature')

    def test_real_installed_helper_closure_can_declare_both_contracts(self):
        setup = load('orbis-host-service-setup.py')
        with tempfile.TemporaryDirectory(prefix='orbis-installed-') as folder:
            destination = Path(folder).resolve(); destination.chmod(0o700)
            for source in setup.source_files(Path(__file__).parent)[0]:
                target = destination / source.name
                target.write_bytes(source.read_bytes()); target.chmod(0o600)
            for kind in ('capture', 'restore'):
                value = M.capability(kind, A, directory=destination)
                self.assertEqual(len(value['sourceSha256']), 64)
            self.assertLessEqual(len(list(destination.iterdir())), 64)
            (destination / 'orbis-host-app-inet-diag.py').unlink()
            with self.assertRaises(ValueError): M.capability('restore', A, directory=destination)

    def test_actual_get_routes_are_peer_protected_and_source_bound(self):
        short = tempfile.TemporaryDirectory(prefix='orbis-cap-')
        self.addCleanup(short.cleanup)
        endpoint = Path(short.name).resolve() / 'host.sock'
        server = S.UnixHTTPServer(str(endpoint), S.Handler)
        server.service = SimpleNamespace(time_machine_capability=self.capability)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        def get(path):
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(2); connection.connect(str(endpoint)); connection.sendall(('GET ' + path + ' HTTP/1.0\r\n\r\n').encode())
                response = b''
                while True:
                    block = connection.recv(65536)
                    if not block: break
                    response += block
            header, body = response.split(b'\r\n\r\n', 1)
            return header, json.loads(body)
        with mock.patch.object(S, 'trusted_capture_peer', return_value=True):
            for path, kind in [('/v3/controller-capture-authority/capability', 'capture'), ('/v1/retained-restore/capability', 'restore')]:
                head, body = get(path); self.assertIn(b'200 OK', head); self.assertEqual(body, self.capability(kind))
            (self.path / 'orbis-host-app-inet-diag.py').chmod(0o660)
            self.assertIn(b'409', get('/v3/controller-capture-authority/capability')[0])
        with mock.patch.object(S, 'trusted_capture_peer', return_value=False):
            self.assertIn(b'403', get('/v3/controller-capture-authority/capability')[0])


class CapabilityFenceTests(unittest.TestCase):
    def fixture(self, modern):
        value = C.CaptureAuthorityTests(); value.capture_v3 = modern; value.setUp()
        self.addCleanup(value.doCleanups)
        return value

    def test_new_capture_contract_is_durable_and_acknowledged_by_exact_reply(self):
        value = self.fixture(True)
        self.assertEqual(set(value.fence_reply), {'version', 'token', 'expiresAt', 'captureContractSha256'})
        self.assertEqual(value.fence_reply['version'], 2)
        record = value.service._verify_capture_fence(value.token)
        self.assertEqual(record['schema'], 'orbis.controller-capture-fence.v2')
        self.assertEqual(record['captureContractSha256'], value.service.time_machine_capability('capture')['contractSha256'])
        request = {**value.request, 'preparationSha256': value.preparation['preparationSha256'], 'clientKey': value.token,
                   'captureContractSha256': record['captureContractSha256']}
        self.assertEqual(value.service.acquire_capture_fence(request), value.fence_reply)
        with self.assertRaises(ValueError): value.service.acquire_capture_fence({**request, 'captureContractSha256': '0' * 64})
        request.pop('captureContractSha256')
        with self.assertRaises(ValueError): value.service.acquire_capture_fence(request)

    def test_legacy_fence_reply_and_v3_rejection_remain_distinct(self):
        value = self.fixture(False)
        self.assertEqual(set(value.fence_reply), {'version', 'token', 'expiresAt'})
        self.assertEqual(value.fence_reply['version'], 1)
        with self.assertRaises(ValueError): value.service.prepare_controller_app_runtime(value.fixture.point, value.proxy_request())

    def test_contract_drift_stops_live_work_but_original_exact_cleanup_survives(self):
        value = self.fixture(True)
        file = value.native_scripts / 'orbis-host-app-inet-diag.py'
        file.write_bytes(file.read_bytes() + b'\n# simulated native package replacement\n')
        with self.assertRaises(ValueError): value.service.maintain_capture_fence('renew', value.token)
        expected = {**value.request, 'preparationSha256': value.preparation['preparationSha256']}
        result = value.service.maintain_capture_fence('release', value.token, expected)
        self.assertEqual(result, {'version': 1, 'released': True})


if __name__ == '__main__': unittest.main()
