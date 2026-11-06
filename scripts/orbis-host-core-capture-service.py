"""Root admission for independently supervised core captures.

Only the authenticated backend's retained source drain may produce its marker.
This module verifies that marker in the current enrolled controller namespace;
request fields cannot substitute for it. The Unix service restricts callers to
its trusted root peer. There is no admission replay or release API.
"""
import copy
import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace


SPEC = importlib.util.spec_from_file_location('orbis_core_admission_worker', Path(__file__).with_name('orbis-host-core-capture-worker.py'))
W = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(W)
SPEC = importlib.util.spec_from_file_location('orbis_core_admission_reservation', Path(__file__).with_name('orbis-host-core-capture-reservation.py'))
R = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(R)
COMPLETION = W.load('orbis-host-core-capture-completion.py', 'core_admission_completion_contract')
NAMESPACE = W.load('orbis-host-core-capture-namespace.py', 'core_admission_namespace')
SENTINEL = W.load('orbis-host-sentinel-capture.py', 'core_admission_sentinel')
SENTINEL_RECOVERY_CAPABILITY = {
    'schema': 'orbis.core-capture-sentinel-recovery-capability.v1', 'version': 1,
    'pointVersion': 3, 'sourceHoldVersion': 2, 'publisher': 'sentinel.v1',
    'publisherRecordVersion': 1, 'operations': ['download', 'adopt', 'continue'], 'lifecycleAuthority': False,
}
C, H, A, P = W.CORE, W.CORE.HOST, W.A, W.P
QUEUES = {'app-events-queue', 'repo-queue', 'system-events-queue'}

# Read a fixed path in the pinned controller's mount namespace, not a guessed
# host path beneath potentially user-owned installation ancestors.
SOURCE_HOLD_READER = r"""
const fs=require('node:fs');
const dirs=['/data','/data/backups','/data/backups/time-machine','/data/backups/time-machine/core-capture'];
const target=dirs.at(-1)+'/source-hold.json';
const keys=['dev','ino','uid','gid','mode'];
const sealKeys=[...keys,'nlink','size','mtimeNs','ctimeNs'];
const seal=(s,k)=>k.map(n=>String(s[n])).join(':');
const directory=p=>{const s=fs.lstatSync(p,{bigint:true});
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0n||(s.mode&0o022n)!==0n||fs.realpathSync(p)!==p)throw Error('directory');
 return s;};
const before=dirs.map(directory);
if((before.at(-1).mode&0o077n)!==0n)throw Error('private');
const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
try{
 const s=fs.fstatSync(fd,{bigint:true});
 if(!s.isFile()||s.uid!==0n||s.nlink!==1n||(s.mode&0o777n)!==0o600n||s.size<1n||s.size>65536n)throw Error('file');
 const b=Buffer.alloc(Number(s.size)+1);let count=0;
 while(count<b.length){const n=fs.readSync(fd,b,count,b.length-count,null);if(!n)break;count+=n;}
 if(BigInt(count)!==s.size||seal(s,sealKeys)!==seal(fs.fstatSync(fd,{bigint:true}),sealKeys)||
    seal(s,sealKeys)!==seal(fs.lstatSync(target,{bigint:true}),sealKeys))throw Error('changed');
 dirs.forEach((p,i)=>{if(seal(before[i],keys)!==seal(directory(p),keys))throw Error('changed');});
 process.stdout.write(b.subarray(0,count));
}finally{fs.closeSync(fd);}
"""


def create(directory, name, value):
    if name not in {'preparation.json', 'preparation-intent.json', 'point-reservation.json', 'source-hold.json', 'handoff.json', 'request.json', 'acceptance.json'}:
        raise W.AdmissionError('Unknown capture authority record')
    if name == 'preparation-intent.json' or name == 'preparation.json' and value.get('schema') == W.RESERVED.SCHEMA:
        return W.RESERVED.create_atomic(W, directory, name, value)
    with A.protected_directory(directory) as checked:
        expected = W.identity(os.fstat(checked))
        parent = os.dup(checked)
    try:
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            with os.fdopen(descriptor, 'wb', closefd=False) as output:
                output.write(P.canonical(value))
                output.flush()
                os.fsync(descriptor)
            os.fsync(parent)
        finally:
            os.close(descriptor)
        with A.protected_directory(directory) as checked:
            if W.identity(os.fstat(checked)) != expected:
                raise W.AdmissionError('Capture admission directory changed')
    finally:
        os.close(parent)


class CoreCaptureService:
    def __init__(self, service):
        self.service = service
        self.root, self.state, self.context = Path(service.root), Path(service.state_dir), service.context
        self.capture = C.CoreCapture(SimpleNamespace(root=self.root, state_dir=self.state,
                        snapshots=service.snapshots, context=self.context,
                        current_manifest=lambda: W.SERVICE.installed_manifest(self.root, self.context)))
        self.preparations = self.state / 'core-capture-preparations'
        self.capture.child(self.preparations)
        self.sentinel = SENTINEL.SentinelCaptureCustody(self, W, NAMESPACE)

    def directory(self, point):
        return self.preparations / W.identifier(point)

    def read(self, directory, name):
        with A.protected_directory(directory) as descriptor:
            with A.protected_file(descriptor, name, 65536) as body:
                value = P.metadata(body, byte_limit=65536)
                if not isinstance(value, dict) or P.canonical(value) != body:
                    raise W.AdmissionError('Invalid protected capture record')
                return value, body

    def observe(self, reader):
        source = self.capture.source()
        _, installation = C.TX.APPS.selected_installation(reader, self.root)
        identifier = installation['container']['id']
        original = self.capture.observation(reader, identifier)
        C.TX.require_healthy(reader, identifier)
        if original['state'] != 'running':
            raise W.AdmissionError('The source controller is not running')
        return {'sourceSha256': C.TX.APPS.digest(source), 'controller': {
                    'id': identifier, 'imageId': original['imageId'], 'startedAt': original['startedAt'],
                    'definitionSha256': C.TX.APPS.digest(original['definition'])}}

    def public_preparation(self, record):
        result = {'version': 1, 'id': record['id'], 'preparationSha256': W.digest(P.canonical(record)),
                  'sourceSha256': record['sourceSha256'], 'controller': copy.deepcopy(record['controller'])}
        if record['schema'] in {'orbis.core-capture-preparation.v2', W.RESERVED.SCHEMA}:
            result.update(version=3 if record['schema'] == W.RESERVED.SCHEMA else 2,
                          pointReservationSha256=record['pointReservationSha256'])
        return result

    def prepare(self, point):
        W.require_root()
        directory = self.directory(point)
        with self.service.lock:
            self.service.require_idle_core()
            with H.host_lock(self.root) as descriptor:
                reader = C.TX.APPS.Docker(self.context)
                reader.lock_fd = descriptor
                observed = self.observe(reader)
                if directory.exists() or directory.is_symlink():
                    record, _ = self.read(directory, 'preparation.json')
                    if record != self.preparation(point, observed):
                        raise W.AdmissionError('The prepared source changed')
                    return self.public_preparation(record)
                self.capture.child(directory)
                review = C.TX.review(self.root, reader, self.capture.snapshots / ('orbis-time-machine-core-' + point),
                                     directory / 'checkpoint-review.json', scope=C.SCOPE)
                if len(review['roles']) != 3 or set(review['roles'].values()) != {'controller', 'database', 'queue'}:
                    raise W.AdmissionError('Only the three core writers may be captured')
                if self.observe(reader) != observed:
                    raise W.AdmissionError('The source changed during capture preparation')
                record = self.preparation(point, observed)
                create(directory, 'preparation.json', record)
                return self.public_preparation(record)

    def preparation(self, point, observed):
        return {'schema': 'orbis.core-capture-preparation.v1', 'id': point,
                'root': str(self.root), 'context': self.context, 'scope': C.SCOPE, **observed}

    def controller_reservation(self, controller, point):
        W.identifier(point)
        runtime = SimpleNamespace(host=H, root=self.root)
        body = C.D.DockerRestoreRuntime.bounded_output(runtime,
            ['docker', '--context', self.context, 'exec', controller['id'], '/usr/local/bin/node', '-e', R.POINT_READER, point],
            R.LIMIT, 10)
        return R.reservation(body, point)

    def require_publication_capability(self, controller):
        runtime = SimpleNamespace(host=H, root=self.root)
        body = C.D.DockerRestoreRuntime.bounded_output(runtime,
            ['docker', '--context', self.context, 'exec', controller['id'], '/usr/local/bin/node',
             '/app/core-capture-publication.mjs', '--capability'], 8192, 10)
        if P.canonical(P.metadata(body, byte_limit=8192)) != P.canonical(COMPLETION.CAPABILITY):
            raise W.AdmissionError('This controller does not support independent core publication verification')

    def require_sentinel_recovery_capability(self, controller):
        runtime = SimpleNamespace(host=H, root=self.root)
        body = C.D.DockerRestoreRuntime.bounded_output(runtime,
            ['docker', '--context', self.context, 'exec', controller['id'], '/usr/local/bin/node',
             '/app/core-capture-publication.mjs', '--sentinel-recovery-capability'], 8192, 10)
        if P.canonical(P.metadata(body, byte_limit=8192)) != P.canonical(SENTINEL_RECOVERY_CAPABILITY):
            raise W.AdmissionError('This Orbis version cannot resume a Sentinel capture')

    def require_namespace_access(self, controller, point):
        descriptor = H.LOCK_DESCRIPTOR.get()
        if descriptor is None:
            raise W.AdmissionError('Capture namespace preflight requires the installation lock')
        reader = C.TX.APPS.Docker(self.context)
        reader.lock_fd = descriptor
        with NAMESPACE.CaptureNamespace(W, reader, controller) as namespace:
            namespace.verify_storage_root(point)
        path = H.capture_fence_path(self.root)
        with A.protected_directory(path.parent, private=False) as checked:
            expected = W.identity(os.fstat(checked))
            parent = os.dup(checked)
        try:
            NAMESPACE.probe_retirement(W, parent, point)
            with A.protected_directory(path.parent, private=False) as checked:
                if W.identity(os.fstat(checked)) != expected:
                    raise W.AdmissionError('The capture authority parent changed during preflight')
        finally:
            os.close(parent)

    def bound_preparation(self, point, observed, reservation):
        return {**self.preparation(point, observed), 'schema': 'orbis.core-capture-preparation.v2',
                'pointReservationSha256': R.sha256(reservation)}

    def require_bound_source(self, reader, point, preparation):
        observed = self.observe(reader)
        reservation = self.controller_reservation(observed['controller'], point)
        retained, body = self.read(self.directory(point), 'point-reservation.json')
        R.validate_reservation(retained, point)
        if (retained != reservation or R.canonical(reservation) != body
                or self.bound_preparation(point, observed, reservation) != preparation
                or self.observe(reader) != observed):
            raise W.AdmissionError('The saved-point reservation or source changed')

    def prepare_bound(self, point, *, publication='controller-restart.v1'):
        W.require_root()
        if publication not in {'controller-restart.v1', 'sentinel.v1'}:
            raise W.AdmissionError('Unknown capture publisher')
        directory = self.directory(point)
        with self.service.lock:
            self.service.require_idle_core()
            with H.host_lock(self.root) as descriptor:
                reader = C.TX.APPS.Docker(self.context)
                reader.lock_fd = descriptor
                observed = self.observe(reader)
                self.require_publication_capability(observed['controller'])
                if publication == 'sentinel.v1':
                    self.require_sentinel_recovery_capability(observed['controller'])
                self.require_namespace_access(observed['controller'], point)
                reservation = self.controller_reservation(observed['controller'], point)
                record = self.bound_preparation(point, observed, reservation)
                if directory.exists() or directory.is_symlink():
                    existing, _ = self.read(directory, 'preparation.json')
                    if existing != record:
                        raise W.AdmissionError('The prepared saved point or source changed')
                    self.require_bound_source(reader, point, existing)
                    self.sentinel.require_reserved(point, existing)
                    if self.sentinel.publication_mode(point, existing) != publication:
                        raise W.AdmissionError('The capture publisher was already selected')
                    return self.public_preparation(existing)
                if publication == 'sentinel.v1':
                    self.sentinel.preflight_publication()
                self.capture.child(directory)
                review = C.TX.review(self.root, reader, self.capture.snapshots / ('orbis-time-machine-core-' + point),
                                     directory / 'checkpoint-review.json', scope=C.SCOPE)
                if len(review['roles']) != 3 or set(review['roles'].values()) != {'controller', 'database', 'queue'}:
                    raise W.AdmissionError('Only the three core writers may be captured')
                if (self.observe(reader) != observed
                        or self.controller_reservation(observed['controller'], point) != reservation
                        or self.observe(reader) != observed):
                    raise W.AdmissionError('The saved-point reservation or source changed during preparation')
                create(directory, 'point-reservation.json', reservation)
                if publication == 'sentinel.v1':
                    self.sentinel.reserve(reader, point, observed, reservation, for_publication=True)
                else:
                    self.sentinel.reserve(reader, point, observed, reservation)
                create(directory, 'preparation.json', record)
                self.require_bound_source(reader, point, record)
                return self.public_preparation(record)

    def controller_marker(self, controller):
        runtime = SimpleNamespace(host=H, root=self.root)
        return C.D.DockerRestoreRuntime.bounded_output(runtime,
            ['docker', '--context', self.context, 'exec', controller['id'], '/usr/local/bin/node', '-e', SOURCE_HOLD_READER],
            65536, 10)

    def prepare_reserved(self, point, *, publication='controller-restart.v1'):
        """Preparation v3 owns durable exclusion before source draining begins."""
        W.require_root()
        if publication not in {'controller-restart.v1', 'sentinel.v1'}:
            raise W.AdmissionError('Unknown capture publisher')
        directory = self.directory(point)
        with self.service.lock:
            self.service.require_idle_core()
            with H.host_lock(self.root) as descriptor:
                if directory.exists() or directory.is_symlink():
                    raise W.AdmissionError('This preparation identity is already consumed')
                if any(path.exists() or path.is_symlink() for path in
                       (self.state / 'core-capture-admissions' / point, self.capture.base / point)):
                    raise W.AdmissionError('This capture identity already has operation authority')
                reader = C.TX.APPS.Docker(self.context)
                reader.lock_fd = descriptor
                observed = self.observe(reader)
                self.require_publication_capability(observed['controller'])
                if publication == 'sentinel.v1':
                    self.require_sentinel_recovery_capability(observed['controller'])
                self.require_namespace_access(observed['controller'], point)
                reservation = self.controller_reservation(observed['controller'], point)
                if publication == 'sentinel.v1':
                    self.sentinel.preflight_publication()
                self.capture.child(directory)
                review = C.TX.review(self.root, reader, self.capture.snapshots / ('orbis-time-machine-core-' + point),
                                     directory / 'checkpoint-review.json', scope=C.SCOPE)
                if len(review['roles']) != 3 or set(review['roles'].values()) != {'controller', 'database', 'queue'}:
                    raise W.AdmissionError('Only the three core writers may be captured')
                if (self.observe(reader) != observed
                        or self.controller_reservation(observed['controller'], point) != reservation
                        or self.observe(reader) != observed):
                    raise W.AdmissionError('The saved-point reservation or source changed during preparation')
                create(directory, 'point-reservation.json', reservation)
                if publication == 'sentinel.v1':
                    self.sentinel.reserve(reader, point, observed, reservation, for_publication=True)
                else:
                    self.sentinel.reserve(reader, point, observed, reservation)
                grant = W.LEASE.CoreCaptureLease.grant(H, self.root, self.context, point, observed['sourceSha256'])
                path = H.capture_fence_path(self.root)
                stage = path.with_name(W.LEASE.CoreCaptureLease.staging_name(point))
                W.RESERVED.create_atomic(W, stage.parent, stage.name, grant, private=False)
                with A.protected_directory(path.parent, private=False) as parent:
                    parent_identity = list(W.identity(os.fstat(parent)))
                    with A.protected_file(parent, stage.name, 8192) as body:
                        if body != P.canonical(grant):
                            raise W.AdmissionError('The staged preparation lease changed')
                        pinned = W.RESERVED.lease_identity(os.stat(stage.name, dir_fd=parent, follow_symlinks=False))
                create(directory, 'preparation-intent.json', {
                    'schema': W.RESERVED.INTENT, 'preparation': self.bound_preparation(point, observed, reservation),
                    'grant': grant, 'leaseIdentity': pinned, 'parentIdentity': parent_identity,
                    'reviewSha256': W.digest(P.canonical(C.TX.semantic_review(review)))})
                intent = W.RESERVED.PreparationIntent(W, self.state, self.root, self.context, point)
                return self.finish_reserved_preparation(reader, point, intent)

    def finish_reserved_preparation(self, reader, point, intent):
        W.LEASE.CoreCaptureLease.require_installation_lock(H, self.root)

        def original():
            intent.selection()
            if any(path.exists() or path.is_symlink() for path in
                   (intent.directory / 'decision.json', self.state / 'core-capture-admissions' / point,
                    self.capture.base / point)):
                raise W.AdmissionError('The preparation already has operation authority')
            observed = self.observe(reader)
            reservation = self.controller_reservation(observed['controller'], point)
            retained, body = intent.read('point-reservation.json')
            R.validate_reservation(retained, point)
            if (retained != reservation or body != R.canonical(reservation)
                    or self.bound_preparation(point, observed, reservation) != intent.preparation
                    or self.observe(reader) != observed):
                raise W.AdmissionError('The preparation intent original source changed')
            self.require_publication_capability(observed['controller'])
            self.require_namespace_access(observed['controller'], point)
            self.sentinel.require_reserved(point, intent.preparation)
            review = C.TX.review(self.root, reader, self.capture.snapshots / ('orbis-time-machine-core-' + point),
                                intent.directory / 'checkpoint-review.json', scope=C.SCOPE)
            if (len(review['roles']) != 3 or set(review['roles'].values()) != {'controller', 'database', 'queue'}
                    or W.digest(P.canonical(C.TX.semantic_review(review))) != intent.value['reviewSha256']):
                raise W.AdmissionError('The preparation intent storage or writers changed')
            if (self.observe(reader) != observed
                    or self.controller_reservation(observed['controller'], point) != reservation):
                raise W.AdmissionError('The preparation intent source changed during review')
            intent.selection()

        original()
        intent.sync_existing()
        lease = intent.publish()
        with lease.owner():
            original()
            record = {**intent.preparation, 'schema': W.RESERVED.SCHEMA, 'leaseNonce': intent.grant['nonce'],
                      'leaseSha256': W.digest(lease.proof[0]),
                      'leaseIdentity': dict(zip(W.RESERVED.IDENTITY_NAMES, lease.proof[1]))}
            path = intent.directory / 'preparation.json'
            if path.exists() or path.is_symlink():
                if self.read(intent.directory, path.name) != (record, P.canonical(record)):
                    raise W.AdmissionError('The completed preparation differs from its original intent')
            else:
                create(intent.directory, path.name, record)
            authority = W.RESERVED.ReservedPreparation(W, self.state, self.root, self.context, point)
            self.require_reserved_source(reader, point, authority)
            authority.sync_existing()
            original()
            self.require_reserved_source(reader, point, authority)
            return self.public_preparation(record)

    def reconcile_reserved(self, point, request):
        """Explicitly finish an intent-bound preparation, without replaying a capture."""
        W.require_root()
        W.identifier(point)
        if (not isinstance(request, dict) or set(request) != {'pointReservationSha256'}
                or not isinstance(request['pointReservationSha256'], str)
                or not W.HASH.fullmatch(request['pointReservationSha256'])):
            raise W.AdmissionError('Invalid preparation reconciliation')
        with self.service.lock:
            self.service.require_idle_core()
            intent = W.RESERVED.PreparationIntent(W, self.state, self.root, self.context, point)
            if request['pointReservationSha256'] != intent.preparation['pointReservationSha256']:
                raise W.AdmissionError('The reconciliation saved point changed')
            with intent.owner(), H.host_lock(self.root) as descriptor:
                reader = C.TX.APPS.Docker(self.context)
                reader.lock_fd = descriptor
                return self.finish_reserved_preparation(reader, point, intent)

    def observe_reserved(self, point, request):
        """Recover a complete lost preparation reply without repeating reservation."""
        W.require_root()
        W.identifier(point)
        if (not isinstance(request, dict) or set(request) != {'pointReservationSha256'}
                or not isinstance(request['pointReservationSha256'], str)
                or not W.HASH.fullmatch(request['pointReservationSha256'])):
            raise W.AdmissionError('Invalid reserved preparation observation')
        with self.service.lock:
            self.service.require_idle_core()
            authority = W.RESERVED.ReservedPreparation(W, self.state, self.root, self.context, point)
            if request['pointReservationSha256'] != authority.preparation['pointReservationSha256']:
                raise W.AdmissionError('The observed saved point differs from its reservation')
            with authority.lease().owner(), H.host_lock(self.root) as descriptor:
                authority.require_undecided()
                if any(path.exists() or path.is_symlink() for path in
                       (self.state / 'core-capture-admissions' / point, self.capture.base / point)):
                    raise W.AdmissionError('The reserved capture already has operation authority')
                reader = C.TX.APPS.Docker(self.context)
                reader.lock_fd = descriptor
                self.require_reserved_source(reader, point, authority)
                authority.sync_existing()
                self.require_reserved_source(reader, point, authority)
                authority.require_undecided()
                return self.public_preparation(authority.preparation)

    def require_reserved_source(self, reader, point, authority):
        authority.lease()
        preparation = authority.preparation
        observed = self.observe(reader)
        reservation = self.controller_reservation(observed['controller'], point)
        retained, body = authority.read('point-reservation.json')
        R.validate_reservation(retained, point)
        expected = {key: value for key, value in preparation.items() if key not in W.RESERVED.EXTRA}
        expected['schema'] = 'orbis.core-capture-preparation.v2'
        if (retained != reservation or R.canonical(retained) != body
                or R.sha256(retained) != preparation['pointReservationSha256']
                or self.bound_preparation(point, observed, reservation) != expected
                or self.observe(reader) != observed):
            raise W.AdmissionError('The reserved saved point or original source changed')
        authority.lease()

    def abort_reserved(self, point, request):
        """Commit denial of admission; retain both root and source exclusion."""
        W.require_root()
        W.identifier(point)
        if (not isinstance(request, dict) or set(request) != {'preparationSha256'}
                or not isinstance(request['preparationSha256'], str) or not W.HASH.fullmatch(request['preparationSha256'])):
            raise W.AdmissionError('Invalid reserved capture abort intent')
        with self.service.lock:
            self.service.require_idle_core()
            authority = W.RESERVED.ReservedPreparation(W, self.state, self.root, self.context, point)
            if request['preparationSha256'] != authority.preparation_sha256:
                raise W.AdmissionError('The reserved abort preparation changed')
            with authority.lease().owner(), H.host_lock(self.root):
                decision, body = authority.decide('abort')
            return {'version': 1, 'id': point, 'state': 'abort-intent',
                    'preparationSha256': authority.preparation_sha256, 'decisionSha256': W.digest(body)}

    def _admit_reserved(self, point, request):
        # The caller retains the service lock and unchanged idle-core guard.
        authority = W.RESERVED.ReservedPreparation(W, self.state, self.root, self.context, point)
        if request['preparationSha256'] != authority.preparation_sha256:
            raise W.AdmissionError('The reserved admission preparation changed')
        lease = authority.lease()
        with lease.owner() as grant, H.host_lock(self.root) as descriptor:
            authority.require_undecided()
            reader = C.TX.APPS.Docker(self.context)
            reader.lock_fd = descriptor
            self.require_reserved_source(reader, point, authority)
            marker = self.controller_marker(authority.preparation['controller'])
            if W.digest(marker) != request['sourceHoldSha256']:
                raise W.AdmissionError('The reserved source maintenance marker changed')
            hold = self.source_hold(marker, authority.preparation)
            self.require_reserved_source(reader, point, authority)
            if self.sentinel.retain_draft(reader, point, authority.preparation, request['sourceHoldSha256']):
                self.require_reserved_source(reader, point, authority)
                if self.controller_marker(authority.preparation['controller']) != marker:
                    raise W.AdmissionError('The source marker changed during Sentinel custody transfer')
            decision, decision_body = authority.decide('admit', request['sourceHoldSha256'])
            base = self.state / 'core-capture-admissions'
            self.capture.child(base)
            directory = base / point
            directory.mkdir(mode=0o700)
            self.capture.sync(base)
            bindings = {'id': point, 'root': str(self.root), 'context': self.context,
                        'snapshots': str(self.capture.snapshots), 'sourceSha256': authority.preparation['sourceSha256'],
                        'leaseNonce': grant['nonce'], 'preparationSha256': authority.preparation_sha256,
                        'decisionSha256': W.digest(decision_body)}
            handoff = {'schema': 'orbis.core-capture-handoff.v2', **bindings,
                       'producer': 'orbis.authenticated-root-supervisor.v1',
                       'operatorAuthorizationId': hold['operatorAuthorizationId'],
                       'drainReservationId': hold['drainReservationId'], 'controller': hold['controller']}
            worker_request = {'schema': 'orbis.core-capture-admission.v2', **bindings,
                              'handoffSha256': W.digest(P.canonical(handoff))}
            create(directory, 'source-hold.json', hold)
            create(directory, 'handoff.json', handoff)
            create(directory, 'request.json', worker_request)
            create(directory, 'acceptance.json', {'schema': 'orbis.core-capture-acceptance.v1', 'id': point,
                   **request, 'workerRequestSha256': W.digest(P.canonical(worker_request))})
            authority.admission(worker_request, handoff, request['sourceHoldSha256'])
        result = W.launch_worker(self.state, point)
        return {'version': 1, 'id': point, 'state': result['state'], 'sourceHoldSha256': request['sourceHoldSha256']}

    def source_hold(self, body, preparation):
        hold = P.metadata(body, byte_limit=65536)
        expected = {'schema', 'id', 'operatorAuthorizationId', 'drainReservationId', 'preparationSha256',
                    'sourceSha256', 'controller', 'queueDrain'}
        bound = preparation.get('schema') in {'orbis.core-capture-preparation.v2', W.RESERVED.SCHEMA}
        if bound:
            expected.add('pointReservationSha256')
        if (not isinstance(hold, dict) or set(hold) != expected or P.canonical(hold) != body
                or hold['schema'] != ('orbis.core-capture-source-hold.v2' if bound else 'orbis.core-capture-source-hold.v1')
                or any(hold[key] != preparation[key] for key in ('id', 'sourceSha256', 'controller'))
                or (bound and hold['pointReservationSha256'] != preparation['pointReservationSha256'])
                or hold['preparationSha256'] != W.digest(P.canonical(preparation))):
            raise W.AdmissionError('The source maintenance handoff changed')
        W.identifier(hold['operatorAuthorizationId'])
        W.identifier(hold['drainReservationId'])
        drain = hold['queueDrain']
        if (not isinstance(drain, dict) or set(drain) != {'pauseId', 'generation', 'queues'}
                or drain['pauseId'] != hold['drainReservationId'] or type(drain['generation']) is not int
                or not 1 <= drain['generation'] <= 9007199254740991 or not isinstance(drain['queues'], list)
                or len(drain['queues']) != 3):
            raise W.AdmissionError('The source queue drain is incomplete')
        seen = set()
        for item in drain['queues']:
            if (not isinstance(item, dict) or set(item) != {'name', 'messages', 'consumers'}
                    or not isinstance(item['name'], str) or item['name'] not in QUEUES or item['name'] in seen
                    or any(type(item[key]) is not int or item[key] != 0 for key in ('messages', 'consumers'))):
                raise W.AdmissionError('The source queue drain is incomplete')
            seen.add(item['name'])
        return hold

    def admit(self, point, request):
        W.require_root()
        W.identifier(point)
        if (not isinstance(request, dict) or set(request) != {'preparationSha256', 'sourceHoldSha256'}
                or any(not isinstance(value, str) or not W.HASH.fullmatch(value) for value in request.values())):
            raise W.AdmissionError('Invalid core capture handoff request')
        with self.service.lock:
            self.service.require_idle_core()
            preparation, _ = self.read(self.directory(point), 'preparation.json')
            if preparation.get('schema') == W.RESERVED.SCHEMA:
                return self._admit_reserved(point, request)
            with H.host_lock(self.root) as descriptor:
                preparation, body = self.read(self.directory(point), 'preparation.json')
                if request['preparationSha256'] != W.digest(body):
                    raise W.AdmissionError('The source preparation changed')
                reader = C.TX.APPS.Docker(self.context)
                reader.lock_fd = descriptor
                bound = preparation.get('schema') == 'orbis.core-capture-preparation.v2'
                if bound:
                    self.require_bound_source(reader, point, preparation)
                elif self.preparation(point, self.observe(reader)) != preparation:
                    raise W.AdmissionError('The live source no longer matches preparation')
                marker = self.controller_marker(preparation['controller'])
                if W.digest(marker) != request['sourceHoldSha256']:
                    raise W.AdmissionError('The source maintenance marker changed')
                hold = self.source_hold(marker, preparation)
                if bound:
                    self.require_bound_source(reader, point, preparation)
                elif self.preparation(point, self.observe(reader)) != preparation:
                    raise W.AdmissionError('The source changed while checking its drain')
                if self.sentinel.retain_draft(reader, point, preparation, request['sourceHoldSha256']):
                    if bound:
                        self.require_bound_source(reader, point, preparation)
                    elif self.preparation(point, self.observe(reader)) != preparation:
                        raise W.AdmissionError('The source changed during Sentinel custody transfer')
                    if self.controller_marker(preparation['controller']) != marker:
                        raise W.AdmissionError('The source marker changed during Sentinel custody transfer')
                base = self.state / 'core-capture-admissions'
                self.capture.child(base)
                directory = base / point
                directory.mkdir(mode=0o700)
                self.capture.sync(base)
                lease = W.LEASE.CoreCaptureLease.reserve(H, self.root, self.context, point, preparation['sourceSha256'])
                with lease.owner() as grant:
                    bindings = {'id': point, 'root': str(self.root), 'context': self.context,
                                'snapshots': str(self.capture.snapshots), 'sourceSha256': preparation['sourceSha256'],
                                'leaseNonce': grant['nonce']}
                    handoff = {'schema': 'orbis.core-capture-handoff.v1', **bindings,
                               'producer': 'orbis.authenticated-root-supervisor.v1',
                               'operatorAuthorizationId': hold['operatorAuthorizationId'],
                               'drainReservationId': hold['drainReservationId'], 'controller': hold['controller']}
                    worker_request = {'schema': 'orbis.core-capture-admission.v1', **bindings,
                                      'handoffSha256': W.digest(P.canonical(handoff))}
                    create(directory, 'source-hold.json', hold)
                    create(directory, 'handoff.json', handoff)
                    create(directory, 'request.json', worker_request)
                    create(directory, 'acceptance.json', {'schema': 'orbis.core-capture-acceptance.v1', 'id': point,
                           **request, 'workerRequestSha256': W.digest(P.canonical(worker_request))})
            # The durable selector continues exclusion after the flock is handed to the worker.
            result = W.launch_worker(self.state, point)
            return {'version': 1, 'id': point, 'state': result['state'],
                    'sourceHoldSha256': request['sourceHoldSha256']}
