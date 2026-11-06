"""Once-only automatic publication boundary tests."""
import importlib.util
import subprocess
import sys
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('auto_publication', Path(__file__).with_name('orbis-host-sentinel-auto-publication.py'))
AUTO = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUTO)


class Admission:
    def __init__(self):
        self.state, self.point, self.request_sha256 = Path('/private/state'), 'point', 'a' * 64
        self.records = {'worker-terminal.json': ({'terminal': True}, b'terminal')}

    def read(self, name, optional=False):
        if optional and name not in self.records:
            return None, None
        return self.records[name]

    def create(self, name, value):
        if name in self.records:
            raise FileExistsError(name)
        self.records[name] = value, b'proof' if name == 'sentinel-publication.json' else b'event'

    def event(self, kind, **fields):
        return {'kind': kind, **fields}


class AutoTests(unittest.TestCase):
    def setUp(self):
        self.admission = Admission()
        self.terminal = {'state': 'quiescent', 'workerQuiescent': True, 'workerExitCode': 0}
        self.worker = SimpleNamespace(Admission=lambda *_: self.admission, AdmissionError=ValueError,
            require_root=mock.Mock(), P=SimpleNamespace(metadata=lambda body, **kwargs: json.loads(body),
                canonical=lambda value: json.dumps(value, sort_keys=True, separators=(',', ':')).encode()),
            SUPERVISOR=SimpleNamespace(read_terminal=mock.Mock(return_value=self.terminal)),
            worker_context=lambda: object(), WORKER=Path('/trusted/worker.py'),
            digest=lambda body: {'terminal': 't', 'proof': 'p'}[body.decode()])
        self.selection = self.enterContext(mock.patch.object(AUTO, '_selected', return_value=True))
        self.enterContext(mock.patch.object(AUTO, '_source_hash', return_value='s'))
        self.launch = mock.Mock(side_effect=self.success)

    def success(self, command):
        self.admission.create('sentinel-publication.json', {'proof': True})
        return 0, json.dumps({'version': 1, 'id': 'point', 'state': 'verified-data-awaiting-continuation',
                              'publicationSha256': 'p', 'lifecycleComplete': False}).encode()

    def call(self, terminal=None):
        return AUTO.publish_after_terminal(self.worker, '/private/state', 'point', terminal or self.terminal,
                                           launcher=self.launch)

    def test_one_launch_and_no_replay(self):
        self.assertEqual(self.call()['state'], 'verified')
        self.assertEqual(self.call()['state'], 'already-requested')
        self.launch.assert_called_once_with(['/usr/bin/python3', '-I', '-B', '/trusted/orbis-host-sentinel-publication.py',
                                             '--state-directory', '/private/state', '--point', 'point'])

    def test_legacy_skip(self):
        self.selection.return_value = False
        self.assertEqual(self.call()['state'], 'skipped')
        self.launch.assert_not_called()

    def test_ambiguous_launch_does_not_replay(self):
        self.launch.side_effect = TimeoutError()
        self.assertEqual(self.call()['state'], 'unsettled')
        self.assertEqual(self.call()['state'], 'already-requested')
        self.launch.assert_called_once()
        self.assertIsNone(self.admission.records['sentinel-auto-result.json'][0]['proofSha256'])

    def test_terminal_mismatch_or_failure_never_launches(self):
        for terminal in ({'state': 'recovery-required'}, {**self.terminal, 'workerExitCode': 1},
                         {**self.terminal, 'workerQuiescent': False}):
            with self.subTest(terminal=terminal), self.assertRaises(ValueError):
                self.call(terminal)
        self.launch.assert_not_called()

    def test_output_limit_and_timeout_keep_launch_unsettled(self):
        for command, deadline in (([sys.executable, '-c', "import sys;sys.stdout.write('x'*10000)"], 5),
                                  ([sys.executable, '-c', 'import time;time.sleep(2)'], 0.05)):
            with self.subTest(command=command), self.assertRaises((ValueError, TimeoutError)):
                AUTO._launch(command, deadline=deadline)

    def test_source_change_and_prior_launch_do_not_replay(self):
        self.admission.create('sentinel-auto-launch.json', {'partial': True})
        self.assertEqual(self.call()['state'], 'already-requested')
        self.launch.assert_not_called()

    def test_bad_selection_and_child_failure(self):
        self.selection.side_effect = ValueError('selection')
        with self.assertRaises(ValueError):
            self.call()
        self.launch.assert_not_called()
        self.selection.side_effect = None
        self.launch.side_effect = lambda _: (1, b'private failure')
        self.assertEqual(self.call()['state'], 'unsettled')
        self.assertEqual(self.admission.records['sentinel-auto-result.json'][0]['returnCode'], 1)
        self.assertNotIn('private failure', str(self.admission.records))


class JoinedTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'linux', 'Joined private receipt and lease seals are qualified on Linux')
    def test_manual_profile_is_not_an_automatic_publication_opt_in(self):
        import test_orbis_host_sentinel_publication as publication
        f = publication.SentinelPublicationTests('runTest')
        f.setUp()
        self.addCleanup(f.doCleanups)
        worker = publication.fixtures.W
        module = worker.load('orbis-host-sentinel-capture.py', 'manual_auto_selection')
        custody = module.SentinelCaptureCustody(f.f.manager, worker, None)
        profile = {'schema': 'orbis.host.sentinel-capture-profile.v1', 'installationId': 'a' * 64,
                   'catalogDirectory': str(f.f.fixture.parent / 'catalog'), 'recoveryImageId': 'sha256:' + 'b' * 64,
                   'bundleDirectory': str(f.f.fixture.parent / 'sentinel-source'), 'bundleSha256': 'c' * 64}
        preflight = {'schema': 'orbis-sentinel.capture-image-preflight.v1', 'imageId': profile['recoveryImageId'],
                     'workers': module.IMAGE_WORKERS, 'lifecycleAuthority': False}
        f.f.write(f.f.state, 'sentinel-capture.json', profile)
        f.f.write(f.f.directory, 'sentinel-image-preflight.json', preflight)
        f.f.write(f.f.directory, 'sentinel-custody.json', custody._receipt(profile, f.f.point,
            f.f.preparation['sourceSha256'], f.f.preparation['pointReservationSha256'], preflight))
        self.assertFalse(AUTO._selected(worker, f.f.joined.admission()))
        f.f.assert_held()

    def test_original_successful_witness_is_required_for_skip(self):
        import test_orbis_host_core_capture_supervisor_worker as joined
        fixture = joined.JoinedSupervisorWorkerTests('test_joined_success_reopens_after_parent_exit_and_never_replays')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        terminal = fixture.run_supervisor()
        self.assertEqual(terminal['state'], 'quiescent')
        worker = fixture.worker
        original = worker.SUPERVISOR.read_terminal
        with mock.patch.object(worker.SUPERVISOR, 'read_terminal', side_effect=lambda admission, worker:
                original(admission, worker=worker, runtime=fixture.runtime)), \
             mock.patch.object(AUTO, '_selected', return_value=False):
            self.assertEqual(AUTO.publish_after_terminal(worker, fixture.state, fixture.point, terminal),
                             {'state': 'skipped'})
            with self.assertRaises(worker.AdmissionError):
                AUTO.publish_after_terminal(worker, fixture.state, fixture.point, {**terminal, 'workerExitCode': 1})

    @unittest.skipUnless(sys.platform == 'linux', 'Joined private receipt and lease seals are qualified on Linux')
    def test_selected_original_witness_publishes_once_and_gates_continuation(self):
        import test_orbis_host_sentinel_publication as publication
        f = publication.SentinelPublicationTests('runTest')
        f.setUp()
        self.addCleanup(f.doCleanups)
        worker = publication.fixtures.W
        profile = {'schema': 'orbis.host.sentinel-capture-profile.v2', 'publication': 'sentinel.v1',
                   'installationId': 'a' * 64, 'catalogDirectory': str(f.f.fixture.parent / 'catalog'),
                   'recoveryImageId': 'sha256:' + 'b' * 64, 'bundleDirectory': str(f.f.fixture.parent / 'sentinel-source'),
                   'bundleSha256': 'c' * 64}
        f.profile = profile
        f.bridge.require_reserved.return_value = profile
        f.bridge.require_publication_reserved.return_value = profile
        custody_module = worker.load('orbis-host-sentinel-capture.py', 'joined_auto_custody')
        custody = custody_module.SentinelCaptureCustody(f.f.manager, worker, None)
        preflight = {'schema': 'orbis-sentinel.capture-image-preflight.v1', 'imageId': profile['recoveryImageId'],
                     'workers': custody_module.IMAGE_WORKERS, 'lifecycleAuthority': False}
        f.f.write(f.f.state, 'sentinel-capture.json', profile)
        f.f.write(f.f.directory, 'sentinel-image-preflight.json', preflight)
        f.f.write(f.f.directory, 'sentinel-custody.json', custody._receipt(profile, f.f.point,
            f.f.preparation['sourceSha256'], f.f.preparation['pointReservationSha256'], preflight))
        admission = f.f.joined.admission()
        terminal = worker.SUPERVISOR.read_terminal(admission, worker=worker.worker_context())
        module = worker.load('orbis-host-sentinel-reader.py', 'joined_auto_reader')
        reader = module.SentinelPublicationReader(f.f.manager, worker)
        request = {'sourceSha256': f.f.preparation['sourceSha256'], 'sourceHoldSha256': worker.digest(f.f.hold_body)}
        calls = []
        def launch(command):
            calls.append(command)
            result = f.publish()
            self.assertEqual(reader.status(f.f.point, request)['state'], 'awaiting-publication')
            return 0, json.dumps(result).encode()
        with mock.patch.object(AUTO, '_source_hash', return_value='e' * 64):
            self.assertEqual(AUTO.publish_after_terminal(worker, f.f.state, f.f.point, terminal, launcher=launch), {'state': 'verified'})
            self.assertEqual(AUTO.publish_after_terminal(worker, f.f.state, f.f.point, terminal, launcher=launch), {'state': 'already-requested'})
        self.assertEqual(len(calls), 1)
        self.assertEqual(reader.status(f.f.point, request)['state'], 'verified')
        self.assertEqual(f.f.subject.prepare(f.f.point)['state'], 'verified-awaiting-continuation')
        f.f.assert_held()


if __name__ == '__main__':
    unittest.main()
