"""Read an independently published capture without granting lifecycle authority."""
import hashlib
import json
import os
import selectors
import subprocess
import threading
import time
from contextlib import contextmanager


FILES = {'point.json', 'metadata.orbis', 'core.orbis', 'capture-draft.orbis', 'wallpaper.orbis', 'icons.orbis'}
LIMITS = {'point.json': 32768, 'metadata.orbis': 524340, 'capture-draft.orbis': 524340,
          'core.orbis': 68719476736, 'wallpaper.orbis': 33554484, 'icons.orbis': 25165876}
EXPORT_CAPABILITY = {
    'schema': 'orbis-sentinel.capture-export-capability.v1', 'version': 1,
    'operations': ['export-file'], 'pointVersion': 3,
    'files': sorted(FILES), 'verification': 'delivered-sha256-and-file-seals.v1', 'lifecycleAuthority': False,
}
CAPABILITY = {
    'schema': 'orbis.core-capture-sentinel-reader.v1', 'version': 1,
    'operations': ['sentinel-publication', 'sentinel-file'], 'pointVersion': 3,
    'lifecycleAuthority': False,
}
SOURCE_FIELDS = {'sourceSha256', 'sourceHoldSha256'}


class PublicationReadError(ValueError):
    pass


class ExportStream:
    """Withhold the final chunk until the exporter and root rechecks succeed."""
    def __init__(self, bridge, profile, request, info, recheck):
        self.bytes, self.sha256 = info['bytes'], info['sha256']
        self._received = self._delivered = 0
        self._digest, self._done, self._closed = hashlib.sha256(), False, False
        self._failed = False
        self._pending = b''
        self._recheck = recheck
        self._deadline = time.monotonic() + 4 * 60 * 60
        self._error, self._overflow = bytearray(), False
        launcher = bridge._bundle(profile)
        body = json.dumps(request, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()
        if len(body) > 8192:
            raise PublicationReadError('Invalid published capture request')
        self._child = subprocess.Popen(['/usr/bin/python3', '-I', '-B', str(launcher), '--export-file'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True,
            env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'HOME': '/'})
        def drain():
            while block := self._child.stderr.read(4096):
                remaining = max(0, 8192 - len(self._error))
                self._error.extend(block[:remaining])
                if len(block) > remaining:
                    self._overflow = True
        self._thread = threading.Thread(target=drain)
        self._thread.start()
        try:
            self._child.stdin.write(body)
            self._child.stdin.close()
        except BaseException:
            self.close()
            raise

    def _read(self, size):
        remaining = self._deadline - time.monotonic()
        if remaining <= 0:
            raise PublicationReadError('Published capture transfer timed out')
        with selectors.DefaultSelector() as selector:
            selector.register(self._child.stdout, selectors.EVENT_READ)
            if not selector.select(min(30, remaining)):
                raise PublicationReadError('Published capture stream stopped responding')
        return os.read(self._child.stdout.fileno(), size)

    def read(self, size):
        try:
            if self._failed:
                raise PublicationReadError('The published file transfer already failed')
            return self._next(size)
        except BaseException:
            self._failed = True
            raise

    def _next(self, size):
        if self._closed or type(size) is not int or not 1 <= size <= 65536:
            raise PublicationReadError('A bounded active publication read is required')
        if self._done:
            body, self._pending = self._pending[:size], self._pending[size:]
            self._delivered += len(body)
            return body
        remaining = self.bytes - self._received
        final = remaining <= 65536
        wanted = remaining if final else min(size, remaining - 65536)
        pieces = []
        while wanted:
            block = self._read(wanted)
            if not block:
                raise PublicationReadError('The published file ended early')
            self._received += len(block)
            self._digest.update(block)
            pieces.append(block)
            wanted -= len(block)
            if not final:
                break
        if final:
            if self._read(1) or self._digest.hexdigest() != self.sha256:
                raise PublicationReadError('The published file differs from its approval')
            code = self._child.wait(timeout=min(30, max(0.01, self._deadline - time.monotonic())))
            self._thread.join(timeout=30)
            if code != 0 or self._thread.is_alive() or self._overflow or self._error:
                raise PublicationReadError('The published file could not be verified')
            self._recheck()
            self._done = True
        body = b''.join(pieces)
        body, self._pending = body[:size], body[size:]
        self._delivered += len(body)
        return body

    def complete(self):
        if self._failed or not self._done or self._received != self.bytes or self._delivered != self.bytes:
            raise PublicationReadError('The published file transfer is incomplete')

    def close(self):
        if self._closed:
            return
        self._closed = True
        if self._child.poll() is None:
            self._child.kill()
        self._child.wait()
        self._thread.join(timeout=30)
        for stream in (self._child.stdin, self._child.stdout, self._child.stderr):
            stream.close()


class SentinelPublicationReader:
    def __init__(self, manager, worker):
        self.manager, self.W = manager, worker
        completion = worker.load('orbis-host-core-capture-completion.py', 'sentinel_reader_completion')
        self.completion = completion.CoreCaptureCompletion(manager, worker)

    def request(self, point, request, *, transfer=False):
        self.W.require_root()
        self.W.identifier(point)
        fields = SOURCE_FIELDS | ({'receiptSha256', 'publicationSha256', 'fileName'} if transfer else set())
        if (not isinstance(request, dict) or set(request) != fields
                or any(not isinstance(value, str) or not self.W.HASH.fullmatch(value)
                       for key, value in request.items() if key != 'fileName')
                or transfer and (not isinstance(request['fileName'], str) or request['fileName'] not in FILES)):
            raise PublicationReadError('Invalid published capture read request')

    def checked(self, admission, source):
        W, manager = self.W, self.manager
        if admission.root != manager.root or admission.state != manager.state or admission.context != manager.context:
            raise PublicationReadError('The published capture belongs to another installation')
        preparation, reservation, acceptance, hold = self.completion.bound_preparation(admission)
        if source != {'sourceSha256': preparation['sourceSha256'], 'sourceHoldSha256': W.digest(hold)}:
            raise PublicationReadError('The published capture source changed')
        mode = manager.sentinel.publication_mode(admission.point, preparation)
        result = {'version': 1, 'id': admission.point, 'publisher': mode, **source}
        if mode == 'controller-restart.v1':
            if admission.read('sentinel-publication.json', optional=True)[0] is not None:
                raise PublicationReadError('The capture has conflicting publishers')
            return {**result, 'state': 'controller-publication'}
        profile = manager.sentinel.require_publication_reserved(admission.point, preparation)
        proof, body = admission.read('sentinel-publication.json', optional=True)
        automatic = self.completion.automatic_publication_state(admission, profile, body)
        if automatic not in (None, 'verified'):
            return {**result, 'state': automatic}
        if proof is None:
            return {**result, 'state': 'awaiting-publication'}
        terminal = W.SUPERVISOR.read_terminal(admission, worker=W.worker_context())
        terminal_body = admission.read('worker-terminal.json')[1]
        status = W.read_status(manager.state, admission.point)
        value = proof.get('publication')
        if (not isinstance(terminal, dict) or terminal.get('state') != 'quiescent'
                or terminal.get('workerQuiescent') is not True or type(terminal.get('workerExitCode')) is not int
                or terminal['workerExitCode'] != 0 or status.get('state') != 'resumed-awaiting-publication'
                or not isinstance(status.get('artifact'), dict) or not isinstance(value, dict)
                or set(value) != {'schema', 'id', 'dataState', 'lifecycleState', 'preparationSha256',
                                  'sourceHoldSha256', 'terminalSha256', 'publication'}
                or value['schema'] != 'orbis-sentinel.prepared-publication.v1' or value['id'] != admission.point
                or value['dataState'] != 'verified' or value['lifecycleState'] != 'unobserved'
                or value['preparationSha256'] != acceptance['preparationSha256']
                or value['sourceHoldSha256'] != source['sourceHoldSha256']
                or value['terminalSha256'] != W.digest(terminal_body)
                or W.P.canonical(proof) != W.P.canonical(admission.event('sentinel-publication',
                    publication=value, profileSha256=W.digest(W.P.canonical(profile))))):
            raise PublicationReadError('The independent publication authority changed')
        artifact = status['artifact']
        expected = {'pointId': admission.point, 'sourceSha256': source['sourceSha256'],
                    'checkpointSha256': artifact['checkpointSha256'],
                    'captureReceiptSha256': W.digest(admission.read('settled.json')[1]),
                    'checkpoint': artifact['checkpoint'], 'resourceCount': artifact['resourceCount'],
                    'images': artifact['roleImageIds'], 'compatibility': artifact['compatibility']}
        publication = value['publication']
        if (not isinstance(publication, dict) or set(publication) != {'schema', 'core', 'keyId', 'files'}
                or publication['schema'] != 'orbis.core-capture-catalog-publication.v1'
                or publication['keyId'] != reservation['envelope']['keyId']):
            raise PublicationReadError('The independent publication inventory changed')
        core = self.completion.validate_publication(admission, publication['core'], expected, reservation)
        files = publication['files']
        if (not isinstance(files, dict) or not {'point.json', 'core.orbis', 'metadata.orbis', 'capture-draft.orbis'} <= set(files) <= FILES
                or any(not isinstance(item, dict) or set(item) != {'bytes', 'sha256'}
                       or type(item['bytes']) is not int or not 1 <= item['bytes'] <= LIMITS[name]
                       or not isinstance(item['sha256'], str) or not W.HASH.fullmatch(item['sha256']) for name, item in files.items())
                or files['point.json']['sha256'] != core['pointSha256']
                or files['metadata.orbis']['sha256'] != core['metadataSha256']
                or files['core.orbis'] != {'bytes': core['cipherBytes'], 'sha256': core['cipherSha256']}):
            raise PublicationReadError('The independent publication file inventory changed')
        admission.unchanged()
        return {**result, 'state': 'verified', 'receiptSha256': W.digest(body),
                'publicationSha256': W.digest(W.P.canonical(publication)),
                'preparationSha256': value['preparationSha256'], 'terminalSha256': value['terminalSha256'],
                'pointReservationSha256': preparation['pointReservationSha256'],
                'publication': publication, 'expectation': expected}

    def status(self, point, request):
        self.request(point, request)
        admission = self.W.Admission(self.manager.state, point)
        with admission.lease.owner():
            before = self.checked(admission, request)
            if self.checked(admission, request) != before:
                raise PublicationReadError('The publication changed while reading')
            return before

    @contextmanager
    def open_file(self, point, request):
        self.request(point, request, transfer=True)
        source = {key: request[key] for key in SOURCE_FIELDS}
        admission = self.W.Admission(self.manager.state, point)
        with admission.lease.owner():
            approved = self.checked(admission, source)
            if (approved['state'] != 'verified' or any(request[key] != approved[key]
                    for key in ('receiptSha256', 'publicationSha256'))
                    or request['fileName'] not in approved['publication']['files']):
                raise PublicationReadError('The publication has no matching transfer approval')
            profile = self.manager.sentinel.require_publication_reserved(point,
                self.completion.bound_preparation(admission)[0])
            if self.W.P.canonical(self.manager.sentinel._invoke(profile, 'export-capability')) != self.W.P.canonical(EXPORT_CAPABILITY):
                raise PublicationReadError('The enrolled Sentinel cannot export this capture')
            payload = {'schema': 'orbis-sentinel.capture-export-file.v1', 'catalogDirectory': profile['catalogDirectory'],
                       'pointId': point, 'fileName': request['fileName'],
                       **{key: approved[key] for key in ('publicationSha256', 'preparationSha256', 'sourceHoldSha256', 'terminalSha256')}}
            def unchanged():
                self.manager.sentinel._bundle(profile)
                if (self.checked(admission, source) != approved
                        or self.manager.sentinel.require_publication_reserved(point,
                            self.completion.bound_preparation(admission)[0]) != profile):
                    raise PublicationReadError('The publication changed during transfer')
            reader = ExportStream(self.manager.sentinel, profile, payload,
                                  approved['publication']['files'][request['fileName']], unchanged)
            try:
                yield reader
                reader.complete()
            finally:
                reader.close()
