"""Private receipt tests with explicit fake kernel/systemd/process boundaries."""
import copy
import errno
import importlib.util
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


S = load('orbis-host-core-capture-supervisor.py', 'delegated_supervisor_subject')
F = load('test_orbis_host_core_capture_worker.py', 'delegated_supervisor_admission_fixtures')
W = F.W


class FakeLeaf:
    def __init__(self, runtime):
        self.runtime = runtime
        self.binding = copy.deepcopy(runtime.binding)
        self.closed = False

    def verify(self):
        if self.runtime.leaf_error:
            raise self.runtime.leaf_error
        if self.binding != self.runtime.binding:
            raise S.SupervisionError('Fake kernel leaf identity changed')

    def empty(self):
        self.verify()
        if self.runtime.events_error:
            raise self.runtime.events_error
        self.runtime.events.append(('population', self.runtime.population, self.runtime.waited))
        return self.runtime.population == 0

    def enter(self, pid):
        self.verify()
        if pid != os.getpid():
            raise AssertionError('Fake kernel only permits moving self')
        self.runtime.moves.append(pid)
        self.runtime.processes[pid]['cgroup'] = self.binding['path']
        self.runtime.population = 1

    def close(self):
        self.closed = True


class FakeRuntime:
    def __init__(self, case):
        self.case = case
        self.supervisor_pid, self.child_pid = os.getpid(), os.getpid() + 10000
        self.boot_id = '11111111-2222-4333-8444-555555555555'
        self.invocation = 'c' * 32
        self.parent_path = '/system.slice/orbis-core-capture-' + case.point + '.service'
        self.binding = {'path': self.parent_path + '/worker', 'device': 11, 'inode': 25}
        self.processes = {}
        self.population = 0
        self.events_error = self.leaf_error = None
        self.created = self.waited = False
        self.moves, self.spawns, self.events, self.pins = [], [], [], []
        self.exit_code = 0
        self.unsupported = False
        self.on_wait = case.successful_receipts
        self.unit_values = {'InvocationID': self.invocation, 'MainPID': str(self.supervisor_pid),
                            'Type': 'exec', 'Restart': 'no', 'RemainAfterExit': 'yes', 'KillMode': 'control-group',
                            'Delegate': 'yes', 'ControlGroup': self.parent_path,
                            'ActiveState': 'active', 'SubState': 'running'}
        self.add_process(self.supervisor_pid, S.SUPERVISOR, parent=1, start=123)
        self.add_process(self.child_pid, case.worker.WORKER, parent=self.supervisor_pid, start=456)

    def add_process(self, pid, script, *, parent, start):
        self.processes[pid] = {'pid': pid, 'parent': parent, 'startTime': start,
                               'argv': [os.fsencode(value) for value in S._argv(script, self.case.admission())],
                               'executable': str(Path('/usr/bin/python3').resolve(strict=True)),
                               'invocationId': self.invocation, 'cgroup': self.parent_path}

    def supported(self):
        if self.unsupported:
            raise S.SupervisionError('Explicit fake unsupported kernel')

    def boot(self):
        return self.boot_id

    def process(self, pid):
        if pid not in self.processes:
            raise FileNotFoundError('Explicit fake missing process')
        return copy.deepcopy(self.processes[pid])

    def unit(self, unit):
        if unit != 'orbis-core-capture-' + self.case.point + '.service':
            raise AssertionError('Unexpected unit lookup')
        return copy.deepcopy(self.unit_values)

    def pin(self, path, *, create=False):
        if path != self.binding['path']:
            raise AssertionError('Unexpected leaf lookup')
        if create:
            if self.created:
                raise FileExistsError('Explicit fake exclusive cgroup mkdir')
            self.created = True
        elif not self.created:
            raise FileNotFoundError('Explicit fake missing leaf')
        leaf = FakeLeaf(self)
        self.pins.append(leaf)
        return leaf

    def spawn(self, command):
        self.spawns.append(command)
        if not (self.case.directory / 'supervisor.json').exists():
            raise AssertionError('Supervisor record must precede spawn')
        if command != S._argv(self.case.worker.WORKER, self.case.admission()):
            raise AssertionError('Unexpected child command')
        self.population = 1

        def wait():
            self.waited = True
            self.events.append(('waitpid', self.child_pid))
            if self.on_wait:
                self.on_wait()
            return self.exit_code
        return SimpleNamespace(pid=self.child_pid, wait=wait)

    def wait(self, child):
        return child.wait()


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        # This fixture produces actual protected admission, handoff, and lease files.
        self.fixture = F.CoreCaptureWorkerTests('test_duplicate_claim_rejects_without_repeating_commands')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.point, self.state, self.directory = self.fixture.point, self.fixture.state, self.fixture.directory
        self.worker = SimpleNamespace(**{name: getattr(W, name) for name in
            ('require_root', 'Admission', 'AdmissionError', 'WORKER', 'worker_hash', 'digest', 'P', 'A')})
        self.worker.read_status = mock.Mock(side_effect=self.validated_fake_status)
        admission = self.admission()
        admission.create('launch-intent.json', admission.event('launch-intent',
            workerSha256=self.worker.worker_hash(), unit='orbis-core-capture-' + self.point,
            supervisionProtocol=2, supervisorSha256=S.source_hash(self.worker)))
        self.runtime = FakeRuntime(self)
        self.enterContext(mock.patch.dict(os.environ, {'INVOCATION_ID': self.runtime.invocation}))
        self.artifact = {'fixture': 'explicit-fake-artifact', 'pointId': self.point}
        self.settlement = {'fixture': 'explicit-fake-settlement'}

    def admission(self):
        return W.Admission(self.state, self.point)

    def read(self, name):
        return self.admission().read(name)[0]

    def rewrite(self, name, value):
        path = self.directory / name
        path.write_bytes(W.P.canonical(value))
        path.chmod(0o600)

    def successful_receipts(self):
        admission = self.admission()
        record = admission.read('supervisor.json')[0]
        self.runtime.processes[self.runtime.child_pid]['cgroup'] = self.runtime.binding['path']
        frame = S._frame(record, self.runtime.processes[self.runtime.child_pid])
        admission.create('claim.json', admission.event('claim', workerSha256=record['workerSha256'], supervision=frame))
        admission.create('settled.json', admission.event('settled', state='resumed-awaiting-publication',
                         settlement=self.settlement, checkpointArtifactSha256=W.digest(W.P.canonical(self.artifact))))
        self.runtime.population = 0

    def validated_fake_status(self, state, point):
        self.assertEqual((Path(state), point), (self.state, self.point))
        settled = self.admission().read('settled.json')[0]
        if (settled.get('checkpointArtifactSha256') != W.digest(W.P.canonical(self.artifact))
                or settled.get('settlement') != self.settlement):
            raise W.AdmissionError('Explicit fake invalid artifact settlement')
        return {'id': self.point, 'state': 'resumed-awaiting-publication',
                'settlement': self.settlement, 'artifact': self.artifact}

    def run_supervisor(self):
        return S.run_supervisor(self.worker, self.state, self.point, runtime=self.runtime)

    def terminal(self):
        return S.read_terminal(self.admission(), worker=self.worker, runtime=self.runtime)

    def save_supervisor(self):
        admission = self.admission()
        self.runtime.created = True
        parent = self.runtime.processes[self.runtime.supervisor_pid]
        record = S._event(admission, 'supervisor', bootId=self.runtime.boot_id,
            unit='orbis-core-capture-' + self.point + '.service', invocationId=self.runtime.invocation,
            supervisorProcessId=self.runtime.supervisor_pid, supervisorStartTime=parent['startTime'],
            workerSha256=self.worker.worker_hash(), supervisorSha256=S.source_hash(self.worker),
            workerLeaf=self.runtime.binding)
        admission.create('supervisor.json', record)
        return record

    def enter_worker(self):
        with mock.patch.object(S.os, 'getpid', return_value=self.runtime.child_pid):
            return S.enter_worker(self.admission(), worker=self.worker, runtime=self.runtime)

    def verify_worker(self, frame):
        with mock.patch.object(S.os, 'getpid', return_value=self.runtime.child_pid):
            return S.verify_worker(self.admission(), frame, worker=self.worker, runtime=self.runtime)

    def test_success_requires_wait_and_empty_pinned_leaf_then_private_read_is_stable(self):
        result = self.run_supervisor()
        self.assertEqual(result['state'], 'quiescent')
        self.assertTrue(result['workerQuiescent'])
        self.assertEqual(result['workerExitCode'], 0)
        self.assertEqual(self.terminal(), result)
        self.assertEqual(self.runtime.events[0], ('population', 0, False))
        self.assertIn(('waitpid', self.runtime.child_pid), self.runtime.events)
        self.assertTrue(all(event[2] for event in self.runtime.events[2:] if event[0] == 'population'))
        self.assertTrue(all(leaf.closed for leaf in self.runtime.pins))
        for name in ('supervisor.json', 'worker-terminal.json'):
            self.assertEqual((self.directory / name).stat().st_mode & 0o777, 0o600)
        self.fixture.assert_held()
        self.assertEqual(self.fixture.fixture.docker.calls, [])

    def test_live_child_enters_leaf_before_claim_and_verifies_exact_execution(self):
        self.save_supervisor()
        frame = self.enter_worker()
        self.assertEqual(frame['version'], 2)
        self.assertEqual(self.runtime.moves, [self.runtime.child_pid])
        self.assertFalse((self.directory / 'claim.json').exists())
        self.verify_worker(frame)
        self.assertEqual(S.validate_frame(self.admission(), frame, worker=self.worker, runtime=self.runtime), frame)
        self.fixture.assert_held()

    def test_external_running_observer_requires_the_exact_live_child_and_parent(self):
        self.save_supervisor()
        frame = self.enter_worker()
        self.assertEqual(S.observe_worker(self.admission(), frame, worker=self.worker, runtime=self.runtime), frame)
        del self.runtime.processes[self.runtime.child_pid]
        with self.assertRaises(FileNotFoundError):
            S.observe_worker(self.admission(), frame, worker=self.worker, runtime=self.runtime)
        self.fixture.assert_held()

    def test_descendant_population_survives_child_zero_and_fails_closed(self):
        def descendant():
            self.successful_receipts()
            self.runtime.population = 1
        self.runtime.on_wait = descendant
        result = self.run_supervisor()
        self.assertEqual(result['workerExitCode'], 0)
        self.assertEqual(result['state'], 'recovery-required')
        self.assertFalse(result['workerQuiescent'])
        self.worker.read_status.assert_not_called()
        self.assertEqual(self.terminal(), result)
        self.assertTrue(self.runtime.created)
        self.fixture.assert_held()

    def test_removed_kernel_events_after_wait_is_not_empty_evidence(self):
        def removed_events():
            self.successful_receipts()
            self.runtime.events_error = OSError(errno.ENODEV, 'Explicit fake retired cgroup')
        self.runtime.on_wait = removed_events
        result = self.run_supervisor()
        self.assertEqual(result['state'], 'recovery-required')
        self.assertFalse(result['workerQuiescent'])
        self.assertEqual(result['failureClass'], 'OSError')
        self.fixture.assert_held()

    def test_replaced_leaf_identity_after_wait_fails_closed(self):
        def replaced():
            self.successful_receipts()
            self.runtime.binding['inode'] += 1
        self.runtime.on_wait = replaced
        result = self.run_supervisor()
        self.assertEqual(result['state'], 'recovery-required')
        self.assertFalse(result['workerQuiescent'])
        self.worker.read_status.assert_not_called()

    def test_worker_failure_and_missing_receipts_cannot_report_success(self):
        self.runtime.on_wait = lambda: setattr(self.runtime, 'population', 0)
        self.runtime.exit_code = 7
        result = self.run_supervisor()
        self.assertEqual(result['state'], 'recovery-required')
        self.assertEqual(result['workerExitCode'], 7)
        self.assertEqual(self.terminal(), result)
        self.worker.read_status.assert_not_called()
        self.fixture.assert_held()

    def test_failed_claimed_child_has_independent_quiescence_witness(self):
        self.runtime.exit_code = 1
        result = self.run_supervisor()
        self.assertEqual(result['state'], 'recovery-required')
        self.assertTrue(result['workerQuiescent'])
        self.assertEqual(result['workerExitCode'], 1)
        self.assertIsNotNone(result['failureClass'])
        self.assertIsNotNone(result['claimSha256'])
        self.assertEqual(self.terminal(), result)
        self.worker.read_status.assert_not_called()
        self.fixture.assert_held()

    def test_zero_exit_without_claim_and_settled_is_failure(self):
        self.runtime.on_wait = lambda: setattr(self.runtime, 'population', 0)
        result = self.run_supervisor()
        self.assertEqual(result['state'], 'recovery-required')
        self.assertEqual(self.terminal(), result)
        self.worker.read_status.assert_not_called()

    def test_settled_worker_without_valid_artifact_is_failure(self):
        self.worker.read_status.return_value = None
        self.worker.read_status.side_effect = lambda *args: {'id': self.point, 'state': 'resumed-awaiting-publication'}
        result = self.run_supervisor()
        self.assertEqual(result['state'], 'recovery-required')
        self.assertTrue(result['workerQuiescent'])
        self.fixture.assert_held()

    def test_wrong_claim_child_pid_does_not_become_terminal_authority(self):
        def wrong_claim():
            self.successful_receipts()
            claim = self.read('claim.json')
            claim['supervision']['processId'] += 1
            self.rewrite('claim.json', claim)
        self.runtime.on_wait = wrong_claim
        result = self.run_supervisor()
        self.assertEqual(result['state'], 'recovery-required')
        with self.assertRaises(S.SupervisionError):
            self.terminal()
        self.fixture.assert_held()

    def test_replay_never_spawns_or_recreates_leaf(self):
        self.run_supervisor()
        with self.assertRaises(S.SupervisionError):
            self.run_supervisor()
        self.assertEqual(len(self.runtime.spawns), 1)
        self.fixture.assert_held()

    def test_partial_supervisor_is_non_replayable(self):
        (self.directory / 'supervisor.json').write_bytes(b'{')
        (self.directory / 'supervisor.json').chmod(0o600)
        with self.assertRaises(ValueError):
            self.run_supervisor()
        self.assertFalse(self.runtime.created)
        self.assertEqual(self.runtime.spawns, [])

    def test_partial_terminal_blocks_before_new_leaf(self):
        (self.directory / 'worker-terminal.json').write_bytes(b'{')
        (self.directory / 'worker-terminal.json').chmod(0o600)
        with self.assertRaises(ValueError):
            self.run_supervisor()
        self.assertEqual(self.runtime.spawns, [])
        self.assertFalse(self.runtime.created)

    def test_existing_claim_blocks_before_new_leaf(self):
        self.admission().create('claim.json', {'fixture': 'already-consumed'})
        with self.assertRaises(S.SupervisionError):
            self.run_supervisor()
        self.assertEqual(self.runtime.spawns, [])
        self.assertFalse(self.runtime.created)

    def test_unsupported_platform_precedes_admission_and_worker_mutation(self):
        self.runtime.unsupported = True
        with mock.patch.object(self.worker, 'Admission', side_effect=AssertionError('No admission')):
            with self.assertRaisesRegex(S.SupervisionError, 'unsupported'):
                self.run_supervisor()
        self.assertEqual(self.runtime.spawns, [])
        self.assertFalse(self.runtime.created)
        self.assertFalse((self.directory / 'supervisor.json').exists())

    def test_wrong_unit_contract_fails_before_leaf_creation(self):
        for key, value in (('Delegate', 'no'), ('MainPID', '0'), ('Type', 'simple'),
                           ('Restart', 'always'), ('RemainAfterExit', 'no'), ('KillMode', 'process'),
                           ('InvocationID', 'd' * 32), ('ControlGroup', '/unrelated')):
            with self.subTest(key=key):
                prior = self.runtime.unit_values[key]
                self.runtime.unit_values[key] = value
                with self.assertRaises(S.SupervisionError):
                    self.run_supervisor()
                self.runtime.unit_values[key] = prior
        self.assertEqual(self.runtime.spawns, [])
        self.assertFalse(self.runtime.created)

    def test_v2_launch_intent_must_bind_both_sources_and_protocol_before_leaf(self):
        original = self.read('launch-intent.json')
        for key, value in (('workerSha256', 'e' * 64), ('supervisorSha256', 'f' * 64),
                           ('unit', 'orbis-core-capture-other'), ('supervisionProtocol', 1),
                           ('supervisionProtocol', True), ('extra', 1)):
            with self.subTest(key=key, value=value):
                self.rewrite('launch-intent.json', {**original, key: value})
                with self.assertRaises(S.SupervisionError):
                    self.run_supervisor()
        self.assertFalse(self.runtime.created)
        self.assertEqual(self.runtime.spawns, [])

    def test_missing_or_wrong_environment_invocation_fails_before_leaf(self):
        with mock.patch.dict(os.environ, {'INVOCATION_ID': 'd' * 32}):
            with self.assertRaises(S.SupervisionError):
                self.run_supervisor()
        self.assertFalse(self.runtime.created)

    def test_worker_rejects_wrong_parent_boot_pid_argv_exe_and_membership(self):
        self.save_supervisor()
        child = self.runtime.processes[self.runtime.child_pid]
        changes = [('parent', self.runtime.supervisor_pid + 1), ('startTime', 0),
                   ('argv', [b'python', b'unadmitted.py']), ('executable', '/wrong/python'),
                   ('cgroup', '/wrong/group'), ('invocationId', 'd' * 32)]
        for key, value in changes:
            with self.subTest(key=key):
                original = child[key]
                child[key] = value
                with self.assertRaises(S.SupervisionError):
                    self.enter_worker()
                child[key] = original
        self.runtime.boot_id = '99999999-2222-4333-8444-555555555555'
        with self.assertRaises(S.SupervisionError):
            self.enter_worker()
        self.assertEqual(self.runtime.moves, [])
        self.assertFalse((self.directory / 'claim.json').exists())

    def test_saved_frame_rejects_extra_keys_boolean_pids_and_changed_leaf(self):
        self.save_supervisor()
        frame = self.enter_worker()
        for key, value in (('processId', True), ('processStartTime', True), ('version', True),
                           ('parentProcessId', self.runtime.supervisor_pid + 1),
                           ('parentStartTime', 124), ('bootId', 'bad'),
                           ('workerLeaf', {**self.runtime.binding, 'inode': 26}), ('extra', 1)):
            with self.subTest(key=key):
                altered = {**frame, key: value}
                with self.assertRaises(S.SupervisionError):
                    S.validate_frame(self.admission(), altered, worker=self.worker, runtime=self.runtime)

    def test_reused_unit_and_parent_pid_reuse_fail_worker_verification(self):
        self.save_supervisor()
        frame = self.enter_worker()
        self.runtime.unit_values['InvocationID'] = 'd' * 32
        with self.assertRaises(S.SupervisionError):
            self.verify_worker(frame)
        self.runtime.unit_values['InvocationID'] = self.runtime.invocation
        self.runtime.processes[self.runtime.supervisor_pid]['startTime'] += 1
        with self.assertRaises(S.SupervisionError):
            self.verify_worker(frame)

    def test_saved_frame_validator_does_not_infer_live_worker_or_unit_presence(self):
        self.save_supervisor()
        frame = self.enter_worker()
        self.runtime.processes.clear()
        self.runtime.unit_values = {}
        self.runtime.leaf_error = FileNotFoundError('Explicit fake retired leaf')
        self.assertEqual(S.validate_frame(self.admission(), frame, worker=self.worker, runtime=self.runtime), frame)
        self.assertIsNone(S.read_terminal(self.admission(), worker=self.worker, runtime=self.runtime))

    def test_terminal_binds_supervisor_claim_settled_and_boot(self):
        result = self.run_supervisor()
        for name, key, value in (('supervisor.json', 'invocationId', 'd' * 32),
                                 ('claim.json', 'workerSha256', 'f' * 64),
                                 ('settled.json', 'state', 'different')):
            with self.subTest(name=name):
                prior = self.read(name)
                altered = copy.deepcopy(prior)
                altered[key] = value
                self.rewrite(name, altered)
                with self.assertRaises((S.SupervisionError, W.AdmissionError)):
                    self.terminal()
                self.rewrite(name, prior)
        self.assertEqual(self.terminal(), result)
        self.runtime.boot_id = '99999999-2222-4333-8444-555555555555'
        with self.assertRaises(S.SupervisionError):
            self.terminal()

    def test_terminal_rejects_wrong_pid_and_forged_success_flags(self):
        self.run_supervisor()
        original = self.read('worker-terminal.json')
        for key, value in (('workerProcessId', self.runtime.child_pid + 1), ('workerExitCode', 4),
                           ('workerQuiescent', False), ('failureClass', 'OSError'),
                           ('claimSha256', None), ('supervisorSha256', 'a' * 64)):
            with self.subTest(key=key):
                terminal = copy.deepcopy(original)
                terminal[key] = value
                self.rewrite('worker-terminal.json', terminal)
                with self.assertRaises(S.SupervisionError):
                    self.terminal()
        self.rewrite('worker-terminal.json', original)
        self.fixture.assert_held()

    def test_source_changes_invalidate_saved_bindings(self):
        self.run_supervisor()
        with mock.patch.object(self.worker, 'worker_hash', return_value='e' * 64):
            with self.assertRaises(S.SupervisionError):
                self.terminal()
        with mock.patch.object(S, 'source_hash', return_value='f' * 64):
            with self.assertRaises(S.SupervisionError):
                self.terminal()

    def test_wait_uncertainty_never_uses_missing_pid_as_quiescence(self):
        def interrupted():
            self.runtime.processes.pop(self.runtime.child_pid)
            raise ChildProcessError('Explicit fake unavailable wait result')
        self.runtime.on_wait = interrupted
        result = self.run_supervisor()
        self.assertEqual(result['state'], 'recovery-required')
        self.assertIsNone(result['workerExitCode'])
        self.assertFalse(result['workerQuiescent'])
        self.assertEqual(self.terminal(), result)
        self.assertTrue((self.directory / 'supervisor.json').exists())
        self.fixture.assert_held()

    def test_missing_supervisor_process_after_wait_cannot_witness_success(self):
        def parent_lost():
            self.successful_receipts()
            self.runtime.processes.pop(self.runtime.supervisor_pid)
        self.runtime.on_wait = parent_lost
        result = self.run_supervisor()
        self.assertEqual(result['state'], 'recovery-required')
        self.assertFalse(result['workerQuiescent'])
        self.worker.read_status.assert_not_called()


class KernelObservationTests(unittest.TestCase):
    def test_real_subprocess_wait_records_the_actual_nonzero_exit(self):
        child = S.subprocess.Popen(['/usr/bin/python3', '-B', '-c', 'raise SystemExit(3)'], close_fds=True)
        self.assertEqual(S.Runtime().wait(child), 3)
        self.assertEqual(child.returncode, 3)

    def test_wait_requires_actual_exact_child_status_and_never_infers_echild_success(self):
        child = SimpleNamespace(pid=123, returncode=None)
        with mock.patch.object(S.os, 'waitpid', return_value=(123, 7 << 8)) as waitpid:
            self.assertEqual(S.Runtime().wait(child), 7)
            self.assertEqual(child.returncode, 7)
            waitpid.assert_called_once_with(123, 0)
        child.returncode = None
        with mock.patch.object(S.os, 'waitpid', side_effect=ChildProcessError('already reaped')):
            with self.assertRaises(ChildProcessError):
                S.Runtime().wait(child)
        self.assertIsNone(child.returncode)
        with mock.patch.object(S.os, 'waitpid', return_value=(124, 0)):
            with self.assertRaises(S.SupervisionError):
                S.Runtime().wait(child)
        self.assertIsNone(child.returncode)
        with mock.patch.object(S.os, 'waitpid', side_effect=[InterruptedError(), (123, 0)]):
            self.assertEqual(S.Runtime().wait(child), 0)

    def test_default_runtime_explicitly_rejects_non_linux_before_mount(self):
        runtime = S.Runtime()
        with mock.patch.object(S.sys, 'platform', 'darwin'), mock.patch.object(runtime, 'mount') as mount:
            with self.assertRaises(S.SupervisionError):
                runtime.supported()
        mount.assert_not_called()

    def test_default_runtime_rejects_non_root(self):
        with mock.patch.object(S.sys, 'platform', 'linux'), mock.patch.object(S.os, 'geteuid', return_value=501):
            with self.assertRaises(S.SupervisionError):
                S.Runtime().supported()

    def test_cgroup2_mount_is_required_and_nested_or_duplicate_mounts_reject(self):
        valid = '32 1 0:28 / /sys/fs/cgroup rw,nosuid - cgroup2 cgroup rw\n'
        for value, accepted in ((valid, True), (valid.replace('cgroup2', 'tmpfs'), False),
                                (valid + valid, False),
                                (valid + '33 32 0:29 / /sys/fs/cgroup/system.slice rw - cgroup2 cgroup rw\n', False)):
            with self.subTest(value=value), mock.patch.object(S.Path, 'read_text', return_value=value):
                if accepted:
                    S.Runtime().mount()
                else:
                    with self.assertRaises(S.SupervisionError):
                        S.Runtime().mount()

    def test_real_pinned_descriptors_reject_leaf_replacement_and_only_move_self(self):
        # Real files/descriptors; root ownership and cgroup mounting are fake seams.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = '/system.slice/probe.service/worker'
            directory = root / path.lstrip('/')
            directory.mkdir(parents=True, mode=0o755)
            (directory / 'cgroup.events').write_bytes(b'populated 0\nfrozen 0\n')
            (directory / 'cgroup.procs').write_bytes(b'')
            device = root.stat().st_dev
            runtime = SimpleNamespace(mount=lambda: (os.major(device), os.minor(device)))
            fstat = os.fstat

            def fake_root_stat(descriptor):
                info = fstat(descriptor)
                return SimpleNamespace(st_dev=info.st_dev, st_ino=info.st_ino, st_uid=0, st_mode=info.st_mode)

            with mock.patch.object(S, 'CGROUP', root), mock.patch.object(S.os, 'fstat', side_effect=fake_root_stat):
                leaf = S.Leaf(runtime, path)
                try:
                    self.assertTrue(leaf.empty())
                    with self.assertRaises(S.SupervisionError):
                        leaf.enter(os.getpid() + 1)
                    leaf.enter(os.getpid())
                    self.assertEqual((directory / 'cgroup.procs').read_bytes(), str(os.getpid()).encode() + b'\n')
                    directory.rename(directory.with_name('retained-worker'))
                    directory.mkdir(mode=0o755)
                    (directory / 'cgroup.events').write_bytes(b'populated 0\n')
                    with self.assertRaisesRegex(S.SupervisionError, 'identity changed'):
                        leaf.empty()
                finally:
                    leaf.close()
                self.assertIsNone(leaf.directory)
                self.assertIsNone(leaf.events)

    def test_unit_observation_rejects_missing_duplicate_and_nonzero_response(self):
        fields = {'InvocationID': 'c' * 32, 'MainPID': '20', 'Type': 'exec', 'Restart': 'no',
                  'RemainAfterExit': 'yes', 'KillMode': 'control-group', 'Delegate': 'yes',
                  'ControlGroup': '/system.slice/probe.service', 'ActiveState': 'active', 'SubState': 'running'}
        body = ''.join(key + '=' + value + '\n' for key, value in fields.items()).encode()
        for response, accepted in ((SimpleNamespace(returncode=0, stdout=body), True),
                                    (SimpleNamespace(returncode=0, stdout=body + b'Type=exec\n'), False),
                                    (SimpleNamespace(returncode=0, stdout=b'MainPID=20\n'), False),
                                    (SimpleNamespace(returncode=1, stdout=body), False)):
            with self.subTest(response=response), mock.patch.object(S.subprocess, 'run', return_value=response):
                if accepted:
                    self.assertEqual(S.Runtime().unit('probe.service'), fields)
                else:
                    with self.assertRaises(S.SupervisionError):
                        S.Runtime().unit('probe.service')

    def test_pinned_events_reject_enodev_and_malformed_population(self):
        leaf = object.__new__(S.Leaf)
        leaf.events = 123
        leaf.verify = mock.Mock()
        with mock.patch.object(S.os, 'lseek'), mock.patch.object(S.os, 'read', side_effect=OSError(errno.ENODEV, 'retired')):
            with self.assertRaises(OSError):
                leaf.empty()
        for value, expected in ((b'populated 0\nfrozen 0\n', True), (b'populated 1\n', False),
                                 (b'populated 0\npopulated 0\n', None), (b'frozen 0\n', None),
                                 (b'populated -1\n', None), (b'populated 0 extra\n', None), (b'', None)):
            with self.subTest(value=value), mock.patch.object(S.os, 'lseek'), mock.patch.object(S.os, 'read', return_value=value):
                if expected is None:
                    with self.assertRaises(S.SupervisionError):
                        leaf.empty()
                else:
                    self.assertEqual(leaf.empty(), expected)


if __name__ == '__main__':
    unittest.main()
