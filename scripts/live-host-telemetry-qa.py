"""Read-only source or installed-helper probe on the owned Linux guest. No helper/core changes."""

import argparse
import json
import os
import subprocess
from pathlib import Path


PROBE = r'''
import hashlib,http.client,importlib.util,json,os,socket,tempfile,threading,time
from pathlib import Path
base=Path('/Users/sai/Documents/ChatGPT/homelab/scripts')
spec=importlib.util.spec_from_file_location('orbis_source_counter_probe',base/'orbis-host-service.py')
service=importlib.util.module_from_spec(spec); spec.loader.exec_module(service)
with tempfile.TemporaryDirectory(prefix='orbis-counters-proof-') as directory:
    address=Path(directory)/'host.sock'
    server=service.UnixHTTPServer(str(address),service.Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
    def read(path='/v1/telemetry'):
        conn=http.client.HTTPConnection('localhost',timeout=2)
        transport=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); transport.settimeout(2); transport.connect(str(address)); conn.sock=transport
        conn.request('GET',path); response=conn.getresponse(); status=response.status; value=json.loads(response.read()); conn.close()
        return status,value
    result={}
    try:
        began=time.monotonic(); status,initial=read(); latency=time.monotonic()-began
        assert status==200 and latency<0.5
        deadline=time.monotonic()+4
        while time.monotonic()<deadline:
            status,first=read()
            if first.get('available'): break
            time.sleep(0.05)
        assert first.get('available') and not first['stale']
        time.sleep(10.1)
        deadline=time.monotonic()+4
        while time.monotonic()<deadline:
            status,second=read()
            if second.get('sampledAt')!=first['sampledAt']: break
            time.sleep(0.05)
        assert second.get('available') and not second['stale'] and second['sampledAt']!=first['sampledAt']
        root=next(d for d in second['filesystems'] if d['mount']=='/')
        actual=os.statvfs('/'); assert root['sizeBytes']==actual.f_blocks*(actual.f_frsize or actual.f_bsize)
        assert root['filesystem']=='ext4'
        assert all(d['filesystem'] not in {'overlay','bpf','tmpfs','proc','sysfs'} for d in second['filesystems'])
        for section,key in [('network','rxBytesPerSecond'),('disks','readBytesPerSecond')]:
            assert first[section] and all(item[key] is None for item in first[section])
            assert any(item[key] is not None for item in second[section])
        assert read('/v1/telemetry?path=/etc/shadow')[0]==404
        result={'passed':True,'scope':'New source Unix handler in owned arm64 Linux guest; not an installed/published-image acceptance check',
          'macDockerContext':'colima-runtipi-test','firstResponseMilliseconds':round(latency*1000,2),
          'twoDistinctSamples':True,'firstRatesUnavailable':True,'secondRatesAvailable':True,
          'rootFilesystem':root['filesystem'],'rootCapacityMatchesHostStatvfs':True,'temporaryMountsExcluded':True,
          'filesystems':len(second['filesystems']),'interfaces':len(second['network']),'disks':len(second['disks']),
          'omitted':second['omitted'],'unavailable':second['unavailable'],'queryPathRejected':True,
          'sourceSha256':{name:hashlib.sha256((base/name).read_bytes()).hexdigest() for name in ['orbis-host-service.py','orbis-host-telemetry.py']}}
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)
        assert not thread.is_alive()
        result['serverClosed']=True
print(json.dumps(result))
'''

INSTALLED_PROBE = r'''
import hashlib,http.client,json,os,socket,stat,subprocess,time
from pathlib import Path
source=Path('/Users/sai/Documents/ChatGPT/homelab/scripts')
installed=Path('/opt/orbis/host-service')
names=['orbis-host-service.py','orbis-host-telemetry.py']
hashes={name:hashlib.sha256((installed/name).read_bytes()).hexdigest() for name in names}
assert all(hashes[name]==hashlib.sha256((source/name).read_bytes()).hexdigest() for name in names)
assert all((installed/name).stat().st_uid==0 and stat.S_IMODE((installed/name).stat().st_mode)==0o600 for name in names)
address=Path('/run/orbis/host.sock')
assert stat.S_IMODE(address.stat().st_mode)==0o600
def command(arguments):
    result=subprocess.run(arguments,capture_output=True,text=True,timeout=5)
    assert result.returncode==0
    return result.stdout.strip()
assert command(['systemctl','is-active','orbis-host.service'])=='active'
core=json.loads(command(['docker','--context','default','inspect','--format','{{json .State.Health.Status}}','runtipi']))
assert core=='healthy'
tag=command(['docker','--context','default','inspect','--format','{{index .Config.Labels "org.opencontainers.image.version"}}','runtipi'])
assert tag in {'v0.1.0-beta.41','v0.1.0-beta.42'}
assert not Path('/var/lib/orbis/state/helper-maintenance.json').exists()
def read(path='/v1/telemetry'):
    conn=http.client.HTTPConnection('localhost',timeout=2)
    transport=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); transport.settimeout(2); transport.connect(str(address)); conn.sock=transport
    conn.request('GET',path); response=conn.getresponse(); status=response.status; value=json.loads(response.read()); conn.close()
    return status,value
start=time.monotonic(); status,initial=read(); latency=time.monotonic()-start
assert status==200 and latency<0.5
deadline=time.monotonic()+4
while time.monotonic()<deadline:
    status,first=read()
    if first.get('available'): break
    time.sleep(0.05)
assert first.get('available') and not first['stale']
inside=json.loads(command(['docker','--context','default','exec','runtipi','curl','-fsS','--unix-socket',str(address),'http://localhost/v1/telemetry']))
assert inside.get('available') and inside['sampledAt']==first['sampledAt']
time.sleep(10.1)
deadline=time.monotonic()+4
while time.monotonic()<deadline:
    status,second=read()
    if second.get('sampledAt')!=first['sampledAt']: break
    time.sleep(0.05)
assert second.get('available') and not second['stale'] and second['sampledAt']!=first['sampledAt']
root=next(row for row in second['filesystems'] if row['mount']=='/')
actual=os.statvfs('/'); assert root['sizeBytes']==actual.f_blocks*(actual.f_frsize or actual.f_bsize)
assert root['filesystem']=='ext4'
assert all(row['filesystem'] not in {'overlay','bpf','tmpfs','proc','sysfs'} for row in second['filesystems'])
assert all(0<len(second[section])<=32 for section in ['filesystems','network','disks'])
assert any(row['rxBytesPerSecond'] is not None for row in second['network'])
assert any(row['readBytesPerSecond'] is not None for row in second['disks'])
assert read('/v1/telemetry?path=/etc/shadow')[0]==404
print(json.dumps({'passed':True,'scope':'Installed helper Unix endpoint on owned arm64 guest; core API/render acceptance is separate',
 'installedHelperVerified':True,'serviceActive':True,'coreHealthy':True,'coreTag':tag,'sourceSha256':hashes,
 'privateScriptAndSocketModes':True,'noMaintenanceRecord':True,'coreSocketReadMatchesHost':True,
 'firstResponseMilliseconds':round(latency*1000,2),'twoDistinctSamples':True,'secondRatesAvailable':True,
 'rootCapacityMatchesHostStatvfs':True,'temporaryMountsExcluded':True,'queryPathRejected':True,
 'filesystems':len(second['filesystems']),'interfaces':len(second['network']),'disks':len(second['disks']),
 'omitted':second['omitted'],'unavailable':second['unavailable']}))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument("--allow-owned-source-probe", action="store_true")
    scope.add_argument("--allow-owned-installed-probe", action="store_true")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    output = args.output
    if not output.is_absolute() or not output.parent.resolve().is_relative_to(Path("/tmp").resolve()):
        raise ValueError("proof output must remain under /tmp")
    os.umask(0o077)
    completed = subprocess.run(
        ["colima", "--profile", "runtipi-test", "ssh", "--", "sudo", "-n", "timeout", "--kill-after=2s", "25s", "python3", "-"],
        input=PROBE if args.allow_owned_source_probe else INSTALLED_PROBE, text=True, capture_output=True, timeout=35,
    )
    if completed.returncode != 0:
        raise RuntimeError("owned Linux telemetry probe failed; remote output omitted")
    result = json.loads(completed.stdout)
    if not result.get("passed") or not result.get("serverClosed" if args.allow_owned_source_probe else "installedHelperVerified"):
        raise RuntimeError("owned Linux telemetry probe was incomplete")
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
