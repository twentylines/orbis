"""Admission transaction tests; external daemon/TLS observations are fixtures.

Optional ORBIS_RECOVERY_TEST_RUNTIME joins the genuine six-source Sentinel
journal. This never substitutes fixture observations for installed qualification.
"""
from contextlib import contextmanager
import copy
import base64
from dataclasses import dataclass
import ast
import shutil
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest import mock

from test_orbis_host_sentinel_integration import SERVICE

SPEC=importlib.util.spec_from_file_location('recovery_admission_tests',Path(__file__).with_name('orbis-host-recovery-admission.py'))
P=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(P)


class FixtureJournal:
    calls=[]
    def __init__(self,path,*,create=False,validate_record):
        self.path=Path(path); self.calls.append((self.path,create,sorted(os.listdir(path))))
        if create:
            if os.listdir(path):raise ValueError('not empty')
            (self.path/'sources').mkdir(mode=0o700)
            for name,body in [('writer.lock',b''),('state.json',P.canonical({'schema':'fixture','active':None,'operations':{}}))]:
                (self.path/name).write_bytes(body);(self.path/name).chmod(0o600)
        if set(os.listdir(path))!={'sources','writer.lock','state.json'}:raise ValueError('missing state')
    def read(self):return json.loads((self.path/'state.json').read_bytes())
    def close(self):pass


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name).resolve();self.base.chmod(0o700)
        self.root,self.config,self.state=(self.base/n for n in ('installation','config','state'))
        for path in (self.root,self.config,self.state):path.mkdir(mode=0o700)
        self.host=SERVICE.HOST;self.layout=self.host.AUTHORITY.LAYOUT
        for target,name,value in [(P,'OWNER',os.geteuid()),(P.C,'OWNER',os.geteuid()),(self.host.CREDENTIAL_FENCE,'OWNER',os.geteuid()),
                                  (self.host.AUTHORITY,'OWNER',os.geteuid()),(self.layout,'STATE_ROOT',self.state)]:
            patch=mock.patch.object(target,name,value);patch.start();self.addCleanup(patch.stop)
        for target,name in [(P,'_root'),(self.layout,'_operator')]:
            patch=mock.patch.object(target,name);patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.object(self.layout,'read',return_value={'schema':'fixture-reviewed-layout'});patch.start();self.addCleanup(patch.stop)
        self.namespace=self.layout.namespace(self.root);self.namespace.parent.mkdir(mode=0o700);self.namespace.mkdir(mode=0o700)
        self.service=SERVICE.HostService.__new__(SERVICE.HostService)
        self.service.HOST=self.host
        self.service.root=self.root;self.service.context='local';self.service.state_dir=self.config
        self.service._require_restart_job_clear=lambda:None;self.service._require_idle_core_jobs=lambda:None
        for name,value in [('filesystem',{'fsType':'ext4','identity':'fixture-mount'}),('_durable_filesystem',{'source':'fixture-durable'})]:
            patch=mock.patch.object(self.layout.R,name,return_value=value);patch.start();self.addCleanup(patch.stop)
        self.manager=P.Admission(self.service)
        self.modules={'writer_journal':SimpleNamespace(WriterJournal=FixtureJournal),'writer_broker':SimpleNamespace(validate_record=lambda *a:None)}
        FixtureJournal.calls=[]
        runtime=os.environ.get('ORBIS_RECOVERY_TEST_RUNTIME')
        if runtime:
            pins={name:P.C.PinnedFile(Path(runtime)/name,limit=262144) for name in P.C.RUNTIME_FILES}
            for pin in pins.values():self.addCleanup(pin.close)
            self.modules=P.C.CredentialService.load_runtime('_admission_test_'+P.digest(str(self.base).encode()),pins)
            self.modules['writer_journal']._OWNER_UID=os.geteuid()
        self.dependencies={'installationId':'a'*64,'namespace':str(self.namespace),'writerProtocol':1,
                           'sentinel':{'version':'0.9.0','runtimeDirectory':str(self.base/'runtime'),
                                       'runtimeFiles':{n:'b'*64 for n in P.C.RUNTIME_FILES}},'recovery':None}
        def snapshot(request):
            value=copy.deepcopy(self.dependencies)
            value['recovery']=({'config':str(self.base/'recovery.json'),'configSha256':'c'*64} if request['mode']=='managed' else None)
            return value,self.modules
        self.manager.supervisor=SimpleNamespace(snapshot=mock.Mock(side_effect=snapshot),prove_route=mock.Mock())
        self.request=self.manager.request('unmanaged','https://recovery.example',unmanaged_adoption=True)
        approvals=self.namespace/'recovery-admission-approvals';approvals.mkdir(mode=0o700)
        self.authorization=approvals/'approval.json'
        self.authorization_sha=None
        self.fence=self.namespace/self.layout.PURPOSES['credential-fence']
        with self.host.credential_fence_lock(self.root,'local'):pass

    def review(self,request=None):return self.manager.review(request or self.request)
    def authorize(self,plan):
        value={'schema':'orbis.recovery-admission-authorization.v1','planSha256':P.digest(plan),'installationId':plan['dependencies']['installationId'],
               'root':str(self.root),'context':'local','mode':plan['request']['mode'],'approvalId':'d'*64}
        self.authorization.write_bytes(P._encoded(value));self.authorization.chmod(0o600)
        self.authorization_sha=P.digest(self.authorization.read_bytes())
        return P.digest(plan)
    def apply(self,plan,request=None):
        return self.manager.apply(request or self.request,approved_plan_sha256=P.digest(plan),authorization=self.authorization,authorization_sha256=self.authorization_sha)
    def hold(self):
        with self.host.credential_fence_lock(self.root,'local') as guard:return guard.read()
    def record(self):
        active=self.namespace/P.INTENT
        if active.exists():return json.loads(active.read_bytes())
        records=tuple(p for p in self.namespace.glob('recovery-admission-*.json') if p.name!=P.HISTORY)
        self.assertEqual(len(records),1)
        return json.loads(records[0].read_bytes())
    def history(self):return json.loads((self.namespace/P.HISTORY).read_bytes())
    def finish(self,request=None):
        plan=self.review(request);self.authorize(plan);self.apply(plan,request);return plan

    def storage_fixture(self):
        @dataclass(frozen=True)
        class Upgrade:
            plan: bytes
            predecessor: bytes
            bridge: bytes
            history: bytes

        config = self.config/P.C.CONFIG_NAME
        config_body = P._encoded({'mode':'managed','origin':'https://recovery.example','fixture':True})
        config.write_bytes(config_body)
        config.chmod(0o600)
        prior = {'schema':'legacy-storage-fixture','installationId':'a'*64,'generation':7,'configSha256':P.digest(config_body)}
        history = {**prior,'schema':'stable-storage-fixture','generation':8}
        predecessor = P._encoded(prior)
        previous_hash = P.digest(predecessor)
        bridge = P._encoded({'previousFloorSha256':previous_hash,'roles':'synthetic storage observation'})
        plan = P.canonical({'installationId':prior['installationId'],'generation':8,
                            'previousFloorSha256':previous_hash,'bridgeSha256':P.digest(bridge),'mainCreationTransition':None})
        upgrade = Upgrade(plan,predecessor,bridge,P._encoded(history))
        history_path = self.namespace/P.HISTORY
        history_path.write_bytes(predecessor)
        history_path.chmod(0o600)
        publisher = 'b'*64

        @contextmanager
        def snapshot():
            if history_path.read_bytes() != predecessor or (self.namespace/P.STORAGE_INTENT).exists():
                raise ValueError('read-only review must observe the old floor')
            yield SimpleNamespace(_value=prior, report=SimpleNamespace(
                classification='record-consistent', history_sha256=previous_hash))

        @contextmanager
        def prepare(_, *, publication_operation, creation_transition=None):
            if publication_operation != publisher:
                raise ValueError('wrong publisher')
            yield upgrade

        @contextmanager
        def verify(actual, *, publication_operation):
            def check():
                if (actual != upgrade or publication_operation != publisher
                        or history_path.read_bytes() not in (upgrade.predecessor,upgrade.history)):
                    raise ValueError('wrong durable storage transition')
            check()
            yield check
            check()

        @contextmanager
        def storage_floor(observed):
            if observed != json.loads(config_body):
                raise ValueError('changed protected configuration')
            module = SimpleNamespace(StorageUpgrade=Upgrade, prepare_storage_upgrade=prepare,
                ARCHIVE='credential-floor-history', storage=SimpleNamespace(BRIDGE_DIRECTORY='credential-storage-history'))
            reader = SimpleNamespace(snapshot=snapshot, verify_storage_upgrade=verify)
            yield module, reader, lambda candidate: self.assertEqual(candidate, prior)

        self.manager.supervisor.storage_floor = storage_floor
        packet=P._encoded({'schema':'orbis.credential-storage-upgrade-packet.v1','publisher':publisher,
                           'payload':{name:base64.b64encode(getattr(upgrade,name)).decode('ascii') for name in P.STORAGE_FILES}})
        packet_path=self.authorization.parent/(P.digest(plan)+'.storage-packet.json')
        packet_path.write_bytes(packet)
        packet_path.chmod(0o600)
        approved = {'schema':'orbis.credential-storage-upgrade-approval.v1','planSha256':P.digest(plan),
                    'packetSha256':P.digest(packet), 'installationId':prior['installationId'],
                    'root':str(self.root),'context':'local','approvalId':'c'*64}
        self.authorization.write_bytes(P._encoded(approved))
        self.authorization.chmod(0o600)
        self.authorization_sha = P.digest(self.authorization.read_bytes())
        return SimpleNamespace(upgrade=upgrade,config=config,config_body=config_body,history=history_path,publisher=publisher,
            packet=packet_path,
            archive=self.namespace/'credential-floor-history'/(previous_hash+'.json'),
            bridge=self.namespace/'credential-storage-history'/(P.digest(bridge)+'.json'))

    def storage_apply(self, fixture, **changes):
        args = {'approved_plan_sha256':P.digest(fixture.upgrade.plan),'authorization':self.authorization,
                'authorization_sha256':self.authorization_sha}
        return self.manager.apply_storage(fixture.publisher, **{**args,**changes})

    def test_ordinary_terminal_intent_archives_and_resumes_without_a_stale_floor_hold(self):
        plan=self.review()
        self.authorize(plan)
        guard_type=self.host.CREDENTIAL_FENCE._Guard
        finish=guard_type.finish
        def interrupt(guard,*args,**kwargs):
            self.assertTrue(self.fence.exists())
            self.assertFalse((self.namespace/P.INTENT).exists())
            self.assertEqual(self.record()['phase'],'complete')
            raise InterruptedError('fixture after retirement and before fence finish')
        with mock.patch.object(guard_type,'finish',interrupt), self.assertRaises(InterruptedError):
            self.apply(plan)
        self.assertIsNotNone(self.hold())
        self.assertFalse((self.namespace/P.INTENT).exists())
        self.assertEqual(guard_type.finish,finish)
        self.assertEqual(self.apply(plan)['state'],'complete')
        self.assertEqual(self.history()['generation'],1)
        self.assertIsNone(self.hold())

    def test_storage_migration_exact_review_commit_and_completed_replay(self):
        fixture = self.storage_fixture()
        before = set(self.namespace.iterdir())
        plan = self.manager.review_storage(fixture.publisher)
        self.assertEqual(plan['planSha256'], P.digest(fixture.upgrade.plan))
        self.assertEqual(set(self.namespace.iterdir()),before)
        with self.assertRaises(ValueError):
            self.storage_apply(fixture, approved_plan_sha256='0'*64)
        self.assertEqual(set(self.namespace.iterdir()),before)
        result = self.storage_apply(fixture)
        self.assertEqual(result['generation'],8)
        self.assertEqual(fixture.archive.read_bytes(),fixture.upgrade.predecessor)
        self.assertEqual(fixture.bridge.read_bytes(),fixture.upgrade.bridge)
        self.assertEqual(fixture.history.read_bytes(),fixture.upgrade.history)
        self.assertEqual(fixture.config.read_bytes(),fixture.config_body)
        self.assertIsNone(self.hold())
        self.assertFalse((self.namespace/P.STORAGE_INTENT).exists())
        before_inode = fixture.history.stat().st_ino
        self.assertEqual(self.storage_apply(fixture),result)
        self.assertEqual(fixture.history.stat().st_ino,before_inode)

    def test_storage_migration_fence_exists_before_first_save_and_packet_recovers_fence_only(self):
        fixture = self.storage_fixture()
        saved = P._write_storage
        def cut_before_write(authority,directory,name,body,*,previous):
            if name==P.STORAGE_INTENT:
                self.assertTrue(self.fence.exists())
                self.assertFalse((self.namespace/P.STORAGE_INTENT).exists())
                self.assertFalse((self.namespace/('.'+P.STORAGE_INTENT+'.pending')).exists())
                raise InterruptedError('fixture after durable fence before first intent write')
            return saved(authority,directory,name,body,previous=previous)
        with mock.patch.object(P,'_write_storage',side_effect=cut_before_write), self.assertRaises(InterruptedError):
            self.storage_apply(fixture)
        guard=self.hold()
        self.assertIsNotNone(guard)
        self.assertFalse((self.namespace/P.STORAGE_INTENT).exists())
        packet=fixture.packet.read_bytes()
        fixture.packet.write_bytes(packet+b' ')
        with self.assertRaises(ValueError):
            self.storage_apply(fixture)
        self.assertEqual(self.hold(),guard)
        fixture.packet.write_bytes(packet)
        result=self.storage_apply(fixture)
        self.assertEqual(result['generation'],8)
        self.assertIsNone(self.hold())

    def test_storage_first_intent_exact_partial_replays_only_under_its_existing_fence(self):
        fixture=self.storage_fixture()
        saved=P._write_storage
        pending=self.namespace/('.'+P.STORAGE_INTENT+'.pending')
        def cut_after_temporary(authority,directory,name,body,*,previous):
            if name==P.STORAGE_INTENT:
                self.assertTrue(self.fence.exists())
                pending.write_bytes(body)
                pending.chmod(0o600)
                raise InterruptedError('fixture after exact temporary before first intent rename')
            return saved(authority,directory,name,body,previous=previous)
        with mock.patch.object(P,'_write_storage',side_effect=cut_after_temporary), self.assertRaises(InterruptedError):
            self.storage_apply(fixture)
        self.assertTrue(pending.exists())
        self.assertIsNotNone(self.hold())
        self.assertEqual(self.storage_apply(fixture)['generation'],8)
        self.assertFalse(pending.exists())

    def test_storage_migration_preserves_fence_and_resumes_after_exact_stage_interruptions(self):
        fixture = self.storage_fixture()
        writes = P._write_storage
        milestones = [
            lambda name, body: name==fixture.archive.name,
            lambda name, body: name==fixture.bridge.name,
            lambda name, body: name==P.HISTORY,
            lambda name, body: name==P.STORAGE_INTENT and json.loads(body)['phase']=='config-verified',
            lambda name, body: name==P.STORAGE_COMPLETE,
        ]
        for index, is_fault in enumerate(milestones):
            def inject(authority, directory, name, body, *, previous):
                writes(authority,directory,name,body,previous=previous)
                if is_fault(name,body):
                    raise InterruptedError('fixture after durable write')
            with self.subTest(phase=index), mock.patch.object(P,'_write_storage',side_effect=inject):
                with self.assertRaises(InterruptedError):
                    self.storage_apply(fixture)
                self.assertIsNotNone(self.hold())
                self.assertEqual(fixture.config.read_bytes(),fixture.config_body)
                self.assertTrue((self.namespace/P.STORAGE_INTENT).is_file())
        original_approval = self.base/'preserved-storage-approval'
        self.authorization.rename(original_approval)
        shutil.copyfile(original_approval,self.authorization)
        self.authorization.chmod(0o600)
        with self.assertRaises(ValueError):
            self.storage_apply(fixture)
        self.assertIsNotNone(self.hold())
        original_approval.replace(self.authorization)
        self.assertEqual(self.storage_apply(fixture)['generation'],8)
        self.assertEqual(fixture.archive.read_bytes(),fixture.upgrade.predecessor)
        self.assertEqual(fixture.history.read_bytes(),fixture.upgrade.history)
        self.assertIsNone(self.hold())

    def test_storage_migration_rejects_wrong_partial_or_rollback_and_keeps_evidence(self):
        fixture = self.storage_fixture()
        writes = P._write_storage
        def inject(authority, directory, name, body, *, previous):
            if name==P.HISTORY:
                partial=fixture.history.with_name('.'+P.HISTORY+'.pending')
                partial.write_bytes(b'unmatched interrupted file')
                partial.chmod(0o600)
                raise InterruptedError('fixture partial')
            return writes(authority,directory,name,body,previous=previous)
        with mock.patch.object(P,'_write_storage',side_effect=inject), self.assertRaises(InterruptedError):
            self.storage_apply(fixture)
        partial=fixture.history.with_name('.'+P.HISTORY+'.pending')
        with self.assertRaises(ValueError):
            self.storage_apply(fixture)
        self.assertEqual(partial.read_bytes(),b'unmatched interrupted file')
        self.assertIsNotNone(self.hold())
        partial.write_bytes(fixture.upgrade.history)
        self.assertEqual(self.storage_apply(fixture)['generation'],8)
        self.assertFalse(partial.exists())
        fixture.history.write_bytes(fixture.upgrade.predecessor)
        with self.assertRaises(ValueError):
            self.storage_apply(fixture)
        self.assertEqual(fixture.history.read_bytes(),fixture.upgrade.predecessor)
        self.assertEqual(fixture.archive.read_bytes(),fixture.upgrade.predecessor)
        self.assertEqual(fixture.config.read_bytes(),fixture.config_body)

    def test_review_is_read_only_and_exact_request_required(self):
        before=sorted(self.namespace.iterdir());plan=self.review()
        self.assertEqual(sorted(self.namespace.iterdir()),before);self.assertIsNone(plan['journal']);self.assertIsNone(self.hold())
        for request in [{**self.request,'unknown':True},{**self.request,'unmanagedAdoption':None},{**self.request,'mode':'guess'}]:
            with self.assertRaises(ValueError):self.review(request)

    def test_missing_route_never_selects_unmanaged_and_origin_requires_https(self):
        for args in [('unmanaged','https://recovery.example'),('managed','http://recovery.example'),('managed','https://recovery.example/path')]:
            with self.assertRaises(ValueError):self.manager.request(*args)
        with self.assertRaises(ValueError):self.manager.request('managed','https://recovery.example',unmanaged_adoption=True)

    def test_approval_required_exact_root_private_external_receipt(self):
        plan=self.review();self.authorize(plan)
        self.authorization.chmod(0o644)
        with self.assertRaises(ValueError):self.apply(plan)
        self.assertFalse((self.namespace/P.INTENT).exists());self.assertIsNone(self.hold())
        self.authorization.chmod(0o600)
        for mutate in [('context','other'),('planSha256','f'*64),('installationId','f'*64),('mode','managed')]:
            value=json.loads(self.authorization.read_bytes());value[mutate[0]]=mutate[1];self.authorization.write_bytes(P._encoded(value))
            self.authorization_sha=P.digest(self.authorization.read_bytes())
            with self.assertRaises(ValueError):self.apply(plan)
            self.authorize(plan)
        source=self.authorization;self.authorization=self.root/'approval.json';self.authorization.write_bytes(source.read_bytes());self.authorization.chmod(0o600)
        with self.assertRaises(ValueError):self.apply(plan)

    def test_approval_outside_fixed_custody_or_on_an_aliased_mount_refuses(self):
        plan=self.review();self.authorize(plan);original=self.authorization
        self.authorization=self.base/'external.json';self.authorization.write_bytes(original.read_bytes());self.authorization.chmod(0o600)
        with self.assertRaises(ValueError):self.apply(plan)
        self.authorization=original
        def filesystem(path):return {'fsType':'ext4','identity':'nested-alias' if Path(path)==original else 'namespace-mount'}
        with mock.patch.object(self.layout.R,'filesystem',side_effect=filesystem),self.assertRaises(ValueError):self.apply(plan)
        self.assertFalse((self.namespace/P.INTENT).exists())

    def test_changed_plan_refuses_before_intent_or_hold(self):
        plan=self.review();self.authorize(plan);self.dependencies['installationId']='f'*64
        with self.assertRaises(ValueError):self.apply(plan)
        self.assertFalse((self.namespace/P.INTENT).exists());self.assertIsNone(self.hold())

    def test_actual_journal_created_only_in_fresh_empty_root_directory(self):
        plan=self.finish();record=self.record();self.assertEqual(record['phase'],'complete')
        self.assertEqual(self.history()['generation'],1);self.assertIsNone(self.hold())
        self.assertEqual(json.loads((self.config/P.C.CONFIG_NAME).read_bytes()),record['candidate'])
        if self.modules['writer_journal'].__class__ is SimpleNamespace:
            self.assertEqual([(create,names) for _,create,names in FixtureJournal.calls],[(True,[])])
        self.assertEqual(P.digest(plan),record['planSha256'])

    def test_existing_unadmitted_journal_is_never_initialized_or_adopted(self):
        journal=self.namespace/'credential-journal';journal.mkdir(mode=0o700)
        for name in ('', 'state.json'):
            if name:(journal/name).write_text('preserve')
            with self.assertRaises(ValueError):self.review()
        self.assertEqual((journal/'state.json').read_text(),'preserve');self.assertIsNone(self.hold())

    def test_managed_transition_retains_existing_journal_and_monotonic_history(self):
        self.finish();journal=self.namespace/'credential-journal';before={p.name:p.stat().st_ino for p in journal.iterdir()}
        managed=self.manager.request('managed','https://recovery.example');plan=self.review(managed);self.authorize(plan);self.apply(plan,managed)
        self.assertEqual(before,{p.name:p.stat().st_ino for p in journal.iterdir()})
        self.assertTrue(self.history()['managedEver']);self.assertEqual(self.history()['generation'],2)
        self.manager.supervisor.prove_route.assert_called_once()
        with self.assertRaises(ValueError):self.review()
        if self.modules['writer_journal'].__class__ is SimpleNamespace:self.assertEqual(sum(create for _,create,_ in FixtureJournal.calls),1)

    def test_managed_history_survives_missing_config_and_prohibits_downgrade(self):
        self.finish(self.manager.request('managed','https://recovery.example'))
        (self.config/P.C.CONFIG_NAME).unlink()
        with self.assertRaises(ValueError):self.review()
        self.assertTrue(self.history()['managedEver'])

    def test_runtime_version_and_protocol_floors_cannot_downgrade(self):
        self.finish()
        for key,value in [('writerProtocol',0),('sentinel',dict(self.dependencies['sentinel'],version='0.8.9'))]:
            original=self.dependencies[key];self.dependencies[key]=value
            with self.assertRaises(ValueError):self.review()
            self.dependencies[key]=original

    def test_complete_replay_is_idempotent_without_repeating_route_or_generation(self):
        request=self.manager.request('managed','https://recovery.example');plan=self.finish(request)
        before=(self.namespace/P.HISTORY).read_bytes();self.manager.supervisor.prove_route.reset_mock()
        self.apply(plan,request);self.assertEqual((self.namespace/P.HISTORY).read_bytes(),before)
        self.manager.supervisor.prove_route.assert_not_called();self.assertIsNone(self.hold())

    def test_fence_precedes_initialization_history_and_last_config_publication(self):
        plan=self.review();self.authorize(plan);original=P._write;events=[]
        def write(authority,directory,name,body,*,previous):
            events.append(name)
            if name!=P.INTENT:self.assertTrue(self.fence.exists())
            if name==P.C.CONFIG_NAME:
                self.assertTrue((self.namespace/P.HISTORY).exists());self.assertEqual(self.record()['phase'],'history-ready')
            return original(authority,directory,name,body,previous=previous)
        with mock.patch.object(P,'_write',side_effect=write):self.apply(plan)
        self.assertLess(events.index(P.HISTORY),events.index(P.C.CONFIG_NAME));self.assertTrue(events[-1].startswith('recovery-admission-'));self.assertFalse((self.namespace/P.INTENT).exists())

    def test_route_proof_failure_preserves_journal_and_hold_no_config(self):
        request=self.manager.request('managed','https://recovery.example');plan=self.review(request);self.authorize(plan)
        self.manager.supervisor.prove_route.side_effect=ValueError('offline route not qualified')
        with self.assertRaises(ValueError):self.apply(plan,request)
        self.assertEqual(self.record()['phase'],'journal-ready');self.assertIsNotNone(self.hold());self.assertFalse((self.config/P.C.CONFIG_NAME).exists())
        self.manager.supervisor.prove_route.side_effect=None;self.apply(plan,request);self.assertIsNone(self.hold())

    def test_drift_after_journal_prevents_publication_and_keeps_hold(self):
        request=self.manager.request('managed','https://recovery.example');plan=self.review(request);self.authorize(plan)
        self.manager.supervisor.prove_route.side_effect=lambda _:self.dependencies.update(installationId='f'*64)
        with self.assertRaises(ValueError):self.apply(plan,request)
        self.assertIsNotNone(self.hold());self.assertFalse((self.config/P.C.CONFIG_NAME).exists())

    def test_interrupted_config_publication_can_resume_exact_plan_only(self):
        plan=self.review();self.authorize(plan);original=P._write
        def write(authority,directory,name,body,*,previous):
            if name==P.C.CONFIG_NAME:raise OSError('injected before config publication')
            return original(authority,directory,name,body,previous=previous)
        with mock.patch.object(P,'_write',side_effect=write),self.assertRaises(OSError):self.apply(plan)
        self.assertEqual(self.record()['phase'],'history-ready');self.assertEqual(self.history()['generation'],1);self.assertIsNotNone(self.hold())
        self.apply(plan);self.assertEqual(self.history()['generation'],1);self.assertIsNone(self.hold())

    def test_unrecognized_hold_and_changed_approval_cannot_resume(self):
        plan=self.review();self.authorize(plan)
        with self.host.credential_fence_lock(self.root,'local') as guard:guard.begin('1'*64,'2'*64)
        with self.assertRaises(ValueError):self.apply(plan)
        self.assertFalse((self.namespace/P.INTENT).exists())

    def test_partial_directory_creation_is_not_deleted_or_adopted(self):
        plan=self.review();self.authorize(plan);original=P._write
        def write(authority,directory,name,body,*,previous):
            if name==P.INTENT and json.loads(body)['phase']=='journal-allocated':raise OSError('allocation intent failure')
            return original(authority,directory,name,body,previous=previous)
        with mock.patch.object(P,'_write',side_effect=write),self.assertRaises(OSError):self.apply(plan)
        self.assertEqual(self.record()['phase'],'intent');journal=self.namespace/'credential-journal';self.assertTrue(journal.is_dir())
        with self.assertRaises(ValueError):self.apply(plan)
        self.assertIsNotNone(self.hold());self.assertEqual(list(journal.iterdir()),[])

    def test_active_or_replaced_existing_journal_refuses_review(self):
        self.finish();journal=self.namespace/'credential-journal'
        if isinstance(self.modules['writer_journal'],SimpleNamespace):
            state=json.loads((journal/'state.json').read_bytes());state['active']='a'*64;(journal/'state.json').write_bytes(P.canonical(state))
            with self.assertRaises(ValueError):self.review()
        (journal/'state.json').unlink()
        with self.assertRaises((ValueError,OSError)):self.review()

    def test_staged_write_preserves_partial_bytes_after_fsync_failure(self):
        with P._directory(self.config) as directory,mock.patch.object(P.os,'fsync',side_effect=OSError('fsync failed')):
            with self.assertRaises(OSError):P._write(self.host.AUTHORITY,directory,'new.json',b'preserve',previous=None)
        self.assertFalse((self.config/'new.json').exists());self.assertEqual((self.config/'.new.json.pending').read_bytes(),b'preserve')
        with P._directory(self.config) as directory,self.assertRaises(FileExistsError):P._write(self.host.AUTHORITY,directory,'new.json',b'other',previous=None)

    def test_directory_guard_allows_writes_but_rejects_alias_modes_replacement_and_mount_change(self):
        with P._directory(self.config) as fd:(self.config/'expected').write_text('ok');self.assertEqual(os.fstat(fd).st_ino,self.config.stat().st_ino)
        alias=self.base/'alias';alias.symlink_to(self.config,target_is_directory=True)
        with self.assertRaises(ValueError):
            with P._directory(alias):pass
        self.config.chmod(0o755)
        with self.assertRaises(ValueError):
            with P._directory(self.config):pass
        self.config.chmod(0o700)
        with self.assertRaises(ValueError):
            with P._directory(self.config):self.config.rename(self.base/'old');self.config.mkdir(mode=0o700)
        sequence=iter(range(1000))
        with mock.patch.object(P,'_mount_id',side_effect=lambda _:next(sequence)),self.assertRaises(ValueError):
            with P._directory(self.config):pass

    def test_protected_file_hardlinks_and_symlinks_refuse(self):
        target=self.config/'value';target.write_text('original');target.chmod(0o600);alias=self.config/'alias';os.link(target,alias)
        with P._directory(self.config) as fd,self.assertRaises(ValueError):P._read(self.host.AUTHORITY,fd,'value')
        alias.unlink();alias.symlink_to(target)
        with P._directory(self.config) as fd,self.assertRaises(OSError):P._read(self.host.AUTHORITY,fd,'alias')

    def test_independent_authorization_identity_replacement_refuses_resume(self):
        request=self.manager.request('managed','https://recovery.example');plan=self.review(request);self.authorize(plan)
        self.manager.supervisor.prove_route.side_effect=ValueError('route')
        with self.assertRaises(ValueError):self.apply(plan,request)
        body=self.authorization.read_bytes();self.authorization.rename(self.base/'old-approval');self.authorization.write_bytes(body);self.authorization.chmod(0o600)
        self.manager.supervisor.prove_route.side_effect=None
        with self.assertRaises(ValueError):self.apply(plan,request)
        self.assertIsNotNone(self.hold())



    def existing_retirement_fixture(self):
        # Explicit historical-proof observation port. The real private proof
        # reader/tombstone and actual peer/kernel are tested in their own join.
        reference={'schema':'orbis.existing-ownership-proof.v1','proof':{'sha256':'f'*64},'installationId':'a'*64}
        self.dependencies['existingOwnership']=reference
        retired=self.namespace/'fixture-existing-retired.json'
        calls=[]
        def retire(service,guard,expected,*,plan_sha256,authorization_sha256):
            self.assertEqual(expected,reference)
            self.assertIsNotNone(guard.read())
            self.assertFalse((self.config/P.C.CONFIG_NAME).exists())
            self.assertFalse((self.namespace/P.HISTORY).exists())
            self.assertFalse((self.namespace/'credential-journal').exists())
            calls.append((plan_sha256,authorization_sha256))
            if not retired.exists():
                self.assertFalse((self.namespace/P.INTENT).exists())
                retired.write_bytes(P.canonical(reference));retired.chmod(0o600)
        module=SimpleNamespace(retirement_reference=lambda service:copy.deepcopy(reference),retire_for_admission=retire)
        load=P.load
        patcher=mock.patch.object(P,'load',side_effect=lambda name,key:module if name=='orbis-host-existing-ownership.py' else load(name,key))
        patcher.start();self.addCleanup(patcher.stop)
        return retired,calls

    def test_existing_proof_retires_after_exact_approval_and_before_any_admission_publication(self):
        retired,calls=self.existing_retirement_fixture()
        plan=self.review();self.authorize(plan)
        self.assertFalse(retired.exists());self.assertIsNone(self.hold())
        self.assertEqual(self.apply(plan)['state'],'complete')
        self.assertTrue(retired.exists());self.assertGreaterEqual(len(calls),1);self.assertIsNone(self.hold())
        self.assertEqual(self.apply(plan)['state'],'complete')

    def test_rejected_admission_approval_cannot_retire_existing_proof(self):
        retired,calls=self.existing_retirement_fixture()
        plan=self.review();self.authorize(plan);self.authorization.write_bytes(b'{}')
        with self.assertRaises(ValueError):self.apply(plan)
        self.assertFalse(retired.exists());self.assertEqual(calls,[]);self.assertIsNone(self.hold())

    def test_retirement_before_intent_interruption_resumes_same_approved_plan(self):
        retired,calls=self.existing_retirement_fixture()
        plan=self.review();self.authorize(plan);write=P._write
        def stop(authority,directory,name,body,*,previous):
            if name==P.INTENT and previous is None:raise InterruptedError()
            return write(authority,directory,name,body,previous=previous)
        with mock.patch.object(P,'_write',side_effect=stop),self.assertRaises(InterruptedError):self.apply(plan)
        self.assertTrue(retired.exists());self.assertIsNotNone(self.hold());self.assertFalse((self.namespace/P.INTENT).exists())
        self.assertEqual(self.apply(plan)['state'],'complete');self.assertIsNone(self.hold())
        self.assertEqual(len(set(calls)),1)


class QualificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name).resolve();self.base.chmod(0o700)
        self.root=self.base/'installation';self.root.mkdir(mode=0o700)
        self.runtime_root=self.base/'installed';self.runtime_root.mkdir(mode=0o755)
        self.state=self.base/'state';self.state.mkdir(mode=0o700)
        self.service=SimpleNamespace(HOST=SERVICE.HOST,root=self.root,context='local',state_dir=self.state,current_manifest=lambda:{'tag':'1.0.0'})
        self.supervisor=P.Supervisor(self.service)
        for target,name,value in [(P,'OWNER',os.geteuid()),(P.C,'OWNER',os.geteuid()),(SERVICE.HOST.AUTHORITY,'OWNER',os.geteuid()),(P,'ROOT',self.runtime_root),(P,'STATE',self.state)]:
            patch=mock.patch.object(target,name,value);patch.start();self.addCleanup(patch.stop)
        self.release=self.runtime_root/'releases'/'1.0.0';self.release.mkdir(parents=True,mode=0o755)
        (self.runtime_root/'releases').chmod(0o755)
        self.runtime=self.release/'src'/'orbis_sentinel';self.runtime.mkdir(parents=True,mode=0o755);self.runtime.parent.chmod(0o755)
        for name in P.C.RUNTIME_FILES:(self.runtime/name).write_text('HOST_WRITER_PROTOCOL=1\n' if name=='writer_broker.py' else '\n')
        self.selector=self.runtime_root/'current';self.selector.symlink_to('releases/1.0.0')
        self.receipt()
        self.main={'Id':'a'*64,'Image':'sha256:'+'b'*64,'Config':{'Image':'published@sha256:'+'c'*64,'Volumes':None,
                   'Labels':{'com.docker.compose.project':'runtipi','com.docker.compose.service':'runtipi','com.docker.compose.project.working_dir':str(self.root),
                             'io.orbis.credential-writer-protocol':P.MAIN_PROTOCOL},'Env':['ORBIS_SENTINEL_RECOVERY_ORIGIN=https://recovery.example']},
                   'State':{'Running':False,'Paused':False,'Restarting':False,'Dead':False,'Pid':0,'Status':'exited'},'HostConfig':{},'Mounts':[],'Path':'entrypoint','Args':[]}
        def docker(context,args,root):
            return SimpleNamespace(returncode=0,stdout=json.dumps('daemon-id' if args[0]=='info' else self.main))
        patch=mock.patch.object(P,'_run',return_value=b'\"daemon-id\"');patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.object(SERVICE.HOST,'docker',side_effect=docker);patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.object(SERVICE.HOST,'controller_reference',return_value=self.main['Config']['Image']);patch.start();self.addCleanup(patch.stop)

    def receipt(self):
        files={p.relative_to(self.release).as_posix():{'bytes':p.stat().st_size,'sha256':P.digest(p.read_bytes())} for p in self.release.rglob('*') if p.is_file()}
        value={'schema':'orbis-sentinel.installation.v1','version':'1.0.0','sha256':'d'*64,'sourceCommit':'e'*40,'files':files}
        target=self.state/'installed.json';target.write_bytes(P._encoded(value));target.chmod(0o600)

    def bootstrap_fixture(self):
        source = Path(os.environ['ORBIS_RECOVERY_TEST_RUNTIME'])

        def patch(target, name, **values):
            patcher = mock.patch.object(target, name, **values)
            self.addCleanup(patcher.stop)
            return patcher.start()

        def write(path, body, mode=0o600):
            path.write_bytes(body)
            path.chmod(mode)

        for name in P.C.RUNTIME_FILES | {'bootstrap_source.py', 'credential_storage.py', 'credential_floor.py',
                                        'host_source_publication.py'}:
            write(self.runtime / name, (source / name).read_bytes(), 0o644)
        launcher = self.release / 'bin' / 'orbis-sentinel'
        launcher.parent.mkdir(mode=0o755)
        write(launcher, b'# retained launcher fixture\n', 0o755)
        self.receipt()
        self.service.require_credential_idle = mock.Mock()
        paths = {name: self.base / name.lower() for name in ('UNITS', 'RECOVERY', 'HOST_SOURCE', 'PROC')}
        for path in paths.values():
            path.mkdir(mode=0o700)
        recovery = paths['RECOVERY']
        env_path, config_path, interpreter = self.base / 'recovery.env', recovery / 'config.json', self.base / 'python3'
        paths.update(RECOVERY_ENV=env_path, RECOVERY_CONFIG=config_path, RECOVERY_SETUP=self.base / 'recovery-setup.json',
                     HOST_ENV=self.base / 'host.env',
                     HOST_SOCKET=self.base / 'host.sock', OBSERVER_SOCKET=self.base / 'observer.sock',
                     RECOVERY_INTERPRETER=interpreter)
        for name, path in paths.items():
            patch(P, name, new=path)
        write(interpreter, b'# retained interpreter fixture\n', 0o755)
        patch(self.supervisor.layout, 'STATE_ROOT', new=self.state)
        patch(self.supervisor.layout, '_operator')
        patch(self.supervisor.layout, 'read', return_value={'schema': 'reviewed-root-layout'})
        patch(self.supervisor.layout.R, 'filesystem', return_value={'fsType': 'ext4'})
        patch(SERVICE.HOST.CREDENTIAL_FENCE, 'OWNER', new=os.geteuid())
        patch(P, '_root')
        namespace = self.supervisor.layout.namespace(self.root)
        namespace.mkdir(mode=0o700, parents=True)
        journal = namespace / 'credential-journal'
        journal.mkdir(mode=0o700)
        origin = 'https://recovery.example'
        self.main['HostConfig']['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}
        installation, _, _ = self.supervisor._main(origin, storage_transition=True)
        host_source = paths['HOST_SOURCE']
        names = ('orbis-host-service.py', 'orbis-host.py', 'orbis-host-layout.py', 'orbis-host-retained-authority.py',
                 'orbis-host-credential-peer.py', 'orbis-host-credential-fence.py', 'orbis-host-credential-service.py',
                 'orbis-host-recovery-admission.py', 'orbis-host-recovery-source.py')
        for name in names:
            write(host_source / name, Path(__file__).with_name(name).read_bytes())
        patch(P, '__file__', new=str(host_source / 'orbis-host-recovery-admission.py'))
        write(paths['HOST_ENV'], (f'ORBIS_SERVICE_SOURCE="{host_source / "orbis-host-service.py"}"\n'
                                  f'ORBIS_ROOT="{self.root}"\nORBIS_DOCKER_CONTEXT="local"\n').encode())
        host_unit = paths['UNITS'] / 'orbis-host.service'
        write(host_unit, (Path(__file__).parent.parent / 'packaging/systemd/orbis-host.service').read_bytes(), 0o644)
        recovery_unit = paths['UNITS'] / P.UNIT
        write(recovery_unit, (source.parents[1] / 'packaging/systemd' / P.UNIT).read_bytes(), 0o644)
        write(env_path, (f'ORBIS_SENTINEL_RECOVERY_RUNTIME={launcher}\n'
                         f'ORBIS_SENTINEL_RECOVERY_PROFILE={config_path}\n').encode())
        write(config_path, P._encoded({'schema': 'orbis.sentinel-recovery-config.v1', 'directory': str(recovery),
            'imageId': self.main['Image'], 'origin': origin, 'listenPort': 9443, 'statusSocket': '/run/orbis-sentinel/api.sock'}))
        proc = paths['PROC'] / '42'
        proc.mkdir(mode=0o700)
        inv = '7' * 32
        args = [str(interpreter), '-I', str(launcher), '--recovery-profile', str(config_path)]
        write(proc / 'cmdline', b'\0'.join(os.fsencode(arg) for arg in args) + b'\0')
        write(proc / 'environ', ('INVOCATION_ID=' + inv + '\0').encode())
        write(proc / 'cgroup', b'0::/system.slice/orbis-sentinel-recovery.service\n')
        write(proc / 'stat', b'42 (python3) ' + b'S ' + b'1 ' * 18 + b'800\n')
        status = (b'Uid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nNoNewPrivs:\t1\n' + b''.join(
            key + b':\t0000000000000000\n' for key in (b'CapInh', b'CapPrm', b'CapEff', b'CapBnd', b'CapAmb')))
        write(proc / 'status', status)
        (proc / 'exe').symlink_to(interpreter)
        unit_properties = {
            'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'running', 'FragmentPath': str(recovery_unit),
            'DropInPaths': '', 'NeedDaemonReload': 'no', 'MainPID': '42', 'ControlPID': '0', 'InvocationID': inv,
            'KillMode': 'control-group', 'User': 'root', 'Group': 'root', 'ProtectHome': 'yes',
            'ProtectProc': 'invisible', 'ProtectSystem': 'strict', 'NoNewPrivileges': 'yes', 'CapabilityBoundingSet': '',
            'ExecStart': '{ path=' + str(interpreter) + ' ; argv[]=' + str(interpreter) +
            ' -I ${ORBIS_SENTINEL_RECOVERY_RUNTIME} --recovery-profile ${ORBIS_SENTINEL_RECOVERY_PROFILE}' +
            ' ; ignore_errors=no ; start_time=[fixture] ; pid=42 ; status=0/0 }',
        }

        baseline = dict(unit_properties)

        def run(command, **_):
            if command[0] == '/usr/bin/docker':
                return b'"daemon-id"'
            self.assertEqual(command[0], '/usr/bin/systemctl')
            properties = unit_properties
            stopped = {**baseline, 'ActiveState': 'inactive', 'SubState': 'dead', 'MainPID': '0'}
            if command[-1] == 'orbis-host.service':
                properties = {**stopped, 'FragmentPath': str(host_unit)}
            elif command[-1] == 'orbis-host-observer.socket':
                properties = {**stopped, 'LoadState': 'not-found', 'FragmentPath': ''}
            fields = [item.split('=', 1)[1] for item in command if item.startswith('--property=')]
            return ''.join(f'{key}={properties[key]}\n' for key in fields).encode()

        patch(P, '_run', side_effect=run)
        prior = {'schema': 'orbis.host.credential-admission.v1', 'writerProtocol': P.C.PROTOCOL,
                 'root': str(self.root), 'context': 'local', 'installationId': installation, 'mode': 'unmanaged',
                 'origin': origin, 'recoveryEpoch': None, 'runtimeDirectory': str(self.runtime),
                 'runtimeFiles': {name: 'c'*64 for name in P.C.RUNTIME_FILES}, 'journalDirectory': str(journal),
                 'recoveryConfig': None, 'recoveryConfigSha256': None}
        admission = self.state / P.C.CONFIG_NAME
        write(admission, P._encoded(prior))
        prior_hash = P.digest(admission.read_bytes())
        history = namespace / P.HISTORY
        write(history, P._encoded({'schema': 'orbis.recovery-admission-history.v1', 'installationId': installation,
            'generation': 7, 'managedEver': False, 'mode': 'unmanaged', 'configSha256': prior_hash,
            'planSha256': 'd'*64, 'sentinelVersion': '1.0.0', 'writerProtocol': P.C.PROTOCOL}))
        with self.supervisor._held_runtime(storage_floor=True) as (_, modules, check):
            patch(modules['recovery_sessions'], '_OWNER_UID', new=os.geteuid())
            patch(modules['writer_journal'], '_OWNER_UID', new=os.geteuid())
            journal_class = modules['writer_journal'].WriterJournal
            journal_class(journal, create=True, validate_record=modules['writer_broker'].validate_record).close()
            patch(modules['credential_storage'], 'observe', side_effect=lambda directory: {'path': str(directory.path)})
            proof = mock.Mock(spec=['recheck'])

            @contextmanager
            def held_publication(*_, **__):
                yield proof

            publisher = patch(modules['host_source_publication'], 'read_completed_for_bootstrap_review',
                              side_effect=held_publication)
            check()
        return SimpleNamespace(manager=P.Admission(self.service), origin=origin, operation='a'*64, published='b'*64,
            receipt='c'*64, plan=recovery/'bootstrap'/('a'*64)/P.BOOTSTRAP_REVIEW_FILE, installation=installation,
            history=history, admission=admission, properties=unit_properties, proc=proc, publisher=publisher)

    @unittest.skipUnless(os.environ.get('ORBIS_RECOVERY_TEST_RUNTIME'), 'Set the real Sentinel source fixture path')
    def test_v1_bootstrap_review_stages_actual_bound_inputs_and_leaves_predecessor_unchanged(self):
        fixture = self.bootstrap_fixture()
        prior = (fixture.history.read_bytes(), fixture.admission.read_bytes())
        args = (fixture.operation, fixture.published, fixture.receipt, fixture.origin)
        result = fixture.manager.review_bootstrap(*args)
        plan = result['plan']
        self.assertEqual((plan['schema'], plan['installationId'], plan['previousGeneration']),
                         (P.BOOTSTRAP_REVIEW, fixture.installation, 7))
        self.assertEqual(plan['hostHistorySha256'], P.digest(prior[0]))
        self.assertEqual(plan['previousAdmissionSha256'], P.digest(prior[1]))
        self.assertEqual(plan['recovery']['process']['startTicks'], 800)
        self.assertEqual(plan['recovery']['effectiveSha256'], P.digest(fixture.properties))
        self.assertEqual(fixture.plan.read_bytes(), P.canonical(plan))
        self.assertEqual(result['planSha256'], P.digest(fixture.plan.read_bytes()))
        self.assertEqual(list(fixture.plan.parent.iterdir()), [fixture.plan])
        self.assertEqual(fixture.manager.review_bootstrap(*args), result)
        self.assertEqual((fixture.history.read_bytes(), fixture.admission.read_bytes()), prior)
        observed = fixture.publisher.call_args.kwargs
        self.assertEqual(fixture.publisher.call_args.args, (fixture.published,))
        self.assertEqual(observed['current']['main']['definitionSha256'], plan['main']['definitionSha256'])
        self.assertEqual(observed['receipt_sha256'], fixture.receipt)

    @unittest.skipUnless(os.environ.get('ORBIS_RECOVERY_TEST_RUNTIME'), 'Set the real Sentinel source fixture path')
    def test_marked_external_v1_bootstrap_review_uses_exact_raw_effective_profile(self):
        fixture = self.bootstrap_fixture()
        marker = {'schema':'orbis.sentinel-recovery-listener-setup.v1','operationId':'2'*64,
                  'installationId':fixture.installation,'origin':fixture.origin,
                  'configSha256':P.digest(P.RECOVERY_CONFIG.read_bytes())}
        P.RECOVERY_SETUP.write_bytes(P.canonical(marker))
        P.RECOVERY_SETUP.chmod(0o600)
        result = fixture.manager.review_bootstrap(fixture.operation, fixture.published, fixture.receipt, fixture.origin)
        self.assertEqual(result['plan']['recovery']['effectiveSha256'], P.digest(fixture.properties))

    @unittest.skipUnless(os.environ.get('ORBIS_RECOVERY_TEST_RUNTIME'), 'Set the real Sentinel source fixture path')
    def test_builtin_v2_bootstrap_review_holds_same_invocation_through_exec_status_reset(self):
        fixture = self.bootstrap_fixture()
        marker = {'schema':'orbis.sentinel-recovery-listener-setup.v2','operationId':'2'*64,
                  'installationId':fixture.installation,'origin':fixture.origin,
                  'configSha256':P.digest(P.RECOVERY_CONFIG.read_bytes()),
                  'transport':{'mode':'builtin-private-tls.v1','pairId':'3'*64}}
        P.RECOVERY_SETUP.write_bytes(P.canonical(marker))
        P.RECOVERY_SETUP.chmod(0o600)
        marker_sha = P.digest(P.RECOVERY_SETUP.read_bytes())
        reservation = P.RECOVERY/'listener-setup-store.json'
        reservation_body = P.canonical({'operationId':marker['operationId'],'markerSha256':marker_sha})
        reservation.write_bytes(reservation_body)
        reservation.chmod(0o600)

        prefix = fixture.properties['ExecStart'].split(' ; start_time=', 1)[0]
        active = prefix + ' ; start_time=[Fri 2026-11-20 05:20:59 UTC] ; stop_time=[n/a] ; pid=42 ; code=(null) ; status=0/0 }'
        reset = active.replace('[Fri 2026-11-20 05:20:59 UTC]', '[n/a]').replace('pid=42', 'pid=0')
        fixture.properties['ExecStart'] = active
        args = (fixture.operation, fixture.published, fixture.receipt, fixture.origin)
        first = fixture.manager.review_bootstrap(*args)
        self.assertEqual(first['plan']['recovery']['effectiveSha256'],
                         P.digest({**fixture.properties,'ExecStart':reset}))
        fixture.properties['ExecStart'] = reset
        self.assertEqual(fixture.manager.review_bootstrap(*args), first)
        for altered in (active.replace('pid=42', 'pid=43'), active.replace('pid=42', 'pid=0'),
                        active.replace('2026-11-20', '2026-02-30'), active.replace('Fri', 'Tue'),
                        reset.replace('pid=0', 'pid=42'), reset.replace('status=0/0', 'status=0/1'),
                        reset.replace('status=0/0', 'status=0/0 ; unknown=no'),
                        reset.replace('ignore_errors=no', 'ignore_errors=yes'),
                        reset.replace('--recovery-profile', '--other')):
            with self.subTest(altered=altered), mock.patch.dict(fixture.properties, {'ExecStart':altered}):
                with self.assertRaises(ValueError):
                    fixture.manager.review_bootstrap(*args)
        reservation.write_bytes(P.canonical({'operationId':marker['operationId'],'markerSha256':'0'*64}))
        with self.assertRaises(ValueError):
            fixture.manager.review_bootstrap(*args)
        reservation.write_bytes(reservation_body)

        marker_body = P.RECOVERY_SETUP.read_bytes()
        P.RECOVERY_SETUP.write_bytes(P.canonical({**marker,'installationId':'0'*64}))
        reservation.write_bytes(P.canonical({'operationId':marker['operationId'],
                                             'markerSha256':P.digest(P.RECOVERY_SETUP.read_bytes())}))
        with self.assertRaises(ValueError):
            fixture.manager.review_bootstrap(*args)
        P.RECOVERY_SETUP.write_bytes(marker_body)
        reservation.write_bytes(reservation_body)

        supervisor = fixture.manager.supervisor
        with supervisor._held_runtime(storage_floor=True) as (runtime, modules, _):
            with self.assertRaises(ValueError), supervisor.bootstrap_recovery(
                    fixture.origin, first['plan']['main'], runtime, modules, builtin_marker_sha='0'*64):
                self.fail('Crossed built-in plan entered the listener')
            with self.assertRaises((OSError, ValueError)), supervisor.bootstrap_recovery(
                    fixture.origin, first['plan']['main'], runtime, modules, builtin_marker_sha=marker_sha) as (_, check):
                P.RECOVERY_SETUP.rename(P.RECOVERY_SETUP.with_name('held-marker'))
                check()
            with self.assertRaises(ValueError):
                fixture.manager.review_bootstrap(*args)

    @unittest.skipUnless(os.environ.get('ORBIS_RECOVERY_TEST_RUNTIME'), 'Set the real Sentinel source fixture path')
    def test_v1_bootstrap_review_refuses_crossed_source_and_effective_unit_before_writing_plan(self):
        fixture = self.bootstrap_fixture()
        args = (fixture.operation, fixture.published, fixture.receipt, fixture.origin)
        for key, changed in (('FragmentPath', '/elsewhere.service'), ('DropInPaths', '/elsewhere.conf'),
                             ('NeedDaemonReload', 'yes'), ('ProtectHome', 'no'), ('CapabilityBoundingSet', 'cap_sys_admin'),
                             ('ExecStart', '{ path=/bin/false ; argv[]=/bin/false ; ignore_errors=no }')):
            with self.subTest(key=key), mock.patch.dict(fixture.properties, {key: changed}), self.assertRaises(ValueError):
                fixture.manager.review_bootstrap(*args)
        original = fixture.history.read_bytes()
        for changed in ({'installationId': 'f'*64}, {'managedEver': True}, {'configSha256': 'f'*64}):
            with self.subTest(changed=changed):
                fixture.history.write_bytes(P._encoded({**json.loads(original), **changed}))
                with self.assertRaises(ValueError):
                    fixture.manager.review_bootstrap(*args)
        admission = fixture.admission.read_bytes()
        crossed_admission = P._encoded({**json.loads(admission), 'context': 'foreign'})
        fixture.admission.write_bytes(crossed_admission)
        fixture.history.write_bytes(P._encoded({**json.loads(original), 'configSha256': P.digest(crossed_admission)}))
        with self.assertRaises(ValueError):
            fixture.manager.review_bootstrap(*args)
        fixture.admission.write_bytes(admission)
        fixture.history.write_bytes(original)
        cmdline = fixture.proc / 'cmdline'
        original_argv = cmdline.read_bytes()
        cmdline.write_bytes(original_argv.replace(b'--recovery-profile', b'--different-profile'))
        with self.assertRaises(ValueError):
            fixture.manager.review_bootstrap(*args)
        cmdline.write_bytes(original_argv)
        fixture.publisher.side_effect = ValueError('crossed retained publisher receipt')
        with self.assertRaises(ValueError):
            fixture.manager.review_bootstrap(*args)
        self.assertFalse(fixture.plan.parent.exists())

    def test_exact_root_runtime_inventory_and_six_hashes_load(self):
        value,modules=self.supervisor._runtime()
        self.assertEqual(value['runtimeDirectory'],str(self.runtime));self.assertEqual(set(value['runtimeFiles']),set(P.C.RUNTIME_FILES))
        self.assertEqual(modules['writer_broker'].HOST_WRITER_PROTOCOL,1)

    @unittest.skipUnless(os.environ.get('ORBIS_RECOVERY_TEST_RUNTIME'), 'Set the real Sentinel source fixture path')
    def test_storage_consumer_loads_real_exact_held_retained_module_closure(self):
        source = Path(os.environ['ORBIS_RECOVERY_TEST_RUNTIME'])
        extras = {'bootstrap_source.py','credential_storage.py','credential_floor.py','host_source_publication.py'}
        for name in P.C.RUNTIME_FILES | extras:
            shutil.copyfile(source/name,self.runtime/name)
        self.receipt()
        with self.assertRaises(ValueError):
            with self.supervisor._held_runtime(storage_floor=True) as (_,modules,check):
                self.assertTrue(modules['credential_floor'].SCHEMA.endswith('.v3'))
                self.assertEqual(modules['credential_floor'].storage,modules['credential_storage'])
                self.assertTrue(callable(modules['host_source_publication'].read_completed_for_storage_upgrade))
                check()
                (self.runtime/'credential_storage.py').write_bytes(b'# package member changed while held\n')
                check()

    @unittest.skipUnless(os.environ.get('ORBIS_RECOVERY_TEST_RUNTIME'), 'Set the real Sentinel source fixture path')
    def test_published_floor_consumer_uses_the_pinned_minimal_module_closure(self):
        source = Path(os.environ['ORBIS_RECOVERY_TEST_RUNTIME'])
        extras = {'bootstrap_source.py', 'credential_storage.py', 'credential_floor.py',
                  'host_source_publication.py', 'bootstrap_publication.py'}
        for name in P.C.RUNTIME_FILES | extras:
            shutil.copyfile(source / name, self.runtime / name)
        self.receipt()
        with self.supervisor._held_runtime(storage_floor=True) as (_, modules, check):
            published = modules['bootstrap_publication']
            self.assertIs(published.source, modules['bootstrap_source'])
            self.assertTrue(callable(published.read_published))
            with mock.patch.object(modules['recovery_sessions'], '_OWNER_UID', os.geteuid()), self.assertRaises(FileNotFoundError):
                with published.read_published(self.state, recovery_directory=self.state,
                        root=self.root, context='local', daemon='fixture-daemon', history_body=b'{}'):
                    self.fail('Missing protected publication evidence was accepted')
            check()

    @unittest.skipUnless(os.environ.get('ORBIS_RECOVERY_TEST_RUNTIME'), 'Set the real Sentinel source fixture path')
    def test_minimal_published_reader_verifies_the_real_paired_proof_fixture(self):
        # This joins real SQLite/file evidence to the exact pinned Host loader.
        # Host retirement and installed qualification remain synthetic fixtures.
        from test_bootstrap_publication import PairedPublicationTests
        fixture = PairedPublicationTests('runTest')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        ready = fixture.root('ready')
        fixture.retire(ready)
        expected = fixture.root('publish')
        source = Path(os.environ['ORBIS_RECOVERY_TEST_RUNTIME'])
        extras = {'bootstrap_source.py', 'credential_storage.py', 'credential_floor.py',
                  'host_source_publication.py', 'bootstrap_publication.py'}
        for name in P.C.RUNTIME_FILES | extras:
            shutil.copyfile(source / name, self.runtime / name)
        self.receipt()
        with self.supervisor._held_runtime(storage_floor=True) as (_, modules, check), \
                mock.patch.object(modules['recovery_sessions'], '_OWNER_UID', os.geteuid()), \
                mock.patch.object(modules['bootstrap_source'], 'HOST_STATE', fixture.fixture.base), \
                mock.patch.object(modules['credential_floor'], 'RECOVERY_ROOT', fixture.fixture.root):
            published = modules['bootstrap_publication']
            self.assertNotIn(published.__package__ + '.recovery_listener_install', __import__('sys').modules)
            verified = []
            with self.assertRaises((OSError, ValueError)):
                with published.read_published(fixture.namespace, recovery_directory=fixture.fixture.root,
                        root=fixture.review['root'], context=fixture.review['context'], daemon=fixture.review['daemon'],
                        history_body=fixture.history) as witness:
                    self.assertEqual((witness.host_generation, witness.sessions_generation), (8, 2))
                    self.assertEqual(witness.receipt_sha256, published.digest(published.encoded(expected)))
                    verified.append(True)
                    check()
                    fixture.proof_file.unlink()
                    witness.recheck()
            self.assertEqual(verified, [True])

    def test_storage_restart_transition_requires_identical_full_projected_prior_definition(self):
        origin='https://recovery.example'
        self.main['HostConfig']={'RestartPolicy':{'Name':'unless-stopped','MaximumRetryCount':0},'ReadonlyRootfs':True}
        _, old, _ = self.supervisor._main(origin)
        before={'imageId':old['imageId'],'creationSha256':old['definitionSha256'],'publicationSha256':old['publicationSha256']}
        with mock.patch.object(self.supervisor.layout.R,'filesystem',return_value={'fsType':'ext4'}):
            self.main['HostConfig']['RestartPolicy']['Name']='no'
            _, new, _ = self.supervisor._main(origin,storage_transition=True)
            transition=self.supervisor._storage_creation_transition(before,new)
            self.assertEqual(transition,{'fromPolicy':'unless-stopped','toPolicy':'no',
                'beforeSha256':old['definitionSha256'],'afterSha256':new['definitionSha256']})
            self.assertIsNone(self.supervisor._storage_creation_transition({**before,'creationSha256':new['definitionSha256']},new))
            self.main['HostConfig']['ReadonlyRootfs']=False
            _, crossed, _ = self.supervisor._main(origin,storage_transition=True)
            with self.assertRaises(ValueError):self.supervisor._storage_creation_transition(before,crossed)

    def test_storage_transition_requires_ext4_and_main_auto_restart_disabled(self):
        origin='https://recovery.example'
        with mock.patch.object(self.supervisor.layout.R,'filesystem',return_value={'fsType':'ext4'}):
            for name in ('always','unless-stopped','on-failure',None):
                self.main['HostConfig']['RestartPolicy']={'Name':name,'MaximumRetryCount':0}
                with self.subTest(name=name),self.assertRaises(ValueError):
                    self.supervisor._main(origin,storage_transition=True)
            self.main['HostConfig']['RestartPolicy']={'Name':'no','MaximumRetryCount':0}
            self.supervisor._main(origin,storage_transition=True)
        with mock.patch.object(self.supervisor.layout.R,'filesystem',return_value={'fsType':'xfs'}):
            with self.assertRaises(ValueError):
                self.supervisor._main(origin,storage_transition=True)

    def test_changed_runtime_bytes_and_wrong_protocol_refuse(self):
        (self.runtime/'writer_broker.py').write_text('HOST_WRITER_PROTOCOL=0\n')
        with self.assertRaises(ValueError):self.supervisor._runtime()
        self.receipt()
        with self.assertRaises(ValueError):self.supervisor._runtime()

    def test_extra_symlink_directory_and_unlisted_file_refuse(self):
        alias=self.release/'alias';alias.symlink_to(self.base,target_is_directory=True)
        with self.assertRaises(ValueError):self.supervisor._runtime()
        alias.unlink();(self.release/'unlisted').write_text('extra')
        with self.assertRaises(ValueError):self.supervisor._runtime()

    def test_current_selector_change_during_load_refuses(self):
        original=P.C.CredentialService.load_runtime
        def change(*args):
            result=original(*args);self.selector.unlink();self.selector.symlink_to('releases/other');return result
        with mock.patch.object(P.C.CredentialService,'load_runtime',side_effect=change),self.assertRaises(ValueError):self.supervisor._runtime()

    def test_explicit_stopped_published_controller_origin_and_protocol_required(self):
        identity,main,daemon=self.supervisor._main('https://recovery.example')
        info=self.root.stat();expected=P.digest({'root':str(self.root),'context':'local','daemon':'daemon-id',
                                               'rootIdentity':(info.st_dev,info.st_ino,info.st_uid,info.st_gid,info.st_mode)})
        self.assertEqual(identity,expected);self.assertEqual(main['imageId'],self.main['Image']);self.assertEqual(daemon,'daemon-id')
        for field,value in [('Running',True),('Pid',1),('Status','running')]:
            old=self.main['State'][field];self.main['State'][field]=value
            with self.assertRaises(ValueError):self.supervisor._main('https://recovery.example')
            self.main['State'][field]=old
        self.main['Config']['Labels'].pop('io.orbis.credential-writer-protocol')
        with self.assertRaises(ValueError):self.supervisor._main('https://recovery.example')

    def test_request_origin_never_replaces_explicit_deployment_binding(self):
        self.main['Config']['Env']=['ORBIS_SENTINEL_RECOVERY_ORIGIN=https://recovery.example']*2
        with self.assertRaises(ValueError):self.supervisor._main('https://recovery.example')
        self.main['Config']['Env']=[]
        with self.assertRaises(ValueError):self.supervisor._main('https://recovery.example')
        self.main['Config']['Env']=['ORBIS_SENTINEL_RECOVERY_ORIGIN=https://other.example']
        with self.assertRaises(ValueError):self.supervisor._main('https://recovery.example')

    def test_main_mount_cannot_expose_independent_runtime_or_recovery_state(self):
        for source in (self.runtime_root,self.runtime_root.parent,self.state,self.state/'child'):
            self.main['Mounts']=[{'Type':'bind','Source':str(source),'Destination':'/data','RW':False}]
            with self.subTest(source=source),self.assertRaises(ValueError):self.supervisor._main('https://recovery.example')
        self.main['Mounts']=[{'Type':'bind','Source':str(self.root),'Destination':'/data','RW':True}]
        self.supervisor._main('https://recovery.example')

    def test_capability_requires_new_counter_and_effective_contracts_with_exact_types(self):
        capability={'schema':'orbis.sentinel-authentication-worker.v1','version':1,'methods':['password','passkey'],
                    'role':'operator','maxIdentityBytes':65536,'maxRequestBytes':32768,'deadlineMs':10000,
                    'databaseRequired':False,'mutations':'none','grantsAuthority':False,
                    'identityContentProof':'orbis.sentinel-identity-content.v1',
                    'effectiveIdentityContentProof':'orbis.sentinel-effective-identity-content.v1',
                    'passkeyCounterProof':'orbis.sentinel-passkey-counter.v1'}
        self.assertEqual(P._capability(capability),capability)
        for changes in ({'version':True},{'passkeyCounterProof':None},{'effectiveIdentityContentProof':'old'},{'extra':True}):
            with self.assertRaises(ValueError):P._capability(dict(capability,**changes))

    def test_existing_operator_status_realm_and_hashes_do_not_bypass_unavailable_source_binding(self):
        for identity in ({'origin':'https://recovery.example','revision':'a'*64,'state':'enrolled'},True,{'qualified':True}):
            with self.assertRaisesRegex(ValueError,'source binding has not been qualified'):
                self.supervisor._operator_source_binding('a'*64,self.main,identity)

    def test_local_retained_worker_daemon_must_match_selected_context(self):
        with mock.patch.object(P,'_run',return_value=b'"other-daemon"'),self.assertRaises(ValueError):self.supervisor._main('https://recovery.example')

    def test_actual_installed_helper_inventory_includes_both_module_types_and_pins_config(self):
        source=Path(__file__).resolve().parent
        tree=ast.parse((source/'orbis-host-service-setup.py').read_bytes())
        scripts=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='SCRIPTS' for t in n.targets))
        installed=self.base/'host-source';installed.mkdir(mode=0o700)
        for name in scripts:
            shutil.copyfile(source/name,installed/name);(installed/name).chmod(0o600)
        units=self.base/'units';units.mkdir(mode=0o755)
        unit=units/'orbis-host.service';unit.write_bytes((source.parent/'packaging/systemd/orbis-host.service').read_bytes());unit.chmod(0o644)
        env=self.base/'host.env'
        env.write_bytes(('ORBIS_SERVICE_SOURCE="'+str(installed/'orbis-host-service.py')+'"\nORBIS_ROOT="'+str(self.root)+'"\nORBIS_DOCKER_CONTEXT="local"\n').encode());env.chmod(0o600)
        states={'orbis-host.service':{'LoadState':'loaded','ActiveState':'inactive','SubState':'dead','FragmentPath':str(unit),
                                    'DropInPaths':'','NeedDaemonReload':'no','MainPID':'0','ControlPID':'0','InvocationID':'','KillMode':'control-group'},
                'orbis-host-observer.socket':{'LoadState':'not-found','ActiveState':'inactive','SubState':'dead','FragmentPath':'',
                                             'DropInPaths':'','NeedDaemonReload':'no'}}
        with mock.patch.object(P,'HOST_SOURCE',installed),mock.patch.object(P,'HOST_ENV',env),mock.patch.object(P,'UNITS',units), \
                mock.patch.object(P,'HOST_SOCKET',self.base/'inactive.sock'),mock.patch.object(P,'OBSERVER_SOCKET',self.base/'observer.sock'), \
                mock.patch.object(P,'__file__',str(installed/'orbis-host-recovery-admission.py')), \
                mock.patch.object(P,'_systemd',side_effect=lambda n:copy.deepcopy(states[n])):
            facts=self.supervisor._host_stopped()
            self.assertIn('orbis-controller-bootstrap-profile.mjs',facts['custody']['sourceFiles'])
            self.assertIn('orbis-host-maintenance-responder.mjs',facts['custody']['sourceFiles'])
            states['orbis-host-observer.socket']['ActiveState']='active'
            with self.assertRaises(ValueError):self.supervisor._host_stopped()
            states['orbis-host-observer.socket']['ActiveState']='inactive'
            env.write_bytes(env.read_bytes().replace(b'ORBIS_ROOT=',b'OTHER_ROOT='))
            with self.assertRaises(ValueError):self.supervisor._host_stopped()

    def test_semantic_version_floor_orders_prereleases_before_stable(self):
        self.assertLess(P._order('1.0.0-beta.2'),P._order('1.0.0-beta.10'))
        self.assertLess(P._order('1.0.0-rc.1'),P._order('1.0.0'))
        for value in ('01.0.0','1.0','latest',None):
            with self.assertRaises(ValueError):P._order(value)


if __name__=='__main__':unittest.main()
