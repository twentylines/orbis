"""Bind local inspection requests to Root-installed code, never request-selected code."""
import importlib.util
from pathlib import Path


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


L = load('orbis-host-core-local-inspection.py', 'orbis_serviced_local_inspection')
I = load('orbis-host-core-inspection-installation.py', 'orbis_serviced_inspection_installation')


class LocalRecords(L.BASE.CoreRestoreInspection):
    schema = L.CoreLocalRestoreInspection.schema
    profile = L.CoreLocalRestoreInspection.profile


class BootstrapSourceRecords(L.BASE.CoreRestoreInspection):
    schema = L.CoreVersionedBootstrapSourceInspection.schema
    profile = L.CoreVersionedBootstrapSourceInspection.profile


def manager_for(service, action, request):
    return _manager_for(service, action, request, L.CoreLocalRestoreInspection, LocalRecords)


def bootstrap_source_manager_for(service, action, request, *, enrollment=None):
    return _manager_for(service, action, request, L.CoreVersionedBootstrapSourceInspection, BootstrapSourceRecords, enrollment=enrollment)


def _manager_for(service, action, request, manager_type, records_type, *, enrollment=None):
    I.require_root()
    if enrollment is None:
        enrollment = L.BASE.E.CorePortableEnrollment(service)
    elif (type(enrollment) is not L.BASE.E.CorePortableEnrollment or getattr(enrollment, 'service', None) is not service
            or getattr(enrollment, 'host', None) is not service.HOST or getattr(enrollment, 'a', None) is not service.HOST.AUTHORITY
            or getattr(enrollment, 'P', None) is not service.HOST.IDENTITY.PUBLICATION
            or getattr(enrollment, 'root', None) != Path(service.root) or getattr(enrollment, 'context', None) != service.context
            or getattr(enrollment, 'state', None) != Path(service.state_dir)
            or getattr(enrollment, 'runtime', None) is not service.retained_restores().runtime):
        raise L.BASE.InspectionError('authority')
    if (action not in {'prepare', 'approve', 'status'} or not isinstance(request, dict)
            or not L.BASE.E.matches(L.BASE.E.UUID, request.get('id'))):
        raise L.BASE.InspectionError('authority')
    actor = enrollment.actor(request.get('actor'))
    registry = I.InstalledInspectionRuntime(enrollment)
    record = None
    if action == 'prepare':
        if not enrollment.P.exact(request, {'id', 'pointId', 'actor'}) or not L.BASE.E.matches(L.BASE.E.UUID, request['pointId']):
            raise L.BASE.InspectionError('authority')
        try:
            record = records_type(service, enrollment).record(request['id'])
        except FileNotFoundError:
            source = L.LOCAL.CoreLocalInspectionSource(service.root, service.state_dir, service.context, request['pointId'], actor)
            broker = registry.configuration(source.basis()['roles']['controller']['imageId'])
        else:
            if record.get('pointId') != request['pointId']:
                raise L.BASE.InspectionError('authority')
    else:
        record = records_type(service, enrollment).record(request['id'])
    if record is not None:
        if record.get('actor') != actor:
            raise L.BASE.InspectionError('authority')
        binding = record.get('installedRuntime')
        if not enrollment.P.exact(binding, {'id', 'installationSha256', 'sourceControllerImageId'}):
            raise L.BASE.InspectionError('authority')
        selection = I.InstalledSelection(binding['id'], binding['installationSha256'])
        broker = registry.configuration(binding['sourceControllerImageId'], selection)
    return manager_type(service, broker, enrollment)
