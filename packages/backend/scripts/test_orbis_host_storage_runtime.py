#!/usr/bin/env python3
"""Bounded safety checks for the optional real Host/Core Linux fixture."""
import hashlib
import ast
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
            self.assertEqual(mounts['/cache']['source'], str(prepared['root'] / 'cache'))
            self.assertFalse(mounts['/cache']['read_only'])
            self.assertTrue((prepared['root'] / 'cache').is_dir())
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
            'markers': ['missing-file', 'missing-module'], 'missingPackages': ['argon2'],
            'messages': ['Error [ERR_MODULE_NOT_FOUND]: Cannot find package <quoted> imported from <private>',
                         'Error: ENOENT at <private>'], 'logBytes': len(body)})
        self.assertNotIn('sensitive-value', json.dumps(R.startup_signals(body, {'argon2'})))

    def test_minified_source_lines_cannot_hide_the_final_startup_failure(self):
        body = b'x' * (512 * 1024) + b'\nParseError: private detail\n'
        self.assertEqual(R.startup_signals(body, set()), {
            'markers': ['schema-parse'], 'missingPackages': [], 'messages': ['ParseError: private detail'], 'logBytes': len(body)})

    def test_startup_message_redacts_fixture_values_and_skips_sensitive_lines(self):
        body = b'\x1b[31m[Nest] ERROR [ExceptionHandler] Missing dependency fixture-value in module\x1b[0m\nError: password invalid\n'
        result = R.startup_signals(body, set(), ['fixture-value'])
        self.assertEqual(result['messages'], ['Missing dependency <private> in module'])

    def test_package_loader_failures_name_only_known_product_dependencies(self):
        body = b'[Nest] ERROR [PackageLoader] The "class-validator" package is missing. Please install it.\n'
        result = R.startup_signals(body, {'class-validator'})
        self.assertEqual(result['missingPackages'], ['class-validator'])
        self.assertEqual(result['markers'], ['dependency-package'])
        self.assertEqual(result['messages'], ['The <quoted> package is missing. Please install it.'])

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

    def test_failed_probe_retains_only_bounded_diagnostics_and_never_passes(self):
        runtime = self.runtime()
        runtime.owned['a' * 64] = ('runtipi', 'sha256:' + 'b' * 64, R.IMAGE + '@sha256:' + 'c' * 64)
        state = {'State': {'Status': 'running', 'Health': {'Status': 'healthy'}}}
        child = {'case': 'positive', 'passed': False, 'failedPhase': 'host-transport',
                 'diagnostic': {'hostStatus': 409, 'metadataVerified': False, 'privatePath': '/private/location'}}
        result = subprocess.CompletedProcess([], 1, json.dumps(child).encode(), b'')
        with patch.object(runtime, 'inspect', return_value=state), patch.object(runtime, 'docker', return_value=result):
            with self.assertRaisesRegex(R.Refused, 'core-storage-probe-failed'):
                runtime.probe_core('positive')
        self.assertEqual(runtime.results, [{'case': 'positive', 'passed': False, 'phase': 'host-transport',
                                           'diagnostic': {'hostStatus': 409, 'metadataVerified': False}}])

    def test_host_observation_trace_is_optional_and_preserves_only_source_metadata(self):
        ast.parse(R.HOST_TRACE_BOOTSTRAP, feature_version=(3, 10))
        with tempfile.TemporaryDirectory(prefix='host-observation-trace-') as temporary:
            runtime = R.Runtime(Path('/checkout'), Path(temporary), Path('/manifest'), Path('/probe'))
            expected = {'module': 'orbis-host-app-storage.py', 'function': '_observe', 'line': 200, 'error': 'ValueError'}
            difference = {**expected, 'function': 'verify', 'differences': ['controller.definitionSha256'],
                          'mountOrderOnly': True, 'otherDefinitionFieldsEqual': True}
            mount = {**expected, 'function': 'mounts', 'mountInput': {'rootAbsolute': False,
                'destinationAbsolute': True, 'destinationCanonical': True, 'namespaceHandle': True, 'filesystem': 'nsfs'}}
            invalid_mount = {**mount, 'mountInput': {**mount['mountInput'], 'filesystem': '/private/location'}}
            extra = {**expected, 'privateValue': 'must-not-print'}
            ownership = {'module': 'orbis-host-ownership-bootstrap.py', 'function': 'dispatch', 'line': 465, 'error': 'ValueError'}
            log = b'private ordinary log\n' + b''.join(b'ORBIS_HOST_STORAGE_TRACE ' + json.dumps(row).encode() + b'\n'
                for row in (expected, difference, mount, ownership, {**ownership, 'privateValue': 'must-not-print'},
                            invalid_mount, extra, {**difference, 'differences': ['/private/location']},
                            {**expected, 'module': '/private/location'}, {**expected, 'line': -1}))
            (runtime.folder / 'host.private.log').write_bytes(log)
            with patch.dict(R.os.environ, {'ORBIS_HOST_STORAGE_TRACE': '0'}):
                self.assertEqual(runtime.host_trace_records(), [])
            with patch.dict(R.os.environ, {'ORBIS_HOST_STORAGE_TRACE': '1'}):
                self.assertEqual(runtime.host_trace_records(), [expected, difference, mount, ownership])

    def test_cleanup_has_no_authority_before_initial_inventory(self):
        runtime = self.runtime()
        with patch.object(runtime, 'docker') as docker:
            self.assertFalse(runtime.cleanup())
            docker.assert_not_called()

    def test_optional_ownership_trace_preserves_nested_exceptions_without_argument_data(self):
        import sys
        import threading
        from types import SimpleNamespace
        tree = ast.parse(R.HOST_TRACE_BOOTSTRAP)
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'trace')
        filename = '/fixture/orbis-host-ownership-bootstrap.py'
        captured = []
        scope = {'pathlib': __import__('pathlib'), 'local': threading.local(), 'count': 0,
            'files': {filename}, 'observation_file': '/fixture/orbis-host-app-storage.py', 'ownership_file': filename,
            'credential_modules': {'orbis-host-ownership-bootstrap.py'}, 'errors': {'ValueError'},
            'json': json, 'os': SimpleNamespace(write=lambda descriptor, body: captured.append(body))}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<bounded-trace>', 'exec'), scope)
        functions = {}
        exec(compile("def request(operation, data):\n"
                     "    if operation == 'change-admission': return request('ownership-check', data)\n"
                     "    raise ValueError('private-sensitive-message')\n", filename, 'exec'), functions)
        previous = sys.gettrace()
        try:
            sys.settrace(scope['trace'])
            with self.assertRaises(ValueError): functions['request']('change-admission', {'private': 'private-body'})
        finally:
            sys.settrace(previous)
        self.assertEqual(scope['local'].depth, 0)
        self.assertGreaterEqual(len(captured), 2)
        for body in captured:
            row = json.loads(body.split(b' ', 1)[1])
            self.assertEqual(set(row), {'module', 'function', 'line', 'error'})
            self.assertEqual(row['module'], 'orbis-host-ownership-bootstrap.py')
            self.assertEqual(row['error'], 'ValueError')
            self.assertNotIn(b'private-sensitive-message', body)
            self.assertNotIn(b'private-body', body)

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




class NormalSetupBoundaries(unittest.TestCase):
    def runtime(self, folder=Path('/checkout/.orbis-host-ABC123')):
        runtime = R.Runtime(Path('/checkout'), folder, Path('/manifest'), Path('/probe'), normal_setup=True)
        runtime.manifest = {'commit': 'a' * 40}
        return runtime

    def test_normal_setup_never_reaches_engine_without_linux_root_and_both_gates(self):
        for platform, uid, environment in (
            ('darwin', 0, {'ORBIS_HOST_STORAGE_TEST': '1', 'ORBIS_NORMAL_SETUP_TEST': '1'}),
            ('linux', 1000, {'ORBIS_HOST_STORAGE_TEST': '1', 'ORBIS_NORMAL_SETUP_TEST': '1'}),
            ('linux', 0, {'ORBIS_NORMAL_SETUP_TEST': '1'}),
        ):
            with self.subTest(platform=platform, uid=uid, environment=environment):
                runtime = self.runtime()
                with patch.object(R.sys, 'platform', platform), patch.object(R.os, 'geteuid', return_value=uid), \
                        patch.dict(R.os.environ, environment, clear=True), patch.object(runtime, 'docker') as docker:
                    with self.assertRaises(R.Refused): runtime.prepare()
                    docker.assert_not_called()

    def test_optional_setup_requires_its_own_gate_before_global_mount_operations(self):
        runtime = self.runtime()
        with patch.dict(R.os.environ, {'ORBIS_HOST_STORAGE_TEST': '1'}, clear=True), \
                patch.object(R, 'ProtectedScope') as scope:
            with self.assertRaisesRegex(R.Refused, 'explicit-normal-setup-gate-required'):
                runtime.prepare_installation(None)
            scope.assert_not_called()

    def test_scope_refuses_foreign_system_or_preexisting_state_before_mounting(self):
        for platform, uid, environment in (('darwin', 0, {'ORBIS_NORMAL_SETUP_TEST': '1'}),
                ('linux', 1000, {'ORBIS_NORMAL_SETUP_TEST': '1'}), ('linux', 0, {})):
            with self.subTest(platform=platform, uid=uid, gate=environment):
                scope = R.ProtectedScope(Path('/checkout'), Path('/checkout/.orbis-host-ABC123'))
                with patch.object(R.sys, 'platform', platform), patch.object(R.os, 'geteuid', return_value=uid), \
                        patch.dict(R.os.environ, environment, clear=True), patch.object(R, 'mount_command') as mount:
                    with self.assertRaises(R.Refused): scope.preflight()
                    mount.assert_not_called()

    def test_birth_hook_runs_on_empty_root_before_any_generated_installation_content(self):
        with tempfile.TemporaryDirectory(prefix='normal-setup-prepare-') as temporary:
            parent = Path(temporary)
            folder = parent / 'fixture'
            folder.mkdir(mode=0o700)
            manifest = parent / 'manifest.json'
            manifest.write_text(json.dumps({'schema': 'orbis.release.v1', 'image': R.IMAGE,
                'tag': 'v0.9.2-rc.5', 'commit': 'a' * 40, 'digest': 'sha256:' + 'b' * 64,
                'runtipiCompatibility': '4.10.1', 'installationProtocol': 'orbis.installation-state.v1'}))
            seen = []
            def observe(root):
                self.assertEqual(list(root.iterdir()), [])
                seen.append(root)
            prepared = F.prepare(manifest, folder, R.DEPENDENCIES, before_populate=observe, credential_socket=True)
            self.assertEqual(seen, [prepared['root']])
            self.assertIn('ORBIS_HOST_SOCKET=/run/orbis/host.sock', (prepared['root'] / '.env').read_text().splitlines())

    def test_default_fixture_does_not_request_credential_mutations(self):
        with tempfile.TemporaryDirectory(prefix='normal-setup-default-') as temporary:
            folder = Path(temporary) / 'fixture'
            folder.mkdir(mode=0o700)
            manifest = folder.parent / 'manifest.json'
            manifest.write_text(json.dumps({'schema': 'orbis.release.v1', 'image': R.IMAGE,
                'tag': 'v0.9.2-rc.5', 'commit': 'a' * 40, 'digest': 'sha256:' + 'b' * 64,
                'runtipiCompatibility': '4.10.1', 'installationProtocol': 'orbis.installation-state.v1'}))
            prepared = F.prepare(manifest, folder, R.DEPENDENCIES)
            self.assertNotIn('ORBIS_HOST_SOCKET=', (prepared['root'] / '.env').read_text())

    def test_failed_birth_hook_never_populates_installation(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory(prefix='normal-setup-failed-birth-') as temporary:
            folder = Path(temporary) / 'fixture'
            folder.mkdir(mode=0o700)
            manifest = folder.parent / 'manifest.json'
            manifest.write_text(json.dumps({'schema': 'orbis.release.v1', 'image': R.IMAGE,
                'tag': 'v0.9.2-rc.5', 'commit': 'a' * 40, 'digest': 'sha256:' + 'b' * 64,
                'runtipiCompatibility': '4.10.1', 'installationProtocol': 'orbis.installation-state.v1'}))
            hook = Mock(side_effect=R.Refused('real-birth-refused'))
            with self.assertRaisesRegex(R.Refused, 'real-birth-refused'):
                F.prepare(manifest, folder, R.DEPENDENCIES, before_populate=hook, credential_socket=True)
            self.assertEqual(list((folder / 'install').iterdir()), [])
            self.assertEqual(list(folder.iterdir()), [folder / 'install'])

    def test_active_or_changed_mount_prevents_cleanup_marker(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory(prefix='normal-setup-cleanup-') as temporary:
            runtime = self.runtime(Path(temporary))
            runtime.original_containers, runtime.original_networks = set(), set()
            runtime.normal_scope = Mock()
            def refuse():
                self.assertFalse((runtime.folder / 'cleanup-complete').exists())
                raise R.Refused('still-active')
            runtime.normal_scope.release.side_effect = refuse
            with patch.object(runtime, 'identifiers', return_value=set()), patch.object(runtime, 'docker') as docker:
                with self.assertRaisesRegex(R.Refused, 'still-active'): runtime.cleanup()
                docker.assert_not_called()
            self.assertFalse((runtime.folder / 'cleanup-complete').exists())

    def test_cleanup_marker_follows_owned_inventory_and_mount_release(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory(prefix='normal-setup-cleanup-') as temporary:
            runtime = self.runtime(Path(temporary))
            runtime.original_containers, runtime.original_networks = set(), set()
            runtime.normal_scope = Mock()
            def release(): self.assertFalse((runtime.folder / 'cleanup-complete').exists())
            runtime.normal_scope.release.side_effect = release
            with patch.object(runtime, 'identifiers', return_value=set()), patch.object(runtime, 'docker') as docker:
                self.assertTrue(runtime.cleanup())
                docker.assert_not_called()
            runtime.normal_scope.release.assert_called_once_with()
            self.assertTrue((runtime.folder / 'cleanup-complete').is_file())

    def test_changed_inventory_prevents_unmount_and_deletion(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory(prefix='normal-setup-inventory-') as temporary:
            runtime = self.runtime(Path(temporary))
            runtime.original_containers, runtime.original_networks = set(), set()
            runtime.normal_scope = Mock()
            with patch.object(runtime, 'identifiers', return_value={'f' * 64}), patch.object(runtime, 'docker') as docker:
                with self.assertRaisesRegex(R.Refused, 'original-inventory-changed'): runtime.cleanup()
                docker.assert_not_called()
            runtime.normal_scope.release.assert_not_called()
            self.assertFalse((runtime.folder / 'cleanup-complete').exists())

    def test_failed_api_check_is_failure_and_never_leaks_child_fields(self):
        runtime = self.runtime()
        runtime.owned['a' * 64] = ('runtipi', 'sha256:' + 'b' * 64, R.IMAGE + '@sha256:' + 'c' * 64)
        state = {'State': {'Status': 'running', 'Health': {'Status': 'healthy'}}}
        child = {'case': 'normal-setup-api', 'passed': False, 'completed': [],
                 'failurePhase': 'actual-first-registration', 'lastStatus': 503,
                 'privateValue': 'must-not-print'}
        result = subprocess.CompletedProcess([], 1, json.dumps(child).encode(), b'')
        with patch.object(runtime, 'inspect', return_value=state), patch.object(runtime, 'docker', return_value=result):
            with self.assertRaisesRegex(R.Refused, 'normal-setup-api-failed'): runtime.probe_normal_setup()
        self.assertEqual(runtime.results, [{'case': 'normal-setup-api', 'passed': False, 'completed': [],
            'failurePhase': 'actual-first-registration', 'lastStatus': 503}])

    def test_api_selects_only_the_live_host_only_cookie_after_legacy_domain_retirement(self):
        import shutil
        node = shutil.which('node')
        if not node: self.skipTest('Node.js is required for the real cookie parser')
        helper = R.NORMAL_SETUP_PROBE.split('function session(response) {', 1)[1].split('\ntry {', 1)[0]
        script = "import assert from 'node:assert/strict';\nfunction require(value) { assert.ok(value); }\nfunction session(response) {" + helper + r'''
const current = 'runtipi-sid=current-session; Path=/; HttpOnly; SameSite=Lax';
const retired = 'runtipi-sid=; Domain=.fixture.invalid; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
assert.equal(session({cookies: [retired, current]}), 'runtipi-sid=current-session');
assert.equal(session({cookies: [current]}), 'runtipi-sid=current-session');
for (const cookies of [[], [retired], [current, current], ['runtipi-sid=domain-only; Domain=.fixture.invalid']]) {
  assert.throws(() => session({cookies}));
}
assert.throws(() => session({cookies: ['runtipi-sid=bad\r\nvalue']}));
'''
        result = subprocess.run([node, '--input-type=module', '-e', script], capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, 'Actual normal-setup cookie parser regression')

    def test_out_of_order_or_invented_api_subchecks_are_not_accepted(self):
        runtime = self.runtime()
        runtime.owned['a' * 64] = ('runtipi', 'sha256:' + 'b' * 64, R.IMAGE + '@sha256:' + 'c' * 64)
        state = {'State': {'Status': 'running', 'Health': {'Status': 'healthy'}}}
        for completed in (['session-logout'], ['unknown'], 'session-logout'):
            child = {'case': 'normal-setup-api', 'passed': True, 'completed': completed}
            result = subprocess.CompletedProcess([], 0, json.dumps(child).encode(), b'')
            with self.subTest(completed=completed), patch.object(runtime, 'inspect', return_value=state), \
                    patch.object(runtime, 'docker', return_value=result):
                with self.assertRaisesRegex(R.Refused, 'invalid-normal-setup-case-sequence'): runtime.probe_normal_setup()
        self.assertEqual(runtime.results, [])


class HostEngineBoundaries(unittest.TestCase):
    def test_child_startup_diagnostic_reports_only_fixed_flags(self):
        result = subprocess.CompletedProcess([], 1, b'private body',
            b'Error: Cannot find module private-value\nReferenceError: private-sensitive-message')
        diagnostic = R.engine_probe_diagnostics(result)
        self.assertTrue(diagnostic['moduleResolutionError'])
        self.assertTrue(diagnostic['referenceError'])
        self.assertTrue(all(type(value) is bool for value in diagnostic.values()))
        self.assertNotIn('private', json.dumps(diagnostic))

    def runtime(self):
        runtime = R.Runtime(Path('/checkout'), Path('/checkout/.orbis-host-ABC123'), Path('/manifest'), Path('/probe'), host_engine=True)
        runtime.manifest = {'commit': 'a' * 40}
        runtime.owned['a' * 64] = ('runtipi', 'sha256:' + 'b' * 64, R.IMAGE + '@sha256:' + 'c' * 64)
        return runtime

    def test_optional_engine_requires_both_explicit_gates_before_engine_access(self):
        runtime = self.runtime()
        with patch.object(R.sys, 'platform', 'linux'), patch.object(R.os, 'geteuid', return_value=0), \
                patch.dict(R.os.environ, {'ORBIS_HOST_STORAGE_TEST': '1'}, clear=True), patch.object(runtime, 'docker') as docker:
            with self.assertRaisesRegex(R.Refused, 'explicit-host-engine-gate-required'): runtime.prepare()
            docker.assert_not_called()

    def test_disabled_or_unknown_engine_case_never_reaches_container_exec(self):
        runtime = self.runtime()
        for mode, environment in (('upgrade', {}), ('unknown', {'ORBIS_HOST_ENGINE_TEST': '1'})):
            with self.subTest(mode=mode), patch.dict(R.os.environ, environment, clear=True), patch.object(runtime, 'docker') as docker:
                with self.assertRaisesRegex(R.Refused, 'explicit-host-engine-gate-required'): runtime.probe_host_engine(mode)
                docker.assert_not_called()

    def test_engine_directory_preparation_creates_only_named_empty_synthetic_cases(self):
        with tempfile.TemporaryDirectory(prefix='host-engine-prepare-') as temporary:
            parent = Path(temporary)
            folder = parent / 'fixture'
            folder.mkdir(mode=0o700)
            manifest = parent / 'manifest.json'
            manifest.write_text(json.dumps({'schema': 'orbis.release.v1', 'image': R.IMAGE,
                'tag': 'v0.9.2-rc.6', 'commit': 'a' * 40, 'digest': 'sha256:' + 'b' * 64,
                'runtipiCompatibility': '4.10.1', 'installationProtocol': 'orbis.installation-state.v1'}))
            prepared = F.prepare(manifest, folder, R.DEPENDENCIES, host_engine=True)
            for name in ('engine-upgrade', 'engine-rollback'):
                directory = prepared['root'] / 'app-data/fixture' / name
                self.assertEqual([p.name for p in directory.iterdir()], ['marker'])
                self.assertEqual((directory / 'marker').read_text(), 'scoped fixture\n')
            self.assertNotIn('ORBIS_HOST_SOCKET=', (prepared['root'] / '.env').read_text())

    def test_failed_engine_output_is_bounded_and_never_treated_as_acceptance(self):
        runtime = self.runtime()
        state = {'Image': 'same', 'State': {'StartedAt': 'same', 'Status': 'running', 'Health': {'Status': 'healthy'}}}
        child = {'case': 'host-engine-upgrade', 'passed': False, 'cleanup': True, 'modeledHost': False,
            'mainWorkerTested': False, 'productionTouched': False, 'failurePhase': 'actual-isolated-migration', 'private': 'must-not-print'}
        result = subprocess.CompletedProcess([], 1, json.dumps(child).encode(), b'')
        with patch.dict(R.os.environ, {'ORBIS_HOST_ENGINE_TEST': '1'}), patch.object(runtime, 'inspect', return_value=state), \
                patch.object(runtime, 'docker', return_value=result):
            with self.assertRaisesRegex(R.Refused, 'host-engine-probe-failed'): runtime.probe_host_engine('upgrade')
        self.assertEqual(runtime.results, [{'case': 'host-engine-upgrade', 'passed': False, 'cleanup': True,
            'failurePhase': 'actual-isolated-migration', 'modeledHost': False, 'mainWorkerTested': False}])

    def test_cleanup_model_and_worker_claims_cannot_be_used_as_real_engine_acceptance(self):
        state = {'Image': 'same', 'State': {'StartedAt': 'same', 'Status': 'running', 'Health': {'Status': 'healthy'}}}
        for change in ({'cleanup': False}, {'modeledHost': True}, {'mainWorkerTested': True}, {'failurePhase': 'actual-isolated-migration'}):
            runtime = self.runtime()
            child = {'case': 'host-engine-upgrade', 'passed': True, 'cleanup': True, 'modeledHost': False,
                'mainWorkerTested': False, 'productionTouched': False, **change}
            result = subprocess.CompletedProcess([], 0, json.dumps(child).encode(), b'')
            with self.subTest(change=change), patch.dict(R.os.environ, {'ORBIS_HOST_ENGINE_TEST': '1'}), \
                    patch.object(runtime, 'inspect', return_value=state), patch.object(runtime, 'docker', return_value=result):
                with self.assertRaisesRegex(R.Refused, 'host-engine-probe-failed'): runtime.probe_host_engine('upgrade')
            self.assertFalse(runtime.results[0]['passed'])

    def test_success_is_not_recorded_if_the_controller_restarted(self):
        runtime = self.runtime()
        state = {'Image': 'same', 'State': {'StartedAt': 'before', 'Status': 'running', 'Health': {'Status': 'healthy'}}}
        changed = {'Image': 'same', 'State': {**state['State'], 'StartedAt': 'after'}}
        child = {'case': 'host-engine-upgrade', 'passed': True, 'cleanup': True, 'modeledHost': False,
            'mainWorkerTested': False, 'productionTouched': False}
        result = subprocess.CompletedProcess([], 0, json.dumps(child).encode(), b'')
        with patch.dict(R.os.environ, {'ORBIS_HOST_ENGINE_TEST': '1'}), patch.object(runtime, 'inspect', side_effect=[state, changed]), \
                patch.object(runtime, 'docker', return_value=result):
            with self.assertRaisesRegex(R.Refused, 'host-engine-controller-changed'): runtime.probe_host_engine('upgrade')
        self.assertEqual(runtime.results, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
