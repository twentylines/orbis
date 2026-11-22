"""Protected origin transitions exercised with bounded installed-state observations."""
from contextlib import contextmanager
import copy
import importlib.util
import json
import os
from pathlib import Path
import ssl
import time
from types import SimpleNamespace
import unittest
from unittest import mock

import test_orbis_host_recovery_admission

admission_fixture = SimpleNamespace(setUp=test_orbis_host_recovery_admission.AdmissionTests.setUp,
                                    authorize=test_orbis_host_recovery_admission.AdmissionTests.authorize)


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load('orbis-host-recovery-admission')
HOST = 'recover.example.test'
ORIGIN_URL = 'https://' + HOST + ':8443'
DASHBOARD = 'orbis.example.test'
ADDRESS = '192.0.2.4'
OPERATION = '7' * 64
CUSTODY = {'selectionSha256': '8' * 64, 'hostCopySha256': '9' * 64}
OLD_ENV = b'# preserved\nJWT_SECRET="immutable fixture jwt"\nLOCAL_DOMAIN=orbis.example.test\n'


def routers():
    routes = {name + '@docker': {'entryPoints': [port], 'rule': 'PathPrefix(`/`)', 'priority': 15,
        'service': 'dashboard', 'status': 'enabled'} for name, port in (
        ('dashboard', 'web'), ('dashboard-secure', 'websecure'))}
    routes['dashboard-secure@docker']['tls'] = {'certResolver': 'myresolver'}
    routes['acme-http@internal'] = {'entryPoints': ['web'], 'rule': 'PathPrefix(`/.well-known/acme-challenge/`)',
        'priority': 2147483647, 'service': 'acme-http@internal', 'status': 'enabled'}
    return routes


def active_routers():
    return {**routers(), **{name + '@file': {**route, 'status': 'enabled'} for name, route in
                           P._origin_guard_spec(HOST)['http']['routers'].items()}}


ENTRIES = {name: {'name': name, 'address': ':' + port} for name, port in (
    ('web', '80'), ('websecure', '443'), ('traefik', '8080'))}


class IngressTests(unittest.TestCase):
    def test_guard_is_exact_and_leaves_acme_and_internal_redirect(self):
        routes = active_routers()
        routes['web-to-websecure@internal'] = {'entryPoints': ['web'], 'rule': 'HostRegexp(`^.+$`)',
            'priority': 2147483646, 'service': 'noop@internal',
            'middlewares': ['redirect-web-to-websecure@internal'], 'status': 'enabled'}
        prior = {name: value for name, value in routes.items() if name not in P.ORIGIN_GUARD_NAMES}
        before = P._origin_guards(HOST, prior, {}, ENTRIES, present=False)
        after = P._origin_guards(HOST, routes, {}, ENTRIES, present=True)
        self.assertEqual(before, after)
        self.assertTrue(after['redirect'])
        self.assertEqual(P._origin_guard_spec(HOST)['tls']['options'], {'orbis-recovery-strict': {'sniStrict': True}})
        self.assertEqual(set(routes[P.ORIGIN_GUARD_NAMES[1]]['tls']), {'options'})
        self.assertIn('acme-http@internal', after['routers'])

    def test_refuses_tcp_passthrough_competing_options_disabled_and_inherited_acme(self):
        tcp = {'competing@file': {'entryPoints': ['websecure'], 'rule': 'HostSNI(`*`)',
                                  'tls': {'passthrough': True}, 'status': 'enabled'}}
        with self.assertRaises(ValueError):
            P._origin_guards(HOST, active_routers(), tcp, ENTRIES, present=True)
        for defect in ('competition', 'disabled', 'resolver', 'middleware'):
            with self.subTest(defect=defect):
                routes = active_routers()
                guard = routes[P.ORIGIN_GUARD_NAMES[1]]
                if defect == 'competition':
                    routes['other@file'] = {**guard, 'priority': 1, 'tls': {'options': 'other@file'}}
                if defect == 'disabled':
                    guard['status'] = 'disabled'
                if defect == 'resolver':
                    guard['tls']['certResolver'] = 'myresolver'
                if defect == 'middleware':
                    guard['middlewares'] = ['auth@file']
                with self.assertRaises(ValueError):
                    P._origin_guards(HOST, routes, {}, ENTRIES, present=True)

    def test_refuses_fronting_unexpected_redirect_and_failed_dashboard(self):
        ports = {'http': 80, 'https': 443}
        good = [{'status': 418, 'cookies': False, 'location': None}, {'tls': 'unknown-sni'},
                {'status': 421, 'cookies': False, 'location': None},
                {'status': 200, 'contentType': 'text/html; charset=utf-8'}]
        self.assertEqual(P._origin_checks(ADDRESS, ports, DASHBOARD, HOST, False, None,
                         mock.Mock(side_effect=good))['crossSNI'], 421)
        redirected = {'status': 308, 'location': 'https://' + HOST + '/', 'cookies': False}
        self.assertEqual(P._origin_checks(ADDRESS, ports, DASHBOARD, HOST, True, None,
                         mock.Mock(side_effect=[redirected, *good[1:]]))['http'], 308)
        for index, value in ((1, {'tls': 'indeterminate'}), (2, {'status':200, 'cookies':False, 'location':None}),
                             (3, {'status':401,'contentType':'text/html'})):
            sequence = good.copy()
            sequence[index] = value
            with self.assertRaises(ValueError):
                P._origin_checks(ADDRESS, ports, DASHBOARD, HOST, False, None, mock.Mock(side_effect=sequence))
        with self.assertRaises(ValueError):
            P._origin_checks(ADDRESS, ports, DASHBOARD, HOST, True, None,
                           mock.Mock(side_effect=[{**redirected, 'location':'https://' + DASHBOARD + '/'}, *good[1:]]))

    def test_tls_only_explicit_unknown_sni_and_pins_leaf_before_http(self):
        connection = mock.MagicMock()
        connection.__enter__.return_value = connection
        trusted = mock.MagicMock()
        trusted.__enter__.return_value = trusted
        trusted.getpeercert.return_value = b'wildcard/SAN-certificate'
        context = mock.Mock()
        with mock.patch.object(P.socket, 'socket', return_value=connection):
            alert = ssl.SSLError('alert')
            alert.reason = 'TLSV1_UNRECOGNIZED_NAME'
            context.wrap_socket.side_effect = alert
            self.assertEqual(P._origin_probe(ADDRESS, 443, host=HOST, name=HOST, context=context, unknown_sni=True),
                             {'tls':'unknown-sni'})
            alert.reason = 'TLSV1_ALERT_HANDSHAKE_FAILURE'
            with self.assertRaises(ValueError):
                P._origin_probe(ADDRESS, 443, host=HOST, name=HOST, context=context, unknown_sni=True)
            context.wrap_socket.side_effect = None
            context.wrap_socket.return_value = trusted
            with self.assertRaises(ValueError):
                P._origin_probe(ADDRESS, 443, host=HOST, name=HOST, context=context, unknown_sni=True)
            with self.assertRaises(ValueError):
                P._origin_probe(ADDRESS, 443, host=HOST, name=HOST, context=context, leaf_sha='3' * 64)
            trusted.sendall.assert_not_called()
            trusted.recv.side_effect = [b'HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\n']
            result = P._origin_probe(ADDRESS, 443, host=HOST, name=HOST, context=context,
                                   leaf_sha=P.digest(trusted.getpeercert.return_value))
            self.assertEqual(result['status'], 503)

    def test_malformed_header_is_a_fixed_refusal(self):
        conn = mock.MagicMock()
        conn.__enter__.return_value = conn
        conn.recv.return_value = b'private upstream response\r\n\r\n'
        with mock.patch.object(P.socket, 'socket', return_value=conn):
            with self.assertRaisesRegex(ValueError, '^The retained recovery origin'):
                P._origin_probe(ADDRESS, 443, host=HOST)

    def test_header_trickle_cannot_restart_absolute_deadline(self):
        conn = mock.MagicMock()
        conn.__enter__.return_value = conn
        conn.recv.return_value = b'a'
        with (mock.patch.object(P.socket, 'socket', return_value=conn),
              mock.patch.object(P.time, 'monotonic', side_effect=[0, 0, 0, 1, 2, 3])):
            with self.assertRaises(TimeoutError):
                P._origin_probe(ADDRESS, 443, host=HOST)
        self.assertEqual(conn.recv.call_count, 2)


class ProtectedOriginTests(unittest.TestCase):
    def setUp(self):
        # Share the existing real Host guard/private layout and real optional
        # Sentinel journal fixture without inheriting its unrelated test cases.
        admission_fixture.setUp(self)
        for module in (P, P.C):
            self.patch(module, 'OWNER', os.geteuid())
        self.patch(P, '_root')
        self.config = self.service.state_dir = self.state
        self.manager = P.Admission(self.service)
        self.service.current_manifest = lambda: {'tag': 'fixture'}
        self.patch(self.host, 'controller_reference', return_value='official-image')
        self.proxy_directory = self.root / 'traefik'
        self.proxy_directory.mkdir(mode=0o700)
        (self.proxy_directory / 'dynamic').mkdir(mode=0o700)
        static = self.proxy_directory / 'traefik.yml'
        static.write_text('entryPoints: {}\n')
        static.chmod(0o600)
        self.guard_file = self.proxy_directory / 'dynamic' / P.ORIGIN_GUARD_FILE
        self.origin_dir = self.namespace / P.ORIGIN_OPERATIONS / OPERATION
        self.origin_dir.parent.mkdir(mode=0o700)
        self.origin_dir.mkdir(mode=0o700)
        self.environment = self.root / '.env'
        self.write(self.environment, OLD_ENV)
        self.installation = P.digest({'root': str(self.root), 'context':'local', 'daemon':'fixture-daemon',
                                      'rootIdentity': P._origin_identity(self.root)})
        runtime_dir = P.ROOT / 'releases' / '0.9.0' / 'src/orbis_sentinel'
        self.dependencies.update(installationId=self.installation)
        self.dependencies['sentinel']['runtimeDirectory'] = str(runtime_dir)
        self.main = self.container('1', 'runtipi')
        self.main['Config']['Labels'] = {'com.docker.compose.project': 'runtipi', 'com.docker.compose.service': 'runtipi',
            'com.docker.compose.project.working_dir': str(self.root), 'io.orbis.credential-writer-protocol': P.MAIN_PROTOCOL}
        self.proxy = self.container('2', P.ORIGIN_PROXY_NAMES[0])
        self.objects = {value['Id']: value for value in (self.main, self.proxy)}
        self.effects = []
        self.patch(self.host, 'docker', side_effect=self.docker)
        self.edge = {'generation': 'e' * 64, 'receiptSha256': 'f' * 64,
                     'profileSha256': 'c' * 64, 'certificateSha256': 'd' * 64}
        fixture = P.OriginObservations.__new__(P.OriginObservations)
        fixture.root = self.root
        fixture.proxy_adoption = load('orbis-proxy-adoption')
        self.configuration = fixture.configuration
        self.patch(fixture.proxy_adoption.L.R, '_reviewed_ancestry', side_effect=self.ancestry)
        self.observations = SimpleNamespace(
            ingress=self.ingress, probes=mock.Mock(return_value={'https':'unknown-sni','http':418,'crossSNI':421,'dashboard':200}),
            registered_edge=mock.Mock(return_value=self.edge), local_daemon=lambda:'fixture-daemon', has_responder=lambda:False,
            named=self.named, inspect=lambda identifier:copy.deepcopy(self.objects[identifier]), network=self.network,
            configuration=self.configuration, create=self.create, rename=self.rename)
        self.manager.supervisor = SimpleNamespace(snapshot=self.snapshot, _host_stopped=lambda: None,
                                                   _held_runtime=self.held_runtime)
        self.actor = P.OriginTransition(self.manager, self.observations)
        self.write(self.origin_dir/'request.json', P.canonical({'schema':P.ORIGIN_REQUEST, 'operationId':OPERATION,
            'root':str(self.root), 'context':'local', 'daemon':'fixture-daemon', 'installationId':self.installation, 'origin':ORIGIN_URL,
            'address':ADDRESS, 'dashboardHost':DASHBOARD, 'edge':{key:self.edge[key] for key in ('generation','receiptSha256')}}))
        old_request = self.manager.request('unmanaged', 'https://old.example.test', unmanaged_adoption=True)
        old_plan = self.manager.review(old_request)
        digest = admission_fixture.authorize(self, old_plan)
        self.manager.apply(old_request, approved_plan_sha256=digest, authorization=self.authorization,
                           authorization_sha256=self.authorization_sha)
        self.old_history = (self.namespace/P.HISTORY).read_bytes()
        self.old_admission = (self.config/P.C.CONFIG_NAME).read_bytes()
        self.review_sha = self.approval_sha = None

    def patch(self, obj, name, *args, **kwargs):
        patch = mock.patch.object(obj, name, *args, **kwargs)
        self.addCleanup(patch.stop)
        return patch.start()

    @staticmethod
    @contextmanager
    def ancestry(_):
        yield None, lambda: None

    @staticmethod
    def write(path, body):
        path.write_bytes(body)
        path.chmod(0o600)

    def container(self, identifier, name):
        return {'Id': identifier * 64, 'Name': '/' + name, 'Image': 'sha256:' + 'a' * 64,
                'Config': {'Env': ['NODE_ENV=production', 'JWT_SECRET=immutable fixture jwt'],
                           'Image':'official-image','Labels':{}},
                'State': {'Running':True,'Paused':False,'Restarting':False,'Dead':False,'Status':'running','Pid':123},
                'HostConfig': {'RestartPolicy':{'Name':'unless-stopped','MaximumRetryCount':0},'OomKillDisable':False},
                'Path':'entry','Args':[],'Mounts':[{'Source':str(self.environment),'Destination':'/data/.env'}],
                'NetworkSettings':{'Networks':{'tipi_main_network':{'NetworkID':'b' * 64,'Aliases':['runtipi']}}}}

    @staticmethod
    def stop(raw):
        raw['State'].update(Running=False, Pid=0, Status='exited')
        raw['HostConfig']['RestartPolicy']['Name'] = 'no'

    def named(self, name):
        return next((copy.deepcopy(value) for value in self.objects.values() if value['Name'] == '/' + name), None)

    def network(self, name):
        self.assertEqual(name, 'tipi_main_network')
        return {'Id':'b' * 64,'Driver':'bridge'}

    def docker(self, context, arguments, root):
        self.assertEqual((context, root), ('local', self.root))
        self.assertEqual(arguments[-2:], ['--format','{{json .}}'])
        budget = self.host.CAPTURE_READ_DEADLINE.get()
        self.assertIsNotNone(budget)
        self.assertLessEqual(budget - time.monotonic(), 5)
        if arguments[:2] == ['network','inspect']:
            raw = self.network(arguments[2])
        else:
            self.assertEqual(arguments[:2], ['container','inspect'])
            raw = self.objects[arguments[2]]
        return SimpleNamespace(returncode=0, stdout=json.dumps(raw))

    def snapshot(self, request):
        dependencies = copy.deepcopy(self.dependencies)
        value = self.named('runtipi')
        dependencies['main'] = {'id':value['Id'], 'definitionSha256':P._origin_definition(value)}
        return dependencies, self.modules

    @contextmanager
    def held_runtime(self, *, storage_floor):
        self.assertTrue(storage_floor)
        yield self.dependencies['sentinel'], self.modules, lambda: None

    def ingress(self, request, *, present):
        self.assertEqual(self.guard_file.exists(), present)
        facts = P._origin_guards(HOST, active_routers() if present else routers(), {}, ENTRIES, present=present)
        return {'proxyId':self.proxy['Id'], 'proxyDefinitionSha256':P._origin_definition(self.proxy),
                'proxyRestartPolicy':copy.deepcopy(self.proxy['HostConfig']['RestartPolicy']),
                'proxyNetworksSha256':P.digest(P._origin_networks(self.proxy)),
                'configurationDirectory':str(self.proxy_directory),
                'configurationSha256':self.configuration(self.proxy_directory, present=present),
                'ordinaryRoutesSha256':P.digest(facts), 'redirect':False}, self.named('runtipi')

    def create(self, name, body):
        self.check_guard()
        self.effects.append(('create', name))
        original = self.main
        fresh = copy.deepcopy(original)
        fresh['Name'], fresh['Id'] = '/' + name, '3' * 64
        fresh['State'].update(Running=False, Pid=0, Status='created', StartedAt=P.ORIGIN_ZERO_TIME, FinishedAt=P.ORIGIN_ZERO_TIME)
        fresh['RestartCount'] = 0
        fresh['NetworkSettings']['Networks']['tipi_main_network']['NetworkID'] = ''
        fresh['Config'] = {key:value for key,value in body.items() if key not in ('HostConfig','NetworkingConfig')}
        fresh['HostConfig'] = body['HostConfig']
        self.objects[fresh['Id']] = fresh
        return fresh['Id']

    def rename(self, identity, name):
        self.check_guard()
        self.assertIsNone(self.named(name))
        self.effects.append(('rename', identity, name))
        self.objects[identity]['Name'] = '/' + name

    def check_guard(self):
        self.assertEqual(json.loads(self.fence.read_bytes())['operationId'], OPERATION)

    def run_phase(self, phase, phase_sha=None):
        return self.actor.run(phase, OPERATION, custody=CUSTODY, source_check=lambda:None,
                              review_sha=self.review_sha, approval_sha=self.approval_sha, phase_sha=phase_sha)

    def review_and_ingress(self):
        self.review_sha = self.run_phase('review')['reviewSha256']
        approval = P.canonical({'schema':P.ORIGIN_APPROVAL, 'operationId':OPERATION, 'installationId':self.installation,
                                'reviewSha256':self.review_sha,'approvalId':'4' * 64})
        self.write(self.origin_dir/'approval.json', approval)
        self.approval_sha = P.digest(approval)
        result = self.run_phase('ingress')
        self.assertEqual(result['phase'], 'ingress-registered')
        return result

    def staged(self):
        self.review_and_ingress()
        self.stop(self.main)
        self.stop(self.proxy)
        staged = self.run_phase('stage')
        plan = json.loads((self.origin_dir/'v1-plan.json').read_bytes())
        self.authorization = self.authorization.with_name(OPERATION+'.json')
        self.assertEqual(admission_fixture.authorize(self, plan), staged['planSha256'])
        return staged

    def test_same_guard_config_last_and_completed_replay(self):
        stage = self.staged()
        self.check_guard()
        self.assertEqual(self.run_phase('stage'), stage)
        self.assertEqual([item[0] for item in self.effects], ['create','rename','rename'])
        named = self.named('runtipi')
        self.assertEqual((named['State']['Pid'], named['State']['Status']), (0, 'created'))
        self.assertEqual(named['Config']['Env'][:-1], self.main['Config']['Env'])
        self.assertEqual(named['Config']['Env'][-1], P.ORIGIN_KEY + '=' + ORIGIN_URL)
        self.assertTrue(self.environment.read_bytes().startswith(OLD_ENV))
        self.assertEqual((self.config/P.C.CONFIG_NAME).read_bytes(), self.old_admission)
        complete = self.run_phase('commit', self.authorization_sha)
        self.assertFalse(self.fence.exists())
        self.assertEqual(json.loads((self.namespace/P.HISTORY).read_bytes())['generation'], 2)
        self.assertEqual(json.loads((self.config/P.C.CONFIG_NAME).read_bytes())['origin'], ORIGIN_URL)
        self.assertEqual((self.origin_dir/'prior-history.json').read_bytes(), self.old_history)
        self.assertEqual((self.origin_dir/'prior-admission.json').read_bytes(), self.old_admission)
        self.assertEqual(self.run_phase('commit', self.authorization_sha), complete)
        self.assertEqual(len(self.effects), 3)
        self.assertEqual(named['NetworkSettings']['Networks']['tipi_main_network']['NetworkID'], '')

    def test_unchanged_existing_origin_keeps_exact_stopped_main(self):
        old = self.manager.request('unmanaged', ORIGIN_URL, unmanaged_adoption=True)
        plan = self.manager.review(old)
        admission_fixture.authorize(self, plan)
        self.manager.apply(old, approved_plan_sha256=P.digest(plan), authorization=self.authorization,
                           authorization_sha256=self.authorization_sha)
        self.main['Config']['Env'].append(P.ORIGIN_KEY + '=' + ORIGIN_URL)
        current = OLD_ENV + (P.ORIGIN_KEY + "='" + ORIGIN_URL + "'\n").encode()
        self.write(self.environment, current)
        self.staged()
        self.assertEqual(self.effects, [])
        self.assertEqual(self.environment.read_bytes(), current)
        self.assertEqual(self.named('runtipi')['Id'], self.main['Id'])
        self.assertFalse((self.origin_dir/'candidate.json').exists())
        self.assertEqual(self.run_phase('commit', self.authorization_sha)['phase'], 'complete')
        self.assertEqual(json.loads((self.namespace/P.HISTORY).read_bytes())['generation'], 3)

    def test_lost_create_and_rename_reopen_only_owned_candidate(self):
        self.review_and_ingress()
        self.stop(self.main)
        self.stop(self.proxy)
        create, rename = self.create, self.rename
        def lost_create(name, body):
            create(name, body)
            raise OSError('lost reply after create')
        with mock.patch.object(self.observations, 'create', side_effect=lost_create):
            with self.assertRaises(OSError):
                self.run_phase('stage')
        self.check_guard()
        def lost_rename(identity, name):
            rename(identity, name)
            raise OSError('lost reply after rename')
        with mock.patch.object(self.observations, 'rename', side_effect=lost_rename):
            with self.assertRaises(OSError):
                self.run_phase('stage')
        self.assertEqual(self.run_phase('stage')['phase'], 'awaits-v1-approval')
        self.assertEqual([item[0] for item in self.effects], ['create','rename','rename'])

    def test_failure_before_and_after_config_last_completes_forward(self):
        self.staged()
        write = P._write_storage
        success = False
        def failpoint(authority, directory, name, body, *, previous):
            if name == P.C.CONFIG_NAME:
                self.check_guard()
                if success:
                    write(authority, directory, name, body, previous=previous)
                raise OSError('simulated lost config completion')
            return write(authority, directory, name, body, previous=previous)
        for success in (False, True):
            with mock.patch.object(P, '_write_storage', side_effect=failpoint):
                with self.assertRaises(OSError):
                    self.run_phase('commit', self.authorization_sha)
            self.check_guard()
            self.assertEqual(json.loads((self.namespace/P.HISTORY).read_bytes())['generation'], 2)
        self.assertEqual(self.run_phase('commit', self.authorization_sha)['phase'], 'complete')
        self.assertFalse(self.fence.exists())

    def test_approved_abort_retains_candidate_and_restores_prior_bytes(self):
        self.staged()
        terminal = {'schema':P.ORIGIN_ABORT + '.approval','operationId':OPERATION,'installationId':self.installation,
                    'reviewSha256':self.review_sha,'approvalSha256':self.approval_sha,'approvalId':'5' * 64}
        body = P.canonical(terminal)
        self.write(self.origin_dir/'abort.json', body)
        result = self.run_phase('abort', P.digest(body))
        self.assertEqual(self.environment.read_bytes(), OLD_ENV)
        self.assertFalse(self.guard_file.exists())
        self.assertEqual(self.named('runtipi')['Id'], self.main['Id'])
        self.assertIsNotNone(self.named('runtipi-origin-aborted-' + OPERATION[:32]))
        self.assertEqual(self.run_phase('abort', P.digest(body)), result)
        self.assertFalse(self.fence.exists())
        with self.assertRaises(ValueError):
            self.run_phase('commit', self.authorization_sha)

    def test_substituted_env_and_foreign_approval_keep_guard_and_prior_v1(self):
        self.staged()
        with self.assertRaises(ValueError):
            self.run_phase('commit', '0' * 64)
        self.write(self.environment, OLD_ENV + b'foreign substitution')
        with self.assertRaises(ValueError):
            self.run_phase('commit', self.authorization_sha)
        self.check_guard()
        self.assertEqual((self.namespace/P.HISTORY).read_bytes(), self.old_history)
        self.assertEqual((self.config/P.C.CONFIG_NAME).read_bytes(), self.old_admission)

    def test_network_drift_and_active_writer_journal_block_before_effects(self):
        self.review_and_ingress()
        self.stop(self.main)
        self.stop(self.proxy)
        attachment = self.main['NetworkSettings']['Networks']['tipi_main_network']
        attachment['Aliases'].append('changed')
        with self.assertRaises(ValueError):
            self.run_phase('stage')
        attachment['Aliases'].pop()
        with mock.patch.object(self.manager, '_journal', side_effect=ValueError('active writer')):
            with self.assertRaises(ValueError):
                self.run_phase('stage')
        self.assertFalse(self.fence.exists())
        self.assertEqual(self.effects, [])

    def test_previously_started_candidate_or_changed_network_never_commits(self):
        self.staged()
        candidate = self.objects[self.named('runtipi')['Id']]
        candidate['State']['Status'] = 'exited'
        with self.assertRaises(ValueError):
            self.run_phase('commit', self.authorization_sha)
        candidate['State']['Status'] = 'created'
        candidate['NetworkSettings']['Networks']['tipi_main_network']['Aliases'].append('crossed')
        with self.assertRaises(ValueError):
            self.run_phase('commit', self.authorization_sha)
        self.check_guard()
        self.assertEqual((self.config/P.C.CONFIG_NAME).read_bytes(), self.old_admission)

    def test_midflight_restart_cannot_cross_v1_config_last(self):
        self.staged()
        candidate = self.objects[self.named('runtipi')['Id']]
        writer = P._write_storage
        def drift(authority, directory, name, body, *, previous):
            result = writer(authority, directory, name, body, previous=previous)
            if name == P.HISTORY:
                candidate['State']['Status'] = 'exited'
            return result
        with mock.patch.object(P, '_write_storage', side_effect=drift):
            with self.assertRaises(ValueError):
                self.run_phase('commit', self.authorization_sha)
        self.check_guard()
        self.assertEqual((self.config/P.C.CONFIG_NAME).read_bytes(), self.old_admission)

    def test_v1_approval_inode_must_remain_bound_through_history_and_config(self):
        self.staged()
        writer = P._write_storage
        def substitute(authority, directory, name, body, *, previous):
            result = writer(authority, directory, name, body, previous=previous)
            if name == P.HISTORY:
                temporary = self.authorization.with_suffix('.tmp')
                self.write(temporary, self.authorization.read_bytes())
                os.replace(temporary, self.authorization)
            return result
        with mock.patch.object(P, '_write_storage', side_effect=substitute):
            with self.assertRaises(ValueError):
                self.run_phase('commit', self.authorization_sha)
        self.check_guard()
        self.assertEqual((self.config/P.C.CONFIG_NAME).read_bytes(), self.old_admission)
        self.assertIsNone(self.host.CAPTURE_READ_DEADLINE.get())

    def test_failed_ingress_reverts_only_known_guard_and_cannot_reapply(self):
        self.observations.probes.side_effect = ValueError('TLS indeterminate')
        with self.assertRaises(ValueError):
            self.review_and_ingress()
        self.assertFalse(self.guard_file.exists())
        self.assertTrue((self.origin_dir/'ingress-failed.json').is_file())
        with self.assertRaises(ValueError):
            self.run_phase('ingress')
        self.assertFalse(self.fence.exists())
        self.assertEqual(self.effects, [])

    def test_deployed_cookie_host_cannot_be_selected_as_recovery_alias(self):
        self.write(self.environment, OLD_ENV + b'DOMAIN=' + HOST.encode() + b'\n')
        with self.assertRaises(ValueError):
            self.run_phase('review')
        self.assertFalse(self.guard_file.exists())
        self.assertFalse(self.fence.exists())

    def test_unsafe_alternate_mount_or_unknown_admission_precludes_writes(self):
        self.review_and_ingress()
        self.stop(self.main)
        self.stop(self.proxy)
        self.write(self.proxy_directory/'traefik.yml', b'replaced')
        with self.assertRaises(ValueError):
            self.run_phase('stage')
        self.assertFalse(self.fence.exists())
        self.assertEqual(self.effects, [])
        self.assertEqual(self.environment.read_bytes(), OLD_ENV)


class PackageTests(unittest.TestCase):
    def test_fixed_dispatch_builds_and_runs_from_verified_current_package(self):
        import subprocess
        import sys
        import tempfile

        bundle, launcher = load('orbis-installer-bundle'), load('install-orbis')
        root = Path(__file__).resolve().parents[1]
        candidates = {str(path.relative_to(root)):path.read_bytes() for path in (root/'scripts').iterdir()
                      if path.is_file() and bundle.ALLOWED.fullmatch(str(path.relative_to(root)))}
        unit = 'packaging/systemd/orbis-host.service'
        candidates[unit] = (root/unit).read_bytes()
        commit = 'e' * 40
        assets = bundle.build_installer(candidates, commit)
        manifest_bytes = assets[bundle.MANIFEST]
        manifest = launcher.verify_installer_manifest(manifest_bytes,
            {'commit':commit,'manifestSha256':bundle.sha(manifest_bytes)})
        runtime = launcher.verify_files(assets[bundle.ARCHIVE], manifest)
        self.assertEqual(runtime, {name: body for name, body in candidates.items() if name not in bundle.BUILD_ONLY})
        self.assertEqual(manifest['schema'], bundle.INSTALLER_SCHEMA)
        self.assertNotIn('scripts/orbis-host-recovery-origin.py', runtime)
        with tempfile.TemporaryDirectory(prefix='origin-verified-installer-') as folder:
            selected = Path(folder)
            for name, body in runtime.items():
                member = selected / name
                member.parent.mkdir(parents=True, exist_ok=True)
                member.write_bytes(body)
            entry = selected/'scripts/orbis-host-recovery-admission.py'
            outcome = subprocess.run([sys.executable, '-I', '-B', str(entry), 'origin', '--help'],
                cwd=selected, capture_output=True, text=True, timeout=15, check=True)
            self.assertIn('Prepare the retained Sentinel recovery origin', outcome.stdout)
            ordinary = subprocess.run([sys.executable, '-I', '-B', str(entry), '--help'],
                cwd=selected, capture_output=True, text=True, timeout=15, check=True)
            self.assertIn('review-bootstrap', ordinary.stdout)


if __name__ == '__main__':
    unittest.main()
