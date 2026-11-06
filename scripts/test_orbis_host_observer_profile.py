import contextlib
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location('upgrade_for_observer_profile', Path(__file__).with_name('orbis-host-service-upgrade.py'))
UPGRADE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPGRADE)
PROFILE = UPGRADE.PROFILE


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='observer-profile-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.unit = self.base / 'systemd' / 'orbis-host.service'
        self.unit.parent.mkdir(mode=0o755)
        self.drop_in = self.unit.parent / 'orbis-host.service.d' / 'sentinel-observer.conf'
        self.drop_in.parent.mkdir(mode=0o755)
        self.drop_in.write_bytes(PROFILE.DROP_IN)
        self.socket_unit = self.unit.parent / PROFILE.SOCKET
        self.socket_unit.write_bytes(PROFILE.SOCKET_UNIT)
        self.loaded = {
            ('DropInPaths', 'orbis-host.service'): str(self.drop_in),
            ('FragmentPath', PROFILE.SOCKET): str(self.socket_unit),
            ('DropInPaths', PROFILE.SOCKET): '',
            ('TriggeredBy', 'orbis-host.service'): PROFILE.SOCKET,
            ('KillMode', 'orbis-host.service'): 'control-group',
            ('NeedDaemonReload', 'orbis-host.service'): 'no',
            ('NeedDaemonReload', PROFILE.SOCKET): 'no',
        }
        self.authority = SimpleNamespace(
            protected_directory=lambda path, **options: contextlib.nullcontext(Path(path)),
            protected_file=lambda directory, name, *args, **options: contextlib.nullcontext((directory / name).read_bytes()),
        )
        patch = mock.patch.object(PROFILE.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=12345))
        patch.start()
        self.addCleanup(patch.stop)

    def query(self, *args):
        return self.loaded[args[2], args[-1]]

    def configuration(self):
        return PROFILE.configuration(self.unit, self.query, self.authority)

    def supported(self, directory, text=None):
        directory.mkdir(mode=0o700, exist_ok=True)
        (directory / 'orbis-host-service.py').write_text(text or "SENTINEL_OBSERVER_ACTIVATION = 'orbis-observer-v1'\n")
        (directory / 'orbis-host-sentinel-observer.py').write_text('# fixture\n')
        for file in directory.iterdir():
            file.chmod(0o600)

    def test_unconfigured_legacy_installation_does_not_need_any_observer_file(self):
        self.drop_in.unlink()
        self.loaded['DropInPaths', 'orbis-host.service'] = ''
        self.assertIsNone(self.configuration())
        PROFILE.require_support(self.base / 'missing-legacy-directory', None)

    def test_exact_managed_profile_has_a_durable_content_identity(self):
        profile = self.configuration()
        self.assertEqual(profile['schema'], 'orbis.sentinel-observer-profile.v1')
        self.assertEqual(profile['groupId'], 12345)
        self.assertEqual(set(profile['files']), {str(self.drop_in), str(self.socket_unit)})

    def test_unknown_shadowed_unloaded_or_stale_configuration_is_refused(self):
        for key, value in (
            (('DropInPaths', 'orbis-host.service'), ''),
            (('DropInPaths', 'orbis-host.service'), str(self.drop_in) + ' /etc/extra.conf'),
            (('FragmentPath', PROFILE.SOCKET), '/usr/lib/systemd/system/' + PROFILE.SOCKET),
            (('DropInPaths', PROFILE.SOCKET), '/etc/socket-override.conf'),
            (('TriggeredBy', 'orbis-host.service'), PROFILE.SOCKET + ' other.socket'),
            (('KillMode', 'orbis-host.service'), 'process'),
            (('NeedDaemonReload', 'orbis-host.service'), 'yes'),
            (('NeedDaemonReload', PROFILE.SOCKET), 'yes'),
        ):
            with self.subTest(key=key, value=value), mock.patch.dict(self.loaded, {key: value}):
                with self.assertRaises(ValueError):
                    self.configuration()

    def test_reworded_or_privilege_changing_profile_is_not_implicitly_adopted(self):
        for path in (self.drop_in, self.socket_unit):
            before = path.read_bytes()
            path.write_bytes(before + b'\nExecStart=/bin/false\n')
            with self.assertRaisesRegex(ValueError, 'differs'):
                self.configuration()
            path.write_bytes(before)

    def test_unconfigured_installation_rejects_unloaded_overrides_without_new_observer_requirements(self):
        self.drop_in.unlink()
        self.loaded['DropInPaths', 'orbis-host.service'] = ''
        unknown = self.drop_in.parent / 'unknown.conf'
        unknown.write_text('[Service]\nExecStart=/bin/false\n')
        with self.assertRaisesRegex(ValueError, 'unreviewed'):
            self.configuration()
        unknown.unlink()
        self.loaded['NeedDaemonReload', 'orbis-host.service'] = 'yes'
        with mock.patch.object(self, 'query', wraps=self.query) as query:
            self.assertIsNone(self.configuration())
        self.assertFalse(any('NeedDaemonReload' in call.args for call in query.call_args_list))

    def test_pending_unit_reload_is_allowed_only_for_controlled_recovery(self):
        before = self.configuration()
        self.loaded['NeedDaemonReload', 'orbis-host.service'] = 'yes'
        with self.assertRaisesRegex(ValueError, 'needs review'):
            self.configuration()
        self.assertEqual(PROFILE.configuration(self.unit, self.query, self.authority, loaded=False), before)

    def test_root_or_changed_group_is_not_silently_accepted(self):
        with mock.patch.object(PROFILE.grp, 'getgrnam', side_effect=KeyError('missing')):
            with self.assertRaisesRegex(ValueError, 'group is unavailable'):
                self.configuration()
        for value in (0, -1, True, 2**31):
            with mock.patch.object(PROFILE.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=value)):
                with self.assertRaises(ValueError):
                    self.configuration()
        previous = self.configuration()
        with mock.patch.object(UPGRADE.SETUP, 'UNIT_FILE', self.unit), \
                mock.patch.object(UPGRADE, 'systemctl_output', side_effect=self.query), \
                mock.patch.object(UPGRADE.HOST, 'AUTHORITY', self.authority), \
                mock.patch.object(PROFILE.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=12346)):
            with self.assertRaisesRegex(ValueError, 'changed'):
                UPGRADE.require_profile(previous)

    def test_candidate_declaration_is_literal_unique_and_not_executed(self):
        candidate = self.base / 'candidate'
        profile = self.configuration()
        self.supported(candidate, "SENTINEL_OBSERVER_ACTIVATION = 'orbis-observer-v1'\nraise Exception('do not execute')\n")
        PROFILE.require_support(candidate, profile)
        for text in ("pass\n", "invalid Python!\n", "SENTINEL_OBSERVER_ACTIVATION = 'wrong'\n",
                     "SENTINEL_OBSERVER_ACTIVATION = callback()\n",
                     "SENTINEL_OBSERVER_ACTIVATION = 'orbis-observer-v1'\nSENTINEL_OBSERVER_ACTIVATION += ''\n",
                     "SENTINEL_OBSERVER_ACTIVATION = 'orbis-observer-v1'\nSENTINEL_OBSERVER_ACTIVATION = 'orbis-observer-v1'\n"):
            self.supported(candidate, text)
            with self.assertRaises(ValueError):
                PROFILE.require_support(candidate, profile)
        self.supported(candidate)
        observer = candidate / 'orbis-host-sentinel-observer.py'
        observer.unlink()
        with self.assertRaises(ValueError):
            PROFILE.require_support(candidate, profile)
        observer.symlink_to(candidate / 'orbis-host-service.py')
        with self.assertRaises(ValueError):
            PROFILE.require_support(candidate, profile)

    def test_activation_socket_is_stopped_with_service_before_replacement(self):
        profile = self.configuration()
        for name in (PROFILE.SOCKET, 'orbis-host.service'):
            self.loaded['ActiveState', name] = 'inactive'
            self.loaded['SubState', name] = 'dead'
        with mock.patch.object(UPGRADE, 'systemctl_output', side_effect=self.query), \
                mock.patch.object(UPGRADE.SETUP, 'run_systemctl') as command:
            UPGRADE.stop_service(profile)
            command.assert_called_once_with('stop', PROFILE.SOCKET, 'orbis-host.service')
            self.loaded['ActiveState', PROFILE.SOCKET] = 'active'
            with self.assertRaisesRegex(ValueError, 'not completed'):
                UPGRADE.stop_service(profile)

    def test_profile_maintenance_has_a_separate_recovery_contract(self):
        workspace = self.base / (UPGRADE.WORKSPACE_PREFIX + 'contract')
        workspace.mkdir(mode=0o700)
        root = self.base / 'installation'
        record = {'schema': 'orbis.helper-upgrade.v1', 'root': str(root), 'dockerContext': 'local', 'workspace': str(workspace)}
        with mock.patch.object(UPGRADE.SETUP, 'INSTALL_DIR', self.base / 'installed'), \
                mock.patch.object(UPGRADE, 'require_root_owned'):
            self.assertEqual(UPGRADE.workspace_from_record(record, root, 'local'), workspace)
            record['observerProfile'] = self.configuration()
            with self.assertRaises(ValueError):
                UPGRADE.workspace_from_record(record, root, 'local')
            record['schema'] = 'orbis.helper-upgrade.v2'
            self.assertEqual(UPGRADE.workspace_from_record(record, root, 'local'), workspace)
            record['observerProfile'] = None
            with self.assertRaises(ValueError):
                UPGRADE.workspace_from_record(record, root, 'local')


@unittest.skipUnless(sys.platform.startswith('linux') and os.geteuid() == 0, 'requires Linux root file authority')
class ProtectedLifecycleTests(ProfileTests):
    def setUp(self):
        super().setUp()
        self.authority = UPGRADE.HOST.AUTHORITY
        self.drop_in.chmod(0o644)
        self.socket_unit.chmod(0o644)

    def test_writable_foreign_symlink_and_hardlinked_configuration_are_refused(self):
        before = self.drop_in.read_bytes()
        for mode in (0o666, 0o664):
            self.drop_in.chmod(mode)
            with self.assertRaises(ValueError):
                self.configuration()
        self.drop_in.chmod(0o644)
        os.chown(self.drop_in, 65534, 65534)
        with self.assertRaises(ValueError):
            self.configuration()
        os.chown(self.drop_in, 0, 0)
        other = self.base / 'other.conf'
        other.write_bytes(before)
        self.drop_in.unlink()
        self.drop_in.symlink_to(other)
        with self.assertRaises((OSError, ValueError)):
            self.configuration()
        self.drop_in.unlink()
        os.link(other, self.drop_in)
        with self.assertRaises(ValueError):
            self.configuration()

    def test_replaced_file_is_detected_before_snapshot_returns(self):
        query = self.query
        def replace(*args):
            if args[2] == 'TriggeredBy':
                content = self.drop_in.read_bytes()
                self.drop_in.unlink()
                self.drop_in.write_bytes(content)
            return query(*args)
        with mock.patch.object(self, 'query', side_effect=replace):
            with self.assertRaises(ValueError):
                self.configuration()

    @contextlib.contextmanager
    def lifecycle(self):
        root = self.base / 'installation'
        root.mkdir(mode=0o700)
        parent = self.base / 'opt'
        parent.mkdir(mode=0o700)
        installed = parent / 'host-service'
        self.supported(installed)
        (installed / 'generation').write_text('old')
        source = self.base / 'source'
        self.supported(source)
        (source / 'orbis-host-service.py').write_text("SENTINEL_OBSERVER_ACTIVATION = 'orbis-observer-v1'\ngeneration = 'new'\n")
        source_unit = self.base / 'candidate.service'
        original = (Path(__file__).parent.parent / 'packaging/systemd/orbis-host.service').read_bytes()
        self.unit.write_bytes(original)
        source_unit.write_bytes(original + b'\n# candidate\n')
        state = self.base / 'state'
        state.mkdir(mode=0o700)
        maintenance = state / 'helper-maintenance.json'
        profile = self.configuration()
        for name in (PROFILE.SOCKET, 'orbis-host.service'):
            self.loaded['ActiveState', name] = 'active'
            self.loaded['SubState', name] = 'listening' if name == PROFILE.SOCKET else 'running'
        def command(*args):
            if args[0] in ('stop', 'start'):
                if args[0] == 'stop':
                    self.assertEqual(args, ('stop', PROFILE.SOCKET, 'orbis-host.service'))
                for name in (PROFILE.SOCKET, 'orbis-host.service'):
                    self.loaded['ActiveState', name] = 'inactive' if args[0] == 'stop' else 'active'
                    self.loaded['SubState', name] = 'dead' if args[0] == 'stop' else 'listening' if name == PROFILE.SOCKET else 'running'
            elif args[0] == 'daemon-reload':
                self.loaded['NeedDaemonReload', 'orbis-host.service'] = 'no'
        ready = {'root': str(root), 'digest': 'sha256:' + 'a' * 64, 'observerProfile': profile,
                 'installedScriptsSha256': 'old', 'candidateScriptsSha256': 'new',
                 'installedUnitSha256': 'old', 'candidateUnitSha256': 'new'}
        files = [source / name for name in ('orbis-host-service.py', 'orbis-host-sentinel-observer.py')]
        with contextlib.ExitStack() as stack:
            for target, name, value in (
                (UPGRADE.SETUP, 'INSTALL_DIR', installed), (UPGRADE.SETUP, 'UNIT_FILE', self.unit),
                (UPGRADE, 'STATE_DIR', state), (UPGRADE, 'MAINTENANCE', maintenance),
                (UPGRADE, 'preflight', mock.Mock(return_value=ready)),
                (UPGRADE, 'job_identity', mock.Mock(return_value=None)),
                (UPGRADE.SETUP, 'source_files', mock.Mock(return_value=(files, source_unit))),
                (UPGRADE.HOST, 'host_lock', mock.Mock(side_effect=lambda *a: contextlib.nullcontext())),
                (UPGRADE.HOST, 'retained_state', mock.Mock(return_value=None)),
                (UPGRADE, 'require_maintenance_identity', mock.Mock()),
                (UPGRADE, 'systemctl_output', mock.Mock(side_effect=self.query)),
                (UPGRADE.SETUP, 'run_systemctl', mock.Mock(side_effect=command)),
                (UPGRADE, 'verify_service', mock.Mock()),
                (UPGRADE.subprocess, 'run', mock.Mock(return_value=SimpleNamespace(returncode=0))),
            ):
                stack.enter_context(mock.patch.object(target, name, value))
            yield SimpleNamespace(root=root, installed=installed, source=source, maintenance=maintenance,
                                  parent=parent, originalUnit=original, profile=profile, command=command)

    def test_upgrade_preserves_profile_and_persists_it_before_stopping(self):
        before = {path: (path.read_bytes(), path.stat().st_ino) for path in (self.drop_in, self.socket_unit)}
        with self.lifecycle() as env:
            def command(*args):
                env.command(*args)
                if args[0] == 'stop':
                    record = UPGRADE.SERVICE.read_private(env.maintenance)
                    self.assertEqual(record['observerProfile'], env.profile)
                    self.assertEqual(record['schema'], 'orbis.helper-upgrade.v2')
            UPGRADE.SETUP.run_systemctl.side_effect = command
            self.assertTrue(UPGRADE.upgrade(env.root, 'local', env.source, str(env.root))['upgraded'])
            self.assertIn('new', (env.installed / 'orbis-host-service.py').read_text())
            self.assertFalse(env.maintenance.exists())
            self.assertEqual(list(env.parent.iterdir()), [env.installed])
        self.assertEqual(before, {path: (path.read_bytes(), path.stat().st_ino) for path in before})

    def test_preflight_requires_candidate_support_only_when_observer_is_enrolled(self):
        preflight = UPGRADE.preflight
        with self.lifecycle() as env:
            (env.source / 'orbis-host-service.py').write_text('legacy = True\n')
            with mock.patch.object(UPGRADE.SETUP, 'preflight', return_value={'digest': 'sha256:' + 'a' * 64}), \
                    mock.patch.object(UPGRADE, 'require_installed', return_value=env.profile):
                with self.assertRaisesRegex(ValueError, 'does not support'):
                    preflight(env.root, 'local', env.source)
            with mock.patch.object(UPGRADE.SETUP, 'preflight', return_value={'digest': 'sha256:' + 'a' * 64}), \
                    mock.patch.object(UPGRADE, 'require_installed', return_value=None):
                self.assertIsNone(preflight(env.root, 'local', env.source)['observerProfile'])
            UPGRADE.SETUP.run_systemctl.assert_not_called()
            self.assertFalse(env.maintenance.exists())

    def test_failed_start_restores_previous_helper_without_changing_profile(self):
        before = {path: path.read_bytes() for path in (self.drop_in, self.socket_unit)}
        with self.lifecycle() as env:
            UPGRADE.verify_service.side_effect = [RuntimeError('startup failed'), None]
            with self.assertRaisesRegex(RuntimeError, 'previous helper was restored'):
                UPGRADE.upgrade(env.root, 'local', env.source, str(env.root))
            self.assertEqual((env.installed / 'generation').read_text(), 'old')
            self.assertEqual(self.unit.read_bytes(), env.originalUnit)
            self.assertFalse(env.maintenance.exists())
        self.assertEqual(before, {path: path.read_bytes() for path in before})

    def test_profile_change_preserves_recovery_record_and_never_stops_service(self):
        with self.lifecycle() as env:
            write = UPGRADE.SERVICE.write_private
            def changed(path, record):
                write(path, record)
                self.drop_in.write_bytes(PROFILE.DROP_IN + b'\n# changed\n')
            with mock.patch.object(UPGRADE.SERVICE, 'write_private', side_effect=changed):
                with self.assertRaisesRegex(RuntimeError, 'preserve the maintenance record'):
                    UPGRADE.upgrade(env.root, 'local', env.source, str(env.root))
            UPGRADE.SETUP.run_systemctl.assert_not_called()
            self.assertTrue(env.maintenance.is_file())
            self.assertEqual((env.installed / 'generation').read_text(), 'old')

    def test_interrupted_replacement_recovers_with_its_durable_profile(self):
        with self.lifecycle() as env:
            workspace = env.parent / (UPGRADE.WORKSPACE_PREFIX + 'interrupted')
            workspace.mkdir(mode=0o700)
            os.replace(env.installed, workspace / 'previous')
            self.supported(env.installed, "SENTINEL_OBSERVER_ACTIVATION = 'orbis-observer-v1'\ngeneration = 'broken'\n")
            (workspace / 'previous-unit').write_bytes(env.originalUnit)
            UPGRADE.SERVICE.write_private(env.maintenance, {
                'schema': 'orbis.helper-upgrade.v2', 'root': str(env.root), 'dockerContext': 'local',
                'workspace': str(workspace), 'previousDigest': 'sha256:' + 'a' * 64,
                'stage': 'replaced', 'observerProfile': env.profile,
            })
            self.loaded['NeedDaemonReload', 'orbis-host.service'] = 'yes'
            def reload(*args):
                env.command(*args)
            UPGRADE.SETUP.run_systemctl.side_effect = reload
            self.assertTrue(UPGRADE.recover(env.root, 'local', str(env.root))['recovered'])
            self.assertEqual((env.installed / 'generation').read_text(), 'old')
            self.assertFalse(env.maintenance.exists())
            self.assertFalse(workspace.exists())

    def test_verified_recovery_keeps_workspace_when_profile_changes_during_health_check(self):
        with self.lifecycle() as env:
            workspace = env.parent / (UPGRADE.WORKSPACE_PREFIX + 'verified')
            workspace.mkdir(mode=0o700)
            UPGRADE.SERVICE.write_private(env.maintenance, {
                'schema': 'orbis.helper-upgrade.v2', 'root': str(env.root), 'dockerContext': 'local',
                'workspace': str(workspace), 'previousDigest': 'sha256:' + 'a' * 64,
                'stage': 'verified', 'observerProfile': env.profile,
            })
            UPGRADE.verify_service.side_effect = lambda *args: self.drop_in.write_bytes(PROFILE.DROP_IN + b'\n# changed\n')
            with self.assertRaises(ValueError):
                UPGRADE.recover(env.root, 'local', str(env.root))
            self.assertTrue(env.maintenance.is_file())
            self.assertTrue(workspace.is_dir())

    def test_interrupted_rollback_resumes_after_previous_scripts_are_already_restored(self):
        with self.lifecycle() as env:
            workspace = env.parent / (UPGRADE.WORKSPACE_PREFIX + 'rollback')
            workspace.mkdir(mode=0o700)
            (workspace / 'previous-unit').write_bytes(env.originalUnit)
            self.unit.write_bytes(env.originalUnit + b'\n# rollback waiting for reload\n')
            self.loaded['NeedDaemonReload', 'orbis-host.service'] = 'yes'
            UPGRADE.SERVICE.write_private(env.maintenance, {
                'schema': 'orbis.helper-upgrade.v2', 'root': str(env.root), 'dockerContext': 'local',
                'workspace': str(workspace), 'previousDigest': 'sha256:' + 'a' * 64,
                'stage': 'replaced', 'observerProfile': env.profile,
            })
            self.assertTrue(UPGRADE.recover(env.root, 'local', str(env.root))['recovered'])
            self.assertEqual((env.installed / 'generation').read_text(), 'old')
            self.assertEqual(self.unit.read_bytes(), env.originalUnit)
            self.assertFalse(env.maintenance.exists())


if __name__ == '__main__':
    unittest.main()
