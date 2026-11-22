import fcntl
from contextlib import contextmanager
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location('credential_fence_host', Path(__file__).with_name('orbis-host.py'))
H = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(H)
F = H.CREDENTIAL_FENCE
L = H.AUTHORITY.LAYOUT
OP = 'a' * 64
BINDING = 'b' * 64


class CredentialFenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.base.chmod(0o700)
        self.root = self.base / 'installation'
        self.root.mkdir(mode=0o700)
        self.context = 'local'
        self.state = self.base / 'state'
        self.state.mkdir(mode=0o700)
        self.mount = self.base / 'mountinfo'
        self.mount.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n')
        for target, name, value in [(F, 'OWNER', os.geteuid()), (H.AUTHORITY, 'OWNER', os.geteuid()), (L, 'STATE_ROOT', self.state)]:
            patch = mock.patch.object(target, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        patch = mock.patch.object(L, '_operator')
        patch.start()
        self.addCleanup(patch.stop)
        self.path = L.legacy_path(self.root, 'credential-fence')

    def lock(self):
        return H.credential_fence_lock(self.root, self.context)

    def begin(self):
        with self.lock() as guard:
            return guard.begin(OP, BINDING)

    def blocked(self):
        with self.assertRaises((ValueError, OSError)):
            with H.host_lock(self.root):
                self.fail('lifecycle crossed a credential hold')
        with self.assertRaises((ValueError, OSError)):
            H.require_no_capture_fence(self.root)

    def test_real_lifecycle_and_second_broker_locks_are_excluded_then_pending_hold_survives(self):
        with self.lock() as guard:
            self.assertIsNone(guard.read())
            for factory in [lambda: H.host_lock(self.root), self.lock]:
                with self.assertRaisesRegex(ValueError, 'in progress'):
                    with factory():
                        self.fail('shared lock crossed')
            value = guard.begin(OP, BINDING)
            self.assertEqual(value, {'schema': F.SCHEMA, 'root': str(self.root), 'context': 'local',
                                     'operationId': OP, 'admissionBinding': BINDING})
            self.assertEqual(guard.begin(OP, BINDING), value)
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
            self.blocked()
        self.blocked()
        with self.lock() as guard:
            self.assertEqual(guard.check(OP, BINDING), value)
        self.blocked()

    def test_finish_requires_actual_completed_callback_and_exact_marker(self):
        self.begin()
        for verify in [None, lambda: False, lambda: 1]:
            with self.lock() as guard, self.assertRaises(ValueError):
                guard.finish(OP, BINDING, verify_completed=verify)
            self.blocked()
        with self.lock() as guard:
            for operation, binding in [('c' * 64, BINDING), (OP, 'd' * 64)]:
                with self.assertRaises(ValueError): guard.finish(operation, binding, verify_completed=lambda: True)
            called = []
            def complete():
                called.append(True)
                self.blocked()
                return True
            guard.finish(OP, BINDING, verify_completed=complete)
            self.assertEqual(called, [True])
            self.assertIsNone(guard.read())
            guard.finish(OP, BINDING, verify_completed=lambda: True)
        with H.host_lock(self.root):
            pass

    def test_bootstrap_intent_and_publication_hold_block_ordinary_lifecycle(self):
        proposed = L.review(self.root, 'daemon', self.context, self.mount)
        L.prepare(self.root, 'daemon', self.context, L.plan_sha256(proposed), self.mount)
        with self.selected_layout():
            self.path = L.namespace(self.root) / L.PURPOSES['credential-fence']
            for name in ('credential-bootstrap-intent.json', '.credential-bootstrap-intent.json.pending',
                         'credential-bootstrap-publication-hold.json', '.credential-bootstrap-publication-hold.json.pending'):
                with self.subTest(name=name):
                    path = self.path.parent / name
                    path.write_bytes(b'fixture protected bootstrap selector')
                    try:
                        self.blocked()
                        with self.lock() as guard:
                            self.assertIsNone(guard.read())
                    finally:
                        path.unlink()
            with H.host_lock(self.root):
                pass

    def test_legacy_siblings_ignore_unrelated_shared_parent_bootstrap_basenames(self):
        sibling = self.base / 'sibling-installation'
        sibling.mkdir(mode=0o700)
        for name in ('credential-bootstrap-intent.json', '.credential-bootstrap-intent.json.pending',
                     'credential-bootstrap-publication-hold.json', '.credential-bootstrap-publication-hold.json.pending'):
            with self.subTest(name=name):
                entry = self.base / name
                entry.write_bytes(b'unrelated shared parent entry')
                try:
                    for root in (self.root, sibling):
                        with H.host_lock(root):
                            pass
                finally:
                    entry.unlink()
        self.begin()
        self.blocked()
        with H.host_lock(sibling):
            pass

    def test_callback_cannot_replace_marker_and_remove_the_new_one(self):
        self.begin()
        with self.assertRaises(ValueError), self.lock() as guard:
            def changed():
                self.path.unlink()
                self.path.write_text(json.dumps({'other': 'preserve'}))
                self.path.chmod(0o600)
                return True
            guard.finish(OP, BINDING, verify_completed=changed)
        self.assertTrue(self.path.exists())
        self.blocked()

    def test_marker_schema_duplicate_partial_mode_hardlink_symlink_fifo_always_hold(self):
        bodies = [b'', b'{', b'{}', b'{"schema":"x","schema":"y"}', b'x' * 4097]
        for body in bodies:
            with self.subTest(body=body[:20]):
                self.path.write_bytes(body)
                self.path.chmod(0o600)
                self.blocked()
                with self.assertRaises((ValueError, OSError)):
                    with self.lock(): pass
                self.path.unlink()
        self.begin()
        self.path.chmod(0o644)
        self.blocked()
        with self.assertRaises(ValueError):
            with self.lock(): pass
        self.path.chmod(0o600)
        other = self.base / 'other'
        os.link(self.path, other)
        with self.assertRaises(ValueError):
            with self.lock(): pass
        other.unlink()
        self.path.unlink()
        self.path.symlink_to(self.base / 'missing')
        self.blocked()
        with self.assertRaises((ValueError, OSError)):
            with self.lock(): pass
        self.path.unlink()
        os.mkfifo(self.path, mode=0o600)
        self.blocked()
        with self.assertRaises(ValueError):
            with self.lock(): pass

    def test_marker_other_root_context_operation_and_binding_cannot_be_adopted(self):
        good = self.begin()
        for key, value in [('root', str(self.base)), ('context', 'other'), ('operationId', 1), ('admissionBinding', 'b' * 63)]:
            self.path.write_bytes(H.IDENTITY.PUBLICATION.canonical({**good, key: value}) + b'\n')
            with self.assertRaises(ValueError):
                with self.lock(): pass
            self.blocked()
        self.path.write_bytes(H.IDENTITY.PUBLICATION.canonical(good) + b'\n')
        with self.lock() as guard:
            with self.assertRaises(ValueError): guard.begin('c' * 64, BINDING)
            self.assertEqual(guard.read(), good)

    def test_dead_guard_and_wrong_thread_cannot_publish_or_retire(self):
        with self.lock() as guard:
            guard.begin(OP, BINDING)
            with mock.patch.object(F.threading, 'get_ident', return_value=-1):
                with self.assertRaises(ValueError): guard.read()
            with mock.patch.object(F.os, 'getpid', return_value=-1):
                with self.assertRaises(ValueError): guard.read()
        for operation in [lambda: guard.read(), lambda: guard.begin(OP, BINDING),
                          lambda: guard.finish(OP, BINDING, verify_completed=lambda: True)]:
            with self.assertRaises(ValueError): operation()
        self.blocked()

    def test_partial_write_and_fsync_failure_preserve_hold_without_auto_cleanup(self):
        write = F.os.write
        def partial(descriptor, body):
            write(descriptor, body[:10])
            raise OSError('fixture interruption')
        with self.assertRaises(OSError), self.lock() as guard, mock.patch.object(F.os, 'write', side_effect=partial):
            guard.begin(OP, BINDING)
        self.assertEqual(self.path.stat().st_size, 10)
        self.blocked()
        self.path.unlink()
        with self.assertRaises(OSError), self.lock() as guard, mock.patch.object(F.os, 'fsync', side_effect=OSError('fixture fsync')):
            guard.begin(OP, BINDING)
        self.blocked()
        with self.lock() as guard:
            self.assertEqual(guard.check(OP, BINDING)['operationId'], OP)

    def test_custody_lock_and_parent_changes_refuse(self):
        with self.lock() as guard:
            self.base.chmod(0o777)
            try:
                with self.assertRaises(ValueError): guard.begin(OP, BINDING)
            finally:
                self.base.chmod(0o700)
            lock = L.legacy_path(self.root, 'host-lock')
            other = self.base / 'lock-link'
            os.link(lock, other)
            try:
                with self.assertRaises(ValueError): guard.read()
            finally:
                other.unlink()
        self.assertFalse(self.path.exists())

    def test_capture_restore_and_race_after_lock_still_refuse_broker(self):
        capture = H.capture_fence_path(self.root)
        capture.write_text('{}')
        with self.assertRaises(ValueError):
            with self.lock(): pass
        capture.unlink()
        acquire = L.open_locks
        def crossing(root):
            descriptors = acquire(root)
            capture.write_text('{}')
            return descriptors
        with mock.patch.object(L, 'open_locks', side_effect=crossing), self.assertRaises(ValueError):
            with self.lock(): pass
        capture.unlink()
        with self.lock(): pass

    def test_lifecycle_rechecks_marker_after_lock_acquisition(self):
        acquire = L.open_locks
        def crossing(root):
            descriptors = acquire(root)
            self.path.write_text('interrupted')
            return descriptors
        with mock.patch.object(L, 'open_locks', side_effect=crossing), self.assertRaises(ValueError):
            with H.host_lock(self.root): self.fail('crossed')
        self.blocked()

    def test_root_broker_cannot_write_under_unprotected_legacy_parent(self):
        self.base.chmod(0o775)
        with self.assertRaises(ValueError):
            with self.lock(): pass
        self.assertFalse(self.path.exists())
        # Legacy operations without an admitted credential hold remain unchanged.
        with mock.patch.object(L, 'STATE_ROOT', self.base / 'absent-state'), H.host_lock(self.root): pass
        self.base.chmod(0o700)

    def test_legacy_hold_blocks_reviewed_layout_adoption(self):
        self.begin()
        with self.assertRaises(L.LayoutError):
            L.prepare(self.root, 'daemon', 'local', 'a' * 64, self.mount)
        self.assertTrue(self.path.exists())

    @contextmanager
    def selected_layout(self):
        read, plan = L.read, L._plan
        with mock.patch.object(L, 'read', side_effect=lambda root, daemon=None, context=None, mountinfo=None:
                               read(root, daemon, context, mountinfo or self.mount)), \
                mock.patch.object(L, '_plan', side_effect=lambda root, daemon, context, ancestry, mountinfo:
                                  plan(root, daemon, context, ancestry, mountinfo or self.mount)):
            yield

    def test_protected_layout_uses_both_locks_and_retains_marker_in_private_namespace(self):
        proposed = L.review(self.root, 'daemon', self.context, self.mount)
        L.prepare(self.root, 'daemon', self.context, L.plan_sha256(proposed), self.mount)
        with self.selected_layout():
            self.path = L.namespace(self.root) / L.PURPOSES['credential-fence']
            self.assertEqual(F.path(H, self.root), self.path)
            with self.lock() as guard:
                for lock in L.lock_paths(self.root):
                    fd = os.open(lock, os.O_RDWR)
                    try:
                        with self.assertRaises(BlockingIOError): fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    finally:
                        os.close(fd)
                guard.begin(OP, BINDING)
            self.blocked()
            self.assertTrue(self.path.exists())
            self.assertFalse(L.legacy_path(self.root, 'credential-fence').exists())
            with self.lock() as guard:
                guard.finish(OP, BINDING, verify_completed=lambda: True)
            with H.host_lock(self.root): pass

    def test_replaced_installation_and_parent_are_detected_before_publication(self):
        with self.assertRaises(ValueError), self.lock() as guard:
            self.root.rename(self.base / 'old-installation')
            self.root.mkdir(mode=0o700)
            guard.begin(OP, BINDING)
        self.assertFalse(self.path.exists())
        with self.assertRaises((ValueError, OSError)), self.lock() as guard:
            moved = self.base.with_name(self.base.name + '-moved')
            self.base.rename(moved)
            try:
                self.base.mkdir(mode=0o700)
                guard.begin(OP, BINDING)
            finally:
                self.base.rmdir()
                moved.rename(self.base)
        self.assertFalse(self.path.exists())

    def test_generic_new_process_cannot_cross_pending_marker(self):
        self.begin()
        script = "import importlib.util,sys;from pathlib import Path;s=importlib.util.spec_from_file_location('h',sys.argv[1]);h=importlib.util.module_from_spec(s);s.loader.exec_module(h);\ntry:\n with h.host_lock(Path(sys.argv[2])): sys.exit(3)\nexcept ValueError: sys.exit(0)"
        result = subprocess.run([sys.executable, '-B', '-c', script, str(Path(H.__file__)), str(self.root)],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.blocked()

    def test_non_directory_root_and_invalid_binding_refuse_before_publication(self):
        self.root.rmdir()
        self.root.write_text('not an installation')
        with self.assertRaises(ValueError):
            with self.lock(): pass
        self.assertFalse(self.path.exists())
        self.root.unlink()
        self.root.mkdir(mode=0o700)
        with self.lock() as guard:
            for operation, binding in [(None, BINDING), (OP, 'B' * 64), ('a' * 65, BINDING)]:
                with self.assertRaises(ValueError): guard.begin(operation, binding)
            self.assertIsNone(guard.read())

    def test_host_subprocess_inherits_same_legacy_lock_during_broker_request(self):
        with self.lock():
            descriptor = H.LOCK_DESCRIPTOR.get()
            result = H.run([sys.executable, '-c', f'import os;print(os.fstat({descriptor}).st_ino)'], self.root)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(int(result.stdout.strip()), os.fstat(descriptor).st_ino)
        self.assertIsNone(H.LOCK_DESCRIPTOR.get())


if __name__ == '__main__':
    unittest.main()
