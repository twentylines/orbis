"""Focused fixture tests for capture-time portable core storage bindings.

Docker inspection and checkpoint copying are simulated by the existing core fixture.
"""
import copy
import json
from pathlib import Path
import unittest
from unittest import mock

import test_orbis_host_time_machine_core as fixture

C = fixture.C
M = C.MAP
identifier = fixture.identifier


class StorageMapTests(unittest.TestCase):
    setUp = fixture.CoreCaptureTests.setUp
    copy_storage = fixture.CoreCaptureTests.copy_storage

    def review(self):
        checkpoint = C.TX.review(self.root, self.docker, self.snapshots / 'bundle',
                                 self.parent / 'checkpoint.json', scope=C.SCOPE)
        original = {row['id']: self.capture.observation(self.docker, row['id'])
                    for row in self.docker.containers()}
        return checkpoint, original

    def mapping(self, checkpoint, original):
        return M.capture(C.TX, C.D, self.docker, checkpoint, original)

    def test_exact_mount_addresses_and_nested_database_without_environment(self):
        db = self.docker.services[identifier('runtipi-db')]
        (self.docker.database_directory / 'nested').mkdir()
        db['environment'] = ['PRIVATE_FIXTURE=secret-must-not-appear', 'PGDATA=/var/lib/postgresql/data/nested']
        checkpoint, original = self.review()
        result = self.mapping(checkpoint, original)
        self.assertEqual(set(result['roles']), {'controller', 'database', 'queue'})
        for key, role in checkpoint['roles'].items():
            entry = result['roles'][role]
            self.assertEqual(entry['containerId'], key)
            self.assertEqual(entry['definitionSha256'], original[key]['definition'])
            for mount in entry['mounts']:
                if 'resourceIndex' in mount:
                    raw = next(x for x in self.docker.app(key)['mounts'] if x['Destination'] == mount['destination'])
                    source = C.TX.STORAGE.mount_source(self.docker, raw, controller=role == 'controller')
                    resource = checkpoint['storage']['resources'][mount['resourceIndex']]
                    self.assertEqual(mount['resourcePath'], source.relative_to(resource['source']).as_posix())
        database = result['database']
        self.assertEqual(database['containerPath'], '/var/lib/postgresql/data/nested')
        resource = checkpoint['storage']['resources'][database['resourceIndex']]
        self.assertEqual(str(Path(resource['source']) / database['resourcePath']), str(self.docker.database_directory / 'nested'))
        self.assertNotIn('secret-must-not-appear', json.dumps(result))
        self.assertNotIn('Env', json.dumps(result))
        self.assertEqual(result['hostPlatform'], {'os': 'linux', 'architecture': 'amd64'})
        self.assertTrue(all(entry['platform'] == result['hostPlatform'] for entry in result['roles'].values()))

    def test_platform_host_and_image_must_match(self):
        checkpoint, original = self.review()
        real = self.docker._object
        for host, image in [({'os': 'darwin', 'architecture': 'x86_64'}, None),
                            ({'os': 'linux', 'architecture': 'mips'}, None),
                            ({'os': 'linux', 'architecture': 'aarch64'}, None),
                            (None, {'Os': 'windows', 'Architecture': 'amd64'}),
                            (None, {'Os': 'linux', 'Architecture': 'arm64'})]:
            def inspect(args):
                value = real(args)
                if args[0] == 'info' and host is not None:
                    return host
                if args[:2] == ['image', 'inspect'] and image is not None:
                    return {**value, **image}
                return value
            with self.subTest(host=host, image=image), mock.patch.object(self.docker, '_object', side_effect=inspect):
                with self.assertRaises(M.StorageMapError):
                    self.mapping(checkpoint, original)

    def test_changed_definition_or_mount_source_is_rejected(self):
        checkpoint, original = self.review()
        db = self.docker.services[identifier('runtipi-db')]
        db['mounts'][0]['Source'] = str(self.root / 'app-data')
        with self.assertRaises(M.StorageMapError):
            self.mapping(checkpoint, original)

    def test_source_disappears_after_review(self):
        checkpoint, original = self.review()
        self.docker.database_directory.rmdir()
        with self.assertRaises((ValueError, OSError)):
            self.mapping(checkpoint, original)

    def test_duplicate_or_unmounted_pgdata_rejected(self):
        db = self.docker.services[identifier('runtipi-db')]
        for env in (['PGDATA=/var/lib/postgresql/data', 'PGDATA=/var/lib/postgresql/data'],
                    ['PGDATA=/not-mounted'], ['PRIVATE_FIXTURE=x']):
            with self.subTest(env=env):
                db['environment'] = env
                checkpoint, original = self.review()
                with self.assertRaises(M.StorageMapError):
                    self.mapping(checkpoint, original)

    def test_deepest_volatile_mount_shadows_database_directory(self):
        db = self.docker.services[identifier('runtipi-db')]
        db['mounts'].append({'Type': 'tmpfs', 'Destination': '/var/lib/postgresql/data/volatile', 'RW': True})
        db['environment'] = ['PGDATA=/var/lib/postgresql/data/volatile']
        checkpoint, original = self.review()
        with self.assertRaisesRegex(M.StorageMapError, 'excluded or volatile'):
            self.mapping(checkpoint, original)

    def test_saved_deepest_volatile_mount_shadows_database_directory(self):
        checkpoint, original = self.review()
        value = self.mapping(checkpoint, original)
        db = value['roles']['database']
        db['mounts'].append({'destination': '/var/lib/postgresql/data/nested', 'type': 'tmpfs',
                             'writable': True, 'policy': 'runtime'})
        value['database']['containerPath'] += '/nested'
        value['database']['resourcePath'] = str(Path(value['database']['resourcePath']) / 'nested')
        with self.assertRaisesRegex(M.StorageMapError, 'differs from its captured mount'):
            M.validate(C.TX, value, checkpoint, original)

    def test_address_exclusions_ambiguity_and_non_directory(self):
        base = self.parent / 'data'
        resources = [{'source': str(base), 'kind': 'directory', 'excludedPaths': ['cache']}]
        self.assertEqual(M.address(resources, base / 'nested'), {'resourceIndex': 0, 'resourcePath': 'nested'})
        self.assertIsNone(M.address(resources, base / 'cache' / 'child'))
        with self.assertRaises(M.StorageMapError):
            M.address(resources + [{'source': str(base / 'nested'), 'kind': 'directory'}], base / 'nested')
        with self.assertRaises(M.StorageMapError):
            M.address([{'source': str(base), 'kind': 'file'}], base / 'nested')

    def test_saved_shape_and_binding_tampering_rejected(self):
        checkpoint, original = self.review()
        good = self.mapping(checkpoint, original)
        def mutate(fn):
            value = copy.deepcopy(good)
            fn(value)
            return value
        cases = [lambda v: v.update(extra=True), lambda v: v.update(reviewSha256='0' * 64),
                 lambda v: v.update(storageIdentitySha256='0' * 64),
                 lambda v: v['hostPlatform'].update(architecture='arm64'),
                 lambda v: v['roles']['database'].update(imageId='sha256:' + '0' * 64),
                 lambda v: v['roles']['database'].update(extra='x'),
                 lambda v: v['database'].update(resourceIndex=True),
                 lambda v: v['database'].update(resourcePath='../escape'),
                 lambda v: v['database'].update(containerPath='/different'),
                 lambda v: v['roles']['database']['mounts'][0].update(writable=1),
                 lambda v: v['roles']['database']['mounts'][0].update(resourceIndex=999),
                 lambda v: v['roles']['database']['mounts'].append(copy.deepcopy(v['roles']['database']['mounts'][0]))]
        self.assertEqual(M.validate(C.TX, good, checkpoint, original), good)
        for index, change in enumerate(cases):
            with self.subTest(case=index), self.assertRaises((M.StorageMapError, ValueError)):
                M.validate(C.TX, mutate(change), checkpoint, original)


if __name__ == '__main__':
    unittest.main()
