"""Bind volume operations to an existing protected controller capture."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import time


def _load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


ENGINE = _load('orbis-host-volume-engine.py', 'volume_service_engine')
COORDINATOR = _load('orbis-host-volume-capture.py', 'volume_service_coordinator')
_HASH = re.compile(r'[a-f0-9]{64}')
_POINT = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
_KEYS = {'token', 'configurationSetSha256', 'preparationSha256', 'publicationProofSha256', 'appRuntimeSha256', 'volumeContractSha256'}
_FILES = ('prepared.json', 'proxy-prepared.json', 'app-prepared.json', 'app-runtime.json', 'app-host-bindings.json')


def fail():
    return ValueError('App storage needs recovery before another backup. Existing app data has not been changed.')


def _seal(details):
    return tuple(getattr(details, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


class VolumeCaptureService:
    def __init__(self, service, *, host, capture, read_fence, fence_maximum, engine_factory=None, coordinator_factory=None):
        self.service, self.host, self.capture, self.read_fence = service, host, capture, read_fence
        self.fence_maximum = fence_maximum
        # Factories are code-owned integration seams, never request fields.
        self.engine_factory = engine_factory or ENGINE.DockerVolumeEngine
        self.coordinator_factory = coordinator_factory or COORDINATOR.VolumeCaptureCoordinator

    def _binding(self, point, request):
        if (not isinstance(point, str) or _POINT.fullmatch(point) is None or not isinstance(request, dict) or set(request) != _KEYS
                or any(not isinstance(value, str) or _HASH.fullmatch(value) is None for value in request.values())):
            raise fail()
        service, capture = self.service, self.capture
        with service.lock:
            capability = service.time_machine_capability('volume')
            if request['volumeContractSha256'] != capability['contractSha256']:
                raise fail()
            fence = service._verify_capture_fence(request['token'])
            if fence['schema'] != 'orbis.controller-capture-fence.v2' or fence['pointId'] != point:
                raise fail()
            prepared = capture.load_preparation(service.state_dir, point)
            app = capture.load_app_preparation(service.state_dir, point, prepared)
            if (prepared['rootSha256'] != hashlib.sha256(str(service.root).encode()).hexdigest()
                    or prepared['contextSha256'] != hashlib.sha256(service.context.encode()).hexdigest()
                    or prepared['configuration']['configurationSetSha256'] != fence['configurationSetSha256']
                    or prepared['publicationReceipt']['preparationSha256'] != fence['preparationSha256']
                    or prepared['configuration']['controller']['id'] != fence['controllerId']
                    or prepared['configuration']['controller']['imageId'] != fence['imageId']
                    or any(request[key] != app[key] for key in ('configurationSetSha256', 'preparationSha256', 'publicationProofSha256', 'appRuntimeSha256'))
                    or app['tokenSha256'] != hashlib.sha256(request['token'].encode()).hexdigest()):
                raise fail()
            body = capture.app_runtime_bytes(service.state_dir, point, request['token'], prepared, app['appRuntimeSha256'])
            runtime = capture.APP.validate(capture.APP.parse(body), capture.app_expectations(prepared, app['appRuntimeDaemonSha256']))
            directory = capture.directory(service.state_dir, point)
            seals = {}
            for name in _FILES:
                file = directory / name
                details = file.lstat()
                if (not stat.S_ISREG(details.st_mode) or details.st_uid != self.host.AUTHORITY.OWNER
                        or details.st_nlink != 1 or stat.S_IMODE(details.st_mode) & 0o077):
                    raise fail()
                seals[name] = _seal(details)
            directory_details = directory.lstat()
            directory_identity = (directory_details.st_dev, directory_details.st_ino, directory_details.st_mode, directory_details.st_uid, directory_details.st_gid)
            descriptor, session = service.capture_fence_fd, service.capture_fence_session
            lock_identity = _seal(os.fstat(descriptor))
            immutable = {key: value for key, value in fence.items() if key != 'expiresAt'}

        def guard():
            with service.lock:
                if service.capture_fence_fd != descriptor or service.capture_fence_session != session or _seal(os.fstat(descriptor)) != lock_identity:
                    raise fail()
                current = self.read_fence(self.host.capture_fence_path(service.root))
                if (not isinstance(current, dict) or {key: value for key, value in current.items() if key != 'expiresAt'} != immutable
                        or type(current.get('expiresAt')) not in (int, float)
                        or not current['createdAt'] <= time.time() < current['expiresAt'] <= current['createdAt'] + self.fence_maximum):
                    raise fail()
                details = directory.lstat()
                if (details.st_dev, details.st_ino, details.st_mode, details.st_uid, details.st_gid) != directory_identity:
                    raise fail()
                for name, expected in seals.items():
                    if _seal((directory / name).lstat()) != expected:
                        raise fail()
            return True

        guard()
        return {'prepared': prepared, 'app': app, 'runtime': runtime, 'capability': capability, 'guard': guard}

    def request(self, action, point, request):
        if action not in {'prepare', 'inventory', 'verify'}:
            raise fail()
        binding = self._binding(point, request)
        guard = binding['guard']
        engine = self.engine_factory(self.service.reader.socket())
        guard()
        coordinator = self.coordinator_factory(
            authority=self.host.AUTHORITY, engine=engine, state_dir=self.service.state_dir,
            runtime=binding['runtime'], controller_id=binding['prepared']['configuration']['controller']['id'],
            image_id=binding['prepared']['configuration']['controller']['imageId'], guard=guard,
        )
        plan = coordinator.prepare() if action == 'prepare' else None
        inventories = coordinator.inventory() if action == 'inventory' else None
        if action == 'verify' and coordinator.verify_stopped() is not True:
            raise fail()
        guard()
        # Recheck the native source contract and protected origin at both ends;
        # per-Engine guards use immutable file seals so renewals stay responsive.
        ending = self._binding(point, request)
        if ending['app'] != binding['app'] or ending['runtime']['sha256'] != binding['runtime']['sha256']:
            raise fail()
        result = {'version': 1, 'pointId': point, 'appRuntimeSha256': request['appRuntimeSha256'],
                  'volumeContractSha256': request['volumeContractSha256']}
        if plan is not None:
            result.update(plan=plan, planSha256=hashlib.sha256(self.capture.APP.canonical(plan)).hexdigest())
        elif inventories is not None:
            result['inventories'] = inventories
        else:
            result['stopped'] = True
        body = json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode('utf8')
        if len(body) > 64 * 1024 * 1024:
            raise fail()
        return body
