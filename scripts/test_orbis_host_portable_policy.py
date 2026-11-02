import copy
import importlib.util
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

def load(name,key):
    spec=importlib.util.spec_from_file_location(key,Path(__file__).with_name(name));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
E=load('orbis-host-portable-enrollment.py','portable_enrollment_test');M=E.M

class PortablePolicyTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);self.base=Path(temporary.name).resolve()
        self.root=self.base/'installation';self.root.mkdir();self.data=self.root/'app-data';self.data.mkdir();(self.data/'jellyfin').mkdir()
        app=self.root/'apps/store/jellyfin';app.mkdir(parents=True)
        for name in ('docker-compose.yml','docker-compose.generated.yml'):(app/name).write_text('services: {}')
        self.media=self.base/'mounted-disk';self.media.mkdir();(self.media/'library').mkdir()
        dev=self.base.stat().st_dev;mm=f'{os.major(dev)}:{os.minor(dev)}'
        self.mounts=[dict(mountId='1',majorMinor=mm,mountPoint='/',root='/',filesystem='fixturefs',source='fixture-root'),dict(mountId='2',majorMinor=mm,mountPoint=str(self.media),root='/',filesystem='ext4',source='/dev/fixture')]
        self.network=dict(Id='b'*64,Name='fixture-net',Driver='bridge',Scope='local',Internal=False,IPAM={'Driver':'default'})
        self.container={'Id':'c'*64,'Image':'sha256:'+'d'*64,'Config':{'Labels':{'runtipi.managed':'true','runtipi.appurn':'jellyfin:store','com.docker.compose.project':'jellyfin_store','com.docker.compose.service':'jellyfin'}},'HostConfig':{'PortBindings':{'8096/tcp':[{'HostIp':'','HostPort':'8096'}]}},'NetworkSettings':{'Networks':{'fixture-net':{'NetworkID':'b'*64,'Aliases':['jellyfin']}}},'Mounts':[{'Type':'bind','Source':str(self.data/'jellyfin'),'Destination':'/config','RW':True},{'Type':'bind','Source':str(self.media/'library'),'Destination':'/media','RW':False}]}
        self.approvals={'jellyfin:store\njellyfin\n/media':str(self.media/'library')};self.point=str(uuid.uuid4())
    def build(self):return M.build(self.point,'a'*64,self.root,[self.container],[str(self.data)],self.approvals,self.mounts,{'fixture-net':self.network},context_sha256='e'*64,daemon_sha256='f'*64)
    def plan(self,policy,**changes):
        args=dict(included_roots=[str(self.data)],remaps={},port_decisions={},mounts=self.mounts,occupied_ports=[],network_inspects={'fixture-net':self.network});args.update(changes);return M.destination_plan(policy,**args)
    def codes(self,plan):return {item['code'] for item in plan['blockers']}
    def test_real_paths_capture_roles_without_media_file_bytes(self):
        (self.media/'library/private').write_bytes(b'NEVER_READ_BULK_MEDIA');policy=self.build()
        self.assertEqual([x['bytesPolicy'] for x in policy['apps'][0]['mounts']],['included','excluded'])
        self.assertNotIn('NEVER_READ_BULK_MEDIA',json.dumps(policy));self.assertEqual(self.plan(policy)['blockers'],[])
    def test_unknown_external_storage_and_unknown_writers_are_rejected(self):
        self.approvals.clear()
        with self.assertRaises(ValueError):self.build()
        self.approvals={'jellyfin:store\njellyfin\n/media':str(self.media/'library')};policy=self.build()
        for source in (self.data,self.media):
            writer={'Id':'f'*64,'State':{'Running':True},'Mounts':[{'Type':'bind','Source':str(source),'RW':True}]}
            with self.assertRaises(ValueError):M.require_no_unknown_writers([writer],{self.container['Id']},[str(self.data)],policy)
            writer['State']['Running']=False
            with self.assertRaises(ValueError):M.require_no_unknown_writers([writer],{self.container['Id']},[str(self.data)],policy)
    def test_symlink_fifo_replacement_and_missing_path_fail_without_mkdir(self):
        policy=self.build();library=self.media/'library';library.rename(self.media/'original');library.symlink_to(self.media/'original',target_is_directory=True)
        with self.assertRaises(OSError):self.plan(policy)
        library.unlink();os.mkfifo(library)
        with self.assertRaises(ValueError):self.plan(policy)
        library.unlink();library.mkdir();self.assertIn('explicit-mount-remap-required',self.codes(self.plan(policy)))
        library.rmdir();self.assertIn('required-media-mount-missing',self.codes(self.plan(policy)));self.assertFalse(library.exists())
    def test_unmounted_disk_cannot_be_replaced_by_existing_empty_root_directory(self):
        policy=self.build();item=policy['apps'][0]['mounts'][1]
        self.assertIn('required-media-disk-not-mounted',self.codes(self.plan(policy,mounts=self.mounts[:1],remaps={item['key']:str(self.media/'library')})))
    def test_explicit_remap_uses_existing_target_and_rejects_system_paths_unknown_keys(self):
        policy=self.build();alternate=self.media/'alternate';alternate.mkdir();item=policy['apps'][0]['mounts'][1]
        plan=self.plan(policy,remaps={item['key']:str(alternate)});self.assertEqual(plan['blockers'],[])
        self.assertEqual(plan['mounts'][next(i for i,v in enumerate(plan['mounts']) if v['key']==item['key'])]['targetPath'],str(alternate))
        for remaps in ({item['key']:'/etc'},{'e'*64:str(alternate)}):
            with self.assertRaises(ValueError):self.plan(policy,remaps=remaps)
    def test_port_collision_explicit_port_decision_and_network_conflict(self):
        policy=self.build();occupied=[dict(hostIP='127.0.0.1',hostPort=8096,protocol='tcp')]
        self.assertIn('host-port-collision',self.codes(self.plan(policy,occupied_ports=occupied)))
        key=self.plan(policy)['ports'][0]['key'];self.assertEqual(self.plan(policy,occupied_ports=occupied,port_decisions={key:dict(hostIP='127.0.0.1',hostPort=8097)})['blockers'],[])
        self.assertIn('network-definition-conflict',self.codes(self.plan(policy,network_inspects={'fixture-net':{**self.network,'Internal':True}})))
    def test_strict_mutations_rejected_despite_recomputed_domain_hash(self):
        for mutate in (lambda p:p.update(extra=True),lambda p:p['apps'].append(None),lambda p:p['apps'][0].update(project=123),lambda p:p['apps'][0]['mounts'].append(None),lambda p:p['apps'][0]['mounts'][0].update(readOnly=0),lambda p:p['apps'][0]['mounts'][0]['source'].update(path='/a/../b'),lambda p:p['apps'][0]['ports'][0].update(hostPort=0)):
            value=self.build();mutate(value);value['sha256']=M.sha((M.SCHEMA+'\n').encode()+M.canonical({k:v for k,v in value.items() if k!='sha256'}))
            with self.assertRaises(ValueError):M.validate(value)
    def test_mountinfo_escape_and_invalid_device(self):
        self.assertEqual(M.table('1 0 8:1 / / rw - ext4 /dev/a rw\n2 1 8:2 / /media/Media\\040Disk rw - ext4 /dev/b rw')[1]['mountPoint'],'/media/Media Disk')
        with self.assertRaises(ValueError):M.table('1 0 BAD / / rw - ext4 /dev/a rw')

class PortableEnrollmentTests(unittest.TestCase):
    def setUp(self):
        from test_orbis_host_capture_authority import CaptureAuthorityTests
        self.capture=CaptureAuthorityTests();self.capture.setUp();self.addCleanup(self.capture.doCleanups)
        self.enterContext(mock.patch.object(E.A,'OWNER',os.geteuid()));self.fixture=self.capture.fixture
        self.stage=self.fixture.base/'portable-review';self.stage.mkdir(mode=0o700);config=self.capture.service.capture_controller_config(self.fixture.point,self.fixture.controller,self.fixture.image,self.capture.token);self.point=config['pointId']
        policy=M.build(self.point,config['configurationSetSha256'],self.fixture.root,[],[],{},[],{},context_sha256=M.sha(b'fixture'),daemon_sha256='d'*64)
        manifest=dict(schema='orbis.time-machine-runtime.v5',pointId=self.point,configurationSetSha256=config['configurationSetSha256'],mountPolicySha256=M.sha(M.canonical(policy)),publicationProofSha256=M.sha(E.P.canonical(self.capture.preparation)))
        base=self.capture.finalize();descriptor={key:value for key,value in base.items() if key!='authoritySha256'}
        descriptor.update(schema='orbis.controller-capture-authority.v3',version=3,proxyHostIdentity=self.capture.proxy_fixture(),mountPolicySha256=manifest['mountPolicySha256'])
        authority={**descriptor,'authoritySha256':M.sha(b'orbis.controller-capture-authority.v3\n'+E.P.canonical(descriptor))}
        authority_bytes=E.P.canonical(authority);manifest['controllerAuthoritySha256']=M.sha(authority_bytes)
        contents={'mount-policy.json':M.canonical(policy),'controller-config.json':E.P.canonical(config),'controller-publication.json':E.P.canonical(self.capture.preparation),'controller-authority.json':authority_bytes,'runtime-manifest.json':E.P.canonical(manifest),'controller.tar':self.capture.archive}
        self.expected=dict(capsuleSha256='e'*64,currentRevision='f'*64,pointId=self.point,runtimeManifestSha256=M.sha(contents['runtime-manifest.json']),entries={k:M.sha(v) for k,v in contents.items()})
        for name,body in contents.items():(self.stage/name).write_bytes(body);(self.stage/name).chmod(0o600)
        self.official=lambda tag:dict(tag=tag,commit=self.capture.release['commit'],image=self.capture.release['image']+'@'+self.capture.release['digest'],runtipiCompatibility=self.capture.release['runtipiCompatibility'],installationProtocol=self.capture.release.get('installationProtocol'))
    def test_real_graph_layers_and_configuration_require_independent_official_release(self):
        result=E.verify_bundle(self.stage,self.expected,official_check=self.official);self.assertEqual(result['archive']['configDigest'],self.capture.graph.config_digest)
        with self.assertRaises(ValueError):E.verify_bundle(self.stage,self.expected,official_check=lambda tag:{**self.official(tag),'image':'ghcr.io/twentylines/orbis@sha256:'+'0'*64})
        archive=self.stage/'controller.tar';body=bytearray(archive.read_bytes());body[1024]^=1;archive.write_bytes(body);expected=copy.deepcopy(self.expected);expected['entries']['controller.tar']=M.sha(body)
        with self.assertRaises(ValueError):E.verify_bundle(self.stage,expected,official_check=self.official)
    def test_root_enrollment_requires_exact_current_capsule_plan_nonce_and_privileged_peer(self):
        import shutil
        capsule_id=str(uuid.uuid4());capsule=self.fixture.state/'portable-capsules'/capsule_id;capsule.mkdir(parents=True,mode=0o700)
        capsule_file=capsule/'capsule.orbis';capsule_file.write_bytes(b'opaque authenticated capsule driver fixture');capsule_file.chmod(0o600)
        expected=copy.deepcopy(self.expected);expected['capsuleSha256']=M.sha(capsule_file.read_bytes())
        current=dict(currentRevision='f'*64,controllerId='1'*64,controllerImageId='sha256:'+'2'*64,includedRoots=[],mountTable=[],occupiedPorts=[],networks={})
        service=SimpleNamespace(state_dir=self.fixture.state,portable_destination_observation=lambda:copy.deepcopy(current))
        def review(identifier,digest,observation):
            target=self.fixture.state/'portable-enrollments'/identifier/'review';target.mkdir(mode=0o700,exist_ok=True)
            for file in self.stage.iterdir():shutil.copyfile(file,target/file.name);(target/file.name).chmod(0o600)
            return copy.deepcopy(expected)
        manager=E.PortableEnrollment(service,SimpleNamespace(review=review),official_check=self.official)
        request=dict(capsuleId=capsule_id,capsuleSha256=expected['capsuleSha256'],remaps={},portDecisions={})
        result=manager.prepare(request);self.assertFalse(result['activationAvailable']);self.assertEqual(result['plan']['blockers'],[])
        approval={key:result[key] for key in ('capsuleId','capsuleSha256','planSha256','currentRevision','criticalApprovalNonce')};approval['action']='enroll-portable-point'
        with self.assertRaises(ValueError):manager.approve(approval)
        with self.assertRaises(ValueError):manager.approve({**approval,'criticalApprovalNonce':'0'*64},privileged_peer=True)
        current['currentRevision']='e'*64
        with self.assertRaises(ValueError):manager.approve(approval,privileged_peer=True)
        self.assertFalse((manager.directory(capsule_id)/'enrolled.json').exists())
        current['currentRevision']='f'*64
        now=E.time.time()
        with mock.patch.object(E.time,'time',return_value=now+301):
            with self.assertRaises(ValueError):manager.approve(approval,privileged_peer=True)
            renewed=manager.prepare(request)
        self.assertEqual(renewed['planSha256'],result['planSha256'])
        self.assertNotEqual(renewed['criticalApprovalNonce'],result['criticalApprovalNonce'])
        approval['criticalApprovalNonce']=renewed['criticalApprovalNonce']
        enrolled=manager.approve(approval,privileged_peer=True);self.assertFalse(enrolled['activationAvailable'])
        self.assertEqual(manager.approve(approval,privileged_peer=True),enrolled)
        capsule_file.write_bytes(b'changed opaque capsule')
        with self.assertRaises(ValueError):manager.approve(approval,privileged_peer=True)

    def test_capture_producer_is_bound_to_original_fence_and_root_observed_writers(self):
        import io
        from test_orbis_host_capture_authority import S
        root=self.fixture.root
        for name in ('app-data','apps','user-config','state','repos'):(root/name).mkdir(mode=0o700,exist_ok=True)
        current={'Id':self.fixture.controller,'Image':self.fixture.image,'Config':{'Labels':{'com.docker.compose.project':'runtipi','com.docker.compose.service':'runtipi','com.docker.compose.project.working_dir':str(root)}},
                 'Mounts':[dict(Type='bind',Source=str(root),Destination='/data',RW=True),dict(Type='bind',Source=str(root/'app-data'),Destination='/app-data',RW=True)]}
        rows=[current['Id']];inspections={current['Id']:current};calls=[]
        def bounded(_observer,args,_maximum,timeout):
            self.assertGreater(timeout,0);self.assertLessEqual(timeout,30);calls.append(args)
            arguments=args[3:]
            if arguments[0]=='context':return b'{"host":"unix:///run/fixture-docker.sock"}'
            if arguments[0]=='info':return b'{"ID":"independent-fixture-daemon"}'
            if arguments[:2]==['container','ls']:return ('\n'.join(rows)).encode()
            if arguments[:2]==['container','inspect']:return E.P.canonical(inspections[arguments[-1]])
            raise AssertionError('Unexpected root observation')
        real_load=E.load
        driver=SimpleNamespace(DockerRestoreRuntime=SimpleNamespace(bounded_output=bounded))
        def loader(name,key):return driver if name=='orbis-host-retained-restore-runtime.py' else real_load(name,key)
        device=root.stat().st_dev;table=[dict(mountId='1',majorMinor=f'{os.major(device)}:{os.minor(device)}',mountPoint='/',root='/',filesystem='fixturefs',source='fixture')]
        with mock.patch.object(E,'load',side_effect=loader),mock.patch.object(E.Path,'read_text',return_value='fixture kernel mount table'),mock.patch.object(M,'table',return_value=table):
            with self.assertRaises(ValueError):E.capture_mount_policy(self.capture.service,self.point,'0'*64)
            self.assertEqual(calls,[])
            result=E.capture_mount_policy(self.capture.service,self.point,self.capture.token)
            self.assertEqual(result['mountPolicy']['apps'],[]);self.assertFalse(result['runtimeV5Available'])
            self.assertTrue((self.fixture.state/'portable-capture-policies'/self.point/'mount-policy.json').is_file())
            other='9'*64;rows.append(other);inspections[other]={'Id':other,'Config':{'Labels':{}},'State':{'Running':True},'Mounts':[dict(Type='bind',Source=str(root/'state'),Destination='/unreviewed',RW=True)]}
            with self.assertRaises(ValueError):E.capture_mount_policy(self.capture.service,self.point,self.capture.token)
        self.assertIsNone(self.capture.service.HOST.CAPTURE_READ_DEADLINE.get())

    def test_socket_routes_enforce_peer_and_keep_portable_capability_closed(self):
        import io
        from test_orbis_host_capture_authority import S
        handler=S.Handler.__new__(S.Handler);handler.connection=mock.Mock();handler.server=mock.Mock();handler.send_json=mock.Mock()
        handler.path='/v1/portable-restore/capability'
        with mock.patch.object(S,'trusted_capture_peer',return_value=False):handler.do_GET()
        self.assertEqual(handler.send_json.call_args.args[0],403)
        with mock.patch.object(S,'trusted_capture_peer',return_value=True):handler.do_GET()
        self.assertEqual(handler.send_json.call_args.args[1]['activation'],False)
        handler.path='/v1/portable-restore/approve';body=b'{"approved":true}'
        handler.headers={'Content-Length':str(len(body))};handler.rfile=io.BytesIO(body)
        with mock.patch.object(S,'trusted_capture_peer',return_value=False):handler.do_POST()
        self.assertEqual(handler.send_json.call_args.args[0],409);handler.server.service.portable_enrollments.assert_not_called()
        body=b'{"capsuleId":"a","capsuleId":"b"}';handler.headers={'Content-Length':str(len(body))};handler.rfile=io.BytesIO(body)
        with mock.patch.object(S,'trusted_capture_peer',return_value=True):handler.do_POST()
        self.assertEqual(handler.send_json.call_args.args[0],409);handler.server.service.portable_enrollments.assert_not_called()

    def test_no_driver_no_caller_self_authorization_or_early_enrollment(self):
        manager=E.PortableEnrollment(SimpleNamespace(state_dir=self.fixture.state))
        with self.assertRaises(ValueError):manager.prepare(dict(capsuleId=str(uuid.uuid4()),capsuleSha256='e'*64,remaps={},portDecisions={}))
        with self.assertRaises(ValueError):manager.approve({'approved':True},privileged_peer=True)
        self.assertFalse((self.fixture.state/'portable-enrollments').exists())

if __name__=='__main__':unittest.main()
