import copy
import unittest

from test_orbis_host_retained_restore import D


class RestoreMediaPolicyTests(unittest.TestCase):
    def manifest(self, policy='preserve-destination'):
        return {'format': 'orbis-full-backup', 'version': 2, 'mediaPolicy': policy,
                'files': [{'name': 'app-data/player/config.json'}],
                'directories': [{'name': 'data/state'}, {'name': 'app-data'}]}

    def test_legacy_and_explicit_media_backups_keep_existing_restore_roots(self):
        legacy = {'format': 'orbis-full-backup', 'version': 1}
        self.assertEqual(D.restore_data_roots(legacy), D.ROOTS)
        included = self.manifest('included')
        included['files'].append({'name': 'data/media/movie.mkv'})
        self.assertEqual(D.restore_data_roots(included), D.ROOTS)
        self.assertEqual(D.restore_data_roots(included, preserve_proxy=True), D.ROOTS - {'traefik'})

    def test_omitted_media_is_never_a_restore_swap_root(self):
        manifest = self.manifest()
        original = copy.deepcopy(manifest)
        self.assertEqual(D.restore_data_roots(manifest), D.ROOTS - {'media'})
        self.assertEqual(D.restore_data_roots(manifest, preserve_proxy=True), D.ROOTS - {'media', 'traefik'})
        self.assertEqual(manifest, original)

    def test_preserving_manifest_cannot_smuggle_media_files_or_directories(self):
        for field in ('files', 'directories'):
            for name in ('data/media', 'data/media/library/movie.mkv', 'data/state/../media/movie.mkv', '/data/media', 'data//media'):
                with self.subTest(field=field, name=name):
                    manifest = self.manifest()
                    manifest[field].append({'name': name})
                    with self.assertRaises(ValueError):
                        D.restore_data_roots(manifest)

    def test_missing_unknown_or_unversioned_policy_fails_closed(self):
        malformed = [
            {'format': 'orbis-full-backup', 'version': 1, 'mediaPolicy': 'preserve-destination'},
            {**self.manifest(), 'version': True},
            {**self.manifest(), 'version': 3},
            {**self.manifest(), 'mediaPolicy': None},
            {**self.manifest(), 'mediaPolicy': []},
            {**self.manifest(), 'mediaPolicy': 'skip'},
            {**self.manifest(), 'directories': None},
            {**self.manifest(), 'files': ['data/media/movie.mkv']},
        ]
        for manifest in malformed:
            with self.subTest(manifest=manifest), self.assertRaises(ValueError):
                D.restore_data_roots(manifest)

    def test_link_and_runtime_socket_metadata_cannot_reintroduce_omitted_media(self):
        for field, value in (
            ('symlinks', [{'name': 'data/media/link', 'target': 'movie.mkv'}]),
            ('excludedRuntimeSockets', ['data/media/socket']),
            ('symlinks', [{'name': 'app-data/link', 'target': '../media/movie.mkv'}]),
            ('symlinks', [{'name': 'app-data/link', 'target': '/media/movie.mkv'}]),
            ('symlinks', ['app-data/link']),
            ('excludedRuntimeSockets', [None]),
        ):
            manifest = self.manifest()
            manifest[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                D.restore_data_roots(manifest)
        valid = self.manifest()
        valid['symlinks'] = [{'name': 'app-data/player/link', 'target': 'config.json'}]
        valid['excludedRuntimeSockets'] = ['app-data/player/runtime.sock']
        self.assertNotIn('media', D.restore_data_roots(valid))


if __name__ == '__main__':
    unittest.main()
