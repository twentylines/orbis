"""Fresh catalog inspections through installed code; no target or activation grant."""
from contextlib import contextmanager
import importlib.util
from pathlib import Path
import threading


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FACTORY = load('orbis-host-core-local-inspection-service.py', 'orbis_bootstrap_inspection_factory')
EXECUTOR = load('orbis-host-core-inspection-executor.py', 'orbis_serviced_bootstrap_inspection_executor')


class BootstrapSourceInspectionService:
    def __init__(self, service):
        self.service = service
        self._lock = threading.Lock()
        self._active = {}

    @contextmanager
    def _working(self, identifier):
        token = object()
        with self._lock:
            if identifier in self._active:
                raise FACTORY.L.BASE.InspectionError('approval')
            self._active[identifier] = token
        try:
            yield
        finally:
            with self._lock:
                if self._active.get(identifier) is token:
                    del self._active[identifier]

    def _manager(self, action, request, privileged_peer):
        if privileged_peer is not True:
            raise FACTORY.L.BASE.InspectionError('authority')
        manager = FACTORY.bootstrap_source_manager_for(self.service, action, request)
        if not callable(getattr(manager.configuration, 'installed_authority', None)):
            raise FACTORY.L.BASE.InspectionError('coordinator')
        return manager

    @contextmanager
    def _operation(self, privileged_peer):
        if privileged_peer is not True:
            raise FACTORY.L.BASE.InspectionError('authority')
        FACTORY.I.require_root()
        with self.service.lock, self.service.HOST.host_lock(self.service.root):
            yield

    def _completed(self, manager, record):
        manager.bootstrap_catalog(record['id'], record['actor'])
        if manager.record(record['id']) != record:
            raise FACTORY.L.BASE.InspectionError('changed')
        # Completion is checked against the owned terminal workers, not the
        # pre-start PGDATA inventory that PostgreSQL legitimately changed.
        result = manager.public(record)
        result.update(phase='inspection-complete', bootstrapCatalogAvailable=True,
                      workerExecutionAvailable=False)
        return result

    def _status(self, manager, request):
        if not manager.P.exact(request, {'id', 'actor'}):
            raise FACTORY.L.BASE.InspectionError('authority')
        record = manager.record(request['id'])
        if record.get('actor') != manager.enrollment.actor(request['actor']):
            raise FACTORY.L.BASE.InspectionError('authority')
        with manager.runtime_authority():
            if record['phase'] == 'inspection-complete':
                return self._completed(manager, record)
            with self._lock:
                active = record['id'] in self._active
            if record['phase'] in {'preparing', 'authorizing', 'inspection-authorized', 'inspecting'}:
                result = manager.public(record)
                result.update(phase=record['phase'] if active else 'recovery-required',
                              workerExecutionAvailable=active, bootstrapCatalogAvailable=False)
                return result
            result = manager.status(request, privileged_peer=True)
            result['workerExecutionAvailable'] = result['phase'] == 'awaiting-approval'
            result['bootstrapCatalogAvailable'] = False
            return result

    def prepare(self, request, *, privileged_peer=False):
        with self._operation(privileged_peer):
            manager = self._manager('prepare', request, privileged_peer)
            with manager.runtime_authority():
                try:
                    manager.record(request['id'])
                except FileNotFoundError:
                    with self._working(request['id']):
                        result = manager.prepare(request, privileged_peer=True)
                        result['workerExecutionAvailable'] = result['phase'] == 'awaiting-approval'
                        result['bootstrapCatalogAvailable'] = False
                        return result
                return self._status(manager, {'id': request['id'], 'actor': request['actor']})

    def approve(self, request, *, privileged_peer=False):
        with self._operation(privileged_peer):
            manager = self._manager('approve', request, privileged_peer)
            with self._working(request['id']), manager.runtime_authority():
                manager.approve(request, privileged_peer=True)
                record = manager.claim_execution(request['id'], request['actor'])
                directory = manager.directory(record['id']) / 'execution'
                worker_request = manager.enrollment.json(directory / 'trusted-input/request.json', 16384)
                supervisor = EXECUTOR.InspectionSupervisor(manager, record)
                supervisor.run_workers(directory, record['evidence']['profile'], worker_request)
                completed = manager.record(record['id'])
                if completed.get('actor') != manager.enrollment.actor(request['actor']):
                    raise FACTORY.L.BASE.InspectionError('authority')
                return self._completed(manager, completed)

    def status(self, request, *, privileged_peer=False):
        manager = self._manager('status', request, privileged_peer)
        return self._status(manager, request)
