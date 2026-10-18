"""Read-only source probe on the owned Linux test guest. No installed helper/core changes."""

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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-owned-source-probe", action="store_true", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    output = args.output
    if not output.is_absolute() or not output.parent.resolve().is_relative_to(Path("/tmp").resolve()):
        raise ValueError("proof output must remain under /tmp")
    os.umask(0o077)
    completed = subprocess.run(
        ["colima", "--profile", "runtipi-test", "ssh", "--", "sudo", "-n", "timeout", "--kill-after=2s", "25s", "python3", "-"],
        input=PROBE, text=True, capture_output=True, timeout=35,
    )
    if completed.returncode != 0:
        raise RuntimeError("owned Linux source probe failed; remote output omitted")
    result = json.loads(completed.stdout)
    if not result.get("passed") or not result.get("serverClosed"):
        raise RuntimeError("owned Linux source probe was incomplete")
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
