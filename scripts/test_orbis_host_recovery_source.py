"""Local file/pipe fixtures; no daemon, installed source or PostgreSQL qualification."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

SPEC=importlib.util.spec_from_file_location('source_collector_tests',Path(__file__).with_name('orbis-host-recovery-source.py'))
S=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(S)
A=S.load('orbis-host-retained-authority.py','source_authority_test')


class SourceFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name).resolve();self.base.chmod(0o700)
        for module in (A,S,S.P,S.P.C):
            patch=mock.patch.object(module,'OWNER',os.geteuid());patch.start();self.addCleanup(patch.stop)
    def pin(self,path,**kw):
        result=S.SourceFile(A,path,maximum=1024,**kw);self.addCleanup(result.close);return result
    def test_real_file_is_pinned_and_replacement_never_matches_same_bytes(self):
        path=self.base/'source';path.write_bytes(b'actual');path.chmod(0o600)
        pin=self.pin(path,private=True);self.assertEqual(pin.body,b'actual');pin.check()
        path.rename(self.base/'old');path.write_bytes(b'actual');path.chmod(0o600)
        with self.assertRaises(ValueError):pin.check()
    def test_absence_is_not_empty_file_and_new_ancestor_invalidates(self):
        path=self.base/'missing/auth/passkeys.json';pin=self.pin(path,private=True)
        self.assertIsNone(pin.body);self.assertEqual(pin.descriptor()['absence'],'missing')
        (self.base/'missing').mkdir(mode=0o700)
        with self.assertRaises(ValueError):pin.check()
        # A failed original-directory seal is evidence, not cleanup authority.
        with self.assertRaises(ValueError):pin.close()
    def test_same_filesystem_missing_parent_replacement_is_rejected_during_check(self):
        parent=self.base/'auth';parent.mkdir(mode=0o700);pin=self.pin(parent/'passkeys.json',private=True)
        parent.rename(self.base/'old-auth');parent.mkdir(mode=0o700)
        (parent/'passkeys.json').write_bytes(b'new-current-source')
        with self.assertRaises(ValueError):pin.check()
        with self.assertRaises(ValueError):pin.close()

    def test_symlink_hardlink_mode_and_mount_replacement_refuse(self):
        path=self.base/'source';path.write_bytes(b'actual');path.chmod(0o600)
        alias=self.base/'alias';alias.symlink_to(path)
        with self.assertRaises(ValueError):self.pin(alias,private=True)
        alias.unlink();os.link(path,alias)
        with self.assertRaises(ValueError):self.pin(path,private=True)
        alias.unlink();path.chmod(0o644)
        with self.assertRaises(ValueError):self.pin(path,private=True)
        path.chmod(0o600);pin=self.pin(path,private=True)
        with mock.patch.object(S.P,'_mount_id',return_value='different'),self.assertRaises(ValueError):pin.check()
    def test_mapping_uses_longest_mount_and_rejects_ambiguous_or_symlink_sources(self):
        nested=self.base/'actual';nested.mkdir(mode=0o700)
        main={'Mounts':[{'Type':'bind','Source':str(self.base),'Destination':'/data'},
                        {'Type':'bind','Source':str(nested),'Destination':'/data/state'}]}
        self.assertEqual(S.mapped(main,'/data/state/auth/passkeys.json')[0],nested/'auth/passkeys.json')
        main['Mounts'].append(dict(main['Mounts'][1]))
        with self.assertRaises(ValueError):S.mapped(main,'/data/state/auth/passkeys.json')
    def test_postgres_directory_identity_is_not_only_a_docker_mount_string(self):
        path=self.base/'pgdata';path.mkdir(mode=0o700)
        profile={'uid':os.getuid(),'gid':os.getgid()};first=S.pg_directory(path,profile)
        path.rename(self.base/'old-pgdata');path.mkdir(mode=0o700)
        self.assertNotEqual(S.pg_directory(path,profile)['identity'],first['identity'])
        path.chmod(0o755)
        with self.assertRaises(ValueError):S.pg_directory(path,profile)

    def test_root_issued_request_codec_never_accepts_claim_booleans_or_paths(self):
        value={'operationId':'a'*64,'planSha256':'b'*64,'phase':'proposal','collectionNonce':base64.urlsafe_b64encode(b'x'*32).decode().rstrip('='),'origin':'https://recovery.example'}
        self.assertEqual(S.issued(value),value)
        for field,new in [('collectionNonce','x'),('phase','any'),('origin','http://recovery.example'),('operationId',True)]:
            with self.assertRaises(ValueError):S.issued({**value,field:new})
        with self.assertRaises(ValueError):S.issued({**value,'qualified':True})


class PipeTests(unittest.TestCase):
    def open(self,source):
        docker=SimpleNamespace(command=lambda args:[sys.executable,'-B','-c',source])
        pipe=S.Pipe(docker,'fixture');self.addCleanup(pipe.close);return pipe
    def test_actual_duplex_pipe_keeps_child_alive_until_exact_release_and_rejects_trailing(self):
        source='''import json,sys,struct
out=lambda x:sys.stdout.buffer.write(struct.pack('!I',len(x))+x)
out(b'{"phase":"source"}');sys.stdout.buffer.flush()
n=struct.unpack('!I',sys.stdin.buffer.read(4))[0];body=sys.stdin.buffer.read(n)
out(body);sys.stdout.buffer.flush()
'''
        pipe=self.open(source);self.assertEqual(pipe.receive(),{'phase':'source'});self.assertIsNone(pipe.process.poll())
        pipe.send({'operation':'release'});self.assertEqual(pipe.receive(),{'operation':'release'});pipe.finish()
        self.assertEqual(pipe.process.returncode,0)
    def test_oversize_partial_invalid_json_stderr_and_timeout_are_failures(self):
        cases=["import sys,struct;sys.stdout.buffer.write(struct.pack('!I',999999));sys.stdout.buffer.flush()",
               "import sys,struct;sys.stdout.buffer.write(struct.pack('!I',9)+b'{}');sys.stdout.buffer.flush()",
               "import sys,struct;sys.stdout.buffer.write(struct.pack('!I',2)+b'[]');sys.stdout.buffer.flush()",
               "import sys,time;sys.stderr.write('x'*5000);sys.stderr.flush();time.sleep(1)",
               "import time;time.sleep(2)"]
        for source in cases:
            pipe=self.open(source);pipe.deadline=S.time.monotonic()+0.1
            with self.subTest(source=source),self.assertRaises((ValueError,TimeoutError)):pipe.receive()
            pipe.close()
    def test_nonzero_exit_and_extra_output_after_release_never_mean_complete(self):
        for ending in ["sys.exit(7)","sys.stdout.buffer.write(b'x');sys.stdout.buffer.flush()"]:
            source="import sys,struct;sys.stdout.buffer.write(struct.pack('!I',2)+b'{}');sys.stdout.buffer.flush();"+ending
            pipe=self.open(source);self.assertEqual(pipe.receive(),{})
            with self.assertRaises(ValueError):pipe.finish()
    def test_fixed_docker_output_limits_and_minimal_environment(self):
        real=subprocess.Popen;calls=[]
        def child(args,**kw):
            calls.append((args,kw));return real([sys.executable,'-B','-c',"import sys;sys.stdout.write('x'*9000)"],**kw)
        with mock.patch.object(S.subprocess,'Popen',side_effect=child),self.assertRaises(ValueError):S.Docker('/protected-no-config').run(['info'],maximum=8192)
        self.assertEqual(calls[0][0][:5],['/usr/bin/docker','--config','/protected-no-config','--host','unix:///var/run/docker.sock'])
        self.assertEqual(calls[0][1]['env'],{'PATH':'/usr/bin:/bin','LANG':'C'})
    def test_caller_cannot_construct_a_fake_capture_lease(self):
        with self.assertRaises(ValueError):S.CaptureLease(object(),object(),{},object())


class CaptureLifecycleTests(unittest.TestCase):
    """External observations/crypto are fixtures; actual source files/intents/fence are used."""
    def setUp(self):
        from test_orbis_host_sentinel_integration import SERVICE
        self.service_module=SERVICE;self.host=SERVICE.HOST;self.layout=self.host.AUTHORITY.LAYOUT
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name).resolve();self.base.chmod(0o700)
        self.root,self.state,self.data=(self.base/n for n in ('installation','state','main-data'))
        for path in (self.root,self.state,self.data):path.mkdir(mode=0o700)
        (self.data/'auth').mkdir(mode=0o700);(self.data/'configuration').write_bytes(b'private-source');(self.data/'configuration').chmod(0o600)
        for module,name,value in [(S,'OWNER',os.geteuid()),(S.P,'OWNER',os.geteuid()),(S.P.C,'OWNER',os.geteuid()),
                (self.host.AUTHORITY,'OWNER',os.geteuid()),(self.host.CREDENTIAL_FENCE,'OWNER',os.geteuid()),(self.layout,'STATE_ROOT',self.state)]:
            patch=mock.patch.object(module,name,value);patch.start();self.addCleanup(patch.stop)
        for module,name,value in [(self.layout,'read',{'schema':'fixture-layout'}),(self.layout.R,'filesystem',{'fsType':'ext4'})]:
            patch=mock.patch.object(module,name,return_value=value);patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.object(S,'root');patch.start();self.addCleanup(patch.stop)
        self.namespace=self.layout.namespace(self.root);self.namespace.parent.mkdir(mode=0o700);self.namespace.mkdir(mode=0o700)
        service=SERVICE.HostService.__new__(SERVICE.HostService);service.HOST=self.host;service.root=self.root;service.context='local';service.state_dir=self.state
        service._require_restart_job_clear=lambda:None;service._require_idle_core_jobs=lambda:None
        self.collector=S.Collector(service)
        self.observation={'installationId':'a'*64,'origin':'https://recovery.example','daemon':'fixture-daemon','layoutSha256':'6'*64,'hostService':{'fixture':'qualified-installed-helper'},
            'main':{'id':'b'*64,'imageId':'sha256:'+'c'*64,'publicationSha256':'d'*64,'definitionSha256':'e'*64},
            'postgres':{'id':'f'*64,'imageId':'sha256:'+'1'*64,'definitionSha256':'2'*64,'networkId':'3'*64,
                'networkNamespace':[7,8],'allowedHosts':['runtipi-db'],'profile':{'major':14},'dataDirectory':'/var/lib/postgresql/data'}}
        self.main={'Id':'b'*64,'Image':'sha256:'+'c'*64,'Config':{'Env':['POSTGRES_HOST=runtipi-db']},'Mounts':[
            {'Type':'bind','Source':str(self.data/'configuration'),'Destination':'/data/.env'},
            {'Type':'bind','Source':str(self.data/'auth'),'Destination':'/data/state/auth'}]}
        self.database={'Id':'f'*64,'Image':'sha256:'+'1'*64,'Config':{'Env':['POSTGRES_DB=tipi']}}
        self.collector._observe=lambda origin:(json.loads(json.dumps(self.observation)),self.main,self.database)
        test=self
        class FixtureDocker:
            def __init__(self):self.objects={};self.calls=[];self.next=0;self.bad_capability=False;self.exit_code=0;self.bad_label=False
            def run(self,args,**kw):
                self.calls.append(list(args));verb=args[0]
                if verb=='create':
                    self.next+=1;cid=str(self.next)*64;mode='capability' if args[-1]=='--capability' else 'capture'
                    nonce=args[args.index('--label')+1].split('=',1)[1]
                    network='none' if mode=='capability' else 'container:'+test.database['Id']
                    self.objects[cid]={'Id':cid,'Name':'/'+args[args.index('--name')+1],'Image':test.main['Image'],
                        'Config':{'Image':test.main['Image'],'Labels':{S.LABEL:nonce},'Entrypoint':['/usr/local/bin/node'],
                            'Cmd':[S.SCRIPT,'--'+mode],'User':'0:0','Volumes':None},
                        'Mounts':[] if mode=='capability' else [{'Type':'bind','Source':str(test.directory/'input'),'Destination':'/source-input','RW':False}],
                        'HostConfig':{'Privileged':False,'ReadonlyRootfs':True,'NetworkMode':network,'IpcMode':'none','CapDrop':['ALL'],
                            'CapAdd':None,'SecurityOpt':['no-new-privileges'],'Memory':512*1024*1024,'NanoCpus':1000000000,'PidsLimit':64,
                            'Binds':None,'Devices':[],'DeviceRequests':None,'VolumesFrom':None,'PortBindings':None,'PublishAllPorts':False,
                            'LogConfig':{'Type':'none'},'RestartPolicy':{'Name':'no'},'AutoRemove':False},
                        'State':{'Running':False,'Pid':0,'Paused':False,'Restarting':False,'Dead':False,'ExitCode':0}}
                    return (cid+'\n').encode()
                if verb=='start':return S.canonical({**S.CAPABILITY,'version':False} if self.bad_capability else S.CAPABILITY)
                if verb=='rm':del self.objects[args[-1]];return b''
                if verb=='ps':
                    selector=args[args.index('--filter')+1]
                    if selector.startswith('id='):return b'present' if selector[3:] in self.objects else b''
                    return b''
                raise AssertionError(args)
            def object(self,args):
                value=json.loads(json.dumps(self.objects[args[-1]]))
                if self.bad_label and value['Config']['Cmd'][-1]=='--capture':value['Config']['Labels'][S.LABEL]='foreign'
                return value
        self.docker=FixtureDocker();self.collector.docker=self.docker
        self.request={'operationId':'4'*64,'planSha256':'5'*64,'phase':'proposal','collectionNonce':base64.urlsafe_b64encode(b'x'*32).decode().rstrip('='),'origin':'https://recovery.example'}
        self.directory=self.namespace/'bootstrap-sources'/self.request['operationId']/('proposal-'+S.digest(self.request['collectionNonce'].encode()))
        class FixturePipe:
            def __init__(self,docker,cid):
                self.docker,self.cid=docker,cid;self.command=None
                docker.objects[cid]['State'].update(Running=True,Pid=999)
                self.source=b'{"syntheticSource":true}';self.closed=False
                request=json.loads((test.directory/'input/request.json').read_bytes())
                self.descriptor={'database':{'systemIdentifier':'123'},'sourceBindingSha256':request['sourceBindingSha256']}
                self.descriptor_hash=S.digest(json.dumps(self.descriptor,separators=(',',':')).encode())
            def receive(self):
                if self.command:
                    return {'schema':'orbis.sentinel-source-frame.v1','phase':'released' if self.command['operation']=='release' else 'checked',
                        'collectionNonce':test.request['collectionNonce'],'challenge':self.command['challenge'],
                        'sourceSha256':S.digest(self.source),'descriptorSha256':self.descriptor_hash}
                return {'schema':'orbis.sentinel-source-frame.v1','phase':'source','collectionNonce':test.request['collectionNonce'],
                    'sourceSha256':S.digest(self.source),'identityBase64':base64.b64encode(self.source).decode(),
                    'descriptor':self.descriptor,'descriptorSha256':self.descriptor_hash}
            def send(self,value):self.command=value
            def finish(self):self.docker.objects[self.cid]['State'].update(Running=False,Pid=0,ExitCode=self.docker.exit_code)
            def close(self):self.closed=True
        patch=mock.patch.object(S,'Pipe',FixturePipe);patch.start();self.addCleanup(patch.stop)
        original_stat=S.os.stat;original_read=Path.read_text
        def stat_file(path,*a,**kw):
            if str(path)=='/proc/999/ns/net':return SimpleNamespace(st_dev=7,st_ino=8)
            return original_stat(path,*a,**kw)
        def read_text(path,*a,**kw):
            if str(path)=='/proc/self/stat':return '1 (fixture) '+' '.join(['1']*20)
            return original_read(path,*a,**kw)
        for module,name,replacement in [(S.os,'stat',stat_file),(Path,'read_text',read_text)]:
            patch=mock.patch.object(module,name,side_effect=replacement) if module is S.os else mock.patch.object(module,name,replacement)
            patch.start();self.addCleanup(patch.stop)

    def lease(self,guard):
        value=self.collector.open(self.request,guard);self.addCleanup(value.close);return value
    def test_actual_capture_files_witness_and_capability_lifecycle_keep_original_source_and_guard(self):
        with self.host.credential_fence_lock(self.root,'local') as guard:
            lease=self.lease(guard)
            self.assertEqual((self.directory/'source.json').read_bytes(),b'{"syntheticSource":true}')
            witness=json.loads((self.directory/'witness.json').read_bytes())
            self.assertEqual(set(witness),{'schema','operationId','planSha256','phase','collectionNonce','sourceSha256','descriptorSha256','descriptor','capturedAtMs'})
            self.assertEqual(witness['descriptorSha256'],S.digest(witness['descriptor']));self.assertEqual(witness['descriptor']['collector']['protocol'],S.PROTOCOL)
            self.assertEqual(len(self.docker.objects),1);self.assertEqual(json.loads((self.directory/'worker-capability.json').read_bytes())['phase'],'complete')
            lease.check();lease.finish();self.assertFalse(lease.active);self.assertEqual(self.docker.objects,{})
            self.assertEqual(json.loads((self.directory/'worker.json').read_bytes())['phase'],'complete')
            self.assertEqual((self.data/'configuration').read_bytes(),b'private-source')
    def test_actual_root_file_reader_accepts_collector_witness_without_normalization_and_keeps_live_gate_closed(self):
        runtime=os.environ.get('ORBIS_BOOTSTRAP_TEST_RUNTIME')
        if not runtime:self.skipTest('Explicit current Sentinel source path required for joined file-reader proof')
        import importlib
        package='_actual_bootstrap_reader_'+S.digest(str(self.base).encode())
        spec=importlib.util.spec_from_file_location(package,Path(runtime)/'__init__.py',submodule_search_locations=[runtime])
        module=importlib.util.module_from_spec(spec);sys.modules[package]=module;spec.loader.exec_module(module)
        reader=importlib.import_module(package+'.bootstrap_source');sessions=importlib.import_module(package+'.recovery_sessions')
        with mock.patch.object(sessions,'_OWNER_UID',os.geteuid()):
            store_path=self.base/'recovery-store';store_path.mkdir(mode=0o700)
            store=sessions.RecoverySessions(str(store_path));self.addCleanup(store.close)
            operation=store_path/'bootstrap'/self.request['operationId'];operation.mkdir(mode=0o700,parents=True);operation.parent.chmod(0o700)
            self.request['phase']='activation'
            self.directory=self.namespace/'bootstrap-sources'/self.request['operationId']/('activation-'+S.digest(self.request['collectionNonce'].encode()))
            plan={'schema':'orbis.sentinel-bootstrap-plan.v1','operationId':self.request['operationId'],
                'installationId':self.observation['installationId'],'origin':self.request['origin'],
                'sourceSha256':S.digest(b'{"syntheticSource":true}'),'captureRoot':str(self.namespace/'bootstrap-sources'),
                'collector':{'protocol':S.PROTOCOL,'programSha256':S.digest(Path(S.__file__).read_bytes()),'imageId':self.main['Image']},'hostHistorySha256':None}
            body=S.canonical(plan);self.request['planSha256']=S.digest(body)
            (operation/'plan.json').write_bytes(body);(operation/'plan.json').chmod(0o600)
            approval={'schema':'orbis.sentinel-bootstrap-approval.v1','operationId':self.request['operationId'],
                'planSha256':self.request['planSha256'],'installationId':self.observation['installationId'],'approvalId':'7'*64}
            (operation/'approval.json').write_bytes(S.canonical(approval));(operation/'approval.json').chmod(0o600)
            with self.host.credential_fence_lock(self.root,'local') as guard:
                lease=self.lease(guard);witness=reader.RootFileSourceWitness(store)
                now=store._now()
                with witness.source(self.request['operationId'],self.request['planSha256'],'activation',self.request['collectionNonce'],issued_at=now-1000,expires_at=now+60000) as source:
                    self.assertEqual(source.body,lease.source)
                    self.assertEqual(source.descriptor_sha256,S.digest(lease.descriptor))
                    with self.assertRaisesRegex(ValueError,'live stopped-Main source context has not been qualified'):witness.require_live_context(source)
                    with self.assertRaisesRegex(ValueError,'writer floor and durable managed intent have not been qualified'):witness.require_writer_floor(source)
                lease.finish()

    def test_oversize_root_witness_is_rejected_before_source_publication(self):
        self.observation['hostService']={'sourceFiles':{'x'*34000:'a'*64}}
        with self.host.credential_fence_lock(self.root,'local') as guard,self.assertRaises(ValueError):self.lease(guard)
        self.assertFalse((self.directory/'source.json').exists());self.assertFalse((self.directory/'witness.json').exists())
        self.assertEqual(len(self.docker.objects),1)
        self.assertEqual(json.loads((self.directory/'worker.json').read_bytes())['phase'],'awaiting-root-ack')

    def test_capability_mismatch_never_starts_capture_and_retains_owned_intent(self):
        self.docker.bad_capability=True
        with self.host.credential_fence_lock(self.root,'local') as guard,self.assertRaises(ValueError):self.lease(guard)
        self.assertFalse((self.directory/'source.json').exists());self.assertEqual(len(self.docker.objects),1)
        self.assertEqual(json.loads((self.directory/'worker-capability.json').read_bytes())['phase'],'created')
    def test_original_drift_and_nonzero_exit_do_not_remove_or_complete_capture(self):
        with self.host.credential_fence_lock(self.root,'local') as guard:
            lease=self.lease(guard);self.docker.exit_code=7
            with self.assertRaises(ValueError):lease.finish()
            self.assertEqual(len(self.docker.objects),1);self.assertEqual(json.loads((self.directory/'worker.json').read_bytes())['phase'],'awaiting-root-ack')
    def test_foreign_owned_metadata_prevents_start_or_removal(self):
        self.docker.bad_label=True
        with self.host.credential_fence_lock(self.root,'local') as guard,self.assertRaises(ValueError):self.lease(guard)
        self.assertFalse((self.directory/'source.json').exists());self.assertEqual(len(self.docker.objects),1)
    def test_unknown_existing_capture_is_never_adopted_or_overwritten(self):
        self.directory.mkdir(mode=0o700,parents=True)
        for path in (self.directory.parent.parent,self.directory.parent):path.chmod(0o700)
        (self.directory/'preserve').write_bytes(b'evidence')
        with self.host.credential_fence_lock(self.root,'local') as guard,self.assertRaises(FileExistsError):self.lease(guard)
        self.assertEqual((self.directory/'preserve').read_bytes(),b'evidence');self.assertEqual(self.docker.calls,[])


if __name__=='__main__':unittest.main()
