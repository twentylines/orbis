"""Settle a positively denied capture on its original live, held controller.

Only complete markers and affirmative producer-terminal/queue-ready witnesses are
supported. Abort intent, missing files and dead processes never release a hold.
"""
import importlib.util
import os
from pathlib import Path
import re
import stat


SPEC = importlib.util.spec_from_file_location('orbis_abort_retirement', Path(__file__).with_name('orbis-host-core-capture-retirement.py'))
RETIRE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RETIRE)
SCHEMA = 'orbis.core-capture-abort-commit.v1'
NAMES = ('device', 'inode', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs')
STAT = RETIRE.STAT_FIELDS + ('st_ctime_ns',)
QUEUES = {'app-events-queue', 'repo-queue', 'system-events-queue'}
HASH = re.compile('[a-f0-9]{64}')
RECORDS = {'preparation.json', 'point-reservation.json', 'decision.json', 'abort-terminal.json',
           'abort-approval.json', 'abort-continuation.json', 'abort-commit.json', 'abort-source-retired.json'}
REQUEST = {'preparationSha256', 'decisionSha256', 'terminalSha256'}
COMMIT_HASHES = REQUEST | {'approvalSha256', 'continuationSha256', 'leaseSha256', 'sourceHoldSha256',
                         'pointReservationSha256', 'sourceRetirementSha256'}


class AbortError(ValueError):
    pass


def hashes(value, keys):
    return all(isinstance(value.get(key), str) and HASH.fullmatch(value[key]) for key in keys)


def identity(info):
    return dict(zip(NAMES, (str(getattr(info, key)) for key in STAT)))


def same_file(first, second):
    return first[:2] == second[:2] and identity(first[2]) == identity(second[2])


def checked_identity(value, owner, *, decimal=True):
    if not isinstance(value, dict) or set(value) != set(NAMES):
        raise AbortError('Invalid abort filesystem identity')
    for item in value.values():
        if decimal:
            if not isinstance(item, str) or not re.fullmatch(r'0|[1-9][0-9]{0,19}', item):
                raise AbortError('Invalid canonical abort filesystem integer')
        elif type(item) is not int:
            raise AbortError('Invalid abort filesystem integer')
        if not 0 <= int(item) <= 2 ** 64 - 1:
            raise AbortError('Invalid abort filesystem integer range')
    result = {key: int(item) for key, item in value.items()}
    if (not stat.S_ISREG(result['mode']) or stat.S_IMODE(result['mode']) != 0o600
            or result['uid'] != owner or result['nlink'] != 1 or not 0 < result['size'] <= 8192):
        raise AbortError('Abort evidence is not a protected private file')
    return result


class Records:
    allowed_names = RECORDS

    def __init__(self, worker, manager, point):
        worker.require_root()
        self.W, self.A, self.P = worker, worker.A, worker.P
        self.root, self.context, self.point = Path(manager.root), manager.context, worker.identifier(point)
        self.state = Path(manager.state)
        self.directory = self.state / 'core-capture-preparations' / self.point
        self.identities, self.seals = {}, {}
        for path in (self.state, self.directory.parent, self.directory):
            with self.A.protected_directory(path) as fd:
                self.identities[path] = RETIRE.directory_identity(os.fstat(fd))

    def read(self, name, *, optional=False):
        if name not in self.allowed_names:
            raise AbortError('Unknown fixed abort authority record')
        for path, expected in self.identities.items():
            with self.A.protected_directory(path) as fd:
                if RETIRE.directory_identity(os.fstat(fd)) != expected:
                    raise AbortError('The abort authority directory changed')
        with self.A.protected_directory(self.directory) as fd:
            if optional:
                try:
                    os.stat(name, dir_fd=fd, follow_symlinks=False)
                except FileNotFoundError:
                    return None, None
            with self.A.protected_file(fd, name, 65536) as body:
                value = self.P.metadata(body, byte_limit=65536)
                seal = self.A.seal(os.stat(name, dir_fd=fd, follow_symlinks=False))
                if not isinstance(value, dict) or self.P.canonical(value) != body:
                    raise AbortError('Noncanonical abort authority')
                if name in self.seals and self.seals[name] != seal:
                    raise AbortError('The protected abort authority changed')
                self.seals[name] = seal
                return value, body

    def persist(self, name, value):
        if name not in self.allowed_names - {'preparation.json', 'point-reservation.json', 'decision.json'}:
            raise AbortError('Abort cannot overwrite reservation authority')
        existing, body = self.read(name, optional=True)
        encoded = self.P.canonical(value)
        if existing is not None:
            if body != encoded:
                raise AbortError('An earlier immutable abort record differs')
            return
        with self.A.protected_directory(self.directory) as checked:
            parent = os.dup(checked)
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                with os.fdopen(fd, 'wb', closefd=False) as output:
                    output.write(encoded)
                    output.flush()
                    os.fsync(fd)
                os.fsync(parent)
            finally:
                os.close(fd)
        finally:
            os.close(parent)
        if self.read(name)[1] != encoded:
            raise AbortError('The immutable abort record did not persist')


def base_evidence(worker, read, root, context, point):
    preparation, body = read('preparation.json')
    if (set(preparation) != worker.RESERVED.FIELDS or preparation.get('schema') != worker.RESERVED.SCHEMA
            or preparation.get('id') != point or preparation.get('root') != str(root)
            or preparation.get('context') != context or preparation.get('scope') != worker.CORE.SCOPE
            or not hashes(preparation, {'sourceSha256', 'pointReservationSha256', 'leaseNonce', 'leaseSha256'})):
        raise AbortError('Only the exact reserved preparation can authorize abort settlement')
    checked_identity(preparation['leaseIdentity'], worker.A.OWNER, decimal=False)
    frame = preparation['controller']
    if (not isinstance(frame, dict) or set(frame) != {'id', 'imageId', 'startedAt', 'definitionSha256'}
            or not hashes(frame, {'id', 'definitionSha256'}) or not isinstance(frame['imageId'], str)
            or not re.fullmatch('sha256:[a-f0-9]{64}', frame['imageId'])
            or not isinstance(frame['startedAt'], str) or not re.fullmatch(r'[\x20-\x7e]{1,128}', frame['startedAt'])):
        raise AbortError('Invalid original abort controller frame')
    preparation_sha = worker.digest(body)
    reservation, reservation_body = read('point-reservation.json')
    if worker.digest(reservation_body) != preparation['pointReservationSha256']:
        raise AbortError('The aborted saved-point reservation changed')
    expected_decision = {'schema': worker.RESERVED.DECISION, 'id': point, 'root': str(root), 'context': context,
        'preparationSha256': preparation_sha, 'decision': 'abort',
        **{key: preparation[key] for key in ('leaseNonce', 'leaseSha256', 'sourceSha256', 'pointReservationSha256')}}
    decision, decision_body = read('decision.json')
    if decision != expected_decision:
        raise AbortError('There is no exact positive abort decision')
    lease = {'schema': 'orbis.core-capture-lease.v1', 'id': point, 'root': str(root), 'context': context,
             'nonce': preparation['leaseNonce'], 'sourceSha256': preparation['sourceSha256']}
    if worker.digest(worker.P.canonical(lease)) != preparation['leaseSha256']:
        raise AbortError('The original abort lease bytes changed')
    return preparation, preparation_sha, worker.digest(decision_body), lease


def terminal_evidence(worker, terminal, preparation, preparation_sha, decision_sha):
    keys = {'schema', 'id', 'preparationSha256', 'decisionSha256', 'sourceHoldSha256', 'pointReservationSha256',
            'controller', 'queueGeneration', 'sourceHoldIdentity'}
    if (set(terminal) != keys or terminal.get('schema') != 'orbis.core-capture-source-abort-terminal.v1'
            or terminal.get('id') != preparation['id'] or terminal.get('preparationSha256') != preparation_sha
            or terminal.get('decisionSha256') != decision_sha or not hashes(terminal, {'sourceHoldSha256'})
            or terminal.get('pointReservationSha256') != preparation['pointReservationSha256']
            or terminal.get('controller') != preparation['controller'] or type(terminal.get('queueGeneration')) is not int
            or not 1 <= terminal['queueGeneration'] <= 9007199254740991):
        raise AbortError('The source has no exact positive abort terminal witness')
    checked_identity(terminal['sourceHoldIdentity'], worker.A.OWNER)


def approval_evidence(worker, read, root, context, point):
    preparation, preparation_sha, decision_sha, lease = base_evidence(worker, read, root, context, point)
    terminal, terminal_body = read('abort-terminal.json')
    terminal_evidence(worker, terminal, preparation, preparation_sha, decision_sha)
    approval, approval_body = read('abort-approval.json')
    expected = {'schema': 'orbis.core-capture-abort-approval.v1', 'id': point, 'root': str(root), 'context': context,
        'preparationSha256': preparation_sha, 'decisionSha256': decision_sha, 'terminalSha256': worker.digest(terminal_body),
        'sourceSha256': preparation['sourceSha256'], 'sourceHoldSha256': terminal['sourceHoldSha256'],
        'pointReservationSha256': preparation['pointReservationSha256'], 'controller': preparation['controller'],
        'queueGeneration': terminal['queueGeneration'], 'leaseNonce': preparation['leaseNonce'],
        'leaseSha256': preparation['leaseSha256'], 'leaseIdentity': preparation['leaseIdentity'],
        'sourceHoldIdentity': terminal['sourceHoldIdentity'], 'sourceTerminalIdentity': approval.get('sourceTerminalIdentity')}
    if approval != expected:
        raise AbortError('The immutable abort approval differs from its original evidence')
    checked_identity(approval['sourceTerminalIdentity'], worker.A.OWNER)
    checked_identity(approval['leaseIdentity'], worker.A.OWNER, decimal=False)
    if type(approval['queueGeneration']) is not int:
        raise AbortError('Invalid approved queue generation')
    return preparation, approval, worker.digest(approval_body), terminal, lease


def continuation_evidence(worker, value, approval, approval_sha):
    keys = {'schema', 'id', 'preparationSha256', 'decisionSha256', 'terminalSha256', 'approvalSha256',
            'sourceHoldSha256', 'pointReservationSha256', 'controller', 'queueGeneration', 'queues'}
    if (set(value) != keys or value.get('schema') != 'orbis.core-capture-source-abort-continuation.v1'
            or any(value.get(key) != approval[key] for key in keys - {'schema', 'approvalSha256', 'queues'})
            or value.get('approvalSha256') != approval_sha or not isinstance(value.get('queues'), list)
            or type(value.get('queueGeneration')) is not int
            or len(value['queues']) != 3):
        raise AbortError('The source has no exact abort continuation witness')
    seen = set()
    for queue in value['queues']:
        if (not isinstance(queue, dict) or set(queue) != {'name', 'messages', 'consumers'}
                or not isinstance(queue.get('name'), str) or queue['name'] not in QUEUES or queue['name'] in seen
                or type(queue['messages']) is not int or queue['messages'] != 0
                or type(queue['consumers']) is not int or queue['consumers'] != 1):
            raise AbortError('The abort continuation does not cover all three consumers')
        seen.add(queue['name'])


def expected_source_witness(approval):
    return {'schema': 'orbis.core-capture-source-retirement.v1', 'id': approval['id'],
            'sourceHoldSha256': approval['sourceHoldSha256'], 'controller': approval['controller'],
            'retiredIdentity': dict(zip(RETIRE.STAT_FIELDS, (int(approval['sourceHoldIdentity'][name]) for name in NAMES[:-1])))}


def commit_evidence(worker, read, root, context, point, *, source_retired):
    preparation, approval, approval_sha, terminal, lease = approval_evidence(worker, read, root, context, point)
    ready, ready_body = read('abort-continuation.json')
    continuation_evidence(worker, ready, approval, approval_sha)
    witness = expected_source_witness(approval)
    commit, commit_body = read('abort-commit.json')
    expected = {'schema': SCHEMA, 'id': point, 'root': str(root), 'context': context,
        **{key: approval[key] for key in REQUEST | {'sourceHoldSha256', 'pointReservationSha256', 'leaseSha256'}},
        'approvalSha256': approval_sha, 'continuationSha256': worker.digest(ready_body),
        'leaseIdentity': {key: preparation['leaseIdentity'][key] for key in NAMES[:-1]},
        'sourceContinuationIdentity': commit.get('sourceContinuationIdentity'),
        'sourceRetirementSha256': worker.digest(worker.P.canonical(witness))}
    if (commit != expected or not hashes(commit, COMMIT_HASHES)
            or not isinstance(commit.get('leaseIdentity'), dict)
            or any(type(value) is not int for value in commit['leaseIdentity'].values())):
        raise AbortError('The abort commit differs from its protected positive evidence')
    checked_identity(commit['sourceContinuationIdentity'], worker.A.OWNER)
    if source_retired:
        retired, _ = read('abort-source-retired.json')
        namespace = retired.get('namespace')
        if (not isinstance(namespace, dict) or not isinstance(namespace.get('retiredIdentity'), dict)
                or any(type(value) is not int for value in namespace['retiredIdentity'].values())):
            raise AbortError('Invalid positive source retirement identity')
        if retired != {'schema': 'orbis.core-capture-abort-source-retired.v1', 'id': point,
                       'abortCommitSha256': worker.digest(commit_body), 'namespace': witness}:
            raise AbortError('The committed original source marker has no matching preserved retirement')
    return commit, approval, approval_sha, lease


class AbortRetirement(RETIRE.CaptureRetirement):
    def authority_directory(self):
        return self.state / 'core-capture-preparations' / self.point

    def _authority(self):
        self.W.require_root()
        commit, _, _, lease = commit_evidence(self.W, self._read, self.root, self.context, self.point, source_retired=True)
        return commit, lease, self.P.canonical(lease)


class CoreCaptureAbort:
    def __init__(self, manager, worker):
        self.manager, self.W = manager, worker
        self.H = worker.CORE.HOST
        self.namespace = worker.load('orbis-host-core-capture-namespace.py', 'abort_namespace')

    def validate_request(self, point, request, *, finish=False, intent=False):
        self.W.require_root()
        self.W.identifier(point)
        keys = {'preparationSha256'} if intent else REQUEST | ({'approvalSha256', 'continuationSha256'} if finish else set())
        if not isinstance(request, dict) or set(request) != keys or not hashes(request, keys):
            raise AbortError('Invalid fixed abort request')

    @staticmethod
    def details(approval, approval_sha, *, continuation=None):
        result = {'version': 1, 'id': approval['id'],
            'state': 'complete' if continuation else 'verified-abort-awaiting-continuation',
            **{key: approval[key] for key in REQUEST | {'sourceSha256', 'sourceHoldSha256', 'pointReservationSha256', 'controller'}},
            'approvalSha256': approval_sha}
        if continuation:
            result['continuationSha256'] = continuation
        return result

    def records(self, point):
        return Records(self.W, self.manager, point)

    def authority(self, point, request):
        manager, worker = self.manager, self.W
        authority = worker.RESERVED.ReservedPreparation(worker, manager.state, manager.root, manager.context, point)
        _, body = authority.decision('abort')
        if (request['preparationSha256'] != authority.preparation_sha256
                or ('decisionSha256' in request and request['decisionSha256'] != worker.digest(body))):
            raise AbortError('The abort request differs from its exact reserved decision')
        return authority

    def intent_status(self, point, request):
        self.validate_request(point, request, intent=True)
        with self.manager.service.lock:
            authority = self.authority(point, request)
            with authority.lease().owner(), self.H.host_lock(self.manager.root):
                _, body = authority.decision('abort')
                return {'version': 1, 'id': point, 'state': 'abort-intent',
                        'preparationSha256': authority.preparation_sha256, 'decisionSha256': self.W.digest(body)}

    def source(self, point, authority, reader, namespace, *, committed=False):
        worker, manager = self.W, self.manager
        manager.require_reserved_source(reader, point, authority)
        terminal, terminal_body, terminal_info = namespace.read_abort_terminal(point)
        preparation = authority.preparation
        _, decision_body = authority.decision('abort')
        terminal_evidence(worker, terminal, preparation, authority.preparation_sha256, worker.digest(decision_body))
        retired = False
        try:
            hold, hold_body, hold_info = namespace.read_source_hold(point)
        except FileNotFoundError:
            if not committed:
                raise AbortError('A complete original source marker is required')
            hold, hold_body, hold_info = namespace.read_source_hold(point, retired=True)
            retired = True
        manager.source_hold(hold_body, preparation)
        if (worker.digest(hold_body) != terminal['sourceHoldSha256']
                or hold['queueDrain']['generation'] != terminal['queueGeneration']
                or any(identity(hold_info)[key] != terminal['sourceHoldIdentity'][key]
                       for key in (NAMES[:-1] if retired else NAMES))):
            raise AbortError('The original complete source marker or its inode changed')
        return terminal, terminal_body, terminal_info

    def _prepare(self, point, request, records, *, persist):
        worker, manager = self.W, self.manager
        if records.read('abort-commit.json', optional=True)[0] is not None:
            raise AbortError('Abort settlement is committed; inspect its positive status')
        if records.read('abort-approval.json', optional=True)[0] is not None:
            approval_evidence(worker, records.read, manager.root, manager.context, point)
        authority = self.authority(point, request)
        with authority.lease().owner(), self.H.host_lock(manager.root) as descriptor:
            if persist:
                manager.require_owned_idle_core()
            reader = worker.CORE.TX.APPS.Docker(manager.context)
            reader.lock_fd = descriptor
            with self.namespace.CaptureNamespace(worker, reader, authority.preparation['controller']) as namespace:
                terminal, terminal_body, terminal_info = self.source(point, authority, reader, namespace)
                if worker.digest(terminal_body) != request['terminalSha256']:
                    raise AbortError('The requested source terminal witness changed')
                preparation = authority.preparation
                approval = {'schema': 'orbis.core-capture-abort-approval.v1', 'id': point,
                    'root': str(manager.root), 'context': manager.context, **request,
                    'sourceSha256': preparation['sourceSha256'], 'sourceHoldSha256': terminal['sourceHoldSha256'],
                    'pointReservationSha256': preparation['pointReservationSha256'], 'controller': preparation['controller'],
                    'queueGeneration': terminal['queueGeneration'], 'leaseNonce': preparation['leaseNonce'],
                    'leaseSha256': preparation['leaseSha256'], 'leaseIdentity': preparation['leaseIdentity'],
                    'sourceHoldIdentity': terminal['sourceHoldIdentity'], 'sourceTerminalIdentity': identity(terminal_info)}
                if persist:
                    records.persist('abort-terminal.json', terminal)
                    records.persist('abort-approval.json', approval)
                elif records.read('abort-approval.json')[0] != approval:
                    raise AbortError('The protected abort approval changed')
                _, protected, approval_sha, _, _ = approval_evidence(worker, records.read, manager.root, manager.context, point)
                if protected != approval or not same_file(self.source(point, authority, reader, namespace), (terminal, terminal_body, terminal_info)):
                    raise AbortError('The source terminal evidence changed before abort approval')
                return self.details(approval, approval_sha)

    def prepare(self, point, request):
        self.validate_request(point, request)
        with self.manager.service.lock:
            return self._prepare(point, request, self.records(point), persist=True)

    def completed(self, point, request, records):
        commit, approval, approval_sha, _ = commit_evidence(self.W, records.read, self.manager.root,
                                                          self.manager.context, point, source_retired=True)
        if any(request[key] != commit[key] for key in request):
            raise AbortError('The historical abort differs from this request')
        retirement = AbortRetirement(self.W, self.manager.state, self.manager.root, self.manager.context, point)
        retirement.inspect_retired()
        return self.details(approval, approval_sha, continuation=commit['continuationSha256'])

    def status(self, point, request):
        self.validate_request(point, request)
        with self.manager.service.lock:
            records = self.records(point)
            if records.read('abort-commit.json', optional=True)[0] is not None:
                return self.completed(point, request, records)
            return self._prepare(point, request, records, persist=False)

    def finish(self, point, request):
        self.validate_request(point, request, finish=True)
        worker, manager = self.W, self.manager
        with manager.service.lock:
            records = self.records(point)
            committed = records.read('abort-commit.json', optional=True)[0] is not None
            if committed:
                commit, approval, approval_sha, _ = commit_evidence(worker, records.read, manager.root, manager.context,
                                                                  point, source_retired=False)
                if any(request[key] != commit[key] for key in request):
                    raise AbortError('The committed abort differs from this continuation')
                if records.read('abort-source-retired.json', optional=True)[0] is not None:
                    try:
                        manager.service.require_idle_core()
                        return self.completed(point, request, records)
                    except FileNotFoundError:
                        # Reconciliation is for the still-live committed lease,
                        # not for missing private authority or preserved evidence.
                        commit_evidence(worker, records.read, manager.root, manager.context, point, source_retired=True)
                        target = self.H.capture_fence_path(manager.root)
                        target = target.with_name(target.name + '.retired-' + point)
                        try:
                            target.lstat()
                        except FileNotFoundError:
                            pass
                        else:
                            raise AbortError('A missing abort authority record cannot authorize reconciliation')
            else:
                _, approval, approval_sha, _, _ = approval_evidence(worker, records.read, manager.root, manager.context, point)
                if any(request[key] != approval[key] for key in REQUEST) or request['approvalSha256'] != approval_sha:
                    raise AbortError('There is no matching positive root abort approval')
            authority = self.authority(point, request)
            with authority.lease().owner(), self.H.host_lock(manager.root) as descriptor:
                manager.require_owned_idle_core()
                reader = worker.CORE.TX.APPS.Docker(manager.context)
                reader.lock_fd = descriptor
                with self.namespace.CaptureNamespace(worker, reader, approval['controller']) as namespace:
                    terminal, terminal_body, terminal_info = self.source(point, authority, reader, namespace, committed=committed)
                    if (worker.digest(terminal_body) != approval['terminalSha256']
                            or identity(terminal_info) != approval['sourceTerminalIdentity']):
                        raise AbortError('The approved original source terminal inode changed')
                    ready, ready_body, ready_info = namespace.read_abort_continuation(point)
                    continuation_evidence(worker, ready, approval, approval_sha)
                    if worker.digest(ready_body) != request['continuationSha256']:
                        raise AbortError('The requested abort continuation changed')
                    if committed and identity(ready_info) != commit['sourceContinuationIdentity']:
                        raise AbortError('The committed source continuation inode changed')
                    records.persist('abort-continuation.json', ready)
                    expected = {'schema': SCHEMA, 'id': point, 'root': str(manager.root), 'context': manager.context,
                        **{key: approval[key] for key in REQUEST | {'sourceHoldSha256', 'pointReservationSha256', 'leaseSha256'}},
                        'approvalSha256': approval_sha, 'continuationSha256': worker.digest(ready_body),
                        'leaseIdentity': {key: authority.preparation['leaseIdentity'][key] for key in NAMES[:-1]},
                        'sourceContinuationIdentity': identity(ready_info),
                        'sourceRetirementSha256': worker.digest(worker.P.canonical(expected_source_witness(approval)))}
                    if (not same_file(namespace.read_abort_continuation(point), (ready, ready_body, ready_info))
                            or not same_file(self.source(point, authority, reader, namespace, committed=committed), (terminal, terminal_body, terminal_info))):
                        raise AbortError('The abort continuation changed before its durable commit')
                    records.persist('abort-commit.json', expected)
                    commit_evidence(worker, records.read, manager.root, manager.context, point, source_retired=False)
                    witness = namespace.retire_hold(point, approval['sourceHoldSha256'], identity=approval['sourceHoldIdentity'])
                    if witness != expected_source_witness(approval):
                        raise AbortError('The original source marker was not preserved')
                    records.persist('abort-source-retired.json', {'schema': 'orbis.core-capture-abort-source-retired.v1',
                        'id': point, 'abortCommitSha256': worker.digest(worker.P.canonical(expected)), 'namespace': witness})
                    AbortRetirement(worker, manager.state, manager.root, manager.context, point).retire_committed()
            return self.completed(point, request, records)
