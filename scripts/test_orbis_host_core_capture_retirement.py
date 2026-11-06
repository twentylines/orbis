import copy
import importlib.util
import errno
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


R = load('orbis-host-core-capture-retirement.py', 'retirement_subject')
W = load('orbis-host-core-capture-worker.py', 'retirement_worker_fixture')


class AtomicRenameTests(unittest.TestCase):
    def test_missing_libc_wrapper_uses_only_the_known_lp64_linux_syscall(self):
        for machine, number in (('x86_64', 316), ('aarch64', 276)):
            function = mock.Mock(return_value=0)
            with mock.patch.object(R.sys, 'platform', 'linux'), \
                    mock.patch.object(R.os, 'uname', return_value=SimpleNamespace(machine=machine)), \
                    mock.patch.object(R.ctypes, 'sizeof', return_value=8), \
                    mock.patch.object(R.ctypes, 'CDLL', return_value=SimpleNamespace(syscall=function)):
                R.rename_noreplace(4, 'source', 'target')
                function.assert_called_once_with(number, 4, b'source', 4, b'target', 1)

    def test_unknown_architecture_or_pointer_abi_has_no_nonatomic_fallback(self):
        for machine, width in (('unknown', 8), ('x86_64', 4), ('aarch64', 4)):
            function = mock.Mock(return_value=0)
            with mock.patch.object(R.sys, 'platform', 'linux'), \
                    mock.patch.object(R.os, 'uname', return_value=SimpleNamespace(machine=machine)), \
                    mock.patch.object(R.ctypes, 'sizeof', return_value=width), \
                    mock.patch.object(R.ctypes, 'CDLL', return_value=SimpleNamespace(syscall=function)):
                with self.assertRaises(OSError) as caught:
                    R.rename_noreplace(4, 'source', 'target')
                self.assertEqual(caught.exception.errno, errno.ENOTSUP)
                function.assert_not_called()

    def test_kernel_or_filesystem_rejection_is_preserved(self):
        for code in (errno.ENOSYS, errno.EOPNOTSUPP, errno.EEXIST):
            with mock.patch.object(R.sys, 'platform', 'linux'), \
                    mock.patch.object(R.os, 'uname', return_value=SimpleNamespace(machine='aarch64')), \
                    mock.patch.object(R.ctypes, 'sizeof', return_value=8), \
                    mock.patch.object(R.ctypes, 'CDLL', return_value=SimpleNamespace(syscall=mock.Mock(return_value=-1))), \
                    mock.patch.object(R.ctypes, 'get_errno', return_value=code):
                with self.assertRaises(OSError) as caught:
                    R.rename_noreplace(4, 'source', 'target')
                self.assertEqual(caught.exception.errno, code)

    @unittest.skipUnless(R.sys.platform.startswith('linux') and os.uname().machine in {'x86_64', 'aarch64'}
        and R.ctypes.sizeof(R.ctypes.c_void_p) == 8 and R.ctypes.sizeof(R.ctypes.c_long) == 8, 'requires known native Linux syscall ABI')
    def test_actual_kernel_fallback_preserves_inode_and_never_replaces_target(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source, target = base / 'source', base / 'target'
            source.write_bytes(b'original recovery evidence')
            expected = R.lease_identity(source.stat())
            parent = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            libc = R.ctypes.CDLL(None, use_errno=True)
            try:
                with mock.patch.object(R.ctypes, 'CDLL', return_value=SimpleNamespace(syscall=libc.syscall)):
                    R.rename_noreplace(parent, source.name, target.name)
                    self.assertEqual(R.lease_identity(target.stat()), expected)
                    source.write_bytes(b'new unrelated hold')
                    with self.assertRaises(FileExistsError):
                        R.rename_noreplace(parent, source.name, target.name)
                self.assertEqual(source.read_bytes(), b'new unrelated hold')
                self.assertEqual(target.read_bytes(), b'original recovery evidence')
            finally:
                os.close(parent)
POINT = '00000000-0000-4000-8000-000000000001'
OTHER = '00000000-0000-4000-8000-000000000002'


class CaptureRetirementTests(unittest.TestCase):
    def setUp(self):
        # Host privilege is injected on macOS; files, strict authority checks,
        # ContextVars, lock acquisition, inode preservation and rename are real.
        temp = tempfile.TemporaryDirectory(prefix='core-retirement-')
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name).resolve()
        self.root, self.state, self.snapshots = [self.folder / name for name in ('install', 'state', 'snapshots')]
        for path in (self.root, self.state, self.snapshots):
            path.mkdir(mode=0o700)
        self.H, self.A, self.P = W.CORE.HOST, W.A, W.P
        self.enterContext(mock.patch.object(W, 'require_root'))
        self.enterContext(mock.patch.object(self.A, 'OWNER', os.geteuid()))
        self.context = 'fixture-context'
        with self.H.host_lock(self.root):
            self.lease = W.LEASE.CoreCaptureLease.reserve(self.H, self.root, self.context, POINT, 'a' * 64)
        self.path = self.H.capture_fence_path(self.root)
        self.target = self.path.with_name(self.path.name + '.retired-' + POINT)
        self.body = self.path.read_bytes()
        with self.lease.owner() as grant:
            self.grant = grant
        base = self.state / 'core-capture-admissions'
        base.mkdir(mode=0o700)
        self.directory = base / POINT
        self.directory.mkdir(mode=0o700)
        self.request = {'schema': 'orbis.core-capture-admission.v1', 'id': POINT, 'root': str(self.root),
                        'context': self.context, 'snapshots': str(self.snapshots),
                        'sourceSha256': self.grant['sourceSha256'], 'leaseNonce': self.grant['nonce'],
                        'handoffSha256': 'b' * 64}
        self.write('request.json', self.request)
        self.commit = {'schema': R.SCHEMA, 'id': POINT, 'root': str(self.root), 'context': self.context,
                       'requestSha256': W.digest(self.P.canonical(self.request)), 'leaseSha256': W.digest(self.body),
                       'leaseIdentity': R.lease_identity(self.path.stat()), 'completionSha256': 'c' * 64,
                       'sourceHoldSha256': 'd' * 64, 'continuationSha256': 'e' * 64,
                       'pointReservationSha256': 'f' * 64}
        self.write('completion-commit.json', self.commit)

    def write(self, name, value):
        path = self.directory / name
        path.write_bytes(self.P.canonical(value))
        path.chmod(0o600)

    def retirement(self, root=None, context=None):
        return R.CaptureRetirement(W, self.state, root or self.root, context or self.context, POINT)

    def retire(self, instance=None):
        with self.lease.owner(), self.H.host_lock(self.root):
            return (instance or self.retirement()).retire_committed()

    def assert_preserved(self):
        self.assertFalse(self.path.exists())
        self.assertEqual(self.target.read_bytes(), self.body)
        self.assertEqual(R.lease_identity(self.target.stat()), self.commit['leaseIdentity'])

    def test_real_private_commit_lock_and_no_clobber_rename_preserve_original_inode(self):
        self.assertEqual(self.retire(), self.commit)
        self.assert_preserved()
        with self.H.host_lock(self.root):
            pass

    def test_history_inspection_and_replay_use_no_live_admission(self):
        self.retire()
        with mock.patch.object(W, 'Admission', side_effect=AssertionError('live lease unavailable')):
            self.assertEqual(self.retirement().inspect_retired(), self.commit)
            self.assertEqual(self.retirement().inspect_retired(), self.commit)
        self.assert_preserved()
        with self.assertRaises((FileNotFoundError, ValueError)):
            self.retirement().retire_committed()

    def test_missing_target_alone_is_never_completion(self):
        with self.assertRaises(FileNotFoundError):
            self.retirement().inspect_retired()
        self.path.rename(self.path.with_name('orphan-evidence'))
        with self.assertRaises(FileNotFoundError):
            self.retirement().inspect_retired()

    def test_failure_before_rename_keeps_original_and_no_target(self):
        with mock.patch.object(R.os, 'fsync', side_effect=OSError('before rename sync')):
            with self.assertRaisesRegex(OSError, 'before rename'):
                self.retire()
        self.assertEqual(self.path.read_bytes(), self.body)
        self.assertFalse(self.target.exists())

    def test_failure_after_rename_requires_fresh_inspection_and_sync(self):
        original_sync = os.fsync
        count = 0

        def sync(fd):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError('after rename sync')
            return original_sync(fd)

        with mock.patch.object(R.os, 'fsync', side_effect=sync):
            with self.assertRaisesRegex(OSError, 'after rename'):
                self.retire()
        self.assert_preserved()
        with mock.patch.object(R.os, 'fsync', side_effect=original_sync) as synced:
            self.assertEqual(self.retirement().inspect_retired(), self.commit)
            self.assertEqual(synced.call_count, 1)

    def test_different_selector_replacement_before_rename_is_never_removed(self):
        original_sync = os.fsync
        newer = self.P.canonical({**self.grant, 'id': OTHER, 'nonce': '7' * 64})
        changed = False

        def sync(fd):
            nonlocal changed
            if not changed:
                changed = True
                self.path.rename(self.path.with_name('original-capture-evidence'))
                self.path.write_bytes(newer)
                self.path.chmod(0o600)
            return original_sync(fd)

        with mock.patch.object(R.os, 'fsync', side_effect=sync):
            with self.assertRaises(ValueError):
                self.retire()
        self.assertFalse(self.target.exists())
        self.assertEqual(self.path.read_bytes(), newer)

    def test_failed_history_sync_cannot_report_completion(self):
        self.retire()
        with mock.patch.object(R.os, 'fsync', side_effect=OSError('history sync')):
            with self.assertRaisesRegex(OSError, 'history sync'):
                self.retirement().inspect_retired()
        self.assert_preserved()

    def test_root_is_required_for_construction_and_each_operation(self):
        instance = self.retirement()
        with mock.patch.object(W, 'require_root', side_effect=W.AdmissionError('Root authority required')):
            with self.assertRaises(W.AdmissionError):
                self.retirement()
            with self.assertRaises(W.AdmissionError):
                instance.retire_committed()
            with self.assertRaises(W.AdmissionError):
                instance.inspect_retired()

    def test_missing_owner_or_host_lock_cannot_retire(self):
        with self.assertRaisesRegex(ValueError, 'operation lock'):
            self.retirement().retire_committed()
        with self.lease.owner(), self.H.host_lock(self.root):
            token = self.H.CORE_CAPTURE_OWNER.set(None)
            try:
                with self.assertRaisesRegex(ValueError, 'original admitted capture owner'):
                    self.retirement().retire_committed()
            finally:
                self.H.CORE_CAPTURE_OWNER.reset(token)
        self.assertTrue(self.path.exists())

    def test_other_installation_lock_descriptor_cannot_retire(self):
        other = self.folder / 'other-install'
        other.mkdir(mode=0o700)
        with self.H.host_lock(other), self.lease.owner():
            with self.assertRaisesRegex(ValueError, 'installation lock'):
                self.retirement().retire_committed()
        self.assertTrue(self.path.exists())

    def test_migrated_layout_uses_exact_legacy_first_host_descriptor(self):
        layout = self.H.AUTHORITY.LAYOUT
        selected = layout.selected_path
        authority = self.folder / 'authority-namespace'
        authority.mkdir(mode=0o700)
        lock = authority / 'host.lock'

        def choose(root, purpose):
            return lock if purpose == 'host-lock' else selected(root, purpose)

        with mock.patch.object(layout, 'selected_path', side_effect=choose):
            self.assertEqual(self.retire(), self.commit)
            self.assertTrue(lock.exists())
        self.assert_preserved()

    def test_changed_owner_inside_existing_lock_is_rejected(self):
        with self.lease.owner(), self.H.host_lock(self.root):
            token = self.H.CORE_CAPTURE_OWNER.set(('caller-supplied-grant', None, None))
            try:
                with self.assertRaisesRegex(ValueError, 'ownership'):
                    self.retirement().retire_committed()
            finally:
                self.H.CORE_CAPTURE_OWNER.reset(token)
        self.assertEqual(self.path.read_bytes(), self.body)

    def test_adopted_shared_legacy_lock_parent_does_not_become_completion_authority(self):
        shared = self.folder / 'legacy-lock-parent'
        shared.mkdir(mode=0o775)
        shared.chmod(0o775)
        with mock.patch.object(self.H.AUTHORITY.LAYOUT, 'lock_paths', return_value=[shared / 'host.lock']):
            self.assertEqual(self.retire(), self.commit)
        self.assert_preserved()
        self.assertEqual(shared.stat().st_mode & 0o777, 0o775)

    def test_v2_request_hashes_remain_bound_to_the_protected_completion_commit(self):
        request = {**self.request, 'schema': 'orbis.core-capture-admission.v2',
                   'preparationSha256': '1' * 64, 'decisionSha256': '2' * 64}
        self.write('request.json', request)
        with self.assertRaises(ValueError):
            self.retirement()
        self.commit['requestSha256'] = W.digest(self.P.canonical(request))
        self.write('completion-commit.json', self.commit)
        self.assertEqual(self.retire(), self.commit)
        self.assertEqual(self.retirement().inspect_retired(), self.commit)
        self.assert_preserved()

    def test_retirement_rechecks_private_lock_mode_after_acquisition(self):
        with self.lease.owner(), self.H.host_lock(self.root):
            lock = self.H.AUTHORITY.LAYOUT.lock_paths(self.root)[0]
            try:
                lock.chmod(0o644)
                with self.assertRaisesRegex(ValueError, 'no longer protected'):
                    self.retirement().retire_committed()
            finally:
                lock.chmod(0o600)
        self.assertTrue(self.path.exists())
        self.assertFalse(self.target.exists())

    def test_different_root_context_or_commit_identity_is_rejected(self):
        other = self.folder / 'other-install'
        other.mkdir(mode=0o700)
        for root, context in ((other, self.context), (self.root, 'other-context')):
            with self.subTest(root=root, context=context), self.assertRaises(ValueError):
                self.retirement(root=root, context=context)
        for key, value in (('id', OTHER), ('root', str(other)), ('context', 'other-context')):
            with self.subTest(key=key):
                self.write('completion-commit.json', {**self.commit, key: value})
                with self.assertRaises(ValueError):
                    self.retirement()

    def test_request_hash_and_original_nonce_source_binding_are_required(self):
        for key, value in (('leaseNonce', '9' * 64), ('sourceSha256', '8' * 64)):
            with self.subTest(key=key):
                changed = {**self.request, key: value}
                self.write('request.json', changed)
                with self.assertRaises(ValueError):
                    self.retirement()
                self.write('completion-commit.json', {**self.commit, 'requestSha256': W.digest(self.P.canonical(changed))})
                with self.assertRaisesRegex(ValueError, 'original capture lease'):
                    self.retirement()
                self.write('request.json', self.request)
                self.write('completion-commit.json', self.commit)

    def test_commit_schema_exact_fields_hashes_and_integer_identity_are_strict(self):
        variants = [{**self.commit, 'grant': True}, {**self.commit, 'schema': 'unknown'},
                    {**self.commit, 'leaseSha256': 'x' * 64}]
        for field in R.IDENTITY_FIELDS:
            changed = copy.deepcopy(self.commit)
            changed['leaseIdentity'][field] = True
            variants.append(changed)
        for changed in variants:
            with self.subTest(changed=changed):
                self.write('completion-commit.json', changed)
                with self.assertRaises(ValueError):
                    self.retirement()

    def test_rewritten_identical_commit_is_rejected_by_existing_instance(self):
        instance = self.retirement()
        original = self.directory / 'completion-commit.json'
        original.rename(self.directory / 'completion-commit.original')
        self.write('completion-commit.json', self.commit)
        with self.assertRaisesRegex(ValueError, 'authority changed'):
            self.retire(instance)
        self.assertTrue(self.path.exists())

    def test_changed_commit_during_rename_cannot_report_success(self):
        rename = R.rename_noreplace

        def changed(parent, source, target):
            rename(parent, source, target)
            self.write('completion-commit.json', {**self.commit, 'completionSha256': '1' * 64})

        with mock.patch.object(R, 'rename_noreplace', side_effect=changed):
            with self.assertRaisesRegex(ValueError, 'authority changed'):
                self.retire()
        self.assert_preserved()

    def test_replaced_identical_original_cannot_satisfy_pinned_inode(self):
        self.path.rename(self.path.with_name('original-evidence'))
        self.path.write_bytes(self.body)
        self.path.chmod(0o600)
        lease = W.LEASE.CoreCaptureLease.load(self.H, self.root)
        with lease.owner(), self.H.host_lock(self.root):
            with self.assertRaisesRegex(ValueError, 'lease changed'):
                self.retirement().retire_committed()
        self.assertFalse(self.target.exists())

    def test_existing_different_target_is_preserved_without_overwrite(self):
        self.target.write_bytes(b'protected ambiguous evidence')
        self.target.chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'Existing retired'):
            self.retire()
        self.assertEqual(self.target.read_bytes(), b'protected ambiguous evidence')
        self.assertEqual(self.path.read_bytes(), self.body)

    def test_racing_target_is_never_overwritten_by_atomic_rename(self):
        rename = R.rename_noreplace

        def racing(parent, source, target):
            self.target.write_bytes(b'competing protected evidence')
            self.target.chmod(0o600)
            rename(parent, source, target)

        with mock.patch.object(R, 'rename_noreplace', side_effect=racing):
            with self.assertRaises(FileExistsError):
                self.retire()
        self.assertEqual(self.target.read_bytes(), b'competing protected evidence')
        self.assertEqual(self.path.read_bytes(), self.body)

    def test_internal_rename_requires_single_leaf_names_and_pinned_descriptor(self):
        parent = os.open(self.folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.addCleanup(os.close, parent)
        for name in ('', '.', '..', '../escape', 'nested/name', '/absolute', 'nul\0byte', None, 1):
            for source, target in ((name, 'target'), ('source', name)):
                with self.subTest(source=source, target=target), self.assertRaises(ValueError):
                    R.rename_noreplace(parent, source, target)
        for descriptor in (-1, 2**31, None, True, 'caller path'):
            with self.subTest(descriptor=descriptor), self.assertRaises(ValueError):
                R.rename_noreplace(descriptor, 'source', 'target')

    def test_internal_rename_preserves_inode_and_refuses_existing_target(self):
        source, target = self.folder / 'source-hold', self.folder / 'retired-hold'
        source.write_bytes(b'root-private hold')
        source.chmod(0o600)
        expected = R.lease_identity(source.stat())
        parent = os.open(self.folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.addCleanup(os.close, parent)
        R.rename_noreplace(parent, source.name, target.name)
        self.assertFalse(source.exists())
        self.assertEqual(R.lease_identity(target.stat()), expected)
        source.write_bytes(b'new hold')
        with self.assertRaises(FileExistsError):
            R.rename_noreplace(parent, source.name, target.name)
        self.assertEqual(source.read_bytes(), b'new hold')
        self.assertEqual(target.read_bytes(), b'root-private hold')

    def test_retired_target_replacement_tampering_and_symlink_are_rejected(self):
        self.retire()
        self.target.rename(self.path.with_name('retired-evidence'))
        self.target.write_bytes(self.body)
        self.target.chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'lease changed'):
            self.retirement().inspect_retired()
        self.target.unlink()
        self.target.symlink_to(self.path.with_name('retired-evidence'))
        with self.assertRaises((OSError, ValueError)):
            self.retirement().inspect_retired()

    def test_retired_body_change_on_original_inode_is_rejected(self):
        self.retire()
        inode = self.target.stat().st_ino
        self.target.write_bytes(self.body.replace(b'"sourceSha256":"a', b'"sourceSha256":"9'))
        self.assertEqual(self.target.stat().st_ino, inode)
        with self.assertRaisesRegex(ValueError, 'lease changed'):
            self.retirement().inspect_retired()

    def test_original_symlink_and_nonprivate_commit_are_rejected(self):
        with self.lease.owner(), self.H.host_lock(self.root):
            saved = self.path.with_name('original-private-evidence')
            self.path.rename(saved)
            self.path.symlink_to(saved)
            with self.assertRaises((OSError, ValueError)):
                self.retirement().retire_committed()
        self.assertFalse(self.target.exists())
        (self.directory / 'completion-commit.json').chmod(0o644)
        with self.assertRaises(ValueError):
            self.retirement()

    def test_existing_symlink_retired_target_is_preserved(self):
        self.target.symlink_to(self.path)
        with self.assertRaisesRegex(ValueError, 'Existing retired'):
            self.retire()
        self.assertTrue(self.target.is_symlink())
        self.assertEqual(self.path.read_bytes(), self.body)

    def test_symlinked_commit_or_request_is_not_authority(self):
        for name in ('request.json', 'completion-commit.json'):
            original = self.directory / name
            saved = self.directory / (name + '.evidence')
            original.rename(saved)
            original.symlink_to(saved)
            with self.subTest(name=name), self.assertRaises((OSError, ValueError)):
                self.retirement()
            original.unlink()
            saved.rename(original)

    def test_active_retired_same_admission_contradiction_is_rejected(self):
        self.retire()
        self.path.write_bytes(self.body)
        self.path.chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'contradictory'):
            self.retirement().inspect_retired()
        self.assertEqual(self.path.read_bytes(), self.body)

    def test_different_newer_selector_is_preserved_by_history_inspection(self):
        self.retire()
        with self.H.host_lock(self.root):
            W.LEASE.CoreCaptureLease.reserve(self.H, self.root, self.context, OTHER, '2' * 64)
        current = self.path.read_bytes()
        current_identity = self.A.seal(self.path.stat())
        self.assertEqual(self.retirement().inspect_retired(), self.commit)
        self.assertEqual(self.path.read_bytes(), current)
        self.assertEqual(self.A.seal(self.path.stat()), current_identity)
        self.assert_preserved_target_only()

    def assert_preserved_target_only(self):
        self.assertEqual(self.target.read_bytes(), self.body)
        self.assertEqual(R.lease_identity(self.target.stat()), self.commit['leaseIdentity'])


if __name__ == '__main__':
    unittest.main()
