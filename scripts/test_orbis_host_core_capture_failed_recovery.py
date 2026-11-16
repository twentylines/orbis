"""Real failed receipts, files and retirement; Docker and kernel are explicit seams."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

import test_orbis_host_core_capture_completion as completion
import test_orbis_host_core_capture_supervisor_worker as joined

W = joined.W
SPEC = importlib.util.spec_from_file_location('failed_capture_recovery_tests', Path(__file__).with_name('orbis-host-core-capture-failed-recovery.py'))
M = importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name] = M;SPEC.loader.exec_module(M)
OLD = '2026-11-14T00:00:00.000000000Z'
STOP = '2026-11-14T00:01:00.000000000Z'
NEW = '2026-11-14T00:02:00.000000000Z'


class FailedCaptureRecoveryTests(unittest.TestCase):
    def write(self, directory, name, value):
        path = directory / name;path.write_bytes(W.P.canonical(value));path.chmod(0o600)

    def setUp(self):
        self.joined = joined.JoinedSupervisorWorkerTests('test_failed_actual_worker_is_held_and_cannot_replay')
        self.joined.setUp();self.addCleanup(self.joined.doCleanups)
        self.capture, self.fixture = self.joined.capture, self.joined.capture.fixture
        self.enterContext(mock.patch.object(completion.SERVICE.A, 'OWNER', os.geteuid()))
        self.root, self.state, self.point = self.capture.root, self.capture.state, self.capture.point
        self.docker = self.fixture.docker
        backup = self.root / 'backups';backup.mkdir(exist_ok=True);backup.chmod(0o755)
        tm = backup / 'time-machine';tm.mkdir(mode=0o700)
        self.point_dir = tm / 'points' / self.point;self.point_dir.parent.mkdir(mode=0o700);self.point_dir.mkdir(mode=0o700)
        self.markers = tm / 'core-capture';self.markers.mkdir(mode=0o700)
        self.docker.starts[self.docker.controller_id] = OLD
        self.health = {}
        raw_object = self.docker._object
        def raw(arguments):
            if arguments[-2] == '{{json .State}}':
                row = self.docker.app(arguments[-1])
                return {'Status': row['state'], 'Health': {'Status': self.health.get(arguments[-1], 'healthy')}}
            result = raw_object(arguments)
            if arguments[:2] == ['container', 'inspect'] and arguments[-2] == '{{json .}}':
                result['State'].update(Pid=6619 if result['State']['Running'] else 0, Dead=False,
                                       OOMKilled=False, FinishedAt=STOP)
                if arguments[-1] == self.docker.controller_id:
                    result['Mounts'].append({'Type': 'bind', 'Source': str(backup), 'Destination': '/data/backups', 'RW': True})
            return result
        self.enterContext(mock.patch.object(self.docker, '_object', side_effect=raw))
        self.docker.after_change = lambda args: self.docker.starts.update({self.docker.controller_id: NEW}) if args[0] == 'start' else None
        frame = self.capture.handoff['controller']
        frame.update(startedAt=OLD, definitionSha256=W.CORE.TX.APPS.digest(
            self.fixture.capture.observation(self.docker, self.docker.controller_id)['definition']))
        self.directory = self.state / 'core-capture-preparations' / self.point
        self.directory.mkdir(parents=True, mode=0o700);self.directory.parent.chmod(0o700)
        self.manager = SimpleNamespace(root=self.root, state=self.state, context=self.docker.context,
            capture=self.fixture.capture, service=SimpleNamespace(lock=threading.Lock()), directory=lambda point: self.directory)
        self.manager.read = lambda directory, name: completion.SERVICE.CoreCaptureService.read(self.manager, directory, name)
        self.manager.source_hold = lambda body, preparation: completion.SERVICE.CoreCaptureService.source_hold(self.manager, body, preparation)
        self.manager.sentinel = completion.SERVICE.SENTINEL.SentinelCaptureCustody(self.manager, W, completion.SERVICE.NAMESPACE)
        self.manager.observe = lambda reader: {'controller': {**frame, 'startedAt': self.docker.starts[self.docker.controller_id]},
                                              'sourceSha256': self.capture.request['sourceSha256']}
        def idle():
            grant = W.CORE.HOST.core_capture_owner(self.root)
            self.assertEqual(grant['id'], self.point);self.assertEqual(grant['context'], self.docker.context)
        self.manager.require_owned_idle_core = idle
        self.reservation = {'version': 3, 'id': self.point, 'ownerId': 1, 'createdAt': 1793910000000,
            'envelope': {'version': 1, 'keyId': '1' * 64, 'nonce': '2' * 24, 'tag': '3' * 32, 'value': '4' * 86}}
        self.subject = M.FailedCaptureRecovery.__new__(M.FailedCaptureRecovery)
        with mock.patch.object(M, 'require_platform'):
            self.subject.__init__(self.manager, W)
        self.preparation = {'schema': 'orbis.core-capture-preparation.v2', 'id': self.point,
            'root': str(self.root), 'context': self.docker.context, 'scope': W.CORE.SCOPE,
            'sourceSha256': self.capture.request['sourceSha256'], 'controller': frame,
            'pointReservationSha256': self.subject.reservation.sha256(self.reservation)}
        self.write(self.directory, 'preparation.json', self.preparation)
        self.write(self.directory, 'point-reservation.json', self.reservation)
        self.write(self.directory, 'preparation-intent.json', {'fixture': 'original protected intent'})
        self.hold = {'schema': 'orbis.core-capture-source-hold.v2', 'id': self.point,
            'sourceSha256': self.preparation['sourceSha256'], 'controller': frame,
            'preparationSha256': W.digest(W.P.canonical(self.preparation)),
            'pointReservationSha256': self.preparation['pointReservationSha256'],
            'operatorAuthorizationId': self.capture.handoff['operatorAuthorizationId'],
            'drainReservationId': self.capture.handoff['drainReservationId'],
            'queueDrain': {'pauseId': self.capture.handoff['drainReservationId'], 'generation': 1,
                'queues': [{'name': name, 'messages': 0, 'consumers': 0} for name in sorted(completion.SERVICE.QUEUES)]}}
        completion.ReservedCoreCompletionTests.configure_reserved_preparation(self)
        self.write(self.markers, 'source-hold.json', self.hold)
        self.point_value = {**copy.deepcopy(self.reservation), 'kind': 'orbis-core', 'coreFormat': 'orbis.time-machine-core.v1',
            'status': 'capturing', 'core': None, 'backupJobId': None, 'issue': None,
            'archiveBytes': 0, 'archiveSha256': None, 'metadataSha256': None}
        self.write(self.point_dir, 'point.json', self.point_value)
        (self.point_dir / 'capture-draft.orbis').write_bytes(b'encrypted draft retained');(self.point_dir / 'capture-draft.orbis').chmod(0o600)
        shutil.rmtree(self.fixture.capture.base / self.point)
        if self.fixture.bundle.exists():shutil.rmtree(self.fixture.bundle)
        self.enterContext(mock.patch.object(W.BoundCapture, 'source', side_effect=FileNotFoundError('Docker unavailable')))
        terminal = self.joined.run_supervisor()
        self.assertTrue(terminal['workerQuiescent']);self.assertEqual(terminal['state'], 'recovery-required')
        read_terminal = W.SUPERVISOR.read_terminal
        self.enterContext(mock.patch.object(W.SUPERVISOR, 'read_terminal',
            side_effect=lambda admission, worker: read_terminal(admission, worker=worker, runtime=self.joined.runtime)))
        owner = self
        class Namespace:
            def __init__(self, worker, reader, controller):
                M.require(controller == owner.capture.handoff['controller'])
            def read_source_hold(self, point):
                path = owner.markers / 'source-hold.json';return json.loads(path.read_bytes()), path.read_bytes(), path.stat()
            def directory(self):
                from contextlib import contextmanager
                @contextmanager
                def opened():
                    fd = os.open(owner.markers, os.O_RDONLY | os.O_DIRECTORY)
                    try:yield fd
                    finally:os.close(fd)
                return opened()
            def unchanged(self):pass
            def __enter__(self):return self
            def __exit__(self, *args):pass
        self.enterContext(mock.patch.object(self.subject.namespace, 'CaptureNamespace', Namespace))
        self.actor = {'operatorId': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'authorizationSha256': 'a' * 64}

    def approval(self):
        review = self.subject.review(self.point, self.actor)
        return M.RootFailedCaptureApproval(self.actor, self.subject.digest(review), self.actor['operatorId'])

    def test_review_preserves_all_files_and_never_stops_or_replays(self):
        before = {str(p):p.read_bytes() for base in (self.state, self.root / 'backups') for p in base.rglob('*') if p.is_file()}
        result = self.subject.review(self.point, self.actor)
        self.assertEqual(result['schema'], M.SCHEMA + '.review')
        self.assertFalse(result['captureCompleted']);self.assertFalse(result['queueStateProved'])
        self.assertFalse(self.subject.transaction(self.point).exists())
        self.assertEqual(before, {str(p):p.read_bytes() for base in (self.state, self.root / 'backups') for p in base.rglob('*') if p.is_file()})
        self.assertEqual(self.docker.calls, [])

    def test_recovery_cold_starts_only_original_controller_and_preserves_draft_and_receipts(self):
        draft = (self.point_dir / 'capture-draft.orbis').read_bytes()
        inputs = self.subject.review(self.point, self.actor)['inputs']
        result = self.subject.apply(self.point, self.approval())
        self.assertEqual(result['schema'], M.SCHEMA + '.complete')
        self.assertEqual(self.docker.calls, [(['stop', '--time', '30', self.docker.controller_id], 45),
                                            (['start', self.docker.controller_id], 60)])
        current = json.loads((self.point_dir / 'point.json').read_bytes())
        self.assertEqual(current, {**self.point_value, 'status': 'failed', 'issue': 'capture-failed'})
        self.assertEqual((self.point_dir / 'capture-draft.orbis').read_bytes(), draft)
        self.assertFalse((self.markers / 'source-hold.json').exists())
        self.assertTrue((self.markers / ('source-hold-retired-' + self.point + '.json')).exists())
        self.assertFalse(W.CORE.HOST.capture_fence_path(self.root).exists())
        for relative, sha in inputs.items():
            path = self.state / relative;self.assertEqual(W.digest(path.read_bytes()), sha)

    def assert_held_without_mutation(self):
        self.assertEqual(self.docker.calls, [])
        self.assertTrue(W.CORE.HOST.capture_fence_path(self.root).exists())
        self.assertTrue((self.markers / 'source-hold.json').exists())

    def test_incomplete_or_contradictory_terminal_never_authorizes_recovery(self):
        path = self.capture.directory / 'worker-terminal.json';original = json.loads(path.read_bytes())
        for key, value in [('workerQuiescent', False), ('claimSha256', '0' * 64),
                           ('workerExitCode', None), ('settledSha256', '0' * 64), ('failureClass', None)]:
            with self.subTest(field=key):
                self.write(path.parent, path.name, {**original, key: value})
                with self.assertRaises(ValueError):self.subject.review(self.point, self.actor)
                self.assert_held_without_mutation()
        self.write(path.parent, path.name, original)

    def test_existing_job_snapshot_or_selected_capture_requires_its_own_recovery(self):
        paths = [self.fixture.capture.base / self.point, self.fixture.bundle,
                 self.state / 'selected-captures' / self.point]
        for path in paths:
            with self.subTest(path=path.name):
                path.parent.mkdir(mode=0o700, exist_ok=True);path.mkdir(mode=0o700)
                with self.assertRaises(ValueError):self.subject.review(self.point, self.actor)
                self.assert_held_without_mutation();path.rmdir()

    def test_no_unrecorded_or_sealed_point_can_be_abandoned(self):
        for change in [{'status': 'sealed'}, {'archiveBytes': 1}, {'archiveBytes': False},
                       {'ownerId': 99}, {'assetBytes': True}, {'core': {'unexpected': True}}]:
            with self.subTest(change=change):
                self.write(self.point_dir, 'point.json', {**self.point_value, **change})
                with self.assertRaises(ValueError):self.subject.review(self.point, self.actor)
                self.assert_held_without_mutation()

    def test_unexpected_point_file_is_preserved(self):
        path = self.point_dir / 'core.orbis';path.write_bytes(b'possible captured data');path.chmod(0o600)
        with self.assertRaises(ValueError):self.subject.review(self.point, self.actor)
        self.assertEqual(path.read_bytes(), b'possible captured data');self.assert_held_without_mutation()

    def test_changed_or_duplicate_source_marker_is_rejected(self):
        marker = self.markers / 'source-hold.json';body = marker.read_bytes()
        marker.write_bytes(body + b' ')
        with self.assertRaises(ValueError):self.subject.review(self.point, self.actor)
        marker.write_bytes(body)
        retired = self.markers / ('source-hold-retired-' + self.point + '.json');retired.write_bytes(body);retired.chmod(0o600)
        with self.assertRaises(ValueError):self.subject.review(self.point, self.actor)
        self.assert_held_without_mutation()

    def test_controller_replacement_is_not_a_same_execution_recovery(self):
        self.docker.starts[self.docker.controller_id] = NEW
        with self.assertRaises(ValueError):self.subject.review(self.point, self.actor)
        self.assert_held_without_mutation()

    def test_forged_stale_or_different_operator_approval_cannot_stop_controller(self):
        approval = self.approval()
        for forged in [vars(approval), M.RootFailedCaptureApproval(self.actor, '0' * 64, approval.confirmation_id),
                       M.RootFailedCaptureApproval({**self.actor, 'authorizationSha256': 'b' * 64},
                                                  approval.review_sha256, approval.confirmation_id)]:
            with self.subTest(kind=type(forged).__name__), self.assertRaises(ValueError):self.subject.apply(self.point, forged)
            self.assert_held_without_mutation()
        path = self.point_dir / 'capture-draft.orbis';path.write_bytes(b'changed draft')
        with self.assertRaises(ValueError):self.subject.apply(self.point, approval)
        self.assert_held_without_mutation()

    def test_lost_stop_response_observes_stopped_execution_without_replaying_stop(self):
        approval = self.approval();after = self.docker.after_change
        def lost(args):
            after(args)
            if args[0] == 'stop':raise RuntimeError('lost stop response')
        self.docker.after_change = lost
        with self.assertRaises(RuntimeError):self.subject.apply(self.point, approval)
        self.docker.after_change = after
        result = self.subject.apply(self.point, approval)
        self.assertEqual(result['schema'], M.SCHEMA + '.complete')
        self.assertEqual([args[0] for args, _ in self.docker.calls], ['stop', 'start'])

    def test_unknown_stop_outcome_does_not_reissue_command(self):
        approval = self.approval()
        with mock.patch.object(self.docker, 'change', side_effect=RuntimeError('unobserved stop')) as change:
            with self.assertRaises(RuntimeError):self.subject.apply(self.point, approval)
            with self.assertRaises(ValueError):self.subject.apply(self.point, approval)
        self.assertEqual(change.call_count, 1);self.assert_held_without_mutation()

    def test_lost_start_response_observes_new_execution_without_replaying_start(self):
        approval = self.approval();after = self.docker.after_change
        def lost(args):
            after(args)
            if args[0] == 'start':raise RuntimeError('lost start response')
        self.docker.after_change = lost
        with self.assertRaises(RuntimeError):self.subject.apply(self.point, approval)
        self.docker.after_change = after
        result = self.subject.apply(self.point, approval)
        self.assertEqual(result['schema'], M.SCHEMA + '.complete')
        self.assertEqual([args[0] for args, _ in self.docker.calls], ['stop', 'start'])

    def test_interrupted_point_and_marker_publication_can_finish_from_exact_evidence(self):
        approval = self.approval()
        with mock.patch.object(self.subject, 'marker_write', side_effect=OSError('interrupted publication')):
            with self.assertRaises(OSError):self.subject.apply(self.point, approval)
        self.assertEqual(json.loads((self.point_dir / 'point.json').read_bytes())['status'], 'failed')
        self.assertTrue(W.CORE.HOST.capture_fence_path(self.root).exists())
        result = self.subject.apply(self.point, approval)
        self.assertEqual(result['schema'], M.SCHEMA + '.complete')
        self.assertEqual([args[0] for args, _ in self.docker.calls], ['stop', 'start'])

    def test_interrupted_after_lease_retirement_can_start_once(self):
        approval = self.approval()
        with mock.patch.object(self.subject, 'start', side_effect=OSError('interrupted before start')):
            with self.assertRaises(OSError):self.subject.apply(self.point, approval)
        self.assertFalse(W.CORE.HOST.capture_fence_path(self.root).exists())
        result = self.subject.apply(self.point, approval)
        self.assertEqual(result['schema'], M.SCHEMA + '.complete')
        self.assertEqual([args[0] for args, _ in self.docker.calls], ['stop', 'start'])

    def test_completed_apply_and_read_only_status_never_restart_again(self):
        approval = self.approval();result = self.subject.apply(self.point, approval)
        calls = copy.deepcopy(self.docker.calls)
        self.assertEqual(self.subject.apply(self.point, approval), result)
        status = self.subject.status(self.point)
        self.assertEqual(status, {'id': self.point, 'state': 'complete', 'result': result})
        self.assertEqual(self.docker.calls, calls)

    def test_unhealthy_dependency_prevents_stopping_original_controller(self):
        database = next(key for key, row in self.docker.services.items() if row['name'] == '/runtipi-db')
        approval = self.approval();self.health[database] = 'unhealthy'
        with self.assertRaises(ValueError):self.subject.apply(self.point, approval)
        self.assert_held_without_mutation()

    def test_dependency_failure_after_stop_keeps_metadata_and_lease_held(self):
        database = next(key for key, row in self.docker.services.items() if row['name'] == '/runtipi-db')
        approval = self.approval();after = self.docker.after_change
        def lost(args):
            after(args)
            if args[0] == 'stop':self.health[database] = 'unhealthy'
        self.docker.after_change = lost
        with self.assertRaises(ValueError):self.subject.apply(self.point, approval)
        self.assertEqual(json.loads((self.point_dir / 'point.json').read_bytes())['status'], 'capturing')
        self.assertTrue(W.CORE.HOST.capture_fence_path(self.root).exists())
        self.assertTrue((self.markers / 'source-hold.json').exists())

    def test_changed_draft_after_stop_preserves_old_point_and_retains_hold(self):
        approval = self.approval();after = self.docker.after_change
        def changed(args):
            after(args)
            if args[0] == 'stop':(self.point_dir / 'capture-draft.orbis').write_bytes(b'changed during stop')
        self.docker.after_change = changed
        with self.assertRaises(ValueError):self.subject.apply(self.point, approval)
        self.assertEqual(json.loads((self.point_dir / 'point.json').read_bytes())['status'], 'capturing')
        self.assertTrue(W.CORE.HOST.capture_fence_path(self.root).exists())

    def test_interrupted_marker_commit_finishes_without_a_second_stop(self):
        approval = self.approval();persist = self.subject.persist
        def interrupted(directory, name, value):
            if name == 'metadata-commit.json':raise OSError('metadata commit sync interrupted')
            return persist(directory, name, value)
        with mock.patch.object(self.subject, 'persist', side_effect=interrupted):
            with self.assertRaises(OSError):self.subject.apply(self.point, approval)
        self.assertFalse((self.markers / 'source-hold.json').exists())
        self.assertTrue(W.CORE.HOST.capture_fence_path(self.root).exists())
        self.subject.apply(self.point, approval)
        self.assertEqual([args[0] for args, _ in self.docker.calls], ['stop', 'start'])

    def test_changed_receipt_or_envelope_after_retirement_prevents_cold_start(self):
        approval = self.approval()
        with mock.patch.object(self.subject, 'start', side_effect=OSError('held before cold start')):
            with self.assertRaises(OSError):self.subject.apply(self.point, approval)
        before = (self.point_dir / 'point.json').read_bytes();value = json.loads(before)
        value['envelope']['keyId'] = 'f' * 64;self.write(self.point_dir, 'point.json', value)
        with self.assertRaises(ValueError):self.subject.apply(self.point, approval)
        self.assertEqual([args[0] for args, _ in self.docker.calls], ['stop'])

    def test_storage_symlink_or_readable_private_point_is_rejected(self):
        file = self.point_dir / 'point.json';file.chmod(0o644)
        with self.assertRaises(ValueError):self.subject.review(self.point, self.actor)
        file.chmod(0o600);retained = self.point_dir.with_name('retained-point');self.point_dir.rename(retained)
        self.point_dir.symlink_to(retained, target_is_directory=True)
        with self.assertRaises(OSError):self.subject.review(self.point, self.actor)
        self.assert_held_without_mutation()


class FailedCaptureRecoveryCliTests(unittest.TestCase):
    def args(self):
        return ['review', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '--root', '/srv/orbis',
                '--state-dir', '/var/lib/orbis/state', '--snapshots', '/var/lib/orbis/snapshots',
                '--docker-context', 'default', '--operator-id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                '--authorization-sha256', 'a' * 64]

    def test_root_gate_precedes_any_service_construction(self):
        with mock.patch.object(M.os, 'geteuid', return_value=501), mock.patch.object(M, 'cli_context') as context:
            with self.assertRaises(ValueError):M.main(self.args())
        context.assert_not_called()

    def test_apply_requires_exact_digest_and_confirmation(self):
        args = self.args();args[0] = 'apply'
        with self.assertRaises(SystemExit):M.arguments(args)
        result = M.arguments([*args, '--review-sha256', 'c' * 64,
                              '--confirmation-id', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'])
        self.assertEqual(result.review_sha256, 'c' * 64)

    def test_relative_paths_and_context_commands_are_rejected(self):
        for option, value in [('--root', '../orbis'), ('--docker-context', 'default;stop'), ('--authorization-sha256', 'invalid')]:
            args = self.args();args[args.index(option) + 1] = value
            with self.subTest(option=option), self.assertRaises(SystemExit):M.arguments(args)

    def test_review_does_not_accept_a_mutation_confirmation(self):
        with self.assertRaises(SystemExit):M.arguments([*self.args(), '--review-sha256', 'c' * 64])


if __name__ == '__main__':unittest.main()
