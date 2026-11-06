"""Real sealed-copy and tar bytes; Docker inventory is synthetic, never live."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load('orbis-host-core-checkpoint.py', 'portable_core_checkpoint_test')
F = load('test_orbis_host_time_machine_core.py', 'portable_core_capture_fixtures')
C = F.C
TX = C.TX
POINT = F.POINT


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='portable-core-checkpoint-')
        self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name).resolve()
        self.root, self.state, self.snapshots = [self.parent / name for name in ('install', 'state', 'snapshots')]
        for path in (self.root, self.state, self.snapshots):
            path.mkdir(mode=0o700)
        for name in ('.env', 'docker-compose.yml'):
            (self.root / name).write_bytes(b'private-real-bytes\x00\xff')
        (self.root / 'apps').mkdir()
        for index in range(3):
            (self.root / 'app-data' / f'app-{index}').mkdir(parents=True)
        self.docker = F.Docker(self.root)
        self.pgdata = self.docker.database_directory / 'nested'
        self.pgdata.mkdir()
        (self.pgdata / 'PG_VERSION').write_bytes(b'16\n')
        database = self.docker.services[F.identifier('runtipi-db')]
        database['environment'] = ['PGDATA=/var/lib/postgresql/data/nested']
        self.enterContext(mock.patch.object(C.HOST.AUTHORITY, 'OWNER', os.geteuid()))
        # macOS fixtures exercise byte/metadata logic; only Linux root is supported.
        if sys.platform != 'linux' or os.geteuid() != 0:
            self.enterContext(mock.patch.object(P, 'require_host'))
        if not hasattr(os, 'listxattr') or not hasattr(os, 'getxattr'):
            # This macOS Python lacks xattr APIs. Linux runs use the real APIs.
            self.enterContext(mock.patch.object(P, 'attributes', return_value={}))
        self.capture = C.CoreCapture(SimpleNamespace(root=self.root, state_dir=self.state, snapshots=self.snapshots, context=self.docker.context))
        self.directory = self.capture.base / POINT
        self.directory.mkdir(mode=0o700)
        self.bundle = self.snapshots / ('orbis-time-machine-core-' + POINT)

    def prepare(self):
        checkpoint = TX.review(self.root, self.docker, self.bundle, self.directory / 'checkpoint.json', scope=C.SCOPE)
        original = {row['id']: self.capture.observation(self.docker, row['id']) for row in self.docker.containers()}
        mapping = C.MAP.capture(TX, C.D, self.docker, checkpoint, original)
        self.bundle.mkdir(mode=0o700)
        manifest = {'schema': TX.STORAGE.SCHEMA, 'stage': 'complete', 'plan': checkpoint['storage'], 'copies': []}
        for index, item in enumerate(checkpoint['storage']['resources']):
            source, target = Path(item['source']), self.bundle / f'resource-{index:04d}'
            options = {'excluded': item.get('excludedPaths', [])}
            if item['kind'] == 'file':
                shutil.copy2(source, target)
                record = TX.STORAGE.file_fingerprint(target)
                entry = {'index': index, 'kind': 'file', 'record': record}
            else:
                target.mkdir()
                links, directories = {}, [(source, target)]
                for folder, folders, files in TX.STORAGE.SNAPSHOT.filtered_walk(source, options['excluded']):
                    for name in sorted(folders + files):
                        origin = Path(folder) / name
                        copied = target / origin.relative_to(source)
                        details = origin.lstat()
                        if stat.S_ISLNK(details.st_mode):
                            copied.symlink_to(os.readlink(origin))
                        elif stat.S_ISDIR(details.st_mode):
                            copied.mkdir()
                            directories.append((origin, copied))
                        else:
                            key = (details.st_dev, details.st_ino)
                            if key in links:
                                os.link(links[key], copied)
                            else:
                                shutil.copy2(origin, copied)
                                links[key] = copied
                for origin, copied in reversed(directories):
                    shutil.copystat(origin, copied, follow_symlinks=False)
                record = {'schema': TX.STORAGE.SNAPSHOT.SCHEMA, 'snapshot': str(target),
                          'sourceRoot': str(source), 'sourceRootMode': stat.S_IMODE(source.stat().st_mode),
                          **TX.STORAGE.SNAPSHOT.fingerprint(target)}
                if options['excluded']:
                    record['excludedPaths'] = options['excluded']
                TX.STORAGE.SNAPSHOT.write_sidecar(target, record)
                entry = {'index': index, 'kind': 'directory', 'record': record,
                         'directoryMetadata': TX.STORAGE.directory_metadata(target)}
            entry['attributes'] = TX.STORAGE.attributes_metadata(target)
            manifest['copies'].append(entry)
        TX.APPS.write_journal(self.bundle / 'storage.json', manifest)
        self.assertEqual(TX.STORAGE.verified_manifest(self.bundle), manifest)
        source = {'publication': {'tag': 'synthetic-test'}, 'enrollment': {'root': str(self.root)}}
        expected = {key: copy.deepcopy(original[key]) for key in checkpoint['roles']}
        self.job = {'schema': C.SCHEMA, 'id': POINT, 'root': str(self.root), 'context': self.docker.context,
                    'scope': C.SCOPE, 'phase': 'complete', 'pendingMutation': None, 'checkpoint': checkpoint,
                    'checkpointSha256': TX.APPS.digest(manifest), 'source': source, 'original': original,
                    'expected': expected, 'portableStorage': mapping}
        self.job['settlement'] = {'schema': 'orbis.time-machine-core-resumed.v1', 'pointId': POINT,
                                 'root': str(self.root), 'context': self.docker.context, 'scope': C.SCOPE,
                                 'sourceSha256': TX.APPS.digest(source), 'checkpointSha256': self.job['checkpointSha256'],
                                 'portableStorageSha256': TX.APPS.digest(mapping),
                                 'containersSha256': TX.APPS.digest({**original, **expected}),
                                 'originalCoreIds': sorted(expected), 'restoredSnapshotBytes': False}
        self.capture.save(self.job)
        self.assertEqual(self.capture.read(self.directory), self.job)
        return mapping

    def artifact(self):
        return self.directory / 'portable-checkpoint'

    def build(self):
        return P.build(self.capture, POINT, tx=TX)

    def copied_pgdata(self, mapping):
        database = mapping['database']
        return self.bundle / f"resource-{database['resourceIndex']:04d}" / database['resourcePath']

    def test_real_tar_copied_nested_pgdata_metadata_links_and_private_receipt(self):
        data = b'checkpoint\x00payload\xff' * 10_000
        file = self.pgdata / 'relation'
        file.write_bytes(data)
        file.chmod(0o640)
        os.utime(file, ns=(1_700_000_000_123456789, 1_700_000_001_987654321))
        os.link(file, self.pgdata / 'relation-linked')
        (self.pgdata / 'relation-symbolic').symlink_to('relation')
        if hasattr(os, 'setxattr'):
            try:
                os.setxattr(file, 'user.orbis-test', b'\x00binary\xff')
            except OSError:
                pass
        mapping = self.prepare()
        (self.pgdata / 'PG_VERSION').write_bytes(b'99\n')
        receipt = self.build()
        self.assertEqual(receipt['compatibility'], {'os': 'linux', 'architecture': 'amd64',
                         'database': {'engine': 'postgresql', 'major': 16}, 'storageFormat': 'physical-pgdata.v1'})
        self.assertEqual(P.read_receipt(self.capture, POINT, tx=TX), receipt)
        archive_path = self.artifact() / 'checkpoint.tar'
        self.assertEqual(receipt['checkpoint'], {'bytes': archive_path.stat().st_size,
                                               'sha256': hashlib.sha256(archive_path.read_bytes()).hexdigest()})
        with tarfile.open(archive_path) as archive:
            manifest_bytes = archive.extractfile('manifest.json').read()
            manifest = json.loads(manifest_bytes)
            self.assertEqual(receipt['manifestSha256'], hashlib.sha256(manifest_bytes).hexdigest())
            self.assertNotIn(str(self.parent).encode(), manifest_bytes)
            self.assertNotIn(b'storage.json', manifest_bytes)
            self.assertIn('unproven', manifest['compatibilityEvidence'])
            address = mapping['database']
            prefix = f"resources/{address['resourceIndex']:04d}/" + address['resourcePath']
            entries = {entry['path']: entry for entry in manifest['entries']}
            entry = entries[prefix + '/relation']
            self.assertEqual(archive.extractfile(prefix + '/relation').read(), data)
            self.assertEqual(entry['mtimeNs'], 1_700_000_001_987654321)
            self.assertEqual(entry['mode'], 0o640)
            self.assertEqual(entry['uid'], file.stat().st_uid)
            self.assertEqual(entry['sha256'], hashlib.sha256(data).hexdigest())
            self.assertTrue(archive.getmember(prefix + '/relation-linked').islnk())
            self.assertEqual(entries[prefix + '/relation-linked']['target'], prefix + '/relation')
            self.assertTrue(archive.getmember(prefix + '/relation-symbolic').issym())
            expected_attrs = P.attributes(self.copied_pgdata(mapping) / 'relation')
            self.assertEqual(entry['xattrs'], expected_attrs)
            if base64.b64encode(b'user.orbis-test').decode() in expected_attrs:
                self.assertEqual(base64.b64decode(expected_attrs[base64.b64encode(b'user.orbis-test').decode()]), b'\x00binary\xff')
            self.assertTrue(all(name == 'manifest.json' or name.startswith('resources/') for name in archive.getnames()))
        for path, mode in ((self.artifact(), 0o700), (archive_path, 0o600), (self.artifact() / 'artifact.json', 0o600)):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), mode)

    def test_missing_or_malformed_mapping_and_incomplete_capture(self):
        self.prepare()
        for mutate in (lambda job: job.pop('portableStorage'),
                       lambda job: job['portableStorage']['database'].update(resourcePath='../live'),
                       lambda job: job.update(phase='resuming'),
                       lambda job: job.update(checkpointSha256='0' * 64)):
            original = copy.deepcopy(self.job)
            mutate(self.job)
            self.capture.save(self.job)
            with self.assertRaises((ValueError, KeyError)):
                self.build()
            self.assertFalse(self.artifact().exists())
            self.job = original
        self.capture.save(self.job)

    def test_changed_copy_and_pgdata_symlink_are_rejected(self):
        mapping = self.prepare()
        copied = self.copied_pgdata(mapping)
        (copied / 'PG_VERSION').write_bytes(b'17\n')
        with self.assertRaises(ValueError):
            self.build()
        self.assertFalse(self.artifact().exists())
        (copied / 'PG_VERSION').unlink()
        (copied / 'PG_VERSION').symlink_to(self.pgdata / 'PG_VERSION')
        with self.assertRaises((ValueError, OSError)):
            P.pg_major(self.bundle, mapping)
        copied.rename(copied.with_name('other'))
        copied.symlink_to('other', target_is_directory=True)
        with self.assertRaises(OSError):
            P.pg_major(self.bundle, mapping)

    def test_pg_major_bounds_and_non_regular_files(self):
        mapping = self.prepare()
        version = self.copied_pgdata(mapping) / 'PG_VERSION'
        for value in (b'0', b'100', b'016', b'16.1', b'16\nprivate', b'1' * 17):
            version.write_bytes(value)
            with self.assertRaises(ValueError):
                P.pg_major(self.bundle, mapping)
        version.unlink()
        version.mkdir()
        with self.assertRaises(ValueError):
            P.pg_major(self.bundle, mapping)

    def test_existing_destination_and_receipt_are_never_overwritten(self):
        self.prepare()
        self.artifact().mkdir(mode=0o700)
        sentinel = self.artifact() / 'artifact.json'
        sentinel.write_bytes(b'prior-recovery-evidence')
        with self.assertRaises(FileExistsError):
            self.build()
        self.assertEqual(sentinel.read_bytes(), b'prior-recovery-evidence')

    def test_write_failure_and_source_mutation_publish_no_receipt(self):
        mapping = self.prepare()
        with mock.patch.object(P, 'tar_entry', side_effect=OSError('synthetic full disk')):
            with self.assertRaises(OSError):
                self.build()
        self.assertFalse(self.artifact().exists())
        real_digest = P.archive_digest
        def mutate(*args):
            (self.copied_pgdata(mapping) / 'PG_VERSION').write_bytes(b'42\n')
            return real_digest(*args)
        with mock.patch.object(P, 'archive_digest', side_effect=mutate):
            with self.assertRaises(ValueError):
                self.build()
        self.assertFalse(self.artifact().exists())

    def test_partial_publication_is_preserved_and_cannot_be_replayed(self):
        self.prepare()
        real_link = os.link
        def fail_receipt(source, target, **kwargs):
            if target == 'artifact.json':
                raise OSError('synthetic receipt publication failure')
            return real_link(source, target, **kwargs)
        with mock.patch.object(P.os, 'link', side_effect=fail_receipt):
            with self.assertRaises(OSError):
                self.build()
        self.assertTrue((self.artifact() / 'checkpoint.tar').is_file())
        self.assertFalse((self.artifact() / 'artifact.json').exists())
        self.assertEqual([path.name for path in self.artifact().iterdir()], ['checkpoint.tar'])
        with self.assertRaises(FileExistsError):
            self.build()

    def test_collect_rejects_escaping_symlinks_and_hardlink_groups_and_special_files(self):
        mapping = self.prepare()
        copied = self.copied_pgdata(mapping)
        link = copied / 'escape'
        link.symlink_to('../../../../escape')
        with self.assertRaises(ValueError):
            P.collect(self.bundle, self.job['checkpoint']['storage']['resources'])
        link.unlink()
        outside = self.parent / 'outside'
        outside.write_bytes(b'not-captured')
        os.link(outside, link)
        with self.assertRaises(ValueError):
            P.collect(self.bundle, self.job['checkpoint']['storage']['resources'])
        link.unlink()
        os.mkfifo(link)
        with self.assertRaises(ValueError):
            P.collect(self.bundle, self.job['checkpoint']['storage']['resources'])

    def test_cross_resource_hardlinks_and_indirect_symbolic_escape_are_rejected(self):
        self.bundle.mkdir(mode=0o700)
        roots = [self.bundle / f'resource-{index:04d}' for index in range(2)]
        for path in roots:
            path.mkdir()
        (roots[0] / 'data').write_bytes(b'linked across copied resource roots')
        os.link(roots[0] / 'data', roots[1] / 'data')
        resources = [{'kind': 'directory'}, {'kind': 'directory'}]
        with self.assertRaises(ValueError):
            P.collect(self.bundle, resources)
        (roots[1] / 'data').unlink()
        (roots[0] / 'nested').mkdir()
        (roots[0] / 'nested' / 'step').symlink_to('..')
        (roots[0] / 'indirect').symlink_to('nested/step/../outside')
        with self.assertRaises(ValueError):
            P.collect(self.bundle, resources)

    def test_postcheck_job_mutation_and_unreadable_metadata_fail_closed(self):
        self.prepare()
        real_digest = P.archive_digest
        def mutate(*args):
            self.job['source']['publication']['tag'] = 'changed'
            self.capture.save(self.job)
            return real_digest(*args)
        with mock.patch.object(P, 'archive_digest', side_effect=mutate):
            with self.assertRaises(ValueError):
                self.build()
        self.assertFalse(self.artifact().exists())
        with mock.patch.object(P, 'attributes', side_effect=OSError('unreadable xattr')):
            with self.assertRaises(OSError):
                P.collect(self.bundle, self.job['checkpoint']['storage']['resources'])

    def test_receipt_reader_checks_bindings_and_does_not_hash_data(self):
        self.prepare()
        receipt = self.build()
        with mock.patch.object(P, 'archive_digest', side_effect=AssertionError('status cannot hash archive')):
            self.assertEqual(P.read_receipt(self.capture, POINT, tx=TX), receipt)
        receipt['captureJobSha256'] = '0' * 64
        (self.artifact() / 'artifact.json').write_bytes(P.canonical(receipt))
        with self.assertRaises(ValueError):
            P.read_receipt(self.capture, POINT, tx=TX)


if __name__ == '__main__':
    unittest.main()
