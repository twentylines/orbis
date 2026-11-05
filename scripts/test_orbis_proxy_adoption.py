import copy
import hashlib
import importlib.util
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

spec = importlib.util.spec_from_file_location('proxy_adoption_tests', Path(__file__).with_name('orbis-proxy-adoption.py'))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)


def started():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')


class Engine:
    P = M.P
    definition = M.D.DockerRestoreRuntime.definition
    check_intent = M.D.DockerRestoreRuntime.check_intent
    def __init__(self, root):
        self.root = root
        self.context = 'local'
        self.reader = self
        self.calls = []
        self.lost = None
        self.rows = {}
        def mount(source, target, rw=True):
            return {'Type': 'bind', 'Source': str(source), 'Destination': target, 'RW': rw, 'Propagation': 'rprivate'}
        proxy = {'Id': 'a' * 64, 'Image': 'sha256:' + 'b' * 64, 'Name': '/' + M.NAME,
                 'Config': {'Image': 'traefik:v2', 'User': '', 'Env': ['A=B'], 'Labels': {
                     'com.docker.compose.project': 'runtipi', 'com.docker.compose.service': M.NAME,
                     'com.docker.compose.project.working_dir': str(root)}},
                 'HostConfig': {'AutoRemove': False, 'Privileged': False, 'NetworkMode': 'core',
                                'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0},
                                'Binds': [str(root / 'traefik') + ':/etc/traefik', str(root / 'traefik/shared') + ':/shared']},
                 'Mounts': [mount(root / 'traefik', '/etc/traefik'), mount(root / 'traefik/shared', '/shared')],
                 'State': {'Running': True, 'Paused': False, 'Restarting': False, 'Status': 'running', 'StartedAt': started()},
                 'NetworkSettings': {'Networks': {'core': {'NetworkID': 'c' * 64, 'Aliases': ['proxy'], 'IPAddress': '172.31.0.2'}}}}
        controller = copy.deepcopy(proxy)
        controller.update(Id='d' * 64, Name='/runtipi')
        controller['Config']['Labels']['com.docker.compose.service'] = 'runtipi'
        controller['Mounts'] = [mount(root / 'traefik', '/data/traefik')]
        self.rows = {r['Id']: r for r in (proxy, controller)}
    def socket(self): return '/var/run/docker.sock'
    def daemon(self): return 'daemon-one'
    def containers(self): return [{'id': item} for item in self.rows]
    def inspect(self, identifier):
        if identifier in self.rows: return copy.deepcopy(self.rows[identifier])
        return copy.deepcopy(next(r for r in self.rows.values() if r['Name'] == '/' + identifier))
    def image(self, identifier): return {'Config': {}}
    def observed_proxy_static_digest(self, proxy): return hashlib.sha256((Path(next(m['Source'] for m in proxy['Mounts'] if m['Destination'] == '/etc/traefik')) / 'traefik.yml').read_bytes()).hexdigest()
    def engine(self, method, route, body=None):
        if method == 'GET' and route == '/networks/core': return M.P.canonical({'Id': 'c' * 64})
        self.calls.append(('create', route))
        target = {'Id': 'e' * 64, 'Name': '/' + M.NAME, 'Image': body['Image'],
                  'Config': {k: copy.deepcopy(v) for k, v in body.items() if k not in {'HostConfig', 'NetworkingConfig'}},
                  'HostConfig': copy.deepcopy(body['HostConfig']),
                  'Mounts': [{'Type': 'bind', 'Source': m['Source'], 'Destination': m['Target'], 'RW': not m['ReadOnly'],
                              'Propagation': 'rprivate'} for m in body['HostConfig']['Mounts']],
                  'NetworkSettings': {'Networks': {'core': {'NetworkID': 'c' * 64, 'Aliases': ['proxy'], 'IPAddress': '172.31.0.3'}}},
                  'State': {'Running': False, 'Paused': False, 'Restarting': False, 'Status': 'created', 'StartedAt': '0001-01-01T00:00:00Z'}}
        self.rows[target['Id']] = target
        if self.lost == 'create': self.lost = None; raise RuntimeError('lost reply')
        return M.P.canonical({'Id': target['Id']})
    def change(self, arguments):
        self.calls.append(tuple(arguments))
        op = arguments[0]
        raw = self.rows[arguments[-1] if op not in {'rename'} else arguments[1]]
        if op == 'update':
            value = arguments[1].split('=', 1)[1]
            name, _, retries = value.partition(':')
            raw['HostConfig']['RestartPolicy'] = {'Name': name, 'MaximumRetryCount': int(retries or 0)}
        elif op == 'stop': raw['State'].update(Running=False, Status='exited')
        elif op == 'start': raw['State'].update(Running=True, Status='running', StartedAt=started())
        elif op == 'rename': raw['Name'] = '/' + arguments[2]
        if self.lost == op: self.lost = None; raise RuntimeError('lost reply')


class AdoptionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.root = self.base / 'installation'; self.root.mkdir(mode=0o775)
        (self.root / 'traefik/shared').mkdir(parents=True)
        (self.root / 'traefik').chmod(0o777)
        (self.root / 'traefik/traefik.yml').write_bytes(b'entryPoints: {}\n')
        (self.root / 'traefik/shared/acme.json').write_bytes(b'private synthetic identity')
        self.engine = Engine(self.root)
        self.state = self.base / 'protected'; self.state.mkdir(mode=0o700)
        self.patch(M.A, 'OWNER', new=os.geteuid())
        self.patch(M.L, 'STATE_ROOT', new=self.state)
        self.patch(M.L, 'read', return_value={'schema': 'test-layout', 'approved': True})
        self.adoption = M.Adoption(self.root, 'local', self.engine)
        M.L.namespace(self.root).mkdir(mode=0o700, parents=True)
        self.routes = {'dashboard@docker': {'fixture': 'http'}, 'dashboard-secure@docker': {'fixture': 'https'}}
        self.patch(M.Adoption, 'routes', return_value=self.routes)
    def patch(self, target, attribute, **kwargs):
        patch = mock.patch.object(target, attribute, **kwargs); value = patch.start(); self.addCleanup(patch.stop); return value
    def plan(self): return self.adoption.review(['d' * 64])
    def approve(self):
        plan = self.plan()
        return self.adoption.approve(plan, M.digest(plan))
    def apply(self): return self.adoption.resume(self.approve())
    def test_review_no_mutation_and_approval_pins_exact_plan(self):
        plan = self.plan()
        self.assertFalse(self.adoption.directory.exists()); self.assertEqual([], self.engine.calls)
        self.assertTrue(plan['preserveOriginal'])
        self.assertEqual(0o777, (self.root / 'traefik').stat().st_mode & 0o777)
        with self.assertRaises(ValueError): self.adoption.approve(plan, '0' * 64)
        self.assertFalse(self.adoption.directory.exists())
        (self.root / 'traefik/shared/acme.json').write_bytes(b'changed')
        with self.assertRaises(ValueError): self.adoption.approve(plan, M.digest(plan))
    def test_unreviewed_rw_config_alias_rejected(self):
        with self.assertRaisesRegex(ValueError, 'unreviewed container'): self.adoption.review()
        other = copy.deepcopy(self.engine.rows['d' * 64]); other['Id'] = 'f' * 64
        self.engine.rows[other['Id']] = other
        with self.assertRaisesRegex(ValueError, 'unreviewed container'): self.plan()
    def test_protected_namespace_alias_rejected_even_if_readonly(self):
        self.engine.rows['d' * 64]['Mounts'].append({'Type': 'bind', 'Source': str(self.state), 'Destination': '/private', 'RW': False})
        with self.assertRaisesRegex(ValueError, 'protected enrollment'): self.plan()
    def test_links_and_static_digest_drift_rejected(self):
        path = self.root / 'traefik/shared/acme.json'
        path.rename(path.with_name('original'))
        path.symlink_to(path.with_name('original'))
        with self.assertRaisesRegex(ValueError, 'link'): self.plan()
        path.unlink(); os.link(path.with_name('original'), path)
        with self.assertRaisesRegex(ValueError, 'link'): self.plan()
    def test_tree_seals_entry_replacement_and_metadata(self):
        with self.assertRaises(ValueError):
            with M.sealed_tree(self.root / 'traefik/shared') as (_, _, seal):
                path = self.root / 'traefik/shared/acme.json'
                path.rename(path.with_name('retained'))
                path.write_bytes(b'private synthetic identity')
                seal()
    def test_apply_preserves_peers_original_config_and_identity(self):
        peer = copy.deepcopy(self.engine.rows['d' * 64])
        original = (self.root / 'traefik/traefik.yml').read_bytes()
        result = self.apply()
        self.assertEqual(M.SCHEMA, result['schema'])
        self.assertEqual(peer, self.engine.rows['d' * 64])
        self.assertFalse(self.engine.rows['a' * 64]['State']['Running'])
        self.assertIn('orbis-proxy-original-', self.engine.rows['a' * 64]['Name'])
        self.assertEqual(original, (self.root / 'traefik/traefik.yml').read_bytes())
        self.assertEqual(0o777, (self.root / 'traefik').stat().st_mode & 0o777)
        self.assertEqual(b'private synthetic identity', (self.adoption.identity / 'acme.json').read_bytes())
        self.assertEqual(0o600, (self.adoption.identity / 'acme.json').stat().st_mode & 0o777)
        self.assertEqual(0o700, self.adoption.identity.stat().st_mode & 0o777)
    def test_lost_create_reply_recovers_exact_intent_without_second_create(self):
        record = self.approve(); self.engine.lost = 'create'
        with self.assertRaises(RuntimeError): self.adoption.resume(record)
        self.adoption.resume(self.adoption.read())
        self.assertEqual(1, sum(c[0] == 'create' for c in self.engine.calls))
    def test_lost_stop_reply_resumes_without_second_stop(self):
        record = self.approve(); self.engine.lost = 'stop'
        with self.assertRaises(RuntimeError): self.adoption.resume(record)
        self.adoption.resume(self.adoption.read())
        self.assertEqual(1, sum(call[0] == 'stop' for call in self.engine.calls))
    def test_lost_start_reply_recovers_without_second_start(self):
        record = self.approve(); self.engine.lost = 'start'
        with self.assertRaises(RuntimeError): self.adoption.resume(record)
        self.adoption.resume(self.adoption.read())
        self.assertEqual(1, sum(call[0] == 'start' for call in self.engine.calls))
    def test_physical_bind_alias_and_recursive_submount_rejected(self):
        mountinfo = self.base / 'mountinfo'
        alias = self.base / 'alias'; alias.mkdir()
        mountinfo.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n'
            + '2 1 8:1 ' + str(self.root / 'traefik') + ' ' + str(alias) + ' rw - ext4 /dev/test rw\n')
        other = copy.deepcopy(self.engine.rows['d' * 64]); other['Id'] = 'f' * 64
        other['Mounts'] = [{'Type': 'bind', 'Source': str(alias), 'Destination': '/alias', 'RW': True}]
        with self.assertRaisesRegex(ValueError, 'unreviewed container'):
            M.require_aliases(self.root, [other], 'a' * 64, mountinfo=mountinfo)
        # A parent bind recursively exposes an aliased submount too.
        other['Mounts'][0]['Source'] = str(alias.parent)
        with self.assertRaisesRegex(ValueError, 'protected enrollment|unreviewed container'):
            M.require_aliases(self.root, [other], 'a' * 64, mountinfo=mountinfo)
    def test_interrupted_copy_resumes_matching_partial_tree_only(self):
        record = self.approve(); self.engine.lost = 'create'
        with self.assertRaises(RuntimeError): self.adoption.resume(record)
        # Represent process loss after mkdir/fsync but before the first copied file.
        self.engine.rows.pop('e' * 64)
        record = self.adoption.read(); record['targetId'] = None; record['phase'] = 'stopped'; record['intent'] = 'copy-identity'
        (self.adoption.identity / 'acme.json').unlink(); self.adoption.save(record)
        self.adoption.resume(self.adoption.read())
        self.assertEqual(b'private synthetic identity', (self.adoption.identity / 'acme.json').read_bytes())
    def test_interrupted_file_copy_preserves_partial_then_resumes_exact_intent(self):
        record = self.approve(); self.engine.lost = 'create'
        with self.assertRaises(RuntimeError): self.adoption.resume(record)
        self.engine.rows.pop('e' * 64)
        record = self.adoption.read(); record.update(targetId=None, phase='stopped', intent='copy-identity', identityCopyEntry='acme.json')
        (self.adoption.identity / 'acme.json').write_bytes(b'partial')
        self.adoption.save(record)
        self.adoption.resume(self.adoption.read())
        self.assertEqual(b'private synthetic identity', (self.adoption.identity / 'acme.json').read_bytes())
        retained = list(self.adoption.directory.glob('copy-partial-*'))
        self.assertEqual(1, len(retained)); self.assertEqual(b'partial', retained[0].read_bytes())
    def test_rollback_detects_write_during_target_stop(self):
        self.apply(); original = self.engine.change
        def change(arguments):
            original(arguments)
            if arguments[0] == 'stop' and arguments[-1] == 'e' * 64:
                (self.adoption.identity / 'acme.json').write_bytes(b'identity renewed during stop')
        self.engine.change = change
        with self.assertRaisesRegex(ValueError, 'NEVER restart'):
            self.adoption.rollback(self.adoption.read())
        self.assertFalse(self.engine.rows['a' * 64]['State']['Running'])
        self.assertFalse(self.engine.rows['e' * 64]['State']['Running'])
    def test_alias_or_peer_drift_before_mutation_holds(self):
        record = self.approve()
        self.engine.rows['d' * 64]['State']['StartedAt'] = started()
        with self.assertRaisesRegex(ValueError, 'another container'): self.adoption.resume(record)
        self.assertEqual([], self.engine.calls)
    def test_static_same_new_untrusted_hashes_are_not_authority(self):
        self.apply(); path = M.execution_path(self.root) / 'traefik.yml'; path.write_bytes(b'new untrusted static')
        with self.assertRaises(ValueError): M.verified_authority(self.root, 'local', self.engine.inspect('e' * 64), self.engine)
    def test_authority_preserves_v1_logical_descriptor_and_allows_ro_controller_succession(self):
        self.apply()
        controller = self.engine.rows.pop('d' * 64); controller['Id'] = 'f' * 64
        controller['Mounts'][0]['RW'] = False; self.engine.rows[controller['Id']] = controller
        receipt = M.verified_authority(self.root, 'local', self.engine.inspect('e' * 64), self.engine)
        self.assertEqual('e' * 64, receipt['proxyId'])
        controller['Mounts'][0]['RW'] = True
        with self.assertRaisesRegex(ValueError, 'unreviewed container'): M.verified_authority(self.root, 'local', self.engine.inspect('e' * 64), self.engine)
    def test_rollback_only_if_identity_unchanged_and_retains_target(self):
        self.apply(); result = self.adoption.rollback(self.adoption.read())
        self.assertEqual('rolled-back', result['phase'])
        self.assertTrue(self.engine.rows['a' * 64]['State']['Running'])
        self.assertFalse(self.engine.rows['e' * 64]['State']['Running'])
        self.assertTrue(self.adoption.identity.exists())
    def test_lost_rollback_original_start_never_replays_later_identity(self):
        self.apply(); self.engine.lost = 'start'
        with self.assertRaises(RuntimeError): self.adoption.rollback(self.adoption.read())
        old = self.root / 'traefik/shared/acme.json'; old.write_bytes(b'new writes after original resumed')
        calls = len(self.engine.calls)
        self.adoption.rollback(self.adoption.read())
        self.assertEqual(calls, len(self.engine.calls))
        self.assertEqual(b'new writes after original resumed', old.read_bytes())
    def test_lost_rollback_disable_reply_recovers_exact_intent(self):
        self.apply(); self.engine.lost = 'update'
        with self.assertRaises(RuntimeError): self.adoption.rollback(self.adoption.read())
        self.adoption.rollback(self.adoption.read())
        self.assertTrue(self.engine.rows['a' * 64]['State']['Running'])
    def test_new_identity_divergence_never_rolls_back_to_stale_original(self):
        self.apply(); (self.adoption.identity / 'acme.json').write_bytes(b'new ACME identity')
        before = len(self.engine.calls)
        with self.assertRaisesRegex(ValueError, 'NEVER restart'): self.adoption.rollback(self.adoption.read())
        self.assertEqual(before, len(self.engine.calls))
        self.assertFalse(self.engine.rows['a' * 64]['State']['Running'])
        self.assertTrue(self.engine.rows['e' * 64]['State']['Running'])
    def test_divergence_after_stop_can_only_forward_with_new_exact_approval(self):
        self.apply(); original = self.engine.change
        def change(arguments):
            original(arguments)
            if arguments[0] == 'stop' and arguments[-1] == 'e' * 64:
                (self.adoption.identity / 'acme.json').write_bytes(b'newer live identity')
        self.engine.change = change
        with self.assertRaises(ValueError): self.adoption.rollback(self.adoption.read())
        record = self.adoption.read()
        with self.assertRaisesRegex(ValueError, 'rollback has begun'): self.adoption.resume(record)
        plan = self.adoption.reconciliation_plan(record)
        with self.assertRaises(ValueError): self.adoption.forward(record, '0' * 64)
        self.adoption.forward(record, M.digest(plan))
        self.assertEqual(b'newer live identity', (self.adoption.identity / 'acme.json').read_bytes())
        self.assertTrue(self.engine.rows['e' * 64]['State']['Running'])
        self.assertFalse(self.engine.rows['a' * 64]['State']['Running'])
    def test_created_network_id_requires_fresh_daemon_network_identity(self):
        record = self.approve(); self.engine.lost = 'create'
        with self.assertRaises(RuntimeError): self.adoption.resume(record)
        self.engine.rows['e' * 64]['NetworkSettings']['Networks']['core']['NetworkID'] = ''
        network = self.engine.engine
        with mock.patch.object(self.engine, 'engine', side_effect=lambda method, route, body=None:
                M.P.canonical({'Id': 'f' * 64}) if method == 'GET' else network(method, route, body)):
            with self.assertRaisesRegex(ValueError, 'intended proxy network generation changed'):
                self.adoption.resume(self.adoption.read())
        self.adoption.lookup_target(self.adoption.read())
        self.engine.rows['e' * 64]['State'].update(Status='exited', StartedAt=started())
        with self.assertRaisesRegex(ValueError, 'network generation changed'):
            self.adoption.lookup_target(self.adoption.read())

    def test_original_and_target_intents_preserve_config_and_network_aliases(self):
        record = self.approve()
        body = record['plan']['body']
        self.assertEqual(['A=B'], body['Env'])
        self.assertEqual(['proxy'], body['NetworkingConfig']['EndpointsConfig']['core']['Aliases'])
        self.assertEqual(record['plan']['proxy']['HostConfig']['RestartPolicy'], body['HostConfig']['RestartPolicy'])
        self.adoption.resume(record)
        self.engine.rows['e' * 64]['NetworkSettings']['Networks']['core']['Aliases'].append('injected')
        with self.assertRaisesRegex(ValueError, 'aliases changed'):
            M.verified_authority(self.root, 'local', self.engine.inspect('e' * 64), self.engine)
    def test_proxy_identity_and_runtime_observation_use_approved_authority(self):
        self.apply()
        identity = M.load('orbis-proxy-identity.py', 'proxy_identity_integration_test')
        with mock.patch.object(identity.A, 'LAYOUT', M.L), mock.patch.object(identity, 'adoption_module', return_value=SimpleNamespace(
                execution_path=M.execution_path,
                verified_authority=lambda root, context, proxy, runtime=None: M.verified_authority(root, context, proxy, self.engine))):
            proxy = self.engine.inspect('e' * 64)
            descriptor = identity.observe(self.root, 'local', proxy)
            self.assertEqual('orbis.proxy-host-identity-policy.v1', descriptor['schema'])
            self.assertEqual({'destination', 'readOnly', 'staticSha256', 'capture', 'restore'}, set(descriptor['configuration']))
            self.assertNotIn(str(self.root), M.P.canonical(descriptor).decode())
            load = M.D.load
            with mock.patch.object(M.D, 'load', side_effect=lambda name, key: identity if name == 'orbis-proxy-identity.py' else load(name, key)):
                self.assertEqual(descriptor['configuration']['staticSha256'], M.D.DockerRestoreRuntime.proxy_static_digest(self.engine, proxy))
                self.assertEqual('orbis.controller-overlay-preserve-live-proxy.v1', M.D.DockerRestoreRuntime.controller_proxy_policy(self.engine, proxy)['schema'])
    def test_immutable_receipt_cannot_be_replaced_by_reverify(self):
        self.apply(); receipt = self.adoption.directory / 'identity.json'
        receipt.write_bytes(b'{}')
        with self.assertRaisesRegex(ValueError, 'immutable proxy identity receipt differs'):
            self.adoption.verify(self.adoption.read())
    def test_static_ctime_after_start_rejected(self):
        self.apply(); self.engine.rows['e' * 64]['State']['StartedAt'] = '2020-01-01T00:00:00Z'
        with self.assertRaisesRegex(ValueError, 'after reviewed proxy start'): M.verified_authority(self.root, 'local', self.engine.inspect('e' * 64), self.engine)
    def test_execution_copy_pins_dynamic_bytes_and_excludes_shared(self):
        dynamic = self.root / 'traefik/dynamic'; dynamic.mkdir()
        (dynamic / 'routes.yml').write_bytes(b'http: {}\n')
        self.apply()
        execution = M.execution_path(self.root)
        self.assertEqual(b'http: {}\n', (execution / 'dynamic/routes.yml').read_bytes())
        self.assertFalse((execution / 'shared').exists())
        self.assertEqual(str(execution), next(m['Source'] for m in self.engine.rows['e' * 64]['Mounts'] if m['Destination'] == '/etc/traefik'))
        for path in [execution, execution / 'dynamic', execution / 'traefik.yml', execution / 'dynamic/routes.yml']:
            self.assertEqual(0o700 if path.is_dir() else 0o600, path.stat().st_mode & 0o777)
        (self.root / 'traefik/traefik.yml').write_bytes(b'new writable source bytes')
        M.verified_authority(self.root, 'local', self.engine.inspect('e' * 64), self.engine)
        self.assertNotEqual((self.root / 'traefik/traefik.yml').read_bytes(), (execution / 'traefik.yml').read_bytes())
        with self.assertRaisesRegex(ValueError, 'original configuration changed'):
            self.adoption.rollback(self.adoption.read())

    def test_unapproved_dynamic_change_before_copy_holds_without_stopping_proxy(self):
        dynamic = self.root / 'traefik/dynamic.yml'; dynamic.write_bytes(b'approved dynamic')
        record = self.approve()
        dynamic.write_bytes(b'unapproved dynamic')
        with self.assertRaisesRegex(ValueError, 'source configuration changed'):
            self.adoption.resume(record)
        self.assertEqual([], self.engine.calls)
        self.assertTrue(self.engine.rows['a' * 64]['State']['Running'])

    def test_writable_execution_alias_and_parent_exposure_are_rejected(self):
        self.apply()
        controller = self.engine.rows['d' * 64]
        controller['Mounts'].append({'Type': 'bind', 'Source': str(M.execution_path(self.root)), 'Destination': '/alias', 'RW': True})
        with self.assertRaisesRegex(ValueError, 'protected enrollment'):
            M.verified_authority(self.root, 'local', self.engine.inspect('e' * 64), self.engine)
        controller['Mounts'][-1].update(Source=str(self.adoption.directory), Destination='/data/traefik', RW=False)
        with self.assertRaisesRegex(ValueError, 'protected enrollment'):
            M.verified_authority(self.root, 'local', self.engine.inspect('e' * 64), self.engine)

    def test_interrupted_execution_copy_retains_partial_and_resumes_approved_bytes(self):
        record = self.approve(); path = M.execution_path(self.root); path.mkdir(mode=0o700)
        (path / 'traefik.yml').write_bytes(b'partial approved file')
        (path / 'traefik.yml').chmod(0o600)
        record.update(intent='copy-execution', executionCopyEntry='traefik.yml'); self.adoption.save(record)
        self.adoption.resume(self.adoption.read())
        retained = list(self.adoption.directory.glob('copy-partial-execution-*'))
        self.assertEqual(1, len(retained)); self.assertEqual(b'partial approved file', retained[0].read_bytes())
        self.assertEqual(record['plan']['static']['sha256'], hashlib.sha256((path / 'traefik.yml').read_bytes()).hexdigest())
        M.verified_authority(self.root, 'local', self.engine.inspect('e' * 64), self.engine)

    def test_writable_original_cannot_reauthorize_modified_private_execution(self):
        self.apply(); source = self.root / 'traefik/traefik.yml'; execution = M.execution_path(self.root) / 'traefik.yml'
        source.write_bytes(b'same unapproved replacement'); execution.write_bytes(source.read_bytes())
        with self.assertRaisesRegex(ValueError, 'approved bytes'):
            M.verified_authority(self.root, 'local', self.engine.inspect('e' * 64), self.engine)

    def test_dynamic_execution_corruption_is_rejected_even_when_static_unchanged(self):
        dynamic = self.root / 'traefik/dynamic'; dynamic.mkdir(); (dynamic / 'routes.yml').write_bytes(b'approved routes')
        self.apply(); (M.execution_path(self.root) / 'dynamic/routes.yml').write_bytes(b'unapproved routes')
        with self.assertRaisesRegex(ValueError, 'approved bytes'):
            M.verified_authority(self.root, 'local', self.engine.inspect('e' * 64), self.engine)

    def test_source_late_acme_write_needs_post_quiescence_approval(self):
        record = self.approve(); change = self.engine.change
        old = self.root / 'traefik/shared/acme.json'
        def stop_with_write(arguments):
            change(arguments)
            if arguments[0] == 'stop' and arguments[-1] == 'a' * 64:
                old.write_bytes(b'late source ACME renewal')
        self.engine.change = stop_with_write
        with self.assertRaisesRegex(ValueError, 'source identity changed at quiescence'):
            self.adoption.resume(record)
        self.assertFalse(self.adoption.identity.exists())
        self.assertFalse(self.engine.rows['a' * 64]['State']['Running'])
        record = self.adoption.read(); plan = self.adoption.reconciliation_plan(record)
        self.assertEqual('orbis.proxy-adoption-quiescent-plan.v1', plan['schema'])
        with self.assertRaises(ValueError): self.adoption.forward(record, '0' * 64)
        self.adoption.forward(record, M.digest(plan))
        self.assertEqual(old.read_bytes(), (self.adoption.identity / 'acme.json').read_bytes())
        self.adoption.rollback(self.adoption.read())
        self.assertEqual(b'late source ACME renewal', old.read_bytes())
        self.assertTrue(self.engine.rows['a' * 64]['State']['Running'])

    def test_fresh_quiescent_approval_refuses_later_identity_drift(self):
        record = self.approve(); self.engine.lost = 'stop'
        with self.assertRaises(RuntimeError): self.adoption.resume(record)
        old = self.root / 'traefik/shared/acme.json'; old.write_bytes(b'late source renewal')
        with self.assertRaises(ValueError): self.adoption.resume(self.adoption.read())
        record = self.adoption.read(); plan = self.adoption.reconciliation_plan(record)
        old.write_bytes(b'even later renewal')
        with self.assertRaisesRegex(ValueError, 'fresh forward-reconciliation approval'):
            self.adoption.forward(record, M.digest(plan))
        self.assertFalse(self.adoption.identity.exists())

    def test_rollback_disables_restart_before_stop(self):
        self.apply(); before = len(self.engine.calls)
        self.adoption.rollback(self.adoption.read())
        calls = self.engine.calls[before:]
        disable = next(i for i, call in enumerate(calls) if call == ('update', '--restart=no', 'e' * 64))
        stop = next(i for i, call in enumerate(calls) if call[0] == 'stop')
        self.assertLess(disable, stop)

    def test_lost_create_cannot_adopt_foreign_target(self):
        record = self.approve(); self.engine.lost = 'create'
        with self.assertRaises(RuntimeError): self.adoption.resume(record)
        self.engine.rows['e' * 64]['Config']['Env'] = ['INJECTED=yes']
        with self.assertRaises(ValueError): self.adoption.resume(self.adoption.read())


if __name__ == '__main__': unittest.main()
