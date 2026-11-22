import copy
from contextlib import contextmanager
import fcntl
import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

import test_orbis_host_legacy_ownership as legacy_tests


SPEC = importlib.util.spec_from_file_location('fresh_ownership_target', Path(__file__).with_name('orbis-host-fresh-ownership.py'))
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
TX = '00000000-0000-4000-8000-000000000001'


class FreshPermitTests(unittest.TestCase):
    """Real Root claim files and credential guards; unprivileged test ports only.

    The legacy module is the same production source loaded by the legacy suite.
    Native producer/Root approval and replacement review validity are not faked
    as acceptance; Docker/owner/review-validator inputs remain explicit fixtures.
    """
    def setUp(self):
        self.f = legacy_tests.LegacyOwnershipTests('test_helper_is_required_by_both_producers_and_present_in_host_copy')
        self.addCleanup(self.f.doCleanups); self.f.setUp()
        for name, value in (('L', legacy_tests.L), ('OWNER', os.geteuid())):
            patch = mock.patch.object(M, name, value); patch.start(); self.addCleanup(patch.stop)
        self.host, self.root, self.reader = self.f.host, self.f.root, self.f.reader
        self.host.IDENTITY = SimpleNamespace(PUBLICATION=SimpleNamespace(
            canonical=M.L.K.canonical, metadata=lambda body, **_: M.L.K.decoded(body)))

        def opened(root):
            path = self.f.layout.legacy_path(root, 'host-lock')
            fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.f.layout._lock_identity(os.fstat(fd))
                return [fd]
            except BaseException:
                os.close(fd); raise

        self.f.layout.open_locks = opened
        self.validator = mock.Mock()
        self.issuer = M.Issuer(self.host, self.root, self.reader, self.validator)

    @contextmanager
    def guarded(self):
        with legacy_tests.F.locked(self.host, self.root, self.reader.context) as guard:
            self.reader.lock_fd = guard._descriptors[0]
            try: yield guard
            finally: self.reader.lock_fd = None

    def review_fixture(self):
        self.f.authorization_fixture()
        with M.L.authorized(self.host, self.root, self.reader, self.f.manifest) as proof:
            decision = proof.verify()
        value = {'schema': 'fixture-replacement-review.v1', 'mode': 'fresh', 'root': str(self.root),
                 'dockerContext': self.reader.context, 'target': copy.deepcopy(self.f.manifest),
                 'checkpoint': {'roles': {self.f.raw['Id']: 'controller'}, 'journal': str(self.f.folder / 'checkpoint.json')},
                 'journal': str(self.f.folder / 'transaction.json'), 'freshOwnership': decision}
        value['reviewId'] = M.L.K.digest(value)
        return value

    def selected(self, guard, value):
        row = guard.read()
        return {'schema': M.REFERENCE, 'operationId': row['operationId'], 'admissionBinding': row['admissionBinding'],
                'authorizationSha256': value['freshOwnership']['authorizationSha256']}

    def stop_original(self, name=None):
        self.f.raw['State'].update(Status='exited', Running=False, Pid=0)
        self.f.raw['HostConfig']['RestartPolicy'] = dict(M.NO_RESTART)
        if name is not None: self.f.raw['Name'] = name

    def test_selector_is_durable_before_exclusive_claim_and_no_scope_retires_it(self):
        with self.guarded() as guard:
            value = self.review_fixture()
            original = self.issuer._write
            def write(selected, record):
                self.assertEqual(selected.read()['operationId'], record['operationId'])
                self.assertFalse(M.claim_path(self.root, record['operationId']).exists())
                original(selected, record)
            with mock.patch.object(self.issuer, '_write', side_effect=write):
                with self.issuer.begin(guard, value, TX) as permit:
                    ref = permit.check(value, TX, original_state='running')
                    path = M.claim_path(self.root, ref['operationId'])
                    body = path.read_bytes()
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                    altered = permit.reference; altered['admissionBinding'] = '0' * 64
                    self.assertEqual(permit.reference, ref)
                    self.assertNotIn('fixture-value', body.decode())
            self.assertEqual(guard.read()['admissionBinding'], ref['admissionBinding'])
            self.assertEqual(path.read_bytes(), body)
            with self.assertRaises(ValueError): permit.check(value, TX, original_state='running')
        self.validator.assert_called()

    def test_stopped_retained_original_resumes_without_a_live_producer_or_old_approval_file(self):
        with self.guarded() as guard:
            value = self.review_fixture()
            with self.issuer.begin(guard, value, TX) as permit: ref = permit.reference
        self.stop_original('/orbis-previous-' + TX)
        self.assertFalse(M.L.authorization_path(self.root).exists())
        with self.guarded() as guard:
            with self.issuer.resume(guard, value, TX, ref, original_state='stopped') as permit:
                self.assertEqual(permit.check(value, TX, original_state='stopped'), ref)
                with self.assertRaises(ValueError): permit.check(value, TX, original_state='running')
            self.assertIsNotNone(guard.read())

    def test_lost_reply_after_claim_is_recovered_only_by_explicit_resume(self):
        with self.guarded() as guard:
            value = self.review_fixture()
            with mock.patch.object(self.issuer, '_read', side_effect=RuntimeError('fixture lost reply')):
                with self.assertRaises(RuntimeError), self.issuer.begin(guard, value, TX): pass
            ref = self.selected(guard, value)
            with self.assertRaises(ValueError), self.issuer.begin(guard, value, TX): pass
            with self.issuer.resume(guard, value, TX, ref, original_state='running') as permit:
                self.assertEqual(permit.reference, ref)

    def test_failure_after_hold_before_claim_never_reinitializes_or_retires(self):
        with self.guarded() as guard:
            value = self.review_fixture()
            with mock.patch.object(self.issuer, '_write', side_effect=OSError('fixture disk interruption')):
                with self.assertRaises(OSError), self.issuer.begin(guard, value, TX): pass
            before = guard.read(); ref = self.selected(guard, value)
            with self.assertRaises(FileNotFoundError), self.issuer.resume(guard, value, TX, ref, original_state='running'): pass
            self.assertEqual(guard.read(), before)
            self.assertFalse(M.claim_path(self.root, ref['operationId']).exists())

    def test_partial_claim_is_retained_and_never_promoted_to_a_permit(self):
        with self.guarded() as guard:
            value = self.review_fixture()
            def partial(selected, record):
                path = M.claim_path(self.root, record['operationId'])
                with path.open('xb') as out: out.write(b'{'); out.flush(); os.fsync(out.fileno())
                path.chmod(0o600)
                raise OSError('fixture partial claim')
            with mock.patch.object(self.issuer, '_write', side_effect=partial):
                with self.assertRaises(OSError), self.issuer.begin(guard, value, TX): pass
            ref = self.selected(guard, value); path = M.claim_path(self.root, ref['operationId'])
            with self.assertRaises(ValueError), self.issuer.resume(guard, value, TX, ref, original_state='running'): pass
            self.assertEqual(path.read_bytes(), b'{'); self.assertIsNotNone(guard.read())

    def test_interrupted_consumption_preserves_claim_policy_and_hold_without_repair(self):
        with self.guarded() as guard:
            value = self.review_fixture()
            with mock.patch.object(self.issuer, '_consume', side_effect=OSError('fixture archive interruption')):
                with self.assertRaises(OSError), self.issuer.begin(guard, value, TX): pass
            ref = self.selected(guard, value); before = self.f.snapshot()
            self.assertTrue(M.claim_path(self.root, ref['operationId']).exists())
            self.assertTrue(M.L.authorization_path(self.root).exists())
            with self.assertRaises(ValueError), self.issuer.resume(guard, value, TX, ref, original_state='running'): pass
            self.assertEqual(self.f.snapshot(), before); self.assertIsNotNone(guard.read())

    def test_two_link_consumption_crash_never_issues_or_recreates_a_decision(self):
        with self.guarded() as guard:
            value = self.review_fixture(); original = M.L.authorization_path(self.root)
            unlink = M.os.unlink
            def interrupted(name, *args, **kwargs):
                if name == original.name: raise OSError('fixture interruption after archive link')
                return unlink(name, *args, **kwargs)
            with mock.patch.object(M.os, 'unlink', side_effect=interrupted):
                with self.assertRaises(OSError), self.issuer.begin(guard, value, TX): pass
            ref = self.selected(guard, value); consumed = M.consumed_path(self.root, ref['operationId'])
            self.assertEqual(original.stat().st_ino, consumed.stat().st_ino)
            self.assertEqual(consumed.stat().st_nlink, 2)
            before = self.f.snapshot()
            with self.assertRaises(ValueError), self.issuer.resume(guard, value, TX, ref, original_state='running'): pass
            self.assertEqual(self.f.snapshot(), before); self.assertIsNotNone(guard.read())

    def test_one_root_decision_cannot_be_reissued_for_another_review_or_transaction(self):
        with self.guarded() as guard:
            value = self.review_fixture()
            with self.issuer.begin(guard, value, TX) as permit: ref = permit.reference
            # Fixture-only manual retirement simulates a later, independently
            # proven terminal disposition. This module exposes no completion.
            guard.finish(ref['operationId'], ref['admissionBinding'], verify_completed=lambda: True)
            # Restoring a spent policy and losing its claim must still not make
            # the independently retained consumption receipt a new approval.
            policy = M.L.authorization_path(self.root)
            policy.write_bytes(M.consumed_path(self.root, ref['operationId']).read_bytes()); policy.chmod(0o600)
            M.claim_path(self.root, ref['operationId']).unlink()
            with self.assertRaises(ValueError), self.issuer.begin(guard, value, TX): pass
            self.assertIsNone(guard.read())

    def test_review_transaction_reference_and_selector_cannot_be_substituted(self):
        with self.guarded() as guard:
            value = self.review_fixture()
            with self.issuer.begin(guard, value, TX) as permit: ref = permit.reference
            before = guard.read()
            changed = copy.deepcopy(value); changed['journal'] += '.other'; changed.pop('reviewId'); changed['reviewId'] = M.L.K.digest(changed)
            for candidate, tx, selected in ((changed, TX, ref), (value, '00000000-0000-4000-8000-000000000002', ref),
                    (value, TX, {**ref, 'admissionBinding': '0' * 64}), (value, TX, {**ref, 'authorizationSha256': '0' * 64})):
                with self.assertRaises(ValueError), self.issuer.resume(guard, candidate, tx, selected, original_state='running'): pass
            self.assertEqual(guard.read(), before)

    def test_stopped_original_mutations_never_change_or_release_claim(self):
        with self.guarded() as guard:
            value = self.review_fixture()
            with self.issuer.begin(guard, value, TX) as permit: ref = permit.reference
            self.stop_original(); raw = copy.deepcopy(self.f.raw)
            changes = [lambda: self.f.raw['State'].update(Pid=1), lambda: self.f.raw['State'].update(Running=0),
                       lambda: self.f.raw['State'].update(Dead=True), lambda: self.f.raw.update(Name='/another-controller'),
                       lambda: self.f.raw['HostConfig'].update(RestartPolicy={'Name': 'always', 'MaximumRetryCount': 0}),
                       lambda: self.f.raw['Config']['Env'].append('CHANGED=fixture'),
                       lambda: self.f.raw.update(Image='sha256:' + '0' * 64)]
            path = M.claim_path(self.root, ref['operationId']); body = path.read_bytes()
            for change in changes:
                change()
                with self.assertRaises(ValueError), self.issuer.resume(guard, value, TX, ref, original_state='stopped'): pass
                self.f.raw = copy.deepcopy(raw)
                self.assertEqual(path.read_bytes(), body); self.assertIsNotNone(guard.read())

    def test_same_bytes_replaced_source_file_and_changed_storage_identity_stay_held(self):
        with self.guarded() as guard:
            value = self.review_fixture()
            with self.issuer.begin(guard, value, TX) as permit: ref = permit.reference
            source = self.root / '.env'; body = source.read_bytes()
            source.rename(self.root / 'retained-env'); source.write_bytes(body); source.chmod(0o600)
            with self.assertRaises(ValueError), self.issuer.resume(guard, value, TX, ref, original_state='running'): pass
            self.assertIsNotNone(guard.read())

    def test_changed_cache_inode_cannot_rebind_stopped_controller_storage(self):
        with self.guarded() as guard:
            value = self.review_fixture()
            with self.issuer.begin(guard, value, TX) as permit: ref = permit.reference
            self.stop_original()
            cache = self.root / 'cache'; cache.rename(self.root / 'retained-cache'); cache.mkdir(mode=0o700)
            with self.assertRaises(ValueError), self.issuer.resume(guard, value, TX, ref, original_state='stopped'): pass
            self.assertIsNotNone(guard.read())

    def test_missing_consumed_root_policy_is_not_replaced_by_a_claim_alone(self):
        with self.guarded() as guard:
            value = self.review_fixture()
            with self.issuer.begin(guard, value, TX) as permit: ref = permit.reference
            consumed = M.consumed_path(self.root, ref['operationId']); consumed.unlink()
            before = self.f.snapshot()
            with self.assertRaises(FileNotFoundError), self.issuer.resume(guard, value, TX, ref, original_state='running'): pass
            self.assertEqual(self.f.snapshot(), before); self.assertIsNotNone(guard.read())

    def test_other_authority_or_claim_mode_alias_missing_cannot_resume(self):
        with self.guarded() as guard:
            value = self.review_fixture()
            with self.issuer.begin(guard, value, TX) as permit: ref = permit.reference
            path = M.claim_path(self.root, ref['operationId']); body = path.read_bytes()
            for state in ('namespace', 'public', 'missing'):
                if state == 'namespace':
                    selected = self.f.layout.namespace(self.root); selected.parent.mkdir(parents=True, exist_ok=True); selected.mkdir(mode=0o700)
                elif state == 'public': path.chmod(0o644)
                else: path.unlink()
                with self.assertRaises((ValueError, OSError)), self.issuer.resume(guard, value, TX, ref, original_state='running'): pass
                self.assertIsNotNone(guard.read())
                if state == 'namespace': selected.rmdir()
                elif state == 'public': path.chmod(0o600)
            self.assertFalse(path.exists()); self.assertTrue(body)

    def test_no_missing_root_decision_or_fake_guard_can_issue_a_claim(self):
        with self.guarded() as guard:
            value = self.review_fixture(); M.L.authorization_path(self.root).unlink()
            with self.assertRaises(FileNotFoundError), self.issuer.begin(guard, value, TX): pass
            with self.assertRaises(ValueError), self.issuer.begin(SimpleNamespace(), value, TX): pass
            self.assertIsNone(guard.read())
            self.assertEqual(list(self.root.parent.glob('.orbis-fresh-ownership-*.json')), [])

    def test_pending_permit_blocks_ordinary_credential_and_lifecycle_paths(self):
        with self.guarded() as guard:
            value = self.review_fixture()
            with self.issuer.begin(guard, value, TX) as permit:
                before = self.f.snapshot()
                with self.assertRaises(ValueError): self.host.require_no_capture_fence(self.root)
                with self.assertRaises(ValueError): M.L.require_no_transition(self.host, self.root)
                self.assertEqual(self.f.snapshot(), before)
                self.assertEqual(guard.read()['operationId'], permit.reference['operationId'])
        before = self.f.snapshot()
        @contextmanager
        def credential_scope():
            with self.guarded() as guard:
                # A deliberately positive fixture admission still cannot
                # displace the real existing Fresh lifecycle selector.
                proof = {'schema': M.L.K.ADMISSION, 'mode': 'unmanaged', 'managedEver': False,
                         'installationId': '1' * 64, 'controllerId': '2' * 64, 'imageId': 'sha256:' + '3' * 64,
                         'controllerEpoch': '4' * 64, 'authorityEpoch': '5' * 64}
                yield guard, lambda: copy.deepcopy(proof)
        kernel = M.L.K.OwnershipAuthority(self.host, self.root, self.reader.context, credential_scope)
        with self.assertRaises(M.L.K.OwnershipAuthorityError): kernel.prepare('6' * 64, 'first-registration')
        self.assertEqual(self.f.snapshot(), before)


if __name__ == '__main__':
    unittest.main()
