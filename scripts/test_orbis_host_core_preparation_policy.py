"""Private-file policy custody; release approval and image metadata are fixtures."""
import copy
from contextlib import contextmanager
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


M = load('orbis-host-core-preparation-policy.py', 'preparation_policy_test')
E = load('orbis-host-core-portable-enrollment.py', 'preparation_policy_enrollment_test')
A = load('orbis-host-retained-authority.py', 'preparation_policy_authority_test')
NODE, SOURCE = 'sha256:' + '1' * 64, 'sha256:' + '2' * 64


class MigrationPolicyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='clean-target-policy-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        code, state = self.root / 'approved-code', self.root / 'state'
        for path in (code, state):
            path.mkdir(mode=0o700)
        inventory = {}
        for name in ('core-inspection-worker.mjs', 'core-source-configuration-worker.mjs', 'core-clean-target-bootstrap-worker.mjs'):
            body = b'export const fixture = true;\n'
            (code / name).write_bytes(body)
            (code / name).chmod(0o400)
            inventory[name] = {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
        self.enterContext(mock.patch.object(M.I, 'require_root'))
        self.enterContext(mock.patch.object(A, 'OWNER', os.geteuid()))
        self.enrollment = object.__new__(E.CorePortableEnrollment)
        self.enrollment.state, self.enrollment.root, self.enrollment.context = state, self.root, 'fixture'
        self.enrollment.a, self.enrollment.P = A, A.P
        self.enrollment.runtime = mock.Mock()
        self.enrollment.runtime.image.return_value = {'Id': NODE, 'Os': 'linux', 'Architecture': 'arm64', 'Config': {'Volumes': None}}
        self.policies = M.CleanTargetMigrationPolicies(self.enrollment)
        trust = M.I.C.TrustedCoordinator(NODE, 'arm64', code, inventory, SOURCE, M.I.C.PARSER)
        self.install_approval = M.I.RootInstallationApproval(trust, '3' * 64, self.policies.digest(inventory),
            {SOURCE: {'parserProfile': M.I.C.PARSER, 'qualificationSha256': '4' * 64}})
        installed = self.policies.registry.install(self.install_approval)
        self.selection = M.I.InstalledSelection(installed['id'], installed['installationSha256'])
        sql = b'SELECT 1;'
        self.inventory = {'schema': M.INVENTORY, 'files': {
            'meta/_journal.json': {'bytes': 2, 'sha256': hashlib.sha256(b'{}').hexdigest()},
            '0000_fixture.sql': {'bytes': len(sql), 'sha256': hashlib.sha256(sql).hexdigest()}}}
        self.graph = [{'hash': hashlib.sha256(sql).hexdigest(), 'created_at': '1700000000000'}]

    def approval(self, **changes):
        values = dict(installation=self.selection, source_controller_image_id=SOURCE, release_sha256='3' * 64,
            inventory=self.inventory, inventory_sha256=self.policies.digest(self.inventory),
            graph=self.graph, graph_sha256=self.policies.digest(self.graph))
        return M.RootMigrationPolicyApproval(**(values | changes))

    def directory(self, selection=None):
        return self.policies.registry.base / 'generations' / (selection or self.selection).identifier / 'clean-target-migrations'

    def path(self):
        return self.directory() / (SOURCE[7:] + '.json')

    def test_inspection_qualification_alone_never_creates_migration_authority(self):
        with self.assertRaises(ValueError):
            self.policies.read(self.selection, SOURCE)
        self.assertFalse(self.directory().exists())
        self.enrollment.runtime.engine.assert_not_called()

    def test_rpc_dictionary_is_not_root_release_approval(self):
        with self.assertRaises(M.MigrationPolicyError):
            self.policies.install(vars(self.approval()))
        self.assertFalse(self.directory().exists())

    def test_approved_manifest_is_bound_to_generation_release_and_scope(self):
        result = self.policies.install(self.approval())
        record = self.policies.read(self.selection, SOURCE, expected_sha256=result['policySha256'])
        self.assertEqual(record['installedRuntime'], result['installedRuntime'])
        self.assertEqual(record['inventory'], self.inventory)
        self.assertEqual(record['graph'], self.graph)
        self.assertEqual(record['releaseSha256'], '3' * 64)
        self.assertTrue(all(record[key] == value for key, value in M.POLICIES.items()))
        self.enrollment.runtime.engine.assert_not_called()
        self.enrollment.runtime.change.assert_not_called()

    def test_independent_digest_or_release_mismatch_does_not_publish(self):
        for changes in ({'inventory_sha256': 'a' * 64}, {'graph_sha256': 'a' * 64}, {'release_sha256': 'a' * 64}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.policies.install(self.approval(**changes))
        self.assertFalse(self.directory().exists())

    def test_unqualified_source_image_is_not_enrolled(self):
        with self.assertRaises(ValueError):
            self.policies.install(self.approval(source_controller_image_id='sha256:' + '9' * 64))
        self.assertFalse(self.directory().exists())

    def test_policy_digest_mismatch_refuses_without_repair(self):
        self.policies.install(self.approval())
        before = self.path().read_bytes()
        with self.assertRaises(ValueError):
            self.policies.read(self.selection, SOURCE, expected_sha256='f' * 64)
        self.assertEqual(self.path().read_bytes(), before)

    def test_existing_approval_is_idempotent_but_changed_policy_is_not(self):
        first = self.policies.install(self.approval())
        before, inode = self.path().read_bytes(), self.path().stat().st_ino
        self.assertEqual(self.policies.install(self.approval()), first)
        graph = [{**self.graph[0], 'created_at': '1700000000001'}]
        with self.assertRaises(ValueError):
            self.policies.install(self.approval(graph=graph, graph_sha256=self.policies.digest(graph)))
        self.assertEqual(self.path().read_bytes(), before)
        self.assertEqual(self.path().stat().st_ino, inode)

    def test_old_generation_stays_pinned_and_new_one_does_not_inherit_policy(self):
        first = self.policies.install(self.approval())
        installed = self.policies.registry.install(self.install_approval)
        new = M.I.InstalledSelection(installed['id'], installed['installationSha256'])
        self.assertEqual(self.policies.read(self.selection, SOURCE, expected_sha256=first['policySha256'])['graph'], self.graph)
        with self.assertRaises(ValueError):
            self.policies.read(new, SOURCE)
        self.assertFalse(self.directory(new).exists())

    def test_revoked_generation_refuses_reads_and_new_policy(self):
        self.policies.install(self.approval())
        self.policies.registry.revoke(self.selection)
        for action in (lambda: self.policies.read(self.selection, SOURCE), lambda: self.policies.install(self.approval())):
            with self.assertRaises(ValueError):
                action()

    def test_shared_policy_directory_refuses(self):
        self.policies.install(self.approval())
        self.directory().chmod(0o777)
        with self.assertRaises(ValueError):
            self.policies.read(self.selection, SOURCE)

    def test_symlink_or_hardlink_policy_is_not_authority(self):
        self.policies.install(self.approval())
        path, original = self.path(), self.root / 'original-policy'
        path.rename(original)
        for kind in ('symlink', 'hardlink'):
            if kind == 'symlink':
                path.symlink_to(original)
            else:
                os.link(original, path)
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.policies.read(self.selection, SOURCE)
            path.unlink()

    def test_serialized_selection_and_invalid_image_are_rejected(self):
        for selection, source in ((vars(self.selection), SOURCE), (self.selection, '../../elsewhere')):
            with self.assertRaises(M.MigrationPolicyError):
                self.policies.read(selection, source)
        self.assertFalse(self.directory().exists())

    def test_manifest_requires_bounded_exact_executable_sequence(self):
        variants = []
        value = copy.deepcopy(self.inventory); value['files']['0000_fixture.sql']['bytes'] = True; variants.append((value, self.graph))
        value = copy.deepcopy(self.inventory); value['files']['../escape.sql'] = value['files'].pop('0000_fixture.sql'); variants.append((value, self.graph))
        value = copy.deepcopy(self.inventory); value['files']['0001_fixture.sql'] = value['files'].pop('0000_fixture.sql'); variants.append((value, self.graph))
        value = copy.deepcopy(self.inventory); del value['files']['meta/_journal.json']; variants.append((value, self.graph))
        value = copy.deepcopy(self.inventory); value['files']['0000_' + 'x' * 260 + '.sql'] = value['files'].pop('0000_fixture.sql'); variants.append((value, self.graph))
        variants.extend((self.inventory, graph) for graph in ([], [{'hash': 'f' * 64, 'created_at': '1'}],
            [{**self.graph[0], 'created_at': '01'}], [{**self.graph[0], 'created_at': '9007199254740992'}],
            [{**self.graph[0], 'extra': True}]))
        for inventory, graph in variants:
            with self.subTest(inventory=inventory, graph=graph), self.assertRaises(M.MigrationPolicyError):
                self.policies.install(self.approval(inventory=inventory, inventory_sha256=self.policies.digest(inventory),
                    graph=graph, graph_sha256=self.policies.digest(graph)))
        self.assertFalse(self.directory().exists())

    def test_record_tampering_and_noncanonical_bytes_are_rejected(self):
        self.policies.install(self.approval())
        body = self.path().read_bytes()
        record = self.enrollment.P.metadata(body)
        for changed in (body + b' ', self.enrollment.P.canonical(record | {'activation': True}),
                        self.enrollment.P.canonical(record | {'sourceControllerImageId': 'sha256:' + '8' * 64})):
            self.path().write_bytes(changed)
            with self.assertRaises(ValueError):
                self.policies.read(self.selection, SOURCE)
        self.path().write_bytes(body)

    def inspection(self):
        image = {'Id': M.B.TARGET.SOURCE.PG17_ARM64_IMAGE, 'Os': 'linux', 'Architecture': 'arm64',
                 'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}}
        execution = M.B.TARGET.SOURCE.role_bound_execution_profile(image, 'orbis_role', '5' * 64)
        node = self.enrollment.runtime.image.return_value
        self.enrollment.runtime.image.side_effect = lambda identifier: image if identifier == image['Id'] else node
        return SimpleNamespace(schema=M.B.CoreVersionedCleanTargetBootstrap.inspection_schema,
            enrollment=self.enrollment, configuration=self.policies.registry.configuration(SOURCE, self.selection),
            bootstrap_catalog=mock.Mock(return_value={'executionProfile': execution, 'databaseExecution': {
                'database': 'orbis_database', 'locale': {'encoding': 'UTF8', 'collate': 'C', 'ctype': 'C', 'provider': 'c'}}}))

    def test_factory_derives_profile_and_inventory_from_root_evidence(self):
        installed = self.policies.install(self.approval())
        inspection = self.inspection()
        depth = 0

        @contextmanager
        def guard():
            nonlocal depth
            depth += 1
            try:
                yield
            finally:
                depth -= 1

        manager = mock.Mock()
        manager.validate.side_effect = lambda actor: self.assertEqual(depth, 1)
        with mock.patch.object(M.B.CoreVersionedCleanTargetBootstrap, 'from_source_inspection', return_value=manager) as factory:
            self.assertIs(self.policies.bootstrap_for(inspection, 'inspection-id', {'ownerId': '1'},
                guard=guard, expected_sha256=installed['policySha256']), manager)
        args, kwargs = factory.call_args
        self.assertIs(args[0], inspection.configuration)
        self.assertIs(args[1], inspection)
        self.assertEqual(kwargs['migration_inventory'], self.inventory)
        self.assertEqual(kwargs['migration_graph'], self.graph)
        self.assertEqual(kwargs['profile']['role'], 'orbis_role')
        self.assertEqual(kwargs['profile']['database'], 'orbis_database')
        self.assertEqual(kwargs['profile']['schema'], M.B.TARGET.BOUNDED_SCHEMA)
        self.assertEqual(depth, 0)
        with kwargs['guard']():
            with self.assertRaises(ValueError):
                self.policies.registry.revoke(self.selection)
        self.assertFalse((self.directory().parent / 'revoked.json').exists())
        body = self.path().read_bytes()
        self.path().write_bytes(body + b' ')
        entered = False
        with self.assertRaises(ValueError):
            with kwargs['guard']():
                entered = True
        self.assertFalse(entered)
        self.assertEqual(depth, 0)
        self.enrollment.runtime.engine.assert_not_called()

    def test_factory_does_not_use_old_inspection_or_unapproved_migrations(self):
        inspection = self.inspection()
        with mock.patch.object(M.B.CoreVersionedCleanTargetBootstrap, 'from_source_inspection') as factory:
            with self.assertRaises(ValueError):
                self.policies.bootstrap_for(inspection, 'inspection-id', {'ownerId': '1'}, guard=lambda: mock.MagicMock())
            inspection.bootstrap_catalog.assert_not_called()
            inspection.schema = 'orbis.core-restore-inspection.v2'
            with self.assertRaises(M.MigrationPolicyError):
                self.policies.bootstrap_for(inspection, 'inspection-id', {'ownerId': '1'}, guard=lambda: mock.MagicMock())
            factory.assert_not_called()

    def test_factory_guard_rechecks_revocation_after_construction(self):
        self.policies.install(self.approval())
        inspection = self.inspection()
        with mock.patch.object(M.B.CoreVersionedCleanTargetBootstrap, 'from_source_inspection', return_value=mock.Mock()) as factory:
            self.policies.bootstrap_for(inspection, 'inspection-id', {'ownerId': '1'}, guard=lambda: mock.MagicMock())
        self.policies.registry.revoke(self.selection)
        with self.assertRaises(ValueError):
            with factory.call_args.kwargs['guard']():
                self.fail('revoked policy admitted work')

    def test_factory_checks_approval_again_on_guard_exit(self):
        self.policies.install(self.approval())
        inspection = self.inspection()
        with mock.patch.object(M.B.CoreVersionedCleanTargetBootstrap, 'from_source_inspection', return_value=mock.Mock()) as factory:
            self.policies.bootstrap_for(inspection, 'inspection-id', {'ownerId': '1'}, guard=lambda: mock.MagicMock())
        with self.assertRaises(ValueError):
            with factory.call_args.kwargs['guard']():
                self.path().write_bytes(self.path().read_bytes() + b' ')


if __name__ == '__main__':
    unittest.main()
