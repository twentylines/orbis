#!/usr/bin/env python3
"""Prepare required Docker services through a reviewed, recoverable host transaction."""
import argparse
import base64
import contextlib
from contextvars import ContextVar
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request
import uuid

DOCKER_SIGNING_BLOCK_SHA256 = '1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570'
KEY_FINGERPRINT = '9DC858229FC7DD38854AE2D88D81803C0EBFCD88'
ENGINE_PACKAGES = {'docker-ce','docker-ce-cli','containerd.io','docker-buildx-plugin','docker-compose-plugin'}
LEGACY_PACKAGES = {'docker.io','docker-cli','docker-compose','docker-compose-v2','docker-buildx','containerd','runc'}
DOCKER_PACKAGES = ENGINE_PACKAGES | LEGACY_PACKAGES
DEPENDENCIES = {'iproute2','rsync','ca-certificates','iptables','nftables','libacl1','libbpf0','libbpf1','libbsd0','libc6','libcap2','libdb5.3','libdb5.3t64','libedit2','libelf1','libelf1t64','libgmp10','libip4tc2','libip6tc2','libjansson4','liblz4-1','libmd0','libmnl0','libnetfilter-conntrack3','libnfnetlink0','libnftables1','libnftnl11','libpcre2-8-0','libpopt0','libreadline8','libreadline8t64','libseccomp2','libselinux1','libssl3','libssl3t64','libsystemd0','libtinfo6','libxtables12','libxxhash0','libzstd1','openssl','init-system-helpers','lsb-base'}
SYSTEMS = {('debian','12','bookworm'),('debian','13','trixie'),('ubuntu','22.04','jammy'),('ubuntu','24.04','noble')}
SERVICES = ['/usr/bin/systemctl','/usr/bin/systemd-run','/usr/bin/deb-systemd-helper','/usr/bin/deb-systemd-invoke','/usr/sbin/invoke-rc.d','/usr/sbin/service','/usr/sbin/update-rc.d','/usr/sbin/start-stop-daemon']
ENV = {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','DEBIAN_FRONTEND':'noninteractive','NEEDRESTART_MODE':'l'}
LOG_DIRECTORY = ContextVar('orbis_setup_log_directory',default=None)
PACKAGE = re.compile(r'[a-z0-9][a-z0-9+.-]*(?::(?:arm64|amd64|all))?')
VERSION = re.compile(r'[0-9A-Za-z.+:~_-]{1,180}')
CONTAINER = re.compile(r'[a-f0-9]{64}')


class PrerequisiteError(ValueError):
    pass


def sha(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for data in iter(lambda:stream.read(1024*1024),b''):result.update(data)
    return result.hexdigest()


def host():
    if sys.platform!='linux' or os.geteuid()!=0 or sys.version_info<(3,10) or sys.maxsize<2**63-1 or platform.machine().lower() not in {'aarch64','arm64','x86_64','amd64'}:
        raise PrerequisiteError('Docker setup requires root on 64-bit ARM64 or AMD64 Linux with Python 3.10 or newer.')


def private_directory(path):
    path=Path(path)
    if not path.is_absolute() or path!=path.resolve(strict=False):raise PrerequisiteError('Docker setup storage must be an absolute private directory without symlinks.')
    for parent in reversed([path,*path.parents]):
        if not parent.exists():parent.mkdir(mode=0o700)
        info=parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o022:raise PrerequisiteError('Docker setup storage has an unsafe parent.')
    if path.stat().st_mode&0o077:raise PrerequisiteError('Docker setup storage must be private.')
    return path


def protected(path,maximum=8*1024*1024):
    path=Path(path);info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.geteuid() or info.st_mode&0o022 or info.st_size>maximum:raise PrerequisiteError('A Docker setup input changed or has unsafe permissions.')
    return path


def save(path,value):
    path=Path(path);temporary=path.with_name(path.name+'.'+str(uuid.uuid4())+'.tmp')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as stream:json.dump(value,stream,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    os.replace(temporary,path)
    fd=os.open(path.parent,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)


def read(path):return json.loads(protected(path).read_text())


def run(args,*,cwd=None,timeout=180,ok=(0,),binary=False):
    environment=dict(ENV)
    if args[0] in {'/usr/bin/apt-get','/usr/bin/apt-cache'}:
        source=next((value.split('=',1)[1] for value in args if value.startswith('Dir::Etc::sourcelist=')),None)
        if source is None:raise PrerequisiteError('APT requires an isolated transaction configuration.')
        configuration=protected(Path(source).parent/'apt.conf',65536)
        environment['APT_CONFIG']=str(configuration)
    result=subprocess.run(args,cwd=cwd,env=environment,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout,check=False)
    log_directory=LOG_DIRECTORY.get()
    if log_directory is not None:
        log=Path(log_directory)/('command-'+str(uuid.uuid4())+'.json')
        save(log,{'command':args,'returncode':result.returncode,'stdout':result.stdout[:8*1024*1024].decode('utf-8',errors='replace'),'stderr':result.stderr[:8*1024*1024].decode('utf-8',errors='replace')})
    if result.returncode not in ok or len(result.stdout)>8*1024*1024 or len(result.stderr)>8*1024*1024:raise PrerequisiteError('Required Docker setup command failed. Its private journal has been preserved; no data directory was removed.')
    return result.stdout if binary else result.stdout.decode('utf-8',errors='strict').strip()


def docker(context,args,**kwargs):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}',context):raise PrerequisiteError('Docker context is invalid.')
    return run(['docker','--context',context,*args],**kwargs)


def supported_system(value,architecture):
    pair=(value.get('ID'),value.get('VERSION_ID'),value.get('VERSION_CODENAME'))
    if pair not in SYSTEMS or architecture not in {'arm64','amd64'}:raise PrerequisiteError('Automatic Docker setup supports 64-bit Debian 12/13, Raspberry Pi OS using those Debian releases, and Ubuntu 22.04/24.04. Keep existing Docker packages until this host is reviewed.')
    return {'distribution':pair[0],'version':pair[1],'codename':pair[2],'architecture':architecture}


def versions(system):
    suffix='~'+system['distribution']+'.'+system['version']+'~'+system['codename']
    return {'docker-ce':'5:29.9.2-1'+suffix,'docker-ce-cli':'5:29.9.2-1'+suffix,'containerd.io':'2.4.2-3'+suffix,'docker-buildx-plugin':'0.38.1-1'+suffix,'docker-compose-plugin':'5.6.1-1'+suffix}


def key_fingerprint(data):
    if len(data)!=3817 or hashlib.sha256(data).hexdigest()!=DOCKER_SIGNING_BLOCK_SHA256:raise PrerequisiteError('The official Docker signing key changed. Repository trust was not modified.')
    lines=data.decode('ascii').splitlines();start=lines.index('')+1
    raw=base64.b64decode(''.join(line for line in lines[start:] if line and not line.startswith(('=','-----'))),validate=True)
    # The pinned official block begins with a version-four primary public-key packet.
    if raw[0]!=0x99:raise PrerequisiteError('The Docker public-key format changed.')
    size=int.from_bytes(raw[1:3],'big');body=raw[3:3+size]
    if len(body)!=size or body[0]!=4:raise PrerequisiteError('The Docker primary public key is invalid.')
    fingerprint=hashlib.sha1(b'\x99'+size.to_bytes(2,'big')+body).hexdigest().upper()
    if fingerprint!=KEY_FINGERPRINT:raise PrerequisiteError('The Docker public-key fingerprint changed.')
    return fingerprint


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*_args,**_kwargs):return None


def fetch_key(system):
    url='https://download.docker.com/linux/'+system['distribution']+'/gpg'
    with urllib.request.build_opener(NoRedirect).open(url,timeout=20) as response:data=response.read(65537)
    key_fingerprint(data)
    return data


def apt_sources(system,key):
    distribution=system['distribution'];code=system['codename'];arch=system['architecture']
    if distribution=='debian':
        os_key='/usr/share/keyrings/debian-archive-keyring.gpg'
        repositories=[('https://deb.debian.org/debian',code+' '+code+'-updates'),('https://security.debian.org/debian-security',code+'-security')]
    else:
        os_key='/usr/share/keyrings/ubuntu-archive-keyring.gpg'
        mirror='https://ports.ubuntu.com/ubuntu-ports' if arch=='arm64' else 'https://archive.ubuntu.com/ubuntu'
        repositories=[(mirror,code+' '+code+'-updates'),(mirror if arch=='arm64' else 'https://security.ubuntu.com/ubuntu',code+'-security')]
    protected(os_key,4*1024*1024)
    components='main universe' if distribution=='ubuntu' else 'main'
    entries=[f'Types: deb\nURIs: {url}\nSuites: {suites}\nComponents: {components}\nArchitectures: {arch}\nSigned-By: {os_key}\n' for url,suites in repositories]
    entries.append(f'Types: deb\nURIs: https://download.docker.com/linux/{distribution}\nSuites: {code}\nComponents: stable\nArchitectures: {arch}\nSigned-By: {key}\n')
    return '\n'.join(entries)


def apt_command(directory):
    directory=Path(directory)
    options={'Dir::Etc::sourcelist':str(directory/'sources.sources'),'Dir::Etc::sourceparts':'-','Dir::Etc::main':'/dev/null','Dir::Etc::parts':'-','Dir::State::lists':str(directory/'lists'),'Dir::Cache::archives':str(directory/'archives'),'DPkg::Lock::Timeout':'30','Acquire::Retries':'1','Acquire::http::Timeout':'20','Acquire::https::Timeout':'20','APT::Update::Error-Mode':'any','APT::Get::AllowUnauthenticated':'false','Acquire::AllowInsecureRepositories':'false','Acquire::AllowDowngradeToInsecureRepositories':'false'}
    return ['/usr/bin/apt-get',*[item for key,value in options.items() for item in ['-o',key+'='+value]]]


def parse_simulation(text,installed,requested,allow_replacement=False,recovery=False,permitted_removals=None):
    if len(text.encode())>2*1024*1024:raise PrerequisiteError('Docker package review exceeded its limit.')
    selected,removed={},{}
    for line in text.splitlines():
        if line.startswith('Purg '):raise PrerequisiteError('Docker setup never purges packages.')
        if line.startswith('Remv '):
            found=re.fullmatch(r'Remv ([a-z0-9][a-z0-9+.-]*)(?::(?:arm64|amd64))? \[([^\]]+)\](?: .*)?',line)
            if not allow_replacement or not found or (found[1] not in DOCKER_PACKAGES and (not recovery or (permitted_removals or {}).get(found[1])!=found[2])) or installed.get(found[1])!=found[2]:raise PrerequisiteError('Docker setup would remove an unrelated package.')
            removed[found[1]]=found[2]
        if line.startswith('Inst '):
            found=re.fullmatch(r'Inst ([a-z0-9][a-z0-9+.-]*)(?::(?:arm64|amd64))?(?: \[([^\]]+)\])? \(([^\s()]+) [^\n]+\)',line)
            if not found or found[1] in selected or found[1] not in ENGINE_PACKAGES|DEPENDENCIES|(LEGACY_PACKAGES if recovery else set()) or not VERSION.fullmatch(found[3]):raise PrerequisiteError('Docker setup proposed an unsupported dependency.')
            name,old,new=found.groups()
            if old and (name not in ENGINE_PACKAGES|DEPENDENCIES|(LEGACY_PACKAGES if recovery else set()) or installed.get(name)!=old):raise PrerequisiteError('Docker setup would upgrade unrelated host packages.')
            if not old and name in installed:raise PrerequisiteError('Installed package state changed during Docker review.')
            if name in requested and requested[name]!=new:raise PrerequisiteError('Docker package versions changed during review.')
            selected[name]={'old':old,'version':new}
        if line.startswith('Conf '):
            found=re.fullmatch(r'Conf ([a-z0-9][a-z0-9+.-]*)(?::(?:arm64|amd64))? \(([^\s()]+) [^\n]+\)',line)
            if not found or selected.get(found[1],{}).get('version')!=found[2]:raise PrerequisiteError('Docker setup would configure an unrelated package.')
    if not selected or len(selected)>64 or any(name not in selected and installed.get(name)!=version for name,version in requested.items()):raise PrerequisiteError('Required Docker packages were not confirmed by APT.')
    return {'selected':selected,'removed':removed}


def installed_packages(recovery=False):
    result=run(['/usr/bin/dpkg-query','-W','-f=${binary:Package}\t${Version}\t${db:Status-Status}\n'])
    packages={}
    for line in result.splitlines():
        fields=line.split('\t')
        if len(fields)!=3:raise PrerequisiteError('Installed package state is invalid.')
        name,version,status=fields;name=name.split(':')[0]
        if status=='installed':packages[name]=version
        elif recovery and status in {'unpacked','half-configured','half-installed','triggers-awaited','triggers-pending'}:packages[name]=version
        elif status not in {'not-installed','config-files'}:raise PrerequisiteError('Finish package recovery before Docker setup.')
    return packages


def inspect(context='default'):
    host()
    if shutil.which('docker') is None:return {'kind':'install','context':context,'engine':None,'compose':None}
    try:endpoint=json.loads(docker(context,['context','inspect',context,'--format','{{json .Endpoints.docker.Host}}']))
    except (PrerequisiteError,OSError,json.JSONDecodeError,subprocess.SubprocessError) as error:raise PrerequisiteError('The selected Docker context could not be inspected. Its packages and services were not changed.') from error
    if endpoint not in {'unix:///var/run/docker.sock','unix:///run/docker.sock'} or Path(endpoint[7:]).is_symlink():raise PrerequisiteError('Automatic Docker setup requires the local default rootful Docker socket; custom or remote endpoints were not changed.')
    try:
        version=json.loads(docker(context,['version','--format','{{json .Server}}']))
        api=version.get('ApiVersion') or version.get('APIVersion')
        if not isinstance(api,str) or not re.fullmatch(r'1\.[0-9]{2,3}',api):raise PrerequisiteError('Docker returned an unsupported API version.')
    except (PrerequisiteError,OSError,json.JSONDecodeError,subprocess.SubprocessError) as error:
        if context=='default':
            loaded=run(['/usr/bin/systemctl','show','docker.service','--property=LoadState','--value'],ok=(0,1,3,4))
            if loaded=='loaded' and run(['/usr/bin/systemctl','is-active','docker.service'],ok=(0,1,3,4))!='active':return {'kind':'start','context':context,'engine':None,'compose':None}
            if loaded=='not-found' and not any(Path(path).exists() for path in ['/var/lib/docker','/var/lib/containerd']):return {'kind':'install','context':context,'engine':None,'compose':None}
        raise PrerequisiteError('The selected Docker daemon needs a configuration or permissions repair. Its existing packages, containers and data were preserved.') from error
    try:
        compose=docker(context,['compose','version','--short'])
        match=re.fullmatch(r'v?(\d+)\.(\d+)\.\d+(?:[-+][0-9A-Za-z.-]+)?',compose)
        compose_ready=bool(match and (int(match[1]),int(match[2]))>=(2,20))
    except (PrerequisiteError,OSError,subprocess.SubprocessError):compose=None;compose_ready=False
    return {'kind':'ready' if int(api.split('.')[1])>=44 and compose_ready else 'compose' if int(api.split('.')[1])>=44 else 'upgrade','context':context,'engine':version.get('Version'),'api':api,'compose':compose}


def service_helpers():
    result={}
    for name in SERVICES:
        path=Path(name).resolve(strict=True);protected(path,8*1024*1024)
        result[str(path)]=sha(path)
    return result


def archive_record(path):
    path=protected(path,256*1024*1024)
    fields=run(['/usr/bin/dpkg-deb','--field',str(path),'Package','Version','Architecture'])
    values=dict(line.split(': ',1) for line in fields.splitlines() if ': ' in line)
    name=values.get('Package');version=values.get('Version');arch=values.get('Architecture')
    if name not in ENGINE_PACKAGES|DEPENDENCIES|LEGACY_PACKAGES or not VERSION.fullmatch(version or '') or arch not in {'arm64','amd64','all'}:raise PrerequisiteError('A downloaded Docker setup archive has an unexpected identity.')
    control=run(['/usr/bin/dpkg-deb','--ctrl-tarfile',str(path)],binary=True)
    if len(control)>2*1024*1024:raise PrerequisiteError('Package control data exceeded its limit.')
    scripts={}
    with tarfile.open(fileobj=io.BytesIO(control),mode='r:') as archive:
        for member in archive:
            item=member.name.removeprefix('./')
            if item not in {'preinst','postinst','prerm','postrm','triggers'}:continue
            if not member.isreg() or member.issparse() or member.size>128*1024 or item in scripts:raise PrerequisiteError('Package maintainer metadata is invalid.')
            with archive.extractfile(member) as stream:data=stream.read(member.size+1)
            if len(data)!=member.size:raise PrerequisiteError('Package maintainer data was truncated.')
            scripts[item]={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
    return {'name':name,'version':version,'architecture':arch,'path':str(path),'sha256':sha(path),'scripts':scripts}


def verify_protocol(plan,protocol):
    lines=protocol.splitlines()
    if len(protocol.encode())>2*1024*1024 or not lines or lines[0]!='VERSION 2' or '' not in lines:raise PrerequisiteError('APT did not supply the required transaction protocol.')
    expected=plan['packages'];removed=plan['removed'];unpacked=set();configured=set();deleted=set()
    for line in lines[lines.index('')+1:]:
        fields=line.split()
        if len(fields)!=5:raise PrerequisiteError('APT returned an invalid Docker package action.')
        name,old,direction,new,action=fields;name=name.split(':')[0]
        if action=='**REMOVE**':
            if name not in removed or old!=removed[name] or new!='-' or direction!='>' or name in deleted:raise PrerequisiteError('APT attempted an unreviewed package removal.')
            deleted.add(name);continue
        item=expected.get(name)
        if not item or old!=(item['old'] or '-') or direction!=item.get('direction','<') or new!=item['version']:raise PrerequisiteError('APT attempted a changed or unrelated package operation.')
        if action=='**CONFIGURE**':
            if name in configured:raise PrerequisiteError('APT duplicated a package configuration.')
            configured.add(name)
        elif action==item['path'] and name not in unpacked:
            if sha(protected(action,256*1024*1024))!=item['sha256']:raise PrerequisiteError('A reviewed package archive changed.')
            unpacked.add(name)
        else:raise PrerequisiteError('APT attempted an unreviewed package action.')
    if unpacked!=set(expected) or deleted!=set(removed):raise PrerequisiteError('APT omitted a reviewed package operation.')
    return True


def inventory(context):
    info=json.loads(docker(context,['info','--format','{{json .}}']))
    security=info.get('SecurityOptions') or []
    if info.get('DockerRootDir')!='/var/lib/docker' or info.get('Driver') not in {'overlay2','overlayfs'} or info.get('Swarm',{}).get('LocalNodeState')!='inactive' or any('rootless' in str(item) for item in security):
        raise PrerequisiteError('This Docker storage, rootless or Swarm layout needs a separate update review. Containers and data were preserved.')
    identifiers=docker(context,['container','ls','--all','--no-trunc','--quiet']).splitlines()
    if len(identifiers)>2048 or any(not CONTAINER.fullmatch(item) for item in identifiers):raise PrerequisiteError('Docker container inventory is invalid or exceeds its limit.')
    containers=[]
    projection='{"id":{{json .Id}},"imageId":{{json .Image}},"image":{{json .Config.Image}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"restarting":{{json .State.Restarting}},"autoRemove":{{json .HostConfig.AutoRemove}},"restart":{{json .HostConfig.RestartPolicy}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}}'
    for identifier in sorted(identifiers):
        value=json.loads(docker(context,['container','inspect','--format',projection,identifier]))
        if value.get('id')!=identifier or value.get('autoRemove') or value.get('paused') or value.get('restarting'):raise PrerequisiteError('Finish paused, restarting or automatically removed container operations before Docker setup.')
        policy=value.get('restart',{})
        if policy.get('Name') not in {'no','always','unless-stopped','on-failure'} or type(policy.get('MaximumRetryCount')) is not int:raise PrerequisiteError('A container restart policy could not be preserved.')
        value['networks']={name:{key:network.get(key) for key in ['NetworkID','Aliases','IPAMConfig']} for name,network in sorted((value.get('networks') or {}).items())}
        containers.append(value)
    networks=[]
    for identifier in sorted(docker(context,['network','ls','--no-trunc','--quiet']).splitlines()):
        if not CONTAINER.fullmatch(identifier):raise PrerequisiteError('Docker network identity is invalid.')
        value=json.loads(docker(context,['network','inspect','--format','{"id":{{json .Id}},"name":{{json .Name}},"driver":{{json .Driver}},"internal":{{json .Internal}},"ipam":{{json .IPAM}}}',identifier]))
        networks.append(value)
    volumes=[]
    for name in sorted(docker(context,['volume','ls','--quiet']).splitlines()):
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}',name):raise PrerequisiteError('Docker volume identity is invalid.')
        volumes.append(json.loads(docker(context,['volume','inspect','--format','{"name":{{json .Name}},"driver":{{json .Driver}},"mountpoint":{{json .Mountpoint}},"options":{{json .Options}},"labels":{{json .Labels}}}',name])))
    images=sorted(set(docker(context,['image','ls','--no-trunc','--quiet']).splitlines()))
    if any(not re.fullmatch(r'sha256:[a-f0-9]{64}',item) for item in images):raise PrerequisiteError('Docker image inventory is invalid.')
    return {'root':'/var/lib/docker','driver':info['Driver'],'containers':containers,'networks':networks,'volumes':volumes,'images':images}


def same_inventory(before,after,*,restored=False):
    if any(before[key]!=after[key] for key in ['root','driver','networks','volumes','images']):return False
    if len(before['containers'])!=len(after['containers']):return False
    for old,new in zip(before['containers'],after['containers']):
        keys=['id','imageId','image','mounts','networks']+(['running','restart'] if restored else [])
        if any(old.get(key)!=new.get(key) for key in keys):return False
    return True


def require_exclusive_engine(installed):
    if installed.get('podman-docker') or any(Path(path).exists() for path in ['/var/lib/rancher','/etc/rancher','/var/snap/microk8s','/run/k3s']):raise PrerequisiteError('Docker setup will not replace shared Kubernetes, Podman or other container runtimes.')
    if 'containerd' in installed or 'containerd.io' in installed:
        ctr=shutil.which('ctr')
        if ctr is None:raise PrerequisiteError('The existing container runtime cannot be identified safely; its packages were retained.')
        namespaces=set(run([ctr,'namespaces','list','--quiet']).splitlines())
        if not namespaces.issubset({'moby','plugins.moby'}):raise PrerequisiteError('Other workloads share containerd. Docker setup preserved their runtime; review that shared host separately.')


def public_directory(path):
    path=Path(path)
    if not path.is_absolute() or path!=path.resolve(strict=False):raise PrerequisiteError('Public package cache path is unsafe.')
    for parent in reversed([path,*path.parents]):
        if not parent.exists():parent.mkdir(mode=0o755)
        info=parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise PrerequisiteError('Package cache ownership is unsafe.')
    return path


def prepare_repository(directory,system):
    key=fetch_key(system)
    key_path=Path('/etc/apt/keyrings/orbis-docker.asc')
    public_directory(key_path.parent)
    if key_path.exists() or key_path.is_symlink():
        key_fingerprint(protected(key_path,65536).read_bytes())
    else:
        fd=os.open(key_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
        with os.fdopen(fd,'wb') as stream:stream.write(key);stream.flush();os.fsync(stream.fileno())
    directory=public_directory(directory)
    (directory/'sources.sources').write_text(apt_sources(system,key_path));(directory/'sources.sources').chmod(0o644)
    configuration='Dir::Etc::parts "-";\nDir::Etc::main "/dev/null";\n#clear DPkg::Pre-Invoke;\n#clear DPkg::Post-Invoke;\n#clear DPkg::Pre-Install-Pkgs;\n#clear APT::Update::Pre-Invoke;\n#clear APT::Update::Post-Invoke;\n#clear APT::Update::Post-Invoke-Success;\nAPT::Get::AutomaticRemove "false";\n'
    (directory/'apt.conf').write_text(configuration);(directory/'apt.conf').chmod(0o644)
    for name in ['lists','archives','rollback']:(directory/name).mkdir(mode=0o755)
    run([*apt_command(directory),'update'])


def requested_packages(action,system,installed):
    fixed=versions(system)
    names=ENGINE_PACKAGES if action['kind'] in {'install','upgrade'} else {'docker-compose-plugin'} if action['kind']=='compose' else set()
    requested={name:fixed[name] for name in sorted(names)}
    for name in ['iproute2','rsync','ca-certificates']:
        if name not in installed:requested[name]=None
    for name in required_tools():requested[name]=None
    return requested


def simulate(directory,installed,requested,allow_replacement):
    targets=[name+('='+version if version else '') for name,version in sorted(requested.items())]
    flags=['--no-install-recommends']+([] if allow_replacement else ['--no-remove'])
    output=run([*apt_command(directory),'--simulate','install',*flags,*targets])
    return parse_simulation(output,installed,{key:value for key,value in requested.items() if value},allow_replacement)


def acquire_archives(directory,review):
    targets=[name+'='+item['version'] for name,item in sorted(review['selected'].items())]
    run([*apt_command(directory),'--download-only','--yes','--no-install-recommends','install',*targets],timeout=900)
    found={}
    for path in sorted((directory/'archives').glob('*.deb')):
        record=archive_record(path)
        name=record['name'];selected=review['selected'].get(name)
        if not selected or name in found or selected['version']!=record['version']:raise PrerequisiteError('Downloaded setup archives do not match the reviewed transaction.')
        found[name]={**record,'old':selected['old']}
    if set(found)!=set(review['selected']):raise PrerequisiteError('A reviewed setup archive is missing.')
    return found


def backup_packages(directory,installed,review):
    # Exact old packages are collected before any daemon, policy or package changes.
    originals={name:installed[name] for name in set(review['selected'])|set(review['removed']) if name in installed}
    for name,version in sorted(originals.items()):
        run([*apt_command(directory),'download',name+'='+version],cwd=directory/'rollback',timeout=300)
    archives={}
    for path in (directory/'rollback').glob('*.deb'):
        record=archive_record(path)
        if originals.get(record['name'])!=record['version'] or record['name'] in archives:raise PrerequisiteError('The previous package recovery set changed.')
        archives[record['name']]=record
    if set(archives)!=set(originals):raise PrerequisiteError('The exact previous packages could not be retained. No container was stopped; preserve the journal and review the installed package version.')
    return archives


def package_apply_command(directory,plan_file):
    worker=directory/'worker.py'
    guard=directory/'guard'
    if not guard.exists():
        guard.write_text('#!/bin/sh\nexec /usr/bin/python3 '+shlex.quote(str(worker))+' --verify '+shlex.quote(str(plan_file))+'\n');guard.chmod(0o700)
    protected(guard,4096)
    hook=str(guard)
    return [*apt_command(Path(read(plan_file)['aptDirectory'])),'-o','DPkg::Pre-Install-Pkgs::='+shlex.quote(hook),'-o','DPkg::Tools::Options::'+hook+'::Version=2','-o','Dpkg::Options::=--force-confold','--no-download','--yes','--no-install-recommends','install',*(['--allow-downgrades','--reinstall'] if read(plan_file).get('recovery') else []),*[item['path'] for _,item in sorted(read(plan_file)['packages'].items())],*[name+'-' for name in sorted(read(plan_file)['removed'])]]


def apply_namespace(directory,plan_file):
    host();directory=private_directory(directory);LOG_DIRECTORY.set(directory);plan=read(plan_file)
    if plan.get('schema')!='orbis.docker-packages.v1' or plan.get('sourceSha256')!=sha(protected(__file__)) or plan.get('directory')!=str(directory):raise PrerequisiteError('Docker package worker source or transaction changed.')
    current=os.stat('/proc/self/ns/mnt')
    parent=plan.get('parentNamespace')
    if not isinstance(parent,list) or len(parent)!=2 or not all(type(value) is int for value in parent) or parent==[current.st_dev,current.st_ino]:raise PrerequisiteError('Docker package changes require their private mount namespace.')
    run(['/usr/bin/mount','--make-rprivate','/'])
    helpers=service_helpers()
    if helpers!=plan['helpers']:raise PrerequisiteError('Service helpers changed before the protected transaction.')
    true=Path('/usr/bin/true').resolve(strict=True);protected(true)
    for target in helpers:
        run(['/usr/bin/mount','--bind',str(true),target])
        run(['/usr/bin/mount','-o','remount,bind,ro',target])
        if not os.path.samefile(true,target):raise PrerequisiteError('Transaction-local service suppression was not established.')
    run(package_apply_command(directory,plan_file),timeout=1800)
    if read(directory/'guard-receipt.json')!={'verified':True,'planSha256':sha(plan_file)}:raise PrerequisiteError('APT did not confirm the reviewed Docker package guard.')


def apply_packages(directory,review,archives,apt_directory,*,recovery=False):
    helpers=service_helpers()
    for name in ['/usr/bin/unshare','/usr/bin/mount','/usr/bin/dpkg-deb','/usr/bin/python3']:
        protected(Path(name).resolve(strict=True),64*1024*1024)
    worker=directory/'worker.py'
    shutil.copyfile(protected(__file__),worker);worker.chmod(0o600)
    plan={'schema':'orbis.docker-packages.v1','directory':str(directory),'aptDirectory':str(apt_directory),'sourceSha256':sha(worker),'packages':archives,'removed':review['removed'],'recovery':recovery,'helpers':helpers,'parentNamespace':[os.stat('/proc/self/ns/mnt').st_dev,os.stat('/proc/self/ns/mnt').st_ino]}
    plan_file=directory/'package-plan.json';save(plan_file,plan)
    run(['/usr/bin/unshare','--mount','--fork','--propagation','private','/usr/bin/python3',str(worker),'--apply-namespace',str(directory),str(plan_file)],timeout=1900)
    if service_helpers()!=helpers:raise PrerequisiteError('Host service helper files changed unexpectedly; preserve the setup journal.')


def restart_argument(policy):
    name=policy['Name']
    return 'on-failure:'+str(policy['MaximumRetryCount']) if name=='on-failure' and policy['MaximumRetryCount'] else name


def quiesce(context,snapshot):
    if not same_inventory(snapshot,inventory(context),restored=True):raise PrerequisiteError('Docker workloads changed before setup; review the refreshed journal before retrying.')
    for item in snapshot['containers']:docker(context,['container','update','--restart=no',item['id']])
    for item in snapshot['containers']:
        if item['running']:docker(context,['container','stop','--time','60',item['id']],timeout=90)
    if any(item['running'] for item in inventory(context)['containers']):raise PrerequisiteError('A container restarted during Docker setup. No package was changed.')
    run(['/usr/bin/systemctl','stop','docker.socket','docker.service','containerd.service'],timeout=180)


def restore_workloads(context,snapshot):
    current=inventory(context)
    if not same_inventory(snapshot,current):raise PrerequisiteError('Docker container, image, storage or network identities changed; automatic app resume was stopped.')
    for item in snapshot['containers']:docker(context,['container','update','--restart='+restart_argument(item['restart']),item['id']])
    running={item['id'] for item in current['containers'] if item['running']}
    for item in snapshot['containers']:
        if item['running'] and item['id'] not in running:docker(context,['container','start',item['id']],timeout=120)
        elif not item['running'] and item['id'] in running:raise PrerequisiteError('A previously stopped container started unexpectedly; review its state before continuing.')
    if not same_inventory(snapshot,inventory(context),restored=True):raise PrerequisiteError('Original Docker workloads have not yet been confirmed. Preserve the journal before retrying.')


def storage_seal(root,*,volume_data_only=False):
    root=Path(root);result=hashlib.sha256();count=0;hardlinks={}
    def visit(folder):
        nonlocal count
        for path in sorted(folder.iterdir()):
            relative=path.relative_to(root);info=path.lstat()
            include=not volume_data_only or '_data' in relative.parts
            count+=int(include)
            if count>2_000_000:raise PrerequisiteError('Docker checkpoint contains too many entries for automatic recovery.')
            record={'path':str(relative),'mode':stat.S_IMODE(info.st_mode),'uid':info.st_uid,'gid':info.st_gid,'mtime':info.st_mtime_ns}
            if stat.S_ISLNK(info.st_mode):record.update(kind='link',target=os.readlink(path))
            elif stat.S_ISDIR(info.st_mode):record['kind']='directory'
            elif stat.S_ISREG(info.st_mode):
                record.update(kind='file',bytes=info.st_size,sha256=sha(path))
                if info.st_nlink>1:
                    key=(info.st_dev,info.st_ino)
                    record['hardlink']=hardlinks.setdefault(key,str(relative))
            elif stat.S_ISBLK(info.st_mode) and path.name=='backingFsBlockDev':record.update(kind='device',number=info.st_rdev)
            else:raise PrerequisiteError('A Docker checkpoint contains an unsupported live socket, device or special file. Preserve the journal and review its storage.')
            if hasattr(os,'listxattr'):
                record['attributes']={name:hashlib.sha256(os.getxattr(path,name,follow_symlinks=False)).hexdigest() for name in sorted(os.listxattr(path,follow_symlinks=False))}
            if include:result.update(json.dumps(record,sort_keys=True).encode()+b'\n')
            if stat.S_ISDIR(info.st_mode):visit(path)
    if root.is_symlink():raise PrerequisiteError('Docker checkpoint roots cannot be symbolic links.')
    if root.is_dir():visit(root)
    else:
        info=root.stat();result.update(json.dumps({'mode':stat.S_IMODE(info.st_mode),'uid':info.st_uid,'gid':info.st_gid,'mtime':info.st_mtime_ns,'bytes':info.st_size},sort_keys=True).encode())
        result.update(root.read_bytes())
    return {'sha256':result.hexdigest(),'entries':count}


def storage_requirements(directory):
    required=0
    sources=[Path('/var/lib/docker'),Path('/var/lib/containerd'),Path('/etc/docker'),Path('/etc/containerd')]
    sources += [Path('/etc/systemd/system')/name for name in ['docker.service','docker.service.d','containerd.service','containerd.service.d']]
    records=[]
    for source in sources:
        if not source.exists():continue
        if source.is_symlink() or source==directory or source in directory.parents or directory in source.parents:raise PrerequisiteError('Docker recovery storage overlaps a live source or symlink.')
        if source.is_dir():required+=int(run(['/usr/bin/du','-sx','--block-size=1',str(source)]).split()[0])
        else:required+=source.stat().st_size
        records.append({'source':str(source),'backup':str(directory/'storage'/str(len(records)))})
    if shutil.disk_usage(directory).free<required+1024**3:raise PrerequisiteError('Docker update needs more private recovery storage. Choose a private installer state directory on a larger disk before changing the daemon.')
    return records


def require_no_nested_mounts(records):
    raw=Path('/proc/self/mountinfo').read_text()
    if len(raw)>2*1024*1024:raise PrerequisiteError('Host mount inventory exceeded the checkpoint limit.')
    roots=[Path(item['source']) for item in records]
    for line in raw.splitlines():
        fields=line.split()
        if len(fields)<10 or ' - ' not in line:raise PrerequisiteError('Host mount inventory is invalid.')
        target=Path(re.sub(r'\\([0-7]{3})',lambda match:chr(int(match[1],8)),fields[4]))
        if any(root in target.parents for root in roots):raise PrerequisiteError('Docker storage contains a nested mounted filesystem or a remaining live layer. It was not copied or overwritten.')


def checkpoint_storage(directory,records=None):
    records=records or storage_requirements(directory)
    require_no_nested_mounts(records)
    (directory/'storage').mkdir(mode=0o700)
    for record in records:
        before=storage_seal(record['source'])
        run(['/usr/bin/cp','--archive','--reflink=auto','--sparse=always',record['source'],record['backup']],timeout=3600)
        if storage_seal(record['backup'])!=before or storage_seal(record['source'])!=before:raise PrerequisiteError('Docker recovery storage changed during its stopped-state checkpoint. No package was changed.')
        record['seal']=before
        if record['source']=='/var/lib/docker':record['volumeDataSeal']=storage_seal(Path(record['source'])/'volumes',volume_data_only=True) if (Path(record['source'])/'volumes').exists() else None
    require_no_nested_mounts(records)
    os.sync();save(directory/'storage.json',records)
    return records


def restore_storage(directory):
    records=read(directory/'storage.json')
    require_no_nested_mounts(records)
    for record in records:
        source=Path(record['source']);backup=Path(record['backup'])
        if str(source) not in {'/var/lib/docker','/var/lib/containerd','/etc/docker','/etc/containerd','/etc/systemd/system/docker.service','/etc/systemd/system/docker.service.d','/etc/systemd/system/containerd.service','/etc/systemd/system/containerd.service.d'} or backup.parent!=directory/'storage' or storage_seal(backup)!=record['seal'] or source.is_symlink():raise PrerequisiteError('Docker recovery source, destination or checkpoint seal changed.')
        expected=record.get('volumeDataSeal')
        if expected is not None and storage_seal(source/'volumes',volume_data_only=True)!=expected:raise PrerequisiteError('App volume data changed after the checkpoint. Automatic rollback will not discard those writes; preserve the journal for recovery review.')
    for record in records:
        source=Path(record['source']);backup=Path(record['backup'])
        if backup.is_dir():
            source.mkdir(parents=True,exist_ok=True)
            run(['/usr/bin/rsync','--archive','--acls','--xattrs','--hard-links','--numeric-ids','--delete','--',str(backup)+'/',str(source)+'/'],timeout=3600)
        else:run(['/usr/bin/cp','--archive',str(backup),str(source)])
        if storage_seal(source)!=record['seal']:raise PrerequisiteError('Docker recovery storage has not matched its sealed checkpoint; the daemon remains stopped.')
    os.sync()


def require_local_setup(context):
    if context!='default' or os.environ.get('DOCKER_CONTEXT','') not in {'','default'} or os.environ.get('DOCKER_HOST','') not in {'','unix:///var/run/docker.sock','unix:///run/docker.sock'}:
        raise PrerequisiteError('Required host packages can only be changed for the local default Docker context. No package was changed on this host.')


def persist_repository(system):
    directory=Path('/etc/apt/sources.list.d');public_directory(directory)
    expected='https://download.docker.com/linux/'+system['distribution']
    candidates=[Path('/etc/apt/sources.list'),*directory.glob('*.list'),*directory.glob('*.sources')]
    for path in candidates:
        if path.exists() and expected in protected(path,1024*1024).read_text():return
    target=directory/'orbis-docker.sources'
    content=f'Types: deb\nURIs: {expected}\nSuites: {system["codename"]}\nComponents: stable\nArchitectures: {system["architecture"]}\nSigned-By: /etc/apt/keyrings/orbis-docker.asc\n'
    if target.exists() or target.is_symlink():
        if protected(target,65536).read_text()!=content:raise PrerequisiteError('The existing Orbis Docker repository needs review; it was not overwritten.')
        return
    fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
    with os.fdopen(fd,'w') as stream:stream.write(content);stream.flush();os.fsync(stream.fileno())


def required_tools():
    names=set()
    if not Path('/usr/sbin/ip').is_file() and not Path('/usr/bin/ip').is_file():names.add('iproute2')
    if not Path('/usr/bin/rsync').is_file():names.add('rsync')
    else:
        output=run(['/usr/bin/rsync','--version'])
        found=re.search(r'rsync\s+version\s+(\d+)\.(\d+)\.(\d+)',output)
        if not found or tuple(map(int,found.groups()))<(3,1,3):names.add('rsync')
    return names


def tools_required():return bool(required_tools())


def stage(directory,journal,value,progress):
    journal['phase']=value;journal['updatedAt']=time.time();save(directory/'journal.json',journal)
    progress(value.replace('-',' ').capitalize())


def pending_transaction(root):
    pointer=root/'current.json'
    if not pointer.exists():return None
    value=read(pointer);identifier=value.get('id')
    if not isinstance(identifier,str) or str(uuid.UUID(identifier))!=identifier:raise PrerequisiteError('The Docker recovery pointer is invalid.')
    directory=private_directory(root/identifier);journal=read(directory/'journal.json')
    if journal.get('schema')!='orbis.docker-setup.v1' or journal.get('id')!=identifier:raise PrerequisiteError('The Docker recovery journal does not match its transaction.')
    return None if journal.get('phase') in {'complete','rolled-back','cancelled'} else (directory,journal)


@contextlib.contextmanager
def host_barrier(root):
    configuration=Path('/etc/orbis/host-service.env');state=Path('/var/lib/orbis/state');descriptor=None;owned=False
    if not configuration.exists():
        yield;return
    values={}
    for line in protected(configuration,65536).read_text().splitlines():
        if not line or line.startswith('#'):continue
        parts=shlex.split(line,posix=True)
        if len(parts)!=1 or '=' not in parts[0]:raise PrerequisiteError('The existing Orbis host configuration needs review before Docker setup.')
        name,value=parts[0].split('=',1);values[name]=value
    installation=Path(values.get('ORBIS_ROOT',''))
    if not installation.is_absolute() or installation!=installation.resolve(strict=True) or not installation.is_dir():raise PrerequisiteError('The existing Orbis installation cannot be locked safely.')
    private_directory(state)
    lock=installation.parent/('.'+installation.name+'.orbis-host.lock')
    descriptor=os.open(lock,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    marker=state/'helper-maintenance.json';record={'schema':'orbis.docker-setup-maintenance.v1','setupRoot':str(root)}
    try:
        fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
        for name in ['job.json','package-job.json','restart-job.json']:
            path=state/name
            if path.exists() and read(path).get('state') in {'running','recovering','interrupted','queued'}:raise PrerequisiteError('Finish or recover the active Orbis host task before Docker setup.')
        if marker.exists() or marker.is_symlink():
            if read(marker)!=record:raise PrerequisiteError('Another Orbis maintenance operation is in progress.')
        else:save(marker,record)
        owned=True
        yield
    finally:
        if owned and marker.exists() and read(marker)==record and pending_transaction(root) is None:marker.unlink()
        if descriptor is not None:os.close(descriptor)


def resume_transaction(directory,journal,progress):
    if journal.get('sourceSha256')!=sha(__file__) or journal.get('context')!='default':raise PrerequisiteError('Use the exact retained installer version to recover this Docker transaction.')
    save(directory/('before-recovery-'+str(uuid.uuid4())+'.json'),journal)
    token=LOG_DIRECTORY.set(directory)
    try:
        if journal.get('hadEngine') and journal.get('inventory'):
            if journal.get('appsResumed'):
                outcome=journal.get('resumeOutcome','complete')
                if outcome not in {'complete','rolled-back'}:raise PrerequisiteError('The durable app-resume outcome is invalid; storage was not overwritten.')
                if outcome=='rolled-back':
                    current=installed_packages()
                    if any(current.get(name)!=item['version'] for name,item in journal['rollbackPackages'].items()):raise PrerequisiteError('Recovered package versions changed before app resume; storage was not overwritten.')
                progress('Confirming the original running apps')
                run(['/usr/bin/systemctl','start','containerd.service','docker.service'],timeout=180)
                restore_workloads(journal['context'],journal['inventory'])
                health=inspect(journal['context'])['kind']
                if health not in ({'ready','upgrade','compose'} if outcome=='rolled-back' else {'ready'}):raise PrerequisiteError('Docker health still needs recovery; no app writes were rolled back.')
                stage(directory,journal,outcome,progress)
            elif (directory/'storage.json').exists():rollback_engine(directory,journal,progress)
            else:
                run(['/usr/bin/systemctl','start','containerd.service','docker.service'],timeout=180)
                restore_workloads(journal['context'],journal['inventory']);stage(directory,journal,'rolled-back',progress)
        else:
            archives=journal.get('archives');cache=Path(journal.get('aptDirectory',''))
            if not isinstance(archives,dict) or not archives:stage(directory,journal,'cancelled',progress);return {'result':'setup-cancelled','changed':False}
            current=installed_packages(recovery=True)
            for name,item in archives.items():
                if current.get(name) not in {None,item['old'],item['version']} or archive_record(item['path'])['sha256']!=item['sha256']:raise PrerequisiteError('Package state changed outside this transaction. Its recovery journal was preserved.')
            targets=[item['path'] for _,item in sorted(archives.items())]
            output=run([*apt_command(cache),'--simulate','--reinstall','--no-remove','--no-install-recommends','install',*targets])
            review=parse_simulation(output,current,{name:item['version'] for name,item in archives.items()},False)
            selected={}
            for name,item in review['selected'].items():
                original=archives.get(name)
                if not original or item['version']!=original['version']:raise PrerequisiteError('Recovery proposed an unretained package.')
                selected[name]={**original,'old':item['old'],'direction':package_direction(item['old'],item['version'])}
            worker=private_directory(directory/('forward-recovery-'+str(uuid.uuid4())))
            apply_packages(worker,review,selected,cache,recovery=True)
            run(['/usr/bin/systemctl','daemon-reload'])
            if not journal.get('hadEngine'):run(['/usr/bin/systemctl','enable','--now','containerd.service','docker.service'],timeout=180)
            if (journal['action']['kind']!='tools' and inspect(journal['context'])['kind']!='ready') or tools_required():raise PrerequisiteError('Required services have not reached compatible health; their journal remains available.')
            persist_repository(journal['system']);stage(directory,journal,'complete',progress)
        return {'result':'previous-docker-recovered' if journal['phase']=='rolled-back' else 'recovered','changed':True,'outcome':journal['phase'],'journal':str(directory/'journal.json')}
    except BaseException as error:
        journal['phase']='recovery-required';journal['recoveryErrorType']=type(error).__name__;save(directory/'journal.json',journal);raise
    finally:LOG_DIRECTORY.reset(token)


def install_required(context,root,system,action,progress):
    pending=root/'current.json'
    installed=installed_packages()
    if any(name in installed for name in LEGACY_PACKAGES) and action['kind']=='install':raise PrerequisiteError('Existing container runtime packages need a recovery review before replacement.')
    identifier=str(uuid.uuid4());directory=private_directory(root/identifier)
    log_token=LOG_DIRECTORY.set(directory)
    journal={'schema':'orbis.docker-setup.v1','id':identifier,'context':context,'system':system,'action':action,'createdAt':time.time(),'sourceSha256':sha(__file__),'phase':'preparing','hadEngine':action['kind']!='install'}
    save(directory/'journal.json',journal);save(pending,{'id':identifier})
    cache=public_directory(Path('/var/cache/orbis-installer')/identifier)
    journal['aptDirectory']=str(cache);save(directory/'journal.json',journal)
    try:
        stage(directory,journal,'checking-service-isolation',progress)
        service_helpers()
        run(['/usr/bin/unshare','--mount','--fork','--propagation','private','/usr/bin/true'])
        stage(directory,journal,'checking-signed-repositories',progress)
        prepare_repository(cache,system)
        requested=requested_packages(action,system,installed)
        review=simulate(cache,installed,requested,False)
        journal['review']=review;save(directory/'journal.json',journal)
        stage(directory,journal,'downloading-required-packages',progress)
        archives=acquire_archives(cache,review)
        journal['archives']=archives;journal['rollbackPackages']=backup_packages(cache,installed,review);save(directory/'journal.json',journal)
        if simulate(cache,installed_packages(),requested,False)!=review:raise PrerequisiteError('The required package plan changed before installation.')
        stage(directory,journal,'installing-required-packages',progress)
        apply_packages(directory,review,archives,cache)
        stage(directory,journal,'checking-docker-services',progress)
        run(['/usr/bin/systemctl','daemon-reload'])
        if action['kind']=='install':run(['/usr/bin/systemctl','enable','--now','containerd.service','docker.service'],timeout=180)
        if (action['kind']!='tools' and inspect(context)['kind']!='ready') or tools_required():raise PrerequisiteError('Required Docker setup has not reached a healthy compatible state. Preserve the journal before retrying.')
        persist_repository(system)
        stage(directory,journal,'complete',progress)
        return {'result':'required-tools-ready','changed':True,'journal':str(directory/'journal.json')}
    except BaseException as error:
        journal['failedAt']=time.time();journal['failedPhase']=journal['phase'];journal['phase']='recovery-required';journal['errorType']=type(error).__name__;save(directory/'journal.json',journal)
        raise PrerequisiteError('Required setup did not finish. Its packages, archives and private recovery journal were retained at '+str(directory)+'. No container or data directory was removed.') from error
    finally:LOG_DIRECTORY.reset(log_token)


def prepare(context,state_dir,*,accepted=False,ask=None,progress=None,inspect_only=False):
    host();progress=progress or (lambda value:print(value+'…',flush=True))
    existing_root=Path(state_dir)/'docker-setup'
    unfinished=pending_transaction(existing_root) if existing_root.exists() else None
    action=unfinished[1]['action'] if unfinished else inspect(context)
    if unfinished is None and action['kind']=='ready' and not tools_required():return {'result':'already-compatible','changed':False}
    if inspect_only:raise PrerequisiteError('Required Docker or backup tools need setup. Inspection did not install or change anything.')
    require_local_setup(context)
    system=supported_system(platform.freedesktop_os_release(),run(['/usr/bin/dpkg','--print-architecture']))
    notice='Orbis needs to install or update required Docker, Compose or backup tools. Docker services and apps may restart; Docker manages their container networking and firewall rules. Existing containers, configuration and data will be retained. Continue? [y/N]: '
    if not accepted and (ask is None or ask(notice).strip().lower()!='y'):raise PrerequisiteError('Required setup was cancelled; no package or service was changed.')
    if accepted:print(notice.removesuffix(' [y/N]: '),flush=True)
    root=private_directory(Path(state_dir)/'docker-setup')
    barrier=None
    descriptor=os.open(root/'setup.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
        pending=root/'current.json'
        barrier=host_barrier(root);barrier.__enter__()
        unfinished=pending_transaction(root)
        if unfinished is not None:
            recovered=resume_transaction(*unfinished,progress)
            if recovered.get('outcome')=='rolled-back':return recovered
            action=inspect(context)
            if action['kind']=='ready' and not tools_required():return recovered
        if action['kind']=='start':
            progress('Starting the existing Docker service')
            run(['/usr/bin/systemctl','start','docker.service'],timeout=180)
            action=inspect(context)
        if action['kind'] in {'upgrade','compose'}:
            if tools_required():install_required(context,root,system,{'kind':'tools','context':context},progress)
            return upgrade_existing(context,root,system,action,progress)
        if action['kind']=='install' and (Path('/var/lib/docker').exists() or Path('/var/lib/containerd').exists()):raise PrerequisiteError('Docker data already exists without an inspectable engine. Its files were preserved; repair the existing daemon before starting a new installation.')
        return install_required(context,root,system,action,progress)
    finally:
        try:
            if barrier is not None:barrier.__exit__(*sys.exc_info())
        finally:os.close(descriptor)


def package_direction(old,new):
    if old is None:return '<'
    if old==new:return '='
    result=subprocess.run(['/usr/bin/dpkg','--compare-versions',old,'lt',new],env=ENV,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10,check=False)
    if result.returncode not in {0,1}:raise PrerequisiteError('Package version ordering could not be checked.')
    return '<' if result.returncode==0 else '>'


def rollback_engine(directory,journal,progress):
    if journal.get('appsResumed') or journal.get('phase') in {'apps-resumed','complete'}:raise PrerequisiteError('Apps have resumed. Automatic rollback will not overwrite accepted app writes.')
    context=journal['context'];cache=Path(journal['aptDirectory'])
    progress('Recovering the previous Docker installation')
    originals=journal.get('rollbackPackages') or {}
    if not originals:raise PrerequisiteError('Previous package archives are not available. Preserve the journal before changing this host.')
    current=installed_packages(recovery=True)
    for name,item in originals.items():
        selected=journal['review']['selected'].get(name)
        allowed={item['version'],selected['version']} if selected else {item['version'],None} if name in journal['review']['removed'] else {item['version']}
        if current.get(name) not in allowed:raise PrerequisiteError('A previous package changed outside the reviewed transaction; automatic rollback was refused before changing packages or recovery storage.')
    introduced={name:item['version'] for name,item in journal['review']['selected'].items() if item['old'] is None and name in current}
    if any(current[name]!=version for name,version in introduced.items()):raise PrerequisiteError('New package state changed outside this transaction; automatic removal was stopped.')
    run(['/usr/bin/systemctl','stop','docker.socket','docker.service','containerd.service'],timeout=180)
    targets=[item['path'] for _,item in sorted(originals.items())]+[name+'-' for name in sorted(introduced)]
    output=run([*apt_command(cache),'--simulate','--allow-downgrades','--reinstall','--no-install-recommends','install',*targets])
    review=parse_simulation(output,current,{name:item['version'] for name,item in originals.items()},True,recovery=True,permitted_removals=introduced)
    if any(name not in introduced for name in review['removed']):raise PrerequisiteError('Rollback would remove a package present before setup.')
    archives={}
    for name,item in review['selected'].items():
        original=originals.get(name)
        if not original or sha(protected(original['path'],256*1024*1024))!=original['sha256']:raise PrerequisiteError('Rollback proposed an unretained package.')
        archives[name]={**original,'old':item['old'],'direction':package_direction(item['old'],item['version'])}
    recovery=private_directory(directory/('package-recovery-'+str(uuid.uuid4())))
    apply_packages(recovery,review,archives,cache,recovery=True)
    restored=installed_packages()
    if any(restored.get(name)!=item['version'] for name,item in originals.items()) or any(name in restored for name in introduced):raise PrerequisiteError('Original package versions have not been restored; Docker storage remains stopped for recovery.')
    restore_storage(directory)
    journal['appsResumed']=True;journal['resumeOutcome']='rolled-back'
    stage(directory,journal,'resuming-original-apps',progress)
    run(['/usr/bin/systemctl','daemon-reload'])
    run(['/usr/bin/systemctl','start','containerd.service','docker.service'],timeout=180)
    restore_workloads(context,journal['inventory'])
    journal['phase']='rolled-back';journal['recoveredAt']=time.time();save(directory/'journal.json',journal)


def upgrade_existing(context,root,system,action,progress):
    if tools_required():raise PrerequisiteError('Required recovery tools must be prepared before Docker downtime.')
    installed=installed_packages();require_exclusive_engine(installed)
    snapshot=inventory(context)
    if any(item.get('driver')!='local' or item.get('options') for item in snapshot['volumes']):raise PrerequisiteError('Docker update cannot checkpoint remote or plugin-managed volumes automatically. Their data and packages were preserved.')
    identifier=str(uuid.uuid4());directory=private_directory(root/identifier);cache=public_directory(Path('/var/cache/orbis-installer')/identifier)
    token=LOG_DIRECTORY.set(directory)
    journal={'schema':'orbis.docker-setup.v1','id':identifier,'context':context,'system':system,'action':action,'inventory':snapshot,'createdAt':time.time(),'sourceSha256':sha(__file__),'phase':'preparing','hadEngine':True,'aptDirectory':str(cache)}
    save(directory/'journal.json',journal);save(root/'current.json',{'id':identifier})
    stopped=False;package_started=False
    try:
        service_helpers();run(['/usr/bin/unshare','--mount','--fork','--propagation','private','/usr/bin/true'])
        records=storage_requirements(directory)
        stage(directory,journal,'checking-signed-repositories',progress);prepare_repository(cache,system)
        requested=requested_packages(action,system,installed)
        review=simulate(cache,installed,requested,True)
        stage(directory,journal,'downloading-required-and-recovery-packages',progress)
        archives=acquire_archives(cache,review);originals=backup_packages(cache,installed,review)
        journal.update(review=review,archives=archives,rollbackPackages=originals);save(directory/'journal.json',journal)
        if simulate(cache,installed_packages(),requested,True)!=review:raise PrerequisiteError('The reviewed Docker package plan changed before downtime.')
        require_exclusive_engine(installed_packages())
        stage(directory,journal,'pausing-original-containers',progress);stopped=True;quiesce(context,snapshot)
        stage(directory,journal,'checkpointing-docker-storage',progress);checkpoint_storage(directory,records)
        stage(directory,journal,'installing-required-packages',progress);package_started=True;apply_packages(directory,review,archives,cache)
        stage(directory,journal,'checking-updated-docker',progress)
        run(['/usr/bin/systemctl','daemon-reload']);run(['/usr/bin/systemctl','start','containerd.service','docker.service'],timeout=180)
        if inspect(context)['kind']!='ready' or tools_required():raise PrerequisiteError('Updated Docker or required backup tools have not reached compatible health.')
        if not same_inventory(snapshot,inventory(context)):raise PrerequisiteError('Updated Docker did not preserve the reviewed identities.')
        persist_repository(system)
        journal['appsResumed']=True
        stage(directory,journal,'apps-resumed',progress)
        restore_workloads(context,snapshot)
        stage(directory,journal,'complete',progress)
        return {'result':'required-docker-updated','changed':True,'journal':str(directory/'journal.json')}
    except BaseException as error:
        journal['failedAt']=time.time();journal['failedPhase']=journal['phase'];journal['errorType']=type(error).__name__;save(directory/'journal.json',journal)
        try:
            if package_started:rollback_engine(directory,journal,progress)
            elif stopped:
                run(['/usr/bin/systemctl','start','containerd.service','docker.service'],timeout=180);restore_workloads(context,snapshot)
                journal['phase']='rolled-back';save(directory/'journal.json',journal)
            else:journal['phase']='cancelled';save(directory/'journal.json',journal)
        except BaseException as recovery_error:
            journal['phase']='recovery-required';journal['recoveryErrorType']=type(recovery_error).__name__;save(directory/'journal.json',journal)
        raise PrerequisiteError('Docker setup did not finish. Its original package, storage and workload recovery records were retained at '+str(directory)+'. Re-run recovery before another update.') from error
    finally:LOG_DIRECTORY.reset(token)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    operation=parser.add_mutually_exclusive_group(required=True)
    operation.add_argument('--prepare',type=Path,metavar='PRIVATE_STATE')
    operation.add_argument('--apply-namespace',nargs=2,metavar=('DIRECTORY','PLAN'))
    operation.add_argument('--verify',type=Path,metavar='PLAN')
    parser.add_argument('--yes',action='store_true')
    parser.add_argument('--docker-context',default='default')
    args=parser.parse_args();host()
    if args.apply_namespace:apply_namespace(Path(args.apply_namespace[0]),Path(args.apply_namespace[1]));return
    if args.verify:
        plan_file=protected(args.verify);plan=read(plan_file)
        verify_protocol(plan,sys.stdin.read(2*1024*1024+1))
        save(plan_file.parent/'guard-receipt.json',{'verified':True,'planSha256':sha(plan_file)});return
    result=prepare(args.docker_context,args.prepare,accepted=args.yes,ask=None if args.yes else input)
    print(json.dumps(result))


if __name__=='__main__':
    try:main()
    except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as failure:
        print(str(failure),file=sys.stderr);sys.exit(2)
