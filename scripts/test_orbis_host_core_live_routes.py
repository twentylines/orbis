import io
import json
import os
import tempfile
import threading
import unittest
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import test_orbis_host_service as BASE

S = BASE.SERVICE
ID = '8a2ba5cd-36c3-4edb-bafb-94d32a985fd7'
OTHER = '6cb51cbc-a697-4e56-b911-23b25bed155d'
SCHEMA = 'orbis.core-live-restoration-job.v1'


class LiveHostBoundaryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='core-live-host-boundary-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.root = self.base / 'root'; self.root.mkdir(mode=0o700)
        self.state = self.base / 'state'; self.state.mkdir(mode=0o700)
        self.enterContext(mock.patch.object(S.HOST.AUTHORITY, 'OWNER', os.geteuid()))
        self.service = object.__new__(S.HostService)
        self.service.root, self.service.state_dir, self.service.context = self.root, self.state, 'fixture'
        self.legacy = mock.Mock(); self.legacy.maintenance.return_value = {'state': 'idle'}
        self.live = mock.Mock(); self.live.maintenance.return_value = {'state': 'restoring'}
        self.service.retained_restores = mock.Mock(return_value=self.legacy)
        self.service.core_live_restorations = mock.Mock(return_value=self.live)

    def marker(self, schema=SCHEMA, **changes):
        value = {'schema': schema, 'id': ID, 'root': str(self.root), 'context': 'fixture', **changes}
        S.HOST.AUTHORITY.atomic(S.HOST.restore_selector_path(self.root), S.CONTROLLER_IDENTITY.canonical(value))

    def test_live_marker_blocks_all_unowned_host_mutations_and_accepts_only_its_distinct_context(self):
        self.marker()
        with self.assertRaises(ValueError):
            S.HOST.require_no_capture_fence(self.root)
        for context, identifier, allowed in [(S.HOST.RESTORE_TRANSACTION, ID, False),
                (S.HOST.CORE_LIVE_TRANSACTION, OTHER, False), (S.HOST.CORE_LIVE_TRANSACTION, ID, True)]:
            with self.subTest(context=context.name, identifier=identifier):
                token = context.set(identifier)
                try:
                    if allowed:
                        with S.HOST.host_lock(self.root):
                            pass
                    else:
                        with self.assertRaises(ValueError):
                            with S.HOST.host_lock(self.root):
                                self.fail('unowned host operation admitted')
                finally:
                    context.reset(token)

    def test_legacy_marker_keeps_its_original_context_and_does_not_accept_live_context(self):
        self.marker('orbis.retained-restore-transaction.v1')
        token = S.HOST.CORE_LIVE_TRANSACTION.set(ID)
        try:
            with self.assertRaises(ValueError): S.HOST.require_no_capture_fence(self.root)
        finally: S.HOST.CORE_LIVE_TRANSACTION.reset(token)
        token = S.HOST.RESTORE_TRANSACTION.set(ID)
        try: S.HOST.require_no_capture_fence(self.root)
        finally: S.HOST.RESTORE_TRANSACTION.reset(token)
        self.assertEqual(self.service.restore_maintenance(), {'state': 'idle'})
        self.service.core_live_restorations.assert_not_called()

    def test_absent_new_store_does_not_require_new_features_on_an_older_installation(self):
        self.assertEqual(self.service.restore_maintenance(), {'state': 'idle'})
        self.service.core_live_restorations.assert_not_called()

    def test_live_marker_dispatches_status_and_startup_without_legacy_recovery_or_replay(self):
        self.marker()
        self.assertEqual(self.service.restore_maintenance(), {'state': 'restoring'})
        self.service.resume_pending_retained_restore()
        self.live.resume_pending.assert_called_once_with()
        self.live.begin.assert_not_called()
        self.service.retained_restores.assert_not_called()

    def test_lost_marker_with_existing_live_store_still_checks_recovery(self):
        (self.state / 'core-live-restorations').mkdir(mode=0o700)
        self.live.maintenance.return_value = {'state': 'recovery'}
        self.assertEqual(self.service.restore_maintenance(), {'state': 'recovery'})
        self.service.resume_pending_retained_restore()
        self.live.resume_pending.assert_called_once_with()
        self.service.retained_restores.assert_not_called()

    def test_invalid_store_or_marker_never_silently_becomes_idle(self):
        (self.state / 'core-live-restorations').symlink_to(self.root, target_is_directory=True)
        self.assertEqual(self.service.restore_maintenance(), {'state': 'checking'})
        self.service.core_live_restorations.assert_not_called()
        (self.state / 'core-live-restorations').unlink()
        for changes in [{'schema': 'unknown'}, {'context': 'foreign'}, {'id': '../invalid'}, {'extra': True}]:
            with self.subTest(changes=changes):
                self.marker(**changes)
                self.assertEqual(self.service.restore_maintenance(), {'state': 'checking'})
                self.service.resume_pending_retained_restore()
                self.live.begin.assert_not_called()
                self.live.resume_pending.assert_not_called()

    def test_corrupt_or_unavailable_live_status_keeps_the_recovery_hold(self):
        self.marker()
        self.live.maintenance.side_effect = ValueError('private data must not surface')
        self.assertEqual(self.service.restore_maintenance(), {'state': 'checking'})

    def test_factory_selects_one_genuine_service_without_starting_a_job(self):
        service = object.__new__(S.HostService)
        service.core_live_restoration_factory_lock = threading.Lock()
        service.core_live_restoration_service = None
        service.core_live_restoration_module = None
        service.core_restoration_reviews = mock.Mock()
        manager = mock.Mock()
        module = SimpleNamespace(CoreLiveRestorationService=mock.Mock(return_value=manager))
        with mock.patch.object(S, 'load_script', return_value=module) as loader:
            self.assertIs(service.core_live_restorations(), manager)
            self.assertIs(service.core_live_restorations(), manager)
        loader.assert_called_once_with('orbis-host-core-live-restoration.py', 'orbis_core_live_restoration_for_service')
        module.CoreLiveRestorationService.assert_called_once_with(service)
        manager.begin.assert_not_called()


class LiveRoutesTests(unittest.TestCase):
    def handler(self, action='status', body=None):
        value = {'id': ID, 'actor': {'ownerId': 1, 'sessionBinding': 'a'*64, 'securityBinding': 'b'*64}} if body is None else body
        raw = json.dumps(value).encode()
        handler = object.__new__(S.Handler)
        handler.path = '/v1/core-live-restoration/' + action
        handler.connection = mock.Mock()
        handler.server = mock.Mock()
        handler.headers = Message(); handler.headers['Content-Type'] = 'application/json'; handler.headers['Content-Length'] = str(len(raw))
        handler.rfile = io.BytesIO(raw)
        handler.send_json = mock.Mock()
        manager = handler.server.service.core_live_restorations.return_value
        getattr(manager, action).return_value = {'version': 1, 'id': ID, 'phase': 'checking', 'activation': False}
        return handler, value, manager

    def test_only_closed_private_actions_are_dispatched(self):
        for action in ('admit', 'begin', 'status', 'wait', 'abort'):
            with self.subTest(action=action):
                handler, request, manager = self.handler(action)
                with mock.patch.object(S, 'trusted_capture_peer', return_value=True): handler.do_POST()
                getattr(manager, action).assert_called_once_with(request, privileged_peer=True)
                self.assertEqual(handler.send_json.call_args.args[0], 200)
                self.assertTrue(handler.close_connection)

    def test_untrusted_peer_is_refused_before_any_job_lookup(self):
        handler, _, _ = self.handler()
        with mock.patch.object(S, 'trusted_capture_peer', return_value=False): handler.do_POST()
        self.assertEqual(handler.send_json.call_args.args[0], 403)
        handler.server.service.core_live_restorations.assert_not_called()

    def test_malformed_headers_actions_and_truncated_bodies_do_not_invoke_the_manager(self):
        for change in ('action', 'length', 'too-large', 'duplicate-length', 'duplicate-type', 'chunked', 'encoded', 'type', 'truncated'):
            with self.subTest(change=change):
                handler, _, _ = self.handler()
                if change == 'action': handler.path = '/v1/core-live-restoration/activate'
                if change in ('length', 'too-large'):
                    handler.headers.replace_header('Content-Length', 'invalid' if change == 'length' else '16385')
                if change == 'duplicate-length': handler.headers['Content-Length'] = handler.headers['Content-Length']
                if change == 'duplicate-type': handler.headers['Content-Type'] = 'application/json'
                if change == 'chunked': handler.headers['Transfer-Encoding'] = 'chunked'
                if change == 'encoded': handler.headers['Content-Encoding'] = 'gzip'
                if change == 'type': handler.headers.replace_header('Content-Type', 'text/plain')
                if change == 'truncated': handler.rfile = io.BytesIO(b'{')
                with mock.patch.object(S, 'trusted_capture_peer', return_value=True): handler.do_POST()
                self.assertEqual(handler.send_json.call_args.args[0], 409)
                handler.server.service.core_live_restorations.assert_not_called()

    def test_private_errors_do_not_leak_to_the_responder(self):
        handler, _, manager = self.handler()
        manager.status.side_effect = ValueError('private path and credentials')
        with mock.patch.object(S, 'trusted_capture_peer', return_value=True): handler.do_POST()
        self.assertEqual(handler.send_json.call_args.args[0], 409)
        self.assertNotIn('credentials', json.dumps(handler.send_json.call_args.args[1]))


if __name__ == '__main__': unittest.main()
