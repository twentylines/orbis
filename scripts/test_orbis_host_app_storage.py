import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import stat
import struct
import tempfile
from contextlib import ExitStack, contextmanager
from contextvars import ContextVar
from email.message import Message
from types import SimpleNamespace
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('app_storage_under_test', Path(__file__).with_name('orbis-host-app-storage.py'))
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
CID = 'a' * 64
IMAGE = 'sha256:' + 'b' * 64
NONCE = 'c' * 64


def row(destination, ident=1, optional=''):
    return f'{ident} 0 8:1 / {destination} rw{(" " + optional) if optional else ""} - ext4 /dev/fixture rw\n'.encode()


class DirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def test_user_owned_writable_data_is_observed_without_changes(self):
        target = self.root / 'data'; target.mkdir(mode=0o777); target.chmod(0o777)
        before = target.stat()
        with M.Directory(target) as pin:
            self.assertEqual(pin.metadata()['inode'], str(before.st_ino))
            self.assertEqual(pin.metadata()['mode'], 0o777)
        self.assertEqual((before.st_uid, before.st_gid, before.st_mode, before.st_ino, before.st_mtime_ns),
                         (target.stat().st_uid, target.stat().st_gid, target.stat().st_mode, target.stat().st_ino, target.stat().st_mtime_ns))

    def test_symlink_ancestors_and_non_directories_refuse(self):
        target = self.root / 'data'; target.mkdir()
        (self.root / 'alias').symlink_to(target, target_is_directory=True)
        with self.assertRaises((OSError, ValueError)): M.Directory(self.root / 'alias')
        (target / 'file').write_bytes(b'preserve')
        with self.assertRaises((OSError, ValueError)): M.Directory(target / 'file')

    def test_named_replacement_and_mode_drift_refuse(self):
        target = self.root / 'data'; target.mkdir()
        with M.Directory(target) as pin:
            target.rename(self.root / 'retained'); target.mkdir()
            with self.assertRaises(ValueError): pin.verify()
        with M.Directory(target) as pin:
            target.chmod(0o777)
            with self.assertRaises(ValueError): pin.verify()


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.base = self.root / 'data'; (self.base / 'store' / 'demo').mkdir(parents=True)
        self.proc = self.root / 'proc'; self.proc.mkdir()
        self.proc_fd = None
        self.requests = []
        self.closed = []
        self.raw = {'Id': CID, 'Image': IMAGE, 'Config': {'Image': 'fixture'}, 'Path': 'node', 'Args': [],
                    'HostConfig': {'Privileged': False}, 'Mounts': [{'Type': 'bind', 'Source': str(self.base),
                       'Destination': '/app-data', 'RW': True, 'Propagation': 'rprivate'}],
                    'State': {'Pid': 100, 'Running': True, 'Status': 'running', 'Paused': False, 'Restarting': False,
                              'Dead': False, 'StartedAt': 'fixture-start'}}
        self.peer_uid, self.peer_namespace = 0, ((1, 10), (1, 11), (1, 12))
        self.controller = {'id': CID, 'imageId': IMAGE, 'startedAt': 'fixture-start', 'releaseTag': 'v0.9.1', 'releaseDigest': IMAGE}
        self.endpoint, self.daemon, self.socket_inode = 'unix:///var/run/docker.sock', 'fixture-daemon', 901
        self.host_mounts, self.main_mounts = row('/'), row('/') + row('/app-data', 2)
        self.saved = {'root': str(self.root), 'dockerContext': 'fixture'}
        self.publication = {'tag': 'v0.9.1', 'digest': IMAGE}
        self.lock_entries = 0
        @contextmanager
        def locked(root):
            self.assertEqual(root, self.root)
            self.lock_entries += 1
            yield
        self.service = SimpleNamespace(root=self.root, context='fixture', state_dir=self.root / 'host-state',
            HOST=SimpleNamespace(saved_state=lambda _root: copy.deepcopy(self.saved), host_lock=locked,
                                 CAPTURE_READ_DEADLINE=ContextVar("fixture_app_storage_deadline", default=None),
                                 AUTHORITY=SimpleNamespace(LAYOUT=SimpleNamespace(namespace=lambda _root: self.root / 'root-namespace'))),
            current_manifest=lambda: copy.deepcopy(self.publication),
            require_controller_capture_idle=mock.Mock(),
            controller_capture_identity=lambda *_args: copy.deepcopy(self.controller))
        self.connection = SimpleNamespace(getsockopt=lambda *_args: struct.pack('3i', 123, self.peer_uid, 0))
        self.request = {'appUrn': 'demo:store', 'nonce': NONCE}

    def run_docker(self, service, args, deadline):
        self.requests.append(args)
        self.assertGreater(deadline, M.time.monotonic())
        if args[0] == 'context': result = self.endpoint
        elif args[0] == 'inspect': result = copy.deepcopy(self.raw)
        elif args[0] == 'info': result = self.daemon
        else: self.fail('Unexpected Docker effect')
        return json.dumps(result).encode()

    @contextmanager
    def environment(self):
        original_open, original_stat, original_fstat, original_lstat = os.open, os.stat, os.fstat, os.lstat
        owner = self
        def opened(name, *args, **kwargs):
            fd = original_open(self.proc if name == '/proc' else name, *args, **kwargs)
            if name == '/proc': self.proc_fd = fd
            return fd
        def root_info(info):
            return SimpleNamespace(st_dev=info.st_dev, st_ino=info.st_ino, st_uid=0, st_gid=0, st_mode=info.st_mode)
        def fstat(fd):
            info = original_fstat(fd)
            return root_info(info) if fd == self.proc_fd else info
        def lstat(name, *args, **kwargs):
            return root_info(original_lstat(self.proc)) if name == '/proc' else original_lstat(name, *args, **kwargs)
        def named(name, *args, **kwargs):
            if name == '/var/run/docker.sock':
                return SimpleNamespace(st_mode=stat.S_IFSOCK | 0o660, st_uid=0, st_gid=0, st_nlink=1, st_dev=8, st_ino=self.socket_inode)
            return original_stat(name, *args, **kwargs)
        class Process:
            def __init__(self, proc, pid):
                self.fd = 10000 + pid
                self.identity = (pid, (('0', '', '/docker/' + CID),), owner.peer_namespace if pid == 123 else ((1, 10), (1, 11), (1, 12)))
            def verify(self, proc): pass
            def close(self): owner.closed.append(self.fd)
        def read(fd, name, maximum):
            if name == 'self/mountinfo': return self.host_mounts
            if name == 'mountinfo': return self.main_mounts
            self.fail('Unexpected kernel read')
        with ExitStack() as stack:
            for patch in (mock.patch.object(M.sys, 'platform', 'linux'), mock.patch.object(M.os, 'geteuid', return_value=0),
                          mock.patch.object(M.os, 'open', side_effect=opened), mock.patch.object(M.os, 'fstat', side_effect=fstat),
                          mock.patch.object(M.os, 'lstat', side_effect=lstat), mock.patch.object(M.os, 'stat', side_effect=named),
                          mock.patch.object(M.PEER, '_Process', Process), mock.patch.object(M.PEER, '_run', side_effect=self.run_docker),
                          mock.patch.object(M.PEER, '_read', side_effect=read), mock.patch.object(M.socket, 'SO_PEERCRED', 17, create=True)):
                stack.enter_context(patch)
            yield

    def test_real_data_directory_and_synthetic_peer_are_bound_with_no_mutations(self):
        target = self.base / 'store/demo'
        (target / 'preserved').write_bytes(b'unchanged')
        with self.environment(): result = M.observe(self.service, self.connection, self.request)
        self.assertEqual(result['directory']['inode'], str(target.stat().st_ino))
        self.assertEqual(result['hostPath'], str(target))
        self.assertEqual(result['containerPath'], '/app-data/store/demo')
        self.assertEqual(result['dockerSocket'], {'device': '8', 'inode': '901'})
        body = {k: v for k, v in result.items() if k != 'bindingSha256'}
        self.assertEqual(result['bindingSha256'], hashlib.sha256((M.SCHEMA + '\n').encode() + M.canonical(body)).hexdigest())
        self.assertTrue(all(args[0] in {'inspect', 'info', 'context'} for args in self.requests))
        self.assertEqual((target / 'preserved').read_bytes(), b'unchanged')
        self.assertEqual(self.lock_entries, 1)
        self.assertEqual(len(self.closed), 2)

    def test_peer_uid_namespace_remote_context_and_unknown_data_fail_closed(self):
        for kind in ('uid', 'namespace', 'remote', 'missing'):
            with self.subTest(kind=kind):
                prior = (self.peer_uid, self.peer_namespace, self.endpoint, copy.deepcopy(self.request))
                if kind == 'uid': self.peer_uid = 1000
                if kind == 'namespace': self.peer_namespace = ((9, 9), (9, 8), (9, 7))
                if kind == 'remote': self.endpoint = 'tcp://example.invalid:2376'
                if kind == 'missing': self.request['appUrn'] = 'absent:store'
                with self.environment(), self.assertRaisesRegex(ValueError, '^The app storage binding could not be verified\\.$'):
                    M.observe(self.service, self.connection, self.request)
                self.peer_uid, self.peer_namespace, self.endpoint, self.request = prior

    def test_mount_alias_writable_propagation_and_hidden_child_mounts_refuse(self):
        for change in ({'Type': 'volume'}, {'RW': False}, {'Propagation': 'rshared'}, {'Source': str(self.base / '..' / 'data')}, {'Destination': '/app-data/child'}):
            with self.subTest(change=change):
                old = copy.deepcopy(self.raw['Mounts'])
                self.raw['Mounts'][0].update(change)
                with self.environment(), self.assertRaises(ValueError): M.observe(self.service, self.connection, self.request)
                self.raw['Mounts'] = old
        self.raw['Mounts'].append({'Type': 'bind', 'Source': str(self.base), 'Destination': '/app-data/other', 'RW': True, 'Propagation': 'rprivate'})
        with self.environment(), self.assertRaises(ValueError): M.observe(self.service, self.connection, self.request)

    def test_host_and_main_nested_mounts_or_shared_data_namespace_refuse(self):
        original = self.host_mounts, self.main_mounts
        for host, main in ((row('/') + row(str(self.base / 'store/demo/db'), 3), original[1]),
                           (original[0], original[1] + row('/app-data/store/demo/db', 3)),
                           (original[0], row('/') + row('/app-data', 2, 'shared:3'))):
            self.host_mounts, self.main_mounts = host, main
            with self.environment(), self.assertRaises(ValueError): M.observe(self.service, self.connection, self.request)

    def test_observed_controller_socket_or_daemon_drift_refuse(self):
        original = self.run_docker
        for kind in ('controller', 'socket', 'daemon'):
            with self.subTest(kind=kind):
                self.raw['State']['StartedAt'] = 'fixture-start'; self.socket_inode = 901; self.daemon = 'fixture-daemon'
                count = 0
                def changed(service, args, deadline):
                    nonlocal count
                    count += 1
                    if count == 5:
                        if kind == 'controller': self.raw['State']['StartedAt'] = 'restarted'
                        if kind == 'socket': self.socket_inode = 902
                        if kind == 'daemon': self.daemon = 'different'
                    return original(service, args, deadline)
                with self.environment(), mock.patch.object(M.PEER, '_run', side_effect=changed), self.assertRaises(ValueError):
                    M.observe(self.service, self.connection, self.request)

    def test_harmless_health_log_updates_do_not_change_the_controller_definition(self):
        original = self.run_docker
        def changed(service, args, deadline):
            self.raw['State']['Health'] = {'Status': 'healthy', 'Log': [{'synthetic': len(self.requests)}]}
            return original(service, args, deadline)
        with self.environment(), mock.patch.object(M.PEER, '_run', side_effect=changed):
            self.assertEqual(M.observe(self.service, self.connection, self.request)['controller']['id'], CID)

    def test_absolute_deadline_covers_existing_host_observations_and_is_restored(self):
        observed = []
        def controller(*_args):
            observed.append(self.service.HOST.CAPTURE_READ_DEADLINE.get())
            return copy.deepcopy(self.controller)
        self.service.controller_capture_identity = controller
        with self.environment(): M.observe(self.service, self.connection, self.request)
        self.assertTrue(observed and all(type(value) is float for value in observed))
        self.assertEqual(len(set(observed)), 1)
        self.assertIsNone(self.service.HOST.CAPTURE_READ_DEADLINE.get())

    def test_unknown_selector_or_extra_fields_refuse_before_host_lock(self):
        for request in ({'appUrn': '../etc:store', 'nonce': NONCE}, {**self.request, 'path': '/etc'}, {**self.request, 'nonce': 'invalid'}):
            with self.assertRaises(ValueError): M.observe(self.service, self.connection, request)
        self.assertEqual(self.lock_entries, 0)

    def test_app_data_cannot_overlap_protected_host_or_recovery_storage(self):
        for base in ('/var/lib', '/var/lib/orbis-host/data', '/var/lib/orbis-sentinel/recovery', '/etc/orbis-sentinel',
                     '/proc', '/run/orbis/data', str(self.root), str(self.root / 'root-namespace/data')):
            with self.subTest(base=base), self.assertRaises(ValueError): M._data_scope(self.service, base)
        M._data_scope(self.service, str(self.base))

    def test_unrelated_mounts_do_not_change_the_operation_storage_binding(self):
        before = M._boundaries(M.mounts(self.host_mounts), M.mounts(self.main_mounts), str(self.base / 'store/demo'), '/app-data/store/demo')
        after = M._boundaries(M.mounts(self.host_mounts + row('/unrelated', 3)), M.mounts(self.main_mounts), str(self.base / 'store/demo'), '/app-data/store/demo')
        self.assertEqual(before, after)


class MountTableParserTests(unittest.TestCase):
    def test_unrelated_kernel_namespace_handles_preserve_storage_binding(self):
        host = b'1 0 8:1 / / rw - ext4 /dev/fixture rw\n'
        main = b'2 1 8:1 /fixture/app-data /app-data rw - ext4 /dev/fixture rw\n'
        before = M._boundaries(M.mounts(host), M.mounts(main), '/srv/app-data/store/app', '/app-data/store/app')
        for namespace in ('net', 'mnt', 'pid', 'ipc', 'uts', 'user', 'cgroup', 'time'):
            extra = f'3 1 0:4 {namespace}:[4026533000] /run/fixture-namespace rw - nsfs nsfs rw\n'.encode()
            with self.subTest(namespace=namespace):
                rows = M.mounts(host + extra)
                self.assertEqual(rows[-1]['root'], f'{namespace}:[4026533000]')
                self.assertEqual(M._boundaries(rows, M.mounts(main), '/srv/app-data/store/app', '/app-data/store/app'), before)

    def test_nonpath_roots_require_exact_kernel_namespace_syntax_and_nsfs(self):
        for root, filesystem in (('relative', 'ext4'), ('net:[4026533000]', 'ext4'),
                ('unknown:[4026533000]', 'nsfs'), ('net:[0]', 'nsfs'), ('net:[-1]', 'nsfs'),
                ('net:[0001]', 'nsfs'), ('net:[1]/suffix', 'nsfs'), ('net:[123456789012345678901]', 'nsfs')):
            with self.subTest(root=root, filesystem=filesystem), self.assertRaises(ValueError):
                M.mounts(f'1 0 0:4 {root} /run/fixture-namespace rw - {filesystem} nsfs rw\n'.encode())

    def test_namespace_mounts_never_back_application_data_or_escape_submount_checks(self):
        host = M.mounts(b'1 0 8:1 / / rw - ext4 /dev/fixture rw\n')
        main = M.mounts(b'2 1 8:1 /fixture/app-data /app-data rw - ext4 /dev/fixture rw\n')
        for location in ('/srv/app-data/store/app', '/srv/app-data/store/app/nested'):
            rows = M.mounts(f'3 1 0:4 net:[4026533000] {location} rw - nsfs nsfs rw\n'.encode())
            with self.subTest(location=location), self.assertRaises(ValueError):
                M._boundaries(host + rows, main, '/srv/app-data/store/app', '/app-data/store/app')
        namespace_backing = M.mounts(b'2 1 0:4 net:[4026533000] /app-data rw - nsfs nsfs rw\n')
        with self.assertRaises(ValueError): M._boundaries(host, namespace_backing, '/srv/app-data/store/app', '/app-data/store/app')


class RouteTests(unittest.TestCase):
    def dispatch(self, *, body=None, extra=(), trusted=True, declared=None, error=None):
        from test_orbis_host_sentinel_integration import SERVICE
        payload = json.dumps({'appUrn': 'demo:store', 'nonce': NONCE}).encode() if body is None else body
        handler = object.__new__(SERVICE.Handler)
        handler.path = '/v1/app-storage/observe'
        handler.headers = Message()
        for name, value in [('Host', 'orbis'), ('Content-Type', 'application/json'),
                            ('Content-Length', str(len(payload)) if declared is None else declared), *extra]:
            handler.headers[name] = value
        handler.connection, handler.send_json = mock.Mock(), mock.Mock()
        handler.rfile = io.BytesIO(payload)
        handler.server = SimpleNamespace(service=SimpleNamespace(credentials_only=False))
        module = SimpleNamespace(PEER=M.PEER, observe=mock.Mock(return_value={'observed': True}, side_effect=error))
        with mock.patch.object(SERVICE, 'trusted_capture_peer', return_value=trusted), mock.patch.object(SERVICE, 'load_script', return_value=module) as loaded:
            handler.do_POST()
        return handler, module, loaded

    def test_valid_bounded_body_dispatches_only_to_read_only_observer(self):
        handler, module, loaded = self.dispatch()
        self.assertEqual(handler.send_json.call_args.args, (200, {'observed': True}))
        module.observe.assert_called_once_with(handler.server.service, handler.connection, {'appUrn': 'demo:store', 'nonce': NONCE})
        self.assertEqual(loaded.call_args.args[0], 'orbis-host-app-storage.py')
        self.assertTrue(handler.close_connection)

    def test_untrusted_peer_bad_lengths_duplicate_and_encoded_headers_refuse_before_module_load(self):
        cases = [{'trusted': False}, {'declared': '0'}, {'declared': '1025'}, {'declared': '+90'}, {'declared': '0090'},
                 {'extra': [('Host', 'orbis')]}, {'extra': [('Content-Length', '2')]},
                 {'extra': [('Content-Encoding', 'gzip')]}, {'extra': [('Transfer-Encoding', 'chunked')]},
                 {'extra': [('Content-Type', 'text/plain')]}]
        for case in cases:
            with self.subTest(case=case):
                handler, module, loaded = self.dispatch(**case)
                self.assertEqual(handler.send_json.call_args.args, (409, {'error': 'The app storage binding could not be verified.'}))
                loaded.assert_not_called(); module.observe.assert_not_called()

    def test_truncated_and_duplicate_key_json_cannot_reach_the_observer(self):
        for payload, declared in ((b'{', '10'), (b'{"appUrn":"demo:store","appUrn":"other:store"}', None)):
            handler, module, _ = self.dispatch(body=payload, declared=declared)
            self.assertEqual(handler.send_json.call_args.args[0], 409)
            module.observe.assert_not_called()

    def test_observer_errors_never_return_private_exception_content(self):
        handler, _, _ = self.dispatch(error=ValueError('synthetic private path and environment detail'))
        self.assertEqual(handler.send_json.call_args.args, (409, {'error': 'The app storage binding could not be verified.'}))


class IdentifierCompatibilityTests(unittest.TestCase):
    def test_supported_identifiers_keep_their_exact_data_paths(self):
        value = {'Mounts': [{'Type': 'bind', 'Source': '/fixture/app-data', 'Destination': '/app-data', 'RW': True, 'Propagation': 'rprivate'}]}
        for urn in ['demo:store', 'demo:_user', 'demo:_private', 'Demo:My_store', '-demo:store', 'demo.v1:store-1', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx:store', 'demo:ssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss']:
            with self.subTest(urn=urn):
                name, store = urn.split(':')
                self.assertEqual(M._storage_paths(value, urn), ('/fixture/app-data', f'/fixture/app-data/{store}/{name}', f'/app-data/{store}/{name}'))

    def test_traversal_ambiguous_and_oversized_identifiers_refuse(self):
        value = {'Mounts': [{'Type': 'bind', 'Source': '/fixture/app-data', 'Destination': '/app-data', 'RW': True, 'Propagation': 'rprivate'}]}
        for urn in ['.:store', '..:store', 'demo:..', 'demo:.store', 'demo:store/other', 'demo:store\\other', 'demo:store:other', 'demo:/store', 'demo:store\x00', 'demo:\nstore', 'é:store', 'demo:%2e%2e', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx:store', 'demo:sssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss', 'demo:', ':store', 'demo:store\n', 'demo:store\r', 'demo:store\r\n', 'demo:store\u2028', 'demo:store\u2029']:
            with self.subTest(urn=urn), self.assertRaises(ValueError):
                M._storage_paths(value, urn)


if __name__ == '__main__': unittest.main()
