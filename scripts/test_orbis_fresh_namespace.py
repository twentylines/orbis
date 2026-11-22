import copy
from contextvars import ContextVar
from contextlib import ExitStack, contextmanager
import hashlib
import os
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
import threading
from unittest import mock

import test_orbis_fresh_forward as forward
import test_orbis_fresh_rollback as rollback
import test_orbis_host_legacy_ownership as legacy

M, TX = forward.M, forward.fixtures.TX


class FreshNamespaceTests(unittest.TestCase):
    """Actual Fresh chains/layout/locks, explicit Docker/SQL/filesystem ports.

    UID1000 is observed metadata for the data directories, not an actual chown.
    Temporary layout decisions and portable restore copies are not native Root
    approval, Linux restore semantics or installed acceptance.
    """
    def setUp(self):
        self.flow = forward.FreshForwardTests('test_complete_verifies_live_outcome_then_retires_exact_fence_and_preserves_new_data')
        self.addCleanup(self.flow.doCleanups); self.flow.setUp()
        self.c = self.flow.c
        self.adopt(self.c)

    def adopt(self, c):
        old = c.root
        home = c.f.folder / 'home'; home.mkdir(mode=0o775); home.chmod(0o775)
        root = home / 'server'; old.rename(root)
        c.root = c.f.root = c.b.root = c.issuer.root = root
        for path in (root, root / 'state', root / 'cache', root / 'user-config'): path.chmod(0o775)
        for name in ('docker-compose.yml', '.env', 'VERSION'): (root / name).chmod(0o664)
        for raw in c.raws.values():
            labels = raw['Config'].get('Labels', {})
            if labels.get('com.docker.compose.project.working_dir') == str(old):
                labels['com.docker.compose.project.working_dir'] = str(root)
            for mount in raw['Mounts']:
                if Path(mount['Source']).is_relative_to(old):
                    mount['Source'] = str(root / Path(mount['Source']).relative_to(old))
        # Keep actual Root control storage outside the simulated user home.
        identities = {(path.stat().st_dev, path.stat().st_ino) for path in
                      (home, root, root / 'state', root / 'cache', root / 'user-config')}
        c.observed_data_owners = identities
        def changed(info):
            if (info.st_dev, info.st_ino) not in identities: return info
            return SimpleNamespace(**{name: (1000 if name == 'st_uid' else getattr(info, name))
                                      for name in dir(info) if name.startswith('st_')})
        original_stat, original_lstat, original_fstat = os.stat, os.lstat, os.fstat
        for change in (mock.patch.object(os, 'stat', side_effect=lambda *a, **k: changed(original_stat(*a, **k))),
                       mock.patch.object(os, 'lstat', side_effect=lambda *a, **k: changed(original_lstat(*a, **k))),
                       mock.patch.object(os, 'fstat', side_effect=lambda *a, **k: changed(original_fstat(*a, **k)))):
            change.start(); self.addCleanup(change.stop)
        layout = legacy.load('orbis-host-layout.py', 'fresh_namespace_actual_layout')
        c.f.layout = c.host.AUTHORITY.LAYOUT = layout
        mountinfo = c.f.folder / 'mountinfo'
        mountinfo.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n')
        read = layout.read
        for change in (mock.patch.object(layout, 'STATE_ROOT', c.f.state), mock.patch.object(layout, '_operator'),
                       mock.patch.object(layout, 'read', side_effect=lambda root, daemon=None, context=None, mountinfo_arg=None:
                           read(root, daemon, context, mountinfo_arg or mountinfo))):
            change.start(); self.addCleanup(change.stop)
        plan = layout.review(root, 'daemon-fixture', 'local', mountinfo)
        layout.prepare(root, 'daemon-fixture', 'local', layout.plan_sha256(plan), mountinfo)
        def decision(plan=None):
            plan = plan or M.L.review(c.host, root, c.reader, c.f.manifest)
            path = M.L.authorization_path(root, c.host, c.reader)
            value = {'schema': M.L.AUTHORIZATION, 'policy': M.L.POLICY, 'planSha256': M.L.K.digest(plan), 'approvalId': 'e' * 64}
            path.write_bytes(M.L.K.canonical(value) + b'\n'); path.chmod(0o600)
            return path, value
        c.f.authorization_fixture = decision
        c.namespace = layout.namespace(root)

    def path(self, identifier, phase=None):
        c = self.c
        return M.phase_path(c.root, identifier, phase, c.host) if phase else M.claim_path(c.root, identifier, c.host)

    def test_complete_and_restart_proof_use_only_exact_protected_namespace(self):
        c = self.c
        with self.flow.ready() as (guard, permit):
            self.flow.finished(permit)
            selected = permit.reference
            self.assertIsNotNone(guard.read())
            result = permit.complete(c.record)
            self.assertIsNone(guard.read())
            birth = M.L.B.receipt_path(c.root, c.host)
            value = M.L.C.json_body(birth.read_bytes())
            self.assertEqual(value['custody'], M.L.B.custody(c.host, c.root))
            self.assertEqual(value['rootIdentity'][2], 1000)
            reference = {'schema': M.L.B.SCHEMA, 'path': str(birth), 'sha256': hashlib.sha256(birth.read_bytes()).hexdigest()}
            self.assertEqual(M.L.B.verify_reference(c.host, c.root, 'local', value['daemonSha256'], reference), value)
            for path in (self.path(selected['operationId']), birth, self.path(selected['operationId'], 'complete')):
                self.assertEqual(path.parent, c.namespace)
                self.assertEqual(path.stat().st_uid, os.geteuid()); self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertFalse(M.claim_path(c.root, selected['operationId']).exists())
            self.assertFalse(M.L.B.receipt_path(c.root).exists())
        before = c.f.snapshot()
        with c.b.guarded() as guard, c.issuer.resume_completed(guard, c.record, selected) as reopened:
            self.assertEqual(reopened.complete(c.record), result)
            service = SimpleNamespace(HOST=c.host, root=c.root, context='local', state_dir=c.f.state,
                                      require_credential_idle=lambda guard: guard.read())
            observations = M.L.E
            with mock.patch.object(M.L.B, '_observations', return_value=observations), \
                    mock.patch.object(observations.K, 'OWNER', os.geteuid()):
                runtime = M.L.B.BirthRuntime(service, guard)
                try: runtime.verify()
                finally: runtime.close()
            self.assertIsNone(guard.read())
        self.assertEqual(c.f.snapshot(), before); self.assertEqual(c.sql_calls, 1)

    def test_begin_and_stopped_resume_retain_single_consumed_decision(self):
        c = self.c
        with c.b.guarded() as guard:
            value = c.reviewed()
            with c.issuer.begin(guard, value, TX) as permit: selected = permit.reference
            self.assertFalse(M.L.authorization_path(c.root, c.host, c.reader).exists())
            approval = M.consumed_path(c.root, selected['operationId'], c.host)
            self.assertEqual(approval.parent, c.namespace); self.assertEqual(approval.stat().st_nlink, 1)
        c.b.stop_original('/orbis-previous-' + TX)
        with c.b.guarded() as guard, c.issuer.resume(guard, value, TX, selected, original_state='stopped') as permit:
            self.assertEqual(permit.reference, selected); self.assertEqual(permit.guard._directory.path, c.namespace)
            self.assertEqual(len(guard._descriptors), 2)

    def test_restart_birth_service_joins_current_peer_and_real_account_kernel(self):
        import test_orbis_host_credential_peer as peers
        c = self.c
        with self.flow.ready() as (guard, permit):
            self.flow.finished(permit); permit.complete(c.record)
        peer = peers.PeerTests('test_descendant_in_exact_controller_namespaces_and_cgroup_is_bound')
        self.addCleanup(peer.doCleanups); peer.setUp()
        raw = c.raws['9' * 64]
        raw.update(RestartCount=0, Path='node', Args=[])
        raw['State'].update(Pid=100, Running=True, Paused=False, Restarting=False, Dead=False,
                            StartedAt='2026-01-01T00:00:00Z')
        c.host.PLAN.validate_manifest = legacy.P.validate_manifest
        c.host.saved_state = lambda root: json.loads((root / c.host.STATE_NAME).read_bytes())
        c.host.CAPTURE_READ_DEADLINE = ContextVar('fresh-birth-peer-deadline', default=None)
        c.host.credential_fence_lock = lambda root, context: legacy.F.locked(c.host, root, context)
        c.host.docker = lambda context, args, root: SimpleNamespace(returncode=0,
            stdout=json.dumps('daemon-fixture' if args[0] == 'info' else raw))
        service = SimpleNamespace(HOST=c.host, root=c.root, context='local', state_dir=c.f.state,
            require_credential_idle=lambda guard: guard.read(), lock=threading.Lock(),
            current_manifest=lambda: copy.deepcopy(c.f.manifest),
            controller_capture_identity=lambda identifier, image, saved: {'id': identifier, 'imageId': image,
                'imageReference': c.f.manifest['image'] + '@' + c.f.manifest['digest'],
                'releaseTag': c.f.manifest['tag'], 'releaseDigest': c.f.manifest['digest'],
                'startedAt': raw['State']['StartedAt']})
        peer.service, peer.container, peer.daemon = service, raw, 'daemon-fixture'
        for pid in (100, 101): peer.write_proc(pid, cgroup='0::/system.slice/docker-' + raw['Id'] + '.scope\n')
        observations = M.L.E
        with mock.patch.object(peers.PEER, '_bootstrap_module', return_value=M.L.B), \
                mock.patch.object(M.L.B, '_observations', return_value=observations), \
                mock.patch.object(observations.K, 'OWNER', os.geteuid()), \
                mock.patch.object(observations, 'local_daemon', return_value='daemon-fixture'):
            issuer = M.L.B.BootstrapService(service, enrollment=service.current_manifest)
            self.addCleanup(issuer.close)
            result = issuer.request(peer.connection, 'ownership-prepare', {'requestId': 'a' * 64, 'purpose': 'first-registration'}, peer_module=peers.PEER)
            self.assertEqual(result['state'], 'pending')
            args = {key: result[key] for key in ('operationId', 'admissionBinding', 'purpose')}
            self.assertEqual(issuer.request(peer.connection, 'ownership-check', args, peer_module=peers.PEER), result)
            self.assertEqual(issuer.request(peer.connection, 'ownership-complete', {**args, 'disposition': 'committed'}, peer_module=peers.PEER)['state'], 'completed')
            peer.write_proc(101, cgroup='0::/system.slice/other.scope\n')
            with self.assertRaises(ValueError): issuer.request(peer.connection, 'admission', {}, peer_module=peers.PEER)

    def test_interrupted_consumption_keeps_hold_and_two_names_never_authorize(self):
        c = self.c
        with c.b.guarded() as guard:
            value = c.reviewed()
            unlink = os.unlink
            def interrupted(name, *args, **kwargs):
                if name == 'legacy-ownership-authorization.json': raise OSError('fixture interrupted consume')
                return unlink(name, *args, **kwargs)
            with mock.patch.object(os, 'unlink', side_effect=interrupted):
                with self.assertRaises(OSError), c.issuer.begin(guard, value, TX): pass
            selected = c.b.selected(guard, value); before = c.f.snapshot()
            with self.assertRaises(ValueError), c.issuer.resume(guard, value, TX, selected, original_state='running'): pass
            with self.assertRaises(ValueError), c.issuer.begin(guard, value, TX): pass
            self.assertEqual(c.f.snapshot(), before); self.assertIsNotNone(guard.read())

    def test_orphan_other_transaction_is_not_an_own_record_exception(self):
        c = self.c
        with c.b.guarded() as guard:
            value = c.reviewed()
            with c.issuer.begin(guard, value, TX) as permit:
                other = M.claim_path(c.root, 'f' * 64, c.host); other.write_bytes(b'partial')
                before = c.f.snapshot()
                with self.assertRaises(ValueError): permit.check(value, TX, original_state='running')
                self.assertEqual(c.f.snapshot(), before); self.assertIsNotNone(guard.read())

    def test_changed_layout_receipt_cannot_rebind_live_or_reopened_claim(self):
        c = self.c
        with c.b.guarded() as guard:
            value = c.reviewed()
            with c.issuer.begin(guard, value, TX) as permit:
                selected = permit.reference; path = c.namespace / 'layout.json'; body = path.read_bytes()
                path.write_bytes(body)
                with self.assertRaises(ValueError): permit.check(value, TX, original_state='running')
            with self.assertRaises(ValueError), c.issuer.resume(guard, value, TX, selected, original_state='running'): pass
            self.assertIsNotNone(guard.read())

    def test_partial_birth_publication_cannot_advance_or_reissue(self):
        c = self.c
        with c.prepared() as (guard, permit):
            c.reset_ready(permit)
            with mock.patch.object(c.r.FRESH.subprocess, 'run', side_effect=c.sql): permit.reset_accounts(c.record)
            pending = M.L.B.pending_path(c.root, c.host); pending.write_bytes(b'partial'); pending.chmod(0o600)
            before = c.f.snapshot()
            with self.assertRaises(ValueError): permit.publish_birth(c.record)
            self.assertEqual(c.f.snapshot(), before); self.assertIsNotNone(guard.read()); self.assertEqual(c.sql_calls, 1)

    def test_public_or_aliased_claim_and_forged_custody_are_rejected(self):
        c = self.c
        with c.b.guarded() as guard:
            value = c.reviewed()
            with c.issuer.begin(guard, value, TX) as permit: selected = permit.reference
            path = self.path(selected['operationId']); body = path.read_bytes()
            path.chmod(0o644)
            with self.assertRaises(ValueError), c.issuer.resume(guard, value, TX, selected, original_state='running'): pass
            path.chmod(0o600)
            forged = M.L.C.json_body(body); forged['legacy'].pop('custody')
            forged['admissionBinding'] = c.issuer._binding(forged)
            path.write_bytes(M.L.K.canonical(forged) + b'\n')
            selected['admissionBinding'] = forged['admissionBinding']
            with self.assertRaises(ValueError), c.issuer.resume(guard, value, TX, selected, original_state='running'): pass
            self.assertIsNotNone(guard.read())


class FreshNamespaceRollbackTests(unittest.TestCase):
    def setUp(self):
        self.flow = rollback.FreshRollbackTests('test_real_root_checkpoint_restores_rotated_environment_without_identity_exception')
        self.addCleanup(self.flow.doCleanups); self.flow.setUp()
        self.c = self.flow.c
        FreshNamespaceTests.adopt(self, self.c)
        actual = self.flow.copy_directory
        def copied_owners(source, target):
            # The portable copier cannot chown. Carry the same declared UID
            # observation onto copied directory inodes before fingerprinting.
            for path in (source, *source.rglob('*')):
                info = path.stat()
                if (info.st_dev, info.st_ino) in self.c.observed_data_owners:
                    copied = (target / path.relative_to(source)).stat()
                    self.c.observed_data_owners.add((copied.st_dev, copied.st_ino))
        def preserving_owner_port(source, target):
            actual(source, target)
            copied_owners(source, target)
        self.flow.copy_directory = preserving_owner_port
        run = self.c.r.TX.STORAGE.SNAPSHOT.subprocess.run
        def captured(args, **kwargs):
            result = run(args, **kwargs)
            if args[:2] == ['cp', '-a'] and result.returncode == 0:
                copied_owners(Path(args[-2]), Path(args[-1]))
            return result
        change = mock.patch.object(self.c.r.TX.STORAGE.SNAPSHOT.subprocess, 'run', side_effect=captured)
        change.start(); self.addCleanup(change.stop)
        chown = os.chown
        def observed_chown(path, uid, gid, **kwargs):
            info = Path(path).stat()
            if uid == 1000 and (info.st_dev, info.st_ino) in self.c.observed_data_owners:
                self.assertTrue(Path(path).is_relative_to(self.c.root)); self.assertEqual(gid, info.st_gid)
                return None
            return chown(path, uid, gid, **kwargs)
        change = mock.patch.object(os, 'chown', side_effect=observed_chown)
        change.start(); self.addCleanup(change.stop)

    def test_rotated_data_restore_retires_namespace_birth_before_original_start_and_replays(self):
        c = self.c
        with self.flow.ready(reset=True, birth=True) as (guard, permit):
            selected = permit.reference
            result = permit.rollback(c.record)
            self.assertIsNone(guard.read())
            self.assertFalse(M.L.B.receipt_path(c.root, c.host).exists())
            self.assertTrue(M.L.B.retired_path(c.root, c.host).exists())
            self.assertEqual(c.f.raw['State']['Status'], 'running')
            copied = self.flow.copy_calls
        with c.b.guarded() as guard, c.issuer.resume_rollback(guard, c.record, selected) as permit:
            self.assertEqual(permit.rollback(c.record), result); self.assertIsNone(guard.read())
        self.assertEqual(self.flow.copy_calls, copied)

    def test_interrupted_original_start_resumes_from_restored_receipt_without_copying_again(self):
        c = self.c
        with self.flow.ready(reset=True, birth=True) as (guard, permit):
            selected = permit.reference; self.flow.interrupt_start = True
            with self.assertRaises(OSError): permit.rollback(c.record)
            copied = self.flow.copy_calls
            self.assertTrue(M.phase_path(c.root, selected['operationId'], 'restored', c.host).exists())
            self.assertIsNotNone(guard.read())
        with c.b.guarded() as guard, c.issuer.resume_rollback(guard, c.record, selected) as permit:
            permit.rollback(c.record); self.assertIsNone(guard.read())
        self.assertEqual(self.flow.copy_calls, copied)


class NewNamespaceBirthTests(unittest.TestCase):
    def setUp(self):
        self.f = legacy.AdoptedLegacyOwnershipTests('test_real_layout_user_owned_data_and_dual_lock_review_has_no_writes_or_grants')
        self.addCleanup(self.f.doCleanups); self.f.setUp()
        self.root, self.host, self.reader = self.f.f.root, self.f.f.host, self.f.f.reader
        for path in self.root.iterdir():
            if path.is_dir(): path.rmdir()
            else: path.unlink()
        self.reader.containers.return_value = []
        owners = self.f.data_owner(); owners.__enter__(); self.addCleanup(owners.__exit__, None, None, None)
        self.f.adopt()

    def prepare(self):
        return legacy.L.B.prepare_new(self.host, self.root, self.reader, self.f.f.manifest)

    def test_installer_storage_and_pointer_selection_are_bound_and_read_only(self):
        before = self.f.f.snapshot()
        selected = legacy.L.B.installer_storage(self.host, self.root, 'local')
        self.assertEqual(selected, {'schema': legacy.L.B.INSTALLER_STORAGE_PROTOCOL,
                                    'custody': legacy.L.B.custody(self.host, self.root, context='local')})
        self.assertEqual(legacy.L.B.verify_installer_storage(self.host, self.root, selected, 'local'), selected)
        self.assertEqual(legacy.L.B.installer_pointer_path(self.host, self.root, 'local'), self.f.namespace / 'installer-pointer.json')
        self.assertEqual(self.f.f.snapshot(), before)
        with self.assertRaises(ValueError): legacy.L.B.verify_installer_storage(self.host, self.root, None, 'local')
        with self.assertRaises(ValueError): legacy.L.B.installer_pointer_path(self.host, self.root, 'foreign')

    def test_installer_reference_rejects_same_content_layout_replacement(self):
        selected = legacy.L.B.installer_storage(self.host, self.root, 'local')
        path = self.f.namespace / 'layout.json'
        replacement = self.f.namespace / 'layout-replacement.json'
        replacement.write_bytes(path.read_bytes()); replacement.chmod(0o600)
        os.replace(replacement, path)
        with self.assertRaises(ValueError): legacy.L.B.verify_installer_storage(self.host, self.root, selected, 'local')
        self.assertFalse((self.f.namespace / 'installer-pointer.json').exists())

    def test_installer_reference_requires_exact_json_types_and_fields(self):
        selected = legacy.L.B.installer_storage(self.host, self.root, 'local')
        changed = json.loads(json.dumps(selected))
        changed['custody']['namespaceIdentity'][0] = float(changed['custody']['namespaceIdentity'][0])
        self.assertEqual(changed, selected)
        with self.assertRaises(ValueError): legacy.L.B.verify_installer_storage(self.host, self.root, changed, 'local')
        changed = {**selected, 'additional': True}
        with self.assertRaises(ValueError): legacy.L.B.verify_installer_storage(self.host, self.root, changed, 'local')

    def test_partial_layout_cannot_select_a_legacy_installer_pointer(self):
        (self.f.namespace / 'layout.json').unlink()
        with self.assertRaises(ValueError): legacy.L.B.installer_pointer_path(self.host, self.root, 'local')
        self.assertFalse((self.root / '.orbis-installation.json').exists())

    def test_legacy_installer_marker_conflict_is_preserved_for_review(self):
        marker = self.root / '.orbis-installation.json'
        marker.write_bytes(b'legacy installer custody')
        before = self.f.f.snapshot()
        with self.assertRaises(ValueError): legacy.L.B.installer_pointer_path(self.host, self.root, 'local')
        self.assertEqual(self.f.f.snapshot(), before)

    def test_read_only_pointer_lookup_does_not_invalidate_empty_birth_issuance(self):
        with self.f.locked():
            self.assertFalse(legacy.L.B.installer_pointer_path(self.host, self.root, 'local').exists())
            self.assertIsInstance(self.prepare(), dict)

    def test_empty_birth_does_not_erase_a_legacy_proxy_identity_history(self):
        for suffix in ('.orbis-proxy-identity', '.orbis-proxy-identity.json'):
            marker = self.root.parent / ('.' + self.root.name + suffix)
            marker.write_bytes(b'prior proxy custody')
            try:
                with self.subTest(suffix=suffix), self.f.locked():
                    before = self.f.f.snapshot()
                    with self.assertRaises(ValueError): self.prepare()
                    self.assertEqual(self.f.f.snapshot(), before)
            finally:
                marker.unlink()

    def test_empty_user_parent_installation_publishes_only_private_namespace_birth(self):
        with self.f.locked():
            selected = self.prepare()
            path = legacy.L.B.receipt_path(self.root, self.host)
            self.assertEqual(path.parent, self.f.namespace)
            self.assertEqual(path.stat().st_uid, os.geteuid()); self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            body = legacy.L.B.verify_reference(self.host, self.root, 'local', hashlib.sha256(b'daemon-fixture').hexdigest(), selected)
            self.assertEqual(body['rootIdentity'][2], 1000)
            self.assertEqual(body['custody'], legacy.L.B.custody(self.host, self.root))
            self.assertEqual(list(self.root.iterdir()), [])
            self.assertFalse(legacy.L.B.receipt_path(self.root).exists())
            before = self.f.f.snapshot()
            with self.assertRaises(ValueError): self.prepare()
            self.assertEqual(self.f.f.snapshot(), before)

    def test_empty_data_never_erases_existing_namespace_history_or_other_contents(self):
        with self.f.locked():
            for name in ('main-ownership-authority.json', '.orbis-fresh-ownership-partial', 'proxy-config', 'unrecognized'):
                path = self.f.namespace / name; path.write_bytes(b'prior fixture custody')
                try:
                    before = self.f.f.snapshot()
                    with self.subTest(name=name), self.assertRaises(ValueError): self.prepare()
                    self.assertEqual(self.f.f.snapshot(), before)
                finally: path.unlink()
            marker = self.root / 'old-data'; marker.write_bytes(b'existing')
            with self.assertRaises(ValueError): self.prepare()
            self.assertFalse(legacy.L.B.receipt_path(self.root, self.host).exists())

    def test_interrupted_pending_birth_cannot_be_reissued_or_admitted(self):
        with self.f.locked():
            with mock.patch.object(os, 'link', side_effect=OSError('fixture interrupted birth publication')):
                with self.assertRaises(OSError): self.prepare()
            self.assertTrue(legacy.L.B.pending_path(self.root, self.host).exists())
            before = self.f.f.snapshot()
            with self.assertRaises(ValueError): self.prepare()
            self.assertEqual(self.f.f.snapshot(), before)
            self.assertFalse(legacy.L.B.receipt_path(self.root, self.host).exists())

    def test_namespace_birth_requires_recorded_custody_even_with_recomputed_body_hash(self):
        with self.f.locked():
            selected = self.prepare(); path = Path(selected['path'])
            body = legacy.L.C.json_body(path.read_bytes()); body.pop('custody')
            path.write_bytes(legacy.L.K.canonical(body) + b'\n')
            selected['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
            with self.assertRaises(ValueError):
                legacy.L.B.verify_reference(self.host, self.root, 'local', body['daemonSha256'], selected)


if __name__ == '__main__':
    unittest.main()
