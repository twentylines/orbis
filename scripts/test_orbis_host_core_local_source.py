"""Completed real local authority/files with synthetic Docker and producer seams."""
import copy
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

import test_orbis_host_core_capture_completion as completed


spec = importlib.util.spec_from_file_location('core_local_source_subject', Path(__file__).with_name('orbis-host-core-local-source.py'))
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)


class LocalSourceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = completed.CoreCompletionTests('test_full_root_commit_preserves_lease_and_supports_completed_history')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.request = self.fixture.finish_request()
        self.fixture.subject.finish(self.fixture.point, self.request)
        self.W = completed.W
        self.enterContext(mock.patch.object(S, 'W', self.W))
        self.actor = {'ownerId': 17, 'sessionBinding': 'a' * 64, 'securityBinding': 'b' * 64}
        self.root, self.state = self.fixture.capture.root, self.fixture.state
        self.context, self.point = self.fixture.fixture.docker.context, self.fixture.point
        self.admission = self.state / 'core-capture-admissions' / self.point
        # Fixture construction is allowed to finalize; subject calls never are.
        self.enterContext(mock.patch.object(S.COMPLETION.CoreCaptureCompletion, 'completed', side_effect=AssertionError('forbidden finalizer')))
        self.enterContext(mock.patch.object(self.W.CORE.HOST, 'host_lock', side_effect=AssertionError('forbidden lock')))
        self.enterContext(mock.patch.object(self.W, 'Admission', side_effect=AssertionError('forbidden admission constructor')))

    def source(self, **changes):
        values = {'root': self.root, 'state_dir': self.state, 'context': self.context, 'point': self.point, 'actor': self.actor}
        return S.CoreLocalInspectionSource(**(values | changes))

    def inventory(self):
        result = {}
        for path in sorted(self.root.parent.rglob('*')):
            s = path.lstat()
            row = [s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_size, s.st_mtime_ns]
            if stat.S_ISREG(s.st_mode): row.append(hashlib.sha256(path.read_bytes()).hexdigest())
            result[str(path.relative_to(self.root.parent))] = row
        return result

    def dotenv_address(self, source):
        address = self.W.CORE.MAP.address(source._storage['plan']['resources'], self.root / '.env')
        self.assertIsNotNone(address)
        self.assertLess(address['resourceIndex'], source.basis()['resourceCount'])
        return address

    def optional_fixture(self):
        source = self.source()
        address = self.dotenv_address(source)
        index = address['resourceIndex']
        return source, index, source.bundle / ('resource-' + str(index).zfill(4))

    def test_completed_basis_is_distinct_nonexecuting_and_separates_original_owner_and_actor(self):
        before, calls = self.inventory(), list(self.fixture.fixture.docker.calls)
        source = self.source(); value = source.basis()
        self.assertEqual(value['schema'], S.SCHEMA)
        self.assertEqual(value['origin'], 'genuine-root-local-capture')
        self.assertEqual(value['sourceOwnerId'], 1)
        self.assertEqual(value['actor'], self.actor)
        self.assertTrue(value['sourceAuthority'])
        for key in ('environmentProved', 'currentCreateEnvProved', 'activationAuthorized', 'restoreAuthority'):
            self.assertFalse(value[key])
        self.assertNotIn('root', value)
        self.assertNotIn('envelope', json.dumps(value))
        self.assertNotIn(str(self.root), json.dumps(value))
        self.assertEqual(len(value['sourceWitnessSha256']), 64)
        self.assertEqual(self.inventory(), before)
        self.assertEqual(self.fixture.fixture.docker.calls, calls)
        value['actor']['ownerId'] = 999
        self.assertEqual(source.basis()['actor']['ownerId'], 17)

    def test_root_owned_0755_installation_keeps_private_completed_authority(self):
        self.root.chmod(0o755)
        before = self.inventory()
        source = self.source()
        self.assertTrue(source.basis()['sourceAuthority'])
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o700)
        self.assertEqual(self.inventory(), before)
        self.state.chmod(0o755)
        with self.assertRaises(S.LocalSourceError): self.source()

    def test_group_or_world_writable_installation_root_refuses(self):
        for mode in (0o720, 0o702, 0o775, 0o777):
            self.root.chmod(mode)
            before = self.inventory()
            with self.subTest(mode=mode), self.assertRaises(S.LocalSourceError): self.source()
            self.assertEqual(self.inventory(), before)

    def test_checkpoint_and_resource_access_is_readonly_fd_scoped(self):
        source = self.source(); basis = source.basis()
        with source.open_checkpoint() as fd:
            content = bytearray()
            while block := os.read(fd, 65536): content.extend(block)
            self.assertEqual(hashlib.sha256(content).hexdigest(), basis['checkpoint']['sha256'])
            with self.assertRaises(OSError): os.write(fd, b'forbidden')
        with self.assertRaises(OSError): os.fstat(fd)
        address = self.dotenv_address(source)
        with source.open_resource(address['resourceIndex'], address['resourcePath']) as resource:
            self.assertTrue(os.read(resource, 65536))
        with self.assertRaises(OSError): os.fstat(resource)

    def test_missing_committed_records_never_repairs_or_creates_markers(self):
        for name in ('source-retired.json', 'worker-terminal.json', 'completion-ready.json', 'completion-commit.json'):
            path = self.admission / name; body = path.read_bytes(); path.unlink()
            before = self.inventory()
            with self.subTest(name=name), self.assertRaises(S.LocalSourceError): self.source()
            self.assertEqual(self.inventory(), before)
            path.write_bytes(body); path.chmod(0o600)

    def test_changed_bound_record_and_foreign_root_context_actor_refuse(self):
        source = self.source()
        path = self.admission / 'completion-ready.json'; original = path.read_bytes()
        value = json.loads(original); value['terminalSha256'] = 'f' * 64
        self.fixture.write(self.admission, path.name, value)
        with self.assertRaises(S.LocalSourceError): source.basis()
        path.write_bytes(original)
        for values in ({'context': 'foreign'}, {'root': self.root.parent}, {'actor': self.actor | {'ownerId': True}},
                       {'actor': self.actor | {'sessionBinding': 'secret'}}, {'actor': self.actor | {'extra': True}}):
            with self.subTest(values=tuple(values)), self.assertRaises(S.LocalSourceError): self.source(**values)

    def test_active_selector_and_import_only_metadata_are_not_local_capture_authority(self):
        fence = self.fixture.capture.fence
        fence.write_bytes(b'active or ambiguous'); fence.chmod(0o600)
        with self.assertRaises(S.LocalSourceError): self.source()
        fence.unlink()
        job = self.fixture.fixture.capture.base / self.point / 'job.json'
        job.write_bytes(self.W.P.canonical({'schema': 'orbis.core-portable-provenance.v1', 'origin': 'authenticated-portable-import'}))
        with self.assertRaises(S.LocalSourceError): self.source()

    def test_replaced_record_inode_or_resource_and_invalid_relative_paths_refuse(self):
        source = self.source()
        path = self.admission / 'completion-ready.json'; body = path.read_bytes()
        replacement = path.with_name('replacement'); replacement.write_bytes(body); replacement.chmod(0o600); replacement.replace(path)
        with self.assertRaises(S.LocalSourceError): source.basis()
        source = self.source()
        bundle = self.fixture.fixture.bundle
        index = 0
        resource = bundle / ('resource-' + str(index).zfill(4))
        moved = bundle / 'retained-original'
        resource.rename(moved); resource.mkdir(mode=0o700)
        with self.assertRaises(S.LocalSourceError): source.basis()

    def test_resource_change_during_fd_scope_refuses_and_closes_descriptor(self):
        source = self.source(); address = self.dotenv_address(source)
        target = source.bundle / ('resource-' + str(address['resourceIndex']).zfill(4)) / address['resourcePath']
        with self.assertRaises(S.LocalSourceError):
            with source.open_resource(address['resourceIndex'], address['resourcePath']) as fd:
                target.write_bytes(b'replaced candidate without logging it')
        with self.assertRaises(OSError): os.fstat(fd)

    def test_candidate_path_and_size_limits_are_not_generic_host_read_authority(self):
        source = self.source()
        for path in ('../.env', '/etc/passwd', 'a/../.env', 'bad\nname', ''):
            with self.subTest(path=path), self.assertRaises(S.LocalSourceError):
                with source.open_resource(0, path): self.fail('must not yield')
        for index in (-1, True, 4096):
            with self.subTest(index=index), self.assertRaises(S.LocalSourceError):
                with source.open_resource(index): self.fail('must not yield')

    def test_optional_present_and_authenticated_leaf_and_ancestor_absence_are_readonly(self):
        source, index, _ = self.optional_fixture()
        before = self.inventory()
        address = self.dotenv_address(source)
        with source.open_optional_resource(index, address['resourcePath']) as result:
            self.assertIsInstance(result, S.OptionalResourceRead)
            self.assertTrue(result.present)
            self.assertTrue(os.read(result.descriptor, 65536))
            with self.assertRaises(OSError): os.write(result.descriptor, b'forbidden')
        with self.assertRaises(OSError): os.fstat(result.descriptor)
        for relative in ('absent-passkeys.json', 'absent-parent/passkeys.json'):
            with self.subTest(relative=relative):
                with source.open_optional_resource(index, relative) as result:
                    self.assertFalse(result.present)
                    self.assertIsNone(result.descriptor)
                with self.assertRaises(S.LocalSourceError):
                    with source.open_resource(index, relative): self.fail('mandatory must refuse')
        self.assertEqual(self.inventory(), before)

    def test_optional_exclusions_and_invalid_requests_never_mean_absent(self):
        source, index, _ = self.optional_fixture()
        resources = source._storage['plan']['resources']
        excluded = [(i, p) for i, resource in enumerate(resources) for p in resource.get('excludedPaths', [])]
        self.assertTrue(excluded)
        for resource_index, path in excluded:
            for relative in (path, path + '/passkeys.json'):
                with self.subTest(relative=relative), self.assertRaises(S.LocalSourceError):
                    with source.open_optional_resource(resource_index, relative): self.fail('excluded')
        for relative in ('../passkeys.json', '/etc/passwd', 'a/../b', '', 'bad\nname'):
            with self.subTest(relative=relative), self.assertRaises(S.LocalSourceError):
                with source.open_optional_resource(index, relative): self.fail('invalid')
        for options in ({'index': True}, {'index': -1}, {'index': 4096}, {'index': index, 'maximum': 0}):
            with self.subTest(options=options), self.assertRaises(S.LocalSourceError):
                with source.open_optional_resource(**options): self.fail('invalid')

    def test_optional_read_and_verification_errors_never_mean_absent(self):
        source, index, root = self.optional_fixture()
        actual_open = os.open
        for error in (PermissionError(errno.EACCES, 'private-do-not-log'), OSError(errno.EIO, 'private-do-not-log'),
                      OSError(errno.ELOOP, 'private-do-not-log'), NotADirectoryError(errno.ENOTDIR, 'private-do-not-log')):
            def injected(path, *args, **kwargs):
                if path == 'passkeys.json': raise error
                return actual_open(path, *args, **kwargs)
            with self.subTest(error=type(error).__name__), mock.patch.object(S.os, 'open', side_effect=injected):
                with self.assertRaises(S.LocalSourceError) as caught:
                    with source.open_optional_resource(index, 'passkeys.json'): self.fail('error')
                self.assertNotIn('private-do-not-log', str(caught.exception))
        with mock.patch.object(source, '_verify', side_effect=FileNotFoundError('private-do-not-log')):
            with self.assertRaises(S.LocalSourceError):
                with source.open_optional_resource(index, 'passkeys.json'): self.fail('unverified')
        (root / 'unexpected').write_bytes(b'changed tree')
        with self.assertRaises(S.LocalSourceError):
            with source.open_optional_resource(index, 'passkeys.json'): self.fail('changed')

    def test_optional_absent_leaf_created_during_scope_refuses(self):
        source, index, root = self.optional_fixture()
        with self.assertRaises(S.LocalSourceError):
            with source.open_optional_resource(index, 'passkeys.json') as result:
                self.assertFalse(result.present)
                (root / 'passkeys.json').write_bytes(b'not logged')

    def test_optional_missing_ancestor_created_during_scope_refuses(self):
        source, index, root = self.optional_fixture()
        with self.assertRaises(S.LocalSourceError):
            with source.open_optional_resource(index, 'missing-parent/passkeys.json') as result:
                self.assertFalse(result.present)
                (root / 'missing-parent').mkdir(mode=0o700)

    def test_optional_existing_parent_replaced_during_scope_refuses(self):
        source, index, root = self.optional_fixture()
        directory = next(path for path in root.iterdir() if path.is_dir() and not path.is_symlink())
        relative = directory.relative_to(root).as_posix() + '/passkeys.json'
        with self.assertRaises(S.LocalSourceError):
            with source.open_optional_resource(index, relative) as result:
                self.assertFalse(result.present)
                directory.rename(directory.with_name('retained-original-parent'))
                directory.mkdir(mode=0o700)

    def test_optional_present_fd_change_refuses_and_closes_fd(self):
        source, index, root = self.optional_fixture()
        address = self.dotenv_address(source)
        with self.assertRaises(S.LocalSourceError):
            with source.open_optional_resource(index, address['resourcePath']) as result:
                self.assertTrue(result.present)
                (root / address['resourcePath']).write_bytes(b'changed-not-logged')
        with self.assertRaises(OSError): os.fstat(result.descriptor)

    def test_optional_symlink_never_means_absent(self):
        source, index, root = self.optional_fixture()
        # The genuine-tree check rejects even a dangling link before traversal.
        (root / 'passkeys.json').symlink_to('absent-target')
        with self.assertRaises(S.LocalSourceError):
            with source.open_optional_resource(index, 'passkeys.json'): self.fail('symlink')

    def test_optional_non_directory_parent_and_oversized_file_refuse(self):
        source, index, _ = self.optional_fixture()
        address = self.dotenv_address(source)
        with self.assertRaises(S.LocalSourceError):
            with source.open_optional_resource(index, address['resourcePath'] + '/passkeys.json'): self.fail('not-directory')
        with self.assertRaises(S.LocalSourceError):
            with source.open_optional_resource(index, address['resourcePath'], maximum=1): self.fail('oversized')

    def test_optional_foreign_capture_and_missing_resource_are_not_absence(self):
        with self.assertRaises(S.LocalSourceError): self.source(context='foreign')
        source, index, root = self.optional_fixture()
        root.rename(root.with_name('retained-original-resource'))
        with self.assertRaises(S.LocalSourceError):
            with source.open_optional_resource(index, 'passkeys.json'): self.fail('missing resource')


class ConfigurationSourceTests(unittest.TestCase):
    source = LocalSourceTests.source
    inventory = LocalSourceTests.inventory

    def setUp(self):
        fixtures = completed.joined.checkpoint.workers.F
        original = fixtures.CoreCaptureTests.setUp

        def configured(fixture):
            original(fixture)
            fixture.source['enrollment']['files'] = {'.env': hashlib.sha256((fixture.root / '.env').read_bytes()).hexdigest()}
            original_core = fixture.docker.core
            extra = [{'Type': 'bind', 'Source': str(fixture.root), 'Destination': '/data', 'RW': True}]
            name = self._testMethodName
            if name in ('test_present_passkeys_bound_bytes_and_pathless_witness', 'test_most_specific_passkey_mount_wins',
                        'test_oversized_passkey_store_refuses'):
                store = fixture.root / 'state/auth/passkeys.json'
                store.parent.mkdir(parents=True, mode=0o700)
                store.write_bytes(b'{"version":1,"users":{}}' if name != 'test_oversized_passkey_store_refuses' else b'x' * (512 * 1024 + 1))
                store.chmod(0o600)
            if name == 'test_most_specific_passkey_mount_wins':
                selected = fixture.root / 'selected-passkeys.json'
                selected.write_bytes(b'{"version":1,"users":{},"selected":true}')
                selected.chmod(0o600)
                extra.append({'Type': 'bind', 'Source': str(selected), 'Destination': '/data/state/auth/passkeys.json', 'RW': True})
            if name in ('test_alias_selection_refuses', 'test_nested_selection_refuses'):
                extra.append({'Type': 'bind', 'Source': str(fixture.root / '.env' if name == 'test_alias_selection_refuses' else fixture.root),
                              'Destination': '/data/state/auth/passkeys.json', 'RW': True})
            if name == 'test_unmapped_passkey_path_is_not_absence':
                extra = []
            if name == 'test_preserved_most_specific_mount_never_falls_back':
                extra.append({'Type': 'bind', 'Source': str(fixture.root / 'app-data'), 'Destination': '/data/state/auth', 'RW': True})
            if name == 'test_excluded_passkey_path_is_not_absence':
                excluded = fixture.root / 'state/auth'
                excluded.mkdir(parents=True, mode=0o700)
                extra.append({'Type': 'bind', 'Source': str(excluded), 'Destination': '/data/backups', 'RW': True})
            if name == 'test_original_configuration_hash_mismatch_refuses':
                fixture.source['enrollment']['files']['.env'] = 'f' * 64
            if name == 'test_missing_original_configuration_hash_refuses':
                fixture.source['enrollment'].pop('files')

            def core(identifier):
                value = original_core(identifier)
                if identifier == fixture.docker.controller_id:
                    value['mounts'].extend(copy.deepcopy(extra))
                return value
            fixture.docker.core = core

        self.enterContext(mock.patch.object(fixtures.CoreCaptureTests, 'setUp', configured))
        LocalSourceTests.setUp(self)

    def read(self, source, **changes):
        arguments = {'expected_controller_image_id': source.basis()['roles']['controller']['imageId'],
                     'parser_profile': S.CONFIGURATION_PROFILE}
        return source.open_configuration_source(**(arguments | changes))

    def test_present_passkeys_bound_bytes_and_pathless_witness(self):
        source = self.source(); before = self.inventory(); basis = source.basis()
        with self.read(source) as result:
            self.assertEqual(result.configuration, b'private test bytes')
            self.assertEqual(result.passkeys, b'{"version":1,"users":{}}')
            self.assertEqual(set(result.witness), {'schema', 'sourceWitnessSha256', 'sourceManifestSha256', 'controllerImageId',
                'parserProfile', 'sourceConfigurationFileSha256', 'configuration', 'passkeys', 'environmentProved', 'restoreAuthority'})
            self.assertEqual(result.witness['schema'], S.CONFIGURATION_SCHEMA)
            for key in ('sourceWitnessSha256', 'sourceManifestSha256', 'sourceConfigurationFileSha256'):
                self.assertEqual(result.witness[key], basis[key])
            self.assertEqual(result.witness['controllerImageId'], basis['roles']['controller']['imageId'])
            self.assertEqual(result.witness['parserProfile'], S.CONFIGURATION_PROFILE)
            for key in ('environmentProved', 'restoreAuthority'): self.assertFalse(result.witness[key])
            for key in ('configuration', 'passkeys'):
                self.assertEqual(set(result.witness[key]), {'mountSha256', 'addressSha256', 'resourceRecordSha256', 'present', 'sha256', 'bytes'})
                self.assertTrue(result.witness[key]['present'])
                self.assertEqual(result.witness[key]['sha256'], hashlib.sha256(getattr(result, key)).hexdigest())
                self.assertEqual(result.witness[key]['bytes'], len(getattr(result, key)))
            self.assertNotIn(str(self.root), json.dumps(result.witness))
            self.assertNotIn('/data', json.dumps(result.witness))
            self.assertNotIn('passkeys.json', json.dumps(result.witness))
            self.assertNotIn('private test bytes', repr(result))
            self.assertNotIn('"users"', repr(result))
            with self.assertRaises(TypeError): json.dumps(result)
        self.assertEqual(self.inventory(), before)

    def test_absent_passkey_store_requires_authenticated_optional_absence(self):
        source = self.source(); before = self.inventory()
        with self.read(source) as result:
            self.assertIsNone(result.passkeys)
            self.assertFalse(result.witness['passkeys']['present'])
            self.assertIsNone(result.witness['passkeys']['sha256'])
            self.assertEqual(result.witness['passkeys']['bytes'], 0)
            self.assertTrue(result.witness['configuration']['present'])
        self.assertEqual(self.inventory(), before)

    def test_most_specific_passkey_mount_wins(self):
        source = self.source()
        with self.read(source) as result:
            self.assertEqual(result.passkeys, b'{"version":1,"users":{},"selected":true}')

    def test_wrong_image_or_parser_is_not_qualified_by_equality_binding(self):
        source = self.source()
        for changes in ({'expected_controller_image_id': 'sha256:' + 'f' * 64}, {'expected_controller_image_id': 'bad'},
                        {'parser_profile': 'unknown'}, {'parser_profile': None}):
            with self.subTest(keys=tuple(changes)), self.assertRaises(S.LocalSourceError):
                with self.read(source, **changes): self.fail('unbound')

    def test_unmapped_passkey_path_is_not_absence(self):
        source = self.source()
        with self.assertRaises(S.LocalSourceError):
            with self.read(source): self.fail('unmapped')

    def test_preserved_most_specific_mount_never_falls_back(self):
        source = self.source()
        with self.assertRaises(S.LocalSourceError):
            with self.read(source): self.fail('preserved')

    def test_excluded_passkey_path_is_not_absence(self):
        source = self.source()
        with self.assertRaises(S.LocalSourceError):
            with self.read(source): self.fail('excluded')

    def test_alias_selection_refuses(self):
        source = self.source()
        with self.assertRaises(S.LocalSourceError):
            with self.read(source): self.fail('alias')

    def test_nested_selection_refuses(self):
        source = self.source()
        with self.assertRaises(S.LocalSourceError):
            with self.read(source): self.fail('nested')

    def test_original_configuration_hash_mismatch_refuses(self):
        source = self.source()
        with self.assertRaises(S.LocalSourceError):
            with self.read(source): self.fail('hash')

    def test_missing_original_configuration_hash_refuses(self):
        source = self.source()
        with self.assertRaises(S.LocalSourceError):
            with self.read(source): self.fail('missing original hash')

    def test_oversized_passkey_store_refuses(self):
        source = self.source()
        with self.assertRaises(S.LocalSourceError):
            with self.read(source): self.fail('oversized')

    def test_read_failure_never_substitutes_null_passkeys_or_leaks_cause(self):
        source = self.source()
        with mock.patch.object(source, 'open_optional_resource', side_effect=PermissionError('fixture-secret-error')):
            with self.assertRaises(S.LocalSourceError) as caught:
                with self.read(source): self.fail('must refuse')
            self.assertNotIn('fixture-secret-error', str(caught.exception))
            self.assertTrue(caught.exception.__suppress_context__)

    def test_change_after_private_bytes_selected_refuses_operation(self):
        source = self.source()
        with self.assertRaises(S.LocalSourceError):
            with self.read(source) as result:
                self.assertIsNone(result.passkeys)
                address = self.W.CORE.MAP.address(source._storage['plan']['resources'], self.root / '.env')
                path = source.bundle / ('resource-' + str(address['resourceIndex']).zfill(4)) / address['resourcePath']
                path.write_bytes(b'changed while held')


class DatabaseSourceTests(unittest.TestCase):
    source = LocalSourceTests.source
    inventory = LocalSourceTests.inventory

    def setUp(self):
        worker_fixtures = completed.joined.checkpoint.workers.F
        original_setup = worker_fixtures.CoreCaptureTests.setUp
        def configured(fixture):
            original_setup(fixture)
            fixture.docker.services[worker_fixtures.identifier('runtipi-db')]['imageId'] = S.INSPECTION.PG17_ARM64_IMAGE
            original_object = fixture.docker._object
            def observed(arguments):
                result = original_object(arguments)
                if arguments[:2] == ['info', '--format']:
                    result['architecture'] = 'arm64'
                if arguments[:2] == ['image', 'inspect']:
                    result['Architecture'] = 'arm64'
                return result
            fixture.docker._object = observed
        self.enterContext(mock.patch.object(worker_fixtures.CoreCaptureTests, 'setUp', configured))
        checkpoints = completed.joined.checkpoint.checkpoints
        original_prepare = checkpoints.CheckpointTests.prepare
        def physical(fixture):
            (fixture.docker.database_directory / 'PG_VERSION').write_bytes(b'17\n')
            return original_prepare(fixture)
        self.enterContext(mock.patch.object(checkpoints.CheckpointTests, 'prepare', physical))
        LocalSourceTests.setUp(self)
        profile = S.INSPECTION.image_profile({'Id': S.INSPECTION.PG17_ARM64_IMAGE, 'Os': 'linux', 'Architecture': 'arm64',
                                             'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}})
        self.profile = {**profile, 'uid': os.geteuid(), 'gid': os.getegid()}
        native_validate = S.INSPECTION.validate_profile
        def fixture_profile(value):
            native_validate({**value, 'uid': 70, 'gid': 70})
            return value
        self.enterContext(mock.patch.object(S.INSPECTION, 'validate_profile', side_effect=fixture_profile))
        if not hasattr(os, 'listxattr') or not hasattr(os, 'getxattr'):
            self.enterContext(mock.patch.object(S.INSPECTION.M.R.PACK, 'attributes', return_value={}))
        self.destination = self.root.parent / 'isolated-database-copy'
        copy_parent = os.environ.get('ORBIS_CORE_COPY_TEST_DIR')
        if copy_parent is not None:
            parent = Path(copy_parent)
            if not parent.is_absolute() or parent.resolve(strict=True) != parent:
                raise ValueError('The explicit copy fixture directory is invalid.')
            with self.W.A.protected_directory(parent):
                pass
            temporary = tempfile.TemporaryDirectory(prefix='local-database-copy-', dir=parent)
            self.addCleanup(temporary.cleanup)
            self.destination = Path(temporary.name) / 'inspection'

    def database_path(self, source):
        location = source.inspection_binding()['database']
        return source.bundle / ('resource-' + str(location['resourceIndex']).zfill(4)) / location['resourcePath']

    def test_local_inspection_binding_preserves_basis_owner_and_exact_resource_digest(self):
        source = self.source(); before = source.basis(); inventory = self.inventory()
        binding = source.inspection_binding()
        self.assertEqual(binding['schema'], S.INSPECTION_SCHEMA)
        self.assertEqual(binding['origin'], 'genuine-root-local-capture')
        self.assertEqual(binding['sourceOwnerId'], 1)
        self.assertEqual(before['actor']['ownerId'], 17)
        self.assertNotIn('actor', binding)
        self.assertEqual(binding['images']['database'], S.INSPECTION.PG17_ARM64_IMAGE)
        self.assertEqual(binding['compatibility']['database']['major'], 17)
        self.assertEqual(binding['compatibility']['architecture'], 'arm64')
        self.assertEqual(binding['sourceWitnessSha256'], before['sourceWitnessSha256'])
        self.assertFalse(binding['environmentProved']); self.assertFalse(binding['restoreAuthority'])
        recipe = {'schema': S.RESOURCE_SCHEMA, **{key: binding[key] for key in ('sourceWitnessSha256', 'captureJobSha256',
                  'checkpointStorageSha256', 'portableStorageSha256', 'database', 'resources')}}
        self.assertEqual(binding['resourcesSha256'], hashlib.sha256(self.W.P.canonical(recipe)).hexdigest())
        self.assertNotEqual(binding['resourcesSha256'], hashlib.sha256(self.W.P.canonical(binding['resources'])).hexdigest())
        self.assertNotIn(str(self.root), json.dumps(binding))
        self.assertNotIn('archiveSha256', binding)
        self.assertEqual(source.basis(), before)
        self.assertEqual(self.inventory(), inventory)
        binding['database']['resourcePath'] = 'foreign'
        self.assertNotEqual(source.inspection_binding()['database']['resourcePath'], 'foreign')

    def test_scoped_database_copy_preserves_original_and_returns_verified_overlay(self):
        source = self.source(); before = source.basis()
        path = self.database_path(source); original = (path / 'PG_VERSION').read_bytes()
        if os.environ.get('ORBIS_CORE_COPY_TEST_DIR') is not None:
            capacities = {}
            for label, directory in (('source', path), ('destination', self.destination.parent)):
                descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    capacity = os.fstatvfs(descriptor)
                    capacities[label] = {'device': os.fstat(descriptor).st_dev, 'availableBytes': capacity.f_bavail * capacity.f_frsize}
                finally:
                    os.close(descriptor)
            print(json.dumps({'event': 'copy-fixture-capacity', **capacities}, sort_keys=True))
        with source.open_database_source() as capability:
            self.assertFalse(hasattr(capability, 'descriptor'))
            self.assertFalse(hasattr(capability, 'path'))
            with self.assertRaises(TypeError): json.dumps(capability)
            receipt = capability.copy_to(self.destination, self.profile)
            self.assertEqual(S.INSPECTION.verify_overlay(self.destination, receipt, source.a), receipt)
            self.assertFalse(receipt['restoreAuthority'])
            self.assertEqual((self.destination / 'pgdata/PG_VERSION').read_bytes(), original)
            with self.assertRaises(S.LocalSourceError): capability.copy_to(self.destination, self.profile)
        with self.assertRaises(S.LocalSourceError): capability.copy_to(self.root.parent / 'after-scope', self.profile)
        self.assertEqual((path / 'PG_VERSION').read_bytes(), original)
        self.assertEqual(source.basis(), before)

    def test_scoped_source_replacement_refuses_before_copy(self):
        source = self.source(); path = self.database_path(source)
        with self.assertRaises(S.LocalSourceError):
            with source.open_database_source() as capability:
                path.rename(path.with_name('retained-original-pgdata'))
                path.mkdir(mode=0o700)
                capability.copy_to(self.destination, self.profile)
        self.assertFalse(self.destination.exists())

    def test_scoped_tree_change_refuses_even_without_copy(self):
        source = self.source(); path = self.database_path(source)
        with self.assertRaises(S.LocalSourceError):
            with source.open_database_source():
                (path / 'unexpected').write_bytes(b'changed captured tree')

    def test_scoped_copy_refuses_unbound_profile_and_source_overlap(self):
        source = self.source()
        with source.open_database_source() as capability:
            for changes in ({'imageId': 'sha256:' + 'f' * 64}, {'major': 16}, {'architecture': 'amd64'}):
                with self.subTest(keys=tuple(changes)), self.assertRaises(S.LocalSourceError):
                    capability.copy_to(self.destination, self.profile | changes)
            for destination in (self.root / 'forbidden-copy', source.bundle / 'forbidden-copy', self.state / 'time-machine-core/forbidden-copy'):
                with self.subTest(destination=destination.name), self.assertRaises(S.LocalSourceError):
                    capability.copy_to(destination, self.profile)
                self.assertFalse(destination.exists())
        self.assertFalse(self.destination.exists())

    def test_scoped_copy_failure_never_returns_overlay_or_leaks_private_cause(self):
        source = self.source()
        with source.open_database_source() as capability:
            with mock.patch.object(S.INSPECTION, 'prepare_copy_from_fd', side_effect=OSError(errno.EXDEV, 'fixture-private-cause')):
                with self.assertRaises(S.LocalSourceError) as caught:
                    capability.copy_to(self.destination, self.profile)
                self.assertNotIn('fixture-private-cause', str(caught.exception))
                self.assertTrue(caught.exception.__suppress_context__)

    def test_original_database_mapping_tamper_is_not_a_caller_selected_source(self):
        source = self.source()
        job = self.fixture.fixture.capture.base / self.point / 'job.json'
        value = json.loads(job.read_bytes()); value['portableStorage']['database']['resourcePath'] = '../foreign'
        job.write_bytes(self.W.P.canonical(value))
        with self.assertRaises(S.LocalSourceError): source.inspection_binding()
        with self.assertRaises(S.LocalSourceError):
            with source.open_database_source(): self.fail('changed mapping')


if __name__ == '__main__':
    unittest.main()
