from contextlib import contextmanager
from pathlib import Path
import shutil
from types import SimpleNamespace
import unittest
from unittest import mock

import test_orbis_fresh_cutover_birth as fixtures

M = fixtures.M


class FreshRollbackTests(unittest.TestCase):
    """Real canonical storage/checkpoint/restore loops with bounded IO ports.

    Docker discovery/SQL and the Linux rsync copier are explicit fixture ports.
    The portable copier does not qualify native Linux ACL/xattr semantics.
    """
    def setUp(self):
        self.c = fixtures.CutoverBirthTests('test_full_real_snapshot_reset_and_birth_keep_fence_and_match_target')
        self.addCleanup(self.c.doCleanups); self.c.setUp()
        c = self.c; c.r.OWNERSHIP = M
        c.bundle.rmdir()
        for identifier, role in c.roles.items():
            labels = c.raws[identifier]['Config']['Labels']
            labels.update({'com.docker.compose.service': 'runtipi' if role == 'controller' else c.raws[identifier]['Name'][1:],
                           'com.docker.compose.project.working_dir': str(c.root)})
        def rows():
            return [{'id': key, 'name': raw['Name'][1:], 'image': raw['Config']['Image'], 'state': raw['State']['Status'],
                     'project': 'runtipi', 'service': raw['Config']['Labels'].get('com.docker.compose.service', ''),
                     'workingDir': str(c.root), 'managed': '', 'appUrn': '', 'publishedPorts': ''}
                    for key, raw in c.raws.items()]
        c.reader.containers.side_effect = rows
        c.reader.inspect_apps = None
        self.changes = []; self.copy_calls = 0
        self.interrupt_start = False
        def change(args, **kwargs):
            self.changes.append(list(args))
            identifier = args[1] if args[0] == 'rename' else args[-1]
            raw = c.raws[identifier]
            if args[0] == 'update':
                name, _, attempts = args[2].partition(':')
                raw['HostConfig']['RestartPolicy'] = {'Name': name, 'MaximumRetryCount': int(attempts or 0)}
            elif args[0] == 'stop':
                raw['State'].update(Status='exited', Running=False, Pid=0, Paused=False, Restarting=False, Dead=False)
            elif args[0] == 'start':
                if self.interrupt_start:
                    self.interrupt_start = False
                    raise OSError('fixture interrupted original startup')
                raw['State'].update(Status='running', Running=True, Pid=42, Health={'Status': 'healthy'},
                                    Paused=False, Restarting=False, Dead=False)
            elif args[0] == 'rename': raw['Name'] = '/' + args[2]
            elif args[0] == 'rm': c.raws.pop(identifier)
            else: raise AssertionError('Unexpected Docker change')
        c.reader.change = change
        def inspect(args):
            raw = c.inspect(args)
            return raw['State'] if '{{json .State}}' in args else raw
        c.reader._object.side_effect = inspect
        discovery = mock.patch.object(c.r.APPS, 'selected_installation', side_effect=lambda reader, root: (
            {'daemonFingerprint': c.r.APPS.digest_daemon(reader)}, {'container': {'id': c.f.raw['Id']}, 'apps': []}))
        discovery.start(); self.addCleanup(discovery.stop)
        reviewed = c.reviewed
        def canonical_review():
            value = reviewed()
            value['checkpoint'] = c.r.TX.review(c.root, c.reader, c.bundle, c.r.checkpoint_path(c.journal))
            value['reviewId'] = c.r.APPS.digest({key: item for key, item in value.items() if key != 'reviewId'})
            return value
        c.reviewed = canonical_review
        def checkpoint(value, permit):
            c.r.TX.checkpoint(c.root, c.reader, value['checkpoint'], host_writers_stopped=True)
            c.record = {'schema': c.r.SCHEMA, 'id': fixtures.TX, 'stage': 'checkpointed', 'review': value,
                        'retainedName': 'orbis-previous-' + fixtures.TX, 'ownershipPermit': permit.reference,
                        'quiescedConfiguration': c.r.APPS.digest({key: c.f.raw[key] for key in ('Config', 'HostConfig')})}
            c.save()
        c.checkpoint = checkpoint
        runtime = mock.patch.object(c.r.TX.RESTORE, 'runtime')
        runtime.start(); self.addCleanup(runtime.stop)
        actual_run = c.r.TX.RESTORE.subprocess.run
        def portable(args, **kwargs):
            if args[0] != 'rsync': return actual_run(args, **kwargs)
            self.assertIn('--delete', args); self.assertIn('--ignore-times', args)
            self.copy_calls += 1
            self.copy_directory(Path(args[-2]), Path(args[-1]))
            return SimpleNamespace(returncode=0)
        copying = mock.patch.object(c.r.TX.RESTORE.subprocess, 'run', side_effect=portable)
        copying.start(); self.addCleanup(copying.stop)

    def copy_directory(self, source, target):
        names = {p.name for p in source.iterdir()}
        for item in target.iterdir():
            if item.name not in names:
                if item.is_dir() and not item.is_symlink(): shutil.rmtree(item)
                else: item.unlink()
        for item in source.iterdir():
            destination = target / item.name
            if item.is_dir():
                destination.mkdir(exist_ok=True)
                self.copy_directory(item, destination)
            else: shutil.copy2(item, destination)
        shutil.copystat(source, target)

    @contextmanager
    def ready(self, *, reset=False, birth=False):
        c = self.c
        with c.prepared() as (guard, permit):
            c.reset_ready(permit)
            if reset:
                with mock.patch.object(c.r.FRESH.subprocess, 'run', side_effect=c.sql):
                    c.record['freshReset'] = permit.reset_accounts(c.record)
                c.save()
            if birth: permit.publish_birth(c.record)
            yield guard, permit

    def test_real_root_checkpoint_restores_rotated_environment_without_identity_exception(self):
        c = self.c
        with self.ready(reset=True, birth=True) as (guard, permit):
            original = M.L.K.decoded(permit._value)['legacy']['files']['.env']
            self.assertNotEqual(c.host.file_digest(c.root / '.env'), original)
            with c.r.ownership_scope(permit, c.record): result = c.r.rollback(c.record, c.reader)
            self.assertEqual(c.host.file_digest(c.root / '.env'), original)
            self.assertEqual(c.record['stage'], 'rolled-back'); self.assertIsNone(guard.read())
            self.assertEqual(result['result'], 'original-runtipi-recovered')
            self.assertTrue(M.L.B.retired_path(c.root).exists()); self.assertFalse(M.L.B.receipt_path(c.root).exists())
            self.assertEqual(self.copy_calls, 1); self.assertEqual(c.sql_calls, 1)

    def test_pre_reset_rollback_returns_original_without_birth_or_reset(self):
        c = self.c
        with self.ready() as (guard, permit):
            permit.rollback(c.record)
            self.assertIsNone(guard.read()); self.assertEqual(c.sql_calls, 0)
            self.assertFalse(M.L.B.retired_path(c.root).exists()); self.assertEqual(self.copy_calls, 1)

    def test_partial_forward_proof_never_falls_back_to_rollback(self):
        c = self.c
        with self.ready(reset=True, birth=True) as (guard, permit):
            path = M.phase_path(c.root, permit.reference['operationId'], 'forward'); path.write_bytes(b'{'); path.chmod(0o600)
            before = len(self.changes)
            with self.assertRaises(ValueError): permit.rollback(c.record)
            self.assertEqual(len(self.changes), before); self.assertEqual(self.copy_calls, 0)
            self.assertIsNotNone(guard.read()); self.assertEqual(path.read_bytes(), b'{')

    def test_start_interruption_finishes_without_recopying_restored_or_new_data(self):
        c = self.c
        with self.ready(reset=True, birth=True) as (guard, permit):
            selected = permit.reference; self.interrupt_start = True
            with self.assertRaises(OSError): permit.rollback(c.record)
            self.assertEqual(self.copy_calls, 1); self.assertIsNotNone(guard.read())
            self.assertTrue(M.phase_path(c.root, selected['operationId'], 'restored').exists())
        new = c.root / 'state/new-write'; new.write_text('fixture new original data')
        with c.b.guarded() as guard:
            with c.issuer.resume_rollback(guard, c.record, selected) as permit: permit.rollback(c.record)
            self.assertIsNone(guard.read())
        self.assertEqual(new.read_text(), 'fixture new original data'); self.assertEqual(self.copy_calls, 1)

    def test_lost_retirement_reply_and_completed_replay_keep_provenance(self):
        c = self.c
        with self.ready(reset=True, birth=True) as (guard, permit):
            selected = permit.reference
            with mock.patch.object(guard, 'finish', side_effect=OSError('fixture lost retirement reply')):
                with self.assertRaises(OSError): permit.rollback(c.record)
            self.assertIsNotNone(guard.read())
        c.f.raw['State']['StartedAt'] = '2026-11-22T03:00:00.000000000Z'
        for _ in range(2):
            with c.b.guarded() as guard:
                with c.issuer.resume_rollback(guard, c.record, selected) as permit: permit.rollback(c.record)
                self.assertIsNone(guard.read())
        self.assertEqual(self.copy_calls, 1); self.assertTrue(M.L.B.retired_path(c.root).exists())

    def test_changed_backup_prevents_restore_and_keeps_hold(self):
        c = self.c
        with self.ready() as (guard, permit):
            copied = c.bundle / 'resource-0000' / '.env'; copied.write_bytes(b'changed fixture')
            with self.assertRaises(ValueError): permit.rollback(c.record)
            self.assertEqual(self.copy_calls, 0); self.assertIsNotNone(guard.read())

    def test_foreign_writer_prevents_data_copy_and_original_start(self):
        c = self.c
        with self.ready(reset=True, birth=True) as (guard, permit):
            identifier = 'c' * 64
            c.raws[identifier] = {'Id': identifier, 'Name': '/foreign', 'Image': 'sha256:' + 'd' * 64,
                'Config': {'Image': 'fixture/foreign:1', 'Labels': {'com.docker.compose.project': 'outside'}},
                'Mounts': [{'Type': 'bind', 'Source': str(c.root), 'Destination': '/data', 'RW': True}],
                'HostConfig': {'RestartPolicy': {'Name': 'always', 'MaximumRetryCount': 0}},
                'State': {'Status': 'running'}}
            before = len(self.changes)
            with self.assertRaises(ValueError): permit.rollback(c.record)
            self.assertEqual(self.copy_calls, 0); self.assertIsNotNone(guard.read())
            self.assertFalse(any(item[0] == 'start' for item in self.changes[before:]))

    def test_interrupted_copy_replays_verified_copy_before_any_original_can_start(self):
        c = self.c
        with self.ready(reset=True, birth=True) as (guard, permit):
            selected = permit.reference
            actual = self.copy_directory
            def interrupted(source, target):
                actual(source, target)
                raise OSError('fixture copier interrupted')
            self.copy_directory = interrupted
            with self.assertRaises(OSError): permit.rollback(c.record)
            self.copy_directory = actual
            self.assertFalse(M.phase_path(c.root, selected['operationId'], 'restored').exists())
            self.assertEqual(c.f.raw['State']['Status'], 'exited'); self.assertIsNotNone(guard.read())
        with c.b.guarded() as guard:
            with c.issuer.resume_rollback(guard, c.record, selected) as permit: permit.rollback(c.record)
            self.assertIsNone(guard.read())
        self.assertEqual(self.copy_calls, 2)

    def test_missing_retired_birth_after_restoration_is_not_recreated(self):
        c = self.c
        with self.ready(reset=True, birth=True) as (guard, permit):
            selected = permit.reference; self.interrupt_start = True
            with self.assertRaises(OSError): permit.rollback(c.record)
            retired = M.L.B.retired_path(c.root); retired.unlink()
        with c.b.guarded() as guard:
            with c.issuer.resume_rollback(guard, c.record, selected) as permit:
                with self.assertRaises(FileNotFoundError): permit.rollback(c.record)
            self.assertIsNotNone(guard.read())
        self.assertFalse(retired.exists()); self.assertEqual(self.copy_calls, 1)
        self.assertEqual(c.f.raw['State']['Status'], 'exited')

    def test_unexpected_original_restart_during_copy_recovery_never_rewinds_its_writes(self):
        c = self.c
        with self.ready(reset=True, birth=True) as (guard, permit):
            selected = permit.reference
            actual = self.copy_directory
            def interrupted(source, target): raise OSError('fixture copier did not finish')
            self.copy_directory = interrupted
            with self.assertRaises(OSError): permit.rollback(c.record)
            self.copy_directory = actual
        c.f.raw['State'].update(Status='running', Running=True, Pid=42)
        marker = c.root / 'state/unexpected-live-write'; marker.write_text('fixture new live data')
        with c.b.guarded() as guard:
            with self.assertRaises(ValueError), c.issuer.resume_rollback(guard, c.record, selected): pass
            self.assertIsNotNone(guard.read())
        self.assertEqual(marker.read_text(), 'fixture new live data'); self.assertEqual(self.copy_calls, 1)


if __name__ == '__main__': unittest.main()
