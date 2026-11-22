import copy
from contextvars import ContextVar
import importlib.util
import json
import os
from pathlib import Path
import socket
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from test_orbis_host_sentinel_integration import SERVICE


SPEC = importlib.util.spec_from_file_location('credential_peer_under_test', Path(__file__).with_name('orbis-host-credential-peer.py'))
PEER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PEER)
CID = 'a' * 64
IMAGE = 'sha256:' + 'b' * 64
DIGEST = 'sha256:' + 'c' * 64


class PeerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('ORBIS_TEST_SOCKET_DIR'))
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.proc = self.base / 'proc'
        self.proc.mkdir()
        self.root = self.base / 'installation'
        self.root.mkdir()
        self.state = {'schema': 'orbis.host.v1', 'root': str(self.root), 'dockerContext': 'fixture',
                      'tag': 'v0.8.5', 'digest': DIGEST}
        self.state_path = self.root / '.orbis-host-state.json'
        self.write_state()
        self.publication = {'tag': 'v0.8.5', 'digest': DIGEST}
        self.controller = {'id': CID, 'imageId': IMAGE, 'imageReference': 'fixture@' + DIGEST,
                           'project': 'runtipi', 'service': 'runtipi', 'startedAt': '2026-11-19T00:00:00Z',
                           'releaseTag': 'v0.8.5', 'releaseDigest': DIGEST}
        self.container = {'Id': CID, 'Image': IMAGE,
                          'State': {'Pid': 100, 'Running': True, 'Restarting': False, 'Paused': False, 'Dead': False,
                                    'Status': 'running', 'Health': {'Status': 'healthy'},
                                    'StartedAt': self.controller['startedAt']},
                          'Config': {'Image': 'fixture@' + DIGEST}, 'HostConfig': {}, 'Mounts': [], 'Path': 'node', 'Args': []}
        self.daemon = 'fixture-daemon'
        self.service = SimpleNamespace(root=self.root, context='fixture', controller_capture_identity=self.capture_identity)
        self.host = SimpleNamespace(AUTHORITY=SERVICE.HOST.AUTHORITY, STATE_NAME='.orbis-host-state.json',
                                    CAPTURE_READ_DEADLINE=ContextVar('peer-test-deadline', default=None),
                                    saved_state=lambda root: json.loads((root / '.orbis-host-state.json').read_text()))
        self.connection = mock.Mock()
        self.connection.getsockopt.return_value = struct.pack('3i', 101, os.geteuid(), os.getegid())
        ns = self.proc / 'namespaces'
        ns.mkdir()
        for name in ('mnt', 'pid', 'user'):
            (ns / name).write_bytes(b'namespace fixture')
        for pid in (100, 101):
            process = self.proc / str(pid)
            process.mkdir()
            self.write_proc(pid)
            (process / 'ns').mkdir()
            for name in ('mnt', 'pid', 'user'):
                os.link(ns / name, process / 'ns' / name)
        for patcher in (mock.patch.object(PEER, '_PROC', self.proc), mock.patch.object(PEER, '_OWNER', os.geteuid()),
                        mock.patch.object(PEER, 'sys', SimpleNamespace(platform='linux')),
                        mock.patch.object(PEER.socket, 'SO_PEERCRED', 17, create=True),
                        mock.patch.object(SERVICE.HOST.AUTHORITY, 'OWNER', os.geteuid()),
                        mock.patch.object(PEER, '_run', self.docker_read)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def write_state(self):
        self.state_path.write_text(json.dumps(self.state))
        self.state_path.chmod(0o600)

    def write_proc(self, pid, *, start=1234, state='S', uid=None, cgroup=None):
        directory = self.proc / str(pid)
        (directory / 'stat').write_text(f'{pid} (node (worker)) ' + ' '.join([state] + ['0'] * 18 + [str(start)]) + '\n')
        uid = os.geteuid() if uid is None else uid
        (directory / 'status').write_text('Name:\tnode\nUid:\t' + '\t'.join([str(uid)] * 4) + '\n')
        (directory / 'cgroup').write_text(cgroup or '0::/system.slice/docker-' + CID + '.scope\n')

    def capture_identity(self, container, image, saved):
        self.assertEqual((container, image, saved), (CID, IMAGE, self.state))
        return copy.deepcopy(self.controller)

    def docker_read(self, service, arguments, deadline):
        self.assertIs(service, self.service)
        self.assertGreater(deadline, PEER.time.monotonic())
        self.assertLessEqual(deadline - PEER.time.monotonic(), 15)
        if arguments == ['inspect', '--format', '{{json .}}', 'runtipi']:
            return json.dumps(self.container).encode()
        self.assertEqual(arguments, ['info', '--format', '{{json .ID}}'])
        return json.dumps(self.daemon).encode()

    def admit(self):
        return PEER.admit(self.service, self.connection, host=self.host, enrollment=lambda: copy.deepcopy(self.publication))

    def refused(self):
        with self.assertRaisesRegex(ValueError, '^The credential producer could not be verified.$'):
            self.admit()

    def test_descendant_in_exact_controller_namespaces_and_cgroup_is_bound(self):
        with self.admit() as witness:
            identity = witness.identity()
            self.assertEqual(set(identity), {'installationId', 'controllerId', 'imageId', 'controllerEpoch'})
            self.assertEqual((identity['controllerId'], identity['imageId']), (CID, IMAGE))
            self.assertRegex(identity['installationId'], r'^[a-f0-9]{64}$')
            self.assertRegex(identity['controllerEpoch'], r'^[a-f0-9]{64}$')
            identity['controllerId'] = 'modified'
            self.assertEqual(witness.identity()['controllerId'], CID)
        with self.assertRaises(ValueError):
            witness.verify()

    def test_installation_binding_is_current_verified_scope_and_cannot_be_mutated(self):
        with self.admit() as witness:
            expected = {'root': str(self.root), 'context': 'fixture', 'daemon': self.daemon}
            actual = witness.installation_binding()
            self.assertEqual(actual, expected)
            actual['daemon'] = 'different'
            self.assertEqual(witness.installation_binding(), expected)
            self.write_proc(101, start=1235)
            with self.assertRaises(ValueError):
                witness.installation_binding()
        with self.assertRaises(ValueError):
            witness.installation_binding()

    def test_root_uid_alone_does_not_admit_host_or_sibling_container(self):
        self.write_proc(101, cgroup='0::/system.slice/host.service\n')
        self.refused()
        self.write_proc(101, cgroup='0::/system.slice/docker-' + 'd' * 64 + '.scope\n')
        self.refused()

    def test_same_cgroup_with_different_mount_pid_or_user_namespace_refuses(self):
        for name in ('mnt', 'pid', 'user'):
            with self.subTest(namespace=name):
                path = self.proc / '101/ns' / name
                path.unlink()
                path.write_text('different namespace')
                self.refused()
                path.unlink()
                os.link(self.proc / 'namespaces' / name, path)

    def test_same_namespaces_without_exact_docker_container_cgroup_refuses(self):
        for group in ('0::/\n', '0::/docker/' + CID + '-suffix\n', 'bad\n', '0::relative\n', ''):
            with self.subTest(group=group):
                (self.proc / '100/cgroup').write_text(group)
                (self.proc / '101/cgroup').write_text(group)
                self.refused()

    def test_nonroot_or_dead_peer_refuses_and_errors_do_not_echo_input(self):
        self.connection.getsockopt.return_value = struct.pack('3i', 101, os.geteuid() + 1, os.getegid())
        self.refused()
        self.connection.getsockopt.return_value = struct.pack('3i', 101, os.geteuid(), os.getegid())
        for state in ('Z', 'X', 'T'):
            self.write_proc(101, state=state)
            self.refused()
        self.write_proc(101, uid=os.geteuid() + 1)
        self.refused()

    def test_witness_detects_pid_reuse_start_time_change(self):
        with self.admit() as witness:
            self.write_proc(101, start=1235)
            with self.assertRaises(ValueError):
                witness.verify()

    def test_witness_detects_process_directory_replacement(self):
        with self.admit() as witness:
            (self.proc / '101').rename(self.proc / 'old101')
            (self.proc / '101').mkdir()
            with self.assertRaises(ValueError):
                witness.verify()

    def test_witness_detects_namespace_switch_even_when_held_old_fd_survives(self):
        with self.admit() as witness:
            path = self.proc / '101/ns/mnt'
            path.unlink()
            path.write_text('replacement')
            with self.assertRaises(ValueError):
                witness.verify()

    def test_witness_detects_controller_restart_definition_daemon_and_enrollment_drift(self):
        for change in ('pid', 'started', 'definition', 'daemon', 'enrollment'):
            with self.subTest(change=change), self.admit() as witness:
                old = copy.deepcopy((self.container, self.controller, self.daemon, self.state))
                if change == 'pid':
                    self.container['State']['Pid'] = 999
                elif change == 'started':
                    self.container['State']['StartedAt'] = 'later'
                    self.controller['startedAt'] = 'later'
                elif change == 'definition':
                    self.container['HostConfig']['NetworkMode'] = 'changed'
                elif change == 'daemon':
                    self.daemon = 'new-daemon'
                else:
                    self.state['extra'] = 'changed'
                    self.write_state()
                with self.assertRaises(ValueError):
                    witness.verify()
                self.container, self.controller, self.daemon, self.state = old
                self.write_state()

    def test_paused_restarting_unhealthy_stopped_or_unenrolled_controller_refuses(self):
        for key, value in (('Paused', True), ('Restarting', True), ('Running', False), ('Dead', True),
                           ('Health', {'Status': 'unhealthy'}), ('Pid', 0), ('Pid', True)):
            with self.subTest(key=key):
                old = self.container['State'][key]
                self.container['State'][key] = value
                self.refused()
                self.container['State'][key] = old
        self.publication['digest'] = 'sha256:' + 'e' * 64
        self.refused()

    def test_peer_credentials_cannot_change_after_admission(self):
        with self.admit() as witness:
            self.connection.getsockopt.return_value = struct.pack('3i', 102, os.geteuid(), os.getegid())
            with self.assertRaises(ValueError):
                witness.verify()

    def test_proc_or_enrollment_symlink_and_permissive_state_refuse(self):
        self.state_path.chmod(0o666)
        self.refused()
        self.state_path.chmod(0o600)
        state = self.state_path.read_bytes()
        self.state_path.unlink()
        other = self.root / 'elsewhere'
        other.write_bytes(state)
        self.state_path.symlink_to(other)
        self.refused()

    def test_duplicate_enrollment_and_oversize_proc_fields_refuse(self):
        self.state_path.write_text('{"schema":"one","schema":"two"}')
        self.refused()
        self.write_state()
        (self.proc / '101/status').write_text('x' * 65537)
        self.refused()

    def test_outer_deadline_is_preserved_and_restored(self):
        deadline = PEER.time.monotonic() + 3
        token = self.host.CAPTURE_READ_DEADLINE.set(deadline)
        try:
            with self.admit() as witness:
                witness.verify()
            self.assertEqual(self.host.CAPTURE_READ_DEADLINE.get(), deadline)
        finally:
            self.host.CAPTURE_READ_DEADLINE.reset(token)

    def test_new_publication_changes_controller_epoch_but_not_installation_identity(self):
        with self.admit() as old:
            before = old.identity()
            self.state['tag'] = self.publication['tag'] = self.controller['releaseTag'] = 'v0.8.6'
            self.write_state()
            with self.assertRaises(ValueError):
                old.verify()
            with self.admit() as new:
                after = new.identity()
            self.assertEqual(before['installationId'], after['installationId'])
            self.assertNotEqual(before['controllerEpoch'], after['controllerEpoch'])

    def test_proc_root_symlink_or_replacement_refuses(self):
        with self.admit() as witness:
            self.proc.rename(self.base / 'oldproc')
            self.proc.symlink_to(self.base / 'oldproc', target_is_directory=True)
            with self.assertRaises(ValueError):
                witness.verify()
            self.refused()

    def test_controller_init_start_time_and_cgroup_drift_refuse(self):
        with self.admit() as witness:
            self.write_proc(100, start=1235)
            with self.assertRaises(ValueError):
                witness.verify()

    def test_unsupported_platform_or_nonroot_supervisor_refuses(self):
        with mock.patch.object(PEER.sys, 'platform', 'darwin'):
            self.refused()
        with mock.patch.object(PEER.os, 'geteuid', return_value=os.geteuid() + 1):
            self.refused()

    def test_invalid_observations_never_return_an_empty_admission(self):
        for body in (b'{}', b'{"Id":"a","Id":"b"}', b'not-json', b'[]'):
            with self.subTest(body=body), mock.patch.object(PEER, '_run', return_value=body):
                self.refused()
        with mock.patch.object(PEER, '_run', side_effect=TimeoutError('private detail')):
            self.refused()


if __name__ == '__main__':
    unittest.main()
