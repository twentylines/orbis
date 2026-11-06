#!/usr/bin/env python3
"""Root-only, unexposed single-attempt core capture and transient-unit launcher.

Admission remains unexposed. Only a trusted root producer that authenticated the
operator and retained managed-mutation/queue drain through the durable lease
reservation may write request.json and handoff.json. Their private
ownership is the authority; booleans, clocks, PIDs and unit disappearance are not
drain or settlement proof. Never expose these paths or this CLI through HTTP.

There is deliberately no startup replay, takeover, lease release, or publication
API. A resumed capture still requires independent library publication settlement.
"""
import argparse
import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import importlib.util


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CORE = load('orbis-host-time-machine-core.py', 'orbis_capture_worker_core')
CHECKPOINT = load('orbis-host-core-checkpoint.py', 'orbis_capture_worker_checkpoint')
SUPERVISOR = load('orbis-host-core-capture-supervisor.py', 'orbis_capture_worker_supervisor')
LEASE = load('orbis-host-core-capture-lease.py', 'orbis_capture_worker_lease')
RESERVED = load('orbis-host-core-capture-reserved.py', 'orbis_capture_worker_reserved')
SERVICE = load('orbis-host-service.py', 'orbis_capture_worker_manifest')
A, P = CORE.HOST.AUTHORITY, CORE.HOST.IDENTITY.PUBLICATION
WORKER = Path(__file__).absolute()
BINDINGS = {'id', 'root', 'context', 'snapshots', 'sourceSha256', 'leaseNonce'}
RESERVED_BINDINGS = {'preparationSha256', 'decisionSha256'}
HASH = re.compile('[a-f0-9]{64}')


class AdmissionError(ValueError):
    pass


def require_root():
    if os.geteuid() != 0:
        raise AdmissionError('Root service authority is required')


def digest(body):
    return hashlib.sha256(body).hexdigest()


def identifier(value):
    if not isinstance(value, str) or not CORE.UUID.fullmatch(value):
        raise AdmissionError('A canonical point UUID is required')
    return value


def identity(info):
    return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode'))


def private_path(value):
    if not isinstance(value, str) or str(Path(value)) != value:
        raise AdmissionError('A canonical private directory is required')
    path = Path(value)
    with A.protected_directory(path):
        pass
    return path


class Admission:
    def __init__(self, state_dir, point):
        require_root()
        self.point = identifier(point)
        self.state = private_path(str(state_dir))
        self.base = private_path(str(self.state / 'core-capture-admissions'))
        self.directory = private_path(str(self.base / self.point))
        with A.protected_directory(self.directory) as fd:
            self.directory_identity = identity(os.fstat(fd))
        self.seals = {}
        self.request, request_body = self.read('request.json')
        self.request_sha256 = digest(request_body)
        reserved = self.request.get('schema') == 'orbis.core-capture-admission.v2'
        bindings = BINDINGS | (RESERVED_BINDINGS if reserved else set())
        if (set(self.request) != bindings | {'schema', 'handoffSha256'}
                or self.request['schema'] != ('orbis.core-capture-admission.v2' if reserved else 'orbis.core-capture-admission.v1')
                or self.request['id'] != self.point):
            raise AdmissionError('Invalid capture admission')
        for key in {'sourceSha256', 'leaseNonce', 'handoffSha256'} | (RESERVED_BINDINGS if reserved else set()):
            if not isinstance(self.request[key], str) or not HASH.fullmatch(self.request[key]):
                raise AdmissionError('Invalid capture binding')
        root = self.request['root']
        if (not isinstance(root, str) or not Path(root).is_absolute() or str(Path(root)) != root
                or str(Path(root).resolve(strict=True)) != root or not Path(root).is_dir()):
            raise AdmissionError('A canonical installation root is required')
        # The installation is enrolled source, not a private authority directory.
        self.root = Path(root)
        self.snapshots = private_path(self.request['snapshots'])
        self.context = self.request['context']
        CORE.HOST.IDENTITY.binding(str(self.root), self.context)
        if any(CORE.TX.STORAGE.overlaps(path, self.root) for path in (self.state, self.snapshots)):
            raise AdmissionError('Capture authority overlaps the installation')
        self.handoff, body = self.read('handoff.json')
        if (digest(body) != self.request['handoffSha256']
                or set(self.handoff) != bindings | {'schema', 'producer', 'operatorAuthorizationId',
                                                    'drainReservationId', 'controller'}
                or self.handoff['schema'] != ('orbis.core-capture-handoff.v2' if reserved else 'orbis.core-capture-handoff.v1')
                or self.handoff['producer'] != 'orbis.authenticated-root-supervisor.v1'
                or any(self.handoff[key] != self.request[key] for key in bindings)):
            raise AdmissionError('Invalid source handoff')
        identifier(self.handoff['operatorAuthorizationId'])
        identifier(self.handoff['drainReservationId'])
        frame = self.handoff['controller']
        if (not isinstance(frame, dict) or set(frame) != {'id', 'imageId', 'startedAt', 'definitionSha256'}
                or not isinstance(frame['id'], str) or not HASH.fullmatch(frame['id'])
                or not isinstance(frame['imageId'], str) or not CORE.TX.APPS.IMAGE_ID.fullmatch(frame['imageId'])
                or not isinstance(frame['startedAt'], str) or not 0 < len(frame['startedAt']) <= 128
                or not isinstance(frame['definitionSha256'], str) or not HASH.fullmatch(frame['definitionSha256'])):
            raise AdmissionError('Invalid source controller frame')
        # Use the capture module's HOST: each dynamic module owns distinct ContextVars.
        self.lease = LEASE.CoreCaptureLease.load(CORE.HOST, self.root)
        with self.lease.owner() as grant:
            expected = {'id': self.point, 'root': str(self.root), 'context': self.context,
                        'sourceSha256': self.request['sourceSha256'], 'nonce': self.request['leaseNonce']}
            if any(grant.get(key) != value for key, value in expected.items()):
                raise AdmissionError('The admission does not own the reserved capture')
        self.reservation = RESERVED.for_admission(reservation_context(), self)

    def read(self, name, *, optional=False):
        try:
            with A.protected_directory(self.directory) as fd:
                if identity(os.fstat(fd)) != self.directory_identity:
                    raise AdmissionError('The admission directory changed')
                with A.protected_file(fd, name, 64 * 1024) as body:
                    value = P.metadata(body, byte_limit=64 * 1024)
                    seal = A.seal(os.stat(name, dir_fd=fd, follow_symlinks=False))
                    if not isinstance(value, dict) or P.canonical(value) != body:
                        raise AdmissionError('Noncanonical capture authority')
                    if name in self.seals and self.seals[name] != seal:
                        raise AdmissionError('The admission authority changed')
                    self.seals[name] = seal
                    return value, body
        except FileNotFoundError:
            if optional:
                return None, None
            raise

    def unchanged(self):
        self.read('request.json')
        self.read('handoff.json')
        with self.lease.owner():
            pass
        if self.reservation is not None:
            _, body = self.read('source-hold.json')
            self.reservation.admission(self.request, self.handoff, digest(body))

    def create(self, name, value):
        self.unchanged()
        with A.protected_directory(self.directory) as checked:
            parent = os.dup(checked)
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                body = P.canonical(value)
                with os.fdopen(fd, 'wb', closefd=False) as output:
                    output.write(body)
                    output.flush()
                    os.fsync(fd)
                os.fsync(parent)
            finally:
                os.close(fd)
        finally:
            os.close(parent)
        with A.protected_directory(self.directory) as checked:
            if identity(os.fstat(checked)) != self.directory_identity:
                raise AdmissionError('The admission directory changed')

    def event(self, kind, **fields):
        return {'schema': 'orbis.core-capture-' + kind + '.v1', 'id': self.point,
                'requestSha256': self.request_sha256, **fields}


def reservation_context():
    return SimpleNamespace(CORE=CORE, A=A, P=P, LEASE=LEASE, require_root=require_root,
                           identifier=identifier, digest=digest, identity=identity, HASH=HASH, AdmissionError=AdmissionError)


class BoundCapture(CORE.CoreCapture):
    """Check the admitted controller's original frame inside capture's host lock."""
    def __init__(self, admission):
        self.admission = admission
        service = SimpleNamespace(root=admission.root, state_dir=admission.state,
                                  snapshots=admission.snapshots, context=admission.context,
                                  current_manifest=lambda: SERVICE.installed_manifest(admission.root, admission.context))
        super().__init__(service)

    def verify(self, reader, record):
        frame = self.admission.handoff['controller']
        original = record['original'].get(frame['id'])
        if (record['checkpoint']['roles'].get(frame['id']) != 'controller'
                or not original or original['state'] != 'running'
                or original['imageId'] != frame['imageId'] or original['startedAt'] != frame['startedAt']
                or CORE.TX.APPS.digest(original['definition']) != frame['definitionSha256']):
            raise AdmissionError('The original controller frame differs from the source handoff')
        self.admission.unchanged()
        super().verify(reader, record)


def worker_hash():
    with A.protected_directory(WORKER.parent, private=False) as fd:
        with A.protected_file(fd, WORKER.name, 2 * 1024 * 1024, private=False) as body:
            return digest(body)


def supervision_identity(point, admission=None):
    if admission is not None:
        launch, _ = admission.read('launch-intent.json', optional=True)
        if launch is not None and launch.get('supervisionProtocol') == 2:
            return SUPERVISOR.enter_worker(admission, worker=worker_context())
    invocation = os.environ.get('INVOCATION_ID')
    if not isinstance(invocation, str) or not re.fullmatch('[a-f0-9]{32}', invocation):
        raise AdmissionError('A systemd invocation identity is required')
    return {'unit': 'orbis-core-capture-' + point + '.service',
            'invocationId': invocation, 'processId': os.getpid()}


def process_frame():
    return {'argv': Path('/proc/self/cmdline').read_bytes().rstrip(b'\0').split(b'\0'),
            'executable': os.readlink('/proc/self/exe'),
            'cgroup': Path('/proc/self/cgroup').read_text()}


def verify_supervision(admission, frame):
    if isinstance(frame, dict) and frame.get('version') == 2:
        return SUPERVISOR.verify_worker(admission, frame, worker=worker_context())
    # PID/cgroup are execution identity only. They never prove worker settlement.
    expected_argv = ['/usr/bin/python3', '-B', str(WORKER), 'run', admission.point,
                     '--state-dir', str(admission.state)]
    process = process_frame()
    if (process['argv'] != [os.fsencode(value) for value in expected_argv]
            or process['executable'] != str(Path('/usr/bin/python3').resolve(strict=True))
            or not any(line.split(':', 2)[-1].split('/')[-1] == frame['unit']
                       for line in process['cgroup'].splitlines())):
        raise AdmissionError('The worker execution frame differs from admission')
    result = subprocess.run(['/usr/bin/systemctl', 'show', frame['unit'], '--no-pager',
                             '--property=InvocationID,MainPID,Type,Restart,RemainAfterExit,KillMode,ActiveState,SubState'],
                            capture_output=True, timeout=5, check=False)
    if result.returncode or len(result.stdout) > 8192:
        raise AdmissionError('The supervising unit is unavailable')
    pairs = [line.split('=', 1) for line in result.stdout.decode('ascii').splitlines()]
    if any(len(pair) != 2 for pair in pairs) or len({pair[0] for pair in pairs}) != len(pairs):
        raise AdmissionError('Invalid supervising unit observation')
    observed = dict(pairs)
    if observed != {'InvocationID': frame['invocationId'], 'MainPID': str(frame['processId']),
                    'Type': 'exec', 'Restart': 'no', 'RemainAfterExit': 'yes', 'KillMode': 'control-group',
                    'ActiveState': 'active', 'SubState': 'running'}:
        raise AdmissionError('The supervising invocation changed')


def worker_context():
    # Dynamic loaders need not register a module in sys.modules. Share the exact
    # admitting functions and authority objects, including their ContextVars.
    return SimpleNamespace(require_root=require_root, Admission=Admission, AdmissionError=AdmissionError,
                           WORKER=WORKER, worker_hash=worker_hash, digest=digest, P=P, A=A,
                           read_status=read_status)


def run_worker(state_dir, point):
    admission = Admission(state_dir, point)
    code_sha256 = worker_hash()
    launch, _ = admission.read('launch-intent.json', optional=True)
    expected_launch = admission.event('launch-intent', workerSha256=code_sha256, unit='orbis-core-capture-' + admission.point)
    if launch is not None:
        if launch.get('supervisionProtocol') == 2:
            expected_launch.update(supervisionProtocol=2, supervisorSha256=SUPERVISOR.source_hash(worker_context()))
        if launch != expected_launch:
            raise AdmissionError('The admitted worker source changed')
    # A partial write is also a consumed claim. Never unlink or reclaim it.
    supervision = supervision_identity(admission.point, admission)
    if launch is not None and launch.get('supervisionProtocol') == 2 and supervision.get('version') != 2:
        raise AdmissionError('The delegated worker did not establish its supervision')
    admission.create('claim.json', admission.event('claim', workerSha256=code_sha256, supervision=supervision))
    try:
        verify_supervision(admission, supervision)
        capture = BoundCapture(admission)
        with admission.lease.owner():
            if CORE.TX.APPS.digest(capture.source()) != admission.request['sourceSha256']:
                raise AdmissionError('The admitted source changed')
            admission.unchanged()
            settlement = capture.capture(admission.point, host_writers_stopped=True)
            record = capture.read(capture.base / admission.point)
            if record['settlement'] != settlement:
                raise AdmissionError('The capture settlement changed')
            artifact = CHECKPOINT.build(capture, admission.point, tx=CORE.TX)
            admission.unchanged()
            verify_supervision(admission, supervision)
            admission.create('settled.json', admission.event('settled',
                             state='resumed-awaiting-publication', settlement=settlement,
                             captureJobSha256=digest(P.canonical(record)),
                             checkpointArtifactSha256=digest(P.canonical(artifact))))
        return {'id': admission.point, 'state': 'resumed-awaiting-publication', 'settlement': settlement,
                'artifact': artifact}
    except BaseException as error:
        try:
            admission.create('failure.json', admission.event('failure', state='recovery-required',
                                                           failureClass=type(error).__name__))
        except BaseException:
            pass  # The durable claim remains the recovery hold if recording fails.
        raise


def read_status(state_dir, point):
    admission = Admission(state_dir, point)
    result = {'id': admission.point, 'state': 'reserved'}
    claim, _ = admission.read('claim.json', optional=True)
    launch, _ = admission.read('launch-intent.json', optional=True)
    if claim is None:
        return {**result, 'state': 'launch-unsettled'} if launch is not None else result
    frame = claim.get('supervision')
    expected_claim = admission.event('claim', workerSha256=claim.get('workerSha256'), supervision=frame)
    if (claim != expected_claim or not isinstance(claim['workerSha256'], str) or not HASH.fullmatch(claim['workerSha256'])
            or not isinstance(frame, dict)):
        raise AdmissionError('Invalid consumed capture claim')
    if frame.get('version') == 2:
        SUPERVISOR.validate_frame(admission, frame, worker=worker_context())
    elif (set(frame) != {'unit', 'invocationId', 'processId'}
          or frame['unit'] != 'orbis-core-capture-' + admission.point + '.service'
          or not isinstance(frame['invocationId'], str) or not re.fullmatch('[a-f0-9]{32}', frame['invocationId'])
          or type(frame['processId']) is not int or frame['processId'] <= 0):
        raise AdmissionError('Invalid consumed capture claim')
    settled, _ = admission.read('settled.json', optional=True)
    failure, _ = admission.read('failure.json', optional=True)
    if failure is None and settled is None and frame.get('version') == 2:
        try:
            SUPERVISOR.observe_worker(admission, frame, worker=worker_context())
            return {**result, 'state': 'running'}
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
            return {**result, 'state': 'recovery-required'}
    if failure is not None or settled is None:
        return {**result, 'state': 'recovery-required'}
    # Construct no HostService or capture directories for a read-only restart query.
    capture = object.__new__(CORE.CoreCapture)
    capture.root, capture.context, capture.a, capture.P = admission.root, admission.context, A, P
    capture.base = admission.state / 'time-machine-core'
    record = capture.read(admission.state / 'time-machine-core' / admission.point)
    artifact = None
    if 'checkpointArtifactSha256' in settled:
        artifact = CHECKPOINT.read_receipt(capture, admission.point, tx=CORE.TX)
    elif 'portableStorage' in record:
        raise AdmissionError('The portable capture has no settled checkpoint artifact')
    expected = admission.event('settled', state='resumed-awaiting-publication', settlement=record['settlement'],
                               captureJobSha256=digest(P.canonical(record)))
    if artifact is not None:
        expected['checkpointArtifactSha256'] = digest(P.canonical(artifact))
    if settled != expected or record['settlement']['sourceSha256'] != admission.request['sourceSha256']:
        raise AdmissionError('Invalid capture settlement authority')
    return {**result, 'state': 'resumed-awaiting-publication', 'settlement': record['settlement'],
            **({'artifact': artifact} if artifact is not None else {})}


def launch_worker(state_dir, point):
    admission = Admission(state_dir, point)
    code_sha256 = worker_hash()
    if admission.read('claim.json', optional=True)[0] is not None:
        raise AdmissionError('The capture attempt is already consumed')
    # Existing complete, partial, or lost-response intents are all non-replayable.
    admission.create('launch-intent.json', admission.event('launch-intent', workerSha256=code_sha256,
                     unit='orbis-core-capture-' + admission.point, supervisionProtocol=2,
                     supervisorSha256=SUPERVISOR.source_hash(worker_context())))
    command = ['/usr/bin/systemd-run', '--unit=orbis-core-capture-' + admission.point,
               '--property=Type=exec', '--property=Restart=no', '--property=RemainAfterExit=yes',
               '--property=KillMode=control-group', '--property=Delegate=yes', '--property=TasksAccounting=yes',
               '/usr/bin/python3', '-B', str(SUPERVISOR.SUPERVISOR), 'run', admission.point, '--state-dir', str(admission.state)]
    try:
        result = subprocess.run(command, capture_output=True, timeout=10, check=False)
        if result.returncode:
            raise RuntimeError('Launch response did not confirm supervision')
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        admission.create('launch-unknown.json', admission.event('launch-unknown', failureClass=type(error).__name__))
        return {'id': admission.point, 'state': 'launch-unsettled'}
    return {'id': admission.point, 'state': 'launch-requested'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('run', 'launch', 'status'))
    parser.add_argument('point')
    parser.add_argument('--state-dir', required=True)
    arguments = parser.parse_args()
    try:
        result = {'run': run_worker, 'launch': launch_worker, 'status': read_status}[arguments.action](
            arguments.state_dir, arguments.point)
        # Status contains public binding hashes only; authority receipts stay private.
        print(P.canonical(result).decode())
        return 0
    except BaseException as error:
        print(type(error).__name__, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
