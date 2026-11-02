import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
import socket
import threading
import time
from unittest import mock
from urllib.parse import parse_qs, urlparse

import test_orbis_host_retained_app_effects as E
F, load = E.F, E.load
from test_orbis_host_retained_restore import D, M
import test_orbis_host_retained_restore as T

R = load('orbis-host-retained-app-driver.py', 'root_app_driver_tests')


class HistoricalAppDriverTests(unittest.TestCase):
    def setUp(self):
        self.base = E.EffectsTests()
        self.base.setUp()
        self.addCleanup(self.base.tearDown)
        self.path = self.base.path
        self.capture = M.CAPTURE
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(self.capture.AUTHORITY, 'OWNER', os.getuid()).start()
        self.effects_path = self.path / 'historical-app-effects'
        self.base.engine.directory = self.effects_path
        self.apps, self.app_data = self.path / 'apps', self.path / 'app-data'
        self.values = [F.fixture(1, True), F.fixture(2, False)]
        for values in self.values:
            row = values[0]
            raw, host = row['inspect'], row['inspect']['HostConfig']
            host['Devices'] = []
            host['PortBindings'] = {}
            raw['NetworkSettings']['Ports'] = {} if row['wasRunning'] else None
            for mount in raw['Mounts']:
                source = mount['Source'].replace('/srv/orbis/app-data', str(self.app_data)).replace('/srv/orbis/apps', str(self.apps))
                old = mount['Source']; mount['Source'] = source
                host['Binds'] = [bind.replace(old + ':', source + ':', 1) for bind in host['Binds']]
                for item in host['Mounts']:
                    if item['Source'] == old: item['Source'] = source
            values[2].clear(); values[2].update({mount['Source']: mount['Source'] for mount in raw['Mounts']})
        self.base.engine.values = self.values
        for root in (self.apps, self.app_data):
            root.mkdir(mode=0o700)
            incoming = root / ('.orbis-restore-' + self.base.kwargs['restore_id'] + '.incoming')
            (incoming / 'demo/whoami').mkdir(mode=0o700, parents=True)
            (root / 'demo/whoami').mkdir(mode=0o700, parents=True)
            if root == self.apps:
                for target in (root, incoming):
                    (target / 'demo/whoami/actual.json').write_bytes(b'{"saved":"pending"}')
                    (target / 'demo/whoami/actual.json').chmod(0o600)
        self.original = {'containers': [value[0] for value in self.values],
                         'networkDefinitions': [self.values[0][3][name]['captured'] for name in sorted(self.values[0][3])]}
        self.destinations = []
        for index, values in enumerate(self.values):
            raw = F.created(values, F.compile_fixture(values), False)
            raw['Id'] = ('e' if index == 0 else 'f') * 64
            raw['State'].update(Paused=False, Restarting=False, Status='exited', StartedAt='2026-10-01T00:00:00Z', FinishedAt='2026-11-01T00:00:00Z')
            self.destinations.append(raw)
        self.base.engine.objects = {raw['Id']: copy.deepcopy(raw) for raw in self.destinations}
        self.destination = {'containers': [{'inspect': {key: value for key, value in raw.items() if key != 'State'}} for raw in self.destinations]}
        operation = b'{"root-pinned":"operation"}'
        self.write(self.path / 'node-runtime.json', operation)
        origin = b'{"independent":"origin"}'
        self.record = {'root': str(self.path), 'context': 'fixture', 'id': self.base.kwargs['restore_id'], 'pointId': self.base.kwargs['point_id'],
                       'decision': None, 'preparedOperationSha256': D.hashed(operation), 'originSha256': D.hashed(origin),
                       'source': {'controllerId': 'a' * 64, 'daemonId': 'fixture-daemon', 'container': {'Mounts': []}},
                       'stage': {'journal': {'roots': ['apps', 'app-data']}, 'journalPath': str(self.path / 'node'),
                                 'metadata': {'appRuntimeSha256': 'c' * 64}}}
        for name, root in [('apps', self.apps), ('app-data', self.app_data)]:
            self.record['source']['container']['Mounts'].append({'Type': 'bind', 'Source': str(root), 'Destination': '/data/apps' if name == 'apps' else '/app-data', 'RW': True})
            details = root.stat()
            swap = {'id': self.record['id'], 'root': '/data/apps' if name == 'apps' else '/app-data',
                    'device': str(details.st_dev), 'inode': str(details.st_ino), 'phase': 'prepared'}
            self.write(self.path / 'node/roots' / name / 'swap.json', json.dumps(swap).encode())
        manager = SimpleNamespace(CAPTURE=self.capture, directory=lambda _: self.path, origin=lambda _: SimpleNamespace(authority_bytes=origin),
                                  read=lambda _: copy.deepcopy(self.record), save=lambda value: self.record.update(copy.deepcopy(value)))
        self.runtime = object.__new__(D.DockerRestoreRuntime)
        self.runtime.manager, self.runtime.a, self.runtime.P = manager, self.capture.AUTHORITY, M.P
        self.runtime.root, self.runtime.context = self.path, 'fixture'
        self.runtime.image = lambda _: copy.deepcopy(self.values[0][1])
        self.runtime.inspect = lambda identifier: self.base.engine.inspect(identifier)
        self.runtime.engine = self.engine
        self.runtime.restore_app_statuses = mock.Mock()
        self.runtime.bounded_output = self.output
        self.original_bindings = self.capture.APP.observe_bindings(self.original)
        mock.patch.object(R.HistoricalAppDriver, 'original', return_value=(self.original, self.original_bindings)).start()
        mock.patch.object(R.HistoricalAppDriver, 'destination', return_value=self.destination).start()
        original_load = R.load
        proc_module = original_load('orbis-host-app-port-observer.py', 'root_app_proc_union_test')
        class Diag:
            def __init__(self, **values):
                if type(values.get('deadline')) is not int: raise AssertionError('native diagnostic requires integer deadline')
            def observe(self): return {'version': 1, 'complete': False, 'tcpBoundInactive': False}
        class Observer:
            def __init__(self, **values):
                if type(values.get('deadline')) is not int: raise AssertionError('native observer requires integer deadline')
            def _check(self): pass
            def observe(self, _):
                return {'observation': {'complete': True, 'namespace': 'host', 'protocols': ['tcp', 'udp'], 'sockets': []},
                        'ownership': {'coverage': {'tcpBoundInactive': False}}}
            def prove_host_socket_owner(self, *_): return False
        mock.patch.object(R, 'load', side_effect=lambda name, key: SimpleNamespace(ProcPortObserver=Observer, combine_port_observations=proc_module.combine_port_observations) if name == 'orbis-host-app-port-observer.py' else SimpleNamespace(InetDiagTcpObserver=Diag) if name == 'orbis-host-app-inet-diag.py' else original_load(name, key)).start()

    def write(self, path, body):
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.write_bytes(body); path.chmod(0o600)

    def output(self, arguments, *_):
        if arguments[3:5] == ['network', 'inspect']:
            return self.capture.APP.canonical(self.values[0][3][arguments[-1]]['current'])
        if arguments[3:5] == ['container', 'ls']:
            return ('\n'.join(sorted(self.base.engine.objects))).encode()
        raise AssertionError('unexpected fixture observation')

    def engine(self, method, route, body=None, *, allow_missing=False, **_):
        parsed = urlparse(route)
        value = parsed.path.split('/')[2]
        if method == 'GET':
            raw = self.base.engine.inspect(value) if len(value) == 64 else self.base.engine.find_name(value)
            if raw is None and not allow_missing: raise ValueError('fixture not found')
            return None if raw is None else self.capture.APP.canonical(raw)
        if method == 'POST' and value == 'create':
            identifier = self.base.engine.create(parse_qs(parsed.query)['name'][0], body)
            return self.runtime.P.canonical({'Id': identifier, 'Warnings': []})
        if method == 'POST' and parsed.path.endswith('/start'):
            self.base.engine.start(value)
            raw = self.base.engine.objects[value]; raw['State']['Health'] = {'Status': 'healthy'}
            for endpoint in raw['NetworkSettings']['Networks'].values():
                for requested, observed in (('IPv4Address', 'IPAddress'), ('IPv6Address', 'GlobalIPv6Address')):
                    selected = (endpoint.get('IPAMConfig') or {}).get(requested)
                    if selected: endpoint[observed] = selected
            return b''
        if method == 'DELETE':
            self.assertEqual(parse_qs(parsed.query), {'force': ['0'], 'v': ['0'], 'link': ['0']})
            self.base.engine.remove(value); return b''
        raise AssertionError('unexpected fixture effect')

    def driver(self): return R.HistoricalAppDriver(self.runtime, self.record)

    def test_prepared_probe_then_commit_creates_exact_runtime_without_saved_compose(self):
        driver = self.driver()
        driver.probe(); driver.precommit()
        self.assertEqual(set(self.base.engine.objects), {item['Id'] for item in self.destinations})
        self.record['decision'] = 'commit'
        driver = self.driver()
        result = driver.activate()
        self.assertEqual(len(result['containers']), 2)
        self.assertEqual(sum(item['wasRunning'] for item in result['containers']), 1)
        self.assertEqual(sum(raw['State']['Running'] for raw in self.base.engine.objects.values()), 1)
        for raw in self.base.engine.objects.values():
            self.assertIn('MODE=running-old', raw['Config']['Env'])
            self.assertNotIn('MODE=saved-new', raw['Config']['Env'])
        self.assertEqual(self.driver().verify(), result)

    def test_probe_binds_only_root_verified_incoming_paths_and_removes_every_probe(self):
        driver = self.driver(); driver.probe()
        creates = [event for event in self.base.engine.events if event[0] == 'create']
        self.assertEqual(len(creates), 2)
        plan = json.loads((self.path / 'historical-app-plan.json').read_bytes())
        for probe in plan['probePlans']:
            self.assertIn('.orbis-restore-' + self.record['id'] + '.incoming', probe['compiled']['body']['HostConfig']['Mounts'][0]['Source'])
        self.assertEqual(set(self.base.engine.objects), {item['Id'] for item in self.destinations})

    def test_unknown_managed_container_blocks_effects_before_retirement(self):
        driver = self.driver(); driver.probe()
        extra = copy.deepcopy(self.destinations[0]); extra.update(Id='9' * 64, Name='/unknown-managed-writer')
        self.base.engine.objects[extra['Id']] = extra
        self.record['decision'] = 'commit'
        with self.assertRaises(ValueError): self.driver().activate()
        self.assertTrue(all(item['Id'] in self.base.engine.objects for item in self.destinations))

    def test_mutable_root_plan_and_operation_hash_cannot_authorize_effects(self):
        driver = self.driver()
        self.write(self.path / 'node-runtime.json', b'{"changed":true}')
        with self.assertRaises(ValueError): driver.probe()
        self.assertFalse(any(event[0] == 'create' for event in self.base.engine.events))

    def test_incoming_source_replacement_is_rejected_before_daemon_create(self):
        driver = self.driver()
        file = self.apps / ('.orbis-restore-' + self.record['id'] + '.incoming/demo/whoami/actual.json')
        replacement = file.with_name('replacement.json')
        self.write(replacement, b'replaced')
        self.assertNotEqual(file.stat().st_ino, replacement.stat().st_ino)
        os.replace(replacement, file)
        with self.assertRaises(ValueError): driver.probe()
        self.assertFalse(any(event[0] == 'create' for event in self.base.engine.events))

    def test_host_ports_fail_before_commit_without_bound_inactive_kernel_coverage(self):
        self.values[0][0]['inspect']['HostConfig']['PortBindings'] = {'8080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18080'}]}
        self.values[0][0]['inspect']['NetworkSettings']['Ports'] = copy.deepcopy(self.values[0][0]['inspect']['HostConfig']['PortBindings'])
        with self.assertRaises(ValueError): self.driver().probe()
        self.assertFalse(any(event[0] == 'remove' for event in self.base.engine.events))

    def test_static_network_identity_conflicts_are_rejected_before_commit(self):
        driver = self.driver(); driver.probe()
        network = self.values[0][3]['whoami_demo_default']['current']
        network['Containers'] = {'9' * 64: {'Name': 'unrelated', 'IPv4Address': '172.20.0.2/16', 'IPv6Address': '', 'MacAddress': '02:42:ac:00:00:99'}}
        with self.assertRaises(ValueError): driver.precommit()
        self.assertTrue(all(raw['Id'] in self.base.engine.objects for raw in self.destinations))

    def test_actual_static_assignment_must_match_protected_requested_address(self):
        self.driver().probe(); self.record['decision'] = 'commit'; self.driver().activate()
        raw = next(value for value in self.base.engine.objects.values() if value['State']['Running'])
        raw['NetworkSettings']['Networks']['whoami_demo_default']['IPAddress'] = '172.20.0.99'
        with self.assertRaises(ValueError): self.driver().verify()

    def test_changed_network_or_swap_identity_fails_before_any_effect(self):
        self.values[0][3]['shared']['current']['Internal'] = True
        with self.assertRaises(ValueError): self.driver()
        self.assertFalse(self.base.engine.events)

    def test_completed_effects_result_is_immutable_and_contains_only_bounded_identities(self):
        self.driver().probe()
        self.record['decision'] = 'commit'
        result = self.driver().activate()
        wire = (self.path / 'historical-app-result.json').read_bytes()
        self.assertEqual(D.hashed(wire), result['appEffectsSha256'])
        self.assertNotIn(b'Env', wire)
        self.assertNotIn(b'MODE=', wire)
        self.record['appEffectsSha256'] = '0' * 64
        with self.assertRaises(ValueError): self.driver().verify()

    def test_lost_create_reply_reconciles_exact_id_and_forward_retry_preserves_writes(self):
        self.driver().probe(); self.record['decision'] = 'commit'
        self.base.engine.lose = 'create'
        with self.assertRaises(E.LostReply): self.driver().activate()
        result = self.driver().activate()
        sentinel = self.path / 'postcommit-app-write'
        self.write(sentinel, b'keep new writes')
        creates = sum(event[0] == 'create' for event in self.base.engine.events)
        self.assertEqual(self.driver().activate(), result)
        self.assertEqual(sum(event[0] == 'create' for event in self.base.engine.events), creates)
        self.assertEqual(sentinel.read_bytes(), b'keep new writes')

    def test_expired_effects_require_explicit_root_quiesced_recovery_grant(self):
        self.driver().probe()
        self.record['decision'] = 'commit'
        predecessor = self.record['appEffectsLease']['deadline']
        with mock.patch.object(R.time, 'time', return_value=predecessor + 1):
            with self.assertRaises(ValueError): self.driver().activate()
            result = self.driver().activate(recovery=True)
        progress = json.loads((self.effects_path / 'progress.json').read_bytes())
        self.assertEqual(progress['version'], 2)
        self.assertEqual(progress['leaseHistory'][0]['predecessorDeadline'], predecessor)
        self.assertEqual(progress['leaseHistory'][0]['grantId'], self.record['appEffectsLease']['id'])
        self.assertEqual(len(result['containers']), 2)

    def test_plan_hash_is_durable_before_immutable_write_and_retry_rederives_exact_scope(self):
        immutable = self.capture.immutable
        def fail_plan(path, body):
            if path.name == 'historical-app-plan.json':
                self.assertEqual(self.record['appPlanSha256'], D.hashed(body))
                raise OSError('fixture interrupted private plan write')
            return immutable(path, body)
        with mock.patch.object(self.capture, 'immutable', side_effect=fail_plan), self.assertRaises(OSError): self.driver()
        self.assertFalse(self.base.engine.events)
        self.assertTrue(self.record['appPlanSha256'])
        driver = self.driver()
        self.assertEqual(D.hashed((self.path / 'historical-app-plan.json').read_bytes()), self.record['appPlanSha256'])
        driver.probe()


class HistoricalAppDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.rows = [{'id': 7, 'urn': 'whoami:_user', 'status': 'running', 'pendingRestart': True, 'userConfigEnabled': False},
                     {'id': 8, 'urn': 'zombie:demo', 'status': 'missing', 'pendingRestart': False, 'userConfigEnabled': True}]
        self.runtime = object.__new__(D.DockerRestoreRuntime)
        self.runtime.P = M.P
        self.runtime.captured_app_rows = mock.Mock(return_value=copy.deepcopy(self.rows))
        self.runtime.reader = SimpleNamespace(_read=mock.Mock())
        self.record = {'id': '11111111-1111-4111-8111-111111111111', 'nonce': '22222222-2222-4222-8222-222222222222'}
        self.operation = {'database': {'connection': {'user': 'tipi'}, 'owner': {'name': 'orbis_restore_' + '1' * 32}}}

    def answer(self, rows): self.runtime.reader._read.return_value = json.dumps({'apps': rows})

    def test_staging_transform_changes_only_status_and_preserves_pending_preferences(self):
        staged = [{**item, 'status': 'stopped'} for item in self.rows]
        self.answer(list(reversed(staged)))
        self.assertEqual(self.runtime.verify_app_rows(self.record, self.operation, {'Id': 'd' * 64}), staged)
        self.answer(self.rows)
        self.assertEqual(self.runtime.verify_app_rows(self.record, self.operation, {'Id': 'd' * 64}, restored=True), self.rows)

    def test_omitted_or_changed_database_row_cannot_choose_app_state(self):
        for rows in (self.rows[:1], [{**self.rows[0], 'pendingRestart': False}, self.rows[1]],
                     [{**self.rows[0], 'userConfigEnabled': True}, self.rows[1]], [{**self.rows[0], 'id': True}, self.rows[1]]):
            self.answer(rows)
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                self.runtime.verify_app_rows(self.record, self.operation, {'Id': 'd' * 64}, restored=True)

    def test_status_update_is_commit_only_root_pinned_and_checks_owner_inside_sql_transaction(self):
        fixture = E.EffectsTests(); fixture.setUp(); self.addCleanup(fixture.tearDown)
        path = fixture.path
        operation = {'database': {'connection': {'user': 'tipi'}, 'owner': {'name': 'orbis_restore_' + self.record['id'].replace('-', ''),
                     'oid': 42, 'marker': 'orbis.restore.v1/' + self.record['id'] + '/' + self.record['nonce']}}}
        body = M.P.canonical(operation)
        (path / 'node-runtime.json').write_bytes(body); (path / 'node-runtime.json').chmod(0o600)
        self.record.update(decision='commit', preparedOperationSha256=D.hashed(body), stage={'metadata': {'schema': 'orbis.time-machine-runtime.v6'}})
        self.runtime.a, self.runtime.root = E.A, path
        self.runtime.manager = SimpleNamespace(directory=lambda _: path, CAPTURE=E.C, save=mock.Mock())
        database = {'Id': 'd' * 64, 'State': {'Running': True}, 'Config': {'Labels': {
            'com.docker.compose.project.working_dir': str(path), 'com.docker.compose.service': 'runtipi-db'}}}
        self.runtime.inspect = mock.Mock(return_value=database)
        self.runtime.reader._read.side_effect = ['', json.dumps({'apps': self.rows})]
        self.runtime.restore_app_statuses(self.record)
        sql = self.runtime.reader._read.call_args_list[0].args[0][-1]
        self.assertIn('LOCK TABLE public.app IN EXCLUSIVE MODE', sql)
        self.assertIn('oid=42', sql)
        self.assertIn('pg_catalog.shobj_description', sql)
        self.assertIn('"pendingRestart":true', sql)
        self.assertIn('"userConfigEnabled":false', sql)
        self.assertIn("UPDATE public.app SET status='running' WHERE id=7", sql)
        self.assertTrue(self.record['appStatusRestored'])
        self.assertTrue((path / 'app-status-intent.json').is_file())
        self.record['decision'] = None
        with self.assertRaises(ValueError): self.runtime.restore_app_statuses(self.record)


class HistoricalAppCallerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = T.RetainedRestoreTests(); self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.runtime, self.manager = self.fixture.runtime, self.fixture.manager
        prior = self.runtime.review_stage
        self.runtime.review_stage = lambda *args: {**prior(*args), 'metadata': {'schema': 'orbis.time-machine-runtime.v6'}}
        self.calls = []
        def apps(record, action, **kwargs):
            self.calls.append((action, record['decision'], kwargs))
            self.runtime.event('historical-apps:' + action)
        self.runtime.historical_apps = apps

    def test_existing_root_callers_probe_precommit_and_execute_only_after_durable_commit(self):
        self.fixture.begin(); identifier = self.fixture.request['restoreId']
        self.manager.prepare(identifier, self.fixture.key)
        self.manager.activate(identifier, self.fixture.key)
        self.assertEqual([(action, decision) for action, decision, _ in self.calls],
                         [('probe', None), ('precommit', None), ('activate', 'commit'), ('verify', 'commit')])
        events = self.runtime.events
        self.assertLess(events.index('historical-apps:probe'), events.index('promote'))
        self.assertLess(events.index('historical-apps:activate'), events.index('activation'))

    def test_precommit_failure_cleans_probes_before_data_rollback(self):
        self.fixture.begin(); identifier = self.fixture.request['restoreId']
        self.manager.prepare(identifier, self.fixture.key)
        self.runtime.fail_at = 'historical-apps:precommit'
        with self.assertRaises(RuntimeError): self.manager.activate(identifier, self.fixture.key)
        self.assertEqual(self.manager.read(identifier)['decision'], 'rollback')
        events = self.runtime.events
        self.assertLess(events.index('historical-apps:rollback'), events.index('rollback'))
        self.assertNotIn('historical-apps:activate', events)

    def test_postcommit_app_failure_is_forward_only_and_recovery_uses_explicit_mode(self):
        self.fixture.begin(); identifier = self.fixture.request['restoreId']
        self.manager.prepare(identifier, self.fixture.key)
        self.runtime.fail_at = 'historical-apps:activate'
        with self.assertRaises(RuntimeError): self.manager.activate(identifier, self.fixture.key)
        self.assertEqual(self.manager.read(identifier)['decision'], 'commit')
        self.assertNotIn('rollback', self.runtime.events)
        self.runtime.fail_at = None
        self.manager.recover(identifier, self.fixture.key)
        self.assertIn(('activate', 'commit', {'recovery': True}), self.calls)

    def test_actual_protected_result_route_is_token_only_and_cannot_execute_apps(self):
        identifier, record = self.fixture.staged_candidate_activation()
        material = {'appRuntimeSha256': 'e' * 64, 'appEffectsSha256': 'f' * 64, 'containers': []}
        self.runtime.candidate_app_result_material = mock.Mock(return_value=material)
        endpoint = self.fixture.base / 'app-result.sock'
        server = T.S.UnixHTTPServer(str(endpoint), T.S.Handler)
        server.service = SimpleNamespace(retained_restores=lambda: self.manager)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        def request(value):
            body = json.dumps(value).encode()
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(2); connection.connect(str(endpoint))
                headers = ('POST /v1/retained-restore/' + identifier + '/candidate-app-result HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(body)) + '\r\n\r\n').encode()
                connection.sendall(headers + body); response = b''
                while True:
                    part = connection.recv(65536)
                    if not part: break
                    response += part
            return response.split(b'\r\n\r\n', 1)
        with mock.patch.object(T.S, 'trusted_capture_peer', return_value=True), self.manager.operation(identifier):
            head, body = request({'token': self.fixture.key})
            self.assertIn(b'200', head)
            result = json.loads(body)
            self.assertEqual(result['appEffectsSha256'], material['appEffectsSha256'])
            self.assertEqual(result['expiresAt'], record['candidateActivationLease']['expiresAt'])
            self.assertIn(b'409', request({'token': self.fixture.key, 'containers': []})[0])
        with mock.patch.object(T.S, 'trusted_capture_peer', return_value=False):
            self.assertIn(b'409', request({'token': self.fixture.key})[0])


if __name__ == '__main__': unittest.main()
