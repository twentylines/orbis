import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
import struct
import tarfile
import time
import socket
import threading
import unittest
from pathlib import Path
from unittest import mock

from test_orbis_controller_identity import fixture
import test_orbis_host_controller_config as CONFIG
from test_orbis_host_app_runtime import fixture as app_fixture

S = CONFIG.SERVICE
A = S.CAPTURE_AUTHORITY
P = S.CONTROLLER_IDENTITY


def tar_bytes(entries):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode='w') as archive:
        for name, body in entries.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(body)
            archive.addfile(entry, io.BytesIO(body))
    return result.getvalue()


class CaptureAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.fixture = CONFIG.ControllerConfigTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.service = self.fixture.service
        self.addCleanup(self.close_fence)
        self.layers = [tar_bytes({'fixture-' + str(i): ('layer-' + str(i)).encode()}) for i in range(2)]
        self.compressed = [gzip.compress(body, mtime=0) for body in self.layers]
        self.diff_ids = [P.digest(body) for body in self.layers]
        layer_descriptors = [{'mediaType': 'application/vnd.oci.image.layer.v1.tar+gzip', 'digest': P.digest(body), 'size': len(body)} for body in self.compressed]
        self.release, self.blobs = fixture(config_change=lambda config: config['rootfs'].update(diff_ids=self.diff_ids),
                                           manifest_change=lambda manifest: manifest.update(layers=layer_descriptors))
        self.graph = P.verify_published_graph(self.release, **self.blobs)
        self.proof = self.graph.proof()
        self.fixture.image = self.graph.config_digest
        self.fixture.identity.update(imageId=self.fixture.image, imageReference=self.release['image'] + '@' + self.release['digest'])
        saved = S.HOST.saved_state(self.fixture.root)
        saved.update(tag=self.release['tag'], digest=self.release['digest'])
        S.HOST.write_state(self.fixture.root, saved)
        self.local = dict(Id=self.fixture.image, Os='linux', Architecture='arm64', Variant='',
                          RepoDigests=[self.fixture.identity['imageReference']], RootFS=dict(Type='layers', Layers=self.diff_ids),
                          Config=json.loads(self.blobs['config_bytes'])['config'])
        self.fixture.docker.side_effect = lambda context, args, root: mock.Mock(returncode=0, stdout=json.dumps(self.local if args[0] == 'image' else self.fixture.identity))
        self.worker = self.enterContext(mock.patch.object(P, 'produce_bounded_publication', return_value=self.proof))
        before = self.fixture.capture()
        self.request = dict(pointId=self.fixture.point, controllerId=self.fixture.controller, imageId=self.fixture.image,
                            configurationSetSha256=before['configurationSetSha256'])
        self.preparation = self.service.prepare_controller_publication(self.request)
        self.token = 'e' * 64
        fence_request = {**self.request, 'preparationSha256': self.preparation['preparationSha256'], 'clientKey': self.token}
        if getattr(self, 'capture_v3', False) or self._testMethodName.startswith('test_app_runtime_') or self._testMethodName == 'test_actual_unix_handler_v3_routes_preserve_raw_bytes_and_deny_untrusted_peer':
            # Development exports may be group-writable. Exercise the actual
            # protected reader against an installed-mode copy, not a hash mock.
            self.native_scripts = self.fixture.base / 'native-scripts'
            self.native_scripts.mkdir(mode=0o700)
            capabilities = S.TIME_MACHINE_CAPABILITIES
            for source in Path(__file__).parent.iterdir():
                if source.is_file() and capabilities.NAMES.fullmatch(source.name):
                    target = self.native_scripts / source.name
                    target.write_bytes(source.read_bytes()); target.chmod(0o600)
            reader = capabilities.source_digest
            self.enterContext(mock.patch.object(capabilities, 'source_digest', side_effect=lambda authority, **_: reader(authority, directory=self.native_scripts)))
            fence_request['captureContractSha256'] = self.service.time_machine_capability('capture')['contractSha256']
        self.fence_reply = self.service.acquire_capture_fence(fence_request)
        self.entries = {'index.json': self.blobs['index_bytes'], 'oci-layout': b'{"imageLayoutVersion":"1.0.0"}',
                        'blobs/sha256/' + self.graph.manifest_digest[7:]: self.blobs['manifest_bytes'],
                        'blobs/sha256/' + self.graph.config_digest[7:]: self.blobs['config_bytes']}
        self.entries.update({'blobs/sha256/' + P.digest(body)[7:]: body for body in self.compressed})
        self.entries['manifest.json'] = P.canonical({'items': []})  # replaced with the Docker-compatible list below
        self.entries['manifest.json'] = json.dumps([dict(Config='blobs/sha256/' + self.graph.config_digest[7:], RepoTags=None,
              Layers=['blobs/sha256/' + P.digest(body)[7:] for body in self.compressed])], separators=(',', ':')).encode()
        self.archive = tar_bytes(self.entries)

    def close_fence(self):
        if self.service.capture_fence_fd is not None:
            os.close(self.service.capture_fence_fd)
            self.service.capture_fence_fd = None

    def finalize(self, body=None, stream=None):
        body = self.archive if body is None else body
        return self.service.finalize_controller_capture_authority(self.fixture.point, self.token, stream or io.BytesIO(body), len(body))

    def authority_path(self):
        return self.fixture.state / 'controller-capture-authorities' / self.fixture.point

    def test_original_host_preparation_is_immutable_and_outside_container_root(self):
        prepared = A.load_preparation(self.fixture.state, self.fixture.point)
        self.assertEqual(prepared['publicationReceipt'], self.preparation)
        self.assertFalse(self.authority_path().is_relative_to(self.fixture.root))
        changed = copy.deepcopy(prepared['configuration'])
        changed['controller']['imageId'] = 'sha256:' + '9' * 64
        with self.assertRaises(ValueError):
            A.capture_preparation(self.fixture.state, self.fixture.root, 'fixture', changed, self.preparation)
        self.assertEqual(A.load_preparation(self.fixture.state, self.fixture.point), prepared)

    def test_saved_oci_descriptor_can_omit_platform_only_with_exact_protected_config(self):
        entries = copy.deepcopy(self.entries)
        index = json.loads(entries['index.json'])
        selected = next(item for item in index['manifests'] if item['digest'] == self.graph.manifest_digest)
        selected.pop('platform')
        entries['index.json'] = P.canonical(index)
        result = self.finalize(tar_bytes(entries))
        self.assertEqual(result['platform'], json.loads(self.graph.platform_bytes))
        self.assertEqual(result['archive']['archiveRootId'], P.digest(entries['index.json']))
        for platform in (None, {'os': 'linux', 'architecture': 'amd64'}):
            selected['platform'] = platform
            entries['index.json'] = P.canonical(index)
            path = self.fixture.base / 'conflicting-saved-platform.tar'
            path.write_bytes(tar_bytes(entries))
            path.chmod(0o600)
            with self.assertRaises(ValueError):
                A.verify_archive(path, self.graph, time.monotonic() + 30)

    def docker_attestation(self, *, wrong_subject=False, wrong_diff=False, conflicting_predicate=False, runnable_platform=False):
        entries = copy.deepcopy(self.entries)
        statement = {'_type': 'https://in-toto.io/Statement/v1', 'subject': [{'name': 'fixture', 'digest': {'sha256': ('e' * 64 if wrong_subject else self.graph.manifest_digest[7:])}}],
                     'predicateType': 'https://spdx.dev/Document', 'predicate': {'fixturePadding': 'x' * (P.METADATA_BYTES + 128)}}
        payload = P.canonical(statement)
        layer = {'mediaType': 'application/vnd.in-toto+json', 'digest': P.digest(payload), 'size': len(payload),
                 'annotations': {'in-toto.io/predicate-type': 'conflicting-fixture' if conflicting_predicate else statement['predicateType']}}
        config = P.canonical({'architecture': 'unknown', 'os': 'unknown', 'config': {}, 'rootfs': {'type': 'layers', 'diff_ids': ['sha256:' + 'e' * 64 if wrong_diff else layer['digest']]}})
        manifest = P.canonical({'schemaVersion': 2, 'mediaType': P.OCI_MANIFEST, 'config': {'mediaType': P.OCI_CONFIG, 'digest': P.digest(config), 'size': len(config)}, 'layers': [layer]})
        for body in (payload, config, manifest):
            entries['blobs/sha256/' + P.digest(body)[7:]] = body
        index = json.loads(entries['index.json'])
        index['manifests'].append({'mediaType': P.OCI_MANIFEST, 'digest': P.digest(manifest), 'size': len(manifest),
            'platform': {'os': 'linux', 'architecture': 'arm64'} if runnable_platform else {'os': 'unknown', 'architecture': 'unknown'},
            'annotations': {'io.containerd.manifest.subject': self.graph.manifest_digest}})
        entries['index.json'] = P.canonical(index)
        return tar_bytes(entries)

    def test_docker_attestation_form_binds_all_subjects_and_diff_ids_with_bounded_large_sbom(self):
        result = self.finalize(self.docker_attestation())
        self.assertEqual(result['archive']['platformManifestDigest'], self.graph.manifest_digest)
        for mutation in ('wrong_subject', 'wrong_diff', 'conflicting_predicate', 'runnable_platform'):
            path = self.fixture.base / ('invalid-' + mutation + '.tar')
            path.write_bytes(self.docker_attestation(**{mutation: True}))
            path.chmod(0o600)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                A.verify_archive(path, self.graph, time.monotonic() + 30)
        with self.assertRaises(ValueError):
            A.attestation_metadata(b'x' * (16 * 1024 * 1024 + 1))
        with self.assertRaises(ValueError):
            A.attestation_metadata(b'{"a":1,"a":2}')

    def proxy_fixture(self):
        value = {'schema': 'orbis.proxy-host-identity-policy.v1', 'policy': 'preserve-live-proxy-identity.v1',
                 'rootSha256': hashlib.sha256(str(self.fixture.root).encode()).hexdigest(), 'dockerContextSha256': hashlib.sha256(b'fixture').hexdigest(),
                 'configuration': {'destination': '/etc/traefik', 'readOnly': True, 'staticSha256': '1' * 64, 'capture': 'encrypted-review-only', 'restore': 'preserve-live'},
                 'mutableIdentity': {'destination': '/shared', 'capture': 'excluded', 'restore': 'preserve-live', 'ownershipSha256': '2' * 64},
                 'proxy': {'containerId': '9' * 64, 'imageId': 'sha256:' + '8' * 64}}
        return {**value, 'sha256': hashlib.sha256(b'orbis.proxy-host-identity-policy.v1\n' + P.canonical(value)).hexdigest()}

    def proxy_request(self):
        return {'token': self.token, 'configurationSetSha256': self.request['configurationSetSha256'],
                'preparationSha256': self.preparation['preparationSha256'], 'publicationProofSha256': hashlib.sha256(P.canonical(self.preparation)).hexdigest()}

    def app_fixture(self):
        value, _ = app_fixture()
        value.pop('sha256')
        prepared = A.load_preparation(self.fixture.state, self.fixture.point)
        expected = A.app_expectations(prepared, 'c' * 64)
        value.update(expected)
        return A.APP.seal(value, expected)

    def test_app_runtime_root_prepare_blob_and_finalization_use_independent_observations(self):
        original = self.app_fixture()
        stopped = copy.deepcopy(original); stopped.pop('sha256')
        for item in stopped['containers']: item['wasRunning'] = False
        stopped = A.APP.seal(stopped, A.app_expectations(A.load_preparation(self.fixture.state, self.fixture.point), 'c' * 64))
        def observe(*_):
            self.assertTrue(self.service.lock.acquire(blocking=False), 'bounded observation must not block fence renewals')
            self.service.lock.release()
            return original
        with mock.patch.object(self.service, 'proxy_host_identity', return_value={'version': 1, 'descriptor': self.proxy_fixture()}), \
                mock.patch.object(A.APP, 'observe', side_effect=observe) as observer:
            summary = self.service.prepare_controller_app_runtime(self.fixture.point, self.proxy_request())
            self.assertEqual(summary['version'], 3)
            self.assertEqual(summary['appRuntimeSha256'], hashlib.sha256(A.APP.canonical(original)).hexdigest())
            self.assertEqual(self.service.prepare_controller_app_runtime(self.fixture.point, self.proxy_request()), summary)
            self.assertEqual(observer.call_count, 1)
            request = {**self.proxy_request(), 'appRuntimeSha256': summary['appRuntimeSha256']}
            self.assertEqual(self.service.controller_app_runtime_bytes(self.fixture.point, request), A.APP.canonical(original))
            with self.assertRaises(ValueError):
                self.service.controller_app_runtime_bytes(self.fixture.point, {**request, 'token': '0' * 64})
            with self.assertRaises(ValueError):
                self.service.controller_app_runtime_bytes(self.fixture.point, {**request, 'appRuntimeSha256': '0' * 64})
            observer.side_effect = lambda *_: stopped
            final = self.service.finalize_controller_capture_authority(self.fixture.point, self.token, io.BytesIO(self.archive),
                                                                       len(self.archive), proxy_policy=True, app_policy=True)
        self.assertEqual(final['version'], 4)
        self.assertEqual(final['appRuntimeSha256'], summary['appRuntimeSha256'])
        self.assertEqual(final['appRuntimeDaemonSha256'], 'c' * 64)
        self.assertEqual(json.loads(A.load_effective_origin(self.fixture.state, self.fixture.root, 'fixture', self.fixture.point).authority_bytes), final)
        recovered = self.service.recover_controller_capture_authority(self.fixture.point, self.proxy_request(), proxy_policy=True, app_policy=True)
        self.assertEqual(recovered, {'version': 3, 'state': 'finalized', 'authority': final})
        self.assertNotIn('apps', final)
        self.assertNotIn('Env', json.dumps(final))

    def test_app_runtime_finalize_rejects_running_app_or_changed_saved_database_state(self):
        original = self.app_fixture()
        with mock.patch.object(self.service, 'proxy_host_identity', return_value={'version': 1, 'descriptor': self.proxy_fixture()}), \
                mock.patch.object(A.APP, 'observe', return_value=original) as observer:
            self.service.prepare_controller_app_runtime(self.fixture.point, self.proxy_request())
            for change in ('running', 'saved-config', 'database-status', 'daemon'):
                altered = copy.deepcopy(original); altered.pop('sha256')
                for item in altered['containers']: item['wasRunning'] = False
                if change == 'running': altered['containers'][0]['wasRunning'] = True
                if change == 'saved-config': altered['apps'][0]['pendingRestart'] = False
                if change == 'database-status': altered['apps'][0]['status'] = 'stopped'
                if change == 'daemon': altered['daemonSha256'] = 'f' * 64
                expected = {key: altered[key] for key in A.app_expectations(A.load_preparation(self.fixture.state, self.fixture.point), altered['daemonSha256'])}
                observer.return_value = A.APP.seal(altered, expected)
                with self.subTest(change=change), self.assertRaises(ValueError):
                    self.service.finalize_controller_capture_authority(self.fixture.point, self.token, io.BytesIO(self.archive),
                                                                       len(self.archive), proxy_policy=True, app_policy=True)
                self.assertFalse((self.authority_path() / 'app-finalized.json').exists())

    def test_app_runtime_corrupt_private_entry_never_falls_back_to_older_authority(self):
        original = self.app_fixture()
        with mock.patch.object(self.service, 'proxy_host_identity', return_value={'version': 1, 'descriptor': self.proxy_fixture()}), \
                mock.patch.object(A.APP, 'observe', return_value=original):
            self.service.prepare_controller_app_runtime(self.fixture.point, self.proxy_request())
        path = self.authority_path() / 'app-runtime.json'
        path.write_bytes(path.read_bytes() + b' ')
        with self.assertRaises(ValueError):
            A.load_app_preparation(self.fixture.state, self.fixture.point, A.load_preparation(self.fixture.state, self.fixture.point))

    def test_actual_unix_handler_v3_routes_preserve_raw_bytes_and_deny_untrusted_peer(self):
        endpoint = self.fixture.base / 'app-capture.sock'
        server = S.UnixHTTPServer(str(endpoint), S.Handler); server.service = self.service
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        def request(action, value):
            body = P.canonical(value)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.connect(str(endpoint))
                path = '/v3/controller-capture-authority/' + self.fixture.point + '/' + action
                connection.sendall(('POST ' + path + ' HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: '
                                    + str(len(body)) + '\r\n\r\n').encode() + body)
                chunks = []
                while block := connection.recv(65536): chunks.append(block)
            return b''.join(chunks).split(b'\r\n\r\n', 1)
        original = self.app_fixture()
        with mock.patch.object(S, 'trusted_capture_peer', return_value=True), \
                mock.patch.object(self.service, 'proxy_host_identity', return_value={'version': 1, 'descriptor': self.proxy_fixture()}), \
                mock.patch.object(A.APP, 'observe', return_value=original):
            headers, body = request('prepare', self.proxy_request())
            self.assertIn(b'200 OK', headers); summary = json.loads(body)
            headers, body = request('app-runtime', {**self.proxy_request(), 'appRuntimeSha256': summary['appRuntimeSha256']})
            self.assertIn(b'Content-Type: application/json', headers); self.assertIn(b'Cache-Control: no-store', headers)
            self.assertIn(('Content-Length: ' + str(len(body))).encode(), headers)
            self.assertEqual(body, A.APP.canonical(original))
            headers, body = request('recover', self.proxy_request())
            self.assertEqual(json.loads(body), {'version': 3, 'state': 'prepared'})
        with mock.patch.object(S, 'trusted_capture_peer', return_value=False):
            headers, body = request('app-runtime', {**self.proxy_request(), 'appRuntimeSha256': summary['appRuntimeSha256']})
            self.assertIn(b'409 Conflict', headers); self.assertNotIn(b'MODE=running-old', body)

    def test_proxy_authority_v2_pins_independent_layout_without_changing_v1(self):
        descriptor = self.proxy_fixture()
        with mock.patch.object(self.service, 'proxy_host_identity', return_value={'version': 1, 'descriptor': descriptor}):
            prepared = self.service.prepare_controller_proxy_identity(self.fixture.point, self.proxy_request())
            result = self.service.finalize_controller_capture_authority(self.fixture.point, self.token, io.BytesIO(self.archive), len(self.archive), proxy_policy=True)
        self.assertEqual(prepared['proxyHostIdentity'], descriptor)
        self.assertEqual(result['schema'], 'orbis.controller-capture-authority.v2')
        self.assertEqual(result['proxyHostIdentity'], descriptor)
        self.assertEqual(json.loads(A.load_origin(self.fixture.state, self.fixture.root, 'fixture', self.fixture.point).authority_bytes)['schema'], 'orbis.controller-capture-authority.v1')
        self.assertEqual(json.loads(A.load_proxy_origin(self.fixture.state, self.fixture.root, 'fixture', self.fixture.point).authority_bytes), result)
        self.assertEqual(self.service.recover_controller_capture_authority(self.fixture.point, self.proxy_request(), proxy_policy=True)['authority'], result)
        changed = copy.deepcopy(descriptor)
        changed['configuration']['readOnly'] = False
        with mock.patch.object(self.service, 'proxy_host_identity', return_value={'version': 1, 'descriptor': changed}), self.assertRaises(ValueError):
            self.service.finalize_controller_capture_authority(self.fixture.point, self.token, io.BytesIO(self.archive), len(self.archive), proxy_policy=True)

    def test_proxy_capture_rejects_wrong_fence_and_does_not_promote_partial_v2(self):
        with mock.patch.object(self.service, 'proxy_host_identity', return_value={'version': 1, 'descriptor': self.proxy_fixture()}):
            with self.assertRaises(ValueError):
                self.service.prepare_controller_proxy_identity(self.fixture.point, {**self.proxy_request(), 'token': '0' * 64})
            self.service.prepare_controller_proxy_identity(self.fixture.point, self.proxy_request())
        self.assertEqual(self.service.recover_controller_capture_authority(self.fixture.point, self.proxy_request(), proxy_policy=True)['state'], 'prepared')
        self.finalize()
        self.assertEqual(self.service.recover_controller_capture_authority(self.fixture.point, self.proxy_request(), proxy_policy=True)['state'], 'verified-uncommitted')
        self.assertFalse((self.authority_path() / 'proxy-finalized.json').exists())

    def test_root_finalizes_actual_archive_layers_and_returns_only_bounded_identity(self):
        result = self.finalize()
        self.assertEqual(result['archive']['sha256'], hashlib.sha256(self.archive).hexdigest())
        self.assertEqual(result['archive']['creationReference'], self.graph.manifest_digest)
        self.assertEqual(result['archive']['sourceImageId'], self.graph.config_digest)
        self.assertEqual(result['archive']['archiveRootId'], P.digest(self.blobs['index_bytes']))
        self.assertEqual(result['publicationProofSha256'], hashlib.sha256(P.canonical(self.preparation)).hexdigest())
        unhashed = {key: value for key, value in result.items() if key != 'authoritySha256'}
        self.assertEqual(result['authoritySha256'], hashlib.sha256(b'orbis.controller-capture-authority.v1\n' + P.canonical(unhashed)).hexdigest())
        self.assertEqual(json.loads(A.read(self.authority_path(), 'finalized.json', A.RECEIPT_LIMIT)), result)
        encoded = P.canonical(result)
        self.assertLess(len(encoded), A.RECEIPT_LIMIT)
        self.assertNotIn(b'.env', encoded)
        self.assertNotIn(str(self.fixture.root).encode(), encoded)
        self.assertNotIn(b'fixture_private', encoded.lower())
        self.assertFalse(list(self.authority_path().glob('.controller-archive-*')))

    def test_retry_is_idempotent_but_different_valid_archive_cannot_replace_authority(self):
        before = self.finalize()
        self.assertEqual(self.finalize(), before)
        entries = dict(self.entries)
        index = json.loads(entries['index.json'])
        index['annotations'] = {'fixture': 'another byte generation'}
        entries['index.json'] = P.canonical(index)
        with self.assertRaises(ValueError):
            self.finalize(tar_bytes(entries))
        self.assertEqual(json.loads(A.read(self.authority_path(), 'finalized.json', A.RECEIPT_LIMIT)), before)

    def test_compressed_bytes_diffids_and_extra_archive_objects_are_rejected(self):
        mutations = []
        changed = dict(self.entries)
        key = 'blobs/sha256/' + P.digest(self.compressed[0])[7:]
        changed[key] = changed[key][:-1] + bytes([changed[key][-1] ^ 1])
        mutations.append(changed)
        changed = dict(self.entries)
        changed['unreviewed-image.json'] = b'{}'
        mutations.append(changed)
        changed = dict(self.entries)
        mapped = json.loads(changed['manifest.json'])
        mapped[0]['Layers'] = list(reversed(mapped[0]['Layers']))
        changed['manifest.json'] = json.dumps(mapped).encode()
        mutations.append(changed)
        for entries in mutations:
            with self.subTest(names=list(entries)), self.assertRaises(ValueError):
                self.finalize(tar_bytes(entries))
        self.assertFalse((self.authority_path() / 'finalized.json').exists())

    def test_root_rejects_wrong_uncompressed_diffids_and_injected_image_aliases(self):
        def wrong_config(config):
            config['rootfs']['diff_ids'] = ['sha256:' + '9' * 64, self.diff_ids[1]]
        descriptors = [{'mediaType': 'application/vnd.oci.image.layer.v1.tar+gzip', 'digest': P.digest(body), 'size': len(body)} for body in self.compressed]
        release, blobs = fixture(config_change=wrong_config, manifest_change=lambda manifest: manifest.update(layers=descriptors))
        graph = P.verify_published_graph(release, **blobs)
        entries = {key: value for key, value in self.entries.items() if key not in ('index.json', 'manifest.json',
                   'blobs/sha256/' + self.graph.manifest_digest[7:], 'blobs/sha256/' + self.graph.config_digest[7:])}
        entries.update({'index.json': blobs['index_bytes'], 'blobs/sha256/' + graph.manifest_digest[7:]: blobs['manifest_bytes'],
                        'blobs/sha256/' + graph.config_digest[7:]: blobs['config_bytes']})
        bad = self.authority_path() / 'wrong-diff.tar'
        bad.write_bytes(tar_bytes(entries))
        bad.chmod(0o600)
        with self.assertRaises(ValueError):
            A.verify_archive(bad, graph, time.monotonic() + 30)
        for alias in ('repo-tag', 'oci-reference'):
            entries = dict(self.entries)
            if alias == 'repo-tag':
                mapped = json.loads(entries['manifest.json'])
                mapped[0]['RepoTags'] = ['unrelated/image:latest']
                entries['manifest.json'] = json.dumps(mapped).encode()
            else:
                index = json.loads(entries['index.json'])
                index['manifests'][0]['annotations'] = {'org.opencontainers.image.ref.name': 'unrelated/image:latest'}
                entries['index.json'] = P.canonical(index)
            with self.subTest(alias=alias), self.assertRaises(ValueError):
                self.finalize(tar_bytes(entries))

    def test_point_bound_recovery_is_read_only_and_crash_retry_preserves_original_receipt(self):
        request = dict(token=self.token, configurationSetSha256=self.request['configurationSetSha256'],
                       preparationSha256=self.preparation['preparationSha256'],
                       publicationProofSha256=hashlib.sha256(P.canonical(self.preparation)).hexdigest())
        self.assertEqual(self.service.recover_controller_capture_authority(self.fixture.point, request), {'version': 1, 'state': 'prepared'})
        immutable = A.immutable
        def interrupted(path, body):
            if path.name == 'finalized.json':
                raise OSError('injected crash before root finalized commit')
            return immutable(path, body)
        with mock.patch.object(A, 'immutable', side_effect=interrupted), self.assertRaises(OSError):
            self.finalize()
        response = self.service.recover_controller_capture_authority(self.fixture.point, request)
        self.assertEqual(response, {'version': 1, 'state': 'verified-uncommitted'})
        planned = json.loads(A.read(self.authority_path(), 'finalization.json', A.RECEIPT_LIMIT))['authority']
        self.assertEqual(self.finalize(), planned)
        response = self.service.recover_controller_capture_authority(self.fixture.point, request)
        self.assertEqual(response['state'], 'finalized')
        self.assertEqual(response['authority'], planned)
        origin = A.load_origin(self.fixture.state, self.fixture.root, 'fixture', self.fixture.point)
        self.assertEqual(json.loads(origin.authority_bytes), planned)
        self.assertEqual(json.loads(origin.publication_receipt_bytes), self.preparation)
        with self.assertRaises(ValueError):
            A.load_origin(self.fixture.state, self.fixture.root, 'another-context', self.fixture.point)
        # A completed root producer receipt remains available after cleanup; it
        # neither needs nor reconstructs a current controller or capture fence.
        self.service.maintain_capture_fence('release', self.token)
        self.assertEqual(self.service.recover_controller_capture_authority(self.fixture.point, request), response)
        for key in request:
            changed = dict(request)
            changed[key] = '9' * 64
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.service.recover_controller_capture_authority(self.fixture.point, changed)

    def test_upload_allows_owned_lease_renewal_and_rechecks_configuration_after_stream(self):
        service, token, archive = self.service, self.token, self.archive
        class Renewing(io.BytesIO):
            checked = False
            def read(inner, size=-1):
                if not inner.checked:
                    inner.checked = True
                    self.assertTrue(service.lock.acquire(blocking=False))
                    service.lock.release()
                    self.assertIn('expiresAt', service.maintain_capture_fence('renew', token))
                return super().read(size)
        self.finalize(stream=Renewing(archive))
        env = self.fixture.root / '.env'
        original = env.read_bytes()
        class Mutating(io.BytesIO):
            changed = False
            def read(inner, size=-1):
                value = super().read(size)
                if not inner.changed:
                    inner.changed = True
                    env.write_bytes(original + b'changed')
                return value
        with self.assertRaises(ValueError):
            self.finalize(stream=Mutating(archive))

    def test_missing_root_preparation_truncated_upload_and_wrong_fence_fail_closed(self):
        with self.assertRaises(ValueError):
            self.service.finalize_controller_capture_authority(self.fixture.point, 'f' * 64, io.BytesIO(self.archive), len(self.archive))
        with self.assertRaises(ValueError):
            self.finalize(stream=io.BytesIO(self.archive[:-1]))
        path = self.authority_path() / 'prepared.json'
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.finalize()
        self.assertFalse((self.authority_path() / 'finalized.json').exists())

    def test_root_staging_checks_its_own_disk_reserve_before_upload(self):
        with mock.patch.object(S.os, 'statvfs', return_value=mock.Mock(f_bavail=0, f_frsize=4096)), self.assertRaises(ValueError):
            self.finalize()
        self.assertFalse(list(self.authority_path().glob('.controller-archive-*')))
        self.assertFalse((self.authority_path() / 'finalized.json').exists())

    def test_raw_route_requires_real_privileged_peer_fixed_path_and_tar_length(self):
        handler = S.Handler.__new__(S.Handler)
        handler.path = '/v1/controller-capture-authority/' + self.fixture.point + '/finalize'
        handler.headers = {'Content-Length': str(len(self.archive)), 'Content-Type': 'application/x-tar', 'X-Orbis-Capture-Token': self.token}
        handler.rfile = io.BytesIO(self.archive)
        handler.connection = mock.Mock()
        handler.server = mock.Mock()
        handler.server.service.finalize_controller_capture_authority.return_value = {'fixture': True}
        handler.send_json = mock.Mock()
        with mock.patch.object(S, 'trusted_capture_peer', return_value=False):
            handler.do_POST()
        self.assertEqual(handler.send_json.call_args.args[0], 409)
        handler.server.service.finalize_controller_capture_authority.assert_not_called()
        with mock.patch.object(S, 'trusted_capture_peer', return_value=True):
            handler.do_POST()
        self.assertEqual(handler.send_json.call_args.args[0], 200)
        handler.server.service.finalize_controller_capture_authority.assert_called_once_with(self.fixture.point, self.token, handler.rfile, len(self.archive))
        handler.server.service.finalize_controller_capture_authority.reset_mock()
        handler.headers['Content-Length'] = '-1'
        with mock.patch.object(S, 'trusted_capture_peer', return_value=True):
            handler.do_POST()
        self.assertEqual(handler.send_json.call_args.args[0], 409)
        handler.server.service.finalize_controller_capture_authority.assert_not_called()

    def test_kernel_peer_check_never_uses_client_identity_headers(self):
        connection = mock.Mock()
        with mock.patch.object(S.socket, 'SO_PEERCRED', 17, create=True), mock.patch.object(S.os, 'geteuid', return_value=0):
            connection.getsockopt.return_value = struct.pack('3i', 123, 0, 0)
            self.assertTrue(S.trusted_capture_peer(connection))
            connection.getsockopt.return_value = struct.pack('3i', 123, 501, 0)
            self.assertFalse(S.trusted_capture_peer(connection))


if __name__ == '__main__':
    unittest.main()
