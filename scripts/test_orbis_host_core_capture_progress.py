import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
from types import SimpleNamespace
import unittest
import tempfile
from unittest import mock


spec = importlib.util.spec_from_file_location('capture_progress', Path(__file__).with_name('orbis-host-core-capture-progress.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
POINT = '12345678-1234-4123-8123-123456789abc'
HASH = re.compile('[a-f0-9]{64}')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def digest(body):
    return hashlib.sha256(body).hexdigest()


class CaptureProgressTests(unittest.TestCase):
    def setUp(self):
        self.service = SimpleNamespace(root=Path('/installation'), state_dir=Path('/authority'), context='default')
        self.directory = self.service.state_dir / 'core-capture-admissions' / POINT
        self.core = self.service.state_dir / 'time-machine-core' / POINT
        self.records = {}
        self.request = {'id': POINT, 'root': '/installation', 'context': 'default',
                        'sourceSha256': 'a' * 64, 'leaseNonce': 'b' * 64}
        self.hold = {'schema': 'orbis.core-capture-source-hold.v2', 'id': POINT, 'sourceSha256': 'a' * 64}
        self.put(self.directory, 'request.json', self.request)
        self.put(self.directory, 'source-hold.json', self.hold)
        self.worker = SimpleNamespace(require_root=mock.Mock(), identifier=lambda value: value,
            HASH=HASH, digest=digest, P=SimpleNamespace(canonical=canonical),
            CORE=SimpleNamespace(SCHEMA='orbis.time-machine-core-job.v1', SCOPE='controller-live-proxy.v1',
                                 TX=SimpleNamespace(SCHEMA='transaction'), HOST=object()))
        self.reader = SimpleNamespace(worker=self.worker, status=mock.Mock(return_value={'id': POINT, 'state': 'running'}))
        self.progress = module.CaptureProgress(self.service, self.reader)
        self.progress.read = self.read
        self.progress.unchanged = mock.Mock()
        self.progress.controller_healthy = mock.Mock(return_value=True)
        self.progress.publication_current = mock.Mock()

    def put(self, directory, name, value):
        self.records[(directory, name)] = (copy.deepcopy(value), canonical(value))

    def read(self, directory, name, *, optional=False):
        result = self.records.get((directory, name))
        if result is None and not optional:
            raise FileNotFoundError(name)
        return result

    def job(self, phase):
        value = {'schema': self.worker.CORE.SCHEMA, 'id': POINT, 'root': '/installation', 'context': 'default',
                 'scope': self.worker.CORE.SCOPE, 'phase': phase, 'checkpoint': {'approved': True}}
        self.put(self.core, 'job.json', value)
        return value

    def completed(self):
        proof = {'schema': 'orbis.core-capture-completion-ready.v1', 'id': POINT,
                 'requestSha256': digest(canonical(self.request)), 'leaseNonce': self.request['leaseNonce'],
                 'sourceHoldSha256': digest(canonical(self.hold)), 'pointReservationSha256': 'c' * 64,
                 'controller': {'id': 'd' * 64}}
        commit = {'completionSha256': digest(canonical(proof)), 'requestSha256': proof['requestSha256'],
                  'sourceHoldSha256': proof['sourceHoldSha256'], 'pointReservationSha256': 'c' * 64,
                  'continuationSha256': 'e' * 64}
        self.put(self.directory, 'completion-ready.json', proof)
        self.put(self.directory, 'completion-commit.json', commit)
        witness = {'schema': 'orbis.core-capture-retirement-witness.v1', 'id': POINT,
                   'completionSha256': commit['completionSha256'], 'continuationSha256': commit['continuationSha256'],
                   'sourceHoldSha256': commit['sourceHoldSha256'], 'namespace': {
                       'schema': 'orbis.core-capture-source-retirement.v1', 'id': POINT,
                       'sourceHoldSha256': commit['sourceHoldSha256']}}
        self.put(self.directory, 'source-retired.json', witness)
        self.retirement = SimpleNamespace(inspect_retired=mock.Mock(return_value=commit))
        self.worker.load = mock.Mock(return_value=SimpleNamespace(CaptureRetirement=mock.Mock(return_value=self.retirement)))

    def test_durable_phases_not_elapsed_time(self):
        for phase, expected in [('preparing', 'preparing'), ('checkpointing', 'saving-orbis'),
                                ('resuming', 'starting-orbis'), ('complete', 'sealing')]:
            with self.subTest(phase=phase):
                self.job(phase)
                result = self.progress.progress(POINT)
                self.assertEqual(result['phase'], expected)
                self.assertFalse(result['restartVerified'])
                self.assertIsNone(result['totalBytes'])
                self.assertEqual(result['completedBytes'], 0)
        job = self.job('checkpointing')
        self.put(self.core, 'checkpoint.json', {'schema': 'transaction', 'review': job['checkpoint'], 'stage': 'quiescing'})
        self.assertEqual(self.progress.progress(POINT)['phase'], 'stopping-orbis')
        self.put(self.core, 'checkpoint.json', {'schema': 'transaction', 'review': job['checkpoint'], 'stage': 'unknown'})
        with self.assertRaises(ValueError):
            self.progress.progress(POINT)
        self.progress.controller_healthy.assert_not_called()

    def test_reserved_and_settled_worker_never_imply_complete(self):
        for state, expected in [('reserved', 'waiting'), ('launch-unsettled', 'waiting'),
                                ('resumed-awaiting-publication', 'running'), ('recovery-required', 'recovery-required')]:
            self.reader.status.return_value = {'id': POINT, 'state': state}
            result = self.progress.progress(POINT)
            self.assertEqual(result['state'], expected)
            self.assertNotEqual(result['phase'], 'complete')
            self.assertFalse(result['restartVerified'])

    def test_current_installation_and_core_journal_must_match(self):
        self.job('resuming')
        for directory, name, key in [(self.directory, 'request.json', 'root'), (self.core, 'job.json', 'context')]:
            original = self.records[(directory, name)]
            self.put(directory, name, {**original[0], key: 'different'})
            with self.assertRaises(ValueError):
                self.progress.progress(POINT)
            self.records[(directory, name)] = original

    def test_complete_requires_retirement_current_publication_and_health(self):
        self.completed()
        result = self.progress.progress(POINT)
        self.assertEqual(result['state'], 'complete')
        self.assertTrue(result['restartVerified'])
        self.assertEqual(self.retirement.inspect_retired.call_count, 2)
        self.reader.status.assert_not_called()
        self.progress.publication_current.assert_called_once()
        self.progress.controller_healthy.return_value = False
        result = self.progress.progress(POINT)
        self.assertEqual(result['phase'], 'starting-orbis')
        self.assertFalse(result['restartVerified'])

    def test_missing_witness_is_observation_only_never_reconciled(self):
        self.completed()
        del self.records[(self.directory, 'source-retired.json')]
        self.assertEqual(self.progress.progress(POINT)['phase'], 'sealing')
        self.assertNotIn((self.directory, 'source-retired.json'), self.records)
        self.progress.publication_current.assert_not_called()
        self.progress.controller_healthy.assert_not_called()

    def test_hash_mismatch_and_changed_publication_fail_closed(self):
        self.completed()
        self.put(self.directory, 'completion-ready.json', {**self.records[(self.directory, 'completion-ready.json')][0], 'extra': 1})
        with self.assertRaises(ValueError):
            self.progress.progress(POINT)
        self.progress.controller_healthy.assert_not_called()
        self.completed()
        self.progress.publication_current.side_effect = ValueError('changed')
        with self.assertRaises(ValueError):
            self.progress.progress(POINT)

    def test_selected_component_needs_wrapper_not_just_base_completion(self):
        self.completed()
        manager = SimpleNamespace(verify_wrapper=mock.Mock(side_effect=ValueError('unsealed')))
        self.progress.selected_view = mock.Mock(return_value=manager)
        self.progress.selected = mock.Mock(return_value={'state': 'running', 'phase': 'sealing', 'restartVerified': True})
        with self.assertRaises(ValueError):
            self.progress.progress(POINT)
        manager.verify_wrapper.assert_called_once_with(POINT, 'd' * 64)
        manager.verify_wrapper.side_effect = None
        self.assertEqual(self.progress.progress(POINT)['state'], 'complete')
        self.progress.selected.return_value['state'] = 'recovery-required'
        self.assertEqual(self.progress.progress(POINT)['state'], 'recovery-required')

    def test_read_only_selected_view_does_not_call_lifecycle_constructor(self):
        class Selected:
            def __init__(self, *args):
                raise AssertionError('lifecycle constructor must not run')
        self.worker.SELECTED = SimpleNamespace(SelectedCapture=Selected)
        self.worker.A = object()
        view = self.progress.selected_view()
        self.assertEqual(view.base, Path('/authority/selected-captures'))
        self.assertIs(view.authority, self.worker.A)

    def test_fresh_health_uses_the_exact_resumed_controller_and_bounded_read(self):
        definition = {'mounts': [], 'label': '\u03a9'}
        frame = {'id': 'd' * 64, 'imageId': 'sha256:' + 'e' * 64, 'startedAt': 'start',
                 'definitionSha256': digest(canonical(definition))}
        raw = {'Id': frame['id'], 'Image': frame['imageId'], 'State': {
            'Status': 'running', 'Running': True, 'StartedAt': 'start', 'Health': {'Status': 'healthy'}}}
        output = mock.Mock(return_value=canonical(raw))
        self.worker.CORE.D = SimpleNamespace(DockerRestoreRuntime=SimpleNamespace(
            bounded_output=output, definition=lambda runtime, value: definition))
        self.worker.CORE.TX.APPS = SimpleNamespace(digest=lambda value: digest(canonical(value)))
        self.worker.P.metadata = lambda body, **kwargs: json.loads(body)
        observe = lambda: module.CaptureProgress.controller_healthy(self.progress, frame)
        self.assertTrue(observe())
        self.assertEqual(output.call_args.args[-1], 1)
        for state in ({'Health': {'Status': 'starting'}}, {'Running': False}, {'Paused': True}, {'Restarting': True}):
            output.return_value = canonical({**raw, 'State': {**raw['State'], **state}})
            self.assertFalse(observe())
        for key, value in [('Id', 'f' * 64), ('Image', 'sha256:' + 'f' * 64)]:
            output.return_value = canonical({**raw, key: value})
            with self.assertRaises(ValueError):
                observe()
        output.return_value = canonical({**raw, 'State': {**raw['State'], 'StartedAt': 'different'}})
        with self.assertRaises(ValueError):
            observe()

    def test_publication_rechecks_metadata_and_identities_without_archive_scan(self):
        proof = {'controller': {'id': 'd' * 64}, 'publicationSeal': {'verified': True}}
        output = mock.Mock(return_value=canonical(proof['publicationSeal']))
        self.worker.P.metadata = lambda body, **kwargs: json.loads(body)
        self.worker.load = mock.Mock(return_value=SimpleNamespace(PUBLICATION_SEAL_READER='sealed-stat-reader'))
        self.worker.CORE.D = SimpleNamespace(DockerRestoreRuntime=SimpleNamespace(bounded_output=output))
        module.CaptureProgress.publication_current(self.progress, POINT, proof)
        self.assertEqual(output.call_args.args[-2:], (8192, 1))
        self.assertEqual(output.call_args.args[1][-3:], ['-e', 'sealed-stat-reader', POINT])
        output.return_value = canonical({'verified': False})
        with self.assertRaises(ValueError):
            module.CaptureProgress.publication_current(self.progress, POINT, proof)


class ProtectedObservationTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('capture_progress_authority_test', Path(__file__).with_name('orbis-host-retained-authority.py'))
        self.authority = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.authority)
        self.authority.OWNER = os.geteuid()
        self.temporary = tempfile.TemporaryDirectory(prefix='capture-progress-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name).resolve()
        os.chmod(self.directory, 0o700)
        worker = SimpleNamespace(A=self.authority, P=self.authority.P)
        service = SimpleNamespace(root=self.directory, state_dir=self.directory, context='default')
        self.progress = module.CaptureProgress(service, SimpleNamespace(worker=worker))

    def write(self, name='proof.json', value=None):
        target = self.directory / name
        target.write_bytes(self.authority.P.canonical(value if value is not None else {'version': 1}))
        target.chmod(0o600)
        return target

    def test_unchanged_reads_use_existing_protected_files(self):
        target = self.write()
        before = target.stat()
        self.assertEqual(self.progress.read(self.directory, 'proof.json')[0], {'version': 1})
        self.progress.unchanged()
        self.assertEqual(target.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertIsNone(self.progress.read(self.directory / 'missing', 'proof.json', optional=True))
        self.assertFalse((self.directory / 'missing').exists())

    def test_absence_or_same_bytes_cannot_hide_inode_replacement(self):
        self.progress.read(self.directory, 'proof.json', optional=True)
        self.write()
        with self.assertRaises(ValueError):
            self.progress.unchanged()
        self.progress.seen.clear()
        self.progress.read(self.directory, 'proof.json')
        replacement = self.write('replacement.json')
        os.replace(replacement, self.directory / 'proof.json')
        with self.assertRaises(ValueError):
            self.progress.unchanged()

    def test_symlinks_and_nonprivate_records_are_refused(self):
        target = self.write('target.json')
        (self.directory / 'proof.json').symlink_to(target)
        with self.assertRaises((ValueError, OSError)):
            self.progress.read(self.directory, 'proof.json')
        target.chmod(0o644)
        with self.assertRaises(ValueError):
            self.progress.read(self.directory, 'target.json')

    def test_host_callback_uses_existing_reader_without_lifecycle_admission(self):
        spec = importlib.util.spec_from_file_location('capture_progress_host_callback', Path(__file__).with_name('orbis-host-service.py'))
        host = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(host)
        directory = self.directory / 'core-capture-admissions' / POINT
        directory.mkdir(mode=0o700, parents=True)
        request = {'id': POINT, 'root': str(self.directory), 'context': 'default', 'sourceSha256': 'a' * 64}
        hold = {'schema': 'orbis.core-capture-source-hold.v1', 'id': POINT, 'sourceSha256': 'a' * 64}
        for name, value in [('request.json', request), ('source-hold.json', hold)]:
            target = directory / name
            target.write_bytes(self.authority.P.canonical(value))
            target.chmod(0o600)
        worker = SimpleNamespace(A=self.authority, P=self.authority.P, require_root=mock.Mock(),
                                 identifier=lambda point: point, digest=digest)
        reader = SimpleNamespace(worker=worker, status=mock.Mock(return_value={'id': POINT, 'state': 'reserved'}))
        service = SimpleNamespace(root=self.directory, state_dir=self.directory, context='default', _core_capture_reader=reader)
        before = sorted(str(path.relative_to(self.directory)) for path in self.directory.rglob('*'))
        with mock.patch.object(host, 'core_capture_admission', side_effect=AssertionError('lifecycle admission is forbidden')):
            result = host.HostService.sentinel_capture_progress(service, POINT)
        self.assertEqual(result['state'], 'waiting')
        self.assertEqual(result['phase'], 'preparing')
        self.assertFalse(result['restartVerified'])
        reader.status.assert_called_once_with(POINT, {'sourceSha256': 'a' * 64, 'sourceHoldSha256': digest(self.authority.P.canonical(hold))})
        self.assertEqual(before, sorted(str(path.relative_to(self.directory)) for path in self.directory.rglob('*')))


if __name__ == '__main__':
    unittest.main()
