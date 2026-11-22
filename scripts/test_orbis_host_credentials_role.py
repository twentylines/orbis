import contextlib
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


S = load('orbis-host-service.py', 'credentials_role_service')
SETUP = load('orbis-host-service-setup.py', 'credentials_role_setup')
ENABLE = load('orbis-host-service-enable.py', 'credentials_role_enable')
UPGRADE = load('orbis-host-service-upgrade.py', 'credentials_role_upgrade')
GUIDE = load('orbis-install.py', 'credentials_role_guide')


class CredentialRoleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='orbis-role-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.root, self.state, self.snapshots = [self.base / name for name in ('server', 'state', 'snapshots')]
        for path in (self.root, self.state, self.snapshots): path.mkdir(mode=0o700)

    def test_constructor_and_status_never_reconcile_interrupted_administration(self):
        job = self.state / 'job.json'
        for state in ('running', 'recovering', 'interrupted'):
            with self.subTest(state=state):
                S.write_private(job, {'id': 'fixture', 'state': state, 'snapshot': 'must-not-be-read'})
                original = job.read_bytes()
                service = S.HostService(self.root, 'local', self.snapshots, self.state, credentials_only=True)
                saved = {'tag': 'v1.0.0', 'digest': 'sha256:' + 'a' * 64}
                core = {'state': 'running', 'health': 'healthy', 'image': S.PLAN.IMAGE + '@' + saved['digest']}
                with mock.patch.object(S.HOST, 'saved_state', return_value=saved), \
                        mock.patch.object(S.HOST, 'current_core', return_value=core), \
                        mock.patch.object(service, 'state_matches', return_value=True), \
                        mock.patch.object(service, 'complete_channel_change', side_effect=AssertionError('No channel changes')), \
                        mock.patch.object(S.UPDATE, 'safe_download', side_effect=AssertionError('No update journal')):
                    status = service.status()
                self.assertEqual(status['serviceRole'], 'credentials-only')
                self.assertEqual(status['credentialProtocol'], 1)
                self.assertEqual(status['capabilities'], [])
                self.assertEqual(status['job']['state'], state)
                self.assertEqual(job.read_bytes(), original)

    def test_credential_idle_check_never_runs_administrative_reconciliation(self):
        service = S.HostService(self.root, 'local', self.snapshots, self.state, credentials_only=True)
        with mock.patch.object(service, 'restart_status', side_effect=AssertionError('No reboot reconciliation')), \
                mock.patch.object(service, 'core_overlays', side_effect=AssertionError('No overlay directories')), \
                mock.patch.object(service, 'require_package_clear', side_effect=AssertionError('No package retries')):
            service.require_credential_role_idle()
            identifier = '550e8400-e29b-41d4-a716-446655440010'
            cases = [(service.restart_job_file, 'orbis.restart-job.v1', 'restarting'),
                     (service.package_job_file, 'orbis.package-job.v1', 'failed'),
                     (service.job_file, 'orbis.host-service-job.v1', 'interrupted')]
            for file, schema, pending in cases:
                S.write_private(file, {'schema': schema, 'id': identifier, 'state': pending})
                before = file.read_bytes()
                with self.assertRaises(ValueError): service.require_credential_role_idle()
                self.assertEqual(file.read_bytes(), before)
                S.write_private(file, {'schema': schema, 'id': identifier, 'state': 'complete'})
                service.require_credential_role_idle()
                file.unlink()
            S.write_private(service.job_file, {'schema': 'orbis.host-service-job.v1', 'id': identifier,
                                               'state': 'complete', 'overlayId': identifier})
            with self.assertRaises(ValueError): service.require_credential_role_idle()
            self.assertFalse((self.state / 'core-overlays').exists())

    def test_actual_narrow_idle_gate_requires_live_shared_guard_and_preserves_its_hold(self):
        host = S.HOST
        service = S.HostService(self.root, 'local', self.snapshots, self.state, credentials_only=True)
        with mock.patch.object(host.CREDENTIAL_FENCE, 'OWNER', os.geteuid()), \
                mock.patch.object(host.AUTHORITY, 'OWNER', os.geteuid()), \
                mock.patch.object(host.AUTHORITY.LAYOUT, 'STATE_ROOT', self.state), \
                mock.patch.object(host.AUTHORITY.LAYOUT, '_operator'), \
                mock.patch.object(service, '_require_restart_job_clear', side_effect=AssertionError('No reboot reconciliation')), \
                mock.patch.object(service, '_require_idle_core_jobs', side_effect=AssertionError('No admin overlay reconciliation')):
            with host.credential_fence_lock(self.root, 'local') as guard:
                guard.begin('a' * 64, 'b' * 64)
                service.require_credential_idle(guard)
                with self.assertRaises(ValueError): service.require_credential_idle(SimpleNamespace())
                service.maintenance_file.write_text('{}')
                with self.assertRaises(ValueError): service.require_credential_idle(guard)
                self.assertIsNotNone(guard.read())
            with self.assertRaises(ValueError): service.require_credential_idle(guard)

    def test_narrow_startup_and_shutdown_do_not_run_any_administrative_supervisor(self):
        endpoint = self.base / 's'
        connection = socket.socket(socket.AF_UNIX)
        self.addCleanup(connection.close)
        server = mock.Mock()
        server.serve_forever.side_effect = KeyboardInterrupt
        server.server_close.side_effect = connection.close
        def construct(path, handler):
            self.assertIs(handler, S.CredentialHandler)
            connection.bind(path)
            return server
        service = SimpleNamespace(credentials_only=True, discovery=mock.Mock(),
                                  resume_pending_retained_restore=mock.Mock(), credential_service=None)
        with mock.patch.object(S, 'UnixHTTPServer', side_effect=construct), \
                mock.patch.object(S, 'load_script', side_effect=AssertionError('No administrative runtime')):
            S.serve(endpoint, service)
        service.resume_pending_retained_restore.assert_not_called()
        service.discovery.disable.assert_not_called()
        self.assertFalse(endpoint.exists())

    def test_cli_role_ignores_observer_activation_and_constructs_narrow_service(self):
        args = ['service', '--root', str(self.root), '--docker-context', 'local', '--socket', str(self.base / 's'),
                '--snapshots', str(self.snapshots), '--state-dir', str(self.state), '--credentials-only']
        with mock.patch.object(sys, 'argv', args), mock.patch.dict(os.environ, {'LISTEN_PID': str(os.getpid())}), \
                mock.patch.object(S, 'HostService') as factory, mock.patch.object(S, 'serve') as serve, \
                mock.patch.object(S, 'load_script', side_effect=AssertionError('No observer')):
            self.assertEqual(S.main(), 0)
        self.assertIs(factory.call_args.kwargs['credentials_only'], True)
        serve.assert_called_once()

    def test_live_narrow_http_rejects_admin_handoff_and_unknown_routes(self):
        endpoint = self.base / 's'
        service = SimpleNamespace(credentials_only=True, credential_status=mock.Mock(return_value={'serviceRole': 'credentials-only', 'capabilities': []}),
                                  credential_request=mock.Mock(return_value={'fixture': True}),
                                  status=mock.Mock(side_effect=AssertionError('No full status')))
        # Even a caller selecting the older handler cannot bypass the role.
        server = S.UnixHTTPServer(str(endpoint), S.Handler); server.service = service
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        def request(method, path, data=None):
            body = json.dumps(data).encode() if data is not None else b''
            headers = [('Host', 'orbis')]
            if body: headers += [('Content-Type', 'application/json'), ('Content-Length', str(len(body)))]
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(2); client.connect(str(endpoint))
                client.sendall(f'{method} {path} HTTP/1.0\r\n'.encode() + b''.join(f'{k}: {v}\r\n'.encode() for k, v in headers) + b'\r\n' + body)
                response = http.client.HTTPResponse(client); response.begin()
                return response.status, json.loads(response.read())
        self.assertEqual(request('GET', '/v1/status')[0], 200)
        self.assertEqual(request('GET', '/v1/credentials/change-admission'), (200, {'fixture': True}))
        self.assertEqual(request('POST', '/v1/credentials/ownership-prepare', {})[0], 200)
        calls = service.credential_request.call_count
        for method, path in [('POST', '/v1/apply'), ('POST', '/v1/recover'), ('POST', '/v1/packages/apply'),
                             ('POST', '/v1/restart/apply'), ('POST', '/v1/sentinel/controller-handoff/apply'),
                             ('GET', '/v1/sentinel/update-progress'), ('GET', '/v1/drives'), ('GET', '/v1/processes'),
                             ('POST', '/v1/credentials/../apply'), ('GET', '/v1/status?mutate=1')]:
            with self.subTest(path=path): self.assertEqual(request(method, path, {} if method == 'POST' else None)[0], 404)
        self.assertEqual(service.credential_request.call_count, calls)
        service.status.assert_not_called()

    def test_role_environment_is_exact_and_cannot_smuggle_additional_flags(self):
        for selected in (False, True):
            body = SETUP.service_environment(self.root, 'local', credentials_only=selected)
            self.assertIs(SETUP.environment_role(body, self.root, 'local'), selected)
            for bad in (body + b'EXTRA=1\n', body.replace(b'local', b'other')):
                with self.assertRaises(ValueError): SETUP.environment_role(bad, self.root, 'local')
        body = SETUP.service_environment(self.root, 'local', credentials_only=True)
        with self.assertRaises(ValueError): SETUP.environment_role(body.replace(b'--credentials-only', b'--credentials-only --socket /other'), self.root, 'local')
        for value in ('true', 1, None):
            with self.assertRaises(ValueError): SETUP.service_environment(self.root, 'local', credentials_only=value)

    def test_actual_copy_receipt_binds_the_installed_role_environment(self):
        installed = self.base / 'installed'; installed.mkdir(mode=0o700)
        code = installed / 'orbis-host-service.py'; code.write_bytes(b'# fixture copy'); code.chmod(0o600)
        config = self.base / 'config'; config.mkdir(mode=0o700)
        environment, unit = config / 'host.env', self.base / 'orbis-host.service'
        unit.write_bytes(b'[Service]\n'); unit.chmod(0o644)
        hashes = []
        with mock.patch.multiple(SETUP, INSTALL_DIR=installed, ENV_FILE=environment, UNIT_FILE=unit), \
                mock.patch.object(SETUP.HOST.AUTHORITY, 'OWNER', os.geteuid()):
            expected = SETUP.actual_copy(installed, unit)
            for role in (False, True):
                body = SETUP.service_environment(self.root, 'local', credentials_only=role)
                environment.write_bytes(body); environment.chmod(0o600)
                with contextlib.ExitStack() as pins:
                    receipt = json.loads(SETUP._source_copy_receipt(pins, self.root, 'local', {'inventory': {}}, expected))
                captured = receipt['installed']['environmentSha256']
                self.assertEqual(captured, hashlib.sha256(body).hexdigest()); hashes.append(captured)
            self.assertNotEqual(*hashes)
            environment.write_bytes(SETUP.service_environment(self.root, 'other', credentials_only=True))
            with contextlib.ExitStack() as pins, self.assertRaises(ValueError):
                SETUP._source_copy_receipt(pins, self.root, 'local', {'inventory': {}}, expected)

    def test_candidate_unit_must_preserve_role_expansion(self):
        unit = (Path(__file__).parents[1] / 'packaging/systemd/orbis-host.service').read_text()
        UPGRADE.validate_unit(unit, credentials_only=True)
        with self.assertRaises(ValueError): UPGRADE.validate_unit(unit.replace(' $ORBIS_CREDENTIAL_FLAGS', ''), credentials_only=True)
        for extra in ('\n  ExecStart=\n', '\n EnvironmentFile=/other\n'):
            with self.assertRaises(ValueError): UPGRADE.validate_unit(unit + extra, credentials_only=True)
        UPGRADE.validate_unit(unit.replace(' $ORBIS_CREDENTIAL_FLAGS', ''))

    def test_narrow_role_checks_unit_before_copying_any_source(self):
        source = self.base / 'source'; source.mkdir(mode=0o700)
        code, unit = source / 'orbis-host-service.py', self.base / 'source.service'
        code.write_bytes(b'# fixture'); unit.write_bytes(b'[Service]\nExecStart=/usr/bin/true\n')
        with mock.patch.object(SETUP, 'source_files', return_value=([code], unit)), \
                mock.patch.object(SETUP, '_stage_source_snapshot') as stage:
            with self.assertRaisesRegex(ValueError, 'cannot preserve'):
                SETUP._stage_service_files(self.root, 'local', source, credentials_only=True)
        stage.assert_not_called()

    def test_narrow_environment_is_retained_on_resume_and_cannot_broaden_to_default(self):
        source = self.base / 'source'; source.mkdir(mode=0o700)
        code, unit = source / 'orbis-host-service.py', self.base / 'source.service'
        code.write_bytes(b'# fixture')
        unit.write_bytes((Path(__file__).parents[1] / 'packaging/systemd/orbis-host.service').read_bytes())
        install, environment, installed_unit = self.base / 'opt/helper', self.base / 'etc/host.env', self.base / 'systemd/orbis-host.service'
        original_stat, original_lstat = Path.stat, Path.lstat
        def owned(method, path, *args, **kwargs):
            values = list(method(path, *args, **kwargs)); values[4] = 0; values[5] = 0
            return os.stat_result(values)
        with mock.patch.multiple(SETUP, INSTALL_DIR=install, ENV_FILE=environment, UNIT_FILE=installed_unit), \
                mock.patch.object(SETUP, 'source_files', return_value=([code], unit)), \
                mock.patch.object(SETUP.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)), \
                mock.patch.object(Path, 'stat', autospec=True, side_effect=lambda p, *a, **k: owned(original_stat, p, *a, **k)), \
                mock.patch.object(Path, 'lstat', autospec=True, side_effect=lambda p, *a, **k: owned(original_lstat, p, *a, **k)):
            SETUP._stage_service_files(self.root, 'local', source, credentials_only=True)
            original = environment.read_bytes()
            self.assertTrue(SETUP.environment_role(original, self.root, 'local'))
            SETUP._stage_service_files(self.root, 'local', source, resume=True, credentials_only=True)
            with self.assertRaisesRegex(ValueError, 'configuration changed'):
                SETUP._stage_service_files(self.root, 'local', source, resume=True)
            self.assertEqual(environment.read_bytes(), original)

    def test_authenticated_listener_requires_narrow_process_command_and_exact_protocol(self):
        endpoint = SimpleNamespace(st_mode=stat.S_IFSOCK | 0o600, st_uid=0)
        parent = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)
        good = {'serviceRole': 'credentials-only', 'credentialProtocol': 1, 'capabilities': []}
        for patch in ({}, {'serviceRole': 'administration'}, {'credentialProtocol': True}, {'capabilities': ['restart.v1']}):
            with self.subTest(patch=patch), mock.patch.object(Path, 'lstat', side_effect=[endpoint, parent]), \
                    mock.patch.object(SETUP, '_systemd_main_pid', return_value=42) as pid, \
                    mock.patch.object(SETUP, 'read_socket_status', return_value=good | patch):
                if patch:
                    with self.assertRaises(ValueError): SETUP.authenticated_socket_status(self.root, 'local', credentials_only=True)
                else:
                    self.assertEqual(SETUP.authenticated_socket_status(self.root, 'local', credentials_only=True), good)
                self.assertTrue(all(call.kwargs == {'credentials_only': True} for call in pid.call_args_list))

    def test_existing_root_selected_role_is_preserved_when_an_installer_has_a_different_default(self):
        for previous, requested in ((False, True), (True, False)):
            with self.subTest(previous=previous), mock.patch.object(ENABLE, '_require_host'), \
                    mock.patch.object(ENABLE, 'available', return_value=True), \
                    mock.patch.object(ENABLE.HOST, 'host_lock', return_value=contextlib.nullcontext()), \
                    mock.patch.object(ENABLE.SETUP, 'installed_credentials_only', return_value=previous), \
                    mock.patch.object(ENABLE, 'existing_owner', return_value=True), \
                    mock.patch.object(ENABLE, 'healthy_existing', return_value=True) as healthy, \
                    mock.patch.object(ENABLE, 'journal_path', return_value=self.base / 'not-present'), \
                    mock.patch.object(ENABLE.SETUP, '_stage_service_files') as stage:
                result = ENABLE.enable(self.root, 'local', self.base, credentials_only=requested)
                self.assertEqual(result['result'], 'account-security-active' if previous else 'host-service-active')
                self.assertEqual(healthy.call_args.kwargs, {'credentials_only': True} if previous else {})
                stage.assert_not_called()

    def test_without_administration_update_upgrades_security_and_uses_only_local_core_updater(self):
        current = {'tag': 'v1.0.0', 'digest': 'sha256:' + 'a' * 64}
        target = {'tag': 'v1.0.1', 'digest': 'sha256:' + 'b' * 64, 'installationProtocol': GUIDE.HOST.PLAN.INSTALLATION_PROTOCOL}
        for protocol, without in ((1, True), (1, False), (None, True), (True, True)):
            setup = SimpleNamespace(SOCKET_FILE=self.base / 's', installed_credentials_only=mock.Mock(return_value=True),
                                    authenticated_socket_status=mock.Mock(return_value={'credentialProtocol': protocol}))
            upgrade = SimpleNamespace(SERVICE=SimpleNamespace(installed_manifest=lambda *_: current,
                read_channel=lambda *_: {'channel': 'stable', 'revision': 'initial'}), SETUP=setup, upgrade=mock.Mock())
            enable = SimpleNamespace(enable=mock.Mock())
            modules = {'orbis-host-service-upgrade.py': upgrade, 'orbis-host-service-enable.py': enable,
                       'install-orbis.py': SimpleNamespace(private_directory=lambda _: self.snapshots)}
            display = SimpleNamespace(set_remaining_steps=mock.Mock(), step=lambda *_: contextlib.nullcontext())
            with self.subTest(protocol=protocol, without=without), mock.patch.object(GUIDE, 'load', side_effect=lambda name, _: modules[name]), \
                    mock.patch.object(GUIDE.REPLACE.UPDATE, 'verify_release'), \
                    mock.patch.object(GUIDE, 'prepare_sentinel'), mock.patch.object(GUIDE, 'activate_sentinel'), \
                    mock.patch.object(GUIDE.REPLACE.UPDATE, 'apply_update', return_value={'result': 'updated'}) as apply, \
                    mock.patch.object(GUIDE, 'host_request', side_effect=AssertionError('No administrative RPC')):
                if type(protocol) is int:
                    self.assertEqual(GUIDE.update_existing(self.root, SimpleNamespace(context='local'), target, display,
                                                          without_host_service=without), {'result': 'updated'})
                    apply.assert_called_once()
                else:
                    with self.assertRaises(GUIDE.HostServiceCompatibilityError):
                        GUIDE.update_existing(self.root, SimpleNamespace(context='local'), target, display, without_host_service=True)
                    apply.assert_not_called()
                self.assertEqual(enable.enable.call_args.kwargs.get('credentials_only', False), without)
                upgrade.upgrade.assert_called_once()
                self.assertEqual(setup.authenticated_socket_status.call_args.kwargs, {'credentials_only': True})

    def test_maintenance_detects_role_environment_change_before_any_recovery_action(self):
        environment = self.base / 'host.env'; environment.write_bytes(b'original role'); environment.chmod(0o600)
        record = {'environmentSha256': hashlib.sha256(environment.read_bytes()).hexdigest()}
        with mock.patch.object(UPGRADE.SETUP, 'ENV_FILE', environment), mock.patch.object(UPGRADE.SERVICE, 'read_private', return_value=record), \
                mock.patch.object(UPGRADE, 'require_root_owned'), mock.patch.object(UPGRADE.HOST, 'retained_state', return_value=None):
            UPGRADE.require_maintenance_identity(self.root, 'local')
            environment.write_bytes(b'broader role')
            with self.assertRaises(ValueError): UPGRADE.require_maintenance_identity(self.root, 'local')


if __name__ == '__main__':
    unittest.main()
