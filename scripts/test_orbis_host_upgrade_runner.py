"""Real sequencing/journal/terminal code with explicit service and kernel fixtures.

These cases do not qualify Linux Root admission or installed replacement. The
separate source/worker suites exercise genuine bundle/execution custody.
"""
from contextlib import ExitStack, contextmanager, nullcontext
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
from types import MethodType, SimpleNamespace
import unittest
from unittest import mock
import uuid


def load(name):
    spec = importlib.util.spec_from_file_location('test_component_' + name.replace('-', '_'),
                                                Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


R = load('orbis-host-upgrade-runner.py')
REAL_LOAD_TARGET = R.load_target
REAL_PROGRESS_ENDPOINT = R.ProgressEndpoint
L = load('orbis-host-upgrade-launcher.py')
SERVICE = load('orbis-host-service.py')
OBSERVER = load('orbis-host-sentinel-observer.py')


def release(letter, tag):
    return {'schema': 'orbis.release.v1', 'tag': tag, 'commit': letter * 40,
            'digest': 'sha256:' + letter * 64, 'image': 'ghcr.io/twentylines/orbis',
            'installationProtocol': 'orbis.installation-state.v1', 'runtipiCompatibility': '4.10.1'}


class RunnerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.base.chmod(0o700)
        self.operation = str(uuid.uuid4())
        self.state, self.root = self.base / 'state', self.base / 'root'
        self.state.mkdir(mode=0o700)
        self.root.mkdir(mode=0o700)
        self.directory = self.state / 'component-upgrades' / self.operation
        self.directory.mkdir(mode=0o700, parents=True)
        self.current, self.target = release('a', 'v0.9.1'), release('b', 'v0.9.2')
        self.job = {'schema': 'orbis.host-service-job.v1', 'id': self.operation, 'state': 'running',
            'current': self.current, 'target': self.target, 'targetTag': self.target['tag'],
            'snapshot': str(self.base / 'snapshot'), 'backupPolicy': 'automatic',
            'worker': {'schema': 'orbis.host-upgrade-worker.v1', 'unit': 'orbis-upgrade-' + self.operation + '.service',
                       'requestSha256': 'd' * 64}}
        self.old_copy = {'inventory': {'old.py': 'e' * 64}, 'unitSha256': 'f' * 64}
        self.new_copy = {'inventory': {'new.py': '1' * 64}, 'unitSha256': '2' * 64}
        self.copy = copy.deepcopy(self.old_copy)
        self.environment = self.base / 'service.env'
        self.environment.write_bytes(b'private local fixture\n')
        self.environment.chmod(0o600)
        self.env_sha = R.sha(self.environment.read_bytes())
        self.collector = {'release': {'version': '0.1.0-dev.23', 'sha256': '3' * 64, 'sourceCommit': '4' * 40},
            'inventorySha256': '5' * 64, 'profile': None,
            'host': {'MainPID': '100', 'InvocationID': '6' * 32, 'ControlGroup': '/system.slice/orbis-host.service'}}
        self.collector_original = copy.deepcopy(self.collector)
        self.collector_target = {'version': '0.1.0-dev.24', 'sha256': '7' * 64, 'sourceCommit': '8' * 40}
        self.profile = {'schema': 'orbis-sentinel.observer-profile.v1', 'profile': 'orbis-observer-v2',
                        'groupId': 1234, 'files': {key: '9' * 64 for key in ('collector', 'host', 'socket', 'sysusers')}}
        self.host_profile = None
        self.manifest = {'selectionDirectory': str(self.base / 'selection'),
            'sourceSelectionSha256': 'a' * 64, 'host': self.new_copy,
            'sentinel': {'release': self.collector_target}, 'core': self.target}
        self.boot = SimpleNamespace(operation=self.operation, directory=self.directory, state_directory=self.state,
            reference=self.job['worker'], request_sha='d' * 64, target=self.target,
            intake={'job': {key: value for key, value in self.job.items() if key != 'worker'},
                    'files': self.old_copy['inventory'], 'acceptingHostUnitSha256': self.old_copy['unitSha256']})
        self.events, self.held = [], set()
        self.job_file = self.state / 'job.json'
        SERVICE.write_private(self.job_file, self.job)
        self.boot.verify_bootstrap = self.verify_admission
        self.boot.accepted_job = lambda: {key: value for key, value in self.job.items() if key != 'worker'}
        self.admission = SimpleNamespace(bootstrap=self.boot, body=R.encoded(self.manifest),
            target=SimpleNamespace(manifest=lambda: copy.deepcopy(self.manifest)), verify_bootstrap=self.verify_admission)
        self.launcher = SimpleNamespace(operator=lambda: None, make_directory=L.make_directory,
            ReconciliationBootstrap=L.ReconciliationBootstrap,
            file_seal=L.file_seal, directory=L.directory, read_file=L.read_file,
            write_exclusive=L.write_exclusive, decoded=L.decoded,
            admit_helper_replacement=lambda _: self.events.append('host-admission'))
        self.core = self.current
        self.service = SimpleNamespace(root=self.root, context='fixture', state_dir=self.state, job_file=self.job_file,
            lock=threading.Lock(), busy=True, core_overlays=lambda: SimpleNamespace(
                read=lambda _: {'componentProgress': 'orbis.component-browser-progress.v1',
                                'current': self.current, 'target': self.target},
                accepted_job=lambda _: True,
                resume=lambda _, **options: self.events.append('overlay')),
            complete_channel_change=mock.Mock(), core_operation_maintenance=mock.Mock(),
            read_core_operation_record=self.read, update_journal_matches=lambda job, value: value.get('targetDigest') == job['target']['digest'],
            update_progress_phase=lambda job, value: value.get('progressPhase'))
        self.service.write_component_progress = MethodType(SERVICE.HostService.write_component_progress, self.service)
        self.service.publish_component_outcome = MethodType(SERVICE.HostService.publish_component_outcome, self.service)
        self.locks = (88, 89)
        self.lease = SimpleNamespace(verify=lambda: self.assertIn('sentinel-lock', self.held))
        self.update = SimpleNamespace(update_plan=lambda *args: {'checkpoint': {'backupPolicy': 'automatic'}},
            pull_verified_image=self.pull, apply_update=self.apply_core,
            journal_path=lambda _: self.base / 'core-journal.json', safe_download=lambda value: {})
        self.helper = SimpleNamespace(SETUP=SimpleNamespace(
            actual_copy=lambda *args: copy.deepcopy(self.copy), INSTALL_DIR=self.base / 'installed',
            UNIT_FILE=self.base / 'unit', ENV_FILE=self.environment,
            _systemd_main_pid=lambda *args: int(self.collector['host']['MainPID']),
            SERVICE=SimpleNamespace(UPDATE=self.update)),
            HOST=SimpleNamespace(host_lock_lease=lambda root: self.hold('host-lock'),
                AUTHORITY=SimpleNamespace(LAYOUT=SimpleNamespace(verify_locks=self.verify_locks)),
                current_core=lambda *args: {'state': 'running', 'health': 'healthy', 'image': self.image(self.core)},
                controller_reference=lambda root, ref, context: self.image(ref),
                installation_fingerprint=lambda *args: {}, retained_descriptor=lambda *args: {}),
            STATE_DIR=self.state, MAINTENANCE=self.state / 'helper-maintenance.json',
            preflight=lambda *args: {'installedEnvironmentSha256': self.env_sha},
            require_installed=lambda *args: copy.deepcopy(self.host_profile), verify_service=self.verify_host,
            upgrade=self.upgrade_host)
        self.prepared = object()
        self.sentinel = SimpleNamespace(activation_lease=lambda: self.hold('sentinel-lock'),
            prepare_release=self.prepare, require_observer_change_support=lambda _: self.events.append('support'),
            observer_profile_spec=lambda _: {'schema': 'orbis-sentinel.observer-spec.v1', 'profile': 'orbis-observer-v2',
                'groupName': 'orbis-observer', 'files': self.profile['files']},
            observe_installation=self.observe_collector, activate=self.activate_collector,
            enroll_observer=self.integrate)
        owner = self
        class Endpoint:
            def __init__(self, observer, initial, **options):
                owner.assertEqual(initial['job']['id'], owner.operation)
                self.browser = 'directory' in options
                if self.browser:
                    binding = '\n'.join((owner.operation, owner.current['digest'], owner.target['digest'])).encode('ascii')
                    owner.assertEqual(options['directory'], R.BROWSER_DIRECTORY)
                    owner.assertEqual(options['name'], R.sha(binding) + '.sock')
            def __enter__(self):
                if self.browser:
                    owner.held.add('browser-progress')
                else:
                    owner.events.append('progress-start')
                    owner.held.add('progress')
                return self
            def publish(self, value):
                owner.assertEqual(value['job']['id'], owner.operation)
                owner.assertNotEqual(value['job']['state'], 'complete')
            def __exit__(self, *args):
                if self.browser:
                    owner.held.remove('browser-progress')
                else:
                    owner.events.append('progress-close')
                    owner.held.remove('progress')
        for module, name, value in ((L, 'OWNER', os.geteuid()), (SERVICE.HOST.AUTHORITY, 'OWNER', os.geteuid()),
                (SERVICE, '_COMPONENT_RUNNER', R), (SERVICE, '_COMPONENT_LAUNCHER', L),
                (R, '_OBSERVER', OBSERVER), (R, 'ProgressEndpoint', Endpoint),
                (R, 'verify_unit', lambda *_: self.events.append('unit-checked')),
                (R, 'load_target', self.target_module)):
            patch = mock.patch.object(module, name, value)
            patch.start()
            self.addCleanup(patch.stop)

    @staticmethod
    def image(reference):
        return reference['image'] + '@' + reference['digest']

    def read(self, path, *, optional=False):
        try:
            return L.decoded(L.read_file(path))
        except FileNotFoundError:
            if optional:
                return None
            raise

    def verify_admission(self):
        self.assertEqual(self.read(self.job_file), self.job)
        return {'fixture': True}

    @contextmanager
    def hold(self, name):
        self.assertNotIn(name, self.held)
        self.held.add(name)
        try:
            yield self.locks if name == 'host-lock' else self.lease
        finally:
            self.held.remove(name)

    def verify_locks(self, root, locks):
        self.assertIn('host-lock', self.held)
        self.assertEqual(locks, self.locks)

    def target_module(self, launcher, admission, name):
        self.verify_admission()
        return {'orbis-host-service-upgrade.py': self.helper, 'orbis-sentinel-install.py': self.sentinel,
                'orbis-host-sentinel-observer.py': OBSERVER}[name]

    def prepare(self, directory, release):
        self.assertEqual(self.held - {'browser-progress'}, {'host-lock', 'sentinel-lock'})
        self.assertEqual(release, self.collector_target)
        self.events.append('prepare')
        return self.prepared

    def pull(self, context, target, root, publish):
        self.assertEqual(target, self.target)
        self.events.append('pull')

    def observe_collector(self, prepared, *, lease):
        self.assertIs(prepared, self.prepared)
        lease.verify()
        return copy.deepcopy(self.collector)

    def verify_host(self, digest, root, context):
        self.assertEqual(digest, self.core['digest'])

    def activate_collector(self, prepared, *, retain, lease):
        self.assertIn('pull', self.events)
        self.assertFalse((self.base / 'core-journal.json').exists())
        self.events.append('sentinel')
        self.binding = retain
        self.collector['release'] = copy.deepcopy(self.collector_target)
        self.collector['inventorySha256'] = 'b' * 64
        self.retained = {'fixtureTicket': True, 'binding': retain}
        return {'retainedRollback': self.retained}

    def integrate(self, prepared, retained, *, binding, lease, ready):
        self.assertEqual(binding, self.binding)
        self.events.append('integration-prepare')
        ticket = {'fixtureIntegration': True}
        ready(copy.deepcopy(self.profile), ticket)
        self.assertIn('progress', self.held)
        self.events.append('integration-activate')
        self.collector['profile'] = copy.deepcopy(self.profile)
        self.host_profile = {'schema': 'orbis.sentinel-observer-profile.v1', 'groupId': 1234, 'files': {}}
        return {'profile': copy.deepcopy(self.profile), 'ticket': ticket}

    def upgrade_host(self, root, context, source, confirmation, **options):
        self.verify_admission()
        self.assertIn('progress', self.held)
        self.assertEqual(options, {'source_custody': self.manifest['sourceSelectionSha256'],
                                  'retain': self.binding, 'lock_fds': self.locks})
        self.events.append('host')
        self.copy = copy.deepcopy(self.new_copy)
        self.collector['host'] = {**self.collector['host'], 'MainPID': '200', 'InvocationID': 'c' * 32}
        return {'upgraded': True, 'retainedRollback': {'fixtureHelperTicket': True, **self.binding}}

    def apply_core(self, root, current, target, context, snapshot, **options):
        self.assertIn('progress', self.held)
        self.assertEqual(options['lock_fds'], self.locks)
        self.events.append('core')
        self.core = self.target
        return {'result': 'healthy', 'releaseTag': target['tag']}

    def run_upgrade(self):
        return R.run(self.launcher, self.service, copy.deepcopy(self.job), self.admission)

    def test_real_sequencer_stages_then_updates_all_actors_before_terminal_publication(self):
        outcome = self.run_upgrade()
        self.assertEqual(self.read(self.job_file), self.job)
        self.assertFalse(self.held)
        self.assertEqual([x for x in self.events if x in {'sentinel', 'integration-prepare', 'progress-start',
            'integration-activate', 'host', 'core'}],
            ['sentinel', 'integration-prepare', 'progress-start', 'integration-activate', 'host', 'core'])
        self.assertLess(self.events.index('pull'), self.events.index('sentinel'))
        self.assertLess(self.events.index('unit-checked'), self.events.index('sentinel'))
        self.service.complete_channel_change.assert_not_called()
        R.finalize(self.launcher, self.service, self.boot, outcome)
        self.assertEqual(self.read(self.job_file)['state'], 'complete')
        self.assertEqual(self.read(self.job_file)['id'], self.operation)
        self.assertFalse(self.service.busy)
        self.service.core_operation_maintenance.assert_called_once()
        with self.assertRaises(ValueError):
            R.finalize(self.launcher, self.service, self.boot, outcome)

    def test_public_toolkit_protocol_refusal_occurs_before_any_activation(self):
        self.sentinel.require_observer_change_support = mock.Mock(side_effect=ValueError('published toolkit lacks protocol'))
        with self.assertRaises(ValueError):
            self.run_upgrade()
        self.assertEqual(self.events, ['prepare'])
        self.assertEqual(self.read(self.job_file), self.job)
        self.assertFalse(self.held)

    def test_helper_and_accepted_job_cannot_use_different_state_namespaces(self):
        self.helper.STATE_DIR = self.base / 'other-state'
        with self.assertRaises(ValueError):
            self.run_upgrade()
        self.assertEqual(self.events, [])
        self.assertFalse((self.directory / 'component-journal').exists())
        self.assertEqual(self.read(self.job_file), self.job)

    def test_partial_component_failure_never_reports_core_only_completion_or_replays(self):
        original = self.sentinel.enroll_observer
        self.sentinel.enroll_observer = mock.Mock(side_effect=RuntimeError('lost integration reply'))
        with self.assertRaises(RuntimeError):
            self.run_upgrade()
        self.assertNotIn('host', self.events)
        self.assertNotIn('core', self.events)
        self.assertEqual(self.read(self.job_file), self.job)
        self.assertEqual(self.read(self.directory / 'component-progress.json')['progress']['job']['state'], 'interrupted')
        self.sentinel.enroll_observer = original
        with self.assertRaises(ValueError):
            self.run_upgrade()
        self.assertEqual(self.events.count('sentinel'), 1)

    def test_failed_final_observation_keeps_the_job_and_all_retention_evidence(self):
        original = self.update.apply_update
        def effect(*args, **options):
            result = original(*args, **options)
            self.environment.write_bytes(b'changed environment\n')
            return result
        self.update.apply_update = effect
        with self.assertRaises(ValueError):
            self.run_upgrade()
        self.assertEqual(self.read(self.job_file), self.job)
        self.assertTrue(any(self.directory.glob('component-journal/*-host-ready.json')))
        self.assertFalse(any(self.directory.glob('component-journal/*-complete.json')))
        self.assertTrue(any(self.directory.glob('component-journal/*-interrupted.json')))

    def test_final_receipt_or_job_change_prevents_terminal_publication(self):
        outcome = self.run_upgrade()
        path = next(self.directory.glob('component-journal/*-complete.json'))
        path.write_bytes(path.read_bytes() + b' ')
        with self.assertRaises(ValueError):
            R.finalize(self.launcher, self.service, self.boot, outcome)
        self.assertEqual(self.read(self.job_file), self.job)
        self.service.core_operation_maintenance.assert_not_called()

    def test_progress_uses_the_selected_job_and_cannot_supply_terminal_authority(self):
        progress = R.Progress(self.launcher, self.service, self.boot, OBSERVER)
        progress.publish('installing', state='interrupted')
        observed = R.read_progress(self.service, self.job)
        self.assertEqual(observed['job']['state'], 'interrupted')
        self.assertEqual(observed['job']['phase'], 'installing')
        self.assertEqual(self.read(self.job_file), self.job)
        changed = {**self.job, 'state': 'interrupted'}
        self.assertEqual(R.read_progress(self.service, changed)['job']['state'], 'interrupted')
        record = self.read(self.directory / 'component-progress.json')
        record['requestSha256'] = '0' * 64
        SERVICE.write_private(self.directory / 'component-progress.json', record)
        with self.assertRaises(ValueError):
            R.read_progress(self.service, self.job)

    def test_reconciliation_reclaims_only_a_disconnected_socket_with_the_same_inode(self):
        # The fixture binds a real stream socket. Systemd proof of the caller
        # is tested separately and required before browser endpoint recovery.
        location = self.base
        pathname = location / 'p.sock'
        group = os.getegid()
        descriptor = os.open(location, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, descriptor)
        endpoint = object.__new__(REAL_PROGRESS_ENDPOINT)
        owner = mock.patch.object(R, 'OWNER', os.geteuid())
        owner.start()
        self.addCleanup(owner.stop)
        endpoint.directory = descriptor
        endpoint.directory_seal = R.seal(os.fstat(descriptor))
        endpoint.location, endpoint.name = location, pathname.name
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
            peer.bind(str(pathname))
            pathname.chmod(0o660)
            peer.listen(1)
            inode = pathname.lstat().st_ino
            with self.assertRaises(ValueError):
                endpoint._clear_stopped_socket(group)
            self.assertEqual(pathname.lstat().st_ino, inode)
        endpoint._clear_stopped_socket(group)
        self.assertFalse(pathname.exists())
        pathname.write_bytes(b'not a socket')
        with self.assertRaises(ValueError):
            endpoint._clear_stopped_socket(group)
        self.assertTrue(pathname.is_file())

    def interrupt(self):
        self.job = {**self.job, 'state': 'interrupted'}
        SERVICE.write_private(self.job_file, self.job)
        self.launcher.ReconciliationBootstrap = type(self.boot)

    def test_recovering_progress_requires_a_live_reconciliation_generation(self):
        self.interrupt()
        progress = R.Progress(self.launcher, self.service, self.boot, OBSERVER)
        progress.publish('recovering', state='recovering')
        self.service.component_recovery_live = mock.Mock(return_value=True)
        self.assertEqual(R.read_progress(self.service, self.job)['job']['state'], 'recovering')
        self.service.component_recovery_live.side_effect = FileNotFoundError
        self.assertEqual(R.read_progress(self.service, self.job)['job']['state'], 'interrupted')
        self.assertEqual(self.read(self.job_file), self.job)

    def test_only_reconciliation_can_reclaim_both_progress_endpoints(self):
        for recovering in (False, True):
            with self.subTest(recovering=recovering):
                if recovering:
                    self.interrupt()
                progress = R.Progress(self.launcher, self.service, self.boot, OBSERVER)
                progress.publish('recovering' if recovering else 'installing',
                                 state='recovering' if recovering else 'running')
                with mock.patch.object(R, 'ProgressEndpoint') as endpoint, ExitStack() as resources:
                    progress.start(resources)
                browser, sentinel = endpoint.call_args_list
                self.assertEqual(browser.kwargs['directory'], R.BROWSER_DIRECTORY)
                self.assertEqual(browser.kwargs['allow_stale'], recovering)
                self.assertNotIn('directory', sentinel.kwargs)
                self.assertEqual(sentinel.kwargs.get('allow_stale', False), recovering)

    def test_reconcile_observes_terminal_receipt_after_new_host_generation_without_replay(self):
        self.run_upgrade()
        journal = self.directory / 'component-journal'
        old = next(journal.glob('*-complete.json')).read_bytes()
        self.interrupt()
        self.collector['host']['InvocationID'] = 'd' * 32
        SERVICE.write_private(self.update.journal_path(None), {'stage': 'complete'})
        self.update.read_journal = mock.Mock(return_value={'stage': 'complete'})
        self.sentinel.reconcile_retained = mock.Mock(side_effect=AssertionError('Terminal result is read-only'))
        outcome = R.reconcile(self.launcher, self.service, self.job, self.admission)
        R.finalize(self.launcher, self.service, self.boot, outcome)
        self.assertEqual(self.read(self.job_file)['state'], 'complete')
        self.assertEqual(self.read(self.job_file)['componentReceiptSha256'], R.sha(old))
        self.assertEqual(len(list(journal.glob('*-complete.json'))), 1)
        self.assertEqual(self.events.count('core'), 1)

    def test_prepared_observer_recovery_uses_authentic_pending_receipt_before_live_observation(self):
        ticket = {'fixtureIntegration': True}
        self.pending = False
        def interrupted(prepared, retained, *, binding, lease, ready):
            ready(self.profile, ticket)
            self.pending = True
            raise KeyboardInterrupt
        self.sentinel.enroll_observer = interrupted
        with self.assertRaises(KeyboardInterrupt):
            self.run_upgrade()
        self.interrupt()
        def observe(prepared, *, lease):
            self.assertFalse(self.pending, 'Loaded profile cannot match before pending files are returned')
            return self.observe_collector(prepared, lease=lease)
        self.sentinel.observe_installation = observe
        self.sentinel.reconcile_retained = mock.Mock(return_value={'retainedRollback': self.retained,
            'activation': 'candidate', 'previousRelease': self.collector_original['release'],
            'observer': {'ticket': ticket, 'phase': 'installed', 'originalProfile': None}})
        def return_observer(prepared, retained, observed, *, binding, lease):
            self.assertEqual(observed, ticket)
            self.pending = False
            return {'ticket': ticket, 'profile': None, 'restored': True}
        def restore_retained(prepared, retained, *, binding, lease):
            self.collector = copy.deepcopy(self.collector_original)
            return {'restored': True, 'previousRelease': self.collector['release']}
        self.sentinel.return_observer = return_observer
        self.sentinel.restore_retained = restore_retained
        outcome = R.reconcile(self.launcher, self.service, self.job, self.admission)
        R.finalize(self.launcher, self.service, self.boot, outcome)
        self.assertEqual(self.read(self.job_file)['state'], 'rolled-back')
        self.assertEqual(self.events.count('sentinel'), 1)
        self.assertNotIn('host', self.events)
        self.sentinel.reconcile_retained.assert_called_once()

    def test_reconcile_interrupted_host_copy_before_observing_collector(self):
        def half_replaced(*args, **options):
            self.events.append('host-stopped')
            self.copy = {}
            SERVICE.write_private(self.helper.MAINTENANCE, {'componentUpgrade': self.binding})
            raise KeyboardInterrupt
        self.helper.upgrade = half_replaced
        with self.assertRaises(KeyboardInterrupt):
            self.run_upgrade()
        self.interrupt()
        self.launcher.helper_intent = lambda _: {'fixture': 'host-effect-intent'}
        L.write_exclusive(self.directory / 'host-forward-intent.json', L.canonical(self.launcher.helper_intent(None)))
        def observe_after_return(prepared, *, lease):
            self.assertIn('host-copy-returned', self.events)
            return self.observe_collector(prepared, lease=lease)
        self.sentinel.observe_installation = observe_after_return
        def restore_copy(*args, **options):
            self.assertNotIn('core', self.events)
            self.assertEqual(options, {'lock_fds': self.locks})
            self.events.append('host-copy-returned')
            self.copy = copy.deepcopy(self.old_copy)
            self.helper.MAINTENANCE.unlink()
        self.helper.restore_interrupted_component_copy = mock.Mock(side_effect=restore_copy)
        self.sentinel.reconcile_retained = mock.Mock(return_value={'retainedRollback': self.retained,
            'activation': 'candidate', 'previousRelease': self.collector_original['release'],
            'observer': {'ticket': {'fixtureIntegration': True}, 'phase': 'active', 'originalProfile': None}})
        def return_profile(*args, **options):
            self.host_profile = None
            return {'restored': True, 'profile': None}
        self.sentinel.return_observer = return_profile
        def return_collector(*args, **options):
            self.collector = copy.deepcopy(self.collector_original)
            return {'restored': True, 'previousRelease': self.collector['release']}
        self.sentinel.restore_retained = return_collector
        SERVICE.write_private(self.helper.MAINTENANCE, {'componentUpgrade': {**self.binding, 'planSha256': '0' * 64}})
        with self.assertRaises(ValueError):
            R.reconcile(self.launcher, self.service, self.job, self.admission)
        self.helper.restore_interrupted_component_copy.assert_not_called()
        SERVICE.write_private(self.helper.MAINTENANCE, {'componentUpgrade': self.binding})
        outcome = R.reconcile(self.launcher, self.service, self.job, self.admission)
        R.finalize(self.launcher, self.service, self.boot, outcome)
        self.helper.restore_interrupted_component_copy.assert_called_once()
        self.assertEqual(self.read(self.job_file)['state'], 'rolled-back')
        self.assertEqual(self.events.count('host-stopped'), 1)
        self.assertNotIn('core', self.events)

    def test_journal_drift_is_detected_before_the_next_intent(self):
        journal = R.Journal(self.launcher, self.admission)
        journal.append('staged', {'fixture': True})
        path = next(journal.directory.iterdir())
        path.write_bytes(path.read_bytes() + b' ')
        with self.assertRaises(ValueError):
            journal.append('sentinel-intent', {})
        self.assertEqual(len(list(journal.directory.iterdir())), 1)

    def test_unregistered_outcome_has_no_completion_authority(self):
        with self.assertRaises(ValueError):
            R.finalize(self.launcher, self.service, self.boot, R.Outcome())
        self.assertEqual(self.read(self.job_file), self.job)

    def test_known_early_effects_return_only_after_original_host_and_core_are_verified(self):
        original = self.sentinel.enroll_observer
        def integrate(*args, **options):
            original(*args, **options)
            raise RuntimeError('failure after known enrollment')
        def return_integration(prepared, retained, ticket, *, binding, lease):
            self.assertNotIn('host', self.events)
            self.events.append('integration-return')
            self.collector['profile'] = None
            self.host_profile = None
            return {'restored': True, 'profile': None}
        def return_collector(prepared, retained, *, binding, lease):
            self.assertEqual(self.events[-1], 'integration-return')
            self.events.append('sentinel-return')
            self.collector = copy.deepcopy(self.collector_original)
            return {'restored': True, 'previousRelease': copy.deepcopy(self.collector_original['release'])}
        self.sentinel.enroll_observer = integrate
        self.sentinel.return_observer = return_integration
        self.sentinel.restore_retained = return_collector
        outcome = self.run_upgrade()
        self.assertEqual(self.read(self.job_file), self.job)
        self.assertNotIn('core', self.events)
        self.assertEqual(self.events[-3:], ['integration-return', 'sentinel-return', 'progress-close'])
        R.finalize(self.launcher, self.service, self.boot, outcome)
        self.assertEqual(self.read(self.job_file)['state'], 'rolled-back')
        self.service.complete_channel_change.assert_not_called()
        self.service.core_operation_maintenance.assert_called_once()

    def test_successful_helper_replacement_cannot_use_the_early_collector_return(self):
        def uncertain(*args, **options):
            SERVICE.write_private(self.base / 'core-journal.json', {'stage': 'recovery-required'})
            raise RuntimeError('Core uncertain')
        self.update.apply_update = uncertain
        self.update.read_journal = lambda *args: {'stage': 'recovery-required'}
        self.sentinel.return_observer = mock.Mock()
        self.sentinel.restore_retained = mock.Mock()
        with self.assertRaises(RuntimeError):
            self.run_upgrade()
        self.sentinel.return_observer.assert_not_called()
        self.sentinel.restore_retained.assert_not_called()
        self.assertEqual(self.read(self.job_file), self.job)
        self.assertTrue(any(self.directory.glob('component-journal/*-interrupted.json')))

    def enable_ordered_return(self):
        def integration(prepared, retained, ticket, *, binding, lease):
            self.assertIn('host', self.events)
            self.assertEqual(self.core, self.current)
            self.events.append('integration-return')
            self.collector['profile'] = None
            self.host_profile = None
            return {'restored': True, 'profile': None}
        def collector(prepared, retained, *, binding, lease):
            self.assertEqual(self.events[-1], 'integration-return')
            self.events.append('sentinel-return')
            frame = self.collector['host']
            self.collector = {**copy.deepcopy(self.collector_original), 'host': frame}
            return {'restored': True, 'previousRelease': copy.deepcopy(self.collector_original['release'])}
        def host(root, context, confirmation, retained, *, lock_fds, coordinated):
            self.assertEqual(self.events[-1], 'sentinel-return')
            self.assertTrue(coordinated)
            self.assertEqual(lock_fds, self.locks)
            # Exercise the actual ordered journal reader, not a supplied profile.
            self.update.HOST = self.helper.HOST
            profile = R.helper_return_profile(self.launcher, self.admission, self.update, root, context, self.job, retained)
            self.assertIsNone(profile)
            self.events.append('host-return')
            self.copy = copy.deepcopy(self.old_copy)
            self.collector['host'] = {**self.collector['host'], 'MainPID': '300', 'InvocationID': 'd' * 32}
            return {'restored': True, **self.binding}
        self.sentinel.return_observer = mock.Mock(side_effect=integration)
        self.sentinel.restore_retained = mock.Mock(side_effect=collector)
        self.helper.rollback_retained = mock.Mock(side_effect=host)

    def test_helper_returns_last_after_original_core_is_positively_unchanged(self):
        self.enable_ordered_return()
        self.update.apply_update = mock.Mock(side_effect=RuntimeError('before Core journal/effects'))
        outcome = self.run_upgrade()
        self.assertEqual(self.events[-4:], ['integration-return', 'sentinel-return', 'host-return', 'progress-close'])
        self.assertEqual(self.read(self.job_file), self.job)
        R.finalize(self.launcher, self.service, self.boot, outcome)
        self.assertEqual(self.read(self.job_file)['state'], 'rolled-back')
        self.service.complete_channel_change.assert_not_called()

    def test_core_commit_or_uncertain_data_never_allows_component_return(self):
        for phase in ('complete', 'staged', 'rollback-failed', 'recovery-required'):
            with self.subTest(phase=phase):
                update = SimpleNamespace(journal_path=lambda _: self.base / 'core-journal.json',
                    read_journal=lambda *args: {'stage': phase})
                SERVICE.write_private(self.base / 'core-journal.json', {'stage': phase})
                with self.assertRaises(ValueError):
                    R.original_core_boundary(update, self.root, 'fixture', self.job, self.state)

    def test_terminal_core_return_is_bound_to_exact_producer_journal(self):
        for stage in ('aborted', 'rolled-back'):
            with self.subTest(stage=stage):
                record = {'stage': stage}
                path = self.base / 'core-journal.json'
                SERVICE.write_private(path, record)
                update = SimpleNamespace(journal_path=lambda _: path, read_journal=lambda *args: record,
                                         unbacked_job=lambda _: False, CONTROLLER=SimpleNamespace(SCOPE='fixture-v2'),
                                         HOST=SimpleNamespace(AUTHORITY=L.Files()))
                observed = R.original_core_boundary(update, self.root, 'fixture', self.job, self.state)
                self.assertEqual(observed, {'stage': stage, 'journalSha256': R.sha(path.read_bytes())})
                SERVICE.write_private(path, {**record, 'changed': True})
                with self.assertRaises(ValueError):
                    R.original_core_boundary(update, self.root, 'fixture', self.job, self.state)

    def test_failed_host_return_retains_running_job_and_full_ordered_evidence(self):
        self.enable_ordered_return()
        self.update.apply_update = mock.Mock(side_effect=RuntimeError('before Core journal/effects'))
        self.helper.rollback_retained.side_effect = RuntimeError('lost Host stop reply')
        with self.assertRaises(RuntimeError):
            self.run_upgrade()
        self.assertEqual(self.read(self.job_file), self.job)
        self.assertTrue(any(self.directory.glob('component-journal/*-host-return-intent.json')))
        self.assertFalse(any(self.directory.glob('component-journal/*-rolled-back.json')))

    def test_host_stopped_during_retained_rollback_reuses_its_original_return_intent(self):
        self.enable_ordered_return()
        self.update.apply_update = mock.Mock(side_effect=RuntimeError('before Core journal/effects'))
        def half_returned(*args, **options):
            SERVICE.write_private(self.helper.MAINTENANCE, {'componentUpgrade': self.binding})
            self.copy = {}
            raise KeyboardInterrupt
        self.helper.rollback_retained = mock.Mock(side_effect=half_returned)
        with self.assertRaises(KeyboardInterrupt):
            self.run_upgrade()
        self.interrupt()
        self.launcher.helper_intent = lambda _: {'fixture': 'host-effect-intent'}
        L.write_exclusive(self.directory / 'host-forward-intent.json', L.canonical(self.launcher.helper_intent(None)))
        self.sentinel.reconcile_retained = mock.Mock(return_value={'observer': {'phase': 'returned'}})
        def finish_return(*args, **options):
            self.assertEqual(options['returning'], ({'fixtureHelperTicket': True, **self.binding}, None))
            self.assertIn('browser-progress', self.held)
            self.copy = copy.deepcopy(self.old_copy)
            self.helper.MAINTENANCE.unlink()
        self.helper.restore_interrupted_component_copy = mock.Mock(side_effect=finish_return)
        outcome = R.reconcile(self.launcher, self.service, self.job, self.admission)
        R.finalize(self.launcher, self.service, self.boot, outcome)
        self.assertEqual(self.read(self.job_file)['state'], 'rolled-back')
        self.sentinel.return_observer.assert_called_once()
        self.sentinel.restore_retained.assert_called_once()
        self.helper.rollback_retained.assert_called_once()

    def test_import_executes_only_the_exact_held_target_entrypoint(self):
        source = Path(self.manifest['selectionDirectory']) / 'scripts'
        source.mkdir(parents=True, mode=0o700)
        name = 'orbis-fixture.py'
        body = b"PROTOCOL='fixture-only'\n"
        path = source / name
        path.write_bytes(body)
        path.chmod(0o600)
        self.manifest['host']['inventory'][name] = R.sha(body)
        module = REAL_LOAD_TARGET(self.launcher, self.admission, name)
        self.assertEqual(module.PROTOCOL, 'fixture-only')
        path.write_bytes(b"raise RuntimeError('must not execute changed source')\n")
        with self.assertRaises(ValueError):
            REAL_LOAD_TARGET(self.launcher, self.admission, name)

    def test_core_journal_progress_is_followed_without_writing_the_accepted_job(self):
        progress = R.Progress(self.launcher, self.service, self.boot, OBSERVER)
        progress.publish('installing')
        SERVICE.write_private(self.base / 'core-journal.json', {
            'targetDigest': self.target['digest'], 'stage': 'staged', 'progressPhase': 'verifying'})
        with progress.follow_core(self.update, self.job):
            time.sleep(0.15)
        self.assertEqual(self.read(self.directory / 'component-progress.json')['progress']['job']['phase'], 'verifying')
        self.assertEqual(self.read(self.job_file), self.job)


if __name__ == '__main__':
    unittest.main()
