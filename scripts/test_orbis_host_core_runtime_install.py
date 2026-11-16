"""Release-backed installation over private files; Docker and publication are fixtures."""
import copy
from contextlib import contextmanager
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


M = load('orbis-host-core-runtime-install.py', 'release_runtime_install_test')
F = load('test_orbis_host_core_preparation_policy.py', 'release_runtime_policy_fixture')
IMAGE = 'sha256:' + '1' * 64
CARRIER = 'd' * 64


def archive(files, *, symlink=False):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.USTAR_FORMAT) as output:
        for name, value in files.items():
            entry = tarfile.TarInfo(name)
            entry.uid, entry.gid, entry.mode, entry.size = 0, 0, 0o644, len(value)
            if symlink:
                entry.type, entry.linkname, entry.size = tarfile.SYMTYPE, '/etc/passwd', 0
            output.addfile(entry, io.BytesIO(value) if not symlink else None)
    return stream.getvalue()


class RuntimeInstallTests(unittest.TestCase):
    def setUp(self):
        self.fixture = F.MigrationPolicyTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.enrollment = self.fixture.enrollment
        self.enterContext(mock.patch.object(M.POLICY.I, 'require_root'))
        self.publication = {'schema': 'orbis.release.v1', 'image': 'ghcr.io/twentylines/orbis', 'tag': 'v0.8.0-beta.3',
            'commit': '5' * 40, 'digest': 'sha256:' + '6' * 64, 'runtipiCompatibility': '4.10.1'}
        self.image = {'Id': IMAGE, 'Os': 'linux', 'Architecture': 'arm64',
            'RepoDigests': [self.publication['image'] + '@' + self.publication['digest']],
            'Config': {'Volumes': None, 'Labels': {'org.opencontainers.image.source': 'https://github.com/twentylines/orbis',
                'org.opencontainers.image.version': self.publication['tag'], 'org.opencontainers.image.revision': self.publication['commit'],
                M.LABEL: M.PROTOCOL}}}
        self.files = {name: b'export const fixture = true;\n' for name in M.ROOTS}
        self.files['core-publication-fixture.mjs'] = b'export const chunk = true;\n'
        journal = {'version': '7', 'dialect': 'postgresql', 'entries': [
            {'idx': 0, 'version': '7', 'when': 1700000000000, 'tag': '0000_fixture', 'breakpoints': True}]}
        self.migrations = {'meta/_journal.json': self.enrollment.P.canonical(journal), '0000_fixture.sql': b'SELECT 1;'}
        self.manifest = {'schema': M.PROTOCOL, 'parserProfile': M.POLICY.I.C.PARSER,
            'workers': {'files': self.inventory(self.files)}, 'migrations': {'schema': M.POLICY.INVENTORY, 'files': self.inventory(self.migrations)},
            'graph': [{'hash': hashlib.sha256(self.migrations['0000_fixture.sql']).hexdigest(), 'created_at': '1700000000000'}],
            'qualification': copy.deepcopy(M.QUALIFICATION)}
        self.calls, self.created, self.deleted = [], 0, 0
        self.body, self.removed = None, False
        self.changed, self.started, self.link = False, False, False
        self.guard_depth = 0
        runtime = self.enrollment.runtime
        runtime.image.side_effect = lambda identifier: copy.deepcopy(self.image)
        runtime.engine.side_effect = self.engine
        runtime.inspect.side_effect = self.inspect
        runtime.never_started.side_effect = lambda raw: not self.started
        runtime.definition.side_effect = lambda raw: hashlib.sha256(self.enrollment.P.canonical(raw)).hexdigest()
        runtime.check_intent.side_effect = self.check_intent
        runtime.bounded_output.side_effect = lambda *args: archive(self.migrations)
        self.verifier = mock.Mock(side_effect=self.published)
        self.manager = M.ReleaseRuntimeInstaller(self.enrollment, lambda: copy.deepcopy(self.publication), self.guard,
                                                verify_release=self.verifier)

    @staticmethod
    def inventory(files):
        return {name: {'bytes': len(value), 'sha256': hashlib.sha256(value).hexdigest()} for name, value in files.items()}

    def test_restoration_entry_is_optional_and_exact_under_existing_manifest(self):
        self.assertEqual(self.manager.manifest(self.manifest),self.manifest)
        extended=copy.deepcopy(self.manifest)
        extended['workers']['files'].update(self.inventory({'core-restoration-worker.mjs':b'export const optional = true;\n'}))
        self.assertEqual(self.manager.manifest(extended),extended)
        del extended['workers']['files']['core-inspection-worker.mjs']
        with self.assertRaises(ValueError):self.manager.manifest(extended)
        wrong=copy.deepcopy(self.manifest)
        wrong['workers']['files'].update(self.inventory({'core-restoration-other.mjs':b'export const rejected = true;\n'}))
        with self.assertRaises(ValueError):self.manager.manifest(wrong)

    def test_live_entry_remains_optional_alongside_the_existing_restore_entry(self):
        extended = copy.deepcopy(self.manifest)
        for name in ('core-restoration-worker.mjs', 'core-live-reconciliation-worker.mjs'):
            extended['workers']['files'].update(self.inventory({name: b'export const optional = true;\n'}))
        self.assertEqual(self.manager.manifest(extended), extended)
        for name in M.ROOTS:
            with self.subTest(required=name):
                missing = copy.deepcopy(extended)
                del missing['workers']['files'][name]
                with self.assertRaises(ValueError):
                    self.manager.manifest(missing)
        extended['workers']['files'].update(self.inventory({'core-live-reconciliation-other.mjs': b'export const rejected = true;\n'}))
        with self.assertRaises(ValueError):
            self.manager.manifest(extended)

    @contextmanager
    def guard(self):
        self.guard_depth += 1
        try:
            yield
        finally:
            self.guard_depth -= 1

    def published(self, tag):
        self.assertEqual(self.guard_depth, 1)
        return {'tag': self.publication['tag'], 'commit': self.publication['commit'],
            'image': self.publication['image'] + '@' + self.publication['digest'],
            'runtipiCompatibility': self.publication['runtipiCompatibility']}

    def inspect(self, identifier):
        self.assertEqual(identifier, CARRIER)
        return {'Id': CARRIER, 'Image': self.image['Id'], 'State': {'Status': 'created'}, 'Mounts': [], 'body': copy.deepcopy(self.body)}

    def check_intent(self, raw, body):
        self.assertEqual(raw['body'], body)
        self.assertEqual(body['Image'], self.image['Id'])
        self.assertEqual(body['HostConfig']['NetworkMode'], 'none')
        self.assertTrue(body['HostConfig']['ReadonlyRootfs'])
        self.assertFalse(body['HostConfig']['Privileged'])
        self.assertEqual(body['HostConfig']['Mounts'], [])
        self.assertEqual(body['Entrypoint'], ['/bin/true'])

    def engine(self, method, route, body=None, **values):
        self.assertEqual(self.guard_depth, 1)
        self.calls.append((method, route))
        if method == 'POST' and route.startswith('/containers/create?name=orbis-runtime-install-'):
            self.created += 1
            self.body, self.removed = copy.deepcopy(body), False
            return self.enrollment.P.canonical({'Id': CARRIER})
        if method == 'GET' and route.endswith('/changes'):
            return b'[{"Path":"/app/main.mjs","Kind":0}]' if self.changed else b'null'
        if method == 'GET' and '/archive?path=' in route:
            name = route.split('%2Fapp%2F')[1]
            value = self.enrollment.P.canonical(self.manifest) if name == 'core-restore-runtime.json' else self.files[name]
            return archive({name: value}, symlink=self.link)
        if method == 'DELETE' and route == '/containers/' + CARRIER + '?v=false':
            self.deleted += 1
            self.removed = True
            return b''
        if method == 'GET' and route == '/containers/' + CARRIER + '/json' and values.get('allow_missing'):
            return None if self.removed else b'{}'
        self.fail('unexpected runtime operation ' + method + ' ' + route)

    def jobs(self):
        return [self.manager.read(path / 'job.json') for path in self.manager.base.iterdir()]

    def test_verified_release_installs_real_generation_and_policy_after_retirement(self):
        result = self.manager.install()
        self.assertEqual(result['state'], 'installed')
        self.assertEqual((self.created, self.deleted), (1, 1))
        self.assertEqual(self.guard_depth, 0)
        self.assertTrue(all(result[key] is False for key in M.FLAGS))
        selection = M.POLICY.I.InstalledSelection(**{'identifier': result['installedRuntime']['id'],
            'installation_sha256': result['installedRuntime']['installationSha256']})
        broker = self.manager.registry.configuration(IMAGE, selection)
        self.assertEqual(broker.code(), self.manifest['workers']['files'])
        policy = self.manager.policies.read(selection, IMAGE, expected_sha256=result['migrationPolicySha256'])
        self.assertEqual(policy['inventory'], self.manifest['migrations'])
        self.assertEqual(policy['graph'], self.manifest['graph'])
        self.assertEqual(self.jobs()[0]['phase'], 'complete')
        self.assertFalse(any('/start' in route for _, route in self.calls))
        self.verifier.assert_called_once_with(self.publication['tag'])

    def test_repeated_install_checks_private_evidence_without_new_carrier(self):
        first = self.manager.install()
        self.assertEqual(self.manager.install(), first)
        self.assertEqual(self.created, 1)
        self.assertEqual(self.deleted, 1)

    def test_older_release_skips_without_new_requirements_network_or_writes(self):
        self.image['Config']['Labels'] = {}
        self.image['Config']['Volumes'] = {'/older-layout': {}}
        result = self.manager.install()
        self.assertEqual(result['state'], 'not-supported')
        self.assertFalse(self.manager.base.exists())
        self.verifier.assert_not_called()
        self.assertEqual(self.calls, [])

    def test_remote_publication_mismatch_refuses_before_allocation(self):
        for changes in ({'tag': 'v0.8.0-beta.2'}, {'commit': '7' * 40}, {'image': 'ghcr.io/another@sha256:' + '7' * 64},
                        {'runtipiCompatibility': 'unknown'}):
            self.verifier.side_effect = None
            self.verifier.return_value = {
                'tag': self.publication['tag'], 'commit': self.publication['commit'],
                'image': self.publication['image'] + '@' + self.publication['digest'], 'runtipiCompatibility': '4.10.1', **changes}
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.manager.install()
        self.assertFalse(self.manager.base.exists())
        self.assertEqual(self.created, 0)

    def test_self_claimed_manifest_cannot_override_worker_or_source_qualification(self):
        original = copy.deepcopy(self.manifest)
        variants = []
        changed = copy.deepcopy(original); changed['qualification']['scope'] = 'all-versions'; variants.append(changed)
        changed = copy.deepcopy(original); changed['qualification']['activation'] = 0; variants.append(changed)
        changed = copy.deepcopy(original); del changed['workers']['files']['core-inspection-worker.mjs']; variants.append(changed)
        changed = copy.deepcopy(original); changed['workers']['files']['main.mjs'] = next(iter(changed['workers']['files'].values())); variants.append(changed)
        changed = copy.deepcopy(original); changed['workers']['files']['core-publication-ABC.mjs'] = changed['workers']['files'].pop('core-publication-fixture.mjs'); variants.append(changed)
        for value in variants:
            self.manifest = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.manager.install()
        self.assertEqual(self.created, self.deleted)
        self.assertTrue(all(job['phase'] == 'failed-retired' for job in self.jobs()))

    def test_changed_worker_bytes_and_migration_inventory_retire_without_grant(self):
        for kind in ('worker', 'migration'):
            if kind == 'worker':
                self.files['core-inspection-worker.mjs'] += b'changed'
            else:
                self.files['core-inspection-worker.mjs'] = b'export const fixture = true;\n'
                self.migrations['0000_fixture.sql'] += b'changed'
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.manager.install()
        self.assertEqual(self.created, self.deleted)
        self.assertTrue(all(job['phase'] == 'failed-retired' for job in self.jobs()))

    def test_archive_links_are_not_read_or_installed(self):
        self.link = True
        with self.assertRaises(ValueError):
            self.manager.install()
        self.assertEqual((self.created, self.deleted), (1, 1))

    def test_started_or_changed_carrier_is_held_without_forced_cleanup(self):
        self.changed = True
        with self.assertRaises(ValueError):
            self.manager.install()
        self.assertEqual(self.created, 1)
        self.assertEqual(self.deleted, 0)
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.manager.install()
        self.assertEqual(self.created, 1)

    def test_missing_delete_confirmation_never_grants_installation(self):
        original = self.engine
        def engine(method, route, body=None, **values):
            if values.get('allow_missing'):
                return b'{}'
            return original(method, route, body, **values)
        self.enrollment.runtime.engine.side_effect = engine
        with self.assertRaises(ValueError):
            self.manager.install()
        self.assertFalse((self.manager.base / self.jobs()[0]['id'] / 'carrier-retired.json').exists())

    def test_started_carrier_is_never_stopped_or_removed(self):
        self.started = True
        with self.assertRaises(ValueError):
            self.manager.install()
        self.assertEqual((self.created, self.deleted), (1, 0))

    def test_unknown_create_reply_is_held_without_a_second_carrier(self):
        original = self.engine
        def engine(method, route, body=None, **values):
            result = original(method, route, body, **values)
            if method == 'POST':
                raise OSError('fixture reply lost')
            return result
        self.enrollment.runtime.engine.side_effect = engine
        with self.assertRaises(OSError):
            self.manager.install()
        self.enrollment.runtime.engine.side_effect = original
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.manager.install()
        self.assertEqual((self.created, self.deleted), (1, 0))

    def test_parent_directories_are_synced_before_installation_reports_complete(self):
        events = []
        original = self.enrollment.sync
        def sync(directory):
            original(directory)
            events.append(Path(directory))
        with mock.patch.object(self.enrollment, 'sync', side_effect=sync):
            result = self.manager.install()
        base = self.manager.registry.base
        generation = base / 'generations' / result['installedRuntime']['id']
        self.assertLess(events.index(Path(self.enrollment.state)), events.index(base))
        self.assertGreaterEqual(events.count(generation), 2)

    def test_known_carrier_is_retired_after_one_transient_record_save_failure(self):
        original, failed = self.manager.save, False
        def save(job):
            nonlocal failed
            if job['phase'] == 'created' and not failed:
                failed = True
                raise OSError('fixture save failure')
            return original(job)
        with mock.patch.object(self.manager, 'save', side_effect=save), self.assertRaises(OSError):
            self.manager.install()
        self.assertEqual((self.created, self.deleted), (1, 1))
        self.assertEqual(self.jobs()[0]['phase'], 'failed-retired')

    def test_interrupted_local_enrollment_resumes_only_after_positive_carrier_retirement(self):
        with mock.patch.object(self.manager.policies, 'install', side_effect=OSError('fixture interrupted enrollment')):
            with self.assertRaises(OSError):
                self.manager.install()
        self.assertEqual(self.jobs()[0]['phase'], 'extracted')
        self.assertEqual((self.created, self.deleted), (1, 1))
        self.assertEqual(self.manager.install()['state'], 'installed')
        self.assertEqual(self.created, 1)

    def test_completed_cache_may_not_mask_removed_migration_authority(self):
        first = self.manager.install()
        selection = M.POLICY.I.InstalledSelection(first['installedRuntime']['id'], first['installedRuntime']['installationSha256'])
        path = self.manager.registry.base / 'generations' / selection.identifier / 'clean-target-migrations' / (IMAGE[7:] + '.json')
        path.unlink()
        result = self.manager.install()
        self.assertEqual(result['installedRuntime'], first['installedRuntime'])
        self.assertEqual((self.created, self.deleted), (2, 2))

    def test_same_release_replacement_generation_is_a_cache_miss(self):
        first = self.manager.install()
        broker = self.manager.registry.configuration(IMAGE)
        replaced = self.manager.registry.install(M.POLICY.I.RootInstallationApproval(broker.trust,
            self.manager.digest(self.publication), self.manager.digest(self.manifest['workers']['files']),
            {IMAGE: {'parserProfile': M.POLICY.I.C.PARSER, 'qualificationSha256': self.manager.digest(self.manifest['qualification'])}}))
        selected = M.POLICY.I.InstalledSelection(replaced['id'], replaced['installationSha256'])
        self.manager.policies.install(M.POLICY.RootMigrationPolicyApproval(selected, IMAGE, self.manager.digest(self.publication),
            self.manifest['migrations'], self.manager.digest(self.manifest['migrations']), self.manifest['graph'], self.manager.digest(self.manifest['graph'])))
        result = self.manager.install()
        self.assertNotEqual(result['installedRuntime'], first['installedRuntime'])
        self.assertEqual(result['installedRuntime']['id'], selected.identifier)
        self.assertEqual((self.created, self.deleted), (2, 2))

    def test_install_a_b_a_uses_fresh_published_enrollment(self):
        publication, image = copy.deepcopy(self.publication), copy.deepcopy(self.image)
        first = self.manager.install()
        self.publication.update(tag='v0.8.0-beta.4', commit='7' * 40, digest='sha256:' + '8' * 64)
        self.image.update(Id='sha256:' + '9' * 64, RepoDigests=[self.publication['image'] + '@' + self.publication['digest']])
        self.image['Config']['Labels'].update({'org.opencontainers.image.version': self.publication['tag'],
            'org.opencontainers.image.revision': self.publication['commit']})
        self.manager.install()
        self.publication, self.image = publication, image
        result = self.manager.install()
        self.assertEqual(result['imageId'], IMAGE)
        self.assertNotEqual(result['installedRuntime'], first['installedRuntime'])
        self.assertEqual((self.created, self.deleted), (3, 3))


if __name__ == '__main__':
    unittest.main()
