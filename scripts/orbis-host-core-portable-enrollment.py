"""Destination Root custody and one-shot publication of authenticated core imports."""
import ctypes
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import tarfile
import time


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DRIVER = load('orbis-host-core-portable-driver.py', 'orbis_core_portable_fixed_driver')
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
HEX = re.compile('[a-f0-9]{64}')
SCHEMA = 'orbis.core-portable-enrollment.v1'
FILES = {'point.json', 'metadata.orbis', 'core.orbis', 'capture-draft.orbis', 'wallpaper.orbis', 'icons.orbis'}
REQUIRED = {'point.json', 'metadata.orbis', 'core.orbis', 'capture-draft.orbis'}
LIMIT = 128 * 1024 ** 3


class EnrollmentError(ValueError):
    pass


def fail():
    return EnrollmentError('Core import requires authenticated bytes, unchanged destination custody and fresh actor approval')


def matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def sha(body):
    return hashlib.sha256(body).hexdigest()


def rename_noreplace(source, destination):
    """Atomically move a complete generation across pinned private parents."""
    a = os.open(source.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    b = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        name, flag = ('renameat2', 1) if sys.platform == 'linux' else ('renameatx_np', 4) if sys.platform == 'darwin' else ('', 0)
        operation = getattr(libc, name, None)
        if operation is None:
            raise fail()
        operation.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
        operation.restype = ctypes.c_int
        if operation(a, os.fsencode(source.name), b, os.fsencode(destination.name), flag):
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))
        os.fsync(a)
        os.fsync(b)
    finally:
        os.close(a)
        os.close(b)


class CorePortableEnrollment:
    # The service dispatcher holds its process lock and installation flock. The
    # actor is supplied only by the currently enrolled privileged controller peer
    # after fresh account/session validation, not by a public request directly.
    def __init__(self, service, driver=None):
        self.service, self.host = service, service.HOST
        self.a, self.P = self.host.AUTHORITY, self.host.IDENTITY.PUBLICATION
        self.root, self.context, self.state = Path(service.root), service.context, Path(service.state_dir)
        self.runtime = service.retained_restores().runtime
        self.driver = driver if driver is not None else DRIVER.CorePortableDriver(self)

    def child(self, parent, name):
        with self.a.protected_directory(parent):
            pass
        directory = parent / name
        directory.mkdir(mode=0o700, exist_ok=True)
        with self.a.protected_directory(directory):
            pass
        return directory

    def directory(self, identifier, create=False):
        if not matches(UUID, identifier):
            raise fail()
        base = self.child(self.state, 'core-portable-enrollments') if create else self.state / 'core-portable-enrollments'
        with self.a.protected_directory(base):
            names = os.listdir(base)
        if len(names) >= 256 and identifier not in names or any(not matches(UUID, name) for name in names):
            raise fail()
        target = base / identifier
        if create:
            # Existing/partial admissions are never reclaimed as new work.
            target.mkdir(mode=0o700)
            self.sync(base)
        with self.a.protected_directory(target):
            pass
        return target

    @staticmethod
    def sync(directory):
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def read(self, path, maximum):
        with self.a.protected_directory(path.parent) as parent:
            with self.a.protected_file(parent, path.name, maximum) as body:
                return body

    def json(self, path, maximum=2 * 1024 * 1024):
        return self.P.metadata(self.read(path, maximum), byte_limit=maximum, string_limit=maximum)

    def digest(self, path, maximum=LIMIT):
        with self.a.protected_directory(path.parent) as parent:
            with self.a.protected_file(parent, path.name, maximum, digest_only=True) as digest:
                return {'bytes': path.lstat().st_size, 'sha256': digest.removeprefix('sha256:')}

    def immutable(self, path, body):
        # Root's authority implementation fsyncs a new inode before no-replace
        # publication, and compares exact bytes on an idempotent retry.
        capture = load('orbis-host-capture-authority.py', 'orbis_core_portable_immutable')
        capture.AUTHORITY, capture.P = self.a, self.P
        capture.immutable(path, body)

    def save(self, record):
        self.a.atomic(self.directory(record['id']) / 'job.json', self.P.canonical(record))

    def record(self, identifier):
        value = self.json(self.directory(identifier) / 'job.json', 4 * 1024 * 1024)
        if (value.get('schema') != SCHEMA or value.get('id') != identifier or value.get('root') != str(self.root)
                or value.get('context') != self.context):
            raise fail()
        return value

    def actor(self, value):
        if (not self.P.exact(value, {'ownerId', 'sessionBinding', 'securityBinding'})
                or type(value['ownerId']) is not int or not 1 <= value['ownerId'] <= 2**31 - 1
                or not matches(HEX, value['sessionBinding']) or not matches(HEX, value['securityBinding'])):
            raise fail()
        return value

    def implementation_sha256(self):
        capabilities = load('orbis-host-time-machine-capabilities.py', 'orbis_core_portable_helper_sources')
        return capabilities.source_digest(self.a, extra_required={
            'orbis-host-core-portable-enrollment.py', 'orbis-host-core-portable-driver.py',
            'orbis-host-core-checkpoint-review.py', 'orbis-host-core-checkpoint-materialize.py',
            'orbis-host-core-checkpoint.py', 'orbis-host-core-storage-map.py'})

    def destination(self):
        observed = self.runtime.source_snapshot()
        library = self.runtime.map_path(observed['container'], '/data/backups/time-machine')
        paths = [library, library / 'keys', library / 'points']
        identities = []
        for path in paths:
            with self.a.protected_directory(path):
                details = path.lstat()
                identities.append({'path': str(path), 'device': details.st_dev, 'inode': details.st_ino,
                                   'mode': stat.S_IMODE(details.st_mode), 'uid': details.st_uid, 'gid': details.st_gid})
        key = self.digest(library / 'keys/master-v1.key', 32)
        if key['bytes'] != 32:
            raise fail()
        with self.a.protected_directory(library / 'points'):
            names = sorted(os.listdir(library / 'points'))
        if len(names) > 16 or any(not matches(UUID, name) for name in names):
            raise fail()
        catalog = {name: self.digest(library / 'points' / name / 'point.json', 32768) for name in names}
        retained = 0
        for name in names:
            point = self.json(library / 'points' / name / 'point.json', 32768)
            for field in ('archiveBytes', 'runtimeBytes', 'assetBytes'):
                amount = point.get(field, 0)
                if type(amount) is not int or not 0 <= amount <= LIMIT:
                    raise fail()
                retained += amount
        if retained > LIMIT:
            raise fail()
        return {'controllerId': observed['controllerId'], 'imageId': observed['imageId'],
                'rootImplementationSha256': self.implementation_sha256(),
                'revisionSha256': sha(self.P.canonical(observed)), 'library': str(library),
                'storage': identities, 'keyId': key['sha256'],
                'keySeal': list(self.a.seal((library / 'keys/master-v1.key').lstat())), 'catalog': catalog,
                'retainedBytes': retained}

    def require_destination(self, record, *, allow_published=False):
        current = self.destination()
        expected = record['destination']
        if allow_published and record.get('review'):
            if current['catalog'].pop(record['review']['pointId'], None) is not None:
                point = self.json(Path(current['library']) / 'points' / record['review']['pointId'] / 'point.json', 32768)
                current['retainedBytes'] -= sum(point.get(field, 0) for field in ('archiveBytes', 'runtimeBytes', 'assetBytes'))
        if current != expected:
            raise fail()
        return current

    def checked_review(self, record):
        directory = self.directory(record['id'])
        review = self.json(directory / 'work/review.json')
        fields = {'schema', 'operationId', 'capsuleId', 'capsuleSha256', 'pointId', 'createdAt', 'sourceOwnerId',
                  'ownerId', 'keyId', 'metadata', 'files', 'payload', 'restoreSupported'}
        if (not self.P.exact(review, fields) or review['schema'] != 'orbis.core-portable-staged.v1'
                or review['operationId'] != record['id'] or review['capsuleSha256'] != record['capsuleSha256']
                or not matches(UUID, review['pointId']) or not matches(UUID, review['capsuleId'])
                or type(review['sourceOwnerId']) is not int or not 1 <= review['sourceOwnerId'] <= 2**31 - 1
                or review['ownerId'] != record['actor']['ownerId'] or review['keyId'] != record['destination']['keyId']
                or review['restoreSupported'] is not False or not isinstance(review['files'], dict)
                or not REQUIRED <= set(review['files']) <= FILES):
            raise fail()
        point_dir = directory / 'work/library/backups/time-machine/points' / review['pointId']
        with self.a.protected_directory(point_dir):
            if set(os.listdir(point_dir)) != set(review['files']):
                raise fail()
        for name, item in review['files'].items():
            if (not self.P.exact(item, {'bytes', 'sha256'}) or type(item['bytes']) is not int
                    or not 0 < item['bytes'] <= LIMIT or not matches(HEX, item['sha256'])
                    or self.digest(point_dir / name) != item):
                raise fail()
        seals = {name: list(self.a.seal((point_dir / name).lstat())) for name in review['files']}
        if record.get('reviewSeals') is not None and record['reviewSeals'] != seals:
            raise fail()
        record['reviewSeals'] = seals
        point = self.json(point_dir / 'point.json', 32768)
        metadata = review['metadata']
        if (point.get('version') != 3 or point.get('status') != 'sealed' or point.get('id') != review['pointId']
                or point.get('ownerId') != review['ownerId'] or point.get('createdAt') != review['createdAt']
                or point.get('envelope', {}).get('keyId') != review['keyId']
                or point.get('archiveSha256') != review['files']['core.orbis']['sha256']
                or point.get('archiveBytes') != review['files']['core.orbis']['bytes']
                or point.get('metadataSha256') != review['files']['metadata.orbis']['sha256']
                or not isinstance(metadata, dict) or metadata.get('id') != point['id'] or metadata.get('version') != 3
                or metadata.get('core') != point.get('core') or metadata.get('restore', {}).get('ready') is not False):
            raise fail()
        payload = review['payload']
        if (not self.P.exact(payload, {'schema', 'pointId', 'manifestSha256', 'files'})
                or payload['schema'] != 'orbis.core-portable-payload.v1' or payload['pointId'] != point['id']
                or payload['manifestSha256'] != metadata['core'].get('manifestSha256')
                or not isinstance(payload['files'], dict) or not 3 <= len(payload['files']) <= 5):
            raise fail()
        payload_dir = directory / 'work/payload'
        encoded = self.read(payload_dir / 'manifest.json', 2 * 1024 * 1024)
        manifest = self.P.metadata(encoded, byte_limit=2 * 1024 * 1024)
        if (sha(encoded) != payload['manifestSha256'] or self.P.canonical(manifest) != encoded
                or manifest.get('schema') != 'orbis.time-machine-core.v1' or manifest.get('pointId') != point['id']
                or any(manifest.get(key) != metadata['core'].get(key) for key in
                       ('sourceSha256', 'checkpointSha256', 'captureReceiptSha256', 'resourceCount', 'imageInventorySha256'))
                or manifest.get('compatibility') != metadata.get('compatibility')
                or not isinstance(manifest.get('entries'), list) or not 2 <= len(manifest['entries']) <= 4):
            raise fail()
        expected_payload = {'manifest.json': {'bytes': len(encoded), 'sha256': sha(encoded)}}
        for index, entry in enumerate(manifest['entries']):
            if (not self.P.exact(entry, {'name', 'bytes', 'sha256'}) or type(entry['bytes']) is not int
                    or not 0 < entry['bytes'] <= LIMIT or not matches(HEX, entry['sha256'])
                    or not isinstance(entry['name'], str)
                    or (entry['name'] != 'checkpoint.tar' if index == 0 else not re.fullmatch(r'images/image-[a-f0-9]{64}\.tar', entry['name']))
                    or entry['name'] in expected_payload):
                raise fail()
            expected_payload[entry['name']] = {'bytes': entry['bytes'], 'sha256': entry['sha256']}
        if payload['files'] != expected_payload:
            raise fail()
        with self.a.protected_directory(payload_dir):
            if set(os.listdir(payload_dir)) != {'manifest.json', 'checkpoint.tar', 'images'}:
                raise fail()
        with self.a.protected_directory(payload_dir / 'images'):
            if set(os.listdir(payload_dir / 'images')) != {Path(name).name for name in expected_payload if name.startswith('images/')}:
                raise fail()
        payload_seals = {}
        for name, expected in expected_payload.items():
            if self.digest(payload_dir / name) != expected:
                raise fail()
            payload_seals[name] = list(self.a.seal((payload_dir / name).lstat()))
        if record.get('payloadSeals') not in (None, payload_seals):
            raise fail()
        record['payloadSeals'] = payload_seals
        inventory = manifest.get('inventory')
        if (not isinstance(inventory, dict) or not isinstance(inventory.get('bindings'), list)
                or sha(self.P.canonical(inventory)) != manifest['imageInventorySha256']):
            raise fail()
        images = {entry.get('key'): entry.get('imageId') for entry in inventory['bindings'] if isinstance(entry, dict)}
        if len(inventory['bindings']) != 3 or set(images) != {'controller', 'database', 'queue'}:
            raise fail()
        expected = {key: manifest[key] for key in ('pointId', 'sourceSha256', 'checkpointSha256', 'resourceCount', 'compatibility')}
        expected.update(images=images, checkpoint={key: manifest['entries'][0][key] for key in ('bytes', 'sha256')})
        checkpoint_reader = load('orbis-host-core-checkpoint-review.py', 'orbis_core_portable_checkpoint_review')
        try:
            checkpoint_review = checkpoint_reader.review_checkpoint(payload_dir / 'checkpoint.tar', expected, self.a)
        except (tarfile.TarError, RecursionError, UnicodeError) as error:
            raise fail() from error
        if record.get('checkpointReview') not in (None, checkpoint_review):
            raise fail()
        record['checkpointReview'] = checkpoint_review
        if 'resources' in record:
            materializer = load('orbis-host-core-checkpoint-materialize.py', 'orbis_core_portable_resources')
            materializer.verify_checkpoint_resources(payload_dir / 'checkpoint.tar', expected, directory / 'candidate', record['resources'], self.a)
        if self.digest(directory / 'input/capsule.orbis-tm')['sha256'] != record['capsuleSha256']:
            raise fail()
        if any(list(self.a.seal((directory / 'input' / name).lstat())) != expected
               for name, expected in record.get('inputSeals', {}).items()):
            raise fail()
        return review

    def prepare(self, request, *, privileged_peer=False):
        fields = {'id', 'capsuleJobId', 'capsuleSha256', 'actor', 'passphrase'}
        if (privileged_peer is not True or not self.P.exact(request, fields) or not matches(UUID, request['id'])
                or not matches(UUID, request['capsuleJobId']) or not matches(HEX, request['capsuleSha256'])
                or not isinstance(request['passphrase'], str) or not 8 <= len(request['passphrase']) <= 1024):
            raise fail()
        actor = self.actor(request['actor'])
        destination = self.destination()
        if len(destination['catalog']) >= 16:
            raise fail()
        directory = self.directory(request['id'], True)
        record = {'schema': SCHEMA, 'id': request['id'], 'root': str(self.root), 'context': self.context,
                  'phase': 'preparing', 'actor': actor, 'destination': destination,
                  'capsuleJobId': request['capsuleJobId'], 'capsuleSha256': request['capsuleSha256'],
                  'workerNonce': secrets.token_hex(32)}
        self.save(record)
        try:
            input_dir, _work = self.child(directory, 'input'), self.child(directory, 'work')
            original = self.runtime.inspect(destination['controllerId'])
            capsule = self.runtime.map_path(original, '/data/backups/capsules/' + request['capsuleJobId'] + '/capsule.orbis-tm')
            self.runtime.copy_file(capsule, input_dir / 'capsule.orbis-tm', LIMIT + 8 * 1024 * 1024)
            if self.digest(input_dir / 'capsule.orbis-tm')['sha256'] != request['capsuleSha256']:
                raise fail()
            self.runtime.copy_file(Path(destination['library']) / 'keys/master-v1.key', input_dir / 'master-v1.key', 32)
            if self.digest(input_dir / 'master-v1.key', 32)['sha256'] != destination['keyId']:
                raise fail()
            worker_request = {'operationId': request['id'], 'capsuleSha256': request['capsuleSha256'],
                              'ownerId': actor['ownerId'], 'keyId': destination['keyId'], 'passphrase': request['passphrase']}
            self.immutable(input_dir / 'request.json', self.P.canonical(worker_request))
            for name in ('capsule.orbis-tm', 'master-v1.key', 'request.json'):
                (input_dir / name).chmod(0o400)
            self.sync(input_dir)
            record['inputRequestSha256'] = sha(self.P.canonical(worker_request))
            record['inputSeals'] = {name: list(self.a.seal((input_dir / name).lstat()))
                                    for name in ('capsule.orbis-tm', 'master-v1.key')}
            self.save(record)
            self.require_destination(record)
            self.driver.stage(record, directory)
            if record.get('workerIntent') != 'complete' or not record.get('workerTerminal'):
                raise fail()
            review = self.checked_review(record)
            # This creates data only. Its original PGDATA is never promoted or
            # started, and its receipt grants no captured-image execution.
            record['resourceIntent'] = 'materializing'
            self.save(record)
            payload_dir = directory / 'work/payload'
            manifest = self.json(payload_dir / 'manifest.json')
            expected = {key: manifest[key] for key in ('pointId', 'sourceSha256', 'checkpointSha256', 'resourceCount', 'compatibility')}
            expected.update(images=record['checkpointReview']['roleImages'],
                            checkpoint={key: manifest['entries'][0][key] for key in ('bytes', 'sha256')})
            materializer = load('orbis-host-core-checkpoint-materialize.py', 'orbis_core_portable_resources_prepare')
            record['resources'] = materializer.materialize_checkpoint(payload_dir / 'checkpoint.tar', expected, directory / 'candidate', self.a)
            record['resourceIntent'] = 'complete'
            self.save(record)
            self.require_destination(record)
            if review['pointId'] in destination['catalog']:
                raise EnrollmentError('A point with this identifier already exists; no existing point was replaced')
            try:
                self.json(self.state / 'core-portable-points' / (review['pointId'] + '.json'), 2 * 1024 * 1024)
            except FileNotFoundError:
                pass
            else:
                raise EnrollmentError('Prior import authority must be explicitly retired before this point identifier can be reused')
            # Only after positive container settlement may its secret input be
            # retired. Ambiguous workers retain private custody for recovery.
            if self.digest(input_dir / 'request.json', 16384)['sha256'] != record['inputRequestSha256']:
                raise fail()
            (input_dir / 'request.json').unlink()
            self.sync(input_dir)
            prepared = {'schema': 'orbis.core-portable-review.v1', 'id': record['id'], 'actor': actor,
                        'destination': destination, 'review': review,
                        'checkpointReview': record['checkpointReview'],
                        'resources': record['resources'],
                        'workerTerminalSha256': sha(self.P.canonical(record['workerTerminal']))}
            self.immutable(directory / 'prepared.json', self.P.canonical(prepared))
            record.update(phase='awaiting-approval', review=review, reviewSha256=sha(self.P.canonical(prepared)),
                          approvalNonce=secrets.token_hex(32), approvalExpiresAt=int(time.time() * 1000) + 300000)
            self.save(record)
            return self.public(record)
        except BaseException as error:
            record.update(phase='recovery-required', failureClass=type(error).__name__)
            self.save(record)
            raise

    def public(self, record):
        value = {'version': 1, 'id': record['id'], 'phase': record['phase'], 'restoreSupported': False}
        if record['phase'] == 'awaiting-approval':
            value.update(reviewSha256=record['reviewSha256'], approvalNonce=record['approvalNonce'],
                         approvalExpiresAt=record['approvalExpiresAt'], pointId=record['review']['pointId'],
                         sourceOwnerId=record['review']['sourceOwnerId'], ownerId=record['actor']['ownerId'],
                         metadata=record['review']['metadata'])
        if record['phase'] == 'enrolled':
            value.update(pointId=record['review']['pointId'], provenanceSha256=record['provenanceSha256'], created=True)
        return value

    def approve(self, request, *, privileged_peer=False):
        fields = {'id', 'actor', 'reviewSha256', 'approvalNonce', 'action'}
        if (privileged_peer is not True or not self.P.exact(request, fields)
                or request['action'] != 'enroll-core-portable-point' or not matches(HEX, request['reviewSha256'])
                or not matches(HEX, request['approvalNonce'])):
            raise fail()
        actor = self.actor(request['actor'])
        record = self.record(request['id'])
        if (record['phase'] != 'awaiting-approval' or actor != record['actor']
                or request['reviewSha256'] != record['reviewSha256'] or request['approvalNonce'] != record['approvalNonce']
                or record['approvalExpiresAt'] <= int(time.time() * 1000)):
            raise fail()
        self.require_destination(record)
        if self.checked_review(record) != record['review']:
            raise fail()
        prepared = self.read(self.directory(record['id']) / 'prepared.json', 4 * 1024 * 1024)
        if sha(prepared) != record['reviewSha256']:
            raise fail()
        if record['approvalExpiresAt'] <= int(time.time() * 1000):
            raise fail()
        approval = {'schema': 'orbis.core-portable-approval.v1', 'request': request, 'approvedAt': int(time.time() * 1000)}
        self.immutable(self.directory(record['id']) / 'approved.json', self.P.canonical(approval))
        record.update(phase='publishing', approvalSha256=sha(self.P.canonical(approval)))
        record.pop('approvalNonce')
        self.save(record)
        return self.publish(record)

    def verify_publication(self, record, directory):
        expected = set(record['review']['files']) | {'portable-core-import.json'}
        with self.a.protected_directory(directory):
            if set(os.listdir(directory)) != expected:
                raise fail()
        for name, item in record['review']['files'].items():
            if self.digest(directory / name) != item:
                raise fail()
        marker = self.json(directory / 'portable-core-import.json', 4096)
        if marker != {'schema': 'orbis.core-portable-import.v1', 'id': record['id'], 'provenanceSha256': record['provenanceSha256']}:
            raise fail()

    def publish(self, record):
        directory = self.directory(record['id'])
        self.require_destination(record, allow_published=True)
        review = self.checked_review(record)
        if review != record['review'] or record.get('phase') != 'publishing':
            raise fail()
        if record['destination']['retainedBytes'] + sum(item['bytes'] for item in review['files'].values()) > LIMIT:
            raise fail()
        provenance = {'schema': 'orbis.core-portable-provenance.v1', 'id': record['id'],
                      'origin': 'authenticated-portable-import', 'root': str(self.root), 'context': self.context,
                      'actor': record['actor'], 'destination': record['destination'], 'review': review,
                      'checkpointReview': record['checkpointReview'],
                      'resources': record['resources'],
                      'reviewSha256': record['reviewSha256'], 'approvalSha256': record['approvalSha256'],
                      'workerTerminalSha256': sha(self.P.canonical(record['workerTerminal']))}
        provenance_sha = sha(self.P.canonical(provenance))
        self.immutable(directory / 'provenance.json', self.P.canonical(provenance))
        if record.get('provenanceSha256') not in {None, provenance_sha}:
            raise fail()
        record['provenanceSha256'] = provenance_sha
        self.save(record)
        library = Path(record['destination']['library'])
        destination = library / 'points' / review['pointId']
        stage_parent = self.child(library, 'portable-staging')
        stage = stage_parent / ('core-root-' + record['id'])
        if not destination.exists() and not destination.is_symlink():
            if not stage.exists() and not stage.is_symlink():
                stage.mkdir(mode=0o700)
                self.sync(stage_parent)
                record['publicationStage'] = str(stage)
                self.save(record)
                source = directory / 'work/library/backups/time-machine/points' / review['pointId']
                for name in review['files']:
                    self.runtime.copy_file(source / name, stage / name, LIMIT)
                self.immutable(stage / 'portable-core-import.json', self.P.canonical({
                    'schema': 'orbis.core-portable-import.v1', 'id': record['id'], 'provenanceSha256': provenance_sha}))
                self.sync(stage)
            if record.get('publicationStage') != str(stage):
                raise fail()
            self.verify_publication(record, stage)
            self.require_destination(record)
            space = os.statvfs(library)
            if space.f_bavail * space.f_frsize < 256 * 1024 * 1024:
                raise fail()
            rename_noreplace(stage, destination)
        # A crash after rename but before the authority receipt is reconciled
        # only against this operation's complete immutable generation.
        self.verify_publication(record, destination)
        self.require_destination(record, allow_published=True)
        receipt = {'schema': SCHEMA, 'id': record['id'], 'pointId': review['pointId'], 'ownerId': review['ownerId'],
                   'provenanceSha256': provenance_sha, 'files': review['files'], 'restoreSupported': False}
        self.immutable(directory / 'enrolled.json', self.P.canonical(receipt))
        index = self.child(self.state, 'core-portable-points')
        self.immutable(index / (review['pointId'] + '.json'), self.P.canonical(receipt))
        record['phase'] = 'enrolled'
        self.save(record)
        return self.public(record)

    def status(self, request, *, privileged_peer=False, reconcile=False):
        if privileged_peer is not True or not self.P.exact(request, {'id', 'actor'}):
            raise fail()
        record = self.record(request['id'])
        if self.actor(request['actor']) != record['actor']:
            raise fail()
        if reconcile and record['phase'] == 'publishing':
            return self.publish(record)
        if record['phase'] == 'enrolled':
            self.verify_publication(record, Path(record['destination']['library']) / 'points' / record['review']['pointId'])
        return self.public(record)
