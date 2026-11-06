"""Read protected capture receipts and stream approved bytes without lifecycle authority."""
import hashlib
import os
import stat
from contextlib import contextmanager
from pathlib import Path


CHUNK = 64 * 1024
SOURCE_FIELDS = {'sourceSha256', 'sourceHoldSha256'}
TRANSFER_FIELDS = SOURCE_FIELDS | {'captureReceiptSha256', 'checkpointArtifactSha256'}
STATES = {'reserved', 'launch-unsettled', 'running', 'recovery-required', 'resumed-awaiting-publication'}
EVENTS = ('claim.json', 'launch-intent.json', 'failure.json', 'settled.json')


class CaptureReaderError(ValueError):
    pass


class CheckpointReader:
    def __init__(self, descriptor, checkpoint, authority):
        self._descriptor, self._authority = descriptor, authority
        self.bytes, self.sha256 = checkpoint['bytes'], checkpoint['sha256']
        self.delivered_count, self._hash = 0, hashlib.sha256()
        self._failed, self._closed = False, False
        self._seal = authority.seal(os.fstat(descriptor))

    @property
    def delivered_sha256(self):
        return self._hash.hexdigest()

    def read(self, size):
        if self._closed or self._failed or type(size) is not int or not 1 <= size <= CHUNK:
            self._failed = True
            raise CaptureReaderError('A bounded active checkpoint read is required')
        try:
            if self._authority.seal(os.fstat(self._descriptor)) != self._seal:
                raise CaptureReaderError('The checkpoint changed during transfer')
            data = os.read(self._descriptor, min(size, self.bytes - self.delivered_count + 1))
            if self.delivered_count + len(data) > self.bytes:
                raise CaptureReaderError('The checkpoint exceeds its approval')
            if not data and self.delivered_count != self.bytes:
                raise CaptureReaderError('The checkpoint ended before its approval')
            self.delivered_count += len(data)
            self._hash.update(data)
            return data
        except BaseException:
            self._failed = True
            raise

    def complete(self):
        if (self._failed or self.delivered_count != self.bytes
                or self.delivered_sha256 != self.sha256 or os.read(self._descriptor, 1)):
            raise CaptureReaderError('The checkpoint transfer is incomplete or differs from approval')


class CoreCaptureReader:
    def __init__(self, worker, state_dir):
        # The caller's worker owns the HOST ContextVars used by its lease.
        self.worker, self.state = worker, Path(state_dir)

    def request(self, point, request, fields):
        self.worker.require_root()
        self.worker.identifier(point)
        if (not isinstance(request, dict) or set(request) != fields
                or any(not isinstance(value, str) or not self.worker.HASH.fullmatch(value)
                       for value in request.values())):
            raise CaptureReaderError('Invalid core capture read request')

    def source_hold(self, admission, request):
        hold, body = admission.read('source-hold.json')
        if (hold.get('schema') not in {'orbis.core-capture-source-hold.v1', 'orbis.core-capture-source-hold.v2'}
                or hold.get('id') != admission.point
                or hold.get('sourceSha256') != admission.request['sourceSha256']
                or self.worker.digest(body) != request['sourceHoldSha256']
                or request['sourceSha256'] != admission.request['sourceSha256']):
            raise CaptureReaderError('The approved capture source changed')

    def checked_status(self, admission, request):
        admission.unchanged()
        self.source_hold(admission, request)
        events = {name: admission.read(name, optional=True) for name in EVENTS}
        observed = self.worker.read_status(self.state, admission.point)
        if observed.get('id') != admission.point or observed.get('state') not in STATES:
            raise CaptureReaderError('Unknown core capture state')
        result = {'version': 1, 'id': admission.point, 'state': observed['state'], **request}
        if result['state'] == 'resumed-awaiting-publication':
            artifact = observed.get('artifact')
            if artifact is None:
                result['state'] = 'unsupported'
            else:
                settled, body = events['settled.json']
                artifact_hash = self.worker.digest(self.worker.P.canonical(artifact))
                if (settled is None or settled.get('checkpointArtifactSha256') != artifact_hash
                        or artifact.get('sourceSha256') != request['sourceSha256']):
                    raise CaptureReaderError('The checkpoint differs from its capture receipt')
                result['ready'] = {'captureReceiptSha256': self.worker.digest(body),
                                   'checkpointArtifactSha256': artifact_hash, 'artifact': artifact}
        if events != {name: admission.read(name, optional=True) for name in EVENTS}:
            raise CaptureReaderError('The capture state changed while reading')
        self.source_hold(admission, request)
        admission.unchanged()
        return result

    def status(self, point, request):
        self.request(point, request, SOURCE_FIELDS)
        admission = self.worker.Admission(self.state, point)
        return self.checked_status(admission, request)

    def metadata_seals(self, directory):
        authority = self.worker.A
        result = {}
        for parent, name in ((directory, 'job.json'), (directory / 'portable-checkpoint', 'artifact.json')):
            with authority.protected_directory(parent) as descriptor:
                details = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                self.private_file(details)
                result[name] = authority.seal(details)
        return result

    def private_file(self, details):
        if (not stat.S_ISREG(details.st_mode) or details.st_uid != self.worker.A.OWNER
                or details.st_nlink != 1 or stat.S_IMODE(details.st_mode) != 0o600):
            raise CaptureReaderError('The checkpoint authority is not a private regular file')

    @contextmanager
    def open_checkpoint(self, point, request):
        self.request(point, request, TRANSFER_FIELDS)
        source = {key: request[key] for key in SOURCE_FIELDS}
        admission = self.worker.Admission(self.state, point)
        directory = self.state / 'time-machine-core' / point
        approved = self.checked_status(admission, source)
        ready = approved.get('ready')
        if (ready is None or any(request[key] != ready[key]
                                 for key in ('captureReceiptSha256', 'checkpointArtifactSha256'))):
            raise CaptureReaderError('The checkpoint has no matching ready approval')
        seals = self.metadata_seals(directory)
        if self.checked_status(admission, source) != approved or self.metadata_seals(directory) != seals:
            raise CaptureReaderError('The checkpoint metadata changed')
        authority = self.worker.A
        with admission.lease.owner(), authority.protected_directory(directory), \
                authority.protected_directory(directory / 'portable-checkpoint') as parent:
            descriptor = os.open('checkpoint.tar', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            reader = None
            try:
                details = os.fstat(descriptor)
                self.private_file(details)
                checkpoint = ready['artifact']['checkpoint']
                if details.st_size != checkpoint['bytes']:
                    raise CaptureReaderError('The checkpoint size differs from approval')
                reader = CheckpointReader(descriptor, checkpoint, authority)

                def unchanged():
                    if any(authority.seal(value) != reader._seal for value in
                           (os.fstat(descriptor), os.stat('checkpoint.tar', dir_fd=parent, follow_symlinks=False))):
                        raise CaptureReaderError('The checkpoint path or bytes changed')
                    if self.metadata_seals(directory) != seals:
                        raise CaptureReaderError('The checkpoint metadata changed')

                unchanged()
                yield reader
                reader.complete()
                unchanged()
                if self.checked_status(admission, source) != approved:
                    raise CaptureReaderError('The approved capture changed during transfer')
                unchanged()
            finally:
                if reader is not None:
                    reader._closed = True
                os.close(descriptor)
