"""Opt-in read-only source or installed identity probe on the owned rehearsal guest."""

import argparse
import json
import os
import subprocess
from pathlib import Path


KERNEL_IDENTITY = r'''
boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
assert re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',boot)
disk_numbers={fields[2]:fields[:2] for line in Path('/proc/diskstats').read_text().splitlines() if len(fields:=line.split())>=14}
def expected(kind,row):
    name=row['interface' if kind=='network' else 'device']
    if kind=='network':
        identity=[name,(Path('/sys/class/net')/name/'ifindex').read_text().strip()]
    else:
        generation=Path('/sys/class/block')/name/'diskseq'
        if not generation.exists():return None
        identity=[name,*disk_numbers[name],generation.read_text().strip()]
    return hashlib.sha256('\0'.join([boot,kind,*identity]).encode()).hexdigest()
def identities(sample):
    result={}
    for group,kind in [('network','network'),('disks','disk')]:
        for row in sample[group]:
            identity=expected(kind,row)
            assert row.get('historyId')==identity
            if identity is not None:
                assert re.fullmatch(r'[0-9a-f]{64}',identity)
                result[(kind,row['interface' if kind=='network' else 'device'])]=identity
    assert result and boot not in json.dumps(sample)
    return result
'''


PROBE = r'''
import hashlib,http.client,importlib.util,json,os,platform,re,socket,subprocess,tempfile,threading,time
from pathlib import Path
assert platform.machine()=='aarch64' and os.cpu_count()==2
base=Path('/Users/sai/Documents/ChatGPT/homelab/scripts')
image='ghcr.io/twentylines/orbis@sha256:85466caef871350b9034287d024fe71dfea27ae670c12197b61df1bfdcdeee86'
def core():
    result=subprocess.run(['docker','--context','default','inspect','--format','{{json .Config.Image}} {{json .State.Health.Status}}','runtipi'],capture_output=True,text=True,timeout=5,check=True)
    assert result.stdout.strip()==json.dumps(image)+' '+json.dumps('healthy')
def protected():
    files=[*Path('/opt/orbis/host-service').glob('*.py'),Path('/etc/orbis/host-service.env'),Path('/etc/systemd/system/orbis-host.service')]
    assert len(files)>=14
    return {str(file):hashlib.sha256(file.read_bytes()).hexdigest() for file in files}
core();before=protected()
spec=importlib.util.spec_from_file_location('orbis_history_source_probe',base/'orbis-host-service.py')
service=importlib.util.module_from_spec(spec);spec.loader.exec_module(service)
''' + KERNEL_IDENTITY + r'''
result={}
with tempfile.TemporaryDirectory(prefix='orbis-history-source-proof-') as directory:
    address=Path(directory)/'host.sock'
    server=service.UnixHTTPServer(str(address),service.Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    def read(target='/v1/telemetry'):
        connection=http.client.HTTPConnection('localhost',timeout=2)
        transport=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);transport.settimeout(2);transport.connect(str(address));connection.sock=transport
        connection.request('GET',target);response=connection.getresponse();status=response.status;body=json.loads(response.read());connection.close()
        return status,body
    def wait_sample(previous=None):
        deadline=time.monotonic()+4
        while time.monotonic()<deadline:
            status,body=read()
            assert status==200
            if body.get('available') and body['sampledAt']!=previous:return body
            time.sleep(0.05)
        raise AssertionError('Source sample did not settle')
    try:
        began=time.monotonic();status,initial=read();latency=time.monotonic()-began
        assert status==200 and latency<0.5
        first=wait_sample();first_ids=identities(first)
        assert not first['stale']
        assert all(row['rxBytesPerSecond'] is None for row in first['network'])
        assert all(row['readBytesPerSecond'] is None for row in first['disks'])
        time.sleep(10.1)
        second=wait_sample(first['sampledAt'])
        assert not second['stale'] and identities(second)==first_ids
        assert any(row['rxBytesPerSecond'] is not None for row in second['network'])
        assert any(row['readBytesPerSecond'] is not None for row in second['disks'])
        restarted=service.TELEMETRY.__class__().collect()
        assert restarted['available'] and identities(restarted)==first_ids
        assert all(row['rxBytesPerSecond'] is None for row in restarted['network'])
        assert read('/v1/telemetry?device=disk:sda')[0]==404
        result={'passed':True,'scope':'Temporary source Unix handler on owned arm64 guest; installed helper and published beta43 unchanged',
          'macDockerContext':'colima-runtipi-test','guestDockerContext':'default','coreImage':image,
          'firstResponseMilliseconds':round(latency*1000,2),'twoDistinctSamples':True,'firstRatesUnavailable':True,'secondRatesAvailable':True,
          'identitiesMatchIndependentKernelDigest':True,'identitiesStableAcrossSamples':True,'identitiesStableAcrossNewCollector':True,
          'newCollectorRatesWaitForComparison':True,'rawBootIdentityNotReturned':True,'parameterizedHelperPathRejected':True,
          'interfaces':len(second['network']),'disks':len(second['disks']),'recordableDevices':len(first_ids),
          'omitted':second['omitted'],'unavailable':second['unavailable'],
          'sourceSha256':{name:hashlib.sha256((base/name).read_bytes()).hexdigest() for name in ['orbis-host-service.py','orbis-host-telemetry.py']}}
    finally:
        server.shutdown();server.server_close();thread.join(timeout=2)
        assert not thread.is_alive()
        result['serverClosed']=True
core();assert protected()==before
result['installedHelperEnvironmentUnitUnchanged']=True
print(json.dumps(result))
'''



INSTALLED_PROBE = r'''
import hashlib,http.client,json,os,re,socket,stat,subprocess,tarfile,time
from pathlib import Path
source=Path('/Users/sai/Documents/ChatGPT/homelab/scripts')
installed=Path('/opt/orbis/host-service')
archive=Path('/var/lib/orbis/snapshots/helper-before-device-history-20261018T053642Z.tar.gz')
archive_hash='6bf69144907a111acc9d0c36f44a467769fbb442fc9e5dee49c1b9aabfadaeaa'
assert archive.is_file() and not archive.is_symlink() and stat.S_IMODE(archive.stat().st_mode)==0o600
assert hashlib.sha256(archive.read_bytes()).hexdigest()==archive_hash
changed=[]
with tarfile.open(archive,'r:gz') as previous:
    members=previous.getmembers();assert len(members)==14
    for member in members:
        assert member.isreg() and not member.name.startswith('/') and '..' not in Path(member.name).parts
        file=Path('/')/member.name
        assert file.is_file() and not file.is_symlink() and file.stat().st_uid==0
        if hashlib.sha256(previous.extractfile(member).read()).digest()!=hashlib.sha256(file.read_bytes()).digest():changed.append(str(file))
assert changed==['/opt/orbis/host-service/orbis-host-telemetry.py']
assert not Path('/var/lib/orbis/state/helper-maintenance.json').exists()
for file in installed.glob('*.py'):
    assert stat.S_IMODE(file.stat().st_mode)==0o600
    assert file.read_bytes()==(source/file.name).read_bytes()
assert stat.S_IMODE(installed.stat().st_mode)==0o700
address=Path('/run/orbis/host.sock')
assert address.stat().st_uid==0 and stat.S_IMODE(address.stat().st_mode)==0o600
image='ghcr.io/twentylines/orbis@sha256:85466caef871350b9034287d024fe71dfea27ae670c12197b61df1bfdcdeee86'
def command(arguments):
    result=subprocess.run(arguments,capture_output=True,text=True,timeout=5,check=True)
    return result.stdout.strip()
def core():
    assert command(['docker','--context','default','inspect','--format','{{json .Config.Image}} {{json .State.Health.Status}}','runtipi'])==json.dumps(image)+' '+json.dumps('healthy')
assert command(['systemctl','is-active','orbis-host.service'])=='active'
core()
''' + KERNEL_IDENTITY + r'''
def read(target='/v1/telemetry'):
    connection=http.client.HTTPConnection('localhost',timeout=2)
    transport=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);transport.settimeout(2);transport.connect(str(address));connection.sock=transport
    connection.request('GET',target);response=connection.getresponse();status=response.status;body=response.read(262145);connection.close()
    assert len(body)<=262144
    return status,json.loads(body)
def wait_sample(previous=None):
    deadline=time.monotonic()+4
    while time.monotonic()<deadline:
        status,body=read();assert status==200
        if body.get('available') and not body['stale'] and body['sampledAt']!=previous:return body
        time.sleep(0.05)
    raise AssertionError('Installed sample did not settle')
began=time.monotonic();status,initial=read();latency=time.monotonic()-began
assert status==200 and latency<0.5
first=wait_sample();first_ids=identities(first)
inside=json.loads(command(['docker','--context','default','exec','runtipi','curl','-fsS','--max-time','2','--unix-socket',str(address),'http://localhost/v1/telemetry']))
assert inside['sampledAt']==first['sampledAt'] and identities(inside)==first_ids
time.sleep(10.1)
second=wait_sample(first['sampledAt'])
assert identities(second)==first_ids
assert any(row['rxBytesPerSecond'] is not None for row in second['network'])
assert any(row['readBytesPerSecond'] is not None for row in second['disks'])
assert read('/v1/telemetry?device=disk:sda')[0]==404
core()
print(json.dumps({'passed':True,'installedHelperVerified':True,'scope':'Installed helper on owned arm64 guest; core remains published beta43 without device-history API/presentation',
 'macDockerContext':'colima-runtipi-test','guestDockerContext':'default','coreImage':image,'coreExactImageUnchanged':True,'coreHealthy':True,
 'serviceActive':True,'privateScriptDirectoryAndSocketModes':True,'noMaintenanceRecord':True,
 'backupSha256':archive_hash,'backupEntries':14,'onlyTelemetryModuleChanged':True,'environmentUnitAndOtherModulesMatchBackup':True,
 'firstResponseMilliseconds':round(latency*1000,2),'twoDistinctSamples':True,'secondRatesAvailable':True,
 'identitiesMatchIndependentKernelDigest':True,'identitiesStableAcrossSamples':True,'rawBootIdentityNotReturned':True,
 'coreSocketReadMatchesHost':True,'parameterizedHelperPathRejected':True,
 'interfaces':len(second['network']),'disks':len(second['disks']),'recordableDevices':len(first_ids),
 'omitted':second['omitted'],'unavailable':second['unavailable'],
 'sourceSha256':{name:hashlib.sha256((installed/name).read_bytes()).hexdigest() for name in ['orbis-host-service.py','orbis-host-telemetry.py']}}))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument("--allow-owned-source-probe", action="store_true")
    scope.add_argument("--allow-owned-installed-probe", action="store_true")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not args.output.is_absolute() or not args.output.parent.resolve().is_relative_to(Path("/tmp").resolve()):
        raise ValueError("history proof output must remain under /tmp")
    os.umask(0o077)
    completed = subprocess.run(
        ["colima", "--profile", "runtipi-test", "ssh", "--", "sudo", "-n", "timeout", "--kill-after=2s", "25s", "python3", "-"],
        input=PROBE if args.allow_owned_source_probe else INSTALLED_PROBE, text=True, capture_output=True, timeout=35,
    )
    if completed.returncode:
        raise RuntimeError("owned history probe failed; remote output omitted")
    result = json.loads(completed.stdout)
    complete = (result.get("installedHelperEnvironmentUnitUnchanged") and result.get("serverClosed")) if args.allow_owned_source_probe else result.get("installedHelperVerified")
    if not result.get("passed") or not complete:
        raise RuntimeError("owned history probe was incomplete")
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
