import copy
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SPEC = importlib.util.spec_from_file_location('core_capture_test', Path(__file__).with_name('orbis-host-time-machine-core.py'))
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)
F = C.load('test_orbis_install_transaction.py', 'core_capture_transaction_fixtures')
identifier = F.identifier
POINT = '00000000-0000-4000-8000-000000000001'
OTHER = '00000000-0000-4000-8000-000000000002'


class Interrupted(BaseException):
    pass


class Docker(F.Docker):
    def __init__(self, root):
        super().__init__(root)
        self.starts = {}
        self.before_change = None
        self.after_change = None
        self.database_directory = root / 'postgres'
        self.database_directory.mkdir(mode=0o700)
        database = self.services[identifier('runtipi-db')]
        database['mounts'] = [{'Type': 'bind', 'Source': str(self.database_directory), 'Destination': '/var/lib/postgresql/data', 'RW': True}]
        database['environment'] = ['PRIVATE_FIXTURE=do-not-record', 'PGDATA=/var/lib/postgresql/data']
        proxy = self.services[identifier('runtipi-reverse-proxy')]
        folder = root / 'traefik'
        (folder / 'shared').mkdir(parents=True)
        proxy['mounts'] = [{'Type': 'bind', 'Source': str(folder), 'Destination': '/etc/traefik', 'RW': True},
                           {'Type': 'bind', 'Source': str(folder / 'shared'), 'Destination': '/shared', 'RW': True}]

    def _object(self, arguments):
        if arguments[:2] == ['info', '--format']:
            return {'os': 'linux', 'architecture': 'x86_64'}
        if arguments[:2] == ['image', 'inspect'] and arguments[-2] == '{{json .}}':
            return {'Id': arguments[-1], 'Os': 'linux', 'Architecture': 'amd64'}
        if arguments[-2] != '{{json .}}':
            return super()._object(arguments)
        key = arguments[-1]
        value = self.app(key)
        state = value['state']
        return {'Id': key, 'Name': value['name'], 'Image': value['imageId'],
                'Config': {'Image': value['image'], 'Labels': value['labels'], 'Env': value.get('environment', ['PRIVATE_FIXTURE=do-not-record'])},
                'Mounts': value['mounts'],
                'HostConfig': {'AutoRemove': False, 'RestartPolicy': value['restartPolicy']},
                'State': {'Status': state, 'Running': state == 'running', 'Restarting': False, 'Paused': False,
                          'StartedAt': self.starts.get(key, 'original-start')},
                'NetworkSettings': {'Networks': {'fixture': {'NetworkID': 'f' * 64}}}}

    def change(self, arguments, timeout=90):
        if self.before_change:
            self.before_change(arguments)
        super().change(arguments, timeout)
        if arguments[0] == 'start':
            self.starts[arguments[-1]] = 'resumed-start'
        if self.after_change:
            self.after_change(arguments)


class CoreCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name).resolve()
        self.root, self.state, self.snapshots = [self.parent / name for name in ('install', 'state', 'snapshots')]
        for folder in (self.root, self.state, self.snapshots):
            folder.mkdir(mode=0o700)
        for name in ('.env', 'docker-compose.yml'):
            (self.root / name).write_text('private test bytes')
        (self.root / 'apps').mkdir()
        for index in range(3):
            (self.root / 'app-data' / f'app-{index}').mkdir(parents=True)
        self.docker = Docker(self.root)
        self.service = SimpleNamespace(root=self.root, state_dir=self.state, snapshots=self.snapshots, context=self.docker.context)
        self.enterContext(mock.patch.object(C.HOST.AUTHORITY, 'OWNER', os.geteuid()))
        self.production_docker = C.TX.APPS.Docker
        self.enterContext(mock.patch.object(C.TX.APPS, 'Docker', return_value=self.docker))
        self.enterContext(mock.patch.object(C.TX.RESTORE, 'runtime'))
        self.capture = C.CoreCapture(self.service)
        self.source = {'publication': {'tag': 'v1'}, 'enrollment': {'root': str(self.root)},
                       'creationReference': self.docker.controller_image}
        self.enterContext(mock.patch.object(self.capture, 'source', side_effect=lambda: copy.deepcopy(self.source)))
        self.manifests = {}
        self.copy_hook = None
        self.storage_capture = self.enterContext(mock.patch.object(C.TX.STORAGE, 'capture', side_effect=self.copy_storage))
        self.enterContext(mock.patch.object(C.TX.STORAGE, 'verified_manifest', side_effect=lambda path: copy.deepcopy(self.manifests[path])))
        self.restore = self.enterContext(mock.patch.object(C.TX.RESTORE, 'restore', side_effect=AssertionError('capture cannot restore')))

    def copy_storage(self, root, reader, plan, *, host_writers_stopped):
        self.assertTrue(host_writers_stopped)
        C.TX.STORAGE.require_quiet_existing(root, reader, plan)
        self.assertIsNotNone(reader.lock_fd)
        os.fstat(reader.lock_fd)
        if self.copy_hook:
            self.copy_hook()
        bundle = Path(plan['bundle'])
        bundle.mkdir(mode=0o700)
        manifest = {'schema': C.TX.STORAGE.SCHEMA, 'stage': 'complete', 'plan': plan, 'copies': []}
        C.TX.APPS.write_journal(bundle / 'storage.json', manifest)
        self.manifests[bundle] = manifest
        return {'result': 'fixture-copy'}

    def run_capture(self, point=POINT):
        return self.capture.capture(point, host_writers_stopped=True)

    def record(self, point=POINT):
        return json.loads((self.capture.base / point / 'job.json').read_text())

    def test_real_review_checkpoint_and_same_id_resume_exclude_all_apps_and_proxy(self):
        prior = {row['id']: self.capture.observation(self.docker, row['id']) for row in self.docker.containers()}
        receipt = self.run_capture()
        record = self.record()
        self.assertEqual(record['phase'], 'complete')
        self.assertIsNone(record['pendingMutation'])
        self.assertFalse(receipt['restoredSnapshotBytes'])
        self.assertEqual(set(record['checkpoint']['roles'].values()), {'controller', 'database', 'queue'})
        changed = {args[-1] for args, _ in self.docker.calls}
        self.assertEqual(changed, set(receipt['originalCoreIds']))
        stopped = [record['checkpoint']['roles'][args[-1]] for args, _ in self.docker.calls if args[0] == 'stop']
        started = [record['checkpoint']['roles'][args[-1]] for args, _ in self.docker.calls if args[0] == 'start']
        self.assertEqual(stopped, ['controller', 'queue', 'database'])
        self.assertEqual(started, ['database', 'queue', 'controller'])
        for key, value in prior.items():
            after = self.capture.observation(self.docker, key)
            if key in changed:
                self.assertEqual({**value, 'startedAt': 'resumed-start'}, after)
            else:
                self.assertEqual(value, after)
        self.assertEqual(self.storage_capture.call_count, 1)
        self.restore.assert_not_called()
        self.assertNotIn('do-not-record', (self.capture.base / POINT / 'job.json').read_text())
        self.assertEqual(self.capture.read(self.capture.base / POINT), record)

    def test_every_external_change_has_durable_intent_and_host_lock(self):
        def before(arguments):
            record = self.record()
            self.assertEqual(record['pendingMutation'], arguments)
            self.assertIn(record['phase'], {'checkpointing', 'resuming'})
            with self.assertRaises(ValueError):
                with C.HOST.host_lock(self.root):
                    pass
        self.docker.before_change = before
        self.run_capture()

    def test_completed_mapping_is_bound_and_legacy_jobs_keep_their_meaning(self):
        self.run_capture()
        record = self.record()
        self.assertEqual(record['settlement']['portableStorageSha256'], C.TX.APPS.digest(record['portableStorage']))
        changed = copy.deepcopy(record)
        changed['portableStorage']['database']['resourcePath'] += '/other'
        self.capture.save(changed)
        with self.assertRaises(ValueError):
            self.capture.read(self.capture.base / POINT)
        legacy = copy.deepcopy(record)
        legacy.pop('portableStorage')
        legacy['settlement'].pop('portableStorageSha256')
        self.capture.save(legacy)
        self.assertEqual(self.capture.read(self.capture.base / POINT), legacy)
        legacy['settlement']['portableStorageSha256'] = record['settlement']['portableStorageSha256']
        self.capture.save(legacy)
        with self.assertRaises(ValueError):
            self.capture.read(self.capture.base / POINT)

    def test_missing_database_mapping_fails_before_stopping_any_service(self):
        self.docker.services[identifier('runtipi-db')]['environment'] = ['PRIVATE_FIXTURE=do-not-record']
        with self.assertRaisesRegex(ValueError, 'one data directory'):
            self.run_capture()
        self.assertEqual(self.docker.calls, [])
        self.assertEqual(self.record()['phase'], 'recovery-required')

    def test_source_change_before_stop_preserves_hold_without_mutations(self):
        calls = 0
        def source():
            nonlocal calls
            calls += 1
            return {**self.source, 'enrollment': {'generation': calls}}
        self.capture.source.side_effect = source
        with self.assertRaisesRegex(C.CoreCaptureError, 'enrollment changed'):
            self.run_capture()
        self.assertEqual(self.docker.calls, [])
        self.assertEqual(self.record()['phase'], 'recovery-required')

    def test_real_enrollment_binding_rejects_source_file_changes_before_resume(self):
        publication = {'schema': 'orbis.release.v1', 'image': 'ghcr.io/twentylines/orbis',
                       'tag': 'v0.1.0-beta.3', 'commit': 'a' * 40, 'digest': 'sha256:' + 'b' * 64,
                       'runtipiCompatibility': '4.10.1'}
        self.service.current_manifest = lambda: copy.deepcopy(publication)
        self.docker.controller_image = publication['image'] + '@' + publication['digest']
        (self.root / 'orbis-compose.yml').write_text(C.HOST.STAGE.staged_content(publication))
        self.capture.source.side_effect = lambda: C.CoreCapture.source(self.capture)
        with mock.patch.object(C.HOST.PLAN, 'plan'):
            enrollment = C.HOST.installation_fingerprint(self.root, publication, self.docker.context)
            C.TX.APPS.write_journal(self.root / C.HOST.STATE_NAME, enrollment)
            self.copy_hook = lambda: (self.root / '.env').write_text('changed private source')
            with self.assertRaisesRegex(ValueError, 'changed since enrollment'):
                self.run_capture()
        self.assertEqual(self.record()['phase'], 'recovery-required')
        self.assertFalse(any(args[0] == 'start' for args, _ in self.docker.calls))

    def test_native_writer_acknowledgement_and_point_id_are_required(self):
        for point, ack in ((POINT, False), (POINT, 1), ('../../escape', True)):
            with self.assertRaises(C.CoreCaptureError):
                self.capture.capture(point, host_writers_stopped=ack)
        self.assertEqual(self.docker.calls, [])

    def test_lost_stop_response_remains_ambiguous_and_is_never_resumed_or_replayed(self):
        def after(arguments):
            if arguments[0] == 'stop':
                raise Interrupted()
        self.docker.after_change = after
        with self.assertRaises(Interrupted):
            self.run_capture()
        pending = self.record()['pendingMutation']
        self.assertEqual(pending[0], 'stop')
        self.assertEqual(self.record()['phase'], 'recovery-required')
        calls = copy.deepcopy(self.docker.calls)
        fresh = C.CoreCapture(self.service)
        with self.assertRaisesRegex(C.CoreCaptureError, 'unfinished'):
            fresh.capture(OTHER, host_writers_stopped=True)
        self.assertEqual(calls, self.docker.calls)
        self.assertFalse(any(args[0] == 'start' for args, _ in calls))

    def test_copy_failure_keeps_stopped_core_and_failed_evidence(self):
        self.copy_hook = lambda: (_ for _ in ()).throw(OSError('fixture full destination'))
        with self.assertRaises(OSError):
            self.run_capture()
        self.assertEqual(self.record()['phase'], 'recovery-required')
        self.assertTrue((self.capture.base / POINT / 'checkpoint.json').is_file())
        self.assertFalse(any(args[0] == 'start' for args, _ in self.docker.calls))

    def test_changed_preserved_app_prevents_success_and_resume(self):
        def changed():
            self.docker.apps[identifier('app-0')]['imageId'] = 'sha256:' + 'e' * 64
        self.copy_hook = changed
        with self.assertRaisesRegex(C.CoreCaptureError, 'preserved container changed'):
            self.run_capture()
        self.assertEqual(self.record()['phase'], 'recovery-required')
        self.assertFalse(any(args[0] == 'start' for args, _ in self.docker.calls))

    def test_changed_proxy_policy_prevents_success_without_touching_proxy(self):
        key = identifier('runtipi-reverse-proxy')
        self.copy_hook = lambda: self.docker.services[key].update(restartPolicy={'Name': 'no', 'MaximumRetryCount': 0})
        with self.assertRaisesRegex(C.CoreCaptureError, 'preserved container changed'):
            self.run_capture()
        self.assertFalse(any(args[-1] == key for args, _ in self.docker.calls))

    def test_changed_publication_after_copy_cannot_resume(self):
        self.copy_hook = lambda: self.source.update(creationReference='different-image')
        with self.assertRaisesRegex(C.CoreCaptureError, 'enrollment changed before resume'):
            self.run_capture()
        self.assertFalse(any(args[0] == 'start' for args, _ in self.docker.calls))

    def test_unselected_app_writer_overlapping_core_storage_blocks_before_stop(self):
        self.docker.apps[identifier('app-0')]['mounts'].append(
            {'Type': 'bind', 'Source': str(self.root), 'Destination': '/foreign-core', 'RW': True})
        with self.assertRaisesRegex(C.TX.TransactionError, 'Another container can write'):
            self.run_capture()
        self.assertEqual(self.docker.calls, [])

    def test_lost_start_response_retains_exact_pending_identity(self):
        def after(arguments):
            if arguments[0] == 'start':
                raise TimeoutError('lost response')
        self.docker.after_change = after
        with self.assertRaises(TimeoutError):
            self.run_capture()
        self.assertEqual(self.record()['phase'], 'recovery-required')
        self.assertEqual(self.record()['pendingMutation'], ['start', identifier('runtipi-db')])

    def test_unhealthy_resumed_controller_has_no_success_receipt(self):
        def after(arguments):
            if arguments == ['start', self.docker.controller_id]:
                self.docker.controller_health = 'unhealthy'
        self.docker.after_change = after
        healthy = C.TX.require_healthy
        with mock.patch.object(C.TX, 'require_healthy', side_effect=lambda reader, key, timeout=0: healthy(reader, key)):
            with self.assertRaisesRegex(C.TX.TransactionError, 'healthy'):
                self.run_capture()
        self.assertNotIn('settlement', self.record())
        self.assertEqual(self.record()['phase'], 'recovery-required')

    def test_completed_job_cannot_be_replayed_and_private_lock_serializes_workers(self):
        with self.capture.exclusive():
            with self.assertRaisesRegex(C.CoreCaptureError, 'worker still owns'):
                self.run_capture()
        self.run_capture()
        calls = copy.deepcopy(self.docker.calls)
        with self.assertRaisesRegex(C.CoreCaptureError, 'replayed'):
            self.run_capture()
        self.assertEqual(calls, self.docker.calls)

    def test_symlink_shared_state_or_unfinished_directory_is_not_adopted(self):
        (self.capture.base / OTHER).mkdir(mode=0o700)
        with self.assertRaises(FileNotFoundError):
            self.run_capture()
        self.assertEqual(self.docker.calls, [])
        (self.capture.base / OTHER).rmdir()
        os.chmod(self.state, 0o777)
        with self.assertRaises(ValueError):
            C.CoreCapture(self.service)

    def test_job_symlink_and_changed_complete_receipt_require_review(self):
        target = self.parent / 'foreign-job'
        target.mkdir(mode=0o700)
        (self.capture.base / OTHER).symlink_to(target, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.run_capture()
        (self.capture.base / OTHER).unlink()
        self.run_capture()
        record = self.record()
        record['settlement']['containersSha256'] = 'a' * 64
        self.capture.save(record)
        calls = copy.deepcopy(self.docker.calls)
        with self.assertRaisesRegex(C.CoreCaptureError, 'unfinished'):
            self.run_capture(OTHER)
        self.assertEqual(calls, self.docker.calls)

    def test_privacy_and_journal_write_failure_prevents_external_change(self):
        save = self.capture.save
        def fail_intent(record):
            if record['pendingMutation'] is not None:
                raise OSError('fixture intent publication failure')
            save(record)
        with mock.patch.object(self.capture, 'save', side_effect=fail_intent):
            with self.assertRaises(OSError):
                self.run_capture()
        self.assertEqual(self.docker.calls, [])

    def test_owned_docker_mutation_inherits_host_lock_descriptor(self):
        with C.HOST.host_lock(self.root) as descriptor:
            original = self.production_docker(self.docker.context)
            original.lock_fd = descriptor
            with mock.patch.object(C.TX.APPS.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run:
                original.change(['stop', identifier('runtipi-db')])
            self.assertEqual(run.call_args.kwargs['pass_fds'], (descriptor,))


if __name__ == '__main__':
    unittest.main()
