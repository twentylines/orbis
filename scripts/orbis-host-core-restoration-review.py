"""Root-private current-installation observation bound to checked reconciliation."""
import copy
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import types


ADMISSION = 'orbis.core-restoration-review-admission.v1'
OBSERVATION = 'orbis.core-restoration-installation-observation.v1'
FAILURE = 'orbis.core-restoration-review-failure.v1'
ACTION = 'review-current-installation-core-restoration'
MAX_RECORD = 16 * 1024 ** 2
FLAGS = {'scope': 'current-installation-observation-only', 'logicalConsistencyProved': False,
         'writerQuiescenceProved': False, 'activation': False, 'environmentProved': False,
         'restoreAuthority': False, 'sourceWrites': False}


def require(value):
    if not value:
        raise ValueError('Restoration review requires unchanged protected evidence. Your saved data is unchanged.')


@dataclass(frozen=True)
class CheckedRestorationReview:
    owner: object
    reconciliation: object
    record: dict
    guard: object


class CoreRestorationReview:
    def __init__(self, service):
        self.service = service
        self.reconciliations = service.core_clean_target_reconciliations()
        self.C = service.core_reconciliation_module
        self.enrollment = self.reconciliations.enrollment
        self.P = self.enrollment.P
        self._graph()

    def _graph(self):
        service, reconciliations = self.service, self.reconciliations
        require(isinstance(self.C, types.ModuleType) and service.core_reconciliation_module is self.C
                and type(reconciliations) is self.C.CleanTargetReconciliationService
                and service.core_clean_target_reconciliations() is reconciliations and reconciliations.service is service
                and type(reconciliations.preparation) is self.C.P.CleanTargetPreparationService
                and reconciliations.preparation.service is service
                and reconciliations.preparation.enrollment is self.enrollment
                and type(self.enrollment) is self.C.P.F.L.BASE.E.CorePortableEnrollment
                and self.enrollment.service is service and self.enrollment.host is service.HOST
                and self.enrollment.a is service.HOST.AUTHORITY and self.P is service.HOST.IDENTITY.PUBLICATION
                and self.enrollment.root == Path(service.root) and self.enrollment.context == service.context
                and self.enrollment.state == Path(service.state_dir))
        retained = service.retained_restores()
        runtime = retained.runtime
        require(service.retained_restore_manager is retained and type(retained) is service.retained_restore_manager_type
                and type(runtime) is service.retained_restore_runtime_type
                and retained.service is service and retained.host is service.HOST
                and retained.authority is self.enrollment.a and retained.root == self.enrollment.root
                and retained.context == self.enrollment.context and retained.state == self.enrollment.state
                and runtime.manager is retained and runtime.host is service.HOST and runtime.a is self.enrollment.a
                and runtime.root == self.enrollment.root and runtime.context == self.enrollment.context
                and runtime.P is self.P and self.enrollment.runtime is runtime)
        return runtime

    def _request(self, request, peer, *, review=False):
        require(peer is True)
        self.C.P.F.I.require_root()
        require(self.P.exact(request, {'id', 'reconciliationId', 'actor', 'action'} if review else {'id', 'actor'}))
        identifier = self.reconciliations._identifier(request['id'])
        actor = copy.deepcopy(self.enrollment.actor(request['actor']))
        if review:
            self.reconciliations._identifier(request['reconciliationId'])
            require(request['action'] == ACTION)
        self._graph()
        return identifier, actor

    def _base(self):
        return Path(self.enrollment.state) / 'core-restoration-reviews'

    def _directory(self, identifier):
        return self._base() / self.reconciliations._identifier(identifier)

    def _digest(self, value):
        return hashlib.sha256(self.P.canonical(value)).hexdigest()

    def _read(self, identifier, name):
        body = self.enrollment.read(self._directory(identifier) / name, MAX_RECORD)
        value = self.P.metadata(body, byte_limit=MAX_RECORD, string_limit=MAX_RECORD)
        require(body == self.P.canonical(value))
        return value

    def _admission(self, identifier, actor):
        value = self._read(identifier, 'admission.json')
        require(self.P.exact(value, {'schema', 'id', 'reconciliationId', 'actor', 'root', 'context', 'action', *FLAGS})
                and value['schema'] == ADMISSION and value['id'] == identifier and value['actor'] == actor
                and self.enrollment.actor(value['actor']) == actor and value['root'] == str(self.enrollment.root)
                and value['context'] == self.enrollment.context and value['action'] == ACTION
                and all(type(value[key]) is type(expected) and value[key] == expected for key, expected in FLAGS.items()))
        self.reconciliations._identifier(value['reconciliationId'])
        return value

    def _observation(self, admission):
        failure = self._directory(admission['id']) / 'failure.json'
        require(not failure.exists() and not failure.is_symlink())
        value = self._read(admission['id'], 'observation.json')
        require(self.P.exact(value, {'schema', 'id', 'admissionSha256', 'reconciliation', 'snapshot', 'snapshotSha256', *FLAGS})
                and value['schema'] == OBSERVATION and value['id'] == admission['id']
                and value['admissionSha256'] == self._digest(admission)
                and value['snapshotSha256'] == self._digest(value['snapshot'])
                and all(type(value[key]) is type(expected) and value[key] == expected for key, expected in FLAGS.items()))
        return value

    def _binding(self, checked):
        require(type(checked) is self.C.CheckedReconciliation and checked.owner is self.reconciliations
                and type(checked.manager) is self.C.R.CoreVersionedCleanTargetReconcile
                and checked.manager.enrollment is self.enrollment and checked.manager.broker.enrollment is self.enrollment
                and type(checked.prepared_target) is self.C.R.ReconciledCleanTarget
                and checked.prepared_target.identifier == checked.admission['id'])
        with checked.guard():
            self.reconciliations._check_claim(checked.admission, checked.intent)
            require(checked.manager.checked(checked.prepared_target, checked.admission['actor']) == checked.prepared_target)
            return {'admissionSha256': self._digest(checked.admission), 'intentSha256': self._digest(checked.intent),
                'completionSha256': self._digest(checked.completion), 'receiptSha256': checked.prepared_target.receipt_sha256,
                'recordSha256': self._digest(checked.manager.record(checked.admission['id'])),
                'bindingSha256': self._digest(checked.manager.approved),
                'targetClaimSha256': self._digest(self.reconciliations._claim_value(checked.admission, checked.intent))}

    def _snapshot(self, checked):
        with checked.guard():
            snapshot = self._graph().source_snapshot()
            require(type(snapshot) is dict and len(self.P.canonical(snapshot)) <= MAX_RECORD // 2)
            return snapshot

    def _public(self, admission, phase):
        return {'version': 1, 'id': admission['id'], 'reconciliationId': admission['reconciliationId'],
                'phase': phase, 'reviewAvailable': phase == 'installation-observed', **FLAGS}

    def review(self, request, *, privileged_peer=False):
        identifier, actor = self._request(request, privileged_peer, review=True)
        directory = self._directory(identifier)
        if directory.exists() or directory.is_symlink():
            admission = self._admission(identifier, actor)
            require(admission['reconciliationId'] == request['reconciliationId'])
            return self.status({'id': identifier, 'actor': actor}, privileged_peer=True)
        admission = {'schema': ADMISSION, 'id': identifier, 'reconciliationId': request['reconciliationId'], 'actor': actor,
                     'root': str(self.enrollment.root), 'context': self.enrollment.context, 'action': ACTION, **FLAGS}
        try:
            with self.reconciliations._checked_for_restoration(request['reconciliationId'], actor) as checked:
                binding = self._binding(checked)
                base = self.enrollment.child(Path(self.enrollment.state), self._base().name)
                self.enrollment.sync(Path(self.enrollment.state))
                with self.enrollment.a.protected_directory(base):
                    names = os.listdir(base)
                require(len(names) < 256)
                for name in names:
                    self.reconciliations._identifier(name)
                directory.mkdir(mode=0o700)
                self.enrollment.sync(base)
                self.enrollment.immutable(directory / 'admission.json', self.P.canonical(admission))
                snapshot = self._snapshot(checked)
                require(self._snapshot(checked) == snapshot and self._binding(checked) == binding)
                observation = {'schema': OBSERVATION, 'id': identifier, 'admissionSha256': self._digest(admission),
                    'reconciliation': binding, 'snapshot': snapshot, 'snapshotSha256': self._digest(snapshot), **FLAGS}
                require(len(self.P.canonical(observation)) <= MAX_RECORD)
                self.enrollment.immutable(directory / 'observation.json', self.P.canonical(observation))
                self.enrollment.sync(directory)
        except BaseException as error:
            if (directory / 'admission.json').exists():
                try:
                    self.enrollment.immutable(directory / 'failure.json', self.P.canonical(
                        {'schema': FAILURE, 'id': identifier, 'admissionSha256': self._digest(admission)}))
                except (OSError, ValueError, TypeError):
                    pass
            if isinstance(error, BlockingIOError):
                return self._public(admission, 'checking')
            raise
        return self._public(admission, 'installation-observed')

    @contextmanager
    def _checked_review(self, identifier, actor):
        admission = self._admission(identifier, self.enrollment.actor(actor))
        observation = self._observation(admission)
        with self.reconciliations._checked_for_restoration(admission['reconciliationId'], actor) as checked:
            require(self._binding(checked) == observation['reconciliation'])
            snapshot = self._snapshot(checked)
            require(snapshot == observation['snapshot'] and self._snapshot(checked) == snapshot)
            yield CheckedRestorationReview(self, checked, copy.deepcopy(observation), checked.guard)
            with checked.guard():
                require(self._admission(identifier, actor) == admission and self._observation(admission) == observation
                        and self._binding(checked) == observation['reconciliation']
                        and self._snapshot(checked) == snapshot)

    def status(self, request, *, privileged_peer=False):
        identifier, actor = self._request(request, privileged_peer)
        admission = self._admission(identifier, actor)
        try:
            with self._checked_review(identifier, actor):
                pass
        except BlockingIOError:
            return self._public(admission, 'checking')
        except (OSError, ValueError, RuntimeError, KeyError, TypeError):
            return self._public(admission, 'recovery-required')
        return self._public(admission, 'installation-observed')
