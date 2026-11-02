#!/usr/bin/env python3
"""Protected destination review and critical enrollment; no activation or path creation."""
import hashlib
import importlib.util
import json
import secrets
import time
from pathlib import Path


def load(name,key):
    spec=importlib.util.spec_from_file_location(key,Path(__file__).with_name(name));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


M=load('orbis-host-portable-policy.py','orbis_portable_policy_for_enrollment')
C=load('orbis-host-capture-authority.py','orbis_capture_for_portable_enrollment')
A,P=C.AUTHORITY,C.P
CHECK=load('orbis-release-check.py','orbis_official_release_for_portable_enrollment')
SCHEMA='orbis.portable-enrollment.v1'
MAX_CAPSULE=256*1024**3


def fail():return ValueError('Portable enrollment requires protected capsule verification and a fresh critical approval')


def read(directory,name,maximum):
    with A.protected_directory(directory) as parent:
        with A.protected_file(parent,name,maximum) as body:return body


def parsed(directory,name,maximum):
    return P.metadata(read(directory,name,maximum),byte_limit=maximum,string_limit=2*1024*1024)


def file_sha(directory,name,maximum):
    with A.protected_directory(directory) as parent:
        with A.protected_file(parent,name,maximum,digest_only=True) as digest:return digest.removeprefix('sha256:')


def official_publication(publication,check=None):
    # check is an installed root policy dependency, never a request field.
    release=CHECK.PLAN.validate_manifest(publication)
    observed=(check or CHECK.check)(release['tag'])
    if (observed.get('tag')!=release['tag'] or observed.get('commit')!=release['commit']
            or observed.get('image')!=release['image']+'@'+release['digest']
            or observed.get('runtipiCompatibility')!=release['runtipiCompatibility']
            or observed.get('installationProtocol')!=release.get('installationProtocol')):raise fail()
    return release


def verify_bundle(directory,expected,*,official_check=None):
    """Revalidate fixed root-private output of the pinned current capsule driver."""
    if not M.exact(expected,{'capsuleSha256','currentRevision','pointId','runtimeManifestSha256','entries'}):raise fail()
    if (any(not M.matches(M.HEX, expected[key]) for key in ('capsuleSha256','currentRevision','runtimeManifestSha256'))
            or not M.matches(M.UUID, expected['pointId']) or not isinstance(expected['entries'],dict)):raise fail()
    required={'runtime-manifest.json','mount-policy.json','controller-config.json','controller-publication.json','controller-authority.json','controller.tar'}
    if set(expected['entries'])!=required:raise fail()
    for name,digest in expected['entries'].items():
        if not M.matches(M.HEX, digest) or file_sha(directory,name,C.P.MAX_IMAGE_BYTES if name=='controller.tar' else 16*1024*1024)!=digest:raise fail()
    manifest=parsed(directory,'runtime-manifest.json',1024*1024)
    policy=M.validate(parsed(directory,'mount-policy.json',M.LIMIT))
    configuration=parsed(directory,'controller-config.json',16*1024*1024)
    receipt=parsed(directory,'controller-publication.json',P.PROOF_WIRE_BYTES)
    A.configuration_files(configuration)
    if (manifest.get('schema')!='orbis.time-machine-runtime.v5' or manifest.get('pointId')!=expected['pointId']
            or policy['pointId']!=expected['pointId'] or configuration.get('pointId')!=expected['pointId']
            or M.sha(read(directory,'runtime-manifest.json',1024*1024))!=expected['runtimeManifestSha256']
            or manifest.get('mountPolicySha256')!=M.sha(read(directory,'mount-policy.json',M.LIMIT))
            or manifest.get('configurationSetSha256')!=configuration.get('configurationSetSha256')
            or policy['configurationSetSha256']!=configuration.get('configurationSetSha256')
            or policy['sourceRootSha256']!=configuration.get('rootIdentity',{}).get('pathSha256')
            or receipt.get('pointId')!=expected['pointId'] or receipt.get('configurationSetSha256')!=configuration.get('configurationSetSha256')
            or receipt.get('controller')!=configuration.get('controller') or receipt.get('rootIdentity')!=configuration.get('rootIdentity')):raise fail()
    proof=receipt.get('proof')
    if not isinstance(proof,dict):raise fail()
    release=official_publication(proof.get('publication'),official_check)
    graph=P.verify_publication_proof(release,proof)
    receipt_descriptor={key:value for key,value in receipt.items() if key!='preparationSha256'}
    domain=b'orbis.controller-publication-capture.v2\n' if receipt.get('version')==2 else b'orbis.controller-publication-capture.v1\n'
    if receipt.get('preparationSha256')!=M.sha(domain+P.canonical(receipt_descriptor)):raise fail()
    archive=C.verify_archive(directory/'controller.tar',graph,time.monotonic()+C.MAX_SECONDS)
    authority=parsed(directory,'controller-authority.json',65536)
    fields={'schema','version','pointId','configurationSetSha256','preparationSha256','publicationProofSha256','rootIdentitySha256',
            'publication','platform','archive','finalizedAt','authoritySha256','proxyHostIdentity','mountPolicySha256'}
    descriptor={key:item for key,item in authority.items() if key!='authoritySha256'}
    if (not M.exact(authority,fields) or authority['schema']!='orbis.controller-capture-authority.v3' or type(authority['version']) is not int or authority['version']!=3
            or authority['authoritySha256']!=M.sha(b'orbis.controller-capture-authority.v3\n'+P.canonical(descriptor))
            or authority['pointId']!=expected['pointId'] or authority['configurationSetSha256']!=configuration['configurationSetSha256']
            or authority['preparationSha256']!=receipt['preparationSha256'] or authority['publicationProofSha256']!=M.sha(read(directory,'controller-publication.json',P.PROOF_WIRE_BYTES))
            or authority['rootIdentitySha256']!=M.sha(P.canonical(configuration['rootIdentity'])) or authority['publication']!=release
            or authority['platform']!=json.loads(graph.platform_bytes) or authority['mountPolicySha256']!=M.sha(read(directory,'mount-policy.json',M.LIMIT))
            or manifest.get('controllerAuthoritySha256')!=M.sha(read(directory,'controller-authority.json',65536))
            or type(authority['finalizedAt']) is not int or not 0<authority['finalizedAt']<=2**53-1):raise fail()
    C.proxy_descriptor(authority['proxyHostIdentity'],policy['sourceRootSha256'],policy['sourceContextSha256'])
    source_archive=authority['archive']
    if (not M.exact(source_archive,set(archive)|{'sourceImageId'}) or any(source_archive[key]!=value for key,value in archive.items())
            or source_archive['sourceImageId']!=configuration['controller']['imageId']):raise fail()
    controller=configuration['controller']
    if (controller.get('releaseTag')!=release['tag'] or controller.get('releaseDigest')!=release['digest']
            or controller.get('imageId') not in {archive['configDigest'],archive['platformManifestDigest']}
            or manifest.get('publicationProofSha256')!=M.sha(read(directory,'controller-publication.json',P.PROOF_WIRE_BYTES))):raise fail()
    return {'pointId':expected['pointId'],'capsuleSha256':expected['capsuleSha256'],'runtimeManifestSha256':expected['runtimeManifestSha256'],
            'mountPolicySha256':M.sha(read(directory,'mount-policy.json',M.LIMIT)),'configurationSetSha256':configuration['configurationSetSha256'],
            'publication':release,'archive':archive,'policy':policy,'reviewReceiptSha256':M.sha(P.canonical(expected))}


class PortableEnrollment:
    """The socket dispatcher owns the host lock and privileged-peer check.

    driver is the installed fixed current-image capsule verifier; it must positively
    attest its capability before review. No driver means no prepare/enrollment.
    """
    def __init__(self,service,driver=None,*,official_check=None):
        self.service,self.driver=service,driver
        self.state=Path(service.state_dir)
        self.official_check=official_check

    def directory(self,identifier,create=False):
        if not M.matches(M.UUID, identifier):raise fail()
        with A.protected_directory(self.state):pass
        base=self.state/'portable-enrollments'
        if create:base.mkdir(mode=0o700,exist_ok=True)
        with A.protected_directory(base) as parent:
            if len(list(base.iterdir()))>256:raise fail()
        target=base/identifier
        if create:target.mkdir(mode=0o700,exist_ok=True)
        with A.protected_directory(target):pass
        return target

    def observation(self):
        value=self.service.portable_destination_observation()
        if (not M.exact(value,{'currentRevision','controllerId','controllerImageId','includedRoots','mountTable','occupiedPorts','networks'})
                or not M.matches(M.HEX, value['currentRevision']) or not M.matches(M.HEX, value['controllerId'])
                or not M.matches(M.DIGEST, value['controllerImageId'])):raise fail()
        return value

    def prepare(self,request):
        if not M.exact(request,{'capsuleId','capsuleSha256','remaps','portDecisions'}) or not M.matches(M.UUID, request['capsuleId']) or not M.matches(M.HEX, request['capsuleSha256']):raise fail()
        if self.driver is None:raise fail()
        identifier=request['capsuleId'];destination=self.directory(identifier,True);current=self.observation()
        capsule=self.state/'portable-capsules'/identifier
        if file_sha(capsule,'capsule.orbis',MAX_CAPSULE)!=request['capsuleSha256']:raise fail()
        # Only this fixed trusted driver can establish the encrypted capsule's
        # authenticated membership. Imported JSON cannot supply this receipt.
        expected=self.driver.review(identifier,request['capsuleSha256'],current)
        if expected.get('capsuleSha256')!=request['capsuleSha256'] or expected.get('currentRevision')!=current['currentRevision']:raise fail()
        reviewed=verify_bundle(destination/'review',expected,official_check=self.official_check)
        plan=M.destination_plan(reviewed['policy'],included_roots=current['includedRoots'],remaps=request['remaps'],
            port_decisions=request['portDecisions'],mounts=current['mountTable'],occupied_ports=current['occupiedPorts'],network_inspects=current['networks'])
        if self.observation()!=current or file_sha(capsule,'capsule.orbis',MAX_CAPSULE)!=request['capsuleSha256']:raise fail()
        value={'schema':'orbis.portable-review.v1','capsuleId':identifier,'capsuleSha256':request['capsuleSha256'],
               'currentRevision':current['currentRevision'],'controllerId':current['controllerId'],'controllerImageId':current['controllerImageId'],
               'review':reviewed,'plan':plan,'request':request}
        plan_sha=M.sha(P.canonical(value));file=destination/(plan_sha+'.json')
        C.immutable(file,P.canonical(value))
        token_file=plan_sha+'.approval.json';now=int(time.time()*1000)
        try:permit=parsed(destination,token_file,4096)
        except FileNotFoundError:permit=None
        if permit is not None and (not M.exact(permit,{'schema','planSha256','capsuleSha256','currentRevision','nonce','expiresAt'})
                or permit['schema']!='orbis.portable-critical-permit.v1' or permit['planSha256']!=plan_sha
                or permit['capsuleSha256']!=request['capsuleSha256'] or permit['currentRevision']!=current['currentRevision']
                or not M.matches(M.HEX, permit['nonce']) or type(permit['expiresAt']) is not int):raise fail()
        if permit is None or permit['expiresAt']<=now:
            permit={'schema':'orbis.portable-critical-permit.v1','planSha256':plan_sha,'capsuleSha256':request['capsuleSha256'],
                    'currentRevision':current['currentRevision'],'nonce':secrets.token_hex(32),'expiresAt':now+300000}
            A.atomic(destination/token_file,P.canonical(permit))
        return {'version':1,'capsuleId':identifier,'capsuleSha256':request['capsuleSha256'],'planSha256':plan_sha,
                'currentRevision':current['currentRevision'],'criticalApprovalNonce':permit['nonce'],'approvalExpiresAt':permit['expiresAt'],
                'plan':plan,'activationAvailable':False}

    def approve(self,request,*,privileged_peer=False):
        if (privileged_peer is not True or not M.exact(request,{'capsuleId','capsuleSha256','planSha256','currentRevision','criticalApprovalNonce','action'})
                or request['action']!='enroll-portable-point' or any(not M.matches(M.HEX, request[key]) for key in ('capsuleSha256','planSha256','currentRevision','criticalApprovalNonce'))):raise fail()
        directory=self.directory(request['capsuleId']);stored=parsed(directory,request['planSha256']+'.json',4*1024*1024)
        if any(stored.get(key)!=request[key] for key in ('capsuleId','capsuleSha256','currentRevision')) or stored['plan']['blockers']:raise fail()
        permit=parsed(directory,request['planSha256']+'.approval.json',4096)
        if (permit.get('schema')!='orbis.portable-critical-permit.v1' or permit.get('planSha256')!=request['planSha256']
                or permit.get('capsuleSha256')!=request['capsuleSha256'] or permit.get('currentRevision')!=request['currentRevision']
                or permit.get('nonce')!=request['criticalApprovalNonce'] or type(permit.get('expiresAt')) is not int
                or permit['expiresAt']<=int(time.time()*1000)):raise fail()
        # Re-run root observations, official publication, graph/config/archive and
        # destination presence/collision checks under the same host lock.
        fresh=self.prepare(stored['request'])
        if any(fresh[key]!=request[key] for key in ('capsuleId','capsuleSha256','planSha256','currentRevision','criticalApprovalNonce')):raise fail()
        receipt={'schema':SCHEMA,'version':1,'capsuleId':request['capsuleId'],'capsuleSha256':request['capsuleSha256'],
                 'planSha256':request['planSha256'],'currentRevision':request['currentRevision'],'controllerId':stored['controllerId'],
                 'controllerImageId':stored['controllerImageId'],'pointId':stored['review']['pointId'],
                 'runtimeManifestSha256':stored['review']['runtimeManifestSha256'],'mountPolicySha256':stored['review']['mountPolicySha256'],
                 'reviewReceiptSha256':stored['review']['reviewReceiptSha256'],'criticalApprovalSha256':M.sha(P.canonical(request)),
                 'activationAvailable':False}
        receipt['sha256']=M.sha((SCHEMA+'\n').encode()+P.canonical(receipt))
        C.immutable(directory/'enrolled.json',P.canonical(receipt))
        return receipt


def _capture_mount_policy(service,point_id,token):
    """Point-fence-bound root producer; no request paths, IDs or policy JSON."""
    if not M.matches(M.UUID, point_id) or not M.matches(M.HEX, token):raise fail()
    host=service.HOST
    with service.lock:
        fence=service._verify_capture_fence(token)
        prepared=C.load_preparation(service.state_dir,point_id)
        if (fence['pointId']!=point_id or fence['configurationSetSha256']!=prepared['configuration']['configurationSetSha256']
                or fence['preparationSha256']!=prepared['publicationReceipt']['preparationSha256']
                or prepared['rootSha256']!=M.sha(str(service.root).encode()) or prepared['contextSha256']!=M.sha(service.context.encode())):raise fail()
        runtime=load('orbis-host-retained-restore-runtime.py','orbis_bounded_portable_observer')
        class Observer:
            pass
        observer=Observer();observer.host,observer.root=host,service.root
        def docker(arguments):
            remaining=host.CAPTURE_READ_DEADLINE.get()-time.monotonic()
            if remaining<=0:raise fail()
            return runtime.DockerRestoreRuntime.bounded_output(observer,
                ['docker','--context',service.context,*arguments],8*1024*1024,remaining).decode('utf-8',errors='strict').strip()
        endpoint=P.metadata(docker(['context','inspect',service.context,'--format','{"host":{{json .Endpoints.docker.Host}}}']).encode())
        if not isinstance(endpoint.get('host'),str) or not endpoint['host'].startswith('unix:///'):raise fail()
        daemon=P.metadata(docker(['info','--format','{{json .}}']).encode(),byte_limit=8*1024*1024)
        if not isinstance(daemon.get('ID'),str) or not 1<=len(daemon['ID'])<=256:raise fail()
        rows=docker(['container','ls','--all','--no-trunc','--format','{{.ID}}']).splitlines()
        if len(rows)>4096 or len(set(rows))!=len(rows) or any(not M.HEX.fullmatch(row) for row in rows):raise fail()
        inspections=[P.metadata(docker(['container','inspect','--format','{{json .}}',identifier]).encode(),byte_limit=8*1024*1024) for identifier in rows]
        current=[item for item in inspections if item.get('Id')==fence['controllerId']]
        if len(current)!=1 or current[0].get('Image')!=fence['imageId']:raise fail()
        root=Path(service.root);included=[]
        for target in ('/app-data','/data/apps','/data/user-config','/data/state','/data/repos'):
            covering=[item for item in current[0].get('Mounts',[]) if item.get('Type')=='bind' and item.get('RW') is True
                      and M.below(item.get('Destination',''),target)]
            if not covering:raise fail()
            item=max(covering,key=lambda value:len(value['Destination']))
            physical=Path(item['Source'])/target.removeprefix(item['Destination']).lstrip('/')
            M.path(str(physical))
            if physical.resolve(strict=True)!=physical:raise fail()
            included.append(str(physical))
        apps=[];known={fence['controllerId']}
        for item in inspections:
            labels=item.get('Config',{}).get('Labels') or {}
            if labels.get('com.docker.compose.project.working_dir')!=str(root) and not M.below(str(root/'apps'),str(labels.get('com.docker.compose.project.working_dir',''))):continue
            if labels.get('com.docker.compose.project')=='runtipi' and labels.get('com.docker.compose.service') in {'runtipi','runtipi-db','runtipi-queue','runtipi-reverse-proxy'}:
                known.add(item['Id']);continue
            if labels.get('runtipi.managed')=='true' and M.matches(M.URN, labels.get('runtipi.appurn')):apps.append(item);known.add(item['Id'])
        approved={}
        base=Path(service.state_dir)/'portable-capture-policies';directory=base/point_id
        base.mkdir(mode=0o700,exist_ok=True)
        with A.protected_directory(base):pass
        directory.mkdir(mode=0o700,exist_ok=True)
        with A.protected_directory(directory):pass
        try:approval=parsed(directory,'media-approved.json',64*1024)
        except FileNotFoundError:approval=None
        if approval is not None:
            if (not M.exact(approval,{'schema','pointId','configurationSetSha256','observedSourceSha256','media'})
                    or approval['schema']!='orbis.portable-media-approval.v1' or approval['pointId']!=point_id
                    or approval['configurationSetSha256']!=fence['configurationSetSha256'] or not isinstance(approval['media'],dict)
                    or approval['observedSourceSha256']!=M.sha(P.canonical([
                        {'Id':item['Id'],'Image':item['Image'],'Config':item['Config'],'HostConfig':item['HostConfig'],
                         'Mounts':sorted(item['Mounts'],key=lambda mount:mount['Destination']),
                         'Networks':{name:value.get('NetworkID') for name,value in sorted(item['NetworkSettings']['Networks'].items())}}
                        for item in sorted(apps,key=lambda item:item['Id'])]))):raise fail()
            approved=approval['media']
        networks={}
        for app in apps:
            for name in app.get('NetworkSettings',{}).get('Networks',{}):
                if not M.NAME.fullmatch(name):raise fail()
                networks[name]=P.metadata(docker(['network','inspect','--format','{{json .}}',name]).encode(),byte_limit=1024*1024)
        mount_table=M.table(Path('/proc/self/mountinfo').read_text())
        policy=M.build(point_id,fence['configurationSetSha256'],root,apps,included,approved,mount_table,networks,context_sha256=M.sha(service.context.encode()),daemon_sha256=M.sha(daemon['ID'].encode()))
        M.require_no_unknown_writers(inspections,known,included,policy)
        final=service._capture_controller_config_locked(point_id,fence['controllerId'],fence['imageId'])
        if final!=prepared['configuration']:raise fail()
        service._verify_capture_fence(token)
        if sorted(docker(['container','ls','--all','--no-trunc','--format','{{.ID}}']).splitlines())!=sorted(rows):raise fail()
        for item in apps:
            final_app=P.metadata(docker(['container','inspect','--format','{{json .}}',item['Id']]).encode(),byte_limit=8*1024*1024)
            if M.container_observation(final_app)!=M.container_observation(item):raise fail()
        C.immutable(directory/'mount-policy.json',P.canonical(policy))
        return {'version':1,'pointId':point_id,'mountPolicy':policy,'mountPolicySha256':M.sha(P.canonical(policy)),'runtimeV5Available':False}


def capture_mount_policy(service,point_id,token):
    deadline=service.HOST.CAPTURE_READ_DEADLINE.set(time.monotonic()+30)
    try:return _capture_mount_policy(service,point_id,token)
    finally:service.HOST.CAPTURE_READ_DEADLINE.reset(deadline)
