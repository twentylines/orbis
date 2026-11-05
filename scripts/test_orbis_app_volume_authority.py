import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location('app_volume_authority', Path(__file__).with_name('orbis-app-volume-authority.py'))
A = importlib.util.module_from_spec(spec)
spec.loader.exec_module(A)
REQUIRE_ROOT = A._operator

GENERATION = '11111111-1111-4111-8111-111111111111'
PREPARED = '22222222-2222-4222-8222-222222222222'
RESTORE = '33333333-3333-4333-8333-333333333333'
NONCE = '44444444-4444-4444-8444-444444444444'
UPLOADER = '55555555-5555-4555-8555-555555555555'
OTHER = '66666666-6666-4666-8666-666666666666'


def sha(body):
    return hashlib.sha256(body.encode() if isinstance(body, str) else body).hexdigest()


def wire(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()


def pin_bytes(volume, *, urn='test:store', services=None):
    services = services or [{'name': 'web', 'mounts': [{'target': '/data', 'volume': volume, 'readOnly': False}]}]
    pin = {'version': 1, 'appUrn': urn, 'project': urn.replace(':', '_'), 'services': services}
    names = sorted({mount['volume'] for service in services for mount in service['mounts']})
    local = {name: 'orbis_retained_' + sha(name) for name in names}
    return wire({'x-orbis-volume-pin': pin, 'services': {
        service['name']: {'volumes': [{'type': 'volume', 'source': local[mount['volume']], 'target': mount['target'],
                                      'read_only': mount['readOnly'], 'volume': {'nocopy': True}} for mount in service['mounts']]}
        for service in services}, 'volumes': {local[name]: {'external': True, 'name': name} for name in names}})


class FakeEngine:
    def __init__(self, volume):
        self.volume = volume
        self.containers = {}
        self.daemon = 'daemon-test'
        self.calls = []
        self.after = None

    def request(self, method, route):
        if method != 'GET':
            raise AssertionError('authority observation must not mutate Docker')
        self.calls.append(route)
        if route == '/info':
            value = {'ID': self.daemon}
        elif route.startswith('/volumes/'):
            if route[len('/volumes/'):] != self.volume['Name']:
                raise AssertionError('unexpected volume')
            value = self.volume
        elif route == '/containers/json?all=1':
            value = [{'Id': identifier} for identifier in self.containers]
        elif route.startswith('/containers/') and route.endswith('/json'):
            value = self.containers[route.split('/')[2]]
        else:
            raise AssertionError(route)
        if self.after:
            self.after(route)
        return copy.deepcopy(value)


class PinTests(unittest.TestCase):
    def test_exact_render_and_custom_store(self):
        for urn in ('test:store', 'test:_user'):
            body = pin_bytes('restored-data', urn=urn)
            self.assertEqual(A.decode_pins(body)['appUrn'], urn)
        for urn in ('test:_other', '../test:store', 'Test:store'):
            with self.assertRaises(A.AuthorityError):
                A.decode_pins(pin_bytes('restored-data', urn=urn))
        document = json.loads(pin_bytes('restored-data'))
        pins = document['x-orbis-volume-pin']
        document['x-orbis-volume-pin'] = {key: pins[key] for key in ('appUrn', 'services', 'project', 'version')}
        self.assertEqual(A.decode_pins(wire(document))['appUrn'], 'test:store')

    def test_full_render_is_checked_not_only_inner_extension(self):
        body = pin_bytes('restored-data')
        document = json.loads(body)
        mutations = []
        value = copy.deepcopy(document); value['services']['web']['volumes'][0]['source'] = 'source-volume'; mutations.append(value)
        value = copy.deepcopy(document); value['volumes'][next(iter(value['volumes']))]['external'] = False; mutations.append(value)
        value = copy.deepcopy(document); value['services']['web']['volumes'][0]['volume']['nocopy'] = False; mutations.append(value)
        value = copy.deepcopy(document); value['extra'] = True; mutations.append(value)
        for value in mutations:
            with self.assertRaises(A.AuthorityError): A.decode_pins(wire(value))
        for value in (body + b'\n', b' ' + body, body.replace(b'"version":1', b'"version":1,"version":1'), b'\xff'):
            with self.assertRaises(A.AuthorityError): A.decode_pins(value)

    def test_unsafe_targets_names_and_overlap(self):
        for target in ('/', '//data', '/data/', '/data/../else', '/proc/x', '/sys', '/dev/x', '/a:b', '/a$b', '/a\\b', '/a\n', '/a\x7f'):
            services = [{'name': 'web', 'mounts': [{'target': target, 'volume': 'fresh', 'readOnly': False}]}]
            with self.assertRaises(A.AuthorityError): A.decode_pins(pin_bytes('fresh', services=services))
        for volume in ('../source', '-source', 'source/name', 'a' * 256):
            with self.assertRaises(A.AuthorityError): A.decode_pins(pin_bytes(volume))
        mounts = [{'target': '/data', 'volume': 'fresh', 'readOnly': False}, {'target': '/data/child', 'volume': 'fresh', 'readOnly': True}]
        with self.assertRaises(A.AuthorityError): A.decode_pins(pin_bytes('fresh', services=[{'name': 'web', 'mounts': mounts}]))

    def test_sorted_services_mounts_and_types(self):
        for services in ([{'name': 'web', 'mounts': []}],
                         [{'name': 'web', 'mounts': [{'target': '/data', 'volume': 'fresh', 'readOnly': 1}]}],
                         [{'name': 'z', 'mounts': [{'target': '/data', 'volume': 'fresh', 'readOnly': False}]},
                          {'name': 'a', 'mounts': [{'target': '/data', 'volume': 'fresh', 'readOnly': False}]}]):
            with self.assertRaises(A.AuthorityError): A.decode_pins(pin_bytes('fresh', services=services))

    def test_numeric_service_property_order_matches_javascript(self):
        services = [{'name': name, 'mounts': [{'target': '/data', 'volume': 'fresh', 'readOnly': False}]} for name in ('10', '2')]
        document = json.loads(pin_bytes('fresh', services=services))
        # JS puts integer property names in numeric order, even when pins list is lexical.
        document['services'] = {'2': document['services']['2'], '10': document['services']['10']}
        self.assertEqual(A.decode_pins(wire(document))['services'][0]['name'], '10')
        with self.assertRaises(A.AuthorityError): A.decode_pins(pin_bytes('fresh', services=services))
        mounts = [{'target': target, 'volume': 'fresh', 'readOnly': False} for target in ('/\U00010000', '/\ue000')]
        self.assertEqual(len(A.decode_pins(pin_bytes('fresh', services=[{'name': 'web', 'mounts': mounts}]))['services'][0]['mounts']), 2)


class AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='app-volume-authority-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.base.chmod(0o700)
        self.root = self.base / 'installation'; self.root.mkdir(mode=0o775)
        self.state = self.base / 'state'; self.state.mkdir(mode=0o700)
        self.mount = self.base / 'mountinfo'
        self.mount.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n')
        for obj, key, value in ((A, 'OWNER', os.geteuid()), (A.LAYOUT, 'STATE_ROOT', self.state)):
            patch = mock.patch.object(obj, key, value); patch.start(); self.addCleanup(patch.stop)
        if os.geteuid() != 0:
            for obj in (A, A.LAYOUT):
                patch = mock.patch.object(obj, '_operator'); patch.start(); self.addCleanup(patch.stop)
        plan = A.LAYOUT.review(self.root, 'daemon-test', 'local', self.mount)
        A.LAYOUT.prepare(self.root, 'daemon-test', 'local', A.LAYOUT.plan_sha256(plan), self.mount)
        self.lock = os.open(A.LAYOUT.legacy_path(self.root, 'host-lock'), os.O_RDWR | os.O_NOFOLLOW)
        self.addCleanup(os.close, self.lock)
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.source_name = 'old-source'
        self.key = sha('orbis.backup-volume.v1\n' + self.source_name)
        self.target_name = 'orbis-restore-' + PREPARED + '-' + self.key
        labels = {'org.orbis.role': 'volume-restore', 'org.orbis.restore': RESTORE,
                  'org.orbis.generation': PREPARED, 'org.orbis.volume-key': self.key}
        self.volume = dict(Name=self.target_name, CreatedAt='2026-11-05T00:00:00Z', Driver='local', Scope='local',
                           Options=None, Labels=labels, Mountpoint='/var/lib/docker/volumes/' + self.target_name + '/_data')
        identity = dict(name=self.volume['Name'], createdAt=self.volume['CreatedAt'], driver='local', scope='local',
                        options={}, labels=labels, mountpoint=self.volume['Mountpoint'])
        self.target = dict(key=self.key, sourceName=self.source_name, targetName=self.target_name, archiveSha256='a' * 64,
                           inventorySha256='b' * 64, uploaderName='orbis-volume-restore-' + UPLOADER, uploaderId='c' * 64,
                           state='ready', volumeIdentity=A.plan_sha256(identity), containerIdentity='d' * 64, verificationSha256='e' * 64)
        self.engine = FakeEngine(self.volume)
        self.adapter = A.LocalDockerAdapter(self.engine)
        self.options = dict(restore_source_sha256='f' * 64,
            restore=dict(restoreId=RESTORE, nonce=NONCE, imageId='sha256:' + '9' * 64,
                         manifestSha256='8' * 64, preparedReceiptSha256='7' * 64),
            prepared_generation=PREPARED, generation=GENERATION, pin_documents=[pin_bytes(self.target_name)],
            expected_targets=[self.target], adapter=self.adapter, mountinfo=self.mount)

    def review(self, **changes):
        return A.review(self.root, 'daemon-test', 'local', **{**self.options, **changes})

    def stage(self, **changes):
        options = {**self.options, **changes}
        digest = A.plan_sha256(A.review(self.root, 'daemon-test', 'local', **options))
        return A.stage(self.root, 'daemon-test', 'local', approved_plan_sha256=digest, held_lock_fd=self.lock, **options)

    def verify(self, generation=GENERATION):
        return A.verify(self.root, 'daemon-test', 'local', generation, adapter=self.adapter, mountinfo=self.mount)

    def current(self):
        return A.current(self.root, 'daemon-test', 'local', adapter=self.adapter, mountinfo=self.mount)

    def select(self, generation=GENERATION, previous=None):
        plan = A.review_selection(self.root, 'daemon-test', 'local', generation, expected_current_sha256=previous,
                                  adapter=self.adapter, mountinfo=self.mount)
        return A.activate_cas(self.root, 'daemon-test', 'local', generation, expected_current_sha256=previous,
                              approved_plan_sha256=A.plan_sha256(plan), adapter=self.adapter, held_lock_fd=self.lock, mountinfo=self.mount)

    def add_container(self, mounts=None, *, identifier='1' * 64, labels=None, host=None):
        self.engine.containers[identifier] = dict(Id=identifier, Mounts=mounts or [], HostConfig=host or {},
                                                 Config={'Labels': labels or {}})

    def test_review_is_readonly_and_root_is_required(self):
        plan = self.review()
        self.assertEqual(plan, self.review())
        self.assertFalse(A.store_path(self.root).exists())
        self.assertIsNone(self.current())
        with mock.patch.object(A.os, 'geteuid', return_value=12345):
            with self.assertRaises(A.AuthorityError):
                REQUIRE_ROOT()

    def test_exact_plan_required_before_any_generation_mutation(self):
        plan = self.review()
        with self.assertRaises(A.AuthorityError):
            A.stage(self.root, 'daemon-test', 'local', approved_plan_sha256='0' * 64, held_lock_fd=self.lock, **self.options)
        self.assertFalse(A.store_path(self.root).exists())
        changed = {**self.options, 'restore_source_sha256': '1' * 64}
        with self.assertRaises(A.AuthorityError):
            A.stage(self.root, 'daemon-test', 'local', approved_plan_sha256=A.plan_sha256(plan), held_lock_fd=self.lock, **changed)
        with self.assertRaises(A.AuthorityError): self.review(unused=False)
        self.assertFalse(A.store_path(self.root).exists())

    def test_complete_stage_marker_modes_and_idempotence(self):
        result = self.stage()
        self.assertEqual(self.stage(), result)
        self.assertIsNone(self.current())
        source = Path(result['source'])
        marker = json.loads((source / 'authority.json').read_bytes())
        self.assertEqual(set(marker), {'version', 'schema', 'generation', 'files'})
        self.assertEqual(marker['schema'], 'orbis.app-volume-authority.v1')
        name = sha('test:store') + '.json'
        self.assertEqual(marker['files'], {name: sha(self.options['pin_documents'][0])})
        binding = json.loads((source / 'binding.json').read_bytes())
        self.assertEqual(binding['plan']['restore'], self.options['restore'])
        self.assertEqual(binding['plan']['preparedGeneration'], PREPARED)
        for path in [A.store_path(self.root), source.parent, source, source / 'pins']:
            self.assertEqual(path.stat().st_mode & 0o7777, 0o700)
        for path in [source / 'authority.json', source / 'binding.json', source / 'pins' / name]:
            self.assertEqual(path.stat().st_mode & 0o7777, 0o600)
        self.assertTrue(all(not route.startswith('/volumes/' + self.source_name) for route in self.engine.calls))

    def test_source_names_missing_extra_duplicate_target_and_untrusted_path_fail(self):
        for changes in ({'pin_documents': [pin_bytes(self.source_name)]},
                        {'pin_documents': [pin_bytes(self.target_name), pin_bytes(self.target_name)]},
                        {'expected_targets': [self.target, self.target]},
                        {'restore_source_sha256': '/untrusted/archive'},
                        {'expected_targets': [{**self.target, 'archiveSha256': 'bad'}]},
                        {'expected_targets': [{**self.target, 'targetName': self.source_name}]}):
            with self.assertRaises(A.AuthorityError): self.review(**changes)
        self.assertFalse(A.store_path(self.root).exists())

    def test_generation_plan_binds_manifest_receipt_and_target_archive_inventory(self):
        initial = A.plan_sha256(self.review())
        for restore_key in ('restoreId', 'nonce', 'manifestSha256', 'preparedReceiptSha256', 'imageId'):
            changed = dict(self.options['restore'])
            changed[restore_key] = OTHER if restore_key in ('restoreId', 'nonce') else '0' * 64
            if restore_key == 'imageId': changed[restore_key] = 'sha256:' + '0' * 64
            if restore_key == 'restoreId':
                with self.assertRaises(A.AuthorityError): self.review(restore=changed)
            else:
                self.assertNotEqual(A.plan_sha256(self.review(restore=changed)), initial)
        for key in ('archiveSha256', 'inventorySha256', 'verificationSha256'):
            changed = {**self.target, key: '0' * 64}
            self.assertNotEqual(A.plan_sha256(self.review(expected_targets=[changed])), initial)

    def test_interrupted_stage_preserved_without_selector_or_replacement(self):
        original = A._write_new
        def interrupted(directory, name, body):
            if name == 'binding.json': raise OSError('simulated fsync interruption')
            return original(directory, name, body)
        with mock.patch.object(A, '_write_new', side_effect=interrupted):
            with self.assertRaises(OSError): self.stage()
        source = A.store_path(self.root) / 'generations' / GENERATION
        self.assertTrue((source / 'authority.json').exists())
        inode = source.stat().st_ino
        with self.assertRaises((A.AuthorityError, FileNotFoundError)): self.stage()
        self.assertEqual(source.stat().st_ino, inode)
        self.assertIsNone(self.current())

    def test_mutation_after_writes_never_seals_generation(self):
        original = A._write_new
        def changed(directory, name, body):
            original(directory, name, body)
            if name == 'authority.json': self.engine.daemon = 'changed'
        with mock.patch.object(A, '_write_new', side_effect=changed):
            with self.assertRaises(A.AuthorityError): self.stage()
        source = A.store_path(self.root) / 'generations' / GENERATION
        self.assertTrue((source / 'authority.json').exists())
        self.assertFalse((source / 'binding.json').exists())

    def test_invalid_existing_generation_not_repaired_or_overwritten(self):
        result = self.stage()
        file = Path(result['source']) / 'authority.json'
        file.write_bytes(b'{}')
        with self.assertRaises(A.AuthorityError): self.stage()
        self.assertEqual(file.read_bytes(), b'{}')

    def test_tampering_permissions_hardlinks_extra_files_and_symlinks(self):
        result = self.stage()
        source = Path(result['source'])
        marker = source / 'authority.json'
        marker.chmod(0o644)
        with self.assertRaises(A.AuthorityError): self.verify()
        marker.chmod(0o600)
        os.link(marker, source / 'hardlink')
        with self.assertRaises(A.AuthorityError): self.verify()
        (source / 'hardlink').unlink()
        (source / 'extra').write_bytes(b'private evidence')
        with self.assertRaises(A.AuthorityError): self.verify()
        (source / 'extra').unlink()
        original = marker.read_bytes(); marker.unlink(); marker.symlink_to(source / 'binding.json')
        with self.assertRaises((A.AuthorityError, OSError)): self.verify()
        marker.unlink(); marker.write_bytes(original); marker.chmod(0o600)
        self.assertEqual(self.verify()['markerSha256'], result['markerSha256'])

    def test_layout_identity_context_daemon_and_storage_mount_changes(self):
        self.stage()
        for daemon, context in [('changed', 'local'), ('daemon-test', 'changed')]:
            with self.assertRaises(ValueError): A.verify(self.root, daemon, context, GENERATION, adapter=self.adapter, mountinfo=self.mount)
        self.mount.write_text('1 0 8:2 / / rw - ext4 /dev/other rw\n')
        with self.assertRaises(ValueError): self.verify()

    def test_inherited_lock_capability_and_real_contention(self):
        self.stage()
        for invalid in (True, False, -1):
            with self.assertRaises((A.AuthorityError, OSError)):
                A.stage(self.root, 'daemon-test', 'local', approved_plan_sha256=A.plan_sha256(self.review()), held_lock_fd=invalid, **self.options)
        foreign = self.base / 'foreign.lock'; foreign.write_bytes(b''); foreign.chmod(0o600)
        descriptor = os.open(foreign, os.O_RDWR)
        try:
            with self.assertRaises(A.AuthorityError):
                with A._locked(self.root, descriptor): pass
        finally: os.close(descriptor)
        contender = os.open(A.LAYOUT.legacy_path(self.root, 'host-lock'), os.O_RDWR)
        try:
            with self.assertRaises(BlockingIOError):
                with A._locked(self.root, contender): pass
        finally: os.close(contender)

    def test_cas_stale_approval_idempotence_retained_rollback(self):
        original = self.stage()
        selection = A.review_selection(self.root, 'daemon-test', 'local', GENERATION, expected_current_sha256=None,
                                      adapter=self.adapter, mountinfo=self.mount)
        digest = A.plan_sha256(selection)
        with self.assertRaises(A.AuthorityError):
            A.activate_cas(self.root, 'daemon-test', 'local', GENERATION, expected_current_sha256=None,
                           approved_plan_sha256='0' * 64, adapter=self.adapter, held_lock_fd=self.lock, mountinfo=self.mount)
        first = self.select()
        again = A.activate_cas(self.root, 'daemon-test', 'local', GENERATION, expected_current_sha256=None,
            approved_plan_sha256=digest, adapter=self.adapter, held_lock_fd=self.lock, mountinfo=self.mount)
        self.assertEqual(first, again)
        self.stage(generation=OTHER)
        with self.assertRaises(A.AuthorityError): self.select(OTHER, previous=None)
        second = self.select(OTHER, first['currentSha256'])
        with self.assertRaises(A.AuthorityError): self.select(GENERATION, first['currentSha256'])
        rollback = self.select(GENERATION, second['currentSha256'])
        self.assertNotEqual(rollback['currentSha256'], first['currentSha256'])
        self.assertEqual(rollback['bindingSha256'], original['bindingSha256'])
        self.assertTrue((Path(original['source']).parent / OTHER / 'binding.json').exists())

    def test_selector_rename_failure_preserves_staging_and_old_current(self):
        self.stage(); first = self.select()
        self.stage(generation=OTHER)
        with mock.patch.object(A.os, 'replace', side_effect=OSError('simulated rename failure')):
            with self.assertRaises(OSError): self.select(OTHER, first['currentSha256'])
        self.assertEqual(self.current(), first)
        self.assertEqual(len(list(A.store_path(self.root).glob('.selection-*.json'))), 1)
        self.assertEqual(self.select(OTHER, first['currentSha256'])['generation'], OTHER)

    def test_selector_corruption_never_falls_back(self):
        self.stage(); self.select()
        marker = A.store_path(self.root) / 'current.json'
        marker.write_bytes(b'{}')
        with self.assertRaises(A.AuthorityError): self.current()
        with self.assertRaises(A.AuthorityError): self.select()

    def test_local_target_driver_labels_identity_and_uploaders_rechecked(self):
        for key, value in (('Driver', 'plugin'), ('Scope', 'global'), ('Options', {'device': '/source'}),
                           ('Labels', {}), ('CreatedAt', 'changed'), ('Mountpoint', '/other')):
            original = self.volume[key]; self.volume[key] = value
            with self.assertRaises(A.AuthorityError): self.review()
            self.volume[key] = original
        self.assertFalse(A._created_at('2026-99-99T25:00:00Z'))
        self.add_container(identifier=self.target['uploaderId'])
        with self.assertRaises(A.AuthorityError): self.review()

    def test_foreign_bind_alias_target_usage_and_known_app_consumers(self):
        self.stage()
        mount = dict(Type='volume', Name=self.target_name, Source=self.volume['Mountpoint'], Destination='/data', RW=True, Driver='local')
        self.add_container([mount])
        with self.assertRaises(A.AuthorityError): self.review()
        with self.assertRaises(A.AuthorityError): self.verify()
        self.engine.containers['1' * 64]['Config']['Labels'] = {'com.docker.compose.project': 'test_store', 'com.docker.compose.service': 'web'}
        self.assertEqual(self.verify()['generation'], GENERATION)
        with self.assertRaises(A.AuthorityError): self.select()
        self.engine.containers['1' * 64]['Mounts'] = [dict(Type='bind', Source=self.volume['Mountpoint'], Destination='/other', RW=False)]
        with self.assertRaises(A.AuthorityError): self.review()

    def test_authority_writable_ancestor_and_exact_readonly_generation_bind(self):
        result = self.stage()
        self.add_container([dict(Type='bind', Source=str(A.store_path(self.root).parent), Destination='/state', RW=True)])
        with self.assertRaises(A.AuthorityError): self.verify()
        self.engine.containers['1' * 64]['Mounts'] = [dict(Type='bind', Source=result['source'], Destination='/data/orbis-volumes', RW=False)]
        self.assertEqual(self.verify()['generation'], GENERATION)
        self.engine.containers['1' * 64]['Mounts'][0]['RW'] = True
        with self.assertRaises(A.AuthorityError): self.verify()

    def test_pending_configured_alias_and_symlink_bind_refused(self):
        result = self.stage()
        self.add_container(host={'Binds': [result['source'] + ':/data/orbis-volumes:rw']})
        with self.assertRaises(A.AuthorityError): self.verify()
        self.engine.containers['1' * 64]['HostConfig'] = {'Mounts': [dict(Type='bind', Source=result['source'], Target='/data/orbis-volumes', ReadOnly=False)]}
        with self.assertRaises(A.AuthorityError): self.verify()
        alias = self.base / 'authority-alias'; alias.symlink_to(result['source'])
        self.engine.containers['1' * 64]['HostConfig'] = {}
        self.engine.containers['1' * 64]['Mounts'] = [dict(Type='bind', Source=str(alias), Destination='/hidden', RW=True)]
        with self.assertRaises(A.AuthorityError): self.verify()

    def test_host_writable_alias_nested_mount_and_ephemeral_refused(self):
        self.stage()
        namespace = str(A.LAYOUT.namespace(self.root))
        for line in ('2 1 8:1 ' + namespace + ' /alias rw - ext4 /dev/test rw\n',
                     '2 1 8:1 / ' + namespace + '/nested ro - ext4 /dev/test rw\n',
                     '2 1 0:2 / ' + namespace + ' rw - tmpfs tmpfs rw\n'):
            self.mount.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n' + line)
            with self.assertRaises(ValueError): self.verify()

    def test_daemon_change_mid_observation_refused(self):
        def change(route):
            if route.startswith('/volumes/'): self.engine.daemon = 'changed'
        self.engine.after = change
        with self.assertRaises(A.AuthorityError): self.review()
        self.assertFalse(A.store_path(self.root).exists())


if __name__ == '__main__':
    unittest.main()
