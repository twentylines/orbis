import copy
import io
import json
import os
import subprocess
import unittest
from unittest import mock

import importlib.util
from pathlib import Path


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


W = load('orbis-host-core-capture-worker.py', 'capture_worker_subject')
F = load('test_orbis_host_time_machine_core.py', 'worker_capture_fixtures')
# Reuse actual core capture and its filesystem/Docker fixture, with one HOST instance.
F.C = W.CORE


class CoreCaptureWorkerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = F.CoreCaptureTests('test_real_review_checkpoint_and_same_id_resume_exclude_all_apps_and_proxy')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.enterContext(mock.patch.object(W, 'require_root'))
        self.supervision = {'unit': 'orbis-core-capture-' + F.POINT + '.service',
                            'invocationId': 'c' * 32, 'processId': os.getpid()}
        self.enterContext(mock.patch.object(W, 'supervision_identity', return_value=self.supervision))
        self.supervision_check = self.enterContext(mock.patch.object(W, 'verify_supervision'))
        # Copying is a fixture here; the packer has separate real-filesystem tests.
        self.artifact = {'fixture': 'portable-checkpoint', 'pointId': F.POINT}
        self.pack = self.enterContext(mock.patch.object(W.CHECKPOINT, 'build', return_value=self.artifact))
        self.pack_read = self.enterContext(mock.patch.object(W.CHECKPOINT, 'read_receipt', return_value=self.artifact))
        self.fixture.capture.source.side_effect = lambda: copy.deepcopy(self.fixture.source)
        self.enterContext(mock.patch.object(W.BoundCapture, 'source', side_effect=lambda: copy.deepcopy(self.fixture.source)))
        self.point, self.root, self.state = F.POINT, self.fixture.root, self.fixture.state
        with W.CORE.HOST.host_lock(self.root):
            lease = W.LEASE.CoreCaptureLease.reserve(W.CORE.HOST, self.root, self.fixture.docker.context,
                                                   self.point, W.CORE.TX.APPS.digest(self.fixture.source))
        with lease.owner() as grant:
            nonce = grant['nonce']
        self.fence = W.CORE.HOST.capture_fence_path(self.root)
        base = self.state / 'core-capture-admissions'
        base.mkdir(mode=0o700)
        self.directory = base / self.point
        self.directory.mkdir(mode=0o700)
        original = self.fixture.capture.observation(self.fixture.docker, self.fixture.docker.controller_id)
        bindings = {'id': self.point, 'root': str(self.root), 'context': self.fixture.docker.context,
                    'snapshots': str(self.fixture.snapshots), 'sourceSha256': W.CORE.TX.APPS.digest(self.fixture.source),
                    'leaseNonce': nonce}
        self.handoff = {**bindings, 'schema': 'orbis.core-capture-handoff.v1',
                        'producer': 'orbis.authenticated-root-supervisor.v1',
                        'operatorAuthorizationId': F.OTHER, 'drainReservationId': F.OTHER,
                        'controller': {'id': original['id'], 'imageId': original['imageId'],
                                       'startedAt': original['startedAt'],
                                       'definitionSha256': W.CORE.TX.APPS.digest(original['definition'])}}
        self.request = {**bindings, 'schema': 'orbis.core-capture-admission.v1', 'handoffSha256': ''}
        self.write_admission()

    def write(self, name, value):
        path = self.directory / name
        path.write_bytes(W.P.canonical(value))
        path.chmod(0o600)

    def write_admission(self):
        self.write('handoff.json', self.handoff)
        self.request['handoffSha256'] = W.digest(W.P.canonical(self.handoff))
        self.write('request.json', self.request)

    def run_worker(self):
        return W.run_worker(str(self.state), self.point)

    def assert_held(self):
        self.assertTrue(self.fence.exists())
        with self.assertRaises(ValueError):
            with W.CORE.HOST.host_lock(self.root):
                self.fail('The worker released publication exclusion')

    def test_real_capture_resumes_original_core_and_retains_lease(self):
        result = self.run_worker()
        self.assertEqual(result['state'], 'resumed-awaiting-publication')
        self.assertFalse(result['settlement']['restoredSnapshotBytes'])
        self.assertEqual(self.fixture.record()['settlement'], result['settlement'])
        self.assertEqual(self.fixture.storage_capture.call_count, 1)
        self.pack.assert_called_once()
        self.assertEqual(result['artifact'], self.artifact)
        self.fixture.restore.assert_not_called()
        self.assert_held()

    def test_finished_status_is_read_only_after_new_module_load(self):
        result = self.run_worker()
        prior = {path: (path.stat().st_mtime_ns, path.read_bytes())
                 for path in self.state.rglob('*') if path.is_file()}
        restarted = load('orbis-host-core-capture-worker.py', 'capture_worker_restarted')
        # A new worker process would be root; adapt only owner checks for Mac fixtures.
        with mock.patch.object(restarted, 'require_root'), mock.patch.object(restarted.A, 'OWNER', os.geteuid()), \
                mock.patch.object(restarted.CHECKPOINT, 'read_receipt', return_value=self.artifact):
            self.assertEqual(restarted.read_status(str(self.state), self.point), result)
        self.assertEqual(prior, {path: (path.stat().st_mtime_ns, path.read_bytes())
                                 for path in self.state.rglob('*') if path.is_file()})
        self.assert_held()

    def test_duplicate_claim_rejects_without_repeating_commands(self):
        self.run_worker()
        previous = copy.deepcopy(self.fixture.docker.calls)
        with self.assertRaises(FileExistsError):
            self.run_worker()
        self.assertEqual(previous, self.fixture.docker.calls)
        self.assert_held()

    def test_rewritten_mapping_and_local_digest_cannot_replace_supervisor_receipt(self):
        self.run_worker()
        record = self.fixture.record()
        mapping = record['portableStorage']
        mapping['database']['resourcePath'] += '/another-directory'
        mapping['database']['containerPath'] += '/another-directory'
        W.CORE.MAP.validate(W.CORE.TX, mapping, record['checkpoint'], record['original'])
        record['settlement']['portableStorageSha256'] = W.CORE.TX.APPS.digest(mapping)
        self.fixture.capture.save(record)
        with self.assertRaisesRegex(W.AdmissionError, 'settlement authority'):
            W.read_status(str(self.state), self.point)
        self.assert_held()

    def test_artifact_failure_keeps_resumed_source_held_without_settlement(self):
        self.pack.side_effect = OSError('fixture archive destination full')
        with self.assertRaises(OSError):
            self.run_worker()
        self.assertEqual(self.fixture.record()['phase'], 'complete')
        self.assertFalse((self.directory / 'settled.json').exists())
        self.assertEqual(W.read_status(str(self.state), self.point)['state'], 'recovery-required')
        self.assert_held()

    def test_artifact_receipt_change_cannot_report_success(self):
        self.run_worker()
        self.pack_read.return_value = {**self.artifact, 'changed': True}
        with self.assertRaisesRegex(W.AdmissionError, 'settlement authority'):
            W.read_status(str(self.state), self.point)
        self.assert_held()

    def test_new_capture_cannot_drop_artifact_settlement(self):
        self.run_worker()
        settled = json.loads((self.directory / 'settled.json').read_bytes())
        settled.pop('checkpointArtifactSha256')
        self.write('settled.json', settled)
        with self.assertRaisesRegex(W.AdmissionError, 'no settled checkpoint artifact'):
            W.read_status(str(self.state), self.point)
        self.assert_held()

    def test_partial_claim_is_never_reclaimed(self):
        (self.directory / 'claim.json').write_bytes(b'{')
        (self.directory / 'claim.json').chmod(0o600)
        with self.assertRaises(FileExistsError):
            self.run_worker()
        self.assertEqual(self.fixture.docker.calls, [])
        self.assert_held()

    def test_wrong_bound_request_fields_fail_before_claim_or_commands(self):
        for key, value in (('sourceSha256', 'a' * 64), ('context', 'another-context'),
                           ('leaseNonce', 'b' * 64), ('id', F.OTHER)):
            with self.subTest(key=key):
                saved_request, saved_handoff = copy.deepcopy(self.request), copy.deepcopy(self.handoff)
                self.request[key] = value
                self.handoff[key] = value
                self.write_admission()
                with self.assertRaises((ValueError, OSError)):
                    self.run_worker()
                self.assertFalse((self.directory / 'claim.json').exists())
                self.request, self.handoff = saved_request, saved_handoff
        self.assertEqual(self.fixture.docker.calls, [])

    def test_changed_source_after_admission_is_consumed_without_capture(self):
        self.fixture.source['creationReference'] = 'changed-source'
        with self.assertRaises(W.AdmissionError):
            self.run_worker()
        self.assertEqual(W.read_status(str(self.state), self.point)['state'], 'recovery-required')
        self.assertFalse((self.state / 'time-machine-core' / self.point).exists())
        self.assertEqual(self.fixture.docker.calls, [])
        self.assert_held()

    def test_wrong_initial_frame_fails_inside_capture_lock_before_mutation(self):
        self.handoff['controller']['startedAt'] = 'other-controller-generation'
        self.write_admission()
        with self.assertRaises(W.AdmissionError):
            self.run_worker()
        self.assertEqual(self.fixture.record()['phase'], 'recovery-required')
        self.assertEqual(self.fixture.docker.calls, [])
        self.assert_held()

    def test_other_controller_id_image_or_definition_is_rejected(self):
        for key, value in (('id', '9' * 64), ('imageId', 'sha256:' + '9' * 64),
                           ('definitionSha256', '9' * 64)):
            with self.subTest(key=key):
                # Separate source-bound point, claim and journal for every attempt.
                fixture_test = CoreCaptureWorkerTests('test_real_capture_resumes_original_core_and_retains_lease')
                fixture_test.setUp()
                try:
                    fixture_test.handoff['controller'][key] = value
                    fixture_test.write_admission()
                    with self.assertRaises(W.AdmissionError):
                        fixture_test.run_worker()
                    self.assertEqual(fixture_test.fixture.docker.calls, [])
                    fixture_test.assert_held()
                finally:
                    fixture_test.doCleanups()

    def test_frame_changed_during_review_is_rejected_before_mutation(self):
        original_review = W.CORE.TX.review
        def changed(*arguments, **keywords):
            result = original_review(*arguments, **keywords)
            self.fixture.docker.starts[self.fixture.docker.controller_id] = 'new-generation'
            return result
        with mock.patch.object(W.CORE.TX, 'review', side_effect=changed), self.assertRaises(W.AdmissionError):
            self.run_worker()
        self.assertEqual(self.fixture.docker.calls, [])
        self.assert_held()

    def test_frame_check_occurs_while_real_host_lock_is_held(self):
        original_verify = W.BoundCapture.verify
        observations = []
        def checked(operation, reader, record):
            fd = W.CORE.HOST.LOCK_DESCRIPTOR.get()
            self.assertIsNotNone(fd)
            os.fstat(fd)
            observations.append(record['phase'])
            return original_verify(operation, reader, record)
        with mock.patch.object(W.BoundCapture, 'verify', checked):
            self.run_worker()
        self.assertEqual(observations[0], 'preparing')
        self.assertIn('resuming', observations)

    def test_crash_before_capture_consumes_claim(self):
        with mock.patch.object(W.BoundCapture, 'capture', side_effect=F.Interrupted), self.assertRaises(F.Interrupted):
            self.run_worker()
        self.assertEqual(W.read_status(str(self.state), self.point)['state'], 'recovery-required')
        with self.assertRaises(FileExistsError):
            self.run_worker()
        self.assertEqual(self.fixture.docker.calls, [])
        self.assert_held()

    def test_copy_error_retains_exact_core_and_worker_recovery_evidence(self):
        self.fixture.copy_hook = lambda: (_ for _ in ()).throw(OSError('fixture-secret-do-not-log'))
        with self.assertRaises(OSError):
            self.run_worker()
        self.assertEqual(self.fixture.record()['phase'], 'recovery-required')
        failure = json.loads((self.directory / 'failure.json').read_bytes())
        self.assertEqual(failure['failureClass'], 'OSError')
        self.assertNotIn('fixture-secret-do-not-log', (self.directory / 'failure.json').read_text())
        self.assertEqual(W.read_status(str(self.state), self.point)['state'], 'recovery-required')
        self.assert_held()

    def test_symlink_nonprivate_foreign_or_hardlinked_admission_is_rejected(self):
        path = self.directory / 'request.json'
        body = path.read_bytes()
        for kind in ('symlink', 'mode', 'hardlink', 'foreign'):
            with self.subTest(kind=kind):
                self.write('request.json', self.request)
                if kind == 'mode':
                    path.chmod(0o644)
                elif kind in ('symlink', 'hardlink'):
                    retained = self.directory / ('retained-' + kind)
                    retained.write_bytes(body)
                    retained.chmod(0o600)
                    path.unlink()
                    if kind == 'symlink':
                        path.symlink_to(retained)
                    else:
                        os.link(retained, path)
                if kind == 'foreign':
                    with mock.patch.object(W.A, 'OWNER', os.geteuid() + 1), self.assertRaises((ValueError, OSError)):
                        self.run_worker()
                else:
                    with self.assertRaises((ValueError, OSError)):
                        self.run_worker()
                path.unlink()
        self.assertEqual(self.fixture.docker.calls, [])

    def test_malformed_extra_keys_and_untrusted_drain_flag_rejected(self):
        for body in (b'{', W.P.canonical({**self.request, 'command': ['sh', '-c', 'id']}),
                     W.P.canonical({**self.request, 'writersStopped': True}),
                     b'{"schema":1,"schema":2}'):
            with self.subTest(body=body[:20]):
                (self.directory / 'request.json').write_bytes(body)
                with self.assertRaises((ValueError, OSError)):
                    self.run_worker()
                self.assertFalse((self.directory / 'claim.json').exists())
        self.assertEqual(self.fixture.docker.calls, [])

    def test_handoff_hash_or_binding_change_rejected(self):
        self.handoff['context'] = 'different-context'
        self.write_admission()
        with self.assertRaises(W.AdmissionError):
            self.run_worker()
        self.handoff['context'] = self.request['context']
        self.write('handoff.json', self.handoff)
        with self.assertRaises(W.AdmissionError):
            self.run_worker()
        self.assertEqual(self.fixture.docker.calls, [])

    def test_paths_and_commands_cannot_enter_uuid_or_cli(self):
        for point in ('../escape', '/bin/sh', self.point + ';id', 'ABCDEFAB-0000-4000-8000-000000000001'):
            with self.subTest(point=point), self.assertRaises(W.AdmissionError):
                W.run_worker(str(self.state), point)
        parser_error = io.StringIO()
        with mock.patch.object(W.sys, 'argv', ['worker', 'run', self.point, '--state-dir', str(self.state), '--exec', 'id']), \
                mock.patch.object(W.sys, 'stderr', parser_error), self.assertRaises(SystemExit):
            W.main()
        self.request['snapshots'] = str(self.fixture.snapshots / '..' / 'snapshots')
        self.handoff['snapshots'] = self.request['snapshots']
        self.write_admission()
        with self.assertRaises((ValueError, OSError)):
            self.run_worker()
        self.assertEqual(self.fixture.docker.calls, [])

    def test_nonroot_entry_rejected(self):
        with mock.patch.object(W, 'require_root', side_effect=W.AdmissionError), self.assertRaises(W.AdmissionError):
            self.run_worker()
        self.assertFalse((self.directory / 'claim.json').exists())

    def test_launcher_intent_precedes_fixed_bounded_nonrestarting_unit(self):
        def launched(command, **keywords):
            self.assertTrue((self.directory / 'launch-intent.json').exists())
            self.assertEqual(command[:2], ['/usr/bin/systemd-run', '--unit=orbis-core-capture-' + self.point])
            self.assertIn('--property=Type=exec', command)
            self.assertIn('--property=Restart=no', command)
            self.assertIn('--property=RemainAfterExit=yes', command)
            self.assertIn('--property=KillMode=control-group', command)
            self.assertIn('--property=Delegate=yes', command)
            self.assertIn('--property=TasksAccounting=yes', command)
            self.assertNotIn('--collect', command)
            self.assertIn(str(W.SUPERVISOR.SUPERVISOR), command)
            self.assertNotIn(str(W.WORKER), command)
            intent = json.loads((self.directory / 'launch-intent.json').read_bytes())
            self.assertEqual(intent['supervisionProtocol'], 2)
            self.assertEqual(intent['supervisorSha256'], W.SUPERVISOR.source_hash(W.worker_context()))
            self.assertEqual(keywords['timeout'], 10)
            self.assertNotIn('shell', keywords)
            return mock.Mock(returncode=0)
        with mock.patch.object(W.subprocess, 'run', side_effect=launched) as launch:
            self.assertEqual(W.launch_worker(str(self.state), self.point)['state'], 'launch-requested')
            with self.assertRaises(FileExistsError):
                W.launch_worker(str(self.state), self.point)
            self.assertEqual(launch.call_count, 1)
        self.assert_held()

    def test_lost_launch_response_never_relaunches(self):
        with mock.patch.object(W.subprocess, 'run', side_effect=subprocess.TimeoutExpired('fixed-unit', 10)) as launch:
            self.assertEqual(W.launch_worker(str(self.state), self.point)['state'], 'launch-unsettled')
            with self.assertRaises(FileExistsError):
                W.launch_worker(str(self.state), self.point)
            self.assertEqual(launch.call_count, 1)
        self.assertEqual(W.read_status(str(self.state), self.point)['state'], 'launch-unsettled')
        self.assert_held()

    def test_legacy_launch_with_unknown_outcome_can_finish_once(self):
        admission = W.Admission(self.state, self.point)
        admission.create('launch-intent.json', admission.event('launch-intent', workerSha256=W.worker_hash(),
                         unit='orbis-core-capture-' + self.point))
        admission.create('launch-unknown.json', admission.event('launch-unknown', failureClass='RuntimeError'))
        self.run_worker()
        self.assertEqual(W.read_status(str(self.state), self.point)['state'], 'resumed-awaiting-publication')
        self.assert_held()

    def test_delegated_launch_cannot_fall_back_to_direct_supervision(self):
        with mock.patch.object(W.subprocess, 'run', return_value=mock.Mock(returncode=0)):
            W.launch_worker(str(self.state), self.point)
        with self.assertRaisesRegex(W.AdmissionError, 'did not establish'):
            self.run_worker()
        self.assertFalse((self.directory / 'claim.json').exists())
        self.assertEqual(self.fixture.docker.calls, [])
        self.assert_held()

    def test_partial_launch_intent_is_consumed(self):
        (self.directory / 'launch-intent.json').write_bytes(b'{')
        (self.directory / 'launch-intent.json').chmod(0o600)
        with mock.patch.object(W.subprocess, 'run') as launch, self.assertRaises(FileExistsError):
            W.launch_worker(str(self.state), self.point)
        launch.assert_not_called()

    def test_modified_settlement_cannot_report_success(self):
        self.run_worker()
        settled = json.loads((self.directory / 'settled.json').read_bytes())
        settled['settlement']['checkpointSha256'] = 'a' * 64
        self.write('settled.json', settled)
        with self.assertRaises(W.AdmissionError):
            W.read_status(str(self.state), self.point)
        self.assert_held()

    def test_cli_error_exposes_only_exception_class(self):
        output = io.StringIO()
        with mock.patch.object(W.sys, 'argv', ['worker', 'run', self.point, '--state-dir', str(self.state)]), \
                mock.patch.object(W, 'run_worker', side_effect=RuntimeError('secret nonce and credentials')), \
                mock.patch.object(W.sys, 'stderr', output):
            self.assertEqual(W.main(), 1)
        self.assertEqual(output.getvalue(), 'RuntimeError\n')

    def test_canonical_0755_installation_root_is_supported(self):
        self.root.chmod(0o755)
        self.assertEqual(self.run_worker()['state'], 'resumed-awaiting-publication')
        self.assert_held()

    def test_symlinked_or_noncanonical_installation_root_is_rejected(self):
        alias = self.fixture.parent / 'install-alias'
        alias.symlink_to(self.root, target_is_directory=True)
        for root in (str(alias), str(self.root) + '/.'):
            with self.subTest(root=root):
                self.request['root'] = self.handoff['root'] = root
                self.write_admission()
                with self.assertRaises((ValueError, OSError)):
                    self.run_worker()
        self.assertEqual(self.fixture.docker.calls, [])

    def test_supervision_failure_after_claim_never_enters_capture(self):
        self.supervision_check.side_effect = W.AdmissionError('wrong invocation')
        with self.assertRaises(W.AdmissionError):
            self.run_worker()
        claim = json.loads((self.directory / 'claim.json').read_bytes())
        self.assertEqual(claim['supervision'], self.supervision)
        self.assertEqual(W.read_status(str(self.state), self.point)['state'], 'recovery-required')
        self.assertEqual(self.fixture.docker.calls, [])
        self.assert_held()

    def test_launcher_rejects_already_consumed_worker(self):
        self.run_worker()
        with mock.patch.object(W.subprocess, 'run') as launch, self.assertRaises(W.AdmissionError):
            W.launch_worker(str(self.state), self.point)
        launch.assert_not_called()

    def test_durable_claim_precedes_every_external_command(self):
        def verify(admission, frame):
            claim = json.loads((self.directory / 'claim.json').read_bytes())
            self.assertEqual(claim['supervision'], frame)
        self.supervision_check.side_effect = verify
        self.run_worker()
        self.assertEqual(self.supervision_check.call_count, 2)


class SupervisionTests(unittest.TestCase):
    def setUp(self):
        # This fixture models the installed system interpreter, independent of the test host.
        self.enterContext(mock.patch.object(W.Path, 'resolve', return_value=Path('/usr/bin/python3.12')))
        self.point = F.POINT
        self.frame = {'unit': 'orbis-core-capture-' + self.point + '.service',
                      'invocationId': 'c' * 32, 'processId': os.getpid()}
        self.admission = mock.Mock(point=self.point, state=Path('/private/state'))
        argv = ['/usr/bin/python3', '-B', str(W.WORKER), 'run', self.point, '--state-dir', '/private/state']
        self.process = {'argv': [os.fsencode(value) for value in argv],
                        'executable': '/usr/bin/python3.12',
                        'cgroup': '0::/system.slice/' + self.frame['unit'] + '\n'}
        self.observed = {'InvocationID': self.frame['invocationId'], 'MainPID': str(os.getpid()),
                         'Type': 'exec', 'Restart': 'no', 'RemainAfterExit': 'yes', 'KillMode': 'control-group',
                         'ActiveState': 'active', 'SubState': 'running'}

    def verify(self):
        body = '\n'.join(key + '=' + value for key, value in self.observed.items()).encode()
        with mock.patch.object(W, 'process_frame', return_value=self.process), \
                mock.patch.object(W.subprocess, 'run', return_value=mock.Mock(returncode=0, stdout=body)) as run:
            W.verify_supervision(self.admission, self.frame)
            self.assertEqual(run.call_args.kwargs['timeout'], 5)

    def test_exact_execution_and_unit_frame_accepted(self):
        self.verify()

    def test_wrong_invocation_pid_or_unit_policy_rejected(self):
        for key, value in (('InvocationID', 'd' * 32), ('MainPID', '999999'), ('Type', 'simple'),
                           ('Restart', 'always'), ('RemainAfterExit', 'no'), ('KillMode', 'process'),
                           ('ActiveState', 'inactive')):
            with self.subTest(key=key):
                saved = self.observed[key]
                self.observed[key] = value
                with self.assertRaises(W.AdmissionError):
                    self.verify()
                self.observed[key] = saved

    def test_wrong_command_executable_or_cgroup_rejected(self):
        for key, value in (('argv', [b'/bin/sh', b'-c', b'id']), ('executable', '/bin/sh'),
                           ('cgroup', '0::/system.slice/other.service\n')):
            with self.subTest(key=key):
                saved = self.process[key]
                self.process[key] = value
                with self.assertRaises(W.AdmissionError):
                    self.verify()
                self.process[key] = saved

    def test_invocation_environment_is_strict(self):
        for value in ('', 'not-a-unit-id', 'C' * 32):
            with self.subTest(value=value), mock.patch.dict(os.environ, {'INVOCATION_ID': value}), \
                    self.assertRaises(W.AdmissionError):
                W.supervision_identity(self.point)
        with mock.patch.dict(os.environ, {'INVOCATION_ID': 'c' * 32}):
            self.assertEqual(W.supervision_identity(self.point), self.frame)


if __name__ == '__main__':
    unittest.main()
