"""Real checked reconciliation and source snapshot; engine/Root ownership are fixtures."""
import copy
from contextlib import contextmanager
from email.message import Message
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module


V = load('orbis-host-core-restoration-review.py', 'core_restoration_review_test')
F = load('test_orbis_host_core_reconciliation_service.py', 'core_review_reconciliation_fixture')
M = load('orbis-host-retained-restore.py', 'core_review_retained_manager')
ID = '6af11531-ea76-468d-a641-8ed6bd14c8ea'
OTHER = '6af11531-ea76-468d-a641-8ed6bd14c8eb'


class RestorationReviewTests(unittest.TestCase):
    def setUp(self):
        self.fixture = f = F.ReconciliationServiceTests()
        f.setUp()
        self.addCleanup(f.doCleanups)
        f.finish()
        self.service, self.reconciliation, self.enrollment = f.service, f.manager, f.enrollment
        service = self.service
        service.core_clean_target_reconciliations = lambda: self.reconciliation
        service.core_reconciliation_module = F.S
        # The existing fixture supplies synthetic engine boundaries. Preserve its
        # exact capability identity while exercising the production enrollment reader.
        self.enrollment.__class__ = F.S.P.F.L.BASE.E.CorePortableEnrollment
        self.enrollment.service, self.enrollment.host = service, service.HOST
        self.enrollment.a.protected_file = F.A.protected_file
        self.enterContext(mock.patch.object(F.A, 'OWNER', os.geteuid()))
        service.HOST.AUTHORITY = self.enrollment.a
        service.HOST.IDENTITY = SimpleNamespace(PUBLICATION=self.enrollment.P, FILES={'docker-compose.yml', '.env'})
        selected = self.enrollment.root / 'synthetic-existing-host-lock'
        self.enrollment.a.LAYOUT = SimpleNamespace(selected_path=lambda *args: selected, legacy_path=lambda *args: selected)
        self.reference = 'ghcr.io/twentylines/orbis@sha256:' + '3' * 64
        service.HOST.controller_reference = lambda *args: self.reference
        service.HOST.retained_state = lambda *args: False
        service.HOST.file_digest = lambda *args: '4' * 64
        service.HOST.enrollment_bytes = lambda *args: b'{"private":"synthetic enrollment"}'
        service.current_manifest = lambda: {'schema': 'orbis.release.v1', 'image': 'ghcr.io/twentylines/orbis',
            'tag': 'v0.8.0-beta.3', 'commit': 'a' * 40, 'digest': 'sha256:' + '3' * 64,
            'runtipiCompatibility': '4.10.1'}
        service.proxy_host_identity = lambda: {'descriptor': {'schema': 'orbis.proxy-host-identity-policy.v1',
            'policy': 'preserve-live-proxy-identity.v1', 'sha256': '5' * 64}}
        self.retained = M.RestoreManager(service)
        self.runtime = self.retained.runtime
        service.retained_restores = lambda: self.retained
        service.retained_restore_manager = self.retained
        service.retained_restore_manager_type = M.RestoreManager
        service.retained_restore_runtime_type = type(self.runtime)
        self.old_runtime = f.fixture.runtime
        self.raw = {'Id': '6' * 64, 'Image': self.old_runtime.controller, 'Name': '/runtipi',
            'HostConfig': {'Privileged': False, 'AutoRemove': False},
            'Mounts': [{'Type': 'bind', 'Source': '/synthetic/private-data', 'Destination': '/data', 'RW': True}],
            'NetworkSettings': {'Networks': {}},
            'Config': {'Image': self.reference, 'Env': ['PASSWORD=synthetic-review-secret'], 'Labels': {
                'com.docker.compose.project': 'runtipi', 'com.docker.compose.service': 'runtipi',
                'com.docker.compose.project.working_dir': str(service.root)}},
            'State': {'Running': True, 'Restarting': False, 'Paused': False, 'StartedAt': 'current-start',
                      'Health': {'Status': 'healthy'}}}
        def inspect(identifier):
            return copy.deepcopy(self.raw) if identifier == 'runtipi' else self.old_runtime.inspect(identifier)
        self.runtime.inspect = mock.Mock(side_effect=inspect)
        current_definition = type(self.runtime).definition.__get__(self.runtime)
        for name in ('image', 'definition', 'never_started', 'check_intent', 'engine', 'bounded_output'):
            if hasattr(self.old_runtime, name):
                setattr(self.runtime, name, getattr(self.old_runtime, name))
        self.runtime.definition = lambda raw: current_definition(raw) if raw.get('Id') == self.raw['Id'] else self.old_runtime.definition(raw)
        self.runtime.reader = mock.Mock()
        self.runtime.reader.socket.return_value = '/synthetic/docker.sock'
        self.runtime.reader._object.return_value = {'ID': 'synthetic-daemon'}
        self.runtime.require_capability = mock.Mock(return_value='7' * 64)
        self.runtime.overlay_preflight = mock.Mock(return_value={'proxyId': '8' * 64, 'staticSha256': '9' * 64})
        self.runtime.change = mock.Mock(side_effect=AssertionError('review cannot mutate runtime'))
        self.runtime.prepare_overlay = mock.Mock(side_effect=AssertionError('review cannot prepare'))
        self.enrollment.runtime = self.runtime
        self.review = V.CoreRestorationReview(service)
        self.request = {'id': ID, 'reconciliationId': F.ID, 'actor': copy.deepcopy(F.ACTOR), 'action': V.ACTION}
        self.observe = {'id': ID, 'actor': copy.deepcopy(F.ACTOR)}
        self.calls = copy.deepcopy(self.old_runtime.calls)

    def perform(self):
        return self.review.review(self.request, privileged_peer=True)

    def status(self):
        return self.review.status(self.observe, privileged_peer=True)

    def test_actual_checked_reconciliation_and_current_snapshot_produce_only_private_observation(self):
        result = self.perform()
        self.assertEqual(result['phase'], 'installation-observed')
        self.assertTrue(result['reviewAvailable'])
        self.assertEqual(result, self.status())
        admission = self.review._admission(ID, F.ACTOR)
        record = self.review._observation(admission)
        self.assertEqual(record['snapshot']['container']['Config']['Env'], ['PASSWORD=synthetic-review-secret'])
        self.assertEqual(record['snapshot']['container']['Id'], self.raw['Id'])
        self.assertEqual(record['snapshot']['proxyHostIdentity']['policy'], 'preserve-live-proxy-identity.v1')
        self.assertEqual(record['reconciliation']['receiptSha256'], self.reconciliation._read(F.ID, 'complete.json')['receiptSha256'])
        self.assertEqual(set(result), {'version', 'id', 'reconciliationId', 'phase', 'reviewAvailable', *V.FLAGS})
        encoded = json.dumps(result)
        for private in ('PASSWORD', 'synthetic-review-secret', str(self.enrollment.root), 'snapshot', 'sessionBinding', 'securityBinding', 'Sha256'):
            self.assertNotIn(private, encoded)
        self.assertFalse(any(result[key] for key in ('activation', 'environmentProved', 'restoreAuthority', 'sourceWrites',
                                                     'logicalConsistencyProved', 'writerQuiescenceProved')))
        self.assertEqual(self.old_runtime.calls, self.calls)
        self.runtime.change.assert_not_called()
        self.runtime.prepare_overlay.assert_not_called()

    def test_context_bound_checked_handoff_expires_and_rejects_plain_dict_or_bool(self):
        self.perform()
        with self.review._checked_review(ID, F.ACTOR) as checked:
            self.assertIs(type(checked), V.CheckedRestorationReview)
            with checked.guard():
                self.assertIs(checked.reconciliation.owner, self.reconciliation)
        with self.assertRaises(ValueError), checked.guard():
            pass
        for fake in (True, {}, vars(checked.reconciliation)):
            with self.subTest(fake=type(fake).__name__), self.assertRaises(ValueError):
                self.review._binding(fake)

    def test_missing_status_never_creates_admission_or_observation(self):
        with self.assertRaises(FileNotFoundError):
            self.status()
        self.assertFalse(self.review._base().exists())
        self.runtime.inspect.assert_not_called()

    def test_peer_root_exact_uuid_action_and_actor_guards_precede_observation(self):
        for request, peer in ((self.request, False), ({**self.request, 'action': 'activate'}, True),
            ({**self.request, 'snapshot': {}}, True), ({**self.request, 'id': '../escape'}, True),
            ({**self.request, 'id': '6af11531-ea76-568d-a641-8ed6bd14c8ea'}, True)):
            with self.subTest(request=request), self.assertRaises(ValueError):
                self.review.review(request, privileged_peer=peer)
        with mock.patch.object(F.S.P.F.I, 'require_root', side_effect=ValueError('not root')):
            with self.assertRaises(ValueError):
                self.perform()
        self.assertFalse(self.review._base().exists())
        self.runtime.inspect.assert_not_called()
        self.perform()
        with self.assertRaises(ValueError):
            self.review.status({'id': ID, 'actor': {**F.ACTOR, 'sessionBinding': 'f' * 64}}, privileged_peer=True)

    def test_live_restart_proxy_reset_and_publication_drift_invalidate_observation(self):
        self.perform()
        self.raw['State']['StartedAt'] = 'changed-start'
        self.assertEqual(self.status()['phase'], 'recovery-required')
        self.raw['State']['StartedAt'] = 'current-start'
        self.runtime.overlay_preflight.return_value['staticSha256'] = '0' * 64
        self.assertEqual(self.status()['phase'], 'recovery-required')
        self.runtime.overlay_preflight.return_value['staticSha256'] = '9' * 64
        original = self.runtime.reset_authority_snapshot
        self.runtime.reset_authority_snapshot = lambda raw: {'schema': 'synthetic changed reset authority'}
        reset_module = type(self.runtime).source_snapshot.__globals__['RESET']
        with mock.patch.object(reset_module, 'require_docker_isolation'):
            self.assertEqual(self.status()['phase'], 'recovery-required')
        self.runtime.reset_authority_snapshot = original
        self.service.current_manifest = lambda: {'changed': 'publication'}
        self.assertEqual(self.status()['phase'], 'recovery-required')
        self.runtime.change.assert_not_called()

    def test_drift_during_observation_leaves_partial_record_without_replay(self):
        original = self.runtime.source_snapshot
        count = 0
        def snapshot():
            nonlocal count
            count += 1
            result = original()
            if count == 1:
                self.raw['State']['StartedAt'] = 'changed-after-first-observation'
            return result
        with mock.patch.object(self.runtime, 'source_snapshot', side_effect=snapshot):
            with self.assertRaises(ValueError):
                self.perform()
        self.assertTrue((self.review._directory(ID) / 'admission.json').exists())
        self.assertFalse((self.review._directory(ID) / 'observation.json').exists())
        self.assertEqual(self.status()['phase'], 'recovery-required')
        self.assertEqual(self.perform()['phase'], 'recovery-required')

    def test_active_failed_unknown_reconciliation_cannot_create_a_review(self):
        with self.reconciliation._condition:
            self.reconciliation._active[F.ID] = {'token': object()}
        self.assertEqual(self.perform()['phase'], 'checking')
        self.assertFalse(self.review._base().exists())
        self.reconciliation._active.clear()
        completion = self.reconciliation._directory(F.ID) / 'complete.json'
        completion.unlink()
        with self.assertRaises(ValueError):
            self.perform()
        self.assertFalse(self.review._base().exists())

    def test_current_actor_record_generation_and_target_claim_are_freshly_checked(self):
        self.perform()
        claim = self.reconciliation._claims() / (F.PREPARATION + '.json')
        claim.chmod(0o600)
        claim.write_bytes(b'{}')
        self.assertEqual(self.status()['phase'], 'recovery-required')
        self.assertFalse(self.status()['reviewAvailable'])

    def test_current_generation_drift_and_failed_reconciliation_refuse(self):
        self.perform()
        self.fixture.fixture.broker.installed_selection.installation_sha256 = '0' * 64
        self.assertEqual(self.status()['phase'], 'recovery-required')
        self.fixture.fixture.broker.installed_selection.installation_sha256 = 'd' * 64
        admission = self.reconciliation._admission(F.ID, F.ACTOR)
        self.reconciliation._failure(admission, True)
        self.assertEqual(self.status()['phase'], 'recovery-required')

    def test_native_reconciliation_record_actor_drift_never_relabels_the_observation(self):
        self.perform()
        path = self.fixture.fixture.manager.directory(F.ID) / 'job.json'
        record = json.loads(path.read_bytes())
        record['actor']['sessionBinding'] = 'f' * 64
        path.chmod(0o600)
        path.write_bytes(self.enrollment.P.canonical(record))
        self.assertEqual(self.status()['phase'], 'recovery-required')
        self.assertFalse(self.status()['reviewAvailable'])

    def test_lost_private_record_publication_acknowledgement_is_a_hold(self):
        immutable = self.enrollment.immutable
        def lost(path, body):
            immutable(path, body)
            if path.name == 'observation.json':
                raise OSError('synthetic lost private observation acknowledgement')
        with mock.patch.object(self.enrollment, 'immutable', side_effect=lost):
            with self.assertRaises(OSError):
                self.perform()
        self.assertTrue((self.review._directory(ID) / 'observation.json').exists())
        self.assertEqual(self.status()['phase'], 'recovery-required')
        self.assertEqual(self.perform()['phase'], 'recovery-required')

    def test_record_tamper_and_symlink_do_not_create_or_refresh_authority(self):
        self.perform()
        observation = self.review._directory(ID) / 'observation.json'
        observation.chmod(0o600)
        observation.write_bytes(b'{}')
        self.assertEqual(self.status()['phase'], 'recovery-required')
        observation.unlink()
        observation.symlink_to(self.review._directory(ID) / 'admission.json')
        self.assertEqual(self.status()['phase'], 'recovery-required')

    def test_exclusion_contention_returns_checking_and_preserves_original_record(self):
        self.perform()
        body = (self.review._directory(ID) / 'observation.json').read_bytes()
        with self.service.lock:
            self.assertEqual(self.status()['phase'], 'checking')
        with self.fixture.host_lock(self.service.root):
            self.assertEqual(self.status()['phase'], 'checking')
        self.assertEqual((self.review._directory(ID) / 'observation.json').read_bytes(), body)

    def test_exact_graph_rejects_replaced_enrollment_runtime_owner_or_service(self):
        for owner, attribute, replacement in ((self.reconciliation, 'service', object()),
            (self.retained, 'service', object()), (self.runtime, 'manager', object()),
            (self.enrollment, 'runtime', {}), (self.reconciliation.preparation, 'enrollment', {})):
            original = getattr(owner, attribute)
            setattr(owner, attribute, replacement)
            try:
                with self.subTest(attribute=attribute), self.assertRaises((ValueError, AttributeError)):
                    V.CoreRestorationReview(self.service)
            finally:
                setattr(owner, attribute, original)


class ReviewRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.host = load('orbis-host-service.py', 'restoration_review_route_host')

    def handler(self, action):
        request = {'id': ID, 'actor': F.ACTOR}
        if action == 'review':
            request.update(reconciliationId=F.ID, action=V.ACTION)
        body = json.dumps(request).encode()
        handler = object.__new__(self.host.Handler)
        handler.path = '/v1/core-restoration-review/' + action
        handler.headers = Message()
        handler.headers['Content-Type'] = 'application/json'
        handler.headers['Content-Length'] = str(len(body))
        handler.connection, handler.server, handler.send_json = mock.Mock(), mock.Mock(), mock.Mock()
        handler.rfile = io.BytesIO(body)
        self.enterContext(mock.patch.object(self.host, 'trusted_capture_peer', return_value=True))
        return handler, request

    def test_routes_are_real_separate_observation_calls_with_no_mutation_endpoint(self):
        for action in ('review', 'status'):
            handler, request = self.handler(action)
            manager = handler.server.service.core_restoration_reviews.return_value
            result = {'phase': 'installation-observed', 'restoreAuthority': False}
            getattr(manager, action).return_value = result
            handler.do_POST()
            getattr(manager, action).assert_called_once_with(request, privileged_peer=True)
            handler.send_json.assert_called_once_with(200, result)
            self.assertEqual([call.args[0] for call in handler.connection.settimeout.call_args_list], [15, 330])
            handler.server.service.core_clean_target_preparations.assert_not_called()

    def test_peer_bounded_framing_and_mutation_action_rejections_precede_reads_and_factory(self):
        for kind in ('peer', 'activate', 'prepare', 'promote', 'rollback', 'review?x=1', 'truncated', 'large',
                     'transfer', 'encoding', 'type', 'duplicate-length', 'duplicate-type'):
            with self.subTest(kind=kind):
                handler, _ = self.handler('review')
                if kind in {'activate', 'prepare', 'promote', 'rollback', 'review?x=1'}:
                    handler.path = '/v1/core-restoration-review/' + kind
                if kind in {'truncated', 'large'}:
                    handler.headers.replace_header('Content-Length', str(int(handler.headers['Content-Length']) + 1) if kind == 'truncated' else '16385')
                if kind in {'transfer', 'encoding'}:
                    handler.headers['Transfer-Encoding' if kind == 'transfer' else 'Content-Encoding'] = 'unsupported'
                if kind == 'type':
                    handler.headers.replace_header('Content-Type', 'text/plain')
                if kind in {'duplicate-length', 'duplicate-type'}:
                    field = 'Content-Length' if kind == 'duplicate-length' else 'Content-Type'
                    handler.headers[field] = handler.headers[field]
                if kind != 'truncated':
                    handler.rfile = mock.Mock()
                with mock.patch.object(self.host, 'trusted_capture_peer', return_value=kind != 'peer'):
                    handler.do_POST()
                if kind != 'truncated':
                    handler.rfile.read.assert_not_called()
                handler.server.service.core_restoration_reviews.assert_not_called()
                self.assertEqual(handler.send_json.call_args.args[0], 409)

    def test_generic_route_error_never_serializes_snapshot_or_secret_text(self):
        handler, _ = self.handler('review')
        handler.server.service.core_restoration_reviews.return_value.review.side_effect = ValueError('synthetic-review-secret /private/path')
        handler.do_POST()
        self.assertEqual(handler.send_json.call_args.args[0], 409)
        self.assertNotIn('synthetic-review-secret', json.dumps(handler.send_json.call_args.args[1]))
        self.assertNotIn('/private/path', json.dumps(handler.send_json.call_args.args[1]))

    def test_review_factory_retains_service_and_installed_helper_closure(self):
        service = object.__new__(self.host.HostService)
        service.core_restoration_review_factory_lock = threading.Lock()
        service.core_restoration_review_service = None
        service.core_clean_target_reconciliations = mock.Mock()
        module = mock.Mock()
        with mock.patch.object(self.host, 'load_script', return_value=module):
            first = service.core_restoration_reviews()
            self.assertIs(first, service.core_restoration_reviews())
        module.CoreRestorationReview.assert_called_once_with(service)
        setup = load('orbis-host-service-setup.py', 'restoration_review_setup_test')
        files, _ = setup.source_files(Path(__file__).parent)
        self.assertIn('orbis-host-core-restoration-review.py', {path.name for path in files})


if __name__ == '__main__':
    unittest.main()
