import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest


spec = importlib.util.spec_from_file_location('volume_service_test', Path(__file__).with_name('orbis-host-volume-service.py'))
M = importlib.util.module_from_spec(spec); spec.loader.exec_module(M)


class VolumeServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='vs-'); self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.point = '12345678-1234-4123-8123-123456789abc'
        self.appdir = self.root / self.point; self.appdir.mkdir(mode=0o700)
        for name in M._FILES: (self.appdir / name).write_bytes(b'{}'); (self.appdir / name).chmod(0o600)
        self.lockfile = self.root / 'lock'; self.lockfile.write_bytes(b'')
        self.descriptor = os.open(self.lockfile, os.O_RDONLY); self.addCleanup(os.close, self.descriptor)
        self.request = dict(zip(sorted(M._KEYS), [str(index) * 64 for index in range(1, 7)]))
        self.app = {key: value for key, value in self.request.items() if key not in {'token', 'volumeContractSha256'}}
        self.app.update(tokenSha256=hashlib.sha256(self.request['token'].encode()).hexdigest(), appRuntimeDaemonSha256='d' * 64)
        self.runtime = {'sha256': 'e' * 64}
        self.prepared = {'rootSha256': hashlib.sha256(str(self.root).encode()).hexdigest(), 'contextSha256': hashlib.sha256(b'default').hexdigest(),
                         'configuration': {'configurationSetSha256': self.request['configurationSetSha256'], 'controller': {'id': 'a' * 64, 'imageId': 'sha256:' + 'b' * 64}},
                         'publicationReceipt': {'preparationSha256': self.request['preparationSha256']}}
        self.fence = {'schema': 'orbis.controller-capture-fence.v2', 'pointId': self.point, 'createdAt': time.time() - 1,
                      'expiresAt': time.time() + 60, 'token': self.request['token'], 'controllerId': 'a' * 64, 'imageId': 'sha256:' + 'b' * 64,
                      'configurationSetSha256': self.request['configurationSetSha256'], 'preparationSha256': self.request['preparationSha256']}
        self.service = SimpleNamespace(lock=threading.Lock(), root=self.root, state_dir=self.root, context='default',
            capture_fence_fd=self.descriptor, capture_fence_session='fixture-session', reader=SimpleNamespace(socket=lambda: '/fixture.sock'),
            time_machine_capability=lambda _kind: {'contractSha256': self.request['volumeContractSha256']},
            _verify_capture_fence=lambda token: copy.deepcopy(self.fence) if token == self.request['token'] else (_ for _ in ()).throw(ValueError()))
        self.capture = SimpleNamespace(load_preparation=lambda *_: copy.deepcopy(self.prepared), load_app_preparation=lambda *_: copy.deepcopy(self.app),
            app_runtime_bytes=lambda *_: b'{}', app_expectations=lambda *_: {}, directory=lambda *_: self.appdir,
            APP=SimpleNamespace(parse=lambda _: self.runtime, validate=lambda value, _: value, canonical=lambda value: json.dumps(value, sort_keys=True, separators=(',', ':')).encode()))
        self.coordinators = []
        outer = self
        class Coordinator:
            def __init__(self, **kwargs):
                outer.assertFalse(outer.service.lock.locked()); self.guard = kwargs['guard']; self.guard(); outer.coordinators.append(self)
            def prepare(self): self.guard(); return {'version': 1, 'volumes': []}
            def inventory(self): self.guard(); return []
            def verify_stopped(self): self.guard(); return True
        self.adapter = M.VolumeCaptureService(self.service, host=SimpleNamespace(AUTHORITY=SimpleNamespace(OWNER=os.geteuid()), capture_fence_path=lambda _: self.root / 'fence'),
            capture=self.capture, read_fence=lambda _: copy.deepcopy(self.fence), fence_maximum=3600,
            engine_factory=lambda _: SimpleNamespace(), coordinator_factory=Coordinator)

    def test_operations_use_root_origin_and_leave_mutex_free_during_io(self):
        for action in ['prepare', 'inventory', 'verify']:
            result = json.loads(self.adapter.request(action, self.point, self.request))
            self.assertEqual(result['pointId'], self.point)
            self.assertEqual(result['appRuntimeSha256'], self.app['appRuntimeSha256'])
        self.assertEqual(len(self.coordinators), 3)

    def test_request_cannot_supply_runtime_definitions_paths_or_wrong_origin(self):
        for changed in [{**self.request, 'runtime': {}}, {**self.request, 'path': '/outside'}, {**self.request, 'appRuntimeSha256': 'a' * 64},
                        {**self.request, 'token': 'a' * 64}, {**self.request, 'volumeContractSha256': 'a' * 64}]:
            with self.assertRaises(ValueError): self.adapter.request('prepare', self.point, changed)
        self.assertEqual(self.coordinators, [])

    def test_fence_guard_accepts_only_expiry_renewal_and_rejects_revocation(self):
        guard = self.adapter._binding(self.point, self.request)['guard']
        self.fence['expiresAt'] += 5; self.assertTrue(guard())
        self.fence['pointId'] = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        with self.assertRaises(ValueError): guard()

    def test_expired_session_or_changed_origin_is_not_rescued_by_same_token(self):
        guard = self.adapter._binding(self.point, self.request)['guard']
        self.service.capture_fence_session = 'new-session'
        with self.assertRaises(ValueError): guard()
        self.service.capture_fence_session = 'fixture-session'
        self.fence['expiresAt'] = time.time() - 1
        with self.assertRaises(ValueError): guard()

    def test_changed_private_origin_file_is_rejected_between_engine_operations(self):
        guard = self.adapter._binding(self.point, self.request)['guard']
        (self.appdir / 'app-runtime.json').write_bytes(b'{"changed":true}')
        with self.assertRaises(ValueError): guard()

    def test_origin_cannot_borrow_another_controller_or_preparation_fence(self):
        for key in ['controllerId', 'imageId', 'configurationSetSha256', 'preparationSha256']:
            original = self.fence[key]; self.fence[key] = 'f' * 64
            with self.subTest(key=key), self.assertRaises(ValueError): self.adapter._binding(self.point, self.request)
            self.fence[key] = original


if __name__ == '__main__': unittest.main()
