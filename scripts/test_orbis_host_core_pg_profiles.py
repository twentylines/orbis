"""Bounded image recipes; metadata checks do not qualify native restore execution."""
import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location('pg_execution_profile_tests', Path(__file__).with_name('orbis-host-core-pg-profiles.py'))
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


def image(major):
    return {'Id': P.PG14_AMD64_IMAGE if major == 14 else P.PG17_ARM64_IMAGE, 'Os': 'linux',
            'Architecture': 'amd64' if major == 14 else 'arm64',
            'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}}


class ExecutionProfileTests(unittest.TestCase):
    def test_exact_two_profiles_and_base_shape(self):
        for major, identifier, owner in [(14, 'pg14-debian-amd64.v1', 999), (17, 'pg17-alpine-arm64.v1', 70)]:
            with self.subTest(major=major):
                profile = P.execution_image_profile(image(major))
                self.assertEqual(set(profile), P.BASE_FIELDS)
                self.assertEqual(profile['profileId'], identifier)
                self.assertEqual((profile['major'], profile['uid'], profile['gid']), (major, owner, owner))
                self.assertEqual(P.image_for_profile(profile), image(major))

    def test_unknown_image_platform_volume_and_missing_config_refuse(self):
        for major in (14, 17):
            for changes in ({'Id': 'postgres:14'}, {'Id': 'sha256:' + 'f' * 64}, {'Os': 'darwin'},
                            {'Architecture': 'amd64' if major == 17 else 'arm64'}, {'Config': None},
                            {'Config': {}}, {'Config': {'Volumes': {'/var/lib/postgresql/data': {}, '/other': {}}}}):
                with self.subTest(major=major, changes=changes), self.assertRaises(ValueError):
                    P.execution_image_profile(image(major) | changes)
        for value in (None, [], 'postgres:14'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                P.execution_image_profile(value)

    def test_profile_identity_changes_refuse_before_binary_selection(self):
        profile = P.execution_image_profile(image(14))
        for key, value in [('major', 17), ('major', True), ('uid', 70), ('gid', 0), ('architecture', 'arm64'),
                           ('profileId', 'pg14-debian-arm64.v1'), ('profileId', []), ('imageId', P.PG17_ARM64_IMAGE)]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                P.binary_for(profile | {key: value}, 'postgres')

    def test_fixed_tools_cannot_select_path_or_options(self):
        for major, directory in [(14, '/usr/lib/postgresql/14/bin'), (17, '/usr/local/bin')]:
            profile = P.execution_image_profile(image(major))
            for tool in P.TOOLS:
                self.assertEqual(P.binary_for(profile, tool), directory + '/' + tool)
            for tool in ('../sh', 'bash', '--help', '/usr/bin/postgres', None, []):
                with self.subTest(tool=tool), self.assertRaises(ValueError):
                    P.binary_for(profile, tool)

    def test_returned_parameters_cannot_mutate_registry(self):
        first = P.execution_image_profile(image(14));first['uid'] = 0
        self.assertEqual(P.execution_image_profile(image(14))['uid'], 999)
        with self.assertRaises(TypeError):
            P._PROFILES['pg14-debian-amd64.v1']['uid'] = 0
        with self.assertRaises(TypeError):
            P._PROFILES['invented'] = {}

    def test_locale_sets_are_immutable_and_14_is_exact(self):
        locales = P.locales_for(P.execution_image_profile(image(14)))
        self.assertEqual(locales, {'C', 'C.utf8', 'en_US.utf8', 'POSIX'})
        with self.assertRaises(AttributeError):
            locales.add('C.UTF-8')


if __name__ == '__main__':
    unittest.main()
