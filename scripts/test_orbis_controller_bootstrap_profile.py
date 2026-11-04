import copy
from contextlib import contextmanager
import tempfile
import importlib.util
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


spec = importlib.util.spec_from_file_location('bootstrap_profile_tests', Path(__file__).with_name('orbis-controller-bootstrap-profile.py'))
B = importlib.util.module_from_spec(spec)
spec.loader.exec_module(B)


class BootstrapProfileTests(unittest.TestCase):
    def setUp(self):
        self.now = 1800000000000
        self.publication = {'commit': 'a' * 40, 'digest': 'sha256:' + 'b' * 64}
        self.image = 'sha256:' + 'c' * 64
        self.key = (self.publication['commit'], self.publication['digest'], self.image)
        self.proof = {key: 'd' * 64 for key in B.DIGEST_FIELDS}
        self.proof.update(schema=B.SCHEMA, profile=B.LEGACY, baseVersion='v4.10.1', persistTraefikConfig=False,
                          cacheBusterExpiresAt=self.now + 600000, certificateNotAfter=self.now + 172800000,
                          observedAt=self.now)
        self.profiles = mock.patch.dict(B.LEGACY_SOURCES, {self.key: 'd' * 64}, clear=True)
        self.profiles.start()
        self.addCleanup(self.profiles.stop)

    def test_legacy_profile_requires_exact_source_identity_and_immutable_code(self):
        self.assertEqual(B.validate(self.proof, self.publication, self.image, now=self.now), self.proof)
        for publication, image in (({**self.publication, 'commit': 'e' * 40}, self.image),
                                   ({**self.publication, 'digest': 'sha256:' + 'e' * 64}, self.image),
                                   (self.publication, 'sha256:' + 'e' * 64)):
            with self.assertRaises(B.SourceBootstrapError): B.validate(self.proof, publication, image, now=self.now)
        changed = {**self.proof, 'codeSha256': 'e' * 64}
        with self.assertRaises(B.SourceBootstrapError): B.validate(changed, self.publication, self.image, now=self.now)

    def test_stale_buster_tls_nightly_or_unbound_claims_fail_closed(self):
        for key, value in (('cacheBusterExpiresAt', self.now), ('certificateNotAfter', self.now + 86400000),
                           ('baseVersion', 'nightly'), ('persistTraefikConfig', True), ('observedAt', self.now - 30001),
                           ('observedAt', self.now + 1), ('cacheBusterExpiresAt', True), ('staticSha256', 'wrong')):
            with self.subTest(key=key, value=value):
                with self.assertRaises(B.SourceBootstrapError): B.validate({**self.proof, key: value}, self.publication, self.image, now=self.now)
        with self.assertRaises(B.SourceBootstrapError): B.validate({**self.proof, 'trusted': True}, self.publication, self.image, now=self.now)

    def test_restart_comparison_ignores_only_probe_time(self):
        self.assertEqual(B.comparable(self.proof), B.comparable({**self.proof, 'observedAt': self.now + 1}))
        for key in B.DIGEST_FIELDS | {'certificateNotAfter', 'cacheBusterExpiresAt'}:
            changed = {**self.proof, key: 'changed'}
            self.assertNotEqual(B.comparable(changed), B.comparable(self.proof))

    def test_future_capability_is_exact_and_fresh(self):
        proof = {'schema': B.SCHEMA, 'profile': B.CAPABLE, 'codeSha256': 'a' * 64, 'observedAt': self.now}
        self.assertEqual(B.validate(proof, {}, '', now=self.now), proof)
        for changed in ({**proof, 'observedAt': self.now - 30001}, {**proof, 'extra': True}):
            with self.assertRaises(B.SourceBootstrapError): B.validate(changed, {}, '', now=self.now)

    def test_prunable_or_drifted_networks_fail_and_preserved_running_endpoints_pass(self):
        runtime = mock.Mock()
        updater = SimpleNamespace(runtime=runtime, context='fixture')
        network = '1' * 64
        proxy, database, queue = ('2' * 64, '3' * 64, '4' * 64)
        record = {'proxy': {'Id': proxy}, 'peers': {'database': {'Id': database}, 'queue': {'Id': queue}}, 'appIdentities': {}}
        runtime.bounded_output.return_value = (network + '\n').encode()
        runtime.reader._object.return_value = {'Id': network, 'Labels': {'orbis.managed': 'true'}, 'Containers': {proxy: {}}}
        runtime.inspect.return_value = {'State': {'Running': True}}
        self.assertEqual(B.preserved_networks(updater, record), [{'id': network, 'preservedEndpoints': [proxy]}])
        for endpoints in ({}, {'f' * 64: {}}):
            runtime.reader._object.return_value['Containers'] = endpoints
            with self.assertRaises(B.SourceBootstrapError): B.preserved_networks(updater, record)
        runtime.reader._object.return_value['Containers'] = {proxy: {}}
        runtime.inspect.return_value['State']['Running'] = False
        with self.assertRaises(B.SourceBootstrapError): B.preserved_networks(updater, record)
        runtime.bounded_output.return_value = b''
        self.assertEqual(B.preserved_networks(updater, record), [])

    def test_probe_freezes_code_and_recovery_uses_frozen_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / 'package.py'
            package.with_suffix('.mjs').write_bytes(b'// reviewed probe')
            operation = root / 'operation'
            operation.mkdir()
            @contextmanager
            def protected_directory(path, **kwargs): yield path
            @contextmanager
            def protected_file(path, name, maximum, **kwargs):
                body = (path / name).read_bytes()
                if len(body) > maximum: raise ValueError('too large')
                yield body
            authority = SimpleNamespace(protected_directory=protected_directory, protected_file=protected_file,
                                        atomic=lambda path, body: path.write_bytes(body))
            publication = SimpleNamespace(metadata=lambda body, **kwargs: json.loads(body),
                                          canonical=lambda value: json.dumps(value, sort_keys=True).encode())
            runtime = mock.Mock()
            updater = SimpleNamespace(runtime=runtime, P=publication, a=authority, path=operation,
                                      key='a' * 64, context='fixture', save=lambda record: None,
                                      lookup=mock.Mock(side_effect=ValueError('missing')))
            record = {'current': self.publication, 'source': {'Id': '1' * 64, 'Image': self.image,
                      'Config': {'Env': ['ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=1']}, 'Mounts': []}, 'nonce': 'b' * 64}
            proof = {'schema': B.SCHEMA, 'profile': B.CAPABLE, 'codeSha256': 'd' * 64, 'observedAt': self.now}
            runtime.inspect.return_value = {'Id': '2' * 64, 'Image': self.image, 'State': {'Running': False}}
            runtime.definition.return_value = 'e' * 64
            runtime.engine.side_effect = lambda method, route, *args, **kwargs: json.dumps({'Id': '2' * 64}).encode() if method == 'POST' else None
            runtime.bounded_output.side_effect = lambda arguments, *args: b'0' if 'wait' in arguments else json.dumps(proof).encode()
            with mock.patch.object(B, '__file__', str(package)), mock.patch.object(B, 'require_image_startup'), \
                    mock.patch.object(B.time, 'time', return_value=self.now / 1000):
                record['sourceBootstrapProfile'] = B.probe(updater, record, 'review')
                frozen = operation / 'bootstrap-profile.mjs'
                self.assertEqual(frozen.read_bytes(), b'// reviewed probe')
                package.with_suffix('.mjs').write_bytes(b'// package changed')
                B.probe(updater, record, 'rollback')
                self.assertEqual(frozen.read_bytes(), b'// reviewed probe')
                body = record['bootstrapProbes']['rollback']['body']
                self.assertEqual(body['Cmd'], ['/orbis-probe/profile.mjs'])
                self.assertEqual(body['HostConfig']['Mounts'][0]['Source'], str(frozen))
                self.assertTrue(body['HostConfig']['Mounts'][0]['ReadOnly'])
                self.assertNotIn('id', record['bootstrapProbes']['rollback'])
                self.assertEqual(record['bootstrapProbes']['rollback']['retiredId'], '2' * 64)
                B.probe(updater, record, 'rollback')
                self.assertTrue(record['bootstrapProbeHistory'])
                frozen.write_bytes(b'// tampered')
                with self.assertRaises(B.SourceBootstrapError): B.probe(updater, record, 'rollback')

    def test_source_image_startup_rejects_code_mounts_overrides_and_modified_overlay(self):
        publication = SimpleNamespace(metadata=lambda body, **kwargs: json.loads(body))
        runtime = mock.Mock()
        updater = SimpleNamespace(runtime=runtime, P=publication)
        config = {'Entrypoint': None, 'Cmd': ['node', './main.mjs'], 'WorkingDir': '/app', 'Env': ['TIPI_VERSION=v4.10.1']}
        runtime.image.return_value = {'Id': self.image, 'Config': copy.deepcopy(config)}
        record = {'source': {'Id': '1' * 64, 'Image': self.image, 'Config': copy.deepcopy(config), 'Mounts': []}}
        runtime.engine.return_value = b'[]'
        B.require_image_startup(updater, record)
        for changes in ([{'Path': '/app/main.mjs', 'Kind': 0}], [{'Path': '/app/node_modules/yaml/index.js', 'Kind': 0}],
                        [{'Path': '/usr/local/bin/node', 'Kind': 0}]):
            runtime.engine.return_value = json.dumps(changes).encode()
            with self.assertRaises(B.SourceBootstrapError): B.require_image_startup(updater, record)
        runtime.engine.return_value = b'[]'
        for key, value in (('Cmd', ['node', '/data/unreviewed.js']), ('Env', ['NODE_OPTIONS=--require=/data/unreviewed.js'])):
            changed = copy.deepcopy(record)
            changed['source']['Config'][key] = value
            with self.assertRaises(B.SourceBootstrapError): B.require_image_startup(updater, changed)
        changed = copy.deepcopy(record)
        changed['source']['Mounts'] = [{'Destination': '/app/assets'}]
        with self.assertRaises(B.SourceBootstrapError): B.require_image_startup(updater, changed)


if __name__ == '__main__': unittest.main()
