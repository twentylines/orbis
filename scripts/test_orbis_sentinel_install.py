import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock
import uuid


SPEC = importlib.util.spec_from_file_location('sentinel_installer_tests', Path(__file__).with_name('orbis-sentinel-install.py'))
INSTALL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALL)


def digest(body):
    return hashlib.sha256(body).hexdigest()


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.root.chmod(0o700)
        for name, value in [('OWNER', os.geteuid()), ('require_host', lambda: None)]:
            patch = mock.patch.object(INSTALL, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        self.payloads = {name: ('verified fixture ' + name).encode() for name in INSTALL.TOOLKIT}
        self.toolkit = {name: (len(body), digest(body)) for name, body in self.payloads.items()}
        self.commands = []
        self.downloads = []
        self.binary = b'verifier fixture; never executed'
        self.archive = b'archive fixture; never executed'
        self.spec = {'version': '2.103.3', 'architecture': 'amd64', 'archiveBytes': len(self.archive),
                     'archiveSha256': digest(self.archive), 'binaryBytes': len(self.binary), 'binarySha256': digest(self.binary),
                     'url': 'https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_amd64.tar.gz'}
        self.release = {**INSTALL.RELEASE, 'sha256': digest(b'package fixture')}

    def download(self, work, path, url, maximum, *, size=0, digest=''):
        self.downloads.append((path.name, url, maximum))
        if path.parent.name == 'toolkit':
            body = self.payloads[path.name]
        elif path.name == 'github-cli.tar.gz':
            body = self.archive
        elif path.name.endswith('.sigstore.json'):
            body = b'public signature fixture'
        else:
            body = b'package fixture'
        path.write_bytes(body)
        path.chmod(0o600)
        return INSTALL._file(path, size, digest, maximum=maximum)

    def command(self, work, name, code, arguments, **options):
        self.commands.append((name, code, list(arguments), options))
        if name == 'verifier-spec':
            self.assertEqual(len(list((work / 'toolkit').iterdir())), len(self.toolkit))
            return json.dumps(self.spec).encode()
        if name == 'bootstrap-verifier':
            verifier = Path(arguments[2]) / 'pinned-gh'
            if not verifier.exists():
                verifier.write_bytes(self.binary)
                verifier.chmod(0o555)
            return json.dumps({'verifier': str(verifier)}).encode()
        if name == 'verify-package':
            return json.dumps({**self.release, 'publisherVerified': True, 'activated': False}).encode()
        if name == 'activate-sentinel':
            return json.dumps({**self.release, 'publisherVerified': True, 'activated': True, 'retainedVersionsRemoved': 0}).encode()
        raise AssertionError('Unexpected command')

    def prepare(self, *, downloader=None, command=None):
        with mock.patch.object(INSTALL, 'TOOLKIT', self.toolkit), mock.patch.object(INSTALL, 'RELEASE', self.release), \
                mock.patch.object(INSTALL, '_download', side_effect=downloader or self.download), \
                mock.patch.object(INSTALL, '_run', side_effect=command or self.command):
            return INSTALL.prepare(self.root)

    def activate(self, prepared, *, command=None):
        with mock.patch.object(INSTALL, 'RELEASE', self.release), mock.patch.object(INSTALL, '_run', side_effect=command or self.command):
            return INSTALL.activate(prepared)

    def prepare_selected(self, release):
        with mock.patch.object(INSTALL, 'TOOLKIT', self.toolkit), \
                mock.patch.object(INSTALL, '_download', side_effect=self.download), \
                mock.patch.object(INSTALL, '_run', side_effect=self.command):
            return INSTALL.prepare_release(self.root, release)

    def test_preparation_checks_toolkit_then_verifier_then_publisher_without_activation(self):
        prepared = self.prepare()
        self.assertEqual([item[0] for item in self.commands], ['verifier-spec', 'bootstrap-verifier', 'verify-package'])
        self.assertFalse(prepared.used)
        self.assertEqual(len(prepared.files), len(self.toolkit) + 4)
        self.assertEqual(len(self.downloads), len(self.toolkit) + 3)
        for name, url, _ in self.downloads[:len(self.toolkit)]:
            self.assertIn(INSTALL.TOOLKIT_COMMIT, url)
            self.assertTrue(url.endswith('/' + name))

    def test_every_invocation_gets_a_fresh_namespace_and_reuses_only_verified_cache(self):
        first = self.prepare()
        second = self.prepare()
        self.assertNotEqual(first.work, second.work)
        self.assertEqual(first.verifier, second.verifier)
        self.assertNotEqual(first.files[0]['identity'], second.files[0]['identity'])

    def test_changed_toolkit_during_download_is_rejected_before_any_code_runs(self):
        def download(*args, **kwargs):
            result = self.download(*args, **kwargs)
            if args[1].name == 'LICENSE':
                (args[0] / 'toolkit' / 'stage_release.py').write_bytes(b'changed')
            return result
        with self.assertRaises(INSTALL.SentinelInstallError):
            self.prepare(downloader=download)
        self.assertEqual(self.commands, [])

    def test_failed_source_download_is_retained_and_never_executes_tooling(self):
        def download(*args, **kwargs):
            if args[1].name == 'stage_release.py':
                raise TimeoutError('controlled download timeout')
            return self.download(*args, **kwargs)
        with self.assertRaises(TimeoutError):
            self.prepare(downloader=download)
        self.assertEqual(self.commands, [])
        self.assertTrue(list(self.root.glob('sentinel-install-*/toolkit/activate_release.py')))

    def test_bad_publisher_result_cannot_return_a_prepared_activation(self):
        def command(*args, **kwargs):
            if args[1] == 'verify-package':
                return json.dumps({**self.release, 'publisherVerified': False, 'activated': False}).encode()
            return self.command(*args, **kwargs)
        with self.assertRaises(INSTALL.SentinelInstallError):
            self.prepare(command=command)
        self.assertNotIn('activate-sentinel', [item[0] for item in self.commands])

    def test_activation_consumes_once_and_rechecks_every_prepared_file(self):
        prepared = self.prepare()
        result = self.activate(prepared)
        self.assertTrue(result['activated'])
        command = self.commands[-1]
        self.assertEqual(command[0], 'activate-sentinel')
        self.assertIsNone(command[3]['timeout'])
        self.assertEqual(command[2][-2:], ['--source-commit', self.release['sourceCommit']])
        with self.assertRaisesRegex(INSTALL.SentinelInstallError, 'already been consumed'):
            self.activate(prepared)
        self.assertEqual(sum(item[0] == 'activate-sentinel' for item in self.commands), 1)

    def retained_binding(self):
        return {'operationId': str(uuid.uuid4()), 'planSha256': '2' * 64, 'targetDigest': 'sha256:' + '3' * 64}

    def retained_ticket(self, binding):
        return {'schema': 'orbis-sentinel.upgrade-retention-ticket.v1', 'activationId': '4' * 32,
                'sha256': '5' * 64, 'binding': dict(binding)}

    def retained_activation(self, prepared, binding, *, changes=None):
        ticket = self.retained_ticket(binding)

        def command(work, name, code, arguments, **options):
            self.assertEqual(name, 'activate-sentinel')
            self.assertEqual(code, INSTALL._ACTIVATE_RETAINED)
            self.assertEqual(json.loads(arguments[1])['retain'], binding)
            result = {**self.release, 'publisherVerified': True, 'activated': True, 'retainedVersionsRemoved': 0,
                      'activationId': ticket['activationId'], 'retainedRollback': ticket, **(changes or {})}
            return json.dumps(result).encode()

        with mock.patch.object(INSTALL, 'RELEASE', self.release), mock.patch.object(INSTALL, '_run', side_effect=command):
            return INSTALL.activate(prepared, retain=binding)

    def restored_result(self, ticket):
        return {'restored': True, 'activationId': '6' * 32, 'restoredActivationId': ticket['activationId'],
                'version': '0.1.0-dev.20', 'retainedVersionsRemoved': 0,
                'previousRelease': {'version': '0.1.0-dev.20', 'sha256': '7' * 64, 'sourceCommit': '8' * 40}}

    def return_activation(self, prepared, ticket, binding, *, command=None):
        with mock.patch.object(INSTALL, 'RELEASE', self.release), mock.patch.object(INSTALL, '_run', side_effect=command or
                               (lambda *_args, **_kwargs: json.dumps(self.restored_result(ticket)).encode())):
            return INSTALL.restore_retained(prepared, ticket, binding=binding)

    def test_retained_activation_requires_exact_ticket_and_preserves_default_one_use_boundary(self):
        binding = self.retained_binding()
        prepared = self.prepare()
        result = self.retained_activation(prepared, binding)
        self.assertEqual(result['retainedRollback'], self.retained_ticket(binding))
        with self.assertRaises(INSTALL.SentinelInstallError):
            self.activate(prepared)
        for changes in ({'retainedRollback': None}, {'activationId': '0' * 32},
                        {'retainedRollback': self.retained_ticket(self.retained_binding())}):
            with self.subTest(changes=changes), self.assertRaises(INSTALL.SentinelInstallError):
                self.retained_activation(self.prepare(), binding, changes=changes)

    def test_live_return_reuses_only_its_bound_preparation_and_keeps_each_attempts_evidence(self):
        binding = self.retained_binding()
        prepared = self.prepare()
        ticket = self.retained_activation(prepared, binding)['retainedRollback']
        calls = []

        def command(work, name, code, arguments, **options):
            self.assertEqual(name, 'restore-sentinel')
            self.assertEqual(code, INSTALL._RESTORE_RETAINED)
            self.assertEqual(arguments[0], prepared.work / 'toolkit/activate_release.py')
            self.assertEqual(json.loads(arguments[1]), ticket)
            self.assertEqual(json.loads(arguments[2]), prepared.release)
            self.assertEqual(work.parent, prepared.work)
            self.assertEqual({p.name for p in work.iterdir()}, {'tmp', 'cache', 'config', 'state', 'data'})
            calls.append(work)
            return json.dumps(self.restored_result(ticket)).encode()

        self.assertTrue(self.return_activation(prepared, ticket, binding, command=command)['restored'])
        self.assertTrue(self.return_activation(prepared, ticket, binding, command=command)['restored'])
        self.assertNotEqual(calls[0], calls[1])
        self.assertTrue(all(path.exists() for path in calls))

    def test_restart_can_authenticate_a_fresh_preparation_before_observing_the_retained_return(self):
        binding = self.retained_binding()
        prepared = self.prepare()
        ticket = self.retained_ticket(binding)
        self.assertTrue(self.return_activation(prepared, ticket, binding)['restored'])
        self.assertTrue(prepared.used)
        with self.assertRaises(INSTALL.SentinelInstallError):
            self.activate(prepared)

    def test_retention_binding_and_ticket_refusals_do_not_consume_unused_preparation(self):
        prepared = self.prepare()
        binding = self.retained_binding()
        with self.assertRaises(INSTALL.SentinelInstallError):
            INSTALL.activate(prepared, retain={**binding, 'operationId': 'invalid'})
        with self.assertRaises(INSTALL.SentinelInstallError):
            INSTALL.restore_retained(prepared, self.retained_ticket(binding), binding=self.retained_binding())
        self.assertFalse(prepared.used)
        self.assertTrue(self.activate(prepared)['activated'])

    def test_changed_or_unretained_used_preparation_cannot_dispatch_return(self):
        binding = self.retained_binding()
        prepared = self.prepare()
        self.activate(prepared)
        with mock.patch.object(INSTALL, '_run') as run, self.assertRaises(INSTALL.SentinelInstallError):
            INSTALL.restore_retained(prepared, self.retained_ticket(binding), binding=binding)
        run.assert_not_called()
        prepared = self.prepare()
        ticket = self.retained_activation(prepared, binding)['retainedRollback']
        prepared.files[0]['path'].write_bytes(b'changed toolkit')
        with mock.patch.object(INSTALL, '_run') as run, self.assertRaises(INSTALL.SentinelInstallError):
            INSTALL.restore_retained(prepared, ticket, binding=binding)
        run.assert_not_called()

    def test_return_requires_confirmed_identity_without_version_pruning_or_bool_counts(self):
        binding = self.retained_binding()
        ticket = self.retained_ticket(binding)
        for changes in ({'restored': False}, {'version': '0.1.0-dev.19'}, {'retainedVersionsRemoved': False},
                        {'restoredActivationId': '9' * 32}, {'activationId': ticket['activationId']},
                        {'previousRelease': None}):
            result = {**self.restored_result(ticket), **changes}
            with self.subTest(changes=changes), self.assertRaises(INSTALL.SentinelInstallError):
                self.return_activation(self.prepare(), ticket, binding,
                                       command=lambda *_args, **_kwargs: json.dumps(result).encode())

    def test_isolated_return_wrapper_binds_verified_candidate_before_any_return_api_call(self):
        binding = self.retained_binding()
        ticket = self.retained_ticket(binding)
        record = {'activation': {'candidate': self.release, 'previous': self.restored_result(ticket)['previousRelease']}}
        body = json.dumps(record).encode()
        ticket['sha256'] = digest(body)
        (self.root / ('retention-' + ticket['activationId'] + '.json')).write_bytes(body)
        module = self.root / 'activate_release.py'
        module.write_text('''
import json
from pathlib import Path
STATE=Path(__file__).parent
class RecoveryRequired(ValueError): pass
class _Parent:
    def __init__(self,path): self.path=path
    def close(self): pass
def _read(parent,name,mode): return (parent.path/name).read_bytes()
_json=json.loads
def restore_retained(ticket):
    (STATE/'called').write_text('called')
    return {'restored':True,'version':'0.1.0-dev.20'}
''')
        def run(expected):
            return subprocess.run([str(INSTALL.PYTHON), '-I', '-B', '-c', INSTALL._RESTORE_RETAINED,
                str(module), json.dumps(ticket), json.dumps(expected)], capture_output=True,
                env=INSTALL._environment(self.root), timeout=10)

        wrong = run({**self.release, 'sourceCommit': '9' * 40})
        self.assertNotEqual(wrong.returncode, 0)
        self.assertFalse((self.root / 'called').exists())
        right = run(self.release)
        self.assertEqual(right.returncode, 0, right.stderr)
        self.assertEqual(json.loads(right.stdout)['previousRelease'], record['activation']['previous'])
        self.assertTrue((self.root / 'called').exists())

    def test_equal_byte_input_replacement_is_rejected_before_activation(self):
        prepared = self.prepare()
        path = prepared.files[0]['path']
        replacement = path.with_name('replacement')
        replacement.write_bytes(path.read_bytes())
        replacement.chmod(0o600)
        replacement.replace(path)
        with self.assertRaises(INSTALL.SentinelInstallError):
            self.activate(prepared)
        self.assertTrue(prepared.used)
        self.assertNotIn('activate-sentinel', [item[0] for item in self.commands])

    def test_verifier_tamper_or_namespace_alias_never_activates(self):
        prepared = self.prepare()
        prepared.verifier.chmod(0o755)
        with self.assertRaises(INSTALL.SentinelInstallError):
            self.activate(prepared)
        self.assertNotIn('activate-sentinel', [item[0] for item in self.commands])
        alias = self.root / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            INSTALL.Directory(alias)

    def test_directory_permission_drift_and_linked_files_are_rejected(self):
        with INSTALL.Directory(self.root, private=True) as directory:
            self.root.chmod(0o755)
            with self.assertRaises(INSTALL.SentinelInstallError):
                directory.check()
            self.root.chmod(0o700)
        path = self.root / 'record'
        path.write_bytes(b'record')
        path.chmod(0o600)
        os.link(path, self.root / 'linked')
        with self.assertRaises(INSTALL.SentinelInstallError):
            INSTALL._file(path, 6, digest(b'record'))

    def test_unknown_lengths_remain_bounded_and_duplicate_metadata_is_rejected(self):
        path = self.root / 'record'
        path.write_bytes(b'x' * 100)
        path.chmod(0o600)
        with self.assertRaises(INSTALL.SentinelInstallError):
            INSTALL._file(path, 0, '', maximum=99)
        with self.assertRaises(INSTALL.SentinelInstallError):
            INSTALL._json(b'{"activated":true,"activated":false}')

    def test_activation_rejects_wrong_identity_or_version_pruning_claim(self):
        for changes in ({'sourceCommit': 'f' * 40}, {'activated': False}, {'retainedVersionsRemoved': 1}, {'retainedVersionsRemoved': False}):
            with self.subTest(changes=changes):
                prepared = self.prepare()
                def command(*_args, **_kwargs):
                    return json.dumps({**self.release, 'publisherVerified': True, 'activated': True,
                                       'retainedVersionsRemoved': 0, **changes}).encode()
                with self.assertRaises(INSTALL.SentinelInstallError):
                    self.activate(prepared, command=command)

    def test_sanitized_child_environment_does_not_inherit_credentials_or_loader_configuration(self):
        with mock.patch.dict(os.environ, {'GH_TOKEN': 'synthetic', 'PYTHONPATH': '/untrusted', 'LD_PRELOAD': '/untrusted'}):
            environment = INSTALL._environment(self.root)
        self.assertTrue({'GH_TOKEN', 'PYTHONPATH', 'LD_PRELOAD', 'HOME'}.isdisjoint(environment))
        self.assertEqual(Path(environment['TMPDIR']).parent, self.root)

    def test_real_isolated_downloader_rejects_http_before_network_or_file_writes(self):
        path = self.root / 'download'
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        self.addCleanup(os.close, descriptor)
        result = subprocess.run([str(INSTALL.PYTHON), '-I', '-B', '-c', INSTALL.DOWNLOAD,
            'http://invalid.example/', str(descriptor), '100', '0', ''],
            env=INSTALL._environment(self.root), pass_fds=(descriptor,), capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(path.stat().st_size, 0)

    def test_selected_release_uses_shared_publisher_verification_without_changing_installer_default(self):
        default = dict(INSTALL.RELEASE)
        self.release = {**self.release, 'version': '0.2.0-beta.1', 'sourceCommit': 'a' * 40}
        selected = dict(self.release)
        prepared = self.prepare_selected(selected)
        self.assertEqual(INSTALL.RELEASE, default)
        self.assertEqual(prepared.release, selected)
        package = next(url for name, url, _ in self.downloads if name == 'orbis-sentinel-0.2.0-beta.1.tar.gz')
        self.assertEqual(package, 'https://github.com/twentylines/orbis-sentinel/releases/download/v0.2.0-beta.1/orbis-sentinel-0.2.0-beta.1.tar.gz')
        self.assertEqual(self.commands[-1][0], 'verify-package')
        self.assertEqual(self.commands[-1][2][-2:], ['--source-commit', selected['sourceCommit']])
        selected['version'] = '9.9.9'
        self.assertEqual(prepared.release['version'], '0.2.0-beta.1')
        with mock.patch.object(INSTALL, '_run', side_effect=self.command):
            result = INSTALL.activate(prepared)
        self.assertEqual(result['version'], '0.2.0-beta.1')
        self.assertEqual(INSTALL.RELEASE, default)
        with self.assertRaises(INSTALL.SentinelInstallError):
            INSTALL.activate(prepared)

    def test_invalid_release_identity_is_refused_before_host_files_or_network(self):
        for value in (None, [], {}, {**self.release, 'url': 'https://untrusted.example/'},
                      {**self.release, 'version': None}, {**self.release, 'sha256': 'F' * 64},
                      {**self.release, 'sourceCommit': 'main'}):
            with self.subTest(value=value), mock.patch.object(INSTALL, 'require_host') as host:
                with self.assertRaises(INSTALL.SentinelInstallError):
                    INSTALL.prepare_release(self.root, value)
                host.assert_not_called()
        self.assertEqual(self.downloads, [])
        self.assertEqual(self.commands, [])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_selected_version_requires_canonical_semver_and_cannot_change_download_paths(self):
        for version in ('v1.2.3', '1.2.3\n', '../1.2.3', '1.2.3/other', '01.2.3',
                        '1.2.3-dev.01', '1.2.3-a..b', '1.2.3+a..b', '1.2.3-', '1.2.3+', 'x' * 129):
            with self.subTest(version=version):
                with self.assertRaises(INSTALL.SentinelInstallError):
                    INSTALL.prepare_release(self.root, {**self.release, 'version': version})
        for version in ('1.2.3', '1.2.3-dev.0', '1.2.3-dev.10', '1.2.3-0a+001.build'):
            self.assertEqual(INSTALL._release_identity({**self.release, 'version': version})['version'], version)
        self.assertEqual(self.downloads, [])

    def test_changed_selected_identity_or_file_records_never_execute_activation(self):
        def change_release(prepared):
            prepared.release['sourceCommit'] = 'f' * 40
        def change_file(prepared):
            prepared.files[0] = {**prepared.files[0], 'sha256': 'f' * 64}
        def change_verifier(prepared):
            prepared.verifier = prepared.work / 'other-verifier'
        for change in (change_release, change_file, change_verifier):
            with self.subTest(change=change.__name__):
                prepared = self.prepare_selected(self.release)
                change(prepared)
                with mock.patch.object(INSTALL, '_run') as run:
                    with self.assertRaises(INSTALL.SentinelInstallError):
                        INSTALL.activate(prepared)
                    run.assert_not_called()
                self.assertTrue(prepared.used)

    def test_copying_a_prepared_object_does_not_copy_activation_authority(self):
        prepared = self.prepare()
        copied = INSTALL.Prepared(prepared.work, prepared.identity, prepared.files, prepared.release, prepared.verifier)
        with mock.patch.object(INSTALL, '_run') as run:
            with self.assertRaises(INSTALL.SentinelInstallError):
                INSTALL.activate(copied)
            run.assert_not_called()
        self.assertTrue(copied.used)
        self.assertFalse(prepared.used)

    def test_default_preparation_still_requires_its_original_pinned_policy(self):
        prepared = self.prepare()
        with mock.patch.object(INSTALL, 'RELEASE', {**self.release, 'sourceCommit': 'f' * 40}), \
                mock.patch.object(INSTALL, '_run') as run:
            with self.assertRaises(INSTALL.SentinelInstallError):
                INSTALL.activate(prepared)
            run.assert_not_called()

    def test_cli_requires_all_selected_identity_fields_before_preparing(self):
        for arguments in (['--release-version', '1.2.3'], ['--release-sha256', 'a' * 64],
                          ['--release-source-commit', 'a' * 40],
                          ['--release-version', '1.2.3', '--release-sha256', 'a' * 64]):
            with self.subTest(arguments=arguments), \
                    mock.patch.object(INSTALL.sys, 'argv', ['installer', '--state-dir', str(self.root), *arguments]), \
                    mock.patch.object(INSTALL, 'prepare') as default, \
                    mock.patch.object(INSTALL, 'prepare_release') as selected, \
                    mock.patch.object(INSTALL.sys, 'stderr', io.StringIO()):
                with self.assertRaises(SystemExit) as result:
                    INSTALL.main()
                self.assertEqual(result.exception.code, 1)
                default.assert_not_called()
                selected.assert_not_called()

    def test_cli_selected_prepare_only_never_calls_activation(self):
        prepared = self.prepare_selected(self.release)
        arguments = ['installer', '--state-dir', str(self.root), '--prepare-only',
                     '--release-version', self.release['version'], '--release-sha256', self.release['sha256'],
                     '--release-source-commit', self.release['sourceCommit']]
        with mock.patch.object(INSTALL.sys, 'argv', arguments), \
                mock.patch.object(INSTALL, 'prepare_release', return_value=prepared) as selected, \
                mock.patch.object(INSTALL, 'prepare') as default, \
                mock.patch.object(INSTALL, 'activate') as activate, \
                mock.patch.object(INSTALL.sys, 'stdout', io.StringIO()) as output:
            self.assertEqual(INSTALL.main(), 0)
            selected.assert_called_once_with(self.root, self.release)
            default.assert_not_called()
            activate.assert_not_called()
            self.assertEqual(json.loads(output.getvalue()), {'prepared': True, 'activated': False, 'version': self.release['version']})


if __name__ == '__main__':
    unittest.main()
