import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock


def load(filename, name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


M = load('orbis-host-app-create-intent.py', 'app_create_intent_test')
R = load('orbis-host-retained-restore-runtime.py', 'app_create_existing_comparator_test')
A = load('orbis-host-app-runtime.py', 'app_create_protected_descriptor_test')


def fixture(ordinal=1, running=True):
    labels = {'runtipi.appurn': 'whoami:demo', 'runtipi.managed': 'true', 'com.docker.compose.project': 'whoami_demo',
              'com.docker.compose.service': 'web', 'com.docker.compose.container-number': str(ordinal),
              'com.docker.compose.oneoff': 'False', 'vendor': 'fixture', '10': 'ten', '2': 'two'}
    config = {'Hostname': 'historical-web-' + str(ordinal), 'Domainname': '', 'User': '1000:1000',
              'AttachStdin': False, 'AttachStdout': True, 'AttachStderr': True, 'Tty': False,
              'OpenStdin': False, 'StdinOnce': False, 'Env': ['BASE=image', 'MODE=running-old', 'TOKEN_SHAPE=a=b', 'LANGUAGE=中文'],
              'Cmd': ['serve', '--actual'], 'Healthcheck': {'Test': ['CMD', '/health'], 'Interval': 30000000000,
                                                          'Timeout': 1000000000, 'Retries': 3, 'StartPeriod': 5000000000},
              'Image': 'saved-tag:may-have-moved', 'Volumes': {'/config': {}}, 'WorkingDir': '/work',
              'Entrypoint': ['/entry'], 'Labels': labels, 'StopSignal': 'SIGTERM', 'StopTimeout': 20,
              'ExposedPorts': {'8080/tcp': {}, '9090/udp': {}, '80/tcp': {}}, 'Shell': ['/bin/sh', '-c']}
    host = {'AutoRemove': False, 'Binds': ['/srv/orbis/app-data/demo/whoami:/config:rw,z'],
            'Mounts': [{'Type': 'bind', 'Source': '/srv/orbis/apps/demo/whoami/actual.json', 'Target': '/source',
                        'ReadOnly': True, 'BindOptions': {'Propagation': 'rprivate'}}],
            'NetworkMode': 'whoami_demo_default', 'PortBindings': {'8080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18080'}],
                                                                '9090/udp': [{'HostIp': '::1', 'HostPort': '19090'}]},
            'PublishAllPorts': False, 'Privileged': False, 'ReadonlyRootfs': True, 'CapAdd': ['NET_BIND_SERVICE'],
            'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges:true'], 'GroupAdd': ['44'],
            'RestartPolicy': {'Name': 'on-failure', 'MaximumRetryCount': 5}, 'Memory': 268435456,
            'MemorySwap': 536870912, 'NanoCpus': 500000000, 'PidsLimit': 128, 'OomKillDisable': None,
            'Devices': [{'PathOnHost': '/dev/dri/renderD128', 'PathInContainer': '/dev/dri/renderD128', 'CgroupPermissions': 'rwm'}],
            'DeviceRequests': [], 'Dns': ['1.1.1.1'], 'DnsSearch': ['local'], 'ExtraHosts': ['fixture:192.0.2.10'],
            'IpcMode': 'private', 'PidMode': '', 'UTSMode': '', 'UsernsMode': '', 'CgroupnsMode': 'private',
            'MaskedPaths': ['/proc/kcore'], 'ReadonlyPaths': ['/proc/sys'], 'Ulimits': [{'Name': 'nofile', 'Soft': 4096, 'Hard': 4096}],
            'Sysctls': {'net.ipv4.ip_unprivileged_port_start': '0'}, 'LogConfig': {'Type': 'json-file', 'Config': {'max-size': '10m'}}}
    endpoint = {'NetworkID': 'a' * 64, 'EndpointID': '1' * 64, 'Gateway': '172.20.0.1', 'IPAddress': '172.20.0.2',
                'IPPrefixLen': 16, 'IPv6Gateway': '', 'GlobalIPv6Address': '', 'GlobalIPv6PrefixLen': 0,
                'DNSNames': ['historical-web'], 'MacAddress': '02:42:ac:14:00:02',
                'IPAMConfig': {'IPv4Address': '172.20.0.2', 'IPv6Address': '', 'LinkLocalIPs': []},
                'Links': None, 'Aliases': ['web', 'historical-web-' + str(ordinal)], 'DriverOpts': {'fixture': 'old'}, 'GwPriority': 10}
    second = copy.deepcopy(endpoint); second.update(NetworkID='b' * 64, IPAMConfig=None, MacAddress='02:42:ac:15:00:02', GwPriority=0)
    ports = copy.deepcopy(host['PortBindings']) if running else None
    if ports is not None: ports['80/tcp'] = None
    raw = {'Id': str(ordinal) * 64, 'Name': '/whoami_demo-web-' + str(ordinal), 'Image': 'sha256:' + '3' * 64,
           'Config': config, 'HostConfig': host,
           'Mounts': [{'Type': 'bind', 'Source': '/srv/orbis/app-data/demo/whoami', 'Destination': '/config', 'Mode': 'rw,z', 'RW': True, 'Propagation': 'rprivate'},
                      {'Type': 'bind', 'Source': '/srv/orbis/apps/demo/whoami/actual.json', 'Destination': '/source', 'Mode': '', 'RW': False, 'Propagation': 'rprivate'}],
           'NetworkSettings': {'Networks': {'whoami_demo_default': endpoint, 'shared': second}, 'Ports': ports}}
    row = {'appUrn': 'whoami:demo', 'service': 'web', 'ordinal': ordinal, 'wasRunning': running, 'inspect': raw,
           'image': {'sourceImageId': raw['Image'], 'creationReference': 'sha256:' + '4' * 64,
                     'platform': {'os': 'linux', 'architecture': 'arm64', 'variant': 'v8'}, 'selection': 'docker29-platform-manifest.v1'},
           'transformPolicy': M.POLICY}
    networks = {}
    for name, identity, subnet in [('whoami_demo_default', 'a', '172.20.0.0/16'), ('shared', 'b', '172.21.0.0/16')]:
        desired = {'Id': identity * 64, 'Name': name, 'Created': '2026-10-01T00:00:00Z', 'Scope': 'local', 'Driver': 'bridge',
                   'EnableIPv4': True, 'EnableIPv6': False, 'Internal': False, 'Attachable': False, 'Ingress': False,
                   'ConfigOnly': False, 'ConfigFrom': {'Network': ''}, 'Options': {}, 'Labels': {'fixture': 'actual'},
                   'IPAM': {'Driver': 'default', 'Options': None, 'Config': [{'Subnet': subnet}]},
                   'Containers': {raw['Id']: {'Name': raw['Name'][1:]}}}
        current = copy.deepcopy(desired); current.update(Id=('c' if identity == 'a' else 'd') * 64, Created='2026-11-01T00:00:00Z', Containers={})
        networks[name] = {'captured': {'name': name, 'sourceNetworkId': identity * 64, 'inspect': desired}, 'current': current}
    image = {'Id': row['image']['creationReference'], 'Os': 'linux', 'Architecture': 'arm64', 'Variant': 'v8',
             'Config': {'Env': ['BASE=image'], 'Labels': {'vendor': 'fixture'}}}
    sources = {item['Source']: item['Source'] for item in raw['Mounts']}
    return row, image, sources, networks


def compile_fixture(values):
    row, image, sources, networks = values
    return M.compile_container(row, image=image, bind_sources=sources, networks=networks)


def created(values, compiled, running=True):
    raw = copy.deepcopy(values[0]['inspect']); body = compiled['body']
    raw['Image'] = body['Image']; raw['Name'] = '/' + compiled['name']
    raw['Config'] = {key: copy.deepcopy(value) for key, value in body.items() if key not in {'HostConfig', 'NetworkingConfig'}}
    raw['HostConfig'] = copy.deepcopy(body['HostConfig'])
    raw['NetworkSettings'] = {'Networks': copy.deepcopy(body['NetworkingConfig']['EndpointsConfig']),
                              'Ports': copy.deepcopy(body['HostConfig']['PortBindings']) if running else None}
    for item in raw['NetworkSettings']['Networks'].values(): item.update(EndpointID='e' * 64, IPAddress='172.30.0.3')
    raw['State'] = {'Running': running}
    return raw


def comparator(image):
    runtime = SimpleNamespace(image=lambda _: copy.deepcopy(image))
    return lambda raw, body: R.DockerRestoreRuntime.check_intent(runtime, raw, body)


class CreateIntentTests(unittest.TestCase):
    def test_actual_shaped_rows_are_admitted_by_the_shared_protected_descriptor_validator(self):
        first, second = fixture(), fixture(2, False)
        expected = {'pointId': '11111111-1111-4111-8111-111111111111', 'rootSha256': 'a' * 64,
                    'dockerContextSha256': 'b' * 64, 'daemonSha256': 'c' * 64,
                    'configurationSetSha256': 'd' * 64, 'preparationSha256': 'e' * 64}
        saved = [{'name': 'data/apps/demo/whoami/config.json', 'bytes': 3, 'sha256': A.digest(b'{}\n')}]
        app = {'id': 1, 'urn': 'whoami:demo', 'project': 'whoami_demo', 'status': 'running',
               'pendingRestart': True, 'userConfigEnabled': False, 'configurationSha256': saved[0]['sha256'],
               'sourceSha256': A.digest(b'orbis.app-runtime-saved-source.v1\n' + A.canonical(saved)),
               'savedFiles': saved, 'services': [{'name': 'web', 'replicas': 2}]}
        descriptor = A.seal({'schema': A.SCHEMA, 'version': 1, **expected, 'capturedAt': 1793548800000,
                             'apps': [app], 'containers': [first[0], second[0]],
                             'networkDefinitions': [first[3][name]['captured'] for name in sorted(first[3])]}, expected)
        admitted = A.validate(A.parse(A.canonical(descriptor)), expected)
        for index, values in enumerate((first, second)):
            self.assertEqual(M.compile_container(admitted['containers'][index], image=values[1], bind_sources=values[2], networks=values[3]), compile_fixture(values))

    def test_full_actual_runtime_is_cloned_without_compose_translation_or_input_mutation(self):
        values = fixture(); original = copy.deepcopy(values)
        result = compile_fixture(values); body = result['body']
        self.assertEqual(set(result), {'name', 'body', 'networkIds'})
        self.assertEqual(values, original)
        self.assertEqual(body['HostConfig'], values[0]['inspect']['HostConfig'])
        expected = copy.deepcopy(values[0]['inspect']['Config']); expected['Image'] = values[1]['Id']
        self.assertEqual({key: value for key, value in body.items() if key not in {'HostConfig', 'NetworkingConfig'}}, expected)
        self.assertIn('MODE=running-old', body['Env'])
        self.assertNotIn('MODE=pending-saved-new', body['Env'])
        self.assertEqual(body['Image'], values[1]['Id'])
        body['Env'].append('LOCAL=changed'); body['HostConfig']['Devices'][0]['CgroupPermissions'] = 'r'
        self.assertEqual(values, original)

    def test_distinct_replica_names_images_and_mixed_running_intent_are_not_collapsed(self):
        first, second = fixture(), fixture(2, False)
        second[0]['image']['creationReference'] = 'sha256:' + '5' * 64; second[1]['Id'] = second[0]['image']['creationReference']
        results = [compile_fixture(value) for value in (first, second)]
        self.assertNotEqual(results[0]['name'], results[1]['name'])
        self.assertNotEqual(results[0]['body']['Image'], results[1]['body']['Image'])
        self.assertEqual([first[0]['wasRunning'], second[0]['wasRunning']], [True, False])

    def test_stopped_fixed_requested_ports_are_preserved_without_fabricating_allocations(self):
        values = fixture(2, False)
        values[0]['inspect']['HostConfig']['PortBindings']['8080/tcp'][0]['HostIp'] = ''
        result = compile_fixture(values)
        self.assertEqual(result['body']['HostConfig']['PortBindings'], values[0]['inspect']['HostConfig']['PortBindings'])
        self.assertTrue(M.verify_created(created(values, result, False), result, comparator(values[1])))
        raw = created(values, result, True)
        raw['NetworkSettings']['Ports']['8080/tcp'] = [{'HostIp': '0.0.0.0', 'HostPort': '18080'}, {'HostIp': '::', 'HostPort': '18080'}]
        self.assertTrue(M.verify_created(raw, result, comparator(values[1])))
        values[0]['inspect']['HostConfig']['PortBindings']['8080/tcp'][0]['HostPort'] = '0'
        with self.assertRaises(ValueError): compile_fixture(values)

    def test_network_definition_full_equality_and_explicit_id_replacement(self):
        values = fixture(); source = values[0]['inspect']['HostConfig']; source['NetworkMode'] = 'a' * 64
        result = compile_fixture(values)
        self.assertEqual(result['body']['HostConfig']['NetworkMode'], 'c' * 64)
        self.assertEqual(result['networkIds'], {'whoami_demo_default': 'c' * 64, 'shared': 'd' * 64})
        endpoint = result['body']['NetworkingConfig']['EndpointsConfig']['whoami_demo_default']
        self.assertEqual(endpoint['Aliases'], ['web', 'historical-web-1'])
        self.assertEqual(endpoint['IPAMConfig']['IPv4Address'], '172.20.0.2')
        self.assertEqual(endpoint['MacAddress'], '02:42:ac:14:00:02')
        self.assertEqual(endpoint['GwPriority'], 10)
        self.assertFalse(set(endpoint) & M.ENDPOINT_VOLATILE - {'NetworkID'})
        for field, change in [('Driver', 'overlay'), ('Internal', True), ('Options', {'different': 'yes'}),
                              ('IPAM', {'Driver': 'other'}), ('Labels', {'changed': 'yes'}), ('EnableIPv6', True), ('FutureField', True)]:
            modified = copy.deepcopy(values); modified[3]['shared']['current'][field] = change
            with self.subTest(field=field), self.assertRaises(ValueError): compile_fixture(modified)

    def test_missing_extra_or_wrong_network_binding_is_rejected(self):
        for operation in ('missing', 'extra', 'wrong-name', 'wrong-source', 'wrong-endpoint', 'missing-wrapper'):
            values = fixture()
            if operation == 'missing': values[3].pop('shared')
            if operation == 'extra': values[3]['extra'] = copy.deepcopy(values[3]['shared'])
            if operation == 'wrong-name': values[3]['shared']['current']['Name'] = 'other'
            if operation == 'wrong-source': values[3]['shared']['captured']['sourceNetworkId'] = 'f' * 64
            if operation == 'wrong-endpoint': values[0]['inspect']['NetworkSettings']['Networks']['shared']['NetworkID'] = 'f' * 64
            if operation == 'missing-wrapper': values[3]['shared'] = values[3]['shared']['current']
            with self.subTest(operation=operation), self.assertRaises(ValueError): compile_fixture(values)

    def test_exact_identity_bind_sources_and_full_mount_union_are_required(self):
        for operation in ('missing', 'extra', 'remap', 'changed-source', 'changed-mode', 'changed-readonly', 'missing-bind', 'duplicate-destination', 'unsafe-path', 'create-path'):
            values = fixture(); raw = values[0]['inspect']; sources = values[2]
            if operation == 'missing': sources.pop(next(iter(sources)))
            if operation == 'extra': sources['/unrelated'] = '/unrelated'
            if operation == 'remap': sources[next(iter(sources))] = '/different'
            if operation == 'changed-source': raw['HostConfig']['Mounts'][0]['Source'] = '/other'
            if operation == 'changed-mode': raw['Mounts'][0]['Propagation'] = 'shared'
            if operation == 'changed-readonly': raw['Mounts'][0]['RW'] = False
            if operation == 'missing-bind': raw['HostConfig']['Binds'] = []
            if operation == 'duplicate-destination': raw['Mounts'].append(copy.deepcopy(raw['Mounts'][0]))
            if operation == 'unsafe-path': raw['HostConfig']['Binds'][0] = '/srv/../other:/config:rw'
            if operation == 'create-path': raw['HostConfig']['Mounts'][0]['BindOptions']['CreateMountpoint'] = True
            with self.subTest(operation=operation), self.assertRaises(ValueError): compile_fixture(values)

    def test_named_anonymous_and_tmpfs_volumes_need_separate_authority(self):
        for operation in ('volume', 'anonymous', 'tmpfs', 'driver', 'from', 'structured-volume'):
            values = fixture(); raw = values[0]['inspect']
            if operation == 'volume': raw['Mounts'][0]['Type'] = 'volume'
            if operation == 'anonymous': raw['Config']['Volumes']['/uncovered'] = {}
            if operation == 'tmpfs': raw['HostConfig']['Tmpfs'] = {'/tmp': 'rw'}
            if operation == 'driver': raw['HostConfig']['VolumeDriver'] = 'local'
            if operation == 'from': raw['HostConfig']['VolumesFrom'] = ['foreign:rw']
            if operation == 'structured-volume': raw['HostConfig']['Mounts'][0]['Type'] = 'volume'
            with self.subTest(operation=operation), self.assertRaises(ValueError): compile_fixture(values)

    def test_cross_container_namespaces_and_links_are_rejected(self):
        for field in ('NetworkMode', 'PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode', 'Links', 'endpoint-Links'):
            values = fixture()
            if field == 'endpoint-Links': values[0]['inspect']['NetworkSettings']['Networks']['shared']['Links'] = ['foreign:alias']
            else: values[0]['inspect']['HostConfig'][field] = ['foreign:alias'] if field == 'Links' else 'container:' + 'f' * 64
            with self.subTest(field=field), self.assertRaises(ValueError): compile_fixture(values)

    def test_dynamic_ports_pin_actual_ipv4_and_ipv6_assignments(self):
        values = fixture(); raw = values[0]['inspect']
        raw['HostConfig']['PortBindings']['8080/tcp'] = [{'HostIp': '', 'HostPort': '0'}]
        raw['NetworkSettings']['Ports']['8080/tcp'] = [{'HostIp': '0.0.0.0', 'HostPort': '32768'}, {'HostIp': '::', 'HostPort': '32769'}]
        result = compile_fixture(values)
        self.assertEqual(result['body']['HostConfig']['PortBindings']['8080/tcp'], raw['NetworkSettings']['Ports']['8080/tcp'])
        self.assertTrue(M.verify_created(created(values, result), result, comparator(values[1])))

    def test_unassigned_dynamic_and_publish_all_ports_are_not_invented(self):
        for operation in ('null', 'empty', 'zero', 'missing', 'changed-port', 'changed-address', 'publish-all', 'old-schema'):
            values = fixture(); raw = values[0]['inspect']
            if operation == 'null': raw['NetworkSettings']['Ports'] = None
            if operation == 'empty': raw['NetworkSettings']['Ports']['8080/tcp'] = []
            if operation == 'zero': raw['NetworkSettings']['Ports']['8080/tcp'][0]['HostPort'] = '0'
            if operation == 'missing': raw['NetworkSettings']['Ports'].pop('8080/tcp')
            if operation == 'changed-port': raw['NetworkSettings']['Ports']['8080/tcp'][0]['HostPort'] = '18081'
            if operation == 'changed-address': raw['NetworkSettings']['Ports']['8080/tcp'][0]['HostIp'] = '192.0.2.1'
            if operation == 'publish-all': raw['HostConfig']['PublishAllPorts'] = True
            if operation == 'old-schema': raw['NetworkSettings'].pop('Ports')
            with self.subTest(operation=operation), self.assertRaises(ValueError): compile_fixture(values)

    def test_port_canonical_address_shape_duplicate_and_count_limits(self):
        for field, value in [('HostPort', '018080'), ('HostPort', '65536'), ('HostPort', ''), ('HostIp', ''),
                             ('HostIp', 'fe80::1%eth0'), ('HostIp', '[::1]'), ('HostIp', '127.0.0.1\n'), ('Other', 'x')]:
            values = fixture(); values[0]['inspect']['NetworkSettings']['Ports']['8080/tcp'][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError): compile_fixture(values)
        for count in (2, 65):
            values = fixture(); values[0]['inspect']['NetworkSettings']['Ports']['8080/tcp'] *= count
            with self.subTest(count=count), self.assertRaises(ValueError): compile_fixture(values)

    def test_independently_observed_image_and_platform_must_match_exactly(self):
        for field, value in [('Id', 'sha256:' + 'f' * 64), ('Architecture', 'amd64'), ('Os', 'windows'), ('Variant', 'v9')]:
            values = fixture(); values[1][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): compile_fixture(values)
        values = fixture(); values[1].pop('Variant')
        self.assertEqual(compile_fixture(values)['body']['Image'], values[1]['Id'])

    def test_protected_container_metadata_and_managed_labels_cannot_be_omitted(self):
        for operation in ('label', 'ordinal', 'policy', 'saved-input', 'autoremove'):
            values = fixture(); row = values[0]
            if operation == 'label': row['inspect']['Config']['Labels']['runtipi.appurn'] = 'other:store'
            if operation == 'ordinal': row['ordinal'] = 2
            if operation == 'policy': row['transformPolicy'] = 'arbitrary'
            if operation == 'saved-input': row['savedCompose'] = 'MODE=pending-saved-new'
            if operation == 'autoremove': row['inspect']['HostConfig']['AutoRemove'] = True
            with self.subTest(operation=operation), self.assertRaises(ValueError): compile_fixture(values)

    def test_unknown_endpoint_create_field_is_rejected_instead_of_silently_dropped(self):
        values = fixture(); values[0]['inspect']['NetworkSettings']['Networks']['shared']['FutureCreateOption'] = 'unknown'
        with self.assertRaises(ValueError): compile_fixture(values)

    def test_endpoint_create_fields_reject_wrong_kinds_invalid_addresses_and_links(self):
        for field, value in [('Aliases', 'web'), ('Aliases', ['']), ('DriverOpts', {'invalid': True}),
                             ('Links', ''), ('Links', ['foreign:alias']), ('MacAddress', False), ('MacAddress', 'invalid'),
                             ('GwPriority', True), ('GwPriority', 2147483648), ('IPAMConfig', {'IPv4Address': 0}),
                             ('IPAMConfig', {'IPv4Address': '::1'}), ('IPAMConfig', {'IPv6Address': 'fe80::1%eth0'}),
                             ('IPAMConfig', {'LinkLocalIPs': ['invalid']}), ('IPAMConfig', {'FutureOption': 'unknown'})]:
            values = fixture(); values[0]['inspect']['NetworkSettings']['Networks']['shared'][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError): compile_fixture(values)

    def test_shared_comparator_is_called_and_full_verified_runtime_passes_before_and_after_start(self):
        values = fixture(); result = compile_fixture(values)
        for running in (False, True):
            check = mock.Mock(wraps=comparator(values[1])); raw = created(values, result, running)
            self.assertTrue(M.verify_created(raw, result, check)); check.assert_called_once_with(raw, result['body'])
        with self.assertRaises(ValueError): M.verify_created(created(values, result), result, mock.Mock(side_effect=ValueError('comparison failed')))

    def test_changed_actual_config_security_mounts_and_endpoints_fail_verification(self):
        values = fixture(); result = compile_fixture(values)
        def env(raw): raw['Config']['Env'][1] = 'MODE=pending-saved-new'
        def labels(raw): raw['Config']['Labels']['vendor'] = 'changed'
        def privileged(raw): raw['HostConfig']['Privileged'] = True
        def device(raw): raw['HostConfig']['Devices'][0]['PathOnHost'] = '/dev/other'
        def restart(raw): raw['HostConfig']['RestartPolicy']['Name'] = 'always'
        def source(raw): raw['Mounts'][0]['Source'] = '/other'
        def readonly(raw): raw['Mounts'][0]['RW'] = False
        def missing_mount(raw): raw['Mounts'].pop()
        def extra_mount(raw): raw['Mounts'].append({'Type': 'bind', 'Source': '/extra', 'Destination': '/extra', 'RW': True, 'Propagation': 'rprivate'})
        def host_extra(raw): raw['HostConfig']['FutureSecurityFlag'] = True
        def config_extra(raw): raw['Config']['FutureConfigFlag'] = True
        def aliases(raw): raw['NetworkSettings']['Networks']['shared']['Aliases'].append('other')
        def ipam(raw): raw['NetworkSettings']['Networks']['whoami_demo_default']['IPAMConfig']['IPv4Address'] = '172.20.0.4'
        def mac(raw): raw['NetworkSettings']['Networks']['shared']['MacAddress'] = '02:00:00:00:00:01'
        def network(raw): raw['NetworkSettings']['Networks']['shared']['NetworkID'] = 'f' * 64
        def missing_network(raw): raw['NetworkSettings']['Networks'].pop('shared')
        def name(raw): raw['Name'] = '/different'
        def image(raw): raw['Image'] = 'sha256:' + 'f' * 64
        def ports(raw): raw['NetworkSettings']['Ports']['8080/tcp'][0]['HostPort'] = '18081'
        for change in (env, labels, privileged, device, restart, source, readonly, missing_mount, extra_mount, host_extra,
                       config_extra, aliases, ipam, mac, network, missing_network, name, image, ports):
            raw = created(values, result); change(raw)
            with self.subTest(change=change.__name__), self.assertRaises(ValueError): M.verify_created(raw, result, comparator(values[1]))

    def test_unstarted_container_must_not_report_allocated_ports(self):
        values = fixture(); result = compile_fixture(values); raw = created(values, result)
        raw['State']['Running'] = False
        with self.assertRaises(ValueError): M.verify_created(raw, result, comparator(values[1]))

    def test_unstarted_empty_endpoint_ids_require_independent_pinned_networks_and_exact_create_fields(self):
        values = fixture(); result = compile_fixture(values); raw = created(values, result, False)
        raw['NetworkSettings']['Networks']['shared']['NetworkID'] = ''
        raw['NetworkSettings']['Networks']['whoami_demo_default']['NetworkID'] = None
        self.assertTrue(M.verify_created(raw, result, comparator(values[1])))
        changed = copy.deepcopy(raw); changed['NetworkSettings']['Networks']['shared']['NetworkID'] = 'f' * 64
        with self.assertRaises(ValueError): M.verify_created(changed, result, comparator(values[1]))
        changed = copy.deepcopy(raw); changed['NetworkSettings']['Networks']['shared']['Aliases'].append('unapproved')
        with self.assertRaises(ValueError): M.verify_created(changed, result, comparator(values[1]))
        changed = created(values, result, True); changed['NetworkSettings']['Networks']['shared']['NetworkID'] = ''
        with self.assertRaises(ValueError): M.verify_created(changed, result, comparator(values[1]))
        missing = copy.deepcopy(values); missing[3].pop('shared')
        with self.assertRaises(ValueError): compile_fixture(missing)
        changed = copy.deepcopy(raw); changed['NetworkSettings']['Networks']['extra'] = copy.deepcopy(changed['NetworkSettings']['Networks']['shared'])
        with self.assertRaises(ValueError): M.verify_created(changed, result, comparator(values[1]))

    def test_bounded_json_rejects_unknown_objects_floats_deep_values_and_surrogates(self):
        for value in (object(), 1.5, '\ud800', 9007199254740992):
            values = fixture(); values[0]['inspect']['Config']['Bad'] = value
            with self.subTest(kind=type(value).__name__), self.assertRaises(ValueError): compile_fixture(values)
        values = fixture(); nested = []; values[0]['inspect']['Config']['Bad'] = nested
        for _ in range(35): child = []; nested.append(child); nested = child
        with self.assertRaises(ValueError): compile_fixture(values)


if __name__ == '__main__':
    unittest.main()
