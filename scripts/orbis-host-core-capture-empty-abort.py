"""Settle only a positive, live source attempt that never attempted a marker.

Namespace absence is a consistency check. Preparation, a positive abort decision,
and affirmative retained-drain terminal/continuation witnesses remain mandatory.
"""
import importlib.util
import os
from pathlib import Path
import stat


SPEC = importlib.util.spec_from_file_location('orbis_empty_abort_shared', Path(__file__).with_name('orbis-host-core-capture-abort.py'))
BASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASE)
AbortError = BASE.AbortError
SCHEMA = 'orbis.core-capture-abort-commit.v2'
REQUEST = BASE.REQUEST
AUDIT = {'operatorAuthorizationId', 'drainReservationId', 'queueGeneration', 'queues'}
COMMIT_HASHES = REQUEST | {'approvalSha256', 'continuationSha256', 'leaseSha256',
                         'pointReservationSha256', 'sourceSettlementSha256'}
AUTHORITY_FILES = ('preparation.json', 'point-reservation.json', 'decision.json', 'abort-terminal.json',
                   'abort-approval.json', 'abort-continuation.json', 'abort-commit.json', 'abort-source-settled.json')


class EmptyRecords(BASE.Records):
    allowed_names = BASE.Records.allowed_names | {'abort-source-settled.json'}


def durable_records(records):
    """Reconcile an exact record after an earlier file/directory sync failed."""
    for name in AUTHORITY_FILES:
        expected = records.read(name)[1]
        with records.A.protected_directory(records.directory) as parent:
            with records.A.protected_file(parent, name, 65536) as body:
                if body != expected:
                    raise AbortError('The early-abort authority changed before durable settlement')
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    before = records.A.seal(os.stat(name, dir_fd=parent, follow_symlinks=False))
                    if records.A.seal(os.fstat(fd)) != before:
                        raise AbortError('The pinned early-abort authority inode changed')
                    os.fsync(fd)
                    if records.A.seal(os.fstat(fd)) != before:
                        raise AbortError('The early-abort authority changed while syncing')
                finally:
                    os.close(fd)
            os.fsync(parent)


def queues(value, consumers):
    if not isinstance(value, list) or len(value) != 3:
        raise AbortError('The early abort does not cover all three retained queues')
    seen = set()
    for queue in value:
        if (not isinstance(queue, dict) or set(queue) != {'name', 'messages', 'consumers'}
                or not isinstance(queue.get('name'), str) or queue['name'] not in BASE.QUEUES or queue['name'] in seen
                or type(queue['messages']) is not int or queue['messages'] != 0
                or type(queue['consumers']) is not int or queue['consumers'] != consumers):
            raise AbortError('Invalid early abort queue readiness')
        seen.add(queue['name'])


def terminal_evidence(worker, terminal, preparation, preparation_sha, decision_sha):
    keys = {'schema', 'id', 'preparationSha256', 'decisionSha256', 'pointReservationSha256',
            'controller', 'sourceMarker'} | AUDIT
    if (set(terminal) != keys or terminal.get('schema') != 'orbis.core-capture-source-abort-terminal.v2'
            or terminal.get('sourceMarker') != 'absent' or terminal.get('id') != preparation['id']
            or terminal.get('preparationSha256') != preparation_sha or terminal.get('decisionSha256') != decision_sha
            or terminal.get('pointReservationSha256') != preparation['pointReservationSha256']
            or terminal.get('controller') != preparation['controller']
            or type(terminal.get('queueGeneration')) is not int or not 1 <= terminal['queueGeneration'] <= 9007199254740991):
        raise AbortError('There is no positive never-attempted-marker source terminal')
    worker.identifier(terminal['operatorAuthorizationId'])
    worker.identifier(terminal['drainReservationId'])
    queues(terminal['queues'], 0)


def absence_evidence(worker, value, point, controller):
    if (not isinstance(value, dict) or set(value) != {'schema', 'id', 'controller', 'directoryIdentity'}
            or value.get('schema') != 'orbis.core-capture-marker-absence.v1' or value.get('id') != point
            or value.get('controller') != controller):
        raise AbortError('Invalid pinned source marker consistency observation')
    pinned = value['directoryIdentity']
    fields = {'st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid'}
    if (not isinstance(pinned, dict) or set(pinned) != fields
            or any(type(item) is not int or not 0 <= item <= 2 ** 64 - 1 for item in pinned.values())
            or not stat.S_ISDIR(pinned['st_mode']) or stat.S_IMODE(pinned['st_mode']) != 0o700
            or pinned['st_uid'] != worker.A.OWNER):
        raise AbortError('The pinned source marker directory is not private')


def approval_evidence(worker, read, root, context, point):
    preparation, preparation_sha, decision_sha, lease = BASE.base_evidence(worker, read, root, context, point)
    terminal, terminal_body = read('abort-terminal.json')
    terminal_evidence(worker, terminal, preparation, preparation_sha, decision_sha)
    approval, approval_body = read('abort-approval.json')
    expected = {'schema': 'orbis.core-capture-abort-approval.v2', 'id': point, 'root': str(root), 'context': context,
        'preparationSha256': preparation_sha, 'decisionSha256': decision_sha, 'terminalSha256': worker.digest(terminal_body),
        'sourceSha256': preparation['sourceSha256'], 'pointReservationSha256': preparation['pointReservationSha256'],
        'controller': preparation['controller'], 'sourceMarker': 'absent',
        **{key: terminal[key] for key in AUDIT}, 'leaseNonce': preparation['leaseNonce'],
        'leaseSha256': preparation['leaseSha256'], 'leaseIdentity': preparation['leaseIdentity'],
        'sourceTerminalIdentity': approval.get('sourceTerminalIdentity'), 'namespace': approval.get('namespace')}
    if approval != expected or type(approval['queueGeneration']) is not int:
        raise AbortError('The protected early-abort approval differs from its positive terminal')
    queues(approval['queues'], 0)
    BASE.checked_identity(approval['leaseIdentity'], worker.A.OWNER, decimal=False)
    BASE.checked_identity(approval['sourceTerminalIdentity'], worker.A.OWNER)
    absence_evidence(worker, approval['namespace'], point, preparation['controller'])
    return preparation, approval, worker.digest(approval_body), terminal, lease


def continuation_evidence(worker, value, approval, approval_sha):
    keys = {'schema', 'id', 'preparationSha256', 'decisionSha256', 'terminalSha256', 'approvalSha256',
            'pointReservationSha256', 'controller', 'queueGeneration', 'queues', 'sourceMarker'}
    if (set(value) != keys or value.get('schema') != 'orbis.core-capture-source-abort-continuation.v2'
            or any(value.get(key) != approval[key] for key in keys - {'schema', 'approvalSha256', 'queues'})
            or value.get('approvalSha256') != approval_sha or type(value.get('queueGeneration')) is not int):
        raise AbortError('There is no exact never-attempted-marker continuation')
    queues(value['queues'], 1)


def commit_evidence(worker, read, root, context, point, *, source_settled):
    preparation, approval, approval_sha, terminal, lease = approval_evidence(worker, read, root, context, point)
    ready, ready_body = read('abort-continuation.json')
    continuation_evidence(worker, ready, approval, approval_sha)
    commit, commit_body = read('abort-commit.json')
    expected = {'schema': SCHEMA, 'id': point, 'root': str(root), 'context': context, 'sourceMarker': 'absent',
        **{key: approval[key] for key in REQUEST | {'pointReservationSha256', 'leaseSha256'}},
        'approvalSha256': approval_sha, 'continuationSha256': worker.digest(ready_body),
        'leaseIdentity': {key: preparation['leaseIdentity'][key] for key in BASE.NAMES[:-1]},
        'sourceTerminalIdentity': approval['sourceTerminalIdentity'],
        'sourceContinuationIdentity': commit.get('sourceContinuationIdentity'),
        'sourceSettlementSha256': worker.digest(worker.P.canonical(approval['namespace']))}
    if (commit != expected or not BASE.hashes(commit, COMMIT_HASHES)
            or not isinstance(commit.get('leaseIdentity'), dict)
            or any(type(value) is not int for value in commit['leaseIdentity'].values())):
        raise AbortError('The early-abort commit differs from its protected positive witnesses')
    BASE.checked_identity(commit['sourceTerminalIdentity'], worker.A.OWNER)
    BASE.checked_identity(commit['sourceContinuationIdentity'], worker.A.OWNER)
    if source_settled:
        settled, _ = read('abort-source-settled.json')
        if settled != {'schema': 'orbis.core-capture-abort-source-settled.v2', 'id': point,
                       'abortCommitSha256': worker.digest(commit_body), 'namespace': approval['namespace']}:
            raise AbortError('There is no exact committed source-settlement witness')
        absence_evidence(worker, settled['namespace'], point, preparation['controller'])
    return commit, approval, approval_sha, lease


class EmptyAbortRetirement(BASE.RETIRE.CaptureRetirement):
    def __init__(self, worker, state, root, context, point, *, namespace=None):
        self.live_namespace = namespace
        super().__init__(worker, state, root, context, point)

    def authority_directory(self):
        return self.state / 'core-capture-preparations' / self.point

    def _authority(self):
        self.W.require_root()
        commit, _, _, lease = commit_evidence(self.W, self._read, self.root, self.context, self.point, source_settled=True)
        return commit, lease, self.P.canonical(lease)

    def _lease(self, parent, name, commit, expected_body):
        if self.live_namespace is not None:
            approval, _ = self._read('abort-approval.json')
            if self.live_namespace.verify_no_source_hold(self.point) != approval['namespace']:
                raise AbortError('A source marker or namespace change forbids global lease retirement')
        return super()._lease(parent, name, commit, expected_body)

    def retire_committed(self):
        if self.live_namespace is None:
            raise AbortError('Live early-abort cleanup requires its pinned original source namespace')
        return super().retire_committed()


class CoreCaptureEmptyAbort(BASE.CoreCaptureAbort):
    def records(self, point):
        return EmptyRecords(self.W, self.manager, point)

    @staticmethod
    def details(approval, approval_sha, *, continuation=None):
        result = {'version': 2, 'id': approval['id'], 'sourceMarker': 'absent',
            'state': 'complete' if continuation else 'verified-abort-awaiting-continuation',
            **{key: approval[key] for key in REQUEST | {'sourceSha256', 'pointReservationSha256', 'controller'}},
            'approvalSha256': approval_sha}
        if continuation:
            result['continuationSha256'] = continuation
        return result

    def source(self, point, authority, reader, namespace):
        manager, worker = self.manager, self.W
        manager.require_reserved_source(reader, point, authority)
        terminal = namespace.read_abort_terminal(point)
        _, decision_body = authority.decision('abort')
        terminal_evidence(worker, terminal[0], authority.preparation, authority.preparation_sha256, worker.digest(decision_body))
        observed = namespace.verify_no_source_hold(point)
        absence_evidence(worker, observed, point, authority.preparation['controller'])
        return terminal, observed

    def _prepare(self, point, request, records, *, persist):
        worker, manager = self.W, self.manager
        if records.read('abort-commit.json', optional=True)[0] is not None:
            raise AbortError('Early abort settlement is committed; inspect its positive status')
        if records.read('abort-approval.json', optional=True)[0] is not None:
            approval_evidence(worker, records.read, manager.root, manager.context, point)
        authority = self.authority(point, request)
        with authority.lease().owner(), self.H.host_lock(manager.root) as descriptor:
            if persist:
                manager.require_owned_idle_core()
            reader = worker.CORE.TX.APPS.Docker(manager.context)
            reader.lock_fd = descriptor
            with self.namespace.CaptureNamespace(worker, reader, authority.preparation['controller']) as namespace:
                terminal, observed = self.source(point, authority, reader, namespace)
                value, body, info = terminal
                if worker.digest(body) != request['terminalSha256']:
                    raise AbortError('The early-abort source terminal changed')
                preparation = authority.preparation
                approval = {'schema': 'orbis.core-capture-abort-approval.v2', 'id': point,
                    'root': str(manager.root), 'context': manager.context, **request,
                    'sourceSha256': preparation['sourceSha256'], 'pointReservationSha256': preparation['pointReservationSha256'],
                    'controller': preparation['controller'], 'sourceMarker': 'absent', **{key: value[key] for key in AUDIT},
                    'leaseNonce': preparation['leaseNonce'], 'leaseSha256': preparation['leaseSha256'],
                    'leaseIdentity': preparation['leaseIdentity'], 'sourceTerminalIdentity': BASE.identity(info), 'namespace': observed}
                if persist:
                    records.persist('abort-terminal.json', value)
                    records.persist('abort-approval.json', approval)
                elif records.read('abort-approval.json')[0] != approval:
                    raise AbortError('The protected early-abort approval changed')
                _, protected, approval_sha, _, _ = approval_evidence(worker, records.read, manager.root, manager.context, point)
                fresh, fresh_observed = self.source(point, authority, reader, namespace)
                if protected != approval or not BASE.same_file(fresh, terminal) or fresh_observed != observed:
                    raise AbortError('The positive early-abort source witnesses changed before approval')
                return self.details(approval, approval_sha)

    def completed(self, point, request, records):
        commit, approval, approval_sha, _ = commit_evidence(self.W, records.read, self.manager.root,
                                                          self.manager.context, point, source_settled=True)
        if any(request[key] != commit[key] for key in request):
            raise AbortError('The historical early abort differs from this request')
        EmptyAbortRetirement(self.W, self.manager.state, self.manager.root, self.manager.context, point).inspect_retired()
        return self.details(approval, approval_sha, continuation=commit['continuationSha256'])

    def finish(self, point, request):
        self.validate_request(point, request, finish=True)
        worker, manager = self.W, self.manager
        with manager.service.lock:
            records = self.records(point)
            committed = records.read('abort-commit.json', optional=True)[0] is not None
            if committed:
                commit, approval, approval_sha, _ = commit_evidence(worker, records.read, manager.root, manager.context,
                                                                  point, source_settled=False)
                if any(request[key] != commit[key] for key in request):
                    raise AbortError('The committed early abort differs from this continuation')
                if records.read('abort-source-settled.json', optional=True)[0] is not None:
                    try:
                        manager.service.require_idle_core()
                        return self.completed(point, request, records)
                    except FileNotFoundError:
                        commit_evidence(worker, records.read, manager.root, manager.context, point, source_settled=True)
                        target = self.H.capture_fence_path(manager.root)
                        target = target.with_name(target.name + '.retired-' + point)
                        try:
                            target.lstat()
                        except FileNotFoundError:
                            pass
                        else:
                            raise AbortError('Missing early-abort authority cannot authorize reconciliation')
            else:
                _, approval, approval_sha, _, _ = approval_evidence(worker, records.read, manager.root, manager.context, point)
                if any(request[key] != approval[key] for key in REQUEST) or request['approvalSha256'] != approval_sha:
                    raise AbortError('There is no matching positive root early-abort approval')
            authority = self.authority(point, request)
            with authority.lease().owner(), self.H.host_lock(manager.root) as descriptor:
                manager.require_owned_idle_core()
                reader = worker.CORE.TX.APPS.Docker(manager.context)
                reader.lock_fd = descriptor
                with self.namespace.CaptureNamespace(worker, reader, approval['controller']) as namespace:
                    terminal, observed = self.source(point, authority, reader, namespace)
                    if (worker.digest(terminal[1]) != approval['terminalSha256']
                            or BASE.identity(terminal[2]) != approval['sourceTerminalIdentity'] or observed != approval['namespace']):
                        raise AbortError('The approved original early-abort terminal or namespace changed')
                    ready = namespace.read_abort_continuation(point)
                    continuation_evidence(worker, ready[0], approval, approval_sha)
                    if worker.digest(ready[1]) != request['continuationSha256']:
                        raise AbortError('The requested early-abort continuation changed')
                    if committed and BASE.identity(ready[2]) != commit['sourceContinuationIdentity']:
                        raise AbortError('The committed early-abort continuation inode changed')
                    records.persist('abort-continuation.json', ready[0])
                    expected = {'schema': SCHEMA, 'id': point, 'root': str(manager.root), 'context': manager.context,
                        'sourceMarker': 'absent', **{key: approval[key] for key in REQUEST | {'pointReservationSha256', 'leaseSha256'}},
                        'approvalSha256': approval_sha, 'continuationSha256': worker.digest(ready[1]),
                        'leaseIdentity': {key: authority.preparation['leaseIdentity'][key] for key in BASE.NAMES[:-1]},
                        'sourceTerminalIdentity': approval['sourceTerminalIdentity'], 'sourceContinuationIdentity': BASE.identity(ready[2]),
                        'sourceSettlementSha256': worker.digest(worker.P.canonical(observed))}
                    fresh, fresh_observed = self.source(point, authority, reader, namespace)
                    if (not BASE.same_file(namespace.read_abort_continuation(point), ready)
                            or not BASE.same_file(fresh, terminal) or fresh_observed != observed):
                        raise AbortError('The early-abort positive witnesses changed before commit')
                    records.persist('abort-commit.json', expected)
                    commit_evidence(worker, records.read, manager.root, manager.context, point, source_settled=False)
                    if namespace.verify_no_source_hold(point) != observed:
                        raise AbortError('The never-attempted-marker namespace changed before settlement')
                    records.persist('abort-source-settled.json', {'schema': 'orbis.core-capture-abort-source-settled.v2',
                        'id': point, 'abortCommitSha256': worker.digest(worker.P.canonical(expected)), 'namespace': observed})
                    durable_records(records)
                    if namespace.verify_no_source_hold(point) != observed:
                        raise AbortError('A source marker appeared before global lease retirement')
                    EmptyAbortRetirement(worker, manager.state, manager.root, manager.context, point,
                                         namespace=namespace).retire_committed()
            return self.completed(point, request, records)
