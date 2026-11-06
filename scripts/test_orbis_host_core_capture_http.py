"""Actual private Unix HTTP framing; root reader authorization is tested separately."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
from contextlib import contextmanager
from types import SimpleNamespace
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location('core_transfer_http', Path(__file__).with_name('orbis-host-service.py'))
S = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(S)
POINT = '12345678-1234-4234-8234-123456789abc'


class CaptureHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ch-')
        self.addCleanup(self.temp.cleanup)
        self.socket = Path(self.temp.name).resolve() / 's'
        self.data = b'fixed-checkpoint-bytes' * 10_000
        self.opened, self.read_sizes = 0, []
        self.failure = None
        self.provider = SimpleNamespace(status=mock.Mock(return_value={'version': 1, 'id': POINT, 'state': 'reserved'}),
                                        open_checkpoint=self.open_checkpoint)
        self.server = S.UnixHTTPServer(str(self.socket), S.Handler)
        self.server.service = SimpleNamespace(lock=threading.Lock(), _core_capture_reader=self.provider,
                                              state_dir=Path(self.temp.name).resolve() / 'state')
        self.completion = SimpleNamespace(status=mock.Mock(return_value={'version': 1, 'id': POINT,
            'state': 'verified-awaiting-continuation'}), finish=mock.Mock(return_value={'version': 1, 'id': POINT, 'state': 'complete'}))
        self.server.service._core_capture_completion = self.completion
        self.admission = SimpleNamespace(
            prepare_bound=mock.Mock(return_value={'version': 2, 'id': POINT, 'preparationSha256': 'a' * 64}),
            prepare_reserved=mock.Mock(return_value={'version': 3, 'id': POINT, 'preparationSha256': 'a' * 64}),
            abort_reserved=mock.Mock(return_value={'version': 1, 'id': POINT, 'state': 'abort-intent'}),
            observe_reserved=mock.Mock(return_value={'version': 3, 'id': POINT, 'preparationSha256': 'a' * 64}),
            reconcile_reserved=mock.Mock(return_value={'version': 3, 'id': POINT, 'preparationSha256': 'a' * 64}),
            admit=mock.Mock(return_value={'version': 1, 'id': POINT, 'state': 'reserved', 'sourceHoldSha256': 'b' * 64}))
        self.server.service._core_capture_admission = (object(), self.admission)
        os.chmod(self.socket, 0o600)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        if not hasattr(socket, 'SO_PEERCRED') or os.geteuid() != 0:
            self.enterContext(mock.patch.object(S, 'trusted_capture_peer', return_value=True))

    @contextmanager
    def open_checkpoint(self, point, request):
        self.assertEqual(point, POINT)
        self.opened += 1
        if self.failure == 'before':
            raise ValueError('PRIVATE_FIXTURE_MUST_NOT_LEAK')
        offset = 0
        def read(size):
            nonlocal offset
            self.read_sizes.append(size)
            if self.failure == 'during' and offset:
                raise ValueError('PRIVATE_FIXTURE_MUST_NOT_LEAK')
            block = self.data[offset:offset + size]
            offset += len(block)
            return block
        yield SimpleNamespace(bytes=len(self.data), read=read)

    def request(self, suffix='status', body=None, headers=None, method='POST'):
        data = json.dumps(body if body is not None else {'sourceSha256': 'a' * 64, 'sourceHoldSha256': 'b' * 64}).encode()
        request_headers = {'Host': 'localhost', 'Content-Type': 'application/json', 'Content-Length': str(len(data)), **(headers or {})}
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(5)
        try:
            client.connect(str(self.socket))
            target = ('/v1/core-captures/' + suffix if suffix in {'sentinel-publication-capability', 'sentinel-start-capability',
                                                              'reserved-start-capability', 'refused-abort-capability'}
                      else '/v1/core-captures/' + POINT + '/' + suffix)
            client.sendall((f'{method} {target} HTTP/1.0\r\n' + ''.join(f'{key}: {value}\r\n' for key, value in request_headers.items()) + '\r\n').encode() + data)
            parts = []
            while block := client.recv(65536):
                parts.append(block)
        finally:
            client.close()
        head, payload = b''.join(parts).split(b'\r\n\r\n', 1)
        lines = head.decode().split('\r\n')
        response_headers = {key.lower(): value.strip() for key, value in (line.split(':', 1) for line in lines[1:])}
        return int(lines[0].split()[1]), response_headers, payload

    def test_status_and_bounded_binary_headers_are_no_store(self):
        status, headers, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(headers['cache-control'], 'no-store')
        self.assertEqual(headers['content-length'], str(len(body)))
        self.assertEqual(json.loads(body)['id'], POINT)
        status, headers, body = self.request('checkpoint')
        self.assertEqual(status, 200)
        self.assertEqual(headers['content-type'], 'application/octet-stream')
        self.assertEqual(headers['content-length'], str(len(self.data)))
        self.assertEqual(headers['cache-control'], 'no-store')
        self.assertEqual(body, self.data)
        self.assertTrue(all(size == 65536 for size in self.read_sizes))

    def test_sentinel_routes_use_the_separate_publication_reader(self):
        provider = SimpleNamespace(status=mock.Mock(return_value={'version': 1, 'id': POINT, 'state': 'verified'}),
                                   open_file=self.open_checkpoint)
        with mock.patch.object(S, 'core_capture_sentinel_reader', return_value=(object(), provider)):
            status, headers, body = self.request('sentinel-publication')
            self.assertEqual(status, 200)
            self.assertEqual(headers['cache-control'], 'no-store')
            self.assertEqual(json.loads(body)['state'], 'verified')
            status, headers, body = self.request('sentinel-file')
            self.assertEqual(status, 200)
            self.assertEqual(headers['content-type'], 'application/octet-stream')
            self.assertEqual(int(headers['content-length']), len(self.data))
            self.assertEqual(body, self.data)
        self.provider.status.assert_not_called()

    def test_sentinel_capability_is_optional_and_root_only(self):
        status, headers, body = self.request('sentinel-publication-capability', method='GET')
        self.assertEqual(status, 200)
        self.assertEqual(headers['cache-control'], 'no-store')
        self.assertEqual(json.loads(body)['operations'], ['sentinel-publication', 'sentinel-file'])
        with mock.patch.object(S, 'trusted_capture_peer', return_value=False):
            self.assertEqual(self.request('sentinel-publication-capability', method='GET')[0], 403)
            self.assertEqual(self.request('sentinel-publication')[0], 403)
            self.assertEqual(self.request('sentinel-file')[0], 403)

    def test_automatic_start_is_opt_in_and_keeps_the_old_prepare_contract(self):
        with mock.patch.object(S, 'sentinel_start_available', return_value=False):
            status, _, body = self.request('sentinel-start-capability', method='GET')
            self.assertEqual(status, 200)
            self.assertIs(json.loads(body)['available'], False)
            self.assertEqual(self.request('prepare-sentinel', body={})[0], 409)
            self.admission.prepare_bound.assert_not_called()
            self.assertEqual(self.request('prepare', body={})[0], 200)
            self.admission.prepare_bound.assert_called_once_with(POINT)
        self.admission.prepare_bound.reset_mock()
        with mock.patch.object(S, 'sentinel_start_available', return_value=True):
            self.assertEqual(self.request('prepare-sentinel', body={})[0], 200)
            self.admission.prepare_bound.assert_called_once_with(POINT, publication='sentinel.v1')

    def test_reserved_start_keeps_legacy_preparation_and_selects_only_explicit_publisher(self):
        with mock.patch.object(S, 'core_capture_admission', side_effect=AssertionError('must not load')):
            code, headers, body = self.request('reserved-start-capability', method='GET')
            self.assertEqual(code, 200)
            self.assertEqual(headers['cache-control'], 'no-store')
            self.assertEqual(json.loads(body), S.CORE_CAPTURE_RESERVED_START_CAPABILITY)
            self.assertEqual(S.CORE_CAPTURE_START_CAPABILITY['preparationVersion'], 2)
        self.assertEqual(self.request('prepare-reserved', body={})[0], 200)
        self.admission.prepare_reserved.assert_called_once_with(POINT)
        self.admission.prepare_reserved.reset_mock()
        with mock.patch.object(S, 'sentinel_start_available', return_value=False):
            self.assertEqual(self.request('prepare-reserved-sentinel', body={})[0], 409)
            self.admission.prepare_reserved.assert_not_called()
        with mock.patch.object(S, 'sentinel_start_available', return_value=True):
            self.assertEqual(self.request('prepare-reserved-sentinel', body={})[0], 200)
            self.admission.prepare_reserved.assert_called_once_with(POINT, publication='sentinel.v1')
        self.admission.prepare_bound.assert_not_called()

    def test_fixed_abort_routes_dispatch_only_the_selected_component(self):
        intent = {'preparationSha256': 'a' * 64}
        request = {**intent, 'decisionSha256': 'b' * 64, 'terminalSha256': 'c' * 64}
        finish = {**request, 'approvalSha256': 'd' * 64, 'continuationSha256': 'e' * 64}
        handler = SimpleNamespace(**{name: mock.Mock(return_value={'state': name})
                                   for name in ('intent_status', 'prepare', 'status', 'finish', 'settle')})
        self.assertEqual(self.request('abort-intent', intent)[0], 200)
        self.admission.abort_reserved.assert_called_once_with(POINT, intent)
        routes = [('abort-intent/status', 'complete', 'intent_status', intent)]
        routes += [(f'abort-{middle}{method}', kind, method, finish if method == 'finish' else request)
                   for middle, kind, methods in [('', 'complete', ('prepare', 'status', 'finish')),
                       ('empty-', 'empty', ('prepare', 'status', 'finish')),
                       ('unused-', 'unused', ('settle', 'status')), ('setup-', 'setup', ('settle', 'status')),
                       ('refused-', 'refused', ('settle', 'status'))] for method in methods]
        with mock.patch.object(S, 'core_capture_abort', return_value=handler) as selected:
            for route, kind, method, body in routes:
                with self.subTest(route=route):
                    selected.reset_mock()
                    getattr(handler, method).reset_mock()
                    code, headers, reply = self.request(route, body)
                    self.assertEqual(code, 200)
                    self.assertEqual(headers['cache-control'], 'no-store')
                    self.assertEqual(json.loads(reply), {'state': method})
                    selected.assert_called_once_with(self.server.service, kind)
                    getattr(handler, method).assert_called_once_with(POINT, body)

    def test_reserved_and_abort_routes_reject_untrusted_or_nonfixed_input_before_loading_state(self):
        with mock.patch.object(S, 'core_capture_abort', side_effect=AssertionError('must not load')), \
             mock.patch.object(S, 'core_capture_admission', side_effect=AssertionError('must not load')):
            for route in ('prepare-reserved', 'prepare-reserved-sentinel', 'abort-intent', 'abort-intent/status',
                          'abort-prepare', 'abort-status', 'abort-finish', 'abort-empty-prepare',
                          'abort-unused-settle', 'abort-setup-status', 'abort-refused-settle'):
                for body in ([], {'path': '/outside'}, {'preparationSha256': True}):
                    with self.subTest(route=route, body=body):
                        self.assertEqual(self.request(route, body)[0], 409)
                with mock.patch.object(S, 'trusted_capture_peer', return_value=False):
                    self.assertEqual(self.request(route, {})[0], 403)
            with mock.patch.object(S, 'trusted_capture_peer', return_value=False):
                for name in ('reserved-start-capability', 'refused-abort-capability'):
                    self.assertEqual(self.request(name, method='GET')[0], 403)

    def test_refused_capability_is_the_existing_positive_evidence_contract(self):
        code, headers, body = self.request('refused-abort-capability', method='GET')
        self.assertEqual(code, 200)
        self.assertEqual(headers['cache-control'], 'no-store')
        self.assertEqual(json.loads(body), {'schema': 'orbis.core-capture-refused-abort-capability.v1',
            'version': 1, 'preparationVersion': 3, 'terminalVersion': 5, 'localLease': 'not-acquired',
            'operations': ['abort-refused-settle', 'abort-refused-status'], 'admissionReplay': 'forbidden'})

    def test_real_reserved_prepare_and_abort_intent_preserve_the_original_lease(self):
        import test_orbis_host_core_capture_reserved as fixtures
        case = fixtures.ReservedCaptureTests('test_prepare_returns_only_after_real_durable_lease_and_exact_pins')
        case.setUp()
        self.addCleanup(case.doCleanups)
        self.server.service._core_capture_admission = (fixtures.S, case.manager)
        def request(route, body):
            data = json.dumps(body).encode()
            return self.raw_request((f'POST /v1/core-captures/{case.point}/{route} HTTP/1.0\r\n'
                f'Content-Type: application/json\r\nContent-Length: {len(data)}\r\n\r\n').encode() + data)
        code, _, body = request('prepare-reserved', {})
        self.assertEqual(code, 200)
        prepared = json.loads(body)
        self.assertEqual(prepared['version'], 3)
        original = fixtures.S.A.seal(case.fence().stat())
        code, _, body = request('abort-intent', {'preparationSha256': prepared['preparationSha256']})
        self.assertEqual(code, 200)
        intent = json.loads(body)
        code, _, body = request('abort-intent/status', {'preparationSha256': prepared['preparationSha256']})
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body), intent)
        self.assertEqual(S.core_capture_abort(self.server.service, 'complete'),
                         S.core_capture_abort(self.server.service, 'complete'))
        self.assertEqual(request('admit', {'preparationSha256': prepared['preparationSha256'], 'sourceHoldSha256': 'f' * 64})[0], 409)
        self.assertEqual(fixtures.S.A.seal(case.fence().stat()), original)
        case.marker_read.assert_not_called()
        case.launch.assert_not_called()
        case.assert_held()

    def test_real_unused_abort_settlement_round_trip_uses_positive_source_evidence(self):
        import test_orbis_host_core_capture_unused_abort as fixtures
        case = fixtures.UnusedAbortTests('test_success_preserves_only_original_retired_lease')
        case.setUp()
        self.addCleanup(case.doCleanups)
        self.server.service._core_capture_abort = {'unused': case.subject}
        def request(route):
            data = json.dumps(case.request).encode()
            return self.raw_request((f'POST /v1/core-captures/{case.point}/{route} HTTP/1.0\r\n'
                f'Content-Type: application/json\r\nContent-Length: {len(data)}\r\n\r\n').encode() + data)
        code, _, body = request('abort-unused-settle')
        self.assertEqual(code, 200)
        settled = json.loads(body)
        self.assertEqual(settled['state'], 'complete')
        code, _, body = request('abort-unused-status')
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body), settled)
        self.assertFalse(case.fence().exists())
        self.assertFalse(case.marker_file.exists())
        self.assertEqual(case.fixture.docker.calls, [])

    def test_sentinel_stream_errors_never_become_successful_full_length(self):
        provider = SimpleNamespace(open_file=self.open_checkpoint)
        self.failure = 'during'
        with mock.patch.object(S, 'core_capture_sentinel_reader', return_value=(object(), provider)):
            status, headers, body = self.request('sentinel-file')
        self.assertEqual(status, 200)
        self.assertLess(len(body), int(headers['content-length']))
        self.assertNotIn(b'PRIVATE_FIXTURE', body)

    def test_lazy_reader_is_cached_without_creating_capture_state(self):
        state = Path(self.temp.name).resolve() / 'state'
        state.mkdir(mode=0o700)
        service = SimpleNamespace(lock=threading.Lock(), state_dir=state)
        reader = S.core_capture_reader(service)
        with mock.patch.object(service, 'lock', mock.MagicMock()) as operation_lock:
            operation_lock.__enter__.side_effect = AssertionError('A cached status read must not wait for publication')
            self.assertIs(S.core_capture_reader(service), reader)
        self.assertEqual(list(state.iterdir()), [])

    def test_untrusted_peer_is_denied_before_reader_or_body(self):
        with mock.patch.object(S, 'trusted_capture_peer', return_value=False):
            self.assertEqual(self.request()[0], 403)
        self.provider.status.assert_not_called()
        self.assertEqual(self.opened, 0)
        with mock.patch.object(S, 'trusted_capture_peer', return_value=False):
            self.assertEqual(self.request('completion')[0], 403)
            self.assertEqual(self.request('continuation')[0], 403)
        self.completion.status.assert_not_called()
        self.completion.finish.assert_not_called()

    def test_completion_and_continuation_use_only_the_root_peer_component(self):
        for route, method, expected in (('completion', self.completion.status, 'verified-awaiting-continuation'),
                                        ('continuation', self.completion.finish, 'complete')):
            with self.subTest(route=route):
                status, headers, body = self.request(route)
                self.assertEqual(status, 200)
                self.assertEqual(headers['cache-control'], 'no-store')
                self.assertEqual(headers['content-type'], 'application/json')
                self.assertEqual(json.loads(body)['state'], expected)
                method.assert_called_once_with(POINT, {'sourceSha256': 'a' * 64, 'sourceHoldSha256': 'b' * 64})
        self.provider.status.assert_not_called()
        self.assertEqual(self.opened, 0)

    def test_completion_errors_remain_generic_and_do_not_fall_back_to_binary(self):
        self.completion.finish.side_effect = ValueError('PRIVATE_FIXTURE_MUST_NOT_LEAK')
        status, _, body = self.request('continuation')
        self.assertEqual(status, 409)
        self.assertNotIn(b'PRIVATE_FIXTURE', body)
        self.assertEqual(self.opened, 0)

    def test_fixed_routes_and_bounded_json_inputs_only(self):
        for suffix in ('status?path=/etc/shadow', '../checkpoint', 'prepare?x=1', 'admit/extra'):
            with self.subTest(suffix=suffix):
                self.assertEqual(self.request(suffix)[0], 409)
        for headers in ({'Content-Type': 'text/plain'}, {'Content-Length': '1025'}, {'Transfer-Encoding': 'chunked'}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request(headers=headers)[0], 409)
        self.assertEqual(self.request(method='GET')[0], 404)
        self.provider.status.assert_not_called()
        self.assertEqual(self.opened, 0)

    def raw_request(self, raw):
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(5)
        try:
            client.connect(str(self.socket))
            client.sendall(raw)
            parts = []
            while block := client.recv(65536):
                parts.append(block)
        finally:
            client.close()
        head, body = b''.join(parts).split(b'\r\n\r\n', 1)
        return int(head.split(b' ')[1]), head, body

    def test_capability_is_exact_no_store_and_never_loads_manager(self):
        with mock.patch.object(S, 'core_capture_admission', side_effect=AssertionError('must not load')):
            code, head, body = self.raw_request(b'GET /v1/core-captures/capabilities HTTP/1.0\r\nHost: localhost\r\n\r\n')
            self.assertEqual(code, 200)
            self.assertIn(b'Cache-Control: no-store', head)
            self.assertEqual(json.loads(body), {'schema': 'orbis.core-capture-start-capability.v1', 'version': 1,
                'preparationVersion': 2, 'pointVersion': 3, 'sourceHoldVersion': 2, 'scope': 'controller-live-proxy.v1',
                'operations': ['prepare', 'admit'], 'admissionReplay': 'forbidden', 'publication': 'controller-restart.v1'})
            with mock.patch.object(S, 'trusted_capture_peer', return_value=False):
                self.assertEqual(self.raw_request(b'GET /v1/core-captures/capabilities HTTP/1.0\r\n\r\n')[0], 403)

    def test_prepare_and_admit_forward_exact_requests(self):
        status, headers, body = self.request('prepare', {})
        self.assertEqual(status, 200)
        self.assertEqual(headers['cache-control'], 'no-store')
        self.assertEqual(json.loads(body), self.admission.prepare_bound.return_value)
        self.admission.prepare_bound.assert_called_once_with(POINT)
        request = {'preparationSha256': 'a' * 64, 'sourceHoldSha256': 'b' * 64}
        status, _, body = self.request('admit', request)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), self.admission.admit.return_value)
        self.admission.admit.assert_called_once_with(POINT, request)

    def test_preparation_observation_is_no_store_and_never_prepares_or_admits(self):
        request = {'pointReservationSha256': 'c' * 64}
        code, headers, body = self.request('preparation', request)
        self.assertEqual(code, 200)
        self.assertEqual(headers['cache-control'], 'no-store')
        self.assertEqual(json.loads(body), self.admission.observe_reserved.return_value)
        self.admission.observe_reserved.assert_called_once_with(POINT, request)
        self.admission.prepare_bound.assert_not_called()
        self.admission.admit.assert_not_called()

    def test_bad_observation_requests_or_untrusted_peer_never_load_manager(self):
        with mock.patch.object(S, 'core_capture_admission', side_effect=AssertionError('must not load')):
            for value in ({}, [], {'pointReservationSha256': 'C' * 64},
                          {'pointReservationSha256': 'c' * 64, 'retry': True}):
                with self.subTest(value=value):
                    self.assertEqual(self.request('preparation', value)[0], 409)
            with mock.patch.object(S, 'trusted_capture_peer', return_value=False):
                self.assertEqual(self.request('preparation', {'pointReservationSha256': 'c' * 64})[0], 403)
        self.admission.observe_reserved.assert_not_called()

    def test_explicit_preparation_reconciliation_is_separate_from_observation_and_start(self):
        request = {'pointReservationSha256': 'c' * 64}
        code, headers, body = self.request('reconcile-preparation', request)
        self.assertEqual(code, 200)
        self.assertEqual(headers['cache-control'], 'no-store')
        self.assertEqual(json.loads(body), self.admission.reconcile_reserved.return_value)
        self.admission.reconcile_reserved.assert_called_once_with(POINT, request)
        self.admission.observe_reserved.assert_not_called()
        self.admission.prepare_bound.assert_not_called()
        self.admission.admit.assert_not_called()

    def test_bad_reconciliation_or_untrusted_peer_never_load_manager(self):
        with mock.patch.object(S, 'core_capture_admission', side_effect=AssertionError('must not load')):
            for value in ({}, [], {'pointReservationSha256': 'C' * 64},
                          {'pointReservationSha256': 'c' * 64, 'retry': True}):
                with self.subTest(value=value):
                    self.assertEqual(self.request('reconcile-preparation', value)[0], 409)
            with mock.patch.object(S, 'trusted_capture_peer', return_value=False):
                self.assertEqual(self.request('reconcile-preparation', {'pointReservationSha256': 'c' * 64})[0], 403)
        self.admission.reconcile_reserved.assert_not_called()

    def test_recovery_capability_does_not_change_legacy_start_capability_or_load_state(self):
        with mock.patch.object(S, 'core_capture_admission', side_effect=AssertionError('must not load')):
            code, head, body = self.raw_request(b'GET /v1/core-captures/preparation-recovery-capability HTTP/1.0\r\n\r\n')
            self.assertEqual(code, 200)
            self.assertIn(b'Cache-Control: no-store', head)
            self.assertEqual(json.loads(body), {'schema': 'orbis.core-capture-preparation-recovery-capability.v1',
                'version': 1, 'preparationVersion': 3, 'intentVersion': 1,
                'operations': ['reconcile-preparation', 'preparation'], 'createsReservation': False,
                'releasesCapture': False, 'admissionReplay': 'forbidden'})
            self.assertEqual(S.CORE_CAPTURE_START_CAPABILITY['preparationVersion'], 2)
            with mock.patch.object(S, 'trusted_capture_peer', return_value=False):
                self.assertEqual(self.raw_request(b'GET /v1/core-captures/preparation-recovery-capability HTTP/1.0\r\n\r\n')[0], 403)

    def test_preparation_reconciliation_errors_remain_generic(self):
        self.admission.reconcile_reserved.side_effect = ValueError('PRIVATE_FIXTURE_MUST_NOT_LEAK')
        code, _, body = self.request('reconcile-preparation', {'pointReservationSha256': 'c' * 64})
        self.assertEqual(code, 409)
        self.assertNotIn(b'PRIVATE_FIXTURE', body)
        self.admission.prepare_bound.assert_not_called()
        self.admission.admit.assert_not_called()

    def test_real_partial_preparation_recovers_through_private_http_and_lost_reply_is_observable(self):
        spec = importlib.util.spec_from_file_location('joined_preparation_http_fixtures',
                    Path(__file__).with_name('test_orbis_host_core_capture_reserved.py'))
        fixtures = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixtures)
        case = fixtures.ReservedCaptureTests('test_prepare_returns_only_after_real_durable_lease_and_exact_pins')
        case.setUp()
        self.addCleanup(case.doCleanups)
        with mock.patch.object(case.manager, 'finish_reserved_preparation', side_effect=OSError('interrupted after intent')):
            with self.assertRaises(OSError):
                case.manager.prepare_reserved(case.point)
        stage = case.fence().with_name(fixtures.S.W.LEASE.CoreCaptureLease.staging_name(case.point))
        before = stage.stat()
        self.server.service._core_capture_admission = (object(), case.manager)
        data = json.dumps(case.observation_request()).encode()
        def request(route):
            return self.raw_request((f'POST /v1/core-captures/{case.point}/{route} HTTP/1.0\r\n'
                f'Content-Type: application/json\r\nContent-Length: {len(data)}\r\n\r\n').encode() + data)
        with mock.patch.object(S.Handler, 'send_json', side_effect=BrokenPipeError('lost reply')):
            with self.assertRaises(ValueError):
                request('reconcile-preparation')
        authority = case.authority()
        expected = case.manager.public_preparation(authority.preparation)
        lease = fixtures.S.A.seal(case.fence().stat())
        with mock.patch.object(fixtures.S, 'create', side_effect=AssertionError('observation mutated authority')):
            code, head, body = request('preparation')
        self.assertEqual(code, 200)
        self.assertIn(b'Cache-Control: no-store', head)
        self.assertEqual(json.loads(body), expected)
        self.assertEqual((case.fence().stat().st_dev, case.fence().stat().st_ino), (before.st_dev, before.st_ino))
        self.assertEqual(fixtures.S.A.seal(case.fence().stat()), lease)
        case.launch.assert_not_called()
        case.marker_read.assert_not_called()
        self.assertEqual(case.fixture.docker.calls, [])
        case.assert_held()

    def test_start_routes_reject_bad_bodies_and_framing_before_manager(self):
        for suffix, body in [('prepare', {'anything': 1}), ('admit', {}),
                ('admit', {'preparationSha256': 'a' * 64, 'sourceHoldSha256': 'b' * 64, 'extra': True}),
                ('admit', {'preparationSha256': 'A' * 64, 'sourceHoldSha256': 'b' * 64})]:
            with self.subTest(suffix=suffix, body=body):
                self.assertEqual(self.request(suffix, body)[0], 409)
        target = f'/v1/core-captures/{POINT}/prepare'.encode()
        for extra, body in [(b'Content-Length: 2\r\n', b'{}'), (b'Content-Type: application/json\r\n', b'{}'),
                (b'Content-Encoding: gzip\r\n', b'{}'), (b'Transfer-Encoding: chunked\r\n', b'{}'),
                (b'', b'{"x":1,"x":2}')]:
            raw = b'POST ' + target + b' HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n' + extra + b'\r\n' + body
            self.assertEqual(self.raw_request(raw)[0], 409)
        self.admission.prepare_bound.assert_not_called()
        self.admission.admit.assert_not_called()

    def test_denied_start_peer_precedes_body_and_manager(self):
        target = f'/v1/core-captures/{POINT}/prepare'.encode()
        with mock.patch.object(S, 'trusted_capture_peer', return_value=False), mock.patch.object(S, 'core_capture_admission', side_effect=AssertionError('must not load')):
            code, _, _ = self.raw_request(b'POST ' + target + b' HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: 999\r\n\r\n')
            self.assertEqual(code, 403)
        self.admission.prepare_bound.assert_not_called()
        self.admission.admit.assert_not_called()

    def test_start_failure_is_generic(self):
        self.admission.prepare_bound.side_effect = ValueError('PRIVATE_FIXTURE_MUST_NOT_LEAK')
        code, _, body = self.request('prepare', {})
        self.assertEqual(code, 409)
        self.assertNotIn(b'PRIVATE_FIXTURE', body)

    def test_cached_admission_and_completion_avoid_nested_lock(self):
        module = SimpleNamespace(CoreCaptureService=mock.Mock(return_value=self.admission),
            COMPLETION=SimpleNamespace(CoreCaptureCompletion=mock.Mock(return_value=self.completion)), W=object())
        service = SimpleNamespace(lock=threading.Lock())
        with mock.patch.object(S, 'load_script', return_value=module) as loader:
            self.assertIs(S.core_capture_completion(service), self.completion)
            self.assertEqual(S.core_capture_admission(service), (module, self.admission))
            loader.assert_called_once()
            module.CoreCaptureService.assert_called_once_with(service)
            module.COMPLETION.CoreCaptureCompletion.assert_called_once_with(self.admission, module.W)
        with mock.patch.object(service, 'lock', mock.MagicMock()) as lock:
            lock.__enter__.side_effect = AssertionError('cached admission must not lock')
            self.assertEqual(S.core_capture_admission(service), (module, self.admission))

    def test_failures_do_not_append_json_to_binary_or_leak_details(self):
        self.failure = 'before'
        status, _, body = self.request('checkpoint')
        self.assertEqual(status, 409)
        self.assertNotIn(b'PRIVATE_FIXTURE', body)
        self.failure = 'during'
        status, headers, body = self.request('checkpoint')
        self.assertEqual(status, 200)
        self.assertLess(len(body), int(headers['content-length']))
        self.assertEqual(body, self.data[:len(body)])
        self.assertNotIn(b'error', body)
        self.assertNotIn(b'PRIVATE_FIXTURE', body)


if __name__ == '__main__':
    unittest.main()
