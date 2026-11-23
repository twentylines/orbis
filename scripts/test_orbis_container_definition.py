import copy
import hashlib
import importlib.util
import itertools
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('container_definition_test', Path(__file__).with_name('orbis-container-definition.py'))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def fixture():
    return {'Id': 'a' * 64, 'Created': 'fixture', 'Image': 'sha256:' + 'b' * 64,
            'Config': {'Cmd': ['node', 'main.mjs']}, 'HostConfig': {'Privileged': False},
            'Path': 'node', 'Args': ['main.mjs'],
            'Mounts': [{'Type': 'bind', 'Source': '/fixture/state', 'Destination': '/data/state', 'RW': True, 'Propagation': 'rprivate'},
                       {'Type': 'bind', 'Source': '/fixture/apps', 'Destination': '/app-data', 'RW': True, 'Propagation': 'rprivate'},
                       {'Type': 'bind', 'Source': '/fixture/cache', 'Destination': '/cache', 'RW': True, 'Propagation': 'rprivate'}]}


class ContainerDefinitionTests(unittest.TestCase):
    def test_every_mount_permutation_has_the_same_identity(self):
        original = fixture()
        expected = digest(M.normalize(original))
        for rows in itertools.permutations(original['Mounts']):
            with self.subTest(order=[row['Destination'] for row in rows]):
                self.assertEqual(digest(M.normalize({**original, 'Mounts': list(rows)})), expected)

    def test_every_mount_field_remains_bound(self):
        original = fixture()
        expected = digest(M.normalize(original))
        for key, value in [('Type', 'volume'), ('Source', '/other'), ('Destination', '/different'),
                           ('RW', False), ('Propagation', 'rshared'), ('Name', 'different'),
                           ('Driver', 'different'), ('Mode', 'z'), ('newField', {'value': True})]:
            with self.subTest(field=key):
                changed = copy.deepcopy(original)
                changed['Mounts'][0][key] = value
                self.assertNotEqual(digest(M.normalize(changed)), expected)

    def test_other_definition_fields_remain_bound(self):
        original = fixture()
        expected = digest(M.normalize(original))
        for key in original.keys() - {'Mounts'}:
            with self.subTest(field=key):
                changed = copy.deepcopy(original)
                changed[key] = {'changed': True}
                self.assertNotEqual(digest(M.normalize(changed)), expected)

    def test_normalization_never_mutates_the_observation_or_shares_nested_values(self):
        original = fixture()
        before = copy.deepcopy(original)
        normalized = M.normalize(original)
        normalized['Config']['Cmd'].append('changed')
        normalized['Mounts'][0]['Source'] = '/changed'
        self.assertEqual(original, before)

    def test_duplicate_destinations_are_not_merged_or_ignored(self):
        row = fixture()['Mounts'][0]
        for duplicate in (copy.deepcopy(row), {**row, 'Source': '/different'}):
            with self.subTest(changed=duplicate != row), self.assertRaises(ValueError):
                M.mounts([row, duplicate])

    def test_invalid_or_ambiguous_mounts_refuse(self):
        cases = [None, {}, [None], [{}], [{'Destination': 'relative'}], [{'Destination': '/data/../other'}],
                 [{'Destination': '//data'}], [{'Destination': '/data//other'}],
                 [{'Destination': '/data/'}], [{'Destination': '/data\\other'}], [{'Destination': '/data\nother'}],
                 [{'Destination': '/data\0other'}], [{'Destination': '/data\u0085other'}],
                 [{'Destination': '/' + 'a' * 4096}], [{'Destination': '/same'}] * 4097]
        for rows in cases:
            with self.subTest(case=cases.index(rows)), self.assertRaises(ValueError):
                M.mounts(rows)

    def test_empty_mounts_and_a_canonical_root_destination_are_preserved(self):
        self.assertEqual(M.mounts([]), [])
        self.assertEqual(M.mounts([{'Destination': '/', 'RW': False}]), [{'Destination': '/', 'RW': False}])

    def test_missing_mount_observation_does_not_become_an_empty_mount_set(self):
        for value in (None, [], {}, {'Config': {}}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                M.normalize(value)


if __name__ == '__main__':
    unittest.main()
