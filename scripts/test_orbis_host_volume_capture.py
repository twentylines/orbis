"""Root coordinator contract checks; namespace fixtures never read Docker _data."""
import copy
import hashlib
import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

BASE = Path(__file__).resolve().parent

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, BASE / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

V = module('orbis_volume_coordinator_tests', 'orbis-host-volume-capture.py')
A = module('orbis_volume_authority_tests', 'orbis-host-retained-authority.py')
A.OWNER = os.geteuid()
SOURCE, CONTROL, HOLDER = 'a' * 64, 'b' * 64, 'c' * 64
IMAGE = 'sha256:' + 'd' * 64
POINT = '12345678-1234-4123-8123-123456789abc'

class Missing(ValueError):
    status = 404


def mount(name='app-volume', target='/data', readonly=False):
    return {'Type': 'volume', 'Name': name, 'Source': '/never/read/docker/_data', 'Destination': target, 'Driver': 'local', 'Mode': 'ro' if readonly else 'z', 'RW': not readonly, 'Propagation': ''}


def container(identifier=SOURCE):
    return {'Id': identifier, 'Name': '/app' if identifier == SOURCE else '/controller', 'Image': IMAGE,
            'Config': {'Labels': {'com.docker.compose.project': 'app_store', 'com.docker.compose.service': 'web',
                                 'com.docker.compose.container-number': '1', 'com.docker.compose.oneoff': 'False',
                                 'runtipi.appurn': 'app:store', 'runtipi.managed': 'true'}} if identifier == SOURCE else {'Labels': {}},
            'HostConfig': {'AutoRemove': False}, 'Mounts': [mount()] if identifier == SOURCE else [],
            'State': {'Running': True, 'Paused': False, 'Restarting': False, 'StartedAt': '2026-11-01T01:00:00Z', 'Pid': 123}}


class Engine:
    def __init__(self):
        self.containers = {SOURCE: container(), CONTROL: container(CONTROL)}
        self.volume = {'Name': 'app-volume', 'Driver': 'local', 'Scope': 'local', 'Options': {}, 'Labels': {}, 'CreatedAt': '2026-01-01T00:00:00Z', 'Mountpoint': '/never/read/docker/_data'}
        self.calls, self.created, self.create_timeout = [], [], False
        self.volumes = {}
        self.image = {'Id': IMAGE, 'Config': {'Env': ['PATH=/usr/local/bin'], 'Labels': {'org.opencontainers.image.title': 'controller'}, 'ExposedPorts': {'3000/tcp': {}}}}
        self.hook = lambda *args: None

    def request(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        self.hook(method, path, body)
        if path == '/info':
            return {'ID': 'daemon-id'}
        if path.startswith('/images/'):
            return copy.deepcopy(self.image)
        if path == '/containers/json?all=1':
            return [{'Id': identifier} for identifier in self.containers]
        if path.startswith('/volumes/'):
            name = path.rsplit('/', 1)[1]
            return copy.deepcopy(self.volume if name == 'app-volume' else self.volumes[name])
        if path.startswith('/containers/create?name='):
            self.created.append(copy.deepcopy(body))
            name = path.split('=', 1)[1]
            config = {key: copy.deepcopy(value) for key, value in body.items() if key != 'HostConfig'}
            config['Env'] = copy.deepcopy(self.image['Config'].get('Env') or [])
            config['ExposedPorts'] = copy.deepcopy(self.image['Config'].get('ExposedPorts') or {})
            config['Labels'] = {**(self.image['Config'].get('Labels') or {}), **config['Labels']}
            raw = {'Id': HOLDER, 'Name': '/' + name, 'Image': IMAGE, 'Config': config,
                   'HostConfig': copy.deepcopy(body['HostConfig']), 'Mounts': [mount(body['HostConfig']['Mounts'][0]['Source'], '/orbis-volume', True)],
                   'State': {'Running': False, 'Paused': False, 'Restarting': False, 'StartedAt': '0001-01-01T00:00:00Z', 'Pid': 0}}
            self.containers[HOLDER] = raw
            if self.create_timeout:
                raise TimeoutError()
            return {'Id': HOLDER, 'Warnings': []}
        pieces = path.split('/')
        identifier = pieces[2].split('?')[0]
        if identifier not in self.containers:
            raise Missing()
        raw = self.containers[identifier]
        if method == 'DELETE':
            del self.containers[identifier]
            return None
        if path.endswith('/start'):
            raw['State'].update(Running=True, Pid=456, StartedAt='2026-11-05T00:00:00Z')
            return None
        if '/stop?' in path:
            raw['State']['Running'] = False
            raw['State']['Pid'] = 0
            return None
        if path.endswith('/json'):
            return copy.deepcopy(raw)
        raise AssertionError((method, path))


class Namespace:
    def __init__(self, directory):
        self.directory, self.on_read, self.opened = directory, lambda: None, []

    @contextmanager
    def open_reader(self, raw, volume):
        self.opened.append((raw['Id'], volume))
        self.on_read()
        descriptor = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            yield descriptor
        finally:
            os.close(descriptor)


class VolumeCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='volume-capture-test-')
        self.directory = Path(self.temporary.name)
        self.state = self.directory / 'state'
        self.state.mkdir(mode=0o700)
        self.contents = self.directory / 'contents'
        self.contents.mkdir(mode=0o700)
        self.engine = Engine()
        self.namespace = Namespace(self.contents)
        raw = {key: copy.deepcopy(self.engine.containers[SOURCE][key]) for key in ('Id', 'Name', 'Image', 'Config', 'HostConfig', 'Mounts')}
        self.runtime = {'schema': 'orbis.app-runtime-capture.v1', 'version': 1, 'pointId': POINT, 'rootSha256': 'e' * 64,
                        'dockerContextSha256': 'f' * 64, 'daemonSha256': hashlib.sha256(b'daemon-id').hexdigest(), 'sha256': '0' * 64,
                        'apps': [{'urn': 'app:store', 'project': 'app_store'}],
                        'containers': [{'appUrn': 'app:store', 'service': 'web', 'ordinal': 1, 'inspect': raw}]}
        self.valid = True
        def fixture_atomic(path, body):
            A.atomic(path, body)
            if sys.platform == 'darwin':
                # Initialize native tracking/hidden flags before protected-file seals.
                os.chflags(path, path.stat().st_flags | 0x40 | 0x8000, follow_symlinks=False)
        self.authority = SimpleNamespace(OWNER=A.OWNER, P=A.P, protected_directory=A.protected_directory,
                                         protected_file=A.protected_file, atomic=fixture_atomic)
        self.coordinator = self.make()

    def tearDown(self):
        self.temporary.cleanup()

    def make(self, **changes):
        args = dict(authority=self.authority, engine=self.engine, state_dir=self.state, runtime=self.runtime,
                    controller_id=CONTROL, image_id=IMAGE, guard=lambda: self.valid, namespace=self.namespace)
        args.update(changes)
        return V.VolumeCaptureCoordinator(**args)

    def stopped(self):
        plan = self.coordinator.prepare()
        self.engine.containers[SOURCE]['State']['Running'] = False
        return plan

    def record(self, name='holder.json'):
        return self.coordinator._load(name)

    def test_detached_stable_plan_and_protected_storage(self):
        plan = self.coordinator.prepare()
        self.assertEqual(plan['version'], 1)
        self.assertEqual(plan['volumes'][0]['sourceName'], 'app-volume')
        self.assertEqual(plan['volumes'][0]['key'], hashlib.sha256(b'orbis.backup-volume.v1\napp-volume').hexdigest())
        plan['volumes'].clear()
        self.assertEqual(len(self.coordinator.prepare()['volumes']), 1)
        saved = self.record('plan.json')
        self.assertEqual(saved['origin'], {key: self.runtime[key] for key in V.ORIGIN})
        self.assertNotIn('Mountpoint', saved['volumeIdentities']['app-volume'])
        self.assertEqual(stat.S_IMODE((self.coordinator.directory / 'plan.json').stat().st_mode), 0o600)
        self.assertNotIn('/never/read/docker/_data', json.dumps(saved['volumeIdentities']))

    def test_bad_runtime_shapes_and_labels(self):
        for key, value in [('pointId', '../escape'), ('daemonSha256', 'x'), ('apps', {}), ('version', True)]:
            with self.subTest(key=key):
                runtime = copy.deepcopy(self.runtime)
                runtime[key] = value
                with self.assertRaises(V.VolumeCaptureError):
                    self.make(runtime=runtime)
        runtime = copy.deepcopy(self.runtime)
        runtime['containers'][0]['inspect']['Config']['Labels']['runtipi.managed'] = 'false'
        with self.assertRaises(V.VolumeCaptureError):
            self.make(runtime=runtime)

    def test_same_point_different_origin_rejected(self):
        self.coordinator.prepare()
        runtime = copy.deepcopy(self.runtime)
        runtime['sha256'] = '1' * 64
        with self.assertRaises(V.VolumeCaptureError):
            self.make(runtime=runtime).prepare()

    def test_plan_tamper_and_permissions_rejected(self):
        self.stopped()
        path = self.coordinator.directory / 'plan.json'
        body = json.loads(path.read_bytes())
        body['consumers'] = {}
        A.atomic(path, A.P.canonical(body))
        with self.assertRaises(V.VolumeCaptureError):
            self.coordinator.verify_stopped()
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            self.coordinator.verify_stopped()

    def test_daemon_controller_source_and_volume_identity_changes(self):
        self.stopped()
        cases = [lambda: self.engine.containers[SOURCE]['Config'].update(User='root'),
                 lambda: self.engine.containers[CONTROL]['State'].update(StartedAt='new-controller'),
                 lambda: self.engine.volume.update(CreatedAt='recreated'),
                 lambda: self.engine.volume.update(Options={'type': 'nfs'})]
        original_containers, original_volume = copy.deepcopy(self.engine.containers), copy.deepcopy(self.engine.volume)
        for change in cases:
            self.engine.containers, self.engine.volume = copy.deepcopy(original_containers), copy.deepcopy(original_volume)
            change()
            with self.assertRaises(V.VolumeCaptureError):
                self.coordinator.verify_stopped()
        self.engine.containers, self.engine.volume = original_containers, original_volume
        self.runtime['daemonSha256'] = '9' * 64
        with self.assertRaises(V.VolumeCaptureError):
            self.make().prepare()

    def test_foreign_dormant_consumer_rejected_at_prepare_and_stopped(self):
        foreign = container('8' * 64)
        foreign['Mounts'] = [mount()]
        foreign['State']['Running'] = False
        self.engine.containers[foreign['Id']] = foreign
        with self.assertRaises(V.VolumeCaptureError):
            self.coordinator.prepare()
        del self.engine.containers[foreign['Id']]
        self.stopped()
        self.engine.containers[foreign['Id']] = foreign
        with self.assertRaises(V.VolumeCaptureError):
            self.coordinator.verify_stopped()

    def test_missing_or_unrepresented_app_container_rejected(self):
        raw = self.engine.containers.pop(SOURCE)
        with self.assertRaises(V.VolumeCaptureError):
            self.coordinator.prepare()
        self.engine.containers[SOURCE] = raw
        foreign = copy.deepcopy(raw)
        foreign['Id'] = '7' * 64
        self.engine.containers[foreign['Id']] = foreign
        with self.assertRaises(V.VolumeCaptureError):
            self.coordinator.prepare()

    def test_restart_between_stop_and_inventory_rejected(self):
        self.stopped()
        self.assertTrue(self.coordinator.verify_stopped())
        self.engine.containers[SOURCE]['State']['StartedAt'] = '2026-11-05T01:00:00Z'
        with self.assertRaises(V.VolumeCaptureError):
            self.coordinator.inventory()
        self.assertEqual(self.engine.created, [])

    def test_running_paused_restarting_autoremove_rejected(self):
        self.stopped()
        for key in ('Running', 'Paused', 'Restarting'):
            self.engine.containers[SOURCE]['State'][key] = True
            with self.assertRaises(V.VolumeCaptureError):
                self.coordinator.verify_stopped()
            self.engine.containers[SOURCE]['State'][key] = False
        self.engine.containers[SOURCE]['HostConfig']['AutoRemove'] = True
        with self.assertRaises(V.VolumeCaptureError):
            self.coordinator.verify_stopped()

    def test_subpath_nested_and_replica_divergence_rejected(self):
        for mode in ('subpath', 'nested', 'replica'):
            with self.subTest(mode=mode):
                raw = self.engine.containers[SOURCE]
                runtime = copy.deepcopy(self.runtime)
                engine = Engine()
                if mode == 'subpath':
                    engine.containers[SOURCE]['HostConfig']['Mounts'] = [{'Type': 'volume', 'VolumeOptions': {'Subpath': 'part'}}]
                elif mode == 'nested':
                    engine.containers[SOURCE]['Mounts'].append(mount('other', '/data/child'))
                else:
                    extra = copy.deepcopy(raw)
                    extra['Id'], extra['Name'] = '9' * 64, '/app2'
                    extra['Config']['Labels']['com.docker.compose.container-number'] = '2'
                    extra['Mounts'][0]['Name'] = 'replica-volume'
                    engine.containers[extra['Id']] = extra
                    runtime['containers'].append({'appUrn': 'app:store', 'service': 'web', 'ordinal': 2,
                                                  'inspect': {key: copy.deepcopy(extra[key]) for key in ('Id', 'Name', 'Image', 'Config', 'HostConfig', 'Mounts')}})
                runtime['containers'][0]['inspect'] = {key: copy.deepcopy(engine.containers[SOURCE][key]) for key in ('Id', 'Name', 'Image', 'Config', 'HostConfig', 'Mounts')}
                with self.assertRaises(V.VolumeCaptureError):
                    self.make(engine=engine, runtime=runtime).prepare()

    def test_fixed_holder_spec_inventory_receipt_and_cleanup(self):
        self.stopped()
        result = self.coordinator.inventory()
        self.assertEqual(result[0]['entries'], [{'name': '.', 'kind': 'directory'}])
        self.assertEqual(result[0]['containerId'], SOURCE)
        self.assertEqual(set(self.engine.containers), {SOURCE, CONTROL})
        self.assertIsNone(self.record())
        self.assertEqual(self.record('last-holder.json')['phase'], 'cleaned')
        self.assertEqual(self.record('inventory.json')['inventories'], result)
        spec = self.engine.created[0]
        self.assertEqual(spec['Image'], IMAGE)
        self.assertEqual(spec['Entrypoint'], ['/usr/local/bin/node'])
        self.assertEqual(spec['User'], '65534:65534')
        self.assertEqual(spec['Env'], [])
        host = spec['HostConfig']
        self.assertEqual(host['NetworkMode'], 'none')
        self.assertTrue(host['ReadonlyRootfs'])
        self.assertEqual(host['CapDrop'], ['ALL'])
        self.assertEqual(host['SecurityOpt'], ['no-new-privileges'])
        self.assertEqual(host['PidsLimit'], 32)
        self.assertEqual(host['Memory'], 128 * 1024 * 1024)
        self.assertFalse(host['AutoRemove'])
        self.assertEqual(host['Mounts'], [{'Type': 'volume', 'Source': 'app-volume', 'Target': '/orbis-volume', 'ReadOnly': True, 'VolumeOptions': {'NoCopy': True}}])
        self.assertNotIn('runtipi.managed', spec['Labels'])
        self.assertNotIn('runtipi.appurn', spec['Labels'])
        self.assertEqual(spec['Labels']['com.docker.compose.service'], 'orbis-volume-reader')
        mutations = [(method, path) for method, path, _ in self.engine.calls if method != 'GET']
        self.assertTrue(all(SOURCE not in path and CONTROL not in path for _, path in mutations))
        self.assertTrue(any(method == 'DELETE' and path.endswith('?v=false') for method, path in mutations))
        self.assertTrue(self.coordinator.verify_stopped())

    def test_holder_oom_false_to_null_preserves_generation_and_cleanup(self):
        self.stopped()
        def transition(method, path, body):
            if method == 'GET' and path == '/containers/' + HOLDER + '/json' and HOLDER in self.engine.containers:
                raw = self.engine.containers[HOLDER]
                raw['HostConfig']['OomKillDisable'] = None if raw['State']['Running'] else False
        self.engine.hook = transition
        result = self.coordinator.inventory()
        self.assertEqual(result[0]['entries'], [{'name': '.', 'kind': 'directory'}])
        self.assertEqual(set(self.engine.containers), {SOURCE, CONTROL})
        self.assertIsNone(self.record())
        self.assertEqual(self.record('last-holder.json')['phase'], 'cleaned')
        self.assertIs(self.record('last-holder.json')['static']['HostConfig']['OomKillDisable'], False)

    def test_holder_oom_false_to_true_rejects_changed_generation(self):
        self.stopped()
        def transition(method, path, body):
            if method == 'GET' and path == '/containers/' + HOLDER + '/json' and HOLDER in self.engine.containers:
                raw = self.engine.containers[HOLDER]
                raw['HostConfig']['OomKillDisable'] = raw['State']['Running']
        self.engine.hook = transition
        with self.assertRaises(V.VolumeCaptureError):
            self.coordinator.inventory()
        self.assertIn(HOLDER, self.engine.containers)
        self.assertEqual(self.record()['phase'], 'reconciliation-required')
        self.assertFalse(any(method == 'DELETE' or '/stop?' in path for method, path, _ in self.engine.calls))
        self.assertIsNone(self.record('inventory.json'))

    def test_create_intent_precedes_engine_and_ambiguous_create_never_retries(self):
        self.stopped()
        def check_intent(method, path, body):
            if '/containers/create?' in path:
                self.assertEqual(self.record()['phase'], 'create-intent')
                self.assertIsNone(self.record()['id'])
        self.engine.hook = check_intent
        self.engine.create_timeout = True
        with self.assertRaises(V.VolumeCaptureError):
            self.coordinator.inventory()
        self.assertEqual(self.record()['phase'], 'reconciliation-required')
        self.assertIn(HOLDER, self.engine.containers)
        with self.assertRaises(V.VolumeCaptureError):
            self.make().inventory()
        self.assertEqual(len(self.engine.created), 1)
        self.assertFalse(any(method == 'DELETE' for method, _, _ in self.engine.calls))

    def test_cancellation_during_scan_cleans_owned_holder(self):
        self.stopped()
        self.namespace.on_read = lambda: setattr(self, 'valid', False)
        with self.assertRaises(Exception):
            self.coordinator.inventory()
        self.assertEqual(set(self.engine.containers), {SOURCE, CONTROL})
        self.assertIsNone(self.record())

    def test_post_create_cancellation_persists_id_and_cleans(self):
        self.stopped()
        def cancel(method, path, body):
            if '/containers/create?' in path:
                self.valid = False
        self.engine.hook = cancel
        with self.assertRaises(Exception):
            self.coordinator.inventory()
        self.assertNotIn(HOLDER, self.engine.containers)
        self.assertIsNone(self.record())

    def test_source_changes_during_scan_rejected_after_cleanup(self):
        self.stopped()
        self.namespace.on_read = lambda: self.engine.containers[SOURCE]['State'].update(StartedAt='restarted')
        with self.assertRaises(V.VolumeCaptureError):
            self.coordinator.inventory()
        self.assertNotIn(HOLDER, self.engine.containers)
        self.assertIsNone(self.record('inventory.json'))

    def test_lost_ownership_refuses_cleanup_and_keeps_recovery_record(self):
        self.stopped()
        self.namespace.on_read = lambda: self.engine.containers[HOLDER]['Config']['Labels'].update({'org.orbis.nonce': 'foreign'})
        with self.assertRaises(V.VolumeCaptureError):
            self.coordinator.inventory()
        self.assertIn(HOLDER, self.engine.containers)
        self.assertEqual(self.record()['phase'], 'reconciliation-required')
        self.assertFalse(any(method == 'DELETE' or '/stop?' in path for method, path, _ in self.engine.calls))

    def test_installed_image_declared_volumes_rejected_before_create(self):
        self.stopped()
        self.engine.image['Config']['Volumes'] = {'/anonymous': {}}
        with self.assertRaises(V.VolumeCaptureError):
            self.coordinator.inventory()
        self.assertEqual(self.engine.created, [])
        self.assertIsNone(self.record())

    def test_nonempty_intent_without_id_requires_explicit_reconciliation(self):
        self.stopped()
        self.coordinator._save('holder.json', {'id': None, 'phase': 'create-intent'})
        with self.assertRaises(V.VolumeCaptureError):
            self.coordinator.inventory()
        self.assertEqual(self.engine.created, [])

    def test_cached_bytes_are_never_returned_after_source_change(self):
        self.stopped()
        self.coordinator.inventory()
        self.engine.containers[SOURCE]['State']['Running'] = True
        with self.assertRaises(V.VolumeCaptureError):
            self.coordinator.inventory()
        self.assertEqual(len(self.engine.created), 1)

    def test_foreign_bind_alias_of_selected_volume_rejected(self):
        foreign = container('8' * 64)
        foreign['Mounts'] = [{'Type': 'bind', 'Source': '/never/read/docker/_data/subdirectory', 'Destination': '/foreign', 'RW': True}]
        foreign['State']['Running'] = False
        self.engine.containers[foreign['Id']] = foreign
        with self.assertRaises(V.VolumeCaptureError):
            self.coordinator.prepare()

    def test_duplicate_runtime_service_ordinal_rejected(self):
        runtime = copy.deepcopy(self.runtime)
        extra = copy.deepcopy(runtime['containers'][0])
        extra['inspect']['Id'], extra['inspect']['Name'] = '8' * 64, '/duplicate'
        runtime['containers'].append(extra)
        with self.assertRaises(V.VolumeCaptureError):
            self.make(runtime=runtime)

    def second_volume(self):
        self.engine.containers[SOURCE]['Mounts'].append(mount('second-volume', '/cache'))
        self.runtime['containers'][0]['inspect']['Mounts'] = copy.deepcopy(self.engine.containers[SOURCE]['Mounts'])
        self.engine.volumes['second-volume'] = {**self.engine.volume, 'Name': 'second-volume'}
        self.coordinator = self.make()

    def test_aggregate_entry_budget_refuses_multiple_volume_overflow(self):
        self.second_volume()
        (self.contents / 'child').mkdir()
        self.stopped()
        # Each real FD scan contains two directories; the second receives one slot.
        with patch.object(V, 'MAX_ENTRIES', 3):
            with self.assertRaises(Exception):
                self.coordinator.inventory()
        self.assertEqual(len(self.engine.created), 2)
        self.assertEqual(set(self.engine.containers), {SOURCE, CONTROL})
        self.assertIsNone(self.record('inventory.json'))
        self.assertIsNone(self.record())

    def test_aggregate_path_budget_refuses_multiple_volume_overflow(self):
        self.second_volume()
        (self.contents / 'child').mkdir()
        self.stopped()
        # Root + child names consume six bytes on each independent volume.
        with patch.object(V, 'MAX_PATH_BYTES', 11):
            with self.assertRaises(Exception):
                self.coordinator.inventory()
        self.assertEqual(set(self.engine.containers), {SOURCE, CONTROL})
        self.assertIsNone(self.record('inventory.json'))

    def test_remaining_file_budget_is_passed_into_next_scanner(self):
        self.second_volume()
        self.stopped()
        budgets = []
        def scan(descriptor, **kwargs):
            budgets.append((kwargs['maximum_entries'], kwargs['maximum_path_bytes'], kwargs['maximum_bytes']))
            if len(budgets) == 2:
                raise V._SCAN.VolumeInventoryError('remaining file bytes exhausted')
            return [{'name': '.', 'kind': 'directory'}, {'name': 'file', 'kind': 'file', 'bytes': 7, 'sha256': '1' * 64}]
        with patch.object(V, 'MAX_FILE_BYTES', 10), patch.object(V._SCAN, 'scan_directory', scan):
            with self.assertRaises(V._SCAN.VolumeInventoryError):
                self.coordinator.inventory()
        self.assertEqual(budgets, [(250000, 33554432, 10), (249998, 33554427, 3)])
        self.assertEqual(set(self.engine.containers), {SOURCE, CONTROL})
        self.assertIsNone(self.record('inventory.json'))

    def test_large_inventory_receipt_has_separate_node_bound(self):
        self.stopped()
        # Synthetic scanner output avoids creating 60k fixture directories on disk.
        entries = [{'name': '.', 'kind': 'directory'}] + [{'name': 'directory-' + str(index), 'kind': 'directory'} for index in range(60000)]
        with self.assertRaises(V.VolumeCaptureError):
            V._bounded(entries)
        with patch.object(V._SCAN, 'scan_directory', return_value=entries):
            result = self.coordinator.inventory()
        self.assertEqual(len(result[0]['entries']), 60001)
        self.assertEqual(len(self.record('inventory.json')['inventories'][0]['entries']), 60001)
        self.assertIsNone(self.record())
        self.assertLess((self.coordinator.directory / 'inventory.json').stat().st_size, V.INVENTORY_LIMIT)

    def test_deadline_fails_before_engine_io(self):
        with patch.object(V.time, 'monotonic', side_effect=[0, 0, 301]):
            with self.assertRaises(V.VolumeCaptureError):
                self.coordinator.prepare()
        self.assertEqual(self.engine.calls, [])

    def test_namespace_proc_parsing_full_id_and_readonly_mount(self):
        proc = self.directory / 'proc'
        proc.mkdir()
        fields = ['S'] + ['0'] * 18 + ['1234']
        (proc / 'stat').write_text('456 (node with spaces) ' + ' '.join(fields))
        (proc / 'cgroup').write_text('0::/system.slice/docker-' + HOLDER + '.scope\n')
        (proc / 'mountinfo').write_text('55 1 0:42 /vol /orbis-volume ro,nosuid - ext4 /dev/sda rw\n')
        fd = os.open(proc, os.O_RDONLY | os.O_DIRECTORY)
        namespace = V.LinuxVolumeNamespace(self.engine)
        try:
            self.assertEqual(namespace._process(fd, HOLDER)[0], '1234')
            (proc / 'cgroup').write_text('0::/prefix' + HOLDER + 'suffix\n')
            with self.assertRaises(V.VolumeCaptureError):
                namespace._process(fd, HOLDER)
            (proc / 'cgroup').write_text('0::/docker/' + HOLDER + '\n')
            (proc / 'mountinfo').write_text('55 1 0:42 /vol /orbis-volume rw - ext4 /dev/sda rw\n')
            with self.assertRaises(V.VolumeCaptureError):
                namespace._process(fd, HOLDER)
        finally:
            os.close(fd)

    @unittest.skipUnless(sys.platform == 'linux', 'Regular-file scanner requires Linux O_PATH/proc; macOS exercises empty real FD inventory.')
    def test_real_linux_file_scanner_via_injected_verified_fd(self):
        (self.contents / 'payload').write_bytes(b'volume payload')
        self.stopped()
        entries = self.coordinator.inventory()[0]['entries']
        self.assertEqual(entries[1], {'name': 'payload', 'kind': 'file', 'bytes': 14, 'sha256': hashlib.sha256(b'volume payload').hexdigest()})

if __name__ == '__main__':
    unittest.main()
