import json
import os
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from test_orbis_host_service import SERVICE


class SentinelRecoveryAccessTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.profile = self.directory / 'config.json'
        reader = SERVICE.load_script('orbis-host-credential-service.py', 'orbis_recovery_access_fixture')
        # Exercise the production file checks under the local fixture owner.
        reader.OWNER = os.getuid()
        self.enterContext(mock.patch.object(SERVICE, 'load_script', return_value=reader))
        self.enterContext(mock.patch.object(SERVICE, '_RECOVERY_PROFILE', self.profile))
        self.unit = self.enterContext(mock.patch.object(SERVICE, '_recovery_unit_state', return_value='active'))
        self.config = {
            'schema': 'orbis.sentinel-recovery-config.v1',
            'origin': 'https://recovery.example:8443',
            'directory': str(self.directory),
            'imageId': 'sha256:' + 'a' * 64,
            'listenPort': 8443,
            'statusSocket': '/run/orbis-sentinel/api.sock',
        }

    def write_profile(self, **changes):
        self.profile.write_text(json.dumps({**self.config, **changes}))
        self.profile.chmod(0o600)

    def assert_unavailable(self):
        self.assertEqual(SERVICE.sentinel_recovery_access(),
                         {'version': 1, 'state': 'unavailable', 'portalUrl': None, 'unitState': None})

    def test_reports_only_configured_url_and_observed_unit_state(self):
        self.assertEqual(SERVICE.sentinel_recovery_access(),
                         {'version': 1, 'state': 'missing', 'portalUrl': None, 'unitState': None})
        self.unit.assert_not_called()
        self.write_profile()
        for state in ('active', 'inactive', 'unknown'):
            self.unit.return_value = state
            self.assertEqual(SERVICE.sentinel_recovery_access(),
                             {'version': 1, 'state': 'configured', 'unitState': state,
                              'portalUrl': 'https://recovery.example:8443/sentinel/recovery/'})
        self.unit.side_effect = OSError()
        self.assertEqual(SERVICE.sentinel_recovery_access()['unitState'], 'unknown')

    def test_enrollment_uses_only_fixed_root_observation_and_same_origin(self):
        self.write_profile()
        schema = 'orbis.sentinel-root-bootstrap-control.v1'
        response = {'schema': schema, 'ok': True,
                    'result': {'origin': self.config['origin'], 'stage': 'key-prepared'}}
        real_lstat = Path.lstat
        endpoint = self.directory / 'bootstrap-control.sock'
        fields = {'st_dev': 3, 'st_ino': 4, 'st_uid': 0, 'st_gid': 0, 'st_mode': stat.S_IFSOCK | 0o600,
                  'st_nlink': 1, 'st_size': 0, 'st_mtime_ns': 1, 'st_ctime_ns': 1}
        peer = mock.MagicMock()
        peer.__enter__.return_value = peer
        with mock.patch.object(Path, 'lstat', lambda path: SimpleNamespace(**fields) if path == endpoint else real_lstat(path)), \
                mock.patch.object(SERVICE.socket, 'socket', return_value=peer), \
                mock.patch.object(SERVICE, 'trusted_capture_peer', return_value=True) as trust:
            def reply(value):
                body = json.dumps(value).encode()
                peer.recv.side_effect = [struct.pack('!I', len(body)), body, b'']
            reply(response)
            self.assertEqual(SERVICE.sentinel_recovery_access()['enrollment'], 'key-prepared')
            sent, = peer.sendall.call_args.args
            self.assertEqual(json.loads(sent[4:]), {'schema': schema, 'operation': 'bootstrap-enrollment-state', 'arguments': {}})
            self.assertEqual(peer.connect.call_args.args, (str(endpoint),))
            for result in ({'origin': 'https://wrong.example', 'stage': 'activated'},
                           {**response['result'], 'key': 'not-a-public-field'}):
                reply({**response, 'result': result})
                self.assertNotIn('enrollment', SERVICE.sentinel_recovery_access())
            reply(response)
            peer.shutdown.side_effect = lambda *_: fields.update(st_ino=7)
            self.assertNotIn('enrollment', SERVICE.sentinel_recovery_access())
            peer.shutdown.side_effect = None
            trust.return_value = False
            peer.sendall.reset_mock()
            self.assertNotIn('enrollment', SERVICE.sentinel_recovery_access())
            peer.sendall.assert_not_called()

    def test_handoff_relays_only_fixed_key_operations_and_sanitizes_reply(self):
        self.write_profile()
        root_origin = self.config['origin']
        binding = {name: 'b' * 64 for name in ('operationId', 'reviewSha256', 'planSha256', 'keyRevision', 'deliveryEpoch')}
        binding['handoff'] = 'A' * 43
        fake_key = 'orbis-recovery-' + 'B' * 42 + 'A'
        save = '/v1/sentinel/enrollment/save-key'
        confirm = '/v1/sentinel/enrollment/confirm-key'
        with mock.patch.object(SERVICE, '_recovery_bootstrap_request') as bridge:
            bridge.return_value = {'origin': root_origin, 'recoveryKey': fake_key}
            self.assertEqual(SERVICE.sentinel_browser_key(save, json.dumps(binding).encode()), {'recoveryKey': fake_key})
            self.assertEqual(bridge.call_args.args[-2:], ('bootstrap-browser-deliver', binding))
            proof = {**binding, 'recoveryKey': fake_key}
            bridge.return_value = {'origin': root_origin, 'state': 'acknowledged'}
            self.assertEqual(SERVICE.sentinel_browser_key(confirm, json.dumps(proof).encode()), {'state': 'acknowledged'})
            self.assertEqual(bridge.call_args.args[-2:], ('bootstrap-browser-confirm', proof))
            bridge.reset_mock()
            with self.assertRaises(ValueError):
                SERVICE.sentinel_browser_key(save, json.dumps({**binding, 'operation': 'bootstrap-browser-authorize'}).encode())
            with self.assertRaises(ValueError):
                SERVICE.sentinel_browser_key(confirm, json.dumps(binding).encode())
            bridge.assert_not_called()

    def test_refuses_browser_ambiguous_origins_and_noncanonical_paths(self):
        for origin in ('http://recovery.example', 'https://one.example\\@two.example',
                       'https://one.example@two.example', 'https://one.example/%2e',
                       'https://one.example?', 'https://one.example#', 'https://one.example\r',
                       'https://one.example:0', 'https://one.example:65536', 'https://127.1',
                       'https://[::1]elsewhere.example'):
            with self.subTest(origin=origin):
                self.write_profile(origin=origin)
                self.assert_unavailable()
        for location in ('relative', '/var/../run', '/var//state', '//var/state'):
            with self.subTest(location=location):
                self.write_profile(statusSocket=location)
                self.assert_unavailable()
        self.profile.write_text(json.dumps(self.config).replace('{', '{"origin":"https://elsewhere.example",', 1))
        self.assert_unavailable()
        self.unit.assert_not_called()

    def test_rejects_symlinks_hardlinks_and_unprotected_permissions(self):
        self.write_profile()
        other = self.directory / 'other.json'
        os.link(self.profile, other)
        self.assert_unavailable()
        self.profile.unlink()
        self.profile.symlink_to(other)
        self.assert_unavailable()
        self.profile.unlink()
        self.write_profile()
        self.profile.chmod(0o640)
        self.assert_unavailable()
        self.write_profile()
        try:
            self.directory.chmod(0o770)
            self.assert_unavailable()
            self.profile.unlink()
            self.assert_unavailable()
        finally:
            self.directory.chmod(0o700)
        self.unit.assert_not_called()

    def test_discards_profile_replaced_during_the_unit_observation(self):
        self.write_profile()

        def replace():
            self.profile.rename(self.directory / 'previous.json')
            self.write_profile(origin='https://replacement.example')
            return 'active'

        self.unit.side_effect = replace
        self.assert_unavailable()

    def test_route_checks_peer_and_body_before_reading_the_profile(self):
        self.write_profile()
        for peer, headers, status in [
            ((1, 1000, 1000), [], 403),
            ((0, 0, 0), [], 403),
            ((1, 0, 0), [('Content-Length', '1')], 400),
            ((1, 0, 0), [('Content-Length', '0'), ('Content-Length', '0')], 400),
            ((1, 0, 0), [('Transfer-Encoding', 'chunked')], 400),
            ((1, 0, 0), [('Content-Encoding', 'gzip')], 400),
            ((1, 0, 0), [], 200),
        ]:
            with self.subTest(peer=peer, headers=headers):
                handler = object.__new__(SERVICE.Handler)
                handler.server = SimpleNamespace(service=SimpleNamespace(credentials_only=False))
                handler.path = '/v1/sentinel/recovery-access'
                handler.headers = Message()
                handler.connection = mock.Mock()
                handler.connection.getsockopt.return_value = struct.pack('3i', *peer)
                handler.send_json = mock.Mock()
                for name, value in headers:
                    handler.headers[name] = value
                with mock.patch.object(SERVICE.socket, 'SO_PEERCRED', 17, create=True), \
                        mock.patch.object(SERVICE.os, 'geteuid', return_value=0):
                    handler.do_GET()
                handler.connection.getsockopt.assert_called_once_with(socket.SOL_SOCKET, 17, struct.calcsize('3i'))
                self.assertTrue(handler.close_connection)
                self.assertEqual(handler.send_json.call_args.args[0], status)
                if status != 200:
                    self.unit.assert_not_called()
        self.unit.assert_called_once_with()

    def test_host_route_does_not_accept_selected_paths_or_mutations(self):
        for method, suffix in [('GET', '?profile=/elsewhere'), ('POST', '')]:
            handler = object.__new__(SERVICE.Handler)
            handler.server = SimpleNamespace(service=SimpleNamespace(credentials_only=False))
            handler.path = '/v1/sentinel/recovery-access' + suffix
            handler.headers = Message()
            handler.send_json = mock.Mock()
            getattr(handler, 'do_' + method)()
            self.assertEqual(handler.send_json.call_args.args[0], 404)
        self.unit.assert_not_called()


class SentinelRecoveryUnitTests(unittest.TestCase):
    def test_observes_fixed_unit_with_bounded_child_output_and_time(self):
        popen = subprocess.Popen
        cases = [
            ("print('active')", 'active'),
            ("print('failed')", 'inactive'),
            ("print('activating')", 'unknown'),
            ("print('active'); raise SystemExit(1)", 'unknown'),
            ("print('x' * 65536)", 'unknown'),
            ("import time; time.sleep(10)", 'unknown'),
        ]
        for program, state in cases:
            with self.subTest(program=program):
                def fixture(arguments, **kwargs):
                    self.assertEqual(arguments, [
                        '/usr/bin/systemctl', '--no-pager', 'show', '--property=ActiveState', '--value',
                        'orbis-sentinel-recovery.service',
                    ])
                    return popen([sys.executable, '-I', '-c', program], **kwargs)

                started = time.monotonic()
                with mock.patch.object(SERVICE.subprocess, 'Popen', side_effect=fixture):
                    self.assertEqual(SERVICE._recovery_unit_state(), state)
                self.assertLess(time.monotonic() - started, 2)
