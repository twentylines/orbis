"""Root publication filesystem tests; worker authentication and Docker are separate acceptance boundaries."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


E = load('orbis-host-core-portable-enrollment.py', 'core_portable_enrollment_test')
A = load('orbis-host-retained-authority.py', 'core_portable_test_authority')
F = load('test_orbis_host_core_checkpoint.py', 'core_portable_checkpoint_fixture')
ID = 'd813f20b-7aae-43c7-a999-c9393686add1'
POINT = F.POINT
CAPSULE = 'd813f20b-7aae-43c7-a999-c9393686add3'
ACTOR = {'ownerId': 17, 'sessionBinding': 'b' * 64, 'securityBinding': 'c' * 64}


class FakeRuntime:
    def __init__(self, data):
        self.data = data
        self.source = {'controllerId': 'a' * 64, 'imageId': 'sha256:' + 'd' * 64, 'container': {'Id': 'a' * 64}}

    def source_snapshot(self):
        return copy.deepcopy(self.source)

    def inspect(self, identifier):
        if identifier != self.source['controllerId']:
            raise AssertionError('Only the current enrolled controller is observed')
        return self.source['container']

    def map_path(self, _container, target):
        return self.data / target.removeprefix('/data/')

    def copy_file(self, source, destination, maximum):
        if source.stat().st_size > maximum:
            raise ValueError('Too large')
        with destination.open('xb') as output:
            destination.chmod(0o600)
            output.write(source.read_bytes())
            output.flush()
            os.fsync(output.fileno())
        if sys.platform == 'darwin':
            os.chflags(destination, destination.stat().st_flags | 0x40 | 0x8000, follow_symlinks=False)


class FakeAuthenticatedWorker:
    """Synthetic settled output, never a claim of cryptographic/worker acceptance."""
    def __init__(self):
        self.calls = 0

    def stage(self, record, directory):
        self.calls += 1
        point = {'version': 3, 'status': 'sealed', 'id': POINT, 'ownerId': ACTOR['ownerId'],
                 'createdAt': 1700000000000, 'envelope': {'keyId': record['destination']['keyId']}, 'core': {'version': 1}}
        outputs = {'core.orbis': b'synthetic cipher bytes', 'metadata.orbis': b'synthetic metadata',
                   'capture-draft.orbis': b'synthetic rebound draft'}
        digest = lambda body: {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
        point.update(archiveSha256=digest(outputs['core.orbis'])['sha256'], archiveBytes=len(outputs['core.orbis']),
                     metadataSha256=digest(outputs['metadata.orbis'])['sha256'])
        outputs['point.json'] = A.P.canonical(point)
        fixture = F.CheckpointTests('test_real_tar_copied_nested_pgdata_metadata_links_and_private_receipt')
        fixture.setUp()
        try:
            fixture.prepare()
            checkpoint_receipt = fixture.build()
            checkpoint_body = (fixture.artifact() / 'checkpoint.tar').read_bytes()
        finally:
            fixture.doCleanups()
        compatibility = checkpoint_receipt['compatibility']
        image_ids = sorted(set(checkpoint_receipt['roleImageIds'].values()))
        image_files = {'images/image-' + image_id.removeprefix('sha256:') + '.tar': ('synthetic image ' + image_id).encode() for image_id in image_ids}
        inventory = {'version': 1, 'images': [{'imageId': image_id} for image_id in image_ids],
                     'bindings': [{'key': role, 'imageId': image_id} for role, image_id in sorted(checkpoint_receipt['roleImageIds'].items())]}
        manifest = {'schema': 'orbis.time-machine-core.v1', 'pointId': POINT,
                    'sourceSha256': checkpoint_receipt['sourceSha256'], 'checkpointSha256': checkpoint_receipt['checkpointSha256'],
                    'captureReceiptSha256': hashlib.sha256(A.P.canonical(checkpoint_receipt)).hexdigest(),
                    'resourceCount': checkpoint_receipt['resourceCount'], 'inventory': inventory,
                    'imageInventorySha256': hashlib.sha256(A.P.canonical(inventory)).hexdigest(), 'compatibility': compatibility,
                    'entries': [{'name': 'checkpoint.tar', **digest(checkpoint_body)}, *[{'name': name, **digest(body)} for name, body in image_files.items()]]}
        manifest_body = A.P.canonical(manifest)
        point['core'].update({key: manifest[key] for key in ('sourceSha256', 'checkpointSha256', 'captureReceiptSha256', 'resourceCount', 'imageInventorySha256')})
        point['core']['manifestSha256'] = hashlib.sha256(manifest_body).hexdigest()
        outputs['point.json'] = A.P.canonical(point)
        target = directory / 'work/library/backups/time-machine/points' / POINT
        for parent in reversed([target, *list(target.parents)[:4]]):
            parent.mkdir(mode=0o700, exist_ok=True)
        for name, body in outputs.items():
            (target / name).write_bytes(body)
            (target / name).chmod(0o600)
        payload_dir = directory / 'work/payload'
        payload_dir.mkdir(mode=0o700)
        (payload_dir / 'images').mkdir(mode=0o700)
        payload_outputs = {'manifest.json': manifest_body, 'checkpoint.tar': checkpoint_body, **image_files}
        for name, body in payload_outputs.items():
            (payload_dir / name).write_bytes(body)
            (payload_dir / name).chmod(0o400)
        payload = {'schema': 'orbis.core-portable-payload.v1', 'pointId': POINT, 'manifestSha256': point['core']['manifestSha256'],
                   'files': {name: digest(body) for name, body in payload_outputs.items()}}
        metadata = {'id': POINT, 'version': 3, 'core': point['core'], 'restore': {'ready': False}, 'compatibility': compatibility}
        review = {'schema': 'orbis.core-portable-staged.v1', 'operationId': record['id'], 'capsuleId': CAPSULE,
                  'capsuleSha256': record['capsuleSha256'], 'pointId': POINT, 'createdAt': point['createdAt'],
                  'sourceOwnerId': 1, 'ownerId': ACTOR['ownerId'], 'keyId': record['destination']['keyId'],
                  'metadata': metadata, 'files': {name: digest(body) for name, body in outputs.items()}, 'payload': payload, 'restoreSupported': False}
        (directory / 'work/review.json').write_bytes(A.P.canonical(review))
        (directory / 'work/review.json').chmod(0o600)
        if sys.platform == 'darwin':
            # Native tracking flags must settle before sealing generated fixtures.
            for folder, _, names in os.walk(directory / 'work'):
                for name in names:
                    file = Path(folder) / name
                    if file.is_file():
                        os.chflags(file, file.stat().st_flags | 0x40 | 0x8000, follow_symlinks=False)
        record.update(workerIntent='complete', workerTerminal={'id': 'e' * 64, 'positiveSettlement': True})
        return review


class EnrollmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='core-portable-root-')
        self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name).resolve()
        self.root, self.state, self.data = [self.parent / name for name in ('install', 'state', 'data')]
        for directory in (self.root, self.state, self.data):
            directory.mkdir(mode=0o700)
        for name in ('backups', 'backups/time-machine', 'backups/time-machine/keys', 'backups/time-machine/points',
                     'backups/capsules', 'backups/capsules/' + CAPSULE):
            (self.data / name).mkdir(mode=0o700)
        self.library = self.data / 'backups/time-machine'
        (self.library / 'keys/master-v1.key').write_bytes(os.urandom(32))
        (self.library / 'keys/master-v1.key').chmod(0o600)
        body = b'synthetic authenticated worker input; see real encrypted capsule tests'
        (self.data / 'backups/capsules' / CAPSULE / 'capsule.orbis-tm').write_bytes(body)
        if sys.platform == 'darwin':
            for path in (self.library / 'keys/master-v1.key', self.data / 'backups/capsules' / CAPSULE / 'capsule.orbis-tm'):
                os.chflags(path, path.stat().st_flags | 0x40 | 0x8000, follow_symlinks=False)
        self.runtime, self.driver = FakeRuntime(self.data), FakeAuthenticatedWorker()
        self.service = SimpleNamespace(root=self.root, context='default', state_dir=self.state,
            HOST=SimpleNamespace(AUTHORITY=A, IDENTITY=SimpleNamespace(PUBLICATION=A.P)),
            retained_restores=lambda: SimpleNamespace(runtime=self.runtime))
        self.enterContext(mock.patch.object(A, 'OWNER', os.geteuid()))
        self.manager = E.CorePortableEnrollment(self.service, self.driver)
        self.enterContext(mock.patch.object(self.manager, 'implementation_sha256', return_value='9' * 64))
        if not hasattr(os, 'listxattr') or not hasattr(os, 'getxattr'):
            original_load = E.load
            def fixture_load(name, key):
                module = original_load(name, key)
                if name == 'orbis-host-core-checkpoint-materialize.py':
                    # Producer metadata is explicitly synthetic on this Python;
                    # Linux qualification must use the real xattr APIs.
                    module.R.PACK.attributes = lambda _target: {}
                return module
            self.enterContext(mock.patch.object(E, 'load', side_effect=fixture_load))
        self.request = {'id': ID, 'capsuleJobId': CAPSULE, 'capsuleSha256': hashlib.sha256(body).hexdigest(),
                        'actor': copy.deepcopy(ACTOR), 'passphrase': 'synthetic private test passphrase'}

    def prepared(self):
        result = self.manager.prepare(self.request, privileged_peer=True)
        self.assertEqual(result['phase'], 'awaiting-approval')
        self.assertEqual(result['sourceOwnerId'], 1)
        self.assertFalse(result['restoreSupported'])
        self.assertFalse((self.manager.directory(ID) / 'input/request.json').exists())
        self.approval = {'id': ID, 'actor': copy.deepcopy(ACTOR), 'reviewSha256': result['reviewSha256'],
                         'approvalNonce': result['approvalNonce'], 'action': 'enroll-core-portable-point'}
        return result

    def test_authenticated_worker_destination_enrollment_and_nonreplayable_approval(self):
        self.prepared()
        result = self.manager.approve(self.approval, privileged_peer=True)
        self.assertEqual(result['phase'], 'enrolled')
        self.assertFalse(result['restoreSupported'])
        provenance = self.manager.json(self.manager.directory(ID) / 'provenance.json')
        self.assertEqual(provenance['origin'], 'authenticated-portable-import')
        self.assertEqual(provenance['review']['sourceOwnerId'], 1)
        self.assertEqual(provenance['actor']['ownerId'], 17)
        self.assertNotIn('passphrase', json.dumps(provenance))
        self.assertNotIn('captureAuthority', provenance)
        self.assertEqual(provenance['resources']['schema'], 'orbis.core-portable-resources.v1')
        self.assertFalse(provenance['resources']['restoreAuthority'])
        self.assertEqual(self.manager.status({'id': ID, 'actor': ACTOR}, privileged_peer=True)['phase'], 'enrolled')
        with self.assertRaises(ValueError):
            self.manager.approve(self.approval, privileged_peer=True)
        with self.assertRaises(FileExistsError):
            self.manager.prepare(self.request, privileged_peer=True)
        self.assertEqual(self.driver.calls, 1)

    def test_materialized_resource_change_blocks_approval_without_publication(self):
        self.prepared()
        candidate = self.manager.directory(ID) / 'candidate/resources'
        file = next(path for path in candidate.rglob('*') if path.is_file() and not path.is_symlink())
        file.write_bytes(b'changed isolated resource')
        with self.assertRaises(ValueError):
            self.manager.approve(self.approval, privileged_peer=True)
        self.assertEqual(list((self.library / 'points').iterdir()), [])
        self.assertEqual(self.driver.calls, 1)

    def test_approval_expiring_during_full_review_never_publishes(self):
        self.prepared()
        now, original = E.time.time(), self.manager.checked_review
        with mock.patch.object(E.time, 'time', return_value=now) as clock:
            def delayed(record):
                value = original(record)
                clock.return_value = now + 301
                return value
            with mock.patch.object(self.manager, 'checked_review', side_effect=delayed):
                with self.assertRaises(ValueError):
                    self.manager.approve(self.approval, privileged_peer=True)
        self.assertFalse((self.manager.directory(ID) / 'approved.json').exists())
        self.assertEqual(list((self.library / 'points').iterdir()), [])

    def test_interrupted_materialization_is_durable_hold_without_worker_replay(self):
        original_load = E.load
        def interrupting_load(name, key):
            module = original_load(name, key)
            if name == 'orbis-host-core-checkpoint-materialize.py' and key.endswith('_prepare'):
                original_extract = module.extract
                def interrupted(*args):
                    with mock.patch.object(module.os, 'write', side_effect=OSError('synthetic interrupted candidate write')):
                        return original_extract(*args)
                module.extract = interrupted
            return module
        with mock.patch.object(E, 'load', side_effect=interrupting_load):
            with self.assertRaises(OSError):
                self.manager.prepare(self.request, privileged_peer=True)
        record = self.manager.record(ID)
        self.assertEqual(record['phase'], 'recovery-required')
        self.assertEqual(record['resourceIntent'], 'materializing')
        self.assertNotIn('resources', record)
        self.assertTrue((self.manager.directory(ID) / 'candidate/resources').is_dir())
        self.assertEqual(self.manager.status({'id': ID, 'actor': ACTOR}, privileged_peer=True, reconcile=True)['phase'], 'recovery-required')
        with self.assertRaises(FileExistsError):
            self.manager.prepare(self.request, privileged_peer=True)
        self.assertEqual(self.driver.calls, 1)
        self.assertEqual(list((self.library / 'points').iterdir()), [])

    def test_missing_privileged_peer_and_caller_source_owner_are_rejected(self):
        with self.assertRaises(ValueError):
            self.manager.prepare(self.request)
        with self.assertRaises(ValueError):
            self.manager.prepare({**self.request, 'sourceOwnerId': 9}, privileged_peer=True)
        self.assertEqual(self.driver.calls, 0)

    def test_approval_actor_session_and_expiry_are_bound(self):
        self.prepared()
        for field, value in (('ownerId', 18), ('sessionBinding', 'f' * 64), ('securityBinding', 'f' * 64)):
            wrong = copy.deepcopy(self.approval)
            wrong['actor'][field] = value
            with self.assertRaises(ValueError):
                self.manager.approve(wrong, privileged_peer=True)
        with mock.patch.object(E.time, 'time', return_value=2**45):
            with self.assertRaises(ValueError):
                self.manager.approve(self.approval, privileged_peer=True)
        self.assertFalse((self.library / 'points' / POINT).exists())

    def test_destination_key_inode_replacement_even_with_identical_bytes_refuses(self):
        self.prepared()
        key = self.library / 'keys/master-v1.key'
        body = key.read_bytes()
        key.unlink()
        key.write_bytes(body)
        key.chmod(0o600)
        with self.assertRaises(ValueError):
            self.manager.approve(self.approval, privileged_peer=True)
        self.assertFalse((self.library / 'points' / POINT).exists())

    def test_staged_inode_and_cipher_tampering_refuse(self):
        self.prepared()
        file = self.manager.directory(ID) / 'work/library/backups/time-machine/points' / POINT / 'core.orbis'
        body = file.read_bytes()
        file.unlink()
        file.write_bytes(body)
        file.chmod(0o600)
        with self.assertRaises(ValueError):
            self.manager.approve(self.approval, privileged_peer=True)

    def test_plaintext_payload_tampering_and_root_implementation_change_refuse(self):
        self.prepared()
        with mock.patch.object(self.manager, 'implementation_sha256', return_value='0' * 64):
            with self.assertRaises(ValueError):
                self.manager.approve(self.approval, privileged_peer=True)
        payload = self.manager.directory(ID) / 'work/payload/checkpoint.tar'
        payload.chmod(0o600)
        payload.write_bytes(b'changed plaintext checkpoint')
        with self.assertRaises(ValueError):
            self.manager.approve(self.approval, privileged_peer=True)
        self.assertFalse((self.library / 'points' / POINT).exists())

    def test_retained_prior_import_authority_blocks_identifier_reuse_before_publication(self):
        index = self.manager.child(self.state, 'core-portable-points')
        file = index / (POINT + '.json')
        file.write_text(json.dumps({'schema': E.SCHEMA, 'pointId': POINT, 'id': CAPSULE}))
        file.chmod(0o600)
        with self.assertRaises(E.EnrollmentError):
            self.manager.prepare(self.request, privileged_peer=True)
        self.assertFalse((self.library / 'points' / POINT).exists())

    def test_collision_preserves_preexisting_point(self):
        self.prepared()
        destination = self.library / 'points' / POINT
        destination.mkdir(mode=0o700)
        (destination / 'point.json').write_text('{}')
        (destination / 'point.json').chmod(0o600)
        with self.assertRaises(ValueError):
            self.manager.approve(self.approval, privileged_peer=True)
        self.assertEqual((destination / 'point.json').read_text(), '{}')

    def test_positive_worker_settlement_is_required(self):
        self.driver.stage = lambda *_: None
        with self.assertRaises(ValueError):
            self.manager.prepare(self.request, privileged_peer=True)
        self.assertEqual(self.manager.record(ID)['phase'], 'recovery-required')
        self.assertTrue((self.manager.directory(ID) / 'input/request.json').exists())

    def test_crash_after_rename_reconciles_exact_generation_without_another_worker(self):
        self.prepared()
        original = self.manager.immutable
        def interrupt(path, body):
            if path.name == 'enrolled.json':
                raise OSError('simulated crash after publication')
            return original(path, body)
        with mock.patch.object(self.manager, 'immutable', side_effect=interrupt):
            with self.assertRaises(OSError):
                self.manager.approve(self.approval, privileged_peer=True)
        self.assertTrue((self.library / 'points' / POINT).is_dir())
        self.assertEqual(self.manager.record(ID)['phase'], 'publishing')
        result = self.manager.status({'id': ID, 'actor': ACTOR}, privileged_peer=True, reconcile=True)
        self.assertEqual(result['phase'], 'enrolled')
        self.assertEqual(self.driver.calls, 1)

    def test_incomplete_private_publication_stage_is_a_hold(self):
        self.prepared()
        original = self.runtime.copy_file
        def interrupt(source, target, maximum):
            if target.parent.name.startswith('core-root-'):
                raise OSError('simulated incomplete generation')
            return original(source, target, maximum)
        with mock.patch.object(self.runtime, 'copy_file', side_effect=interrupt):
            with self.assertRaises(OSError):
                self.manager.approve(self.approval, privileged_peer=True)
        with self.assertRaises(ValueError):
            self.manager.status({'id': ID, 'actor': ACTOR}, privileged_peer=True, reconcile=True)
        self.assertFalse((self.library / 'points' / POINT).exists())
        self.assertEqual(self.driver.calls, 1)


if __name__ == '__main__':
    unittest.main()
