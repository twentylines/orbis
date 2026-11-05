import importlib.util
import json
import os
from pathlib import Path
import socketserver
import tempfile
import threading
import struct
import unittest
from http.server import BaseHTTPRequestHandler
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('volume_engine_test', Path(__file__).with_name('orbis-host-volume-engine.py'))
engine = importlib.util.module_from_spec(spec); spec.loader.exec_module(engine)


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


class VolumeEngineTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='ve-')
        self.path = Path(self.directory.name) / 's'
        self.calls = []
        self.reply = lambda _method, _path, _body: (200, b'{"ID":"disposable-daemon"}')
        outer = self
        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            def log_message(self, *_args): pass
            def handle_request(self):
                body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                outer.calls.append((self.command, self.path, body))
                if self.path == '/version': status, payload = 200, b'{"ApiVersion":"1.44"}'
                else: status, payload = outer.reply(self.command, self.path, body)
                try:
                    self.send_response(status); self.send_header('Content-Length', str(len(payload))); self.end_headers()
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError): pass
            do_GET = do_POST = do_DELETE = handle_request
        self.server = Server(str(self.path), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        # Linux proof exercises the real peer credential check; macOS cannot provide SO_PEERCRED.
        self.real_peer = engine._peer_uid
        self.peer = patch.object(engine, '_peer_uid', return_value=os.geteuid()); self.peer.start()
        self.client = engine.DockerVolumeEngine(str(self.path), owner=os.geteuid(), timeout=1)

    def tearDown(self):
        self.peer.stop(); self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.directory.cleanup()

    def test_bounded_versioned_json_and_empty_replies(self):
        self.assertEqual(self.client.request('GET', '/info'), {'ID': 'disposable-daemon'})
        self.assertEqual(self.calls[-1][:2], ('GET', '/v1.44/info'))
        self.reply = lambda *_args: (204, b'')
        self.assertIsNone(self.client.request('POST', '/containers/' + 'a' * 64 + '/start'))

    def test_root_daemon_may_be_namespace_init_but_an_invisible_peer_is_rejected(self):
        from unittest.mock import Mock
        peer = Mock()
        with patch.object(engine.sys, 'platform', 'linux'), patch.object(engine.socket, 'SO_PEERCRED', 17, create=True):
            peer.getsockopt.return_value = struct.pack('3i', 1, 0, 0)
            self.assertEqual(self.real_peer(peer), 0)
            peer.getsockopt.return_value = struct.pack('3i', 0, 0, 0)
            with self.assertRaises(engine.VolumeEngineError): self.real_peer(peer)

    def test_routes_cannot_delete_volumes_or_mutate_source_definitions(self):
        before = len(self.calls)
        for method, route, body in [('DELETE', '/volumes/source', None), ('POST', '/containers/prune', {}),
                                    ('GET', '/containers/' + 'a' * 64 + '/archive?path=/', None),
                                    ('GET', '/info', {'body': True}), ('POST', '/containers/create?name=other', {})]:
            with self.assertRaises(engine.VolumeEngineError): self.client.request(method, route, body)
        self.assertEqual(len(self.calls), before)

    def test_only_owned_reader_names_and_bounded_creation_body_are_sent(self):
        name = 'orbis-volume-reader-12345678-1234-4123-8123-123456789abc'
        body = {'Image': 'sha256:' + 'a' * 64, 'Env': [], 'HostConfig': {'ReadonlyRootfs': True}}
        self.client.request('POST', '/containers/create?name=' + name, body)
        self.assertEqual(json.loads(self.calls[-1][2]), body)
        before = len(self.calls)
        with self.assertRaises(engine.VolumeEngineError): self.client.request('POST', '/containers/create?name=' + name, {'large': 'x' * (1024 * 1024)})
        self.assertEqual(len(self.calls), before)

    def test_duplicate_keys_malformed_json_and_oversized_metadata_fail(self):
        for payload in [b'{"x":1,"x":2}', b'{', b'{"x":NaN}', b'{"x":"\\ud800"}', b'[' * 34 + b'0' + b']' * 34]:
            self.reply = lambda *_args, payload=payload: (200, payload)
            with self.assertRaises(engine.VolumeEngineError): self.client.request('GET', '/info')
        self.client.maximum = 1024
        self.reply = lambda *_args: (200, b' ' * 1025)
        with self.assertRaises(engine.VolumeEngineError): self.client.request('GET', '/info')

    def test_http_errors_expose_status_without_private_error_body(self):
        self.reply = lambda *_args: (404, b'{"message":"private daemon details"}')
        with self.assertRaises(engine.VolumeEngineError) as result: self.client.request('GET', '/volumes/source')
        self.assertEqual(result.exception.status, 404)
        self.assertNotIn('private daemon details', str(result.exception))

    def test_socket_replacement_or_permission_change_is_rejected(self):
        self.reply = lambda *_args: (os.chmod(self.path, 0o777) or 200, b'{}')
        with self.assertRaises(engine.VolumeEngineError): self.client.request('GET', '/info')
        os.chmod(self.path, 0o600)
        with self.assertRaises(engine.VolumeEngineError): self.client.request('GET', '/info')

    def test_wall_deadline_interrupts_a_stalled_reply(self):
        stalled = threading.Event()
        self.client.timeout = 0.05
        self.reply = lambda *_args: (stalled.wait(0.3) or 200, b'{}')
        with self.assertRaises(engine.VolumeEngineError): self.client.request('GET', '/info')
        stalled.set()


if __name__ == '__main__': unittest.main()
