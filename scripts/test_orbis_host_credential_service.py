import base64
import copy
from contextlib import contextmanager, nullcontext
import hashlib
import http.client
import importlib.util
import json
import os
import py_compile
import shutil
from pathlib import Path
import socket
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

from test_orbis_host_sentinel_integration import SERVICE

SPEC = importlib.util.spec_from_file_location('credential_service_tests', Path(__file__).with_name('orbis-host-credential-service.py'))
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)


class ChangeProtocolTests(unittest.TestCase):
    def test_existing_positive_admission_keeps_prepared_identity_for_both_modes(self):
        service = C.CredentialService.__new__(C.CredentialService)
        service.service = SimpleNamespace(lock=threading.Lock(), HOST=object())
        service.verify = mock.Mock()
        service.peer = C.ContextVar('change_protocol_fixture', default=None)
        service.enrollment = lambda: {}
        service.lifecycle = SimpleNamespace(operation=lambda:nullcontext(object()))
        service.data_scope = lambda guard:nullcontext(object())
        @contextmanager
        def peer(*args, **kwargs):
            yield object()
        for mode in ('managed', 'unmanaged'):
            with self.subTest(mode=mode):
                service.broker = SimpleNamespace(admission=mock.Mock(return_value={'mode': mode, 'binding': 'a' * 64}))
                result = service.request(object(), 'change-admission', {}, peer_module=SimpleNamespace(admit_configured=peer))
                self.assertEqual(result, {'protocol': 'prepared-identity', 'mode': mode, 'binding': 'a' * 64})
                service.broker.admission.assert_called_once_with()
                self.assertIsNone(service.peer.get())
        with self.assertRaises(ValueError):
            service.request(object(), 'change-admission', {'protocol': 'root-ownership'}, peer_module=SimpleNamespace(admit_configured=peer))


class CredentialConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.root, self.state, self.runtime, self.journal = (self.base / n for n in ('installation', 'state', 'runtime', 'journal'))
        for p in (self.root, self.state, self.runtime, self.journal): p.mkdir(mode=0o700)
        self.host = SimpleNamespace(root=self.root, context='local', state_dir=self.state, lock=threading.Lock(), require_idle_core=lambda: None)
        patch = mock.patch.object(C, 'OWNER', os.geteuid())
        patch.start(); self.addCleanup(patch.stop)
        # Loader fixture only. Joined native proof uses the genuine Sentinel package.
        bodies = {name: '\n' for name in C.RUNTIME_FILES}
        bodies['writer_broker.py'] = '''HOST_WRITER_PROTOCOL=1
class WriterBroker:
 def __init__(self,*a,**kw):self.kw=kw
 def close(self):pass
'''
        for name, body in bodies.items(): (self.runtime / name).write_text(body)
        self.value = {'schema':'orbis.host.credential-admission.v1','writerProtocol':1,'root':str(self.root),'context':'local',
                      'installationId':'a'*64,'mode':'unmanaged','origin':'https://recovery.example','recoveryEpoch':None,
                      'runtimeDirectory':str(self.runtime),'runtimeFiles':{name:hashlib.sha256((self.runtime/name).read_bytes()).hexdigest() for name in C.RUNTIME_FILES},
                      'journalDirectory':str(self.journal),'recoveryConfig':None,'recoveryConfigSha256':None}
        self.config = self.state / C.CONFIG_NAME

    def write(self):
        self.config.write_text(json.dumps(self.value)); self.config.chmod(0o600)

    def open(self):
        value = C.CredentialService(self.host, enrollment=lambda: {})
        self.addCleanup(value.close)
        return value

    def test_absent_admission_never_initializes_journal_or_unmanaged_mode(self):
        with self.assertRaises(ValueError): self.open()
        self.assertEqual(list(self.journal.iterdir()), [])

    def test_explicit_unmanaged_config_supplies_real_lifecycle_and_never_creates_journal(self):
        self.write(); service = self.open()
        self.assertFalse(service.broker.kw['create'])
        self.assertIsInstance(service.broker.kw['lifecycle'], C.Lifecycle)
        self.assertIsInstance(service.broker.kw['control'], C.UnmanagedControl)
        with self.assertRaises(ValueError): service.admitted()
        self.assertEqual(list(self.journal.iterdir()), [])

    def test_unknown_or_old_protocol_or_inconsistent_mode_is_refused(self):
        for key, bad in [('mode','unknown'),('writerProtocol',0),('writerProtocol',True),('recoveryEpoch','b'*64),('context','other')]:
            with self.subTest(key=key):
                old=self.value[key]; self.value[key]=bad; self.write()
                with self.assertRaises(ValueError): self.open()
                self.value[key]=old

    def test_managed_requires_protected_recovery_config_not_socket_presence(self):
        self.value.update(mode='managed', recoveryEpoch='b'*64)
        self.write()
        with self.assertRaises(ValueError): self.open()
        self.value.update(recoveryConfig=str(self.base/'missing.json'), recoveryConfigSha256='c'*64)
        self.write()
        with self.assertRaises(ValueError): self.open()
        self.assertEqual(list(self.journal.iterdir()), [])

    def test_runtime_hash_mismatch_stops_execution(self):
        self.write()
        (self.runtime/'__init__.py').write_text('raise AssertionError("must never execute")\n')
        with self.assertRaises(ValueError): self.open()

    def test_runtime_without_required_lifecycle_protocol_is_refused(self):
        p=self.runtime/'writer_broker.py'; p.write_text('HOST_WRITER_PROTOCOL=0\n')
        self.value['runtimeFiles'][p.name]=hashlib.sha256(p.read_bytes()).hexdigest(); self.write()
        with self.assertRaises(ValueError): self.open()

    def test_timestamp_valid_old_bytecode_cannot_replace_pinned_source_execution(self):
        p=self.runtime/'writer_broker.py'
        good=p.read_text(); p.write_text(good.replace('PROTOCOL=1','PROTOCOL=0'))
        stamp=p.stat(); py_compile.compile(str(p),doraise=True)
        p.write_text(good); os.utime(p,ns=(stamp.st_atime_ns,stamp.st_mtime_ns))
        self.assertEqual(len(good),stamp.st_size)
        self.write(); service=self.open()
        self.assertIsInstance(service.broker.kw['lifecycle'],C.Lifecycle)

    def test_unlisted_relative_package_code_is_never_imported(self):
        p=self.runtime/'writer_broker.py'
        p.write_text('from . import unlisted\n'+p.read_text())
        (self.runtime/'unlisted.py').write_text('raise AssertionError("unlisted executed")\n')
        self.value['runtimeFiles'][p.name]=hashlib.sha256(p.read_bytes()).hexdigest(); self.write()
        with self.assertRaisesRegex(ValueError,'protected recovery needs review'): self.open()

    def test_runtime_and_journal_must_be_outside_installation(self):
        for key in ('runtimeDirectory','journalDirectory'):
            old=self.value[key]; self.value[key]=str(self.root/'child'); self.write()
            with self.assertRaises(ValueError): self.open()
            self.value[key]=old

    def test_config_replacement_and_runtime_change_refuse_existing_service(self):
        self.write(); service=self.open()
        self.config.write_text(self.config.read_text()+' ')
        with self.assertRaises(ValueError): service.verify()
        self.write(); another=self.open()
        (self.runtime/'writer_control.py').write_text('# changed\n')
        with self.assertRaises(ValueError): another.verify()

    def test_config_requires_private_single_link_regular_file(self):
        self.write(); self.config.chmod(0o644)
        with self.assertRaises(ValueError): self.open()
        self.config.chmod(0o600); os.link(self.config,self.state/'alias')
        with self.assertRaises(ValueError): self.open()

    def test_pinned_file_rejects_symlink_and_replaced_ancestor(self):
        target=self.base/'file'; target.write_text('data'); target.chmod(0o600)
        alias=self.base/'alias'; alias.symlink_to(target)
        with self.assertRaises(ValueError): C.PinnedFile(alias,limit=100,private=True)
        pinned=C.PinnedFile(target,limit=100,private=True); self.addCleanup(pinned.close)
        target.rename(self.base/'old'); target.write_text('data'); target.chmod(0o600)
        with self.assertRaises(ValueError): pinned.verify()

    def test_identity_codec_is_canonical_and_bounded(self):
        self.assertEqual(C.CredentialService.identity(base64.b64encode(b'x'*65536).decode()), b'x'*65536)
        for value in ('', 'eA', 'eA==\n', 'eB==', base64.b64encode(b'x'*65537).decode(), 1):
            with self.subTest(value=str(value)[:20]), self.assertRaises(ValueError): C.CredentialService.identity(value)

    def test_json_duplicate_nested_fields_float_nan_and_nonobjects_refuse(self):
        for body in (b'{"x":1,"x":2}',b'{"x":{"a":1,"a":2}}',b'{"x":1.5}',b'{"x":NaN}',b'[]',b'null'):
            with self.subTest(body=body), self.assertRaises(ValueError): C.json_body(body)

    def test_actual_host_idle_check_accepts_only_its_live_guard_without_crossing_own_hold(self):
        host=SERVICE.HOST
        for target,name,value in [(host.CREDENTIAL_FENCE,'OWNER',os.geteuid()),(host.AUTHORITY,'OWNER',os.geteuid()),
                                   (host.AUTHORITY.LAYOUT,'STATE_ROOT',self.state)]:
            patch=mock.patch.object(target,name,value); patch.start(); self.addCleanup(patch.stop)
        patch=mock.patch.object(host.AUTHORITY.LAYOUT,'_operator'); patch.start(); self.addCleanup(patch.stop)
        service=SERVICE.HostService.__new__(SERVICE.HostService)
        service.root,self.host.root=self.root,self.root
        service.context='local'; service.busy=False
        service.restart_job_file=self.state/'restart.json'; service.package_job_file=self.state/'packages.json'
        service.job_file=self.state/'job.json'; service.maintenance_file=self.state/'maintenance.json'
        with host.credential_fence_lock(self.root,'local') as guard:
            guard.begin('a'*64,'b'*64)
            service.require_credential_idle(guard)
            with self.assertRaises(ValueError): service.require_idle_core()
            with self.assertRaises(ValueError): service.require_credential_idle(SimpleNamespace())
            service.maintenance_file.write_text('{}')
            with self.assertRaisesRegex(ValueError,'maintenance'): service.require_credential_idle(guard)
            self.assertIsNotNone(guard.read())
        with self.assertRaises(ValueError): service.require_credential_idle(guard)


@unittest.skipUnless(os.environ.get('ORBIS_RECOVERY_TEST_RUNTIME'), 'Set the real Sentinel source fixture path')
class ConfiguredPeerJoinTests(unittest.TestCase):
    """Real pinned runtime, private files/locks and peer implementation.

    Layout, Docker, proc/socket producer and recovery-control observations are
    explicit ports. No native controller, TLS route or human key ceremony runs.
    """
    def setUp(self):
        import test_orbis_host_existing_ownership as roots
        import test_orbis_host_credential_peer as peers
        from test_writer_broker import ControlFixture
        self.roots,self.peers,self.Control=roots,peers,ControlFixture
        self.fixture=roots.ExistingOwnershipTests('test_absent_history_is_not_a_root_decision')
        self.addCleanup(self.fixture.doCleanups);self.fixture.setUp()
        self.base,self.root,self.state,self.namespace=self.fixture.f.folder,self.fixture.f.root,self.fixture.f.state,self.fixture.namespace
        self.service,self.host=self.fixture.service,self.fixture.f.host
        self.service.lock=threading.Lock();self.root.chmod(0o775)
        self.host.load_script=lambda name,key:roots.E.K if name=='orbis-host-ownership-authority.py' else roots.fixture.load(name,key)
        self.peer=peers.PeerTests('test_descendant_in_exact_controller_namespaces_and_cgroup_is_bound')
        self.addCleanup(self.peer.doCleanups);self.peer.setUp()
        raw=self.fixture.f.raw;raw['Id'],raw['Image'],raw['State']['Pid']=peers.CID,peers.IMAGE,100
        self.peer.service,self.peer.container,self.peer.daemon=self.service,raw,'daemon-fixture'
        self.host.CAPTURE_READ_DEADLINE=C.ContextVar('configured-peer-deadline',default=None)
        self.runtime=self.base/'runtime';self.runtime.mkdir(mode=0o700)
        source=Path(os.environ['ORBIS_RECOVERY_TEST_RUNTIME'])
        for name in C.RUNTIME_FILES:shutil.copyfile(source/name,self.runtime/name)
        self.journal=self.namespace/'credential-journal';self.journal.mkdir(mode=0o700)
        self.config=self.state/C.CONFIG_NAME
        self.issuer=None;self.addCleanup(self.close_issuer)
        for change in (mock.patch.object(C,'OWNER',os.geteuid()),mock.patch.object(C,'_data_observations',return_value=roots.E),
                       mock.patch.object(C,'OWNERSHIP_RECOVERY',self.base/'no-ownership-recovery'),
                       mock.patch.object(C,'OWNERSHIP_RECOVERY_ENV',self.base/'no-ownership-recovery-env'),
                       mock.patch.object(peers.PEER,'_enrollment_file',side_effect=AssertionError('No private data-root fallback'))):
            change.start();self.addCleanup(change.stop)

    def close_issuer(self):
        if self.issuer is not None:self.issuer.close();self.issuer=None

    def open(self,mode='unmanaged'):
        self.close_issuer()
        value={'schema':'orbis.host.credential-admission.v1','writerProtocol':1,'root':str(self.root),'context':'local',
            'installationId':self.roots.E.K.digest({'root':str(self.root),'context':'local','daemon':'daemon-fixture',
                'rootIdentity':list(C.seal(self.root.stat())[:5])}),'mode':mode,'origin':'https://recovery.example',
            'recoveryEpoch':None,'runtimeDirectory':str(self.runtime),
            'runtimeFiles':{name:hashlib.sha256((self.runtime/name).read_bytes()).hexdigest() for name in C.RUNTIME_FILES},
            'journalDirectory':str(self.journal),'recoveryConfig':None,'recoveryConfigSha256':None}
        if mode=='managed':
            recovery=self.base/'recovery';recovery.mkdir(mode=0o700,exist_ok=True)
            profile=self.base/'recovery-config.json'
            profile.write_bytes(self.roots.E.K.canonical({'schema':'orbis.sentinel-recovery-config.v1',
                'origin':value['origin'],'directory':str(recovery),'imageId':self.peers.IMAGE,
                'listenPort':8443,'statusSocket':str(self.base/'status.sock')})+b'\n');profile.chmod(0o600)
            value.update(recoveryEpoch='e'*64,recoveryConfig=str(profile),recoveryConfigSha256=hashlib.sha256(profile.read_bytes()).hexdigest())
        self.config.write_bytes(self.roots.E.K.canonical(value)+b'\n');self.config.chmod(0o600)
        package='_orbis_credential_'+hashlib.sha256(self.config.read_bytes()).hexdigest()
        pins={name:C.PinnedFile(self.runtime/name,limit=262144) for name in C.RUNTIME_FILES}
        try:self.modules=C.CredentialService.load_runtime(package,pins)
        finally:
            for pin in pins.values():pin.close()
        for module in self.modules.values():
            if hasattr(module,'_OWNER_UID'):
                change=mock.patch.object(module,'_OWNER_UID',os.geteuid());change.start();self.addCleanup(change.stop)
        if not list(self.journal.iterdir()):
            journal=self.modules['writer_journal'].WriterJournal(self.journal,create=True,validate_record=self.modules['writer_broker'].validate_record)
            journal.close()
        self.issuer=C.CredentialService(self.service,enrollment=self.service.current_manifest)
        history={'schema':'orbis.recovery-admission-history.v1','installationId':value['installationId'],'generation':1,
            'managedEver':mode=='managed','mode':mode,'configSha256':hashlib.sha256(self.config.read_bytes()).hexdigest(),
            'planSha256':'d'*64,'sentinelVersion':'0.1.0-dev.20','writerProtocol':1}
        self.fixture.write(self.namespace/'recovery-admission-history.json',history)
        self.control=self.Control(self.journal);self.counter_calls=[]
        def call(operation,arguments):
            if operation.startswith('main-passkey-'):
                self.counter_calls.append((operation,copy.deepcopy(arguments)));return {'proof':'fixture'}
            return self.control.call(operation,arguments)
        if mode=='managed':self.issuer.broker.control=SimpleNamespace(call=call)
        return self.issuer

    def request(self,operation,data=None):
        return self.issuer.request(self.peer.connection,operation,data or {},peer_module=self.peers.PEER)

    def prepare(self):
        admission=self.request('change-admission')
        self.assertEqual(admission['protocol'],'prepared-identity')
        args={'requestId':'a'*64,'admissionBinding':admission['binding'],
              'baselineIdentityBase64':base64.b64encode(b'baseline fixture').decode(),
              'plannedIdentityBase64':base64.b64encode(b'planned fixture').decode()}
        return self.request('prepare',args),args

    def test_service_owned_data_uses_actual_peer_and_one_reentrant_lifecycle_guard(self):
        import test_orbis_host_ownership_bootstrap as birth
        with birth.BootstrapTests.data_uid(SimpleNamespace(root=self.root),1000):
            self.open()
            with mock.patch.object(self.host,'credential_fence_lock',wraps=self.host.credential_fence_lock) as locks:
                result=self.request('admission')
                self.assertEqual(result['mode'],'unmanaged');self.assertEqual(locks.call_count,1)
            self.assertIsNone(self.issuer.lifecycle.current.get());self.assertIsNone(self.issuer.peer.get())
            self.assertFalse(self.service.lock.locked())

    def test_unmanaged_prepared_identity_prepare_complete_and_lost_reply_replay(self):
        self.open();result,args=self.prepare()
        self.assertEqual(result['state'],'pending')
        with self.host.credential_fence_lock(self.root,'local') as guard:self.assertIsNotNone(guard.read())
        completion={key:result[key] for key in ('operationId','admissionBinding')}
        completion['currentIdentityBase64']=args['plannedIdentityBase64']
        done=self.request('complete',completion)
        self.assertEqual(done['state'],'completed');self.assertEqual(self.request('complete',completion),done)
        with self.host.credential_fence_lock(self.root,'local') as guard:self.assertIsNone(guard.read())

    def test_managed_prepared_identity_uses_real_runtime_and_keeps_hold_until_root_completion(self):
        self.open('managed');result,args=self.prepare()
        self.assertEqual(result['state'],'pending')
        calls=list(self.control.calls)
        with self.assertRaises((ValueError,self.modules['writer_broker'].WriterBrokerError,self.modules['writer_journal'].WriterJournalError)):self.request('counter-challenge',{
            'admissionBinding':result['admissionBinding'],'purpose':'login','ceremonyBinding':'c'*64})
        self.assertEqual(self.control.calls,calls)
        done=self.request('complete',{'operationId':result['operationId'],'admissionBinding':result['admissionBinding'],
                                     'currentIdentityBase64':args['plannedIdentityBase64']})
        self.assertEqual(done['state'],'completed');self.assertIn('operator-prepare-writer',self.control.calls)
        self.assertIn('operator-complete-incarnation',self.control.calls)

    def test_managed_counter_routes_share_guard_and_bind_root_generation(self):
        self.open('managed');admission=self.request('admission')
        challenge={'admissionBinding':admission['binding'],'purpose':'login','ceremonyBinding':'c'*64}
        self.assertEqual(self.request('counter-challenge',challenge)['mode'],'managed')
        result=self.request('counter-floors',{'admissionBinding':admission['binding'],'identityBase64':'eA=='})
        self.assertEqual(result['schema'],'orbis.sentinel-main-counter-floors.v1')
        self.assertEqual(self.counter_calls[-1][1]['expectedGeneration'],1)
        self.assertEqual(self.counter_calls[-1][1]['expectedRevision'],'a'*64)

    def test_unmanaged_account_ownership_reuses_guard_and_completes_kernel_receipt(self):
        self.open();grant=self.request('ownership-prepare',{'requestId':'b'*64,'purpose':'first-registration'})
        args={key:grant[key] for key in ('operationId','admissionBinding','purpose')}
        self.assertEqual(self.request('ownership-check',args),grant)
        self.assertEqual(self.request('ownership-complete',{**args,'disposition':'committed'})['state'],'completed')

    def test_unknown_hold_never_initializes_or_returns_an_admission(self):
        self.open()
        with self.host.credential_fence_lock(self.root,'local') as guard:guard.begin('a'*64,'b'*64)
        before=self.fixture.f.snapshot()
        with self.assertRaises(self.modules['writer_broker'].WriterBrokerError):self.request('admission')
        self.assertEqual(self.fixture.f.snapshot(),before)

    def test_current_scope_detects_layout_and_runtime_replacement(self):
        self.open()
        file=self.namespace/'layout.json';other=self.namespace/'layout-copy'
        other.write_bytes(file.read_bytes());other.chmod(0o600);other.replace(file)
        # The layout observation port still returns the same value, so only the
        # currently pinned scope sees this replacement during its own lifetime.
        with self.issuer.lifecycle.operation() as guard,self.issuer.data_scope(guard) as scope:
            replacement=self.namespace/'layout-copy';replacement.write_bytes(file.read_bytes());replacement.chmod(0o600);replacement.replace(file)
            with self.assertRaises(ValueError):scope.verify()
        (self.runtime/'writer_control.py').write_text('# changed fixture\n')
        with self.assertRaises(ValueError):self.request('admission')
        self.assertIsNone(self.issuer.peer.get());self.assertIsNone(self.issuer.lifecycle.current.get())

    def test_scope_cannot_be_supplied_as_json_or_reused_outside_its_live_frame(self):
        self.open()
        with self.assertRaises(ValueError):C.ConfiguredRuntime(object(),self.issuer,object())
        with self.issuer.lifecycle.operation() as guard:
            with self.issuer.data_scope(guard) as scope:scope.verify()
            with self.assertRaises(ValueError):scope.verify()
        with self.assertRaises(ValueError):self.issuer.data_scope(guard)

    def test_sibling_cgroup_and_changed_enrollment_preserve_pending_writer_hold(self):
        self.open();result,args=self.prepare()
        self.peer.write_proc(101,cgroup='0::/system.slice/docker-'+'f'*64+'.scope\n')
        before=self.fixture.f.snapshot()
        with self.assertRaises(ValueError):self.request('complete',{'operationId':result['operationId'],
            'admissionBinding':result['admissionBinding'],'currentIdentityBase64':args['plannedIdentityBase64']})
        self.assertEqual(self.fixture.f.snapshot(),before)

    def test_main_mount_cannot_expose_configured_runtime_or_recovery(self):
        self.open('managed')
        for source in (self.runtime,Path(self.issuer.value['recoveryConfig']),self.journal):
            with self.subTest(source=source.name):
                self.fixture.f.raw['Mounts']=[{'Type':'bind','Source':str(source),'Destination':'/unsafe','RW':False}]
                before=self.fixture.f.snapshot()
                with self.assertRaises(ValueError):self.request('admission')
                self.assertEqual(self.fixture.f.snapshot(),before)

    def test_partial_admission_or_storage_transition_blocks_current_scope(self):
        self.open()
        for name in ('recovery-admission-intent.json','credential-storage-migration.json','credential-bootstrap-publication-hold.json'):
            with self.subTest(name=name):
                path=self.namespace/name;path.write_bytes(b'partial');path.chmod(0o600)
                before=self.fixture.f.snapshot()
                with self.assertRaises(ValueError):self.request('admission')
                self.assertEqual(self.fixture.f.snapshot(),before);path.unlink()

    def test_config_and_recovery_profile_changes_invalidate_cached_service(self):
        self.open('managed')
        profile=Path(self.issuer.value['recoveryConfig']);profile.write_bytes(profile.read_bytes()+b' ')
        before=self.fixture.f.snapshot()
        with self.assertRaises(ValueError):self.request('admission')
        self.assertEqual(self.fixture.f.snapshot(),before)
        self.open('managed');self.config.write_bytes(self.config.read_bytes()+b' ')
        before=self.fixture.f.snapshot()
        with self.assertRaises(ValueError):self.request('admission')
        self.assertEqual(self.fixture.f.snapshot(),before)

    def test_lifecycle_reentry_rejects_stale_cross_thread_and_foreign_context(self):
        from contextvars import copy_context
        self.open()
        with self.issuer.lifecycle.operation() as guard:
            with self.issuer.lifecycle.operation() as nested:self.assertIs(nested,guard)
            context=copy_context();errors=[]
            def other():
                try:
                    with self.issuer.lifecycle.operation():pass
                except ValueError:errors.append('denied')
            thread=threading.Thread(target=lambda:context.run(other));thread.start();thread.join(timeout=2)
            self.assertFalse(thread.is_alive());self.assertEqual(errors,['denied'])
            token=self.issuer.lifecycle.current.set(object())
            try:
                with self.assertRaises(ValueError),self.issuer.lifecycle.operation():pass
            finally:self.issuer.lifecycle.current.reset(token)
        token=self.issuer.lifecycle.current.set(guard)
        try:
            with self.assertRaises(ValueError),self.issuer.lifecycle.operation():pass
        finally:self.issuer.lifecycle.current.reset(token)

    def test_verified_publication_transition_changes_peer_binding_without_reenrollment(self):
        self.open();before=self.request('admission');installation=self.issuer.value['installationId']
        f=self.fixture.f;f.manifest.update(tag='v9.0.1',commit='e'*40,digest='sha256:'+'d'*64)
        f.raw['Config']['Image']=f.manifest['image']+'@'+f.manifest['digest'];f.raw['Image']='sha256:'+'d'*64
        self.fixture.saved.update(tag=f.manifest['tag'],digest=f.manifest['digest'])
        self.fixture.write(self.root/self.host.STATE_NAME,self.fixture.saved)
        after=self.request('admission')
        self.assertEqual(after['mode'],'unmanaged');self.assertNotEqual(after['binding'],before['binding'])
        self.assertEqual(self.issuer.value['installationId'],installation)

    def test_lost_managed_completion_reply_reconciles_exact_root_receipt(self):
        self.open('managed');result,args=self.prepare();self.control.drop_complete=True
        completion={'operationId':result['operationId'],'admissionBinding':result['admissionBinding'],
                    'currentIdentityBase64':args['plannedIdentityBase64']}
        with self.assertRaises(self.modules['writer_broker'].WriterBrokerError):self.request('complete',completion)
        with self.host.credential_fence_lock(self.root,'local') as guard:self.assertIsNotNone(guard.read())
        done=self.request('complete',completion)
        self.assertEqual(done['state'],'completed')
        self.assertEqual(self.control.calls.count('operator-complete-incarnation'),1)
        with self.host.credential_fence_lock(self.root,'local') as guard:self.assertIsNone(guard.read())


class CredentialHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)/'s'
        self.calls=[]; self.error=None
        def request(connection, operation, data):
            self.calls.append((operation,data))
            if self.error: raise self.error
            return {'operation':operation}
        self.server=SERVICE.UnixHTTPServer(str(self.path),SERVICE.Handler)
        self.server.service=SimpleNamespace(credential_request=request)
        self.thread=threading.Thread(target=self.server.serve_forever,kwargs={'poll_interval':0.01})
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive())

    def request(self, method='POST', path='/v1/credentials/prepare', body=b'{}', headers=None):
        if headers is None:
            headers=[('Host','orbis')]+([('Content-Length',str(len(body))),('Content-Type','application/json')] if method=='POST' else [])
        wire=f'{method} {path} HTTP/1.1\r\n'.encode()+b''.join(f'{k}: {v}\r\n'.encode() for k,v in headers)+b'\r\n'+body
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
            connection.settimeout(2); connection.connect(str(self.path)); connection.sendall(wire)
            try: connection.shutdown(socket.SHUT_WR)
            except OSError: pass  # Server may already have rejected headers/closed.
            response=http.client.HTTPResponse(connection); response.begin(); return response.status,response.read()

    def test_fixed_admission_and_complete_routes_dispatch_only_exact_operations(self):
        self.assertEqual(self.request('GET','/v1/credentials/admission',b'')[0],200)
        self.assertEqual(self.request(path='/v1/credentials/complete')[0],200)
        self.assertEqual([c[0] for c in self.calls],['admission','complete'])
        self.assertEqual(self.request(path='/v1/credentials/prepare?relay=1')[0],404)
        self.assertEqual(len(self.calls),2)
        self.assertEqual(self.request('GET','/v1/credentials/change-admission',b'')[0],200)
        self.assertEqual(self.calls[-1], ('change-admission', {}))
        self.assertEqual(self.request(path='/v1/credentials/change-admission')[0],404)
        for route in ('counter-challenge', 'counter-complete', 'counter-floors',
                      'ownership-prepare', 'ownership-check', 'ownership-complete'):
            self.assertEqual(self.request(path='/v1/credentials/'+route)[0],200)
            self.assertEqual(self.calls[-1], (route, {}))
            self.assertEqual(self.request('GET','/v1/credentials/'+route,b'')[0],404)

    def test_two_maximum_identity_frames_exceed_old_generic_limit_and_are_accepted(self):
        value=base64.b64encode(b'x'*65536).decode()
        body=json.dumps({'baselineIdentityBase64':value,'plannedIdentityBase64':value}).encode()
        self.assertGreater(len(body),65536)
        self.assertEqual(self.request(body=body)[0],200)
        self.assertEqual(len(self.calls),1)

    def test_duplicate_headers_encoding_wrong_host_and_oversize_never_dispatch(self):
        baseline=[('Host','orbis'),('Content-Length','2'),('Content-Type','application/json')]
        cases=[baseline+[('Content-Length','2')],baseline+[('Content-Type','application/json')],
               baseline+[('Transfer-Encoding','chunked')],baseline+[('Content-Encoding','identity')],
               baseline+[('Host','orbis')],[('Host','localhost'),*baseline[1:]],
               [('Host','orbis'),('Content-Length','196609'),('Content-Type','application/json')]]
        for headers in cases:
            with self.subTest(headers=headers): self.assertEqual(self.request(headers=headers)[0],503)
        self.assertEqual(self.calls,[])

    def test_duplicate_json_partial_frame_and_nonobject_never_dispatch(self):
        for body in (b'{"x":1,"x":2}',b'[]',b'{"x":NaN}'):
            self.assertEqual(self.request(body=body)[0],503)
        self.assertEqual(self.request(body=b'{',headers=[('Host','orbis'),('Content-Length','2'),('Content-Type','application/json')])[0],503)
        self.assertEqual(self.calls,[])

    def test_failure_is_generic_without_private_details_or_identity_echo(self):
        self.error=ValueError('private credential value must not be returned')
        status,body=self.request(body=b'{"identity":"private payload"}')
        self.assertEqual(status,503)
        self.assertNotIn(b'private credential',body); self.assertNotIn(b'private payload',body)
        self.assertIn(b'protected recovery needs review',body)

    def test_admission_rejects_body_headers_and_wrong_method(self):
        self.assertEqual(self.request('GET','/v1/credentials/admission',b'{}',headers=[('Host','orbis'),('Content-Length','2')])[0],503)
        self.assertEqual(self.request(path='/v1/credentials/admission')[0],404)
        self.assertEqual(self.calls,[])

    def test_slow_trickle_cannot_extend_the_total_body_deadline(self):
        with mock.patch.object(SERVICE,'CREDENTIAL_BODY_TIMEOUT',0.08), socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
            connection.settimeout(2); connection.connect(str(self.path))
            connection.sendall(b'POST /v1/credentials/prepare HTTP/1.1\r\nHost: orbis\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{')
            started=time.monotonic()
            for _ in range(8):
                time.sleep(0.02)
                try: connection.sendall(b' ')
                except OSError: break
            response=http.client.HTTPResponse(connection); response.begin()
            self.assertEqual(response.status,503); response.read()
            self.assertLess(time.monotonic()-started,1.5)
        self.assertEqual(self.calls,[])


if __name__=='__main__': unittest.main()


class CounterRouteTests(unittest.TestCase):
    def setUp(self):
        self.service=C.CredentialService.__new__(C.CredentialService)
        self.binding='a'*64
        self.mode='managed'
        self.marker=None
        self.active=None
        self.calls=[]
        self.rechecks=0
        @contextmanager
        def operation():
            self.calls.append(('lock', None))
            yield None,self.marker
        def admitted(binding):
            self.rechecks+=1
            if binding != self.binding: raise ValueError('crossed')
            return {'mode':self.mode},self.binding
        def control(operation,arguments):
            self.calls.append((operation,arguments))
            if operation=='operator-status':return {'generation':3,'revision':'b'*64,'state':'enrolled'}
            return {'proof':'fixture'}
        self.service.broker=SimpleNamespace(_operation=operation,_admitted=admitted,
            journal=SimpleNamespace(read=lambda:{'active':self.active}),control=SimpleNamespace(call=control))
    def challenge(self):
        return {'admissionBinding':self.binding,'purpose':'login','ceremonyBinding':'c'*64}
    def test_challenge_is_separate_fixed_counter_operation_under_shared_lock_and_recheck(self):
        self.assertEqual(self.service.counter_request('counter-challenge',self.challenge()),
                         {'proof':'fixture','mode':'managed','admissionBinding':self.binding})
        self.assertEqual(self.calls,[('lock',None),('main-passkey-challenge',self.challenge())])
        self.assertEqual(self.rechecks,2)
    def test_complete_passes_bound_assertion_without_any_session_operation(self):
        data={**self.challenge(),'challenge':base64.urlsafe_b64encode(b'x'*32).decode().rstrip('='),'response':{'id':'fixture'}}
        result=self.service.counter_request('counter-complete',data)
        self.assertEqual(result,{'proof':'fixture','admissionBinding':self.binding})
        self.assertEqual(self.calls,[('lock',None),('main-passkey-complete',data)])
    def test_floors_take_generation_revision_from_root_inside_lock_not_main(self):
        data={'admissionBinding':self.binding,'identityBase64':base64.b64encode(b'identity').decode()}
        result=self.service.counter_request('counter-floors',data)
        self.assertEqual(result,{'schema':'orbis.sentinel-main-counter-floors.v1','proof':'fixture','admissionBinding':self.binding})
        self.assertEqual(self.calls,[('lock',None),('operator-status',{}),('main-passkey-floors',
            {'identityBase64':data['identityBase64'],'expectedGeneration':3,'expectedRevision':'b'*64})])
    def test_unmanaged_is_explicit_challenge_only_and_never_calls_root(self):
        self.mode='unmanaged'
        self.assertEqual(self.service.counter_request('counter-challenge',self.challenge()),
                         {'mode':'unmanaged','admissionBinding':self.binding})
        with self.assertRaises(ValueError):self.service.counter_request('counter-floors',
            {'admissionBinding':self.binding,'identityBase64':'eA=='})
        self.assertTrue(all(operation=='lock' for operation,_ in self.calls))
    def test_active_authority_lease_or_orphan_marker_excludes_counter_rpc(self):
        for marker,active in (({},None),(None,{})):
            self.marker,self.active=marker,active
            with self.assertRaises(ValueError):self.service.counter_request('counter-challenge',self.challenge())
        self.assertTrue(all(operation=='lock' for operation,_ in self.calls))
    def test_nonexact_or_invalid_input_refuses_before_control_or_lock(self):
        for patch in ({'extra':1},{'purpose':'recovery'},{'ceremonyBinding':'bad'},{'admissionBinding':'bad'}):
            with self.subTest(patch=patch),self.assertRaises(ValueError):
                self.service.counter_request('counter-challenge',{**self.challenge(),**patch})
        for identity in ('eB==','',1):
            with self.subTest(identity=identity),self.assertRaises(ValueError):
                self.service.counter_request('counter-floors',{'admissionBinding':self.binding,'identityBase64':identity})
        self.assertEqual(self.calls,[])
    def test_root_status_unknown_or_numeric_and_revision_aliases_refuse(self):
        for patch in ({'state':'pending'},{'generation':True},{'generation':0},{'generation':9007199254740992},{'revision':'bad'},{'extra':1}):
            calls=[]
            def control(operation,arguments):
                calls.append(operation)
                return {**{'generation':3,'revision':'b'*64,'state':'enrolled'},**patch}
            self.service.broker.control.call=control
            with self.subTest(patch=patch),self.assertRaises(ValueError):
                self.service.counter_request('counter-floors',{'admissionBinding':self.binding,'identityBase64':'eA=='})
            self.assertEqual(calls,['operator-status'])
    def test_changed_admission_after_root_response_returns_no_receipt(self):
        original=self.service.broker._admitted
        def admitted(binding):
            if self.rechecks:raise ValueError('changed')
            return original(binding)
        self.service.broker._admitted=admitted
        with self.assertRaises(ValueError):self.service.counter_request('counter-challenge',self.challenge())
        self.assertEqual(self.calls[-1][0],'main-passkey-challenge')
