"""Fresh inspection-only consent for genuine local data and a qualified cached image."""
import copy
import os
import secrets
import time
from contextlib import nullcontext
from functools import wraps

from pathlib import Path
import importlib.util


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BASE = load('orbis-host-core-restore-inspection.py', 'orbis_local_inspection_admission')
LOCAL = load('orbis-host-core-local-source.py', 'orbis_local_inspection_source')
PROFILE = load('orbis-host-core-inspection-profile.py', 'orbis_local_inspection_profile')


def runtime_authorized(method):
    @wraps(method)
    def guarded(self, *args, **kwargs):
        with self.runtime_authority():
            return method(self, *args, **kwargs)
    return guarded


class CoreLocalRestoreInspection(BASE.CoreRestoreInspection):
    schema = 'orbis.core-restore-inspection.v2'
    profile = PROFILE.ROLE_SCHEMA
    version = 2
    permit_schema = 'orbis.core-restore-inspection-permit.v2'
    ready_schema = 'orbis.core-inspection-execution-ready.v2'
    ready_extra_fields = {'profileSha256', 'configurationReceiptSha256'}
    worker_version = 2
    worker_extra = {}
    consent_schema = 'orbis.core-inspection-execution-consent.v2'

    def __init__(self, service, configuration, enrollment=None, *, source_factory=None):
        super().__init__(service, enrollment)
        self.configuration = configuration
        self.source_factory = source_factory or LOCAL.CoreLocalInspectionSource
        if 'core-inspection-worker.mjs' not in configuration.code():
            raise BASE.InspectionError('coordinator')

    def source(self, point, actor):
        return self.source_factory(self.root, self.state, self.context, point, actor)

    def runtime_authority(self):
        authority = getattr(self.configuration, 'installed_authority', None)
        return authority() if authority is not None else nullcontext()

    @classmethod
    def public(cls, record):
        value = super().public(record)
        value['sourceManifestSha256'] = record['evidence']['source'].get('payload', {}).get('manifestSha256')
        return value

    @runtime_authorized
    def approve(self, request, *, privileged_peer=False):
        return super().approve(request, privileged_peer=privileged_peer)

    @runtime_authorized
    def status(self, request, *, privileged_peer=False):
        return super().status(request, privileged_peer=privileged_peer)

    @runtime_authorized
    def claim_execution(self, identifier, actor):
        return super().claim_execution(identifier, actor)

    def prepared_configuration(self, identifier, actor, source):
        handle = self.configuration.checked(identifier, actor, source)
        directory = self.configuration.directory(identifier)
        receipt = self.enrollment.json(directory / 'receipt.json', 16384)
        report_body = self.enrollment.read(directory / 'output/result.json', 2 * 1024 * 1024)
        if (handle.identifier != identifier or handle.receipt_sha256 != self.digest(receipt)
                or receipt['resultSha256'] != PROFILE.digest(report_body)):
            raise BASE.InspectionError('configuration')
        report = self.P.metadata(report_body, byte_limit=2 * 1024 * 1024)
        return handle, report['projection']

    def inspection_profile(self, image, projection):
        return PROFILE.role_bound_image_profile(image, projection['role'], self.digest(projection))

    def worker_fields(self, evidence):
        return dict(self.worker_extra)

    def evidence(self, point, actor, identifier):
        source = self.source(point, actor)
        basis, binding = source.basis(), source.inspection_binding()
        if (binding.get('schema') != 'orbis.core-local-inspection-binding.v1'
                or binding.get('origin') != 'genuine-root-local-capture' or binding.get('pointId') != point
                or binding.get('sourceWitnessSha256') != basis['sourceWitnessSha256']
                or binding.get('sourceAuthority') is not True or binding.get('environmentProved') is not False
                or binding.get('restoreAuthority') is not False or basis.get('actor') != actor):
            raise BASE.InspectionError('source')
        handle, projection = self.prepared_configuration(identifier, actor, source)
        if (projection['sourceWitnessSha256'] != basis['sourceWitnessSha256']
                or projection['sourceManifestSha256'] != basis['sourceManifestSha256']):
            raise BASE.InspectionError('source')
        image = self.enrollment.runtime.image(binding['images']['database'])
        profile = self.inspection_profile(image, projection)
        compatibility = binding['compatibility']
        if (profile['imageId'] != binding['images']['database']
                or any(compatibility[key] != profile[key] for key in ('os', 'architecture'))
                or compatibility['database']['major'] != profile['major']):
            raise BASE.InspectionError('platform')
        destination = self.enrollment.destination()
        observed = self.enrollment.runtime.source_snapshot()
        if self.digest(observed) != destination['revisionSha256']:
            raise BASE.InspectionError('changed')
        if profile['architecture'] != self.configuration.trust.architecture:
            raise BASE.InspectionError('platform')
        destination['inspectionCoordinatorImageId'] = self.configuration.trust.image_id
        destination['inspectionCoordinatorCodeSha256'] = self.digest(self.configuration.code())
        local = {
            'origin': 'genuine-root-local-capture', 'pointId': point, 'sourceOwnerId': binding['sourceOwnerId'],
            'ownerId': actor['ownerId'], 'sourceWitnessSha256': basis['sourceWitnessSha256'],
            'resourcesSha256': binding['resourcesSha256'], 'inspectionBinding': binding,
            'payload': {'manifestSha256': basis['sourceManifestSha256']}, 'images': binding['images'],
            'compatibility': compatibility, 'environmentProjection': projection,
            'configurationPreparationId': identifier, 'configurationPreparationSha256': handle.receipt_sha256,
            'legacyRestrictions': copy.deepcopy(BASE.RESTRICTIONS),
        }
        consent = {
            'schema': self.consent_schema, 'role': 'database',
            'imageAuthority': 'root-qualified-cached-image', 'imageId': profile['imageId'],
            'platform': {'os': profile['os'], 'architecture': profile['architecture']}, 'postgresqlMajor': profile['major'],
            'sandboxProfile': self.profile, 'profileSha256': self.digest(profile),
            'settingsSha256': self.digest(PROFILE.settings_for(profile)), 'sourceWitnessSha256': basis['sourceWitnessSha256'],
            'resourcesSha256': binding['resourcesSha256'], 'sourceProjectionSha256': self.digest(projection),
            'configurationReceiptSha256': handle.receipt_sha256, 'destinationRevisionSha256': destination['revisionSha256'],
            'coordinatorImageId': destination['inspectionCoordinatorImageId'],
            'coordinatorSha256': destination['inspectionCoordinatorCodeSha256'],
            'authority': 'explicit-fresh-exact-bytes', 'scope': 'inspection-only',
        }
        return {'source': local, 'destination': destination, 'profile': profile, 'executionConsent': consent}

    @runtime_authorized
    def prepare(self, request, *, privileged_peer=False):
        if (privileged_peer is not True or not self.P.exact(request, {'id', 'pointId', 'actor'})
                or not BASE.E.matches(BASE.E.UUID, request['pointId'])):
            raise BASE.InspectionError('authority')
        actor = self.enrollment.actor(request['actor'])
        try:
            existing = self.record(request['id'])
        except FileNotFoundError:
            pass
        else:
            if existing.get('actor') != actor or existing.get('pointId') != request['pointId']:
                raise BASE.InspectionError('authority')
            # The same admitted request observes its record; it never creates another worker.
            return self.status({'id': request['id'], 'actor': actor}, privileged_peer=True)
        self.directory(request['id'], True)
        record = {'schema': self.schema, 'id': request['id'], 'root': str(self.root), 'context': self.context,
                  'scope': 'inspection-only', 'sandboxProfile': self.profile, 'activationAuthorized': False,
                  'actor': actor, 'pointId': request['pointId'], 'phase': 'preparing',
                  'evidence': {'source': {'pointId': request['pointId']}}}
        selected = getattr(self.configuration, 'installed_selection', None)
        if selected is not None:
            record['installedRuntime'] = {'id': selected.identifier, 'installationSha256': selected.installation_sha256,
                                          'sourceControllerImageId': self.configuration.trust.source_controller_image_id}
        self.save(record)
        try:
            source = self.source(request['pointId'], actor)
            self.configuration.prepare(request['id'], actor, source)
            evidence = self.evidence(request['pointId'], actor, request['id'])
            plan = self.prepare_execution_plan(request['id'], actor, evidence)
            self.bind_execution_plan(evidence, plan)
            prepared = {key: value for key, value in record.items() if key not in {'phase', 'evidence'}}
            prepared['evidence'] = evidence
            body = self.P.canonical(prepared)
            self.enrollment.immutable(self.directory(request['id']) / 'prepared.json', body)
            record.update(evidence=evidence, reviewSha256=PROFILE.digest(body), phase='awaiting-approval',
                          approvalNonce=secrets.token_hex(32), approvalExpiresAt=int(time.time() * 1000) + 300000)
            self.save(record)
            return self.public(record)
        except BaseException:
            record['phase'] = 'recovery-required'
            self.save(record)
            raise BASE.InspectionError('preparation') from None

    def require_current(self, record):
        evidence = self.evidence(record['pointId'], record['actor'], record['id'])
        self.bind_execution_plan(evidence, self.checked_execution_plan(record['id'], evidence))
        if evidence != record['evidence']:
            raise BASE.InspectionError('changed')
        prepared = self.enrollment.read(self.directory(record['id']) / 'prepared.json', 4 * 1024 * 1024)
        material = self.P.metadata(prepared, byte_limit=4 * 1024 * 1024)
        if (PROFILE.digest(prepared) != record['reviewSha256']
                or material.get('installedRuntime') != record.get('installedRuntime')):
            raise BASE.InspectionError('changed')

    def bind_execution_plan(self, evidence, plan):
        evidence['executionPlan'] = plan
        evidence['executionConsent'].update(executionPlanSha256=self.digest(plan), overlaySha256=plan['overlaySha256'])

    def prepare_execution_plan(self, identifier, actor, evidence):
        source = self.source(evidence['source']['pointId'], actor)
        directory = self.directory(identifier) / 'execution'
        # Copy and verify before asking for final consent; large copies cannot consume its short TTL.
        with source.open_database_source() as database:
            overlay = database.copy_to(directory, evidence['profile'])
        PROFILE.verify_overlay(directory, overlay, self.a)
        self.enrollment.immutable(directory / 'overlay.json', self.P.canonical(overlay))
        for child in ('trusted-input', 'output', 'coordinator', 'socket'):
            (directory / child).mkdir(mode=0o700)
        descriptor = os.open(directory / 'socket', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fchown(descriptor, evidence['profile']['uid'], evidence['profile']['gid'])
            os.fchmod(descriptor, 0o770)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        inventory = self.configuration.code()
        for name, expected in inventory.items():
            body = self.enrollment.read(self.configuration.trust.code_directory / name, 16 * 1024 * 1024)
            if len(body) != expected['bytes'] or PROFILE.digest(body) != expected['sha256']:
                raise BASE.InspectionError('coordinator')
            self.enrollment.immutable(directory / 'coordinator' / name, body)
        handle, projection = self.prepared_configuration(identifier, actor, source)
        authentication = self.enrollment.read(self.configuration.directory(identifier) / 'output/source-authentication.json', 2 * 1024 * 1024)
        if PROFILE.digest(authentication) != projection['sourceAuthenticationSha256']:
            raise BASE.InspectionError('configuration')
        self.enrollment.immutable(directory / 'trusted-input/source-authentication.json', authentication)
        if self.configuration.code() != inventory:
            raise BASE.InspectionError('coordinator')
        plan = {'schema': 'orbis.core-local-inspection-plan.v1', 'id': identifier,
                'sourceWitnessSha256': evidence['source']['sourceWitnessSha256'],
                'resourcesSha256': evidence['source']['resourcesSha256'], 'profileSha256': self.digest(evidence['profile']),
                'configurationReceiptSha256': handle.receipt_sha256, 'overlaySha256': self.digest(overlay),
                'coordinatorSha256': self.digest(inventory), 'sourceAuthenticationSha256': projection['sourceAuthenticationSha256'],
                'pgdataInventorySha256': PROFILE.prepared_copy_inventory(directory, evidence['profile'], self.a)['inventorySha256'],
                'restoreAuthority': False}
        self.enrollment.immutable(directory / 'plan.json', self.P.canonical(plan))
        self.enrollment.sync(directory)
        return self.checked_execution_plan(identifier, evidence)

    def checked_execution_plan(self, identifier, evidence):
        directory = self.directory(identifier) / 'execution'
        plan_body = self.enrollment.read(directory / 'plan.json', 16384)
        plan = self.P.metadata(plan_body, byte_limit=16384)
        expected = {'schema', 'id', 'sourceWitnessSha256', 'resourcesSha256', 'profileSha256', 'configurationReceiptSha256',
                    'overlaySha256', 'coordinatorSha256', 'sourceAuthenticationSha256', 'pgdataInventorySha256', 'restoreAuthority'}
        overlay = self.enrollment.read(directory / 'overlay.json', 16 * 1024 * 1024)
        authentication = self.enrollment.read(directory / 'trusted-input/source-authentication.json', 2 * 1024 * 1024)
        if (not self.P.exact(plan, expected) or plan_body != self.P.canonical(plan)
                or plan['schema'] != 'orbis.core-local-inspection-plan.v1' or plan['id'] != identifier
                or plan['sourceWitnessSha256'] != evidence['source']['sourceWitnessSha256']
                or plan['resourcesSha256'] != evidence['source']['resourcesSha256']
                or plan['profileSha256'] != self.digest(evidence['profile'])
                or plan['configurationReceiptSha256'] != evidence['source']['configurationPreparationSha256']
                or plan['overlaySha256'] != PROFILE.digest(overlay)
                or plan['coordinatorSha256'] != self.digest(PROFILE.coordinator_inventory(directory / 'coordinator', self.a))
                or plan['coordinatorSha256'] != evidence['destination']['inspectionCoordinatorCodeSha256']
                or plan['sourceAuthenticationSha256'] != PROFILE.digest(authentication)
                or plan['sourceAuthenticationSha256'] != evidence['source']['environmentProjection']['sourceAuthenticationSha256']
                or not BASE.E.matches(BASE.E.HEX, plan['pgdataInventorySha256'])
                or plan['restoreAuthority'] is not False):
            raise BASE.InspectionError('changed')
        return plan

    def prepare_authorized_execution(self, record):
        source, consent = record['evidence']['source'], record['evidence']['executionConsent']
        projection = source['environmentProjection']
        directory = self.directory(record['id']) / 'execution'
        worker_request = {'schema': 'orbis.core-inspection-worker-input.v' + str(self.worker_version), 'id': record['id'], 'nonce': secrets.token_hex(32),
                          'permitSha256': record['permitSha256'], 'resourcesSha256': source['resourcesSha256'],
                          'sourceManifestSha256': source['payload']['manifestSha256'], 'database': projection['database'],
                          'sourceOwnerId': source['sourceOwnerId'], 'sourceImageId': source['images']['database'],
                          'sourceAuthenticationSha256': projection['sourceAuthenticationSha256'],
                          'settingsSha256': consent['settingsSha256'], 'role': projection['role'],
                          'sourceProjectionSha256': self.digest(projection), **self.worker_fields(record['evidence'])}
        plan = record['evidence']['executionPlan']
        ready = {'schema': self.ready_schema, 'permitSha256': record['permitSha256'],
                 'requestSha256': self.digest(worker_request), 'overlaySha256': plan['overlaySha256'],
                 'coordinatorSha256': plan['coordinatorSha256'], 'profileSha256': plan['profileSha256'],
                 'configurationReceiptSha256': plan['configurationReceiptSha256']}
        self.enrollment.immutable(directory / 'trusted-input/request.json', self.P.canonical(worker_request))
        self.enrollment.immutable(directory / 'prepared.json', self.P.canonical(ready))
        self.require_current(record)

    def projection(self, record):
        source = record['evidence']['source']
        projection = source.get('environmentProjection')
        if (source.get('origin') != 'genuine-root-local-capture' or not isinstance(projection, dict)
                or projection.get('schema') != 'orbis.core-source-environment.v2'
                or projection.get('basis') != 'captured-configuration-candidate'
                or projection.get('environmentProved') is not False or projection.get('restoreAuthority') is not False):
            raise BASE.InspectionError('source-environment-unavailable')
        return projection

    def require_claim_bindings(self, record, projection, request, ready):
        profile = record['evidence']['profile']
        consent = record['evidence']['executionConsent']
        expected = {'schema', 'id', 'nonce', 'permitSha256', 'resourcesSha256', 'sourceManifestSha256', 'database',
                    'sourceOwnerId', 'sourceImageId', 'sourceAuthenticationSha256', 'settingsSha256', 'role', 'sourceProjectionSha256'} | set(self.worker_fields(record['evidence']))
        if (not self.P.exact(request, expected) or request['schema'] != 'orbis.core-inspection-worker-input.v' + str(self.worker_version)
                or any(request.get(key) != value for key, value in self.worker_fields(record['evidence']).items())
                or any(not BASE.E.matches(BASE.E.HEX, ready[key]) for key in self.ready_extra_fields | {
                    'permitSha256', 'requestSha256', 'overlaySha256', 'coordinatorSha256'})
                or not BASE.E.matches(BASE.E.HEX, request['nonce'])
                or request['role'] != projection['role'] or request['sourceProjectionSha256'] != self.digest(projection)
                or request['settingsSha256'] != consent['settingsSha256']
                or ready['profileSha256'] != self.digest(profile)
                or ready['overlaySha256'] != record['evidence']['executionPlan']['overlaySha256']
                or ready['configurationReceiptSha256'] != record['evidence']['source']['configurationPreparationSha256']
                or ready['coordinatorSha256'] != record['evidence']['destination']['inspectionCoordinatorCodeSha256']
                or consent['imageAuthority'] != 'root-qualified-cached-image' or profile['schema'] != self.profile):
            raise BASE.InspectionError('changed')
        self.validate_prepared_execution(record, self.directory(record['id']) / 'execution')

    def validate_pre_approval(self, record):
        self.validate_prepared_execution(record, self.directory(record['id']) / 'execution')

    def validate_prepared_execution(self, record, directory):
        if Path(directory) != self.directory(record['id']) / 'execution':
            raise BASE.InspectionError('changed')
        inventory = PROFILE.prepared_copy_inventory(directory, record['evidence']['profile'], self.a)
        if inventory['inventorySha256'] != record['evidence']['executionPlan']['pgdataInventorySha256']:
            raise BASE.InspectionError('changed')


class CoreBootstrapSourceInspection(CoreLocalRestoreInspection):
    """Fresh consent for catalog export; old completed jobs never gain this scope."""
    schema = 'orbis.core-restore-inspection.v3'
    version = 3
    permit_schema = 'orbis.core-restore-inspection-permit.v3'
    ready_schema = 'orbis.core-inspection-execution-ready.v3'
    worker_version = 3
    worker_extra = {'evidenceScope': 'authenticated-bootstrap-source'}
    consent_schema = 'orbis.core-inspection-execution-consent.v3'
    report_schema = 'orbis.core-inspection-worker-result.v3'
    catalog_schema = 'orbis.core-root-authenticated-bootstrap-source.v1'

    def evidence(self, point, actor, identifier):
        evidence = super().evidence(point, actor, identifier)
        evidence['executionConsent'].update(self.worker_extra)
        return evidence

    @runtime_authorized
    def bootstrap_catalog(self, identifier, actor):
        """Recheck owned terminal evidence for fresh-target bootstrap only."""
        actor = self.enrollment.actor(actor)
        record = self.record(identifier)
        if record.get('actor') != actor or record.get('phase') != 'inspection-complete':
            raise BASE.InspectionError('source')
        source = self.source(record['pointId'], actor)
        basis = source.basis()
        material = record['evidence']['source']
        if (basis['sourceWitnessSha256'] != material['sourceWitnessSha256']
                or basis['sourceManifestSha256'] != material['payload']['manifestSha256']
                or self.digest(self.configuration.code()) != record['executionCoordinatorSha256']):
            raise BASE.InspectionError('changed')
        handle, projection = self.prepared_configuration(identifier, actor, source)
        if (handle.receipt_sha256 != material['configurationPreparationSha256']
                or projection != material['environmentProjection']):
            raise BASE.InspectionError('configuration')
        executor = load('orbis-host-core-inspection-executor.py', 'orbis_bootstrap_source_completion')
        report = executor.InspectionSupervisor(self, record).checked_completion(
            self.directory(identifier) / 'execution', record['evidence']['profile'])
        if (report.get('schema') != self.report_schema
                or report.get('evidenceScope') != self.worker_extra['evidenceScope']):
            raise BASE.InspectionError('source')
        evidence = report['bootstrapSource']
        catalog = {'schema': self.catalog_schema, 'actor': copy.deepcopy(actor),
                'sourceWitnessSha256': basis['sourceWitnessSha256'],
                'sourceManifestSha256': basis['sourceManifestSha256'],
                'sourceControllerImageId': self.configuration.trust.source_controller_image_id,
                'catalogSha256': evidence['catalogSha256'], 'systemIdentifier': evidence['systemIdentifier'],
                'ledger': copy.deepcopy(evidence['migrationLedger']), 'authenticationVerified': True,
                'authorityScope': 'authenticated-source-catalog-and-ledger',
                'environmentProved': False, 'restoreAuthority': False}

        return self.completed_catalog(catalog, report, record)

    def completed_catalog(self, catalog, report, record):
        return catalog


class CoreVersionedBootstrapSourceInspection(CoreBootstrapSourceInspection):
    """Fresh, profile-bound observation; prior consent never gains this protocol."""
    schema = 'orbis.core-restore-inspection.v4'
    profile = PROFILE.EXECUTION_SCHEMA
    version = 4
    permit_schema = 'orbis.core-restore-inspection-permit.v4'
    ready_schema = 'orbis.core-inspection-execution-ready.v4'
    worker_version = 4
    consent_schema = 'orbis.core-inspection-execution-consent.v4'
    report_schema = 'orbis.core-inspection-worker-result.v4'
    catalog_schema = 'orbis.core-root-authenticated-bootstrap-source.v2'

    def inspection_profile(self, image, projection):
        return PROFILE.role_bound_execution_profile(image, projection['role'], self.digest(projection))

    def worker_fields(self, evidence):
        profile = PROFILE.validate_profile(evidence['profile'])
        if profile['schema'] != self.profile:
            raise BASE.InspectionError('platform')
        return {**self.worker_extra, 'executionProfile': profile['profileId']}

    def evidence(self, point, actor, identifier):
        evidence = super().evidence(point, actor, identifier)
        evidence['executionConsent']['executionProfile'] = evidence['profile']['profileId']
        return evidence

    def require_claim_bindings(self, record, projection, request, ready):
        super().require_claim_bindings(record, projection, request, ready)
        profile = PROFILE.validate_profile(record['evidence']['profile'])
        if (record['schema'] != self.schema or record['sandboxProfile'] != self.profile
                or record['evidence']['executionConsent'].get('schema') != self.consent_schema
                or record['evidence']['executionConsent'].get('executionProfile') != profile['profileId']
                or request['executionProfile'] != profile['profileId']):
            raise BASE.InspectionError('changed')

    def completed_catalog(self, catalog, report, record):
        profile = PROFILE.validate_profile(record['evidence']['profile'])
        executor = load('orbis-host-core-inspection-executor.py', 'orbis_versioned_source_observation')
        observation = executor.validate_database_execution(profile,
            {'database': record['evidence']['source']['environmentProjection']['database']}, report.get('databaseExecution'))
        if (profile['schema'] != self.profile or report.get('executionProfile') != profile['profileId']
                or not isinstance(report['bootstrapSource'], dict)
                or report['bootstrapSource'].get('schema') != 'orbis.core-source-bootstrap-evidence.v2'):
            raise BASE.InspectionError('source')
        return {**catalog, 'executionProfile': copy.deepcopy(profile), 'databaseExecution': copy.deepcopy(observation)}
