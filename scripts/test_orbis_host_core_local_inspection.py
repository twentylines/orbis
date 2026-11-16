"""Local admission lifecycle with synthetic source/runtime, never native execution proof."""
import copy
from contextlib import contextmanager
import importlib.util
from pathlib import Path
from unittest import mock
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace

import test_orbis_host_core_source_configuration as fixtures


spec = importlib.util.spec_from_file_location('local_inspection_test', Path(__file__).with_name('orbis-host-core-local-inspection.py'))
I = importlib.util.module_from_spec(spec)
spec.loader.exec_module(I)
POINT = 'd5d82d7c-1f6a-429e-90ea-787833c06fe3'


class LocalInspectionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.BrokerTests('test_success_and_exclusive')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.enrollment, self.broker, self.source = self.fixture.enrollment, self.fixture.broker, self.fixture.source
        read_json = self.enrollment.json
        self.enrollment.json = lambda path, maximum=2 * 1024 * 1024: read_json(path, maximum)
        self.identifier, self.actor = self.fixture.identifier, self.fixture.actor
        self.original_owner = 7
        self.enrollment.runtime.source_snapshot = lambda: {'controller': 'current-controller', 'revision': self.revision}
        self.revision = 1
        self.enrollment.destination = lambda: {'imageId': 'sha256:' + '9' * 64,
                                              'revisionSha256': self.broker.digest(self.enrollment.runtime.source_snapshot())}
        original_image = self.enrollment.runtime.image
        def image(identifier):
            if identifier == I.PROFILE.PG17_ARM64_IMAGE:
                return {'Id': identifier, 'Os': 'linux', 'Architecture': 'arm64', 'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}}
            return original_image(identifier)
        self.enrollment.runtime.image = image
        self.source.inspection_binding = self.binding
        self.copy_count = 0
        @contextmanager
        def database_source():
            parent = self
            class Copy:
                def copy_to(self, directory, profile):
                    parent.copy_count += 1
                    directory.mkdir(mode=0o700)
                    for name in ('pgdata', 'config', 'quarantined-config'):
                        (directory / name).mkdir(mode=0o700)
                    (directory / 'pgdata/fixture-data').write_bytes(b'synthetic-database-contents')
                    return {'syntheticOverlay': True, 'profile': profile}
            yield Copy()
        self.source.open_database_source = database_source
        self.enterContext(mock.patch.object(I.PROFILE, 'verify_overlay', side_effect=lambda directory, receipt, authority: receipt))
        self.enterContext(mock.patch.object(I.os, 'fchown'))
        def inventory(directory, profile, authority):
            leaf = directory / 'pgdata/fixture-data'
            details = leaf.stat()
            identity = self.broker.P.canonical({name: getattr(details, 'st_' + name) for name in ('dev', 'ino', 'mode', 'mtime_ns', 'ctime_ns')})
            return {'inventorySha256': fixtures.module.sha(identity + leaf.read_bytes())}
        self.enterContext(mock.patch.object(I.PROFILE, 'prepared_copy_inventory', side_effect=inventory))
        # The manager requires the independently supplied union code inventory.
        file = self.fixture.code / 'core-inspection-worker.mjs'
        file.write_bytes(b'inspection-fixture')
        file.chmod(0o400)
        self.broker.inventory[file.name] = {'bytes': file.stat().st_size, 'sha256': fixtures.module.sha(file.read_bytes())}
        self.manager = I.CoreLocalRestoreInspection(None, self.broker, self.enrollment, source_factory=self.source_factory)
        self.request = {'id': self.identifier, 'pointId': POINT, 'actor': copy.deepcopy(self.actor)}

    def source_factory(self, root, state, context, point, actor):
        if point != POINT or actor != self.actor:
            raise ValueError('synthetic source unavailable')
        return self.source

    def binding(self):
        return {'schema': 'orbis.core-local-inspection-binding.v1', 'origin': 'genuine-root-local-capture',
                'pointId': POINT, 'sourceOwnerId': self.original_owner, 'sourceWitnessSha256': 'a' * 64,
                'resourcesSha256': 'e' * 64, 'images': {'controller': self.source.image, 'database': I.PROFILE.PG17_ARM64_IMAGE},
                'compatibility': {'os': 'linux', 'architecture': 'arm64', 'database': {'major': 17}},
                'sourceAuthority': True, 'environmentProved': False, 'restoreAuthority': False}

    def prepare(self):
        prepared = self.manager.prepare(self.request, privileged_peer=True)
        self.approval = {'id': self.identifier, 'actor': self.actor, 'reviewSha256': prepared['reviewSha256'],
                         'approvalNonce': prepared['approvalNonce'], 'executionConsent': prepared['executionConsent'],
                         'action': 'authorize-core-inspection-only'}
        return prepared

    def authorize(self):
        self.prepare()
        return self.manager.approve(self.approval, privileged_peer=True)

    def ready(self):
        directory = self.manager.directory(self.identifier) / 'execution'
        ready = self.enrollment.json(directory / 'prepared.json')
        request = self.enrollment.json(directory / 'trusted-input/request.json')
        return directory, ready, request

    def test_local_consent_binds_cached_image_source_code_and_separate_owner(self):
        prepared = self.prepare()
        self.assertEqual(prepared['schema'], self.manager.schema)
        self.assertEqual(prepared['version'], 2)
        consent = prepared['executionConsent']
        self.assertEqual(consent['schema'], 'orbis.core-inspection-execution-consent.v2')
        self.assertEqual(consent['imageAuthority'], 'root-qualified-cached-image')
        self.assertEqual(consent['imageId'], I.PROFILE.PG17_ARM64_IMAGE)
        self.assertNotIn('archiveSha256', consent)
        self.assertEqual(self.copy_count, 1)
        record = self.manager.record(self.identifier)
        self.assertEqual(consent['executionPlanSha256'], self.manager.digest(record['evidence']['executionPlan']))
        self.assertFalse((self.manager.directory(self.identifier) / 'execution/prepared.json').exists())
        self.assertEqual(record['evidence']['source']['sourceOwnerId'], self.original_owner)
        self.assertEqual(record['evidence']['source']['ownerId'], self.actor['ownerId'])
        self.assertNotEqual(record['evidence']['destination']['imageId'], record['evidence']['destination']['inspectionCoordinatorImageId'])
        for flag in ('restoreSupported', 'activationAuthorized', 'workerExecutionAvailable'):
            self.assertFalse(prepared[flag])
        result = self.manager.approve(self.approval, privileged_peer=True)
        self.assertEqual(result['phase'], 'inspection-authorized')
        permit = self.enrollment.json(self.manager.directory(self.identifier) / 'permit.json', 16384)
        self.assertEqual(permit['schema'], self.manager.permit_schema)
        self.assertEqual(permit['sandboxProfile'], I.PROFILE.ROLE_SCHEMA)
        self.assertEqual(self.copy_count, 1)
        with self.assertRaises(ValueError):
            self.manager.approve(self.approval, privileged_peer=True)

    def test_installed_runtime_selection_is_bound_to_the_prepared_review(self):
        self.broker.installed_selection = SimpleNamespace(identifier=self.identifier, installation_sha256='f' * 64)
        self.prepare()
        record = self.manager.record(self.identifier)
        self.assertEqual(record['installedRuntime'], {'id': self.identifier, 'installationSha256': 'f' * 64,
                         'sourceControllerImageId': self.broker.trust.source_controller_image_id})
        record['installedRuntime']['installationSha256'] = 'e' * 64
        self.manager.save(record)
        with self.assertRaises(I.BASE.InspectionError):
            self.manager.approve(self.approval, privileged_peer=True)
        self.assertFalse((self.manager.directory(self.identifier) / 'approval-claim.json').exists())

    def test_claim_is_single_use_and_binds_the_full_projection_without_effective_environment_authority(self):
        self.authorize()
        _, _, request = self.ready()
        claimed = self.manager.claim_execution(self.identifier, self.actor)
        self.assertEqual(claimed['phase'], 'inspecting')
        self.assertEqual(claimed['executionRequestSha256'], self.manager.digest(request))
        self.assertFalse(claimed['evidence']['source']['environmentProjection']['environmentProved'])
        self.assertFalse(claimed['activationAuthorized'])
        with self.assertRaises(ValueError):
            self.manager.claim_execution(self.identifier, self.actor)

    def test_repeated_admission_observes_the_same_record_without_another_worker(self):
        prepared = self.prepare()
        repeated = self.manager.prepare(self.request, privileged_peer=True)
        self.assertEqual(repeated, prepared)
        self.assertEqual(self.copy_count, 1)
        self.assertEqual(repeated['sourceManifestSha256'], self.source.basis()['sourceManifestSha256'])
        approved = self.manager.approve(self.approval, privileged_peer=True)
        self.assertEqual(self.manager.prepare(self.request, privileged_peer=True), approved)
        self.assertEqual(self.copy_count, 1)

    def test_existing_admission_does_not_accept_another_point_or_actor(self):
        self.prepare()
        for request in (self.request | {'pointId': self.identifier},
                        self.request | {'actor': self.actor | {'sessionBinding': 'c' * 64}}):
            with self.subTest(request=request), self.assertRaises(I.BASE.InspectionError):
                self.manager.prepare(request, privileged_peer=True)
        self.assertEqual(self.copy_count, 1)

    def test_partial_admission_directory_is_not_recreated_or_replayed(self):
        self.manager.directory(self.identifier, True)
        with mock.patch.object(self.broker, 'prepare', side_effect=AssertionError('must not launch')):
            with self.assertRaises(FileExistsError):
                self.manager.prepare(self.request, privileged_peer=True)
        self.assertFalse((self.manager.directory(self.identifier) / 'job.json').exists())

    def test_two_concurrent_claimants_cannot_both_consume_the_same_permit(self):
        self.authorize()
        barrier = Barrier(2)
        original = self.manager.reserve_execution_claim
        def reserve(*args):
            barrier.wait(timeout=5)
            return original(*args)
        def claim():
            try:
                return self.manager.claim_execution(self.identifier, self.actor)
            except I.BASE.InspectionError:
                return None
        with mock.patch.object(self.manager, 'reserve_execution_claim', side_effect=reserve):
            with ThreadPoolExecutor(max_workers=2) as workers:
                results = list(workers.map(lambda _: claim(), range(2)))
        self.assertEqual(sum(result is not None for result in results), 1)
        self.assertEqual(self.manager.record(self.identifier)['phase'], 'inspecting')
        self.manager.validate_execution_claim(self.manager.record(self.identifier))

    def test_concurrent_approval_loser_cannot_overwrite_the_claimed_winner(self):
        self.prepare()
        barrier = Barrier(2)
        original = self.manager.reserve_approval
        def reserve(*args):
            barrier.wait(timeout=5)
            return original(*args)
        def approve_and_claim():
            try:
                self.manager.approve(self.approval, privileged_peer=True)
                return self.manager.claim_execution(self.identifier, self.actor)
            except I.BASE.InspectionError:
                return None
        with mock.patch.object(self.manager, 'reserve_approval', side_effect=reserve):
            with ThreadPoolExecutor(max_workers=2) as workers:
                results = list(workers.map(lambda _: approve_and_claim(), range(2)))
        self.assertEqual(sum(result is not None for result in results), 1)
        self.assertEqual(self.manager.record(self.identifier)['phase'], 'inspecting')
        self.manager.validate_execution_claim(self.manager.record(self.identifier))

    def test_approval_is_not_claimable_until_all_execution_inputs_are_published(self):
        self.prepare()
        original = self.manager.prepare_authorized_execution
        def stage(record):
            self.assertEqual(self.manager.record(self.identifier)['phase'], 'authorizing')
            with self.assertRaises(I.BASE.InspectionError):
                self.manager.claim_execution(self.identifier, self.actor)
            original(record)
            self.assertEqual(self.manager.record(self.identifier)['phase'], 'authorizing')
        with mock.patch.object(self.manager, 'prepare_authorized_execution', side_effect=stage):
            self.manager.approve(self.approval, privileged_peer=True)
        self.assertEqual(self.manager.record(self.identifier)['phase'], 'inspection-authorized')
        self.ready()

    def test_approval_reservation_survives_failed_first_job_write_and_blocks_replay(self):
        self.prepare()
        with mock.patch.object(self.manager, 'save', side_effect=OSError('synthetic failed job write')):
            with self.assertRaises(OSError):
                self.manager.approve(self.approval, privileged_peer=True)
        self.assertEqual(self.manager.record(self.identifier)['phase'], 'awaiting-approval')
        self.assertEqual(self.manager.status({'id': self.identifier, 'actor': self.actor}, privileged_peer=True)['phase'], 'recovery-required')
        with mock.patch.object(self.manager, 'save', side_effect=AssertionError('duplicate must not write')):
            with self.assertRaises(I.BASE.InspectionError):
                self.manager.approve(self.approval, privileged_peer=True)

    def test_a_reserved_claim_is_not_replayed_after_its_record_write_fails(self):
        self.authorize()
        original = self.manager.save
        def save(record):
            if record['phase'] == 'inspecting':
                raise OSError('synthetic write failure')
            return original(record)
        with mock.patch.object(self.manager, 'save', side_effect=save):
            with self.assertRaises(OSError):
                self.manager.claim_execution(self.identifier, self.actor)
        self.assertEqual(self.manager.record(self.identifier)['phase'], 'inspection-authorized')
        self.assertEqual(self.manager.status({'id': self.identifier, 'actor': self.actor}, privileged_peer=True)['phase'], 'recovery-required')
        with self.assertRaises(ValueError):
            self.manager.claim_execution(self.identifier, self.actor)

    def test_changed_working_data_cannot_receive_final_approval(self):
        self.prepare()
        file = self.manager.directory(self.identifier) / 'execution/pgdata/fixture-data'
        file.write_bytes(b'changed-working-data')
        with self.assertRaises(ValueError):
            self.manager.approve(self.approval, privileged_peer=True)
        self.assertFalse((self.manager.directory(self.identifier) / 'permit.json').exists())

    def test_identical_replaced_working_data_does_not_consume_a_claim(self):
        self.authorize()
        file = self.manager.directory(self.identifier) / 'execution/pgdata/fixture-data'
        body = file.read_bytes()
        file.rename(file.with_name('original-fixture-data'))
        file.write_bytes(body)
        with self.assertRaises(ValueError):
            self.manager.claim_execution(self.identifier, self.actor)
        self.assertFalse((self.manager.directory(self.identifier) / 'execution-claim.json').exists())

    def test_changed_working_data_after_claim_is_refused_before_launch(self):
        self.authorize()
        record = self.manager.claim_execution(self.identifier, self.actor)
        directory = self.manager.directory(self.identifier) / 'execution'
        (directory / 'pgdata/fixture-data').write_bytes(b'changed-after-claim')
        with self.assertRaises(ValueError):
            self.manager.validate_prepared_execution(record, directory)

    def test_every_consent_field_requires_exact_fresh_approval(self):
        self.prepare()
        for field in self.approval['executionConsent']:
            bad = copy.deepcopy(self.approval)
            bad['executionConsent'][field] = 'changed'
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.manager.approve(bad, privileged_peer=True)
        self.assertEqual(self.manager.record(self.identifier)['phase'], 'awaiting-approval')

    def test_unprivileged_or_imported_grants_do_not_create_a_local_inspection(self):
        with self.assertRaises(ValueError):
            self.manager.prepare(self.request)
        with self.assertRaises(ValueError):
            self.manager.prepare({'id': self.identifier, 'enrollmentId': POINT, 'actor': self.actor}, privileged_peer=True)
        self.assertFalse((self.fixture.root / 'core-restore-inspections').exists())

    def test_changed_destination_or_actor_revokes_prepared_approval(self):
        self.prepare()
        self.revision += 1
        with self.assertRaises(ValueError):
            self.manager.approve(self.approval, privileged_peer=True)
        self.revision -= 1
        bad = copy.deepcopy(self.approval)
        bad['actor']['securityBinding'] = 'f' * 64
        with self.assertRaises(ValueError):
            self.manager.approve(bad, privileged_peer=True)

    def test_expired_approval_and_permit_never_claim(self):
        self.prepare()
        with mock.patch.object(I.BASE.time, 'time', return_value=10 ** 12):
            with self.assertRaises(ValueError):
                self.manager.approve(self.approval, privileged_peer=True)
        self.manager.approve(self.approval, privileged_peer=True)
        with mock.patch.object(I.BASE.time, 'time', return_value=10 ** 12):
            with self.assertRaises(ValueError):
                self.manager.claim_execution(self.identifier, self.actor)

    def test_changed_private_ready_binding_refuses_without_consuming(self):
        self.authorize()
        directory, ready, request = self.ready()
        file = directory / 'prepared.json'
        for key in ready:
            bad = {**ready, key: 'changed'}
            file.chmod(0o600)
            file.write_bytes(self.manager.P.canonical(bad))
            with self.subTest(field=key), self.assertRaises(ValueError):
                self.manager.claim_execution(self.identifier, self.actor)
        file.write_bytes(self.manager.P.canonical(ready))
        self.assertEqual(self.manager.record(self.identifier)['phase'], 'inspection-authorized')

    def test_changed_role_or_legacy_ready_cannot_redeem_local_consent(self):
        self.authorize()
        directory, ready, request = self.ready()
        request['role'] = 'other_role'
        ready['requestSha256'] = self.manager.digest(request)
        for file, value in [(directory / 'prepared.json', ready), (directory / 'trusted-input/request.json', request)]:
            file.chmod(0o600)
            file.write_bytes(self.manager.P.canonical(value))
        with self.assertRaises(ValueError):
            self.manager.claim_execution(self.identifier, self.actor)

    def test_failed_source_preparation_holds_without_minting_a_permit(self):
        with mock.patch.object(self.broker, 'prepare', side_effect=ValueError('private source detail')):
            with self.assertRaisesRegex(ValueError, 'preparation'):
                self.prepare()
        record = self.manager.record(self.identifier)
        self.assertEqual(record['phase'], 'recovery-required')
        self.assertNotIn('private source detail', str(record))
        self.assertFalse((self.manager.directory(self.identifier) / 'permit.json').exists())


class BootstrapSourceInspectionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = LocalInspectionTests('test_local_consent_binds_cached_image_source_code_and_separate_owner')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        f.manager = I.CoreBootstrapSourceInspection(None, f.broker, f.enrollment, source_factory=f.source_factory)

    def test_fresh_scope_is_bound_to_distinct_consent_permit_and_worker_protocol(self):
        f = self.fixture
        prepared = f.prepare()
        self.assertEqual(prepared['version'], 3)
        self.assertEqual(prepared['executionConsent']['schema'], 'orbis.core-inspection-execution-consent.v3')
        self.assertEqual(prepared['executionConsent']['evidenceScope'], 'authenticated-bootstrap-source')
        f.manager.approve(f.approval, privileged_peer=True)
        _, ready, request = f.ready()
        self.assertEqual(ready['schema'], 'orbis.core-inspection-execution-ready.v3')
        self.assertEqual(request['schema'], 'orbis.core-inspection-worker-input.v3')
        self.assertEqual(request['evidenceScope'], 'authenticated-bootstrap-source')
        permit = f.enrollment.json(f.manager.directory(f.identifier) / 'permit.json')
        self.assertEqual(permit['schema'], 'orbis.core-restore-inspection-permit.v3')
        claimed = f.manager.claim_execution(f.identifier, f.actor)
        self.assertEqual(claimed['phase'], 'inspecting')

    def test_existing_v2_job_cannot_be_adopted_as_bootstrap_evidence(self):
        f = self.fixture
        legacy = I.CoreLocalRestoreInspection(None, f.broker, f.enrollment, source_factory=f.source_factory)
        legacy.prepare(f.request, privileged_peer=True)
        copies = f.copy_count
        with self.assertRaises(ValueError):
            f.manager.prepare(f.request, privileged_peer=True)
        self.assertEqual(f.copy_count, copies)
        self.assertFalse((legacy.directory(f.identifier) / 'permit.json').exists())

    def test_completed_catalog_mapper_preserves_bindings_and_never_claims_activation(self):
        f = self.fixture
        f.authorize()
        f.manager.claim_execution(f.identifier, f.actor)
        record = f.manager.record(f.identifier)
        record['phase'] = 'inspection-complete'
        f.manager.save(record)
        ledger = [{'id': 3, 'hash': '1' * 64, 'created_at': '1700000000000'}]
        report = {'schema': 'orbis.core-inspection-worker-result.v3', 'evidenceScope': 'authenticated-bootstrap-source',
                  'bootstrapSource': {'catalogSha256': '2' * 64, 'systemIdentifier': '7000000000000000001', 'migrationLedger': ledger}}
        # The actual completion/worker verifier has its own filesystem lifecycle tests.
        checker = mock.Mock()
        checker.InspectionSupervisor.return_value.checked_completion.return_value = report
        with mock.patch.object(I, 'load', return_value=checker):
            catalog = f.manager.bootstrap_catalog(f.identifier, f.actor)
            self.assertEqual(catalog['actor'], f.actor)
            self.assertEqual(catalog['sourceControllerImageId'], f.broker.trust.source_controller_image_id)
            self.assertEqual(catalog['sourceWitnessSha256'], f.source.basis()['sourceWitnessSha256'])
            self.assertEqual(catalog['ledger'], ledger)
            self.assertTrue(catalog['authenticationVerified'])
            self.assertFalse(catalog['environmentProved'])
            self.assertFalse(catalog['restoreAuthority'])
            catalog['ledger'][0]['id'] = 99
            self.assertEqual(ledger[0]['id'], 3)
            report['schema'] = 'orbis.core-inspection-worker-result.v2'
            with self.assertRaises(ValueError): f.manager.bootstrap_catalog(f.identifier, f.actor)
        actor = copy.deepcopy(f.actor)
        actor['ownerId'] += 1
        with self.assertRaises(ValueError): f.manager.bootstrap_catalog(f.identifier, actor)


class VersionedBootstrapSourceInspectionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = LocalInspectionTests('test_local_consent_binds_cached_image_source_code_and_separate_owner')
        self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        f = self.fixture;self.old_image = f.enrollment.runtime.image;self.old_binding = f.source.inspection_binding
        self.configure(14)
        f.manager = I.CoreVersionedBootstrapSourceInspection(None, f.broker, f.enrollment, source_factory=f.source_factory)

    def configure(self, major):
        f = self.fixture;self.major = major
        architecture = 'amd64' if major == 14 else 'arm64'
        trust = f.broker.trust
        f.broker.trust = type(trust)(trust.image_id, architecture, trust.code_directory, trust.inventory,
                                    trust.source_controller_image_id, trust.parser_profile)
        def image(identifier):
            if identifier == I.PROFILE.PG.PG14_AMD64_IMAGE:
                return {'Id': identifier, 'Os': 'linux', 'Architecture': 'amd64', 'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}}
            value = self.old_image(identifier)
            if identifier != I.PROFILE.PG17_ARM64_IMAGE:value['Architecture'] = architecture
            return value
        f.enrollment.runtime.image = image
        def binding():
            value = self.old_binding();value['images']['database'] = I.PROFILE.PG.PG14_AMD64_IMAGE if major == 14 else I.PROFILE.PG17_ARM64_IMAGE
            value['compatibility'] = {'os': 'linux', 'architecture': architecture, 'database': {'engine': 'postgresql', 'major': major}}
            return value
        f.source.inspection_binding = binding

    def test_v4_fresh_profile_consent_permit_request_and_claim_are_distinct(self):
        self.check_admission(14)

    def test_v4_pg17_remains_explicit_instead_of_promoting_v3(self):
        self.configure(17);self.check_admission(17)

    def check_admission(self, major):
        f = self.fixture;prepared = f.prepare();record = f.manager.record(f.identifier)
        profile = record['evidence']['profile'];consent = prepared['executionConsent']
        self.assertEqual((prepared['version'], prepared['schema']), (4, 'orbis.core-restore-inspection.v4'))
        self.assertEqual(profile['schema'], I.PROFILE.EXECUTION_SCHEMA)
        self.assertEqual(profile['major'], major)
        self.assertEqual(consent['schema'], 'orbis.core-inspection-execution-consent.v4')
        self.assertEqual(consent['executionProfile'], profile['profileId'])
        self.assertEqual(consent['profileSha256'], f.manager.digest(profile))
        self.assertEqual(consent['settingsSha256'], f.manager.digest(I.PROFILE.settings_for(profile)))
        f.manager.approve(f.approval, privileged_peer=True);directory, ready, request = f.ready()
        self.assertEqual(request['schema'], 'orbis.core-inspection-worker-input.v4')
        self.assertEqual(request['executionProfile'], profile['profileId'])
        self.assertEqual(ready['schema'], 'orbis.core-inspection-execution-ready.v4')
        self.assertEqual(f.enrollment.json(f.manager.directory(f.identifier) / 'permit.json')['schema'], 'orbis.core-restore-inspection-permit.v4')
        claimed = f.manager.claim_execution(f.identifier, f.actor)
        self.assertEqual(claimed['phase'], 'inspecting')
        self.assertEqual(f.copy_count, 1)
        self.assertFalse(claimed['activationAuthorized'])
        self.assertFalse(profile.get('restoreAuthority', False))
        self.assertFalse(claimed['evidence']['source']['environmentProjection']['environmentProved'])

    def test_old_v2_job_is_never_adopted_by_v4(self):
        self.check_old_job(I.CoreLocalRestoreInspection)

    def test_old_v3_job_is_never_adopted_by_v4(self):
        self.check_old_job(I.CoreBootstrapSourceInspection)

    def check_old_job(self, old_class):
        self.configure(17);f = self.fixture
        legacy = old_class(None, f.broker, f.enrollment, source_factory=f.source_factory)
        legacy.prepare(f.request, privileged_peer=True);before = (legacy.directory(f.identifier) / 'job.json').read_bytes();copies = f.copy_count
        with self.assertRaises(ValueError):f.manager.prepare(f.request, privileged_peer=True)
        self.assertEqual((legacy.directory(f.identifier) / 'job.json').read_bytes(), before)
        self.assertEqual(f.copy_count, copies)
        self.assertFalse((legacy.directory(f.identifier) / 'permit.json').exists())

    def test_v4_refuses_replayed_old_consent_without_reserving_approval(self):
        f = self.fixture;f.prepare();request = copy.deepcopy(f.approval)
        request['executionConsent']['schema'] = 'orbis.core-inspection-execution-consent.v3'
        request['executionConsent'].pop('executionProfile')
        with self.assertRaises(ValueError):f.manager.approve(request, privileged_peer=True)
        self.assertFalse((f.manager.directory(f.identifier) / 'approval-claim.json').exists())
        self.assertFalse((f.manager.directory(f.identifier) / 'permit.json').exists())

    def test_v4_changed_worker_profile_cannot_consume_claim_even_with_rehashed_ready(self):
        f = self.fixture;f.authorize();directory, ready, request = f.ready()
        request['executionProfile'] = 'pg17-alpine-arm64.v1';ready['requestSha256'] = f.manager.digest(request)
        for path, value in [(directory / 'trusted-input/request.json', request), (directory / 'prepared.json', ready)]:
            path.chmod(0o600);path.write_bytes(f.manager.P.canonical(value))
        with self.assertRaises(ValueError):f.manager.claim_execution(f.identifier, f.actor)
        self.assertFalse((f.manager.directory(f.identifier) / 'execution-claim.json').exists())

    def test_versioned_profile_is_selected_by_root_image_and_not_a_request_flag(self):
        f = self.fixture
        with self.assertRaises(ValueError):
            f.manager.prepare(f.request | {'executionProfile': 'pg14-debian-amd64.v1'}, privileged_peer=True)
        self.assertEqual(f.copy_count, 0)
        self.assertFalse((f.manager.state / 'core-restore-inspections').exists())

    def test_v4_source_platform_drift_refuses_before_permit(self):
        f = self.fixture;f.prepare();binding = f.source.inspection_binding
        def changed():
            value = binding();value['compatibility']['database']['major'] = 17;return value
        f.source.inspection_binding = changed
        with self.assertRaises(ValueError):f.manager.approve(f.approval, privileged_peer=True)
        self.assertFalse((f.manager.directory(f.identifier) / 'permit.json').exists())

    def test_v4_catalog_carries_checked_profile_and_actual_observation_without_authority(self):
        f = self.fixture;f.authorize();f.manager.claim_execution(f.identifier, f.actor)
        record = f.manager.record(f.identifier);record['phase'] = 'inspection-complete';f.manager.save(record)
        profile = record['evidence']['profile'];database = record['evidence']['source']['environmentProjection']['database']
        observation = {'schema': 'orbis.core-pg-execution-observation.v1', 'profileId': profile['profileId'],
            'serverVersionNum': 140023, 'major': 14, 'database': database,
            'locale': {'encoding': 'UTF8', 'collate': 'en_US.utf8', 'ctype': 'en_US.utf8', 'provider': 'c'},
            'localeProviderEvidence': 'postgresql14-libc-database-default'}
        ledger = [{'id': 3, 'hash': '1' * 64, 'created_at': '1700000000000'}]
        report = {'schema': 'orbis.core-inspection-worker-result.v4', 'evidenceScope': 'authenticated-bootstrap-source',
            'executionProfile': profile['profileId'], 'databaseExecution': observation,
            'bootstrapSource': {'schema': 'orbis.core-source-bootstrap-evidence.v2', 'catalogSha256': '2' * 64,
                'systemIdentifier': '7000000000000000001', 'migrationLedger': ledger}}
        executor = I.load('orbis-host-core-inspection-executor.py', 'v4_catalog_test_executor')
        checker = SimpleNamespace(InspectionSupervisor=mock.Mock(), validate_database_execution=executor.validate_database_execution)
        checker.InspectionSupervisor.return_value.checked_completion.return_value = report
        with mock.patch.object(I, 'load', return_value=checker):
            catalog = f.manager.bootstrap_catalog(f.identifier, f.actor)
            self.assertEqual(catalog['schema'], 'orbis.core-root-authenticated-bootstrap-source.v2')
            self.assertEqual(catalog['executionProfile'], profile)
            self.assertEqual(catalog['databaseExecution'], observation)
            self.assertTrue(catalog['authenticationVerified'])
            self.assertFalse(catalog['environmentProved']);self.assertFalse(catalog['restoreAuthority'])
            catalog['executionProfile']['major'] = 17;catalog['databaseExecution']['locale']['collate'] = 'C'
            self.assertEqual(profile['major'], 14);self.assertEqual(observation['locale']['collate'], 'en_US.utf8')
            report['databaseExecution'] = observation | {'major': 17}
            with self.assertRaises(ValueError):f.manager.bootstrap_catalog(f.identifier, f.actor)
            report['databaseExecution'] = observation;report['schema'] = 'orbis.core-inspection-worker-result.v3'
            with self.assertRaises(ValueError):f.manager.bootstrap_catalog(f.identifier, f.actor)


if __name__ == '__main__':
    unittest.main()
