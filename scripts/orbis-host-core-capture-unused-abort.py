"""Settle sealed, marker-free source attempts using versioned positive evidence."""
import importlib.util
import os
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('orbis_unused_empty', Path(__file__).with_name('orbis-host-core-capture-empty-abort.py'))
EMPTY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EMPTY)
BASE = EMPTY.BASE
AbortError = BASE.AbortError
SCHEMA = 'orbis.core-capture-abort-commit.v3'
FILES = ('preparation.json', 'point-reservation.json', 'decision.json', 'abort-terminal.json', 'abort-unused-commit.json')
REFUSED_CAPABILITY = {'schema': 'orbis.core-capture-refused-abort-capability.v1', 'version': 1,
    'preparationVersion': 3, 'terminalVersion': 5, 'localLease': 'not-acquired',
    'operations': ['abort-refused-settle', 'abort-refused-status'], 'admissionReplay': 'forbidden'}


class Records(BASE.Records):
    allowed_names = BASE.Records.allowed_names | {'abort-unused-commit.json'}


def terminal_evidence(worker, terminal, preparation, preparation_sha, decision_sha):
    expected = {'schema': 'orbis.core-capture-source-abort-terminal.v3', 'id': preparation['id'],
        'preparationSha256': preparation_sha, 'decisionSha256': decision_sha,
        'pointReservationSha256': preparation['pointReservationSha256'], 'controller': preparation['controller'],
        'operatorAuthorizationId': terminal.get('operatorAuthorizationId'),
        'sourceMarker': 'absent', 'sourceAttempt': 'not-started'}
    if terminal != expected:
        raise AbortError('Invalid never-started source terminal')
    worker.identifier(terminal['operatorAuthorizationId'])


def commit_evidence(worker, read, root, context, point, terminal_check=terminal_evidence, schema=SCHEMA, attempt='not-started'):
    prep, prep_sha, decision_sha, lease = BASE.base_evidence(worker, read, root, context, point)
    terminal, terminal_body = read('abort-terminal.json')
    terminal_check(worker, terminal, prep, prep_sha, decision_sha)
    commit, body = read('abort-unused-commit.json')
    expected = {'schema': schema, 'id': point, 'root': str(root), 'context': context,
        'sourceMarker': 'absent', 'sourceAttempt': attempt, 'preparationSha256': prep_sha,
        'decisionSha256': decision_sha, 'terminalSha256': worker.digest(terminal_body),
        'sourceSha256': prep['sourceSha256'], 'pointReservationSha256': prep['pointReservationSha256'],
        'controller': prep['controller'], 'operatorAuthorizationId': terminal['operatorAuthorizationId'],
        'leaseNonce': prep['leaseNonce'], 'leaseSha256': prep['leaseSha256'],
        'leaseIdentity': {key: prep['leaseIdentity'][key] for key in BASE.NAMES[:-1]},
        'sourceTerminalIdentity': commit.get('sourceTerminalIdentity'), 'namespace': commit.get('namespace')}
    if attempt == 'setup-unwound':
        expected.update(localLease=terminal['localLease'], queueUnwind=terminal['queueUnwind'])
    elif attempt == 'setup-refused':
        expected.update(localLease=terminal['localLease'], queueRefusal=terminal['queueRefusal'])
    if commit != expected:
        raise AbortError('The unused abort commit differs from its protected evidence')
    BASE.checked_identity(commit['sourceTerminalIdentity'], worker.A.OWNER)
    EMPTY.absence_evidence(worker, commit['namespace'], point, prep['controller'])
    return commit, worker.digest(body), lease


def durable_records(records):
    for name in FILES:
        expected = records.read(name)[1]
        with records.A.protected_directory(records.directory) as parent:
            with records.A.protected_file(parent, name, 65536) as body:
                if body != expected:
                    raise AbortError('Unused abort evidence changed before sync')
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    before = records.A.seal(os.stat(name, dir_fd=parent, follow_symlinks=False))
                    if records.A.seal(os.fstat(fd)) != before:
                        raise AbortError('Unused abort evidence inode changed')
                    os.fsync(fd)
                    if records.A.seal(os.fstat(fd)) != before:
                        raise AbortError('Unused abort evidence changed during sync')
                finally:
                    os.close(fd)
            os.fsync(parent)


class Retirement(BASE.RETIRE.CaptureRetirement):
    def __init__(self, worker, state, root, context, point, namespace=None, contract=None):
        self.live_namespace = namespace
        self.contract = contract or {}
        super().__init__(worker, state, root, context, point)

    def authority_directory(self):
        return self.state / 'core-capture-preparations' / self.point

    def _authority(self):
        self.W.require_root()
        commit, _, lease = commit_evidence(self.W, self._read, self.root, self.context, self.point, **self.contract)
        return commit, lease, self.P.canonical(lease)

    def _lease(self, parent, name, commit, expected_body):
        if self.live_namespace is not None and self.live_namespace.verify_no_source_hold(self.point) != commit['namespace']:
            raise AbortError('The original source namespace changed')
        return super()._lease(parent, name, commit, expected_body)

    def retire_committed(self):
        if self.live_namespace is None:
            raise AbortError('Retirement requires the original live namespace')
        return super().retire_committed()


class CoreCaptureUnusedAbort(BASE.CoreCaptureAbort):
    contract = {}
    schema = SCHEMA
    attempt = 'not-started'
    version = 3

    def terminal_evidence(self, *args):
        return terminal_evidence(*args)

    def commit_evidence(self, *args):
        return commit_evidence(*args, **self.contract)

    def retirement(self, point, namespace=None):
        return Retirement(self.W, self.manager.state, self.manager.root, self.manager.context, point, namespace, **({'contract': self.contract} if self.contract else {}))

    def extra_evidence(self, terminal):
        return {}

    def records(self, point):
        return Records(self.W, self.manager, point)

    def no_prior_abort(self, records):
        for name in ('abort-approval.json', 'abort-continuation.json', 'abort-commit.json',
                     'abort-source-retired.json', 'abort-source-settled.json'):
            if name == 'abort-source-settled.json':
                with records.A.protected_directory(records.directory) as parent:
                    try:
                        os.stat(name, dir_fd=parent, follow_symlinks=False)
                    except FileNotFoundError:
                        continue
                    raise AbortError('Prior abort authority forbids unused settlement')
            if records.read(name, optional=True)[0] is not None:
                raise AbortError('Prior abort authority forbids unused settlement')

    def no_operation_authority(self, point):
        for path in (self.manager.state / 'core-capture-admissions' / point, self.manager.capture.base / point):
            try:
                path.lstat()
            except FileNotFoundError:
                continue
            raise AbortError('Existing admission or job authority forbids unused settlement')

    def source(self, point, authority, reader, namespace):
        self.manager.require_reserved_source(reader, point, authority)
        terminal = namespace.read_abort_terminal(point)
        _, decision_body = authority.decision('abort')
        self.terminal_evidence(self.W, terminal[0], authority.preparation, authority.preparation_sha256, self.W.digest(decision_body))
        try:
            namespace.read_abort_continuation(point)
        except FileNotFoundError:
            pass
        else:
            raise AbortError('Existing source continuation contradicts unused settlement')
        observed = namespace.verify_no_source_hold(point)
        EMPTY.absence_evidence(self.W, observed, point, authority.preparation['controller'])
        return terminal, observed

    def completed(self, point, request, records):
        self.no_prior_abort(records)
        commit, digest, _ = self.commit_evidence(self.W, records.read, self.manager.root, self.manager.context, point)
        if any(commit[key] != request[key] for key in BASE.REQUEST):
            raise AbortError('The unused abort request differs from its commit')
        self.no_operation_authority(point)
        retirement = self.retirement(point)
        retirement.inspect_retired()
        return {'version': self.version, 'id': point, 'state': 'complete', 'sourceMarker': 'absent',
            'sourceAttempt': self.attempt, **self.extra_evidence(commit), **{key: commit[key] for key in BASE.REQUEST}, 'commitSha256': digest,
            **{key: commit[key] for key in ('sourceSha256', 'pointReservationSha256', 'controller')}}

    def status(self, point, request):
        self.validate_request(point, request)
        with self.manager.service.lock:
            return self.completed(point, request, self.records(point))

    def settle(self, point, request):
        self.validate_request(point, request)
        worker, manager = self.W, self.manager
        with manager.service.lock:
            manager.service.require_idle_core()
            records = self.records(point)
            self.no_prior_abort(records)
            committed = records.read('abort-unused-commit.json', optional=True)[0] is not None
            if committed:
                commit, _, _ = self.commit_evidence(worker, records.read, manager.root, manager.context, point)
                if any(commit[key] != request[key] for key in BASE.REQUEST):
                    raise AbortError('The committed unused abort differs from this request')
                retirement = self.retirement(point)
                try:
                    retirement.path.with_name(retirement.retired_name).lstat()
                except FileNotFoundError:
                    pass
                else:
                    return self.completed(point, request, records)
            self.no_operation_authority(point)
            authority = self.authority(point, request)
            with authority.lease().owner(), self.H.host_lock(manager.root) as descriptor:
                self.no_operation_authority(point)
                reader = worker.CORE.TX.APPS.Docker(manager.context)
                reader.lock_fd = descriptor
                with self.namespace.CaptureNamespace(worker, reader, authority.preparation['controller']) as namespace:
                    terminal, observed = self.source(point, authority, reader, namespace)
                    if worker.digest(terminal[1]) != request['terminalSha256']:
                        raise AbortError('The source terminal differs from the request')
                    prep = authority.preparation
                    expected = {'schema': self.schema, 'id': point, 'root': str(manager.root), 'context': manager.context,
                        'sourceMarker': 'absent', 'sourceAttempt': self.attempt, **self.extra_evidence(terminal[0]), **request,
                        'sourceSha256': prep['sourceSha256'], 'pointReservationSha256': prep['pointReservationSha256'],
                        'controller': prep['controller'], 'operatorAuthorizationId': terminal[0]['operatorAuthorizationId'],
                        'leaseNonce': prep['leaseNonce'], 'leaseSha256': prep['leaseSha256'],
                        'leaseIdentity': {key: prep['leaseIdentity'][key] for key in BASE.NAMES[:-1]},
                        'sourceTerminalIdentity': BASE.identity(terminal[2]), 'namespace': observed}
                    if committed and expected != commit:
                        raise AbortError('The committed source transaction changed')
                    records.persist('abort-terminal.json', terminal[0])
                    fresh, fresh_observed = self.source(point, authority, reader, namespace)
                    if not BASE.same_file(fresh, terminal) or fresh_observed != observed:
                        raise AbortError('The source terminal or namespace changed before commit')
                    self.no_operation_authority(point)
                    records.persist('abort-unused-commit.json', expected)
                    self.commit_evidence(worker, records.read, manager.root, manager.context, point)
                    durable_records(records)
                    self.no_operation_authority(point)
                    fresh, fresh_observed = self.source(point, authority, reader, namespace)
                    if not BASE.same_file(fresh, terminal) or fresh_observed != observed:
                        raise AbortError('The source terminal or namespace changed before retirement')
                    self.retirement(point, namespace).retire_committed()
            return self.completed(point, request, records)


def setup_terminal_evidence(worker, terminal, preparation, preparation_sha, decision_sha):
    expected = {'schema': 'orbis.core-capture-source-abort-terminal.v4', 'id': preparation['id'],
        'preparationSha256': preparation_sha, 'decisionSha256': decision_sha,
        'pointReservationSha256': preparation['pointReservationSha256'], 'controller': preparation['controller'],
        'operatorAuthorizationId': terminal.get('operatorAuthorizationId'), 'sourceMarker': 'absent',
        'sourceAttempt': 'setup-unwound', 'localLease': 'not-acquired', 'queueUnwind': terminal.get('queueUnwind')}
    if terminal != expected:
        raise AbortError('Invalid setup-unwound source terminal')
    worker.identifier(terminal['operatorAuthorizationId'])
    unwind = terminal['queueUnwind']
    if (not isinstance(unwind, dict) or set(unwind) != {'pauseId', 'generation', 'queues'}
            or type(unwind['generation']) is not int or not 1 <= unwind['generation'] <= 9007199254740991):
        raise AbortError('Invalid setup unwind evidence')
    worker.identifier(unwind['pauseId'])
    EMPTY.queues(unwind['queues'], 1)


class CoreCaptureSetupAbort(CoreCaptureUnusedAbort):
    schema = 'orbis.core-capture-abort-commit.v4'
    attempt = 'setup-unwound'
    version = 4
    contract = {'terminal_check': setup_terminal_evidence, 'schema': schema, 'attempt': attempt}

    def terminal_evidence(self, *args):
        return setup_terminal_evidence(*args)

    def extra_evidence(self, terminal):
        return {key: terminal[key] for key in ('localLease', 'queueUnwind')}


def refused_terminal_evidence(worker, terminal, preparation, preparation_sha, decision_sha):
    expected = {'schema': 'orbis.core-capture-source-abort-terminal.v5', 'id': preparation['id'],
        'preparationSha256': preparation_sha, 'decisionSha256': decision_sha,
        'pointReservationSha256': preparation['pointReservationSha256'], 'controller': preparation['controller'],
        'operatorAuthorizationId': terminal.get('operatorAuthorizationId'), 'sourceMarker': 'absent',
        'sourceAttempt': 'setup-refused', 'localLease': 'not-acquired', 'queueRefusal': terminal.get('queueRefusal')}
    if terminal != expected:
        raise AbortError('Invalid setup-refused source terminal')
    worker.identifier(terminal['operatorAuthorizationId'])
    refusal = terminal['queueRefusal']
    if (not isinstance(refusal, dict) or set(refusal) != {'setupId', 'generation', 'outcome', 'queues'}
            or type(refusal['generation']) is not int or not 1 <= refusal['generation'] <= 9007199254740991
            or not isinstance(refusal['outcome'], str) or refusal['outcome'] not in {'not-entered', 'queue-refused'}):
        raise AbortError('Invalid setup refusal evidence')
    worker.identifier(refusal['setupId'])
    EMPTY.queues(refusal['queues'], 1)


class CoreCaptureRefusedAbort(CoreCaptureUnusedAbort):
    schema = 'orbis.core-capture-abort-commit.v5'
    attempt = 'setup-refused'
    version = 5
    contract = {'terminal_check': refused_terminal_evidence, 'schema': schema, 'attempt': attempt}

    def terminal_evidence(self, *args):
        return refused_terminal_evidence(*args)

    def extra_evidence(self, terminal):
        return {key: terminal[key] for key in ('localLease', 'queueRefusal')}
