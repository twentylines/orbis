import copy
import importlib.util
import json
import os
import socket
import select
import time
import sys
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

spec = importlib.util.spec_from_file_location('observer', os.path.join(os.path.dirname(__file__), 'orbis-host-sentinel-observer.py'))
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class ObserverTest(unittest.TestCase):
    def setUp(self):
        self.old = os.getcwd()
        self.temp = tempfile.TemporaryDirectory()
        os.chdir(self.temp.name)
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind('s')
        self.listener.listen(16)
        self.calls = 0
        self.identity = ((1, 2, 0, 12345, 0, 1), (1, 3, 0, 12345, 0, 1), ())
        self.ip = mock.patch.object(observer.ObserverServer, '_identity', side_effect=lambda p: self.identity)
        self.pp = mock.patch.object(observer.ObserverServer, '_peer', return_value=(1000, 12345))
        self.lp = mock.patch.object(observer.ObserverServer, '_is_listening', return_value=True)
        self.lp.start()
        self.ip.start()
        self.pp.start()
        self.server = observer.ObserverServer(self.listener, self.provider)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(3)
        self.server.server_close()
        self.listener.close()
        self.lp.stop()
        self.ip.stop()
        self.pp.stop()
        os.chdir(self.old)
        self.temp.cleanup()

    def provider(self):
        self.calls += 1
        return {'version': 1, 'job': None}

    def request(self, data):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(4)
        s.connect('s')
        s.sendall(data)
        output = b''
        try:
            while True:
                part = s.recv(32768)
                if not part:
                    break
                output += part
        except (ConnectionResetError, BrokenPipeError):
            pass
        s.close()
        return output

    def test_allowlist_and_fd(self):
        self.assertIn(b'200 OK', self.request(b'GET /v1/core-operation/progress HTTP/1.1\r\n\r\n'))
        self.assertEqual(self.calls, 1)
        self.assertIn(b'core-update-progress', self.request(b'GET /v1/capability HTTP/1.1\r\n\r\n'))
        for request in (b'POST /v1/core-operation/progress', b'GET /v1/other', b'GET /v1/capability?x=1'):
            self.assertIn(b'400 Bad Request', self.request(request + b' HTTP/1.1\r\n\r\n'))
        self.assertEqual(self.calls, 1)
        self.server.shutdown()
        self.thread.join(3)
        self.server.server_close()
        self.assertGreaterEqual(self.listener.fileno(), 0)
        self.assertTrue(os.path.exists('s'))

    def test_auth_and_parser(self):
        self.pp.stop()
        self.pp = mock.patch.object(observer.ObserverServer, '_peer', return_value=(1000, 999))
        self.pp.start()
        self.assertIn(b'400 Bad Request', self.request(b'GET /v1/core-operation/progress HTTP/1.1\r\n\r\n'))
        self.pp.stop()
        self.pp = mock.patch.object(observer.ObserverServer, '_peer', return_value=(0, 999))
        self.pp.start()
        for suffix in (b'Transfer-Encoding: chunked\r\n', b'Content-Length: 0\r\nContent-Length: 0\r\n', b'Content-Length: 1\r\n'):
            self.assertIn(b'400 Bad Request', self.request(b'GET /v1/core-operation/progress HTTP/1.1\r\n' + suffix + b'\r\n'))
        self.assertIn(b'400 Bad Request', self.request(b'GET /' + b'a' * 8192 + b' HTTP/1.1\r\n\r\n'))
        self.assertIn(b'400 Bad Request', self.request(b'GET /v1/core-operation/progress HTTP/1.1\r\nX: ' + b'a' * 16384 + b'\r\n\r\n'))
        self.assertEqual(self.calls, 0)

    def test_identity_and_redaction(self):
        self.identity = ((1, 9, 0, 12345, 0, 1), (1, 3, 0, 12345, 0, 1), ())
        response = self.request(b'GET /v1/core-operation/progress HTTP/1.1\r\n\r\n')
        self.assertIn(b'Unavailable', response)
        self.assertNotIn(self.temp.name.encode(), response)
        self.assertEqual(self.calls, 0)

    def test_callback_identity_change(self):
        def mutate():
            self.identity = ((1, 9, 0, 12345, 0, 1), (1, 3, 0, 12345, 0, 1), ())
            return {'version': 1, 'job': None}
        self.server.provider = mutate
        self.assertIn(b'400 Bad Request', self.request(b'GET /v1/core-operation/progress HTTP/1.1\r\n\r\n'))

    def test_capture_is_additive_bounded_and_redacted(self):
        point = '12345678-1234-4123-8123-123456789abc'
        route = '/v2/core-captures/' + point + '/progress'
        self.assertIn(b'400 Bad Request', self.request(('GET ' + route + ' HTTP/1.1\r\n\r\n').encode()))
        sample = {'version': 1, 'id': point, 'state': 'running', 'phase': 'starting-orbis',
                  'completedBytes': 0, 'totalBytes': None, 'restartVerified': False}
        provider = mock.Mock(return_value=sample)
        self.server.capture_provider = provider
        self.assertIn(b'core-capture-progress', self.request(b'GET /v2/capture-capability HTTP/1.1\r\n\r\n'))
        response = self.request(('GET ' + route + ' HTTP/1.1\r\n\r\n').encode())
        self.assertIn(b'200 OK', response)
        self.assertEqual(json.loads(response.split(b'\r\n\r\n')[1]), sample)
        provider.assert_called_once_with(point)
        for suffix in ('?x=1', '/', '%2f', '\n'):
            self.assertIn(b'400 Bad Request', self.request(('GET ' + route + suffix + ' HTTP/1.1\r\n\r\n').encode()))
        provider.assert_called_once()
        provider.return_value = {**sample, 'privatePath': self.temp.name}
        response = self.request(('GET ' + route + ' HTTP/1.1\r\n\r\n').encode())
        self.assertIn(b'400 Bad Request', response)
        self.assertNotIn(self.temp.name.encode(), response)
        self.assertIn(b'200 OK', self.request(b'GET /v1/core-operation/progress HTTP/1.1\r\n\r\n'))

    def test_component_status_is_optional_read_only_and_redacted(self):
        route = b'GET /v3/orbis/status HTTP/1.1\r\n\r\n'
        self.assertIn(b'400 Bad Request', self.request(route))
        provider = mock.Mock(return_value={'installedVersion': '0.8.8', 'availableVersion': None, 'state': 'healthy'})
        self.server.component_provider = provider
        self.assertIn(b'core-component-status', self.request(b'GET /v3/component-capability HTTP/1.1\r\n\r\n'))
        provider.assert_not_called()
        response = self.request(route)
        self.assertIn(b'200 OK', response)
        self.assertEqual(json.loads(response.split(b'\r\n\r\n')[1]), provider.return_value)
        for request in (b'POST /v3/orbis/status', b'GET /v3/orbis/status?restart=1', b'GET /v3/orbis/status/'):
            self.assertIn(b'400 Bad Request', self.request(request + b' HTTP/1.1\r\n\r\n'))
        provider.assert_called_once()
        provider.return_value = {**provider.return_value, 'privatePath': self.temp.name}
        response = self.request(route)
        self.assertIn(b'400 Bad Request', response)
        self.assertNotIn(self.temp.name.encode(), response)
        self.assertIn(b'200 OK', self.request(b'GET /v1/core-operation/progress HTTP/1.1\r\n\r\n'))

    def test_real_path_replacement(self):
        self.ip.stop()
        def identity(path):
            st = os.lstat(path)
            return (self.server.identity[0], (st.st_dev, st.st_ino, 0, 12345, st.st_mode, st.st_ctime_ns), ())
        self.server.identity = identity(self.server.path)
        self.ip = mock.patch.object(observer.ObserverServer, '_identity', side_effect=identity)
        self.ip.start()
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(3)
        client.connect('s')
        os.unlink('s')
        replacement = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        replacement.bind('s')
        replacement.listen(1)
        try:
            client.sendall(b'GET /v1/core-operation/progress HTTP/1.1\r\n\r\n')
            self.assertIn(b'400 Bad Request', client.recv(1024))
            self.assertEqual(self.calls, 0)
        finally:
            client.close()
            replacement.close()

    def test_eight_active_connections_bound(self):
        clients = []
        try:
            for _ in range(8):
                client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                client.connect('s')
                client.sendall(b'GET /v1/capability HTTP/1.1\r\n')
                clients.append(client)
            deadline = time.monotonic() + 1
            while self.server._slots._value and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(self.server._slots._value, 0)
            ninth = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            ninth.connect('s')
            ninth.sendall(b'GET /v1/capability HTTP/1.1\r\n\r\n')
            clients.append(ninth)
            self.assertFalse(select.select([ninth], [], [], 0.15)[0])
            clients[0].close()
            self.assertTrue(select.select([ninth], [], [], 1)[0])
            self.assertIn(b'200 OK', ninth.recv(1024))
        finally:
            for client in clients:
                client.close()

    @unittest.skipUnless(sys.platform.startswith('linux') and hasattr(socket, 'SO_PEERCRED'), 'Linux SO_PEERCRED required')
    def test_linux_peercred(self):
        a, b = socket.socketpair()
        try:
            self.assertEqual(observer._peer(a), (os.getuid(), os.getgid()))
        finally:
            a.close()
            b.close()


class ValidationTest(unittest.TestCase):
    def test_capture_completion_needs_restart_and_exact_safe_values(self):
        point = '12345678-1234-4123-8123-123456789abc'
        sample = {'version': 1, 'id': point, 'state': 'complete', 'phase': 'complete',
                  'completedBytes': 0, 'totalBytes': None, 'restartVerified': True}
        self.assertEqual(observer.validate_capture(sample, point), sample)
        for field, invalid in (('version', True), ('id', '0' * 36), ('completedBytes', True),
                               ('completedBytes', 2 ** 53), ('totalBytes', -1), ('state', 'running'),
                               ('phase', 'sealing'), ('restartVerified', False), ('extra', 'private')):
            with self.subTest(field=field, invalid=invalid), self.assertRaises(ValueError):
                observer.validate_capture({**sample, field: invalid}, point)
        with self.assertRaises(ValueError):
            observer.validate_capture({**sample, 'completedBytes': 2, 'totalBytes': 1}, point)

    def test_strict_shapes(self):
        job = {'id': '12345678-1234-4123-8123-123456789abc', 'state': 'running', 'targetTag': 'v1.2.3', 'phase': None}
        value = {'version': 1, 'job': job}
        self.assertEqual(observer.validate_progress(value), value)
        invalid = []
        for key, bad in [('id', job['id'] + '\n'), ('targetTag', 'v1.2.3\n'), ('state', 'idle'), ('phase', 'bad'), ('extra', 1)]:
            v = copy.deepcopy(value)
            v['job'][key] = bad
            invalid.append(v)
        invalid.extend([{'version': True, 'job': None}, {'version': 1, 'job': None, 'secret': 1}])
        download = {'schema': 'orbis.download-progress.v1', 'phase': 'complete', 'currentBytes': 0, 'totalBytes': 0, 'totalKnown': True, 'alreadyCached': True, 'layersComplete': 1, 'layersTotal': 1, 'updatedAt': 1}
        v = copy.deepcopy(value)
        v['job']['download'] = download
        self.assertEqual(observer.validate_progress(v), v)
        for key, bad in [('updatedAt', float('nan')), ('layersTotal', 4097), ('currentBytes', True), ('alreadyCached', 1), ('extra', 'secret')]:
            w = copy.deepcopy(v)
            w['job']['download'][key] = bad
            invalid.append(w)
        for v in invalid:
            with self.subTest(v=v), self.assertRaises((ValueError, TypeError)):
                observer.validate_progress(v)


class ComponentObservationTest(unittest.TestCase):
    root = Path('/opt/runtipi')

    def sample(self, **changes):
        return {'id': 'a' * 64, 'image': 'sha256:' + 'b' * 64,
                'reference': 'ghcr.io/twentylines/orbis@sha256:' + 'c' * 64,
                'project': 'runtipi', 'service': 'runtipi', 'root': str(self.root),
                'state': 'running', 'health': 'healthy', **changes}

    def image(self, **changes):
        return {'id': 'sha256:' + 'b' * 64,
                'digests': ['ghcr.io/twentylines/orbis@sha256:' + 'c' * 64],
                'source': 'https://github.com/twentylines/orbis', 'version': 'v0.8.8', **changes}

    def observe(self, sample, image=None):
        with mock.patch.object(observer, '_inspect', side_effect=[sample, self.image() if image is None else image]) as inspect:
            value = observer.observe_component(self.root, 'default')
        return value, inspect.call_args_list

    def test_fixed_read_only_inspection_and_immutable_image_health(self):
        value, calls = self.observe(self.sample())
        self.assertEqual(value, {'installedVersion': '0.8.8', 'availableVersion': None, 'state': 'healthy'})
        self.assertEqual(len(calls), 2)
        container, image = [call.args for call in calls]
        self.assertEqual(container[:2], (self.root, 'default'))
        self.assertEqual(container[2][:4], ['inspect', '--type', 'container', '--format'])
        self.assertEqual(container[2][-1], 'runtipi')
        self.assertNotIn('.Config.Env', container[2][-2])
        self.assertNotIn('org.opencontainers.image.version', container[2][-2])
        self.assertEqual(image[2][:3], ['image', 'inspect', '--format'])
        self.assertEqual(image[2][-1], self.sample()['image'])
        self.assertEqual(container[3], image[3])

    def test_stopped_and_restarting_differ_from_missing_health(self):
        for state, health, expected in (('exited', 'healthy', 'unavailable'), ('paused', 'healthy', 'unavailable'),
                                       ('restarting', 'unhealthy', 'recovering'), ('running', 'unhealthy', 'unavailable'),
                                       ('running', None, 'unknown'), ('running', 'starting', 'unknown')):
            with self.subTest(state=state, health=health):
                value, _ = self.observe(self.sample(state=state, health=health))
                self.assertEqual(value['state'], expected)
                self.assertEqual(value['installedVersion'], '0.8.8')

    def test_wrong_installation_or_invalid_observations_are_not_published(self):
        for key, value in (('project', 'other'), ('service', 'other'), ('root', '/other'),
                           ('reference', 'other/image:latest'), ('image', 'mutable'), ('id', 'short'),
                           ('health', 'missing'), ('state', 'absent'), ('private', 'hidden'),
                           ('version', 'v9.9.9'), ('source', 'https://github.com/twentylines/orbis')):
            with self.subTest(key=key), self.assertRaises((ValueError, TypeError)):
                self.observe(self.sample(**{key: value}))

    def test_registry_reference_and_version_must_belong_to_actual_image(self):
        for changes in ({'id': 'sha256:' + 'd' * 64}, {'digests': []},
                        {'digests': ['ghcr.io/twentylines/orbis@sha256:' + 'd' * 64]},
                        {'source': 'https://example.com'}, {'version': 'v0.8.8\n'}, {'private': 'hidden'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.observe(self.sample(), self.image(**changes))
        value, _ = self.observe(self.sample(), self.image(version='v0.8.9'))
        self.assertEqual(value['installedVersion'], '0.8.9')
        value, _ = self.observe(self.sample(reference=self.sample()['image']), self.image(digests=None))
        self.assertEqual(value['installedVersion'], '0.8.8')
        with self.assertRaises(ValueError):
            self.observe(self.sample(reference='sha256:' + 'd' * 64))

    def test_invalid_context_does_not_spawn_inspection(self):
        with mock.patch.object(observer.subprocess, 'Popen') as popen, self.assertRaises(ValueError):
            observer.observe_component(self.root, 'bad/context')
        popen.assert_not_called()


class InspectionChildTest(unittest.TestCase):
    def child(self, program, *, timeout=1):
        original = subprocess.Popen
        children = []
        def spawn(argv, **options):
            self.assertEqual(argv, ['docker', '--context', 'default', 'image', 'inspect'])
            self.assertEqual(options['stderr'], subprocess.DEVNULL)
            process = original([sys.executable, '-B', '-c', program], **options)
            children.append(process)
            return process
        try:
            with mock.patch.object(observer.subprocess, 'Popen', side_effect=spawn):
                return observer._inspect(Path.cwd(), 'default', ['image', 'inspect'], time.monotonic() + timeout)
        finally:
            self.assertEqual(len(children), 1)
            self.assertIsNotNone(children[0].poll())
            self.assertTrue(children[0].stdout.closed)

    def test_valid_output_and_large_discarded_stderr(self):
        self.assertEqual(self.child("import os; os.write(2, b'x' * 1048576); print('{\"id\": 1}')"), {'id': 1})

    def test_overflow_is_refused_and_running_child_reaped(self):
        with self.assertRaises(ValueError):
            self.child("import os,time; os.write(1, b'x' * 1048576); time.sleep(5)")

    def test_silent_child_has_bounded_deadline_and_is_reaped(self):
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            self.child('import time; time.sleep(5)', timeout=0.15)
        self.assertLess(time.monotonic() - started, 1.5)

    def test_nonzero_or_invalid_output_is_refused(self):
        for program in ("print('{}'); raise SystemExit(1)", "print('invalid json')"):
            with self.subTest(program=program), self.assertRaises(ValueError):
                self.child(program)


if __name__ == '__main__':
    unittest.main()
