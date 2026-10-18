"""Opt-in source process probe on the owned Linux guest; no installed helper/core changes."""

import argparse
import json
import os
import subprocess
from pathlib import Path


PROBE = r'''
import hashlib,http.client,importlib.util,json,os,platform,socket,subprocess,tempfile,threading,time
from pathlib import Path
assert platform.machine()=='aarch64' and os.cpu_count()==2
base=Path('/Users/sai/Documents/ChatGPT/homelab/scripts')
installed=Path('/opt/orbis/host-service/orbis-host-service.py')
before=hashlib.sha256(installed.read_bytes()).hexdigest()
def core():
    result=subprocess.run(['docker','--context','default','inspect','--format','{{index .Config.Labels "org.opencontainers.image.version"}} {{.State.Health.Status}}','runtipi'],capture_output=True,text=True,timeout=5,check=True)
    assert result.stdout.strip()=='v0.1.0-beta.42 healthy'
core()
spec=importlib.util.spec_from_file_location('orbis_process_source_probe',base/'orbis-host-service.py')
service=importlib.util.module_from_spec(spec);spec.loader.exec_module(service)
result={}
with tempfile.TemporaryDirectory(prefix='orbis-process-proof-') as directory:
    address=Path(directory)/'host.sock'
    server=service.UnixHTTPServer(str(address),service.Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    def read(target='/v1/processes'):
        client=http.client.HTTPConnection('localhost',timeout=2)
        transport=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);transport.settimeout(2);transport.connect(str(address));client.sock=transport
        client.request('GET',target);response=client.getresponse();status=response.status;body=json.loads(response.read());client.close()
        return status,body
    try:
        began=time.monotonic();status,initial=read();latency=time.monotonic()-began
        assert status==200 and latency<0.5
        deadline=time.monotonic()+4
        while time.monotonic()<deadline:
            status,first=read()
            if first.get('available'):break
            time.sleep(0.05)
        assert first.get('available') and not first['stale'] and first['compared']==0 and not first['byCpu'] and first['byMemory']
        wall_start=time.monotonic();cpu_start=time.process_time()
        # A bounded workload in this probe itself gives a real, independently measured CPU comparison.
        while time.process_time()-cpu_start<2 and time.monotonic()-wall_start<8:
            sum(range(3000))
        assert time.process_time()-cpu_start>=2
        time.sleep(max(0,10.1-(time.monotonic()-wall_start)))
        deadline=time.monotonic()+4
        while time.monotonic()<deadline:
            status,second=read()
            if second.get('sampledAt')!=first['sampledAt']:break
            time.sleep(0.05)
        expected=(time.process_time()-cpu_start)/(time.monotonic()-wall_start)*100
        assert second.get('available') and not second['stale'] and second['sampledAt']!=first['sampledAt']
        own=next(row for row in second['byCpu'] if row['pid']==os.getpid())
        assert 10<own['cpuPercent']<40 and abs(own['cpuPercent']-expected)<3
        resident=int(Path('/proc/self/statm').read_text().split()[1])*os.sysconf('SC_PAGE_SIZE')
        assert abs(own['memoryBytes']-resident)<=2*1024*1024
        assert not second['limited'] and second['scanned']==second['readable']+second['unreadable']
        assert 0<second['compared']<=second['readable']<=8192
        for group,key in [('byCpu','cpuPercent'),('byMemory','memoryBytes')]:
            assert len(second[group])==min(20,second['compared'] if group=='byCpu' else second['readable'])
            assert second[group]==sorted(second[group],key=lambda row:(-row[key],row['pid']))
            assert all(set(row)=={'pid','name','cpuPercent','memoryBytes'} for row in second[group])
        assert read('/v1/processes?pid=1')[0]==404
        assert not service.PROCESSES.running
        result={'passed':True,'scope':'Temporary source Unix handler in owned arm64 guest; installed helper/core unchanged',
          'macDockerContext':'colima-runtipi-test','guestDockerContext':'default','coreTag':'v0.1.0-beta.42',
          'firstResponseMilliseconds':round(latency*1000,2),'twoDistinctSamples':True,'firstCpuUnavailable':True,'memoryAvailableImmediately':True,
          'scanned':second['scanned'],'readable':second['readable'],'unreadable':second['unreadable'],'compared':second['compared'],'limited':second['limited'],
          'cpuRows':len(second['byCpu']),'memoryRows':len(second['byMemory']),'rankingsOrdered':True,'selectedFieldsOnly':True,
          'boundedOwnWorkloadCpuPercent':round(own['cpuPercent'],3),'independentProcessTimePercent':round(expected,3),
          'residentMemoryMatchesIndependentStatm':True,'queryPathRejected':True,'collectorIdle':True,
          'sourceSha256':{name:hashlib.sha256((base/name).read_bytes()).hexdigest() for name in ['orbis-host-service.py','orbis-host-processes.py']}}
    finally:
        server.shutdown();server.server_close();thread.join(timeout=2)
        assert not thread.is_alive()
        result['serverClosed']=True
core()
assert hashlib.sha256(installed.read_bytes()).hexdigest()==before
result['installedHelperUnchanged']=True
print(json.dumps(result))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-owned-source-probe", action="store_true", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not args.output.is_absolute() or not args.output.parent.resolve().is_relative_to(Path("/tmp").resolve()):
        raise ValueError("proof output must remain under /tmp")
    os.umask(0o077)
    completed = subprocess.run(
        ["colima", "--profile", "runtipi-test", "ssh", "--", "sudo", "-n", "env", "PYTHONDONTWRITEBYTECODE=1", "timeout", "--kill-after=2s", "25s", "python3", "-"],
        input=PROBE, text=True, capture_output=True, timeout=35,
    )
    if completed.returncode:
        raise RuntimeError("owned Linux process probe failed; remote output omitted")
    result = json.loads(completed.stdout)
    if not all(result.get(key) for key in ("passed", "serverClosed", "installedHelperUnchanged")):
        raise RuntimeError("owned Linux process probe incomplete")
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
