import base64
import copy
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_orbis_controller_identity import fixture


def load(name, alias):
    spec = importlib.util.spec_from_file_location(alias, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


A = load('orbis-host-retained-authority.py', 'retained_authority_test')
H = load('orbis-host.py', 'retained_host_test')
P = A.P


class RetainedAuthorityTests(unittest.TestCase):
    def test_runtime_origin_versions_and_exact_new_descriptor_hashes_are_paired(self):
        for runtime_version, origin_version in [(3, 1), (4, 2), (6, 4)]:
            runtime = {'schema': 'orbis.time-machine-runtime.v' + str(runtime_version)}
            origin = {'schema': 'orbis.controller-capture-authority.v' + str(origin_version)}
            if runtime_version != 3:
                runtime['proxyHostIdentitySha256'] = 'a' * 64
                origin['proxyHostIdentity'] = {'sha256': 'a' * 64}
            if runtime_version == 6:
                runtime['appRuntimeSha256'] = origin['appRuntimeSha256'] = 'b' * 64
            A.runtime_origin_binding(runtime, origin)
            for other in [1, 2, 4]:
                if other != origin_version:
                    with self.assertRaises(ValueError):
                        A.runtime_origin_binding(runtime, {**origin, 'schema': 'orbis.controller-capture-authority.v' + str(other)})
            if runtime_version != 3:
                with self.assertRaises(ValueError): A.runtime_origin_binding({**runtime, 'proxyHostIdentitySha256': 'f' * 64}, origin)
            if runtime_version == 6:
                with self.assertRaises(ValueError): A.runtime_origin_binding({**runtime, 'appRuntimeSha256': 'f' * 64}, origin)
        with self.assertRaises(ValueError): A.runtime_origin_binding({'schema': 'orbis.time-machine-runtime.v5'}, {'schema': 'orbis.controller-capture-authority.v3'})

    def setUp(self):
        # Production requires UID 0. Tests substitute only the ownership policy,
        # keeping the real openat/no-follow/stat/hash and transaction operations.
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent.parent.parent)
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root, self.bundle = self.base / 'root', self.base / 'reviewed'
        self.root.mkdir(mode=0o700)
        self.bundle.mkdir(mode=0o700)
        for module in (A, H.AUTHORITY):
            patch = mock.patch.object(module, 'OWNER', os.geteuid())
            patch.start()
            self.addCleanup(patch.stop)
        self.release, blobs = fixture()
        self.graph = P.verify_published_graph(self.release, **blobs)
        self.proof = P.canonical(self.graph.proof())
        creation = self.graph.creation_reference('oci')
        self.observed = dict(creationReference=creation, imageId=creation, configDigest=self.graph.config_digest,
                             platform=blobs['platform'], rootfsDiffIds=list(self.graph.rootfs_diff_ids))
        files = []
        values = {'docker-compose.yml': b'services: {}\n', '.env': b'TIPI_VERSION=4.10.1\n',
                  'orbis-compose.yml': H.STAGE.staged_content(self.release).encode()}
        for name in A.CONFIG_PATHS:
            if name not in values:
                files.append(dict(path=name, present=False))
                continue
            body = values[name]
            files.append(dict(path=name, present=True, bytes=len(body), mode=0o600, uid=0, gid=0, device='1', inode='1',
                              mtimeNs='1', ctimeNs='1', sha256=hashlib.sha256(body).hexdigest(), data=base64.b64encode(body).decode()))
            self.write(self.root / name, body)
        self.config = dict(version=1, pointId='00000000-0000-4000-8000-000000000001',
                           controller=dict(id='a' * 64, imageId=self.release['digest'], imageReference=self.release['image'] + '@' + self.release['digest'],
                                           project='runtipi', service='runtipi', startedAt='fixture', releaseTag=self.release['tag'], releaseDigest=self.release['digest']),
                           rootIdentity=dict(device='1', inode='1', uid=0, gid=0, mode=0o700, pathSha256=hashlib.sha256(str(self.root).encode()).hexdigest()), files=files)
        metadata = {**self.config, 'files': [{k: v for k, v in item.items() if k != 'data'} for item in files]}
        self.config['configurationSetSha256'] = hashlib.sha256(b'orbis.controller-config.v1\n' + P.canonical(metadata)).hexdigest()
        self.point = dict(schema='orbis.time-machine-runtime.v2', pointId=self.config['pointId'], configurationSetSha256=self.config['configurationSetSha256'],
                          configuration={**metadata, 'configurationSetSha256': self.config['configurationSetSha256']},
                          controller=dict(sourceImageId=self.release['digest']))
        self.write(self.bundle / 'point.json', P.canonical(self.point))
        self.write(self.bundle / 'configuration.json', P.canonical(self.config))
        self.write(self.bundle / 'proof.json', self.proof)
        self.write(self.bundle / 'release.json', P.canonical(self.release))
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w') as tar:
            for name, body in {'index.json': blobs['index_bytes'], 'blobs/sha256/' + self.graph.config_digest[7:]: blobs['config_bytes'], 'blobs/sha256/' + self.graph.manifest_digest[7:]: blobs['manifest_bytes']}.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(body)
                tar.addfile(entry, io.BytesIO(body))
        self.write(self.bundle / 'controller-image.tar', archive.getvalue())
        self.write(self.root / H.STATE_NAME, P.canonical(dict(schema='orbis.host.v1', root=str(self.root), dockerContext='fixture',
                   tag=self.release['tag'], digest=self.release['digest'], files=A.configuration_files(self.config))))
        self.review = dict(schema=A.REVIEW_SCHEMA, root=str(self.root), dockerContext='fixture', archiveKind='oci',
                           pointDigest=P.digest(P.canonical(self.point)), configurationDigest=P.digest(P.canonical(self.config)),
                           archiveRootId=P.digest(blobs['index_bytes']), archiveDigest=P.digest(archive.getvalue()), proofDigest=P.digest(self.proof),
                           releaseDigest=P.digest(P.canonical(self.release)), previousStateDigest=P.digest((self.root / H.STATE_NAME).read_bytes()))
        self.pin_review()
        self.write(self.root / 'orbis-compose.yml', A.override_content(self.release, creation).encode())

    def write(self, path, body):
        path.write_bytes(body)
        path.chmod(0o600)

    def pin_review(self):
        self.review_bytes = P.canonical(self.review)
        self.review_digest = P.digest(self.review_bytes)
        self.write(self.bundle / 'review.json', self.review_bytes)

    def authorize(self):
        with H.host_lock(self.root) as lock, mock.patch.object(A, 'trusted_observation', return_value=self.observed):
            return A.authorize_reviewed(self.root, 'fixture', self.bundle, self.review_digest,
                                       confirm_root=str(self.root), lock_fd=lock)

    def test_independent_review_derives_descriptor_and_boots_without_published_alias(self):
        descriptor = self.authorize()
        self.assertNotEqual(descriptor['creationReference'], self.release['image'] + '@' + self.release['digest'])
        calls = []
        def docker(context, args, root):
            calls.append(args)
            local = dict(Id=self.observed['imageId'], Os='linux', Architecture='arm64', RootFS=dict(Layers=self.observed['rootfsDiffIds']))
            return subprocess.CompletedProcess(args, 0, json.dumps(local if args[0] == 'image' else self.observed['creationReference']))
        core = dict(state='running', health='healthy', image=self.observed['creationReference'])
        with mock.patch.object(H, 'docker', side_effect=docker), mock.patch.object(H, 'current_core', return_value=core):
            result = H.execute(self.root, self.release, 'fixture', 'start', str(self.root))
            self.assertEqual(result['result'], 'healthy')
            self.assertEqual(H.resolve_current_identity(self.root, 'fixture').publication(), self.release)
            with self.assertRaises(ValueError):
                H.execute(self.root, self.release, 'fixture', 'enroll', str(self.root))
        self.assertTrue(any('--pull' in call and call[call.index('--pull') + 1] == 'never' for call in calls))
        self.assertFalse(any(call[0] == 'pull' for call in calls))

    def test_retained_service_config_publication_status_and_setup_share_authority(self):
        service_module = load('orbis-host-service.py', 'retained_service_test')
        service_host = service_module.HOST
        self.authorize()
        snapshots, state = self.base / 'snapshots', self.base / 'state'
        snapshots.mkdir(mode=0o700)
        state.mkdir(mode=0o700)
        service = service_module.HostService(self.root, 'fixture', snapshots, state)
        creation = self.observed['creationReference']
        core = dict(state='running', health='healthy', image=creation)
        container = dict(id='a' * 64, imageId=creation, imageReference=creation, project='runtipi', service='runtipi',
                         workingDirectory=str(self.root), running=True, restarting=False, paused=False, health='healthy', startedAt='fixture')
        local = dict(Id=creation, Os='linux', Architecture='arm64', RootFS=dict(Type='layers', Layers=self.observed['rootfsDiffIds']))
        def docker(context, args, root):
            value = local if args[0] == 'image' else creation if '{{json .Image}}' in args else container
            return subprocess.CompletedProcess(args, 0, json.dumps(value))
        with mock.patch.object(service_host.AUTHORITY, 'OWNER', os.geteuid()), mock.patch.object(service_host, 'docker', side_effect=docker), mock.patch.object(service_host, 'current_core', return_value=core):
            capture = service.capture_controller_config(self.config['pointId'], 'a' * 64, creation)
            self.assertEqual(capture['version'], 2)
            self.assertEqual(A.configuration_files(capture), service_host.saved_state(self.root)['files'])
            self.assertEqual(capture['controller']['imageReference'], creation)
            self.assertEqual(capture['retainedIdentity']['publishedReference'], self.release['image'] + '@' + self.release['digest'])
            request = dict(pointId=self.config['pointId'], controllerId='a' * 64, imageId=creation,
                           configurationSetSha256=capture['configurationSetSha256'])
            with mock.patch.object(service_module.CONTROLLER_IDENTITY, 'produce_bounded_publication', side_effect=AssertionError('retained capture must use independently authorized proof')):
                receipt = service.prepare_controller_publication(request)
            self.assertEqual(receipt['version'], 2)
            self.assertEqual(receipt['retainedIdentity'], capture['retainedIdentity'])
            self.assertEqual(service_module.installed_manifest(self.root, 'fixture'), self.release)
            status = service.status()
            self.assertTrue(status['enrolled'])
            self.assertTrue(status['imageMatches'])
            self.assertEqual(status['currentDigest'], self.release['digest'])
            # Private compatibility vectors for the independent Node decoder tests.
            self.last_capture, self.last_receipt = capture, receipt

    def update_fixture(self, *, fail_target=False):
        import re
        update = load('orbis-host-update.py', 'retained_update_test')
        host = update.HOST
        self.authorize()
        target = {**self.release, 'tag': 'v0.5.0-beta.4', 'digest': 'sha256:' + '9' * 64}
        target.pop('installationProtocol', None)
        creation = self.observed['creationReference']
        core = dict(state='running', health='healthy', image=creation)
        target_ref = target['image'] + '@' + target['digest']
        calls = []
        def docker(context, args, root):
            calls.append(args)
            if args[0] == 'inspect' and '{{json .Image}}' in args:
                return subprocess.CompletedProcess(args, 0, json.dumps(core['image']))
            if args[0] == 'image':
                local = dict(Id=creation, Os='linux', Architecture='arm64', RootFS=dict(Type='layers', Layers=self.observed['rootfsDiffIds']))
                return subprocess.CompletedProcess(args, 0, json.dumps(local))
            if 'up' in args:
                reference = re.search(r'^    image: (.+)$', (root / 'orbis-compose.yml').read_text(), re.M)[1]
                core.update(image=reference, health='unhealthy' if fail_target and reference == target_ref else 'healthy')
            return subprocess.CompletedProcess(args, 0, '')
        patches = [mock.patch.object(host.AUTHORITY, 'OWNER', os.geteuid()), mock.patch.object(host, 'docker', side_effect=docker),
                   mock.patch.object(host, 'current_core', side_effect=lambda *_: dict(core)),
                   mock.patch.object(host.PLAN, 'plan', return_value={'configuredImage': creation}),
                   mock.patch.object(update, 'core_ownership', return_value=set()), mock.patch.object(update, 'require_quiet_apps'),
                   mock.patch.object(update, 'stop_core'), mock.patch.object(update.SNAPSHOT, 'preflight', return_value={'bytes': 1}),
                   mock.patch.object(update.SNAPSHOT, 'capture'), mock.patch.object(update.SNAPSHOT, 'sidecar', return_value=self.base / 'absent'),
                   mock.patch.object(update.shutil, 'which', return_value='/fixture/rsync')]
        from contextlib import ExitStack
        with ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            verified = stack.enter_context(mock.patch.object(update, 'verify_release'))
            snapshot = self.base / 'update-snapshot'
            if fail_target:
                with self.assertRaisesRegex(RuntimeError, 'previous release was restored'):
                    update.apply_update(self.root, self.release, target, 'fixture', snapshot)
            else:
                result = update.apply_update(self.root, self.release, target, 'fixture', snapshot)
                self.assertEqual(result['result'], 'healthy')
            record = update.read_journal(snapshot, self.root, 'fixture', self.release, target)
            verified.assert_called_once_with(target)
            source = record['retainedSource']
            self.assertEqual(source['publication'], self.release)
            self.assertEqual(source['target'], target)
            self.assertEqual(source['descriptor']['creationReference'], creation)
            if fail_target:
                self.assertEqual(record['stage'], 'rolled-back')
                self.assertEqual(host.resolve_current_identity(self.root, 'fixture').publication(), self.release)
                self.assertEqual(core['image'], creation)
            else:
                self.assertEqual(record['stage'], 'complete')
                self.assertEqual(host.saved_state(self.root)['schema'], 'orbis.host.v1')
                self.assertEqual(core['image'], target_ref)
            source['descriptor']['archiveRootId'] = 'sha256:' + '8' * 64
            source['descriptorDigest'] = P.digest(P.canonical(source['descriptor']))
            with self.assertRaises(ValueError):
                update.retained_source(self.root, 'fixture', record, self.release, target)
            self.assertTrue(any(args == ['pull', target_ref] for args in calls))
            self.assertFalse(any(args == ['pull', self.release['image'] + '@' + self.release['digest']] for args in calls))

    def test_update_keeps_full_authorized_source_and_fresh_published_target_separate(self):
        self.update_fixture()

    def test_failed_target_rolls_back_to_authorized_retained_creation_without_alias(self):
        self.update_fixture(fail_target=True)

    def test_container_image_id_cannot_hide_behind_the_expected_creation_string(self):
        self.authorize()
        core = dict(state='running', health='healthy', image=self.observed['creationReference'])
        def docker(context, args, root):
            return subprocess.CompletedProcess(args, 0, json.dumps('sha256:' + '8' * 64))
        with mock.patch.object(H, 'current_core', return_value=core), mock.patch.object(H, 'docker', side_effect=docker), self.assertRaises(ValueError):
            H.resolve_current_identity(self.root, 'fixture')

    def test_each_independent_binding_is_enforced_even_if_review_rehashed(self):
        for key in ('pointDigest', 'configurationDigest', 'archiveRootId', 'archiveDigest', 'proofDigest', 'releaseDigest', 'previousStateDigest'):
            old = self.review[key]
            self.review[key] = 'sha256:' + '9' * 64
            self.pin_review()
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.authorize()
            self.review[key] = old
        self.pin_review()

    def test_unreviewed_bytes_and_candidate_self_authority_fail(self):
        with self.assertRaises(ValueError):
            with A.reviewed_bundle(self.bundle, 'sha256:' + '9' * 64, self.root, 'fixture'):
                pass
        self.write(self.bundle / 'review.json', P.canonical(dict(schema=A.IDENTITY.AUTHORITY_SCHEMA, descriptorDigest='sha256:' + '9' * 64)))
        with self.assertRaises(ValueError):
            self.authorize()

    def test_symlinks_hardlinks_permissions_and_owner_fail_closed(self):
        path = self.bundle / 'proof.json'
        body = path.read_bytes()
        path.unlink()
        path.symlink_to(self.bundle / 'release.json')
        with self.assertRaises(OSError):
            self.authorize()
        path.unlink()
        self.write(path, body)
        os.link(path, self.bundle / 'hardlink')
        with self.assertRaises(ValueError):
            self.authorize()
        (self.bundle / 'hardlink').unlink()
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            self.authorize()
        path.chmod(0o600)
        with mock.patch.object(A, 'OWNER', -1), self.assertRaises(ValueError):
            self.authorize()

    def test_pending_crash_blocks_reads_and_exact_retry_recovers(self):
        original = A.atomic
        def interrupted(path, body):
            if path.name == H.STATE_NAME:
                raise OSError('injected crash before enrollment commit')
            original(path, body)
        with mock.patch.object(A, 'atomic', side_effect=interrupted), self.assertRaises(OSError):
            self.authorize()
        with self.assertRaises(ValueError):
            with A.current(self.root, 'fixture', (self.root / H.STATE_NAME).read_bytes()):
                pass
        descriptor = self.authorize()
        with A.current(self.root, 'fixture', P.canonical(descriptor)) as (_, authority, _):
            self.assertEqual(authority['descriptorDigest'], P.digest(P.canonical(descriptor)))

    def test_mutation_during_protected_read_and_changed_config_reject(self):
        with self.assertRaises(ValueError):
            with A.reviewed_bundle(self.bundle, self.review_digest, self.root, 'fixture'):
                self.write(self.bundle / 'proof.json', self.proof + b' ')
        self.write(self.bundle / 'proof.json', self.proof)
        self.write(self.root / '.env', b'changed')
        with self.assertRaises(ValueError):
            self.authorize()

    def test_after_enrollment_authority_and_file_changes_do_not_become_adoption(self):
        descriptor = self.authorize()
        body = P.canonical(descriptor)
        for path in ('point.json', 'controller-image.tar', 'configuration.json', 'release.json'):
            file = self.bundle / path
            before = file.read_bytes()
            self.write(file, before + b' ')
            with self.subTest(path=path), self.assertRaises(ValueError):
                with A.current(self.root, 'fixture', body):
                    pass
            self.write(file, before)
        descriptor['creationReference'] = descriptor['sourceImageId']
        with self.assertRaises(ValueError):
            with A.current(self.root, 'fixture', P.canonical(descriptor)):
                pass


if __name__ == '__main__':
    unittest.main()
