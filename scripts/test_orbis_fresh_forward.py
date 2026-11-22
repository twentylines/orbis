from contextlib import closing, contextmanager
import sqlite3
import unittest
from unittest import mock

import test_orbis_fresh_cutover_birth as fixtures

M = fixtures.M


class FreshForwardTests(unittest.TestCase):
    """Real protected chain and module gates; synthetic Docker/SQL ports only."""
    def setUp(self):
        self.c = fixtures.CutoverBirthTests('test_full_real_snapshot_reset_and_birth_keep_fence_and_match_target')
        self.addCleanup(self.c.doCleanups); self.c.setUp()
        c = self.c
        c.r.OWNERSHIP = M
        actual = c.host.file_digest.__globals__
        c.host.published_installation_fingerprint = actual['published_installation_fingerprint']
        c.host.write_state = actual['write_state']
        c.host.installation_fingerprint = actual['installation_fingerprint']
        compose = mock.patch.object(actual['PLAN'], 'plan', return_value={})
        compose.start(); self.addCleanup(compose.stop)
        previous = c.reader._read
        def read(args):
            if 'curl' not in args:
                return previous(args)
            raw = c.raws[args[1]]
            phase = raw['Config']['Labels']['io.orbis.installation.phase']
            return fixtures.json.dumps({'schema': c.host.PLAN.INSTALLATION_PROTOCOL, 'phase': phase,
                                        'transactionId': None if phase == 'normal' else fixtures.TX})
        c.reader._read = read

    @contextmanager
    def ready(self):
        c = self.c
        with c.prepared() as (guard, permit):
            c.reset_ready(permit)
            with mock.patch.object(c.r.FRESH.subprocess, 'run', side_effect=c.sql):
                c.record['freshReset'] = permit.reset_accounts(c.record)
            c.record.update(stage='resuming'); c.save()
            permit.arm_resume(c.record)
            yield guard, permit

    def target(self, permit, phase):
        c = self.c
        c.raws.pop('9' * 64, None)
        c.record.update(candidatePhase=phase, stage='resumed' if phase == 'resume' else 'committing')
        c.record.pop('candidate', None); c.save()
        with c.r.ownership_scope(permit, c.record):
            body = c.r.payload(c.record, c.reader, phase)
        raw = {'Id': '9' * 64, 'Image': c.record['review']['image']['imageId'], 'Name': '/runtipi',
               'Config': {key: item for key, item in body.items() if key not in ('HostConfig', 'NetworkingConfig')},
               'HostConfig': body['HostConfig'], 'NetworkSettings': {'Networks': {}}, 'Mounts': [],
               'State': {'Status': 'running', 'Health': {'Status': 'healthy'}}}
        c.raws[raw['Id']] = raw
        c.record['candidate'] = {'id': raw['Id'], 'definition': c.r.candidate_definition(raw), 'validated': True}
        c.save()
        return raw

    def normal(self, permit):
        self.target(permit, 'resume')
        permit.record_forward(self.c.record)
        self.target(permit, 'normal')
        permit.record_normal(self.c.record)

    def finished(self, permit):
        c = self.c
        self.normal(permit)
        expected = {item['id']: item for item in c.record['review']['checkpoint']['storage']['containerStates']}
        for identifier, role in c.roles.items():
            current = c.raws['9' * 64 if role == 'controller' else identifier]
            current['HostConfig']['RestartPolicy'] = expected[identifier]['restartPolicy']
            current['State']['Status'] = expected[identifier]['state']
        c.host.write_state(c.root, c.host.published_installation_fingerprint(c.root, c.f.manifest, c.reader.context))
        c.raws.pop(c.f.raw['Id'])
        c.record.update(stage='complete'); c.save()

    def test_complete_verifies_live_outcome_then_retires_exact_fence_and_preserves_new_data(self):
        c = self.c
        with self.ready() as (guard, permit):
            self.finished(permit)
            c.accounts['users'] = 1
            cache = c.root / 'cache/cache.sqlite'
            with closing(sqlite3.connect(cache)) as db, db:
                db.execute('CREATE TABLE keyv (key TEXT PRIMARY KEY, value TEXT)')
                db.execute("INSERT INTO keyv VALUES ('session:new','fixture')")
            before = cache.read_bytes(); selected = permit.reference
            result = permit.complete(c.record)
            self.assertIsNone(guard.read())
            self.assertEqual(c.accounts['users'], 1); self.assertEqual(cache.read_bytes(), before)
            self.assertEqual(c.sql_calls, 1)
        with c.b.guarded() as guard:
            with c.issuer.resume_completed(guard, c.record, selected) as permit:
                self.assertEqual(permit.completed(c.record), result)
                self.assertEqual(permit.complete(c.record), result)
                with self.assertRaises(ValueError): permit.authorize_controller(c.record)
            self.assertIsNone(guard.read())

    def test_normal_phase_requires_durable_forward_decision(self):
        c = self.c
        with self.ready() as (guard, permit):
            self.target(permit, 'resume')
            c.record['candidatePhase'] = 'normal'; c.save()
            with c.r.ownership_scope(permit, c.record), self.assertRaises(ValueError):
                c.r.payload(c.record, c.reader, 'normal')
            self.assertIsNotNone(guard.read())

    def test_unhealthy_or_changed_resume_cannot_arm_forward(self):
        c = self.c
        with self.ready() as (guard, permit):
            raw = self.target(permit, 'resume')
            raw['State']['Health']['Status'] = 'unhealthy'
            with self.assertRaises(ValueError): permit.record_forward(c.record)
            raw['State']['Health']['Status'] = 'healthy'
            raw['HostConfig']['PortBindings'] = {'3000/tcp': [{'HostPort': '3000'}]}
            with self.assertRaises(ValueError): permit.record_forward(c.record)
            self.assertFalse(M.phase_path(c.root, permit.reference['operationId'], 'forward').exists())
            self.assertIsNotNone(guard.read())

    def test_old_removal_without_normal_receipt_and_terminal_label_do_not_clear_fence(self):
        c = self.c
        with self.ready() as (guard, permit):
            self.target(permit, 'resume'); permit.record_forward(c.record)
            self.target(permit, 'normal')
            c.raws.pop(c.f.raw['Id']); c.record['stage'] = 'complete'; c.save()
            with self.assertRaises(ValueError): permit.complete(c.record)
            self.assertIsNotNone(guard.read())

    def test_current_health_policy_and_state_failures_keep_fence(self):
        c = self.c
        with self.ready() as (guard, permit):
            self.finished(permit)
            raw = c.raws['9' * 64]
            raw['State']['Health']['Status'] = 'unhealthy'
            with self.assertRaises(ValueError): permit.complete(c.record)
            raw['State']['Health']['Status'] = 'healthy'
            c.raws['6' * 64]['HostConfig']['RestartPolicy'] = dict(M.NO_RESTART)
            with self.assertRaises(ValueError): permit.complete(c.record)
            c.raws['6' * 64]['HostConfig']['RestartPolicy'] = {'Name': 'unless-stopped', 'MaximumRetryCount': 0}
            state = c.root / c.host.STATE_NAME
            value = fixtures.json.loads(state.read_text()); value['tag'] = 'different'
            state.write_text(fixtures.json.dumps(value))
            with self.assertRaises(ValueError): permit.complete(c.record)
            self.assertIsNotNone(guard.read())

    def test_partial_normal_proof_after_old_removal_never_authorizes_forward_work(self):
        c = self.c
        with self.ready() as (guard, permit):
            self.finished(permit)
            path = M.phase_path(c.root, permit.reference['operationId'], 'normal')
            path.write_bytes(b'{')
            with self.assertRaises(ValueError): permit.authorize_controller(c.record)
            with self.assertRaises(ValueError): permit.complete(c.record)
            self.assertEqual(path.read_bytes(), b'{'); self.assertIsNotNone(guard.read())

    def test_lost_retirement_reply_resumes_only_exact_completed_outcome(self):
        c = self.c
        with self.ready() as (guard, permit):
            self.finished(permit); selected = permit.reference
            with mock.patch.object(guard, 'finish', side_effect=OSError('fixture interrupted retirement')):
                with self.assertRaises(OSError): permit.complete(c.record)
            self.assertIsNotNone(guard.read())
        with c.b.guarded() as guard:
            with c.issuer.resume_completed(guard, c.record, selected) as permit: permit.complete(c.record)
            self.assertIsNone(guard.read())
        c.raws['9' * 64]['State']['Health']['Status'] = 'unhealthy'
        with c.b.guarded() as guard:
            with self.assertRaises(ValueError), c.issuer.resume_completed(guard, c.record, selected): pass

    def test_scope_rejects_foreign_or_unarmed_issuer_and_clears_context_on_error(self):
        c = self.c
        with c.prepared() as (guard, permit):
            with self.assertRaises(ValueError), c.r.ownership_scope(object(), c.record): pass
            with c.r.ownership_scope(permit, c.record), self.assertRaises(FileNotFoundError):
                c.r.require_fresh_revocation(c.record)
            self.assertIsNone(c.r._FRESH_PERMIT.get())
            self.assertIsNotNone(guard.read())

    def test_actual_finish_joins_forward_creation_normal_proof_and_exact_terminal_retirement(self):
        c = self.c
        with self.ready() as (guard, permit):
            self.target(permit, 'resume')
            observed = []
            def create(name, body):
                self.assertTrue(M.phase_path(c.root, permit.reference['operationId'], 'forward').is_file())
                self.assertEqual(name, 'runtipi')
                raw = {'Id': '9' * 64, 'Image': c.record['review']['image']['imageId'], 'Name': '/' + name,
                       'Config': {key: item for key, item in body.items() if key not in ('HostConfig', 'NetworkingConfig')},
                       'HostConfig': body['HostConfig'], 'NetworkSettings': {'Networks': {}}, 'Mounts': [],
                       'State': {'Status': 'created', 'Health': {'Status': 'starting'}}}
                c.raws[raw['Id']] = raw
                return raw['Id']
            def change(args, **kwargs):
                observed.append(args)
                action, identifier = args[0], args[-1]
                raw = c.raws[identifier]
                if action == 'update':
                    name, _, attempts = args[2].partition(':')
                    raw['HostConfig']['RestartPolicy'] = {'Name': name, 'MaximumRetryCount': int(attempts or 0)}
                elif action == 'start': raw['State'].update(Status='running', Health={'Status': 'healthy'})
                elif action == 'stop': raw['State']['Status'] = 'exited'
                elif action == 'rm': c.raws.pop(identifier)
                else: raise AssertionError('Unexpected Docker mutation')
            c.reader.change = change
            def inspect(args):
                raw = c.inspect(args)
                return raw['State'] if '{{json .State}}' in args else raw
            c.reader._object.side_effect = inspect
            with c.r.ownership_scope(permit, c.record), mock.patch.object(c.r, 'Engine') as engine:
                engine.return_value.create.side_effect = create
                result = c.r.finish(c.record, c.reader)
            self.assertEqual(result['result'], 'orbis-installed')
            self.assertEqual(c.record['stage'], 'complete'); self.assertIsNone(guard.read())
            self.assertNotIn(c.f.raw['Id'], c.raws)
            self.assertTrue(M.phase_path(c.root, permit.reference['operationId'], 'complete').is_file())
            self.assertTrue(observed); self.assertEqual(c.sql_calls, 1)

    def test_new_guard_finishes_forward_after_old_removal_without_recreating_or_resetting(self):
        c = self.c
        with self.ready() as (guard, permit):
            self.finished(permit)
            c.record['stage'] = 'committing'; c.save()
            c.accounts['users'] = 1
            selected = permit.reference
        changes = []
        def change(args, **kwargs):
            self.assertIn(args[0], ('update', 'start'))
            if args[0] == 'start':
                self.assertEqual(args[1], '9' * 64)
                c.raws[args[1]]['State'].update(Status='running', Health={'Status': 'healthy'})
            changes.append(args)
        c.reader.change = change
        c.raws['9' * 64]['State'].update(Status='exited', Health={'Status': 'starting'})
        def inspect(args):
            raw = c.inspect(args)
            return raw['State'] if '{{json .State}}' in args else raw
        c.reader._object.side_effect = inspect
        with c.b.guarded() as guard:
            with c.issuer.resume_cutover(guard, c.record, selected) as permit:
                with c.r.ownership_scope(permit, c.record), mock.patch.object(c.r, 'Engine') as engine:
                    result = c.r.finish(c.record, c.reader)
                    engine.assert_not_called()
            self.assertIsNone(guard.read())
        self.assertEqual(result['result'], 'orbis-installed')
        self.assertTrue(changes); self.assertEqual(c.sql_calls, 1); self.assertEqual(c.accounts['users'], 1)


if __name__ == '__main__': unittest.main()
