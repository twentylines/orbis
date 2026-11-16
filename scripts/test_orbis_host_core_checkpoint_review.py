"""Real checkpoint tar bytes and link/metadata attacks; Docker inventory remains synthetic."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import unittest


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


R = load('orbis-host-core-checkpoint-review.py', 'core_checkpoint_review_test')
F = load('test_orbis_host_core_checkpoint.py', 'core_checkpoint_review_fixtures')


class CheckpointReviewTests(unittest.TestCase):
    def setUp(self):
        self.fixture = F.CheckpointTests('test_real_tar_copied_nested_pgdata_metadata_links_and_private_receipt')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        (self.fixture.pgdata / 'data').write_bytes(b'actual synthetic checkpoint file')
        (self.fixture.pgdata / 'symbolic').symlink_to('data')
        os.link(self.fixture.pgdata / 'data', self.fixture.pgdata / 'linked')
        self.fixture.prepare()
        receipt = self.fixture.build()
        self.file = self.fixture.artifact() / 'checkpoint.tar'
        self.expected = {key: receipt[key] for key in ('pointId', 'sourceSha256', 'checkpointSha256', 'resourceCount', 'compatibility', 'checkpoint')}
        self.expected['images'] = receipt['roleImageIds']
        self.authority = self.fixture.capture.a

    def review(self):
        return R.review_checkpoint(self.file, self.expected, self.authority)

    def rewrite(self, mutate):
        with tarfile.open(self.file) as archive:
            rows = [(copy.deepcopy(member), archive.extractfile(member).read() if member.isfile() else None) for member in archive]
        manifest = json.loads(rows[-1][1])
        mutate(rows, manifest)
        rows[-1] = (rows[-1][0], R.PACK.canonical(manifest))
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for member, body in rows:
                if body is not None:
                    member.size = len(body)
                archive.addfile(member, io.BytesIO(body) if body is not None else None)
        self.file.write_bytes(output.getvalue())
        self.expected['checkpoint'] = {'bytes': self.file.stat().st_size, 'sha256': hashlib.sha256(self.file.read_bytes()).hexdigest()}

    def test_actual_packer_bytes_preserve_nanosecond_metadata_links_and_pg_version(self):
        result = self.review()
        self.assertEqual(result['pointId'], self.expected['pointId'])
        self.assertEqual(result['compatibility']['database']['major'], 16)
        self.assertFalse(result['restoreAuthority'])
        self.assertEqual(result['roleImages'], self.expected['images'])

    def test_rewritten_hashes_cannot_hide_escaping_symbolic_link(self):
        def mutate(rows, manifest):
            member = next(item for item, _ in rows if item.issym())
            member.linkname = '../../../../outside'
            next(item for item in manifest['entries'] if item['path'] == member.name)['target'] = member.linkname
        self.rewrite(mutate)
        with self.assertRaises(ValueError):
            self.review()

    def test_rewritten_hashes_cannot_hide_pg_major_mismatch(self):
        def mutate(rows, manifest):
            for index, (member, body) in enumerate(rows):
                if member.name.endswith('/PG_VERSION'):
                    rows[index] = (member, b'99\n')
                    node = next(item for item in manifest['entries'] if item['path'] == member.name)
                    node.update(bytes=3, sha256=hashlib.sha256(b'99\n').hexdigest())
        self.rewrite(mutate)
        with self.assertRaises(ValueError):
            self.review()

    def test_unsupported_xattr_name_refuses(self):
        def mutate(rows, manifest):
            file = next(item for item in manifest['entries'] if item['type'] == 'file')
            file['xattrs'] = {'AA==': 'YQ=='}
        self.rewrite(mutate)
        with self.assertRaises(ValueError):
            self.review()

    def test_appended_nonzero_payload_refuses_even_when_archive_hash_is_updated(self):
        with self.file.open('ab') as output:
            output.write(b'not checkpoint padding'.ljust(512, b'\0'))
        self.expected['checkpoint'] = {'bytes': self.file.stat().st_size, 'sha256': hashlib.sha256(self.file.read_bytes()).hexdigest()}
        with self.assertRaises(ValueError):
            self.review()

    def test_wrong_retained_image_binding_refuses(self):
        self.expected['images']['controller'] = 'sha256:' + '0' * 64
        with self.assertRaises(ValueError):
            self.review()

    def test_undeclared_tar_member_and_oversized_pax_metadata_refuse(self):
        def mutate(rows, _manifest):
            member = tarfile.TarInfo('resources/0000/undeclared')
            member.mode = 0o600
            rows.insert(-1, (member, b'not declared'))
        self.rewrite(mutate)
        with self.assertRaises(ValueError):
            self.review()
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w', format=tarfile.PAX_FORMAT) as archive:
            member = tarfile.TarInfo('pax')
            member.type = tarfile.XHDTYPE
            member.size = 20000
            archive.addfile(member, io.BytesIO(b'\0' * member.size))
        self.file.write_bytes(output.getvalue())
        self.expected['checkpoint'] = {'bytes': self.file.stat().st_size, 'sha256': hashlib.sha256(self.file.read_bytes()).hexdigest()}
        with self.assertRaises(ValueError):
            self.review()


if __name__ == '__main__':
    unittest.main()
