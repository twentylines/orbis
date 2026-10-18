"""Opt-in read-only source identity probe on the owned Linux rehearsal guest."""

import argparse
import json
import os
import subprocess
from pathlib import Path


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-owned-source-probe", required=True, action="store_true")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not args.output.is_absolute() or not args.output.parent.resolve().is_relative_to(Path("/tmp").resolve()):
        raise ValueError("source proof output must remain under /tmp")
    os.umask(0o077)
    completed = subprocess.run(
        ["colima", "--profile", "runtipi-test", "ssh", "--", "sudo", "-n", "timeout", "--kill-after=2s", "25s", "python3", "-"],
        input=PROBE, text=True, capture_output=True, timeout=35,
    )
    if completed.returncode:
        raise RuntimeError("owned source history probe failed; remote output omitted")
    result = json.loads(completed.stdout)
    if not result.get("passed") or not result.get("installedHelperEnvironmentUnitUnchanged") or not result.get("serverClosed"):
        raise RuntimeError("owned source history probe was incomplete")
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
