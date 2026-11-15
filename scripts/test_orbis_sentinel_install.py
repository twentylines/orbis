import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


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


if __name__ == '__main__':
    unittest.main()
