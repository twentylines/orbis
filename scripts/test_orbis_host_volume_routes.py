import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('volume_routes_service', Path(__file__).with_name('orbis-host-service.py'))
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)


class VolumeRoutesTests(unittest.TestCase):
    def handler(self, path, body=b'{}'):
        selected = object.__new__(S.Handler)
        selected.path = path; selected.connection = Mock(); selected.server = SimpleNamespace(service=Mock())
        selected.headers = {'Content-Type': 'application/json', 'Content-Length': str(len(body))}
        selected.rfile, selected.wfile = io.BytesIO(body), io.BytesIO()
        selected.send_response, selected.send_header, selected.end_headers, selected.send_json = Mock(), Mock(), Mock(), Mock()
        return selected

    def test_volume_capability_uses_separate_source_bound_contract_and_rejects_untrusted_peer(self):
        handler = self.handler('/v1/backup-volumes/capability')
        with patch.object(S, 'trusted_capture_peer', return_value=False): handler.do_GET()
        handler.send_json.assert_called_once_with(403, {'error': 'native helper peer is unavailable'})
        handler.server.service.time_machine_capability.assert_not_called()
        handler = self.handler('/v1/backup-volumes/capability'); handler.server.service.time_machine_capability.return_value = {'version': 1}
        with patch.object(S, 'trusted_capture_peer', return_value=True): handler.do_GET()
        handler.server.service.time_machine_capability.assert_called_once_with('volume')

    def test_root_peer_request_keeps_operation_bound_to_point_and_exact_raw_body(self):
        point = '12345678-1234-4123-8123-123456789abc'
        for action in ['prepare', 'inventory', 'verify']:
            request = {'token': 'a' * 64}
            handler = self.handler('/v1/backup-volumes/' + point + '/' + action, json.dumps(request).encode())
            handler.server.service.capture_volumes.return_value = b'{"version":1}'
            with patch.object(S, 'trusted_capture_peer', return_value=True): handler.do_POST()
            handler.server.service.capture_volumes.assert_called_once_with(action, point, request)
            handler.send_response.assert_called_once_with(200)
            self.assertEqual(handler.wfile.getvalue(), b'{"version":1}')
            handler.send_header.assert_any_call('Cache-Control', 'no-store')

    def test_untrusted_post_cannot_inspect_or_create_reader(self):
        handler = self.handler('/v1/backup-volumes/12345678-1234-4123-8123-123456789abc/inventory')
        with patch.object(S, 'trusted_capture_peer', return_value=False): handler.do_POST()
        self.assertEqual(handler.send_json.call_args.args[0], 403)
        handler.server.service.capture_volumes.assert_not_called()

    def test_bad_path_size_encoding_or_duplicate_keys_are_refused_before_operation(self):
        path = '/v1/backup-volumes/12345678-1234-4123-8123-123456789abc/inventory'
        for case in ['path', 'large', 'transfer', 'type', 'duplicates']:
            handler = self.handler(path if case != 'path' else path.replace('inventory', '../../outside'), b'{"token":1,"token":2}' if case == 'duplicates' else b'{}')
            if case == 'large': handler.headers['Content-Length'] = '4097'
            if case == 'transfer': handler.headers['Transfer-Encoding'] = 'chunked'
            if case == 'type': handler.headers['Content-Type'] = 'text/plain'
            with patch.object(S, 'trusted_capture_peer', return_value=True): handler.do_POST()
            self.assertEqual(handler.send_json.call_args.args[0], 409)
            handler.server.service.capture_volumes.assert_not_called()


if __name__ == '__main__': unittest.main()
