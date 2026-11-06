"""Verify published captures and retire their holds after committed continuation."""
import os
from types import SimpleNamespace


CAPABILITY = {'schema': 'orbis.core-capture-publication-capability.v1', 'version': 1,
              'pointVersion': 3, 'payloadFormat': 'orbis.time-machine-core.v1',
              'publicationSchema': 'orbis.core-capture-publication.v1', 'dataRoot': '/data',
              'verification': 'authenticated-stream-and-images.v1',
              'mutations': 'private-verification-staging-only'}
HASH_FIELDS = {'pointSha256', 'pointReservationSha256', 'metadataSha256', 'cipherSha256',
               'manifestSha256', 'imageInventorySha256', 'captureReceiptSha256',
               'sourceSha256', 'checkpointSha256'}
PUBLICATION_FIELDS = HASH_FIELDS | {'schema', 'pointId', 'ownerId', 'createdAt',
                                   'cipherBytes', 'checkpoint', 'resourceCount', 'imageCount'}

PUBLICATION_SEAL_READER = r"""
const fs=require('node:fs'),crypto=require('node:crypto');
const id=process.argv[1];
if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))throw Error('id');
const base='/data/backups/time-machine',point=base+'/points/'+id;
const dirs=['/data','/data/backups',base,base+'/points',point,base+'/keys'];
const dk=['dev','ino','mode','uid','gid'],fk=[...dk,'nlink','size','mtimeNs','ctimeNs'];
const seal=(s,ks)=>ks.map(k=>String(s[k]));
const directory=p=>{const s=fs.lstatSync(p,{bigint:true});
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0n||(s.mode&0o022n)!==0n||fs.realpathSync(p)!==p)throw Error('directory');return s;};
const before=dirs.map(directory),opened=[];
const read=(p,max,content)=>{const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);opened.push(fd);
 const s=fs.fstatSync(fd,{bigint:true});if(!s.isFile()||s.uid!==0n||s.nlink!==1n||![0o400n,0o600n].includes(s.mode&0o7777n)||s.size<1n||s.size>BigInt(max))throw Error('file');
 let bytes=null;if(content){bytes=Buffer.alloc(Number(s.size)+1);let count=0;while(count<bytes.length){const n=fs.readSync(fd,bytes,count,bytes.length-count,null);if(!n)break;count+=n;}
 if(BigInt(count)!==s.size)throw Error('size');bytes=bytes.subarray(0,count);}
 if(JSON.stringify(seal(s,fk))!==JSON.stringify(seal(fs.fstatSync(fd,{bigint:true}),fk))||JSON.stringify(seal(s,fk))!==JSON.stringify(seal(fs.lstatSync(p,{bigint:true}),fk)))throw Error('changed');
 return {s,fd,p,bytes};};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
try{
 const a=read(point+'/point.json',32768,true),b=read(point+'/metadata.orbis',524340,true),c=read(point+'/core.orbis',68719476736,false),k=read(base+'/keys/master-v1.key',32,true);
 const value=JSON.parse(a.bytes.toString('utf8'));
 if(value.id!==id||value.version!==3||value.status!=='sealed'||k.bytes.length!==32||value.envelope.keyId!==sha(k.bytes)||BigInt(value.archiveBytes)!==c.s.size||!/^[a-f0-9]{64}$/.test(value.archiveSha256))throw Error('binding');
 const result={schema:'orbis.core-capture-publication-seal.v1',pointId:id,pointSha256:sha(a.bytes),metadataSha256:sha(b.bytes),keyId:sha(k.bytes),cipherBytes:value.archiveBytes,cipherSha256:value.archiveSha256,
 files:{point:seal(a.s,fk),metadata:seal(b.s,fk),core:seal(c.s,fk),key:seal(k.s,fk)},directories:before.map(s=>seal(s,dk))};
 for(const f of [a,b,c,k])if(JSON.stringify(seal(f.s,fk))!==JSON.stringify(seal(fs.fstatSync(f.fd,{bigint:true}),fk))||JSON.stringify(seal(f.s,fk))!==JSON.stringify(seal(fs.lstatSync(f.p,{bigint:true}),fk)))throw Error('changed');
 dirs.forEach((p,i)=>{if(JSON.stringify(seal(before[i],dk))!==JSON.stringify(seal(directory(p),dk)))throw Error('changed');});
 process.stdout.write(JSON.stringify(result));
}finally{for(const fd of opened)fs.closeSync(fd);}
"""


class CompletionError(ValueError):
    pass


def require_dependency_ready(worker, reader, identifier, role):
    if role not in {'controller', 'database', 'queue'}:
        raise CompletionError('The captured dependency role is invalid')
    try:
        worker.CORE.TX.require_healthy(reader, identifier)
        return
    except worker.CORE.TX.TransactionError:
        if role != 'queue':
            raise
        before = reader._object(['container', 'inspect', '--format', '{{json .}}', identifier])
        healthcheck = before['Config'].get('Healthcheck')
        if healthcheck is not None and healthcheck.get('Test') != ['NONE']:
            raise
        state = before['State']
        if (before['Id'] != identifier or state.get('Status') != 'running' or state.get('Running') is not True
                or state.get('Restarting') or state.get('Paused') or not isinstance(state.get('StartedAt'), str)
                or not 1 <= len(state['StartedAt']) <= 128):
            raise CompletionError('The captured message broker is not running stably')
        runtime = SimpleNamespace(P=worker.P)
        definition = worker.CORE.D.DockerRestoreRuntime.definition(runtime, before)
        # Standard RabbitMQ images do not declare Docker HEALTHCHECK. Probe the broker itself.
        for check in ('check_running', 'check_local_alarms'):
            reader._read(['exec', identifier, 'rabbitmq-diagnostics', '-q', check])
        after = reader._object(['container', 'inspect', '--format', '{{json .}}', identifier])
        if (after.get('Image') != before.get('Image')
                or worker.CORE.D.DockerRestoreRuntime.definition(runtime, after) != definition
                or any(after['State'].get(key) != state.get(key)
                       for key in ('Status', 'Running', 'Restarting', 'Paused', 'StartedAt'))
                or after['HostConfig'].get('RestartPolicy') != before['HostConfig'].get('RestartPolicy')):
            raise CompletionError('The captured message broker changed during its readiness probe')


class CoreCaptureCompletion:
    def __init__(self, manager, worker):
        self.manager, self.worker = manager, worker
        self.reservation = worker.load('orbis-host-core-capture-reservation.py', 'completion_reservation')
        self.retirement = worker.load('orbis-host-core-capture-retirement.py', 'completion_retirement')
        self.namespace = worker.load('orbis-host-core-capture-namespace.py', 'completion_namespace')

    def publication_seal(self, admission, controller):
        worker = self.worker
        runtime = SimpleNamespace(host=worker.CORE.HOST, root=admission.root)
        body = worker.CORE.D.DockerRestoreRuntime.bounded_output(runtime,
            ['docker', '--context', admission.context, 'exec', controller['id'], '/usr/local/bin/node',
             '-e', PUBLICATION_SEAL_READER, admission.point], 8192, 10)
        value = worker.P.metadata(body, byte_limit=8192)
        if (not isinstance(value, dict)
                or set(value) != {'schema', 'pointId', 'pointSha256', 'metadataSha256', 'keyId',
                                 'cipherBytes', 'cipherSha256', 'files', 'directories'}
                or value['schema'] != 'orbis.core-capture-publication-seal.v1' or value['pointId'] != admission.point
                or any(not isinstance(value[key], str) or not worker.HASH.fullmatch(value[key])
                       for key in ('pointSha256', 'metadataSha256', 'keyId', 'cipherSha256'))
                or type(value['cipherBytes']) is not int or not 1 <= value['cipherBytes'] <= 68719476736
                or not isinstance(value['files'], dict) or set(value['files']) != {'point', 'metadata', 'core', 'key'}
                or not isinstance(value['directories'], list) or len(value['directories']) != 6):
            raise CompletionError('The published point identity seal is invalid')
        rows = [(row, 9) for row in value['files'].values()] + [(row, 5) for row in value['directories']]
        if any(not isinstance(row, list) or len(row) != length or any(not isinstance(item, str)
                   or not worker.re.fullmatch(r'0|[1-9][0-9]{0,19}', item) for item in row) for row, length in rows):
            raise CompletionError('The published point filesystem identities are invalid')
        return value

    @staticmethod
    def details(proof, source_sha256, state='verified-awaiting-continuation', continuation_sha256=None):
        result = {'version': 1, 'id': proof['id'], 'state': state,
                  'sourceSha256': source_sha256, 'sourceHoldSha256': proof['sourceHoldSha256'],
                  'completionSha256': '', 'pointReservationSha256': proof['pointReservationSha256'],
                  'controller': proof['controller']}
        if state == 'complete':
            result['continuationSha256'] = continuation_sha256
        return result

    def prepared_details(self, proof, source_sha256, state='verified-awaiting-continuation', continuation_sha256=None):
        result = self.details(proof, source_sha256, state, continuation_sha256)
        result['completionSha256'] = self.worker.digest(self.worker.P.canonical(proof))
        return result

    def bound_preparation(self, admission):
        manager, worker = self.manager, self.worker
        preparation, body = manager.read(manager.directory(admission.point), 'preparation.json')
        reserved = admission.request.get('schema') == 'orbis.core-capture-admission.v2'
        if (set(preparation) != {'schema', 'id', 'root', 'context', 'scope', 'sourceSha256',
                                 'controller', 'pointReservationSha256'} | (worker.RESERVED.EXTRA if reserved else set())
                or preparation['schema'] != ('orbis.core-capture-preparation.v3' if reserved else 'orbis.core-capture-preparation.v2')
                or any(preparation[key] != admission.request[key]
                       for key in ('id', 'root', 'context', 'sourceSha256'))
                or preparation['scope'] != worker.CORE.SCOPE
                or preparation['controller'] != admission.handoff['controller']):
            raise CompletionError('Only a bound capture preparation can authorize publication')
        if reserved and (admission.reservation is None or admission.reservation.body != body):
            raise CompletionError('The reserved capture preparation changed before publication')
        admission.unchanged()
        reservation, reservation_body = manager.read(manager.directory(admission.point), 'point-reservation.json')
        self.reservation.validate_reservation(reservation, admission.point)
        if worker.digest(reservation_body) != preparation['pointReservationSha256']:
            raise CompletionError('The original saved point reservation changed')
        acceptance, _ = admission.read('acceptance.json')
        if (set(acceptance) != {'schema', 'id', 'preparationSha256', 'sourceHoldSha256', 'workerRequestSha256'}
                or acceptance['schema'] != 'orbis.core-capture-acceptance.v1'
                or acceptance['id'] != admission.point
                or acceptance['preparationSha256'] != worker.digest(body)
                or acceptance['workerRequestSha256'] != admission.request_sha256):
            raise CompletionError('The accepted capture no longer matches its preparation')
        hold, hold_body = admission.read('source-hold.json')
        manager.source_hold(hold_body, preparation)
        if (hold.get('schema') != 'orbis.core-capture-source-hold.v2'
                or hold.get('pointReservationSha256') != preparation['pointReservationSha256']
                or hold.get('preparationSha256') != acceptance['preparationSha256']
                or hold.get('id') != admission.point
                or hold.get('sourceSha256') != admission.request['sourceSha256']
                or hold.get('controller') != preparation['controller']
                or worker.digest(hold_body) != acceptance['sourceHoldSha256']):
            raise CompletionError('The source hold is not bound to this saved point')
        return preparation, reservation, acceptance, hold_body

    def observed(self, admission, reader, record, preparation, hold_body):
        manager, worker = self.manager, self.worker
        manager.capture.verify(reader, record)
        if worker.CORE.TX.APPS.digest(manager.capture.source()) != admission.request['sourceSha256']:
            raise CompletionError('The installation source changed before completion')
        controller = preparation['controller']
        actual = manager.capture.observation(reader, controller['id'])
        if (actual['id'] != controller['id'] or actual['imageId'] != controller['imageId']
                or worker.CORE.TX.APPS.digest(actual['definition']) != controller['definitionSha256']
                or actual != record['expected'].get(controller['id'])
                or manager.controller_marker(controller) != hold_body):
            raise CompletionError('The resumed controller or its source hold changed')
        for identifier in record['expected']:
            if record['expected'][identifier]['state'] != 'running':
                raise CompletionError('A captured core dependency is not running')
            require_dependency_ready(worker, reader, identifier, record['checkpoint']['roles'][identifier])
        manager.capture.verify(reader, record)
        return {'id': actual['id'], 'imageId': actual['imageId'], 'startedAt': actual['startedAt'],
                'definitionSha256': controller['definitionSha256']}

    def invoke(self, admission, controller, arguments):
        worker = self.worker
        runtime = SimpleNamespace(host=worker.CORE.HOST, root=admission.root)
        body = worker.CORE.D.DockerRestoreRuntime.bounded_output(runtime,
            ['docker', '--context', admission.context, 'exec', controller['id'], '/usr/local/bin/node',
             '/app/core-capture-publication.mjs', *arguments], 8192, 1800)
        return worker.P.metadata(body, byte_limit=8192)

    def publication(self, admission, controller, expected, reservation):
        worker = self.worker
        if worker.P.canonical(self.invoke(admission, controller, ['--capability'])) != worker.P.canonical(CAPABILITY):
            raise CompletionError('The resumed controller cannot independently verify this capture')
        result = self.invoke(admission, controller, ['--verify', worker.P.canonical(expected).decode('utf8')])
        return self.validate_publication(admission, result, expected, reservation)

    def validate_publication(self, admission, result, expected, reservation):
        worker = self.worker
        if (not isinstance(result, dict) or set(result) != PUBLICATION_FIELDS
                or result['schema'] != 'orbis.core-capture-publication.v1'
                or any(not isinstance(result[key], str) or not worker.HASH.fullmatch(result[key]) for key in HASH_FIELDS)
                or any(type(result[key]) is not int or result[key] != reservation[key] for key in ('ownerId', 'createdAt'))
                or result['pointId'] != admission.point
                or result['pointReservationSha256'] != self.reservation.sha256(reservation)
                or any(result[key] != expected[key] for key in
                       ('sourceSha256', 'checkpointSha256', 'captureReceiptSha256', 'checkpoint', 'resourceCount'))
                or type(result['resourceCount']) is not int
                or type(result['imageCount']) is not int
                or result['imageCount'] != len(set(expected['images'].values()))
                or type(result['cipherBytes']) is not int
                or not expected['checkpoint']['bytes'] + 52 < result['cipherBytes'] <= 68719476736):
            raise CompletionError('The independent saved point verification differs from root authority')
        return result

    def automatic_publication_state(self, admission, profile, proof_body):
        worker = self.worker
        launch, _ = admission.read('sentinel-auto-launch.json', optional=True)
        outcome, _ = admission.read('sentinel-auto-result.json', optional=True)
        if launch is None:
            if outcome is not None:
                raise CompletionError('The automatic publication has no original launch')
            return 'awaiting-publication' if profile.get('schema') == 'orbis.host.sentinel-capture-profile.v2' else None
        terminal_body = admission.read('worker-terminal.json')[1]
        if (not isinstance(launch, dict)
                or set(launch) != {'schema', 'id', 'requestSha256', 'terminalSha256', 'publicationSourceSha256'}
                or launch.get('terminalSha256') != worker.digest(terminal_body)
                or not isinstance(launch.get('publicationSourceSha256'), str)
                or not worker.HASH.fullmatch(launch['publicationSourceSha256'])
                or worker.P.canonical(launch) != worker.P.canonical(admission.event('sentinel-auto-launch',
                    terminalSha256=launch['terminalSha256'], publicationSourceSha256=launch['publicationSourceSha256']))):
            raise CompletionError('The automatic publication launch changed')
        if outcome is None:
            return 'awaiting-publication'
        if (not isinstance(outcome, dict)
                or set(outcome) != {'schema', 'id', 'requestSha256', 'state', 'returnCode', 'proofSha256'}
                or outcome.get('state') not in {'verified', 'unsettled'}
                or (outcome['returnCode'] is not None and (type(outcome['returnCode']) is not int
                    or not -255 <= outcome['returnCode'] <= 255))
                or worker.P.canonical(outcome) != worker.P.canonical(admission.event('sentinel-auto-result',
                    state=outcome['state'], returnCode=outcome['returnCode'], proofSha256=outcome['proofSha256']))):
            raise CompletionError('The automatic publication outcome changed')
        if outcome['state'] == 'unsettled':
            if outcome['proofSha256'] is not None:
                raise CompletionError('The unsettled publication contains a completion claim')
            return 'recovery-required'
        if (type(outcome['returnCode']) is not int or outcome['returnCode'] != 0
                or proof_body is None or outcome['proofSha256'] != worker.digest(proof_body)):
            raise CompletionError('The automatic publication proof is incomplete')
        return 'verified'

    def require_selected_publication(self, admission, preparation, acceptance, terminal_body, publication):
        worker, custody = self.worker, self.manager.sentinel
        if custody.publication_mode(admission.point, preparation) == 'controller-restart.v1':
            if admission.read('sentinel-publication.json', optional=True)[0] is not None:
                raise CompletionError('The saved point has conflicting publishers')
            return
        profile = custody.require_publication_reserved(admission.point, preparation)
        proof, proof_body = admission.read('sentinel-publication.json')
        if self.automatic_publication_state(admission, profile, proof_body) not in (None, 'verified'):
            raise CompletionError('The automatic Sentinel publication has not finished successfully')
        value = proof.get('publication')
        if (not isinstance(value, dict)
                or value.get('schema') != 'orbis-sentinel.prepared-publication.v1'
                or value.get('id') != admission.point or value.get('dataState') != 'verified'
                or value.get('lifecycleState') != 'unobserved'
                or value.get('preparationSha256') != worker.digest(worker.P.canonical(preparation))
                or value.get('sourceHoldSha256') != acceptance['sourceHoldSha256']
                or value.get('terminalSha256') != worker.digest(terminal_body)
                or not isinstance(value.get('publication'), dict)
                or worker.P.canonical(value['publication'].get('core')) != worker.P.canonical(publication)
                or worker.P.canonical(proof) != worker.P.canonical(admission.event('sentinel-publication',
                    publication=value, profileSha256=worker.digest(worker.P.canonical(profile))))):
            raise CompletionError('The resumed point differs from its selected Sentinel publication')

    def prepare(self, point):
        """Persist verified completion evidence while retaining every exclusion."""
        manager, worker = self.manager, self.worker
        worker.require_root()
        worker.identifier(point)
        if (manager.root != manager.capture.root or manager.state != manager.capture.state
                or manager.context != manager.capture.context):
            raise CompletionError('The completion manager differs from its capture authority')
        with manager.service.lock:
            admission = worker.Admission(manager.state, point)
            if (admission.root != manager.root or admission.context != manager.context or admission.state != manager.state):
                raise CompletionError('The admission belongs to another installation')
            with admission.lease.owner(), worker.CORE.HOST.host_lock(admission.root) as descriptor:
                preparation, reservation, acceptance, hold_body = self.bound_preparation(admission)
                terminal = worker.SUPERVISOR.read_terminal(admission, worker=worker.worker_context())
                if (terminal is None or terminal['state'] != 'quiescent'
                        or terminal['workerQuiescent'] is not True or terminal['workerExitCode'] != 0):
                    raise CompletionError('The worker has no successful independent terminal witness')
                terminal_body = admission.read('worker-terminal.json')[1]
                status = worker.read_status(manager.state, point)
                if status['state'] != 'resumed-awaiting-publication' or not isinstance(status.get('artifact'), dict):
                    raise CompletionError('The worker has no verified portable checkpoint')
                artifact = status['artifact']
                settled_body = admission.read('settled.json')[1]
                expected = {'pointId': point, 'sourceSha256': admission.request['sourceSha256'],
                            'checkpointSha256': artifact['checkpointSha256'],
                            'captureReceiptSha256': worker.digest(settled_body),
                            'checkpoint': artifact['checkpoint'], 'resourceCount': artifact['resourceCount'],
                            'images': artifact['roleImageIds'], 'compatibility': artifact['compatibility']}
                reader = worker.CORE.TX.APPS.Docker(admission.context)
                reader.lock_fd = descriptor
                record = manager.capture.read(manager.capture.base / point)
                observed = self.observed(admission, reader, record, preparation, hold_body)
                seal = self.publication_seal(admission, observed)
                # A Sentinel-selected job may only continue with its exact sealed point.
                # The controller verifier authenticates that mirror; it is not a second publisher.
                mode = manager.sentinel.publication_mode(point, preparation)
                if mode == 'sentinel.v1' and admission.read('sentinel-publication.json', optional=True)[0] is None:
                    raise CompletionError('The selected Sentinel has not published this capture')
                existing, _ = admission.read('completion-ready.json', optional=True)
                if existing is None:
                    publication = self.publication(admission, observed, expected, reservation)
                else:
                    if existing.get('publicationSeal') != seal:
                        raise CompletionError('The prepared publication identity changed')
                    publication = self.validate_publication(admission, existing.get('publication'), expected, reservation)
                self.require_selected_publication(admission, preparation, acceptance, terminal_body, publication)
                if (self.publication_seal(admission, observed) != seal
                        or any(seal[key] != publication[key] for key in
                               ('pointSha256', 'metadataSha256', 'cipherBytes', 'cipherSha256'))
                        or seal['keyId'] != reservation['envelope']['keyId']):
                    raise CompletionError('The saved point changed around independent verification')
                if self.observed(admission, reader, record, preparation, hold_body) != observed:
                    raise CompletionError('The controller changed during independent verification')
                if (self.bound_preparation(admission) != (preparation, reservation, acceptance, hold_body)
                        or worker.SUPERVISOR.read_terminal(admission, worker=worker.worker_context()) != terminal
                        or admission.read('worker-terminal.json')[1] != terminal_body
                        or worker.read_status(manager.state, point) != status):
                    raise CompletionError('The root completion evidence changed during verification')
                self.require_selected_publication(admission, preparation, acceptance, terminal_body, publication)
                proof = admission.event('completion-ready', leaseNonce=admission.request['leaseNonce'],
                    terminalSha256=worker.digest(terminal_body), sourceHoldSha256=acceptance['sourceHoldSha256'],
                    pointReservationSha256=preparation['pointReservationSha256'], controller=observed,
                    publication=publication, publicationSeal=seal)
                if existing is None:
                    admission.create('completion-ready.json', proof)
                elif existing != proof:
                    raise CompletionError('An earlier completion preparation differs')
                if admission.read('completion-ready.json')[0] != proof:
                    raise CompletionError('The completion preparation did not persist')
                admission.unchanged()
                return self.prepared_details(proof, admission.request['sourceSha256'])

    def validate_request(self, point, request, *, finish=False):
        self.worker.require_root()
        self.worker.identifier(point)
        fields = {'sourceSha256', 'sourceHoldSha256'}
        if finish:
            fields |= {'completionSha256', 'continuationSha256'}
        if (not isinstance(request, dict) or set(request) != fields
                or any(not isinstance(value, str) or not self.worker.HASH.fullmatch(value) for value in request.values())):
            raise CompletionError('Invalid capture completion request')

    def persist(self, directory, name, value):
        if name not in {'source-continuation.json', 'source-retired.json'}:
            raise CompletionError('Unknown capture continuation record')
        worker = self.worker
        try:
            existing, _ = self.manager.read(directory, name)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            if existing != value:
                raise CompletionError('An earlier capture continuation differs')
            return
        with worker.A.protected_directory(directory) as checked:
            before = worker.identity(os.fstat(checked))
            parent = os.dup(checked)
        try:
            descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                with os.fdopen(descriptor, 'wb', closefd=False) as stream:
                    stream.write(worker.P.canonical(value))
                    stream.flush()
                    os.fsync(descriptor)
                os.fsync(parent)
            finally:
                os.close(descriptor)
            with worker.A.protected_directory(directory) as checked:
                if worker.identity(os.fstat(checked)) != before:
                    raise CompletionError('The continuation authority directory changed')
        finally:
            os.close(parent)
        if self.manager.read(directory, name)[0] != value:
            raise CompletionError('The continuation record did not persist')

    def retirement_for(self, point):
        manager = self.manager
        return self.retirement.CaptureRetirement(self.worker, manager.state, manager.root, manager.context, point)

    def completed(self, point, request):
        """Positive historical retirement is sufficient; absence never is."""
        manager, worker = self.manager, self.worker
        directory = manager.state / 'core-capture-admissions' / point
        try:
            manager.read(directory, 'completion-commit.json')
        except FileNotFoundError:
            return None
        retirement = self.retirement_for(point)
        try:
            commit = retirement.inspect_retired()
        except FileNotFoundError:
            return None
        proof, body = manager.read(directory, 'completion-ready.json')
        original, request_body = manager.read(directory, 'request.json')
        if (worker.digest(body) != commit['completionSha256']
                or worker.digest(request_body) != commit['requestSha256']
                or proof.get('sourceHoldSha256') != commit['sourceHoldSha256']
                or proof.get('pointReservationSha256') != commit['pointReservationSha256']
                or request['sourceSha256'] != original['sourceSha256']
                or request['sourceHoldSha256'] != commit['sourceHoldSha256']
                or any(key in request and request[key] != commit[key]
                       for key in ('completionSha256', 'continuationSha256'))):
            raise CompletionError('Historical capture completion differs from this request')
        try:
            retired, _ = manager.read(directory, 'source-retired.json')
        except FileNotFoundError:
            retired = None
        expected = {'schema': 'orbis.core-capture-retirement-witness.v1', 'id': point,
                    'completionSha256': commit['completionSha256'], 'continuationSha256': commit['continuationSha256'],
                    'sourceHoldSha256': commit['sourceHoldSha256']}
        if retired is None:
            # A crash after root lease rename can finish only this committed
            # marker retirement, under the ordinary current installation lock.
            with worker.CORE.HOST.host_lock(manager.root) as descriptor:
                reader = worker.CORE.TX.APPS.Docker(manager.context)
                reader.lock_fd = descriptor
                observed = manager.observe(reader)['controller']
                with self.namespace.CaptureNamespace(worker, reader, observed) as namespace:
                    witness = namespace.retire_hold(point, commit['sourceHoldSha256'])
                retired = {**expected, 'namespace': witness}
                self.persist(directory, 'source-retired.json', retired)
        if (set(retired) != set(expected) | {'namespace'}
                or any(retired[key] != value for key, value in expected.items())
                or not isinstance(retired['namespace'], dict)
                or retired['namespace'].get('schema') != 'orbis.core-capture-source-retirement.v1'
                or retired['namespace'].get('id') != point
                or retired['namespace'].get('sourceHoldSha256') != commit['sourceHoldSha256']):
            raise CompletionError('No matching preserved source hold retirement exists')
        retirement.inspect_retired()
        return self.prepared_details(proof, original['sourceSha256'], 'complete', commit['continuationSha256'])

    def status(self, point, request):
        self.validate_request(point, request)
        with self.manager.service.lock:
            completed = self.completed(point, request)
        if completed is not None:
            return completed
        result = self.prepare(point)
        if any(result[key] != request[key] for key in ('sourceSha256', 'sourceHoldSha256')):
            raise CompletionError('The prepared capture differs from this source')
        return result

    def continuation(self, value, proof, expected_hash):
        worker = self.worker
        if (not isinstance(value, dict) or set(value) != {'schema', 'id', 'completionSha256', 'sourceHoldSha256',
                                                       'pointReservationSha256', 'controller', 'queueGeneration', 'queues'}
                or value['schema'] != 'orbis.core-capture-source-continuation.v1'
                or any(value[key] != proof[key] for key in ('id', 'sourceHoldSha256', 'pointReservationSha256', 'controller'))
                or value['completionSha256'] != worker.digest(worker.P.canonical(proof))
                or worker.digest(worker.P.canonical(value)) != expected_hash
                or type(value['queueGeneration']) is not int or not 1 <= value['queueGeneration'] <= 9007199254740991
                or not isinstance(value['queues'], list) or len(value['queues']) != 3):
            raise CompletionError('The resumed source has no matching continuation acknowledgement')
        names = set()
        for queue in value['queues']:
            if (not isinstance(queue, dict) or set(queue) != {'name', 'messages', 'consumers'}
                    or not isinstance(queue['name'], str) or queue['name'] not in
                       {'app-events-queue', 'repo-queue', 'system-events-queue'} or queue['name'] in names
                    or type(queue['messages']) is not int or queue['messages'] != 0
                    or type(queue['consumers']) is not int or queue['consumers'] != 1):
                raise CompletionError('The resumed source queue coverage changed')
            names.add(queue['name'])

    def finish(self, point, request):
        self.validate_request(point, request, finish=True)
        manager, worker = self.manager, self.worker
        with manager.service.lock:
            completed = self.completed(point, request)
            if completed is not None:
                return completed
            admission = worker.Admission(manager.state, point)
            with admission.lease.owner(), worker.CORE.HOST.host_lock(admission.root) as descriptor:
                preparation, reservation, acceptance, hold_body = self.bound_preparation(admission)
                proof, proof_body = admission.read('completion-ready.json')
                if (proof.get('schema') != 'orbis.core-capture-completion-ready.v1'
                        or proof.get('id') != point or proof.get('requestSha256') != admission.request_sha256
                        or proof.get('leaseNonce') != admission.request['leaseNonce']
                        or worker.digest(proof_body) != request['completionSha256']
                        or request['sourceSha256'] != admission.request['sourceSha256']
                        or request['sourceHoldSha256'] != acceptance['sourceHoldSha256']):
                    raise CompletionError('No matching root completion preparation exists')
                terminal = worker.SUPERVISOR.read_terminal(admission, worker=worker.worker_context())
                if (terminal is None or terminal['state'] != 'quiescent' or terminal['workerQuiescent'] is not True
                        or worker.digest(admission.read('worker-terminal.json')[1]) != proof['terminalSha256']):
                    raise CompletionError('The independent terminal evidence changed')
                self.require_selected_publication(admission, preparation, acceptance,
                    admission.read('worker-terminal.json')[1], proof['publication'])
                reader = worker.CORE.TX.APPS.Docker(admission.context)
                reader.lock_fd = descriptor
                record = manager.capture.read(manager.capture.base / point)
                if (self.observed(admission, reader, record, preparation, hold_body) != proof['controller']
                        or self.publication_seal(admission, proof['controller']) != proof['publicationSeal']):
                    raise CompletionError('The verified source or publication changed before settlement')
                with self.namespace.CaptureNamespace(worker, reader, proof['controller']) as namespace:
                    continuation, body = namespace.read_continuation(point)
                    self.continuation(continuation, proof, request['continuationSha256'])
                    self.persist(admission.directory, 'source-continuation.json', continuation)
                    if (namespace.read_continuation(point) != (continuation, body)
                            or self.observed(admission, reader, record, preparation, hold_body) != proof['controller']
                            or self.publication_seal(admission, proof['controller']) != proof['publicationSeal']):
                        raise CompletionError('The continuation changed before durable commit')
                    path = worker.CORE.HOST.capture_fence_path(admission.root)
                    with worker.A.protected_directory(path.parent, private=False) as parent:
                        details = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
                        with worker.A.protected_file(parent, path.name, 8192) as lease_body:
                            commit = {'schema': self.retirement.SCHEMA, 'id': point, 'root': str(admission.root),
                                'context': admission.context, 'requestSha256': admission.request_sha256,
                                'leaseSha256': worker.digest(lease_body), 'leaseIdentity': self.retirement.lease_identity(details),
                                'completionSha256': request['completionSha256'], 'sourceHoldSha256': request['sourceHoldSha256'],
                                'continuationSha256': request['continuationSha256'],
                                'pointReservationSha256': preparation['pointReservationSha256']}
                    existing, _ = admission.read('completion-commit.json', optional=True)
                    self.require_selected_publication(admission, preparation, acceptance,
                        admission.read('worker-terminal.json')[1], proof['publication'])
                    if existing is None:
                        admission.create('completion-commit.json', commit)
                    elif existing != commit:
                        raise CompletionError('An earlier completion commit differs')
                    self.retirement_for(point).retire_committed()
                    witness = namespace.retire_hold(point, commit['sourceHoldSha256'])
                    self.persist(admission.directory, 'source-retired.json', {
                        'schema': 'orbis.core-capture-retirement-witness.v1', 'id': point,
                        'completionSha256': commit['completionSha256'], 'continuationSha256': commit['continuationSha256'],
                        'sourceHoldSha256': commit['sourceHoldSha256'], 'namespace': witness})
        # The active owner context is over; only preserved positive evidence is read.
        with manager.service.lock:
            return self.completed(point, request)
