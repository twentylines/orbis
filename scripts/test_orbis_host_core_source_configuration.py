"""Synthetic IO/supervisor fixtures; these do not exercise Docker or Linux isolation."""
import contextlib
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('configuration_broker', Path(__file__).with_name('orbis-host-core-source-configuration.py'))
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class Publication:
    @staticmethod
    def canonical(value):
        return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    @staticmethod
    def metadata(body, **kwargs):
        return json.loads(body)
    @staticmethod
    def exact(value, fields):
        return isinstance(value, dict) and set(value) == fields


class Authority:
    OWNER = os.getuid()
    @contextlib.contextmanager
    def protected_directory(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            yield fd
        finally:
            os.close(fd)
    @staticmethod
    def atomic(path, body):
        path.write_bytes(body)
    @staticmethod
    def seal(s):
        return (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)


class Enrollment:
    def __init__(self, root):
        self.a, self.P, self.root, self.state, self.context = Authority(), Publication(), root, root, 'fixture'
        self.runtime = Runtime()
    def child(self, parent, name):
        p = parent / name
        p.mkdir(mode=0o700, exist_ok=True)
        return p
    def sync(self, directory):
        pass
    def actor(self, actor):
        return copy.deepcopy(actor)
    def read(self, path, maximum):
        body = path.read_bytes()
        if len(body) > maximum:
            raise ValueError()
        return body
    def json(self, path, maximum):
        return json.loads(self.read(path, maximum))
    def immutable(self, path, body):
        with path.open('xb') as f:
            f.write(body)
        path.chmod(0o400)


class Runtime:
    def image(self, image):
        return {'Id': image, 'Os': 'linux', 'Architecture': 'arm64', 'Config': {'Volumes': None}}
    def definition(self, raw):
        return 'd' * 64


class Source:
    def __init__(self, actor, image):
        self.actor, self.image = actor, image
        self.configuration = b'JWT_SECRET=' + b'x' * 32 + b'\nPOSTGRES_USERNAME=owner\nPOSTGRES_DBNAME=orbis\n'
        self.passkeys = b'{"keys":[]}'
    def basis(self):
        return {'origin': 'genuine-root-local-capture', 'sourceAuthority': True, 'environmentProved': False,
                'restoreAuthority': False, 'sourceWitnessSha256': 'a' * 64, 'sourceManifestSha256': 'b' * 64,
                'roles': {'controller': {'imageId': self.image}}, 'sourceControllerFrame': {'imageId': self.image}, 'actor': self.actor}
    @contextlib.contextmanager
    def open_configuration_source(self, image, profile):
        def selection(body):
            return {'mountSha256': 'c' * 64, 'addressSha256': 'd' * 64, 'resourceRecordSha256': 'e' * 64,
                    'present': body is not None, 'sha256': module.sha(body) if body is not None else None,
                    'bytes': len(body) if body is not None else 0}
        witness = {'schema': 'orbis.core-local-configuration-source.v1', 'sourceWitnessSha256': 'a' * 64,
                   'sourceManifestSha256': 'b' * 64, 'controllerImageId': image, 'parserProfile': profile,
                   'sourceConfigurationFileSha256': module.sha(self.configuration), 'configuration': selection(self.configuration),
                   'passkeys': selection(self.passkeys), 'environmentProved': False, 'restoreAuthority': False}
        yield type('Selected', (), {'configuration': self.configuration, 'passkeys': self.passkeys, 'witness': witness})()


class Supervisor:
    mode = 'success'
    state = {'Status': 'exited', 'Running': False, 'Restarting': False, 'Dead': False, 'OOMKilled': False,
             'ExitCode': 0, 'FinishedAt': '2026-01-01T00:00:00Z'}
    def __init__(self, manager, record):
        self.manager, self.record = manager, record
    def create_start(self, role, body):
        self.record['inspectionWorkers'] = {role: {'id': 'f' * 64, 'body': body, 'intent': 'running', 'definitionSha256': 'd' * 64}}
        self.manager.save(self.record)
        if self.mode == 'missing':
            raise RuntimeError('fixture secret must not escape')
    def wait(self, role, timeout):
        if self.mode in ('ambiguous', 'failed'):
            raise RuntimeError('fixture secret must not escape')
        worker = self.record['inspectionWorkers'][role]
        worker.update(intent='complete', terminal={'id': worker['id'], 'definitionSha256': 'd' * 64, 'state': copy.deepcopy(self.state)})
        request = self.record['request']
        auth = Publication.canonical({'jwtSecret': 'x' * 32, 'passkeys': {'keys': []} if request['passkeysSha256'] else None})
        projection = {'schema': 'orbis.core-source-environment.v2', **{k: request[k] for k in ('parserProfile', 'sourceWitnessSha256', 'sourceManifestSha256', 'controllerImageId', 'configurationSha256', 'passkeysSha256')},
                      'controllerEnvironmentSha256': None, 'databaseEnvironmentSha256': None, 'role': 'owner', 'database': 'orbis',
                      'sourceAuthenticationSha256': module.sha(auth), 'basis': 'captured-configuration-candidate',
                      'environmentBasis': 'captured-complete-configuration', 'environmentProved': False, 'restoreAuthority': False}
        report = {'schema': 'orbis.core-source-configuration-worker-result.v1', 'id': request['id'], 'nonce': request['nonce'],
                  'inputSha256': module.sha(Publication.canonical(request)), 'projection': projection, 'restoreAuthority': False}
        output = self.manager.directory(self.record['id']) / 'output'
        self.manager.enrollment.immutable(output / 'result.json', Publication.canonical(report))
        self.manager.enrollment.immutable(output / 'source-authentication.json', auth)
        self.manager.save(self.record)
    def inspect(self, role):
        return {'State': copy.deepcopy(self.state)}


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='source-config-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.code = self.root / 'code'
        self.code.mkdir(mode=0o700)
        code = self.code / 'core-source-configuration-worker.mjs'
        code.write_bytes(b'fixture')
        code.chmod(0o400)
        self.identifier = 'cfc625c5-a7a9-4a77-b880-d870872aa504'
        self.actor = {'ownerId': 1, 'sessionBinding': 'a' * 64, 'securityBinding': 'b' * 64}
        self.image = 'sha256:' + '1' * 64
        self.trust = module.TrustedCoordinator(self.image, 'arm64', self.code,
                         {code.name: {'bytes': 7, 'sha256': module.sha(b'fixture')}}, self.image, module.PARSER)
        self.enrollment = Enrollment(self.root)
        self.source = Source(self.actor, self.image)
        self.broker = module.CoreSourceConfigurationPreparation(self.enrollment, self.trust)
        self.patcher = mock.patch.object(module.SUPERVISOR, 'InspectionSupervisor', Supervisor)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        Supervisor.mode = 'success'
        Supervisor.state['ExitCode'] = 0
    def prepare(self):
        return self.broker.prepare(self.identifier, self.actor, self.source)
    def test_success_and_exclusive(self):
        result = self.prepare()
        self.assertEqual(result, self.broker.checked(self.identifier, self.actor, self.source))
        record_bytes = (self.broker.directory(self.identifier) / 'job.json').read_bytes()
        self.assertNotIn(b'x' * 32, record_bytes)
        self.assertNotIn(b'JWT_SECRET', record_bytes)
        with self.assertRaises(Exception):
            self.prepare()
    def test_absent_passkeys(self):
        self.source.passkeys = None
        result = self.prepare()
        self.assertEqual(result, self.broker.checked(self.identifier, self.actor, self.source))
    def test_input_and_extra_output_rejected(self):
        self.prepare()
        directory = self.broker.directory(self.identifier)
        configuration = directory / 'input/configuration.env'
        configuration.chmod(0o600)
        configuration.write_bytes(b'changed')
        with self.assertRaises(module.PreparationError):
            self.broker.checked(self.identifier, self.actor, self.source)
        configuration.write_bytes(self.source.configuration)
        (directory / 'output/extra').write_bytes(b'')
        with self.assertRaises(module.PreparationError):
            self.broker.checked(self.identifier, self.actor, self.source)

    def test_rejected_actor_creates_no_preparation(self):
        with mock.patch.object(self.enrollment, 'actor', side_effect=ValueError('invalid actor')):
            with self.assertRaises(ValueError):
                self.prepare()
        self.assertFalse((self.root / 'core-source-configuration-preparations').exists())

    def test_projection_body_has_only_private_code_input_and_output_mounts(self):
        directory = self.root / 'private-projection'
        body = self.broker.body(directory, self.identifier, 'e' * 64)
        self.assertEqual(body['Image'], self.image)
        self.assertEqual(body['User'], '0:0')
        self.assertEqual(body['Entrypoint'], ['node'])
        self.assertEqual(body['Cmd'], ['/app/core-source-configuration/core-source-configuration-worker.mjs', '--project'])
        self.assertEqual(body['Healthcheck'], {'Test': ['NONE']})
        host = body['HostConfig']
        for name, value in {'NetworkMode': 'none', 'ReadonlyRootfs': True, 'Privileged': False,
                            'AutoRemove': False, 'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges'],
                            'IpcMode': 'private', 'CgroupnsMode': 'private', 'PidsLimit': 64,
                            'Memory': 256 * 1024 ** 2, 'NanoCpus': 1_000_000_000,
                            'LogConfig': {'Type': 'none', 'Config': {}}}.items():
            self.assertEqual(host[name], value)
        self.assertEqual([(m['Source'], m['Target'], m['ReadOnly']) for m in host['Mounts']], [
            (str(self.code), '/app/core-source-configuration', True),
            (str(directory / 'input'), '/source-configuration-input', True),
            (str(directory / 'output'), '/source-configuration-output', False),
        ])
        self.assertFalse(any(key in host for key in ('Binds', 'Devices', 'VolumesFrom', 'PidMode')))
    def test_source_configuration_and_passkeys_change(self):
        self.prepare()
        for attribute in ('configuration', 'passkeys'):
            old = getattr(self.source, attribute)
            setattr(self.source, attribute, old + b' ')
            with self.assertRaises(module.PreparationError):
                self.broker.checked(self.identifier, self.actor, self.source)
            setattr(self.source, attribute, old)
    def test_actor_code_and_image_change(self):
        self.prepare()
        with self.assertRaises(module.PreparationError):
            self.broker.checked(self.identifier, {}, self.source)
        code = self.code / 'core-source-configuration-worker.mjs'
        code.chmod(0o600)
        code.write_bytes(b'changed')
        with self.assertRaises(module.PreparationError):
            self.broker.checked(self.identifier, self.actor, self.source)
        code.write_bytes(b'fixture')
        with mock.patch.object(self.enrollment.runtime, 'image', return_value={'Id': 'wrong'}):
            with self.assertRaises(module.PreparationError):
                self.broker.checked(self.identifier, self.actor, self.source)
    def test_output_nonce_and_worker_change(self):
        self.prepare()
        directory = self.broker.directory(self.identifier)
        result = directory / 'output/result.json'
        original = result.read_bytes()
        report = json.loads(original)
        report['nonce'] = '0' * 64
        result.chmod(0o600)
        result.write_bytes(Publication.canonical(report))
        result.chmod(0o400)
        with self.assertRaises(module.PreparationError):
            self.broker.checked(self.identifier, self.actor, self.source)
        result.chmod(0o600)
        result.write_bytes(original)
        result.chmod(0o400)
        Supervisor.state['ExitCode'] = 1
        with self.assertRaises(module.PreparationError):
            self.broker.checked(self.identifier, self.actor, self.source)
    def test_worker_failure_is_generic_and_recovery_required(self):
        for mode in ('missing', 'ambiguous', 'failed'):
            with self.subTest(mode=mode):
                Supervisor.mode = mode
                self.identifier = {'missing': 'cfc625c5-a7a9-4a77-b880-d870872aa504', 'ambiguous': 'cfc625c5-a7a9-4a77-b880-d870872aa505', 'failed': 'cfc625c5-a7a9-4a77-b880-d870872aa506'}[mode]
                with self.assertRaises(module.PreparationError) as error:
                    self.prepare()
                self.assertNotIn('secret', str(error.exception))
                self.assertEqual(self.broker.record(self.identifier)['phase'], 'recovery-required')
                with self.assertRaises(module.PreparationError):
                    self.broker.checked(self.identifier, self.actor, self.source)


if __name__ == '__main__':
    unittest.main()
