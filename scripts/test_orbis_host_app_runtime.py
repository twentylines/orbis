import copy
import hashlib
import importlib.util
import json
import base64
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('app_runtime_tests', Path(__file__).with_name('orbis-host-app-runtime.py'))
M = importlib.util.module_from_spec(spec); spec.loader.exec_module(M)


def fixture():
    urn, project, network = 'whoami:demo', 'whoami_demo', 'whoami_demo_default'
    files = [{'name': 'app-data/demo/whoami/app.env', 'bytes': 15, 'sha256': M.digest(b'MODE=saved-new\n')},
             {'name': 'data/apps/demo/whoami/config.json', 'bytes': 3, 'sha256': M.digest(b'{}\n')}]
    item = {'id': 1, 'urn': urn, 'project': project, 'status': 'running', 'pendingRestart': True, 'userConfigEnabled': True,
            'sourceSha256': M.digest(b'orbis.app-runtime-saved-source.v1\n' + M.canonical(files)),
            'configurationSha256': files[1]['sha256'], 'savedFiles': files, 'services': [{'name': 'whoami', 'replicas': 2}]}
    containers = []
    for ordinal, running in [(1, True), (2, False)]:
        identity, source, creation = str(ordinal) * 64, 'sha256:' + str(ordinal + 2) * 64, 'sha256:' + str(ordinal + 4) * 64
        labels = {'com.docker.compose.project': project, 'com.docker.compose.service': 'whoami',
                  'com.docker.compose.container-number': str(ordinal), 'com.docker.compose.oneoff': 'False',
                  'runtipi.appurn': urn, 'runtipi.managed': 'true', '10': 'ten', '2': 'two', '01': 'leading-zero',
                  '__proto__': 'plain-label', 'constructor': 'plain-label', 'prototype': 'plain-label',
                  '\ue000': 'fixture', '\U0001f600': 'fixture'}
        raw = {'Id': identity, 'Name': '/' + project + '-whoami-' + str(ordinal), 'Image': source,
               'Config': {'Image': 'private-fixture-only:point', 'Env': ['MODE=running-old', 'LANGUAGE=中文'], 'Labels': labels,
                          'Cmd': ['whoami'], 'Entrypoint': None, 'User': '', 'Hostname': identity[:12], 'WorkingDir': '', 'ExposedPorts': {'80/tcp': {}}},
               'HostConfig': {'Privileged': False, 'ReadonlyRootfs': False, 'Binds': [], 'Mounts': [], 'OomKillDisable': None,
                              'PublishAllPorts': False, 'PortBindings': {'80/tcp': [{'HostIp': '', 'HostPort': '0'}] if running else [{'HostIp': '0.0.0.0', 'HostPort': '32001'}]},
                              'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0}}, 'Mounts': [],
               'NetworkSettings': {'Ports': {'80/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '32000'}, {'HostIp': '::', 'HostPort': '32000'}]} if running else None,
                                   'Networks': {network: {'NetworkID': 'a' * 64, 'Aliases': [project + '-whoami-' + str(ordinal), 'whoami'],
                                                         'IPAMConfig': None, 'IPAddress': '172.20.0.' + str(ordinal + 1)}}}}
        containers.append({'appUrn': urn, 'service': 'whoami', 'ordinal': ordinal, 'wasRunning': running, 'inspect': raw,
                           'image': {'sourceImageId': source, 'creationReference': creation, 'platform': {'os': 'linux', 'architecture': 'arm64', 'variant': 'v8'},
                                     'selection': 'docker29-platform-manifest.v1'}, 'transformPolicy': M.POLICY})
    expected = {'pointId': '11111111-1111-4111-8111-111111111111', 'rootSha256': 'a' * 64, 'dockerContextSha256': 'b' * 64,
                'daemonSha256': 'c' * 64, 'configurationSetSha256': 'd' * 64, 'preparationSha256': 'e' * 64}
    descriptor = {'schema': M.SCHEMA, 'version': 1, **expected, 'capturedAt': 1793548800000, 'apps': [item], 'containers': containers,
                  'networkDefinitions': [{'name': network, 'sourceNetworkId': 'a' * 64,
                                          'inspect': {'Name': network, 'Id': 'a' * 64, 'Driver': 'bridge', 'Scope': 'local',
                                                      'Internal': False, 'Options': {}, 'IPAM': {'Driver': 'default', 'Config': [{'Subnet': '172.20.0.0/16'}]}}}]}
    return M.seal(descriptor, expected), expected


class AppRuntimeTests(unittest.TestCase):
    def test_canonical_roundtrip_preserves_pending_saved_bytes_and_actual_mixed_replica_runtime(self):
        value, expected = fixture(); body = M.canonical(value)
        self.assertEqual(M.validate(M.parse(body), expected), value)
        self.assertNotEqual(M.digest(body), value['sha256'])
        self.assertTrue(value['apps'][0]['pendingRestart'])
        self.assertEqual(value['containers'][0]['inspect']['Config']['Env'][0], 'MODE=running-old')
        self.assertEqual([item['wasRunning'] for item in value['containers']], [True, False])
        self.assertNotEqual(value['containers'][0]['image']['creationReference'], value['containers'][1]['image']['creationReference'])
        self.assertLess(body.index('😀'.encode()), body.index('\ue000'.encode()))
        self.assertLess(body.index(b'"10":"ten"'), body.index(b'"2":"two"'))

    def test_independent_root_expectations_cannot_be_replaced_by_a_resigned_descriptor(self):
        value, expected = fixture()
        for key in expected:
            modified = copy.deepcopy(value); modified.pop('sha256')
            modified[key] = '22222222-2222-4222-8222-222222222222' if key == 'pointId' else 'f' * 64
            with self.subTest(key=key), self.assertRaises(ValueError): M.seal(modified, expected)

    def test_strict_replica_and_network_bindings_reject_forged_or_incomplete_runtime(self):
        value, expected = fixture()
        def missing(x): x['containers'].pop()
        def duplicate(x): x['containers'][1]['ordinal'] = 1
        def wrong_image(x): x['containers'][0]['image']['sourceImageId'] = 'sha256:' + 'f' * 64
        def wrong_project(x): x['containers'][0]['inspect']['Config']['Labels']['com.docker.compose.project'] = 'other'
        def wrong_network(x): x['networkDefinitions'][0]['sourceNetworkId'] = 'f' * 64
        def extra_network(x): x['networkDefinitions'].append({'name': 'zzz', 'sourceNetworkId': 'f' * 64, 'inspect': {'Name': 'zzz', 'Id': 'f' * 64}})
        def unsafe_source(x): x['apps'][0]['savedFiles'][0]['name'] = '../app.env'
        def wrong_config(x): x['apps'][0]['configurationSha256'] = 'f' * 64
        def transient(x): x['apps'][0]['status'] = 'starting'
        for change in (missing, duplicate, wrong_image, wrong_project, wrong_network, extra_network, unsafe_source, wrong_config, transient):
            modified = copy.deepcopy(value); modified.pop('sha256'); change(modified)
            with self.subTest(change=change.__name__), self.assertRaises(ValueError): M.seal(modified, expected)

    def test_parser_rejects_duplicate_float_unsafe_integer_surrogate_depth_and_size(self):
        for body in (b'{"x":1,"x":2}', b'{"x":1.0}', b'{"x":NaN}', b'{"x":9007199254740992}', b'{"x":"\\ud800"}',
                     ('{"x":' + '[' * 40 + '0' + ']' * 40 + '}').encode(), b' ' * (M.MAX_BYTES + 1)):
            with self.subTest(body=body[:50]), self.assertRaises(ValueError): M.parse(body)

    def test_missing_app_records_explicit_absence_without_fabricating_a_container(self):
        value, expected = fixture(); value.pop('sha256'); app = value['apps'][0]
        app.update(status='missing', savedFiles=[], services=[], configurationSha256=M.digest(b''),
                   sourceSha256=M.digest(b'orbis.app-runtime-saved-source.v1\n' + M.canonical([])))
        value.update(containers=[], networkDefinitions=[])
        self.assertEqual(M.seal(value, expected)['containers'], [])
        app['status'] = 'running'
        with self.assertRaises(ValueError): M.seal(value, expected)

    def test_custom_user_store_is_exact_reserved_namespace_and_paths_remain_fixed(self):
        value, expected = fixture(); value.pop('sha256'); app = value['apps'][0]
        app.update(urn='custom-app:_user', project='custom-app__user')
        for file in app['savedFiles']: file['name'] = file['name'].replace('demo/whoami', '_user/custom-app')
        app['sourceSha256'] = M.digest(b'orbis.app-runtime-saved-source.v1\n' + M.canonical(app['savedFiles']))
        for container in value['containers']:
            container['appUrn'] = app['urn']; labels = container['inspect']['Config']['Labels']
            labels.update({'runtipi.appurn': app['urn'], 'com.docker.compose.project': app['project']})
        M.seal(value, expected)
        for bad in ['_user:demo', 'custom-app:_other', 'custom-app:../_user', 'custom-app:_user/other']:
            with self.subTest(bad=bad), self.assertRaises(ValueError): M.saved_names(bad)

    def test_actual_ports_accept_ipv4_ipv6_but_no_unknown_unallocated_or_duplicate_binding(self):
        M.ports(None); M.ports({'80/tcp': None, '53/udp': [], '9000/sctp': [{'HostIp': '::1', 'HostPort': '65535'}]})
        for bad in [{'0/tcp': None}, {'080/tcp': None}, {'65536/tcp': None}, {'80/http': None},
                    {'80/tcp': [{'HostIp': '', 'HostPort': '80'}]}, {'80/tcp': [{'HostIp': 'fe80::1%eth0', 'HostPort': '80'}]},
                    {'80/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '0'}]}, {'80/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '080'}]},
                    {'80/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '80'}] * 2}]:
            with self.subTest(bad=bad), self.assertRaises(ValueError): M.ports(bad)


class RootObserverTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('app_observer_authority', Path(__file__).with_name('orbis-host-retained-authority.py'))
        self.a = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.a)
        self.enterContext(mock.patch.object(self.a, 'OWNER', os.geteuid()))
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / 'installation'; self.root.mkdir(mode=0o700)
        (self.root / 'user-config').mkdir(mode=0o700)
        for name, body in [('apps/demo/whoami/config.json', b'{"pendingRestart":true}\n'),
                           ('app-data/demo/whoami/app.env', b'MODE=saved-new\n')]:
            file = self.root / name; file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            file.write_bytes(body); file.chmod(0o600)
        self.original, expected = fixture()
        self.point = expected['pointId']; self.controller_id, self.database_id = '8' * 64, '9' * 64
        controller = {'Id': self.controller_id, 'Image': 'sha256:' + '7' * 64, 'State': {'Running': True}, 'Config': {'Env': []},
                      'Mounts': [{'Type': 'bind', 'Source': str(self.root / 'apps'), 'Destination': '/data/apps', 'RW': True},
                                 {'Type': 'bind', 'Source': str(self.root / 'user-config'), 'Destination': '/data/user-config', 'RW': True},
                                 {'Type': 'bind', 'Source': str(self.root / 'app-data'), 'Destination': '/app-data', 'RW': True}],
                      'NetworkSettings': {'Networks': {'core': {'NetworkID': 'b' * 64}}}}
        database = {'Id': self.database_id, 'Name': '/runtipi-db', 'State': {'Running': True}, 'Mounts': [],
                    'Config': {'Labels': {'com.docker.compose.project': 'runtipi', 'com.docker.compose.service': 'runtipi-db',
                                          'com.docker.compose.project.working_dir': str(self.root)}},
                    'NetworkSettings': {'Networks': {'core': {'NetworkID': 'b' * 64, 'Aliases': ['runtipi-db']}}}}
        self.raws = {self.controller_id: controller, self.database_id: database}; self.images = {}; self.networks = {}
        for container in self.original['containers']:
            raw = copy.deepcopy(container['inspect']); raw['State'] = {'Status': 'running' if container['wasRunning'] else 'exited', 'Running': container['wasRunning']}
            raw['HostConfig']['AutoRemove'] = False
            self.raws[raw['Id']] = raw
            self.images[raw['Image']] = {'Id': raw['Image'], 'Manifests': [{'Kind': 'image', 'Available': True,
                'Descriptor': {'digest': container['image']['creationReference']}, 'ImageData': {'Platform': container['image']['platform']}}]}
        for network in self.original['networkDefinitions']: self.networks[network['name']] = network['inspect']
        self.rows = {'apps': [{key: self.original['apps'][0][key] for key in ('id', 'urn', 'status', 'pendingRestart', 'userConfigEnabled')}]}
        self.commands = []
        def output(arguments, maximum, timeout):
            self.assertGreater(timeout, 0); self.assertLessEqual(timeout, 30)
            args = arguments[3:]; self.commands.append(args)
            if args[0] == 'info': value = {'ID': 'independent-local-daemon', 'DriverStatus': [['driver-type', 'io.containerd.snapshotter.v1']]}
            elif args[:2] == ['container', 'ls']: return ('\n'.join(self.raws) + '\n').encode()
            elif args[:2] == ['container', 'inspect']: value = self.raws[self.database_id if args[-1] == 'runtipi-db' else args[-1]]
            elif args[0] == 'exec':
                self.assertEqual(args[1], self.database_id); self.assertIn('FROM public.app', args[-1]); value = self.rows
            elif args[:2] == ['image', 'inspect']: value = self.images[args[-1]]
            elif args[:2] == ['network', 'inspect']: value = self.networks[args[-1]]
            else: self.fail('unexpected observer command')
            body = M.canonical(value); self.assertLessEqual(len(body), maximum); return body
        self.driver = SimpleNamespace(a=self.a, bounded_output=output)
        self.service = SimpleNamespace(root=self.root, context='fixture')
        env = b'POSTGRES_HOST=runtipi-db\nPOSTGRES_USERNAME=tipi\nPOSTGRES_DBNAME=tipi\n'
        self.prepared = {'configuration': {'controller': {'id': self.controller_id, 'imageId': controller['Image']},
                                         'configurationSetSha256': 'd' * 64,
                                         'files': [{'path': '.env', 'present': True, 'data': base64.b64encode(env).decode(),
                                                    'bytes': len(env), 'sha256': M.digest(env)}]},
                         'publicationReceipt': {'preparationSha256': 'e' * 64, 'proof': {'platform': {'os': 'linux', 'architecture': 'arm64'}}}}

    def observe(self):
        return M.observe(self.service, self.prepared, None, self.point, driver=self.driver)

    def test_root_reads_database_files_full_runtime_and_replica_images_without_client_ids(self):
        value = self.observe()
        self.assertEqual(value['daemonSha256'], M.digest(b'independent-local-daemon'))
        self.assertEqual(value['rootSha256'], M.digest(str(self.root).encode()))
        self.assertEqual(value['apps'][0]['services'], [{'name': 'whoami', 'replicas': 2}])
        self.assertTrue(value['apps'][0]['pendingRestart'])
        self.assertEqual(value['containers'][0]['inspect']['Config']['Env'][0], 'MODE=running-old')
        self.assertEqual(value['containers'][1]['wasRunning'], False)
        self.assertEqual(value['apps'][0]['savedFiles'][0]['sha256'], M.digest(b'MODE=saved-new\n'))
        self.assertTrue(any(args[0] == 'exec' for args in self.commands))
        self.assertEqual(M.observe_bindings(value), [])

    def test_root_rejects_unknown_writer_source_symlink_transient_database_or_wrong_replica(self):
        unknown = {'Id': '0' * 64, 'Config': {'Labels': {}}, 'State': {'Running': True},
                   'Mounts': [{'Type': 'bind', 'RW': True, 'Source': str(self.root / 'apps' / 'demo')}]}
        self.raws[unknown['Id']] = unknown
        with self.assertRaises(ValueError): self.observe()
        del self.raws[unknown['Id']]
        self.rows['apps'][0]['status'] = 'installing'
        with self.assertRaises(ValueError): self.observe()
        self.rows['apps'][0]['status'] = 'running'
        self.raws['2' * 64]['HostConfig']['AutoRemove'] = True
        with self.assertRaises(ValueError): self.observe()
        self.raws['2' * 64]['HostConfig']['AutoRemove'] = False
        self.raws['2' * 64]['Config']['Labels']['com.docker.compose.container-number'] = '3'
        with self.assertRaises(ValueError): self.observe()
        self.raws['2' * 64]['Config']['Labels']['com.docker.compose.container-number'] = '2'
        file = self.root / 'apps/demo/whoami/config.json'; file.unlink(); file.symlink_to(self.root / 'app-data/demo/whoami/app.env')
        with self.assertRaises((ValueError, OSError)): self.observe()

    def test_host_bind_identity_never_creates_missing_paths_or_follows_symlinks(self):
        value = self.observe(); directory = self.root / 'external'; directory.mkdir()
        value['containers'][0]['inspect']['Mounts'] = [{'Type': 'bind', 'Source': str(directory), 'Destination': '/media', 'RW': False}]
        first = M.observe_bindings(value)
        directory.rename(self.root / 'previous'); directory.mkdir()
        self.assertNotEqual(first, M.observe_bindings(value))
        directory.rmdir()
        with self.assertRaises(FileNotFoundError): M.observe_bindings(value)
        self.assertFalse(directory.exists())
        directory.symlink_to(self.root / 'previous')
        with self.assertRaises(ValueError): M.observe_bindings(value)

    def test_managed_orphan_without_storage_cannot_disappear_from_root_app_inventory(self):
        identifier = '0' * 64
        self.raws[identifier] = {'Id': identifier, 'Config': {'Labels': {'runtipi.managed': 'true',
            'runtipi.appurn': 'orphan:demo', 'com.docker.compose.project': 'orphan_demo'}}, 'State': {'Running': False}, 'Mounts': []}
        with self.assertRaises(ValueError): self.observe()
        self.raws[identifier]['Config']['Labels'].pop('runtipi.appurn')
        with self.assertRaises(ValueError): self.observe()
        self.raws[identifier]['Config']['Labels'] = {}
        self.assertEqual(len(self.observe()['containers']), 2)

    def test_disabled_override_saved_bytes_are_preserved_without_enabling_or_applying_them(self):
        file = self.root / 'user-config/demo/whoami/docker-compose.yml'
        file.parent.mkdir(mode=0o700, parents=True)
        body = b'services: {whoami: {environment: [MODE=disabled-saved]}}\n'
        file.write_bytes(body); file.chmod(0o600)
        self.rows['apps'][0]['userConfigEnabled'] = False
        value = self.observe(); app = value['apps'][0]
        self.assertFalse(app['userConfigEnabled'])
        self.assertIn({'name': 'data/user-config/demo/whoami/docker-compose.yml', 'bytes': len(body), 'sha256': M.digest(body)}, app['savedFiles'])
        self.assertEqual(value['containers'][0]['inspect']['Config']['Env'][0], 'MODE=running-old')

    def test_quiescence_allows_only_known_stop_and_endpoint_changes(self):
        original = self.observe(); stopped = copy.deepcopy(original)
        for item in stopped['containers']:
            item['wasRunning'] = False
            item['inspect']['NetworkSettings']['Ports'] = {}
            for endpoint in item['inspect']['NetworkSettings']['Networks'].values(): endpoint.update(IPAddress='', NetworkID='', EndpointID='')
        stopped['capturedAt'] += 1
        M.verify_quiesced(original, stopped)
        stopped['containers'][0]['inspect']['Config']['Env'].append('UNREVIEWED=1')
        with self.assertRaises(ValueError): M.verify_quiesced(original, stopped)


if __name__ == '__main__': unittest.main()
