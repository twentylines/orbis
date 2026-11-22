import copy
from email.message import Message
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from unittest import mock

from test_orbis_host_sentinel_integration import SERVICE


UNAVAILABLE = {'version': 1, 'available': False, 'status': None}
UNKNOWN = {'installedVersion': None, 'availableVersion': None, 'state': 'unknown'}
STATUS = {'schema': 'orbis-sentinel.status.v1', 'protocolVersion': 1,
          'components': {'orbis': UNKNOWN, 'sentinel': {
              'installedVersion': '0.1.0-dev.10', 'availableVersion': None, 'state': 'healthy'}}}
READINGS_UNAVAILABLE = {'schema': 'orbis-sentinel.system-readings.v1', 'state': 'unavailable', 'ageMs': None, 'sample': None}
READINGS = {**READINGS_UNAVAILABLE, 'state': 'ready', 'ageMs': 200, 'sample': {
    'sampledAt': 1760000000000,
    'cpu': {'model': 'Actual CPU', 'reportedClockGHz': 2.4, 'totalPercent': 60, 'perCorePercent': [0, 50], 'uptimeSeconds': 11.5},
    'memory': {'totalBytes': 4096, 'availableBytes': 1024, 'swapTotalBytes': 0, 'swapFreeBytes': 0},
}}


class SentinelStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('ORBIS_TEST_SOCKET_DIR'))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.path = self.root / 's'
        self.stop = threading.Event()
        self.threads = []
        self.listeners = []
        self.requests = []
        self.owner = mock.patch.object(SERVICE.HOST.AUTHORITY, 'OWNER', os.geteuid())
        self.owner.start()
        self.addCleanup(self.owner.stop)

    def tearDown(self):
        self.stop.set()
        for listener in self.listeners:
            listener.close()
        for thread in self.threads:
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())

    def start(self, body=None, *, wire=None, swap=False, stall=False, trickle=False):
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(self.path))
        self.path.chmod(0o600)
        listener.listen(8)
        listener.settimeout(0.1)
        self.listeners.append(listener)
        if wire is None:
            body = json.dumps(STATUS).encode() if body is None else body
            wire = (b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(body)).encode()
                    + b'\r\nConnection: close\r\n\r\n' + body)

        def serve():
            while not self.stop.is_set():
                try:
                    connection, _ = listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    return
                with connection:
                    connection.settimeout(1)
                    request = bytearray()
                    try:
                        while b'\r\n\r\n' not in request:
                            part = connection.recv(4096)
                            if not part:
                                break
                            request.extend(part)
                        self.requests.append(bytes(request))
                        if swap:
                            self.path.unlink()
                            replacement = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                            replacement.bind(str(self.path))
                            self.path.chmod(0o600)
                            self.listeners.append(replacement)
                        if stall:
                            self.stop.wait(3)
                        elif trickle:
                            for byte in wire:
                                if self.stop.wait(0.15):
                                    break
                                connection.sendall(bytes([byte]))
                        else:
                            connection.sendall(wire)
                    except OSError:
                        pass
        thread = threading.Thread(target=serve)
        self.threads.append(thread)
        thread.start()

    def read(self):
        return SERVICE.sentinel_component_status(self.path)

    def test_real_socket_read_preserves_both_components_and_never_observes_jobs(self):
        self.start()
        with mock.patch.object(SERVICE.HOST, 'saved_state', side_effect=AssertionError('No enrollment mutation')):
            self.assertEqual(self.read(), {'version': 1, 'available': True, 'status': STATUS})
        self.assertEqual(len(self.requests), 1)
        self.assertTrue(self.requests[0].startswith(b'GET /sentinel/api/v1/status HTTP/1.1\r\n'))

    def test_missing_socket_and_untrusted_permissions_are_unavailable(self):
        self.assertEqual(self.read(), UNAVAILABLE)
        self.start()
        self.path.chmod(0o666)
        self.assertEqual(self.read(), UNAVAILABLE)
        self.path.chmod(0o600)
        self.root.chmod(0o777)
        try:
            self.assertEqual(self.read(), UNAVAILABLE)
        finally:
            self.root.chmod(0o700)
        self.assertEqual(self.requests, [])

    def test_linked_socket_is_not_followed(self):
        self.start()
        actual = self.root / 'actual'
        self.path.rename(actual)
        self.path.symlink_to(actual)
        self.assertEqual(self.read(), UNAVAILABLE)
        self.assertEqual(self.requests, [])

    def test_socket_replacement_during_read_is_unavailable(self):
        self.start(swap=True)
        self.assertEqual(self.read(), UNAVAILABLE)

    def test_unknown_components_are_preserved_without_invented_health(self):
        status = {**STATUS, 'components': {'orbis': UNKNOWN, 'sentinel': UNKNOWN}}
        self.start(json.dumps(status).encode())
        self.assertEqual(self.read(), {'version': 1, 'available': True, 'status': status})

    def test_invalid_schema_versions_states_and_additional_fields_are_rejected(self):
        cases = [
            {**STATUS, 'protocolVersion': True}, {**STATUS, 'protocolVersion': 2},
            {**STATUS, 'extra': True}, {**STATUS, 'schema': 'other'},
        ]
        for key, value in [('state', 'fiction'), ('installedVersion', '1.2.3\n'), ('availableVersion', 'x' * 129)]:
            status = copy.deepcopy(STATUS)
            status['components']['sentinel'][key] = value
            cases.append(status)
        for index, status in enumerate(cases):
            with self.subTest(index=index):
                self.path = self.root / ('s' + str(index))
                self.start(json.dumps(status).encode())
                self.assertEqual(self.read(), UNAVAILABLE)

    def test_duplicate_keys_invalid_utf8_and_oversized_bodies_are_rejected(self):
        cases = [b'{"schema":"a","schema":"b"}', b'\xff', b'x' * (64 * 1024 + 1), b'x' * (96 * 1024)]
        for index, body in enumerate(cases):
            with self.subTest(index=index):
                self.path = self.root / ('s' + str(index))
                self.start(body)
                self.assertEqual(self.read(), UNAVAILABLE)

    def test_http_failure_truncation_and_ambiguous_framing_are_rejected(self):
        body = json.dumps(STATUS).encode()
        cases = [b'HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n',
                 b'HTTP/1.1 200 OK\r\nContent-Length: 99999\r\n\r\n' + body,
                 b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}',
                 b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}trailing']
        for index, wire in enumerate(cases):
            with self.subTest(index=index):
                self.path = self.root / ('s' + str(index))
                self.start(wire=wire)
                self.assertEqual(self.read(), UNAVAILABLE)

    def test_total_read_deadline_does_not_leave_a_blocking_request(self):
        for index, options in enumerate([{'stall': True}, {'trickle': True}]):
            with self.subTest(options=options):
                self.path = self.root / ('s' + str(index))
                self.start(**options)
                started = time.monotonic()
                self.assertEqual(self.read(), UNAVAILABLE)
                self.assertLess(time.monotonic() - started, 2)

    def test_handler_refuses_foreign_peers_without_accessing_service_or_reader(self):
        for allowed in (False, True):
            handler = object.__new__(SERVICE.Handler)
            handler.path = '/v1/sentinel/status'
            handler.connection = mock.Mock()
            handler.server = mock.Mock()
            handler.send_json = mock.Mock()
            with mock.patch.object(SERVICE, 'trusted_capture_peer', return_value=allowed), \
                    mock.patch.object(SERVICE, 'sentinel_component_status', return_value=UNAVAILABLE) as reader:
                handler.do_GET()
                if allowed:
                    reader.assert_called_once_with()
                    handler.send_json.assert_called_once_with(200, UNAVAILABLE)
                else:
                    reader.assert_not_called()
                    self.assertEqual(handler.send_json.call_args.args[0], 403)
            self.assertEqual(handler.server.mock_calls, [])

    def test_rich_readings_relay_the_complete_fixed_snapshot_after_peer_check(self):
        self.start(json.dumps(READINGS).encode())
        with mock.patch.object(SERVICE, 'trusted_capture_peer', return_value=True) as peer:
            self.assertEqual(SERVICE.sentinel_system_readings(self.path), READINGS)
        peer.assert_called_once()
        self.assertEqual(self.requests, [b'GET /sentinel/api/v1/system-readings HTTP/1.1\r\n'
                                         b'Host: localhost\r\nConnection: close\r\n\r\n'])
        with mock.patch.object(SERVICE, 'trusted_capture_peer', return_value=False):
            self.assertEqual(SERVICE.sentinel_system_readings(self.path), READINGS_UNAVAILABLE)
        self.assertEqual(len([request for request in self.requests if request]), 1)

    def test_rich_readings_reject_framing_and_partial_reply_and_report_old_component_unavailable(self):
        body = json.dumps(READINGS).encode()
        invalid = [
            {'wire': b'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'},
            {'wire': b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n' + body},
            {'body': json.dumps({**READINGS, 'sample': {**READINGS['sample'], 'cpu': {
                **READINGS['sample']['cpu'], 'reportedClockGHz': None,
            }}}).encode()},
            {'body': json.dumps({**READINGS, 'state': 'stale'}).encode()},
            {'body': b'{"state":"ready","state":"unavailable"}'},
            {'body': b'x' * (16 * 1024 + 1)},
            {'body': body, 'swap': True},
        ]
        with mock.patch.object(SERVICE, 'trusted_capture_peer', return_value=True):
            for index, options in enumerate(invalid):
                with self.subTest(index=index):
                    self.path = self.root / ('r' + str(index))
                    self.start(**options)
                    self.assertEqual(SERVICE.sentinel_system_readings(self.path), READINGS_UNAVAILABLE)
            self.path = self.root / 'stall'
            self.start(body, stall=True)
            started = time.monotonic()
            self.assertEqual(SERVICE.sentinel_system_readings(self.path), READINGS_UNAVAILABLE)
            self.assertLess(time.monotonic() - started, 1)

    def test_rich_readings_host_route_is_exact_bodyless_and_peer_gated(self):
        for suffix, length, allowed, expected in [('', None, True, 200), ('', None, False, 403),
                                                    ('', '1', True, 400), ('?source=other', None, True, 404)]:
            handler = object.__new__(SERVICE.Handler)
            handler.path = '/v1/sentinel/system-readings' + suffix
            handler.connection = mock.Mock()
            handler.server = mock.Mock()
            handler.headers = Message()
            if length is not None:
                handler.headers.add_header('Content-Length', length)
            handler.send_json = mock.Mock()
            with mock.patch.object(SERVICE, 'trusted_capture_peer', return_value=allowed), \
                    mock.patch.object(SERVICE, 'sentinel_system_readings', return_value=READINGS) as reader:
                handler.do_GET()
            self.assertEqual(handler.send_json.call_args.args[0], expected)
            self.assertEqual(reader.call_count, int(expected == 200))
            self.assertEqual(handler.server.mock_calls, [])


if __name__ == '__main__':
    unittest.main()
