import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module


R = load('test_orbis_host_core_capture_reserved.py', 'restart_retirement_fixture')
M = load('orbis-host-core-capture-restart-retirement.py', 'restart_retirement_subject')
REAL_PLATFORM = M.require_platform
REAL_SUPERVISOR_ABSENCE = M.supervisor_absence
S, F = R.S, R.F
OLD = '2026-11-07T22:48:20.593Z'
NEW = '2026-11-09T14:56:23.438Z'
FINISHED = '2026-11-09T14:56:08.940Z'
BOOT = {'bootId': '12345678-1234-4234-8234-123456789abc', 'bootTimeSeconds': 1794236159,
        'clockTicksPerSecond': 100}


class RestartRetirementTests(unittest.TestCase):
    """Real authority/files/rename; authenticated source, Docker and proc are synthetic seams."""
    def setUp(self):
        self.reserved = R.ReservedCaptureTests('test_prepare_returns_only_after_real_durable_lease_and_exact_pins')
        self.reserved.setUp()
        self.addCleanup(self.reserved.doCleanups)
        self.f = self.reserved.fixture
        self.docker, self.manager, self.point = self.f.docker, self.reserved.manager, self.reserved.point
        self.docker.starts[self.docker.controller_id] = OLD
        self.reserved.prepare()
        self.reserved.use_real_idle_guard()
        self.docker.starts[self.docker.controller_id] = NEW
        self.state_fields = {'FinishedAt': FINISHED, 'Pid': 6619, 'Dead': False, 'OOMKilled': False}
        real_object = self.docker._object
        def inspect(arguments):
            value = real_object(arguments)
            if (arguments[:2] == ['container', 'inspect'] and arguments[-1] == self.docker.controller_id
                    and arguments[-2] == '{{json .}}'):
                value['State'].update(self.state_fields)
            return value
        self.enterContext(mock.patch.object(self.docker, '_object', side_effect=inspect))
        self.enterContext(mock.patch.object(M, 'require_platform'))
        self.boot = self.enterContext(mock.patch.object(M, 'boot_witness', return_value=copy.deepcopy(BOOT)))
        self.supervisor = self.enterContext(mock.patch.object(M, 'supervisor_absence', return_value={
            'unit': 'orbis-core-capture-' + self.point + '.service', 'LoadState': 'not-found',
            'ActiveState': 'inactive', 'SubState': 'dead', 'ControlGroup': '', 'InvocationID': '',
            'MainPID': '0', 'ControlPID': '0', 'ExecMainPID': '0'}))
        self.helper = M.CoreCaptureRestartRetirement(self.manager, S.W)
        self.fence = S.H.capture_fence_path(self.f.root)
        self.actor = {'operatorId': F.OTHER, 'authorizationSha256': 'f' * 64}
        self.fake_root = self.f.parent / 'current-container-root'
        (self.fake_root / 'data' / 'backups' / 'time-machine').mkdir(mode=0o700, parents=True)
        for path in (self.fake_root, self.fake_root / 'data', self.fake_root / 'data' / 'backups'):
            path.chmod(0o755)
        self.point_directory = self.fake_root / 'data' / 'backups' / 'time-machine' / 'points' / self.point
        self.point_directory.parent.mkdir(mode=0o700)
        self.point_directory.mkdir(mode=0o700)
        self.point_file = self.point_directory / 'point.json'
        self.point_record = {**copy.deepcopy(self.reserved.reservation),
            'kind': 'orbis-core', 'coreFormat': 'orbis.time-machine-core.v1', 'core': None,
            'status': 'capturing', 'backupJobId': None, 'issue': None, 'archiveBytes': 0,
            'archiveSha256': None, 'metadataSha256': None}
        self.write_point()
        self.proc = self.f.parent / 'current-kernel-proc'
        self.proc.mkdir(mode=0o700)
        self.proc_ticks = 2443
        self.namespace_checks = 0
        owner = self
        class Namespace:
            def __init__(self, worker, reader, frame):
                self.frame = copy.deepcopy(frame)
                self.pid = owner.state_fields['Pid'];self.start = owner.proc_ticks
                self.proc = os.open(owner.proc, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                self.root = os.open(owner.fake_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                self.mount_identity = tuple(getattr(os.fstat(self.proc), key) for key in self_fields)
                self.root_identity = tuple(getattr(os.fstat(self.root), key) for key in self_fields)
                self.unchanged()
            def unchanged(self):
                owner.namespace_checks += 1
                M.require(self.pid == owner.state_fields['Pid'] and self.start == owner.proc_ticks
                          and self.frame['startedAt'] == owner.docker.starts[owner.docker.controller_id]
                          and self.root_identity == tuple(getattr(owner.fake_root.stat(), key) for key in self_fields)
                          and self.mount_identity == tuple(getattr(owner.proc.stat(), key) for key in self_fields))
            def __enter__(self):return self
            def __exit__(self, *args):
                os.close(self.proc);os.close(self.root)
        self_fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid')
        self.enterContext(mock.patch.object(self.helper.namespace, 'CaptureNamespace', Namespace))

    def write_point(self):
        self.point_file.write_text(json.dumps(self.point_record))
        self.point_file.chmod(0o600)

    def approval(self):
        review = self.helper.review(self.point, self.actor)
        return M.RootRestartRetirementApproval(copy.deepcopy(self.actor), review['reviewSha256'], F.OTHER)

    def reservation_sha(self):
        return json.loads((self.manager.directory(self.point) / 'preparation.json').read_text())['pointReservationSha256']

    def test_observation_never_creates_a_retirement_or_releases_the_live_lease(self):
        before = self.snapshot()
        result = self.helper.observe(self.point, self.reservation_sha())
        self.assertEqual(result['state'], 'not-retired')
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.helper.transaction(self.point).exists())

    def test_observation_verifies_an_existing_root_commit_without_a_new_operator_approval(self):
        completed = self.helper.apply(self.point, self.approval())
        before = self.snapshot()
        result = self.helper.observe(self.point, self.reservation_sha())
        self.assertEqual(result['state'], 'preparation-retired')
        self.assertEqual(result['receiptSha256'], completed['receiptSha256'])
        self.assertEqual(result['pointRecordSha256'], S.W.digest(self.point_file.read_bytes()))
        self.assertFalse(result['captureCompleted'])
        self.assertFalse(result['queueStateProved'])
        self.assertFalse(result['activation'])
        self.assertEqual(self.snapshot(), before)
        with self.assertRaises(ValueError):
            self.helper.observe(self.point, '0' * 64)
        self.assertEqual(self.snapshot(), before)

    def test_prepared_receipt_without_the_atomic_retirement_commit_is_not_completion(self):
        approval = self.approval()
        with mock.patch.object(self.helper.retirement, 'rename_noreplace', side_effect=OSError('commit not reached')):
            with self.assertRaises(OSError):
                self.helper.apply(self.point, approval)
        before = self.snapshot()
        self.assertEqual(self.helper.observe(self.point, self.reservation_sha())['state'], 'not-retired')
        self.assertEqual(self.snapshot(), before)

    def snapshot(self):
        result = {}
        for root in (self.f.state, self.fence.parent):
            for path in root.rglob('*'):
                if path.is_file() and not path.is_symlink():
                    result[str(path)] = (S.W.digest(path.read_bytes()), S.A.seal(path.stat()))
        return result

    def assert_refused_without_write(self, approval=None):
        before = self.snapshot()
        with self.assertRaises((ValueError, OSError)):
            if approval is None:self.helper.review(self.point, self.actor)
            else:self.helper.apply(self.point, approval)
        after = self.snapshot()
        if before != after:
            fields = S.W.RESERVED.IDENTITY_NAMES
            differences = {str(Path(path).relative_to(self.f.parent)): {
                'sameBytes': before[path][0] == after[path][0],
                'changedSealFields': {name: {'before': before[path][1][index], 'after': after[path][1][index]}
                                      for index, name in enumerate(fields) if before[path][1][index] != after[path][1][index]}}
                for path in before.keys() & after.keys() if before[path] != after[path]}
            print(json.dumps({'boundary': 'protected review/apply refusal', 'differences': differences}, sort_keys=True), file=sys.stderr)
        self.assertEqual({key: value for key, value in before.items() if value != after.get(key)},
                         {key: value for key, value in after.items() if value != before.get(key)})
        self.assertEqual(self.docker.calls, [])
        self.reserved.launch.assert_not_called()
        self.assertFalse(self.helper.transaction(self.point).exists())

    def test_review_is_read_only_sanitized_and_binds_terminated_unadmitted_execution(self):
        before = self.snapshot()
        result = self.helper.review(self.point, self.actor)
        self.assertEqual(before, self.snapshot())
        proof = result['review']
        self.assertEqual(proof['schema'], M.REVIEW)
        self.assertEqual(proof['currentBootObservation'], BOOT)
        self.assertFalse(proof['hostRebootProved'])
        self.assertEqual(proof['supervisorAbsent']['LoadState'], 'not-found')
        self.assertEqual(proof['originalController']['startedAt'], OLD)
        self.assertEqual(proof['newController']['startedAt'], NEW)
        self.assertEqual(proof['priorFinishedAt'], FINISHED)
        self.assertEqual(proof['process']['startTicks'], 2443)
        self.assertEqual(set(proof['preparationRecords']), M.PREPARATION_FILES)
        body = json.dumps(result)
        for secret in (self.reserved.reservation['envelope']['nonce'],
                       self.reserved.reservation['envelope']['value'], self.reserved.authority().grant['nonce']):
            self.assertNotIn(secret, body)
        self.assertFalse(self.helper.base.exists())
        self.assertFalse(proof['captureCompleted'])
        self.assertEqual(proof['sourceAttempt'], 'unknown-before-controller-restart')

    def test_apply_preserves_exact_original_inode_bytes_and_blocks_old_admission(self):
        approval = self.approval()
        old = self.fence.read_bytes();seal = S.A.seal(self.fence.stat())
        preparations = {path: (path.read_bytes(), S.A.seal(path.stat()))
                        for path in self.reserved.authority().directory.iterdir()}
        result = self.helper.apply(self.point, approval)
        self.assertEqual(result['state'], 'preparation-retired')
        self.assertFalse(self.fence.exists())
        S.H.require_no_capture_fence(self.f.root)
        directory = self.helper.transaction(self.point)
        intent = json.loads((directory / 'intent.json').read_text())
        retired = self.fence.with_name(intent['retiredName'])
        self.assertEqual(retired.read_bytes(), old)
        self.assertEqual(S.A.seal(retired.stat())[:-1], seal[:-1])
        for path in directory.iterdir():self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o400)
        for path, expected in preparations.items():self.assertEqual((path.read_bytes(), S.A.seal(path.stat())), expected)
        self.assertEqual(self.docker.calls, [])
        self.reserved.launch.assert_not_called()
        before = self.snapshot()
        with mock.patch.object(self.manager, 'observe', side_effect=AssertionError('status must not execute new source work')):
            self.assertEqual(self.helper.apply(self.point, approval), result)
        self.assertEqual(before, self.snapshot())
        with self.assertRaises((ValueError, OSError)):self.reserved.authority()
        with self.assertRaises((ValueError, OSError)):
            S.W.RESERVED.PreparationIntent(S.W, self.f.state, self.f.root, self.manager.context, self.point).selection()
        with self.assertRaises((ValueError, OSError)):
            self.manager.admit(self.point, self.reserved.request)
        self.reserved.launch.assert_not_called()

    def test_startup_and_positive_termination_are_mandatory(self):
        for value in ('0001-01-01T00:00:00Z', '2026-11-10T00:00:00Z', None):
            with self.subTest(value=value):
                self.state_fields['FinishedAt'] = value
                self.assert_refused_without_write()

    def test_same_boot_termination_does_not_claim_a_host_reboot(self):
        self.boot.return_value = {**BOOT, 'bootTimeSeconds': 1}
        proof = self.helper.review(self.point, self.actor)['review']
        self.assertFalse(proof['hostRebootProved'])
        self.assertEqual(proof['currentBootObservation']['bootTimeSeconds'], 1)

    def test_original_or_invalid_execution_refused(self):
        for value in (OLD, '2026-11-09T14:55:58Z'):
            with self.subTest(value=value):
                self.docker.starts[self.docker.controller_id] = value
                self.assert_refused_without_write()

    def test_unavailable_or_existing_supervisor_refused(self):
        self.supervisor.side_effect = ValueError('Supervisor absence could not be established')
        self.assert_refused_without_write()

    def test_not_live_or_ambiguous_execution_refused(self):
        for key, value in (('Pid', 0), ('Pid', True), ('Dead', True), ('OOMKilled', True),
                           ('Paused', True), ('Restarting', True), ('Running', False), ('Status', 'exited')):
            with self.subTest(key=key):
                previous = self.state_fields.copy();self.state_fields[key] = value
                self.assert_refused_without_write();self.state_fields = previous

    def test_exact_definition_image_and_source_binding_refused_on_drift(self):
        real = self.manager.observe
        for field, value in (('definitionSha256', '0' * 64), ('imageId', 'sha256:' + '0' * 64), ('id', '0' * 64)):
            def changed(reader):
                result = real(reader);result['controller'][field] = value;return result
            with self.subTest(field=field), mock.patch.object(self.manager, 'observe', side_effect=changed):
                self.assert_refused_without_write()
        with mock.patch.object(self.manager.capture, 'source', return_value={'changed': True}):
            self.assert_refused_without_write()

    def test_changed_point_owner_is_not_adopted(self):
        self.point_record['ownerId'] = 2;self.write_point()
        self.assert_refused_without_write()

    def test_empty_interrupted_point_can_be_retired_but_never_admitted(self):
        issue = 'Capture interrupted by a restart.'
        self.point_record.update(status='interrupted', issue=issue);self.write_point()
        original = self.point_file.read_bytes()
        proof = self.helper.review(self.point, self.actor)['review']
        self.assertEqual(proof['pointRecord']['status'], 'interrupted')
        self.assertEqual(proof['pointRecord']['issueSha256'], S.W.digest(issue.encode()))
        self.assertNotIn(issue, json.dumps(proof))
        with self.assertRaises(self.helper.reservation.ReservationError):
            self.helper.reservation.reservation(original, self.point)
        result = self.helper.apply(self.point, self.approval())
        self.assertEqual(result['state'], 'preparation-retired')
        self.assertEqual(self.point_file.read_bytes(), original)
        self.assertFalse(result['captureCompleted'])

    def test_nonempty_or_invalid_interrupted_points_refused(self):
        baseline = copy.deepcopy(self.point_record)
        changes = ({'status': 'complete'}, {'status': 'failed'}, {'status': 'interrupted', 'issue': None},
            {'status': 'interrupted', 'issue': ''}, {'status': 'interrupted', 'issue': 'x' * 4097},
            {'issue': 'Unexpected capturing issue'}, {'core': {}}, {'backupJobId': self.point},
            {'archiveBytes': 1}, {'archiveBytes': False}, {'assetBytes': 1}, {'assetBytes': False},
            {'archiveSha256': 'a' * 64}, {'metadataSha256': 'b' * 64},
            {'envelope': {**baseline['envelope'], 'value': 'a' * 86}}, {'unknown': True})
        for change in changes:
            with self.subTest(fields=tuple(change)):
                self.point_record = {**baseline, **change};self.write_point()
                self.assert_refused_without_write()

    def test_point_file_or_artifacts_rejected(self):
        self.point_file.chmod(0o644);self.assert_refused_without_write();self.point_file.chmod(0o600)
        artifact = self.point_directory / 'archive.tar'
        artifact.write_bytes(b'');self.assert_refused_without_write();artifact.unlink()
        saved = self.point_file.with_name('saved.json');self.point_file.rename(saved)
        self.point_file.symlink_to(saved);self.assert_refused_without_write()

    def test_point_replacement_or_change_after_review_refused(self):
        approval = self.approval()
        body = self.point_file.read_bytes()
        self.point_file.unlink();self.point_file.write_bytes(body);self.point_file.chmod(0o600)
        self.assert_refused_without_write(approval)

    def test_point_duplicate_json_and_oversize_refused(self):
        body = self.point_file.read_text()
        self.point_file.write_text('{"status":"capturing",' + body[1:])
        self.assert_refused_without_write()
        self.point_file.write_bytes(b' ' * 32769)
        self.assert_refused_without_write()

    def test_entire_capture_directory_must_be_absent_even_empty_or_symlink(self):
        path = self.fake_root / 'data' / 'backups' / 'time-machine' / 'core-capture'
        path.mkdir(mode=0o700)
        self.assert_refused_without_write()
        (path / 'marker.json').write_text('{}')
        self.assert_refused_without_write()
        (path / 'marker.json').unlink();path.rmdir();path.symlink_to(self.proc)
        self.assert_refused_without_write()

    def test_storage_permissions_and_symlinks_refused_with_real_walk(self):
        path = self.fake_root / 'data' / 'backups' / 'time-machine'
        path.chmod(0o755);self.assert_refused_without_write();path.chmod(0o700)
        parent = path.parent;parent.chmod(0o777);self.assert_refused_without_write();parent.chmod(0o755)
        saved = path.with_name('saved');path.rename(saved);path.symlink_to(saved)
        self.assert_refused_without_write()

    def test_foreign_storage_owner_is_refused(self):
        real = os.fstat
        target = (self.fake_root / 'data' / 'backups').stat().st_ino
        def foreign(fd):
            value = real(fd)
            if value.st_ino != target:return value
            class Changed:
                def __getattr__(self, name):return getattr(value, name)
                st_uid = os.geteuid() + 1
            return Changed()
        with mock.patch.object(M.os, 'fstat', side_effect=foreign):self.assert_refused_without_write()

    def test_any_additional_preparation_record_refuses(self):
        directory = self.reserved.authority().directory
        for name in ('decision.json', 'abort-intent.json', 'checkpoint.json', 'job.json'):
            with self.subTest(name=name):
                path = directory / name;path.write_bytes(b'{}');path.chmod(0o600)
                self.assert_refused_without_write();path.unlink()

    def test_admission_job_snapshot_or_checkpoint_directory_refuses(self):
        paths = (self.f.state / 'core-capture-admissions' / self.point,
                 self.manager.capture.base / self.point,
                 self.manager.capture.snapshots / ('orbis-time-machine-core-' + self.point))
        for path in paths:
            with self.subTest(path=path.name):
                path.parent.mkdir(mode=0o700, exist_ok=True);path.mkdir(mode=0o700)
                self.assert_refused_without_write();path.rmdir()

    def test_active_other_operations_remain_excluded(self):
        service = self.reserved.service
        service.busy = True;self.assert_refused_without_write();service.busy = False
        for path in (service.job_file, service.package_job_file):
            path.write_text('{"state":"running"}');self.assert_refused_without_write();path.unlink()

    def test_review_actor_point_and_hash_are_bound_before_writes(self):
        approval = self.approval()
        for changed in (M.RootRestartRetirementApproval({**self.actor, 'authorizationSha256': '0' * 64}, approval.review_sha256, F.OTHER),
                        M.RootRestartRetirementApproval(self.actor, '0' * 64, F.OTHER)):
            self.assert_refused_without_write(changed)
        with self.assertRaises((ValueError, OSError)):
            self.helper.apply(F.OTHER, approval)
        with self.assertRaises(ValueError):self.helper.apply(self.point, {'reviewSha256': approval.review_sha256})

    def test_identical_replacement_of_root_record_or_lease_refuses(self):
        approval = self.approval()
        for path in (self.reserved.authority().directory / 'preparation-intent.json', self.fence):
            with self.subTest(path=path.name):
                replacement = path.with_name('replacement');replacement.write_bytes(path.read_bytes());replacement.chmod(0o600)
                replacement.replace(path)
                self.assert_refused_without_write(approval)

    def test_namespace_or_storage_replacement_after_review_refuses(self):
        approval = self.approval();self.proc_ticks += 1
        self.assert_refused_without_write(approval)
        self.proc_ticks -= 1
        path = self.fake_root / 'data' / 'backups' / 'time-machine'
        path.rename(path.with_name('old-storage'));path.mkdir(mode=0o700)
        self.assert_refused_without_write(approval)

    def test_post_intent_source_race_retains_intent_and_never_renames(self):
        approval = self.approval();publish = self.helper._publish
        def race(directory, name, value):
            pin = publish(directory, name, value)
            if name == 'intent.json':self.proc_ticks += 1
            return pin
        with mock.patch.object(self.helper, '_publish', side_effect=race):
            with self.assertRaises(ValueError):self.helper.apply(self.point, approval)
        self.assertTrue(self.fence.exists())
        intent = self.helper.transaction(self.point) / 'intent.json'
        self.assertEqual(stat.S_IMODE(intent.stat().st_mode), 0o400)
        before = self.snapshot()
        with mock.patch.object(self.manager, 'observe', side_effect=AssertionError('no automatic retry')):
            self.assertEqual(self.helper.apply(self.point, approval)['state'], 'operator-review-required-before-retirement')
        self.assertEqual(before, self.snapshot())

    def test_partial_intent_or_empty_transaction_is_never_adopted(self):
        approval = self.approval()
        self.helper.base.mkdir(mode=0o700);directory = self.helper.transaction(self.point);directory.mkdir(mode=0o700)
        for body in (None, b'{"schema":'):
            if body is not None:(directory / 'intent.json').write_bytes(body);(directory / 'intent.json').chmod(0o400)
            before = self.snapshot()
            with self.assertRaises((ValueError, OSError)):self.helper.apply(self.point, approval)
            self.assertEqual(before, self.snapshot());self.assertTrue(self.fence.exists())

    def test_rename_never_clobbers_destination_and_preserves_uncertainty(self):
        approval = self.approval();publish = self.helper._publish
        retired = self.fence.with_name(self.helper._retired_name(self.point, F.OTHER))
        def collide(directory, name, value):
            pin = publish(directory, name, value)
            if name == 'intent.json':retired.write_bytes(b'collision');retired.chmod(0o600)
            return pin
        with mock.patch.object(self.helper, '_publish', side_effect=collide):
            with self.assertRaises((ValueError, OSError)):self.helper.apply(self.point, approval)
        self.assertEqual(retired.read_bytes(), b'collision');self.assertTrue(self.fence.exists())

    def test_receipt_failure_keeps_original_fence_and_never_replays(self):
        approval = self.approval();publish = self.helper._publish
        def fail_receipt(directory, name, value):
            if name == 'receipt.json':raise OSError('synthetic receipt storage failure')
            return publish(directory, name, value)
        with mock.patch.object(self.helper, '_publish', side_effect=fail_receipt):
            with self.assertRaises(OSError):self.helper.apply(self.point, approval)
        self.assertTrue(self.fence.exists())
        with self.assertRaises(ValueError):S.H.require_no_capture_fence(self.f.root)
        before = self.snapshot()
        with mock.patch.object(self.helper.retirement, 'rename_noreplace', side_effect=AssertionError('rename replay')):
            self.assertEqual(self.helper.apply(self.point, approval)['state'], 'operator-review-required-before-retirement')
        self.assertEqual(before, self.snapshot())

    def test_final_guard_failure_after_receipt_keeps_exclusion(self):
        approval = self.approval();publish = self.helper._publish
        def changed(directory, name, value):
            pin = publish(directory, name, value)
            if name == 'receipt.json':
                self.point_record.update(status='interrupted', issue='Changed before commit');self.write_point()
            return pin
        with mock.patch.object(self.helper, '_publish', side_effect=changed):
            with self.assertRaises(ValueError):self.helper.apply(self.point, approval)
        self.assertTrue(self.fence.exists())
        self.assertTrue((self.helper.transaction(self.point) / 'receipt.json').exists())
        with self.assertRaises(ValueError):
            with S.H.host_lock(self.f.root):self.fail('Uncommitted recovery released exclusion')

    def test_failed_rename_leaves_prepared_receipt_held_without_retry(self):
        approval = self.approval()
        with mock.patch.object(self.helper.retirement, 'rename_noreplace', side_effect=OSError('synthetic failed rename')):
            with self.assertRaises(OSError):self.helper.apply(self.point, approval)
        self.assertTrue(self.fence.exists())
        self.assertTrue((self.helper.transaction(self.point) / 'receipt.json').exists())
        with self.assertRaises(ValueError):S.H.require_no_capture_fence(self.f.root)
        before = self.snapshot()
        with mock.patch.object(self.helper.retirement, 'rename_noreplace', side_effect=AssertionError('rename replay')):
            self.assertEqual(self.helper.apply(self.point, approval)['state'], 'operator-review-required-before-retirement')
        self.assertEqual(before, self.snapshot())

    def test_lost_response_after_atomic_commit_is_inspectable_without_replay(self):
        approval = self.approval();rename = self.helper.retirement.rename_noreplace
        def lost_response(parent, source, target):
            rename(parent, source, target)
            raise OSError('synthetic response loss after irreversible commit')
        with mock.patch.object(self.helper.retirement, 'rename_noreplace', side_effect=lost_response):
            with self.assertRaises(OSError):self.helper.apply(self.point, approval)
        self.assertFalse(self.fence.exists())
        before = self.snapshot()
        with mock.patch.object(self.helper.retirement, 'rename_noreplace', side_effect=AssertionError('rename replay')):
            self.assertEqual(self.helper.apply(self.point, approval)['state'], 'preparation-retired')
        self.assertEqual(before, self.snapshot())
        S.H.require_no_capture_fence(self.f.root)

    def test_source_change_after_atomic_commit_is_not_a_pending_retirement(self):
        approval = self.approval();rename = self.helper.retirement.rename_noreplace
        def changed(parent, source, target):
            rename(parent, source, target)
            self.point_record.update(status='interrupted', issue='Changed after commit');self.write_point()
        with mock.patch.object(self.helper.retirement, 'rename_noreplace', side_effect=changed):
            result = self.helper.apply(self.point, approval)
        self.assertEqual(result['state'], 'preparation-retired')
        self.assertFalse(result['captureCompleted'])
        S.H.require_no_capture_fence(self.f.root)

    def test_historical_status_survives_a_different_point_preparation_and_lease(self):
        approval = self.approval();self.helper.apply(self.point, approval)
        (self.f.state / 'core-capture-preparations' / F.OTHER).mkdir(mode=0o700)
        retired = self.fence.with_name(self.helper._retired_name(self.point, F.OTHER))
        lease = json.loads(retired.read_bytes());lease.update(id=F.OTHER, nonce='0' * 64)
        self.fence.write_bytes(S.P.canonical(lease));self.fence.chmod(0o600)
        before = self.snapshot()
        with mock.patch.object(self.helper.retirement, 'rename_noreplace', side_effect=AssertionError('rename replay')):
            self.assertEqual(self.helper.apply(self.point, approval)['state'], 'preparation-retired')
        self.assertEqual(before, self.snapshot())

    def test_historical_status_rejects_reappearance_of_original_selector(self):
        approval = self.approval();self.helper.apply(self.point, approval)
        retired = self.fence.with_name(self.helper._retired_name(self.point, F.OTHER))
        lease = json.loads(retired.read_bytes())
        for change in ({}, {'id': F.OTHER}, {'nonce': '0' * 64}):
            with self.subTest(fields=tuple(change)):
                self.fence.write_bytes(S.P.canonical({**lease, **change}));self.fence.chmod(0o600)
                with self.assertRaises(ValueError):self.helper.status(self.point, approval)

    def test_final_receipt_rejects_replaced_intent_and_tampered_retired_inode(self):
        approval = self.approval();self.helper.apply(self.point, approval)
        intent = self.helper.transaction(self.point) / 'intent.json'
        replacement = intent.with_name('replacement');replacement.write_bytes(intent.read_bytes());replacement.chmod(0o400)
        replacement.replace(intent)
        with self.assertRaises(ValueError):self.helper.status(self.point, approval)

    def test_bad_actor_and_nonlinux_platform_are_not_accepted(self):
        for actor in ({}, {'operatorId': F.OTHER, 'authorizationSha256': 'x'}, {**self.actor, 'flag': True}):
            with self.assertRaises(ValueError):self.helper.review(self.point, actor)
        with mock.patch.object(M.os, 'uname', return_value=type('U', (), {'sysname': 'Darwin'})()):
            with self.assertRaises(ValueError):REAL_PLATFORM(S.W)


class SupervisorAbsenceTests(unittest.TestCase):
    def response(self, **changes):
        fields = {'LoadState': 'not-found', 'ActiveState': 'inactive', 'SubState': 'dead',
                  'ControlGroup': '', 'InvocationID': '', 'MainPID': '0', 'ControlPID': '0', 'ExecMainPID': '0'}
        fields.update(changes)
        return '\n'.join(key + '=' + value for key, value in fields.items()) + '\n'

    def test_only_explicit_absent_supervisor_is_accepted(self):
        for code in (0, 4):
            with mock.patch.object(M.subprocess, 'run', return_value=M.subprocess.CompletedProcess(
                    [], code, self.response(), '')) as run:
                value = REAL_SUPERVISOR_ABSENCE(F.POINT)
                self.assertEqual(value['LoadState'], 'not-found')
                self.assertEqual(run.call_args.args[0][2], 'orbis-core-capture-' + F.POINT + '.service')
        for change in ({'LoadState': 'loaded'}, {'ActiveState': 'active'}, {'SubState': 'running'},
                       {'MainPID': '3'}, {'ControlPID': '3'}, {'ExecMainPID': '3'},
                       {'InvocationID': 'a' * 32}, {'ControlGroup': '/system.slice/worker'}):
            with self.subTest(fields=tuple(change)), mock.patch.object(M.subprocess, 'run',
                    return_value=M.subprocess.CompletedProcess([], 0, self.response(**change), '')):
                with self.assertRaises(ValueError):REAL_SUPERVISOR_ABSENCE(F.POINT)

    def test_query_errors_and_incomplete_or_duplicate_observations_refused(self):
        for stdout, code in (('', 0), (self.response(), 1), (self.response() + 'MainPID=0\n', 0),
                             ('x' * 4097, 0), (self.response().replace('ExecMainPID=0\n', ''), 0)):
            with self.subTest(code=code, size=len(stdout)), mock.patch.object(M.subprocess, 'run',
                    return_value=M.subprocess.CompletedProcess([], code, stdout, '')):
                with self.assertRaises(ValueError):REAL_SUPERVISOR_ABSENCE(F.POINT)
        with mock.patch.object(M.subprocess, 'run', side_effect=M.subprocess.TimeoutExpired(['systemctl'], 10)):
            with self.assertRaises(M.subprocess.TimeoutExpired):REAL_SUPERVISOR_ABSENCE(F.POINT)


class RestartRetirementCliTests(unittest.TestCase):
    def arguments(self, action='review'):
        result = [action, '--root', '/fixture/install', '--snapshots', '/fixture/snapshots',
                  '--state-dir', '/fixture/state', '--docker-context', 'default', '--point', F.POINT,
                  '--operator-id', F.OTHER, '--authorization-sha256', 'a' * 64]
        if action in ('apply', 'status'):
            result += ['--review-sha256', 'b' * 64, '--confirmation-id', '12345678-1234-4234-8234-123456789abc']
        elif action == 'observe':
            result += ['--point-reservation-sha256', 'c' * 64]
        return result

    def test_review_never_applies_or_confirms_a_retirement(self):
        helper = mock.Mock()
        helper.review.return_value = {'reviewSha256': 'b' * 64, 'review': {'captureCompleted': False}}
        with mock.patch.object(M.os, 'geteuid', return_value=0), \
                mock.patch.object(M.os, 'uname', return_value=mock.Mock(sysname='Linux')), \
                mock.patch.object(M, 'cli_context', return_value=helper), mock.patch('builtins.print') as output:
            self.assertEqual(M.main(self.arguments()), 0)
        helper.review.assert_called_once_with(F.POINT, {'operatorId': F.OTHER, 'authorizationSha256': 'a' * 64})
        helper.apply.assert_not_called()
        helper.status.assert_not_called()
        self.assertEqual(json.loads(output.call_args.args[0]), helper.review.return_value)

    def test_apply_and_status_use_the_exact_root_operator_confirmation(self):
        for action in ('apply', 'status'):
            with self.subTest(action=action):
                helper = mock.Mock()
                getattr(helper, action).return_value = {'state': 'preparation-retired'}
                with mock.patch.object(M.os, 'geteuid', return_value=0), \
                        mock.patch.object(M.os, 'uname', return_value=mock.Mock(sysname='Linux')), \
                        mock.patch.object(M, 'cli_context', return_value=helper), mock.patch('builtins.print'):
                    self.assertEqual(M.main(self.arguments(action)), 0)
                point, approval = getattr(helper, action).call_args.args
                self.assertEqual(point, F.POINT)
                self.assertIs(type(approval), M.RootRestartRetirementApproval)
                self.assertEqual(approval.actor, {'operatorId': F.OTHER, 'authorizationSha256': 'a' * 64})
                self.assertEqual(approval.review_sha256, 'b' * 64)
                self.assertEqual(approval.confirmation_id, '12345678-1234-4234-8234-123456789abc')
                helper.review.assert_not_called()

    def test_observation_only_reads_the_exact_existing_point_reservation(self):
        helper = mock.Mock()
        helper.observe.return_value = {'state': 'not-retired'}
        with mock.patch.object(M.os, 'geteuid', return_value=0), \
                mock.patch.object(M.os, 'uname', return_value=mock.Mock(sysname='Linux')), \
                mock.patch.object(M, 'cli_context', return_value=helper), mock.patch('builtins.print'):
            self.assertEqual(M.main(self.arguments('observe')), 0)
        helper.observe.assert_called_once_with(F.POINT, 'c' * 64)
        helper.apply.assert_not_called()
        helper.review.assert_not_called()

    def test_rejects_unprivileged_or_non_linux_callers_before_loading_the_service(self):
        for uid, system in ((501, 'Linux'), (0, 'Darwin')):
            with self.subTest(uid=uid, system=system), mock.patch.object(M.os, 'geteuid', return_value=uid), \
                    mock.patch.object(M.os, 'uname', return_value=mock.Mock(sysname=system)), \
                    mock.patch.object(M, 'cli_context') as context:
                with self.assertRaises(ValueError):
                    M.main(self.arguments())
                context.assert_not_called()

    def test_rejects_incomplete_or_malformed_review_confirmations(self):
        for argv in (self.arguments('apply')[:-2], self.arguments('status')[:-4],
                     self.arguments() + ['--review-sha256', 'b' * 64],
                     self.arguments() + ['--confirmation-id', F.POINT],
                     self.arguments() + ['--authorization-sha256', 'not-a-digest'],
                     self.arguments() + ['--root', 'relative/install'],
                     self.arguments() + ['--state-dir', '/fixture/../state'],
                     self.arguments() + ['--docker-context', 'default; command']):
            with self.subTest(argv=argv), mock.patch('sys.stderr', new=io.StringIO()):
                with self.assertRaises(SystemExit):
                    M.cli_arguments(argv)


if __name__ == '__main__':
    unittest.main()
