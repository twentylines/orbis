"""Root completion evidence with joined real receipts and explicit runtime/CLI seams."""
import copy
import os
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

import test_orbis_host_core_capture_supervisor_worker as joined


W = joined.W
M = W.load('orbis-host-core-capture-completion.py', 'core_completion_subject')
SERVICE = W.load('orbis-host-core-capture-service.py', 'core_completion_service_read')


class CoreCompletionTests(unittest.TestCase):
    def setUp(self):
        self.joined = joined.JoinedSupervisorWorkerTests('test_joined_success_reopens_after_parent_exit_and_never_replays')
        self.joined.setUp()
        self.addCleanup(self.joined.doCleanups)
        self.capture = self.joined.capture
        self.fixture = self.capture.fixture
        self.enterContext(mock.patch.object(SERVICE.A, 'OWNER', os.geteuid()))
        self.point, self.state = self.capture.point, self.capture.state
        self.fixture.job['daemonFingerprint'] = W.CORE.TX.APPS.digest_daemon(self.fixture.docker)
        self.fixture.capture.save(self.fixture.job)
        self.directory = self.state / 'core-capture-preparations' / self.point
        self.directory.mkdir(parents=True, mode=0o700)
        self.directory.parent.chmod(0o700)
        self.manager = SimpleNamespace(root=self.capture.root, state=self.state, context=self.fixture.docker.context,
            capture=self.fixture.capture, service=SimpleNamespace(lock=threading.Lock()), directory=lambda point: self.directory)
        self.manager.read = lambda directory, name: SERVICE.CoreCaptureService.read(self.manager, directory, name)
        self.manager.source_hold = lambda body, preparation: SERVICE.CoreCaptureService.source_hold(self.manager, body, preparation)
        self.manager.sentinel = SERVICE.SENTINEL.SentinelCaptureCustody(self.manager, W, SERVICE.NAMESPACE)
        self.subject = M.CoreCaptureCompletion(self.manager, W)
        self.reservation = {'version': 3, 'id': self.point, 'ownerId': 1, 'createdAt': 1793910000000,
            'envelope': {'version': 1, 'keyId': '1' * 64, 'nonce': '2' * 24, 'tag': '3' * 32, 'value': '4' * 86}}
        self.preparation = {'schema': 'orbis.core-capture-preparation.v2', 'id': self.point,
            'root': str(self.capture.root), 'context': self.fixture.docker.context, 'scope': W.CORE.SCOPE,
            'sourceSha256': self.capture.request['sourceSha256'], 'controller': self.capture.handoff['controller'],
            'pointReservationSha256': self.subject.reservation.sha256(self.reservation)}
        self.write(self.directory, 'preparation.json', self.preparation)
        self.write(self.directory, 'point-reservation.json', self.reservation)
        self.hold = {'schema': 'orbis.core-capture-source-hold.v2', 'id': self.point,
            'sourceSha256': self.preparation['sourceSha256'], 'controller': self.preparation['controller'],
            'preparationSha256': W.digest(W.P.canonical(self.preparation)),
            'pointReservationSha256': self.preparation['pointReservationSha256'],
            'operatorAuthorizationId': self.capture.handoff['operatorAuthorizationId'],
            'drainReservationId': self.capture.handoff['drainReservationId'],
            'queueDrain': {'pauseId': self.capture.handoff['drainReservationId'], 'generation': 1,
                'queues': [{'name': name, 'messages': 0, 'consumers': 0} for name in sorted(SERVICE.QUEUES)]}}
        self.hold_body = W.P.canonical(self.hold)
        self.write(self.capture.directory, 'source-hold.json', self.hold)
        self.write(self.capture.directory, 'acceptance.json', {'schema': 'orbis.core-capture-acceptance.v1',
            'id': self.point, 'preparationSha256': self.hold['preparationSha256'],
            'sourceHoldSha256': W.digest(self.hold_body),
            'workerRequestSha256': W.digest(W.P.canonical(self.capture.request))})
        self.manager.controller_marker = mock.Mock(side_effect=lambda _: self.hold_body)
        self.configure_reserved_preparation()
        terminal = self.joined.run_supervisor()
        self.assertEqual(terminal['state'], 'quiescent')
        actual_terminal = W.SUPERVISOR.read_terminal
        self.terminal = self.enterContext(mock.patch.object(W.SUPERVISOR, 'read_terminal',
            side_effect=lambda admission, worker: actual_terminal(admission, worker=worker, runtime=self.joined.runtime)))
        self.invoke = self.enterContext(mock.patch.object(self.subject, 'invoke', side_effect=self.cli))
        self.seal = self.enterContext(mock.patch.object(self.subject, 'publication_seal', side_effect=self.file_seal))
        self.continuation_body = None
        self.hold_retired = False
        self.namespace_instance = mock.MagicMock()
        self.namespace_instance.__enter__.return_value = self.namespace_instance
        self.namespace_instance.read_continuation.side_effect = lambda _: (
            W.P.metadata(self.continuation_body), self.continuation_body)
        self.namespace_instance.retire_hold.side_effect = self.retire_source
        self.enterContext(mock.patch.object(self.subject.namespace, 'CaptureNamespace', return_value=self.namespace_instance))
        self.manager.observe = lambda reader: {'controller': copy.deepcopy(self.capture.handoff['controller'])}

    def configure_reserved_preparation(self):
        pass

    def file_seal(self, *_):
        return {'schema': 'orbis.core-capture-publication-seal.v1', 'pointId': self.point,
            'pointSha256': 'a' * 64, 'metadataSha256': 'b' * 64, 'keyId': self.reservation['envelope']['keyId'],
            'cipherBytes': self.joined.worker_result['artifact']['checkpoint']['bytes'] + 10000,
            'cipherSha256': 'c' * 64, 'files': {name: ['1'] * 9 for name in ('point', 'metadata', 'core', 'key')},
            'directories': [['1'] * 5 for _ in range(6)]}

    def retire_source(self, point, digest):
        self.assertEqual(point, self.point)
        self.assertEqual(digest, W.digest(self.hold_body))
        self.hold_retired = True
        return {'schema': 'orbis.core-capture-source-retirement.v1', 'id': point,
            'sourceHoldSha256': digest, 'controller': self.capture.handoff['controller'],
            'retiredIdentity': {'st_dev': 1, 'st_ino': 1, 'st_mode': 0o100600, 'st_uid': W.A.OWNER,
                'st_gid': os.getegid(), 'st_nlink': 1, 'st_size': len(self.hold_body), 'st_mtime_ns': 1}}

    def finish_request(self):
        prepared = self.subject.prepare(self.point)
        self.continuation_value = {'schema': 'orbis.core-capture-source-continuation.v1', 'id': self.point,
            'completionSha256': prepared['completionSha256'], 'sourceHoldSha256': prepared['sourceHoldSha256'],
            'pointReservationSha256': prepared['pointReservationSha256'], 'controller': prepared['controller'],
            'queueGeneration': 1, 'queues': [{'name': name, 'messages': 0, 'consumers': 1}
                for name in ('app-events-queue', 'repo-queue', 'system-events-queue')]}
        self.continuation_body = W.P.canonical(self.continuation_value)
        return {key: prepared[key] for key in ('sourceSha256', 'sourceHoldSha256', 'completionSha256')} | {
            'continuationSha256': W.digest(self.continuation_body)}

    @staticmethod
    def write(directory, name, value):
        path = directory / name
        path.write_bytes(W.P.canonical(value))
        path.chmod(0o600)

    def cli(self, admission, controller, arguments):
        if arguments == ['--capability']:
            return copy.deepcopy(M.CAPABILITY)
        self.assertEqual(arguments[0], '--verify')
        expected = W.P.metadata(arguments[1].encode())
        self.assertEqual(controller['id'], self.preparation['controller']['id'])
        self.expected = expected
        return {'schema': 'orbis.core-capture-publication.v1', 'pointId': self.point,
            'ownerId': self.reservation['ownerId'], 'createdAt': self.reservation['createdAt'],
            'pointSha256': 'a' * 64, 'pointReservationSha256': self.subject.reservation.sha256(self.reservation),
            'metadataSha256': 'b' * 64, 'cipherBytes': expected['checkpoint']['bytes'] + 10000,
            'cipherSha256': 'c' * 64, 'manifestSha256': 'd' * 64, 'imageInventorySha256': 'e' * 64,
            **{key: expected[key] for key in ('sourceSha256', 'checkpointSha256', 'captureReceiptSha256', 'checkpoint', 'resourceCount')},
            'imageCount': len(set(expected['images'].values()))}

    def assert_held(self):
        self.capture.assert_held()
        self.assertEqual((self.capture.directory / 'source-hold.json').read_bytes(), self.hold_body)

    def test_root_derived_verification_persists_evidence_and_never_releases_exclusion(self):
        result = self.subject.prepare(self.point)
        proof, body = self.joined.admission().read('completion-ready.json')
        self.assertEqual(result['completionSha256'], W.digest(body))
        self.assertEqual(result['state'], 'verified-awaiting-continuation')
        self.assertEqual(proof['publication']['pointReservationSha256'], self.preparation['pointReservationSha256'])
        self.assertEqual(proof['publication']['captureReceiptSha256'], W.digest(self.joined.admission().read('settled.json')[1]))
        self.assertEqual(self.subject.prepare(self.point), result)
        self.assertEqual(len(self.joined.runtime.spawns), 1)
        self.assert_held()

    def test_legacy_preparation_cannot_gain_completion_authority(self):
        value = {key: val for key, val in self.preparation.items() if key != 'pointReservationSha256'}
        value['schema'] = 'orbis.core-capture-preparation.v1'
        self.write(self.directory, 'preparation.json', value)
        with self.assertRaises((M.CompletionError, W.AdmissionError)):
            self.subject.prepare(self.point)
        self.invoke.assert_not_called()
        self.assert_held()

    def test_changed_original_reservation_or_acceptance_is_rejected_before_cli(self):
        for name, change in (('point-reservation.json', {'ownerId': 2}),
                             ('preparation.json', {'pointReservationSha256': 'a' * 64})):
            with self.subTest(name=name):
                original = (self.directory / name).read_bytes()
                value = W.P.metadata(original)
                self.write(self.directory, name, {**value, **change})
                with self.assertRaises((M.CompletionError, W.AdmissionError)):
                    self.subject.prepare(self.point)
                (self.directory / name).write_bytes(original)
        self.invoke.assert_not_called()
        self.assert_held()

    def test_unknown_or_unsuccessful_terminal_never_verifies_a_saved_point(self):
        self.terminal.side_effect = None
        for terminal in (None, {'state': 'recovery-required', 'workerQuiescent': True, 'workerExitCode': 1},
                         {'state': 'quiescent', 'workerQuiescent': False, 'workerExitCode': 0}):
            self.terminal.return_value = terminal
            with self.subTest(terminal=terminal), self.assertRaises(M.CompletionError):
                self.subject.prepare(self.point)
        self.invoke.assert_not_called()
        self.assert_held()

    def test_forged_verifier_bindings_and_extra_fields_cannot_become_completion_evidence(self):
        for changes in ({'ownerId': 2}, {'createdAt': True}, {'pointId': '11111111-1111-4111-8111-111111111111'},
                        {'pointReservationSha256': 'a' * 64}, {'captureReceiptSha256': 'a' * 64},
                        {'cipherBytes': True}, {'imageCount': True}, {'resourceCount': True}, {'path': '/elsewhere'}):
            def changed(admission, controller, arguments):
                value = self.cli(admission, controller, arguments)
                return value if arguments == ['--capability'] else {**value, **changes}
            self.invoke.side_effect = changed
            with self.subTest(changes=changes), self.assertRaises(M.CompletionError):
                self.subject.prepare(self.point)
            self.assertFalse((self.capture.directory / 'completion-ready.json').exists())
        self.assert_held()

    def test_capability_type_mismatch_and_source_change_during_cli_keep_hold(self):
        def changed(admission, controller, arguments):
            value = self.cli(admission, controller, arguments)
            return {**value, 'version': True} if arguments == ['--capability'] else value
        self.invoke.side_effect = changed
        with self.assertRaises(M.CompletionError):
            self.subject.prepare(self.point)
        def replaced(admission, controller, arguments):
            value = self.cli(admission, controller, arguments)
            if arguments != ['--capability']:
                self.manager.controller_marker.side_effect = lambda _: b'changed'
            return value
        self.invoke.side_effect = replaced
        with self.assertRaises(M.CompletionError):
            self.subject.prepare(self.point)
        self.assertFalse((self.capture.directory / 'completion-ready.json').exists())
        self.assert_held()

    def test_fixed_verifier_command_uses_only_enrolled_controller_and_canonical_expectation(self):
        with mock.patch.object(W.CORE.D.DockerRestoreRuntime, 'bounded_output', return_value=b'{"ok":true}') as output:
            result = M.CoreCaptureCompletion.invoke(self.subject, self.joined.admission(), self.preparation['controller'], ['--capability'])
        self.assertEqual(result, {'ok': True})
        self.assertEqual(output.call_args.args[1], ['docker', '--context', self.fixture.docker.context, 'exec',
            self.preparation['controller']['id'], '/usr/local/bin/node', '/app/core-capture-publication.mjs', '--capability'])
        self.assertEqual(output.call_args.args[2:], (8192, 1800))
        self.assert_held()

    def test_full_root_commit_preserves_lease_and_supports_completed_history(self):
        request = self.finish_request()
        before = list(self.fixture.docker.calls)
        result = self.subject.finish(self.point, request)
        self.assertEqual(result['state'], 'complete')
        self.assertTrue(self.hold_retired)
        self.assertFalse(self.capture.fence.exists())
        retired = self.capture.fence.with_name(self.capture.fence.name + '.retired-' + self.point)
        self.assertTrue(retired.is_file())
        self.assertEqual(self.subject.retirement_for(self.point).inspect_retired()['completionSha256'], request['completionSha256'])
        self.assertEqual(self.subject.finish(self.point, request), result)
        self.assertEqual(self.subject.status(self.point, {key: request[key] for key in ('sourceSha256', 'sourceHoldSha256')}), result)
        self.assertEqual(self.fixture.docker.calls, before)
        self.assertEqual(len(self.joined.runtime.spawns), 1)

    def test_interruption_after_root_rename_reconciles_only_the_committed_source_hold(self):
        request = self.finish_request()
        original = self.subject.retirement.CaptureRetirement.retire_committed
        def interrupted(retirement):
            original(retirement)
            raise OSError('lost response after durable lease rename')
        with mock.patch.object(self.subject.retirement.CaptureRetirement, 'retire_committed', interrupted), self.assertRaises(OSError):
            self.subject.finish(self.point, request)
        self.assertFalse(self.capture.fence.exists())
        self.assertFalse(self.hold_retired)
        result = self.subject.finish(self.point, request)
        self.assertEqual(result['state'], 'complete')
        self.assertTrue(self.hold_retired)
        self.assertEqual(len(self.joined.runtime.spawns), 1)

    def test_changed_continuation_or_publication_cannot_retire_any_selector(self):
        request = self.finish_request()
        self.continuation_value['queues'][0]['consumers'] = True
        self.continuation_body = W.P.canonical(self.continuation_value)
        request['continuationSha256'] = W.digest(self.continuation_body)
        with self.assertRaises(M.CompletionError):
            self.subject.finish(self.point, request)
        self.assertFalse(self.hold_retired)
        self.assert_held()
        request = self.finish_request()
        changed = self.file_seal()
        changed['files']['core'][1] = '2'
        self.seal.side_effect = None
        self.seal.return_value = changed
        with self.assertRaises(M.CompletionError):
            self.subject.finish(self.point, request)
        self.assertFalse(self.hold_retired)
        self.assert_held()

    def test_saved_point_replacement_around_verifier_cannot_be_prepared(self):
        original = self.file_seal()
        changed = copy.deepcopy(original)
        changed['files']['core'][1] = '2'
        self.seal.side_effect = [original, changed]
        with self.assertRaises(M.CompletionError):
            self.subject.prepare(self.point)
        self.assertFalse((self.capture.directory / 'completion-ready.json').exists())
        self.assert_held()


@unittest.skipIf(sys.platform == 'darwin', 'Reserved worker and completion path is qualified on Linux with strict lease seals')
class ReservedCoreCompletionTests(CoreCompletionTests):
    def configure_reserved_preparation(self):
        lease = W.LEASE.CoreCaptureLease.load(W.CORE.HOST, self.capture.root)
        self.preparation.update(schema=W.RESERVED.SCHEMA,
            leaseNonce=self.capture.request['leaseNonce'], leaseSha256=W.digest(lease.proof[0]),
            leaseIdentity=W.RESERVED.lease_identity(self.capture.fence.stat()))
        self.write(self.directory, 'preparation.json', self.preparation)
        self.hold['preparationSha256'] = W.digest(W.P.canonical(self.preparation))
        self.hold_body = W.P.canonical(self.hold)
        self.write(self.capture.directory, 'source-hold.json', self.hold)
        authority = W.RESERVED.ReservedPreparation(W.reservation_context(), self.state,
            self.capture.root, self.fixture.docker.context, self.point)
        with lease.owner(), W.CORE.HOST.host_lock(self.capture.root):
            _, body = authority.decide('admit', W.digest(self.hold_body))
        bindings = {'preparationSha256': authority.preparation_sha256, 'decisionSha256': W.digest(body)}
        self.capture.handoff.update(schema='orbis.core-capture-handoff.v2', **bindings)
        self.capture.request.update(schema='orbis.core-capture-admission.v2', **bindings)
        self.capture.write_admission()
        self.write(self.capture.directory, 'acceptance.json', {'schema': 'orbis.core-capture-acceptance.v1',
            'id': self.point, 'preparationSha256': self.hold['preparationSha256'],
            'sourceHoldSha256': W.digest(self.hold_body),
            'workerRequestSha256': W.digest(W.P.canonical(self.capture.request))})
        intent = W.P.metadata((self.capture.directory / 'launch-intent.json').read_bytes())
        intent['requestSha256'] = W.digest(W.P.canonical(self.capture.request))
        self.write(self.capture.directory, 'launch-intent.json', intent)

    def test_abort_or_changed_reserved_decision_cannot_authorize_completion(self):
        decision = self.directory / 'decision.json'
        value = W.P.metadata(decision.read_bytes())
        value['decision'] = 'abort'
        self.write(self.directory, 'decision.json', value)
        with self.assertRaises(ValueError):
            self.subject.prepare(self.point)
        self.assertTrue(self.capture.fence.exists())
        self.assertFalse((self.capture.directory / 'completion-ready.json').exists())
        self.invoke.assert_not_called()


class ObservedReadinessTests(unittest.TestCase):
    def setUp(self):
        self.controller = {'id': 'a' * 64, 'imageId': 'sha256:' + 'b' * 64,
                           'startedAt': 'original-start', 'definition': {}, 'state': 'running'}
        self.preparation = {'controller': {**{key: self.controller[key] for key in ('id', 'imageId')},
            'definitionSha256': W.CORE.TX.APPS.digest(self.controller['definition'])}}
        self.source = {'configuration': 'captured source'}
        self.hold = b'original source hold'
        self.admission = SimpleNamespace(request={'sourceSha256': W.CORE.TX.APPS.digest(self.source)})
        self.capture = SimpleNamespace(verify=mock.Mock(), source=lambda: self.source,
                                     observation=lambda *_: copy.deepcopy(self.controller))
        self.manager = SimpleNamespace(capture=self.capture, controller_marker=lambda _: self.hold)
        self.subject = M.CoreCaptureCompletion(self.manager, W)
        self.record = {'expected': {self.controller['id']: copy.deepcopy(self.controller),
            'database': {'state': 'running'}, 'queue': {'state': 'running'}},
            'checkpoint': {'roles': {self.controller['id']: 'controller', 'database': 'database', 'queue': 'queue'}}}
        self.reader = object()

    def test_readiness_uses_captured_roles_and_rechecks_the_full_capture(self):
        with mock.patch.object(M, 'require_dependency_ready') as readiness:
            result = self.subject.observed(self.admission, self.reader, self.record, self.preparation, self.hold)
        self.assertEqual(result['startedAt'], self.controller['startedAt'])
        self.assertEqual(readiness.call_args_list, [mock.call(W, self.reader, identifier, role)
            for identifier, role in self.record['checkpoint']['roles'].items()])
        self.assertEqual(self.capture.verify.call_args_list, [mock.call(self.reader, self.record)] * 2)

    def test_inventory_change_during_readiness_cannot_authorize_completion(self):
        changed = False
        def verify(*_):
            if changed:
                raise W.CORE.TX.TransactionError('Captured inventory changed')
        def readiness(*_):
            nonlocal changed
            changed = True
        self.capture.verify.side_effect = verify
        with mock.patch.object(M, 'require_dependency_ready', side_effect=readiness):
            with self.assertRaises(W.CORE.TX.TransactionError):
                self.subject.observed(self.admission, self.reader, self.record, self.preparation, self.hold)
        self.assertEqual(self.capture.verify.call_count, 2)


class DependencyReadinessTests(unittest.TestCase):
    def setUp(self):
        self.identifier = 'b' * 64
        self.raw = {'Id': self.identifier, 'Image': 'sha256:' + 'c' * 64, 'Config': {},
                    'HostConfig': {'AutoRemove': False, 'RestartPolicy': {'Name': 'unless-stopped'}},
                    'Mounts': [], 'NetworkSettings': {'Networks': {'fixture': {'NetworkID': 'd' * 64}}},
                    'State': {'Status': 'running', 'Running': True, 'Restarting': False,
                              'Paused': False, 'StartedAt': 'original-start'}}
        self.calls = []
        self.on_probe = lambda: None
        def read(arguments):
            self.calls.append(arguments)
            self.on_probe()
            return ''
        self.reader = SimpleNamespace(_object=lambda arguments: copy.deepcopy(
            self.raw['State'] if arguments[-2] == '{{json .State}}' else self.raw), _read=read)

    def test_standard_queue_without_docker_healthcheck_uses_real_broker_command(self):
        M.require_dependency_ready(W, self.reader, self.identifier, 'queue')
        self.assertEqual(self.calls, [['exec', self.identifier, 'rabbitmq-diagnostics', '-q', check]
                                     for check in ('check_running', 'check_local_alarms')])

    def test_explicitly_disabled_docker_healthcheck_still_requires_broker_readiness(self):
        self.raw['Config']['Healthcheck'] = {'Test': ['NONE']}
        M.require_dependency_ready(W, self.reader, self.identifier, 'queue')
        self.assertEqual(len(self.calls), 2)

    def test_configured_unhealthy_or_starting_healthcheck_is_never_bypassed(self):
        self.raw['Config']['Healthcheck'] = {'Test': ['CMD', 'probe']}
        for state in ('unhealthy', 'starting'):
            self.raw['State']['Health'] = {'Status': state}
            with self.subTest(state=state), self.assertRaises(W.CORE.TX.TransactionError):
                M.require_dependency_ready(W, self.reader, self.identifier, 'queue')
        self.assertEqual(self.calls, [])

    def test_running_is_not_enough_for_controller_or_database(self):
        for role in ('controller', 'database'):
            with self.subTest(role=role), self.assertRaises(W.CORE.TX.TransactionError):
                M.require_dependency_ready(W, self.reader, self.identifier, role)
        self.assertEqual(self.calls, [])

    def test_stopped_broker_application_or_resource_alarm_preserves_failure(self):
        for command in ('check_running', 'check_local_alarms'):
            self.calls.clear()
            def failure():
                if self.calls[-1][-1] == command:
                    raise W.CORE.TX.APPS.DETECT.InspectionError('Broker probe failed')
            self.on_probe = failure
            with self.subTest(command=command), self.assertRaises(W.CORE.TX.APPS.DETECT.InspectionError):
                M.require_dependency_ready(W, self.reader, self.identifier, 'queue')

    def test_stopped_paused_or_foreign_queue_cannot_be_probed(self):
        original = copy.deepcopy(self.raw)
        for change in (lambda: self.raw['State'].update(Status='exited', Running=False),
                       lambda: self.raw['State'].update(Paused=True),
                       lambda: self.raw.update(Id='e' * 64)):
            self.raw = copy.deepcopy(original)
            change()
            with self.assertRaises(M.CompletionError):
                M.require_dependency_ready(W, self.reader, self.identifier, 'queue')
        self.assertEqual(self.calls, [])

    def test_container_restart_or_definition_change_during_probe_is_rejected(self):
        original = copy.deepcopy(self.raw)
        for change in (lambda: self.raw['State'].update(StartedAt='new-start'),
                       lambda: self.raw.update(Image='sha256:' + 'e' * 64),
                       lambda: self.raw['HostConfig'].update(RestartPolicy={'Name': 'no'})):
            self.raw = copy.deepcopy(original)
            self.on_probe = change
            with self.assertRaises(M.CompletionError):
                M.require_dependency_ready(W, self.reader, self.identifier, 'queue')

    def test_declared_healthy_dependency_keeps_existing_health_contract(self):
        self.raw['State']['Health'] = {'Status': 'healthy'}
        for role in ('controller', 'database', 'queue'):
            M.require_dependency_ready(W, self.reader, self.identifier, role)
        self.assertEqual(self.calls, [])

    def test_unknown_role_is_rejected(self):
        with self.assertRaises(M.CompletionError):
            M.require_dependency_ready(W, self.reader, self.identifier, 'app')
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
