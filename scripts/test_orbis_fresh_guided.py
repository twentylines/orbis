import hashlib
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest import mock

import test_orbis_fresh_installer as installer
from test_orbis_installer_bundle import BOOT, BUILD


def load(name):
    spec = importlib.util.spec_from_file_location('fresh_guided_' + name, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


class FreshGuidedTests(unittest.TestCase):
    """Actual verified package custody and in-process child command fixture."""
    def setUp(self):
        self.f = installer.FreshInstallerTests('test_public_review_apply_uses_all_protected_phases_and_finishes_exact_target')
        self.addCleanup(self.f.doCleanups); self.f.setUp()
        c = self.c = self.f.c
        self.guide = load('orbis-install.py')
        self.setup = load('orbis-host-service-setup.py')
        owner = mock.patch.object(self.setup.HOST.AUTHORITY, 'OWNER', os.geteuid())
        owner.start(); self.addCleanup(owner.stop)
        self.extraction = c.f.folder / 'extraction'; self.extraction.mkdir(mode=0o700)
        source = Path(__file__).resolve().parent.parent
        files = {str(path.relative_to(source)): path.read_bytes() for path in (source / 'scripts').iterdir()
                 if path.is_file() and BUILD.ALLOWED.fullmatch(str(path.relative_to(source)))}
        files['packaging/systemd/orbis-host.service'] = (source / 'packaging/systemd/orbis-host.service').read_bytes()
        files = BUILD.sources(files)
        core = json.dumps(c.f.manifest).encode()
        assets = BUILD.build(files, core)
        identity = {'tag': c.f.manifest['tag'], 'commit': c.f.manifest['commit'], 'manifestSha256': BUILD.sha(assets[BUILD.MANIFEST])}
        self.custody = BOOT.stage_verified_installer(self.extraction, mode='release', identity=identity, channel='stable',
            release=core, manifest=assets[BUILD.MANIFEST], archive=assets[BUILD.ARCHIVE], files=files)
        with ((self.extraction / BOOT.SOURCE_LAUNCHER).open('rb') as launcher,
              mock.patch.object(BOOT, 'OWNER', os.geteuid()), mock.patch.object(BOOT, '__file__', '/proc/self/fd/' + str(launcher.fileno())),
              mock.patch.object(BOOT, 'private_directory', return_value=self.extraction), mock.patch.object(BOOT, 'EXPECTED_RELEASE', identity),
              mock.patch.object(BOOT, '_exec_guided')):
            BOOT._continue_verified_installer([str(self.extraction), self.custody, 'stable'])
        self.state = self.extraction / 'transactions'; self.state.mkdir(mode=0o700)
        c.host.credential_fence_lock = lambda root, context: c.b.guarded()
        for name, value in (('REPLACE', c.r), ('HOST', c.host), ('APPS', c.r.APPS),
                            ('__file__', str(self.extraction / 'scripts/orbis-install.py'))):
            patch = mock.patch.object(self.guide, name, value)
            patch.start(); self.addCleanup(patch.stop)
        original_load = self.guide.load
        def select(name, key):
            if name == 'orbis-host-service-setup.py': return self.setup
            if name == 'install-orbis.py':
                return type('FixturePrivateDirectory', (), {'private_directory': staticmethod(lambda path: path.mkdir(mode=0o700, exist_ok=True))})
            return original_load(name, key)
        loader = mock.patch.object(self.guide, 'load', side_effect=select)
        loader.start(); self.addCleanup(loader.stop)
        self.dispatches = 0; self.lose_reply = False
        def command(args, output, errors):
            self.dispatches += 1
            with c.b.guarded() as guard:
                try:
                    if args[1] == 'apply':
                        value = json.loads(Path(args[args.index('--review') + 1]).read_text())
                        if self.lose_reply:
                            with mock.patch.object(guard, 'finish', side_effect=OSError('fixture interrupted retirement')):
                                result = c.r.apply(c.root, c.reader, value, host_writers_stopped=True, ownership=guard)
                        else:
                            result = c.r.apply(c.root, c.reader, value, host_writers_stopped=True, ownership=guard)
                    else:
                        result = c.r.recover(c.root, c.reader, Path(args[args.index('--journal') + 1]), host_writers_stopped=True, ownership=guard)
                except ValueError:
                    output.write_bytes(b''); errors.write_text(json.dumps({'schema': c.r.SCHEMA, 'result': 'replacement-failed', 'message': 'fixture protected outcome needs recovery'}))
                    return 2
            output.write_text(json.dumps(result)); errors.write_bytes(b''); return 0
        dispatch = mock.patch.object(self.guide, 'command', side_effect=command)
        dispatch.start(); self.addCleanup(dispatch.stop)

    def approved(self):
        with self.c.b.guarded(): self.c.f.authorization_fixture()

    def replace(self):
        return self.guide.replacement(self.c.root, self.c.reader, self.c.f.manifest, self.state, 'fresh', lambda root: None,
                                      backup_scope='full', source_custody=self.custody)

    def test_guided_fresh_applies_exact_verified_executor_dependencies_and_target(self):
        self.approved()
        result = self.replace()
        self.assertEqual(result['result'], 'orbis-installed'); self.assertEqual(self.dispatches, 1)
        marker = json.loads((self.c.root / '.orbis-installation.json').read_text())
        self.assertEqual(marker['sourceCustodySha256'], self.custody)
        self.assertEqual(self.c.sql_calls, 1)

    def test_guided_terminal_pending_hold_recovers_original_executor_and_keeps_journal(self):
        self.approved(); self.lose_reply = True
        with self.assertRaises(ValueError): self.replace()
        marker = json.loads((self.c.root / '.orbis-installation.json').read_text())
        before = Path(marker['journal']).read_bytes()
        result = self.guide.recover_pending(self.c.root, self.c.reader, self.state, None, writers_stopped=True)
        self.assertEqual(result['result'], 'orbis-installed'); self.assertEqual(self.dispatches, 2)
        self.assertEqual(Path(marker['journal']).read_bytes(), before); self.assertEqual(self.c.sql_calls, 1)

    def test_changed_dependency_or_different_target_never_dispatches(self):
        script = self.extraction / 'scripts/orbis-install-replace.py'
        marker = {'sourceCustodySha256': self.custody, 'executorSha256': hashlib.sha256(script.read_bytes()).hexdigest()}
        scope = {'ownershipProtocol': self.c.r.OWNERSHIP_PROTOCOL, 'target': self.c.f.manifest}
        altered = {**scope, 'target': {**scope['target'], 'commit': '0' * 40}}
        with self.assertRaises(ValueError), self.guide.verified_fresh_executor(script, marker, altered): pass
        dependency = self.extraction / 'scripts/orbis-host-fresh-ownership.py'
        dependency.write_bytes(dependency.read_bytes() + b'\n# changed fixture\n')
        with self.assertRaisesRegex(ValueError, 'dependency'), self.guide.verified_fresh_executor(script, marker, scope): pass
        self.assertEqual(self.dispatches, 0)

    def test_custody_verification_retains_original_inode_until_command_returns(self):
        script = self.extraction / 'scripts/orbis-install-replace.py'
        marker = {'sourceCustodySha256': self.custody, 'executorSha256': hashlib.sha256(script.read_bytes()).hexdigest()}
        scope = {'ownershipProtocol': self.c.r.OWNERSHIP_PROTOCOL, 'target': self.c.f.manifest}
        with self.assertRaises(ValueError):
            with self.guide.verified_fresh_executor(script, marker, scope):
                body = script.read_bytes(); other = script.with_suffix('.replacement'); other.write_bytes(body); other.chmod(0o600)
                os.replace(other, script)

    def test_old_hash_correct_verified_package_cannot_advertise_new_protocol_from_marker(self):
        source = self.extraction
        files = {name: (source / name).read_bytes() for name in json.loads((source / BOOT.MANIFEST).read_text())['files']}
        files['scripts/orbis-install-replace.py'] = b"raise RuntimeError('legacy fixture must not execute')\n"
        target = self.c.f.folder / 'older'; target.mkdir(mode=0o700)
        core = json.dumps(self.c.f.manifest).encode(); assets = BUILD.build(files, core)
        identity = {'tag': self.c.f.manifest['tag'], 'commit': self.c.f.manifest['commit'], 'manifestSha256': BUILD.sha(assets[BUILD.MANIFEST])}
        custody = BOOT.stage_verified_installer(target, mode='release', identity=identity, channel='stable', release=core,
            manifest=assets[BUILD.MANIFEST], archive=assets[BUILD.ARCHIVE], files=files)
        with ((target / BOOT.SOURCE_LAUNCHER).open('rb') as launcher,
              mock.patch.object(BOOT, 'OWNER', os.geteuid()), mock.patch.object(BOOT, '__file__', '/proc/self/fd/' + str(launcher.fileno())),
              mock.patch.object(BOOT, 'private_directory', return_value=target), mock.patch.object(BOOT, 'EXPECTED_RELEASE', identity),
              mock.patch.object(BOOT, '_exec_guided')):
            BOOT._continue_verified_installer([str(target), custody, 'stable'])
        executor = target / 'scripts/orbis-install-replace.py'
        marker = {'sourceCustodySha256': custody, 'executorSha256': hashlib.sha256(executor.read_bytes()).hexdigest()}
        scope = {'ownershipProtocol': self.c.r.OWNERSHIP_PROTOCOL, 'target': self.c.f.manifest}
        with self.assertRaisesRegex(ValueError, 'lacks the protected Fresh protocol'), self.guide.verified_fresh_executor(executor, marker, scope): pass
        self.assertEqual(self.dispatches, 0)

    def test_changed_dependency_blocks_actual_pending_recovery_before_dispatch(self):
        self.approved(); self.lose_reply = True
        with self.assertRaises(ValueError): self.replace()
        marker = json.loads((self.c.root / '.orbis-installation.json').read_text())
        before = Path(marker['journal']).read_bytes()
        dependency = self.extraction / 'scripts/orbis-host-fresh-ownership.py'
        dependency.write_bytes(dependency.read_bytes() + b'\n# changed fixture\n')
        with self.assertRaisesRegex(ValueError, 'dependency'):
            self.guide.recover_pending(self.c.root, self.c.reader, self.state, None, writers_stopped=True)
        self.assertEqual(self.dispatches, 1); self.assertEqual(Path(marker['journal']).read_bytes(), before)


if __name__ == '__main__': unittest.main()
