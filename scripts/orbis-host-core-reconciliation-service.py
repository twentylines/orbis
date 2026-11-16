"""Durable Root reconciliation on three isolated copies, without activation."""
import copy
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import sys
import threading


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module


P = load('orbis-host-core-preparation-service.py', 'orbis_reconciliation_preparation_service')
R = load('orbis-host-core-clean-target-reconcile.py', 'orbis_reconciliation_service_worker')
ADMISSION = 'orbis.core-reconciliation-admission.v1'
INTENT = 'orbis.core-reconciliation-service-intent.v1'
CLAIM = 'orbis.core-reconciliation-target-claim.v1'
COMPLETE = 'orbis.core-reconciliation-service-complete.v1'
FAILURE = 'orbis.core-reconciliation-service-failure.v1'
ACTION = 'prepare-isolated-reconciled-target'
FLAGS = {'scope': 'prepare-isolated-reconciled-target-only', 'activation': False,
         'environmentProved': False, 'restoreAuthority': False, 'sourceWrites': False}
WAIT_SECONDS = 1800


def require(value):
    if not value:
        raise ValueError('Reconciliation needs protected review. Your saved data is unchanged.')


@dataclass(frozen=True)
class CheckedReconciliation:
    owner: object
    manager: object
    prepared_target: object
    admission: dict
    intent: dict
    completion: dict
    guard: object


class CleanTargetReconciliationService:
    def __init__(self, service, *, preparation=None, worker_factory=threading.Thread):
        self.service = service
        self.preparation = preparation if preparation is not None else P.CleanTargetPreparationService(service)
        require(type(self.preparation) is P.CleanTargetPreparationService and self.preparation.service is service)
        self.enrollment, self.P = self.preparation.enrollment, self.preparation.P
        self.worker_factory = worker_factory
        self._condition = threading.Condition()
        self._active = {}

    def _identifier(self, value):
        require(isinstance(value, str) and P.F.L.BASE.E.UUID.fullmatch(value))
        return value

    def _request(self, request, peer, *, prepare=False):
        require(peer is True)
        P.F.I.require_root()
        require(self.P.exact(request, {'id', 'sourcePreparationId', 'destinationInspectionId', 'actor', 'action'}
                              if prepare else {'id', 'actor'}))
        identifier = self._identifier(request['id'])
        actor = copy.deepcopy(self.enrollment.actor(request['actor']))
        if prepare:
            source = self._identifier(request['sourcePreparationId'])
            destination = self._identifier(request['destinationInspectionId'])
            require(request['action'] == ACTION and len({identifier, source, destination}) == 3)
        return identifier, actor

    def _base(self):
        return Path(self.enrollment.state) / 'core-clean-target-reconciliation-admissions'

    def _directory(self, identifier):
        return self._base() / self._identifier(identifier)

    def _claims(self):
        return Path(self.enrollment.state) / 'core-clean-target-reconciliation-target-claims'

    def _read_at(self, path):
        body = self.enrollment.read(path, 65536)
        value = self.P.metadata(body, byte_limit=65536)
        require(body == self.P.canonical(value))
        return value

    def _read(self, identifier, name):
        return self._read_at(self._directory(identifier) / name)

    def _digest(self, value):
        return hashlib.sha256(self.P.canonical(value)).hexdigest()

    def _admission(self, identifier, actor=None):
        value = self._read(identifier, 'admission.json')
        require(self.P.exact(value, {'schema', 'id', 'sourcePreparationId', 'destinationInspectionId',
                                    'actor', 'root', 'context', 'action', *FLAGS})
                and value['schema'] == ADMISSION and value['id'] == identifier
                and value['root'] == str(self.enrollment.root) and value['context'] == self.enrollment.context
                and value['action'] == ACTION and value['actor'] == self.enrollment.actor(value['actor'])
                and (actor is None or value['actor'] == actor)
                and all(type(value[key]) is type(expected) and value[key] == expected for key, expected in FLAGS.items()))
        source, destination = self._identifier(value['sourcePreparationId']), self._identifier(value['destinationInspectionId'])
        require(len({identifier, source, destination}) == 3)
        return value

    def _intent(self, admission):
        value = self._read(admission['id'], 'intent.json')
        require(self.P.exact(value, {'schema', 'id', 'admissionSha256', 'sourceInspectionId',
            'preparationIntentSha256', 'sourceRecordSha256', 'destinationRecordSha256', 'installedRuntime',
            'migrationPolicySha256', 'targetReceiptSha256', 'bindingSha256', 'catalogSha256'})
            and value['schema'] == INTENT and value['id'] == admission['id']
            and value['admissionSha256'] == self._digest(admission))
        self._identifier(value['sourceInspectionId'])
        require(value['sourceInspectionId'] != admission['destinationInspectionId'])
        require(all(isinstance(value[key], str) and P.POLICY.I.C.HEX.fullmatch(value[key]) for key in
            ('preparationIntentSha256', 'sourceRecordSha256', 'destinationRecordSha256',
             'migrationPolicySha256', 'targetReceiptSha256', 'bindingSha256', 'catalogSha256')))
        binding = value['installedRuntime']
        require(self.P.exact(binding, {'id', 'installationSha256', 'sourceControllerImageId'}))
        self._identifier(binding['id'])
        require(isinstance(binding['installationSha256'], str) and P.POLICY.I.C.HEX.fullmatch(binding['installationSha256'])
                and isinstance(binding['sourceControllerImageId'], str) and P.POLICY.I.C.IMAGE.fullmatch(binding['sourceControllerImageId']))
        return value

    def _marker(self, admission, name, schema):
        try:
            value = self._read(admission['id'], name)
        except FileNotFoundError:
            return None
        fields = {'intentSha256', 'receiptSha256'} if schema == COMPLETE else {'executionAdmitted'}
        require(self.P.exact(value, {'schema', 'id', 'admissionSha256', *fields})
                and value['schema'] == schema and value['id'] == admission['id']
                and value['admissionSha256'] == self._digest(admission))
        if schema == COMPLETE:
            require(value['intentSha256'] == self._digest(self._intent(admission))
                    and isinstance(value['receiptSha256'], str) and P.POLICY.I.C.HEX.fullmatch(value['receiptSha256']))
        else:
            require(type(value['executionAdmitted']) is bool)
        return value

    def _claim_value(self, admission, intent):
        return {'schema': CLAIM, 'id': admission['id'], 'sourcePreparationId': admission['sourcePreparationId'],
                'intentSha256': self._digest(intent)}

    def _check_claim(self, admission, intent):
        require(self._read_at(self._claims() / (admission['sourcePreparationId'] + '.json'))
                == self._claim_value(admission, intent))

    def _unfinished(self):
        base = self._base()
        if base.exists() or base.is_symlink():
            with self.enrollment.a.protected_directory(base):
                names = os.listdir(base)
            require(len(names) < 256)
            for name in names:
                admission = self._admission(self._identifier(name))
                require(self._marker(admission, 'failure.json', FAILURE) is None
                        and self._marker(admission, 'complete.json', COMPLETE) is not None)
                self._check_claim(admission, self._intent(admission))
        claims = self._claims()
        if claims.exists() or claims.is_symlink():
            with self.enrollment.a.protected_directory(claims):
                names = os.listdir(claims)
            require(len(names) < 256)
            for name in names:
                require(name.endswith('.json'))
                source = self._identifier(name[:-5])
                value = self._read_at(claims / name)
                require(type(value) is dict)
                admission = self._admission(self._identifier(value.get('id')))
                require(admission['sourcePreparationId'] == source)
                self._check_claim(admission, self._intent(admission))

    @contextmanager
    def _operation(self, *, queued=False):
        acquired = self.service.lock.acquire(timeout=30) if queued else self.service.lock.acquire(blocking=False)
        if not acquired:
            raise BlockingIOError('Another operation is running.')
        entered, active = False, False
        try:
            try:
                exclusion = self.service.HOST.host_lock(self.service.root)
                descriptor = exclusion.__enter__()
                entered = True
            except (OSError, ValueError, RuntimeError) as error:
                raise BlockingIOError('Host exclusion is unavailable.') from error
            require(type(descriptor) is int)
            identity, thread, active = os.fstat(descriptor), threading.get_ident(), True

            @contextmanager
            def held_guard():
                require(active and threading.get_ident() == thread and self.service.lock.locked()
                        and self.service.HOST.LOCK_DESCRIPTOR.get() == descriptor and os.fstat(descriptor) == identity)
                yield
                require(active and threading.get_ident() == thread and self.service.lock.locked()
                        and self.service.HOST.LOCK_DESCRIPTOR.get() == descriptor and os.fstat(descriptor) == identity)

            yield held_guard
        finally:
            active = False
            try:
                if entered:
                    exclusion.__exit__(None, None, None)
            finally:
                self.service.lock.release()

    def _proof(self, admission, guard):
        actor = admission['actor']
        checked = self.preparation._checked_preparation(admission['sourcePreparationId'], actor, guard)
        require(type(checked) is P.CheckedPreparation)
        bootstrap, source, prepared = checked.manager, checked.source_inspection, checked.prepared_target
        source_id = checked.intent['sourceInspectionId']
        selected = getattr(bootstrap.broker, 'installed_selection', None)
        binding = checked.intent['installedRuntime']
        require(callable(getattr(bootstrap.broker, 'installed_authority', None))
                and getattr(selected, 'identifier', None) == binding['id']
                and getattr(selected, 'installation_sha256', None) == binding['installationSha256'])
        require(source_id != admission['destinationInspectionId'] and prepared.identifier == admission['sourcePreparationId']
                and bootstrap.enrollment is self.enrollment and source.enrollment is self.enrollment)
        destination = P.F.bootstrap_source_manager_for(self.service, 'status',
            {'id': admission['destinationInspectionId'], 'actor': actor}, enrollment=self.enrollment)
        manager = R.CoreVersionedCleanTargetReconcile.from_inspections(bootstrap.broker, source, source_id,
            destination, admission['destinationInspectionId'], bootstrap, prepared, actor, guard=guard)
        intent = {'schema': INTENT, 'id': admission['id'], 'admissionSha256': self._digest(admission),
            'sourceInspectionId': source_id, 'preparationIntentSha256': self._digest(checked.intent),
            'sourceRecordSha256': self._digest(source.record(source_id)),
            'destinationRecordSha256': self._digest(destination.record(admission['destinationInspectionId'])),
            'installedRuntime': copy.deepcopy(checked.intent['installedRuntime']),
            'migrationPolicySha256': checked.intent['migrationPolicySha256'],
            'targetReceiptSha256': prepared.receipt_sha256, 'bindingSha256': self._digest(manager.approved),
            'catalogSha256': self._digest(manager.approved['catalog'])}
        return manager, intent

    def _manager(self, admission, guard):
        intent = self._intent(admission)
        self._check_claim(admission, intent)
        manager, current = self._proof(admission, guard)
        require(current == intent)
        return manager

    @contextmanager
    def _checked_for_restoration(self, identifier, actor):
        require(type(self) is CleanTargetReconciliationService
                and self.service.core_clean_target_reconciliations() is self)
        P.F.I.require_root()
        actor = self.enrollment.actor(actor)
        identifier = self._identifier(identifier)
        with self._operation() as guard:
            with self._condition:
                if self._active:
                    raise BlockingIOError('Reconciliation is still owned by its worker.')
            admission = self._admission(identifier, actor)
            require(self._marker(admission, 'failure.json', FAILURE) is None)
            complete = self._marker(admission, 'complete.json', COMPLETE)
            require(complete is not None)
            intent = self._intent(admission)
            manager = self._manager(admission, guard)
            prepared = R.ReconciledCleanTarget(identifier, complete['receiptSha256'])
            require(type(manager) is R.CoreVersionedCleanTargetReconcile
                    and manager.enrollment is self.enrollment and manager.broker.enrollment is self.enrollment
                    and manager.checked(prepared, actor) == prepared)
            yield CheckedReconciliation(self, manager, prepared, copy.deepcopy(admission),
                copy.deepcopy(intent), copy.deepcopy(complete), guard)
            with guard():
                require(self._admission(identifier, actor) == admission and self._intent(admission) == intent
                        and self._marker(admission, 'failure.json', FAILURE) is None
                        and self._marker(admission, 'complete.json', COMPLETE) == complete)
                self._check_claim(admission, intent)
                require(manager.checked(prepared, actor) == prepared)

    def _public(self, admission, phase, *, active=False, available=False):
        return {'version': 1, 'id': admission['id'], 'sourcePreparationId': admission['sourcePreparationId'],
            'destinationInspectionId': admission['destinationInspectionId'], 'phase': phase,
            'reconciliationActive': active, 'reconciledTargetAvailable': available, **FLAGS}

    def prepare(self, request, *, privileged_peer=False):
        identifier, actor = self._request(request, privileged_peer, prepare=True)
        try:
            admission = self._admission(identifier, actor)
        except FileNotFoundError:
            admission = None
        if admission is not None:
            require(admission['sourcePreparationId'] == request['sourcePreparationId']
                    and admission['destinationInspectionId'] == request['destinationInspectionId'])
            return self.status({'id': identifier, 'actor': actor}, privileged_peer=True)
        token = object()
        with self._condition:
            require(not self._active)
            self._active[identifier] = {'token': token, 'actor': actor, 'phase': 'checking-source', 'manager': None,
                'sourcePreparationId': request['sourcePreparationId'], 'destinationInspectionId': request['destinationInspectionId']}
        admitted, dispatched = False, False
        try:
            with self._operation() as guard:
                self._unfinished()
                target_claim = self._claims() / (request['sourcePreparationId'] + '.json')
                require(not target_claim.exists() and not target_claim.is_symlink())
                base = self.enrollment.child(Path(self.enrollment.state), self._base().name)
                self.enrollment.sync(Path(self.enrollment.state))
                directory = self._directory(identifier)
                directory.mkdir(mode=0o700)
                self.enrollment.sync(base)
                admission = {'schema': ADMISSION, 'id': identifier, 'sourcePreparationId': request['sourcePreparationId'],
                    'destinationInspectionId': request['destinationInspectionId'], 'actor': actor,
                    'root': str(self.enrollment.root), 'context': self.enrollment.context, 'action': ACTION, **FLAGS}
                self.enrollment.immutable(directory / 'admission.json', self.P.canonical(admission))
                _, intent = self._proof(admission, guard)
                self.enrollment.immutable(directory / 'intent.json', self.P.canonical(intent))
                claims = self.enrollment.child(Path(self.enrollment.state), self._claims().name)
                self.enrollment.sync(Path(self.enrollment.state))
                self.enrollment.immutable(claims / target_claim.name, self.P.canonical(self._claim_value(admission, intent)))
                self.enrollment.sync(directory)
            with self._condition:
                self._active[identifier]['phase'] = 'queued'
            worker = self.worker_factory(target=self._execute, args=(identifier, token), daemon=True,
                                         name='orbis-reconcile-' + identifier)
            dispatched = True
            worker.start()
            admitted = True
            return self.status({'id': identifier, 'actor': actor}, privileged_peer=True)
        except BaseException:
            if admission is not None and not admitted:
                self._failure(admission, dispatched)
            raise
        finally:
            if not admitted:
                with self._condition:
                    if self._active.get(identifier, {}).get('token') is token:
                        del self._active[identifier]
                        self._condition.notify_all()

    def _failure(self, admission, execution):
        try:
            self.enrollment.immutable(self._directory(admission['id']) / 'failure.json', self.P.canonical(
                {'schema': FAILURE, 'id': admission['id'], 'admissionSha256': self._digest(admission), 'executionAdmitted': execution}))
        except (OSError, ValueError, TypeError):
            pass

    def _execute(self, identifier, token):
        admission, execution = None, False
        try:
            admission = self._admission(identifier)
            with self._operation(queued=True) as guard:
                manager = self._manager(admission, guard)
                with self._condition:
                    require(self._active.get(identifier, {}).get('token') is token)
                    self._active[identifier].update(phase='reconciling', manager=manager)
                try:
                    manager.record(identifier)
                except FileNotFoundError:
                    pass
                else:
                    execution = True
                    raise ValueError('Existing reconciliation cannot be replayed.')
                execution = True
                prepared = manager.reconcile(identifier, admission['actor'])
                require(type(prepared) is R.ReconciledCleanTarget and prepared.identifier == identifier)
                require(manager.checked(prepared, admission['actor']) == prepared)
                complete = {'schema': COMPLETE, 'id': identifier, 'admissionSha256': self._digest(admission),
                    'intentSha256': self._digest(self._intent(admission)), 'receiptSha256': prepared.receipt_sha256}
                self.enrollment.immutable(self._directory(identifier) / 'complete.json', self.P.canonical(complete))
        except BaseException:
            if admission is not None:
                self._failure(admission, execution)
        finally:
            with self._condition:
                if self._active.get(identifier, {}).get('token') is token:
                    del self._active[identifier]
                    self._condition.notify_all()

    def status(self, request, *, privileged_peer=False):
        identifier, actor = self._request(request, privileged_peer)
        with self._condition:
            slot = self._active.get(identifier)
            slot = dict(slot) if slot is not None else None
        if slot is not None:
            require(slot['actor'] == actor)
            phase = slot['phase']
            if slot['manager'] is not None:
                try:
                    phase = slot['manager'].record(identifier)['phase']
                except FileNotFoundError:
                    phase = 'reconciling'
                if phase in {'complete', 'terminal', 'recovery-required', 'checking', 'reconciliation-blocked', 'reconciliation-complete'}:
                    phase = 'verifying-reconciliation'
            require(isinstance(phase, str) and re.fullmatch(r'[a-z][a-z0-9-]{0,63}', phase))
            return self._public({'id': identifier, **slot}, phase, active=True)
        admission = self._admission(identifier, actor)
        try:
            failure = self._marker(admission, 'failure.json', FAILURE)
            if failure is not None:
                return self._public(admission, 'recovery-required' if failure['executionAdmitted'] else 'reconciliation-blocked')
            complete = self._marker(admission, 'complete.json', COMPLETE)
            if complete is None:
                return self._public(admission, 'recovery-required')
            with self._operation() as guard:
                manager = self._manager(admission, guard)
                prepared = R.ReconciledCleanTarget(identifier, complete['receiptSha256'])
                require(manager.checked(prepared, actor) == prepared)
        except BlockingIOError:
            return self._public(admission, 'checking')
        except (OSError, ValueError, RuntimeError, KeyError, TypeError):
            return self._public(admission, 'recovery-required')
        return self._public(admission, 'reconciliation-complete', available=True)

    def wait(self, request, *, privileged_peer=False):
        identifier, actor = self._request(request, privileged_peer)
        with self._condition:
            slot = self._active.get(identifier)
            if slot is not None:
                require(slot['actor'] == actor)
            else:
                self._admission(identifier, actor)
            self._condition.wait_for(lambda: identifier not in self._active, timeout=WAIT_SECONDS)
        return self.status({'id': identifier, 'actor': actor}, privileged_peer=True)
