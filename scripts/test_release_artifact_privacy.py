import base64
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import os
import struct
import tarfile
import tempfile
import unittest
import urllib.error
import zipfile
import zlib
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location('privacy', Path(__file__).with_name('release-artifact-privacy.py'))
SCAN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCAN)
TAG = 'v0.6.0-beta.1'
COMMIT = 'a' * 40


def encoded(value):
    return json.dumps(value, separators=(',', ':')).encode()


def layer(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as archive:
        for name, value in entries:
            entry = tarfile.TarInfo(name)
            if isinstance(value, tuple):
                entry.type, entry.linkname = value
                archive.addfile(entry)
            else:
                entry.size = len(value)
                archive.addfile(entry, io.BytesIO(value))
    return output.getvalue()


def private_key():
    kind = 'PRIVATE' + ' KEY'
    return (f'-----BEGIN {kind}-----\n' + base64.b64encode(b'synthetic non-key bytes for scanner coverage').decode() + f'\n-----END {kind}-----\n').encode()


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.oci = self.root / 'image.tar'

    def image(self, layers=None, platforms=('amd64', 'arm64'), env=None, attestation=True, extra=None, changed_label=False):
        blobs = {}

        def blob(data, media):
            digest = hashlib.sha256(data).hexdigest()
            blobs['blobs/sha256/' + digest] = data
            return {'mediaType': media, 'digest': 'sha256:' + digest, 'size': len(data)}

        descriptors = []
        for arch in platforms:
            config = {'architecture': arch, 'os': 'linux', 'config': {'Env': env or [], 'Labels': {
                'org.opencontainers.image.revision': 'b' * 40 if changed_label else COMMIT,
                'org.opencontainers.image.version': TAG,
            }}}
            manifest = {'schemaVersion': 2, 'mediaType': SCAN.MANIFEST, 'config': blob(encoded(config), SCAN.CONFIG),
                        'layers': [blob(gzip.compress(value, mtime=0), next(key for key, gz in SCAN.LAYERS.items() if gz))
                                   for value in (layers or [layer([('app/main.mjs', b'public runtime')])])]}
            descriptor = blob(encoded(manifest), SCAN.MANIFEST)
            descriptor['platform'] = {'os': 'linux', 'architecture': arch}
            descriptors.append(descriptor)
        if attestation:
            manifest = {'schemaVersion': 2, 'mediaType': SCAN.MANIFEST,
                        'config': blob(encoded({'architecture': 'unknown', 'os': 'unknown'}), SCAN.CONFIG),
                        'layers': [blob(encoded({'predicateType': 'https://example.test/provenance', 'predicate': {}}), SCAN.ATTESTATION)]}
            descriptor = blob(encoded(manifest), SCAN.MANIFEST)
            descriptor.update(platform={'os': 'unknown', 'architecture': 'unknown'}, annotations={'vnd.docker.reference.type': 'attestation-manifest'})
            descriptors.append(descriptor)
        root = blob(encoded({'schemaVersion': 2, 'mediaType': SCAN.INDEX, 'manifests': descriptors}), SCAN.INDEX)
        files = {'oci-layout': encoded({'imageLayoutVersion': '1.0.0'}),
                 'index.json': encoded({'schemaVersion': 2, 'mediaType': SCAN.INDEX, 'manifests': [root]}), **blobs}
        if extra:
            files.update(extra)
        self.oci.write_bytes(layer(list(files.items())))
        return root['digest']

    def scan_image(self):
        image = SCAN.Image(self.oci)
        try:
            digest = image.identity(TAG, COMMIT)
            image.scan(SCAN.Budget())
            return digest
        finally:
            image.close()

    def test_both_platforms_all_layers_and_buildkit_attestation_are_inspected(self):
        expected = self.image(extra={'manifest.json': b'[]'})
        self.assertEqual(self.scan_image(), expected)

    def test_missing_or_duplicate_platform_and_changed_source_identity_fail(self):
        for kwargs in [{'platforms': ('arm64',)}, {'platforms': ('amd64', 'amd64')}, {'changed_label': True}]:
            with self.subTest(kwargs=kwargs):
                self.image(**kwargs)
                with self.assertRaises(SCAN.Rejected):
                    self.scan_image()

    def test_private_history_is_rejected_even_if_later_deleted(self):
        for name in ['app/.env', 'app/.env.example', 'app/' + 'HANDOFF.md', 'app/.ssh/id_ed25519', 'app/cache/session.private.json']:
            with self.subTest(name=name):
                self.image([layer([(name, b'private')]), layer([('app/.wh.' + Path(name).name, b'')])])
                with self.assertRaisesRegex(SCAN.Rejected, 'private-file'):
                    self.scan_image()

    def test_realistic_synthetic_tokens_and_private_material_fail_without_echo(self):
        token = ('gh' + 'p_' + 'ABCdef012345' * 4).encode()
        api = ('s' + 'k-proj-' + 'ABCdef012345' * 4).encode()
        for content in [token, api, private_key(), ('/' + 'Users/' + 'fixture-person/doc.txt').encode(), b'\x00' + token + b'\x00']:
            with self.subTest(kind=content[:3]):
                self.image([layer([('app/data.bin', content)])])
                with self.assertRaises(SCAN.Rejected) as raised:
                    self.scan_image()
                self.assertNotIn(content.decode(errors='replace'), str(raised.exception))

    def test_hidden_developer_folders_fail_while_needed_runtime_links_work(self):
        for name in ['app/.vscode/launch.json', 'app/.editor/private', 'app/.github/workflows/build.yml']:
            self.image([layer([(name, b'fixture')])])
            with self.assertRaisesRegex(SCAN.Rejected, 'private-file'):
                self.scan_image()
        self.image([layer([('app/node_modules/.bin/tool', (tarfile.SYMTYPE, '../tool/main.js'))])])
        self.scan_image()

    def test_only_the_empty_pinned_public_npm_placeholder_is_permitted(self):
        self.image([layer([('usr/local/lib/node_modules/npm/.npmrc', b'')])])
        self.scan_image()
        for name, body in [('usr/local/lib/node_modules/npm/.npmrc', b'changed'), ('app/.npmrc', b'')]:
            self.image([layer([(name, body)])])
            with self.assertRaisesRegex(SCAN.Rejected, 'private-file'):
                self.scan_image()

    def test_high_entropy_json_and_image_environment_credentials_fail(self):
        value = 'Ab3fGh7jKm9pQr2sTu5vWx8y'
        self.image(env=['JWT_' + 'SECRET=' + value])
        with self.assertRaisesRegex(SCAN.Rejected, 'credential-assignment'):
            self.scan_image()
        self.image([layer([('app/config.json', encoded({'password': value}))])])
        with self.assertRaisesRegex(SCAN.Rejected, 'credential-assignment'):
            self.scan_image()

    def test_translation_identifiers_and_key_format_markers_are_not_credentials(self):
        value = encoded({'APP_INSTALL_FORM_HIDE_PASSWORD': 'APP_INSTALL_FORM_SHOW_PASSWORD'})
        marker = ('format: -----BEGIN ' + 'PRIVATE KEY-----').encode()
        self.image([layer([('app/bundle.js', value + marker + b'\ndef preflight(token=_PREFLIGHT_SENTINEL): pass')])])
        self.scan_image()

    def test_documented_upstream_examples_do_not_exempt_other_paths_or_tokens(self):
        public = '/'.join(['', 'home', 'buildozer', 'aports', 'main', 'fixture', 'src', 'public.cc']).encode()
        SCAN.scan_stream(io.BytesIO(public), 'public', SCAN.Budget())
        for content in [public.replace(b'aports', b'private'), '/'.join(['', 'Users', 'mjr', 'private', 'data']).encode()]:
            with self.assertRaisesRegex(SCAN.Rejected, 'personal-path'):
                SCAN.scan_stream(io.BytesIO(content), 'private', SCAN.Budget())
        token = ('s' + 'k-proj-' + 'ABCdef012345' * 4).encode()
        with self.assertRaisesRegex(SCAN.Rejected, 'api-token'):
            SCAN.scan_stream(io.BytesIO(public + b'\n' + token), 'private', SCAN.Budget())
        scanner = SCAN.Content('boundary')
        root = '/'.join(['', 'Users', 'mjr', '']).encode()
        scanner.feed(root)
        scanner.feed(b'work/node/process-args.js')
        scanner.finish()
        SCAN.scan_stream(io.BytesIO(b'https://example.test/site/home/tax/article'), 'public-url', SCAN.Budget())
        with self.assertRaisesRegex(SCAN.Rejected, 'personal-path'):
            SCAN.scan_stream(io.BytesIO(b'https://example.test/?path=/' + b'home/private-person/file'), 'private-query', SCAN.Budget())

    def test_upstream_build_paths_require_exact_public_file_bytes_and_never_exempt_credentials(self):
        name = 'usr/local/bin/docker-compose'
        body = ('public upstream build path: /' + 'home/public-builder/source').encode()
        with mock.patch.object(SCAN, 'PUBLIC_BUILD_PATHS', {name: {SCAN.sha(body)}}):
            self.image([layer([(name, body)])])
            self.scan_image()
            self.image([layer([(name, body + b'changed')])])
            with self.assertRaisesRegex(SCAN.Rejected, 'upstream-file-identity-mismatch'):
                self.scan_image()
            token = ('gh' + 'p_' + 'ABCdef012345' * 4).encode()
            with mock.patch.object(SCAN, 'PUBLIC_BUILD_PATHS', {name: {SCAN.sha(body + token)}}):
                self.image([layer([(name, body + token)])])
                with self.assertRaisesRegex(SCAN.Rejected, 'github-token'):
                    self.scan_image()

    def test_runtime_inherits_pinned_alpine_and_copies_only_node_and_its_security_probe(self):
        dockerfile = Path(__file__).resolve().parent.parent.joinpath('Dockerfile').read_text()
        self.assertRegex(dockerfile, r'ARG ALPINE_IMAGE="alpine:3\.23\.[0-9]+@sha256:[a-f0-9]{64}"')
        runner = dockerfile.split('# ---- RUNNER BASE ----', 1)[1].split('# ---- BUILDER ----', 1)[0]
        self.assertIn('FROM ${ALPINE_IMAGE} AS runner_base', runner)
        self.assertNotIn('FROM node_base', runner)
        copies = [line for line in runner.splitlines() if line.startswith('COPY --from=node_base ')]
        self.assertEqual(copies, [
            'COPY --from=node_base /usr/local/bin/node /usr/local/bin/node',
            'COPY --from=node_base /usr/local/lib/orbis/verify-node-security.cjs /usr/local/lib/orbis/verify-node-security.cjs',
        ])
        self.assertIn('libstdc++', runner)
        self.assertIn('node /usr/local/lib/orbis/verify-node-security.cjs', runner)

    def test_node_public_paths_require_exact_node_bytes_and_never_exempt_keys_or_adjacent_tokens(self):
        name = 'usr/local/bin/node'
        body = ('public upstream build path: /' + 'home/public-builder/source').encode()
        with mock.patch.object(SCAN, 'PUBLIC_BUILD_PATHS', {name: {SCAN.sha(body)}}):
            self.image([layer([(name, body)])])
            self.scan_image()
            for changed_name, changed_body in [(name, body + b'tampered'), ('app/node', body)]:
                self.image([layer([(changed_name, changed_body)])])
                with self.assertRaises(SCAN.Rejected):
                    self.scan_image()
        for secret in [private_key(), ('s' + 'k-proj-' + 'AbCd01234567' * 4).encode()]:
            with mock.patch.object(SCAN, 'PUBLIC_BUILD_PATHS', {name: {SCAN.sha(body + secret)}}):
                self.image([layer([(name, body + secret)])])
                with self.assertRaises(SCAN.Rejected):
                    self.scan_image()
            with mock.patch.object(SCAN, 'PUBLIC_BUILD_PATHS', {name: {SCAN.sha(body)}}):
                self.image([layer([(name, body), ('app/adjacent.bin', secret)])])
                with self.assertRaises(SCAN.Rejected):
                    self.scan_image()

    def test_only_exact_public_ca_symlinks_pass_and_absolute_targets_are_root_relative(self):
        cert = b'-----BEGIN CERTIFICATE-----\n' + base64.b64encode(b'\x30public certificate fixture') + b'\n-----END CERTIFICATE-----\n'
        for alias, target in SCAN.PUBLIC_CERTIFICATE_LINKS.items():
            self.image([layer([(alias, (tarfile.SYMTYPE, target)), ('etc/ssl/cert.pem', cert)])])
            with mock.patch.object(SCAN, 'private_path', wraps=SCAN.private_path) as checked:
                self.scan_image()
            self.assertIn(mock.call('etc/ssl/cert.pem'), checked.call_args_list)
            for content in [cert, (tarfile.LNKTYPE, target), (tarfile.SYMTYPE, '/etc/ssl/other.pem'),
                            (tarfile.SYMTYPE, '../../etc/ssl/cert.pem')]:
                self.image([layer([(alias, content)])])
                with self.assertRaisesRegex(SCAN.Rejected, 'private-file'):
                    self.scan_image()
            self.image([layer([(alias + '.other.pem', (tarfile.SYMTYPE, target))])])
            with self.assertRaisesRegex(SCAN.Rejected, 'private-file'):
                self.scan_image()
            self.image([layer([(alias, (tarfile.SYMTYPE, target)), ('etc/ssl/cert.pem', private_key())])])
            with self.assertRaises(SCAN.Rejected):
                self.scan_image()
        self.image([layer([('app/link', (tarfile.SYMTYPE, '/../etc/ssl/cert.pem'))])])
        with self.assertRaisesRegex(SCAN.Rejected, 'unsafe-archive-path'):
            self.scan_image()

    def test_apk_protocol_markers_require_exact_apk_bytes_and_cannot_exempt_credentials(self):
        value = ('AbCd01234567' * 4).encode()
        body = b'\x00APK_PREUPGRADE_TOKEN=' + value + b'\x00APK_SELFUPGRADE_TOKEN=' + value + b'\x00'
        name = 'sbin/apk'
        with mock.patch.object(SCAN, 'PUBLIC_APK_FILES', {name: {SCAN.sha(body)}}):
            self.image([layer([(name, body)])])
            self.scan_image()
            for entries in [[(name, body + b'tampered')], [('app/apk', body)],
                            [(name, body), ('app/adjacent', body)]]:
                self.image([layer(entries)])
                with self.assertRaises(SCAN.Rejected):
                    self.scan_image()
            self.image([layer([(name, body)]) + body])
            with self.assertRaisesRegex(SCAN.Rejected, 'credential-assignment'):
                self.scan_image()
        for secret in [b'\x00JWT_SECRET=' + value, private_key(),
                       b'\x00OTHER_APK_PREUPGRADE_TOKEN=' + value]:
            changed = body + secret
            with mock.patch.object(SCAN, 'PUBLIC_APK_FILES', {name: {SCAN.sha(changed)}}):
                self.image([layer([(name, changed)])])
                with self.assertRaises(SCAN.Rejected):
                    self.scan_image()

    def test_every_pinned_executable_requires_its_exact_identity_even_without_visible_signals(self):
        token = ('gh' + 'p_' + 'AbCd01234567' * 4).encode()
        for name in ['usr/local/bin/node', 'usr/local/bin/docker-compose', 'sbin/apk']:
            for body in [b'ordinary signal-free replacement', gzip.compress(token, mtime=0)]:
                self.image([layer([(name, body)])])
                with self.assertRaisesRegex(SCAN.Rejected, 'upstream-file-identity-mismatch'):
                    self.scan_image()

    def test_public_trusted_ca_certificate_is_kept_but_private_key_is_rejected(self):
        certificate = b'-----BEGIN CERTIFICATE-----\n' + base64.b64encode(b'\x30public certificate fixture') + b'\n-----END CERTIFICATE-----\n'
        self.image([layer([('etc/ssl/certs/public.pem', certificate)])])
        self.scan_image()
        self.image([layer([('etc/ssl/certs/public.pem', certificate + private_key())])])
        with self.assertRaises(SCAN.Rejected):
            self.scan_image()
        self.image([layer([('app/operator.pem', certificate)])])
        with self.assertRaisesRegex(SCAN.Rejected, 'private-file'):
            self.scan_image()

    def test_symlinks_traversal_and_hardlink_private_targets_fail_without_extraction(self):
        for entries in [[('../escape', b'x')], [('app/link', (tarfile.SYMTYPE, '/root/.ssh/key'))],
                        [('app/link', (tarfile.LNKTYPE, 'app/.env'))]]:
            with self.subTest(entries=entries):
                self.image([layer(entries)])
                with self.assertRaises(SCAN.Rejected):
                    self.scan_image()
                self.assertFalse((self.root / 'escape').exists())

    def test_nested_gzip_zip_and_tar_are_inspected(self):
        token = ('gh' + 'p_' + 'AbCd01234567' * 4).encode()
        zipped = io.BytesIO()
        with zipfile.ZipFile(zipped, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('nested/.env', b'fixture')
        for body in [gzip.compress(token), zipped.getvalue(), layer([('nested/.env', b'fixture')])]:
            with self.subTest(prefix=body[:2]):
                self.image([layer([('app/opaque.bin', body)])])
                with self.assertRaises(SCAN.Rejected):
                    self.scan_image()
        self.image([layer([('app/opaque.bin', b'\xfd7zXZ\x00' + b'unsupported fixture')])])
        with self.assertRaisesRegex(SCAN.Rejected, 'unsupported-nested-archive'):
            self.scan_image()

    def test_tar_signature_inside_ordinary_source_requires_a_valid_header(self):
        source = b'public JavaScript source'.ljust(257, b' ') + b'ustar' + b' ordinary source'.ljust(300, b' ')
        self.assertFalse(SCAN.tar_header(source[:512]))
        self.image([layer([('app/headers.js', source)])])
        self.scan_image()
        token = ('gh' + 'p_' + 'AbCd01234567' * 4).encode()
        self.image([layer([('app/headers.js', source + token)])])
        with self.assertRaisesRegex(SCAN.Rejected, 'github-token'):
            self.scan_image()

    def test_valid_old_tar_headers_and_truncated_archives_still_fail_closed(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as archive:
            entry = tarfile.TarInfo('nested/.env')
            entry.size = 1
            archive.addfile(entry, io.BytesIO(b'x'))
        value = bytearray(output.getvalue())
        value[257:265] = b'\x00' * 8
        value[148:156] = b' ' * 8
        value[148:156] = f'{sum(value[:512]):06o}\x00 '.encode()
        self.assertTrue(SCAN.tar_header(bytes(value[:512])))
        self.image([layer([('app/archive.bin', bytes(value))])])
        with self.assertRaisesRegex(SCAN.Rejected, 'private-file'):
            self.scan_image()
        header = tarfile.TarInfo('public.txt')
        header.size = 2048
        self.image([layer([('app/archive.bin', header.tobuf() + b'short')])])
        with self.assertRaises(tarfile.ReadError):
            self.scan_image()

    def test_unreadable_artifact_reports_only_fixed_stage_and_exception_type(self):
        self.installer(self.image())
        private = 'synthetic private diagnostic contents'
        with mock.patch.object(SCAN.Image, 'scan', side_effect=OSError(private)):
            result, message = self.cli('scan')
        self.assertEqual(result, 1)
        self.assertEqual(message, {'passed': False, 'error': 'invalid-or-unreadable-artifact', 'stage': 'image-content', 'exception': 'OSError'})
        self.assertNotIn(private, json.dumps(message))
        self.assertFalse(self.report.exists())

    def test_early_personal_path_rejection_reports_only_complete_member_and_layer_identity(self):
        private = '/'.join(['', 'home', 'synthetic-person', 'private-file']).encode()
        body = private + b'\n' + os.urandom(SCAN.CHUNK * 3)
        value = layer([('app/public-file.bin', body)])
        expected_layer = 'sha256:' + SCAN.sha(gzip.compress(value, mtime=0))
        self.installer(self.image([value]))
        result, message = self.cli('scan')
        self.assertEqual(result, 1)
        self.assertIn('personal-path at ', message['error'])
        self.assertEqual(message['artifact']['memberSha256'], SCAN.sha(body))
        self.assertEqual(message['artifact']['memberBytes'], len(body))
        self.assertEqual(message['artifact']['layerDigest'], expected_layer)
        self.assertRegex(message['artifact']['memberCounter'], r'^oci\.blob[0-9]+\.layer\.entry0$')
        self.assertNotIn(private.decode(), json.dumps(message))
        self.assertNotIn('public-file.bin', json.dumps(message))
        self.assertFalse(self.report.exists())

    def test_nested_gzip_rejection_hashes_original_compressed_member_after_read_ahead(self):
        private = '/'.join(['', 'home', 'synthetic-person', 'private-file']).encode()
        body = gzip.compress(private + b'\n' + os.urandom(SCAN.CHUNK * 3), mtime=0)
        self.image([layer([('app/public-file.gz', body)])])
        with self.assertRaisesRegex(SCAN.Rejected, 'personal-path') as raised:
            self.scan_image()
        identity = raised.exception.artifact
        self.assertEqual(identity['memberSha256'], SCAN.sha(body))
        self.assertEqual(identity['memberBytes'], len(body))
        self.assertNotIn(private.decode(), json.dumps(identity))
        self.assertNotIn('public-file.gz', json.dumps(identity))

    def test_raw_compressed_signal_reports_only_verified_member_identity_and_offsets(self):
        first = b'https://example.test'
        second = b'/home/tax/article'
        payload = first + second
        deflate = (b'\x00' + struct.pack('<HH', len(first), len(first) ^ 0xffff) + first
                   + b'\x01' + struct.pack('<HH', len(second), len(second) ^ 0xffff) + second)
        compressed = (b'\x1f\x8b\x08\x00' + b'\x00' * 4 + b'\x00\xff' + deflate
                      + struct.pack('<II', zlib.crc32(payload), len(payload)))
        self.assertEqual(gzip.decompress(compressed), payload)
        SCAN.scan_body(io.BytesIO(compressed), 'decoded', SCAN.Budget(), 0)
        for name in ('app/public-file.gz', 'app/' + 'x' * 120 + '.gz'):
            with self.subTest(pax=len(name) > 100), self.assertRaisesRegex(SCAN.Rejected, 'personal-path at layer') as raised:
                SCAN.scan_tar(io.BytesIO(layer([(name, compressed)])), 'layer', SCAN.Budget())
            identity = raised.exception.artifact
            self.assertEqual(identity['memberSha256'], SCAN.sha(compressed))
            self.assertEqual(identity['memberBytes'], len(compressed))
            self.assertEqual(identity['memberCounter'], 'layer.entry0')
            self.assertEqual(identity['memberEncoding'], 'gzip')
            self.assertEqual(identity['memberOffset'], compressed.index(second))
            self.assertEqual(identity['rawEnd'] - identity['rawOffset'], len(b'/home/tax/'))
            self.assertNotIn(second.decode(), json.dumps(identity))
            self.assertNotIn(name, json.dumps(identity))

    def test_raw_trailing_signal_has_no_fabricated_member_identity(self):
        private = '/'.join(['', 'home', 'synthetic-person', 'private-file']).encode()
        archive = layer([('app/public-file', b'ok')])
        with self.assertRaisesRegex(SCAN.Rejected, 'personal-path at layer') as raised:
            SCAN.scan_tar(io.BytesIO(archive + private), 'layer', SCAN.Budget())
        self.assertEqual(raised.exception.artifact, {'rawOffset': len(archive), 'rawEnd': len(archive) + len(private.rsplit(b'/', 1)[0]) + 1})
        self.assertNotIn(private.decode(), json.dumps(raised.exception.artifact))

    def test_secret_rejections_still_fail_without_exposing_body_or_filename(self):
        token = ('gh' + 'p_' + 'AbCd01234567' * 4).encode()
        self.installer(self.image([layer([('app/public-file.bin', token + b'\n' + os.urandom(SCAN.CHUNK * 2))])]))
        result, message = self.cli('scan')
        self.assertEqual(result, 1)
        self.assertIn('github-token at ', message['error'])
        self.assertNotIn('artifact', message)
        self.assertNotIn(token.decode(), json.dumps(message))
        self.assertNotIn('public-file.bin', json.dumps(message))
        self.assertFalse(self.report.exists())

    def test_failed_underlying_read_never_claims_a_member_identity_or_drains_again(self):
        source = mock.Mock()
        source.read.side_effect = [SCAN.Rejected('personal-path at raw-layer'), b'other bytes']
        reader = SCAN.MemberReader(source)
        with self.assertRaisesRegex(SCAN.Rejected, 'personal-path at raw-layer'):
            reader.read(512)
        self.assertIsNone(reader.rejection_identity(11, 'entry0', SCAN.Budget()))
        self.assertEqual(source.read.call_count, 1)

    def test_credentials_split_across_read_boundaries_and_trailing_tar_bytes_fail(self):
        token = ('gh' + 'p_' + 'ABCdef012345' * 4).encode()
        scanner = SCAN.Content('fixture')
        scanner.feed(token[:15])
        with self.assertRaisesRegex(SCAN.Rejected, 'github-token'):
            scanner.feed(token[15:])
        self.image([layer([('app/public', b'ok')]) + token])
        with self.assertRaisesRegex(SCAN.Rejected, 'github-token'):
            self.scan_image()

    def test_unreferenced_blob_and_changed_blob_bytes_fail(self):
        extra = b'not referenced'
        self.image(extra={'blobs/sha256/' + SCAN.sha(extra): extra})
        with self.assertRaisesRegex(SCAN.Rejected, 'unreferenced'):
            self.scan_image()
        self.image()
        with tarfile.open(self.oci) as archive:
            files = [(m.name, archive.extractfile(m).read()) for m in archive if m.isfile()]
        target = next(i for i, (name, body) in enumerate(files) if name.startswith('blobs/') and body.startswith(b'\x1f\x8b'))
        files[target] = (files[target][0], files[target][1] + b'changed')
        self.oci.write_bytes(layer(files))
        with self.assertRaises(SCAN.Rejected):
            self.scan_image()

    def test_limits_fail_closed(self):
        self.image()
        with mock.patch.object(SCAN, 'MAX_TOTAL', 10), self.assertRaises(SCAN.Rejected):
            self.scan_image()

    def installer(self, digest):
        build, plan = SCAN.load('orbis-installer-bundle'), SCAN.load('orbis-release-plan')
        release = {'schema': 'orbis.release.v1', 'image': 'ghcr.io/twentylines/orbis', 'tag': TAG, 'commit': COMMIT,
                   'digest': digest, 'installationProtocol': 'orbis.installation-state.v1', 'runtipiCompatibility': '4.10.1'}
        self.manifest = self.root / 'release-manifest.json'
        self.manifest.write_bytes(encoded(release))
        source = {name: b'# public source fixture\n' for name in build.REQUIRED}
        source['scripts/install-orbis.py'] = Path(__file__).with_name('install-orbis.py').read_bytes()
        self.assets = self.root / 'installer'
        self.assets.mkdir()
        for name, data in build.build(source, self.manifest.read_bytes()).items():
            (self.assets / name).write_bytes(data)
        self.notes = self.root / 'release-notes.md'
        self.notes.write_text('Experimental release fixture.')
        self.report = self.root / 'receipt.json'
        original = SCAN.load
        build.committed_files = mock.Mock(return_value=source)
        patch = mock.patch.object(SCAN, 'load', side_effect=lambda name: build if name == 'orbis-installer-bundle' else plan if name == 'orbis-release-plan' else original(name))
        patch.start()
        self.addCleanup(patch.stop)

    def cli(self, mode):
        args = [mode, '--oci', str(self.oci), '--tag', TAG, '--commit', COMMIT, '--manifest', str(self.manifest),
                '--installer', str(self.assets), '--notes', str(self.notes), '--report', str(self.report)]
        with contextlib.redirect_stdout(io.StringIO()) as output:
            result = SCAN.main(args)
        return result, json.loads(output.getvalue())

    def test_source_bound_installer_and_report_are_rechecked_before_publish(self):
        self.installer(self.image())
        self.assertEqual(self.cli('scan')[0], 0)
        self.assertEqual(self.cli('verify')[0], 0)
        with mock.patch.object(SCAN, 'publish_image') as publish:
            self.assertEqual(self.cli('publish')[0], 0)
            publish.assert_called_once()
        with (self.assets / 'install-orbis.py').open('ab') as file:
            file.write(b'changed')
        with mock.patch.object(SCAN, 'publish_image') as publish:
            self.assertEqual(self.cli('publish')[0], 1)
            publish.assert_not_called()

    def test_notes_image_or_receipt_changed_after_scan_cannot_publish(self):
        self.installer(self.image())
        self.assertEqual(self.cli('scan')[0], 0)
        original = self.notes.read_bytes()
        self.notes.write_bytes(original + b' changed')
        with mock.patch.object(SCAN, 'publish_image') as publish:
            self.assertEqual(self.cli('publish')[0], 1)
            publish.assert_not_called()
        self.notes.write_bytes(original)
        with self.oci.open('ab') as file:
            file.write(b'changed archive envelope')
        with mock.patch.object(SCAN, 'publish_image') as publish:
            self.assertEqual(self.cli('publish')[0], 1)
            publish.assert_not_called()
        self.report.write_text('{}')
        with mock.patch.object(SCAN, 'publish_image') as publish:
            self.assertEqual(self.cli('publish')[0], 1)
            publish.assert_not_called()

    def test_scan_failure_never_creates_a_passing_receipt(self):
        self.installer(self.image([layer([('app/.env', b'fixture')])]))
        self.assertEqual(self.cli('scan')[0], 1)
        self.assertFalse(self.report.exists())

    def test_candidate_cli_requires_scan_receipt_and_rejects_create_tag(self):
        with mock.patch.dict(globals(), {'TAG': 'v0.6.0-rc.1'}):
            self.installer(self.image())
            with mock.patch.object(SCAN, 'publish_image') as publish:
                self.assertEqual(self.cli('publish-candidate')[0], 1)
                self.assertEqual(self.cli('scan')[0], 0)
                self.assertEqual(self.cli('publish-candidate')[0], 0)
                publish.assert_called_once()
                self.notes.write_text('changed')
                self.assertEqual(self.cli('publish-candidate')[0], 1)
                self.assertEqual(publish.call_count, 1)
            args = ['publish-candidate', '--oci', str(self.oci), '--tag', TAG, '--commit', COMMIT, '--create-tag']
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(SCAN.main(args), 1)

    def test_candidate_publication_requires_current_main_and_absent_git_tag(self):
        auth = self.root / 'auth.json'
        auth.write_text('{}')
        tag = 'v0.6.0-rc.1'
        main = {'ref': 'refs/heads/main', 'object': {'type': 'commit', 'sha': COMMIT}}
        missing = lambda: urllib.error.HTTPError('https://example.test', 404, 'absent', {}, None)
        token = lambda: contextlib.nullcontext(io.BytesIO(encoded({'token': 'synthetic'})))
        env = {'GH_TOKEN': 'synthetic', 'GITHUB_REF': 'refs/heads/main', 'GITHUB_SHA': COMMIT}
        for ref, sha, remote, existing in [('refs/heads/other', COMMIT, main, None),
                                            ('refs/heads/main', 'b' * 40, main, None),
                                            ('refs/heads/main', COMMIT, {'ref': 'refs/heads/main', 'object': {'type': 'commit', 'sha': 'b' * 40}}, None),
                                            ('refs/heads/main', COMMIT, main, {'ref': 'refs/tags/' + tag})]:
            with self.subTest(ref=ref, sha=sha, remote=remote, existing=existing), \
                    mock.patch.dict(os.environ, {**env, 'GITHUB_REF': ref, 'GITHUB_SHA': sha}), \
                    mock.patch.object(SCAN.urllib.request, 'urlopen', side_effect=[missing(), token(), missing()]), \
                    mock.patch.object(SCAN, 'github_json', side_effect=[remote, existing]), \
                    mock.patch.object(SCAN.subprocess, 'run') as run, self.assertRaises(SCAN.Rejected):
                SCAN.publish_image(self.oci, 'sha256:' + 'b' * 64, tag, auth, COMMIT, candidate=True)
            run.assert_not_called()

        raw = b'candidate index'
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(SCAN.urllib.request, 'urlopen', side_effect=[missing(), token(), missing()]), \
                mock.patch.object(SCAN, 'github_json', side_effect=[main, None]) as api, \
                mock.patch.object(SCAN.subprocess, 'run', side_effect=[mock.Mock(returncode=0), mock.Mock(returncode=0, stdout=raw)]) as run:
            SCAN.publish_image(self.oci, 'sha256:' + SCAN.sha(raw), tag, auth, COMMIT, candidate=True)
        self.assertEqual(api.call_args_list, [mock.call('git/ref/heads/main', 'synthetic'),
                                              mock.call('git/ref/tags/' + tag, 'synthetic', missing=True)])
        self.assertIn('--all', run.call_args_list[0].args[0])
        self.assertIn('--preserve-digests', run.call_args_list[0].args[0])
        self.assertIn('oci-archive:' + str(self.oci.resolve()), run.call_args_list[0].args[0])
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(SCAN.urllib.request, 'urlopen', side_effect=[missing(), token(), missing()]), \
                mock.patch.object(SCAN, 'github_json', side_effect=[main, None]), \
                mock.patch.object(SCAN.subprocess, 'run', side_effect=[mock.Mock(returncode=0), mock.Mock(returncode=0, stdout=b'changed')]), \
                self.assertRaisesRegex(SCAN.Rejected, 'published-index-digest-mismatch'):
            SCAN.publish_image(self.oci, 'sha256:' + SCAN.sha(raw), tag, auth, COMMIT, candidate=True)

    def test_candidate_rejects_unknown_or_existing_release_registry_and_git_states(self):
        auth = self.root / 'auth.json'
        auth.write_text('{}')
        tag = 'v0.6.0-rc.1'
        missing = lambda: urllib.error.HTTPError('https://example.test', 404, 'absent', {}, None)
        failure = lambda status: urllib.error.HTTPError('https://example.test', status, 'failure', {}, None)
        token = lambda: contextlib.nullcontext(io.BytesIO(encoded({'token': 'synthetic'})))
        main = {'ref': 'refs/heads/main', 'object': {'type': 'commit', 'sha': COMMIT}}
        env = {'GH_TOKEN': 'synthetic', 'GITHUB_REF': 'refs/heads/main', 'GITHUB_SHA': COMMIT}
        for replies, git in [([contextlib.nullcontext(io.BytesIO())], []), ([failure(401)], []),
                             ([TimeoutError()], []), ([missing(), token(), contextlib.nullcontext(io.BytesIO())], []),
                             ([missing(), token(), failure(403)], []), ([missing(), token(), TimeoutError()], []),
                             ([missing(), token(), missing()], [main, SCAN.Rejected('git-reference-unverified')])]:
            with self.subTest(replies=replies, git=git), mock.patch.dict(os.environ, env), \
                    mock.patch.object(SCAN.urllib.request, 'urlopen', side_effect=replies), \
                    mock.patch.object(SCAN, 'github_json', side_effect=git), \
                    mock.patch.object(SCAN.subprocess, 'run') as run, self.assertRaises((SCAN.Rejected, TimeoutError)):
                SCAN.publish_image(self.oci, 'sha256:' + 'b' * 64, tag, auth, COMMIT, candidate=True)
            run.assert_not_called()
        for invalid in ['v0.6.0-beta.1', 'v0.6.0', 'v0.6.0-rc.1-extra']:
            with self.assertRaises(SCAN.Rejected):
                SCAN.publish_image(self.oci, 'sha256:' + 'b' * 64, invalid, auth, COMMIT, candidate=True)
        for status in [401, 403, 500]:
            with mock.patch.object(SCAN.urllib.request, 'urlopen', side_effect=failure(status)), self.assertRaises(SCAN.Rejected):
                SCAN.github_json('git/ref/tags/' + tag, 'synthetic', missing=True)
        with mock.patch.object(SCAN.urllib.request, 'urlopen', side_effect=missing()):
            self.assertIsNone(SCAN.github_json('git/ref/tags/' + tag, 'synthetic', missing=True))

    def test_registry_and_release_unknown_or_existing_states_do_not_copy(self):
        auth = self.root / 'auth.json'
        auth.write_text('{}')
        for status in [200, 401, 403, 500]:
            if status == 200:
                response = contextlib.nullcontext(io.BytesIO(b''))
            else:
                response = urllib.error.HTTPError('https://example.test', status, 'fixture', {}, None)
            with self.subTest(status=status), mock.patch.dict(os.environ, {'GH_TOKEN': 'synthetic'}), \
                    mock.patch.object(SCAN.urllib.request, 'urlopen', **({'return_value': response} if status == 200 else {'side_effect': response})), \
                    mock.patch.object(SCAN.subprocess, 'run') as run, self.assertRaises(SCAN.Rejected):
                SCAN.publish_image(self.oci, 'sha256:' + 'b' * 64, TAG, auth, COMMIT)
            run.assert_not_called()

    def test_copy_preserves_all_scanned_digests_and_registry_index_must_match(self):
        auth = self.root / 'auth.json'
        auth.write_text('{}')
        raw = b'fixture registry index bytes'
        missing = urllib.error.HTTPError('https://example.test', 404, 'absent', {}, None)
        for matching in [True, False]:
            token = contextlib.nullcontext(io.BytesIO(encoded({'token': 'synthetic'})))
            replies = [missing, token, missing]
            commands = []

            def run(args, **kwargs):
                commands.append(args)
                return mock.Mock(returncode=0, stdout=raw if matching else b'changed')

            with mock.patch.dict(os.environ, {'GH_TOKEN': 'synthetic'}), \
                    mock.patch.object(SCAN.urllib.request, 'urlopen', side_effect=replies), mock.patch.object(SCAN.subprocess, 'run', side_effect=run), \
                    mock.patch.object(SCAN, 'ensure_release_tag') as tag:
                if matching:
                    SCAN.publish_image(self.oci, 'sha256:' + SCAN.sha(raw), TAG, auth, COMMIT)
                else:
                    with self.assertRaisesRegex(SCAN.Rejected, 'published-index-digest-mismatch'):
                        SCAN.publish_image(self.oci, 'sha256:' + SCAN.sha(raw), TAG, auth, COMMIT)
                tag.assert_called_once_with(TAG, COMMIT, 'synthetic', False)
            self.assertIn('--all', commands[0])
            self.assertIn('--preserve-digests', commands[0])
            self.assertTrue(any(arg.startswith('oci-archive:') for arg in commands[0]))

    def test_dispatch_creates_only_an_absent_nightly_tag_at_current_main_after_scan(self):
        main = {'ref': 'refs/heads/main', 'object': {'type': 'commit', 'sha': COMMIT}}
        tag = {'ref': 'refs/tags/' + TAG, 'object': {'type': 'commit', 'sha': COMMIT}}
        with mock.patch.dict(os.environ, {'GITHUB_REF': 'refs/heads/main', 'GITHUB_SHA': COMMIT}), \
                mock.patch.object(SCAN, 'github_json', side_effect=[main, None, tag]) as api:
            SCAN.ensure_release_tag(TAG, COMMIT, 'synthetic', True)
        self.assertEqual(api.call_args_list[-1], mock.call('git/refs', 'synthetic', {'ref': 'refs/tags/' + TAG, 'sha': COMMIT}))

    def test_dispatch_refuses_advanced_main_other_branches_stable_or_replaced_tags(self):
        main = {'ref': 'refs/heads/main', 'object': {'type': 'commit', 'sha': 'b' * 40}}
        with mock.patch.dict(os.environ, {'GITHUB_REF': 'refs/heads/main', 'GITHUB_SHA': COMMIT}), \
                mock.patch.object(SCAN, 'github_json', return_value=main) as api, self.assertRaisesRegex(SCAN.Rejected, 'main-advanced'):
            SCAN.ensure_release_tag(TAG, COMMIT, 'synthetic', True)
        self.assertEqual(api.call_count, 1)
        for ref, tag in [('refs/heads/other', TAG), ('refs/heads/main', 'v1.0.0')]:
            with mock.patch.dict(os.environ, {'GITHUB_REF': ref, 'GITHUB_SHA': COMMIT}), \
                    mock.patch.object(SCAN, 'github_json') as api, self.assertRaisesRegex(SCAN.Rejected, 'nightly-dispatch'):
                SCAN.ensure_release_tag(tag, COMMIT, 'synthetic', True)
            api.assert_not_called()
        wrong = {'ref': 'refs/tags/' + TAG, 'object': {'type': 'commit', 'sha': 'b' * 40}}
        with mock.patch.object(SCAN, 'github_json', return_value=wrong) as api, self.assertRaisesRegex(SCAN.Rejected, 'tag-mismatch'):
            SCAN.ensure_release_tag(TAG, COMMIT, 'synthetic', False)
        self.assertEqual(api.call_count, 1)

    def test_tag_push_resolves_existing_annotated_tag_without_creating_or_replacing_it(self):
        tag = {'ref': 'refs/tags/' + TAG, 'object': {'type': 'tag', 'sha': 'b' * 40}}
        with mock.patch.object(SCAN, 'github_json', side_effect=[tag, {'object': {'type': 'commit', 'sha': COMMIT}}]) as api:
            SCAN.ensure_release_tag(TAG, COMMIT, 'synthetic', False)
        self.assertEqual(api.call_count, 2)
        self.assertTrue(all(len(call.args) == 2 for call in api.call_args_list))
        with mock.patch.object(SCAN, 'github_json', return_value=None), self.assertRaisesRegex(SCAN.Rejected, 'tag-missing'):
            SCAN.ensure_release_tag(TAG, COMMIT, 'synthetic', False)

    def test_workflow_builds_and_inspects_before_any_publication(self):
        workflow = (Path(__file__).resolve().parent.parent / '.github/workflows/release.yml').read_text()
        self.assertIn('push: false', workflow)
        self.assertNotIn('push: true', workflow)
        self.assertIn('outputs: type=oci,', workflow)
        self.assertLess(workflow.index('privacy.py scan '), workflow.index('privacy.py publish '))
        self.assertLess(workflow.index('privacy.py publish '), workflow.index('gh release create'))
        self.assertLess(workflow.index('privacy.py verify '), workflow.index('gh release create'))
        self.assertIn('--prerelease --latest=false', workflow)
        self.assertIn('workflow_dispatch:', workflow)
        self.assertIn('RELEASE_TAG: ${{ inputs.tag || github.ref_name }}', workflow)
        self.assertIn('DOCKER_BUILD_RECORD_UPLOAD: \'false\'', workflow)

    def test_candidate_workflow_cannot_create_release_or_git_refs(self):
        workflow = (Path(__file__).resolve().parent.parent / '.github/workflows/candidate.yml').read_text()
        self.assertIn('needs: [verify, integration]', workflow)
        self.assertIn("if: github.ref == 'refs/heads/main'", workflow)
        self.assertIn('ref: ${{ github.sha }}', workflow)
        self.assertIn('contents: read', workflow)
        for forbidden in ('contents: write', 'gh release', 'git tag', '--create-tag', 'push: true', 'upload-artifact'):
            self.assertNotIn(forbidden, workflow)
        self.assertLess(workflow.index('privacy.py scan '), workflow.index('uses: docker/login-action'))
        self.assertLess(workflow.index('privacy.py scan '), workflow.index('privacy.py publish-candidate '))
        self.assertIn('outputs: type=oci,', workflow)
        self.assertIn('DOCKER_BUILD_RECORD_UPLOAD: \'false\'', workflow)


if __name__ == '__main__':
    unittest.main()
