#!/usr/bin/env python3
"""Bounded safety checks for the optional real Host/Core Linux fixture."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


R = load('orbis-host-storage-runtime')
C = load('orbis-host-storage-candidate')
F = load('orbis-host-storage-fixture')


class FixturePreparation(unittest.TestCase):
    def test_actual_source_inventory_and_startup_mount_contracts(self):
        with tempfile.TemporaryDirectory(prefix='host-storage-prepare-') as temporary:
            parent = Path(temporary)
            folder = parent / 'fixture'
            folder.mkdir(mode=0o700)
            manifest = parent / 'manifest.json'
            manifest.write_text(json.dumps({'schema': 'orbis.release.v1', 'image': R.IMAGE,
                'tag': 'v0.9.2-rc.3', 'commit': 'a' * 40, 'digest': 'sha256:' + 'b' * 64,
                'runtipiCompatibility': '4.10.1', 'installationProtocol': 'orbis.installation-state.v1'}))
            prepared = F.prepare(manifest, folder, R.DEPENDENCIES)
            core = prepared['config']['services']['runtipi']
            mounts = {item['target']: item for item in core['volumes']}
            # Normal Core startup legitimately regenerates .env before Host
            # enrollment pins the resulting bytes. A read-only file cannot boot.
            self.assertFalse(mounts['/data/.env']['read_only'])
            self.assertTrue(mounts['/var/run/docker.sock']['read_only'])
            self.assertTrue(mounts['/opt/orbis-test-probe']['read_only'])
            self.assertEqual(mounts['/opt/orbis-test-probe']['source'], str(folder / 'public-probe'))
            self.assertNotIn(str(folder / 'host-state'), {item['source'] for item in mounts.values()})
            self.assertEqual((prepared['root'] / '.env').stat().st_mode & 0o777, 0o600)
            self.assertEqual((prepared['root'] / 'app-data/fixture/probe/marker').read_text(), 'scoped fixture\n')


class RuntimeBoundaries(unittest.TestCase):
    def runtime(self):
        return R.Runtime(Path('/checkout'), Path('/checkout/.orbis-host-ABCDEF'), Path('/manifest'), Path('/probe'))

    def test_startup_diagnostics_do_not_disclose_messages_or_private_values(self):
        body = (b"Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'argon2' imported from /app/main.mjs\n"
                b"Cannot find module '/private/location'\nsecret=sensitive-value\n"
                b"Error: ENOENT at /private/other\n")
        self.assertEqual(R.startup_signals(body, {'argon2'}), {
            'markers': ['missing-file', 'missing-module'], 'missingPackages': ['argon2']})
        self.assertNotIn('sensitive-value', json.dumps(R.startup_signals(body, {'argon2'})))

    def test_official_repository_aliases_preserve_the_exact_digest(self):
        digest = 'sha256:' + 'a' * 64
        expected = 'docker.io/library/postgres@' + digest
        for repository in ('postgres', 'library/postgres', 'docker.io/postgres', 'docker.io/library/postgres',
                           'index.docker.io/library/postgres'):
            with self.subTest(repository=repository):
                self.assertEqual(R.canonical_reference(repository + '@' + digest), expected)

    def test_other_registries_namespaces_and_digests_are_not_official_aliases(self):
        expected = R.canonical_reference('postgres@sha256:' + 'a' * 64)
        for value in ('other.invalid/library/postgres@sha256:' + 'a' * 64,
                      'docker.io/other/postgres@sha256:' + 'a' * 64,
                      'postgres@sha256:' + 'b' * 64):
            self.assertNotEqual(R.canonical_reference(value), expected)
        self.assertEqual(R.canonical_reference(R.IMAGE + '@sha256:' + 'a' * 64), R.IMAGE + '@sha256:' + 'a' * 64)

    def test_unpinned_malformed_and_ambiguous_references_refuse(self):
        for value in ('postgres:14', 'postgres', 'postgres@sha256:short', 'postgres@@sha256:' + 'a' * 64,
                      '../postgres@sha256:' + 'a' * 64, 'postgres@sha256:' + 'a' * 64 + '\n'):
            with self.subTest(value=value):
                self.assertIsNone(R.canonical_reference(value))

    def test_no_engine_access_without_linux_root_and_explicit_gate(self):
        cases = [('darwin', 0, {'ORBIS_HOST_STORAGE_TEST': '1'}),
                 ('linux', 1000, {'ORBIS_HOST_STORAGE_TEST': '1'}), ('linux', 0, {})]
        for platform, uid, environment in cases:
            with self.subTest(platform=platform, uid=uid, gate=bool(environment)):
                runtime = self.runtime()
                with patch.object(R.sys, 'platform', platform), patch.object(R.os, 'geteuid', return_value=uid), \
                        patch.dict(R.os.environ, environment, clear=True), patch.object(runtime, 'docker') as docker:
                    with self.assertRaises(R.Refused):
                        runtime.prepare()
                    docker.assert_not_called()

    def test_inventory_includes_stopped_containers(self):
        runtime = self.runtime()
        with patch.object(runtime, 'docker', return_value=subprocess.CompletedProcess([], 0, b'a' * 64 + b'\n', b'')) as docker:
            self.assertEqual(runtime.identifiers('container'), {'a' * 64})
            self.assertIn('--all', docker.call_args.args)

    def test_cleanup_has_no_authority_before_initial_inventory(self):
        runtime = self.runtime()
        with patch.object(runtime, 'docker') as docker:
            self.assertFalse(runtime.cleanup())
            docker.assert_not_called()

    def test_cleanup_refuses_changed_container_before_any_engine_mutation(self):
        for field in ('name', 'image', 'reference', 'project', 'service', 'root'):
            with self.subTest(field=field):
                runtime = self.runtime()
                runtime.original_containers, runtime.original_networks = set(), set()
                identifier = 'a' * 64
                image = 'sha256:' + 'b' * 64
                reference = R.IMAGE + '@sha256:' + 'c' * 64
                runtime.owned[identifier] = ('runtipi', image, reference)
                item = {'Name': '/runtipi', 'Image': image,
                        'Config': {'Image': reference, 'Labels': {
                            'com.docker.compose.project': 'runtipi',
                            'com.docker.compose.service': 'runtipi',
                            'com.docker.compose.project.working_dir': str(runtime.root)}}}
                if field == 'name': item['Name'] = '/foreign'
                elif field == 'image': item['Image'] = 'sha256:' + 'd' * 64
                elif field == 'reference': item['Config']['Image'] = R.IMAGE + ':foreign'
                else:
                    key = {'project': 'project', 'service': 'service', 'root': 'project.working_dir'}[field]
                    item['Config']['Labels']['com.docker.compose.' + key] = 'foreign'
                with patch.object(runtime, 'inspect', return_value=item), patch.object(runtime, 'docker') as docker:
                    with self.assertRaisesRegex(R.Refused, 'cleanup-identity-changed'):
                        runtime.cleanup()
                    docker.assert_not_called()

    def test_cleanup_refuses_reused_service_pid(self):
        runtime = self.runtime()
        runtime.original_containers, runtime.original_networks = set(), set()
        from unittest.mock import Mock
        runtime.host = Mock(pid=123)
        runtime.host.poll.return_value = None
        runtime.host_start = 'original'
        with patch.object(runtime, 'process_start', return_value='replacement'), patch.object(runtime, 'docker') as docker:
            with self.assertRaisesRegex(R.Refused, 'host-process-changed'):
                runtime.cleanup()
            runtime.host.send_signal.assert_not_called()
            runtime.host.terminate.assert_not_called()
            docker.assert_not_called()


class CandidateBoundaries(unittest.TestCase):
    def test_production_changes_cannot_join_an_older_image(self):
        for change in ('M\tscripts/orbis-host-service.py\n', 'D\tpackages/backend/src/app.module.ts\n',
                       'A\tpackages/backend/src/unreviewed.ts\n'):
            with self.subTest(change=change.strip()):
                with patch.object(C, 'git', side_effect=[b'', b'', change.encode()]):
                    with self.assertRaisesRegex(ValueError, 'production sources differ'):
                        C.validate_source(Path('/checkout'), 'a' * 40)

    def test_only_exact_fixture_additions_or_repairs_are_allowed(self):
        for status in ('A', 'M'):
            changes = ''.join(status + '\t' + name + '\n' for name in sorted(C.FIXTURE_PATHS)).encode()
            with patch.object(C, 'git', side_effect=[b'', b'', changes]):
                C.validate_source(Path('/checkout'), 'a' * 40)
        with patch.object(C, 'git', side_effect=[b'', b'', b'D\t.github/workflows/host-storage-runtime.yml\n']):
            with self.assertRaisesRegex(ValueError, 'production sources differ'):
                C.validate_source(Path('/checkout'), 'a' * 40)

    def registry(self, *, missing_arm=False, wrong_commit=False, corrupt_blob=False):
        tag, commit = 'v0.9.2-rc.3', 'a' * 40
        entries, objects = [], {}
        def blob(value):
            body = json.dumps(value, sort_keys=True).encode()
            digest = 'sha256:' + hashlib.sha256(body).hexdigest()
            objects[digest] = body
            return {'digest': digest, 'size': len(body)}
        for arch in (['amd64'] if missing_arm else ['amd64', 'arm64']):
            config = blob({'os': 'linux', 'architecture': arch, 'config': {
                'Labels': {'org.opencontainers.image.source': 'https://github.com/twentylines/orbis',
                           'org.opencontainers.image.revision': 'b' * 40 if wrong_commit else commit,
                           'org.opencontainers.image.version': tag,
                           'io.orbis.installation-protocol': 'orbis.installation-state.v1'},
                'Env': ['ORBIS_VERSION=' + tag, 'ORBIS_COMMIT=' + commit]}})
            if corrupt_blob:
                objects[config['digest']] = b'{}'
            image = blob({'config': config, 'layers': []})
            entries.append({**image, 'platform': {'os': 'linux', 'architecture': arch}})
        index = blob({'manifests': entries})
        def read(url, headers=None):
            if url.startswith('https://ghcr.io/token?'):
                return b'{"token":"synthetic-in-memory-only"}', {}
            selected = url.rsplit('/', 1)[-1]
            digest = index['digest'] if selected == tag else selected
            return objects[digest], {'Docker-Content-Digest': digest}
        return tag, commit, index['digest'], read

    def test_registry_accepts_exact_both_platforms(self):
        tag, commit, digest, reader = self.registry()
        with patch.object(C, 'validate_source'), patch.object(C, 'read', side_effect=reader), \
                patch.object(C.subprocess, 'check_output', return_value=b'f' * 64 + b'\n'):
            result = C.verify(Path('/checkout'), tag, commit, digest)
            self.assertEqual(result['commit'], commit)
            self.assertEqual(result['digest'], digest)
            self.assertEqual(result['platforms'], ['linux/amd64', 'linux/arm64'])

    def test_registry_refuses_missing_platform_wrong_revision_and_corruption(self):
        for options in ({'missing_arm': True}, {'wrong_commit': True}, {'corrupt_blob': True}):
            with self.subTest(options=options):
                tag, commit, digest, reader = self.registry(**options)
                with patch.object(C, 'validate_source'), patch.object(C, 'read', side_effect=reader):
                    with self.assertRaises(ValueError):
                        C.verify(Path('/checkout'), tag, commit, digest)


if __name__ == '__main__':
    unittest.main(verbosity=2)
