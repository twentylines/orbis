"""Fresh inspection-only admission over enrolled bytes; public execution remains disabled."""
import hashlib
import importlib.util
import os
from pathlib import Path
import secrets
import time
from contextlib import nullcontext


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


E = load('orbis-host-core-portable-enrollment.py', 'orbis_core_inspection_enrollment')
SCHEMA = 'orbis.core-restore-inspection.v1'
PROFILE = 'orbis.core-source-pg-inspection.v1'
RESTRICTIONS = ['legacy-create-intents-not-captured', 'legacy-effective-environment-not-captured']


class InspectionError(ValueError):
    def __init__(self, reason):
        self.reason = reason
        super().__init__('Core inspection could not be authorized (' + reason + '). Existing server data was preserved.')


class CoreRestoreInspection:
    schema = SCHEMA
    profile = PROFILE
    version = 1
    permit_schema = 'orbis.core-restore-inspection-permit.v1'
    ready_schema = 'orbis.core-inspection-execution-ready.v1'
    ready_extra_fields = set()

    def __init__(self, service, enrollment=None):
        self.enrollment = enrollment if enrollment is not None else E.CorePortableEnrollment(service)
        self.a, self.P = self.enrollment.a, self.enrollment.P
        self.root, self.context, self.state = self.enrollment.root, self.enrollment.context, self.enrollment.state

    def digest(self, value):
        return hashlib.sha256(self.P.canonical(value)).hexdigest()

    def runtime_authority(self):
        return nullcontext()

    def directory(self, identifier, create=False):
        if not E.matches(E.UUID, identifier):
            raise InspectionError('authority')
        base = self.enrollment.child(self.state, 'core-restore-inspections') if create else self.state / 'core-restore-inspections'
        with self.a.protected_directory(base):
            names = list(base.iterdir())
        if (any(not E.matches(E.UUID, path.name) for path in names)
                or len(names) >= 256 and all(path.name != identifier for path in names)):
            raise InspectionError('authority')
        target = base / identifier
        if create:
            target.mkdir(mode=0o700)
            self.enrollment.sync(base)
        with self.a.protected_directory(target):
            pass
        return target

    def save(self, record):
        self.a.atomic(self.directory(record['id']) / 'job.json', self.P.canonical(record))

    def record(self, identifier):
        record = self.enrollment.json(self.directory(identifier) / 'job.json', 4 * 1024 * 1024)
        if (record.get('schema') != self.schema or record.get('id') != identifier or record.get('root') != str(self.root)
                or record.get('context') != self.context or record.get('scope') != 'inspection-only'
                or record.get('sandboxProfile') != self.profile or record.get('activationAuthorized') is not False):
            raise InspectionError('authority')
        return record

    def evidence(self, enrollment_id, actor):
        enrollment = self.enrollment
        origin = enrollment.record(enrollment_id)
        if (origin.get('phase') != 'enrolled' or origin.get('resourceIntent') != 'complete'
                or actor['ownerId'] != origin.get('actor', {}).get('ownerId')):
            raise InspectionError('source')
        review = enrollment.checked_review(origin)
        if review != origin.get('review'):
            raise InspectionError('source')
        source_dir = enrollment.directory(enrollment_id)
        provenance_body = enrollment.read(source_dir / 'provenance.json', 4 * 1024 * 1024)
        provenance = self.P.metadata(provenance_body, byte_limit=4 * 1024 * 1024)
        if (hashlib.sha256(provenance_body).hexdigest() != origin.get('provenanceSha256')
                or provenance.get('schema') != 'orbis.core-portable-provenance.v1'
                or provenance.get('origin') != 'authenticated-portable-import'
                or provenance.get('id') != enrollment_id or provenance.get('root') != str(self.root)
                or provenance.get('context') != self.context
                or any(provenance.get(key) != origin.get(key) for key in ('review', 'checkpointReview', 'resources', 'reviewSha256', 'approvalSha256'))):
            raise InspectionError('source')
        receipt = enrollment.json(source_dir / 'enrolled.json')
        index = enrollment.json(self.state / 'core-portable-points' / (review['pointId'] + '.json'))
        if (receipt != index or receipt.get('schema') != E.SCHEMA or receipt.get('id') != enrollment_id
                or receipt.get('pointId') != review['pointId'] or receipt.get('ownerId') != actor['ownerId']
                or receipt.get('provenanceSha256') != origin['provenanceSha256'] or receipt.get('files') != review['files']
                or receipt.get('restoreSupported') is not False):
            raise InspectionError('source')
        destination = enrollment.destination()
        observed = enrollment.runtime.source_snapshot()
        if (self.digest(observed) != destination['revisionSha256']
                or not E.matches(E.HEX, observed.get('coordinatorCapabilitySha256'))):
            raise InspectionError('authority')
        image = enrollment.runtime.image(destination['imageId'])
        platform = {'os': image.get('Os'), 'architecture': image.get('Architecture')}
        compatibility = origin['checkpointReview']['compatibility']
        if (image.get('Id') != destination['imageId'] or platform['os'] != 'linux'
                or platform['architecture'] not in {'arm64', 'amd64'}
                or platform != {key: compatibility[key] for key in ('os', 'architecture')}):
            raise InspectionError('platform')
        enrollment.verify_publication(origin, Path(destination['library']) / 'points' / review['pointId'])
        source = {'enrollmentId': enrollment_id, 'pointId': review['pointId'],
                  'sourceOwnerId': review['sourceOwnerId'], 'ownerId': review['ownerId'],
                  'provenanceSha256': origin['provenanceSha256'], 'enrolledSha256': self.digest(receipt),
                  'capsuleSha256': origin['capsuleSha256'], 'payload': review['payload'],
                  'checkpointReview': origin['checkpointReview'], 'resourcesSha256': self.digest(origin['resources']),
                  'images': origin['checkpointReview']['roleImages'], 'compatibility': compatibility,
                  'legacyRestrictions': RESTRICTIONS}
        database = source['images']['database']
        image_entry = review['payload']['files'].get('images/image-' + database.removeprefix('sha256:') + '.tar')
        if image_entry is None:
            raise InspectionError('source')
        consent = {'schema': 'orbis.core-inspection-execution-consent.v1', 'role': 'database', 'imageId': database,
                   'archiveSha256': image_entry['sha256'], 'platform': platform,
                   'postgresqlMajor': compatibility['database']['major'], 'sandboxProfile': PROFILE,
                   'authority': 'explicit-fresh-exact-bytes', 'scope': 'inspection-only'}
        destination['coordinatorCapabilitySha256'] = observed['coordinatorCapabilitySha256']
        destination['platform'] = platform
        return {'source': source, 'destination': destination, 'executionConsent': consent}

    def require_current(self, record):
        if self.evidence(record['enrollmentId'], record['actor']) != record['evidence']:
            raise InspectionError('changed')
        prepared = self.enrollment.read(self.directory(record['id']) / 'prepared.json', 4 * 1024 * 1024)
        if hashlib.sha256(prepared).hexdigest() != record['reviewSha256']:
            raise InspectionError('changed')

    def prepare(self, request, *, privileged_peer=False):
        if (privileged_peer is not True or not self.P.exact(request, {'id', 'enrollmentId', 'actor'})
                or not E.matches(E.UUID, request['enrollmentId'])):
            raise InspectionError('authority')
        actor = self.enrollment.actor(request['actor'])
        evidence = self.evidence(request['enrollmentId'], actor)
        directory = self.directory(request['id'], True)
        record = {'schema': SCHEMA, 'id': request['id'], 'root': str(self.root), 'context': self.context,
                  'scope': 'inspection-only', 'sandboxProfile': PROFILE, 'activationAuthorized': False,
                  'actor': actor, 'enrollmentId': request['enrollmentId'], 'evidence': evidence}
        prepared = self.P.canonical(record)
        record.update(phase='preparing', reviewSha256=hashlib.sha256(prepared).hexdigest())
        self.save(record)
        try:
            self.enrollment.immutable(directory / 'prepared.json', prepared)
            record.update(phase='awaiting-approval', approvalNonce=secrets.token_hex(32),
                          approvalExpiresAt=int(time.time() * 1000) + 300000)
            self.save(record)
        except BaseException as error:
            record.update(phase='recovery-required', failureClass=type(error).__name__)
            self.save(record)
            raise
        return self.public(record)

    def approve(self, request, *, privileged_peer=False):
        if (privileged_peer is not True or not self.P.exact(request, {'id', 'actor', 'reviewSha256', 'approvalNonce', 'executionConsent', 'action'})
                or request['action'] != 'authorize-core-inspection-only'):
            raise InspectionError('authority')
        record = self.record(request['id'])
        if (record['phase'] != 'awaiting-approval' or self.enrollment.actor(request['actor']) != record['actor']
                or request['reviewSha256'] != record['reviewSha256'] or request['approvalNonce'] != record['approvalNonce']):
            raise InspectionError('approval')
        if record['approvalExpiresAt'] <= int(time.time() * 1000):
            raise InspectionError('expired')
        if request['executionConsent'] != record['evidence']['executionConsent']:
            raise InspectionError('consent')
        self.require_current(record)
        self.validate_pre_approval(record)
        if record['approvalExpiresAt'] <= int(time.time() * 1000):
            raise InspectionError('expired')
        approval_claim = {'schema': 'orbis.core-inspection-approval-claim.v1', 'id': record['id'],
                          'actor': record['actor'], 'reviewSha256': record['reviewSha256'],
                          'approvalNonce': record['approvalNonce'], 'nonce': secrets.token_hex(32)}
        # Losers must leave before entering any path that writes stale job state.
        self.reserve_approval(record, approval_claim)
        record['phase'] = 'authorizing'
        record['approvalClaimSha256'] = self.digest(approval_claim)
        record.pop('approvalNonce')
        self.save(record)
        permit = {'schema': self.permit_schema, 'id': record['id'],
                  'scope': 'inspection-only', 'sandboxProfile': self.profile, 'activationAuthorized': False,
                  'actor': record['actor'], 'reviewSha256': record['reviewSha256'], 'evidenceSha256': self.digest(record['evidence']),
                  'executionConsent': request['executionConsent'], 'approvedAt': int(time.time() * 1000),
                  'expiresAt': int(time.time() * 1000) + 300000, 'nonce': secrets.token_hex(32)}
        try:
            self.enrollment.immutable(self.directory(record['id']) / 'permit.json', self.P.canonical(permit))
            record.update(permitSha256=self.digest(permit), permitExpiresAt=permit['expiresAt'])
            self.prepare_authorized_execution(record)
            record['phase'] = 'inspection-authorized'
            self.save(record)
        except BaseException as error:
            record.update(phase='recovery-required', failureClass=type(error).__name__)
            self.save(record)
            raise
        return self.public(record)

    def status(self, request, *, privileged_peer=False):
        if privileged_peer is not True or not self.P.exact(request, {'id', 'actor'}):
            raise InspectionError('authority')
        record = self.record(request['id'])
        if self.enrollment.actor(request['actor']) != record['actor']:
            raise InspectionError('authority')
        if record['phase'] in {'preparing', 'authorizing', 'recovery-required'}:
            return self.public(record)
        if record['phase'] == 'awaiting-approval' and self.approval_reserved(record):
            return self.public({**record, 'phase': 'recovery-required'})
        self.require_current(record)
        if record['phase'] == 'inspection-authorized':
            if self.claim_reserved(record):
                return self.public({**record, 'phase': 'recovery-required'})
            permit = self.enrollment.json(self.directory(record['id']) / 'permit.json')
            if self.digest(permit) != record['permitSha256']:
                raise InspectionError('changed')
        return self.public(record)

    def claim_execution(self, identifier, actor):
        """Internal coordinator claim only; there is intentionally no HTTP execution route."""
        record = self.record(identifier)
        if (record['phase'] != 'inspection-authorized' or self.enrollment.actor(actor) != record['actor']
                or record['permitExpiresAt'] <= int(time.time() * 1000)):
            raise InspectionError('approval')
        self.require_current(record)
        permit = self.enrollment.json(self.directory(identifier) / 'permit.json')
        if (self.digest(permit) != record['permitSha256'] or permit.get('scope') != 'inspection-only'
                or permit.get('activationAuthorized') is not False or permit.get('actor') != record['actor']
                or permit.get('evidenceSha256') != self.digest(record['evidence']) or permit.get('expiresAt', 0) <= int(time.time() * 1000)):
            raise InspectionError('approval')
        source = record['evidence']['source']
        projection = self.projection(record)
        directory = self.directory(identifier) / 'execution'
        ready = self.enrollment.json(directory / 'prepared.json')
        request = self.enrollment.json(directory / 'trusted-input/request.json', 16384)
        if (not self.P.exact(ready, {'schema', 'permitSha256', 'requestSha256', 'overlaySha256', 'coordinatorSha256'} | self.ready_extra_fields)
                or ready['schema'] != self.ready_schema or ready['permitSha256'] != record['permitSha256']
                or ready['requestSha256'] != self.digest(request)
                or request.get('permitSha256') != record['permitSha256'] or request.get('id') != identifier
                or request.get('resourcesSha256') != source['resourcesSha256']
                or request.get('sourceManifestSha256') != source['payload']['manifestSha256']
                or request.get('sourceImageId') != source['images']['database'] or request.get('sourceOwnerId') != source['sourceOwnerId']
                or any(request.get(key) != projection[key] for key in ('database', 'sourceAuthenticationSha256'))):
            raise InspectionError('changed')
        self.require_claim_bindings(record, projection, request, ready)
        with self.a.protected_directory(directory) as descriptor:
            details = os.fstat(descriptor)
            directory_binding = {'path': str(directory), **{key: getattr(details, 'st_' + field) for key, field in (
                ('device', 'dev'), ('inode', 'ino'), ('mode', 'mode'), ('uid', 'uid'), ('gid', 'gid'))}}
        if record['permitExpiresAt'] <= int(time.time() * 1000):
            raise InspectionError('expired')
        claim_sha = self.reserve_execution_claim(record, ready, directory_binding)
        record.update(phase='inspecting', executionPermitSha256=record['permitSha256'], executionRequestSha256=ready['requestSha256'],
                      executionOverlaySha256=ready['overlaySha256'], executionCoordinatorSha256=ready['coordinatorSha256'],
                      executionConsumedAt=int(time.time() * 1000), executionDirectory=directory_binding, executionClaimSha256=claim_sha)
        self.save(record)
        return record

    def projection(self, record):
        source = record['evidence']['source']
        projection = source.get('environmentProjection')
        if ('legacy-effective-environment-not-captured' in source['legacyRestrictions'] or not isinstance(projection, dict)):
            raise InspectionError('source-environment-unavailable')
        if (not self.P.exact(projection, {'schema', 'sourceManifestSha256', 'database', 'role', 'sourceAuthenticationSha256'})
                or projection['schema'] != 'orbis.core-source-environment.v1' or projection['role'] != 'postgres'
                or projection['sourceManifestSha256'] != source['payload']['manifestSha256']):
            raise InspectionError('source-environment-unavailable')
        return projection

    def require_claim_bindings(self, record, projection, request, ready):
        pass

    def validate_pre_approval(self, record):
        pass

    def prepare_authorized_execution(self, record):
        pass

    def approval_reserved(self, record):
        with self.a.protected_directory(self.directory(record['id'])) as descriptor:
            try:
                os.stat('approval-claim.json', dir_fd=descriptor, follow_symlinks=False)
            except FileNotFoundError:
                return False
        return True

    def reserve_approval(self, record, claim):
        try:
            self.enrollment.immutable(self.directory(record['id']) / 'approval-claim.json', self.P.canonical(claim))
        except (OSError, ValueError):
            raise InspectionError('approval') from None

    def validate_prepared_execution(self, record, directory):
        raise InspectionError('source-environment-unavailable')

    def claim_reserved(self, record):
        with self.a.protected_directory(self.directory(record['id'])) as descriptor:
            try:
                os.stat('execution-claim.json', dir_fd=descriptor, follow_symlinks=False)
            except FileNotFoundError:
                return False
        return True

    def reserve_execution_claim(self, record, ready, directory_binding):
        # A new nonce makes no-replace publication exclusive even for concurrent identical requests.
        claim = {'schema': 'orbis.core-inspection-execution-claim.v1', 'id': record['id'], 'actor': record['actor'],
                 'permitSha256': record['permitSha256'], 'requestSha256': ready['requestSha256'],
                 'evidenceSha256': self.digest(record['evidence']), 'directory': directory_binding, 'nonce': secrets.token_hex(32)}
        try:
            self.enrollment.immutable(self.directory(record['id']) / 'execution-claim.json', self.P.canonical(claim))
        except (OSError, ValueError):
            raise InspectionError('approval') from None
        return self.digest(claim)

    def validate_execution_claim(self, record):
        claim = self.enrollment.json(self.directory(record['id']) / 'execution-claim.json', 16384)
        if (not self.P.exact(claim, {'schema', 'id', 'actor', 'permitSha256', 'requestSha256', 'evidenceSha256', 'directory', 'nonce'})
                or claim['schema'] != 'orbis.core-inspection-execution-claim.v1' or claim['id'] != record['id']
                or claim['actor'] != record['actor'] or claim['permitSha256'] != record['executionPermitSha256']
                or claim['requestSha256'] != record['executionRequestSha256']
                or claim['evidenceSha256'] != self.digest(record['evidence'])
                or claim['directory'] != record['executionDirectory'] or not E.matches(E.HEX, claim['nonce'])
                or self.digest(claim) != record['executionClaimSha256']):
            raise InspectionError('changed')

    @classmethod
    def public(cls, record):
        phase = record['phase']
        if phase in {'preparing', 'authorizing', 'recovery-required', 'inspecting', 'inspection-complete'}:
            phase = 'recovery-required'
        elif record.get('permitExpiresAt', record.get('approvalExpiresAt', 0)) <= int(time.time() * 1000):
            phase = 'expired'
        value = {'schema': cls.schema, 'version': cls.version, 'id': record['id'], 'phase': phase, 'scope': 'inspection-only',
                 'restoreSupported': False, 'activationAuthorized': False, 'workerExecutionAvailable': False,
                 'pointId': record['evidence']['source']['pointId'], 'ownerId': record['actor']['ownerId']}
        if phase == 'awaiting-approval':
            value.update(reviewSha256=record['reviewSha256'], approvalNonce=record['approvalNonce'],
                         approvalExpiresAt=record['approvalExpiresAt'], executionConsent=record['evidence']['executionConsent'],
                         legacyRestrictions=record['evidence']['source']['legacyRestrictions'])
        elif phase == 'inspection-authorized':
            value.update(permitSha256=record['permitSha256'], permitExpiresAt=record['permitExpiresAt'])
        return value
