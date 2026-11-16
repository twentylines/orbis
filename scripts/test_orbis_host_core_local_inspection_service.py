"""Root factory custody checks; source and authenticated controller peer are fixture seams."""
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
import unittest

import test_orbis_host_core_inspection_installation as fixtures

spec = importlib.util.spec_from_file_location('local_inspection_service_test', Path(__file__).with_name('orbis-host-core-local-inspection-service.py'))
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)
ID = 'a71c77d2-f420-440e-951b-083209514e72'
POINT = 'd5d82d7c-1f6a-429e-90ea-787833c06fe3'


class FactoryTests(unittest.TestCase):
    def setUp(self):
        fixture = fixtures.InstallationTests('test_missing_installation_is_not_created_by_read')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.root, self.state = fixture.root, fixture.state
        self.registry, self.approval, self.enrollment = fixture.registry, fixture.approval, fixture.enrollment
        self.enterContext(mock.patch.object(S.I, 'require_root'))
        self.installed = self.registry.install(self.approval)
        self.actor = {'ownerId': 1, 'sessionBinding': 'a' * 64, 'securityBinding': 'b' * 64}
        self.service = SimpleNamespace(root=self.root, context='fixture', state_dir=self.state,
            HOST=SimpleNamespace(AUTHORITY=fixtures.A, IDENTITY=SimpleNamespace(PUBLICATION=fixtures.A.P)),
            retained_restores=lambda: SimpleNamespace(runtime=self.enrollment.runtime))
        self.source = mock.Mock()
        self.source.basis.return_value = {'roles': {'controller': {'imageId': fixtures.SOURCE}}}
        self.source_constructor = self.enterContext(mock.patch.object(S.L.LOCAL, 'CoreLocalInspectionSource', return_value=self.source))
        self.request = {'id': ID, 'pointId': POINT, 'actor': self.actor}

    def record(self, *, bootstrap=False, **changes):
        directory = self.enrollment.child(self.state, 'core-restore-inspections') / ID
        directory.mkdir(mode=0o700)
        kind = S.L.CoreVersionedBootstrapSourceInspection if bootstrap else S.L.CoreLocalRestoreInspection
        record = {'schema': kind.schema, 'id': ID, 'root': str(self.root),
                  'context': 'fixture', 'scope': 'inspection-only', 'sandboxProfile': kind.profile,
                  'activationAuthorized': False, 'actor': self.actor, 'pointId': POINT, 'phase': 'recovery-required',
                  'evidence': {'source': {'pointId': POINT}},
                  'installedRuntime': {**self.installed, 'sourceControllerImageId': fixtures.SOURCE}}
        fixtures.A.atomic(directory / 'job.json', fixtures.A.P.canonical(record | changes))

    def test_prepare_selects_qualified_image_from_original_root_source_only(self):
        manager = S.manager_for(self.service, 'prepare', self.request)
        self.assertEqual(manager.configuration.trust.source_controller_image_id, fixtures.SOURCE)
        self.assertEqual(manager.configuration.installed_selection.identifier, self.installed['id'])
        self.source_constructor.assert_called_once_with(self.root, self.state, 'fixture', POINT, self.actor)

    def test_browser_cannot_supply_code_image_or_import_identity(self):
        for key, value in [('codeDirectory', '/untrusted'), ('imageId', fixtures.NODE), ('enrollmentId', ID)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                S.manager_for(self.service, 'prepare', self.request | {key: value})
        self.source_constructor.assert_not_called()

    def test_revocation_after_factory_lookup_blocks_prepare_before_any_job_write(self):
        manager = S.manager_for(self.service, 'prepare', self.request)
        self.registry.revoke(fixtures.I.InstalledSelection(self.installed['id'], self.installed['installationSha256']))
        with self.assertRaises(ValueError):
            manager.prepare(self.request, privileged_peer=True)
        self.assertFalse((self.state / 'core-restore-inspections').exists())
        self.enrollment.runtime.engine.assert_not_called()

    def test_status_uses_saved_generation_without_requiring_capture_bytes(self):
        self.record()
        self.registry.install(self.approval)
        self.source_constructor.side_effect = AssertionError('held status must not read unavailable capture')
        request = {'id': ID, 'actor': self.actor}
        manager = S.manager_for(self.service, 'status', request)
        result = manager.status(request, privileged_peer=True)
        self.assertEqual(result['phase'], 'recovery-required')
        self.assertEqual(manager.configuration.installed_selection.identifier, self.installed['id'])

    def test_repeated_prepare_uses_saved_generation_and_checks_the_original_point(self):
        self.record()
        self.registry.install(self.approval)
        self.source_constructor.side_effect = AssertionError('must not re-admit the capture')
        manager = S.manager_for(self.service, 'prepare', self.request)
        self.assertEqual(manager.configuration.installed_selection.identifier, self.installed['id'])
        self.assertEqual(manager.prepare(self.request, privileged_peer=True)['phase'], 'recovery-required')
        with self.assertRaises(ValueError):
            S.manager_for(self.service, 'prepare', self.request | {'pointId': ID})

    def test_other_actor_and_unregistered_records_cannot_choose_runtime(self):
        self.record()
        for actor in (self.actor | {'ownerId': 2}, self.actor | {'sessionBinding': 'c' * 64}):
            with self.subTest(actor=actor), self.assertRaises(ValueError):
                S.manager_for(self.service, 'status', {'id': ID, 'actor': actor})
        directory = self.state / 'core-restore-inspections' / ID
        record = self.enrollment.json(directory / 'job.json')
        record.pop('installedRuntime')
        fixtures.A.atomic(directory / 'job.json', fixtures.A.P.canonical(record))
        with self.assertRaises(ValueError):
            S.manager_for(self.service, 'status', {'id': ID, 'actor': self.actor})

    def test_bootstrap_source_factory_selects_fresh_versioned_consent(self):
        manager = S.bootstrap_source_manager_for(self.service, 'prepare', self.request)
        self.assertIs(type(manager), S.L.CoreVersionedBootstrapSourceInspection)
        self.assertEqual(manager.version, 4)
        self.assertEqual(manager.configuration.installed_selection.identifier, self.installed['id'])
        self.assertEqual(manager.configuration.trust.source_controller_image_id, fixtures.SOURCE)
        legacy = S.manager_for(self.service, 'prepare', self.request)
        self.assertIs(type(legacy), S.L.CoreLocalRestoreInspection)
        self.assertEqual(legacy.version, 2)
        self.assertFalse((self.state / 'core-restore-inspections').exists())

    def test_bootstrap_source_cannot_relabel_old_inspection_records(self):
        self.record()
        file = self.state / 'core-restore-inspections' / ID / 'job.json'
        for schema in ('orbis.core-restore-inspection.v2', 'orbis.core-restore-inspection.v3'):
            record = self.enrollment.json(file)
            record['schema'] = schema
            fixtures.A.atomic(file, fixtures.A.P.canonical(record))
            before = file.read_bytes()
            for action, body in (('prepare', self.request), ('approve', {'id': ID, 'actor': self.actor}),
                                 ('status', {'id': ID, 'actor': self.actor})):
                with self.subTest(schema=schema, action=action), self.assertRaises(ValueError):
                    S.bootstrap_source_manager_for(self.service, action, body)
            self.assertEqual(file.read_bytes(), before)
        self.source_constructor.assert_not_called()

    def test_bootstrap_source_status_keeps_saved_installation_and_actor(self):
        self.record(bootstrap=True)
        self.registry.install(self.approval)
        self.source_constructor.side_effect = AssertionError('held status must not read capture bytes')
        request = {'id': ID, 'actor': self.actor}
        manager = S.bootstrap_source_manager_for(self.service, 'status', request)
        self.assertEqual(manager.configuration.installed_selection.identifier, self.installed['id'])
        self.assertEqual(manager.status(request, privileged_peer=True)['version'], 4)
        for actor in (self.actor | {'ownerId': 2}, self.actor | {'sessionBinding': 'c' * 64}):
            with self.subTest(actor=actor), self.assertRaises(ValueError):
                S.bootstrap_source_manager_for(self.service, 'status', request | {'actor': actor})

    def test_bootstrap_source_cannot_accept_caller_runtime_or_scope(self):
        for key, value in [('codeDirectory', '/untrusted'), ('imageId', fixtures.NODE), ('workerVersion', 2),
                           ('executionProfile', 'unqualified'), ('scope', 'restore')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                S.bootstrap_source_manager_for(self.service, 'prepare', self.request | {key: value})
        self.source_constructor.assert_not_called()

    def test_programmatic_shared_enrollment_preserves_exact_runtime_capability(self):
        shared = S.L.BASE.E.CorePortableEnrollment(self.service)
        manager = S.bootstrap_source_manager_for(self.service, 'prepare', self.request, enrollment=shared)
        self.assertIs(manager.enrollment, shared)
        self.assertIs(manager.configuration.enrollment, shared)
        default = S.bootstrap_source_manager_for(self.service, 'prepare', self.request)
        self.assertIsNot(default.enrollment, shared)
        self.assertIs(default.enrollment.service, self.service)

    def test_programmatic_enrollment_rejects_duck_types_other_service_and_every_identity_drift(self):
        shared = S.L.BASE.E.CorePortableEnrollment(self.service)
        with self.assertRaises(ValueError):
            S.bootstrap_source_manager_for(self.service, 'prepare', self.request, enrollment=SimpleNamespace(**vars(shared)))
        for field, value in (('service', copy.copy(self.service)), ('host', copy.copy(self.service.HOST)),
                             ('a', object()), ('P', object()), ('root', self.root / 'different'),
                             ('context', 'other'), ('state', self.state / 'different'), ('runtime', object())):
            original = getattr(shared, field)
            setattr(shared, field, value)
            try:
                with self.subTest(field=field), self.assertRaises(ValueError):
                    S.bootstrap_source_manager_for(self.service, 'prepare', self.request, enrollment=shared)
            finally:
                setattr(shared, field, original)
        self.source_constructor.assert_not_called()

    def test_revoked_bootstrap_source_installation_cannot_write_a_job(self):
        manager = S.bootstrap_source_manager_for(self.service, 'prepare', self.request)
        self.registry.revoke(fixtures.I.InstalledSelection(self.installed['id'], self.installed['installationSha256']))
        with self.assertRaises(ValueError):
            manager.prepare(self.request, privileged_peer=True)
        self.assertFalse((self.state / 'core-restore-inspections').exists())
        self.enrollment.runtime.engine.assert_not_called()
