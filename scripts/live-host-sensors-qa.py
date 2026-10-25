"""Read source or installed sensor handlers in the owned isolated Linux guest."""

import argparse
import hashlib
import json
import os
import subprocess,os
from pathlib import Path


CONTEXT = "colima-runtipi-test"
INSTALL = os.environ.get('ORBIS_QA_INSTALL_ROOT', '/opt/orbis-qa/install')
IMAGE = "ghcr.io/twentylines/orbis@sha256:0e899b65f10b4bb8fbd72b49fc1ca20ec1856ce1c471ca5f5686b081b8f52d06"
PROBE = r'''
import hashlib,http.client,importlib.util,json,os,re,socket,stat,tempfile,threading,time
from pathlib import Path
source=(Path(os.environ.get('ORBIS_QA_SOURCE_ROOT', '/opt/orbis-qa/source'))/'scripts')
assert os.uname().sysname=='Linux' and os.uname().machine=='aarch64'
spec=importlib.util.spec_from_file_location('orbis_sensor_source_handler',source/'orbis-host-service.py')
service=importlib.util.module_from_spec(spec);spec.loader.exec_module(service)
result={}
with tempfile.TemporaryDirectory(prefix='orbis-sensor-source-') as directory:
    address=Path(directory)/'host.sock'
    server=service.UnixHTTPServer(str(address),service.Handler)
    os.chmod(address,0o600)
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    def read(method='GET',target='/v1/sensors'):
        transport=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);transport.settimeout(2);transport.connect(str(address))
        client=http.client.HTTPConnection('localhost',timeout=2);client.sock=transport
        client.request(method,target);response=client.getresponse();status=response.status;body=response.read();client.close()
        return status,json.loads(body)
    try:
        began=time.monotonic();status,initial=read();latency=time.monotonic()-began
        assert status==200 and latency<0.5
        deadline=time.monotonic()+4
        while time.monotonic()<deadline:
            status,sample=read()
            if sample.get('available'):break
            time.sleep(0.05)
        assert status==200 and sample.get('available') and not sample['stale']
        assert not sample['unavailable'] and not sample['limited']
        expected={'temperatures':set(),'fans':set(),'gpus':set()}
        for chip in Path('/sys/class/hwmon').glob('hwmon[0-9]*'):
            for attribute in chip.iterdir():
                if re.fullmatch(r'temp[1-9][0-9]*_input',attribute.name):
                    expected['temperatures'].add('temperature:'+hashlib.sha256(str(attribute.resolve()).encode()).hexdigest()[:16])
                if re.fullmatch(r'fan[1-9][0-9]*_input',attribute.name):
                    expected['fans'].add('fan:'+hashlib.sha256(str(attribute.resolve()).encode()).hexdigest()[:16])
        for card in Path('/sys/class/drm').glob('card[0-9]*'):
            if re.fullmatch(r'card[0-9]+',card.name) and (card/'device').exists():
                expected['gpus'].add('gpu:'+hashlib.sha256(str((card/'device').resolve()).encode()).hexdigest()[:16])
        for group in expected:
            assert {row['id'] for row in sample[group]}==expected[group]
            assert sample['omitted'][group]==0
        attempt=service.SENSORS.last_attempt
        for _ in range(20):
            status,shared=read();assert status==200 and shared['sampledAt']==sample['sampledAt']
        assert service.SENSORS.last_attempt==attempt
        assert read(target='/v1/sensors?path=/etc/shadow')[0]==404
        assert read(method='POST')[0]==404
        assert stat.S_IMODE(address.stat().st_mode)==0o600
        result={'passed':True,'scope':'New source Unix handler in the owned arm64 Linux guest. Installed helper/core are unchanged. This does not prove physical hardware readings when lists are empty.',
          'firstResponseMilliseconds':round(latency*1000,2),'exposedKernelIdentitiesMatched':{key:len(value) for key,value in expected.items()},
          'actualNumericHardwareRows':sum(row.get('status')=='available' for group in ['temperatures','fans'] for row in sample[group]),
          'twentySharedReadsDoNotResample':True,'queryAndPostRejected':True,'sourceSocketMode':'0600',
          'sourceSha256':{name:hashlib.sha256((source/name).read_bytes()).hexdigest() for name in ['orbis-host-service.py','orbis-host-sensors.py']}}
    finally:
        server.shutdown();server.server_close();worker.join(2)
        result['serverClosed']=not worker.is_alive()
assert result.get('passed') and result['serverClosed']
print(json.dumps(result))
'''

INSTALLED_PROBE = r'''
import datetime,hashlib,http.client,json,os,re,socket,stat,subprocess,tarfile,time
from pathlib import Path
source=(Path(os.environ.get('ORBIS_QA_SOURCE_ROOT', '/opt/orbis-qa/source'))/'scripts');installed=Path('/opt/orbis/host-service')
archive=Path('/var/lib/orbis/snapshots/helper-before-sensors-20261018T075207Z.tar.gz')
archive_hash='19c6accfa4307ca49c862ec5950bd997bb1ec07c0bfd365a659426047c3b2f8b'
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
assert changed==['/opt/orbis/host-service/orbis-host-service.py']
assert len(list(installed.glob('*.py')))==13 and stat.S_IMODE(installed.stat().st_mode)==0o700
for file in installed.glob('*.py'):
    assert not file.is_symlink() and file.stat().st_uid==0 and stat.S_IMODE(file.stat().st_mode)==0o600
    assert file.read_bytes()==(source/file.name).read_bytes()
assert not Path('/var/lib/orbis/state/helper-maintenance.json').exists()
address=Path('/run/orbis/host.sock');assert address.stat().st_uid==0 and stat.S_IMODE(address.stat().st_mode)==0o600
active=subprocess.run(['systemctl','is-active','orbis-host.service'],capture_output=True,text=True,timeout=3)
assert active.returncode==0 and active.stdout.strip()=='active'
def read(method='GET',target='/v1/sensors'):
    client=http.client.HTTPConnection('localhost',timeout=2);transport=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    transport.settimeout(2);transport.connect(str(address));client.sock=transport
    try:
        client.request(method,target);response=client.getresponse();body=response.read(262145);assert len(body)<=262144
        return response.status,json.loads(body)
    finally:client.close()
began=time.monotonic();status,sample=read();latency=time.monotonic()-began
assert status==200 and latency<.5
deadline=time.monotonic()+5
while time.monotonic()<deadline:
    if sample.get('available'):
        age=datetime.datetime.now(datetime.timezone.utc).timestamp()-datetime.datetime.fromisoformat(sample['sampledAt'].replace('Z','+00:00')).timestamp()
        if not sample['stale'] and -2<=age<27:break
    time.sleep(.05);status,sample=read();assert status==200
assert sample.get('available') and not sample['stale'] and -2<=age<27
expected={'temperatures':set(),'fans':set(),'gpus':set()}
for chip in Path('/sys/class/hwmon').glob('hwmon[0-9]*'):
    for attribute in chip.iterdir():
        for group,kind,pattern in [('temperatures','temperature',r'temp[1-9][0-9]*_input'),('fans','fan',r'fan[1-9][0-9]*_input')]:
            if re.fullmatch(pattern,attribute.name):expected[group].add(kind+':'+hashlib.sha256(str(attribute.resolve()).encode()).hexdigest()[:16])
for card in Path('/sys/class/drm').glob('card[0-9]*'):
    if re.fullmatch(r'card[0-9]+',card.name) and (card/'device').exists():
        expected['gpus'].add('gpu:'+hashlib.sha256(str((card/'device').resolve()).encode()).hexdigest()[:16])
assert not sample['unavailable'] and not sample['limited'] and not sample['unreadable']
for group in expected:
    assert {row['id'] for row in sample[group]}==expected[group] and sample['omitted'][group]==0
for _ in range(20):
    status,shared=read();assert status==200 and shared['sampledAt']==sample['sampledAt']
inside=subprocess.run(['docker','--context','default','exec','runtipi','curl','-fsS','--max-time','2','--unix-socket',str(address),'http://localhost/v1/sensors'],capture_output=True,text=True,timeout=4)
assert inside.returncode==0 and json.loads(inside.stdout)==sample
assert read(target='/v1/sensors?path=/etc/shadow')[0]==404 and read(method='POST')[0]==404
for target in ['/v1/telemetry','/v1/processes']:
    deadline=time.monotonic()+2
    while time.monotonic()<deadline:
        status,existing=read(target=target);assert status==200
        if existing.get('available'):break
        time.sleep(.05)
    assert existing.get('available')
print(json.dumps({'passed':True,'installedHelperVerified':True,'scope':'Installed helper on owned arm64 VM; beta45 core unchanged and does not expose the sensor API yet. Empty lists do not prove physical numeric readings.',
 'backup':str(archive),'backupSha256':archive_hash,'backupEntries':14,'installedModules':13,
 'onlyExistingModuleChanged':'orbis-host-service.py','addedModule':'orbis-host-sensors.py','environmentUnitAndOtherModulesMatchBackup':True,
 'privateScriptDirectoryAndSocketModes':True,'maintenanceAbsent':True,'serviceActive':True,
 'firstResponseMilliseconds':round(latency*1000,2),'twentySharedReadsDoNotResample':True,'coreSocketReadMatchesHost':True,'existingTelemetryAndProcessesAvailable':True,'queryAndPostRejected':True,
 'exposedKernelIdentitiesMatched':{key:len(value) for key,value in expected.items()},'actualNumericHardwareRows':sum(row.get('status')=='available' for group in ['temperatures','fans'] for row in sample[group]),
 'sourceSha256':{name:hashlib.sha256((installed/name).read_bytes()).hexdigest() for name in ['orbis-host-service.py','orbis-host-sensors.py']}}))
'''


def command(arguments):
    completed = subprocess.run(arguments, capture_output=True, text=True, timeout=15)
    if completed.returncode:
        raise RuntimeError("owned runtime preflight failed; output omitted")
    return completed.stdout


def core():
    identifiers = command(["docker", "--context", CONTEXT, "ps", "-q", "--filter", "label=com.docker.compose.service=runtipi"]).split()
    if len(identifiers) != 1:
        raise ValueError("one owned core is required")
    fields = '{"image":{{json .Config.Image}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}}}'
    value = json.loads(command(["docker", "--context", CONTEXT, "inspect", "--format", fields, identifiers[0]]))
    if value["image"] != IMAGE or value["health"] != "healthy" or not value["running"] or value["paused"]:
        raise ValueError("exact healthy beta45 core is required")
    expected = {"/data/.env": ".env", "/data/apps": "apps", "/data/repos": "repos", "/data/user-config": "user-config", "/data/state": "state", "/app-data": "app-data"}
    for destination, relative in expected.items():
        matches = [item for item in value["mounts"] if item["Destination"] == destination]
        if len(matches) != 1 or matches[0]["Type"] != "bind" or matches[0]["Source"] != INSTALL + "/" + relative:
            raise ValueError("owned installation bind differs")
    if any(any(item["Destination"].startswith(destination + "/") for destination in expected) for item in value["mounts"]):
        raise ValueError("owned installation has a nested bind override")
    bindings = [item for entries in value["ports"].values() for item in (entries or []) if item["HostPort"] == "18080"]
    if not bindings or any(item["HostIp"] not in {"127.0.0.1", "::1"} for item in bindings):
        raise ValueError("owned HTTP listener must remain loopback18080")
    return {"idHash": hashlib.sha256(value["id"].encode()).hexdigest(), "image": IMAGE, "startedAt": value["startedAt"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument("--allow-owned-source-probe", action="store_true")
    scope.add_argument("--allow-owned-installed-probe", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output
    if not output.is_absolute() or output.parent.resolve() != Path("/tmp").resolve():
        raise ValueError("private proof output must be directly under /tmp")
    if output.exists() or output.is_symlink():
        raise ValueError("proof output must be new")
    os.umask(0o077)
    before = core()
    completed = subprocess.run(
        ["colima", "--profile", "runtipi-test", "ssh", "--", "sudo", "-n", "env", "PYTHONDONTWRITEBYTECODE=1", "timeout", "--kill-after=2s", "15s", "python3", "-"],
        input=PROBE if args.allow_owned_source_probe else INSTALLED_PROBE, text=True, capture_output=True, timeout=25,
    )
    if completed.returncode:
        diagnostic = output.with_suffix(".private.stderr")
        descriptor = os.open(diagnostic, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            stream.write(completed.stderr)
        raise RuntimeError("owned Linux sensor probe failed; remote output retained privately")
    result = json.loads(completed.stdout)
    complete = result.get("serverClosed") if args.allow_owned_source_probe else result.get("installedHelperVerified")
    if not result.get("passed") or not complete or core() != before:
        raise RuntimeError("sensor probe or unchanged-core witness failed")
    result.update(macDockerContext=CONTEXT, unchangedCore=before, installedRuntimeMutations=0)
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(descriptor, (json.dumps(result, indent=2) + "\n").encode())
    finally:
        os.close(descriptor)
    print(json.dumps({"passed": True, "output": str(output), "exposedKernelIdentitiesMatched": result["exposedKernelIdentitiesMatched"]}))


if __name__ == "__main__":
    main()
