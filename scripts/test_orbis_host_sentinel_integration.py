import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location('host_for_sentinel_integration', Path(__file__).with_name('orbis-host-service.py'))
SERVICE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVICE)
OBSERVER = SERVICE.load_script('orbis-host-sentinel-observer.py', 'observer_for_activation_tests')


class ActivationTests(unittest.TestCase):
    def test_missing_or_foreign_activation_is_optional(self):
        for environment in ({}, {'LISTEN_PID': '0', 'LISTEN_FDS': '1', 'LISTEN_FDNAMES': 'orbis-observer-v1'}):
            with mock.patch.dict(os.environ, environment, clear=True):
                self.assertIsNone(OBSERVER.activated_observer(lambda: None))

    def test_wrong_descriptor_count_or_name_is_refused_before_fd_access(self):
        for count, name in (('2', 'orbis-observer-v1'), ('1', 'api'), ('0', 'orbis-observer-v1')):
            with mock.patch.dict(os.environ, {'LISTEN_PID': str(os.getpid()), 'LISTEN_FDS': count, 'LISTEN_FDNAMES': name}, clear=True):
                with self.assertRaises(ValueError): OBSERVER.activated_observer(lambda: None)

    def test_existing_startup_does_not_require_an_observer(self):
        arguments = ['host', '--root', '/installation', '--docker-context', 'local', '--socket', '/run/orbis/host.sock',
                     '--snapshots', '/snapshots', '--state-dir', '/state']
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(sys, 'argv', arguments), \
                mock.patch.object(SERVICE, 'HostService') as constructor, mock.patch.object(SERVICE, 'serve') as serve, \
                mock.patch.object(SERVICE, 'load_script', side_effect=AssertionError('No new helper required')):
            self.assertEqual(SERVICE.main(), 0)
            serve.assert_called_once_with(Path('/run/orbis/host.sock'), constructor.return_value)

    def test_capability_is_private_and_does_not_touch_operation_state(self):
        for allowed in (False, True):
            handler = object.__new__(SERVICE.Handler)
            handler.path = '/v1/sentinel-observer/capability'
            handler.connection = mock.Mock()
            handler.server = mock.Mock()
            handler.send_json = mock.Mock()
            with mock.patch.object(SERVICE, 'trusted_capture_peer', return_value=allowed):
                handler.do_GET()
            self.assertEqual(handler.send_json.call_args.args[0], 200 if allowed else 403)
            self.assertEqual(handler.server.mock_calls, [])

    def test_bad_optional_activation_is_refused_before_reconciling_existing_jobs(self):
        arguments = ['host', '--root', '/installation', '--docker-context', 'local', '--socket', '/run/orbis/host.sock',
                     '--snapshots', '/snapshots', '--state-dir', '/state']
        module = mock.Mock()
        module.activated_observer.side_effect = ValueError('Observer activation is unavailable')
        with mock.patch.dict(os.environ, {'LISTEN_PID': str(os.getpid())}, clear=True), \
                mock.patch.object(sys, 'argv', arguments), mock.patch.object(SERVICE, 'HostService') as constructor, \
                mock.patch.object(SERVICE, 'load_script', return_value=module), mock.patch.object(sys, 'stderr'):
            self.assertEqual(SERVICE.main(), 2)
            constructor.assert_not_called()


@unittest.skipUnless(sys.platform.startswith('linux') and os.geteuid() == 0, 'requires real Linux root file authority')
class ProtectedProgressTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.service = object.__new__(SERVICE.HostService)
        self.service.job_file = self.root / 'job.json'
        self.service.core_operation_maintenance = mock.Mock(side_effect=AssertionError('No maintenance mutation'))
        self.service.core_overlays = mock.Mock(side_effect=AssertionError('No overlay mutation'))

    def write(self, value):
        self.service.job_file.write_text(json.dumps(value))
        self.service.job_file.chmod(0o600)

    def test_job_is_pinned_and_observation_never_invokes_cleanup(self):
        self.write({'state': 'running'})
        self.service.core_operation_progress = mock.Mock(return_value={'version': 1, 'job': None})
        self.assertEqual(self.service.sentinel_observer_progress(), {'version': 1, 'job': None})
        self.service.core_operation_progress.assert_called_once_with()
        self.service.core_operation_maintenance.assert_not_called()
        self.service.core_overlays.assert_not_called()

    def test_replaced_or_rewritten_job_is_not_published(self):
        for replace in (True, False):
            self.write({'state': 'running'})
            def change():
                if replace: self.service.job_file.unlink()
                self.write({'state': 'complete'})
                return {'version': 1, 'job': None}
            self.service.core_operation_progress = change
            with self.assertRaises(ValueError): self.service.sentinel_observer_progress()

    def test_absence_is_not_published_if_an_operation_appears_during_observation(self):
        def change():
            self.write({'state': 'running'})
            return {'version': 1, 'job': None}
        self.service.core_operation_progress = change
        with self.assertRaises(ValueError): self.service.sentinel_observer_progress()


if __name__ == '__main__':
    unittest.main()
