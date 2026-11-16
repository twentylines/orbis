"""Fresh inspection grants over actual enrollment files; runtime and browser auth are separate gates."""
import copy
from contextlib import nullcontext
from email.message import Message
import importlib.util
import io
import json
from pathlib import Path
import threading
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


I = load('orbis-host-core-restore-inspection.py', 'core_restore_inspection_test')
F = load('test_orbis_host_core_portable_enrollment.py', 'core_restore_inspection_fixtures')
ID = 'a71c77d2-f420-440e-951b-083209514e72'


class InspectionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = F.EnrollmentTests('test_authenticated_worker_destination_enrollment_and_nonreplayable_approval')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.runtime.source['coordinatorCapabilitySha256'] = '8' * 64
        self.fixture.prepared()
        self.fixture.manager.approve(self.fixture.approval, privileged_peer=True)
        self.enrollment = self.fixture.manager
        compatibility = self.enrollment.record(F.ID)['checkpointReview']['compatibility']
        def image(identifier):
            self.assertEqual(identifier, self.fixture.runtime.source['imageId'])
            return {'Id': identifier, 'Os': 'linux', 'Architecture': compatibility['architecture']}
        self.fixture.runtime.image = image
        self.manager = I.CoreRestoreInspection(self.fixture.service, self.enrollment)
        self.request = {'id': ID, 'enrollmentId': F.ID, 'actor': copy.deepcopy(F.ACTOR)}

    def prepared(self):
        prepared = self.manager.prepare(self.request, privileged_peer=True)
        self.approval = {'id': ID, 'actor': copy.deepcopy(F.ACTOR), 'reviewSha256': prepared['reviewSha256'],
                         'approvalNonce': prepared['approvalNonce'], 'executionConsent': prepared['executionConsent'],
                         'action': 'authorize-core-inspection-only'}
        return prepared

    def test_exact_inspection_only_permit_binds_source_destination_actor_and_never_executes(self):
        prepared = self.prepared()
        self.assertEqual(prepared['legacyRestrictions'], I.RESTRICTIONS)
        self.assertFalse(prepared['restoreSupported'])
        self.assertFalse(prepared['activationAuthorized'])
        self.assertFalse(prepared['workerExecutionAvailable'])
        evidence = self.manager.record(ID)['evidence']
        self.assertEqual(evidence['source']['sourceOwnerId'], 1)
        self.assertEqual(evidence['source']['ownerId'], 17)
        self.assertEqual(evidence['destination']['coordinatorCapabilitySha256'], '8' * 64)
        self.assertEqual(evidence['source']['payload']['files']['checkpoint.tar'], self.enrollment.record(F.ID)['review']['payload']['files']['checkpoint.tar'])
        result = self.manager.approve(self.approval, privileged_peer=True)
        self.assertEqual(result['phase'], 'inspection-authorized')
        self.assertFalse(result['activationAuthorized'])
        self.assertFalse(result['workerExecutionAvailable'])
        permit = self.enrollment.json(self.manager.directory(ID) / 'permit.json')
        self.assertEqual(permit['schema'], 'orbis.core-restore-inspection-permit.v1')
        self.assertEqual(permit['actor'], F.ACTOR)
        self.assertEqual(permit['evidenceSha256'], self.manager.digest(evidence))
        self.assertEqual(permit['executionConsent'], prepared['executionConsent'])
        self.assertEqual(permit['scope'], 'inspection-only')
        self.assertNotIn('token', permit)
        self.assertNotIn('password', permit)
        self.assertEqual(self.fixture.driver.calls, 1)
        self.assertEqual(self.manager.status({'id': ID, 'actor': F.ACTOR}, privileged_peer=True), result)
        with self.assertRaises(ValueError):
            self.manager.approve(self.approval, privileged_peer=True)
        with self.assertRaises(FileExistsError):
            self.manager.prepare(self.request, privileged_peer=True)

    def test_every_exact_execution_consent_field_and_legacy_grant_reuse_refuse(self):
        self.prepared()
        for key in self.approval['executionConsent']:
            changed = copy.deepcopy(self.approval)
            changed['executionConsent'][key] = 'changed'
            with self.subTest(field=key), self.assertRaises(I.InspectionError):
                self.manager.approve(changed, privileged_peer=True)
        changed = {**self.approval, 'action': 'enroll-core-portable-point'}
        with self.assertRaises(I.InspectionError):
            self.manager.approve(changed, privileged_peer=True)
        changed = copy.deepcopy(self.approval)
        changed.pop('executionConsent')
        with self.assertRaises(I.InspectionError):
            self.manager.approve(changed, privileged_peer=True)
        self.assertFalse((self.manager.directory(ID) / 'permit.json').exists())

    def test_claimed_source_path_owner_image_and_missing_privileged_peer_refuse(self):
        for extra in ('path', 'sourceOwnerId', 'imageId', 'grant'):
            with self.subTest(field=extra), self.assertRaises(I.InspectionError):
                self.manager.prepare({**self.request, extra: 'caller claim'}, privileged_peer=True)
        with self.assertRaises(I.InspectionError):
            self.manager.prepare(self.request)
        request = copy.deepcopy(self.request)
        request['actor']['ownerId'] = 1
        with self.assertRaises(I.InspectionError):
            self.manager.prepare(request, privileged_peer=True)

    def test_changed_destination_authority_or_actor_cannot_redeem_prepared_consent(self):
        self.prepared()
        changed = copy.deepcopy(self.approval)
        changed['actor']['sessionBinding'] = '0' * 64
        with self.assertRaises(I.InspectionError):
            self.manager.approve(changed, privileged_peer=True)
        self.fixture.runtime.source['coordinatorCapabilitySha256'] = '0' * 64
        with self.assertRaises(I.InspectionError):
            self.manager.approve(self.approval, privileged_peer=True)
        self.assertFalse((self.manager.directory(ID) / 'permit.json').exists())

    def test_changed_catalog_even_with_same_controller_refuses(self):
        self.prepared()
        extra = self.fixture.library / 'points' / 'd813f20b-7aae-43c7-a999-c9393686add9'
        extra.mkdir(mode=0o700)
        (extra / 'point.json').write_bytes(self.enrollment.P.canonical({'archiveBytes': 0, 'ownerId': 17}))
        (extra / 'point.json').chmod(0o600)
        with self.assertRaises(I.InspectionError):
            self.manager.approve(self.approval, privileged_peer=True)

    def test_changed_plaintext_and_missing_published_origin_refuse(self):
        self.prepared()
        payload = self.enrollment.directory(F.ID) / 'work/payload/checkpoint.tar'
        payload.chmod(0o600)
        payload.write_bytes(b'changed source')
        with self.assertRaises(ValueError):
            self.manager.approve(self.approval, privileged_peer=True)

    def test_retained_index_is_required_instead_of_a_caller_or_legacy_receipt(self):
        (self.enrollment.state / 'core-portable-points' / (F.POINT + '.json')).unlink()
        with self.assertRaises(FileNotFoundError):
            self.manager.prepare(self.request, privileged_peer=True)

    def test_wrong_platform_or_missing_current_coordinator_capability_refuses(self):
        original = self.fixture.runtime.image
        self.fixture.runtime.image = lambda identifier: {**original(identifier), 'Architecture': 'unsupported'}
        with self.assertRaises(I.InspectionError):
            self.manager.prepare(self.request, privileged_peer=True)
        self.fixture.runtime.image = original
        self.fixture.runtime.source.pop('coordinatorCapabilitySha256')
        with self.assertRaises(I.InspectionError):
            self.manager.prepare(self.request, privileged_peer=True)

    def test_expired_consent_and_permit_are_never_current_authority(self):
        self.prepared()
        with mock.patch.object(I.time, 'time', return_value=2**45):
            with self.assertRaises(I.InspectionError):
                self.manager.approve(self.approval, privileged_peer=True)
        self.manager.approve(self.approval, privileged_peer=True)
        with mock.patch.object(I.time, 'time', return_value=2**45):
            status = self.manager.status({'id': ID, 'actor': F.ACTOR}, privileged_peer=True)
        self.assertEqual(status['phase'], 'expired')
        self.assertNotIn('permitSha256', status)
        self.assertFalse(status['workerExecutionAvailable'])

    def test_interrupted_permit_publication_is_a_hold_without_approval_replay(self):
        self.prepared()
        original = self.enrollment.immutable
        def interrupt(path, body):
            original(path, body)
            if path.name == 'permit.json':
                raise OSError('synthetic interruption after immutable permit publication')
        with mock.patch.object(self.enrollment, 'immutable', side_effect=interrupt):
            with self.assertRaises(OSError):
                self.manager.approve(self.approval, privileged_peer=True)
        self.assertEqual(self.manager.record(ID)['phase'], 'recovery-required')
        self.assertNotIn('approvalNonce', self.manager.record(ID))
        self.assertEqual(self.manager.status({'id': ID, 'actor': F.ACTOR}, privileged_peer=True)['phase'], 'recovery-required')
        with self.assertRaises(I.InspectionError):
            self.manager.approve(self.approval, privileged_peer=True)
        self.assertEqual(self.fixture.driver.calls, 1)

    def test_approval_expiring_during_evidence_reads_cannot_issue_a_new_permit(self):
        self.prepared()
        now = I.time.time()
        current = self.manager.require_current
        with mock.patch.object(I.time, 'time', return_value=now) as clock:
            def delayed(record):
                current(record)
                clock.return_value = now + 301
            with mock.patch.object(self.manager, 'require_current', side_effect=delayed):
                with self.assertRaises(I.InspectionError):
                    self.manager.approve(self.approval, privileged_peer=True)
        self.assertFalse((self.manager.directory(ID) / 'permit.json').exists())
        self.assertEqual(self.manager.record(ID)['phase'], 'awaiting-approval')

    def test_existing_core_v1_cannot_guess_effective_source_environment_for_execution(self):
        self.prepared()
        self.manager.approve(self.approval, privileged_peer=True)
        with self.assertRaises(I.InspectionError) as failure:
            self.manager.claim_execution(ID, F.ACTOR)
        self.assertEqual(failure.exception.reason, 'source-environment-unavailable')
        self.assertEqual(self.manager.record(ID)['phase'], 'inspection-authorized')
        self.assertFalse((self.manager.directory(ID) / 'execution').exists())
        self.assertNotIn('inspectionWorkers', self.manager.record(ID))

    def test_internal_claim_rejects_a_changed_actor_without_reusing_install_privilege(self):
        self.prepared()
        self.manager.approve(self.approval, privileged_peer=True)
        actor = {**F.ACTOR, 'sessionBinding': '0' * 64}
        with self.assertRaises(I.InspectionError):
            self.manager.claim_execution(ID, actor)
        self.assertEqual(self.manager.record(ID)['phase'], 'inspection-authorized')


class InspectionRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = load('orbis-host-service.py', 'core_inspection_route_fixture')

    def handler(self, action, body):
        encoded = json.dumps(body).encode()
        handler = object.__new__(self.service.Handler)
        handler.path = '/v1/core-restore-inspection/' + action
        handler.headers = {'Content-Type': 'application/json', 'Content-Length': str(len(encoded))}
        handler.connection = mock.Mock()
        handler.rfile = io.BytesIO(encoded)
        handler.send_json = mock.Mock()
        handler.server = mock.Mock()
        handler.server.service.lock = nullcontext()
        self.enterContext(mock.patch.object(self.service, 'trusted_capture_peer', return_value=True))
        self.enterContext(mock.patch.object(self.service.HOST, 'host_lock', return_value=nullcontext()))
        return handler

    def test_inspection_routes_use_only_the_distinct_locked_inspection_manager(self):
        for action in ('prepare', 'approve', 'status'):
            with self.subTest(action=action):
                request = {'id': ID, 'actor': F.ACTOR}
                handler = self.handler(action, request)
                manager = handler.server.service.core_restore_inspections.return_value
                getattr(manager, action).return_value = {'scope': 'inspection-only'}
                handler.do_POST()
                getattr(manager, action).assert_called_once_with(request, privileged_peer=True)
                handler.server.service.core_portable_enrollments.assert_not_called()
                handler.server.service.retained_restores.assert_not_called()
                handler.send_json.assert_called_once_with(200, {'scope': 'inspection-only'})

    def test_execute_activate_and_legacy_reconcile_are_not_inspection_routes(self):
        for action in ('execute', 'activate', 'reconcile'):
            with self.subTest(action=action):
                handler = self.handler(action, {'id': ID, 'actor': F.ACTOR})
                handler.do_POST()
                handler.server.service.core_restore_inspections.assert_not_called()
                self.assertEqual(handler.send_json.call_args.args[0], 409)

    def test_local_routes_use_the_separate_locked_installed_factory(self):
        for action in ('prepare', 'approve', 'status'):
            with self.subTest(action=action):
                request = {'id': ID, 'actor': F.ACTOR}
                handler = self.handler(action, request)
                handler.path = '/v1/core-local-restore-inspection/' + action
                manager = handler.server.service.core_local_restore_inspections.return_value
                getattr(manager, action).return_value = {'scope': 'inspection-only', 'restoreSupported': False}
                handler.do_POST()
                handler.server.service.core_local_restore_inspections.assert_called_once_with(action, request)
                getattr(manager, action).assert_called_once_with(request, privileged_peer=True)
                handler.server.service.core_restore_inspections.assert_not_called()
                handler.server.service.core_portable_enrollments.assert_not_called()
                self.assertEqual(handler.send_json.call_args.args[0], 200)

    def test_local_peer_and_action_guards_run_before_installed_factory(self):
        for action in ('execute', 'activate', 'reconcile'):
            handler = self.handler(action, {'id': ID, 'actor': F.ACTOR})
            handler.path = '/v1/core-local-restore-inspection/' + action
            handler.do_POST()
            handler.server.service.core_local_restore_inspections.assert_not_called()
            self.assertEqual(handler.send_json.call_args.args[0], 409)
        handler = self.handler('prepare', {'id': ID, 'actor': F.ACTOR})
        handler.path = '/v1/core-local-restore-inspection/prepare'
        with mock.patch.object(self.service, 'trusted_capture_peer', return_value=False):
            handler.do_POST()
        handler.server.service.core_local_restore_inspections.assert_not_called()
        self.assertEqual(handler.send_json.call_args.args[0], 409)

    def test_bootstrap_source_routes_use_only_the_new_coordinator(self):
        for action in ('prepare', 'approve', 'status'):
            with self.subTest(action=action):
                request = {'id': ID, 'actor': F.ACTOR}
                handler = self.handler(action, request)
                handler.path = '/v1/core-bootstrap-source-inspection/' + action
                coordinator = handler.server.service.core_bootstrap_source_inspections.return_value
                getattr(coordinator, action).return_value = {'version': 4, 'restoreSupported': False}
                handler.do_POST()
                getattr(coordinator, action).assert_called_once_with(request, privileged_peer=True)
                handler.server.service.core_local_restore_inspections.assert_not_called()
                handler.server.service.core_restore_inspections.assert_not_called()
                handler.server.service.core_portable_enrollments.assert_not_called()
                handler.send_json.assert_called_once_with(200, {'version': 4, 'restoreSupported': False})

    def test_bootstrap_source_peer_and_body_guards_precede_coordinator_lookup(self):
        for action in ('execute', 'activate', 'reconcile', 'cancel'):
            with self.subTest(action=action):
                handler = self.handler(action, {'id': ID, 'actor': F.ACTOR})
                handler.path = '/v1/core-bootstrap-source-inspection/' + action
                handler.do_POST()
                handler.server.service.core_bootstrap_source_inspections.assert_not_called()
                self.assertEqual(handler.send_json.call_args.args[0], 409)
        for kind in ('peer', 'truncated', 'transfer-encoding', 'content-type'):
            with self.subTest(kind=kind):
                handler = self.handler('prepare', {'id': ID, 'actor': F.ACTOR})
                handler.path = '/v1/core-bootstrap-source-inspection/prepare'
                if kind == 'truncated':
                    handler.headers['Content-Length'] = str(int(handler.headers['Content-Length']) + 1)
                elif kind == 'transfer-encoding':
                    handler.headers['Transfer-Encoding'] = 'chunked'
                elif kind == 'content-type':
                    handler.headers['Content-Type'] = 'text/plain'
                with mock.patch.object(self.service, 'trusted_capture_peer', return_value=kind != 'peer'):
                    handler.do_POST()
                handler.server.service.core_bootstrap_source_inspections.assert_not_called()
                self.assertEqual(handler.send_json.call_args.args[0], 409)

    def test_bootstrap_source_status_does_not_take_the_long_operation_lock(self):
        handler = self.handler('status', {'id': ID, 'actor': F.ACTOR})
        handler.path = '/v1/core-bootstrap-source-inspection/status'
        handler.server.service.lock = mock.MagicMock()
        handler.server.service.lock.__enter__.side_effect = AssertionError('status must remain readable')
        handler.do_POST()
        self.assertEqual(handler.send_json.call_args.args[0], 200)

    def test_bootstrap_source_coordinator_is_retained_for_live_ownership(self):
        service = object.__new__(self.service.HostService)
        service.bootstrap_inspection_factory_lock = threading.Lock()
        service.bootstrap_inspection_service = None
        module = mock.Mock()
        with mock.patch.object(self.service, 'load_script', return_value=module) as load_module:
            first = service.core_bootstrap_source_inspections()
            self.assertIs(service.core_bootstrap_source_inspections(), first)
        load_module.assert_called_once_with('orbis-host-core-bootstrap-inspection-service.py', 'orbis_core_bootstrap_inspection_for_service')
        module.BootstrapSourceInspectionService.assert_called_once_with(service)

    def test_existing_enrollment_route_keeps_its_separate_grant_meaning(self):
        request = {'id': F.ID, 'actor': F.ACTOR, 'action': 'enroll-core-portable-point'}
        handler = self.handler('approve', request)
        handler.path = '/v1/core-portable-enrollment/approve'
        manager = handler.server.service.core_portable_enrollments.return_value
        manager.approve.return_value = {'phase': 'enrolled', 'restoreSupported': False}
        handler.do_POST()
        manager.approve.assert_called_once_with(request, privileged_peer=True)
        handler.server.service.core_restore_inspections.assert_not_called()

    def test_clean_target_routes_are_separate_and_prepare_returns_accepted(self):
        for action in ('prepare', 'status', 'wait'):
            with self.subTest(action=action):
                request = {'id': ID, 'actor': F.ACTOR}
                handler = self.handler(action, request)
                handler.path = '/v1/core-clean-target-preparation/' + action
                coordinator = handler.server.service.core_clean_target_preparations.return_value
                result = {'phase': 'queued', 'preparationActive': True, 'activation': False}
                getattr(coordinator, action).return_value = result
                handler.do_POST()
                getattr(coordinator, action).assert_called_once_with(request, privileged_peer=True)
                handler.server.service.core_bootstrap_source_inspections.assert_not_called()
                handler.server.service.core_local_restore_inspections.assert_not_called()
                handler.server.service.core_restore_inspections.assert_not_called()
                handler.server.service.core_portable_enrollments.assert_not_called()
                handler.send_json.assert_called_once_with(202 if action == 'prepare' else 200, result)
                self.assertEqual([call.args[0] for call in handler.connection.settimeout.call_args_list],
                                 [15, 1900] if action == 'wait' else [15])

    def test_clean_target_guards_precede_coordinator_and_request_body_reads(self):
        for kind in ('peer', 'activate', 'approve', 'continue', 'truncated', 'transfer-encoding', 'content-type',
                     'empty', 'large', 'nondecimal', 'nonascii'):
            with self.subTest(kind=kind):
                handler = self.handler('prepare', {'id': ID, 'actor': F.ACTOR})
                handler.path = '/v1/core-clean-target-preparation/' + (kind if kind in {'activate', 'approve', 'continue'} else 'prepare')
                if kind == 'truncated':
                    handler.headers['Content-Length'] = str(int(handler.headers['Content-Length']) + 1)
                elif kind == 'transfer-encoding':
                    handler.headers['Transfer-Encoding'] = 'chunked'
                elif kind == 'content-type':
                    handler.headers['Content-Type'] = 'text/plain'
                elif kind in {'empty', 'large', 'nondecimal', 'nonascii'}:
                    handler.headers['Content-Length'] = {'empty': '0', 'large': '16385', 'nondecimal': '-1', 'nonascii': '١'}[kind]
                if kind == 'peer':
                    handler.rfile = mock.Mock()
                with mock.patch.object(self.service, 'trusted_capture_peer', return_value=kind != 'peer'):
                    handler.do_POST()
                if kind == 'peer':
                    handler.rfile.read.assert_not_called()
                handler.server.service.core_clean_target_preparations.assert_not_called()
                self.assertEqual(handler.send_json.call_args.args[0], 409)

    def test_clean_target_wait_framing_and_peer_guards_precede_body_and_factory(self):
        for kind in ('peer', 'large', 'empty', 'truncated', 'transfer', 'type'):
            with self.subTest(kind=kind):
                handler = self.handler('wait', {'id': ID, 'actor': F.ACTOR})
                handler.path = '/v1/core-clean-target-preparation/wait'
                if kind in {'large', 'empty', 'truncated'}:
                    handler.headers['Content-Length'] = {'large': '16385', 'empty': '0',
                        'truncated': str(int(handler.headers['Content-Length']) + 1)}[kind]
                if kind == 'transfer':
                    handler.headers['Transfer-Encoding'] = 'chunked'
                if kind == 'type':
                    handler.headers['Content-Type'] = 'text/plain'
                if kind != 'truncated':
                    handler.rfile = mock.Mock()
                with mock.patch.object(self.service, 'trusted_capture_peer', return_value=kind != 'peer'):
                    handler.do_POST()
                if kind != 'truncated':
                    handler.rfile.read.assert_not_called()
                handler.server.service.core_clean_target_preparations.assert_not_called()
                self.assertEqual(handler.send_json.call_args.args[0], 409)

    def test_clean_target_coordinator_is_retained_for_worker_ownership(self):
        service = object.__new__(self.service.HostService)
        service.clean_target_preparation_factory_lock = threading.Lock()
        service.clean_target_preparation_service = None
        module = mock.Mock()
        with mock.patch.object(self.service, 'load_script', return_value=module) as load_module:
            first = service.core_clean_target_preparations()
            self.assertIs(service.core_clean_target_preparations(), first)
        load_module.assert_called_once_with('orbis-host-core-preparation-service.py', 'orbis_core_preparation_for_service')
        module.CleanTargetPreparationService.assert_called_once_with(service)

    def test_untrusted_peer_and_truncated_body_never_reach_admission(self):
        handler = self.handler('prepare', {'id': ID, 'actor': F.ACTOR})
        with mock.patch.object(self.service, 'trusted_capture_peer', return_value=False):
            handler.do_POST()
        handler.server.service.core_restore_inspections.assert_not_called()
        handler = self.handler('prepare', {'id': ID, 'actor': F.ACTOR})
        handler.headers['Content-Length'] = str(int(handler.headers['Content-Length']) + 1)
        handler.do_POST()
        handler.server.service.core_restore_inspections.assert_not_called()

    def runtime_handler(self, action, request):
        handler = self.handler(action, request)
        headers = Message()
        for key, value in handler.headers.items():
            headers[key] = value
        handler.headers = headers
        handler.path = '/v1/core-restore-runtime/' + action
        return handler

    def test_runtime_routes_are_exact_async_and_wait_timeout_is_separate(self):
        for action in ('prepare', 'status', 'wait'):
            request = {'id': ID, 'actor': F.ACTOR}
            if action == 'prepare':
                request['action'] = 'ensure-current-restore-runtime'
            with self.subTest(action=action):
                handler = self.runtime_handler(action, request)
                manager = handler.server.service.core_runtime_enrollments.return_value
                result = {'phase': 'preparing', 'activation': False}
                getattr(manager, action).return_value = result
                handler.do_POST()
                getattr(manager, action).assert_called_once_with(request, privileged_peer=True)
                handler.send_json.assert_called_once_with(202 if action == 'prepare' else 200, result)
                self.assertEqual([call.args[0] for call in handler.connection.settimeout.call_args_list],
                                 [15, 1900] if action == 'wait' else [15])
                handler.server.service.core_portable_enrollments.assert_not_called()
                handler.server.service.core_restore_inspections.assert_not_called()

    def test_runtime_framing_peer_and_action_guards_precede_body_read_and_factory(self):
        for kind in ('peer', 'activate', 'prepare?x=1', 'truncated', 'transfer', 'encoding', 'type',
                     'empty', 'large', 'nondecimal', 'nonascii', 'duplicate-length', 'duplicate-type'):
            with self.subTest(kind=kind):
                handler = self.runtime_handler(kind if kind in {'activate', 'prepare?x=1'} else 'prepare',
                                               {'id': ID, 'actor': F.ACTOR})
                if kind in {'empty', 'large', 'nondecimal', 'nonascii', 'truncated'}:
                    value = {'empty': '0', 'large': '16385', 'nondecimal': '-1', 'nonascii': '١',
                             'truncated': str(int(handler.headers['Content-Length']) + 1)}[kind]
                    handler.headers.replace_header('Content-Length', value)
                if kind in {'transfer', 'encoding', 'type'}:
                    field = {'transfer': 'Transfer-Encoding', 'encoding': 'Content-Encoding', 'type': 'Content-Type'}[kind]
                    if kind == 'type':
                        handler.headers.replace_header(field, 'text/plain')
                    else:
                        handler.headers[field] = 'chunked' if kind == 'transfer' else 'gzip'
                if kind in {'duplicate-length', 'duplicate-type'}:
                    field = 'Content-Length' if kind == 'duplicate-length' else 'Content-Type'
                    handler.headers[field] = handler.headers[field]
                if kind != 'truncated':
                    handler.rfile = mock.Mock()
                with mock.patch.object(self.service, 'trusted_capture_peer', return_value=kind != 'peer'):
                    handler.do_POST()
                if kind != 'truncated':
                    handler.rfile.read.assert_not_called()
                handler.server.service.core_runtime_enrollments.assert_not_called()
                self.assertEqual(handler.send_json.call_args.args[0], 409)

    def test_runtime_coordinator_is_retained_for_worker_ownership(self):
        service = object.__new__(self.service.HostService)
        service.core_runtime_enrollment_factory_lock = threading.Lock()
        service.core_runtime_enrollment_service = None
        module = mock.Mock()
        with mock.patch.object(self.service, 'load_script', return_value=module) as load_module:
            first = service.core_runtime_enrollments()
            self.assertIs(service.core_runtime_enrollments(), first)
        load_module.assert_called_once_with('orbis-host-core-runtime-service.py', 'orbis_core_runtime_for_service')
        module.CoreRuntimeEnrollmentService.assert_called_once_with(service)

    def test_inspection_helper_is_installed_without_new_old_target_requirements(self):
        setup = load('orbis-host-service-setup.py', 'core_inspection_setup_fixture')
        sources, _unit = setup.source_files(Path(__file__).parent)
        self.assertIn('orbis-host-core-restore-inspection.py', {path.name for path in sources})
        self.assertIn('orbis-host-core-bootstrap-inspection-service.py', {path.name for path in sources})
        self.assertIn('orbis-host-core-runtime-service.py', {path.name for path in sources})


if __name__ == '__main__':
    unittest.main()
