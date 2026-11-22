import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location('contract_' + name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BUILD = load('orbis-installer-bundle')
BOOT = load('install-orbis')


class InstallerContractTests(unittest.TestCase):
    def files(self, count=None, *, versions=(5, 6)):
        required = set(BUILD.LEGACY_REQUIRED if versions == (1, 2) else BUILD.REQUIRED)
        files = {name: b'# runtime fixture\n' for name in required}
        files['scripts/install-orbis.py'] = Path(__file__).with_name('install-orbis.py').read_bytes()
        pair = tuple(f'orbis.installer-bundle.v{version}' for version in versions)
        files['scripts/orbis-installer-bundle.py'] = ('SCHEMA = ' + repr(pair[0]) + '\nINSTALLER_SCHEMA = ' + repr(pair[1])
            + '\nREQUIRED = ' + repr(required) + '\nBUILD_ONLY = ' + repr(BUILD.BUILD_ONLY) + '\n').encode()
        index = 0
        while count is not None and len(set(files) - BUILD.BUILD_ONLY) < count:
            suffix = chr(97 + index // 26) + chr(97 + index % 26)
            files['scripts/orbis-fixture-' + suffix + '.py'] = b'# fixture\n'
            index += 1
        return files

    def release(self):
        return json.dumps({'schema': 'orbis.release.v1', 'image': 'ghcr.io/twentylines/orbis', 'tag': 'v0.8.0-beta.1',
            'commit': 'a' * 40, 'digest': 'sha256:' + 'b' * 64, 'installationProtocol': 'orbis.installation-state.v1'}).encode()

    def build(self, files, independent):
        if independent:
            return BUILD.build_installer(files, 'a' * 40)
        return BUILD.build(files, self.release())

    def verify(self, assets, independent=False):
        manifest = assets[BUILD.MANIFEST]
        identity = {'commit': 'a' * 40, 'manifestSha256': BUILD.sha(manifest)}
        if independent:
            return BOOT.verify_installer_manifest(manifest, identity)
        identity['tag'] = 'v0.8.0-beta.1'
        return BOOT.verify_manifest(manifest, identity)

    def test_each_format_round_trips_at_its_original_limit_and_rejects_one_more(self):
        for versions, limit in (((1, 2), 66), ((3, 4), 128), ((5, 6), 160)):
            files = self.files(limit, versions=versions)
            oversized = self.files(limit + 1, versions=versions)
            for independent in (False, True):
                schema = f'orbis.installer-bundle.v{versions[independent]}'
                with self.subTest(schema=schema, limit=limit):
                    assets = self.build(files, independent)
                    value = self.verify(assets, independent)
                    self.assertEqual(value['schema'], schema)
                    self.assertEqual(BOOT.verify_files(assets[BUILD.ARCHIVE], value),
                                     {name: body for name, body in files.items() if name not in BUILD.BUILD_ONLY})
                    with self.assertRaisesRegex(ValueError, 'exceed their limits'):
                        self.build(oversized, independent)
                    value['files']['scripts/orbis-over-limit.py'] = {'sha256': BUILD.sha(b''), 'size': 0}
                    value['maxFiles'] = 10000
                    with self.assertRaisesRegex(ValueError, 'file list is incomplete'):
                        self.verify({BUILD.MANIFEST: json.dumps(value).encode()}, independent)
                    with self.assertRaisesRegex(ValueError, 'file list is incomplete'):
                        BOOT.verify_files(assets[BUILD.ARCHIVE], value)

    def test_format_kind_cannot_change_receiver_policy(self):
        for independent in (False, True):
            files = self.files()
            assets = self.build(files, independent)
            value = json.loads(assets[BUILD.MANIFEST])
            for version in ((1, 3, 5, 99) if independent else (2, 4, 6, 99)):
                schema = f'orbis.installer-bundle.v{version}'
                with self.subTest(independent=independent, schema=schema):
                    changed = {**value, 'schema': schema}
                    with self.assertRaises(ValueError):
                        self.verify({BUILD.MANIFEST: json.dumps(changed).encode()}, independent)
        files = self.files(67, versions=(1, 2))
        files['scripts/orbis-installer-bundle.py'] += b'\nMAX_FILES = 10000\n'
        with self.assertRaises(ValueError):
            BUILD.sources(files)

    def test_manifest_rejects_opposite_role_identity_even_with_matching_digest(self):
        for versions in ((1, 2), (3, 4), (5, 6)):
            for independent in (False, True):
                assets = self.build(self.files(versions=versions), independent)
                value = json.loads(assets[BUILD.MANIFEST])
                opposite = ({'tag': 'v0.8.0-beta.1', 'commit': 'a' * 40,
                             'releaseManifestSha256': 'b' * 64} if independent
                            else {'installerCommit': 'a' * 40})
                for key, extra in opposite.items():
                    with self.subTest(versions=versions, independent=independent, field=key):
                        changed = json.dumps({**value, key: extra}).encode()
                        with self.assertRaises(ValueError):
                            self.verify({BUILD.MANIFEST: changed}, independent)

    def test_manifest_schema_collections_have_the_normal_validation_error(self):
        for independent in (False, True):
            assets = self.build(self.files(), independent)
            value = json.loads(assets[BUILD.MANIFEST])
            for schema in ([], {}):
                with self.subTest(independent=independent, schema=schema):
                    changed = json.dumps({**value, 'schema': schema}).encode()
                    with self.assertRaises(ValueError):
                        self.verify({BUILD.MANIFEST: changed}, independent)

    def test_source_contract_is_unique_literal_and_not_executed(self):
        required = repr(set(BUILD.LEGACY_REQUIRED))
        original = "SCHEMA = 'orbis.installer-bundle.v1'\nINSTALLER_SCHEMA = 'orbis.installer-bundle.v2'\nREQUIRED = " + required + '\n'
        source = {'scripts/orbis-installer-bundle.py': original.encode() + b"raise Exception('must not execute')\n"}
        self.assertEqual(BUILD.source_contract(source), ('orbis.installer-bundle.v1', 'orbis.installer-bundle.v2'))
        for extra in ("SCHEMA = 'orbis.installer-bundle.v3'", "SCHEMA += 'x'", "INSTALLER_SCHEMA = callback()"):
            with self.assertRaises(ValueError): BUILD.source_contract({'scripts/orbis-installer-bundle.py': (original + extra).encode()})
        for first, second in (("[]", "'orbis.installer-bundle.v2'"),
                              ("'orbis.installer-bundle.v3'", "'orbis.installer-bundle.v6'"),
                              ("'orbis.installer-bundle.v5'", "'orbis.installer-bundle.v4'")):
            with self.assertRaises(ValueError): BUILD.source_contract({'scripts/orbis-installer-bundle.py': ('SCHEMA = ' + first + '\nINSTALLER_SCHEMA = ' + second).encode()})

    def workspace_files(self):
        repository = Path(__file__).resolve().parent.parent
        files = {str(path.relative_to(repository)): path.read_bytes() for path in (repository / 'scripts').iterdir()
                 if path.is_file() and BUILD.ALLOWED.fullmatch(str(path.relative_to(repository)))}
        unit = 'packaging/systemd/orbis-host.service'
        files[unit] = (repository / unit).read_bytes()
        return files

    def test_current_source_round_trips_all_runtime_members_in_both_formats(self):
        files = self.workspace_files()
        expected = {name: body for name, body in files.items() if name not in BUILD.BUILD_ONLY}
        self.assertIn('scripts/orbis-snapshot.py', expected)
        for independent in (False, True):
            with self.subTest(independent=independent):
                assets = self.build(files, independent)
                manifest = self.verify(assets, independent)
                self.assertEqual(manifest['schema'], 'orbis.installer-bundle.v6' if independent else 'orbis.installer-bundle.v5')
                self.assertEqual(BOOT.verify_files(assets[BUILD.ARCHIVE], manifest), expected)

    def test_verified_bundle_can_start_installer_and_isolated_installed_helper_entrypoints(self):
        files = self.workspace_files()
        assets = BUILD.build(files, self.release())
        verified = BOOT.verify_files(assets[BUILD.ARCHIVE], self.verify(assets))
        with tempfile.TemporaryDirectory(prefix='verified-helper-') as temporary:
            root = Path(temporary)
            for name, data in verified.items():
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            environment = {**os.environ, 'PYTHONPATH': '', 'PYTHONDONTWRITEBYTECODE': '1', 'PATH': ''}
            for name in ('orbis-install.py', 'orbis-host-service-setup.py', 'orbis-host-service.py', 'orbis-host-core-capture-worker.py'):
                result = subprocess.run([sys.executable, '-I', '-B', str(root / 'scripts' / name), '--help'],
                                        cwd=root, env=environment, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            program = r'''
import importlib.util, pathlib, shutil, sys
root = pathlib.Path(sys.argv[1])
def load(file):
    spec = importlib.util.spec_from_file_location('installed_' + file.stem, file)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
setup = load(root / 'scripts/orbis-host-service-setup.py')
scripts, unit = setup.source_files(root / 'scripts')
installed = root / 'installed/scripts'; installed.mkdir(parents=True)
for file in scripts: shutil.copyfile(file, installed / file.name)
shutil.copyfile(root / 'scripts/orbis-host-service-setup.py', installed / 'orbis-host-service-setup.py')
destination = installed.parent / 'packaging/systemd'; destination.mkdir(parents=True); shutil.copyfile(unit, destination / unit.name)
original = importlib.util.spec_from_file_location
def confined(name, file, *args, **kwargs):
    assert pathlib.Path(file).resolve().parent == installed.resolve()
    return original(name, file, *args, **kwargs)
importlib.util.spec_from_file_location = confined
loaded = load(installed / 'orbis-host-service-setup.py')
assert loaded.SERVICE.HostService
load(installed / 'orbis-host-core-capture-worker.py')
load(installed / 'orbis-host-core-capture-service.py')
load(installed / 'orbis-host-sentinel-observer.py')
'''
            result = subprocess.run([sys.executable, '-I', '-B', '-c', program, str(root)],
                                    cwd=root, env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
