"""Durable isolated-target preparation; no live restore or automatic replay."""
import copy
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import importlib.util
import logging
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


F = load('orbis-host-core-local-inspection-service.py', 'orbis_preparation_service_inspection')
POLICY = load('orbis-host-core-preparation-policy.py', 'orbis_preparation_service_policy')
INTENT = 'orbis.core-clean-target-preparation-intent.v1'
COMPLETE = 'orbis.core-clean-target-preparation-complete.v1'
FAILURE = 'orbis.core-clean-target-preparation-failure.v1'
ACTION = 'prepare-isolated-clean-target'
FLAGS = {'scope': 'prepare-isolated-clean-target-only', 'activation': False,
         'environmentProved': False, 'restoreAuthority': False, 'sourceWrites': False}
LOG = logging.getLogger(__name__)
WAIT_SECONDS = 1800


def require(value):
    if not value:
        raise ValueError('Restore preparation needs review. Your saved data is unchanged.')


@dataclass(frozen=True)
class CheckedPreparation:
    manager: object
    prepared_target: object
    source_inspection: object
    intent: dict


class CleanTargetPreparationService:
    def __init__(self, service, *, enrollment=None, worker_factory=threading.Thread):
        self.service = service
        self.enrollment = enrollment if enrollment is not None else F.L.BASE.E.CorePortableEnrollment(service)
        self.P = self.enrollment.P
        self.worker_factory = worker_factory
        self._lock = threading.Lock()
        self._condition = threading.Condition(self._lock)
        self._active = {}

    def _actor(self, request, peer):
        require(peer is True and isinstance(request, dict))
        F.I.require_root()
        return self.enrollment.actor(request.get('actor'))

    def _identifier(self, value):
        require(isinstance(value, str) and F.L.BASE.E.UUID.fullmatch(value))
        return value

    def _directory(self, identifier, *, create=False):
        self._identifier(identifier)
        base = Path(self.enrollment.state) / 'core-clean-target-preparations'
        if create:
            base = self.enrollment.child(Path(self.enrollment.state), base.name)
            self.enrollment.sync(Path(self.enrollment.state))
            directory = base / identifier
            directory.mkdir(mode=0o700)
            self.enrollment.sync(base)
            return directory
        return base / identifier

    def _read(self, identifier, name):
        body = self.enrollment.read(self._directory(identifier) / name, 65536)
        value = self.P.metadata(body, byte_limit=65536)
        require(body == self.P.canonical(value))
        return value

    def _intent(self, identifier):
        value = self._read(identifier, 'intent.json')
        require(self.P.exact(value, {'schema', 'id', 'sourceInspectionId', 'actor', 'root', 'context', 'installedRuntime',
                'sourceRecordSha256', 'migrationPolicySha256', 'action', *FLAGS})
                and value['schema'] == INTENT and value['id'] == identifier and value['action'] == ACTION
                and value['root'] == str(self.enrollment.root) and value['context'] == self.enrollment.context
                and value['actor'] == self.enrollment.actor(value['actor'])
                and all(type(value[key]) is type(expected) and value[key] == expected for key, expected in FLAGS.items())
                and all(isinstance(value[key], str) and POLICY.I.C.HEX.fullmatch(value[key])
                        for key in ('sourceRecordSha256', 'migrationPolicySha256')))
        self._identifier(value['sourceInspectionId'])
        binding = value['installedRuntime']
        require(self.P.exact(binding, {'id', 'installationSha256', 'sourceControllerImageId'})
                and isinstance(binding['installationSha256'], str) and POLICY.I.C.HEX.fullmatch(binding['installationSha256'])
                and isinstance(binding['sourceControllerImageId'], str) and POLICY.I.C.IMAGE.fullmatch(binding['sourceControllerImageId']))
        self._identifier(binding['id'])
        return value

    def _marker(self, intent, name, schema, fields):
        try:
            value = self._read(intent['id'], name)
        except FileNotFoundError:
            return None
        require(self.P.exact(value, {'schema', 'id', 'intentSha256', *fields, *FLAGS})
                and value['schema'] == schema and value['id'] == intent['id']
                and value['intentSha256'] == self._digest(intent)
                and all(type(value[key]) is type(expected) and value[key] == expected for key, expected in FLAGS.items()))
        if schema == COMPLETE:
            require(isinstance(value['targetReceiptSha256'], str) and POLICY.I.C.HEX.fullmatch(value['targetReceiptSha256']))
        elif schema == FAILURE:
            require(type(value['targetExecutionAdmitted']) is bool and isinstance(value['failureClass'], str)
                    and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,79}', value['failureClass']))
        return value

    def _digest(self, value):
        return hashlib.sha256(self.P.canonical(value)).hexdigest()

    @contextmanager
    def _operation(self, *, queued=False):
        acquired = self.service.lock.acquire(timeout=30) if queued else self.service.lock.acquire(blocking=False)
        if not acquired:
            raise BlockingIOError('Another operation is running.')
        try:
            with self.service.HOST.host_lock(self.service.root):
                owner, active = threading.get_ident(), True

                @contextmanager
                def held_guard():
                    require(active and threading.get_ident() == owner)
                    yield
                    require(active and threading.get_ident() == owner)

                try:
                    yield held_guard
                finally:
                    active = False
        finally:
            self.service.lock.release()

    def _source(self, source_id, actor, expected=None, *, enrollment=None):
        supplied = {} if enrollment is None else {'enrollment': enrollment}
        inspection = F.bootstrap_source_manager_for(self.service, 'status', {'id': source_id, 'actor': actor}, **supplied)
        require(inspection.enrollment.root == self.enrollment.root and inspection.enrollment.state == self.enrollment.state
                and inspection.enrollment.context == self.enrollment.context)
        record = inspection.record(source_id)
        require(record.get('schema') == POLICY.B.CoreVersionedCleanTargetBootstrap.inspection_schema
                and record.get('actor') == actor and record.get('phase') == 'inspection-complete')
        broker = inspection.configuration
        selected = broker.installed_selection
        binding = {'id': selected.identifier, 'installationSha256': selected.installation_sha256,
                   'sourceControllerImageId': broker.trust.source_controller_image_id}
        require(record.get('installedRuntime') == binding)
        policies = POLICY.CleanTargetMigrationPolicies(inspection.enrollment)
        selection = POLICY.I.InstalledSelection(binding['id'], binding['installationSha256'])
        policy = policies.read(selection, binding['sourceControllerImageId'],
                               expected_sha256=expected['migrationPolicySha256'] if expected else None)
        if expected:
            require(binding == expected['installedRuntime'] and self._digest(record) == expected['sourceRecordSha256'])
        return inspection, policies, record, binding, policy

    def _manager(self, intent, guard, *, enrollment=None):
        inspection, policies, _, _, _ = self._source(intent['sourceInspectionId'], intent['actor'], intent, enrollment=enrollment)
        return policies.bootstrap_for(inspection, intent['sourceInspectionId'], intent['actor'],
            guard=guard, expected_sha256=intent['migrationPolicySha256'])

    def _checked_preparation(self, identifier, actor, guard):
        F.I.require_root()
        actor = self.enrollment.actor(actor)
        require(callable(guard))
        intent = self._intent(self._identifier(identifier))
        require(intent['actor'] == actor)
        with self._lock:
            require(identifier not in self._active)
        require(self._marker(intent, 'failure.json', FAILURE, {'failureClass', 'targetExecutionAdmitted'}) is None)
        complete = self._marker(intent, 'complete.json', COMPLETE, {'targetReceiptSha256'})
        require(complete is not None)
        with guard():
            source, policies, _, _, _ = self._source(intent['sourceInspectionId'], actor, intent, enrollment=self.enrollment)
            manager = policies.bootstrap_for(source, intent['sourceInspectionId'], actor,
                guard=guard, expected_sha256=intent['migrationPolicySha256'])
            handle = POLICY.B.PreparedCleanTarget(identifier, complete['targetReceiptSha256'])
            require(manager.checked(handle, actor) == handle)
        return CheckedPreparation(manager, handle, source, copy.deepcopy(intent))

    def _unfinished(self):
        base = Path(self.enrollment.state) / 'core-clean-target-preparations'
        if not base.exists() and not base.is_symlink():
            return False
        with self.enrollment.a.protected_directory(base):
            entries = list(base.iterdir())
        require(len(entries) < 256)
        for path in entries:
            intent = self._intent(self._identifier(path.name))
            failure = self._marker(intent, 'failure.json', FAILURE, {'failureClass', 'targetExecutionAdmitted'})
            if failure:
                require(type(failure['targetExecutionAdmitted']) is bool)
                if failure['targetExecutionAdmitted'] is False:
                    continue
                return True
            if not self._marker(intent, 'complete.json', COMPLETE, {'targetReceiptSha256'}):
                return True
        return False

    def _public(self, identifier, source_id, phase, *, active=False, available=False):
        return {'version': 1, 'id': identifier, 'sourceInspectionId': source_id, 'phase': phase,
                'preparationActive': active, 'preparedTargetAvailable': available, **FLAGS}

    def prepare(self, request, *, privileged_peer=False):
        actor = self._actor(request, privileged_peer)
        require(self.P.exact(request, {'id', 'sourceInspectionId', 'actor', 'action'}) and request['action'] == ACTION)
        identifier, source_id = self._identifier(request['id']), self._identifier(request['sourceInspectionId'])
        require(identifier != source_id)
        try:
            previous = self._intent(identifier)
        except FileNotFoundError:
            previous = None
        if previous:
            require(previous['actor'] == actor and previous['sourceInspectionId'] == source_id)
            return self.status({'id': identifier, 'actor': actor}, privileged_peer=True)
        token = object()
        with self._lock:
            if self._active:
                raise BlockingIOError('Another preparation is running.')
            self._active[identifier] = {'token': token, 'actor': copy.deepcopy(actor), 'source': source_id,
                                        'phase': 'checking-source', 'manager': None}
        admitted = False
        try:
            with self._operation():
                require(not self._unfinished())
                _, _, record, binding, policy = self._source(source_id, actor)
                intent = {'schema': INTENT, 'id': identifier, 'sourceInspectionId': source_id, 'actor': copy.deepcopy(actor),
                          'root': str(self.enrollment.root), 'context': self.enrollment.context, 'installedRuntime': binding,
                          'sourceRecordSha256': self._digest(record), 'migrationPolicySha256': self._digest(policy),
                          'action': ACTION, **FLAGS}
                directory = self._directory(identifier, create=True)
                self.enrollment.immutable(directory / 'intent.json', self.P.canonical(intent))
            with self._lock:
                self._active[identifier]['phase'] = 'queued'
            worker = self.worker_factory(target=self._execute, args=(identifier, token), daemon=True,
                                         name='orbis-prepare-' + identifier)
            worker.start()
            admitted = True
            return self.status({'id': identifier, 'actor': actor}, privileged_peer=True)
        finally:
            if not admitted:
                with self._lock:
                    if self._active.get(identifier, {}).get('token') is token:
                        del self._active[identifier]
                        self._condition.notify_all()

    def _execute(self, identifier, token):
        intent, target_admitted = None, False
        try:
            intent = self._intent(identifier)
            with self._operation(queued=True) as guard:
                with self._lock:
                    require(self._active.get(identifier, {}).get('token') is token)
                    self._active[identifier]['phase'] = 'checking-source'
                manager = self._manager(intent, guard)
                with self._lock:
                    require(self._active.get(identifier, {}).get('token') is token)
                    self._active[identifier].update(phase='preparing', manager=manager)
                try:
                    manager.record(identifier)
                except FileNotFoundError:
                    pass
                else:
                    target_admitted = True
                    raise ValueError('An existing target cannot be prepared again.')
                manager.capacity(self.enrollment.state)
                target_admitted = True
                prepared = manager.prepare(identifier, intent['actor'])
                checked = manager.checked(prepared, intent['actor'])
                require(type(checked) is POLICY.B.PreparedCleanTarget and checked.identifier == identifier)
                require(isinstance(checked.receipt_sha256, str) and POLICY.I.C.HEX.fullmatch(checked.receipt_sha256))
                complete = {'schema': COMPLETE, 'id': identifier, 'intentSha256': self._digest(intent),
                            'targetReceiptSha256': checked.receipt_sha256, **FLAGS}
                self.enrollment.immutable(self._directory(identifier) / 'complete.json', self.P.canonical(complete))
        except BaseException as error:
            name = type(error).__name__
            name = name if re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,79}', name) else 'PreparationError'
            LOG.warning('Restore preparation %s stopped (%s)', identifier, name)
            if intent is not None:
                failure = {'schema': FAILURE, 'id': identifier, 'intentSha256': self._digest(intent),
                           'failureClass': name, 'targetExecutionAdmitted': target_admitted, **FLAGS}
                try:
                    self.enrollment.immutable(self._directory(identifier) / 'failure.json', self.P.canonical(failure))
                except (OSError, ValueError, TypeError):
                    LOG.warning('Restore preparation %s needs local review', identifier)
        finally:
            with self._lock:
                if self._active.get(identifier, {}).get('token') is token:
                    del self._active[identifier]
                    self._condition.notify_all()

    def wait(self, request, *, privileged_peer=False):
        actor = self._actor(request, privileged_peer)
        require(self.P.exact(request, {'id', 'actor'}))
        identifier = self._identifier(request['id'])
        with self._condition:
            slot = self._active.get(identifier)
            if slot is not None:
                require(slot['actor'] == actor)
            else:
                require(self._intent(identifier)['actor'] == actor)
            self._condition.wait_for(lambda: identifier not in self._active, timeout=WAIT_SECONDS)
        return self.status({'id': identifier, 'actor': actor}, privileged_peer=True)

    def status(self, request, *, privileged_peer=False):
        actor = self._actor(request, privileged_peer)
        require(self.P.exact(request, {'id', 'actor'}))
        identifier = self._identifier(request['id'])
        with self._lock:
            slot = self._active.get(identifier)
            slot = dict(slot) if slot is not None else None
        if slot:
            require(slot['actor'] == actor)
            phase = slot['phase']
            if slot['manager'] is not None:
                try:
                    phase = slot['manager'].record(identifier)['phase']
                except FileNotFoundError:
                    phase = 'preparing'
                if phase == 'complete':
                    phase = 'verifying-preparation'
                require(isinstance(phase, str) and re.fullmatch(r'[a-z][a-z0-9-]{0,63}', phase))
            return self._public(identifier, slot['source'], phase, active=True)
        intent = self._intent(identifier)
        require(intent['actor'] == actor)
        source_id = intent['sourceInspectionId']
        failure = self._marker(intent, 'failure.json', FAILURE, {'failureClass', 'targetExecutionAdmitted'})
        if failure:
            require(type(failure['targetExecutionAdmitted']) is bool)
            return self._public(identifier, source_id, 'recovery-required' if failure['targetExecutionAdmitted'] else 'preparation-blocked')
        complete = self._marker(intent, 'complete.json', COMPLETE, {'targetReceiptSha256'})
        if not complete:
            return self._public(identifier, source_id, 'recovery-required')
        require(isinstance(complete['targetReceiptSha256'], str) and POLICY.I.C.HEX.fullmatch(complete['targetReceiptSha256']))
        try:
            with self._operation() as guard:
                manager = self._manager(intent, guard)
                manager.checked(POLICY.B.PreparedCleanTarget(identifier, complete['targetReceiptSha256']), actor)
        except BlockingIOError:
            return self._public(identifier, source_id, 'checking')
        except (OSError, ValueError, RuntimeError, TypeError, KeyError):
            return self._public(identifier, source_id, 'recovery-required')
        return self._public(identifier, source_id, 'preparation-complete', available=True)
