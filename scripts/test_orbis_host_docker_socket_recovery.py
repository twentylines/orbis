"""Isolated supervisor and Docker/procfs adapter tests. No live effects."""

import copy
import importlib.util
import json
from contextlib import nullcontext
from pathlib import Path
import socket
import stat
import struct
import threading
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('socket_recovery', Path(__file__).with_name(
    'orbis-host-docker-socket-recovery.py'))
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)
ID = 'd' * 64
IMAGE_ID = 'sha256:' + 'e' * 64
REFERENCE = 'ghcr.io/twentylines/orbis@sha256:' + 'f' * 64
PATH = Path('/var/run/docker.sock')
ENGINE = (PATH, 'engine', (25, 23836, 42, 0o140660, 100))
BASE = {
    'id': ID, 'creation': 'unchanged', 'incarnation': (10, 'start', '44', 'mount-table'),
    'socket': (25, 1392, 10, 0o140660, 100), 'binding': 'stale', 'health': 'healthy',
    'image': IMAGE_ID, 'reference': REFERENCE,
}
FRESH = {**BASE, 'incarnation': (12, 'new-start', '55', 'new-mount-table'),
         'socket': ENGINE[2], 'binding': 'fresh'}


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.host = SimpleNamespace(host_lock=Mock(return_value=nullcontext()))
        self.service = SimpleNamespace(lock=threading.Lock(), HOST=self.host, root=Path('/fixture'),
                                       state_dir=Path('/fixture-state'), require_idle_core=Mock())
        self.package_locks = Mock(return_value=nullcontext())
        self.docker = Mock()
        self.docker.engine.return_value = ENGINE
        self.docker.deadline.side_effect = lambda _: nullcontext()
        self.docker.enrollment.return_value = 'enrollment'
        self.docker.controller.side_effect = self.controller
        self.source, self.result = BASE, FRESH
        self.docker.restart.side_effect = lambda *_: setattr(self, 'source', self.result)
        self.stop = Mock()
        self.stop.is_set.return_value = False
        self.ledger = None
        self.now = 1
        self.boot_id = Mock(return_value='boot')
        self.recovery = self.new_supervisor()

    def new_supervisor(self):
        return R.Recovery(self.service, self.docker, self.package_locks, lambda _: self.ledger,
                          lambda _, value: setattr(self, 'ledger', value), self.boot_id,
                          clock=lambda: self.now)

    def controller(self, _):
        return copy.deepcopy(self.source)

    def test_incident_restarts_only_full_enrolled_controller_id_then_verifies_fresh_health(self):
        self.assertEqual(self.recovery.check(self.stop), 'recovered')
        self.assertEqual(self.recovery.check(self.stop), 'current')
        self.docker.restart.assert_called_once_with(ID, ENGINE)
        self.assertEqual({call.args[0][1] for call in self.docker.controller.call_args_list}, {'engine'})
        self.assertEqual(len(self.ledger['attempts']), 1)

    def test_matching_inode_and_unverified_socket_are_no_effect(self):
        for binding, expected in [('fresh', 'current'), ('unverified', 'unverified')]:
            self.source = {**BASE, 'binding': binding}
            self.assertEqual(self.recovery.check(self.stop), expected)
        self.docker.restart.assert_not_called()

    def test_engine_down_blocks_effect(self):
        self.docker.engine.side_effect = ConnectionRefusedError()
        self.assertEqual(self.recovery.check(self.stop), 'unverified')
        self.docker.restart.assert_not_called()

    def test_capture_restore_credential_and_handoff_lock_rejection_defers_then_retries(self):
        self.host.host_lock.side_effect = ValueError('protected Host lifecycle fence')
        self.assertEqual(self.recovery.check(self.stop), 'deferred')
        self.host.host_lock.side_effect = None
        self.docker.restart.assert_not_called()
        self.assertEqual(self.recovery.check(self.stop), 'recovered')

    def test_package_and_job_guards_defer_until_clear(self):
        self.package_locks.side_effect = BlockingIOError()
        self.assertEqual(self.recovery.check(self.stop), 'deferred')
        self.package_locks.side_effect = None
        self.service.require_idle_core.side_effect = ValueError('busy')
        self.assertEqual(self.recovery.check(self.stop), 'deferred')
        self.docker.restart.assert_not_called()
        self.service.require_idle_core.side_effect = None
        self.assertEqual(self.recovery.check(self.stop), 'recovered')

    def test_stopped_controller_stays_stopped(self):
        self.source = None
        self.assertEqual(self.recovery.check(self.stop), 'stopped')
        self.docker.restart.assert_not_called()

    def test_unenrolled_controller_blocks_effect(self):
        self.docker.enrollment.side_effect = ValueError('foreign enrollment')
        self.assertEqual(self.recovery.check(self.stop), 'unverified')
        self.docker.restart.assert_not_called()

    def test_creation_or_pid_changes_after_reservation_block_effect(self):
        for changed in ({**BASE, 'creation': 'other'}, {**BASE, 'incarnation': (13, 'start', '44', 'mount-table')}):
            self.ledger = None
            self.docker.controller.side_effect = [BASE, BASE, changed]
            self.assertEqual(self.recovery.check(self.stop), 'unverified')
            self.assertIsNotNone(self.ledger)
        self.docker.restart.assert_not_called()

    def test_enrollment_changes_after_reservation_block_effect(self):
        self.docker.enrollment.side_effect = ['enrolled', 'changed']
        self.assertEqual(self.recovery.check(self.stop), 'unverified')
        self.docker.restart.assert_not_called()

    def test_new_socket_generation_during_preflight_blocks_effect(self):
        self.docker.engine.side_effect = [ENGINE, ENGINE, (*ENGINE[:2], (25, 33333, 91, 0o140660, 100))]
        self.assertEqual(self.recovery.check(self.stop), 'unverified')
        self.docker.restart.assert_not_called()

    def test_concurrent_checks_do_not_release_other_operation_lock(self):
        concurrent = []
        self.docker.enrollment.side_effect = lambda _: concurrent.append(
            self.new_supervisor().check(self.stop)) or 'enrollment'
        self.assertEqual(self.recovery.check(self.stop), 'recovered')
        self.assertEqual(concurrent, ['deferred', 'deferred', 'deferred'])
        self.docker.restart.assert_called_once_with(ID, ENGINE)
        self.assertFalse(self.service.lock.locked())

    def test_ambiguous_restart_failure_is_never_retried_for_same_socket(self):
        self.docker.restart.side_effect = TimeoutError()
        self.assertEqual(self.recovery.check(self.stop), 'repair-unverified')
        self.now += 2 * R.ATTEMPT_WINDOW
        self.assertEqual(self.new_supervisor().check(self.stop), 'attempt-limit')
        self.docker.restart.assert_called_once_with(ID, ENGINE)

    def test_healthy_stale_and_fresh_unhealthy_cannot_verify_recovery(self):
        for result in ({**FRESH, 'binding': 'stale'}, {**FRESH, 'health': 'starting'}):
            self.ledger = None
            self.source, self.result = BASE, result
            self.stop.wait.side_effect = lambda _: setattr(self, 'now', self.now + R.HEALTH_TIMEOUT)
            self.assertEqual(self.recovery.check(self.stop), 'repair-unverified')

    def test_healthy_fresh_binding_requires_new_incarnation(self):
        self.result = {**FRESH, 'incarnation': BASE['incarnation']}
        self.stop.wait.side_effect = lambda _: setattr(self, 'now', self.now + R.HEALTH_TIMEOUT)
        self.assertEqual(self.recovery.check(self.stop), 'repair-unverified')

    def test_new_generation_cooldown_and_rolling_rate_window(self):
        for index in range(R.MAX_ATTEMPTS_PER_WINDOW):
            self.assertIsNone(self.recovery.admit_attempt(str(index) * 64))
            self.assertEqual(self.recovery.admit_attempt('a' * 64), 'cooldown')
            self.now += R.COOLDOWN
        self.assertEqual(self.recovery.admit_attempt('a' * 64), 'cooldown')
        self.now += R.ATTEMPT_WINDOW
        self.assertIsNone(self.recovery.admit_attempt('a' * 64))

    def test_startup_and_periodic_check_retry_after_deferred_result(self):
        self.stop.is_set.side_effect = [False, False, False, True]
        self.recovery.check = Mock(side_effect=['deferred', 'recovered', 'recovered'])
        log = Mock()
        R.supervise(self.recovery, self.stop, log)
        self.assertEqual(self.recovery.check.call_count, 3)
        self.assertEqual([call.args for call in self.stop.wait.call_args_list], [(R.INTERVAL,)] * 3)
        log.assert_called_once_with('recovered')

    def test_unusable_ledger_blocks_restart(self):
        self.recovery.read_record = Mock(side_effect=PermissionError())
        self.assertEqual(self.recovery.check(self.stop), 'unverified')
        self.docker.restart.assert_not_called()


    def test_boolean_ledger_version_cannot_admit_a_restart(self):
        self.recovery.read_record = Mock(return_value={'version': True, 'boot': 'fixture-boot', 'attempts': []})
        self.assertEqual(self.recovery.check(self.stop), 'unverified')
        self.docker.restart.assert_not_called()


class ServiceLifecycleTests(unittest.TestCase):
    def test_service_owns_supervisor_start_and_bounded_shutdown(self):
        spec = importlib.util.spec_from_file_location('socket_recovery_service_test',
            Path(__file__).with_name('orbis-host-service.py'))
        service_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(service_module)
        for interrupted in (False, True):
            with self.subTest(interrupted=interrupted), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                socket_file = root / 'host.sock'
                service = SimpleNamespace(HOST=Mock(), root=root, context='fixture', state_dir=root,
                    discovery=Mock(), resume_pending_retained_restore=Mock(), credential_service=None,
                    credentials_only=False)
                server, worker = Mock(), Mock()
                worker.ident = 1
                observed = {}
                def create_server(*args):
                    socket_file.touch(mode=0o600)
                    return server
                def create_worker(*, target, name, daemon, args):
                    self.assertIs(target, R.supervise)
                    self.assertEqual(name, 'orbis-docker-socket-recovery')
                    self.assertTrue(daemon)
                    observed['stop'] = args[1]
                    self.assertFalse(args[1].is_set())
                    return worker
                def serving(**kwargs):
                    worker.start.assert_called_once()
                    if interrupted:
                        raise KeyboardInterrupt()
                def joined(**kwargs):
                    self.assertTrue(observed['stop'].is_set())
                    self.assertEqual(kwargs, {'timeout': 2})
                server.serve_forever.side_effect = serving
                worker.join.side_effect = joined
                resolver = SimpleNamespace(DockerRestoreRuntime=SimpleNamespace(socket_in_root=Mock()))
                with patch.object(service_module, 'UnixHTTPServer', side_effect=create_server), \
                        patch.object(service_module.threading, 'Thread', side_effect=create_worker), \
                        patch.object(service_module, 'load_script', side_effect=[R, resolver]):
                    service_module.serve(socket_file, service)
                worker.join.assert_called_once_with(timeout=2)
                service.resume_pending_retained_restore.assert_called_once()
                service.discovery.disable.assert_called_once()
                server.server_close.assert_called_once()
                self.assertFalse(socket_file.exists())


class LocalDockerTests(unittest.TestCase):
    def setUp(self):
        self.service = SimpleNamespace(root=Path('/fixture'), context='selected', current_manifest=Mock(
            return_value={'digest': 'release'}), HOST=SimpleNamespace(run=Mock(),
                controller_reference=Mock(return_value=REFERENCE)))
        self.host_socket = self.details(ENGINE[2])
        self.old_socket = self.details(BASE['socket'])
        self.resolve = Mock(return_value=('/run/docker.sock', self.old_socket))
        self.docker = R.LocalDocker(self.service, self.resolve)
        self.raw = {
            'Id': ID, 'Name': '/runtipi', 'Image': IMAGE_ID, 'Created': '2026-11-21T05:21:46Z',
            'Path': '/controller', 'Args': [],
            'Config': {'Image': REFERENCE, 'Env': [], 'Labels': {
                'com.docker.compose.project': 'runtipi', 'com.docker.compose.service': 'runtipi',
                'com.docker.compose.project.working_dir': '/fixture'}},
            'HostConfig': {'AutoRemove': False},
            'State': {'Running': True, 'Restarting': False, 'Paused': False, 'Dead': False, 'Pid': 646,
                      'StartedAt': '2026-11-21T05:21:46Z', 'Status': 'running',
                      'Health': {'Status': 'healthy'}},
            'Mounts': [{'Destination': str(PATH), 'Source': str(PATH), 'Type': 'bind', 'RW': False}],
        }
        self.inspect = self.enterContext(patch.object(self.docker, 'inspect', side_effect=lambda _: copy.deepcopy(self.raw)))
        self.open = self.enterContext(patch.object(R.os, 'open', return_value=40))
        self.enterContext(patch.object(R.os, 'close'))
        self.enterContext(patch.object(R.os, 'O_PATH', 0, create=True))
        self.enterContext(patch.object(R.Path, 'lstat', autospec=True, side_effect=lambda path:
                                     self.old_socket if str(path).startswith('/proc/self/fd/') else self.host_socket))
        self.read = self.enterContext(patch.object(R, 'read_text', side_effect=self.proc))
        self.probe = self.enterContext(patch.object(R, 'socket_probe', return_value='refused'))
        self.enterContext(patch.object(R.os, 'geteuid', return_value=0))
        self.enterContext(patch.dict(R.os.environ, {}, clear=True))

    @staticmethod
    def details(key):
        device, inode, generation, mode, group = key
        return SimpleNamespace(st_dev=device, st_ino=inode, st_ctime_ns=generation, st_uid=0, st_mode=mode, st_gid=group)

    @staticmethod
    def proc(path, _):
        return {
            'stat': '646 (process) S ' + '0 ' * 18 + '142 0',
            'cgroup': f'0::/system.slice/docker-{ID}.scope\n',
            'mountinfo': '1 2 0:25 /docker.sock//deleted /run/docker.sock ro - tmpfs tmpfs rw\n',
        }[path.name]

    def test_exact_hades_inode_mismatch_and_refusal(self):
        value = self.docker.controller(ENGINE)
        self.assertEqual(value['binding'], 'stale')
        self.assertEqual(value['socket'][:2], (25, 1392))
        self.assertEqual(value['incarnation'][2], '142')
        self.inspect.assert_any_call(ID)
        self.probe.assert_called_once_with(Path('/proc/self/fd/40/run/docker.sock'), ping=False)

    def test_same_inode_requires_positive_ping_and_different_listening_inode_is_unverified(self):
        self.probe.return_value = 'listening'
        self.assertEqual(self.docker.controller(ENGINE)['binding'], 'unverified')
        self.old_socket = self.host_socket
        self.resolve.return_value = ('/run/docker.sock', self.host_socket)
        self.probe.return_value = 'ready'
        self.assertEqual(self.docker.controller(ENGINE)['binding'], 'fresh')
        self.probe.assert_called_with(Path('/proc/self/fd/40/run/docker.sock'), ping=True)

    def test_foreign_controller_and_mount_mutations_fail_closed(self):
        for target, field, replacement in (
            (self.raw['Config']['Labels'], 'com.docker.compose.project.working_dir', '/foreign'),
            (self.raw['Config'], 'Env', ['DOCKER_HOST=tcp://remote:2376']),
            (self.raw['Mounts'][0], 'Source', '/foreign/docker.sock'),
            (self.raw['Mounts'][0], 'RW', True),
            (self.raw['Mounts'][0], 'Type', 'volume'),
        ):
            with self.subTest(field=field), patch.dict(target, {field: replacement}):
                with self.assertRaises(ValueError):
                    self.docker.controller(ENGINE)
        self.probe.assert_not_called()

    def test_pid_cgroup_mismatch_and_writable_kernel_mount_fail(self):
        for bad_file, body in [('cgroup', '0::/foreign\n'),
                               ('mountinfo', '1 2 0:25 /docker.sock /run/docker.sock rw - tmpfs tmpfs rw\n')]:
            self.read.side_effect = lambda path, limit: body if path.name == bad_file else self.proc(path, limit)
            with self.assertRaises(ValueError):
                self.docker.controller(ENGINE)
        self.probe.assert_not_called()

    def test_same_pid_reused_during_probe_and_changed_creation_inspect_are_rejected(self):
        stat_reads = iter([self.proc(Path('stat'), 0), self.proc(Path('stat'), 0).replace('142', '143')])
        self.read.side_effect = lambda path, limit: next(stat_reads) if path.name == 'stat' else self.proc(path, limit)
        with self.assertRaises(ValueError):
            self.docker.controller(ENGINE)
        self.read.side_effect = self.proc
        self.inspect.side_effect = [self.raw, {**self.raw, 'Created': '2026-11-21T05:22:46Z'}]
        with self.assertRaises(ValueError):
            self.docker.controller(ENGINE)

    def test_proc_descriptor_permission_failure_never_probes(self):
        self.open.side_effect = PermissionError()
        with self.assertRaises(PermissionError):
            self.docker.controller(ENGINE)
        self.probe.assert_not_called()

    def test_stopped_or_parked_controller_never_opens_descriptor(self):
        for status in ('exited', 'created'):
            with patch.dict(self.raw['State'], Running=False, Status=status, Pid=0):
                self.assertIsNone(self.docker.controller(ENGINE))
        with patch.dict(self.raw['State'], Paused=True):
            with self.assertRaises(ValueError):
                self.docker.controller(ENGINE)
        self.open.assert_not_called()

    def test_remote_context_is_rejected_before_ping_or_mutation(self):
        self.service.HOST.run.return_value = SimpleNamespace(returncode=0, stdout=json.dumps('tcp://remote:2376'))
        with self.assertRaises(ValueError):
            self.docker.engine()
        self.probe.assert_not_called()
        self.service.HOST.run.assert_called_once_with(
            ['/usr/bin/docker', '--context', 'selected', 'context', 'inspect', 'selected',
             '--format', '{{json .Endpoints.docker.Host}}'], self.service.root)

    def test_local_context_requires_ready_rootful_engine(self):
        parent = SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o755)
        with patch.object(R.Path, 'stat', return_value=parent), patch.object(R.Path, 'resolve', return_value=Path('/run')):
            self.service.HOST.run.side_effect = [
                SimpleNamespace(returncode=0, stdout=json.dumps(value))
                for value in ('unix:///var/run/docker.sock', ['engine', ['name=seccomp']])]
            self.probe.return_value = 'ready'
            self.assertEqual(self.docker.engine(), ENGINE)
            self.service.HOST.run.side_effect = [
                SimpleNamespace(returncode=0, stdout=json.dumps(value))
                for value in ('unix:///var/run/docker.sock', ['engine', ['name=rootless']])]
            with self.assertRaises(ValueError):
                self.docker.engine()

    def test_restart_command_cannot_target_proxy_name_or_abbreviated_id(self):
        for bad in ('runtipi-reverse-proxy', ID[:12]):
            with self.assertRaises(ValueError):
                self.docker.restart(bad, ENGINE)
        self.service.HOST.run.assert_not_called()
        self.service.HOST.run.return_value = SimpleNamespace(returncode=0, stdout=ID + '\n')
        self.docker.restart(ID, ENGINE)
        self.service.HOST.run.assert_called_once_with(
            ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', 'container',
             'restart', '--time', '30', ID], self.service.root)

    def test_effect_rejects_host_inode_replaced_after_final_observation(self):
        self.host_socket = self.old_socket
        with self.assertRaises(ValueError):
            self.docker.restart(ID, ENGINE)
        self.service.HOST.run.assert_not_called()

    def test_enrollment_requires_exact_docker_image_id_and_digest(self):
        run = self.service.HOST.run
        for image in ({'Id': 'foreign', 'RepoDigests': [REFERENCE]}, {'Id': IMAGE_ID, 'RepoDigests': []}):
            run.return_value = SimpleNamespace(returncode=0, stdout=json.dumps(image))
            with self.assertRaises(ValueError):
                self.docker.enrollment(BASE)
        run.return_value = SimpleNamespace(returncode=0, stdout=json.dumps({'Id': IMAGE_ID, 'RepoDigests': [REFERENCE]}))
        self.assertEqual(self.docker.enrollment(BASE), R.digest({'digest': 'release'}))


class SocketProbeTests(unittest.TestCase):
    def test_only_connection_refused_counts_as_a_dead_binding(self):
        transport = Mock()
        with patch.object(R.socket, 'socket') as factory:
            factory.return_value.__enter__.return_value = transport
            transport.connect.side_effect = ConnectionRefusedError()
            self.assertEqual(R.socket_probe(PATH, ping=False), 'refused')
            transport.connect.side_effect = PermissionError()
            with self.assertRaises(PermissionError):
                R.socket_probe(PATH, ping=False)

    def test_ping_requires_root_peer_and_200_ok(self):
        transport = Mock()
        transport.getsockopt.return_value = struct.pack('3i', 21, 0, 0)
        with patch.object(R.socket, 'socket') as factory, patch.object(
                R.http.client, 'HTTPResponse') as response_class, patch.object(socket, 'SO_PEERCRED', 17, create=True):
            factory.return_value.__enter__.return_value = transport
            response = response_class.return_value.__enter__.return_value
            response.status, response.read.return_value = 200, b'OK'
            self.assertEqual(R.socket_probe(PATH, ping=True), 'ready')
            response.status = 503
            with self.assertRaises(ValueError):
                R.socket_probe(PATH, ping=True)
            transport.getsockopt.return_value = struct.pack('3i', 21, 1001, 0)
            with self.assertRaises(ValueError):
                R.socket_probe(PATH, ping=True)


if __name__ == '__main__':
    unittest.main()
