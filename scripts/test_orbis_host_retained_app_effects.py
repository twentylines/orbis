import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock
import uuid


def load(filename, name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


M = load('orbis-host-retained-app-effects.py', 'retained_app_effects_test')
F = load('test_orbis_host_app_create_intent.py', 'retained_app_effects_actual_fixture')
A = load('orbis-host-retained-authority.py', 'retained_app_effects_test_authority')
C = load('orbis-host-capture-authority.py', 'retained_app_effects_test_capture')
# Explicit test-only owner policy substitution, preserving actual protected IO.
A.OWNER = os.getuid()
C.AUTHORITY = A
STORAGE = SimpleNamespace(protected_directory=A.protected_directory, protected_file=A.protected_file,
                          atomic=A.atomic, immutable=C.immutable, owner=os.getuid())
ZERO = '0001-01-01T00:00:00Z'


class LostReply(RuntimeError): pass


class Engine:
    def __init__(self, directory, values):
        self.directory, self.values = directory, values
        self.objects, self.events, self.counter = {}, [], 0
        self.lose, self.before_create = None, False
        self.after = None

    def event(self, method, identity=None):
        progress = json.loads((self.directory / 'progress.json').read_bytes())
        self.events.append((method, identity, progress))

    def inspect(self, identity):
        self.event('inspect', identity)
        if self.after: self.after('inspect')
        return copy.deepcopy(self.objects.get(identity))

    def find_name(self, name):
        self.event('find_name', name)
        matches = [raw for raw in self.objects.values() if raw['Name'] == '/' + name]
        if len(matches) > 1: raise ValueError('fake daemon name collision')
        return copy.deepcopy(matches[0]) if matches else None

    def create(self, name, body):
        self.event('create', name)
        if self.before_create: raise LostReply('request completion unknown')
        if any(raw['Name'] == '/' + name for raw in self.objects.values()): raise ValueError('name conflict')
        self.counter += 1; identity = format(self.counter + 100, '064x')
        ordinal = int(body['Labels']['com.docker.compose.container-number'])
        values = self.values[ordinal - 1]
        compiled = {'name': name, 'body': copy.deepcopy(body),
                    'networkIds': {key: endpoint['NetworkID'] for key, endpoint in body['NetworkingConfig']['EndpointsConfig'].items()}}
        raw = F.created(values, compiled, False); raw['Id'] = identity
        for mount in raw['Mounts']:
            for structured in body['HostConfig'].get('Mounts') or []:
                if structured['Target'] == mount['Destination']: mount['Source'] = structured['Source']
            for bind in body['HostConfig'].get('Binds') or []:
                parts = bind.split(':')
                if parts[1] == mount['Destination']: mount['Source'] = parts[0]
        raw['State'].update(Paused=False, Restarting=False, Status='created', StartedAt=ZERO, FinishedAt=ZERO)
        for endpoint in raw['NetworkSettings']['Networks'].values(): endpoint['NetworkID'] = ''; endpoint['EndpointID'] = ''
        self.objects[identity] = raw
        if self.after: self.after('create')
        if self.lose == 'create': self.lose = None; raise LostReply('lost create reply')
        return identity

    def start(self, identity):
        self.event('start', identity)
        raw = self.objects[identity]
        raw['State'].update(Running=True, Status='running', StartedAt='2026-11-02T00:00:00Z')
        raw['NetworkSettings']['Ports'] = copy.deepcopy(raw['HostConfig']['PortBindings'])
        for name, endpoint in raw['NetworkSettings']['Networks'].items():
            endpoint['NetworkID'] = ('c' if name == 'whoami_demo_default' else 'd') * 64
            endpoint['EndpointID'] = 'e' * 64
        if self.after: self.after('start')
        if self.lose == 'start': self.lose = None; raise LostReply('lost start reply')

    def remove(self, identity):
        self.event('remove', identity)
        raw = self.objects[identity]
        if raw['State']['Running']: raise ValueError('non-force removal refused')
        del self.objects[identity]
        if self.after: self.after('remove')
        if self.lose == 'remove': self.lose = None; raise LostReply('lost remove reply')


class EffectsTests(unittest.TestCase):
    def setUp(self):
        # tempfile's public /tmp ancestors deliberately do not satisfy root policy.
        self.temp = tempfile.TemporaryDirectory(prefix='.app-effects-test-', dir=Path(__file__).parent)
        self.path = Path(self.temp.name); os.chmod(self.path, 0o700)
        self.values = [F.fixture(1, True), F.fixture(2, False)]
        self.plans = [{'appUrn': value[0]['appUrn'], 'service': value[0]['service'], 'ordinal': value[0]['ordinal'],
                       'sourceId': value[0]['inspect']['Id'], 'wasRunning': value[0]['wasRunning'],
                       'compiled': F.compile_fixture(value)} for value in self.values]
        self.destinations = []
        for index, value in enumerate(self.values):
            raw = F.created(value, self.plans[index]['compiled'], False)
            raw['Id'] = ('e' if index == 0 else 'f') * 64
            raw['State'].update(Paused=False, Restarting=False, Status='exited', StartedAt='2026-10-01T00:00:00Z', FinishedAt='2026-11-01T00:00:00Z')
            self.destinations.append(raw)
        self.engine = Engine(self.path, self.values)
        self.engine.objects = {raw['Id']: copy.deepcopy(raw) for raw in self.destinations}
        self.decision, self.deadline, self.allowed = 'NONE', int(time.time()) + 600, True
        self.auth_events, self.port_checks, self.destination_checks = [], 0, []
        self.kwargs = dict(restore_id='11111111-1111-4111-8111-111111111111', point_id='22222222-2222-4222-8222-222222222222',
                           operation_sha256='a' * 64, authority_sha256='b' * 64, plans=self.plans, destinations=self.destinations,
                           engine=self.engine, comparator=F.comparator(self.values[0][1]), verify_destination=self.destination,
                           verify_ports=self.ports, authorize=self.authorize, storage=STORAGE)
        self.driver = self.new_driver()

    def tearDown(self): self.temp.cleanup()

    def new_driver(self): return M.RetainedAppEffects(self.path, **self.kwargs)

    def authorize(self, scope, action):
        self.auth_events.append((copy.deepcopy(scope), action))
        if not self.allowed: raise ValueError('root authority revoked')
        return {'decision': self.decision, 'deadline': self.deadline}

    def destination(self, original, current):
        self.destination_checks.append(current['Id'])
        return original == current

    def ports(self, plans, destinations):
        self.port_checks += 1
        self.assertEqual(plans, self.plans); self.assertEqual(destinations, self.destinations)
        return True

    def probe_commit(self):
        self.driver.probe(); self.driver.preflight(); self.decision = 'COMMIT'

    def read(self): return json.loads((self.path / 'progress.json').read_bytes())

    def recovery_authorize(self, scope, action):
        if action != 'recover-lease': return self.authorize(scope, action)
        self.auth_events.append((copy.deepcopy(scope), action))
        if not self.allowed: raise ValueError('root authority revoked')
        original = copy.deepcopy(scope); context = original.pop('recoveryLease')
        self.assertEqual(original, self.driver.scope)
        self.assertEqual(set(context), {'grantId', 'predecessorDeadline'})
        grant = self.grants.get(context['grantId'])
        if (grant is None or not grant['quiesced'] or context['predecessorDeadline'] != grant['predecessorDeadline']):
            raise ValueError('root has no exact durable quiesced recovery grant')
        return {'decision': self.decision, 'deadline': grant['deadline']}

    def grant_recovery(self, predecessor=None, grant_id='33333333-3333-4333-8333-333333333333'):
        predecessor = self.read()['deadline'] if predecessor is None else predecessor
        if not hasattr(self, 'grants'): self.grants = {}
        self.grants[grant_id] = {'predecessorDeadline': predecessor, 'deadline': predecessor + 600, 'quiesced': True}
        self.deadline = predecessor + 600
        self.kwargs['authorize'] = self.recovery_authorize
        self.driver = self.new_driver()
        return predecessor, grant_id

    def test_expired_precommit_lease_requires_explicit_root_grant_before_probe_cleanup(self):
        self.engine.lose = 'create'
        with self.assertRaises(LostReply): self.driver.probe()
        predecessor = self.read()['deadline']; self.decision = 'ROLLBACK'
        with mock.patch.object(M.time, 'time', return_value=predecessor + 1):
            with self.assertRaises(ValueError): self.driver.cleanup_probes()
            _, grant = self.grant_recovery()
            before = len(self.engine.events)
            self.driver.recover_lease(grant, predecessor_deadline=predecessor)
            self.assertEqual(len(self.engine.events), before)
            result = self.driver.cleanup_probes()
        self.assertEqual(result['probesRemoved'], 1)
        self.assertEqual(set(self.engine.objects), {raw['Id'] for raw in self.destinations})
        state = self.read(); self.assertEqual(state['version'], 2)
        self.assertEqual(state['initialDeadline'], predecessor)
        self.assertEqual(state['leaseHistory'], [{'grantId': grant, 'predecessorDeadline': predecessor,
                                               'deadline': predecessor + 600, 'decision': 'ROLLBACK'}])

    def test_expired_postcommit_forward_recovery_preserves_application_writes(self):
        self.probe_commit(); self.engine.lose = 'start'
        with self.assertRaises(LostReply): self.driver.activate()
        data = self.path / 'app-data'; data.write_text('committed application writes')
        predecessor, grant = self.grant_recovery()
        with mock.patch.object(M.time, 'time', return_value=predecessor + 1):
            with self.assertRaises(ValueError): self.driver.activate()
            self.driver.recover_lease(grant, predecessor_deadline=predecessor)
            self.driver.activate(); self.driver.verify()
        self.assertEqual(data.read_text(), 'committed application writes')
        self.assertEqual(len([event for event in self.engine.events if event[0] == 'start']), 1)

    def test_recovery_refuses_live_predecessor_and_never_calls_engine(self):
        self.driver.preflight(); predecessor, grant = self.grant_recovery()
        before = (self.path / 'progress.json').read_bytes(); events = len(self.engine.events)
        with self.assertRaises(ValueError): self.driver.recover_lease(grant, predecessor_deadline=predecessor)
        self.assertEqual((self.path / 'progress.json').read_bytes(), before)
        self.assertEqual(len(self.engine.events), events)

    def test_recovery_requires_independently_durable_quiesced_exact_root_grant(self):
        self.driver.preflight(); predecessor, grant = self.grant_recovery()
        before = (self.path / 'progress.json').read_bytes()
        with mock.patch.object(M.time, 'time', return_value=predecessor + 1):
            self.grants[grant]['quiesced'] = False
            with self.assertRaises(ValueError): self.driver.recover_lease(grant, predecessor_deadline=predecessor)
            self.grants[grant]['quiesced'] = True
            with self.assertRaises(ValueError): self.driver.recover_lease('44444444-4444-4444-8444-444444444444', predecessor_deadline=predecessor)
        self.assertEqual((self.path / 'progress.json').read_bytes(), before)

    def test_recovery_deadline_is_fresh_bounded_integer_and_not_ordinary_renewal(self):
        self.driver.preflight(); predecessor, grant = self.grant_recovery()
        before = (self.path / 'progress.json').read_bytes()
        with mock.patch.object(M.time, 'time', return_value=predecessor + 1):
            with self.assertRaises(ValueError): self.driver.status()
            for deadline in (predecessor, predecessor + 902, float(predecessor + 600), True):
                self.grants[grant]['deadline'] = deadline
                with self.subTest(deadline=deadline), self.assertRaises(ValueError):
                    self.driver.recover_lease(grant, predecessor_deadline=predecessor)
        self.assertEqual((self.path / 'progress.json').read_bytes(), before)

    def test_recovery_requires_existing_definition_progress_and_lock(self):
        self.driver.preflight(); predecessor, grant = self.grant_recovery()
        with mock.patch.object(M.time, 'time', return_value=predecessor + 1):
            for name in ('definition.json', 'progress.json', 'effects.lock'):
                path = self.path / name; body = path.read_bytes(); path.unlink()
                with self.subTest(name=name), self.assertRaises(FileNotFoundError):
                    self.driver.recover_lease(grant, predecessor_deadline=predecessor)
                path.write_bytes(body); path.chmod(0o600)

    def test_latest_recovery_grant_is_idempotent_and_previous_grants_cannot_replay(self):
        self.driver.preflight(); predecessor, first = self.grant_recovery()
        with mock.patch.object(M.time, 'time', return_value=predecessor + 1):
            self.driver.recover_lease(first, predecessor_deadline=predecessor)
            before = (self.path / 'progress.json').read_bytes()
            self.new_driver().recover_lease(first, predecessor_deadline=predecessor)
            self.assertEqual((self.path / 'progress.json').read_bytes(), before)
        second_predecessor, second = self.grant_recovery(grant_id='44444444-4444-4444-8444-444444444444')
        with mock.patch.object(M.time, 'time', return_value=second_predecessor + 1):
            self.driver.recover_lease(second, predecessor_deadline=second_predecessor)
            with self.assertRaises(ValueError): self.driver.recover_lease(first, predecessor_deadline=predecessor)
        self.assertEqual(len(self.read()['leaseHistory']), 2)
        self.assertEqual(self.read()['initialDeadline'], predecessor)

    def test_recovery_progress_write_is_durable_before_reply_and_lost_ack_reconciles(self):
        self.driver.preflight(); predecessor, grant = self.grant_recovery()
        original = self.driver.store.atomic
        def lose_reply(path, body): original(path, body); raise OSError('crash after fsync')
        with mock.patch.object(M.time, 'time', return_value=predecessor + 1):
            with mock.patch.object(self.driver.store, 'atomic', side_effect=lose_reply):
                with self.assertRaises(OSError): self.driver.recover_lease(grant, predecessor_deadline=predecessor)
            self.assertEqual(self.read()['leaseHistory'][0]['grantId'], grant)
            self.new_driver().recover_lease(grant, predecessor_deadline=predecessor)
            self.new_driver().status()
        self.assertEqual(len(self.read()['leaseHistory']), 1)

    def test_recovery_history_chain_rejects_tampering_and_terminal_decision_regression(self):
        self.driver.preflight(); self.decision = 'COMMIT'; predecessor, grant = self.grant_recovery()
        with mock.patch.object(M.time, 'time', return_value=predecessor + 1):
            self.driver.recover_lease(grant, predecessor_deadline=predecessor)
        state = self.read(); pristine = copy.deepcopy(state)
        variants = [lambda s: s['leaseHistory'][0].update(predecessorDeadline=predecessor - 1),
                    lambda s: s.update(deadline=s['deadline'] + 1),
                    lambda s: s['leaseHistory'][0].update(grantId='bad'),
                    lambda s: s['leaseHistory'][0].update(unexpected=True)]
        with mock.patch.object(M.time, 'time', return_value=predecessor + 2):
            for index, change in enumerate(variants):
                state = copy.deepcopy(pristine); change(state)
                (self.path / 'progress.json').write_bytes(M.canonical(state))
                with self.subTest(index=index), self.assertRaises(ValueError): self.new_driver().status()
        (self.path / 'progress.json').write_bytes(M.canonical(pristine))
        second_predecessor, second = self.grant_recovery(grant_id='44444444-4444-4444-8444-444444444444')
        self.decision = 'ROLLBACK'
        with mock.patch.object(M.time, 'time', return_value=second_predecessor + 1):
            with self.assertRaises(ValueError): self.driver.recover_lease(second, predecessor_deadline=second_predecessor)
        self.assertEqual(len(self.read()['leaseHistory']), 1)

    def test_recovery_history_is_bounded_without_pruning_prior_evidence(self):
        self.driver.preflight(); state = self.read(); original_deadline = state['deadline']
        state.update(version=2, initialDeadline=original_deadline, leaseHistory=[])
        for index in range(64):
            state['leaseHistory'].append({'grantId': str(uuid.UUID(int=index + 1, version=4)),
                                         'predecessorDeadline': original_deadline + index,
                                         'deadline': original_deadline + index + 1, 'decision': 'NONE'})
        state['deadline'] = original_deadline + 64
        (self.path / 'progress.json').write_bytes(M.canonical(state))
        predecessor, grant = self.grant_recovery(); before = (self.path / 'progress.json').read_bytes()
        with mock.patch.object(M.time, 'time', return_value=predecessor + 1):
            with self.assertRaises(ValueError): self.driver.recover_lease(grant, predecessor_deadline=predecessor)
        self.assertEqual((self.path / 'progress.json').read_bytes(), before)

    def test_recovery_action_alone_cannot_authorize_before_origin_scope_or_grant_match(self):
        self.driver.preflight(); predecessor, grant = self.grant_recovery()
        self.kwargs['authority_sha256'] = 'c' * 64; forged = self.new_driver()
        with mock.patch.object(M.time, 'time', return_value=predecessor + 1):
            with self.assertRaises(AssertionError): forged.recover_lease(grant, predecessor_deadline=predecessor)
        self.assertEqual(self.read()['version'], 1)

    def test_full_mixed_replicas_preserve_requests_and_start_only_running_history(self):
        original = copy.deepcopy(self.plans)
        self.probe_commit(); result = self.driver.activate()
        self.assertEqual(result['desiredCreated'], 2); self.assertEqual(result['desiredStarted'], 1)
        self.assertEqual(result['destinationsRemoved'], 2); self.assertEqual(result['probesRemoved'], 2)
        self.assertEqual(self.plans, original); self.assertEqual(len(self.engine.objects), 2)
        self.assertEqual([self.engine.objects[row['id']]['State']['Running'] for row in self.read()['desired']], [True, False])
        self.assertEqual(self.driver.verify(), result)

    def test_intents_are_durable_before_every_create_remove_and_start(self):
        self.probe_commit(); self.driver.activate()
        for method, identity, state in self.engine.events:
            if method == 'create':
                kind = 'probes' if '-app-probe-' in identity else 'desired'
                self.assertTrue(any(row['createIntent'] and row['id'] is None for row in state[kind]))
            if method == 'remove':
                rows = state['probes'] + [dict(row, id=raw['Id']) for row, raw in zip(state['destinations'], self.destinations)]
                self.assertTrue(any(row['id'] == identity and row['removeIntent'] for row in rows))
            if method == 'start':
                self.assertTrue(all(row['id'] is not None for row in state['desired']))
                self.assertTrue(any(row['id'] == identity and row['startIntent'] for row in state['desired']))

    def test_returned_id_is_saved_before_configuration_comparison(self):
        def bad(raw, body): raise ValueError('comparison failed')
        self.driver.comparator = bad
        with self.assertRaises(ValueError): self.driver.probe()
        row = self.read()['probes'][0]
        self.assertIn(row['id'], self.engine.objects); self.assertTrue(row['createIntent'])
        self.assertFalse(row['removeIntent'])

    def test_lost_probe_create_reply_reconciles_exact_never_started_name(self):
        self.engine.lose = 'create'
        with self.assertRaises(LostReply): self.driver.probe()
        self.assertIsNone(self.read()['probes'][0]['id'])
        self.driver = self.new_driver(); self.driver.probe()
        self.assertEqual(len([item for item in self.engine.events if item[0] == 'create']), 2)
        self.assertEqual(self.read()['probes'][0]['removed'], True)

    def test_ambiguous_create_without_visible_object_never_reissues(self):
        self.engine.before_create = True
        with self.assertRaises(LostReply): self.driver.probe()
        self.engine.before_create = False
        with self.assertRaises(ValueError): self.new_driver().probe()
        self.assertEqual(len([event for event in self.engine.events if event[0] == 'create']), 1)

    def test_late_create_completion_can_only_reconcile_fixed_name_and_request(self):
        self.engine.before_create = True
        with self.assertRaises(LostReply): self.driver.probe()
        self.engine.before_create = False
        compiled = self.driver._compiled(0, True)
        self.engine.create(compiled['name'], compiled['body'])
        self.new_driver().cleanup_probes()
        self.assertFalse(any('-app-probe-' in raw['Name'] for raw in self.engine.objects.values()))

    def test_lost_probe_remove_reply_is_reconciled_without_second_remove(self):
        self.engine.lose = 'remove'
        with self.assertRaises(LostReply): self.driver.probe()
        removed_id = self.read()['probes'][0]['id']
        self.new_driver().probe()
        self.assertEqual(len([event for event in self.engine.events if event[:2] == ('remove', removed_id)]), 1)

    def test_precommit_rollback_cleanup_removes_only_never_started_probes(self):
        self.engine.lose = 'create'
        with self.assertRaises(LostReply): self.driver.probe()
        self.decision = 'ROLLBACK'; result = self.new_driver().cleanup_probes()
        self.assertEqual(result['probesRemoved'], 1)
        self.assertEqual(set(self.engine.objects), {raw['Id'] for raw in self.destinations})
        self.assertFalse(any(event[0] == 'start' for event in self.engine.events))

    def test_lost_retirement_remove_reply_reconciles_only_prior_intent(self):
        self.probe_commit(); self.engine.lose = 'remove'
        with self.assertRaises(LostReply): self.driver.activate()
        self.new_driver().activate()
        self.assertEqual(len([event for event in self.engine.events if event[:2] == ('remove', self.destinations[0]['Id'])]), 1)

    def test_missing_destination_without_remove_intent_is_rejected(self):
        self.probe_commit(); del self.engine.objects[self.destinations[0]['Id']]
        with self.assertRaises(ValueError): self.driver.activate()
        self.assertFalse(any(event[0] == 'create' and '-app-probe-' not in event[1] for event in self.engine.events))

    def test_lost_desired_create_reply_reconciles_across_process_restart(self):
        self.probe_commit(); self.engine.lose = 'create'
        with self.assertRaises(LostReply): self.driver.activate()
        self.new_driver().activate()
        self.assertEqual(len([event for event in self.engine.events if event[0] == 'create' and '-app-probe-' not in event[1]]), 2)

    def test_lost_start_reply_reconciles_running_exact_id_without_start_retry(self):
        self.probe_commit(); self.engine.lose = 'start'
        with self.assertRaises(LostReply): self.driver.activate()
        self.new_driver().activate()
        self.assertEqual(len([event for event in self.engine.events if event[0] == 'start']), 1)

    def test_no_activation_before_commit_and_no_rollback_after_commit(self):
        self.driver.probe()
        with self.assertRaises(ValueError): self.driver.activate()
        self.decision = 'COMMIT'
        with self.assertRaises(ValueError): self.driver.cleanup_probes()
        self.driver.activate()
        self.decision = 'ROLLBACK'
        with self.assertRaises(ValueError): self.driver.activate()

    def test_activation_requires_all_probes_removed(self):
        self.driver.preflight(); self.decision = 'COMMIT'
        with self.assertRaises(ValueError): self.driver.activate()
        self.assertFalse(any(event[0] in {'remove', 'create', 'start'} for event in self.engine.events))

    def test_port_conflict_refused_before_probe_effects(self):
        self.driver.verify_ports = lambda *_: False
        with self.assertRaises(ValueError): self.driver.probe()
        self.assertFalse(any(event[0] in {'remove', 'create', 'start'} for event in self.engine.events))
        self.assertEqual(set(self.engine.objects), {raw['Id'] for raw in self.destinations})

    def test_port_check_is_fresh_after_probes_and_immediately_before_commit(self):
        self.driver.probe(); self.assertEqual(self.port_checks, 2)
        self.driver.verify_ports = lambda *_: False
        with self.assertRaises(ValueError): self.driver.preflight()

    def test_only_independently_pinned_retirement_ids_are_permitted_name_conflicts(self):
        original = self.destinations[0]
        fake = copy.deepcopy(original); fake['Id'] = '9' * 64
        self.engine.objects[fake['Id']] = fake; self.engine.objects[original['Id']]['Name'] = '/different'
        with self.assertRaises(ValueError): self.driver.probe()
        self.assertFalse(any(event[0] == 'remove' for event in self.engine.events))

    def test_independent_full_destination_verifier_is_required_on_every_retirement(self):
        self.probe_commit(); self.engine.objects[self.destinations[0]['Id']]['Config']['Env'].append('CHANGED=1')
        with self.assertRaises(ValueError): self.driver.activate()
        self.assertIn(self.destinations[0]['Id'], self.engine.objects)

    def test_running_paused_and_restarting_destinations_are_refused(self):
        for field in ('Running', 'Paused', 'Restarting'):
            self.engine.objects = {raw['Id']: copy.deepcopy(raw) for raw in self.destinations}
            self.engine.objects[self.destinations[0]['Id']]['State'][field] = True
            self.driver.verify_destination = lambda *_: True
            with self.subTest(field=field), self.assertRaises(ValueError): self.driver.preflight()

    def test_lost_probe_reply_with_wrong_full_object_never_deletes_collision(self):
        self.engine.lose = 'create'
        with self.assertRaises(LostReply): self.driver.probe()
        identity = next(key for key in self.engine.objects if key not in {raw['Id'] for raw in self.destinations})
        pristine = copy.deepcopy(self.engine.objects[identity])
        changes = [lambda raw: raw.update(Name='/other'), lambda raw: raw.update(Image='sha256:' + '8' * 64),
                   lambda raw: raw['Config'].update(Cmd=['changed']),
                   lambda raw: raw['Mounts'][0].update(Source='/changed'),
                   lambda raw: raw['NetworkSettings']['Networks']['shared'].update(NetworkID='8' * 64),
                   lambda raw: raw['HostConfig']['PortBindings']['8080/tcp'][0].update(HostPort='18081'),
                   lambda raw: raw['State'].update(StartedAt='2026-11-02T00:00:00Z'),
                   lambda raw: raw['State'].update(Running=True)]
        for index, change in enumerate(changes):
            self.engine.objects[identity] = copy.deepcopy(pristine); change(self.engine.objects[identity])
            with self.subTest(change=index), self.assertRaises(ValueError): self.new_driver().cleanup_probes()
            self.assertIn(identity, self.engine.objects)

    def test_extra_fixed_probe_object_without_durable_intent_fails_closed(self):
        self.driver.preflight(); compiled = self.driver._compiled(0, True)
        identity = self.engine.create(compiled['name'], compiled['body'])
        with self.assertRaises(ValueError): self.driver.cleanup_probes()
        self.assertIn(identity, self.engine.objects)

    def test_completed_probe_name_reappearance_is_never_adopted_or_deleted(self):
        self.driver.probe(); compiled = self.driver._compiled(0, True)
        identity = self.engine.create(compiled['name'], compiled['body'])
        with self.assertRaises(ValueError): self.driver.cleanup_probes()
        self.assertIn(identity, self.engine.objects)

    def test_decision_drift_during_engine_boundary_stops_further_effects(self):
        def change(method):
            if method == 'create': self.decision = 'COMMIT'
        self.engine.after = change
        with self.assertRaises(ValueError): self.driver.probe()
        self.assertEqual(len([event for event in self.engine.events if event[0] == 'create']), 1)
        self.assertFalse(any(event[0] in {'remove', 'start'} for event in self.engine.events))

    def test_authorizer_is_called_before_and_after_named_engine_calls(self):
        self.probe_commit(); self.driver.activate()
        actions = [action for _, action in self.auth_events]
        for method in ('inspect', 'find_name', 'create', 'start', 'remove'):
            count = sum(event[0] == method for event in self.engine.events)
            self.assertEqual(actions.count('before-' + method), count)
            self.assertEqual(actions.count('after-' + method), count)
        self.assertTrue(all(scope == self.driver.scope for scope, _ in self.auth_events))

    def test_nonrenewable_expired_or_changed_root_deadline_is_rejected(self):
        self.driver.preflight(); self.deadline += 1
        with self.assertRaises(ValueError): self.driver.preflight()
        self.deadline = int(time.time()) - 1
        with self.assertRaises(ValueError): self.driver.status()

    def test_out_of_band_authority_scope_and_full_definitions_cannot_change_on_resume(self):
        self.driver.preflight()
        for key, value in [('operation_sha256', 'c' * 64), ('authority_sha256', 'c' * 64)]:
            previous = self.kwargs[key]; self.kwargs[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): self.new_driver().preflight()
            self.kwargs[key] = previous
        self.plans[0]['compiled']['body']['Env'].append('DIFFERENT=1')
        with self.assertRaises(ValueError): self.new_driver().preflight()

    def test_no_self_authority_or_optional_security_callback(self):
        for name in ('authorize', 'comparator', 'verify_ports', 'verify_destination'):
            kwargs = dict(self.kwargs); kwargs[name] = None
            with self.subTest(name=name), self.assertRaises(ValueError): M.RetainedAppEffects(self.path, **kwargs)
        self.allowed = False
        with self.assertRaises(ValueError): self.driver.preflight()
        self.assertFalse((self.path / 'definition.json').exists())

    def test_bad_plan_ids_order_names_and_image_references_are_rejected(self):
        variants = [lambda p: p.reverse(), lambda p: p[0].update(sourceId='short'),
                    lambda p: p[0]['compiled'].update(name='orbis-retained-forged'),
                    lambda p: p[0]['compiled']['body'].update(Image='mutable:tag'),
                    lambda p: p[1].update(ordinal=1), lambda p: p[0]['compiled']['networkIds'].update(shared='short')]
        for index, change in enumerate(variants):
            kwargs = dict(self.kwargs); kwargs['plans'] = copy.deepcopy(self.plans); change(kwargs['plans'])
            with self.subTest(change=index), self.assertRaises(ValueError): M.RetainedAppEffects(self.path, **kwargs)

    def test_progress_symlink_and_permissive_files_are_rejected(self):
        self.driver.preflight(); path = self.path / 'progress.json'; body = path.read_bytes()
        path.unlink(); target = self.path / 'target'; target.write_bytes(body); target.chmod(0o600); path.symlink_to(target)
        with self.assertRaises((OSError, ValueError)): self.new_driver().preflight()
        path.unlink(); path.write_bytes(body); path.chmod(0o644)
        with self.assertRaises(ValueError): self.new_driver().preflight()

    def test_journal_cannot_forge_absence_or_own_a_retirement_id(self):
        self.driver.preflight(); state = self.read()
        state['probes'][0].update(createIntent=True, id=self.destinations[0]['Id'])
        (self.path / 'progress.json').write_bytes(M.canonical(state))
        with self.assertRaises(ValueError): self.new_driver().cleanup_probes()

    def test_verify_checks_current_exact_config_ports_network_name_and_state(self):
        self.probe_commit(); self.driver.activate(); state = self.read(); identity = state['desired'][0]['id']
        pristine = copy.deepcopy(self.engine.objects[identity])
        changes = [lambda raw: raw.update(Name='/renamed'), lambda raw: raw.update(Image='sha256:' + '9' * 64),
                   lambda raw: raw['HostConfig'].update(Privileged=True), lambda raw: raw['Config']['Env'].append('CHANGED=1'),
                   lambda raw: raw['NetworkSettings']['Networks']['shared'].update(NetworkID=''),
                   lambda raw: raw['NetworkSettings']['Ports']['8080/tcp'][0].update(HostPort='18081'),
                   lambda raw: raw['State'].update(Running=False), lambda raw: raw['State'].update(Paused=True)]
        for index, change in enumerate(changes):
            self.engine.objects[identity] = copy.deepcopy(pristine); change(self.engine.objects[identity])
            with self.subTest(change=index), self.assertRaises(ValueError): self.new_driver().verify()

    def test_root_approved_probe_plan_changes_only_bind_sources_and_is_scope_bound(self):
        probes = copy.deepcopy(self.plans)
        for plan in probes:
            host = plan['compiled']['body']['HostConfig']
            host['Mounts'][0]['Source'] = '/incoming/apps/demo/whoami/actual.json'
            host['Binds'][0] = '/incoming/app-data/demo/whoami:/config:rw,z'
        self.kwargs['probe_plans'] = probes; self.driver = self.new_driver()
        self.probe_commit(); self.driver.activate()
        self.assertEqual(self.driver.scope['probePlansSha256'], M.digest(probes))
        for method, name, _ in self.engine.events:
            if method == 'create' and '-app-probe-' in name:
                # The immutable desired definition still names final paths.
                self.assertTrue(self.plans[0]['compiled']['body']['HostConfig']['Mounts'][0]['Source'].startswith('/srv/'))
        self.kwargs['probe_plans'][0]['compiled']['body']['HostConfig']['Mounts'][0]['Source'] = '/incoming/changed'
        with self.assertRaises(ValueError): self.new_driver().verify()

    def test_probe_plan_cannot_change_image_security_config_ports_networks_or_target(self):
        variants = [lambda p: p[0]['compiled']['body'].update(Image='sha256:' + '8' * 64),
                    lambda p: p[0]['compiled']['body']['HostConfig'].update(Privileged=True),
                    lambda p: p[0]['compiled']['body']['Env'].append('CHANGED=1'),
                    lambda p: p[0]['compiled']['body']['HostConfig']['PortBindings']['8080/tcp'][0].update(HostPort='12345'),
                    lambda p: p[0]['compiled']['networkIds'].update(shared='8' * 64),
                    lambda p: p[0]['compiled']['body']['HostConfig']['Mounts'][0].update(Target='/other'),
                    lambda p: p[0]['compiled']['body']['HostConfig']['Mounts'][0].update(Source='/bad/../path'),
                    lambda p: p[0]['compiled'].update(name='different'),
                    lambda p: p[0].update(wasRunning=False)]
        for index, change in enumerate(variants):
            kwargs = dict(self.kwargs); kwargs['probe_plans'] = copy.deepcopy(self.plans); change(kwargs['probe_plans'])
            with self.subTest(change=index), self.assertRaises(ValueError): M.RetainedAppEffects(self.path, **kwargs)

    def test_nonempty_container_id_file_rejected_before_any_effect(self):
        self.plans[0]['compiled']['body']['HostConfig']['ContainerIDFile'] = '/private/unapproved-output'
        with self.assertRaises(ValueError): self.new_driver()
        self.assertFalse(self.engine.events)

    def test_running_endpoint_requires_full_endpoint_id(self):
        self.probe_commit(); self.driver.activate(); identity = self.read()['desired'][0]['id']
        self.engine.objects[identity]['NetworkSettings']['Networks']['shared']['EndpointID'] = ''
        with self.assertRaises(ValueError): self.driver.verify()

    def test_previously_started_object_that_exits_is_held_for_independent_health_policy(self):
        self.probe_commit(); self.driver.activate(); identity = self.read()['desired'][0]['id']
        raw = self.engine.objects[identity]; raw['State'].update(Running=False, Status='exited')
        raw['NetworkSettings']['Ports'] = None
        for endpoint in raw['NetworkSettings']['Networks'].values(): endpoint['NetworkID'] = ''; endpoint['EndpointID'] = ''
        with self.assertRaises(ValueError): self.new_driver().activate()
        self.assertEqual(len([event for event in self.engine.events if event[0] == 'start']), 1)

    def test_daemon_transport_error_never_becomes_absence_or_cleanup_permission(self):
        self.probe_commit()
        original = self.engine.inspect
        def unavailable(identity): raise TimeoutError('daemon unavailable')
        self.engine.inspect = unavailable
        with self.assertRaises(TimeoutError): self.driver.activate()
        self.engine.inspect = original
        self.assertEqual(set(self.engine.objects), {raw['Id'] for raw in self.destinations})
        self.assertFalse(any(event[0] == 'start' for event in self.engine.events))

    def test_authority_revocation_before_next_effect_preserves_pending_evidence(self):
        self.engine.lose = 'create'
        with self.assertRaises(LostReply): self.driver.probe()
        before = (self.path / 'progress.json').read_bytes(); self.allowed = False
        with self.assertRaises(ValueError): self.new_driver().cleanup_probes()
        self.assertEqual((self.path / 'progress.json').read_bytes(), before)

    def test_lock_refuses_concurrent_driver_without_waiting_or_changing_journal(self):
        import fcntl
        self.driver.preflight(); before = (self.path / 'progress.json').read_bytes()
        with (self.path / 'effects.lock').open('rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError): self.new_driver().preflight()
        self.assertEqual((self.path / 'progress.json').read_bytes(), before)

    def test_postcommit_application_data_writes_are_preserved_on_resume(self):
        self.probe_commit(); self.driver.activate()
        app_data = self.path / 'application-data'; app_data.write_text('new committed writes')
        self.new_driver().activate(); self.new_driver().verify()
        self.assertEqual(app_data.read_text(), 'new committed writes')
        self.assertEqual(set(path.name for path in self.path.iterdir()), {'definition.json', 'progress.json', 'effects.lock', 'application-data'})
        self.assertFalse(any(event[0] == 'stop' for event in self.engine.events))


if __name__ == '__main__': unittest.main()
