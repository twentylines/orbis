"""Exercise only the new source sensor handler in the owned isolated Linux guest."""

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path


CONTEXT = "colima-runtipi-test"
INSTALL = "/Users/sai/.codex/tmp/orbis-stock-20261015"
IMAGE = "ghcr.io/twentylines/orbis@sha256:0e899b65f10b4bb8fbd72b49fc1ca20ec1856ce1c471ca5f5686b081b8f52d06"
PROBE = r'''
import hashlib,http.client,importlib.util,json,os,re,socket,stat,tempfile,threading,time
from pathlib import Path
source=Path('/Users/sai/Documents/ChatGPT/homelab/scripts')
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
    parser.add_argument("--allow-owned-source-probe", action="store_true", required=True)
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
        ["colima", "--profile", "runtipi-test", "ssh", "--", "sudo", "-n", "timeout", "--kill-after=2s", "10s", "python3", "-"],
        input=PROBE, text=True, capture_output=True, timeout=20,
    )
    if completed.returncode:
        raise RuntimeError("owned Linux source sensor probe failed; remote output omitted")
    result = json.loads(completed.stdout)
    if not result.get("passed") or not result.get("serverClosed") or core() != before:
        raise RuntimeError("source probe or unchanged-core witness failed")
    result.update(macDockerContext=CONTEXT, unchangedCore=before, installedRuntimeMutations=0)
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(descriptor, (json.dumps(result, indent=2) + "\n").encode())
    finally:
        os.close(descriptor)
    print(json.dumps({"passed": True, "output": str(output), "exposedKernelIdentitiesMatched": result["exposedKernelIdentitiesMatched"]}))


if __name__ == "__main__":
    main()
