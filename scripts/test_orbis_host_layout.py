import hashlib
import fcntl
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from contextlib import contextmanager, redirect_stdout, redirect_stderr

spec = importlib.util.spec_from_file_location('host_layout', Path(__file__).with_name('orbis-host-layout.py'))
L = importlib.util.module_from_spec(spec)
spec.loader.exec_module(L)


class LayoutTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.root = self.base / 'legacy'
        self.root.mkdir(mode=0o775)
        self.root.chmod(0o775)
        self.state = self.base / 'state'
        self.state.mkdir(mode=0o700)
        self.mount = self.base / 'mountinfo'
        self.mount.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n')
        patch = mock.patch.object(L, 'STATE_ROOT', self.state)
        patch.start()
        self.addCleanup(patch.stop)
        self.require_operator = L._operator
        if os.geteuid() != 0:
            patch = mock.patch.object(L, '_operator')
            patch.start()
            self.addCleanup(patch.stop)

    def review(self):
        return L.review(self.root, 'daemon-a', 'local', self.mount)

    def enroll(self, plan=None):
        return L.prepare(self.root, 'daemon-a', 'local', L.plan_sha256(plan or self.review()), self.mount)

    def read(self):
        return L.read(self.root, 'daemon-a', 'local', self.mount)

    def test_read_absent_never_creates(self):
        self.assertIsNone(self.read())
        self.assertIsNone(L.purpose_path(self.root, 'daemon-a', 'local', 'host-lock', self.mount))
        self.assertFalse((self.state / 'installations').exists())

    def test_root_operator_required(self):
        with mock.patch.object(L.os, 'geteuid', return_value=12345):
            with self.assertRaises(L.LayoutError): self.require_operator()

    def test_exact_approval_private_receipt_and_purpose(self):
        plan = self.review()
        self.assertEqual(plan, self.review())
        self.assertEqual(plan['ancestry'][-1]['mode'], 0o775)
        with self.assertRaises(L.LayoutError): L.prepare(self.root, 'daemon-a', 'local', '0' * 64, self.mount)
        self.assertFalse((self.state / 'installations').exists())
        self.assertFalse(L.legacy_path(self.root, 'host-lock').exists())
        value = self.enroll(plan)
        self.assertEqual(self.read(), value)
        path = L.namespace(self.root)
        self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        self.assertEqual((path / 'layout.json').stat().st_mode & 0o777, 0o600)
        for purpose in L.PURPOSES:
            self.assertEqual(L.purpose_path(self.root, 'daemon-a', 'local', purpose, self.mount), path / L.PURPOSES[purpose])
        with self.assertRaises(L.LayoutError): L.purpose_path(self.root, 'daemon-a', 'local', '../other', self.mount)
        with self.assertRaises(L.LayoutError): self.enroll(plan)

    def test_changed_approval_and_root_replacement(self):
        plan = self.review()
        self.root.chmod(0o750)
        with self.assertRaises(L.LayoutError): self.enroll(plan)
        self.assertFalse((self.state / 'installations').exists())
        self.root.chmod(0o775)
        self.enroll()
        self.root.rename(self.base / 'old')
        self.root.mkdir(mode=0o775)
        with self.assertRaises(L.LayoutError): self.read()

    def test_daemon_context_ancestor_and_permissions_pinned(self):
        self.enroll()
        for daemon, context in [('daemon-b', 'local'), ('daemon-a', 'other')]:
            with self.assertRaises(L.LayoutError): L.read(self.root, daemon, context, self.mount)
        self.root.chmod(0o750)
        with self.assertRaises(L.LayoutError): self.read()

    def test_world_writable_and_symlink_refused(self):
        self.root.chmod(0o777)
        with self.assertRaises(L.LayoutError): self.review()
        self.root.chmod(0o775)
        link = self.base / 'link'
        link.symlink_to(self.root)
        with self.assertRaises(L.LayoutError): L.review(link, 'daemon-a', 'local', self.mount)
        self.base.chmod(0o777)
        with self.assertRaises(L.LayoutError): self.review()

    def test_partial_or_tampered_receipt_never_legacy(self):
        self.enroll()
        receipt = L.namespace(self.root) / 'layout.json'
        receipt.unlink()
        with self.assertRaises(L.LayoutError): self.read()
        receipt.write_text('{}')
        receipt.chmod(0o600)
        with self.assertRaises(L.LayoutError): self.read()
        receipt.chmod(0o644)
        with self.assertRaises(L.LayoutError): self.read()

    def test_filesystem_ids_stable_and_semantics_pinned(self):
        self.enroll()
        self.mount.write_text('23 12 8:1 / / rw shared:22 - ext4 /dev/test rw\n')
        with self.assertRaises(L.LayoutError): self.read()
        self.mount.write_text('23 12 8:1 / / rw - ext4 /dev/test rw\n')
        self.assertIsNotNone(self.read())
        for line in ('23 12 8:2 / / rw - ext4 /dev/test rw\n', '23 12 8:1 / / ro - ext4 /dev/test ro\n',
                     '23 12 8:1 / / rw - ext4 /dev/other rw\n', '23 12 0:4 / / rw - nsfs nsfs rw\n'):
            self.mount.write_text(line)
            with self.assertRaises(L.LayoutError): self.read()

    def test_observation_bounded_whitelist_without_authority(self):
        self.enroll()
        file = self.root / 'docker-compose.yml'
        file.write_bytes(b'observed only')
        file.chmod(0o600)
        result = L.observe_files(self.root, 'daemon-a', 'local', ['docker-compose.yml', 'VERSION'], self.mount)
        self.assertEqual(result, {'docker-compose.yml': hashlib.sha256(b'observed only').hexdigest(), 'VERSION': None})
        with self.assertRaises(L.LayoutError): L.observe_files(self.root, 'daemon-a', 'local', ['../secret'], self.mount)
        file.chmod(0o666)
        self.assertEqual(L.observe_files(self.root, 'daemon-a', 'local', ['docker-compose.yml'], self.mount)['docker-compose.yml'], result['docker-compose.yml'])
        file.chmod(0o600)
        os.link(file, self.root / 'other')
        with self.assertRaises(L.LayoutError): L.observe_files(self.root, 'daemon-a', 'local', ['docker-compose.yml'], self.mount)

    def test_observation_refuses_symlink_and_oversize(self):
        self.enroll()
        file = self.root / 'VERSION'
        file.symlink_to(self.base / 'other')
        with self.assertRaises((L.LayoutError, OSError)): L.observe_files(self.root, 'daemon-a', 'local', ['VERSION'], self.mount)
        file.unlink()
        file.write_bytes(b'x' * (L.LIMIT + 1))
        with self.assertRaises(L.LayoutError): L.observe_files(self.root, 'daemon-a', 'local', ['VERSION'], self.mount)

    @contextmanager
    def selection(self):
        read = L.read
        plan = L._plan
        with mock.patch.object(L, 'read', side_effect=lambda root, daemon=None, context=None, mountinfo=None:
                               read(root, daemon, context, mountinfo or self.mount)), \
                mock.patch.object(L, '_plan', side_effect=lambda root, daemon, context, ancestry, mountinfo:
                                  plan(root, daemon, context, ancestry, mountinfo or self.mount)):
            yield

    def test_path_adapter_preserves_absent_layout_and_rejects_invalid_receipt(self):
        with self.selection():
            for purpose in ('host-lock', 'capture-fence', 'restore-selector', 'retained-authority'):
                self.assertEqual(L.selected_path(self.root, purpose), L.legacy_path(self.root, purpose))
            self.enroll()
            for purpose in ('host-lock', 'capture-fence', 'restore-selector', 'retained-authority'):
                self.assertEqual(L.selected_path(self.root, purpose), L.namespace(self.root) / L.PURPOSES[purpose])
            (L.namespace(self.root) / 'layout.json').write_text('{}')
            with self.assertRaises(L.LayoutError): L.selected_path(self.root, 'host-lock')

    def test_legacy_authority_blocks_adoption_and_selected_paths(self):
        for purpose in ('retained-authority', 'capture-fence', 'restore-selector', 'credential-fence'):
            marker = L.legacy_path(self.root, purpose)
            marker.write_text('preserve')
            with self.assertRaises(L.LayoutError): self.enroll()
            self.assertEqual(marker.read_text(), 'preserve')
            self.assertFalse(L.namespace(self.root).exists())
            marker.unlink()
        self.enroll()
        marker = L.legacy_path(self.root, 'restore-selector')
        marker.write_text('preserve')
        with self.selection(), self.assertRaises(L.LayoutError): L.selected_path(self.root, 'host-lock')

    def test_borrowed_joint_locks_remain_exclusive_after_component_exit(self):
        self.enroll()
        with self.selection():
            parents=tuple(L.open_locks(self.root))
            try:
                borrowed=L.borrow_locks(self.root,parents)
                self.assertTrue(all(a!=b for a,b in zip(parents,borrowed)))
                for descriptor in borrowed:os.close(descriptor)
                for path in L.lock_paths(self.root):
                    observer=os.open(path,os.O_RDWR)
                    try:
                        with self.assertRaises(BlockingIOError):fcntl.flock(observer,fcntl.LOCK_EX|fcntl.LOCK_NB)
                    finally:os.close(observer)
                L.verify_locks(self.root,parents)
            finally:
                for descriptor in parents:os.close(descriptor)

    def test_incomplete_reversed_readonly_and_foreign_leases_cannot_enter(self):
        self.enroll()
        with self.selection():
            parents=tuple(L.open_locks(self.root))
            readonly=os.open(L.lock_paths(self.root)[0],os.O_RDONLY)
            try:
                for supplied in (parents[:1],tuple(reversed(parents)),list(parents),(True,parents[1]),
                                 (readonly,parents[1]),(parents[0],-1)):
                    with self.subTest(supplied=type(supplied)),self.assertRaises((L.LayoutError,OSError)):
                        L.borrow_locks(self.root,supplied)
                L.verify_locks(self.root,parents)
            finally:
                os.close(readonly)
                for descriptor in parents:os.close(descriptor)

    def test_equal_byte_lock_replacement_revokes_the_whole_lease(self):
        self.enroll()
        with self.selection():
            parents=tuple(L.open_locks(self.root))
            try:
                path=L.lock_paths(self.root)[1]
                path.rename(path.with_name('old-host.lock'))
                path.write_bytes(b'');path.chmod(0o600)
                with self.assertRaises(L.LayoutError):L.borrow_locks(self.root,parents)
                with self.assertRaises(L.LayoutError):L.verify_locks(self.root,parents)
            finally:
                for descriptor in parents:os.close(descriptor)

    def test_joint_parent_lock_lifetime_is_visible_to_an_actual_child(self):
        self.enroll()
        code='''import fcntl,os,sys
fd=os.open(sys.argv[1],os.O_RDWR)
try:
    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(73)
finally:
    os.close(fd)
'''
        with self.selection():
            paths=L.lock_paths(self.root)
            parents=tuple(L.open_locks(self.root))
            try:
                borrowed=L.borrow_locks(self.root,parents)
                for descriptor in borrowed:os.close(descriptor)
                for path in paths:
                    result=subprocess.run([sys.executable,'-I','-B','-c',code,str(path)],
                        stdin=subprocess.DEVNULL,capture_output=True,timeout=10,cwd=self.base)
                    self.assertEqual(result.returncode,73)
            finally:
                for descriptor in parents:os.close(descriptor)
            for path in paths:
                result=subprocess.run([sys.executable,'-I','-B','-c',code,str(path)],
                    stdin=subprocess.DEVNULL,capture_output=True,timeout=10,cwd=self.base)
                self.assertEqual(result.returncode,0,result.stderr.decode())

    def test_joint_locks_serialize_old_helpers_and_pin_legacy_inode(self):
        self.enroll()
        with self.selection():
            descriptors = L.open_locks(self.root)
            self.assertEqual(len(descriptors), 2)
            try:
                legacy = os.open(L.legacy_path(self.root, 'host-lock'), os.O_RDWR)
                try:
                    with self.assertRaises(BlockingIOError): fcntl.flock(legacy, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(legacy)
                for path in L.lock_paths(self.root):
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            finally:
                for descriptor in reversed(descriptors): os.close(descriptor)
            legacy = L.legacy_path(self.root, 'host-lock')
            legacy.rename(self.base / 'original-lock')
            legacy.touch(mode=0o600)
            with self.assertRaises(L.LayoutError): L.selected_path(self.root, 'host-lock')

    def test_existing_old_helper_blocks_enrollment_without_allocating_namespace(self):
        path = L.legacy_path(self.root, 'host-lock')
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError): self.enroll()
            self.assertFalse(L.namespace(self.root).exists())
        finally:
            os.close(descriptor)

    def test_authority_permissions_and_root_replacement_fail_closed_through_adapter(self):
        self.enroll()
        namespace = L.namespace(self.root)
        namespace.chmod(0o770)
        with self.selection(), self.assertRaises(L.LayoutError): L.selected_path(self.root, 'capture-fence')
        namespace.chmod(0o700)
        self.root.rename(self.base / 'old-root')
        self.root.mkdir(mode=0o775)
        self.root.chmod(0o775)
        with self.selection(), self.assertRaises(L.LayoutError): L.selected_path(self.root, 'restore-selector')

    def test_source_callers_share_the_same_path_adapter_without_weakening_execution(self):
        def load(name):
            spec = importlib.util.spec_from_file_location('layout_integration_' + name.replace('-', '_'), Path(__file__).with_name(name))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
        host = load('orbis-host.py')
        restore = load('orbis-host-retained-restore.py')
        self.enroll()
        with self.selection(), mock.patch.object(host.AUTHORITY, 'LAYOUT', L), mock.patch.object(restore, 'HOST', host):
            expected = L.namespace(self.root)
            self.assertEqual(host.capture_fence_path(self.root), expected / 'capture-fence.json')
            self.assertEqual(host.restore_selector_path(self.root), expected / 'restore-selector.json')
            self.assertEqual(restore.marker_path(self.root), expected / 'restore-selector.json')
            self.assertEqual(host.AUTHORITY.store_path(self.root), expected / 'retained-authority')
            file = self.root / 'docker-compose.yml'
            file.write_text('observed only')
            with self.assertRaises(ValueError):
                with host.AUTHORITY.installation_files(self.root, ['docker-compose.yml']): pass
            self.assertEqual(host.AUTHORITY.installation_observations(self.root, ['docker-compose.yml'], daemon='daemon-a', context='local'),
                             {'docker-compose.yml': hashlib.sha256(b'observed only').hexdigest()})
            with self.assertRaises(L.LayoutError): host.AUTHORITY.installation_observations(self.root, ['docker-compose.yml'], daemon='daemon-a', context='other')
            with self.assertRaises(L.LayoutError): host.AUTHORITY.installation_observations(self.root, ['docker-compose.yml'], daemon='daemon-b', context='local')
            with host.host_lock(self.root) as descriptor:
                self.assertEqual(os.fstat(descriptor).st_ino, L.legacy_path(self.root, 'host-lock').stat().st_ino)
                with self.assertRaises(ValueError):
                    with host.host_lock(self.root): pass

    def test_observation_keeps_prior_files_and_absences_sealed_until_completion(self):
        self.enroll()
        first = self.root / 'docker-compose.yml'
        last = self.root / 'VERSION'
        first.write_bytes(b'first')
        last.write_bytes(b'last')
        digest = hashlib.sha256
        def replace(body=b''):
            if body == b'last':
                first.rename(self.root / 'old-compose')
                first.write_bytes(b'first')
            return digest(body)
        with mock.patch.object(L.hashlib, 'sha256', side_effect=replace), self.assertRaises(L.LayoutError):
            L.observe_files(self.root, 'daemon-a', 'local', ['docker-compose.yml', 'VERSION'], self.mount)
        def create(body=b''):
            if body == b'last': (self.root / 'orbis-compose.yml').write_bytes(b'appeared')
            return digest(body)
        with mock.patch.object(L.hashlib, 'sha256', side_effect=create), self.assertRaises(L.LayoutError):
            L.observe_files(self.root, 'daemon-a', 'local', ['orbis-compose.yml', 'VERSION'], self.mount)

    def test_enrolled_service_fence_and_reconciliation_hold_both_locks(self):
        from test_orbis_host_capture_fence import CaptureFenceTests, SERVICE
        fixture = CaptureFenceTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        service = fixture.service
        plan = L.review(service.root, 'daemon-a', service.context, self.mount)
        L.prepare(service.root, 'daemon-a', service.context, L.plan_sha256(plan), self.mount)
        with self.selection(), mock.patch.object(SERVICE.HOST.AUTHORITY, 'LAYOUT', L):
            try:
                token = fixture.acquire()['token']
                marker = L.namespace(service.root) / 'capture-fence.json'
                self.assertTrue(marker.exists())
                self.assertFalse(L.legacy_path(service.root, 'capture-fence').exists())
                self.assertEqual(len(service.capture_fence_companions), 1)
                for path in L.lock_paths(service.root):
                    descriptor = os.open(path, os.O_RDWR)
                    try:
                        with self.assertRaises(BlockingIOError): fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    finally:
                        os.close(descriptor)
                service.maintain_capture_fence('renew', token)
                os.close(service.capture_fence_fd)
                service.capture_fence_fd = None
                for descriptor in service.capture_fence_companions: os.close(descriptor)
                service.capture_fence_companions = []
                service.capture_fence_session = 'replacement-service'
                service.maintain_capture_fence('reconcile', token)
                self.assertFalse(marker.exists())
                with SERVICE.HOST.host_lock(service.root): pass
            finally:
                for descriptor in service.capture_fence_companions: os.close(descriptor)
                service.capture_fence_companions = []


    @contextmanager
    def cli_port(self, daemon='daemon-a'):
        review, prepare, read = L.review, L.prepare, L.read
        options = {'side_effect': daemon} if isinstance(daemon, list) else {'return_value': daemon}
        with mock.patch.object(L.sys, 'platform', 'linux'), mock.patch.object(L, '_cli_daemon', **options) as observe, \
             mock.patch.object(L, 'review', side_effect=lambda root, identity, context: review(root, identity, context, self.mount)), \
             mock.patch.object(L, 'prepare', side_effect=lambda root, identity, context, approval: prepare(root, identity, context, approval, self.mount)), \
             mock.patch.object(L, 'read', side_effect=lambda root, identity, context: read(root, identity, context, self.mount)):
            yield observe

    def cli(self, *arguments):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = L.main(list(arguments))
        return code, stdout.getvalue(), stderr.getvalue()

    def adoption_arguments(self, approval=None):
        return ('adopt', str(self.root), '--docker-context', 'local', '--confirm-root', str(self.root),
                '--approved-plan-sha256', approval or L.plan_sha256(self.review()))

    def test_cli_review_is_read_only_and_returns_the_exact_plan(self):
        expected = self.review()
        with self.cli_port() as observe:
            code, output, error = self.cli('review', str(self.root), '--docker-context', 'local')
        self.assertEqual(code, 0, error)
        self.assertEqual(json.loads(output), {'result': 'review-required', 'planSha256': L.plan_sha256(expected), 'plan': expected})
        observe.assert_called_once_with('local')
        self.assertFalse(L.namespace(self.root).exists())
        self.assertFalse(L.legacy_path(self.root, 'host-lock').exists())
        self.assertEqual(list(self.root.iterdir()), [])

    def test_cli_reset_review_is_separate_read_only_and_uses_the_installer_daemon_digest(self):
        self.enroll()
        receipt = L.namespace(self.root) / 'layout.json'
        before = (receipt.read_bytes(), receipt.stat().st_ino, set(L.namespace(self.root).iterdir()))
        review = L.R.review_external_legacy
        expected = review(self.root, hashlib.sha256(b'daemon-a').hexdigest(), 'local', self.mount)
        with self.cli_port(), mock.patch.object(L.R, 'review_external_legacy', side_effect=lambda root, daemon, context: review(root, daemon, context, self.mount)):
            code, output, error = self.cli('review-reset', str(self.root), '--docker-context', 'local')
        self.assertEqual(code, 0, error)
        self.assertEqual(json.loads(output), {'result': 'reset-review-required', 'planSha256': L.R.review_plan_sha256(expected), 'plan': expected})
        self.assertEqual((receipt.read_bytes(), receipt.stat().st_ino, set(L.namespace(self.root).iterdir())), before)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_cli_reset_review_requires_the_independently_adopted_layout(self):
        with self.cli_port():
            code, output, _ = self.cli('review-reset', str(self.root), '--docker-context', 'local')
        self.assertEqual((code, output), (2, ''))
        self.assertFalse(L.namespace(self.root).exists())

    def test_cli_adoption_requires_the_separate_exact_approval_and_grants_no_ownership(self):
        arguments = self.adoption_arguments()
        with self.cli_port() as observe:
            code, output, error = self.cli(*arguments)
        self.assertEqual(code, 0, error)
        self.assertEqual(json.loads(output), {'result': 'layout-adopted', 'planSha256': arguments[-1], 'namespace': str(L.namespace(self.root))})
        self.assertEqual(self.read()['approvedPlanSha256'], arguments[-1])
        self.assertEqual(set(path.name for path in L.namespace(self.root).iterdir()), {'layout.json'})
        self.assertEqual(observe.call_count, 3)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_cli_wrong_or_stale_approval_allocates_nothing(self):
        approved = L.plan_sha256(self.review())
        for approval in ('0' * 64, approved):
            with self.subTest(approval=approval == approved):
                if approval == approved: self.root.chmod(0o750)
                with self.cli_port():
                    code, output, _ = self.cli(*self.adoption_arguments(approval))
                self.assertEqual((code, output), (2, ''))
                self.assertFalse(L.namespace(self.root).exists())
                self.assertFalse(L.legacy_path(self.root, 'host-lock').exists())

    def test_cli_daemon_change_before_adoption_allocates_nothing(self):
        arguments = self.adoption_arguments()
        with self.cli_port(['daemon-a', 'daemon-b']):
            code, output, _ = self.cli(*arguments)
        self.assertEqual((code, output), (2, ''))
        self.assertFalse(L.namespace(self.root).exists())

    def test_cli_exact_adoption_replay_is_read_only(self):
        arguments = self.adoption_arguments()
        with self.cli_port():
            self.assertEqual(self.cli(*arguments)[0], 0)
        receipt = L.namespace(self.root) / 'layout.json'
        before = (receipt.read_bytes(), receipt.stat().st_ino, receipt.stat().st_mtime_ns)
        with self.cli_port():
            code, output, error = self.cli(*arguments)
        self.assertEqual(code, 0, error)
        self.assertEqual(json.loads(output)['result'], 'layout-already-adopted')
        self.assertEqual((receipt.read_bytes(), receipt.stat().st_ino, receipt.stat().st_mtime_ns), before)

    def test_cli_existing_layout_cannot_be_rebound_to_another_approval(self):
        self.enroll()
        receipt = L.namespace(self.root) / 'layout.json'
        before = receipt.read_bytes()
        with self.cli_port():
            self.assertEqual(self.cli(*self.adoption_arguments('0' * 64))[0], 2)
        self.assertEqual(receipt.read_bytes(), before)

    def test_cli_daemon_change_after_adoption_preserves_the_receipt_for_review(self):
        arguments = self.adoption_arguments()
        with self.cli_port(['daemon-a', 'daemon-a', 'daemon-b']):
            code, output, _ = self.cli(*arguments)
        self.assertEqual((code, output), (2, ''))
        self.assertEqual(self.read()['approvedPlanSha256'], arguments[-1])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_cli_invalid_root_context_confirmation_and_digest_never_observe_docker(self):
        alias = self.base / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        cases = [
            ('review', str(alias), '--docker-context', 'local'),
            ('review', 'relative', '--docker-context', 'local'),
            ('review', str(self.root), '--docker-context', '-foreign'),
            (*self.adoption_arguments(), '--confirm-root', str(self.base)),
            (*self.adoption_arguments(), '--approved-plan-sha256', 'invalid'),
        ]
        with self.cli_port() as observe:
            for arguments in cases:
                with self.subTest(arguments=arguments[:2]):
                    try:
                        code, output, _ = self.cli(*arguments)
                    except SystemExit as error:
                        self.assertEqual(error.code, 2)
                    else:
                        self.assertEqual((code, output), (2, ''))
            observe.assert_not_called()

    def test_cli_review_cannot_take_approval_and_adopt_cannot_infer_it(self):
        with self.cli_port() as observe:
            for arguments in [
                ('review', str(self.root), '--docker-context', 'local', '--approved-plan-sha256', '0' * 64),
                ('adopt', str(self.root), '--docker-context', 'local'),
            ]:
                with self.assertRaises(SystemExit) as error:
                    self.cli(*arguments)
                self.assertEqual(error.exception.code, 2)
            observe.assert_not_called()

    def test_cli_requires_the_root_operator_on_the_linux_host(self):
        with self.cli_port() as observe, mock.patch.object(L, '_operator', side_effect=L.LayoutError('not the operator')):
            self.assertEqual(self.cli('review', str(self.root), '--docker-context', 'local')[0], 2)
            observe.assert_not_called()
        with self.cli_port() as observe, mock.patch.object(L.sys, 'platform', 'darwin'):
            self.assertEqual(self.cli('review', str(self.root), '--docker-context', 'local')[0], 2)
            observe.assert_not_called()

    def test_cli_docker_observer_requires_a_local_socket_and_bounded_daemon_identity(self):
        with mock.patch.object(L, '_cli_docker_output', side_effect=['"unix:///run/docker.sock"', 'daemon-a']) as read, \
             mock.patch.object(Path, 'is_socket', return_value=True):
            self.assertEqual(L._cli_daemon('local'), 'daemon-a')
        self.assertEqual(read.call_args_list[0].args, ('local', ['context', 'inspect', 'local', '--format', '{{json .Endpoints.docker.Host}}']))
        self.assertEqual(read.call_args_list[1].args, ('local', ['info', '--format', '{{.ID}}']))
        for endpoint in ('tcp://example.invalid:2375', 'ssh://example.invalid', 'unix://relative', 'unix:///run/bad\n.sock'):
            with self.subTest(endpoint=endpoint), mock.patch.object(L, '_cli_docker_output', return_value=json.dumps(endpoint)) as read:
                with self.assertRaises(L.LayoutError): L._cli_daemon('local')
                self.assertEqual(read.call_count, 1)
        with mock.patch.object(L, '_cli_docker_output', return_value='"unix:///run/docker.sock"'), \
             mock.patch.object(Path, 'is_socket', return_value=False):
            with self.assertRaises(L.LayoutError): L._cli_daemon('local')
        for identity in ('', 'x' * 257, 'not a daemon', 'daemon\nother'):
            with self.subTest(identity=len(identity)), mock.patch.object(L, '_cli_docker_output', side_effect=['"unix:///run/docker.sock"', identity]), \
                 mock.patch.object(Path, 'is_socket', return_value=True):
                with self.assertRaises(L.LayoutError): L._cli_daemon('local')

    def test_cli_docker_command_is_read_only_bounded_and_does_not_echo_diagnostics(self):
        with mock.patch.object(L.subprocess, 'run', return_value=mock.Mock(returncode=0, stdout='daemon-a\n')) as run:
            self.assertEqual(L._cli_docker_output('local', ['info', '--format', '{{.ID}}']), 'daemon-a')
        self.assertEqual(run.call_args.args[0], ['docker', '--context', 'local', 'info', '--format', '{{.ID}}'])
        self.assertEqual(run.call_args.kwargs, {'cwd': '/', 'capture_output': True, 'text': True, 'check': False, 'timeout': 15})
        for result in (mock.Mock(returncode=1, stdout='private diagnostic'), mock.Mock(returncode=0, stdout='x' * 4097)):
            with mock.patch.object(L.subprocess, 'run', return_value=result):
                with self.assertRaises(L.LayoutError) as error: L._cli_docker_output('local', ['info'])
                self.assertNotIn('private diagnostic', str(error.exception))

    def test_importing_layout_for_the_host_never_dispatches_the_cli(self):
        entry = importlib.util.spec_from_file_location('layout_import_fixture', Path(L.__file__))
        module = importlib.util.module_from_spec(entry)
        with mock.patch.object(L.subprocess, 'run', side_effect=AssertionError('no command during import')) as run:
            entry.loader.exec_module(module)
        run.assert_not_called()
        self.assertTrue(callable(module.main))


if __name__ == '__main__':
    unittest.main()
