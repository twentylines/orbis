import copy
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
    def files(self, legacy=False, count=None):
        required = set(BUILD.LEGACY_REQUIRED if legacy else BUILD.REQUIRED)
        files = {name: b'# runtime fixture\n' for name in required}
        files['scripts/install-orbis.py'] = Path(__file__).with_name('install-orbis.py').read_bytes()
        pair = ('orbis.installer-bundle.v1', 'orbis.installer-bundle.v2') if legacy else (BUILD.SCHEMA, BUILD.INSTALLER_SCHEMA)
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

    def verify(self, assets, independent=False):
        manifest = assets[BUILD.MANIFEST]
        identity = {'commit': 'a' * 40, 'manifestSha256': BUILD.sha(manifest)}
        if independent:
            return BOOT.verify_installer_manifest(manifest, identity)
        identity['tag'] = 'v0.8.0-beta.1'
        return BOOT.verify_manifest(manifest, identity)

    def test_legacy_emission_and_reader_keep_the_66_file_contract(self):
        files = self.files(True, 66)
        for independent in (False, True):
            assets = BUILD.build_installer(files, 'a' * 40) if independent else BUILD.build(files, self.release())
            value = self.verify(assets, independent)
            self.assertEqual(value['schema'], 'orbis.installer-bundle.v2' if independent else 'orbis.installer-bundle.v1')
            self.assertEqual(len(BOOT.verify_files(assets[BUILD.ARCHIVE], value)), 66)
            value['files']['scripts/orbis-over-limit.py'] = {'sha256': BUILD.sha(b''), 'size': 0}
            with self.assertRaises(ValueError): self.verify({BUILD.MANIFEST: json.dumps(value).encode()}, independent)
        with self.assertRaises(ValueError): BUILD.sources(self.files(True, 67))

    def test_modern_formats_support_128_files_and_refuse_129(self):
        files = self.files(False, 128)
        for independent in (False, True):
            assets = BUILD.build_installer(files, 'a' * 40) if independent else BUILD.build(files, self.release())
            value = self.verify(assets, independent)
            self.assertEqual(value['schema'], 'orbis.installer-bundle.v4' if independent else 'orbis.installer-bundle.v3')
            self.assertEqual(len(BOOT.verify_files(assets[BUILD.ARCHIVE], value)), 128)
            value['files']['scripts/orbis-over-limit.py'] = {'sha256': BUILD.sha(b''), 'size': 0}
            with self.assertRaises(ValueError): self.verify({BUILD.MANIFEST: json.dumps(value).encode()}, independent)
        with self.assertRaises(ValueError): BUILD.sources(self.files(False, 129))

    def test_format_kind_and_declared_limits_cannot_change_receiver_policy(self):
        for independent in (False, True):
            files = self.files()
            assets = BUILD.build_installer(files, 'a' * 40) if independent else BUILD.build(files, self.release())
            value = json.loads(assets[BUILD.MANIFEST])
            for schema in ('orbis.installer-bundle.v3' if independent else 'orbis.installer-bundle.v4', 'orbis.installer-bundle.v99'):
                changed = {**value, 'schema': schema, 'maxFiles': 10000}
                with self.assertRaises(ValueError): self.verify({BUILD.MANIFEST: json.dumps(changed).encode()}, independent)
        files = self.files(True, 67)
        files['scripts/orbis-installer-bundle.py'] += b'\nMAX_FILES = 10000\n'
        with self.assertRaises(ValueError): BUILD.sources(files)

    def test_source_contract_is_unique_literal_and_not_executed(self):
        required = repr(set(BUILD.LEGACY_REQUIRED))
        original = "SCHEMA = 'orbis.installer-bundle.v1'\nINSTALLER_SCHEMA = 'orbis.installer-bundle.v2'\nREQUIRED = " + required + '\n'
        source = {'scripts/orbis-installer-bundle.py': original.encode() + b"raise Exception('must not execute')\n"}
        self.assertEqual(BUILD.source_contract(source), ('orbis.installer-bundle.v1', 'orbis.installer-bundle.v2'))
        for extra in ("SCHEMA = 'orbis.installer-bundle.v3'", "SCHEMA += 'x'", "INSTALLER_SCHEMA = callback()"):
            with self.assertRaises(ValueError): BUILD.source_contract({'scripts/orbis-installer-bundle.py': (original + extra).encode()})
        for first, second in (("[]", "'orbis.installer-bundle.v2'"), ("'orbis.installer-bundle.v3'", "'orbis.installer-bundle.v2'")):
            with self.assertRaises(ValueError): BUILD.source_contract({'scripts/orbis-installer-bundle.py': ('SCHEMA = ' + first + '\nINSTALLER_SCHEMA = ' + second).encode()})

    def test_verified_bundle_can_start_installer_and_isolated_installed_helper_entrypoints(self):
        repository = Path(__file__).resolve().parent.parent
        files = {str(path.relative_to(repository)): path.read_bytes() for path in (repository / 'scripts').iterdir()
                 if path.is_file() and BUILD.ALLOWED.fullmatch(str(path.relative_to(repository)))}
        unit = 'packaging/systemd/orbis-host.service'
        files[unit] = (repository / unit).read_bytes()
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
