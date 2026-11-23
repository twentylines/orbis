#!/usr/bin/env python3
"""Root-owned, stopped-controller source lease. No enrollment or activation API.

Only this actual collector's live opaque lease binds a source to an installation.
Its witness file alone never proves a running SQL/file fence or grants authority.
"""
from contextlib import ExitStack
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import selectors
import socket
import stat
import struct
import subprocess
import sys
import time


def _container_definition_module():
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location('orbis_container_definition', Path(__file__).with_name('orbis-container-definition.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CONTAINER_DEFINITION = _container_definition_module()


def load(name,key):
    spec=importlib.util.spec_from_file_location(key,Path(__file__).with_name(name))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


P=load('orbis-host-recovery-admission.py','orbis_source_admission')
PG=load('orbis-host-core-pg-profiles.py','orbis_source_pg_profiles')
OWNER=0
PROTOCOL='orbis.stopped-main-source.v1'
SCRIPT='/app/sentinel-recovery-source.mjs'
LABEL='io.orbis.stopped-source-worker'
FRAME=131072
TIMEOUT=120
MAXIMUM=2*1024*1024
_KEY=object()

CAPABILITY={'schema':'orbis.sentinel-source-exporter.v1','version':1,'databaseRequired':True,'methods':['capture'],
    'parserProfile':'orbis.source-configuration.dotenv-17.2.3.v1','sourceProtocol':PROTOCOL,'maxIdentityBytes':65536,
    'maxFrameBytes':FRAME,'deadlineMs':120000,'sqlMutations':'none','sourceWrites':'none','grantsAuthority':False}


def fail():return ValueError('The actual stopped Main credential source requires protected review.')
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False).encode()
def digest(value):return hashlib.sha256(value if type(value) is bytes else canonical(value)).hexdigest()
def decoded(body):return P.C.json_body(body)
def root():
    if sys.platform!='linux' or os.geteuid()!=OWNER or os.getuid()!=OWNER:raise fail()
def token(value):
    if type(value) is not str or not re.fullmatch(r'[A-Za-z0-9_-]{43}',value):raise fail()
    if base64.urlsafe_b64encode(base64.urlsafe_b64decode(value+'=')).decode().rstrip('=')!=value:raise fail()
    return value

def issued(value):
    if (type(value) is not dict or set(value)!={'operationId','planSha256','phase','collectionNonce','origin'}
            or not P.valid_hash(value['operationId']) or not P.valid_hash(value['planSha256'])
            or value['phase'] not in ('proposal','activation')):raise fail()
    token(value['collectionNonce']);P._origin(value['origin']);return value


def mapped(raw,destination):
    """Resolve the actual most-specific bind/volume mapping, never a guessed root."""
    target=PurePosixPath(destination);matches=[]
    mounts=raw.get('Mounts')
    if type(mounts) is not list:raise fail()
    for item in mounts:
        if type(item) is not dict:raise fail()
        location=PurePosixPath(item.get('Destination','/invalid'))
        if location.is_absolute() and target.is_relative_to(location):matches.append((len(location.parts),item))
    matches.sort(key=lambda v:v[0],reverse=True)
    if not matches or len(matches)>1 and matches[0][0]==matches[1][0]:raise fail()
    mount=matches[0][1]
    if mount.get('Type') not in ('bind','volume') or type(mount.get('Source')) is not str:raise fail()
    source=Path(mount['Source'])
    if not source.is_absolute() or str(source)!=os.path.realpath(source):raise fail()
    result=source/target.relative_to(PurePosixPath(mount['Destination']))
    if str(result)!=os.path.realpath(result):raise fail()
    return result,copy.deepcopy(mount)


def pg_directory(path,profile):
    path=Path(path)
    if not path.is_absolute() or str(path)!=os.path.realpath(path):raise fail()
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        info=os.fstat(fd)
        if (info.st_uid!=profile['uid'] or info.st_gid!=profile['gid']
                or stat.S_IMODE(info.st_mode) not in (0o700,0o750)):raise fail()
        identity=list(P.C.seal(info)[:5]);mounted=P._mount_id(fd)
        fresh=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            if list(P.C.seal(os.fstat(fresh))[:5])!=identity or P._mount_id(fresh)!=mounted:raise fail()
        finally:os.close(fresh)
        return {'identity':identity,'mountId':mounted}
    finally:os.close(fd)


class SourceFile:
    """Keep original file or exact ancestor/absence custody alive, without writes."""
    def __init__(self,authority,path,*,maximum,private=False):
        self.authority=authority
        self.path,self.resources,self.pin=Path(path),ExitStack(),None
        self.missing=None
        try:
            parent=self.path.parent
            while not os.path.lexists(parent):parent=parent.parent
            self.fd=self.resources.enter_context(P._directory(parent) if private and parent==self.path.parent else self._protected(parent))
            self.parent=parent
            self.mounts={str(p):P._mount_id(fd) for p,fd in self._ancestor_fds(parent)}
            self.identities={str(p):list(P.C.seal(os.fstat(fd))[:5]) for p,fd in self.ancestors}
            if private and parent==self.path.parent and (stat.S_IMODE(os.fstat(self.fd).st_mode)!=0o700 or os.fstat(self.fd).st_uid!=OWNER):raise fail()
            if os.path.lexists(self.path):
                self.pin=P.C.PinnedFile(self.path,limit=maximum,private=private)
                self.resources.callback(self.pin.close);self.body=self.pin.body
                self.seal=list(P.C.seal(os.fstat(self.pin.file)))
            else:
                relative=self.path.relative_to(parent);self.missing=relative.parts[0]
                try:os.stat(self.missing,dir_fd=self.fd,follow_symlinks=False)
                except FileNotFoundError:pass
                else:raise fail()
                self.body=None;self.seal=None
            self.check()
        except BaseException:self.resources.close();raise

    def _protected(self,parent):
        # Private-file source custody differs from installed supervisor storage:
        # a legitimate Main state ancestor may be0755, while auth itself is0700.
        return self.authority.protected_directory(parent,private=False)


    def _ancestor_fds(self,parent):
        # PinnedFile already pins file ancestors. Absent sources need equivalent
        # actual mount observations; retain opened descriptors until close.
        result=[]
        for path in (*reversed(parent.parents),parent):
            fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
            self.resources.callback(os.close,fd);result.append((path,fd))
        self.ancestors=result;return result

    def check(self):
        if self.pin:self.pin.verify()
        else:
            try:os.stat(self.missing,dir_fd=self.fd,follow_symlinks=False)
            except FileNotFoundError:pass
            else:raise fail()
        for path,fd in self.ancestors:
            fresh=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
            try:
                if (list(P.C.seal(os.fstat(fd))[:5])!=self.identities[str(path)]
                    or list(P.C.seal(os.fstat(fresh))[:5])!=self.identities[str(path)]
                    or P._mount_id(fd)!=self.mounts[str(path)] or P._mount_id(fresh)!=self.mounts[str(path)]):raise fail()
            finally:os.close(fresh)

    def descriptor(self):
        return {'path':str(self.path),'sha256':digest(self.body) if self.body is not None else None,'identity':self.seal,
                'absence':self.missing,'ancestor':str(self.parent),'ancestors':self.identities,'mounts':self.mounts}
    def close(self):self.resources.close()


class Docker:
    """Fixed local daemon and private bounded pipes; no inherited Docker context."""
    def __init__(self,configuration):self.configuration=configuration
    def command(self,args):return ['/usr/bin/docker','--config',str(self.configuration),'--host','unix:///var/run/docker.sock',*args]
    def run(self,args,*,maximum=MAXIMUM,timeout=15):
        process=subprocess.Popen(self.command(args),stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                                 env={'PATH':'/usr/bin:/bin','LANG':'C'},close_fds=True,start_new_session=True)
        deadline=time.monotonic()+timeout;output=bytearray();errors=0;selector=selectors.DefaultSelector()
        try:
            for stream,kind in ((process.stdout,'out'),(process.stderr,'err')):
                os.set_blocking(stream.fileno(),False);selector.register(stream,selectors.EVENT_READ,kind)
            while selector.get_map():
                remaining=deadline-time.monotonic()
                if remaining<=0:raise fail()
                for key,_ in selector.select(min(remaining,0.1)):
                    chunk=os.read(key.fd,4096)
                    if not chunk:selector.unregister(key.fileobj)
                    elif key.data=='out':
                        output.extend(chunk)
                        if len(output)>maximum:raise fail()
                    else:
                        errors+=len(chunk)
                        if errors>4096:raise fail()
            remaining=deadline-time.monotonic()
            if remaining<=0 or process.wait(timeout=remaining):raise fail()
            return bytes(output)
        finally:
            selector.close()
            if process.poll() is None:process.kill()
            process.wait();process.stdout.close();process.stderr.close()
    def object(self,args):return decoded(self.run(args))


class Pipe:
    """Owned attach process; credentials are never copied to logs or exceptions."""
    def __init__(self,docker,identifier):
        self.process=subprocess.Popen(docker.command(['start','--attach','--interactive',identifier]),stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'PATH':'/usr/bin:/bin','LANG':'C'},close_fds=True,start_new_session=True)
        self.deadline=time.monotonic()+TIMEOUT;self.buffer=bytearray();self.errors=0
        for stream in (self.process.stdin,self.process.stdout,self.process.stderr):os.set_blocking(stream.fileno(),False)
    def _io(self,wanted,body=None):
        pending=memoryview(body or b'');selector=selectors.DefaultSelector()
        try:
            selector.register(self.process.stdout,selectors.EVENT_READ,'out');selector.register(self.process.stderr,selectors.EVENT_READ,'err')
            if pending:selector.register(self.process.stdin,selectors.EVENT_WRITE,'in')
            while pending or len(self.buffer)<wanted:
                remaining=self.deadline-time.monotonic()
                if remaining<=0:raise fail()
                for key,_ in selector.select(min(remaining,0.1)):
                    if key.data=='in':
                        pending=pending[os.write(key.fd,pending[:4096]):]
                        if not pending:selector.unregister(key.fileobj)
                    else:
                        chunk=os.read(key.fd,4096)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            if key.data=='out' and len(self.buffer)<wanted:raise fail()
                        elif key.data=='err':
                            self.errors+=len(chunk)
                            if self.errors>4096:raise fail()
                        else:
                            self.buffer.extend(chunk)
                            if len(self.buffer)>FRAME+4:raise fail()
                if not selector.get_map():raise fail()
        finally:selector.close()
    def receive(self):
        self._io(4);size=struct.unpack('!I',self.buffer[:4])[0]
        if not 0<size<=FRAME:raise fail()
        self._io(size+4);body=bytes(self.buffer[4:size+4]);del self.buffer[:size+4]
        return decoded(body)
    def send(self,value):
        body=canonical(value)
        if not 0<len(body)<=4096:raise fail()
        self._io(0,struct.pack('!I',len(body))+body)
    def finish(self):
        self.process.stdin.close();self.process.stdin=None
        if self.buffer:raise fail()
        selector=selectors.DefaultSelector()
        try:
            for stream,kind in ((self.process.stdout,'out'),(self.process.stderr,'err')):
                selector.register(stream,selectors.EVENT_READ,kind)
            while selector.get_map():
                remaining=self.deadline-time.monotonic()
                if remaining<=0:raise fail()
                for key,_ in selector.select(min(remaining,0.1)):
                    chunk=os.read(key.fd,4096)
                    if not chunk:selector.unregister(key.fileobj)
                    elif key.data=='out':raise fail()
                    else:
                        self.errors+=len(chunk)
                        if self.errors>4096:raise fail()
            remaining=self.deadline-time.monotonic()
            if remaining<=0 or self.process.wait(timeout=remaining):raise fail()
        finally:selector.close()
    def close(self):
        if self.process.poll() is None:self.process.kill()
        self.process.wait()
        for stream in (self.process.stdin,self.process.stdout,self.process.stderr):
            if stream is not None and not stream.closed:stream.close()


class Collector:
    def __init__(self,service):
        self.service,self.host=service,service.HOST
        self.authority,self.layout=self.host.AUTHORITY,self.host.AUTHORITY.LAYOUT
        self.supervisor=P.Supervisor(service)
        self.docker=Docker(P.HOST_SOURCE)

    def _observe(self,origin):
        host_service=self.supervisor._host_stopped()
        publication=self.service.current_manifest()
        main=self.docker.object(['inspect','--format','{{json .}}','runtipi'])
        state=main.get('State',{});cfg=main.get('Config',{});labels=cfg.get('Labels') or {}
        if (not P.valid_hash(main.get('Id')) or not re.fullmatch(r'sha256:[a-f0-9]{64}',main.get('Image',''))
            or cfg.get('Image')!=self.host.controller_reference(self.service.root,publication,self.service.context)
            or labels.get('com.docker.compose.project')!='runtipi' or labels.get('com.docker.compose.service')!='runtipi'
            or labels.get('com.docker.compose.project.working_dir')!=str(self.service.root)
            or any(state.get(k) is not False for k in ('Running','Paused','Restarting','Dead'))
            or type(state.get('Pid')) is not int or state['Pid']!=0 or state.get('Status') not in ('created','exited')):raise fail()
        protected=(P.ROOT,P.STATE,P.RECOVERY_ENV.parent,P.UNITS,P.HOST_SOURCE,P.HOST_ENV.parent,self.service.state_dir)
        if type(main.get('Mounts')) is not list:raise fail()
        for mount in main['Mounts']:
            source=mount.get('Source') if type(mount) is dict else None
            if type(source) is not str or not source.startswith('/'):raise fail()
            source=Path(source)
            if any(source==p or source in p.parents or p in source.parents for p in protected):raise fail()
        main_image=self.docker.object(['image','inspect','--format','{{json .}}',main['Image']])
        if main_image.get('Id')!=main['Image'] or (main_image.get('Config') or {}).get('Volumes') not in (None,{}):raise fail()
        daemon=json.loads(self.docker.run(['info','--format','{{json .ID}}'],maximum=4096))
        if type(daemon) is not str or not 1<=len(daemon)<=256 or any(ord(c)<33 or ord(c)>126 for c in daemon):raise fail()
        other=self.host.docker(self.service.context,['info','--format','{{json .ID}}'],self.service.root)
        if other.returncode or json.loads(other.stdout)!=daemon:raise fail()
        layout=self.layout.read(self.service.root,daemon,self.service.context)
        if layout is None:raise fail()
        root_info=self.service.root.stat()
        installation=digest({'root':str(self.service.root),'context':self.service.context,'daemon':daemon,
            'rootIdentity':(root_info.st_dev,root_info.st_ino,root_info.st_uid,root_info.st_gid,root_info.st_mode)})
        database=self.docker.object(['inspect','--format','{{json .}}','runtipi-db'])
        dbstate=database.get('State',{});dbcfg=database.get('Config',{});dblabel=dbcfg.get('Labels') or {};hc=database.get('HostConfig',{})
        if (not P.valid_hash(database.get('Id')) or database.get('Name')!='/runtipi-db'
            or dblabel.get('com.docker.compose.project')!='runtipi' or dblabel.get('com.docker.compose.service')!='runtipi-db'
            or dblabel.get('com.docker.compose.project.working_dir')!=str(self.service.root)
            or dbstate.get('Running') is not True or type(dbstate.get('Pid')) is not int or dbstate['Pid']<=0
            or any(dbstate.get(k) is not False for k in ('Paused','Restarting','Dead','OOMKilled'))
            or hc.get('Privileged') is not False or hc.get('AutoRemove') is not False or hc.get('UsernsMode') not in ('','host')):raise fail()
        image=self.docker.object(['image','inspect','--format','{{json .}}',database['Image']]);profile=PG.execution_image_profile(image)
        common=set(main.get('NetworkSettings',{}).get('Networks',{})) & set(database.get('NetworkSettings',{}).get('Networks',{}))
        if len(common)!=1:raise fail()
        network_name=next(iter(common));endpoint=database['NetworkSettings']['Networks'][network_name]
        network=self.docker.object(['network','inspect','--format','{{json .}}',endpoint['NetworkID']])
        if (network.get('Id')!=endpoint['NetworkID'] or network.get('Name')!=network_name or network.get('Driver')!='bridge'
                or network.get('Scope')!='local' or network.get('Ingress') not in (None,False)
                or main['NetworkSettings']['Networks'][network_name].get('NetworkID')!=network['Id']):raise fail()
        hosts=sorted(set([database['Id'],'runtipi-db',endpoint.get('IPAddress',''),*(endpoint.get('Aliases') or [])])-{''})
        env=dbcfg.get('Env')
        if type(env) is not list or any(type(v) is not str or '=' not in v for v in env):raise fail()
        env_map=dict(v.split('=',1) for v in env)
        if len(env_map)!=len(env):raise fail()
        data_directory=env_map.get('PGDATA','/var/lib/postgresql/data')
        if not data_directory.startswith('/') or str(PurePosixPath(data_directory))!=data_directory or '..' in PurePosixPath(data_directory).parts:raise fail()
        pgdata,mount=mapped(database,data_directory)
        if mount.get('Type')!='volume' or mount.get('RW') is not True:raise fail()
        volume=self.docker.object(['volume','inspect','--format','{{json .}}',mount['Name']])
        if (volume.get('Name')!=mount['Name'] or volume.get('Mountpoint')!=mount['Source'] or volume.get('Driver')!='local'
                or volume.get('Scope')!='local' or volume.get('Options') not in (None,{})):raise fail()
        net=os.stat('/proc/'+str(dbstate['Pid'])+'/ns/net')
        descriptor={'installationId':installation,'origin':origin,'daemon':daemon,'layoutSha256':digest(layout),'hostService':host_service,
            'main':{'id':main['Id'],'imageId':main['Image'],'publicationSha256':digest(publication),'definitionSha256':self._definition(main)},
            'postgres':{'id':database['Id'],'imageId':database['Image'],'definitionSha256':self._definition(database),
                        'startedAt':dbstate['StartedAt'],'pid':dbstate['Pid'],'profile':profile,'pgdata':str(pgdata),'dataDirectory':data_directory,'dataDirectoryIdentity':pg_directory(pgdata,profile),
                        'volume':digest(volume),'networkId':network['Id'],'networkSha256':digest({k:network.get(k) for k in ('Id','Name','Driver','Scope','Internal','Ingress','IPAM','Options','Labels')}),
                        'networkNamespace':[net.st_dev,net.st_ino],'allowedHosts':hosts}}
        return descriptor,main,database

    @staticmethod
    def _definition(raw):return digest(CONTAINER_DEFINITION.normalize({k:raw.get(k) for k in ('Config','HostConfig','Mounts','Path','Args')}))

    def open(self,request,guard):
        root();request=issued(request)
        if self.service.state_dir!=self.layout.STATE_ROOT:raise fail()
        self.service.require_credential_idle(guard)
        return CaptureLease(_KEY,self,request,guard)


class CaptureLease:
    def __init__(self,key,collector,request,guard):
        if key is not _KEY:raise fail()
        self.collector,self.request,self.guard=collector,copy.deepcopy(request),guard
        self.resources=ExitStack();self.pipe=None;self.active=False;self.record=None;self.source=None
        self.descriptor,self.main,self.database=collector._observe(request['origin'])
        self.namespace=collector.layout.namespace(collector.service.root)
        fs=collector.layout.R.filesystem(self.namespace)
        if fs['fsType']=='nsfs':raise fail()
        self.directory=self.namespace/'bootstrap-sources'/request['operationId']/(request['phase']+'-'+digest(request['collectionNonce'].encode()))
        try:
            self._prepare();self._start();self.active=True
        except BaseException:
            self.close();raise

    def _write(self,name,body):
        with P._directory(self.directory) as fd:P._write(self.collector.authority,fd,name,body,previous=None)
    def _save(self):
        body=canonical(self.record)+b'\n'
        with P._directory(self.directory) as fd:
            previous=P._read(self.collector.authority,fd,'worker.json')
            P._write(self.collector.authority,fd,'worker.json',body,previous=previous)
    def _prepare(self):
        c=self.collector
        # Every missing component is an owned, durably recorded new directory.
        # Existing operation/capture material is never adopted or overwritten.
        for path in (self.namespace/'bootstrap-sources',self.directory.parent):
            if not os.path.lexists(path):
                with P._directory(path.parent) as fd:os.mkdir(path.name,0o700,dir_fd=fd);os.fsync(fd)
            with P._directory(path):pass
        with P._directory(self.directory.parent) as fd:os.mkdir(self.directory.name,0o700,dir_fd=fd);os.fsync(fd)
        self.files={}
        for name,target,maximum,private in [('configuration','/data/.env',1024*1024,False),('passkeys','/data/state/auth/passkeys.json',512*1024,True)]:
            filename,mount=mapped(self.main,target)
            pin=SourceFile(c.authority,filename,maximum=maximum,private=private);self.resources.callback(pin.close)
            if name=='configuration' and pin.body is None:raise fail()
            self.files[name]=pin;self.descriptor[name]={'mount':mount,'source':pin.descriptor()}
        for path in ('input','input/data','input/data/state','input/data/state/auth'):
            parent=(self.directory/path).parent
            with P._directory(parent) as fd:os.mkdir(Path(path).name,0o700,dir_fd=fd);os.fsync(fd)
        input_dir=self.directory/'input'
        private_files={'data/.env':self.files['configuration'].body,
            'controller-environment.json':canonical(self.main['Config']['Env']),
            'database-environment.json':canonical(self.database['Config']['Env'])}
        if self.files['passkeys'].body is not None:private_files['data/state/auth/passkeys.json']=self.files['passkeys'].body
        request={'schema':'orbis.sentinel-source-request.v1',**self.request,'installationId':self.descriptor['installationId'],
            'sourceBindingSha256':digest(self.descriptor),'controllerId':self.main['Id'],'controllerImageId':self.main['Image'],'publicationSha256':self.descriptor['main']['publicationSha256'],
            'configurationSha256':digest(private_files['data/.env']),'controllerEnvironmentSha256':digest(private_files['controller-environment.json']),
            'databaseEnvironmentSha256':digest(private_files['database-environment.json']),
            'passkeysSha256':digest(private_files['data/state/auth/passkeys.json']) if 'data/state/auth/passkeys.json' in private_files else None,
            'database':{'containerId':self.database['Id'],'imageId':self.database['Image'],'networkId':self.descriptor['postgres']['networkId'],
                        'allowedHosts':self.descriptor['postgres']['allowedHosts'],'major':self.descriptor['postgres']['profile']['major'],
                        'dataDirectory':self.descriptor['postgres']['dataDirectory']}}
        private_files['request.json']=canonical(request)
        for name,body in private_files.items():
            path=input_dir/name
            with P._directory(path.parent) as fd:P._write(c.authority,fd,path.name,body,previous=None)
        self.input_hash=digest({n:digest(b) for n,b in private_files.items()})
        nonce=secrets.token_hex(16)
        self.record={'schema':'orbis.bootstrap-source-worker.v1','name':'orbis-bootstrap-source-'+nonce,'nonce':nonce,
                     'imageId':self.main['Image'],'containerId':None,'phase':'intent','inputSha256':self.input_hash}
        self._save()

    def _start(self):
        self._capability()
        d=self.collector.docker;r=self.record
        args=['create','--pull=never','--name',r['name'],'--label',LABEL+'='+r['nonce'],'--log-driver=none',
              '--network=container:'+self.database['Id'],'--ipc=none','--no-healthcheck','--restart=no','--read-only','--user=0:0',
              '--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=64','--memory=512m','--cpus=1','--interactive',
              '--mount','type=bind,src='+str(self.directory/'input')+',dst=/source-input,readonly',
              '--entrypoint','/usr/local/bin/node',r['imageId'],SCRIPT,'--capture']
        identifier=d.run(args).decode('ascii').strip()
        if not P.valid_hash(identifier):raise fail()
        r['containerId']=identifier;r['phase']='created';self._save()
        self._owned(running=False)
        self.pipe=Pipe(d,identifier)
        value=self.pipe.receive()
        fields={'schema','phase','collectionNonce','sourceSha256','identityBase64','descriptor','descriptorSha256'}
        if (set(value)!=fields or value['schema']!='orbis.sentinel-source-frame.v1' or value['phase']!='source'
            or value['collectionNonce']!=self.request['collectionNonce'] or not P.valid_hash(value['sourceSha256'])
            or type(value['identityBase64']) is not str or len(value['identityBase64'])>87384
            or type(value['descriptor']) is not dict):raise fail()
        source=base64.b64decode(value['identityBase64'],validate=True)
        if not 0<len(source)<=65536 or base64.b64encode(source).decode()!=value['identityBase64'] or digest(source)!=value['sourceSha256']:raise fail()
        # Node hashes insertion-order JSON. Recompute using that exact received
        # ordered object; witness descriptor itself uses canonical Root hashing.
        if digest(json.dumps(value['descriptor'],separators=(',',':'),ensure_ascii=False).encode())!=value['descriptorSha256']:raise fail()
        expected=digest(self.descriptor)
        if value['descriptor'].get('sourceBindingSha256')!=expected:raise fail()
        self.source=source;self.observation=value['descriptor'];self.worker_descriptor_hash=value['descriptorSha256']
        self._owned(running=True)
        self.record['phase']='awaiting-root-ack';self._save()
        self._check_original()
        pid=os.getpid();statline=Path('/proc/self/stat').read_text();ticks=int(statline[statline.rfind(') ')+2:].split()[19])
        self.descriptor['sql']=self.observation['database']
        self.descriptor['collector']={'protocol':PROTOCOL,'pid':pid,'startTicks':ticks,'programSha256':digest(Path(__file__).read_bytes()),'imageId':self.main['Image']}
        self.descriptor['exporter']={'cid':r['containerId'],'imageId':r['imageId'],'nonce':r['nonce'],
                                     'inputSha256':self.input_hash,'capabilitySha256':self.capability_sha,'protocol':PROTOCOL,'phase':'awaiting-root-ack'}
        self.witness={'schema':'orbis.bootstrap-source-witness.v1',**self.request,'sourceSha256':digest(source),
                      'descriptorSha256':digest(self.descriptor),'descriptor':self.descriptor,'capturedAtMs':int(time.time()*1000)}
        # origin is bound inside descriptor, not a second unsigned witness field.
        del self.witness['origin']
        witness_body=canonical(self.witness)+b'\n'
        # The independently loaded Root reader has the same finite file bound.
        # Refuse before publishing any source/witness pair that it cannot read.
        if len(witness_body)>32768:raise fail()
        self._write('source.json',source)
        self._write('witness.json',witness_body)

    def _capability(self):
        # A fixed actual image child, not a caller's capability dictionary.
        d=self.collector.docker;nonce=secrets.token_hex(16)
        record={'schema':'orbis.bootstrap-source-worker.v1','name':'orbis-bootstrap-source-'+nonce,'nonce':nonce,
                'imageId':self.main['Image'],'containerId':None,'phase':'intent','inputSha256':None}
        def save():
            with P._directory(self.directory) as fd:
                old=P._read(self.collector.authority,fd,'worker-capability.json')
                P._write(self.collector.authority,fd,'worker-capability.json',canonical(record)+b'\n',previous=old)
        save()
        args=['create','--pull=never','--name',record['name'],'--label',LABEL+'='+nonce,'--log-driver=none',
              '--network=none','--ipc=none','--no-healthcheck','--restart=no','--read-only','--user=0:0',
              '--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=64','--memory=512m','--cpus=1',
              '--entrypoint','/usr/local/bin/node',record['imageId'],SCRIPT,'--capability']
        record['containerId']=d.run(args).decode('ascii').strip()
        if not P.valid_hash(record['containerId']):raise fail()
        record['phase']='created';save();self._owned(running=False,record=record,mode='capability')
        result=decoded(d.run(['start','--attach',record['containerId']],maximum=8192,timeout=20))
        if canonical(result)!=canonical(CAPABILITY):raise fail()
        raw=self._owned(running=False,record=record,mode='capability')
        if raw['State'].get('ExitCode')!=0:raise fail()
        self._remove(record)
        record['phase']='complete';save();self.capability_sha=digest(result)

    def _remove(self,record):
        self.collector.docker.run(['rm',record['containerId']])
        for selector in ('label='+LABEL+'='+record['nonce'],'id='+record['containerId'],'name=^/'+record['name']+'$'):
            found=self.collector.docker.run(['ps','-a','--no-trunc','--filter',selector,'--format','{{.ID}}'])
            if found.strip():raise fail()

    def _owned(self,*,running,record=None,mode='capture'):
        record=self.record if record is None else record
        raw=self.collector.docker.object(['inspect','--format','{{json .}}',record['containerId']])
        cfg,hc,state=raw.get('Config',{}),raw.get('HostConfig',{}),raw.get('State',{})
        expected_mount=[] if mode=='capability' else [{'Type':'bind','Source':str(self.directory/'input'),'Destination':'/source-input','RW':False}]
        mounts=[{k:m.get(k) for k in ('Type','Source','Destination','RW')} for m in raw.get('Mounts',[])]
        if (raw.get('Id')!=record['containerId'] or raw.get('Name')!='/'+record['name'] or raw.get('Image')!=record['imageId']
            or cfg.get('Image')!=record['imageId'] or (cfg.get('Labels') or {}).get(LABEL)!=record['nonce']
            or cfg.get('Entrypoint')!=['/usr/local/bin/node'] or cfg.get('Cmd')!=[SCRIPT,'--'+mode] or cfg.get('User')!='0:0'
            or cfg.get('Volumes') not in (None,{}) or mounts!=expected_mount or hc.get('Privileged') is not False
            or hc.get('CapAdd') not in (None,[]) or hc.get('SecurityOpt')!=['no-new-privileges']
            or hc.get('Memory')!=512*1024*1024 or hc.get('NanoCpus')!=1000000000 or hc.get('PidsLimit')!=64
            or hc.get('Binds') not in (None,[]) or hc.get('Devices') not in (None,[]) or hc.get('DeviceRequests') not in (None,[])
            or hc.get('VolumesFrom') not in (None,[]) or hc.get('PortBindings') not in (None,{}) or hc.get('PublishAllPorts') is not False
            or hc.get('ReadonlyRootfs') is not True or hc.get('NetworkMode')!=('none' if mode=='capability' else 'container:'+self.database['Id'])
            or hc.get('IpcMode')!='none' or hc.get('CapDrop')!=['ALL'] or hc.get('LogConfig',{}).get('Type')!='none'
            or hc.get('RestartPolicy',{}).get('Name')!='no' or hc.get('AutoRemove') is not False
            or state.get('Running') is not running or any(state.get(k) is not False for k in ('Paused','Restarting','Dead'))):raise fail()
        if running:
            if type(state.get('Pid')) is not int or state['Pid']<=0:raise fail()
            net=os.stat('/proc/'+str(state['Pid'])+'/ns/net')
            if [net.st_dev,net.st_ino]!=self.descriptor['postgres']['networkNamespace']:raise fail()
        elif state.get('Pid')!=0:raise fail()
        return raw

    def _check_original(self):
        self.collector.service.require_credential_idle(self.guard)
        current,main,database=self.collector._observe(self.request['origin'])
        if any(current[k]!=self.descriptor[k] for k in ('installationId','origin','daemon','layoutSha256','hostService','main','postgres')):raise fail()
        for name,pin in self.files.items():
            pin.check()
            actual,_=mapped(main,'/data/.env' if name=='configuration' else '/data/state/auth/passkeys.json')
            if actual!=pin.path:raise fail()

    def check(self,challenge=None):
        if not self.active or self.pipe is None:raise fail()
        self._check_original();self._owned(running=True)
        challenge=token(challenge or secrets.token_urlsafe(32))
        self.pipe.send({'schema':'orbis.sentinel-source-command.v1','operation':'check',
                        'collectionNonce':self.request['collectionNonce'],'challenge':challenge})
        value=self.pipe.receive();self._reply(value,'checked',challenge);self._check_original()
        return {'sourceSha256':digest(self.source),'descriptorSha256':digest(self.descriptor),'challenge':challenge}

    def _reply(self,value,phase,challenge):
        expected={'schema':'orbis.sentinel-source-frame.v1','phase':phase,'collectionNonce':self.request['collectionNonce'],
                  'challenge':challenge,'sourceSha256':digest(self.source),'descriptorSha256':self.worker_descriptor_hash}
        if value!=expected:raise fail()

    def finish(self):
        self.check();challenge=secrets.token_urlsafe(32)
        self.pipe.send({'schema':'orbis.sentinel-source-command.v1','operation':'release',
                        'collectionNonce':self.request['collectionNonce'],'challenge':challenge})
        self._reply(self.pipe.receive(),'released',challenge);self.pipe.finish();self._owned(running=False)
        raw=self._owned(running=False)
        if raw['State'].get('ExitCode')!=0:raise fail()
        self._check_original();self._remove(self.record)
        self.record['phase']='complete';self._save();self.active=False;self.close()

    def close(self):
        # Abort never removes a child or source evidence. Its durable intent and
        # host hold require exact supervised reconciliation, even after timeout.
        self.active=False
        if self.pipe:self.pipe.close();self.pipe=None
        self.resources.close()
    def __enter__(self):
        if not self.active:raise fail()
        return self
    def __exit__(self,*args):self.close()
