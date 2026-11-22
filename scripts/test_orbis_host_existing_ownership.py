import copy
from contextlib import redirect_stdout, contextmanager
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

import test_orbis_host_legacy_ownership as fixture

E = fixture.load('orbis-host-existing-ownership.py', 'existing_ownership_target')


class ExistingOwnershipTests(unittest.TestCase):
    """Actual private files and shared locks; observation/owner ports are explicit.

    Publisher/enrollment, Docker, local daemon and layout observations are
    fixture ports. Synthetic Root decisions never become native approval.
    """
    def setUp(self):
        self.f = fixture.LegacyOwnershipTests('test_review_is_bound_metadata_only_and_never_creates_authorization')
        self.addCleanup(self.f.doCleanups); self.f.setUp()
        f = self.f
        for module in (E, E.B, E.C, E.K):
            change = mock.patch.object(module, 'OWNER', os.geteuid()); change.start(); self.addCleanup(change.stop)
        for name in ('RECOVERY', 'RECOVERY_ENV'):
            change = mock.patch.object(E.B, name, f.folder / name.lower()); change.start(); self.addCleanup(change.stop)
        f.host.PLAN.validate_manifest = fixture.P.validate_manifest
        f.host.IDENTITY = SimpleNamespace(PUBLICATION=SimpleNamespace(canonical=E.K.canonical,
            metadata=lambda body, **kwargs: E.K.decoded(body)))
        f.raw.update(Path='/usr/bin/node', Args=['main.js'])
        f.raw['Config']['Image'] = f.manifest['image'] + '@' + f.manifest['digest']
        f.raw['Config']['Env'].append('NOT_AN_AUTHORITY=fixture-private-value')
        self.adopted = True
        self.namespace = f.layout.namespace(f.root)
        self.namespace.mkdir(parents=True, mode=0o700)
        self.layout_value = {'schema': 'fixture-reviewed-layout', 'root': str(f.root), 'context': 'local'}
        self.write(self.namespace / 'layout.json', self.layout_value)
        self.saved = {'schema': 'fixture-enrollment', 'root': str(f.root), 'dockerContext': 'local',
                      'tag': f.manifest['tag'], 'digest': f.manifest['digest']}
        self.write(f.root / f.host.STATE_NAME, self.saved)
        f.host.saved_state = lambda root: json.loads((root / f.host.STATE_NAME).read_bytes())
        f.layout.R = fixture.load('orbis-reset-authority.py', 'existing_review_data_ancestry')
        f.layout.read = lambda *args: copy.deepcopy(self.layout_value) if self.adopted else None
        f.layout.selected_path = lambda root, purpose: self.namespace / {
            'host-lock': 'host.lock', 'credential-fence': 'credential-fence.json'}[purpose] if self.adopted else f.layout.legacy_path(root, purpose)
        f.layout.lock_paths = lambda root: [f.layout.legacy_path(root, 'host-lock')] + ([self.namespace / 'host.lock'] if self.adopted else [])
        def opened(root):
            result = []
            try:
                for path in f.layout.lock_paths(root):
                    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600); result.append(fd)
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    f.layout._lock_identity(os.fstat(fd))
                return result
            except BaseException:
                for fd in result: os.close(fd)
                raise
        f.layout.open_locks = opened
        f.host.credential_fence_lock = lambda root, context: fixture.F.locked(f.host, root, context)
        self.service = SimpleNamespace(HOST=f.host, root=f.root, context='local', state_dir=f.state,
            current_manifest=mock.Mock(side_effect=lambda: copy.deepcopy(f.manifest)),
            require_credential_idle=lambda guard: guard.read())
        self.service.controller_capture_identity = mock.Mock(side_effect=lambda identifier, image, saved: {
            'id': identifier, 'imageId': image, 'releaseTag': f.manifest['tag'], 'releaseDigest': f.manifest['digest'],
            'imageReference': f.manifest['image'] + '@' + f.manifest['digest'],
            'startedAt': f.raw['State']['StartedAt']})
        f.host.docker = mock.Mock(side_effect=lambda context, args, root: SimpleNamespace(
            returncode=0, stdout=json.dumps('daemon-fixture' if args[0] == 'info' else f.raw)))
        change = mock.patch.object(E, 'local_daemon', return_value='daemon-fixture'); change.start(); self.addCleanup(change.stop)
        with self.locked(): pass

    def write(self, path, value):
        path.write_bytes(E.K.canonical(value) + b'\n'); path.chmod(0o600)

    def locked(self):
        return self.f.host.credential_fence_lock(self.f.root, 'local')

    def authorize_fixture(self, guard):
        plan = E.review(self.service, guard)
        path = E.authorization_path(self.service)
        self.write(path, {'schema': E.AUTHORIZATION, 'policy': E.POLICY, 'planSha256': E.K.digest(plan), 'approvalId': 'f' * 64})
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def test_read_only_review_binds_adopted_enrollment_and_never_exposes_environment_or_claims_unmanaged(self):
        with self.locked() as guard:
            before = self.f.snapshot()
            plan = E.review(self.service, guard)
            self.assertEqual(plan['layout']['kind'], 'adopted')
            self.assertEqual(plan['publication']['commit'], self.f.manifest['commit'])
            self.assertEqual(plan['enrollment']['sha256'], hashlib.sha256((self.f.root / self.f.host.STATE_NAME).read_bytes()).hexdigest())
            self.assertNotIn('fixture-private-value', json.dumps(plan)); self.assertNotIn('fixture-only', json.dumps(plan))
            self.assertNotIn('managedEver', plan); self.assertNotIn('origin', plan)
            self.assertFalse(E.authorization_path(self.service).exists()); self.assertIsNone(guard.read())
            self.assertEqual(self.f.snapshot(), before)

    def test_absent_history_is_not_a_root_decision(self):
        with self.locked() as guard:
            before = self.f.snapshot()
            with self.assertRaises(FileNotFoundError), E.authorized(self.service, guard, authorization_sha256='a' * 64):
                self.fail('Missing decision cannot authorize')
            self.assertEqual(self.f.snapshot(), before); self.assertIsNone(guard.read())

    def test_exact_independent_decision_yields_only_live_read_only_witness(self):
        with self.locked() as guard:
            digest = self.authorize_fixture(guard); before = self.f.snapshot()
            with E.authorized(self.service, guard, authorization_sha256=digest) as witness:
                value = witness.verify()
                self.assertEqual(value['authorizationSha256'], digest)
                self.assertNotIn('operationId', value); self.assertNotIn('admissionBinding', value)
                plan = witness.plan; plan['controller']['id'] = '1' * 64
                self.assertNotEqual(witness.plan, plan)
                self.assertIsNone(guard.read())
            with self.assertRaises(ValueError): witness.verify()
            self.assertEqual(self.f.snapshot(), before)

    def test_exact_policy_digest_shape_and_canonical_bytes_are_required(self):
        with self.locked() as guard:
            digest = self.authorize_fixture(guard); path = E.authorization_path(self.service)
            original = path.read_bytes()
            for field, bad in [('policy', 'other'), ('planSha256', 'a' * 64), ('approvalId', True), ('extra', True)]:
                with self.subTest(field=field):
                    value = json.loads(original); value[field] = bad; self.write(path, value)
                    changed = hashlib.sha256(path.read_bytes()).hexdigest()
                    with self.assertRaises(ValueError), E.authorized(self.service, guard, authorization_sha256=changed): pass
            path.write_bytes(original + b' ')
            with self.assertRaises(ValueError), E.authorized(self.service, guard,
                    authorization_sha256=hashlib.sha256(path.read_bytes()).hexdigest()): pass
            path.write_bytes(original)
            with self.assertRaises(ValueError), E.authorized(self.service, guard, authorization_sha256='e' * 64): pass

    def test_root_namespace_orphan_and_global_recovery_cohorts_veto_decisions(self):
        with self.locked() as guard:
            candidates = [self.f.state / E.C.CONFIG_NAME, self.namespace / 'recovery-admission-history.json',
                self.namespace / '.credential-floor.pending', self.namespace / 'controller-handoff',
                E.B.RECOVERY_ENV, E.B.pending_path(self.f.root)]
            legacy, _ = E.B.legacy_journal_paths(self.f.layout, self.f.root)
            candidates.append(legacy.with_name(legacy.name + '.completed.sqlite3'))
            for file in candidates:
                with self.subTest(name=file.name):
                    file.write_bytes(b'partial')
                    try:
                        with self.assertRaises(ValueError): E.review(self.service, guard)
                    finally: file.unlink()
            self.assertIsNone(guard.read())

    def test_missing_adopted_layout_cannot_be_reclassified_as_legacy(self):
        self.adopted = False
        with self.locked() as guard:
            with self.assertRaises(ValueError): E.review(self.service, guard)
            self.assertIsNone(guard.read())

    def test_alternate_state_directory_cannot_hide_global_admission(self):
        self.write(self.f.state / E.C.CONFIG_NAME, {'fixture': 'pending-admission'})
        self.service.state_dir = self.f.folder / 'other-state'
        with self.locked() as guard:
            with self.assertRaises(ValueError): E.review(self.service, guard)
            self.assertIsNone(guard.read())

    def test_existing_credential_hold_is_preserved_without_a_review_or_decision(self):
        with self.locked() as guard:
            guard.begin('b' * 64, 'c' * 64)
            before = guard.read()
            with self.assertRaises(ValueError): E.review(self.service, guard)
            self.assertEqual(guard.read(), before)
            self.assertFalse(E.authorization_path(self.service).exists())

    def test_genuine_legacy_layout_uses_same_enrolled_orbis_decision_without_namespace_allocation(self):
        (self.namespace / 'layout.json').unlink(); (self.namespace / 'host.lock').unlink(); self.namespace.rmdir()
        self.adopted = False
        with self.locked() as guard:
            before = self.f.snapshot(); plan = E.review(self.service, guard)
            self.assertEqual(plan['layout'], {'kind': 'legacy'})
            self.assertFalse(self.namespace.exists()); self.assertEqual(self.f.snapshot(), before)

    def test_same_bytes_enrollment_or_configuration_replacement_invalidates_witness(self):
        with self.locked() as guard:
            digest = self.authorize_fixture(guard)
            with self.assertRaises(ValueError), E.authorized(self.service, guard, authorization_sha256=digest) as witness:
                file = self.f.root / '.env'; other = self.f.root / 'fixture-replacement'
                other.write_bytes(file.read_bytes()); other.chmod(0o600); other.replace(file)
                witness.verify()
            self.assertIsNone(guard.read())

    def test_epoch_local_daemon_and_enrollment_drift_refuse_without_grant(self):
        with self.locked() as guard:
            digest = self.authorize_fixture(guard)
            with self.assertRaises(ValueError), E.authorized(self.service, guard, authorization_sha256=digest) as witness:
                self.f.raw['State']['Pid'] += 1
                witness.verify()
            self.f.raw['State']['Pid'] -= 1
            with mock.patch.object(E, 'local_daemon', return_value='other-daemon'):
                with self.assertRaises(ValueError): E.review(self.service, guard)
            self.service.controller_capture_identity.side_effect = lambda *args: {'releaseTag': 'other'}
            with self.assertRaises(ValueError): E.review(self.service, guard)
            self.assertIsNone(guard.read())

    def test_proxy_execution_mount_is_allowed_but_root_credential_exposure_is_not(self):
        (self.namespace / 'proxy-config/execution').mkdir(parents=True, mode=0o700)
        self.f.raw['Mounts'].append({'Type': 'bind', 'Source': str(self.namespace / 'proxy-config/execution'),
                                    'Destination': '/data/traefik', 'RW': False})
        with self.locked() as guard:
            E.review(self.service, guard)
            self.f.raw['Mounts'].append({'Type': 'bind', 'Source': str(self.namespace), 'Destination': '/unsafe', 'RW': False})
            with self.assertRaises(ValueError): E.review(self.service, guard)
            self.assertIsNone(guard.read())

    def test_namespace_bind_alias_is_rejected_by_identity_without_changing_custody(self):
        alias = self.f.folder / 'namespace-alias'; alias.mkdir()
        self.f.raw['Mounts'].append({'Type': 'bind', 'Source': str(alias), 'Destination': '/alias', 'RW': False})
        actual = E.mount_identity
        def observed(path):
            return actual(self.namespace if Path(path) == alias else path)
        with self.locked() as guard, mock.patch.object(E, 'mount_identity', side_effect=observed):
            before = self.f.snapshot()
            with self.assertRaises(ValueError): E.review(self.service, guard)
            self.assertEqual(self.f.snapshot(), before); self.assertIsNone(guard.read())

    def test_unhealthy_or_unenrolled_controller_never_produces_review(self):
        with self.locked() as guard:
            original = copy.deepcopy(self.f.raw)
            for changed in ('pid', 'health', 'reference', 'id'):
                with self.subTest(changed=changed):
                    self.f.raw.clear(); self.f.raw.update(copy.deepcopy(original))
                    if changed == 'pid': self.f.raw['State']['Pid'] = True
                    elif changed == 'health': self.f.raw['State']['Health']['Status'] = 'starting'
                    elif changed == 'reference': self.f.raw['Config']['Image'] = 'unreviewed/controller:latest'
                    else: self.f.raw['Id'] = 'partial'
                    with self.assertRaises(ValueError): E.review(self.service, guard)
                    self.assertIsNone(guard.read())

    def test_authorization_inode_replacement_and_aliases_never_survive_open_witness(self):
        with self.locked() as guard:
            digest = self.authorize_fixture(guard); file = E.authorization_path(self.service)
            with self.assertRaises(ValueError), E.authorized(self.service, guard, authorization_sha256=digest) as witness:
                other = file.with_suffix('.replacement'); other.write_bytes(file.read_bytes()); other.chmod(0o600)
                other.replace(file); witness.verify()
            alias = file.with_suffix('.alias'); alias.symlink_to(file)
            file.rename(file.with_suffix('.retained')); file.symlink_to(alias)
            with self.assertRaises((OSError, ValueError)), E.authorized(self.service, guard, authorization_sha256=digest): pass
            self.assertIsNone(guard.read())

    def test_decision_cannot_cross_thread_guard_or_protected_file_custody(self):
        with self.locked() as guard:
            digest = self.authorize_fixture(guard)
            with E.authorized(self.service, guard, authorization_sha256=digest) as witness:
                result = []
                def other_thread():
                    try: witness.verify()
                    except ValueError: result.append('refused')
                thread = threading.Thread(target=other_thread); thread.start(); thread.join()
                self.assertEqual(result, ['refused'])
            path = E.authorization_path(self.service); path.chmod(0o644)
            with self.assertRaises(ValueError), E.authorized(self.service, guard, authorization_sha256=digest): pass
        with self.assertRaises(ValueError): E.review(self.service, guard)

    def test_cli_review_uses_credentials_only_nonrecovering_service_and_writes_no_decision(self):
        f = self.f
        module = SimpleNamespace(HOST=f.host, HostService=mock.Mock(return_value=self.service))
        args = [E.__file__, 'review', str(f.root), '--docker-context', 'local', '--snapshots', str(f.folder)]
        before = f.snapshot(); output = io.StringIO()
        with mock.patch.object(E, 'require_host'), mock.patch.object(E, 'load', return_value=module), \
                mock.patch.object(E.os.sys, 'argv', args), redirect_stdout(output):
            self.assertEqual(E.main(), 0)
        module.HostService.assert_called_once_with(f.root, 'local', f.folder, f.state,
            recover_interrupted_job=False, credentials_only=True)
        self.assertEqual(json.loads(output.getvalue())['planSha256'], E.K.digest(json.loads(output.getvalue())['plan']))
        self.assertFalse(E.authorization_path(self.service).exists()); self.assertEqual(f.snapshot(), before)

    def test_user_writable_installation_data_is_observed_while_decision_custody_stays_root_private(self):
        self.f.root.chmod(0o775); (self.f.root / '.env').chmod(0o664)
        private_pin = E.C.PinnedFile
        def protected_only(path, **kwargs):
            self.assertFalse(Path(path).is_relative_to(self.f.root), 'Main data cannot be used as private Root custody')
            return private_pin(path, **kwargs)
        with self.locked() as guard, mock.patch.object(E.C, 'PinnedFile', side_effect=protected_only), \
                mock.patch.object(E.B, 'root_identity', side_effect=AssertionError('Birth authority cannot classify existing data')):
            digest = self.authorize_fixture(guard)
            self.assertEqual(E.authorization_path(self.service).parent, self.namespace)
            with E.authorized(self.service, guard, authorization_sha256=digest) as witness:
                self.assertEqual(witness.plan['rootIdentity'][4] & 0o777, 0o775)
                self.assertEqual(witness.plan['ancestry'][-1]['mode'], 0o775)
            E.authorization_path(self.service).chmod(0o664)
            with self.assertRaises(ValueError), E.authorized(self.service, guard, authorization_sha256=digest): pass
            self.assertIsNone(guard.read())

    def test_observed_file_detects_replaced_intermediate_directory(self):
        parent = self.f.root / 'user-config'; file = parent / 'tipi-compose.yml'; file.write_text('services: {}\n')
        with E.data_root(self.service) as (fd, _, verify):
            pin = E.ObservedFile(self.f.root, fd, verify, file, limit=1024)
            try:
                parent.rename(self.f.root / 'old-user-config'); parent.mkdir(mode=0o700)
                (self.f.root / 'old-user-config/tipi-compose.yml').rename(file)
                with self.assertRaises(ValueError): pin.verify()
            finally: pin.close()

    def test_symlink_hardlink_and_world_writable_data_refuse_without_private_policy(self):
        file = self.f.root / '.env'; original = file.read_bytes()
        with self.locked() as guard:
            other = self.f.root / 'fixture-data'; other.write_bytes(original)
            file.unlink(); file.symlink_to(other)
            with self.assertRaises(ValueError): E.review(self.service, guard)
            file.unlink(); os.link(other, file)
            with self.assertRaises(ValueError): E.review(self.service, guard)
            file.unlink(); file.write_bytes(original); file.chmod(0o666)
            with self.assertRaises(ValueError): E.review(self.service, guard)
            self.assertFalse(E.authorization_path(self.service).exists()); self.assertIsNone(guard.read())

    def test_oversized_data_file_refuses_before_a_plan_or_decision(self):
        (self.f.root / '.env').write_bytes(b'x' * (1024 * 1024 + 1))
        with self.locked() as guard:
            with self.assertRaises(ValueError): E.review(self.service, guard)
            self.assertFalse(E.authorization_path(self.service).exists()); self.assertIsNone(guard.read())

    def test_empty_optional_compose_input_is_preserved_as_data(self):
        file = self.f.root / 'user-config/tipi-compose.yml'; file.write_bytes(b'')
        with self.locked() as guard:
            plan = E.review(self.service, guard)
            self.assertEqual(plan['files']['user-config/tipi-compose.yml']['sha256'], hashlib.sha256(b'').hexdigest())
            self.assertEqual(file.read_bytes(), b''); self.assertIsNone(guard.read())

    def test_provision_consumes_exact_decision_once_and_retains_private_proof_without_main_grant(self):
        self.f.root.chmod(0o775)
        issuer = E.Issuer(self.service)
        with self.locked() as guard:
            digest = self.authorize_fixture(guard)
            original = E.authorization_path(self.service).stat()
            data = {str(p): p.read_bytes() for p in self.f.root.rglob('*') if p.is_file()}
            result = issuer.provision(guard, authorization_sha256=digest)
            self.assertIsNone(guard.read()); self.assertNotIn('mode', result); self.assertNotIn('admissionBinding', result)
            self.assertFalse(E.authorization_path(self.service).exists())
            self.assertEqual(issuer.paths['decision'].stat().st_ino, original.st_ino)
            for name in ('intent', 'decision', 'proof'):
                self.assertEqual(issuer.paths[name].stat().st_mode & 0o777, 0o600)
                self.assertEqual(issuer.paths[name].stat().st_nlink, 1)
            self.assertEqual(data, {str(p): p.read_bytes() for p in self.f.root.rglob('*') if p.is_file()})
            self.assertFalse((self.namespace / E.K.STATE).exists())
            before = self.f.snapshot()
            with mock.patch.object(guard, 'begin', side_effect=AssertionError('No new hold on completed replay')), \
                    mock.patch.object(issuer, '_publish', side_effect=AssertionError('No rewrite on completed replay')):
                self.assertEqual(issuer.provision(guard, authorization_sha256=digest), result)
            self.assertEqual(self.f.snapshot(), before)
            with self.assertRaises(ValueError): E.review(self.service, guard)

    def test_provision_missing_decision_does_not_allocate_hold_or_proof(self):
        with self.locked() as guard:
            before = self.f.snapshot()
            with self.assertRaises(FileNotFoundError): E.Issuer(self.service).provision(guard, authorization_sha256='a' * 64)
            self.assertEqual(self.f.snapshot(), before); self.assertIsNone(guard.read())

    def test_legacy_review_cannot_publish_into_unadopted_parent(self):
        (self.namespace / 'layout.json').unlink(); (self.namespace / 'host.lock').unlink(); self.namespace.rmdir()
        self.adopted = False
        with self.locked() as guard:
            digest = self.authorize_fixture(guard); before = self.f.snapshot()
            with self.assertRaises(ValueError): E.Issuer(self.service).provision(guard, authorization_sha256=digest)
            self.assertIsNone(guard.read()); self.assertEqual(self.f.snapshot(), before)

    def test_interrupted_before_intent_preserves_unexplained_hold_and_original_decision(self):
        issuer = E.Issuer(self.service)
        with self.locked() as guard:
            digest = self.authorize_fixture(guard)
            with mock.patch.object(issuer, '_publish', side_effect=InterruptedError), self.assertRaises(InterruptedError):
                issuer.provision(guard, authorization_sha256=digest)
            before = self.f.snapshot(); marker = guard.read()
            self.assertIsNotNone(marker); self.assertTrue(E.authorization_path(self.service).exists())
            with self.assertRaises(ValueError): issuer.provision(guard, authorization_sha256=digest)
            self.assertEqual(self.f.snapshot(), before); self.assertEqual(guard.read(), marker)

    def test_interrupted_after_intent_resumes_exact_decision_and_does_not_rewrite_intent(self):
        issuer = E.Issuer(self.service)
        with self.locked() as guard:
            digest = self.authorize_fixture(guard)
            with mock.patch.object(issuer, '_consume', side_effect=InterruptedError), self.assertRaises(InterruptedError):
                issuer.provision(guard, authorization_sha256=digest)
            before = E.C.seal(issuer.paths['intent'].stat())
            self.assertTrue(E.authorization_path(self.service).exists())
            result = issuer.provision(guard, authorization_sha256=digest)
            self.assertEqual(E.C.seal(issuer.paths['intent'].stat()), before)
            self.assertEqual(result['schema'], E.PROOF); self.assertIsNone(guard.read())

    def test_interrupted_after_consumption_resumes_from_original_inode_without_a_new_decision(self):
        issuer = E.Issuer(self.service); publish = issuer._publish
        def stop(guard, name, value, hold):
            if name == 'proof': raise InterruptedError()
            return publish(guard, name, value, hold)
        with self.locked() as guard:
            digest = self.authorize_fixture(guard)
            with mock.patch.object(issuer, '_publish', side_effect=stop), self.assertRaises(InterruptedError):
                issuer.provision(guard, authorization_sha256=digest)
            self.assertFalse(E.authorization_path(self.service).exists()); self.assertFalse(issuer.paths['proof'].exists())
            decision = E.C.seal(issuer.paths['decision'].stat())
            issuer.provision(guard, authorization_sha256=digest)
            self.assertEqual(E.C.seal(issuer.paths['decision'].stat()), decision); self.assertIsNone(guard.read())

    def test_interrupted_after_proof_finishes_only_the_same_held_operation(self):
        issuer = E.Issuer(self.service)
        with self.locked() as guard:
            digest = self.authorize_fixture(guard)
            with mock.patch.object(guard, 'finish', side_effect=InterruptedError), self.assertRaises(InterruptedError):
                issuer.provision(guard, authorization_sha256=digest)
            proof = E.C.seal(issuer.paths['proof'].stat()); marker = guard.read()
            with self.assertRaises(ValueError): issuer.provision(guard, authorization_sha256='e' * 64)
            self.assertEqual(guard.read(), marker)
            issuer.provision(guard, authorization_sha256=digest)
            self.assertEqual(E.C.seal(issuer.paths['proof'].stat()), proof); self.assertIsNone(guard.read())

    def test_lost_terminal_reply_replays_read_only(self):
        issuer = E.Issuer(self.service)
        with self.locked() as guard:
            digest = self.authorize_fixture(guard); finish = guard.finish
            def stop(*args, **kwargs):
                finish(*args, **kwargs); raise InterruptedError()
            with mock.patch.object(guard, 'finish', side_effect=stop), self.assertRaises(InterruptedError):
                issuer.provision(guard, authorization_sha256=digest)
            self.assertIsNone(guard.read()); before = self.f.snapshot()
            issuer.provision(guard, authorization_sha256=digest)
            self.assertEqual(self.f.snapshot(), before)

    def test_interrupted_double_link_is_not_repaired_or_reissued(self):
        issuer = E.Issuer(self.service)
        with self.locked() as guard:
            digest = self.authorize_fixture(guard); unlink = E.os.unlink
            def stop(path, *args, **kwargs):
                if path == E.authorization_path(self.service).name: raise InterruptedError()
                return unlink(path, *args, **kwargs)
            with mock.patch.object(E.os, 'unlink', side_effect=stop), self.assertRaises(InterruptedError):
                issuer.provision(guard, authorization_sha256=digest)
            self.assertEqual(issuer.paths['decision'].stat().st_nlink, 2)
            before = self.f.snapshot(); marker = guard.read()
            with self.assertRaises(ValueError): issuer.provision(guard, authorization_sha256=digest)
            self.assertEqual(self.f.snapshot(), before); self.assertEqual(guard.read(), marker)

    def test_partial_intent_is_retained_and_blocks_replay(self):
        issuer = E.Issuer(self.service)
        with self.locked() as guard:
            digest = self.authorize_fixture(guard)
            def partial(*_):
                issuer.paths['intent'].write_bytes(b'{'); issuer.paths['intent'].chmod(0o600); raise InterruptedError()
            with mock.patch.object(issuer, '_publish', side_effect=partial), self.assertRaises(InterruptedError):
                issuer.provision(guard, authorization_sha256=digest)
            before = self.f.snapshot()
            with self.assertRaises(ValueError): issuer.provision(guard, authorization_sha256=digest)
            self.assertIsNotNone(guard.read()); self.assertEqual(self.f.snapshot(), before)

    def test_partial_proof_is_retained_and_blocks_replay(self):
        issuer = E.Issuer(self.service); publish = issuer._publish
        def partial(guard, name, value, hold):
            if name == 'proof':
                issuer.paths['proof'].write_bytes(b'{'); issuer.paths['proof'].chmod(0o600); raise InterruptedError()
            publish(guard, name, value, hold)
        with self.locked() as guard:
            digest = self.authorize_fixture(guard)
            with mock.patch.object(issuer, '_publish', side_effect=partial), self.assertRaises(InterruptedError):
                issuer.provision(guard, authorization_sha256=digest)
            before = self.f.snapshot()
            with self.assertRaises(ValueError): issuer.provision(guard, authorization_sha256=digest)
            self.assertIsNotNone(guard.read()); self.assertEqual(self.f.snapshot(), before)

    def test_controller_drift_after_hold_preserves_original_decision_and_hold(self):
        issuer = E.Issuer(self.service); publish = issuer._publish
        def change(guard, name, value, hold):
            publish(guard, name, value, hold)
            self.f.raw['State']['Pid'] += 1
        with self.locked() as guard:
            digest = self.authorize_fixture(guard)
            with mock.patch.object(issuer, '_publish', side_effect=change), self.assertRaises(ValueError):
                issuer.provision(guard, authorization_sha256=digest)
            self.assertTrue(E.authorization_path(self.service).exists()); self.assertIsNotNone(guard.read())
            self.assertFalse(issuer.paths['decision'].exists()); self.assertFalse(issuer.paths['proof'].exists())

    def test_recovery_participation_after_consumption_prevents_proof(self):
        issuer = E.Issuer(self.service); consume = issuer._consume
        def change(guard, value, hold):
            consume(guard, value, hold); self.write(self.f.state / E.C.CONFIG_NAME, {'partial': True})
        with self.locked() as guard:
            digest = self.authorize_fixture(guard)
            with mock.patch.object(issuer, '_consume', side_effect=change), self.assertRaises(ValueError):
                issuer.provision(guard, authorization_sha256=digest)
            self.assertFalse(issuer.paths['proof'].exists()); self.assertIsNotNone(guard.read())

    def test_replacing_consumed_decision_with_same_bytes_cannot_resume(self):
        issuer = E.Issuer(self.service); publish = issuer._publish
        def stop(guard, name, value, hold):
            if name == 'proof': raise InterruptedError()
            publish(guard, name, value, hold)
        with self.locked() as guard:
            digest = self.authorize_fixture(guard)
            with mock.patch.object(issuer, '_publish', side_effect=stop), self.assertRaises(InterruptedError):
                issuer.provision(guard, authorization_sha256=digest)
            alternate = self.namespace / 'fixture-copy'; alternate.write_bytes(issuer.paths['decision'].read_bytes())
            alternate.chmod(0o600); alternate.replace(issuer.paths['decision'])
            before = self.f.snapshot()
            with self.assertRaises(ValueError): issuer.provision(guard, authorization_sha256=digest)
            self.assertEqual(self.f.snapshot(), before); self.assertIsNotNone(guard.read())

    def test_completed_chain_cannot_be_rebound_to_copied_intent(self):
        issuer = E.Issuer(self.service)
        with self.locked() as guard:
            digest = self.authorize_fixture(guard); issuer.provision(guard, authorization_sha256=digest)
            alternate = self.namespace / 'fixture-copy'; alternate.write_bytes(issuer.paths['intent'].read_bytes())
            alternate.chmod(0o600); alternate.replace(issuer.paths['intent'])
            before = self.f.snapshot()
            with self.assertRaises(ValueError): issuer.provision(guard, authorization_sha256=digest)
            self.assertEqual(self.f.snapshot(), before); self.assertIsNone(guard.read())

    def test_retired_or_recreated_authorization_cannot_revive_completed_proof(self):
        issuer = E.Issuer(self.service)
        with self.locked() as guard:
            digest = self.authorize_fixture(guard); issuer.provision(guard, authorization_sha256=digest)
            self.write(issuer.paths['retired'], {'fixture': 'retired'})
            before = self.f.snapshot()
            with self.assertRaises(ValueError): issuer.provision(guard, authorization_sha256=digest)
            self.assertEqual(self.f.snapshot(), before); self.assertIsNone(guard.read())
            issuer.paths['retired'].unlink()
            self.write(E.authorization_path(self.service), json.loads(issuer.paths['decision'].read_bytes()))
            before = self.f.snapshot()
            with self.assertRaises(ValueError): issuer.provision(guard, authorization_sha256=digest)
            self.assertEqual(self.f.snapshot(), before)

    def test_unknown_existing_proof_records_veto_initial_review_and_issuance(self):
        with self.locked() as guard:
            for name in ('existing-ownership-extra.json', '.existing-ownership-intent.json.pending'):
                path = self.namespace / name; self.write(path, {'fixture': 'unknown'})
                try:
                    before = self.f.snapshot()
                    with self.assertRaises(ValueError): E.Issuer(self.service).provision(guard, authorization_sha256='e' * 64)
                    self.assertEqual(self.f.snapshot(), before); self.assertIsNone(guard.read())
                finally: path.unlink()

    def test_approval_replacement_between_review_and_consumption_stays_held(self):
        issuer = E.Issuer(self.service); publish = issuer._publish
        def change(guard, name, value, hold):
            publish(guard, name, value, hold)
            original = E.authorization_path(self.service); other = self.namespace / 'fixture-copy'
            other.write_bytes(original.read_bytes()); other.chmod(0o600); other.replace(original)
        with self.locked() as guard:
            digest = self.authorize_fixture(guard)
            with mock.patch.object(issuer, '_publish', side_effect=change), self.assertRaises(ValueError):
                issuer.provision(guard, authorization_sha256=digest)
            self.assertIsNotNone(guard.read()); self.assertFalse(issuer.paths['decision'].exists())

    def test_provision_rejects_stale_guard_without_mutation(self):
        with self.locked() as guard: digest = self.authorize_fixture(guard)
        before = self.f.snapshot()
        with self.assertRaises(ValueError): E.Issuer(self.service).provision(guard, authorization_sha256=digest)
        self.assertEqual(self.f.snapshot(), before)

    def test_interrupted_issuance_resumes_with_new_issuer_and_reacquired_real_locks(self):
        issuer = E.Issuer(self.service)
        with self.locked() as guard:
            digest = self.authorize_fixture(guard)
            with mock.patch.object(issuer, '_consume', side_effect=InterruptedError), self.assertRaises(InterruptedError):
                issuer.provision(guard, authorization_sha256=digest)
            identifier = guard.read()['operationId']
        del issuer
        with self.locked() as new_guard:
            result = E.Issuer(self.service).provision(new_guard, authorization_sha256=digest)
            self.assertEqual(result['operationId'], identifier); self.assertIsNone(new_guard.read())

    def test_other_valid_fence_cannot_be_retired_by_retained_proof(self):
        issuer = E.Issuer(self.service)
        with self.locked() as guard:
            digest = self.authorize_fixture(guard)
            with mock.patch.object(guard, 'finish', side_effect=InterruptedError), self.assertRaises(InterruptedError):
                issuer.provision(guard, authorization_sha256=digest)
            marker = guard.read(); marker['operationId'] = 'a' * 64
            self.write(guard._selected, marker); before = self.f.snapshot()
            with self.assertRaises(ValueError): issuer.provision(guard, authorization_sha256=digest)
            self.assertEqual(self.f.snapshot(), before); self.assertEqual(guard.read(), marker)

    def test_direct_proof_bind_exposure_vetoes_review_before_approval(self):
        issuer = E.Issuer(self.service)
        self.write(issuer.paths['proof'], {'fixture': 'exposed'})
        self.f.raw['Mounts'].append({'Type': 'bind', 'Source': str(issuer.paths['proof']), 'Destination': '/unsafe', 'RW': False})
        with self.locked() as guard:
            with self.assertRaises(ValueError): E._review(self.service, guard, own_records=True)
            self.assertIsNone(guard.read())

    def test_provision_cli_requires_separate_digest_and_emits_bound_receipt(self):
        f = self.f
        with self.locked() as guard: digest = self.authorize_fixture(guard)
        module = SimpleNamespace(HOST=f.host, HostService=mock.Mock(return_value=self.service))
        args = [E.__file__, 'provision', str(f.root), '--docker-context', 'local', '--snapshots', str(f.folder),
                '--authorization-sha256', digest]
        output = io.StringIO()
        with mock.patch.object(E, 'require_host'), mock.patch.object(E, 'load', return_value=module), \
                mock.patch.object(E.os.sys, 'argv', args), redirect_stdout(output):
            self.assertEqual(E.main(), 0)
        result = json.loads(output.getvalue())
        self.assertEqual(result['schema'], E.PROOF); self.assertEqual(len(result['proofSha256']), 64)
        self.assertFalse((self.namespace / E.K.STATE).exists())

    def runtime_fixture(self):
        with self.locked() as guard:
            digest = self.authorize_fixture(guard)
            E.Issuer(self.service).provision(guard, authorization_sha256=digest)
        self.service.lock = threading.Lock()
        self.runtime_peer_change = {}
        @contextmanager
        def admitted(service, connection, *, host, enrollment, guard):
            with E.RuntimeProof(service, guard) as proof:
                def verify():
                    with proof.enrollment(): pass
                def identity():
                    verify()
                    return {'installationId': proof.binding()['installationId'], 'controllerId': self.f.raw['Id'],
                        'imageId': self.f.raw['Image'], 'controllerEpoch': E.K.digest({'state':self.f.raw['State'],
                            'manifest':self.f.manifest}), **self.runtime_peer_change}
                verify()
                yield SimpleNamespace(verify=verify, identity=identity, ownership_binding=proof.binding)
        peers = SimpleNamespace(admit_existing=admitted)
        service = E.ExistingService(self.service, enrollment=self.service.current_manifest)
        return service, peers

    def runtime_request(self, runtime, peers, operation, data=None):
        return runtime.request(object(), operation, data or {}, peer_module=peers)

    def test_runtime_proof_survives_verified_version_and_data_changes_without_reapproving_history(self):
        runtime, peers = self.runtime_fixture()
        initial = self.runtime_request(runtime, peers, 'admission')
        self.f.manifest.update(tag='v9.0.1', commit='e' * 40, digest='sha256:' + 'd' * 64)
        self.f.raw['Config']['Image'] = self.f.manifest['image'] + '@' + self.f.manifest['digest']
        self.f.raw['Image'] = 'sha256:' + 'd' * 64
        self.saved.update(tag=self.f.manifest['tag'], digest=self.f.manifest['digest'])
        self.write(self.f.root / self.f.host.STATE_NAME, self.saved)
        (self.f.root / '.env').write_text('PUBLIC_FIXTURE=changed\n')
        after = self.runtime_request(runtime, peers, 'admission')
        self.assertEqual(initial['mode'], 'unmanaged'); self.assertEqual(after['mode'], 'unmanaged')
        self.assertNotEqual(initial['binding'], after['binding'])
        self.assertFalse(E.authorization_path(self.service).exists())

    def test_runtime_uses_real_kernel_for_registration_reset_and_credential_changes(self):
        runtime, peers = self.runtime_fixture()
        for i, purpose in enumerate(sorted(E.K.PURPOSES)):
            with self.subTest(purpose=purpose):
                grant = self.runtime_request(runtime, peers, 'ownership-prepare', {'requestId': str(i + 1) * 64, 'purpose':purpose})
                self.assertEqual(grant['state'], 'pending')
                args = {key:grant[key] for key in ('operationId', 'admissionBinding', 'purpose')}
                self.assertEqual(self.runtime_request(runtime, peers, 'ownership-check', args), grant)
                with self.assertRaises(ValueError): self.runtime_request(runtime, peers, 'admission')
                complete = self.runtime_request(runtime, peers, 'ownership-complete', {**args,'disposition':'committed'})
                self.assertEqual(complete['state'], 'completed')
                self.assertEqual(self.runtime_request(runtime, peers, 'ownership-complete', {**args,'disposition':'committed'}), complete)
                with self.locked() as guard: self.assertIsNone(guard.read())
        self.assertTrue((self.namespace / (E.K.STATE + '.completed.sqlite3')).exists())
        result = self.runtime_request(runtime, peers, 'change-admission')
        self.assertEqual(result['protocol'], 'root-ownership'); self.assertEqual(result['mode'], 'unmanaged')

    def test_unknown_hold_cannot_initialize_kernel_or_return_unmanaged(self):
        runtime, peers = self.runtime_fixture()
        with self.locked() as guard: guard.begin('b' * 64, 'c' * 64)
        before = self.f.snapshot()
        with self.assertRaises(ValueError): self.runtime_request(runtime, peers, 'ownership-prepare', {'requestId':'a' * 64,'purpose':'first-registration'})
        self.assertEqual(self.f.snapshot(), before); self.assertFalse((self.namespace / E.K.STATE).exists())

    def test_changed_producer_cannot_resume_earlier_pending_operation(self):
        runtime, peers = self.runtime_fixture()
        grant = self.runtime_request(runtime, peers, 'ownership-prepare', {'requestId':'a' * 64,'purpose':'first-registration'})
        self.runtime_peer_change['controllerEpoch'] = 'f' * 64
        before = self.f.snapshot()
        with self.assertRaises(ValueError): self.runtime_request(runtime, peers, 'ownership-check',
            {key:grant[key] for key in ('operationId','admissionBinding','purpose')})
        self.assertEqual(self.f.snapshot(), before)
        with self.locked() as guard: self.assertEqual(guard.read()['operationId'], grant['operationId'])

    def test_runtime_local_daemon_change_cannot_inherit_historical_proof(self):
        runtime, peers = self.runtime_fixture(); before = self.f.snapshot()
        with mock.patch.object(E, 'local_daemon', return_value='other-daemon'), self.assertRaises(ValueError):
            self.runtime_request(runtime, peers, 'admission')
        self.assertEqual(self.f.snapshot(), before)

    def test_cached_existing_service_stops_when_managed_admission_or_history_appears(self):
        runtime, peers = self.runtime_fixture()
        for path in (self.f.state / E.C.CONFIG_NAME, self.namespace / 'recovery-admission-history.json'):
            with self.subTest(path=path.name):
                self.write(path, {'partial': True}); before = self.f.snapshot()
                with self.assertRaises(ValueError): self.runtime_request(runtime, peers, 'change-admission')
                self.assertEqual(self.f.snapshot(), before); path.unlink()

    def test_runtime_refuses_torn_kernel_pending_and_orphan_completed_ledger(self):
        runtime, peers = self.runtime_fixture()
        for name in (E.K.PENDING, E.K.STATE + '.completed.sqlite3'):
            with self.subTest(name=name):
                path = self.namespace / name; path.write_bytes(b'partial'); path.chmod(0o600)
                before = self.f.snapshot()
                with self.assertRaises(ValueError): self.runtime_request(runtime, peers, 'admission')
                self.assertEqual(self.f.snapshot(), before); path.unlink()

    def test_runtime_scope_is_request_bound_and_never_constructed_from_caller_mode(self):
        runtime, peers = self.runtime_fixture()
        with self.assertRaises(ValueError), runtime.scope(): pass
        with self.assertRaises(ValueError): self.runtime_request(runtime, peers, 'admission', {'mode':'unmanaged'})
        with self.assertRaises(ValueError): self.runtime_request(runtime, peers, 'counter-challenge',
            {'admissionBinding':'b' * 64, 'purpose':'login', 'ceremonyBinding':'c' * 64})
        admission = self.runtime_request(runtime, peers, 'admission')
        self.assertEqual(self.runtime_request(runtime, peers, 'counter-challenge',
            {'admissionBinding':admission['binding'], 'purpose':'login', 'ceremonyBinding':'c' * 64})['mode'], 'unmanaged')

    def test_runtime_retired_proof_and_replaced_layout_cannot_be_reactivated(self):
        runtime, peers = self.runtime_fixture()
        self.write(E.record_paths(self.service)['retired'], {'fixture':'retired'})
        before = self.f.snapshot()
        with self.assertRaises(ValueError): self.runtime_request(runtime, peers, 'admission')
        self.assertEqual(self.f.snapshot(), before)

        E.record_paths(self.service)['retired'].unlink()
        other = self.namespace / 'fixture-copy'; other.write_bytes((self.namespace / 'layout.json').read_bytes())
        other.chmod(0o600); other.replace(self.namespace / 'layout.json'); before = self.f.snapshot()
        with self.assertRaises(ValueError): self.runtime_request(runtime, peers, 'admission')
        self.assertEqual(self.f.snapshot(), before)

    def test_runtime_recovers_exact_completed_receipt_ahead_of_json_without_repeating_writes(self):
        runtime, peers = self.runtime_fixture()
        grant = self.runtime_request(runtime, peers, 'ownership-prepare', {'requestId':'a' * 64,'purpose':'account-removal'})
        args = {key:grant[key] for key in ('operationId','admissionBinding','purpose')}
        write = runtime.authority._write
        def stop(guard, before, after):
            if grant['operationId'] in before['operations'] and grant['operationId'] not in after['operations']:
                raise InterruptedError()
            return write(guard,before,after)
        with mock.patch.object(runtime.authority, '_write', side_effect=stop), self.assertRaises(ValueError):
            self.runtime_request(runtime, peers, 'ownership-complete', {**args,'disposition':'committed'})
        self.assertTrue((self.namespace / (E.K.STATE + '.completed.sqlite3')).exists())
        with self.locked() as guard: self.assertEqual(guard.read()['operationId'], grant['operationId'])
        result = self.runtime_request(runtime, peers, 'ownership-complete', {**args,'disposition':'committed'})
        self.assertEqual(result['state'],'completed')
        with self.locked() as guard: self.assertIsNone(guard.read())

    def test_retirement_reference_is_stable_and_tombstone_blocks_cached_runtime(self):
        runtime, peers = self.runtime_fixture()
        reference = E.retirement_reference(self.service)
        with self.locked() as guard:
            guard.begin('a' * 64, 'b' * 64)
            E.retire_for_admission(self.service, guard, reference, plan_sha256='c' * 64, authorization_sha256='d' * 64)
            self.assertEqual(E.retirement_reference(self.service),reference)
            before = self.f.snapshot()
            E.retire_for_admission(self.service, guard, reference, plan_sha256='c' * 64, authorization_sha256='d' * 64)
            self.assertEqual(self.f.snapshot(),before)
            self.assertEqual(guard.read()['operationId'],'a' * 64)
        with self.assertRaises(ValueError): self.runtime_request(runtime, peers, 'admission')
        with self.locked() as guard:
            with self.assertRaises(ValueError): E.Issuer(self.service).provision(guard,
                authorization_sha256=hashlib.sha256(E.record_paths(self.service)['decision'].read_bytes()).hexdigest())

    def test_retirement_requires_live_hold_and_exact_reviewed_proof_without_rewriting_it(self):
        self.runtime_fixture(); reference = E.retirement_reference(self.service)
        with self.locked() as guard:
            before = self.f.snapshot()
            with self.assertRaises(ValueError): E.retire_for_admission(self.service,guard,reference,
                plan_sha256='c' * 64,authorization_sha256='d' * 64)
            self.assertEqual(self.f.snapshot(),before)
            guard.begin('a' * 64,'b' * 64); changed = copy.deepcopy(reference); changed['proof']['sha256'] = 'e' * 64
            before = self.f.snapshot()
            with self.assertRaises(ValueError): E.retire_for_admission(self.service,guard,changed,
                plan_sha256='c' * 64,authorization_sha256='d' * 64)
            self.assertEqual(self.f.snapshot(),before)

    def test_partial_retirement_is_preserved_and_cannot_restore_runtime_or_admission_review(self):
        runtime, peers = self.runtime_fixture(); reference = E.retirement_reference(self.service)
        path = E.record_paths(self.service)['retired']
        path.write_bytes(b'{'); path.chmod(0o600)
        before = self.f.snapshot()
        with self.assertRaises(ValueError): E.retirement_reference(self.service)
        with self.assertRaises(ValueError): self.runtime_request(runtime,peers,'admission')
        self.assertEqual(self.f.snapshot(),before)

    def test_host_factory_routes_existing_proof_and_never_falls_back_from_partial_or_managed_records(self):
        runtime, peers = self.runtime_fixture()
        module = fixture.load('orbis-host-service.py','existing_factory_service')
        def instance():
            service = module.HostService.__new__(module.HostService)
            service.__dict__.update(vars(self.service)); service.credential_factory_lock = threading.Lock()
            service.credential_service = None
            return service
        def load(name,key):
            return {'orbis-host-existing-ownership.py':E,'orbis-host-credential-service.py':E.C,
                    'orbis-host-credential-peer.py':peers,'orbis-host-ownership-bootstrap.py':E.B}[name]
        with mock.patch.object(module,'load_script',side_effect=load) as loads:
            service = instance()
            self.assertEqual(service.credential_request(object(),'admission',{})['mode'],'unmanaged')
            self.assertIsInstance(service.credential_service,E.ExistingService)
            self.assertNotIn('orbis-host-ownership-bootstrap.py',[c.args[0] for c in loads.call_args_list])
            E.record_paths(self.service)['proof'].write_bytes(b'{'); before = self.f.snapshot(); loads.reset_mock()
            with self.assertRaises(ValueError): instance().credential_request(object(),'admission',{})
            self.assertEqual(self.f.snapshot(),before)
            self.assertNotIn('orbis-host-ownership-bootstrap.py',[c.args[0] for c in loads.call_args_list])
            self.write(self.f.state / E.C.CONFIG_NAME,{}); loads.reset_mock()
            with self.assertRaises(ValueError): instance().credential_request(object(),'admission',{})
            self.assertNotIn('orbis-host-existing-ownership.py',[c.args[0] for c in loads.call_args_list])

    def test_existing_runtime_joins_actual_peer_process_checks_with_protected_data_scope(self):
        import test_orbis_host_credential_peer as peer_fixture
        p = peer_fixture.PeerTests('test_descendant_in_exact_controller_namespaces_and_cgroup_is_bound')
        self.addCleanup(p.doCleanups); p.setUp()
        self.f.raw['Id'], self.f.raw['Image'], self.f.raw['State']['Pid'] = peer_fixture.CID, peer_fixture.IMAGE, 100
        self.f.host.CAPTURE_READ_DEADLINE = peer_fixture.ContextVar('existing_peer_deadline',default=None)
        p.service, p.container, p.daemon = self.service, self.f.raw, 'daemon-fixture'
        self.f.root.chmod(0o775)
        self.runtime_fixture()
        runtime = E.ExistingService(self.service,enrollment=self.service.current_manifest)
        with mock.patch.object(peer_fixture.PEER,'_existing_module',return_value=E), \
                mock.patch.object(peer_fixture.PEER,'_enrollment_file',side_effect=AssertionError('Private data-root fallback forbidden')):
            result = runtime.request(p.connection,'ownership-prepare',{'requestId':'a' * 64,'purpose':'first-registration'},
                                     peer_module=peer_fixture.PEER)
            self.assertEqual(result['state'],'pending')
            p.write_proc(101,cgroup='0::/system.slice/docker-' + 'f' * 64 + '.scope\n')
            before = self.f.snapshot()
            with self.assertRaises(ValueError): runtime.request(p.connection,'ownership-check',
                {k:result[k] for k in ('operationId','admissionBinding','purpose')},peer_module=peer_fixture.PEER)
            self.assertEqual(self.f.snapshot(),before)

    def test_actual_host_guard_factory_wrapper_is_bound_by_its_live_lock_and_authority(self):
        module = fixture.load('orbis-host.py','existing_actual_host_guard')
        host = self.f.host
        with mock.patch.object(module,'AUTHORITY',host.AUTHORITY), \
                mock.patch.object(module,'CREDENTIAL_FENCE',host.CREDENTIAL_FENCE), \
                mock.patch.object(module,'LOCK_DESCRIPTOR',host.LOCK_DESCRIPTOR), \
                mock.patch.object(module,'_require_no_capture_restore_fence',host._require_no_capture_restore_fence):
            with module.credential_fence_lock(self.f.root,'local') as guard:
                self.assertIsNot(guard._host,host)
                self.assertIs(guard._host.LOCK_DESCRIPTOR,host.LOCK_DESCRIPTOR)
                self.assertIs(guard._host.AUTHORITY,host.AUTHORITY)
                digest = self.authorize_fixture(guard)
                E.Issuer(self.service).provision(guard,authorization_sha256=digest)
                with E.RuntimeProof(self.service,guard) as proof:
                    with proof.enrollment() as (saved,identity):
                        self.assertEqual(saved,self.saved)
                        self.assertEqual(list(identity),proof.chain.plan['rootIdentity'])
                reference = E.retirement_reference(self.service)
                guard.begin('a' * 64,'b' * 64)
                E.retire_for_admission(self.service,guard,reference,plan_sha256='c' * 64,authorization_sha256='d' * 64)

    def test_different_host_authority_or_lock_context_cannot_impersonate_a_live_guard(self):
        with self.locked() as guard:
            original = guard._host
            for key in ('LOCK_DESCRIPTOR','AUTHORITY','CREDENTIAL_FENCE'):
                with self.subTest(key=key):
                    other = SimpleNamespace(**vars(original)); setattr(other,key,object())
                    guard._host = other
                    try:
                        before = self.f.snapshot()
                        with self.assertRaises(ValueError): E.require_guard(self.service,guard)
                        self.assertEqual(self.f.snapshot(),before)
                    finally: guard._host = original


if __name__ == '__main__': unittest.main()
