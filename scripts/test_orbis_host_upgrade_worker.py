"""Filesystem/lifecycle fixtures; service manager and Linux identity are explicit substitutes."""
import copy
from contextlib import contextmanager, nullcontext
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import tempfile
import threading
import unittest
from unittest import mock
import uuid


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


L = load('orbis-host-upgrade-launcher.py', 'independent_worker_test')
S = load('orbis-host-upgrade-supervision.py', 'worker_supervision_test')
SERVICE = load('orbis-host-service.py', 'worker_host_test')
SETUP = load('orbis-host-service-setup.py', 'worker_setup_test')
SYSTEMCTL = L.systemctl


def manifest(character):
    return {'schema': 'orbis.release.v1', 'image': 'ghcr.io/twentylines/orbis',
            'tag': 'v0.9.' + ('1' if character == 'a' else '2'), 'commit': character * 40,
            'digest': 'sha256:' + character * 64, 'runtipiCompatibility': '4.10.1'}


class WorkerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.root.chmod(0o700)
        self.state, self.install, self.snapshots, self.source, self.units = [self.root / name for name in
            ('state', 'install', 'snapshots', 'source', 'units')]
        for path in (self.state, self.install, self.snapshots, self.source, self.units):
            path.mkdir(mode=0o700)
        self.names = ('orbis-host-upgrade-launcher.py', 'orbis-host-upgrade-supervision.py',
                      'orbis-host-service.py', 'orbis-host-service-setup.py', 'orbis-host-upgrade-runner.py')
        for name in self.names:
            (self.source / name).write_bytes(('# local source fixture: ' + name + '\n').encode())
            (self.source / name).chmod(0o600)
        self.host_unit = self.units / 'orbis-host.service'
        self.host_unit.write_bytes(b'[Service]\nType=simple\n')
        self.host_unit.chmod(0o644)
        self.operation = str(uuid.uuid4())
        current, target = manifest('a'), manifest('b')
        self.job = {'schema': 'orbis.host-service-job.v1', 'id': self.operation, 'state': 'running',
            'overlayId': self.operation, 'targetTag': target['tag'], 'startedAt': 123.25,
            'snapshot': str(self.snapshots / ('orbis-' + target['tag'] + '-' + self.operation)),
            'current': current, 'target': target, 'channelState': {'channel': 'nightly'},
            'returnToStable': False, 'backupPolicy': 'automatic'}
        self.overlay = SimpleNamespace(read=mock.Mock(return_value={'current': current, 'target': target}),
                                       accepted_job=mock.Mock(return_value=True), resume=mock.Mock())
        self.service = SimpleNamespace(root=self.install, context='default', snapshots=self.snapshots,
            state_dir=self.state, job_file=self.state / 'job.json', credentials_only=False,
            HOST=SimpleNamespace(PLAN=SERVICE.PLAN), core_overlays=lambda: self.overlay, lock=threading.Lock())
        self.service.write_component_progress = mock.Mock()
        self.service.core_operation_maintenance = mock.Mock()
        self.service.require_restart_clear = mock.Mock()
        self.service.require_package_clear = mock.Mock()
        self.service.busy = False
        self.service.HOST.host_lock = lambda _: nullcontext()
        self.overlay.verify_pre_effect_source = mock.Mock()
        self.component_runner = SimpleNamespace(PROTOCOL='orbis.component-upgrade-runner.v1',
            run=lambda launcher, service, job, admission: service._run_update_job(job, admission=admission),
            finalize=mock.Mock())
        SERVICE.write_private(self.service.job_file, self.job)
        self.setup = SimpleNamespace(INSTALL_DIR=self.source, UNIT_FILE=self.host_unit, SCRIPTS=self.names,
            _SetupSources=SETUP._SetupSources, _systemd_main_pid=mock.Mock(return_value=os.getpid()))
        self.runtime = SimpleNamespace(supported=mock.Mock(), unit=mock.Mock(side_effect=self.unit),
            boot=lambda: self.frame['bootId'], cgroup_empty=mock.Mock(return_value=True),
            generation_gone=mock.Mock(return_value=True))
        self.phase = 'absent'
        self.unit_overrides = {}
        self.command = mock.Mock(side_effect=self.systemctl)
        self.frame = {'bootId': str(uuid.uuid4()), 'pid': os.getpid(), 'startTime': 123,
                      'invocationId': 'c' * 32, 'unit': S.unit_name(self.operation), 'unitSha256': 'd' * 64}
        self.observer = mock.Mock(return_value=self.frame)
        for module, name, value in ((L, 'OWNER', os.geteuid()), (L, 'operator', lambda: None),
                                   (L, '__file__', str(self.source / self.names[0])), (S, 'UNITS', self.units),
                                   (S, 'Runtime', lambda: self.runtime), (S, 'observe_invocation', self.observer),
                                   (L, 'load_snapshot_supervision', mock.Mock(return_value=S)),
                                   (L, 'prepare_worker_source', mock.Mock()),
                                   (L, 'hold_worker_target', mock.Mock(side_effect=self.target_hold)),
                                   (L, 'systemctl', self.command), (L, 'load_sibling', self.sibling)):
            patch = mock.patch.object(module, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        self.effects = []
        self.service._run_update_job = lambda job, **options: self.effects.append((copy.deepcopy(job), options))

    @contextmanager
    def target_hold(self, bootstrap, checked):
        # Source/target custody has its own real-producer fixtures. This suite
        # substitutes that boundary to exercise independent process dispatch.
        bootstrap.verify_bootstrap()
        yield bootstrap

    def sibling(self, name, key):
        if name == 'orbis-host-service-setup.py':
            return self.setup
        if name == 'orbis-host-upgrade-supervision.py':
            return S
        if name == 'orbis-host-service.py':
            return SimpleNamespace(write_private=SERVICE.write_private, read_private=SERVICE.read_private, UPDATE=SERVICE.UPDATE,
                                   HostService=lambda *args, **kwargs: self.service)
        if name == 'orbis-host-upgrade-runner.py':
            return self.component_runner
        raise AssertionError(name)

    def unit(self, name):
        return {'LoadState': 'not-found' if self.phase == 'absent' else 'loaded',
                'MainPID': '0', 'ControlPID': '0', 'ActiveState': 'inactive', 'ControlGroup': '', 'InvocationID': '', 'Job': '',
                'FragmentPath': '' if self.phase == 'absent' else str(self.units / name),
                'DropInPaths': '', 'NeedDaemonReload': 'no', 'SubState': 'dead', 'Type': 'exec',
                'Restart': 'no', 'RemainAfterExit': 'no', 'KillMode': 'control-group', 'User': 'root', 'Group': 'root',
                **self.unit_overrides}

    def systemctl(self, action, unit=None):
        if action == 'daemon-reload':
            self.phase = 'loaded'
        elif action == 'start':
            self.phase = 'started'
        else:
            raise AssertionError(action)

    @property
    def operation_dir(self):
        return S.operation_directory(self.state, self.operation)

    def staged(self):
        reference = L.stage_worker(self.service, self.job)
        self.job['worker'] = reference
        SERVICE.write_private(self.service.job_file, self.job)
        return L.Bootstrap(self.state, self.operation, reference, supervision=S)

    @contextmanager
    def worker_entry(self):
        with mock.patch.object(L, '__file__', str(self.operation_dir / 'bootstrap/scripts' / self.names[0])):
            yield

    @contextmanager
    def reconciliation(self, *, interrupted=True):
        self.staged()
        original = {'schema': 'orbis.host-upgrade-claim.v1',
                    'requestSha256': self.job['worker']['requestSha256'], **self.frame}
        L.write_exclusive(self.operation_dir / 'claim.json', L.canonical(original))
        for name in ('source-checked.json', 'target-set.json'):
            L.write_exclusive(self.operation_dir / name, L.canonical({'fixture': name}))
        if interrupted:
            self.job.update(state='interrupted',
                message='Update worker dispatch needs reconciliation; its execution records were preserved.')
            SERVICE.write_private(self.service.job_file, self.job)
        frame = {**self.frame, 'unit': S.reconciliation_unit_name(self.operation), 'invocationId': 'e' * 32}
        self.observer.return_value = frame
        with mock.patch.object(S, 'observe_quiescence', return_value={'quiescent': True, 'bootId': self.frame['bootId']}) as quiescence:
            bootstrap = L.ReconciliationBootstrap(self.state, self.operation, self.job['worker'],
                                                  supervision=S, claimed=False)
            yield bootstrap, quiescence

    def test_reconciliation_preserves_original_claim_and_uses_exclusive_new_generation_claim(self):
        with self.reconciliation() as (bootstrap, quiescence):
            old = (self.operation_dir / 'claim.json').read_bytes()
            L.claim_reconciliation(bootstrap)
            self.assertEqual((self.operation_dir / 'claim.json').read_bytes(), old)
            value = L.decoded(bootstrap.claim_path(bootstrap.frame).read_bytes())
            self.assertEqual(value['originalClaimSha256'], L.sha(old))
            self.assertEqual(value['acceptedJobSha256'], L.sha(self.service.job_file.read_bytes()))
            self.assertEqual(bootstrap.accepted_job()['state'], 'interrupted')
            self.assertEqual(bootstrap.verify_bootstrap()['unit'], S.reconciliation_unit_name(self.operation))
            self.assertGreaterEqual(quiescence.call_count, 3)
            with self.assertRaises(L.UpgradeSourceError):
                L.claim_reconciliation(bootstrap)

    def test_reconciliation_requires_new_live_scope_and_positive_original_quiescence(self):
        with self.reconciliation() as (bootstrap, quiescence):
            quiescence.side_effect = ValueError('original process or child still present')
            with self.assertRaises(ValueError):
                L.claim_reconciliation(bootstrap)
            self.assertFalse(list(self.operation_dir.glob('reconciliation-*.json')))

    def test_reconciliation_cannot_change_the_accepted_target_source_or_other_job_fields(self):
        with self.reconciliation() as (bootstrap, quiescence):
            L.claim_reconciliation(bootstrap)
            changed = {**self.job, 'backupPolicy': 'none'}
            SERVICE.write_private(self.service.job_file, changed)
            with self.assertRaises(L.UpgradeSourceError):
                bootstrap.verify_bootstrap()
            with self.assertRaises(L.UpgradeSourceError):
                L.ReconciliationBootstrap(self.state, self.operation, self.job['worker'], supervision=S)

    def test_reconciliation_claim_cannot_be_copied_to_another_invocation(self):
        with self.reconciliation() as (bootstrap, quiescence):
            L.claim_reconciliation(bootstrap)
            self.observer.return_value = {**bootstrap.frame, 'invocationId': 'f' * 32}
            another = L.ReconciliationBootstrap(self.state, self.operation, self.job['worker'], supervision=S)
            with self.assertRaises(FileNotFoundError):
                another.verify_bootstrap()

    def test_reconcile_entry_reuses_selected_source_and_keeps_original_claim_and_intent(self):
        with self.reconciliation() as (bootstrap, _), self.worker_entry():
            intent = L.canonical({'schema': 'orbis.host-upgrade-execution.v1',
                                  'requestSha256': bootstrap.request_sha, **bootstrap.original_frame})
            path = self.operation_dir / 'execution-intent.json'
            L.write_exclusive(path, intent)
            checked = L.decoded((self.operation_dir / 'source-checked.json').read_bytes())
            self.component_runner.reconcile = mock.Mock(return_value=object())
            with mock.patch.object(L, 'hold_worker_target', side_effect=lambda scope, source, *, existing:
                                  self.target_hold(scope, source)) as hold:
                L.run_reconciliation(self.state, self.operation)
            hold.assert_called_once()
            self.assertEqual(hold.call_args.kwargs, {'existing': True})
            self.assertEqual(hold.call_args.args[1], checked)
            self.component_runner.reconcile.assert_called_once()
            self.component_runner.finalize.assert_called_once()
            self.assertEqual(path.read_bytes(), intent)
            self.assertEqual((self.operation_dir / 'claim.json').read_bytes(), bootstrap.original_claim)
            self.assertEqual(L.decoded(self.service.job_file.read_bytes()), self.job)
            L.prepare_worker_source.assert_not_called()
            self.assertEqual(self.effects, [])

    def test_offline_dispatch_requires_original_generation_to_be_gone(self):
        with self.reconciliation(interrupted=False) as (bootstrap, quiescence), self.worker_entry():
            current = self.service.job_file.read_bytes()
            with mock.patch.object(L, 'launch_reconciliation') as dispatch:
                quiescence.side_effect = ValueError('operation still has a live member')
                with self.assertRaises(ValueError):
                    L.dispatch_offline_reconciliation(self.state, self.operation)
                self.assertEqual(self.service.job_file.read_bytes(), current)
                dispatch.assert_not_called()
                quiescence.side_effect = None
                L.dispatch_offline_reconciliation(self.state, self.operation)
                accepted = SERVICE.read_private(self.service.job_file)
                self.assertEqual(accepted['state'], 'interrupted')
                dispatch.assert_called_once_with(self.service, accepted)
                self.service.require_restart_clear.assert_called_once()
                self.service.require_package_clear.assert_called_once()
            self.assertEqual((self.operation_dir / 'claim.json').read_bytes(), bootstrap.original_claim)
            self.command.assert_not_called()

    def test_offline_preclaim_recovery_settles_only_after_positive_quiescence(self):
        self.staged()
        intake = (self.operation_dir / 'intake.json').read_bytes()
        with self.worker_entry():
            self.runtime.cgroup_empty.return_value = False
            with self.assertRaises(S.UpgradeSupervisionError):
                L.dispatch_offline_reconciliation(self.state, self.operation)
            self.assertEqual(SERVICE.read_private(self.service.job_file), self.job)
            self.runtime.cgroup_empty.return_value = True
            L.dispatch_offline_reconciliation(self.state, self.operation)
        self.assertEqual(SERVICE.read_private(self.service.job_file)['state'], 'failed')
        self.assertEqual((self.operation_dir / 'intake.json').read_bytes(), intake)
        self.assertFalse((self.operation_dir / 'claim.json').exists())
        self.overlay.verify_pre_effect_source.assert_called_once_with(self.overlay.read.return_value, self.frame['bootId'])
        self.command.assert_not_called()

    def test_accepting_host_snapshot_is_exclusive_complete_and_preserves_original_job(self):
        original = self.service.job_file.read_bytes()
        reference = L.stage_worker(self.service, self.job)
        intake = L.decoded((self.operation_dir / 'intake.json').read_bytes())
        self.assertEqual(reference['requestSha256'], L.sha(L.canonical(intake)))
        self.assertEqual(intake['job'], self.job)
        self.assertEqual(self.service.job_file.read_bytes(), original)
        self.assertEqual(set(intake['files']), set(self.names))
        self.assertEqual(set((self.operation_dir / 'bootstrap/scripts').iterdir()),
                         {self.operation_dir / 'bootstrap/scripts' / name for name in self.names})
        with self.assertRaises(L.UpgradeSourceError):
            L.stage_worker(self.service, self.job)
        self.command.assert_not_called()

    def test_no_snapshot_is_created_for_unaccepted_changed_or_credential_only_job(self):
        for change in ('acceptance', 'job', 'role'):
            with self.subTest(change=change):
                self.overlay.accepted_job.return_value = change != 'acceptance'
                self.service.credentials_only = change == 'role'
                body = {**self.job, 'state': 'complete'} if change == 'job' else self.job
                SERVICE.write_private(self.service.job_file, body)
                with self.assertRaises(L.UpgradeSourceError):
                    L.stage_worker(self.service, self.job)
                self.assertFalse(self.operation_dir.exists())

    def test_only_real_accepting_host_pid_can_snapshot_its_installed_source(self):
        self.setup._systemd_main_pid.return_value = os.getpid() + 1
        with self.assertRaises(L.UpgradeSourceError):
            L.stage_worker(self.service, self.job)
        self.assertFalse(self.operation_dir.exists())

    def test_unknown_linked_or_writable_source_never_gets_a_worker_unit(self):
        source = self.source / self.names[0]
        original = source.read_bytes()
        for variant in ('extra', 'symlink', 'hardlink', 'writable'):
            with self.subTest(variant=variant):
                if variant == 'extra':
                    (self.source / 'extra.py').write_bytes(b'pass\n')
                elif variant == 'symlink':
                    source.rename(self.root / 'original')
                    source.symlink_to(self.root / 'original')
                elif variant == 'hardlink':
                    os.link(source, self.root / 'alias')
                else:
                    source.chmod(0o666)
                with self.assertRaises((OSError, ValueError)):
                    L.stage_worker(self.service, self.job)
                self.assertFalse(self.operation_dir.exists())
                if variant == 'extra':
                    (self.source / 'extra.py').unlink()
                elif variant == 'symlink':
                    source.unlink()
                    (self.root / 'original').rename(source)
                elif variant == 'hardlink':
                    (self.root / 'alias').unlink()
                source.chmod(0o600)
                self.assertEqual(source.read_bytes(), original)
        self.command.assert_not_called()

    def test_dispatch_uses_fixed_private_snapshot_unit_and_retains_same_job_uuid(self):
        L.launch_worker(self.service, self.job)
        saved = SERVICE.read_private(self.service.job_file)
        self.assertEqual(saved['id'], self.operation)
        self.assertEqual(saved['state'], 'running')
        self.assertEqual(saved['worker']['unit'], S.unit_name(self.operation))
        self.assertEqual((self.units / S.unit_name(self.operation)).read_bytes(), S.unit_body(self.state, self.operation))
        self.assertEqual(self.command.call_args_list, [mock.call('daemon-reload'), mock.call('start', S.unit_name(self.operation))])
        body = (self.units / S.unit_name(self.operation)).read_text()
        self.assertIn('Restart=no', body)
        self.assertIn('RemainAfterExit=no', body)
        self.assertIn('/bootstrap/scripts/orbis-host-upgrade-launcher.py', body)
        self.assertTrue((self.operation_dir / 'launch-intent.json').exists())

    def test_foreign_unit_is_preserved_and_never_started(self):
        unit = self.units / S.unit_name(self.operation)
        unit.write_bytes(b'preserve foreign unit\n')
        with self.assertRaises(FileExistsError):
            L.launch_worker(self.service, self.job)
        self.assertEqual(unit.read_bytes(), b'preserve foreign unit\n')
        self.command.assert_not_called()

    def test_loaded_dropin_or_wrong_fragment_blocks_start(self):
        original = self.systemctl
        def alter(action, unit=None):
            original(action, unit)
            if action == 'daemon-reload':
                self.runtime.unit.side_effect = lambda name: {**self.unit(name), 'DropInPaths': '/run/other.conf'}
        self.command.side_effect = alter
        with self.assertRaises(L.UpgradeSourceError):
            L.launch_worker(self.service, self.job)
        self.assertEqual(self.command.call_args_list, [mock.call('daemon-reload')])

    def test_actual_entry_writes_claim_and_intent_before_existing_transaction(self):
        bootstrap = self.staged()
        def execute(job, *, admission):
            self.assertTrue((self.operation_dir / 'claim.json').exists())
            self.assertTrue((self.operation_dir / 'execution-intent.json').exists())
            self.assertEqual(job, SERVICE.read_private(self.service.job_file))
            admission.verify_bootstrap()
            self.effects.append(job)
        self.service._run_update_job = execute
        with self.worker_entry():
            L.run_worker(self.state, self.operation)
        self.assertEqual(len(self.effects), 1)
        claim = L.decoded((self.operation_dir / 'claim.json').read_bytes())
        self.assertEqual(claim, {'schema': 'orbis.host-upgrade-claim.v1',
            'requestSha256': bootstrap.reference['requestSha256'], **self.frame})
        L.prepare_worker_source.assert_called_once()
        L.hold_worker_target.assert_called_once()
        self.component_runner.finalize.assert_called_once()
        self.service.write_component_progress.assert_called_once()

    def test_component_finalization_follows_target_admission_exit_with_original_job_unchanged(self):
        self.staged()
        events = []
        @contextmanager
        def held(bootstrap, checked):
            bootstrap.verify_bootstrap()
            events.append('enter')
            yield bootstrap
            bootstrap.verify_bootstrap()
            events.append('exit')
        def run(launcher, service, job, admission):
            events.append('run')
            self.assertEqual(job, SERVICE.read_private(self.service.job_file))
            return 'registered outcome fixture'
        def finalize(launcher, service, bootstrap, outcome):
            self.assertEqual(events, ['enter', 'run', 'exit'])
            self.assertEqual(outcome, 'registered outcome fixture')
            bootstrap.verify_bootstrap()
            SERVICE.write_private(self.service.job_file, {**self.job, 'state': 'complete'})
            events.append('finalize')
        self.component_runner.run = run
        self.component_runner.finalize.side_effect = finalize
        with mock.patch.object(L, 'hold_worker_target', side_effect=held), self.worker_entry():
            L.run_worker(self.state, self.operation)
        self.assertEqual(events, ['enter', 'run', 'exit', 'finalize'])

    def test_failed_component_effect_never_calls_legacy_core_fallback_or_finalization(self):
        self.staged()
        self.component_runner.run = mock.Mock(side_effect=RuntimeError('uncertain component effect'))
        with self.worker_entry(), self.assertRaises(RuntimeError):
            L.run_worker(self.state, self.operation)
        self.assertEqual(self.effects, [])
        self.component_runner.finalize.assert_not_called()
        self.assertEqual(SERVICE.read_private(self.service.job_file), self.job)

    def test_failed_source_preparation_cannot_enter_the_controller_transaction(self):
        self.staged()
        L.prepare_worker_source.side_effect=ValueError('source could not be verified')
        with self.worker_entry(),self.assertRaises(ValueError):
            L.run_worker(self.state,self.operation)
        self.assertEqual(self.effects,[])
        self.assertFalse((self.operation_dir/'execution-intent.json').exists())
        self.assertTrue((self.operation_dir/'claim.json').exists())

    def test_failed_target_resolution_cannot_enter_the_controller_transaction(self):
        self.staged()
        L.hold_worker_target.side_effect=ValueError('complete target could not be verified')
        with self.worker_entry(), self.assertRaises(ValueError):
            L.run_worker(self.state,self.operation)
        self.assertEqual(self.effects,[])
        self.assertFalse((self.operation_dir/'execution-intent.json').exists())

    def test_repeated_entry_cannot_replay_even_with_same_positive_kernel_frame(self):
        self.staged()
        with self.worker_entry():
            L.run_worker(self.state, self.operation)
            original = (self.operation_dir / 'claim.json').read_bytes()
            with self.assertRaises(FileExistsError):
                L.run_worker(self.state, self.operation)
        self.assertEqual(len(self.effects), 1)
        self.assertEqual((self.operation_dir / 'claim.json').read_bytes(), original)

    def test_source_drift_wrong_entry_or_changed_job_refuses_before_transaction(self):
        self.staged()
        snapshot = self.operation_dir / 'bootstrap/scripts' / self.names[-1]
        original = snapshot.read_bytes()
        snapshot.write_bytes(b'changed\n')
        with self.worker_entry(), self.assertRaises(L.UpgradeSourceError):
            L.run_worker(self.state, self.operation)
        snapshot.write_bytes(original)
        with self.assertRaises(L.UpgradeSourceError):
            L.run_worker(self.state, self.operation)
        self.assertEqual(self.effects, [])
        self.assertFalse((self.operation_dir / 'execution-intent.json').exists())

    def test_changed_equal_byte_inode_is_not_accepted_by_an_existing_source_scope(self):
        bootstrap = self.staged()
        source = self.operation_dir / 'bootstrap/scripts' / self.names[-1]
        replacement = self.operation_dir / 'replacement.py'
        replacement.write_bytes(source.read_bytes())
        replacement.chmod(0o600)
        replacement.replace(source)
        with self.assertRaises(L.UpgradeSourceError):
            bootstrap.verify_files()

    def test_snapshot_drift_is_refused_before_importing_its_supervision_module(self):
        bootstrap = self.staged()
        source = self.operation_dir / 'bootstrap/scripts' / self.names[-1]
        source.write_bytes(b'changed\n')
        with self.assertRaises(L.UpgradeSourceError):
            L.Bootstrap(self.state, self.operation, bootstrap.reference)
        L.load_snapshot_supervision.assert_not_called()

    def test_live_worker_requires_actual_current_frame_and_matching_claim(self):
        self.staged()
        with self.assertRaises(FileNotFoundError):
            L.live_worker(self.service, self.job)
        with self.worker_entry():
            L.run_worker(self.state, self.operation)
        self.assertTrue(L.live_worker(self.service, self.job))
        self.observer.side_effect = ValueError('kernel identity unavailable')
        with self.assertRaises(ValueError):
            L.live_worker(self.service, self.job)

    def test_parent_cannot_overwrite_writer_after_lost_launch_response(self):
        bootstrap = self.staged()
        original = self.service.job_file.read_bytes()
        with L.worker_lock(bootstrap):
            L.interrupt_unowned_worker(self.service, self.job)
        self.assertEqual(self.service.job_file.read_bytes(), original)
        L.interrupt_unowned_worker(self.service, self.job)
        self.assertEqual(SERVICE.read_private(self.service.job_file)['state'], 'interrupted')

    def test_status_does_not_interrupt_the_window_before_parent_start_acknowledgement(self):
        self.staged()
        before = self.service.job_file.read_bytes()
        L.observe_worker_exit(self.service, self.job)
        self.assertEqual(self.service.job_file.read_bytes(), before)

    def test_a_stopped_dispatched_worker_becomes_visible_reconciliation(self):
        L.launch_worker(self.service, self.job)
        self.assertTrue((self.operation_dir / 'started.json').exists())
        self.observer.side_effect = ValueError('unit no longer has a live process')
        L.observe_worker_exit(self.service, self.job)
        self.assertEqual(SERVICE.read_private(self.service.job_file)['state'], 'interrupted')
        self.assertEqual(self.effects, [])

    def test_systemctl_start_timeout_is_ambiguous_and_can_later_be_reconciled(self):
        def launch(action, unit=None):
            if action == 'daemon-reload':
                return self.systemctl(action)
            with mock.patch.object(L.subprocess, 'run', side_effect=subprocess.TimeoutExpired('systemctl', 30)):
                SYSTEMCTL(action, unit)
        self.command.side_effect = launch
        with self.assertRaisesRegex(RuntimeError, 'response was not confirmed'):
            L.launch_worker(self.service, self.job)
        self.assertFalse((self.operation_dir / 'started.json').exists())
        self.assertTrue((self.operation_dir / 'launch-intent.json').exists())
        before = self.service.job_file.read_bytes()
        self.service.busy = True
        L.observe_worker_exit(self.service, self.job)
        self.assertEqual(self.service.job_file.read_bytes(), before)
        self.service.busy = False
        self.unit_overrides['Job'] = '42'
        L.interrupt_unowned_worker(self.service, self.job)
        self.assertEqual(self.service.job_file.read_bytes(), before)
        self.unit_overrides.clear()
        self.runtime.cgroup_empty.return_value = False
        L.observe_worker_exit(self.service, self.job)
        self.assertEqual(self.service.job_file.read_bytes(), before)
        self.runtime.cgroup_empty.return_value = True
        L.observe_worker_exit(self.service, self.job)
        interrupted = SERVICE.read_private(self.service.job_file)
        self.assertEqual(interrupted['state'], 'interrupted')
        L.launch_reconciliation(self.service, interrupted)
        self.assertEqual(SERVICE.read_private(self.service.job_file)['state'], 'failed')
        self.assertEqual(self.command.call_count, 2)
        self.assertEqual(self.effects, [])

    def test_pre_effect_recovery_closes_the_job_without_dispatching(self):
        self.staged()
        self.job.update(state='interrupted')
        SERVICE.write_private(self.service.job_file, self.job)
        self.runtime.cgroup_empty = lambda name: True
        with mock.patch.object(S, 'observe_quiescence', return_value={'quiescent': True, 'bootId': self.frame['bootId']}) as quiescence:
            L.launch_reconciliation(self.service, self.job)
        self.assertIsNone(quiescence.call_args.args[3])
        self.assertEqual(SERVICE.read_private(self.service.job_file)['state'], 'failed')
        self.overlay.verify_pre_effect_source.assert_called_once_with(self.overlay.read.return_value, self.frame['bootId'])
        self.service.core_operation_maintenance.assert_called_once()
        self.command.assert_not_called()

    def test_pre_effect_recovery_refuses_a_checkpoint_or_live_reconciliation(self):
        self.staged()
        self.job.update(state='interrupted')
        SERVICE.write_private(self.service.job_file, self.job)
        self.runtime.cgroup_empty = lambda name: False
        with mock.patch.object(S, 'observe_quiescence', return_value={'quiescent': True, 'bootId': self.frame['bootId']}):
            with self.assertRaises(L.UpgradeSourceError):
                L.launch_reconciliation(self.service, self.job)
            self.runtime.cgroup_empty = lambda name: True
            Path(self.job['snapshot']).mkdir()
            with self.assertRaises(L.UpgradeSourceError):
                L.launch_reconciliation(self.service, self.job)
        self.assertEqual(SERVICE.read_private(self.service.job_file), self.job)
        self.service.core_operation_maintenance.assert_not_called()

    def test_pre_effect_recovery_handles_a_claim_and_intent_before_the_first_stage(self):
        with self.reconciliation() as (bootstrap, quiescence):
            intent = {'schema': 'orbis.host-upgrade-execution.v1',
                      'requestSha256': bootstrap.request_sha, **bootstrap.original_frame}
            path = self.operation_dir / 'execution-intent.json'
            L.write_exclusive(path, L.canonical({**intent, 'startTime': 321}))
            L.make_directory(self.operation_dir, 'component-journal')
            self.runtime.cgroup_empty = lambda name: True
            with self.assertRaises(L.UpgradeSourceError):
                L.launch_reconciliation(self.service, self.job)
            self.assertEqual(SERVICE.read_private(self.service.job_file), self.job)
            SERVICE.write_private(path, intent)
            recorded_intent = path.read_bytes()
            L.launch_reconciliation(self.service, self.job)
        self.assertEqual(quiescence.call_args.args[3], bootstrap.original_frame)
        self.assertEqual(SERVICE.read_private(self.service.job_file)['state'], 'failed')
        self.assertEqual(path.read_bytes(), recorded_intent)
        self.command.assert_not_called()

    def test_stopped_unit_does_not_let_a_reader_overwrite_an_independent_writer(self):
        L.launch_worker(self.service, self.job)
        bootstrap = L.Bootstrap(self.state, self.operation, self.job['worker'], supervision=S)
        before = self.service.job_file.read_bytes()
        with L.worker_lock(bootstrap):
            L.observe_worker_exit(self.service, self.job)
        self.assertEqual(self.service.job_file.read_bytes(), before)

    def test_status_check_cannot_deadlock_with_the_hosts_existing_admission_lock(self):
        L.launch_worker(self.service, self.job)
        before = self.service.job_file.read_bytes()
        thread = threading.Thread(target=L.observe_worker_exit, args=(self.service, self.job))
        with self.service.lock:
            thread.start()
            thread.join(timeout=0.5)
            finished = not thread.is_alive()
        thread.join(timeout=2)
        self.assertTrue(finished)
        self.assertEqual(self.service.job_file.read_bytes(), before)

    def test_lost_parent_response_preserves_already_complete_job(self):
        self.staged()
        SERVICE.write_private(self.service.job_file, {**self.job, 'state': 'complete'})
        original = self.service.job_file.read_bytes()
        L.interrupt_unowned_worker(self.service, self.job)
        self.assertEqual(self.service.job_file.read_bytes(), original)

    def test_same_operation_root_json_cannot_substitute_other_source_reference(self):
        bootstrap = self.staged()
        for changes in ({'requestSha256': 'f' * 64}, {'unit': S.unit_name(str(uuid.uuid4()))}, {'extra': True}):
            with self.subTest(changes=changes), self.assertRaises(L.UpgradeSourceError):
                L.Bootstrap(self.state, self.operation, {**bootstrap.reference, **changes}, supervision=S)
        self.command.assert_not_called()

    def test_lock_file_identity_and_permissions_are_not_optional(self):
        bootstrap = self.staged()
        (self.operation_dir / 'worker.lock').chmod(0o644)
        with self.assertRaises(L.UpgradeSourceError):
            with L.worker_lock(bootstrap):
                self.fail('unprotected lock accepted')

    def test_parent_writer_lease_survives_a_separate_child_without_descriptor_handoff(self):
        bootstrap=self.staged()
        script='''import fcntl,os,sys
fd=os.open(sys.argv[1],os.O_RDWR|os.O_NOFOLLOW)
try:
    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(73)
finally:
    os.close(fd)
'''
        command=[sys.executable,'-I','-B','-c',script,str(self.operation_dir/'worker.lock')]
        def probe():
            return subprocess.run(command,stdin=subprocess.DEVNULL,capture_output=True,timeout=10,
                                  close_fds=True,cwd=self.root).returncode
        with L.worker_lock(bootstrap):
            self.assertEqual(probe(),73)
            self.assertEqual(probe(),73)
        self.assertEqual(probe(),0)


if __name__ == '__main__':
    unittest.main()
