"""Socket-free coverage of the fixed Host handoff read."""

from contextlib import contextmanager
from copy import deepcopy
import json
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import test_orbis_host_controller_handoff as transaction

observer = transaction.load('orbis-host-sentinel-observer')
PLAN = '12345678-1234-4123-8123-123456789abc'
OTHER = '12345678-1234-4123-8123-123456789abd'


class HandoffObservationTests(unittest.TestCase):
    def setUp(self):
        self.provider = transaction.Provider()
        self.provider._current = self.provider.current
        self.provider.product = SimpleNamespace(digest=lambda _: '8' * 64)
        self.provider.supervisor = SimpleNamespace(layout=SimpleNamespace(STATE_ROOT='/private-state'))
        service = SimpleNamespace(HOST=transaction.HOST, root='/core', context='local', state_dir='/private-state')
        self.manager = transaction.HANDOFF.ControllerHandoff(service, self.provider, json.loads, Mock())
        self.selected = PLAN
        self.records = {PLAN: {
            'schema': transaction.HANDOFF.SCHEMA, 'id': PLAN, 'root': str(service.root), 'context': service.context,
            'phase': 'accepted', 'source': self.provider.current(), 'proof': deepcopy(transaction.PROOF),
            'expiresAtMs': 10000, 'stoppedAt': None, 'returnedStartedAt': None,
        }}
        self.manager._selected = lambda: self.selected
        self.manager._record = lambda identifier: deepcopy(self.records[identifier])
        self.scope = self.manager.return_scope({
            **self.records[PLAN], 'phase': 'held', 'stoppedAt': transaction.STOPPED_TIME,
        })
        self.observer = observer.HandoffObservation(lambda: self.manager)
        self.runtime = {'version': '1', 'inventorySha256': '9' * 64, 'runtimeFiles': {}}
        self.history = {
            'schema': 'v3', 'mode': 'managed', 'installationId': transaction.PROOF['installationId'],
            'current': {'main': self.provider.core['main'], 'recoveryOrigin': transaction.ORIGIN,
                        'sentinel': {'version': '1', 'inventorySha256': '9' * 64, 'runtimeSha256': '8' * 64}},
        }
        self.snapshot = SimpleNamespace(
            report=SimpleNamespace(classification='record-consistent', history_sha256=transaction.PROOF['floor']),
            _value=self.history, recheck=Mock())
        self.floor = SimpleNamespace(SCHEMA='v3', CredentialFloorReader=Mock(side_effect=self._reader))
        self.provider.supervisor._held_runtime = self._runtime

    @contextmanager
    def _runtime(self, *, storage_floor):
        self.assertTrue(storage_floor)
        yield self.runtime, {'credential_floor': self.floor}, None

    def _reader(self, root, context, daemon, *, host_state_directory):
        self.assertEqual((root, context, daemon, host_state_directory), ('/core', 'local', 'fixture-daemon', '/private-state'))

        @contextmanager
        def snapshot():
            yield self.snapshot
            self.snapshot.recheck()
        return SimpleNamespace(snapshot=snapshot)

    def read(self):
        return self.observer(time.monotonic() + 2)['handoff']

    def update(self, phase, **changes):
        self.records[PLAN].update(phase=phase, **changes)

    def hold(self):
        self.update('held', stoppedAt=transaction.STOPPED_TIME)
        self.provider.core.update(state='stopped', pid=0, finishedAt=transaction.STOPPED_TIME)

    def test_one_plan_moves_through_all_observed_states_and_verified_completion(self):
        self.manager.workers.add(PLAN)
        self.assertEqual(self.read(), {'planId': PLAN, 'state': 'accepted'})
        self.update('stopping')
        self.assertEqual(self.read(), {'planId': PLAN, 'state': 'stopping'})
        self.hold()
        self.assertEqual(self.read(), {'planId': PLAN, 'state': 'held', 'returnScope': self.scope})
        self.update('return-accepted')
        self.assertEqual(self.read(), {'planId': PLAN, 'state': 'held', 'returnScope': self.scope})
        self.update('returning')
        self.provider.core.update(state='starting', startedAt=transaction.RETURN_TIME, pid=90)
        self.assertEqual(self.read(), {'planId': PLAN, 'state': 'returning'})
        self.update('complete', returnedStartedAt=transaction.RETURN_TIME)
        self.selected = None
        self.assertEqual(self.read(), {'planId': PLAN, 'state': 'attention'})
        self.provider.core.update(state='healthy')
        self.assertEqual(self.read(), {'planId': PLAN, 'state': 'complete'})
        self.observer.terminal_until = time.monotonic() - 1
        self.assertIsNone(self.read())
        self.manager.write.assert_not_called()

    def test_generic_health_and_changed_startup_cannot_supply_completion(self):
        self.hold()
        self.read()
        self.selected = None
        self.provider.core.update(state='healthy', startedAt=transaction.RETURN_TIME, pid=52)
        self.assertEqual(self.read(), {'planId': PLAN, 'state': 'attention'})
        self.update('complete', returnedStartedAt=transaction.RETURN_TIME)
        self.provider.core.update(startedAt='2026-11-21T02:00:05Z')
        self.assertEqual(self.read(), {'planId': PLAN, 'state': 'attention'})

    def test_held_scope_disappears_if_exact_stopped_incarnation_changes(self):
        self.hold()
        self.assertIn('returnScope', self.read())
        self.provider.core.update(finishedAt=transaction.RETURN_TIME)
        self.assertEqual(self.read(), {'planId': PLAN, 'state': 'attention'})
        self.provider.core.update(id='0' * 64)
        with self.assertRaises(ValueError):
            self.read()

    def test_floor_or_installation_mismatch_and_failed_pin_recheck_refuse(self):
        self.hold()
        self.assertEqual(self.read()['state'], 'held')
        for changes in ({'installationId': '0' * 64}, {'mode': 'unmanaged'}, {'schema': 'v2'}):
            with self.subTest(changes=changes), patch.dict(self.history, changes), self.assertRaises(ValueError):
                self.read()
        with patch.object(self.snapshot.report, 'history_sha256', '0' * 64), self.assertRaises(ValueError):
            self.read()
        self.snapshot.recheck.side_effect = ValueError()
        with self.assertRaises(ValueError):
            self.read()

    def test_no_worker_no_selector_and_replaced_selector_are_distinct(self):
        self.assertEqual(self.read(), {'planId': PLAN, 'state': 'attention'})
        self.update('cancelled')
        self.selected = None
        self.assertIsNone(self.read())
        self.selected = OTHER
        self.records[OTHER] = {**self.records[PLAN], 'id': OTHER, 'phase': 'accepted'}
        self.manager.workers.add(OTHER)
        self.assertEqual(self.read(), {'planId': OTHER, 'state': 'accepted'})

    def test_older_manager_cannot_publish_held_without_the_exact_scope_helper(self):
        self.hold()
        with patch.object(self.manager, 'return_scope', None), self.assertRaises(ValueError):
            self.read()

    def test_late_record_or_selector_change_cannot_publish_held(self):
        self.hold()
        for mutate in (lambda: self.update('return-accepted'), lambda: setattr(self, 'selected', OTHER)):
            original = self.records[PLAN].copy()
            self.snapshot.recheck.side_effect = mutate
            with self.assertRaises(ValueError):
                self.read()
            self.records[PLAN] = original
            self.selected = PLAN

    def test_undispatched_return_keeps_exact_retry_scope_without_a_worker(self):
        self.hold()
        self.update('return-accepted')
        self.assertEqual(self.read(), {'planId': PLAN, 'state': 'held', 'returnScope': self.scope})
        self.update('returning')
        self.assertNotIn('returnScope', self.read())

    def test_late_incarnation_change_refuses_held_and_terminal_publication(self):
        self.hold()
        self.snapshot.recheck.side_effect = lambda: self.provider.core.update(startedAt=transaction.RETURN_TIME)
        with self.assertRaises(ValueError):
            self.read()
        self.snapshot.recheck.side_effect = None
        self.provider.core.update(state='healthy', startedAt=transaction.RETURN_TIME, pid=50)
        self.update('complete', returnedStartedAt=transaction.RETURN_TIME)
        self.selected = None
        self.snapshot.recheck.side_effect = lambda: self.provider.core.update(startedAt='2026-11-21T02:00:05Z')
        with self.assertRaises(ValueError):
            self.read()

    def test_known_plan_cannot_be_rebound_and_reads_share_one_slot(self):
        self.read()
        self.records[PLAN]['proof']['portal'] = '0' * 64
        with self.assertRaises(ValueError):
            self.read()
        with self.observer.lock, self.assertRaises(ValueError):
            self.read()
        self.assertIsNone(self.manager.host.CAPTURE_READ_DEADLINE.get())


class ObserverRouteTests(unittest.TestCase):
    def test_only_exact_get_enters_the_handoff_provider(self):
        server = object.__new__(observer.ObserverServer)
        server.path, server.identity = '/observer', (None, (0, 0, 0, 12))
        server._identity, server._peer = lambda _: server.identity, lambda _: (1000, 12)
        server._slots = threading.BoundedSemaphore(1)
        server.capture_provider = server.component_provider = None
        server.provider = Mock(return_value={'version': 1, 'job': None})
        server.handoff_provider = Mock(return_value={'version': 1, 'handoff': None})

        def request(line, headers=b''):
            connection = Mock()
            connection.recv.return_value = line + b' HTTP/1.1\r\n' + headers + b'\r\n'
            self.assertTrue(server._slots.acquire(blocking=False))
            server._handle(connection)
            connection.close.assert_called_once()
            return connection.sendall.call_args.args[0]

        valid = b'GET /v4/controller-handoff/status'
        for target, headers in (
            (valid + b'?planId=' + PLAN.encode(), b''),
            (valid.replace(b'GET', b'POST'), b''),
            (valid, b'Content-Length: 1\r\n'),
        ):
            self.assertIn(b'400 Bad Request', request(target, headers))
        server.handoff_provider.assert_not_called()
        self.assertIn(b'200 OK', request(valid))
        server.handoff_provider.assert_called_once()
        server.handoff_provider.return_value = {'version': 1, 'handoff': None, 'private': 'secret'}
        reply = request(valid)
        self.assertIn(b'400 Bad Request', reply)
        self.assertNotIn(b'secret', reply)
        self.assertIn(b'200 OK', request(b'GET /v1/core-operation/progress'))
