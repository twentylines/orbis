"""Candidate target specification checks; Docker/PostgreSQL proof is separate."""
import importlib.util
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location('orbis_clean_target_profile_tests', Path(__file__).with_name('orbis-host-core-clean-target-profile.py'))
P = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = P
spec.loader.exec_module(P)
ID = 'a71c77d2-f420-440e-951b-083209514e72'
NONCE = 'b71c77d2-f420-440e-951b-083209514e72'


def image():
    return {'Id': P.SOURCE.PG17_ARM64_IMAGE, 'Os': 'linux', 'Architecture': 'arm64',
            'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}}


def profile():
    return P.clean_target_profile(image(), 'orbis_target', 'orbis_restored',
                                  {'encoding': 'UTF8', 'collate': 'C', 'ctype': 'C', 'provider': 'c'})


class TargetProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='orbis-clean-target-spec-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for child in ('pgdata', 'socket', 'config'):
            (self.root / child).mkdir(mode=0o700)
        self.profile = profile()
        self.workspace = P.TargetWorkspace(self.root, self.profile,
            {'id': ID, 'nonce': NONCE, 'rootIntentSha256': 'a' * 64}, {})

    def test_exact_cached_image_and_locale_are_required(self):
        for changed in ({'Id': 'sha256:' + 'f' * 64}, {'Architecture': 'amd64'}, {'Os': 'darwin'}, {'Config': {'Volumes': {}}}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                P.clean_target_profile(image() | changed, 'orbis_target', 'orbis_restored', self.profile['locale'])
        for changed in ({'encoding': 'LATIN1'}, {'provider': 'i'}, {'collate': 'unknown'}, {'extra': True}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                P.clean_target_profile(image(), 'orbis_target', 'orbis_restored', self.profile['locale'] | changed)

    def test_role_and_database_cannot_select_options_or_maintenance_databases(self):
        for value in ('--help', 'role" trust', 'user/other', 'x' * 64):
            with self.subTest(value=value), self.assertRaises(ValueError):
                P.clean_target_profile(image(), value, 'orbis_restored', self.profile['locale'])
        for value in ('postgres', 'template0', 'template1', '../other'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                P.clean_target_profile(image(), 'orbis_target', value, self.profile['locale'])

    def test_profile_cannot_enable_authority_or_change_worker_identity(self):
        for key, value in [('uid', 0), ('gid', 0), ('activation', True), ('restoreAuthority', True), ('environmentProved', True), ('extra', 'value')]:
            changed = self.profile | {key: value}
            with self.subTest(key=key), self.assertRaises(ValueError):
                P.validate_profile(changed)

    def test_target_is_writable_but_has_no_network_or_preload_hooks(self):
        settings = P.settings_for(self.profile)
        self.assertEqual(settings['default_transaction_read_only'], 'off')
        self.assertEqual(settings['search_path'], 'pg_catalog')
        self.assertEqual(settings['listen_addresses'], '')
        for key in ('shared_preload_libraries', 'session_preload_libraries', 'local_preload_libraries', 'restore_command'):
            self.assertEqual(settings[key], '')
        self.assertTrue(all(value.startswith('/clean-target-config/') for key, value in settings.items()
                            if key in {'config_file', 'hba_file', 'ident_file'}))
        hba = P.config_for(self.profile)['pg_hba.conf']
        self.assertEqual(hba, b'local "postgres" "orbis_target" trust\nlocal "orbis_restored" "orbis_target" trust\nlocal all all reject\n')

    def test_initializer_has_no_source_data_config_socket_or_host_network_mount(self):
        with mock.patch.object(P, 'verify_workspace', return_value=self.workspace):
            actual = P.initialization_body(self.workspace, object())
        self.assertEqual(actual['Entrypoint'], ['/usr/local/bin/initdb'])
        self.assertIn('--lc-collate=C', actual['Cmd'])
        self.assertIn('--auth-local=reject', actual['Cmd'])
        self.assertEqual(actual['User'], '70:70')
        self.assertEqual(actual['Image'], P.SOURCE.PG17_ARM64_IMAGE)
        self.assertEqual(actual['HostConfig']['NetworkMode'], 'none')
        self.assertTrue(actual['HostConfig']['ReadonlyRootfs'])
        self.assertEqual(actual['HostConfig']['CapDrop'], ['ALL'])
        self.assertEqual(actual['HostConfig']['Mounts'], [P.SOURCE.mount(self.root / 'pgdata', '/var/lib/postgresql/data', False)])
        self.assertEqual(actual['Labels']['io.orbis.core-clean-target.intent'], 'a' * 64)

    def test_initializer_refuses_preexisting_data_or_socket_residue(self):
        for name in ('pgdata/unexpected', 'socket/unexpected'):
            path = self.root / name
            path.write_bytes(b'existing')
            with self.subTest(name=name), mock.patch.object(P, 'verify_workspace'), self.assertRaises(ValueError):
                P.initialization_body(self.workspace, object())
            path.unlink()

    def test_database_creator_masks_image_volume_readonly_and_never_reuses_existing_database(self):
        with mock.patch.object(P, 'verify_workspace'):
            actual = P.creation_body(self.workspace, object())
        self.assertEqual(actual['Entrypoint'], ['/usr/local/bin/createdb'])
        self.assertEqual(actual['Cmd'][-2:], ['--', 'orbis_restored'])
        self.assertIn('--template=template0', actual['Cmd'])
        self.assertIn('--no-password', actual['Cmd'])
        self.assertNotIn('--if-not-exists', actual['Cmd'])
        self.assertEqual(actual['HostConfig']['Mounts'], [P.SOURCE.mount(self.root / 'socket', '/var/run/postgresql', True),
                                                        P.SOURCE.mount(self.root / 'pgdata', '/var/lib/postgresql/data', True)])
        self.assertEqual(actual['Env'], ['PGCONNECT_TIMEOUT=10'])

    def test_every_image_declared_volume_is_explicitly_masked(self):
        with mock.patch.object(P, 'verify_workspace'):
            bodies = [P.initialization_body(self.workspace, object()), P.creation_body(self.workspace, object())]
        for actual in bodies:
            targets = {item['Target'] for item in actual['HostConfig']['Mounts']} | set(actual['HostConfig'].get('Tmpfs', {}))
            self.assertTrue(set(image()['Config']['Volumes']) <= targets)

    def test_root_guard_precedes_allocation_and_does_not_create_records(self):
        with mock.patch.object(P, 'require_root', side_effect=P.fail()), self.assertRaises(ValueError):
            P.allocate_workspace(self.root, self.profile, object(), ID, NONCE, 'a' * 64)
        self.assertFalse((self.root / 'allocation.json').exists())

    def test_workspace_dictionary_is_not_a_root_capability(self):
        with mock.patch.object(P, 'require_root'), self.assertRaises(ValueError):
            P.verify_workspace({'directory': str(self.root), 'profile': self.profile}, object())

    def test_allocating_children_preserves_the_readonly_parent_guard(self):
        target = self.root / 'fresh'
        target.mkdir(mode=0o700)
        guarded = []
        @contextmanager
        def protected(directory):
            guarded.append(directory)
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                before = os.fstat(fd)
                yield fd
                fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
                self.assertEqual(tuple(getattr(before, key) for key in fields),
                                 tuple(getattr(os.fstat(fd), key) for key in fields))
            finally:
                os.close(fd)
        # Virtual Root ownership is a seam; this check exercises actual directory writes/seals.
        authority = type('Authority', (), {'OWNER': 0, 'protected_directory': staticmethod(protected)})()
        with mock.patch.object(P, 'require_root'), mock.patch.object(P.os, 'fchown'), mock.patch.object(P, 'verify_workspace'):
            workspace = P.allocate_workspace(target, self.profile, authority, ID, NONCE, 'a' * 64)
        self.assertEqual(set(path.name for path in target.iterdir()), {'allocation.json', 'pgdata', 'socket', 'config'})
        self.assertEqual(json.loads((target / 'allocation.json').read_text()), workspace.allocation)
        self.assertIn(self.root, guarded)
        with mock.patch.object(P, 'require_root'), mock.patch.object(P.os, 'fchown'), mock.patch.object(P, 'verify_workspace'), self.assertRaises(ValueError):
            P.allocate_workspace(target, self.profile, authority, ID, NONCE, 'a' * 64)


    def bounded_profile(self, major=14):
        actual = image() if major == 17 else {'Id': P.SOURCE.PG.PG14_AMD64_IMAGE, 'Os': 'linux', 'Architecture': 'amd64',
                                             'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}}
        return P.bounded_clean_target_profile(actual, 'orbis_target', 'orbis_restored', self.profile['locale'])

    def test_bounded_profiles_do_not_relax_old_target_schema(self):
        bounded = self.bounded_profile()
        self.assertEqual(bounded['schema'], 'orbis.core-clean-target-pg.v2')
        self.assertEqual((bounded['major'], bounded['uid'], bounded['gid']), (14, 999, 999))
        self.assertEqual(P.validate_profile(bounded), bounded)
        for changed in ({'schema': P.SCHEMA}, {'uid': 70}, {'gid': 70}, {'major': 17}, {'profileId': 'pg17-alpine-arm64.v1'},
                        {'activation': True}, {'environmentProved': True}, {'restoreAuthority': True}, {'settings': {}}, {'extra': True}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                P.validate_profile(bounded | changed)
        with self.assertRaises(ValueError):
            P.clean_target_profile(P.SOURCE.PG.image_for_profile(bounded), 'orbis_target', 'orbis_restored', bounded['locale'])

    def test_bounded14_locale_is_from_measured_set_only(self):
        bounded = self.bounded_profile();actual = P.SOURCE.PG.image_for_profile(bounded)
        for name in ('C', 'C.utf8', 'en_US.utf8', 'POSIX'):
            self.assertEqual(P.bounded_clean_target_profile(actual, 'target', 'restored', bounded['locale'] | {'collate': name, 'ctype': name})['locale']['collate'], name)
        for change in ({'collate': 'C.UTF-8'}, {'ctype': 'en_US.UTF-8'}, {'encoding': 'LATIN1'}, {'provider': 'i'}, {'other': True}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                P.bounded_clean_target_profile(actual, 'target', 'restored', bounded['locale'] | change)

    def test_bounded17_recipes_match_legacy_commands_and_settings(self):
        old = self.workspace
        new = P.TargetWorkspace(old.directory, self.bounded_profile(17), old.allocation, old.identities)
        self.assertEqual(P.settings_for(new.profile), P.settings_for(old.profile))
        self.assertEqual(P.config_for(new.profile), P.config_for(old.profile))
        for factory in (P.initialization_body, P.creation_body):
            with mock.patch.object(P, 'verify_workspace'):
                self.assertEqual(factory(new, object()), factory(old, object()))

    def test_bounded14_commands_use_fixed_binaries_and_omit_only_unsupported_settings(self):
        self.workspace = P.TargetWorkspace(self.root, self.bounded_profile(), self.workspace.allocation, {})
        with mock.patch.object(P, 'verify_workspace'):
            initialize = P.initialization_body(self.workspace, object());create = P.creation_body(self.workspace, object())
        for tool, actual in [('initdb', initialize), ('createdb', create)]:
            self.assertEqual(actual['Entrypoint'], ['/usr/lib/postgresql/14/bin/' + tool])
            self.assertNotIn('--locale-provider=libc', actual['Cmd'])
            self.assertIn('--lc-collate=C', actual['Cmd'])
            self.assertIn('--lc-ctype=C', actual['Cmd'])
            self.assertEqual(actual['User'], '999:999')
            self.assertEqual(actual['HostConfig']['NetworkMode'], 'none')
            self.assertEqual(actual['HostConfig']['RestartPolicy']['Name'], 'no')
            self.assertEqual(actual['HostConfig']['CapDrop'], ['ALL'])
        self.assertIn('--auth-host=reject', initialize['Cmd'])
        expected = P.settings_for(self.profile)
        self.assertEqual(P.settings_for(self.workspace.profile), {key: value for key, value in expected.items() if key != 'archive_library'})
        self.assertEqual(P.binary_for(self.workspace.profile, 'psql'), '/usr/lib/postgresql/14/bin/psql')
        with self.assertRaises(ValueError):
            P.binary_for(self.workspace.profile, 'sh')

    def test_bounded14_allocation_writes_actual_exclusive_profile_and_config(self):
        target = self.root / 'bounded';target.mkdir(mode=0o700)
        @contextmanager
        def protected(directory):
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:yield fd
            finally:os.close(fd)
        authority = type('Authority', (), {'OWNER': 0, 'protected_directory': staticmethod(protected)})()
        with mock.patch.object(P, 'require_root'), mock.patch.object(P.os, 'fchown'), mock.patch.object(P, 'verify_workspace'):
            workspace = P.allocate_workspace(target, self.bounded_profile(), authority, ID, NONCE, 'a' * 64)
        stored = json.loads((target / 'allocation.json').read_bytes())
        self.assertEqual(stored['profile'], self.bounded_profile())
        self.assertFalse(stored['restoreAuthority'])
        self.assertEqual((target / 'allocation.json').stat().st_mode & 0o777, 0o400)
        self.assertEqual((target / 'config/pg_hba.conf').stat().st_mode & 0o777, 0o440)
        self.assertEqual((target / 'config/pg_hba.conf').read_bytes(), P.config_for(workspace.profile)['pg_hba.conf'])
        with mock.patch.object(P, 'require_root'), mock.patch.object(P.os, 'fchown'), mock.patch.object(P, 'verify_workspace'), self.assertRaises(ValueError):
            P.allocate_workspace(target, self.bounded_profile(), authority, ID, NONCE, 'a' * 64)

    def test_bounded14_database_checks_actual_files_and_version_before_start(self):
        self.workspace = P.TargetWorkspace(self.root, self.bounded_profile(), self.workspace.allocation, {})
        for name, body in [('PG_VERSION', b'14\n'), ('postgresql.auto.conf', b'# generated\n')]:
            file = self.root / 'pgdata' / name;file.write_bytes(body);file.chmod(0o600)
        native_fstat = os.fstat
        class OwnedStat:
            def __init__(self, value):self.value = value
            def __getattr__(self, key):return 999 if key in {'st_uid', 'st_gid'} else getattr(self.value, key)
        # Only ownership is virtual on the unprivileged host; bytes, modes and inode seals are real.
        authority = type('Authority', (), {'seal': staticmethod(lambda value: tuple(getattr(value, name) for name in
                         ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')))})()
        with mock.patch.object(P, 'verify_workspace'), mock.patch.object(P.os, 'fstat', side_effect=lambda fd: OwnedStat(native_fstat(fd))):
            actual = P.database_body(self.workspace, authority)
            self.assertEqual(actual['Entrypoint'], ['/usr/lib/postgresql/14/bin/postgres'])
            self.assertNotIn('archive_library=', actual['Cmd'])
            for value in (b'17\n', b'14', b'14\nextra'):
                (self.root / 'pgdata/PG_VERSION').write_bytes(value)
                with self.subTest(value=value), self.assertRaises(ValueError):
                    P.database_body(self.workspace, authority)
            (self.root / 'pgdata/PG_VERSION').write_bytes(b'14\n')
            (self.root / 'pgdata/postmaster.pid').write_bytes(b'held')
            with self.assertRaises(ValueError):
                P.database_body(self.workspace, authority)
        (self.root / 'pgdata/postmaster.pid').unlink()
        with mock.patch.object(P, 'verify_workspace'), self.assertRaises(ValueError):
            P.database_body(self.workspace, authority)


if __name__ == '__main__':
    unittest.main()
