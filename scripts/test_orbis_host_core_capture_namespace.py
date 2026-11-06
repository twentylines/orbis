"""Real Linux procfs/FD retirement in explicitly disposable /data tmpfs only."""
import copy
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import test_orbis_host_core_capture_worker as workers


W = workers.W
N = W.load('orbis-host-core-capture-namespace.py', 'core_namespace_subject')
SERVICE = W.load('orbis-host-core-capture-service.py', 'core_namespace_preflight_service')
POINT = '12345678-1234-4234-8234-123456789abc'


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0
    and os.environ.get('ORBIS_CORE_NAMESPACE_TEST_ROOT') == '1', 'requires owned Linux fixture /data tmpfs')
class NamespaceTests(unittest.TestCase):
    def setUp(self):
        mounts = [line.split() for line in Path('/proc/self/mountinfo').read_text().splitlines()]
        self.assertTrue(any(row[4] == '/data' and row[row.index('-') + 1] == 'tmpfs' for row in mounts))
        self.base = Path('/data/backups')
        self.assertFalse(self.base.exists(), 'The fixture must never overwrite pre-existing /data backups')
        self.root = self.base / 'time-machine' / 'core-capture'
        (self.root / POINT).mkdir(parents=True, mode=0o700)
        for directory in (self.base, self.base / 'time-machine', self.root):
            directory.chmod(0o700)
        self.addCleanup(shutil.rmtree, self.base)
        self.frame = {'id': 'a' * 64, 'imageId': 'sha256:' + 'b' * 64,
            'startedAt': '2026-11-06T00:00:00Z', 'definitionSha256': 'c' * 64}
        self.raw = {'Id': self.frame['id'], 'Image': self.frame['imageId'], 'State': {
            'Pid': os.getpid(), 'Status': 'running', 'Running': True, 'Paused': False,
            'Restarting': False, 'StartedAt': self.frame['startedAt']}}
        self.reader = SimpleNamespace(_object=lambda _: copy.deepcopy(self.raw))
        self.hold = {'schema': 'orbis.core-capture-source-hold.v2', 'id': POINT, 'privateFixture': True}
        self.body = W.P.canonical(self.hold)
        self.file = self.root / 'source-hold.json'
        self.file.write_bytes(self.body)
        self.file.chmod(0o600)
        self.expected = W.digest(self.body)
        self.ready = self.root / POINT / 'continuation-ready.json'
        self.ready.write_bytes(W.P.canonical({'schema': 'fixture-only'}))
        self.ready.chmod(0o600)

    def namespace(self):
        return N.CaptureNamespace(W, self.reader, self.frame)

    def test_actual_proc_root_read_and_no_clobber_inode_preserving_retirement(self):
        before = self.file.stat()
        with self.namespace() as namespace:
            self.assertEqual(namespace.read_continuation(POINT)[0], {'schema': 'fixture-only'})
            result = namespace.retire_hold(POINT, self.expected)
            self.assertEqual(namespace.retire_hold(POINT, self.expected), result)
        retired = self.root / ('source-hold-retired-' + POINT + '.json')
        self.assertFalse(self.file.exists())
        self.assertEqual(retired.read_bytes(), self.body)
        self.assertEqual((retired.stat().st_dev, retired.stat().st_ino), (before.st_dev, before.st_ino))

    def test_pre_downtime_filesystem_probe_cleans_only_its_exclusive_empty_file(self):
        parent = self.root.parent
        before = set(parent.iterdir())
        with self.namespace() as namespace:
            namespace.verify_storage_root(POINT)
        self.assertEqual(set(parent.iterdir()), before)
        self.assertTrue(self.file.exists())

    def test_service_preflight_uses_actual_namespace_and_both_filesystems_under_host_lock(self):
        with tempfile.TemporaryDirectory(prefix='namespace-service-') as temporary:
            root = Path(temporary) / 'installation'
            root.mkdir(mode=0o700)
            manager = object.__new__(SERVICE.CoreCaptureService)
            manager.root, manager.context = root, 'fixture-context'
            with mock.patch.object(SERVICE.C.TX.APPS, 'Docker', return_value=self.reader):
                with SERVICE.H.host_lock(root):
                    SERVICE.CoreCaptureService.require_namespace_access(manager, self.frame, POINT)
            self.assertFalse(any('retirement-probe' in path.name for path in Path(temporary).iterdir()))
        self.assertTrue(self.file.exists())

    def test_existing_probe_evidence_is_never_replaced_or_cleaned(self):
        source = self.root.parent / ('.orbis-core-retirement-probe-' + POINT)
        source.write_bytes(b'preserve preexisting data')
        source.chmod(0o600)
        with self.namespace() as namespace, self.assertRaises(FileExistsError):
            namespace.verify_storage_root(POINT)
        self.assertEqual(source.read_bytes(), b'preserve preexisting data')
        self.assertTrue(self.file.exists())

    def test_wrong_digest_and_missing_evidence_never_remove_marker(self):
        with self.namespace() as namespace:
            with self.assertRaises(N.NamespaceError):
                namespace.retire_hold(POINT, '0' * 64)
            self.assertTrue(self.file.exists())
            self.file.unlink()
            with self.assertRaises(N.NamespaceError):
                namespace.retire_hold(POINT, self.expected)

    def test_conflicting_or_symlinked_retired_entry_never_gets_overwritten(self):
        retired = self.root / ('source-hold-retired-' + POINT + '.json')
        retired.write_bytes(b'preserve unexpected evidence')
        retired.chmod(0o600)
        with self.namespace() as namespace, self.assertRaises(ValueError):
            namespace.retire_hold(POINT, self.expected)
        self.assertEqual(retired.read_bytes(), b'preserve unexpected evidence')
        retired.unlink()
        retired.symlink_to(self.file)
        with self.namespace() as namespace, self.assertRaises(OSError):
            namespace.retire_hold(POINT, self.expected)
        self.assertEqual(self.file.read_bytes(), self.body)

    def test_changed_controller_pid_startup_or_process_witness_fails_before_mutation(self):
        for changes in ({'Pid': os.getpid() + 10000000}, {'StartedAt': 'changed'}, {'Running': False}, {'Pid': True}):
            original = copy.deepcopy(self.raw)
            self.raw['State'].update(changes)
            with self.subTest(changes=changes), self.assertRaises((N.NamespaceError, OSError)):
                with self.namespace():
                    pass
            self.raw = original
        with self.namespace() as namespace:
            with mock.patch.object(namespace, '_start', return_value=namespace.start + 1), self.assertRaises(N.NamespaceError):
                namespace.retire_hold(POINT, self.expected)
        self.assertTrue(self.file.exists())

    def test_world_writable_symlinked_or_replaced_storage_is_refused(self):
        self.root.chmod(0o777)
        with self.namespace() as namespace, self.assertRaises(N.NamespaceError):
            namespace.read_continuation(POINT)
        self.root.chmod(0o700)
        (self.root / POINT).rename(self.root / 'retained')
        (self.root / POINT).symlink_to(self.root / 'retained')
        with self.namespace() as namespace, self.assertRaises(OSError):
            namespace.read_continuation(POINT)
        self.assertTrue(self.file.exists())

    def test_failure_after_rename_preserves_positive_receipt_for_reconciliation(self):
        with self.namespace() as namespace:
            with (mock.patch.object(N.os, 'fsync', side_effect=OSError('fixture directory sync interruption')),
                    self.assertRaises(OSError)):
                namespace.retire_hold(POINT, self.expected)
            self.assertFalse(self.file.exists())
            result = namespace.retire_hold(POINT, self.expected)
            self.assertEqual(result['sourceHoldSha256'], self.expected)

    def test_fixed_abort_witness_readers_and_original_marker_identity(self):
        names = ('device', 'inode', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs')
        fields = N.FILES + ('st_ctime_ns',)
        before = self.file.stat()
        pinned = dict(zip(names, (str(getattr(before, field)) for field in fields)))
        terminal = self.root / POINT / 'abort-terminal.json'
        ready = self.root / POINT / 'abort-continuation-ready.json'
        for file, value in ((terminal, {'schema': 'fixture-abort-terminal'}), (ready, {'schema': 'fixture-abort-ready'})):
            file.write_bytes(W.P.canonical(value))
            file.chmod(0o600)
        with self.namespace() as namespace:
            self.assertEqual(namespace.read_abort_terminal(POINT)[0], {'schema': 'fixture-abort-terminal'})
            self.assertEqual(namespace.read_abort_continuation(POINT)[0], {'schema': 'fixture-abort-ready'})
            self.assertEqual(namespace.read_source_hold(POINT)[1], self.body)
            with self.assertRaises(N.NamespaceError):
                namespace.retire_hold(POINT, self.expected, identity={**pinned, 'inode': str(before.st_ino + 1)})
            witness = namespace.retire_hold(POINT, self.expected, identity=pinned)
            self.assertEqual(namespace.retire_hold(POINT, self.expected, identity=pinned), witness)
            self.assertEqual(namespace.read_source_hold(POINT, retired=True)[1], self.body)

    def test_replaced_identical_retired_marker_cannot_replace_original_abort_evidence(self):
        names = ('device', 'inode', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs')
        fields = N.FILES + ('st_ctime_ns',)
        pinned = dict(zip(names, (str(getattr(self.file.stat(), field)) for field in fields)))
        with self.namespace() as namespace:
            namespace.retire_hold(POINT, self.expected, identity=pinned)
            retired = self.root / ('source-hold-retired-' + POINT + '.json')
            retired.rename(self.root / 'original-marker-evidence')
            retired.write_bytes(self.body)
            retired.chmod(0o600)
            with self.assertRaises(N.NamespaceError):
                namespace.retire_hold(POINT, self.expected, identity=pinned)

    def test_symlinked_abort_witness_is_not_followed(self):
        terminal = self.root / POINT / 'abort-terminal.json'
        terminal.symlink_to(self.ready)
        with self.namespace() as namespace, self.assertRaises(OSError):
            namespace.read_abort_terminal(POINT)

    def test_never_attempted_marker_consistency_is_pinned_and_never_removes_active_data(self):
        with self.namespace() as namespace:
            with self.assertRaises(N.NamespaceError): namespace.verify_no_source_hold(POINT)
            self.assertEqual(self.file.read_bytes(), self.body)
            self.file.rename(self.root / 'marker-evidence')
            observed = namespace.verify_no_source_hold(POINT)
            self.assertEqual(observed, {'schema': 'orbis.core-capture-marker-absence.v1', 'id': POINT,
                'controller': self.frame, 'directoryIdentity': dict(zip(N.FIELDS,
                    (getattr(self.root.stat(), field) for field in N.FIELDS)))})

    def test_never_attempted_marker_check_refuses_partial_and_symlink_retired_entries(self):
        self.file.rename(self.root / 'marker-evidence')
        retired = self.root / ('source-hold-retired-' + POINT + '.json')
        retired.write_bytes(b'{')
        retired.chmod(0o600)
        with self.namespace() as namespace, self.assertRaises(N.NamespaceError): namespace.verify_no_source_hold(POINT)
        self.assertEqual(retired.read_bytes(), b'{')
        retired.rename(self.root / 'partial-retired-evidence')
        retired.symlink_to(self.root / 'missing-target')
        with self.namespace() as namespace, self.assertRaises(N.NamespaceError): namespace.verify_no_source_hold(POINT)
        self.assertTrue(retired.is_symlink())

    def test_never_attempted_marker_check_requires_unchanged_controller_namespace(self):
        self.file.rename(self.root / 'marker-evidence')
        with self.namespace() as namespace:
            with mock.patch.object(namespace, '_start', return_value=namespace.start + 1), self.assertRaises(N.NamespaceError):
                namespace.verify_no_source_hold(POINT)
        self.assertTrue((self.root / 'marker-evidence').exists())


if __name__ == '__main__':
    unittest.main()
