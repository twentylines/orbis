import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


def load(name):
    spec = importlib.util.spec_from_file_location('sentinel_flow_' + name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GUIDE = load('orbis-install')
BUILD = load('orbis-installer-bundle')
SETUP = load('orbis-host-service-setup')
MANIFEST = {'schema': 'orbis.release.v1', 'image': 'ghcr.io/twentylines/orbis', 'tag': 'v1.0.1',
            'commit': 'a' * 40, 'digest': 'sha256:' + 'b' * 64, 'runtipiCompatibility': '4.10.1',
            'installationProtocol': 'orbis.installation-state.v1'}


class SentinelFlowTests(unittest.TestCase):
    def fresh(self, *, fail=None, cancel=False, without_host_service=False):
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder).resolve()
            state = parent / 'state'; state.mkdir(mode=0o700)
            root = parent / 'server'
            manifest = parent / 'manifest.json'; manifest.write_text(json.dumps(MANIFEST))
            events = []
            def event(name, result=None):
                def action(*_args, **_kwargs):
                    events.append(name)
                    if name == fail:
                        raise ValueError('Controlled ' + name + ' failure')
                    return result
                return action
            def install(_root, _reader, _manifest, _state, _args, confirm, **_kwargs):
                confirm(root)
                events.append('write-controller')
                return {'result': 'orbis-installed'}
            new = SimpleNamespace(IMAGES={}, choose_ports=lambda *_: (80, 443), install=install)
            enable = SimpleNamespace(available=event('helper-preflight'), require_scoped_cleanup=event('image-scope'),
                enable=lambda *_args, **kwargs: event('enable-credentials' if kwargs.get('credentials_only') else 'enable-helper')())
            private = SimpleNamespace(private_directory=lambda _: state)
            modules = {'orbis-install-new.py': new, 'orbis-host-service-enable.py': enable, 'install-orbis.py': private}
            terminal = mock.Mock()
            terminal.ask.side_effect = event('confirm-user', 'cancel' if cancel else str(root))
            argv = ['installer', '--manifest', str(manifest), '--state-dir', str(state), '--root', str(root)]
            if without_host_service:
                argv.append('--without-host-service')
            with contextlib.ExitStack() as stack:
                patches = [
                    (sys, 'argv', argv), (GUIDE.BOOT, 'require_supported_host', lambda: None),
                    (GUIDE.SENTINEL, 'require_host', event('host-preflight')),
                    (GUIDE, 'require_docker_prerequisites', event('docker-preflight')),
                    (GUIDE.APPS, 'Docker', mock.Mock()),
                    (GUIDE.APPS.DETECT, 'discover', lambda *_args, **_kwargs: {'installations': [], 'unassignedManagedContainers': []}),
                    (GUIDE.REPLACE.UPDATE, 'verify_release', event('verify-controller')),
                    (GUIDE, 'load', lambda name, _: modules[name]), (GUIDE, 'Terminal', lambda: terminal),
                    (GUIDE.BOOT, 'private_directory', lambda _: state),
                    (GUIDE.SENTINEL, 'prepare', event('prepare-sentinel', object())),
                    (GUIDE.SENTINEL, 'activate', event('activate-sentinel', {'activated': True})),
                    (GUIDE, 'prepare_backup_tools', event('backup-tools')),
                    (GUIDE.shutil, 'which', lambda _: '/usr/bin/rsync'),
                    (GUIDE.subprocess, 'run', event('pull-controller', subprocess.CompletedProcess([], 0))),
                    (GUIDE.UI, 'Presentation', lambda **_: SimpleNamespace(banner=lambda *_: None,
                        set_remaining_steps=lambda *_: None, step=lambda *_args, **_kwargs: contextlib.nullcontext())),
                    (GUIDE.CHANNELS, 'read_channel', lambda *_: {'channel': 'stable', 'revision': 'owned'}),
                    (GUIDE, 'show_browser_address', lambda *_: None),
                ]
                for target, name, value in patches:
                    stack.enter_context(mock.patch.object(target, name, value))
                stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                if fail or cancel:
                    with self.assertRaises(ValueError):
                        GUIDE.main()
                else:
                    self.assertEqual(GUIDE.main(), 0)
            self.assertFalse(root.exists(), 'The controlled flow must not write a real controller')
            terminal.close.assert_called_once()
            return events

    def test_fresh_flow_prepares_before_confirmation_and_activates_before_controller_data(self):
        events = self.fresh()
        self.assertLess(events.index('host-preflight'), events.index('docker-preflight'))
        self.assertLess(events.index('prepare-sentinel'), events.index('confirm-user'))
        self.assertLess(events.index('confirm-user'), events.index('activate-sentinel'))
        self.assertLess(events.index('activate-sentinel'), events.index('write-controller'))
        self.assertLess(events.index('write-controller'), events.index('enable-helper'))
        self.assertEqual(events.count('activate-sentinel'), 1)

    def test_cancellation_never_activates_or_changes_controller_data(self):
        events = self.fresh(cancel=True)
        self.assertIn('prepare-sentinel', events)
        self.assertNotIn('activate-sentinel', events)
        self.assertNotIn('write-controller', events)

    def test_failed_signature_preparation_stops_before_confirmation_or_controller_changes(self):
        events = self.fresh(fail='prepare-sentinel')
        self.assertNotIn('confirm-user', events)
        self.assertNotIn('activate-sentinel', events)
        self.assertNotIn('write-controller', events)

    def test_failed_activation_stops_before_controller_changes_and_helper_enablement(self):
        events = self.fresh(fail='activate-sentinel')
        self.assertIn('confirm-user', events)
        self.assertNotIn('write-controller', events)
        self.assertNotIn('enable-helper', events)

    def test_optional_host_administration_does_not_remove_independent_sentinel(self):
        events = self.fresh(without_host_service=True)
        self.assertIn('activate-sentinel', events)
        self.assertNotIn('enable-helper', events)
        self.assertIn('enable-credentials', events)
        self.assertLess(events.index('activate-sentinel'), events.index('enable-credentials'))

    def test_both_installer_contracts_and_installed_host_helper_retain_the_adapter(self):
        name = 'scripts/orbis-sentinel-install.py'
        self.assertIn(name, BUILD.REQUIRED)
        self.assertIn(name, GUIDE.BOOT.REQUIRED)
        self.assertIn('orbis-sentinel-install.py', SETUP.SCRIPTS)

    def test_existing_controller_checks_sentinel_before_any_core_update(self):
        events = []
        upgrade = SimpleNamespace(SERVICE=SimpleNamespace(installed_manifest=lambda *_: MANIFEST,
            read_channel=lambda *_: {'channel': 'stable', 'revision': 'owned'}),
            SETUP=SimpleNamespace(SOCKET_FILE=Path('/unused/host.sock'), installed_credentials_only=lambda *_: False), upgrade=lambda *_: events.append('upgrade-helper'))
        enable = SimpleNamespace(enable=lambda *_: events.append('enable-helper'))
        with mock.patch.object(GUIDE, 'load', side_effect=lambda name, _: upgrade if name == 'orbis-host-service-upgrade.py' else enable), \
                mock.patch.object(GUIDE.REPLACE.UPDATE, 'verify_release'), mock.patch.object(GUIDE, 'prepare_backup_tools'), \
                mock.patch.object(GUIDE, 'prepare_sentinel', side_effect=lambda *_: events.append('prepare-sentinel') or object()), \
                mock.patch.object(GUIDE, 'activate_sentinel', side_effect=lambda *_: events.append('activate-sentinel')), \
                mock.patch.object(GUIDE, 'host_request', return_value={'capabilities': ['restart.v1', 'packages.refresh.v1', 'release-channels.v1']}) as request, \
                contextlib.redirect_stdout(io.StringIO()):
            result = GUIDE.update_existing(Path('/unused'), SimpleNamespace(context='default'), MANIFEST,
                SimpleNamespace(set_remaining_steps=lambda *_: None, step=lambda *_: contextlib.nullcontext()))
        self.assertEqual(result['result'], 'up-to-date')
        self.assertEqual(events, ['prepare-sentinel', 'activate-sentinel', 'enable-helper', 'upgrade-helper'])
        request.assert_called_once_with(Path('/unused/host.sock'), '/v1/status')


if __name__ == '__main__':
    unittest.main()
