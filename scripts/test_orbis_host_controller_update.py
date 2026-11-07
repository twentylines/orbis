import copy
from contextlib import contextmanager
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


spec = importlib.util.spec_from_file_location('controller_update_test', Path(__file__).with_name('orbis-host-controller-update.py'))
C = importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)


class ControllerUpdateTests(unittest.TestCase):
    def setUp(self):
        self.root = Path('/fixture/install')
        host = C.D.load('orbis-host.py', 'controller_update_fixture_host')
        manager = SimpleNamespace(host=host, authority=host.AUTHORITY, root=self.root, context='fixture')
        self.runtime = C.D.DockerRestoreRuntime(manager)
        self.runtime.reader = mock.Mock()
        self.runtime.reader._object.return_value = {'ID': 'fixture-daemon'}
        self.runtime.observed_proxy_static_digest = mock.Mock(return_value='a' * 64)
        self.runtime.image = mock.Mock(return_value={'Config': {}})
        self.updater = C.ControllerUpdate.__new__(C.ControllerUpdate)
        self.updater.runtime = self.runtime
        self.updater.root = self.root
        self.updater.verify_source_bootstrap = mock.Mock()
        self.updater.context = "fixture"
        self.updater.P = self.runtime.P
        self.updater.key = "a" * 64
        self.updater.target = {"image": "ghcr.io/twentylines/orbis", "digest": "sha256:" + "2" * 64}
        self.calls = []
        self.objects = {}
        def raw(number, name, running=False):
            value = {'Id': str(number) * 64, 'Name': '/' + name, 'Image': 'sha256:' + str(number) * 64,
                     'Config': {'Image': 'sha256:' + str(number) * 64, 'Env': [], 'Labels': {}},
                     'HostConfig': {'NetworkMode': 'managed', 'Binds': [], 'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0}},
                     'Mounts': [], 'State': {'Running': running, 'Status': 'running' if running else 'exited',
                        'StartedAt': '2026-11-04T00:00:00Z', 'Health': {'Status': 'healthy'}},
                     'NetworkSettings': {'Networks': {'managed': {'NetworkID': 'f' * 64}}}}
            self.objects[value['Id']] = value
            return value
        source = raw(1, 'runtipi')
        candidate = raw(2, 'candidate')
        proxy = raw(3, 'runtipi-reverse-proxy', True)
        proxy['Mounts'] = [{'Type': 'bind', 'Source': str(self.root / 'traefik'), 'Destination': '/etc/traefik', 'RW': True},
                           {'Type': 'bind', 'Source': str(self.root / 'traefik/shared'), 'Destination': '/shared', 'RW': True}]
        peers = {name: raw(number, name) for name, number in [('runtipi-db', 4), ('runtipi-queue', 5)]}
        self.runtime.inspect = lambda identifier: copy.deepcopy(self.objects[identifier])
        def change(arguments):
            self.calls.append(arguments)
            command, identifier = arguments[0], arguments[-1] if arguments[0] == 'update' else arguments[1]
            item = self.objects[identifier]
            if command == 'rename': item['Name'] = '/' + arguments[2]
            elif command == 'start': item['State'].update(Running=True, Status='running')
            elif command == 'stop': item['State'].update(Running=False, Status='exited')
            elif command == 'rm': del self.objects[identifier]
            elif command != 'update': raise AssertionError(arguments)
        self.runtime.change = change
        self.record = {'daemonId': 'fixture-daemon', 'source': copy.deepcopy(source), 'sourceDefinition': self.runtime.definition(source),
                       'candidateId': candidate['Id'], 'candidateDefinition': self.runtime.definition(candidate),
                       'targetImageId': candidate['Image'], 'body': {**candidate['Config'], 'HostConfig': candidate['HostConfig'],
                            'NetworkingConfig': {'EndpointsConfig': {'managed': {}}}},
                       'proxy': copy.deepcopy(proxy), 'proxyDefinition': self.runtime.definition(proxy),
                       'proxyPolicy': self.runtime.controller_proxy_policy(proxy), 'peers': copy.deepcopy(peers),
                       'peerDefinitions': {name: self.runtime.definition(item) for name, item in peers.items()},
                       'originalName': 'original', 'candidateName': 'candidate', 'failedName': 'failed', 'nonce': 'b' * 64}
        self.updater.read = lambda: copy.deepcopy(self.record)
        self.updater.save = lambda record: self.record.update(copy.deepcopy(record))

    def test_optional_reset_without_enrollment_preserves_legacy_mounts(self):
        body = copy.deepcopy(self.record['body'])
        before = copy.deepcopy(body)
        with mock.patch.object(self.updater, 'optional_reset_enrollment', return_value=None), \
                mock.patch.object(C.RESET, 'require_docker_isolation') as isolation:
            self.assertEqual(self.updater.reset_candidate_body(self.record, body), before)
            self.updater.require_reset_mount(self.record)
        self.assertIsNone(self.record['controllerResetMount']['binding'])
        isolation.assert_not_called()
        self.assertEqual(self.record['source']['Mounts'], [])

    def test_adopted_proxy_candidate_is_read_only_and_checks_aliases(self):
        adoption = C.D.load('orbis-proxy-adoption.py', 'candidate_proxy_test')
        identity = SimpleNamespace(adoption_selected=lambda root: True, adoption_module=lambda: adoption)
        config = str(self.root / 'traefik')
        execution = str(adoption.execution_path(self.root))
        for structured in (False, True):
            with self.subTest(structured=structured):
                host = {'Mounts': [{'Type': 'bind', 'Source': config, 'Target': '/data/traefik'}]} if structured else {'Binds': [config + ':/data/traefik:rw,rprivate']}
                body = {'HostConfig': host}
                with mock.patch.object(C.D, 'load', return_value=identity), mock.patch.object(adoption, 'require_aliases') as aliases:
                    self.updater.proxy_candidate_body(body, transform=True)
                    self.updater.proxy_candidate_body(body, transform=False)
                    self.assertFalse(aliases.call_args.args[1][0]['Mounts'][0]['RW'])
                    self.assertEqual(host['Mounts'][0]['ReadOnly'] if structured else host['Binds'][0], True if structured else execution + ':/data/traefik:rprivate,ro')
                    bad = copy.deepcopy(body)
                    bad['HostConfig'].setdefault('Binds', []).append('/other:/data/traefik/nested:rw')
                    with self.assertRaisesRegex(ValueError, 'overlaps'):
                        self.updater.proxy_candidate_body(bad, transform=False)
                    bad = copy.deepcopy(body)
                    if structured: bad['HostConfig']['Mounts'][0]['ReadOnly'] = False
                    else: bad['HostConfig']['Binds'][0] = execution + ':/data/traefik:rw'
                    with self.assertRaisesRegex(ValueError, 'read-only'):
                        self.updater.proxy_candidate_body(bad, transform=False)

    def test_legacy_proxy_candidate_is_unchanged(self):
        body = {'HostConfig': {'Binds': ['/legacy:/data/traefik:rw']}}
        before = copy.deepcopy(body)
        with mock.patch.object(C.D, 'load', return_value=SimpleNamespace(adoption_selected=lambda root: False)):
            self.assertEqual(self.updater.proxy_candidate_body(body, transform=True), before)

    def test_adopted_proxy_rejects_writable_source_alias(self):
        adoption = C.D.load('orbis-proxy-adoption.py', 'candidate_alias_test')
        identity = SimpleNamespace(adoption_selected=lambda root: True, adoption_module=lambda: adoption)
        body = {'HostConfig': {'Binds': [str(self.root / 'traefik') + ':/data/traefik:rw',
                                         str(self.root) + ':/other:rw']}}
        with mock.patch.object(C.D, 'load', return_value=identity):
            with self.assertRaises(ValueError):
                self.updater.proxy_candidate_body(body, transform=True)
        self.assertTrue(body['HostConfig']['Binds'][0].endswith(':rw'))

    def test_optional_reset_reads_verified_external_v4_binding_only(self):
        binding = {'schema': C.RESET.SCHEMA_V4, 'path': '/verified/external/data'}
        @contextmanager
        def directory(path): yield 123
        with mock.patch.object(C.RESET, '_control_descriptor', side_effect=directory), \
                mock.patch.object(C.os, 'stat'), \
                mock.patch.object(C.D.APPS, 'digest_daemon', return_value='hashed-daemon'), \
                mock.patch.object(C.RESET, 'read_external_enrollment', return_value=binding) as read, \
                mock.patch.object(C.RESET, 'verify') as verify, \
                mock.patch.object(C.RESET, 'require_no_enrollment_aliases') as aliases:
            self.assertEqual(self.updater.optional_reset_enrollment(self.record['source']), binding)
        read.assert_called_once_with(self.root, 'hashed-daemon', 'fixture')
        verify.assert_called_once_with(self.root, binding, daemon='hashed-daemon', context='fixture')
        aliases.assert_called_once_with(self.root, [], binding)

    def test_existing_external_reset_mount_keeps_its_verified_enrollment_version(self):
        @contextmanager
        def directory(path): yield 123
        for schema in (C.RESET.SCHEMA_V2, C.RESET.SCHEMA_V3, C.RESET.SCHEMA_V4):
            with self.subTest(schema=schema):
                binding = {'schema': schema, 'path': str(C.RESET.external_directory(self.root))}
                source = copy.deepcopy(self.record['source'])
                source['Mounts'] = [{'Type': 'bind', 'Source': binding['path'],
                    'Destination': C.RESET.TARGET, 'RW': True, 'Propagation': 'rprivate'}]
                before = copy.deepcopy(source)
                with mock.patch.object(C.RESET, '_control_descriptor', side_effect=directory), \
                        mock.patch.object(C.os, 'stat'), \
                        mock.patch.object(C.D.APPS, 'digest_daemon', return_value='hashed-daemon'), \
                        mock.patch.object(C.RESET, 'read_external_enrollment', return_value=binding), \
                        mock.patch.object(C.RESET, 'verify') as verify, \
                        mock.patch.object(C.RESET, 'require_runtime', wraps=C.RESET.require_runtime) as runtime:
                    self.assertEqual(self.updater.optional_reset_enrollment(source), binding)
                verify.assert_called_once_with(self.root, binding, daemon='hashed-daemon', context='fixture')
                runtime.assert_called_once_with(self.root, source['Mounts'], binding)
                self.assertEqual(source, before)
        self.assertFalse(self.calls)

    def test_older_enrollment_cannot_add_a_new_reset_mount(self):
        @contextmanager
        def directory(path): yield 123
        for schema in (C.RESET.SCHEMA_V2, C.RESET.SCHEMA_V3):
            with self.subTest(schema=schema), \
                    mock.patch.object(C.RESET, '_control_descriptor', side_effect=directory), \
                    mock.patch.object(C.os, 'stat'), \
                    mock.patch.object(C.D.APPS, 'digest_daemon', return_value='hashed-daemon'), \
                    mock.patch.object(C.RESET, 'read_external_enrollment', return_value={'schema': schema}), \
                    mock.patch.object(C.RESET, 'verify') as verify:
                with self.assertRaisesRegex(ValueError, 'requires reviewed v4'):
                    self.updater.optional_reset_enrollment(self.record['source'])
                verify.assert_not_called()
        self.assertFalse(self.calls)

    def test_existing_older_reset_mount_still_rejects_unsafe_mounts(self):
        @contextmanager
        def directory(path): yield 123
        binding = {'schema': C.RESET.SCHEMA_V3, 'path': str(C.RESET.external_directory(self.root))}
        valid = {'Type': 'bind', 'Source': binding['path'], 'Destination': C.RESET.TARGET,
                 'RW': True, 'Propagation': 'rprivate'}
        cases = [[{**valid, 'Source': '/unverified'}], [{**valid, 'Type': 'volume'}], [{**valid, 'RW': False}],
                 [{**valid, 'Propagation': 'rshared'}], [valid, valid],
                 [{**valid, 'Destination': C.RESET.TARGET + '/nested'}],
                 [valid, {**valid, 'Destination': C.RESET.TARGET + '/nested'}],
                 [valid, {'Type': 'bind', 'Source': str(Path(binding['path']).parent),
                          'Destination': '/unreviewed', 'RW': True}]]
        for mounts in cases:
            source = {**self.record['source'], 'Mounts': mounts}
            with self.subTest(mounts=mounts), \
                    mock.patch.object(C.RESET, '_control_descriptor', side_effect=directory), \
                    mock.patch.object(C.os, 'stat'), \
                    mock.patch.object(C.D.APPS, 'digest_daemon', return_value='hashed-daemon'), \
                    mock.patch.object(C.RESET, 'read_external_enrollment', return_value=binding), \
                    mock.patch.object(C.RESET, 'verify'):
                with self.assertRaises(C.RESET.ResetAuthorityError):
                    self.updater.optional_reset_enrollment(source)
        self.assertFalse(self.calls)

    def test_existing_v3_mount_is_preserved_in_candidate_and_rollback_intent(self):
        binding = {'schema': C.RESET.SCHEMA_V3, 'path': str(C.RESET.external_directory(self.root))}
        source = self.record['source']
        source['Mounts'] = [{'Type': 'bind', 'Source': binding['path'],
            'Destination': C.RESET.TARGET, 'RW': True, 'Propagation': 'rprivate'}]
        source['HostConfig']['Binds'] = [binding['path'] + ':' + C.RESET.TARGET + ':rw,rprivate']
        body = copy.deepcopy(self.record['body'])
        body['HostConfig']['Binds'] = copy.deepcopy(source['HostConfig']['Binds'])
        before, source_before = copy.deepcopy(body), copy.deepcopy(source)
        with mock.patch.object(self.updater, 'optional_reset_enrollment', return_value=binding), \
                mock.patch.object(self.updater, 'reset_journal', return_value={'state': 'empty'}):
            self.assertEqual(self.updater.reset_candidate_body(self.record, body), before)
        self.assertEqual(source, source_before)
        self.assertEqual(self.record['controllerResetMount']['binding'], binding)
        self.assertEqual(self.record['controllerResetMount']['sourceMount'], 'present')
        retirement = self.updater.validate_retirement(self.record)
        self.assertEqual(retirement['body']['HostConfig']['Binds'], source['HostConfig']['Binds'])
        self.assertFalse(self.calls)

    def test_optional_reset_absence_is_not_partial_or_invalid_enrollment(self):
        @contextmanager
        def directory(path): yield 123
        with mock.patch.object(C.RESET, '_control_descriptor', side_effect=directory), \
                mock.patch.object(C.os, 'stat', side_effect=FileNotFoundError), \
                mock.patch.object(C.RESET, 'read_external_enrollment') as read:
            self.assertIsNone(self.updater.optional_reset_enrollment(self.record['source']))
            read.assert_not_called()
        with mock.patch.object(C.RESET, '_control_descriptor', side_effect=directory), \
                mock.patch.object(C.os, 'stat'), \
                mock.patch.object(C.D.APPS, 'digest_daemon', return_value='hashed-daemon'), \
                mock.patch.object(C.RESET, 'read_external_enrollment', side_effect=C.RESET.ResetAuthorityError('partial')):
            with self.assertRaisesRegex(ValueError, 'partial'):
                self.updater.optional_reset_enrollment(self.record['source'])

    def test_unenrolled_source_reset_mount_fails_before_mutation(self):
        for destination in (C.RESET.TARGET, C.RESET.TARGET + '/nested'):
            source = copy.deepcopy(self.record['source'])
            source['Mounts'] = [{'Destination': destination, 'Type': 'bind', 'Source': '/unverified'}]
            @contextmanager
            def directory(path): yield 123
            with mock.patch.object(C.RESET, '_control_descriptor', side_effect=directory), \
                    mock.patch.object(C.os, 'stat', side_effect=FileNotFoundError), \
                    mock.patch.object(C.RESET, 'read_external_enrollment') as read:
                with self.assertRaisesRegex(ValueError, 'no protected enrollment'):
                    self.updater.optional_reset_enrollment(source)
                read.assert_not_called()
        self.assertFalse(self.calls)

    def test_candidate_reset_mount_uses_only_enrolled_data_and_does_not_change_original(self):
        binding = {'schema': C.RESET.SCHEMA_V4, 'path': '/verified/external/data'}
        source = copy.deepcopy(self.record['source'])
        body = copy.deepcopy(self.record['body'])
        with mock.patch.object(self.updater, 'optional_reset_enrollment', return_value=binding), \
                mock.patch.object(self.updater, 'reset_journal', return_value={'state': 'empty'}), \
                mock.patch.object(C.RESET, 'binding_path', return_value=Path(binding['path'])):
            self.updater.reset_candidate_body(self.record, body)
        self.assertEqual(body['HostConfig']['Mounts'], [{'Type': 'bind', 'Source': binding['path'],
            'Target': C.RESET.TARGET, 'ReadOnly': False, 'BindOptions': {'Propagation': 'rprivate'}}])
        self.assertEqual(self.record['source'], source)
        self.assertEqual(self.record['controllerResetMount']['binding'], binding)

    def test_reset_mount_requires_runtime_isolation_and_preserves_pending_journal(self):
        binding = {'schema': C.RESET.SCHEMA_V4, 'path': '/verified/external/data'}
        self.record['controllerResetMount'] = {'schema': C.RESET_POLICY, 'binding': binding, 'sourceMount': 'absent'}
        candidate = self.objects['2' * 64]
        @contextmanager
        def directory(path): yield 123
        @contextmanager
        def file(*args, **kwargs): yield b'{}'
        self.updater.a = SimpleNamespace(protected_directory=directory, protected_file=file)
        with mock.patch.object(self.updater, 'optional_reset_enrollment', return_value=binding), \
                mock.patch.object(C.RESET, 'binding_path', return_value=Path(binding['path'])), \
                mock.patch.object(C.RESET, 'require_runtime') as runtime, \
                mock.patch.object(C.RESET, 'require_docker_isolation') as isolation, \
                mock.patch.object(C.os, 'listdir', return_value=[]):
            self.updater.require_reset_mount(self.record, candidate=candidate)
            runtime.assert_called_once_with(self.root, candidate['Mounts'], binding)
            isolation.assert_called_once_with(self.root, self.runtime.reader, binding, controller_id=candidate['Id'])
        with mock.patch.object(self.updater, 'optional_reset_enrollment', return_value=binding), \
                mock.patch.object(C.RESET, 'binding_path', return_value=Path(binding['path'])), \
                mock.patch.object(C.RESET, 'require_runtime'), mock.patch.object(C.RESET, 'require_docker_isolation'), \
                mock.patch.object(C.os, 'listdir', return_value=['active.json']) as listing:
            with self.assertRaisesRegex(ValueError, 'reset'):
                self.updater.require_reset_mount(self.record, candidate=candidate)
            listing.assert_called_once()
            self.assertFalse(self.calls)
            self.record['phase'] = 'committed'
            self.updater.require_reset_mount(self.record, candidate=candidate)
            self.assertEqual(listing.call_count, 1)

    def test_lost_candidate_create_reply_is_adopted_only_after_exact_intent_and_isolation(self):
        binding = {'schema': C.RESET.SCHEMA_V4, 'path': '/verified/external/data'}
        for schema in (C.RESET_POLICY, C.RESET_POLICY_V2):
            with self.subTest(schema=schema):
                record = copy.deepcopy(self.record)
                record.pop('candidateId')
                record.pop('candidateDefinition')
                record['controllerResetMount'] = {'schema': schema, 'binding': binding, 'sourceMount': 'absent'}
                if schema == C.RESET_POLICY_V2:
                    record['controllerResetMount']['journal'] = {'state': 'empty'}
                candidate = copy.deepcopy(self.objects['2' * 64])
                candidate['State']['Status'] = 'created'
                with mock.patch.object(self.updater, 'optional_reset_enrollment', return_value=binding), \
                        mock.patch.object(self.updater, 'lookup', return_value=candidate), \
                        mock.patch.object(self.updater, 'reset_journal', return_value={'state': 'empty'}), \
                        mock.patch.object(C.RESET, 'require_runtime'), \
                        mock.patch.object(C.RESET, 'require_docker_isolation') as isolation:
                    self.updater.require_reset_mount(record)
                self.assertEqual(record['candidateId'], candidate['Id'])
                self.assertEqual(record['candidateDefinition'], self.runtime.definition(candidate))
                isolation.assert_called_once_with(self.root, self.runtime.reader, binding, controller_id=candidate['Id'])

    def test_foreign_or_started_pending_reset_candidate_is_never_adopted(self):
        binding = {'schema': C.RESET.SCHEMA_V4, 'path': '/verified/external/data'}
        for field in ('image', 'running', 'network'):
            with self.subTest(field=field):
                record = copy.deepcopy(self.record)
                record.pop('candidateId')
                record['controllerResetMount'] = {'schema': C.RESET_POLICY_V2, 'binding': binding,
                    'sourceMount': 'absent', 'journal': {'state': 'empty'}}
                candidate = copy.deepcopy(self.objects['2' * 64])
                candidate['State']['Status'] = 'created'
                if field == 'image': candidate['Image'] = 'sha256:' + '9' * 64
                if field == 'running': candidate['State']['Running'] = True
                if field == 'network': candidate['NetworkSettings']['Networks']['managed']['NetworkID'] = 'e' * 64
                with mock.patch.object(self.updater, 'optional_reset_enrollment', return_value=binding), \
                        mock.patch.object(self.updater, 'lookup', return_value=candidate), \
                        mock.patch.object(C.RESET, 'require_docker_isolation') as isolation:
                    with self.assertRaises(ValueError): self.updater.require_reset_mount(record)
                self.assertNotIn('candidateId', record)
                isolation.assert_not_called()

    def test_reset_rollback_reconciles_retired_candidate_without_changing_original_mounts(self):
        binding = {'schema': C.RESET.SCHEMA_V4, 'path': '/verified/external/data'}
        self.record['controllerResetMount'] = {'schema': C.RESET_POLICY, 'binding': binding, 'sourceMount': 'absent'}
        self.record['candidateRetirementIntent'] = True
        original = copy.deepcopy(self.record['source'])
        @contextmanager
        def directory(path): yield 123
        self.updater.a = SimpleNamespace(protected_directory=directory)
        with mock.patch.object(self.updater, 'optional_reset_enrollment', return_value=binding), \
                mock.patch.object(C.RESET, 'binding_path', return_value=Path(binding['path'])), \
                mock.patch.object(C.RESET, 'require_runtime') as runtime, \
                mock.patch.object(C.RESET, 'require_docker_isolation') as isolation, \
                mock.patch.object(C.os, 'listdir', return_value=[]), \
                mock.patch.object(self.runtime, 'inspect', side_effect=RuntimeError('missing')), \
                mock.patch.object(self.runtime, 'engine', return_value=None):
            self.updater.require_reset_mount(self.record)
            runtime.assert_not_called()
            isolation.assert_called_once_with(self.root, self.runtime.reader, binding, controller_id=None)
        self.assertEqual(self.record['source'], original)
        self.assertFalse(self.calls)

    def test_reset_enrollment_change_blocks_candidate_before_any_mutation(self):
        binding = {'schema': C.RESET.SCHEMA_V4, 'path': '/verified/external/data'}
        self.record['controllerResetMount'] = {'schema': C.RESET_POLICY, 'binding': binding, 'sourceMount': 'absent'}
        with mock.patch.object(self.updater, 'optional_reset_enrollment', return_value={**binding, 'inode': 999}):
            with self.assertRaisesRegex(ValueError, 'enrollment changed'):
                self.updater.start_target()
        self.assertFalse(self.calls)

    def test_candidate_network_aliases_allow_only_requested_and_docker_generated_names(self):
        self.record['body']['NetworkingConfig']['EndpointsConfig']['managed']['Aliases'] = ['runtipi', 'controller']
        candidate = copy.deepcopy(self.objects['2' * 64])
        endpoint = candidate['NetworkSettings']['Networks']['managed']
        endpoint['Aliases'] = ['runtipi', 'controller', 'candidate', candidate['Id'][:12]]
        endpoint['DNSNames'] = ['runtipi', 'controller', 'candidate', candidate['Id'][:12]]
        self.updater.check_candidate_networks(self.record, candidate)
        candidate['State']['Running'] = True
        candidate['Name'] = '/runtipi'
        endpoint['Aliases'].append('runtipi')
        self.updater.check_candidate_networks(self.record, candidate)
        for aliases in (['runtipi'], ['runtipi', 'controller', 'unreviewed'],
                        ['runtipi', 'controller', self.record['source']['Id'][:12]]):
            changed = copy.deepcopy(candidate)
            changed['NetworkSettings']['Networks']['managed']['Aliases'] = aliases
            with self.assertRaisesRegex(ValueError, 'configured network aliases'):
                self.updater.check_candidate_networks(self.record, changed)
        changed = copy.deepcopy(candidate)
        changed['NetworkSettings']['Networks']['managed']['DNSNames'].append('unreviewed')
        with self.assertRaisesRegex(ValueError, 'Docker DNS names'):
            self.updater.check_candidate_networks(self.record, changed)

    def test_candidate_network_identity_is_pinned_when_running(self):
        candidate = copy.deepcopy(self.objects['2' * 64])
        candidate['NetworkSettings']['Networks']['managed']['NetworkID'] = ''
        self.updater.check_candidate_networks(self.record, candidate)
        candidate['State']['Running'] = True
        with self.assertRaises(ValueError): self.updater.check_candidate_networks(self.record, candidate)
        candidate['NetworkSettings']['Networks']['managed']['NetworkID'] = 'e' * 64
        with self.assertRaises(ValueError): self.updater.check_candidate_networks(self.record, candidate)
        candidate['NetworkSettings']['Networks']['managed']['NetworkID'] = 'f' * 64
        self.updater.check_candidate_networks(self.record, candidate)

    def test_reset_journal_accepts_only_complete_lock_free_exact_schema_and_pins_bytes(self):
        journal = {'version': 1, 'id': '47c71062-aece-4f23-8978-d4d1b7d4b8c0', 'controller': 'controller',
                   'accounts': 'keep', 'users': [1, 2], 'phase': 'complete', 'createdAt': 1800000000000}
        state = {'names': ['active.json'], 'body': json.dumps(journal).encode()}
        @contextmanager
        def directory(path): yield 123
        @contextmanager
        def file(*args, **kwargs): yield state['body']
        self.updater.a = SimpleNamespace(protected_directory=directory, protected_file=file)
        binding = {'schema': C.RESET.SCHEMA_V4}
        with mock.patch.object(C.RESET, 'binding_path', return_value=Path('/verified/reset/data')), \
                mock.patch.object(C.os, 'listdir', side_effect=lambda fd: state['names']):
            expected = self.updater.reset_journal(binding)
            self.assertEqual(expected['state'], 'complete')
            state['body'] += b' '
            self.assertNotEqual(self.updater.reset_journal(binding)['sha256'], expected['sha256'])
            for names in (['active.json', 'operation.lock'], ['unknown'], ['active.json', 'extra']):
                state['names'] = names
                with self.assertRaises(ValueError): self.updater.reset_journal(binding)
            state['names'] = ['active.json']
            for changes in ({'phase': 'recovery'}, {'version': True}, {'users': [1, 1]}, {'users': [True]},
                            {'users': [2**53]}, {'createdAt': 0}, {'id': 'invalid'}, {'controller': ''}, {'controller': '🤖' * 200}, {'extra': True}):
                state['body'] = json.dumps({**journal, **changes}).encode()
                with self.assertRaises(ValueError): self.updater.reset_journal(binding)
        self.assertFalse(self.calls)

    def test_new_controller_uses_docker_hostname_and_target_image_environment_defaults(self):
        original = copy.deepcopy(self.objects['1' * 64])
        original['Config'].update(Hostname='old-container-id', Env=['TIPI_VERSION=old', 'IMAGE_DEFAULT=old', 'CUSTOM=operator', 'ORBIS_VERSION=old'])
        publication = {'tag': 'v0.6.2', 'commit': 'c' * 40, 'digest': 'sha256:' + 'd' * 64}
        record = {'id': 'a' * 64, 'nonce': 'b' * 64,
                  'source': {'container': original, 'imageConfiguration': {'Env': ['TIPI_VERSION=old', 'IMAGE_DEFAULT=old']}},
                  'target': {'creationReference': 'sha256:' + '2' * 64, 'publication': publication}}
        body = self.runtime.base_body(record, 'candidate', {'Env': ['TIPI_VERSION=new', 'IMAGE_DEFAULT=new']})
        self.assertNotIn('Hostname', body)
        environment = dict(item.split('=', 1) for item in body['Env'])
        self.assertEqual(environment['TIPI_VERSION'], 'new')
        self.assertEqual(environment['IMAGE_DEFAULT'], 'new')
        self.assertEqual(environment['CUSTOM'], 'operator')
        self.assertEqual(environment['ORBIS_VERSION'], publication['tag'])
        self.assertEqual(environment['ORBIS_COMMIT'], publication['commit'])
        self.assertEqual(environment['ORBIS_IMAGE_DIGEST'], publication['digest'])

    def test_capability_probe_never_starts_or_mounts_any_host_data(self):
        checkpoint = {'storage': {'backupScope': C.SCOPE}}
        self.record['checkpoint'] = checkpoint
        self.record.pop('candidateId')
        self.updater.lookup = mock.Mock(side_effect=ValueError('missing'))
        probe = {'Id': '6' * 64, 'Image': 'sha256:' + '2' * 64,
                 'Config': {'Labels': {'io.orbis.controller-probe': 'b' * 64}},
                 'State': {'Running': False}, 'Mounts': [], 'HostConfig': {'NetworkMode': 'none'}}
        self.objects[probe['Id']] = probe
        self.runtime.engine = mock.Mock(return_value=json.dumps({'Id': probe['Id']}).encode())
        def archive(capability):
            output = io.BytesIO()
            body = json.dumps(capability).encode()
            with tarfile.open(fileobj=output, mode='w:') as tar:
                info = tarfile.TarInfo('controller-overlay-capability.json')
                info.size = len(body)
                tar.addfile(info, io.BytesIO(body))
            return output.getvalue()
        self.runtime.bounded_output = mock.Mock(return_value=archive({**C.CAPABILITY, 'version': 2}))
        with self.assertRaises(C.CapabilityError): self.updater.prepare(checkpoint)
        self.assertFalse(self.calls)
        self.assertFalse(self.objects['1' * 64]['State']['Running'])
        intent = self.runtime.engine.call_args.args[2]
        self.assertNotIn('Binds', intent['HostConfig'])
        self.assertNotIn('Mounts', intent['HostConfig'])
        self.assertEqual(intent['HostConfig']['NetworkMode'], 'none')
        self.runtime.bounded_output.return_value = archive(C.CAPABILITY)
        with mock.patch.object(C.BOOTSTRAP, 'probe', return_value={'profile': C.BOOTSTRAP.CAPABLE}):
            self.updater.prepare(checkpoint)
        self.assertEqual(self.calls, [['rm', probe['Id']]])
        self.assertEqual(self.record['phase'], 'prepared')

    def test_protected_commit_retires_only_stopped_original_and_reconciles_lost_reply(self):
        self.updater.start_target()
        def engine(method, route, **options):
            self.assertEqual(method, 'GET')
            self.assertEqual(route, '/containers/' + '1' * 64 + '/json')
            original = self.objects.get('1' * 64)
            return None if original is None else json.dumps(original).encode()
        self.runtime.engine = engine
        change = self.runtime.change
        def lost_reply(arguments):
            change(arguments)
            if arguments == ['rm', '1' * 64]: raise RuntimeError('reply lost')
        self.runtime.change = lost_reply
        self.assertTrue(self.updater.commit())
        self.assertEqual(self.record['phase'], 'committed')
        self.assertNotIn('1' * 64, self.objects)
        self.assertFalse(self.updater.commit())
        self.assertFalse(self.record['cleanupRequired'])
        self.assertTrue(self.objects['2' * 64]['State']['Running'])
        self.assertFalse(any('3' * 64 in call for call in self.calls))

    def test_target_start_preserves_proxy_and_reuses_database_and_queue_ids(self):
        proxy_before = copy.deepcopy(self.objects['3' * 64])
        progress = []
        def observe(phase):
            self.assertEqual(self.record['phase'], 'replacing')
            self.assertEqual(self.objects['2' * 64]['State']['Running'], phase == 'verifying')
            progress.append(phase)
        with mock.patch.object(self.updater, 'healthy', wraps=self.updater.healthy) as healthy:
            self.updater.start_target(progress=observe)
        self.assertEqual(progress, ['restarting', 'verifying'])
        healthy.assert_called_once()
        self.assertEqual(self.objects['1' * 64]['Name'], '/original')
        self.assertEqual(self.objects['2' * 64]['Name'], '/runtipi')
        self.assertEqual(self.calls, [['rename', '1' * 64, 'original'], ['rename', '2' * 64, 'runtipi'],
                                     ['start', '4' * 64], ['start', '5' * 64], ['start', '2' * 64]])
        self.assertEqual(self.objects['3' * 64], proxy_before)
        self.assertEqual(self.record['phase'], 'active')

    def test_rollback_restores_original_controller_without_touching_proxy(self):
        self.updater.start_target()
        self.calls.clear()
        protected = self.updater.stop_for_rollback()
        self.assertNotIn('2' * 64, self.objects)
        self.assertEqual(self.objects['1' * 64]['Name'], '/runtipi')
        self.updater.start_original()
        self.updater.restore_policies(target=False)
        self.assertTrue(self.objects['1' * 64]['State']['Running'])
        self.assertEqual(self.record['phase'], 'rolled-back')
        self.assertFalse(any('3' * 64 in call for call in self.calls))
        self.assertEqual(protected['source']['Id'], '1' * 64)

    def test_proxy_definition_mount_static_and_start_generation_drift_fail_before_replacement(self):
        for mutate in (
                lambda: self.objects['3' * 64]['Config']['Labels'].update(unreviewed='true'),
                lambda: self.objects['3' * 64]['Mounts'][1].update(Source='/unreviewed'),
                lambda: self.objects['3' * 64]['State'].update(StartedAt='different'),
                lambda: setattr(self.runtime.observed_proxy_static_digest, 'return_value', 'b' * 64)):
            with self.subTest(mutate=mutate):
                saved = copy.deepcopy(self.objects)
                mutate()
                with self.assertRaises(ValueError): self.updater.start_target()
                self.assertFalse(self.calls)
                self.objects = saved
                self.runtime.observed_proxy_static_digest.return_value = 'a' * 64

    def test_source_or_candidate_definition_drift_fails_before_replacement(self):
        for identifier in ('1' * 64, '2' * 64):
            with self.subTest(identifier=identifier):
                saved = copy.deepcopy(self.objects)
                self.objects[identifier]['Config']['Labels']['changed'] = 'yes'
                with self.assertRaises(ValueError): self.updater.start_target()
                self.assertFalse(self.calls)
                self.objects = saved

    def test_target_health_failure_keeps_original_for_recovery(self):
        original_change = self.runtime.change
        def change(arguments):
            original_change(arguments)
            if arguments == ['start', '2' * 64]:
                self.objects['2' * 64]['State'].update(Status='exited', Running=False)
        self.runtime.change = change
        with self.assertRaises(RuntimeError): self.updater.start_target()
        self.assertIn('1' * 64, self.objects)
        self.assertFalse(self.objects['1' * 64]['State']['Running'])
        self.assertFalse(any('3' * 64 in call for call in self.calls))
        self.updater.stop_for_rollback()
        self.updater.start_original()
        self.assertTrue(self.objects['1' * 64]['State']['Running'])


class DedicatedSourceReconstructionTests(unittest.TestCase):
    def setUp(self):
        ControllerUpdateTests.setUp(self)
        source = self.objects['1' * 64]
        mount = {'Type': 'bind', 'Source': '/verified/reset/data', 'Target': C.RESET.TARGET,
                 'ReadOnly': False, 'BindOptions': {'Propagation': 'rprivate'}}
        source['HostConfig']['Mounts'] = [mount]
        source['Mounts'] = [{'Type': 'bind', 'Source': mount['Source'], 'Destination': C.RESET.TARGET,
                             'RW': True, 'Propagation': 'rprivate'}]
        source['Config']['Hostname'] = source['Id'][:12]
        source['Config']['Env'] = ['ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=1']
        source['NetworkSettings']['Networks']['managed']['Aliases'] = ['runtipi', source['Id'][:12]]
        self.record['source'] = copy.deepcopy(source)
        self.record['sourceDefinition'] = self.runtime.definition(source)
        self.record['body'] = {**copy.deepcopy(source['Config']), 'Image': 'sha256:' + '2' * 64,
            'HostConfig': copy.deepcopy(source['HostConfig']),
            'NetworkingConfig': {'EndpointsConfig': {'managed': {'Aliases': ['runtipi']}}}}
        self.record['body'].pop('Hostname', None)
        self.record['controllerResetMount'] = {'schema': C.RESET_POLICY_V2,
            'binding': {'schema': C.RESET.SCHEMA_V4, 'path': mount['Source']}, 'sourceMount': 'present', 'journal': {'state': 'empty'}}
        self.record['checkpoint'] = {'journal': '/fixture/checkpoint.json', 'storage': {'resources': []}}
        self.record.pop('candidateId')
        self.record.pop('candidateDefinition')
        del self.objects['2' * 64]
        self.runtime.inspect = lambda identifier: copy.deepcopy(self.objects.get(identifier)) or self.missing()
        self.updater.snapshot = Path('/fixture/snapshot')
        self.updater.path = Path('/fixture/authority')
        self.updater.plan_source_reconstruction(self.record)
        self.manifest = {'plan': self.record['checkpoint']['storage'], 'copies': []}
        self.updater.require_reset_excluded = mock.Mock()
        self.writer_counts = []
        def isolation(record, candidate=None):
            writers = [item['Id'] for item in self.objects.values() if any(m.get('Destination') == C.RESET.TARGET and m.get('RW') for m in item['Mounts'])]
            self.writer_counts.append(len(writers))
            if len(writers) > 1: raise AssertionError('Concurrent reset authority writers')
        self.updater.require_reset_mount = isolation
        self.updater.lookup = lambda name: copy.deepcopy(next((item for item in self.objects.values() if item['Name'] == '/' + name), None)) or self.missing()
        def engine(method, route, body=None, **kwargs):
            if method == 'GET':
                identifier = route.split('/')[2]
                item = self.objects.get(identifier)
                return None if item is None else json.dumps(item).encode()
            self.assertEqual(method, 'POST')
            name = route.split('name=')[1]
            number = 6 if 'source-image' in name else 7 if 'reconstructed' in name else 2
            identifier = str(number) * 64
            config = {key: copy.deepcopy(value) for key, value in body.items() if key not in {'HostConfig', 'NetworkingConfig'}}
            config.setdefault('Env', [])
            config.setdefault('Labels', {})
            config.setdefault('Hostname', identifier[:12])
            host = copy.deepcopy(body['HostConfig'])
            host.setdefault('Binds', [])
            host.setdefault('RestartPolicy', {'Name': 'no', 'MaximumRetryCount': 0})
            mounts = [{'Type': 'bind', 'Source': m['Source'], 'Destination': m['Target'], 'RW': not m.get('ReadOnly', False),
                       'Propagation': m.get('BindOptions', {}).get('Propagation', 'rprivate')} for m in host.get('Mounts', [])]
            networks = {network: {'NetworkID': 'f' * 64, 'Aliases': [*endpoint.get('Aliases', []), name, identifier[:12]],
                                 'DNSNames': [*endpoint.get('Aliases', []), name, identifier[:12]]}
                        for network, endpoint in body.get('NetworkingConfig', {}).get('EndpointsConfig', {'none': {}}).items()}
            self.objects[identifier] = {'Id': identifier, 'Name': '/' + name, 'Image': body['Image'], 'Config': config,
                'HostConfig': host, 'Mounts': mounts, 'NetworkSettings': {'Networks': networks},
                'State': {'Running': False, 'Status': 'created', 'StartedAt': '0001-01-01T00:00:00Z', 'Health': {'Status': 'healthy'}}}
            isolation(self.record)
            self.calls.append(['create', identifier, name])
            return json.dumps({'Id': identifier}).encode()
        self.runtime.engine = engine
        self.runtime.reader._object.side_effect = lambda args: {'Id': self.record['source']['Image'], 'Config': {}} if args[0] == 'image' else {'ID': 'fixture-daemon'}
        self.records = mock.patch.object(C.TOOLS, 'read_record', side_effect=lambda *args: {'stage': 'ready', 'review': self.record['checkpoint'],
            'backupFingerprint': C.TOOLS.APPS.digest(self.manifest)})
        self.manifests = mock.patch.object(C.TOOLS.STORAGE, 'verified_manifest', side_effect=lambda *args: copy.deepcopy(self.manifest))
        self.records.start(); self.manifests.start()
        self.addCleanup(self.records.stop); self.addCleanup(self.manifests.stop)

    def missing(self):
        raise ValueError('missing')

    def enable_source_bootstrap(self, preserve='0'):
        source = self.objects['1' * 64]
        source['Config']['Env'] = ['CUSTOM=keep'] + ([C.PRESERVE_ENV + '=' + preserve] if preserve is not None else [])
        self.record['source'] = copy.deepcopy(source)
        self.record['sourceDefinition'] = self.runtime.definition(source)
        self.record['current'] = {'commit': 'c' * 40, 'digest': source['Image']}
        self.updater.plan_source_reconstruction(self.record)
        proof = {'schema': C.BOOTSTRAP.SCHEMA, 'profile': C.BOOTSTRAP.CAPABLE,
                 'codeSha256': 'd' * 64, 'observedAt': 1800000000000}
        with mock.patch.object(C.BOOTSTRAP, 'probe', return_value=proof):
            self.updater.review_source_bootstrap(self.record)
        return copy.deepcopy(source)

    def test_capable_env_zero_reviews_only_reconstruction_environment_without_changing_original(self):
        original = self.enable_source_bootstrap()
        expected = ['CUSTOM=keep', 'ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=1']
        source = self.updater.bootstrap_source(self.record, 'review')
        self.assertEqual(source['Config']['Env'], expected)
        self.assertEqual(self.objects[original['Id']], original)
        self.assertEqual(self.record['source'], original)
        self.assertEqual(self.record['sourceRetirement']['body']['Env'], expected)
        body = copy.deepcopy(self.record['sourceRetirement']['body'])
        body['Env'] = original['Config']['Env']
        self.assertEqual(body, self.updater.source_reconstruction_body(self.record))
        self.assertEqual(self.record['sourceBootstrapEnablement']['publication'], self.record['current'])
        self.assertFalse(self.calls)

    def test_capable_source_missing_flag_uses_only_the_recorded_reconstruction_enablement(self):
        original = self.enable_source_bootstrap(preserve=None)
        self.assertEqual(self.objects[original['Id']]['Config']['Env'], ['CUSTOM=keep'])
        self.assertEqual(self.updater.bootstrap_source(self.record, 'review')['Config']['Env'],
                         ['CUSTOM=keep', 'ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=1'])
        self.assertFalse(self.calls)

    def test_enablement_proof_failure_never_retains_image_retires_or_starts_source(self):
        self.enable_source_bootstrap()
        self.record.pop('sourceBootstrapProfile')
        self.record['sourceBootstrapEnablement'].pop('profileSha256')
        with mock.patch.object(C.BOOTSTRAP, 'probe', side_effect=C.BOOTSTRAP.fail()):
            with self.assertRaises(C.BOOTSTRAP.SourceBootstrapError):
                self.updater.review_source_bootstrap(self.record)
        with self.assertRaises(C.BOOTSTRAP.SourceBootstrapError):
            self.updater.retain_source_image(self.record)
        self.assertFalse(self.calls)
        self.assertEqual(set(self.objects), {'1' * 64, '3' * 64, '4' * 64, '5' * 64})
        self.assertEqual(self.objects['1' * 64]['Config']['Env'][-1], 'ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=0')

    def test_enablement_rejects_intent_proof_publication_and_policy_tampering(self):
        self.enable_source_bootstrap()
        accepted = copy.deepcopy(self.record)
        def change_environment(record):
            retirement = record['sourceRetirement']
            retirement['body']['Env'] = ['CUSTOM=changed', 'ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=1']
            retirement['bodySha256'] = C.hashlib.sha256(self.updater.P.canonical(retirement['body'])).hexdigest()
        changes = [change_environment,
            lambda record: record['sourceBootstrapProfile'].update(codeSha256='e' * 64),
            lambda record: record['sourceBootstrapEnablement'].update(startupEnvSha256='e' * 64),
            lambda record: record['current'].update(commit='e' * 40),
            lambda record: record.pop('sourceBootstrapEnablement')]
        for index, change in enumerate(changes):
            record = copy.deepcopy(accepted)
            change(record)
            with self.subTest(change=index):
                with self.assertRaises(C.BOOTSTRAP.SourceBootstrapError): self.updater.validate_retirement(record)
        self.assertFalse(self.calls)

    def test_enablement_held_rollback_retires_and_reconstructs_before_any_source_restart(self):
        original = self.enable_source_bootstrap()
        with self.assertRaises(C.BOOTSTRAP.SourceBootstrapError): self.updater.start_original()
        self.updater.stop_for_rollback()
        self.assertNotIn(original['Id'], self.objects)
        self.assertEqual(self.objects['7' * 64]['Config']['Env'], ['CUSTOM=keep', 'ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=1'])
        self.assertFalse(self.objects['7' * 64]['State']['Running'])
        self.assertIn('checkpointManifestSha256', self.record['sourceRetirement'])
        self.assertEqual(self.record['source'], original)
        self.updater.start_original()
        self.assertIn(['start', '7' * 64], self.calls)
        self.assertNotIn(['start', original['Id']], self.calls)
        self.assertEqual(max(self.writer_counts), 1)

    def test_enablement_checkpoint_failure_keeps_original_stopped_without_reconstruction(self):
        self.enable_source_bootstrap()
        with mock.patch.object(C.TOOLS, 'read_record', return_value={'stage': 'snapshotting'}):
            with self.assertRaisesRegex(ValueError, 'durable checkpoint'): self.updater.stop_for_rollback()
        self.assertIn('1' * 64, self.objects)
        self.assertNotIn('7' * 64, self.objects)
        self.assertNotIn(['rm', '1' * 64], self.calls)
        self.assertFalse(any(call[0] == 'start' for call in self.calls))

    def test_enablement_failed_candidate_rollback_proves_actual_reconstructed_env(self):
        original = self.enable_source_bootstrap()
        self.updater.healthy = mock.Mock(side_effect=RuntimeError('candidate health failed'))
        with self.assertRaisesRegex(RuntimeError, 'candidate health failed'): self.updater.start_target()
        self.updater.stop_for_rollback()
        self.assertNotIn('2' * 64, self.objects)
        def probe(updater, record, phase):
            actual = updater.bootstrap_source(record, phase)
            self.assertEqual(actual['Id'], '7' * 64)
            self.assertEqual(actual['Image'], original['Image'])
            self.assertEqual(actual['Config']['Env'][-1], 'ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=1')
            self.assertEqual(record['source'], original)
            return record['sourceBootstrapProfile']
        with mock.patch.object(C.BOOTSTRAP, 'probe', side_effect=probe):
            C.ControllerUpdate.verify_source_bootstrap(self.updater)
        self.assertEqual(max(self.writer_counts), 1)

    def test_enablement_lost_held_retirement_and_reconstruction_replies_are_reconciled(self):
        self.enable_source_bootstrap()
        change = self.runtime.change
        def lost_remove(arguments):
            change(arguments)
            if arguments == ['rm', '1' * 64]: raise RuntimeError('remove reply lost')
        self.runtime.change = lost_remove
        with self.assertRaisesRegex(RuntimeError, 'remove reply lost'): self.updater.stop_for_rollback()
        self.runtime.change = change
        engine = self.runtime.engine
        def lost_create(method, route, body=None, **kwargs):
            result = engine(method, route, body, **kwargs)
            if method == 'POST' and 'reconstructed' in route: raise RuntimeError('create reply lost')
            return result
        self.runtime.engine = lost_create
        with self.assertRaisesRegex(RuntimeError, 'create reply lost'): self.updater.stop_for_rollback()
        self.runtime.engine = engine
        self.updater.stop_for_rollback()
        self.assertEqual(self.record['sourceRetirement']['reconstructionId'], '7' * 64)
        self.assertEqual(self.objects['7' * 64]['Config']['Env'][-1], 'ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=1')
        self.assertEqual(sum(call[:2] == ['create', '7' * 64] for call in self.calls), 1)
        self.assertEqual(max(self.writer_counts), 1)

    def test_enablement_crash_after_retirement_intent_before_remove_retries_exact_stopped_source(self):
        self.enable_source_bootstrap()
        change = self.runtime.change
        def crash_before_remove(arguments):
            if arguments == ['rm', '1' * 64]: raise RuntimeError('process lost before removal')
            change(arguments)
        self.runtime.change = crash_before_remove
        with self.assertRaisesRegex(RuntimeError, 'before removal'): self.updater.stop_for_rollback()
        self.assertEqual(self.record['sourceRetirement']['phase'], 'retiring')
        self.assertIn('1' * 64, self.objects)
        self.assertNotIn('7' * 64, self.objects)
        self.runtime.change = change
        self.updater.stop_for_rollback()
        self.assertNotIn('1' * 64, self.objects)
        self.assertEqual(self.objects['7' * 64]['Config']['Env'][-1], 'ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=1')
        self.assertEqual(max(self.writer_counts), 1)

    def test_enablement_wrong_reconstructed_env_and_non_dedicated_source_fail_closed(self):
        self.enable_source_bootstrap()
        held = copy.deepcopy(self.record)
        self.record['controllerResetMount']['sourceMount'] = 'absent'
        with self.assertRaises(C.BOOTSTRAP.SourceBootstrapError): self.updater.validate_retirement(self.record)
        self.assertFalse(self.calls)
        self.record = held
        self.updater.stop_for_rollback()
        self.objects['7' * 64]['Config']['Env'][-1] = 'ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=0'
        self.record['sourceRetirement']['reconstructionDefinition'] = self.runtime.definition(self.objects['7' * 64])
        with self.assertRaises(ValueError): self.updater.start_original()
        self.assertFalse(any(call[0] == 'start' for call in self.calls))

    def test_enablement_lost_candidate_create_reply_retires_candidate_before_reconstruction(self):
        self.enable_source_bootstrap()
        engine = self.runtime.engine
        def lost_create(method, route, body=None, **kwargs):
            result = engine(method, route, body, **kwargs)
            if method == 'POST' and route.endswith('name=' + self.record['candidateName']):
                raise RuntimeError('candidate create reply lost')
            return result
        self.runtime.engine = lost_create
        with self.assertRaisesRegex(RuntimeError, 'candidate create reply lost'): self.updater.start_target()
        self.assertNotIn('candidateId', self.record)
        self.runtime.engine = engine
        self.updater.stop_for_rollback()
        self.assertNotIn('2' * 64, self.objects)
        self.assertLess(self.calls.index(['rm', '2' * 64]), next(index for index, call in enumerate(self.calls) if call[:2] == ['create', '7' * 64]))
        self.assertEqual(self.objects['7' * 64]['Config']['Env'][-1], 'ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=1')
        self.assertEqual(max(self.writer_counts), 1)

    def test_enabled_and_legacy_sources_keep_existing_review_paths(self):
        before = copy.deepcopy(self.record['sourceRetirement'])
        with mock.patch.object(C.BOOTSTRAP, 'probe', return_value={'profile': C.BOOTSTRAP.CAPABLE}) as probe:
            self.updater.review_source_bootstrap(self.record)
        self.assertNotIn('sourceBootstrapEnablement', self.record)
        self.assertEqual(self.record['sourceRetirement'], before)
        probe.assert_called_once_with(self.updater, self.record, 'review')
        self.record.pop('sourceBootstrapProfile')
        source = self.record['source']
        source['Config']['Env'] = []
        self.record['current'] = {'commit': 'c' * 40, 'digest': source['Image']}
        key = (self.record['current']['commit'], self.record['current']['digest'], source['Image'])
        with mock.patch.dict(C.BOOTSTRAP.LEGACY_SOURCES, {key: 'd' * 64}), \
                mock.patch.object(C.BOOTSTRAP, 'probe', return_value={'profile': C.BOOTSTRAP.LEGACY}):
            self.updater.review_source_bootstrap(self.record)
        self.assertNotIn('sourceBootstrapEnablement', self.record)
        self.assertFalse(self.calls)

    def test_dedicated_cutover_retires_source_after_checkpoint_before_creating_candidate(self):
        self.updater.start_target()
        self.assertNotIn('1' * 64, self.objects)
        self.assertEqual(self.objects['2' * 64]['Name'], '/runtipi')
        self.assertTrue(self.objects['2' * 64]['State']['Running'])
        retirement = self.record['sourceRetirement']
        self.assertEqual(retirement['phase'], 'retired')
        self.assertIn('checkpointManifestSha256', retirement)
        self.assertLess(self.calls.index(['rm', '1' * 64]), next(i for i, call in enumerate(self.calls) if call[:2] == ['create', '2' * 64]))
        self.assertTrue(self.writer_counts and max(self.writer_counts) == 1)
        self.assertFalse(self.objects['6' * 64]['State']['Running'])
        self.assertEqual(self.objects['6' * 64]['Mounts'], [])

    def test_dedicated_rollback_reconstructs_one_stopped_source_and_never_reuses_old_id(self):
        original = copy.deepcopy(self.record['source'])
        self.updater.start_target()
        self.updater.stop_for_rollback()
        self.assertNotIn('2' * 64, self.objects)
        restored = self.objects['7' * 64]
        self.assertEqual(restored['Name'], '/runtipi')
        self.assertFalse(restored['State']['Running'])
        self.assertEqual(restored['Image'], original['Image'])
        self.assertEqual(restored['Config']['Hostname'], restored['Id'][:12])
        self.assertEqual(restored['Config']['Env'], original['Config']['Env'])
        self.assertEqual(restored['Mounts'], original['Mounts'])
        self.assertEqual(self.record['source'], original)
        self.updater.start_original()
        self.assertTrue(self.objects['7' * 64]['State']['Running'])
        self.assertFalse(any(call == ['start', original['Id']] for call in self.calls))
        self.assertNotIn('6' * 64, self.objects)
        self.assertEqual(max(self.writer_counts), 1)

    def test_incomplete_checkpoint_prevents_source_retirement(self):
        with mock.patch.object(C.TOOLS, 'read_record', return_value={'stage': 'snapshotting'}):
            with self.assertRaisesRegex(ValueError, 'durable checkpoint'):
                self.updater.start_target()
        self.assertIn('1' * 64, self.objects)
        self.assertNotIn(['rm', '1' * 64], self.calls)
        self.assertNotIn('2' * 64, self.objects)

    def test_lost_source_retirement_reply_reconstructs_source_without_any_duplicate_writer(self):
        change = self.runtime.change
        def lost(arguments):
            change(arguments)
            if arguments == ['rm', '1' * 64]: raise RuntimeError('reply lost')
        self.runtime.change = lost
        with self.assertRaises(RuntimeError): self.updater.start_target()
        self.assertEqual(self.record['sourceRetirement']['phase'], 'retiring')
        self.runtime.change = change
        self.updater.stop_for_rollback()
        self.assertEqual(self.objects['7' * 64]['Name'], '/runtipi')
        self.assertEqual(max(self.writer_counts), 1)

    def test_lost_candidate_creation_reply_is_adopted_before_dedicated_rollback_isolation(self):
        engine = self.runtime.engine
        def lost(method, route, body=None, **kwargs):
            result = engine(method, route, body, **kwargs)
            if method == 'POST' and route.endswith('name=' + self.record['candidateName']):
                raise RuntimeError('candidate create reply lost')
            return result
        self.runtime.engine = lost
        with self.assertRaisesRegex(RuntimeError, 'create reply lost'):
            self.updater.start_target()
        self.assertNotIn('candidateId', self.record)
        self.assertNotIn('1' * 64, self.objects)
        self.runtime.engine = engine
        self.updater.require_reset_mount = C.ControllerUpdate.require_reset_mount.__get__(self.updater, C.ControllerUpdate)
        binding = self.record['controllerResetMount']['binding']
        def only_writer(root, reader, selected, controller_id=None):
            writers = [item['Id'] for item in self.objects.values()
                       if any(m.get('Destination') == C.RESET.TARGET and m.get('RW') for m in item['Mounts'])]
            self.assertEqual(writers, [controller_id] if controller_id else [])
        with mock.patch.object(self.updater, 'optional_reset_enrollment', return_value=binding), \
                mock.patch.object(self.updater, 'reset_journal', return_value={'state': 'empty'}), \
                mock.patch.object(C.RESET, 'require_runtime'), \
                mock.patch.object(C.RESET, 'require_docker_isolation', side_effect=only_writer):
            self.updater.stop_for_rollback()
        self.assertNotIn('2' * 64, self.objects)
        self.assertEqual(self.objects['7' * 64]['Name'], '/runtipi')
        self.assertFalse(self.objects['7' * 64]['State']['Running'])

    def test_successful_dedicated_commit_retires_image_anchor_without_deleting_reset_backing(self):
        self.updater.start_target()
        self.assertFalse(self.updater.commit())
        self.assertNotIn('6' * 64, self.objects)
        self.assertTrue(self.objects['2' * 64]['State']['Running'])
        self.assertEqual(self.record['controllerResetMount']['journal'], {'state': 'empty'})
        self.assertFalse(any(any(flag in call for flag in ['--force', '--volumes', '-v']) for call in self.calls))

    def test_reconstruction_restore_uses_actual_writer_review_and_keeps_source_stopped(self):
        self.updater.start_target()
        self.updater.stop_for_rollback()
        saved = {'bundle': str(self.updater.snapshot), 'reviewId': 'verified-writers'}
        with mock.patch.object(C.TOOLS.RESTORE, 'review', return_value=saved) as review, \
                mock.patch.object(C.TOOLS.RESTORE, 'restore') as restore:
            self.assertTrue(self.updater.restore_reconstructed_checkpoint())
        review.assert_called_once_with(self.root, self.runtime.reader, self.updater.snapshot)
        restore.assert_called_once_with(self.root, self.runtime.reader, saved,
            self.updater.path / 'reconstructed-source-restore.json', host_writers_stopped=True, recover=False)
        self.assertFalse(self.objects['7' * 64]['State']['Running'])
        self.assertEqual(self.record['sourceRetirement']['phase'], 'restored')
        self.assertEqual(max(self.writer_counts), 1)

    def test_recovery_after_source_restart_never_replays_completed_checkpoint(self):
        self.updater.start_target()
        self.updater.stop_for_rollback()
        review = {'bundle': str(self.updater.snapshot), 'reviewId': 'verified-writers'}
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / 'application-data'
            def copy_checkpoint(*args, **kwargs): data.write_text('checkpoint data')
            with mock.patch.object(C.TOOLS.RESTORE, 'review', return_value=review), \
                    mock.patch.object(C.TOOLS.RESTORE, 'restore', side_effect=copy_checkpoint), \
                    mock.patch.object(Path, 'exists', return_value=False), \
                    mock.patch.object(Path, 'is_symlink', return_value=False):
                self.updater.restore_reconstructed_checkpoint()
            save = self.updater.save
            def crash_after_healthy(record):
                if record.get('phase') == 'rolled-back':
                    raise RuntimeError('process lost before rollback decision save')
                save(record)
            with mock.patch.object(self.updater, 'save', side_effect=crash_after_healthy):
                with self.assertRaisesRegex(RuntimeError, 'decision save'):
                    self.updater.start_original()
            self.assertTrue(self.objects['7' * 64]['State']['Running'])
            data.write_text('work written after the original restarted')
            self.updater.stop_for_rollback()
            completed = {'schema': C.TOOLS.RESTORE.SCHEMA, 'stage': 'complete', 'review': review, 'completed': [], 'active': None}
            with mock.patch.object(C.TOOLS.RESTORE, 'private_json', return_value=completed), \
                    mock.patch.object(C.TOOLS.RESTORE, 'review') as recheck, \
                    mock.patch.object(C.TOOLS.RESTORE, 'restore', side_effect=copy_checkpoint) as replay, \
                    mock.patch.object(Path, 'exists', return_value=True):
                self.assertTrue(self.updater.restore_reconstructed_checkpoint())
            recheck.assert_not_called()
            replay.assert_not_called()
            self.assertEqual(data.read_text(), 'work written after the original restarted')

    def test_forged_checkpoint_digest_cannot_restore_reconstructed_source_data(self):
        self.updater.start_target()
        self.updater.stop_for_rollback()
        self.record['sourceRetirement']['checkpointManifestSha256'] = 'f' * 64
        with mock.patch.object(C.TOOLS.RESTORE, 'restore') as restore:
            with self.assertRaisesRegex(ValueError, 'checkpoint changed'):
                self.updater.restore_reconstructed_checkpoint()
            restore.assert_not_called()
        self.assertFalse(self.objects['7' * 64]['State']['Running'])

    def test_lost_reconstruction_create_reply_adopts_only_its_exact_nonce_intent(self):
        self.updater.start_target()
        engine = self.runtime.engine
        def lost(method, route, body=None, **kwargs):
            result = engine(method, route, body, **kwargs)
            if method == 'POST' and 'reconstructed' in route: raise RuntimeError('create reply lost')
            return result
        self.runtime.engine = lost
        with self.assertRaisesRegex(RuntimeError, 'reply lost'):
            self.updater.stop_for_rollback()
        self.assertEqual(self.record['sourceRetirement']['phase'], 'reconstructing')
        self.runtime.engine = engine
        self.updater.stop_for_rollback()
        self.assertEqual(self.objects['7' * 64]['Name'], '/runtipi')
        self.assertEqual(self.record['sourceRetirement']['reconstructionId'], '7' * 64)
        self.assertEqual(max(self.writer_counts), 1)

    def test_reconstructed_bootstrap_probe_keeps_original_authority_and_bound_lookup(self):
        self.updater.start_target()
        self.updater.stop_for_rollback()
        del self.updater.lookup
        original = copy.deepcopy(self.record['source'])
        def probe(updater, record, phase):
            self.assertEqual(phase, 'rollback')
            self.assertTrue(callable(updater.lookup))
            self.assertEqual(record['source']['Id'], '7' * 64)
            record['bootstrapProbeObservation'] = 'fresh'
            updater.save(record)
            return {'profile': C.BOOTSTRAP.CAPABLE}
        with mock.patch.object(C.BOOTSTRAP, 'probe', side_effect=probe):
            C.ControllerUpdate.verify_source_bootstrap(self.updater)
        self.assertEqual(self.record['source'], original)
        self.assertEqual(self.record['bootstrapProbeObservation'], 'fresh')


class RejectedProbeRetirementTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name).resolve()
        self.updater = C.ControllerUpdate.__new__(C.ControllerUpdate)
        host = C.D.load('orbis-host.py', 'probe_retirement_host')
        self.updater.host, self.updater.P = host, host.IDENTITY.PUBLICATION
        self.updater.root, self.updater.context = base / 'install', 'fixture'
        self.updater.path, self.updater.snapshot = base / 'authority', base / 'snapshot'
        self.updater.key = 'a' * 64
        self.updater.current = {'digest': 'sha256:' + 'b' * 64}
        self.updater.target = {'image': 'ghcr.io/twentylines/orbis', 'digest': 'sha256:' + 'c' * 64}
        identifier, nonce = 'd' * 64, 'e' * 64
        image = self.updater.target['image'] + '@' + self.updater.target['digest']
        self.record = {'phase': 'preparing', 'daemonId': 'fixture-daemon', 'nonce': nonce,
                       'probeId': identifier, 'targetImageId': 'sha256:' + 'f' * 64,
                       'probeBody': {'Image': image, 'Labels': {'io.orbis.controller-probe': nonce},
                                     'HostConfig': {'NetworkMode': 'none', 'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0}}},
                       'checkpoint': {'journal': str(base / 'checkpoint.json')}}
        self.journal = {'schema': 'orbis.update.v1', 'stage': 'aborted', 'failureStage': 'pulled',
                        'failureCode': C.CapabilityError.code, 'root': str(self.updater.root), 'dockerContext': 'fixture',
                        'snapshot': str(self.updater.snapshot), 'previousDigest': self.updater.current['digest'],
                        'targetDigest': self.updater.target['digest']}
        self.files, self.events = {}, []
        self.runtime_path = self.updater.path / 'runtime.json'
        self.journal_path = self.updater.snapshot.with_name(self.updater.snapshot.name + '.orbis-update.json')
        self.receipt_path = self.updater.path / 'capability-probe-retirement.json'
        self.files[self.runtime_path] = self.updater.P.canonical(self.record)
        self.files[self.journal_path] = self.updater.P.canonical(self.journal)
        @contextmanager
        def directory(path): yield path
        @contextmanager
        def file(directory, name, *args, **kwargs):
            path = directory / name
            if path not in self.files: raise FileNotFoundError(path)
            yield self.files[path]
        def atomic(path, body):
            self.files[path] = body
            self.events.append(json.loads(body)['phase'])
        self.updater.a = SimpleNamespace(protected_directory=directory, protected_file=file, atomic=atomic)
        self.updater.read = lambda: copy.deepcopy(self.record)
        runtime = C.D.DockerRestoreRuntime(SimpleNamespace(host=host, authority=self.updater.a, root=self.updater.root, context='fixture'))
        runtime.reader = mock.Mock()
        runtime.reader._object.return_value = {'ID': 'fixture-daemon'}
        self.updater.runtime = runtime
        self.objects = {identifier: {'Id': identifier, 'Image': self.record['targetImageId'],
            'Name': '/orbis-controller-probe-' + self.updater.key,
            'Config': {'Image': image, 'Labels': {'io.orbis.controller-probe': nonce}, 'Env': []},
            'HostConfig': copy.deepcopy(self.record['probeBody']['HostConfig']), 'Mounts': [],
            'State': {'Status': 'created', 'Running': False, 'StartedAt': '0001-01-01T00:00:00Z'},
            'NetworkSettings': {'Networks': {'none': {}}}}}
        runtime.engine = lambda method, route, **kwargs: None if identifier not in self.objects else self.updater.P.canonical(self.objects[identifier])
        def change(arguments):
            self.assertEqual(arguments, ['rm', identifier])
            self.events.append('rm')
            del self.objects[identifier]
        runtime.change = change

    def test_durable_abort_retires_only_probe_and_preserves_original_records(self):
        before = {path: value for path, value in self.files.items()}
        self.assertTrue(self.updater.retire_rejected_probe())
        self.assertFalse(self.objects)
        self.assertEqual(self.events, ['approved', 'rm', 'complete'])
        self.assertEqual({path: self.files[path] for path in before}, before)
        receipt = json.loads(self.files[self.receipt_path])
        self.assertEqual(receipt['schema'], C.PROBE_RETIREMENT)
        self.assertEqual(receipt['phase'], 'complete')

    def test_nonterminal_abort_never_deletes_or_writes_receipt(self):
        self.journal['stage'] = 'pulled'
        self.files[self.journal_path] = self.updater.P.canonical(self.journal)
        with self.assertRaisesRegex(ValueError, 'durable abort'):
            self.updater.retire_rejected_probe()
        self.assertFalse(self.events)

    def test_running_or_foreign_probe_is_preserved(self):
        identifier = self.record['probeId']
        original = copy.deepcopy(self.objects[identifier])
        for mutate in (lambda probe: probe['State'].update(Status='running', Running=True),
                       lambda probe: probe.update(Name='/runtipi'),
                       lambda probe: probe['Config']['Labels'].update({'io.orbis.controller-probe': 'foreign'}),
                       lambda probe: probe['Mounts'].append({'Source': '/data', 'Destination': '/data'}),
                       lambda probe: probe['HostConfig'].update(Binds=['/data:/data']),
                       lambda probe: probe['HostConfig'].update(Mounts=[{'Type': 'bind', 'Source': '/data', 'Target': '/data'}]),
                       lambda probe: probe['HostConfig'].update(VolumesFrom=['runtipi']),
                       lambda probe: probe['Config'].update(Volumes={'/data': {}}),
                       lambda probe: probe['HostConfig']['RestartPolicy'].update(Name='always')):
            self.objects[identifier] = copy.deepcopy(original)
            mutate(self.objects[identifier])
            with self.assertRaises(ValueError): self.updater.retire_rejected_probe()
            self.assertFalse(self.events)
            self.assertIn(identifier, self.objects)

    def test_lost_remove_reply_is_reconciled(self):
        change = self.updater.runtime.change
        def lost(arguments):
            change(arguments)
            raise RuntimeError('reply lost')
        self.updater.runtime.change = lost
        self.assertTrue(self.updater.retire_rejected_probe())
        self.assertEqual(self.events, ['approved', 'rm', 'complete'])

    def test_process_crash_after_remove_reconciles_approved_receipt_without_second_remove(self):
        class Crash(BaseException): pass
        change = self.updater.runtime.change
        def crash(arguments):
            change(arguments)
            raise Crash()
        self.updater.runtime.change = crash
        with self.assertRaises(Crash): self.updater.retire_rejected_probe()
        self.assertEqual(json.loads(self.files[self.receipt_path])['phase'], 'approved')
        self.updater.runtime.change = mock.Mock()
        self.assertTrue(self.updater.retire_rejected_probe())
        self.updater.runtime.change.assert_not_called()
        self.assertEqual(json.loads(self.files[self.receipt_path])['phase'], 'complete')

    def test_foreign_definition_after_approval_is_preserved(self):
        class Crash(BaseException): pass
        self.updater.runtime.change = mock.Mock(side_effect=Crash)
        with self.assertRaises(Crash): self.updater.retire_rejected_probe()
        self.objects[self.record['probeId']]['Config']['Env'].append('OTHER=changed')
        self.updater.runtime.change = mock.Mock()
        with self.assertRaisesRegex(ValueError, 'changed after retirement approval'):
            self.updater.retire_rejected_probe()
        self.updater.runtime.change.assert_not_called()


if __name__ == '__main__':
    unittest.main()
