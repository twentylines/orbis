import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import threading
import unittest
from contextlib import contextmanager
from contextvars import ContextVar
from types import SimpleNamespace
from unittest.mock import Mock, patch


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


B = load('orbis-host-ownership-bootstrap.py', 'ownership_bootstrap_target')
F = load('orbis-host-credential-fence.py', 'ownership_bootstrap_fence')


class BootstrapTests(unittest.TestCase):
    """Actual private files, journal and lifecycle fence; explicit peer/Docker ports.

    Linux SO_PEERCRED/process/image verification has its separate peer suite.
    No native controller or actual Root authority is created by these fixtures.
    """
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='orbis-birth-')
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name).resolve()
        self.root, self.state = self.folder / 'server', self.folder / 'service-state'
        self.root.mkdir(mode=0o700)
        self.state.mkdir(mode=0o700)
        for module in (B, B.C, B.K, F):
            changed = patch.object(module, 'OWNER', os.geteuid())
            changed.start(); self.addCleanup(changed.stop)
        for name, value in [('RECOVERY', self.folder / 'recovery'), ('RECOVERY_ENV', self.folder / 'recovery.env')]:
            changed = patch.object(B, name, value); changed.start(); self.addCleanup(changed.stop)

        def legacy(root, purpose):
            suffix = {'host-lock': 'host.lock', 'credential-fence': 'credential-fence.json',
                      'retained-authority': 'retained-authority', 'capture-fence': 'capture-fence.json',
                      'restore-selector': 'retained-restore.json'}[purpose]
            return root.parent / ('.' + root.name + '.orbis-' + suffix)

        def identity(details):
            if (not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid()
                    or details.st_nlink != 1 or stat.S_IMODE(details.st_mode) != 0o600):
                raise ValueError('unsafe fixture lock')
            return tuple(getattr(details, key) for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode'))

        def opened(root):
            fd = os.open(legacy(root, 'host-lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                identity(os.fstat(fd))
                return [fd]
            except BaseException:
                os.close(fd); raise

        self.layout = SimpleNamespace(
            STATE_ROOT=self.state, legacy_path=legacy,
            namespace=lambda root: self.state / 'installations' / hashlib.sha256(os.fsencode(root)).hexdigest(),
            selected_path=lambda root, purpose: legacy(root, purpose),
            lock_paths=lambda root: [legacy(root, 'host-lock')], open_locks=opened, _lock_identity=identity)
        self.host = SimpleNamespace(
            AUTHORITY=SimpleNamespace(LAYOUT=self.layout), CREDENTIAL_FENCE=F,
            PLAN=SimpleNamespace(require_installation_protocol=Mock(side_effect=lambda value: value)),
            LOCK_DESCRIPTOR=ContextVar('ownership_bootstrap_lock', default=None),
            _require_no_capture_restore_fence=lambda root: None,
            IDENTITY=SimpleNamespace(PUBLICATION=SimpleNamespace(canonical=B.K.canonical, metadata=lambda body, **_: B.K.decoded(body))))
        self.host.credential_fence_lock = lambda root, context: F.locked(self.host, root, context)
        self.layout.ENROLLMENT_DESCRIPTOR = self.host.LOCK_DESCRIPTOR
        self.layout._no_legacy_authority = lambda root: F.require_clear(self.host, root)
        self.reader = SimpleNamespace(context='local', daemon=lambda: 'daemon-a', containers=lambda: [])
        self.manifest = {'tag': 'v9.0.0', 'commit': '1' * 40, 'digest': 'sha256:' + '2' * 64}
        self.peer_failure = False
        self.peer_patch = {}

        @contextmanager
        def admitted(service, connection, *, host, enrollment, guard=None):
            if self.peer_failure:
                raise ValueError('synthetic producer refusal')
            body = B.C.json_body(B.receipt_path(service.root).read_bytes())
            peer = {'installationId': body['installationId'], 'controllerId': 'b' * 64,
                    'imageId': 'sha256:' + 'c' * 64, 'controllerEpoch': 'd' * 64, **self.peer_patch}
            yield SimpleNamespace(verify=lambda: None, identity=lambda: copy.deepcopy(peer),
                                  installation_binding=lambda: {'root': str(service.root), 'context': service.context, 'daemon': self.reader.daemon()})
        self.peers = SimpleNamespace(admit=admitted, admit_bootstrap=admitted)
        self.service = SimpleNamespace(HOST=self.host, root=self.root, context='local', state_dir=self.state, lock=threading.Lock(),
                                       require_credential_idle=lambda guard: guard.read())

    @contextmanager
    def locked(self, root=None):
        fds = self.layout.open_locks(root or self.root)
        token = self.host.LOCK_DESCRIPTOR.set(fds[0])
        try:
            yield
        finally:
            self.host.LOCK_DESCRIPTOR.reset(token)
            os.close(fds[0])

    def birth(self, root=None):
        with self.locked(root):
            return B.prepare_new(self.host, root or self.root, self.reader, self.manifest)

    def issuer(self, root=None):
        if root is None:
            service = self.service
        else:
            service = SimpleNamespace(**{**vars(self.service), 'root': root, 'lock': threading.Lock()})
        issuer = B.BootstrapService(service, enrollment=lambda: {})
        self.addCleanup(issuer.close)
        return issuer

    def request(self, issuer, operation, data=None):
        return issuer.request(object(), operation, {} if data is None else data, peer_module=self.peers)

    def prepare(self, issuer, char='e'):
        return self.request(issuer, 'ownership-prepare', {'requestId': char * 64, 'purpose': 'first-registration'})

    def complete(self, issuer, grant):
        return self.request(issuer, 'ownership-complete', {key: grant[key] for key in ('operationId', 'admissionBinding', 'purpose')} | {'disposition': 'committed'})

    def snapshot(self):
        return {str(path.relative_to(self.folder)):(path.stat().st_ino,path.stat().st_mode & 0o777,
            path.stat().st_nlink,path.read_bytes()) for path in self.folder.rglob('*') if path.is_file()}

    def test_unadopted_installer_selection_keeps_the_legacy_marker_without_writes(self):
        before = self.snapshot()
        self.assertIsNone(B.installer_storage(self.host, self.root, 'local'))
        self.assertIsNone(B.verify_installer_storage(self.host, self.root, None, 'local'))
        self.assertEqual(B.installer_pointer_path(self.host, self.root, 'local'), self.root / '.orbis-installation.json')
        with self.assertRaises(ValueError): B.verify_installer_storage(self.host, self.root, {'schema': B.INSTALLER_STORAGE_PROTOCOL}, 'local')
        self.assertEqual(self.snapshot(), before)

    def test_positive_empty_target_receipt_is_private_and_bound_to_root_daemon_and_publication(self):
        reference = self.birth()
        self.assertEqual(os.listdir(self.root), [])
        path = B.receipt_path(self.root)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(reference['sha256'], hashlib.sha256(path.read_bytes()).hexdigest())
        value = B.verify_reference(self.host, self.root, 'local', hashlib.sha256(b'daemon-a').hexdigest(), reference)
        self.assertEqual(value['rootIdentity'], B.root_identity(self.root))
        self.assertEqual(value['initialPublication']['manifestSha256'], B.K.digest(self.manifest))
        self.assertNotIn('approvedPlanSha256', value)
        self.host.PLAN.require_installation_protocol.assert_called_once_with(self.manifest)

    def test_missing_receipt_never_becomes_unmanaged_or_writes_state(self):
        with self.assertRaises((OSError, ValueError)):
            self.issuer()
        self.assertEqual(sorted(path.name for path in self.folder.iterdir()), ['server', 'service-state'])

    def test_alternate_service_state_cannot_hide_a_global_admission_or_operation(self):
        self.birth(); self.service.state_dir = self.folder / 'other-state'
        with self.assertRaises(ValueError): self.issuer()

    def test_real_installer_lock_is_required_before_issuance(self):
        with self.assertRaises(ValueError):
            B.prepare_new(self.host, self.root, self.reader, self.manifest)
        self.assertFalse(B.receipt_path(self.root).exists())

    def test_long_root_name_is_refused_before_a_birth_proof_with_unusable_ledger_names_is_published(self):
        root = self.folder / ('x' * 200); root.mkdir(mode=0o700)
        with self.assertRaises(ValueError): self.birth(root)
        self.assertFalse(B.receipt_path(root).exists())
        self.assertEqual(list(root.iterdir()), [])

    def test_existing_data_and_reserved_controller_cannot_receive_a_new_birth_proof(self):
        data = self.root / 'existing'; data.write_text('preserve')
        with self.assertRaises(ValueError): self.birth()
        self.assertEqual(data.read_text(), 'preserve')
        data.unlink()
        self.reader.containers = lambda: [{'name': 'runtipi'}]
        with self.assertRaises(ValueError): self.birth()
        self.assertFalse(B.receipt_path(self.root).exists())

    def test_partial_or_managed_configuration_vetoes_issuance(self):
        for path in (self.state / B.C.CONFIG_NAME, B.RECOVERY, B.RECOVERY_ENV, self.layout.namespace(self.root)):
            with self.subTest(path=path.name):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('{}'); path.chmod(0o600)
                try:
                    with self.assertRaises(ValueError): self.birth()
                    self.assertFalse(B.receipt_path(self.root).exists())
                finally:
                    path.unlink()

    def test_duplicate_issuance_preserves_exact_receipt(self):
        self.birth(); before = B.receipt_path(self.root).read_bytes()
        with self.assertRaises(OSError): self.birth()
        self.assertEqual(B.receipt_path(self.root).read_bytes(), before)

    def test_failed_postwrite_witness_leaves_pending_evidence_without_usable_proof(self):
        fsync = os.fsync
        def drift(fd):
            fsync(fd)
            self.reader.context = 'changed'
        with patch.object(B.os, 'fsync', side_effect=drift):
            with self.assertRaises(ValueError): self.birth()
        self.assertFalse(B.receipt_path(self.root).exists())
        self.assertTrue(B.pending_path(self.root).exists())
        with self.assertRaises((OSError, ValueError)): self.issuer()

    def test_interrupted_publication_cannot_turn_two_links_into_a_grant(self):
        with patch.object(B.os, 'unlink', side_effect=OSError('synthetic interrupted birth publication')):
            with self.assertRaises(OSError): self.birth()
        self.assertTrue(B.receipt_path(self.root).exists())
        self.assertTrue(B.pending_path(self.root).exists())
        with self.assertRaises((OSError, ValueError)): self.issuer()

    def test_bad_permissions_links_and_noncanonical_content_are_not_positive_proof(self):
        self.birth(); path = B.receipt_path(self.root); original = path.read_bytes()
        path.chmod(0o644)
        with self.assertRaises(ValueError): self.issuer()
        path.chmod(0o600)
        link = self.folder / 'linked'; os.link(path, link)
        with self.assertRaises(ValueError): self.issuer()
        link.unlink()
        path.write_bytes(original + b' ')
        with self.assertRaises(ValueError): self.issuer()

    def test_bootstrap_without_realm_uses_actual_kernel_fence_until_verified_completion(self):
        self.birth(); issuer = self.issuer()
        admitted = self.request(issuer, 'admission')
        self.assertEqual(admitted['mode'], 'unmanaged')
        self.assertEqual(self.request(issuer, 'change-admission'), {**admitted, 'protocol': 'root-ownership'})
        grant = self.prepare(issuer)
        marker = self.layout.legacy_path(self.root, 'credential-fence')
        self.assertTrue(marker.exists())
        with self.assertRaises(ValueError): F.require_clear(self.host, self.root)
        with self.assertRaises(ValueError): self.request(issuer, 'admission')
        with self.assertRaises(ValueError): self.request(issuer, 'change-admission')
        self.assertEqual(self.complete(issuer, grant)['state'], 'completed')
        self.assertFalse(marker.exists())
        self.assertEqual(self.request(issuer, 'admission'), admitted)
        self.assertEqual(self.request(issuer, 'counter-challenge', {'admissionBinding': admitted['binding'], 'purpose': 'login', 'ceremonyBinding': 'f' * 64}),
                         {'mode': 'unmanaged', 'admissionBinding': admitted['binding']})
        with self.assertRaises(ValueError): self.request(issuer, 'counter-complete', {})

    def test_local_change_grant_is_bound_to_same_positive_admission_and_fences_transitions(self):
        self.birth(); issuer = self.issuer()
        admitted = self.request(issuer, 'change-admission')
        grant = self.request(issuer, 'ownership-prepare', {'requestId': '8' * 64, 'purpose': 'credential-change'})
        self.assertEqual(grant['admissionBinding'], admitted['binding'])
        self.assertEqual(grant['purpose'], 'credential-change')
        with self.assertRaises(ValueError): self.request(issuer, 'change-admission')
        with self.locked():
            with self.assertRaises(ValueError): B.retire_for_layout(self.root, self.layout, self.layout._lock_identity(os.fstat(self.host.LOCK_DESCRIPTOR.get())))
        self.complete(issuer, grant)
        self.assertEqual(self.request(issuer, 'change-admission'), admitted)

    def test_no_peer_or_changed_installation_cannot_grant(self):
        self.birth(); issuer = self.issuer()
        self.peer_failure = True
        with self.assertRaises(ValueError): self.prepare(issuer)
        self.peer_failure = False; self.peer_patch['installationId'] = '0' * 64
        with self.assertRaises(ValueError): self.prepare(issuer)
        self.assertFalse(self.layout.legacy_path(self.root, 'credential-fence').exists())

    def test_new_admission_or_partial_recovery_invalidates_a_cached_bootstrap(self):
        self.birth(); issuer = self.issuer()
        path = self.state / B.C.CONFIG_NAME; path.write_text('{}')
        with self.assertRaises(ValueError): self.prepare(issuer)
        self.assertFalse(self.layout.legacy_path(self.root, 'credential-fence').exists())

    def test_root_replacement_and_daemon_drift_invalidate_birth_custody(self):
        reference = self.birth()
        self.reader.daemon = lambda: 'daemon-b'
        with self.assertRaises(ValueError): self.request(self.issuer(), 'admission')
        self.reader.daemon = lambda: 'daemon-a'
        self.root.rename(self.folder / 'previous'); self.root.mkdir(mode=0o700)
        with self.assertRaises(ValueError): B.verify_reference(self.host, self.root, 'local', hashlib.sha256(b'daemon-a').hexdigest(), reference)

    def test_mutated_receipt_preserves_pending_hold(self):
        self.birth(); issuer = self.issuer(); grant = self.prepare(issuer)
        path = B.receipt_path(self.root); path.write_bytes(path.read_bytes() + b' ')
        with self.assertRaises(ValueError): self.complete(issuer, grant)
        self.assertTrue(self.layout.legacy_path(self.root, 'credential-fence').exists())

    def test_two_protected_roots_keep_distinct_journals_and_reject_crossed_grants(self):
        self.birth(); first = self.issuer(); one = self.prepare(first)
        second_root = self.folder / 'other'; second_root.mkdir(mode=0o700)
        self.birth(second_root); second = self.issuer(second_root); two = self.prepare(second, 'f')
        with self.assertRaises(ValueError): self.complete(second, one)
        journals = list(self.folder.glob('*.orbis-main-ownership-authority.json'))
        self.assertEqual(len(journals), 2)
        self.assertNotEqual(one['admissionBinding'], two['admissionBinding'])
        self.complete(first, one); self.complete(second, two)

    def test_birth_retirement_requires_the_live_enrollment_lock_and_preserves_active_holds(self):
        self.birth()
        identity = self.layout._lock_identity(self.layout.legacy_path(self.root, 'host-lock').stat())
        with self.assertRaises(ValueError): B.retire_for_layout(self.root, self.layout, identity)
        issuer = self.issuer(); grant = self.prepare(issuer)
        with self.locked():
            with self.assertRaises(ValueError): B.retire_for_layout(self.root, self.layout, identity)
        self.assertTrue(B.receipt_path(self.root).exists())
        self.complete(issuer, grant)

    def test_retired_birth_cannot_resurrect_when_later_authority_storage_is_absent(self):
        self.birth(); issuer = self.issuer(); original = B.receipt_path(self.root).read_bytes()
        with self.locked():
            identity = self.layout._lock_identity(os.fstat(self.host.LOCK_DESCRIPTOR.get()))
            B.retire_for_layout(self.root, self.layout, identity)
        self.assertFalse(B.receipt_path(self.root).exists())
        self.assertEqual(B.retired_path(self.root).read_bytes(), original)
        self.assertEqual(B.retired_path(self.root).stat().st_nlink, 1)
        with self.assertRaises((OSError, ValueError)): self.issuer()
        with self.assertRaises((OSError, ValueError)): self.request(issuer, 'admission')
        with self.assertRaises(ValueError): self.birth()

    def test_interrupted_retirement_keeps_both_private_links_and_denies_grants(self):
        self.birth(); issuer = self.issuer()
        with self.locked():
            identity = self.layout._lock_identity(os.fstat(self.host.LOCK_DESCRIPTOR.get()))
            with patch.object(B.os, 'unlink', side_effect=OSError('synthetic interrupted retirement')):
                with self.assertRaises(OSError): B.retire_for_layout(self.root, self.layout, identity)
        self.assertTrue(B.receipt_path(self.root).exists())
        self.assertTrue(B.retired_path(self.root).exists())
        self.assertEqual(B.receipt_path(self.root).stat().st_nlink, 2)
        with self.assertRaises((OSError, ValueError)): self.request(issuer, 'admission')
        with self.assertRaises((OSError, ValueError)): self.issuer()

    def test_exact_layout_transition_retires_birth_before_creating_namespace(self):
        self.birth(); original = B.receipt_path(self.root).read_bytes()
        layout = load('orbis-host-layout.py', 'ownership_bootstrap_actual_layout')
        mount = self.folder / 'mountinfo'; mount.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n')
        with patch.object(layout, 'STATE_ROOT', self.state), patch.object(layout, '_operator'), patch.object(layout, '_ownership_bootstrap', return_value=B):
            plan = layout.review(self.root, 'daemon-a', 'local', mount)
            layout.prepare(self.root, 'daemon-a', 'local', layout.plan_sha256(plan), mount)
            self.assertEqual(layout.read(self.root, 'daemon-a', 'local', mount)['plan'], plan)
        self.assertFalse(B.receipt_path(self.root).exists())
        self.assertEqual(B.retired_path(self.root).read_bytes(), original)

    def test_host_factory_uses_positive_birth_and_never_falls_back_from_existing_bad_admission(self):
        self.birth()
        host_service = load('orbis-host-service.py', 'ownership_bootstrap_actual_host')

        def instance():
            service = host_service.HostService.__new__(host_service.HostService)
            service.__dict__.update(vars(self.service))
            service.state_dir = self.state
            service.credential_factory_lock = threading.Lock()
            service.credential_service = None
            return service

        def lookup(name, _key):
            return {'orbis-host-credential-service.py': B.C,
                    'orbis-host-existing-ownership.py': SimpleNamespace(present=lambda service: False),
                    'orbis-host-ownership-bootstrap.py': B,
                    'orbis-host-credential-peer.py': self.peers}[name]

        with patch.object(host_service, 'load_script', side_effect=lookup) as loads:
            service = instance()
            self.assertEqual(service.credential_request(object(), 'admission', {})['mode'], 'unmanaged')
            self.addCleanup(service.credential_service.close)
            self.assertIsInstance(service.credential_service, B.BootstrapService)
            bad = self.state / B.C.CONFIG_NAME; bad.write_text('{}'); bad.chmod(0o600)
            loads.reset_mock()
            with self.assertRaises(ValueError): instance().credential_request(object(), 'admission', {})
            self.assertNotIn('orbis-host-ownership-bootstrap.py', [call.args[0] for call in loads.call_args_list])

    @contextmanager
    def data_uid(self, uid, path=None):
        """Metadata ownership port; do not chown real project/user files."""
        target=path or self.root
        identity = (target.stat().st_dev,target.stat().st_ino)
        def changed(info):
            if (info.st_dev,info.st_ino) != identity:return info
            return SimpleNamespace(**{name:(uid if name=='st_uid' else getattr(info,name))
                                      for name in dir(info) if name.startswith('st_')})
        original_stat,original_lstat,original_fstat=os.stat,os.lstat,os.fstat
        with patch.object(os,'stat',side_effect=lambda *a,**k:changed(original_stat(*a,**k))), \
                patch.object(os,'lstat',side_effect=lambda *a,**k:changed(original_lstat(*a,**k))), \
                patch.object(os,'fstat',side_effect=lambda *a,**k:changed(original_fstat(*a,**k))):
            yield

    def test_empty_service_owned_data_root_uses_only_private_parent_for_birth_authority(self):
        self.root.chmod(0o775)
        with self.data_uid(1000):
            reference=self.birth()
            value=B.verify_reference(self.host,self.root,'local',hashlib.sha256(b'daemon-a').hexdigest(),reference)
            self.assertEqual(value['rootIdentity'][2],1000)
            self.assertEqual(value['rootIdentity'][4] & 0o777,0o775)
            self.assertEqual(B.receipt_path(self.root).stat().st_uid,os.geteuid())
            self.assertNotEqual(value['rootIdentity'][2],B.receipt_path(self.root).stat().st_uid)
            self.assertEqual(os.listdir(self.root),[])

    def test_writable_parent_cannot_be_reclassified_as_private_birth_custody(self):
        self.folder.chmod(0o775)
        try:
            with self.assertRaises(ValueError):self.birth()
            self.assertFalse(B.receipt_path(self.root).exists());self.assertFalse(B.pending_path(self.root).exists())
        finally:self.folder.chmod(0o700)

    def test_user_owned_parent_cannot_publish_a_private_birth_proof(self):
        with self.data_uid(1000,self.folder):
            with self.assertRaises(ValueError):self.birth()
            self.assertFalse(B.receipt_path(self.root).exists());self.assertFalse(B.pending_path(self.root).exists())

    def runtime_observations(self):
        observed=load('orbis-host-existing-ownership.py','birth_actual_data_scope')
        for module in (observed,observed.C,observed.K):
            p=patch.object(module,'OWNER',os.geteuid());p.start();self.addCleanup(p.stop)
        p=patch.object(observed,'local_daemon',return_value='daemon-a');p.start();self.addCleanup(p.stop)
        p=patch.object(B,'_observations',return_value=observed);p.start();self.addCleanup(p.stop)
        self.layout.R=load('orbis-reset-authority.py','birth_reviewed_data_ancestry')
        self.host.STATE_NAME='.orbis-host-state.json'
        self.host.PLAN.validate_manifest=lambda value:value
        self.manifest={'schema':'orbis.release.v1','image':'ghcr.io/twentylines/orbis','tag':'v9.0.0',
                       'commit':'1'*40,'digest':'sha256:'+'2'*64,'installationProtocol':'orbis.installation-state.v1'}
        return observed

    def enroll_runtime_data(self, raw):
        saved={'schema':'orbis.host.v1','root':str(self.root),'dockerContext':'local',
               'tag':self.manifest['tag'],'digest':self.manifest['digest']}
        path=self.root/self.host.STATE_NAME;path.write_bytes(B.K.canonical(saved)+b'\n');path.chmod(0o600)
        self.host.saved_state=lambda root:json.loads((root/self.host.STATE_NAME).read_bytes())
        self.service.current_manifest=lambda:copy.deepcopy(self.manifest)
        self.service.controller_capture_identity=lambda identifier,image,saved:{'id':identifier,'imageId':image,
            'releaseTag':self.manifest['tag'],'releaseDigest':self.manifest['digest'],
            'imageReference':self.manifest['image']+'@'+self.manifest['digest'],'startedAt':raw['State']['StartedAt']}
        self.host.docker=lambda context,args,root:SimpleNamespace(returncode=0,stdout=json.dumps('daemon-a' if args[0]=='info' else raw))
        self.host.CAPTURE_READ_DEADLINE=ContextVar('birth-peer-deadline',default=None)
        raw.update(Name='/runtipi',RestartCount=0)
        raw['Config']['Image']=self.manifest['image']+'@'+self.manifest['digest']

    def test_service_owned_birth_data_joins_actual_peer_and_real_kernel_without_recovery_origin(self):
        import test_orbis_host_credential_peer as fixture
        p=fixture.PeerTests('test_descendant_in_exact_controller_namespaces_and_cgroup_is_bound')
        self.addCleanup(p.doCleanups);p.setUp()
        self.runtime_observations();self.root.chmod(0o775)
        with self.data_uid(1000):
            self.birth();self.enroll_runtime_data(p.container)
            p.service,p.daemon=self.service,'daemon-a'
            issuer=B.BootstrapService(self.service,enrollment=self.service.current_manifest);self.addCleanup(issuer.close)
            with patch.object(fixture.PEER,'_bootstrap_module',return_value=B), \
                    patch.object(fixture.PEER,'_enrollment_file',side_effect=AssertionError('No private data-root fallback')):
                grant=issuer.request(p.connection,'ownership-prepare',{'requestId':'a'*64,'purpose':'first-registration'},peer_module=fixture.PEER)
                self.assertEqual(grant['state'],'pending')
                args={key:grant[key] for key in ('operationId','admissionBinding','purpose')}
                self.assertEqual(issuer.request(p.connection,'ownership-check',args,peer_module=fixture.PEER),grant)
                result=issuer.request(p.connection,'ownership-complete',{**args,'disposition':'committed'},peer_module=fixture.PEER)
                self.assertEqual(result['state'],'completed')
                self.assertEqual(issuer.request(p.connection,'change-admission',{},peer_module=fixture.PEER)['protocol'],'root-ownership')
                p.write_proc(101,cgroup='0::/system.slice/docker-'+'f'*64+'.scope\n')
                before=self.snapshot()
                with self.assertRaises(ValueError):issuer.request(p.connection,'admission',{},peer_module=fixture.PEER)
                self.assertEqual(self.snapshot(),before)

    def test_birth_runtime_unknown_hold_never_allocates_an_ownership_journal(self):
        observed=self.runtime_observations();self.birth()
        with self.host.credential_fence_lock(self.root,'local') as guard:
            guard.begin('a'*64,'b'*64);before=self.snapshot()
            with self.assertRaises(ValueError):B.BirthRuntime(self.service,guard)
            self.assertEqual(self.snapshot(),before)
            self.assertFalse(B.legacy_journal_paths(self.layout,self.root)[0].exists())


if __name__ == '__main__':
    unittest.main()
