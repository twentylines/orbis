"""File-backed transaction and fixed dispatch tests without native services."""

from contextlib import ExitStack, contextmanager, nullcontext
from copy import deepcopy
from email.message import Message
import errno
import importlib.util
from io import BytesIO
import json
import os
from pathlib import Path
import struct
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SERVICE = load('orbis-host-service')
HANDOFF = load('orbis-host-controller-handoff')
HOST = SERVICE.HOST
SOURCE_TIME = '2026-11-21T02:00:00.000001Z'
STOPPED_TIME = '2026-11-21T02:00:03.2Z'
RETURN_TIME = '2026-11-21T02:00:04Z'
ZERO_TIME = '0001-01-01T00:00:00Z'
ORIGIN = 'https://sentinel.example.test:9443'
CONTAINER = 'a' * 64
IMAGE = 'sha256:' + 'b' * 64
PROOF = {'floor': 'c' * 64, 'portal': 'd' * 64, 'installationId': 'e' * 64}
APPROVAL = '9' * 64


class InlineThread:
    def __init__(self, *, target, daemon):
        self.target = target

    def start(self):
        self.target()


class Provider:
    def __init__(self):
        self.proof = deepcopy(PROOF)
        self.core = {
            'boot': 'fixture-boot', 'daemon': 'fixture-daemon', 'id': CONTAINER, 'origin': ORIGIN,
            'main': {'imageId': IMAGE, 'publicationSha256': '3' * 64, 'creationSha256': '4' * 64},
            'startedAt': SOURCE_TIME, 'finishedAt': ZERO_TIME, 'restartCount': 0, 'pid': 43, 'state': 'healthy',
        }
        self.fail_before_effect = False
        self.lose_reply = False
        self.allow_portal = True
        self.fail_portal_after_stop = False
        self.calls = []
        self.timeline = []
        self.fail_preflight = False
        self.fail_final_portal = False
        self.fail_return_readiness = False
        self.readiness_checks = 0
        self.peer_binding = None
        self.peer_identity = {'controllerId': CONTAINER, 'imageId': IMAGE, 'installationId': PROOF['installationId']}
        self.after_transition = lambda: None
        self.listener = object()
        self.approval_claims = []
        self.claim_reply = lambda arguments: {}

    @contextmanager
    def producer(self, connection):
        if connection is None:
            raise ValueError('Unverified peer.')
        yield SimpleNamespace(verify=lambda: None, identity=lambda: self.peer_identity,
                              installation_binding=lambda: self.peer_binding)

    @contextmanager
    def qualification(self, core, *, portal):
        self.timeline.append(('qualify', core['state'], portal))
        if portal and (not self.allow_portal or self.fail_portal_after_stop and core['state'] == 'stopped'):
            raise ValueError('Portal unavailable.')
        def check():
            if portal and self.fail_final_portal:
                raise ValueError('Edge changed during qualification')
        yield {key: value for key, value in self.proof.items() if portal or key != 'portal'}, check
        check()

    def current(self):
        return deepcopy(self.core)

    @contextmanager
    def park_qualification(self, core):
        def check_return():
            self.readiness_checks += 1
            if self.fail_return_readiness:
                raise OSError(errno.ENOPROTOOPT, 'Peer pidfd unavailable')
            return time.monotonic() + 8
        with self.qualification(core, portal=True) as (proof, check):
            yield proof, check, check_return

    @contextmanager
    def return_qualification(self, core, connection):
        if connection is not self.listener:
            raise ValueError('The caller is not the paired listener.')
        with self.qualification(core, portal=True) as (proof, check):
            yield proof, check, SimpleNamespace(call=self.claim)

    def claim(self, operation, arguments):
        if operation != 'controller-return-claim':
            raise ValueError('Unexpected bootstrap operation')
        self.approval_claims.append(deepcopy(arguments))
        return self.claim_reply(arguments)

    def effect(self, operation, core, *, before_dispatch):
        if self.fail_preflight:
            raise ValueError('Daemon observation unavailable before dispatch')
        before_dispatch()
        self.calls.append((operation, core['id']))
        self.timeline.append(('effect', operation))
        if self.fail_before_effect:
            raise RuntimeError('Lost before execution.')
        if operation == 'stop':
            self.core.update(state='stopped', finishedAt=STOPPED_TIME, pid=0)
        else:
            self.core.update(state='healthy', startedAt=RETURN_TIME, finishedAt=ZERO_TIME, pid=57, restartCount=0)
        self.after_transition()
        if self.lose_reply:
            raise RuntimeError('Lost effect reply.')


class HandoffFiles(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        temp = Path(stack.enter_context(tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR') or Path.cwd()))).resolve()
        root = temp / 'installation'
        root.mkdir(mode=0o700)
        state = temp / 'root-state'
        state.mkdir(mode=0o700)
        stack.enter_context(patch.object(HOST.AUTHORITY.LAYOUT, 'STATE_ROOT', state))
        stack.enter_context(patch.object(HOST.AUTHORITY, 'OWNER', os.geteuid()))
        stack.enter_context(patch.object(HOST.CREDENTIAL_FENCE, 'OWNER', os.geteuid()))
        stack.enter_context(patch.object(HOST.CREDENTIAL_FENCE, '_mount', lambda fd: os.fstat(fd).st_dev))
        stack.enter_context(patch.object(HOST.AUTHORITY.LAYOUT, 'read', return_value={}))
        stack.enter_context(patch.object(HANDOFF.threading, 'Thread', InlineThread))
        HOST.AUTHORITY.LAYOUT.namespace(root).mkdir(mode=0o700, parents=True)
        self.peer = object()
        self.provider = Provider()
        self.service = SimpleNamespace(HOST=HOST, root=root, context='local', lock=threading.Lock(),
                                       require_idle_core=lambda: HOST.require_no_capture_fence(root))
        self.provider.peer_binding = {'root': str(root), 'context': 'local', 'daemon': 'fixture-daemon'}
        self.time = 1000
        self.handoff = self.new_manager()

    def new_manager(self):
        return HANDOFF.ControllerHandoff(self.service, self.provider, json.loads, SERVICE.write_private, clock=lambda: self.time)

    def plan(self):
        return self.handoff.review(self.peer, {})['planId']

    def accepted(self, plan):
        result, launch = self.handoff.apply(self.peer, plan)
        self.assertEqual(result['state'], 'accepted')
        self.assertTrue(callable(launch))
        return launch

    def park(self):
        plan = self.plan()
        self.accepted(plan)()
        self.assertEqual(self.handoff.status(plan)['state'], 'held')
        return plan

    def resume(self, plan):
        result, launch = self.handoff.return_to_orbis(plan)
        self.assertIn(result['state'], ('return-accepted', 'returning'))
        self.assertTrue(callable(launch))
        launch()

    def test_full_hold_and_return_across_reopened_files(self):
        plan = self.plan()
        launch = self.accepted(plan)
        self.assertEqual(self.handoff.status(plan)['state'], 'accepted')
        self.assertEqual(self.provider.calls, [])
        self.assertEqual(self.handoff.apply(self.peer, plan)[1], None)
        with self.assertRaises(ValueError), HOST.host_lock(self.service.root):
            self.fail('Other lifecycle operation entered.')
        with self.assertRaises(ValueError), HOST.credential_fence_lock(self.service.root, self.service.context):
            self.fail('Credential lifecycle operation entered.')
        launch()
        self.handoff = self.new_manager()
        self.assertEqual(self.handoff.status(plan)['state'], 'held')
        self.assertEqual(self.provider.timeline[-3:], [('qualify', 'healthy', True), ('effect', 'stop'), ('qualify', 'stopped', True)])
        self.resume(plan)
        self.handoff = self.new_manager()
        self.assertEqual(self.handoff.status(plan)['state'], 'complete')
        self.assertEqual(self.handoff._record(plan)['returnedStartedAt'], RETURN_TIME)
        self.assertFalse(self.handoff.selector.exists())
        self.assertEqual(self.handoff.return_to_orbis(plan)[1], None)
        self.assertEqual(self.provider.calls, [('stop', CONTAINER), ('start', CONTAINER)])
        with HOST.host_lock(self.service.root):
            pass

    def test_stable_floor_id_is_separate_from_current_producer_scope(self):
        self.provider.peer_identity['installationId'] = '0' * 64
        plan = self.park()
        self.assertEqual(self.handoff._record(plan)['proof']['installationId'], PROOF['installationId'])
        self.resume(plan)
        self.assertEqual(self.handoff.status(plan)['state'], 'complete')

    def test_known_zero_preflight_failure_retries_each_effect_once(self):
        plan = self.plan()
        self.provider.fail_preflight = True
        self.accepted(plan)()
        self.assertEqual(self.handoff._record(plan)['phase'], 'accepted')
        self.assertEqual(self.provider.calls, [])
        self.provider.fail_preflight = False
        self.accepted(plan)()
        self.provider.fail_preflight = True
        self.resume(plan)
        self.assertEqual(self.handoff._record(plan)['phase'], 'return-accepted')
        self.provider.fail_preflight = False
        self.resume(plan)
        self.assertEqual(self.provider.calls, [('stop', CONTAINER), ('start', CONTAINER)])
        self.assertEqual(self.handoff.status(plan)['state'], 'complete')

    def test_edge_failure_on_final_check_prevents_stop_intent(self):
        plan = self.plan()
        launch = self.accepted(plan)
        self.provider.fail_final_portal = True
        launch()
        self.assertEqual(self.handoff._record(plan)['phase'], 'accepted')
        self.assertEqual(self.provider.calls, [])

    def test_browser_readiness_is_required_at_review_apply_and_effect(self):
        self.provider.fail_return_readiness = True
        with self.assertRaises(OSError):
            self.plan()
        self.assertFalse(self.handoff.selector.exists())
        self.provider.fail_return_readiness = False
        plan = self.plan()
        self.provider.fail_return_readiness = True
        with self.assertRaises(OSError):
            self.accepted(plan)
        self.assertFalse(self.handoff.selector.exists())
        self.assertEqual(self.handoff._record(plan)['phase'], 'planned')
        self.provider.fail_return_readiness = False
        launch = self.accepted(plan)
        self.provider.fail_return_readiness = True
        launch()
        self.assertEqual(self.handoff._record(plan)['phase'], 'accepted')
        self.assertEqual(self.provider.readiness_checks, 5)
        self.assertEqual(self.provider.calls, [])

    def test_root_can_restart_held_controller_when_browser_readiness_is_lost(self):
        plan = self.park()
        self.assertEqual(self.provider.readiness_checks, 3)
        self.provider.fail_return_readiness = True
        self.resume(plan)
        self.assertEqual(self.handoff.status(plan)['state'], 'complete')
        self.assertEqual(self.provider.readiness_checks, 3)

    def test_review_and_apply_recheck_readiness_after_qualification_exit(self):
        clock = [0.0]
        @contextmanager
        def slow(core):
            with self.provider.qualification(core, portal=True) as (proof, check):
                yield proof, check, lambda: clock[0] + 8
                clock[0] += 9
        with patch.object(HANDOFF.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(self.provider, 'park_qualification', slow), self.assertRaises(ValueError):
            self.plan()
        self.assertIsNone(self.handoff._selected())
        plan = self.plan()
        with patch.object(HANDOFF.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(self.provider, 'park_qualification', slow), self.assertRaises(ValueError):
            self.accepted(plan)
        self.assertEqual(self.handoff._record(plan)['phase'], 'planned')
        self.time = self.handoff._record(plan)['expiresAtMs'] / 1000 - 1
        @contextmanager
        def wall_expired(core):
            with self.provider.qualification(core, portal=True) as (proof, check):
                yield proof, check, lambda: time.monotonic() + 8
                self.time += 2
        with patch.object(self.provider, 'park_qualification', wall_expired), self.assertRaises(ValueError):
            self.accepted(plan)
        self.assertEqual(self.handoff._record(plan)['phase'], 'planned')
        self.assertIsNone(self.handoff._selected())
        self.assertEqual(self.provider.calls, [])

    def test_selector_write_failure_never_publishes_partial_hold(self):
        plan = self.plan()
        real_fsync = HANDOFF.os.fsync
        def fail_file(fd):
            import stat
            if stat.S_ISREG(os.fstat(fd).st_mode):
                raise OSError('simulated file fsync failure')
            return real_fsync(fd)
        with patch.object(HANDOFF.os, 'fsync', side_effect=fail_file), self.assertRaises(OSError):
            self.handoff.apply(self.peer, plan)
        self.assertFalse(self.handoff.selector.exists())
        self.assertEqual(list(self.handoff.selector.parent.glob('.controller-recovery-selector-*')), [])
        with HOST.host_lock(self.service.root):
            pass
        self.accepted(plan)()
        self.assertEqual(self.provider.calls, [('stop', CONTAINER)])

    def test_selector_directory_failure_preserves_complete_cancellable_hold(self):
        plan = self.plan()
        real_fsync = HANDOFF.os.fsync
        def fail_published_directory(fd):
            import stat
            if stat.S_ISDIR(os.fstat(fd).st_mode) and self.handoff.selector.exists():
                raise OSError('simulated directory fsync failure')
            return real_fsync(fd)
        with patch.object(HANDOFF.os, 'fsync', side_effect=fail_published_directory), self.assertRaises(OSError):
            self.handoff.apply(self.peer, plan)
        self.assertEqual(self.handoff._selected(), plan)
        result, launch = self.handoff.return_to_orbis(plan)
        self.assertEqual((result['state'], launch), ('cancelled', None))
        self.assertFalse(self.handoff.selector.exists())
        self.assertEqual(self.provider.calls, [])

    def test_apply_review_expiry_and_stale_runtime(self):
        plan = self.plan()
        self.provider.core['startedAt'] = RETURN_TIME
        with self.assertRaises(ValueError):
            self.handoff.apply(self.peer, plan)
        self.provider.core['startedAt'] = SOURCE_TIME
        self.time += HANDOFF.TTL_MS / 1000
        with self.assertRaises(ValueError):
            self.handoff.apply(self.peer, plan)
        self.assertEqual(self.provider.calls, [])
        self.assertFalse(self.handoff.selector.exists())

    def test_invalid_peer_and_unready_portal_refuse_before_durability(self):
        with self.assertRaises(ValueError):
            self.handoff.review(None, {})
        self.provider.peer_binding['daemon'] = 'other'
        with self.assertRaises(ValueError):
            self.plan()
        self.provider.peer_binding['daemon'] = 'fixture-daemon'
        self.provider.allow_portal = False
        with self.assertRaises(ValueError):
            self.plan()
        self.assertEqual(list(self.handoff.selector.parent.glob('controller-recovery-*')), [])

    def test_rechecks_portal_after_acceptance(self):
        plan = self.plan()
        launch = self.accepted(plan)
        self.provider.proof['portal'] = 'f' * 64
        launch()
        self.assertEqual(self.handoff.status(plan)['state'], 'attention')
        self.assertEqual(self.provider.calls, [])
        cancelled, worker = self.handoff.return_to_orbis(plan)
        self.assertEqual((cancelled['state'], worker), ('cancelled', None))
        self.assertFalse(self.handoff.selector.exists())

    def test_post_stop_portal_failure_reports_attention_but_root_can_return(self):
        self.provider.fail_portal_after_stop = True
        plan = self.plan()
        self.accepted(plan)()
        self.assertEqual((self.handoff.status(plan)['state'], self.handoff.status(plan)['phase']), ('attention', 'stopping'))
        self.resume(plan)
        self.assertEqual(self.handoff.status(plan)['state'], 'complete')

    def test_accepted_without_worker_can_replay_and_second_plan_cannot_take_hold(self):
        plan, other = self.plan(), self.plan()
        self.accepted(plan)  # Simulate interruption before the response starts its worker.
        self.handoff = self.new_manager()
        self.assertEqual(self.handoff.status(plan)['state'], 'attention')
        with self.assertRaises(ValueError):
            self.handoff.apply(self.peer, other)
        self.accepted(plan)()
        self.assertEqual(self.provider.calls, [('stop', CONTAINER)])

    def test_lost_docker_replies_settle_by_observation(self):
        self.provider.lose_reply = True
        plan = self.park()
        self.resume(plan)
        self.assertEqual(self.handoff.status(plan)['state'], 'complete')
        self.assertEqual(self.provider.calls, [('stop', CONTAINER), ('start', CONTAINER)])

    def test_unknown_stop_does_not_retry_or_clear_hold(self):
        self.provider.fail_before_effect = True
        plan = self.plan()
        self.accepted(plan)()
        self.handoff = self.new_manager()
        self.assertEqual(self.handoff.apply(self.peer, plan)[0]['state'], 'attention')
        with self.assertRaises(ValueError):
            self.handoff.return_to_orbis(plan)
        self.assertEqual(self.provider.calls, [('stop', CONTAINER)])
        self.assertTrue(self.handoff.selector.exists())

    def test_return_acceptance_replays_before_worker_launch(self):
        plan = self.park()
        result, launch = self.handoff.return_to_orbis(plan)
        self.assertEqual(result['state'], 'return-accepted')
        self.assertTrue(callable(launch))
        self.handoff = self.new_manager()
        self.assertEqual(self.handoff.status(plan)['state'], 'attention')
        self.assertEqual(self.provider.calls, [('stop', CONTAINER)])
        self.resume(plan)
        self.assertEqual(self.handoff.status(plan)['state'], 'complete')
        self.assertEqual(self.provider.calls, [('stop', CONTAINER), ('start', CONTAINER)])

    def test_unknown_start_does_not_repeat_and_fresh_health_can_settle(self):
        plan = self.park()
        self.provider.fail_before_effect = True
        self.resume(plan)
        self.assertEqual(self.handoff.status(plan)['state'], 'attention')
        self.handoff = self.new_manager()
        self.resume(plan)
        self.assertEqual(self.provider.calls, [('stop', CONTAINER), ('start', CONTAINER)])
        self.provider.core.update(state='healthy', startedAt=RETURN_TIME, pid=57)
        self.resume(plan)
        self.assertEqual(self.handoff.status(plan)['state'], 'complete')
        self.assertEqual(self.provider.calls, [('stop', CONTAINER), ('start', CONTAINER)])

    def test_changed_floor_or_replaced_controller_cannot_return(self):
        plan = self.park()
        self.provider.proof['floor'] = '6' * 64
        self.resume(plan)
        self.assertEqual(self.handoff.status(plan)['state'], 'attention')
        self.assertEqual(self.handoff.status(plan)['phase'], 'return-accepted')
        self.assertEqual(self.provider.calls, [('stop', CONTAINER)])
        self.provider.core['id'] = '5' * 64
        self.assertEqual(self.handoff.status(plan)['state'], 'attention')
        with self.assertRaises(ValueError):
            self.handoff.return_to_orbis(plan)

    def test_lost_receipt_cleanup_replays_after_terminal_commit(self):
        plan = self.park()
        with patch.object(self.handoff, '_clear', side_effect=OSError):
            self.resume(plan)
        self.assertEqual(self.handoff.status(plan)['state'], 'attention')
        self.assertEqual(self.handoff.status(plan)['phase'], 'complete')
        self.assertTrue(self.handoff.selector.exists())
        self.handoff = self.new_manager()
        self.assertEqual(self.handoff.return_to_orbis(plan)[0]['state'], 'complete')
        self.assertFalse(self.handoff.selector.exists())

    def test_selector_interruption_and_corrupt_symlink_hold(self):
        plan = self.plan()
        with patch.object(self.handoff, '_move', side_effect=OSError):
            with self.assertRaises(OSError):
                self.handoff.apply(self.peer, plan)
        self.handoff = self.new_manager()
        self.accepted(plan)()
        self.assertEqual(self.handoff.status(plan)['state'], 'held')
        self.handoff.selector.unlink()
        self.assertEqual(self.handoff.status(plan)['state'], 'attention')
        with self.assertRaises(ValueError):
            self.handoff.return_to_orbis(plan)
        self.handoff.selector.symlink_to('missing')
        with self.assertRaises(ValueError), HOST.host_lock(self.service.root):
            self.fail('Corrupt selector unlocked Host lifecycle.')
        with self.assertRaises(OSError):
            self.handoff.return_to_orbis(plan)

    def approve(self, plan, approval=APPROVAL, *, remaining=60000):
        def reply(arguments):
            return {**arguments, 'approved': True, 'expiresAtMs': int(self.time * 1000) + remaining,
                    'principal': 'orbis-operator', 'method': 'passkey', 'revision': '3' * 64}
        self.provider.claim_reply = reply
        return self.handoff.return_approved(self.provider.listener, plan, approval)

    def test_approved_return_persists_bound_acceptance_and_stable_scope(self):
        plan = self.park()
        held = self.handoff._record(plan)
        scope = HANDOFF.ControllerHandoff.return_scope(held)
        self.assertEqual(scope, {'planId': plan, 'installationId': PROOF['installationId'],
                                 'handoffSha256': HANDOFF.digest({key: held[key] for key in
                                     ('root', 'context', 'source', 'proof', 'stoppedAt')})})
        with self.assertRaises(ValueError):
            self.handoff.return_approved(self.peer, plan, APPROVAL)
        self.assertEqual(self.provider.approval_claims, [])
        accepted, launch = self.approve(plan)
        self.assertEqual(accepted['phase'], 'return-accepted')
        self.assertNotIn('returnClaimId', accepted)
        claim, = self.provider.approval_claims
        self.assertEqual(claim['scope'], scope)
        self.assertEqual(claim['approvalId'], APPROVAL)
        self.assertEqual(self.handoff._record(plan)['returnClaimId'], claim['claimId'])
        self.assertEqual(self.provider.calls, [('stop', CONTAINER)])
        launch()
        self.assertEqual(HANDOFF.ControllerHandoff.return_scope(self.handoff._record(plan)), scope)
        self.assertEqual(self.approve(plan)[0]['state'], 'complete')
        self.assertEqual(self.provider.approval_claims, [claim])
        with self.assertRaises(ValueError):
            self.approve(plan, '0' * 64)
        self.assertEqual(self.provider.calls, [('stop', CONTAINER), ('start', CONTAINER)])

    def test_lost_claim_and_uncertain_acceptance_replays_same_claim(self):
        plan = self.park()
        self.provider.claim_reply = lambda _: (_ for _ in ()).throw(OSError('Lost approval response'))
        with self.assertRaises(OSError):
            self.handoff.return_approved(self.provider.listener, plan, APPROVAL)
        self.assertEqual(self.handoff._record(plan)['phase'], 'held')
        original_write = self.handoff.write

        def uncertain_write(path, value):
            original_write(path, value)
            raise OSError('Lost durable write confirmation')

        with patch.object(self.handoff, 'write', uncertain_write), self.assertRaises(OSError):
            self.approve(plan)
        self.assertEqual(self.provider.calls, [('stop', CONTAINER)])
        self.handoff = self.new_manager()
        self.assertEqual(self.handoff.status(plan)['phase'], 'return-accepted')
        _, launch = self.approve(plan, remaining=30000)
        self.assertEqual(len(self.provider.approval_claims), 3)
        self.assertTrue(all(item == self.provider.approval_claims[0] for item in self.provider.approval_claims))
        launch()
        self.assertEqual(self.provider.calls, [('stop', CONTAINER), ('start', CONTAINER)])

    def test_wall_clock_rollback_does_not_revive_reply_during_live_checks(self):
        plan = self.park()
        def reply(arguments):
            expires = int(self.time * 1000) + 2000
            self.time -= 1
            return {**arguments, 'approved': True, 'expiresAtMs': expires,
                    'principal': 'orbis-operator', 'method': 'passkey', 'revision': '3' * 64}
        self.provider.claim_reply = reply
        with patch.object(HANDOFF.time, 'monotonic', side_effect=[100, 103]), self.assertRaises(ValueError):
            self.handoff.return_approved(self.provider.listener, plan, APPROVAL)
        self.assertEqual(self.handoff._record(plan)['phase'], 'held')

    def test_worker_delay_cannot_extend_approval_and_same_claim_can_shorten_expiry(self):
        plan = self.park()
        _, launch = self.approve(plan)
        with patch.object(HANDOFF.time, 'monotonic', return_value=HANDOFF.time.monotonic() + 61):
            launch()
        self.assertEqual(self.handoff._record(plan)['phase'], 'return-accepted')
        self.assertEqual(self.provider.calls, [('stop', CONTAINER)])
        self.approve(plan, remaining=30000)[1]()
        self.assertEqual(self.provider.approval_claims[0], self.provider.approval_claims[1])
        self.assertEqual(self.handoff.status(plan)['state'], 'complete')

    def test_forward_wall_adjustment_before_dispatch_expires_the_accepted_grant(self):
        plan = self.park()
        _, launch = self.approve(plan, remaining=2000)
        self.time += 3
        launch()
        self.assertEqual(self.handoff._record(plan)['phase'], 'return-accepted')
        self.assertEqual(self.provider.calls, [('stop', CONTAINER)])
        self.approve(plan, 'd' * 64, remaining=2000)[1]()
        self.assertEqual(self.handoff.status(plan)['state'], 'complete')
        self.assertEqual(self.provider.calls, [('stop', CONTAINER), ('start', CONTAINER)])

    def test_rejects_malformed_or_stale_approval_and_changed_live_scope(self):
        plan = self.park()
        for changes in ({'planId': plan}, {'approved': 1}, {'approvalId': 'a' * 64},
                        {'scope': {}}, {'claimId': 'a' * 64}, {'principal': 'other'},
                        {'method': []}, {'revision': 'corrupt'}, {'expiresAtMs': 1000000},
                        {'expiresAtMs': 1060001}, {'expiresAtMs': True}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.provider.claim_reply = lambda args: {
                    **args, 'approved': True, 'expiresAtMs': 1060000, 'principal': 'recovery-key',
                    'method': 'recovery-key', 'revision': '3' * 64, **changes}
                self.handoff.return_approved(self.provider.listener, plan, APPROVAL)
        count = len(self.provider.approval_claims)
        for key in PROOF:
            with self.subTest(proof=key), patch.dict(self.provider.proof, {key: '2' * 64}), self.assertRaises(ValueError):
                self.approve(plan)
        with patch.dict(self.provider.core, {'finishedAt': RETURN_TIME}), self.assertRaises(ValueError):
            self.approve(plan)
        self.assertEqual(len(self.provider.approval_claims), count)
        self.assertEqual(self.handoff._record(plan)['phase'], 'held')
        self.assertEqual(self.provider.calls, [('stop', CONTAINER)])

    def test_approved_worker_refuses_changed_portal_and_root_can_still_return(self):
        plan = self.park()
        _, launch = self.approve(plan)
        self.provider.allow_portal = False
        launch()
        self.assertEqual(self.handoff.status(plan)['phase'], 'return-accepted')
        self.assertEqual(self.provider.calls, [('stop', CONTAINER)])
        self.resume(plan)
        self.assertEqual(self.handoff.status(plan)['state'], 'complete')

    def test_approved_preflight_replay_requires_live_approval(self):
        plan = self.park()
        self.provider.fail_preflight = True
        self.approve(plan)[1]()
        self.provider.fail_preflight = False
        self.handoff = self.new_manager()
        self.provider.claim_reply = lambda _: {}
        with self.assertRaises(ValueError):
            self.handoff.return_approved(self.provider.listener, plan, APPROVAL)
        self.assertEqual(self.provider.calls, [('stop', CONTAINER)])
        self.approve(plan, '8' * 64)[1]()
        self.assertEqual(self.handoff.status(plan)['state'], 'complete')
        self.assertEqual(self.provider.calls, [('stop', CONTAINER), ('start', CONTAINER)])

    def test_approved_retry_observes_uncertain_start_without_another_start(self):
        plan = self.park()
        self.provider.fail_before_effect = True
        self.approve(plan)[1]()
        self.handoff = self.new_manager()
        self.assertEqual(self.handoff.status(plan)['phase'], 'returning')
        self.approve(plan)[1]()
        self.assertEqual(len(self.provider.approval_claims), 1)
        self.assertEqual(self.provider.calls, [('stop', CONTAINER), ('start', CONTAINER)])
        self.provider.core.update(state='healthy', startedAt=RETURN_TIME, pid=57)
        self.approve(plan)[1]()
        self.assertEqual(self.handoff.status(plan)['state'], 'complete')


class RecoveryPeer(unittest.TestCase):
    def test_kernel_peer_pins_expected_live_listener_and_closes_descriptor(self):
        credentials = struct.pack('3i', 139, 0, 0)
        descriptor = 42
        connection = SimpleNamespace(getsockopt=lambda *args: credentials if len(args) == 3 else descriptor)
        poll = SimpleNamespace(register=lambda *_: None, poll=lambda _: [])
        with (patch.object(HANDOFF.sys, 'platform', 'linux'), patch.object(HANDOFF.os, 'geteuid', return_value=0),
              patch.object(HANDOFF.socket, 'SO_PEERCRED', 17, create=True),
              patch.object(HANDOFF.os, 'set_inheritable') as inherit, patch.object(HANDOFF.os, 'close') as close,
              patch.object(HANDOFF.select, 'poll', return_value=poll),
              patch('builtins.open', side_effect=lambda *_: BytesIO(b'Pid:\t139\nNSpid:\t139\n')) as fdinfo):
            with HANDOFF.recovery_peer(connection) as check:
                check(139)
                with self.assertRaises(ValueError):
                    check(140)
                poll.poll = lambda _: [(descriptor, HANDOFF.select.POLLIN)]
                with self.assertRaises(ValueError):
                    check(139)
        fdinfo.assert_called_with('/proc/self/fdinfo/42', 'rb')
        inherit.assert_called_once_with(descriptor, False)
        close.assert_called_once_with(descriptor)


class ProviderBoundary(unittest.TestCase):
    def setUp(self):
        self.product = load('orbis-host-recovery-admission')
        self.service = SimpleNamespace(HOST=HOST, root=Path('/srv/fixture-orbis'), context='local',
                                       current_manifest=lambda: {'tag': '0.0.1'})
        self.provider = HANDOFF.ControllerProvider(self.service, self.product, None, lambda: 'boot')
        self.reference = 'ghcr.io/twentylines/orbis@' + IMAGE
        self.raw = {
            'Id': CONTAINER, 'Image': IMAGE, 'Name': '/runtipi', 'RestartCount': 0, 'Mounts': [],
            'State': {'Running': True, 'Paused': False, 'Restarting': False, 'Dead': False, 'Status': 'running',
                      'Health': {'Status': 'healthy'}, 'Pid': 44, 'StartedAt': SOURCE_TIME, 'FinishedAt': ZERO_TIME},
            'Config': {'Image': self.reference, 'Env': ['ORBIS_SENTINEL_RECOVERY_ORIGIN=' + ORIGIN],
                       'Labels': {'com.docker.compose.project': 'runtipi', 'com.docker.compose.service': 'runtipi',
                                  'com.docker.compose.project.working_dir': str(self.service.root),
                                  'io.orbis.credential-writer-protocol': self.product.MAIN_PROTOCOL}},
            'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0}, 'AutoRemove': False},
            'Path': '/app/start', 'Args': [],
        }
        self.commands = []
        self.provider.docker = SimpleNamespace(local_daemon=lambda: 'fixture-daemon', inspect=lambda _: self.raw,
            runtime=SimpleNamespace(image=lambda _: {'Id': IMAGE, 'RepoDigests': [self.reference]}))
        patcher = patch.object(HOST, 'controller_reference', return_value=self.reference)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(HOST, 'run', side_effect=self.observe_command)
        patcher.start()
        self.addCleanup(patcher.stop)

    def observe_command(self, args, cwd):
        self.assertEqual(cwd, self.service.root)
        self.assertEqual(args[:8], ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C', '/usr/bin/docker',
                                    '--config', str(self.product.HOST_SOURCE), '--host'])
        self.assertEqual(args[8], 'unix:///var/run/docker.sock')
        self.commands.append(args[9:])
        return SimpleNamespace(returncode=0, stdout='"fixture-daemon"')

    def test_fixed_effects_require_full_current_id_and_local_daemon(self):
        core = self.provider.current()
        self.provider.effect('stop', core, before_dispatch=lambda: None)
        self.provider.effect('start', core, before_dispatch=lambda: None)
        self.assertEqual([cmd for cmd in self.commands if cmd[:1] == ['container']],
                         [['container', 'stop', '--time', '30', CONTAINER], ['container', 'start', CONTAINER]])
        for operation, runtime in [('restart', core), ('stop', {**core, 'id': 'runtipi'}),
                                   ('start', {**core, 'daemon': 'other'})]:
            with self.subTest(operation=operation, runtime=runtime['id']), self.assertRaises(ValueError):
                self.provider.effect(operation, runtime, before_dispatch=lambda: None)
        self.assertEqual(sum(cmd[:1] == ['container'] for cmd in self.commands), 2)

    def test_actual_provider_preflight_precedes_durable_dispatch_and_mutation(self):
        core = self.provider.current()
        self.commands.clear()
        events = []
        def dispatch():
            self.assertEqual(self.commands, [['info', '--format', '{{json .ID}}']])
            events.append('durable intent')
        self.provider.effect('stop', core, before_dispatch=dispatch)
        self.assertEqual(events, ['durable intent'])
        self.assertEqual(self.commands[-1], ['container', 'stop', '--time', '30', CONTAINER])
        self.commands.clear()
        with patch.object(self.provider, '_daemon', side_effect=OSError('unavailable')), self.assertRaises(OSError):
            self.provider.effect('stop', core, before_dispatch=lambda: self.fail('Preflight cannot record issued intent'))
        self.assertEqual(self.commands, [])

    def test_current_refuses_unenrolled_or_unstable_facts(self):
        for key, path, value in (
            ('Name', (), '/other'), ('RestartPolicy', ('HostConfig',), {'Name': 'always', 'MaximumRetryCount': 0}),
            ('Paused', ('State',), True), ('com.docker.compose.service', ('Config','Labels'), 'other'),
        ):
            with self.subTest(field=key):
                entry = self.raw
                for part in path:
                    entry = entry[part]
                previous = entry[key]
                entry[key] = value
                with self.assertRaises(ValueError):
                    self.provider.current()
                entry[key] = previous
        self.provider.docker.local_daemon = lambda: 'remote'
        with self.assertRaises(ValueError):
            self.provider.current()

    def test_approved_qualification_pins_bootstrap_client_to_verified_listener_pid(self):
        provider = self.provider
        core = provider.current()
        self.service.state_dir = Path('/root-state')
        noop = lambda: None
        root = self.service.state_dir
        runtime = {'version': 'fixture', 'inventorySha256': 'inventory', 'runtimeFiles': {}}
        process = {'pid': 234, 'startTicks': 98, 'invocationId': '5' * 32}
        listener = {'unitSha256': 'unit', 'environmentSha256': 'env', 'configSha256': 'cfg', 'process': process}
        current = {'main': core['main'], 'recoveryOrigin': core['origin'],
                   'sentinel': {**runtime, 'runtimeSha256': provider.product.digest({}),
                                'unitSha256': 'unit', 'environmentSha256': 'env'},
                   'configuration': {'recoveryConfigSha256': 'cfg'}}
        history = {'schema': 'v3', 'mode': 'managed', 'current': current, 'installationId': PROOF['installationId']}
        snap = SimpleNamespace(report=SimpleNamespace(classification='record-consistent', history_sha256=PROOF['floor']),
                               _value=history, recheck=noop)
        config = SimpleNamespace(data={'origin': core['origin'], 'imageId': core['main']['imageId'], 'listenPort': 9443},
                                 verify=noop)
        modules = {'credential_floor': SimpleNamespace(SCHEMA='v3', CredentialFloorReader=lambda *_a, **_k:
                                           SimpleNamespace(snapshot=lambda: nullcontext(snap))),
                   'recovery_config': SimpleNamespace(RecoveryConfig=lambda _: nullcontext(config))}
        layout = SimpleNamespace(STATE_ROOT=root, read=lambda *_: {}, namespace=lambda _: root)
        provider.supervisor = SimpleNamespace(layout=layout, _held_runtime=lambda **_: nullcontext((runtime, modules, noop)),
            bootstrap_recovery=lambda *_a, **_k: nullcontext((listener, noop)))
        marker = SimpleNamespace(body=b'fixture', close=noop, verify=noop)
        client = SimpleNamespace(call=lambda *_: {'origin': core['origin'], 'stage': 'activated'})
        calls = []
        def bootstrap(path, *, timeout, expected_pid):
            calls.append((path, timeout, expected_pid))
            return client
        extra = {
            'bootstrap_control': SimpleNamespace(RootBootstrapControlClient=bootstrap),
            'recovery_https_install': SimpleNamespace(socket_identity=lambda *_: 'socket'),
            'recovery_listener_install': SimpleNamespace(held_controller_handoff_portal=lambda *_:
                                                            nullcontext(({'certificateSha256': 'f' * 64}, noop))),
            'recovery_worker_provision': object(),
        }
        caller = object()
        seen = []
        with (patch.object(HANDOFF, 'recovery_peer', return_value=nullcontext(seen.append)) as peer,
              patch.object(provider, '_portal_modules', return_value=(extra, {})),
              patch.object(provider, '_anchor'),
              patch.object(provider.product.C, 'PinnedFile', return_value=marker),
              patch.object(provider.product, 'Admission', return_value=SimpleNamespace(_journal=lambda *_a, **_k: 'idle'))):
            with provider.return_qualification(core, caller) as (proof, verify, pinned_client):
                self.assertIs(pinned_client, client)
                self.assertEqual(proof['installationId'], history['installationId'])
                verify()
            with self.assertRaisesRegex(ValueError, 'independent controller return'):
                with provider.park_qualification(core):
                    self.fail('An older portal cannot permit park.')
            exchange = SimpleNamespace(requests=[])
            extra['controller_return_readiness'] = SimpleNamespace(
                readiness_request=lambda value: value, PROBE_SECONDS=8)

            def verify_portal(configuration, marker_bytes, proof, request, arm):
                self.assertIs(configuration, config)
                self.assertEqual(marker_bytes, marker.body)
                self.assertEqual(proof, {'certificateSha256': 'f' * 64})
                exchange.requests.append(request)

            def prove(request, pid, transport, timeout, run):
                self.assertEqual((pid, transport, timeout), (process['pid'], client, 8))
                run(noop)
                return HANDOFF.time.monotonic() + timeout

            extra['recovery_listener_install'].verify_controller_return_portal = verify_portal
            with (provider.park_qualification(core) as (_, verify, verify_return),
                  patch.object(provider, '_prove_return_readiness', side_effect=prove)):
                verify()
                verify_return()
                verify_return()
            first, second = exchange.requests
            self.assertNotEqual(first['challenge'], second['challenge'])
            for request in (first, second):
                self.assertTrue(HANDOFF.matches(HANDOFF.HASH, request.pop('challenge')))
                self.assertEqual(request, {'installationId': history['installationId'],
                                           'invocationId': process['invocationId'],
                                           'markerSha256': provider.product.digest(marker.body)})
        peer.assert_called_once_with(caller)
        self.assertEqual(calls, [(str(provider.product.RECOVERY / 'bootstrap-control.sock'), 3, process['pid'])] * 2)
        self.assertEqual(seen, [process['pid']] * 3)


class HandoffDispatch(unittest.TestCase):
    def handler(self, path, body=None):
        handler = SERVICE.Handler.__new__(SERVICE.Handler)
        handler.server = SimpleNamespace(service=SimpleNamespace(credentials_only=False))
        handler.path = SERVICE.CONTROLLER_HANDOFF_BASE + path
        handler.headers = Message()
        handler.headers['Host'] = 'orbis'
        handler.connection = SimpleNamespace(settimeout=lambda _: None)
        handler.rfile = BytesIO(body or b'')
        if body is not None:
            handler.headers['Content-Type'] = 'application/json'
            handler.headers['Content-Length'] = str(len(body))
        calls = []
        handler.send_json = lambda status, value: calls.append((status, value))
        return handler, calls

    def test_return_checks_root_namespace_before_dispatch(self):
        handler, calls = self.handler('/return', b'{}')
        with (patch.object(SERVICE, 'trusted_capture_peer', return_value=True),
              patch.object(SERVICE, 'load_script', return_value=HANDOFF),
              patch.object(HANDOFF, 'root_operator', return_value=False)):
            handler.do_POST()
        self.assertEqual(calls[0][0], 403)

    def test_apply_launches_after_durable_reply_even_if_reply_is_lost(self):
        identifier = '11111111-2222-4333-8444-555555555555'
        handler, calls = self.handler('/apply', json.dumps({'planId': identifier}).encode())
        service = SimpleNamespace(read=json.loads, apply=lambda *_: ({'state': 'accepted'}, lambda: calls.append('launched')))
        handler.server = SimpleNamespace(service=SimpleNamespace(controller_handoffs=lambda _: service))

        def lost(status, _):
            calls.append(status)
            raise BrokenPipeError

        handler.send_json = lost
        with patch.object(SERVICE, 'trusted_capture_peer', return_value=True), self.assertRaises(BrokenPipeError):
            handler.do_POST()
        self.assertEqual(calls, [202, 'launched'])

    def test_wrong_framing_and_nonfixed_path_are_refused(self):
        with patch.object(SERVICE, 'trusted_capture_peer', return_value=True):
            handler, calls = self.handler('/apply', b'{}')
            handler.headers['Content-Length'] = '2'
            handler.do_POST()
            self.assertEqual(calls[0][0], 409)
            handler, calls = self.handler('/apply?op=stop-other', b'{}')
            handler.do_POST()
            self.assertEqual(calls[0][0], 404)

    def test_approved_post_only_admits_fixed_pair_and_launches_after_response(self):
        plan = '11111111-2222-4333-8444-555555555555'
        data = {'planId': plan, 'approvalId': APPROVAL}
        handler, calls = self.handler('/return-approved', json.dumps(data).encode())
        reader = load('orbis-host-credential-service').json_body
        def accept(*args):
            self.assertEqual(args, (handler.connection, plan, APPROVAL))
            return {'state': 'return-accepted'}, lambda: calls.append('launched')
        service = SimpleNamespace(read=reader, return_approved=accept)
        factory = SimpleNamespace(service=SimpleNamespace(controller_handoffs=lambda _: service))
        handler.server = factory
        with (patch.object(SERVICE, 'trusted_capture_peer', return_value=True),
              patch.object(HANDOFF, 'root_operator', side_effect=AssertionError('Unexpected emergency admission'))):
            def lost(status, _):
                calls.append(status)
                raise BrokenPipeError
            handler.send_json = lost
            with self.assertRaises(BrokenPipeError):
                handler.do_POST()
            self.assertEqual(calls, [202, 'launched'])
            for body in (b'{}', json.dumps({**data, 'scope': {}}).encode(),
                         json.dumps({**data, 'approvalId': '9' * 63}).encode(),
                         json.dumps(data).encode()[:-1] + b', "approvalId": null}'):
                with self.subTest(body=body):
                    malformed, response = self.handler('/return-approved', body)
                    malformed.server = factory
                    malformed.do_POST()
                    self.assertEqual(response[0][0], 409)

    def test_readiness_post_requires_kernel_peer_and_exact_pending_challenge(self):
        data = {'challenge': 'a' * 64, 'installationId': 'b' * 64,
                'invocationId': 'c' * 32, 'markerSha256': 'd' * 64}
        listener_pid = 24
        provider = HANDOFF.ControllerProvider.__new__(HANDOFF.ControllerProvider)
        provider._return_probe_lock, provider._return_probe = threading.Lock(), None
        client = SimpleNamespace(call=lambda operation, args: args if operation == 'controller-return-readiness-arm' else {})
        service = SimpleNamespace(provider=provider, read=load('orbis-host-credential-service').json_body)
        factory = SimpleNamespace(service=SimpleNamespace(controller_handoffs=lambda _: service))

        def post(value, caps):
            handler, calls = self.handler('/return-readiness', json.dumps(value).encode())
            handler.server = factory
            handler.connection.getsockopt = caps
            handler.do_POST()
            return calls[0]

        def unsupported(_level, option, *size):
            if size:
                return struct.pack('3i', listener_pid, 0, 0)
            self.assertEqual(option, getattr(HANDOFF.socket, 'SO_PEERPIDFD', 77))
            raise OSError(errno.ENOPROTOOPT, 'Unsupported')

        with (patch.object(SERVICE, 'load_script', return_value=HANDOFF),
              patch.object(SERVICE, 'trusted_capture_peer', return_value=True),
              patch.object(HANDOFF.sys, 'platform', 'linux'), patch.object(HANDOFF.os, 'geteuid', return_value=0),
              patch.object(HANDOFF.socket, 'SO_PEERCRED', 17, create=True)):
            self.assertEqual(post(data, unsupported)[0], 409)

            def reject(arm):
                arm()
                self.assertEqual(post(data, unsupported)[0], 409)

            with self.assertRaises(ValueError):
                provider._prove_return_readiness(data, listener_pid, client, 8, reject)
            self.assertIsNone(provider._return_probe)

            def match(pid):
                self.assertEqual(pid, listener_pid)

            def accept(arm):
                arm()
                self.assertEqual(post({**data, 'invocationId': 'e' * 32}, unsupported)[0], 409)
                with patch.object(HANDOFF, 'recovery_peer', return_value=nullcontext(match)):
                    self.assertEqual(post(data, unsupported), (200, {'schema': 'orbis.controller-return-readiness.v1', **data}))
                    self.assertEqual(post(data, unsupported)[0], 409)

            provider._prove_return_readiness(data, listener_pid, client, 8, accept)
            self.assertIsNone(provider._return_probe)
            elapsed = [0.0]
            armed = []
            def late(arm):
                elapsed[0] = 9
                arm()
            with patch.object(HANDOFF.time, 'monotonic', side_effect=lambda: elapsed[0]), self.assertRaises(ValueError):
                provider._prove_return_readiness(data, listener_pid,
                    SimpleNamespace(call=lambda *args: armed.append(args)), 8, late)
            self.assertEqual(armed, [])
            self.assertIsNone(provider._return_probe)


if __name__ == '__main__':
    unittest.main()
