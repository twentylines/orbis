"""Read-only, explicitly opted-in beta45 device-history checks on the owned guest.

This script never starts/stops a container, changes helper files, launches a
browser, or writes to the guest. The operator closes owned browser clients and
performs the same-image stop/start between stopped-checkpoint and after-restart.
All inputs and reports are private files under /tmp. Run --self-check offline.
"""

import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


TAG = "v0.1.0-beta.45"
COMMIT = "c58aa30268d2b7ec8b7d49cbb1cbde91344db2ef"
CONTEXT = "colima-runtipi-test"
INSTALL = os.environ.get('ORBIS_QA_INSTALL_ROOT', '/opt/orbis-qa/install')
ORIGIN = "http://127.0.0.1:18080"
MAX_BYTES = 32 * 1024 * 1024
MAX_SAFE = 2**53 - 1
RANGES = {"5m": 10, "1h": 60, "24h": 300, "7d": 1800}
FIELDS = ("inbound", "outbound", "busy")
MODULES = ("orbis-host-service.py", "orbis-host-telemetry.py")
NAME = re.compile(r"[a-zA-Z0-9_.:@+!-]{1,128}\Z")
SHA = re.compile(r"[a-f0-9]{64}\Z")


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def private_path(value, existing=True):
    value = Path(value)
    require(value.is_absolute() and value.parent.resolve().is_relative_to(Path("/tmp").resolve()), "Private files must be under /tmp")
    require(not value.is_symlink(), "Private file must not be a symlink")
    if existing:
        info = value.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600, "Private input must be an owned regular 0600 file")
    return value


def read_private(value, limit=MAX_BYTES * 4):
    value = private_path(value)
    fd = os.open(value, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= limit, "Private input bound or ownership changed")
        data = stream.read(limit + 1)
    require(len(data) <= limit, "Private input exceeds its bound")
    return data


def write_private(value, result):
    value = private_path(value, existing=False)
    descriptor = os.open(value, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(result, stream, indent=2, allow_nan=False)
        stream.write("\n")


def parse_json(raw):
    def no_duplicates(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON member")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=no_duplicates, parse_constant=lambda _: require(False, "Non-finite JSON"))


def milliseconds(value):
    require(isinstance(value, str) and value.endswith("Z"), "Expected UTC timestamp")
    parsed = dt.datetime.fromisoformat(value[:-1] + "+00:00")
    elapsed = parsed - dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
    stamp = elapsed.days * 86400000 + elapsed.seconds * 1000 + elapsed.microseconds // 1000
    require(stamp >= 0, "Invalid timestamp")
    return stamp


def integer(value, minimum=0, maximum=MAX_SAFE):
    return type(value) is int and minimum <= value <= maximum


def finite(value):
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= MAX_SAFE


def valid_span(first, last, count):
    return first == last if count == 1 else last - first >= (count - 1) * 2000


def valid_name(value):
    return isinstance(value, str) and value not in (".", "..") and NAME.fullmatch(value) is not None


def close(actual, expected):
    return math.isclose(actual, expected, rel_tol=2e-12, abs_tol=1e-7)


def validate_records(records, now):
    """Independent tuple/privacy checks; preserve append versions for evidence."""
    require(isinstance(records, list) and 0 < len(records) <= 4096, "Journal must contain 1..4096 records")
    latest = {}
    for record in records:
        require(isinstance(record, list) and len(record) == 8 and record[0] == 1, "Unexpected journal tuple")
        _, seconds, bucket, first, last, count, evicted, rows = record
        require(seconds in (60, 300, 1800), "Unexpected journal tier")
        require(all(integer(x) for x in (bucket, first, last, count, evicted)), "Invalid journal integers")
        require(bucket % (seconds * 1000) == 0 and bucket <= first <= last < bucket + seconds * 1000, "Invalid journal times")
        require(last <= now + 300000 and 1 <= count <= seconds // 2 + 1 and valid_span(first, last, count), "Impossible journal count/span")
        require(isinstance(rows, list) and len(rows) <= 64, "Journal row bound exceeded")
        seen = set()
        for row in rows:
            require(isinstance(row, list) and len(row) == 15, "Unexpected journal device tuple")
            kind, name, source, row_first, row_last, row_count = row[:6]
            require(type(kind) is int and kind in (0, 1) and valid_name(name), "Unexpected stored device name")
            require(source is None or isinstance(source, str) and SHA.fullmatch(source), "Invalid generation digest")
            require(all(integer(x) for x in (row_first, row_last, row_count)) and 1 <= row_count <= count, "Invalid stored device count")
            require(first <= row_first <= row_last <= last and valid_span(row_first, row_last, row_count), "Impossible stored device times")
            key = (kind, name)
            require(key not in seen, "Duplicate stored device")
            seen.add(key)
            for index in range(3):
                average, peak, samples = row[6 + index * 3:9 + index * 3]
                require(finite(average) and finite(peak) and integer(samples, maximum=row_count), "Invalid stored metric")
                require(samples != 0 or average == peak == 0, "Unavailable metric has invented values")
                require(samples != 1 or average == peak, "Single reading has differing mean/peak")
                require(average <= peak * (1 + 1e-12) + 1e-8 and (not samples or average + peak * 1e-12 + 1e-8 >= peak / samples), "Impossible stored mean")
                require(index != 2 or peak <= 100 and (kind != 0 or samples == 0), "Invalid busy metric")
                require(source is not None or samples == 0, "Mixed source aggregate exposes a value")
        key = (seconds, bucket)
        require(key not in latest or latest[key][4] <= last, "Journal version moved backwards")
        latest[key] = record
    return latest


GUEST = r'''
import hashlib,http.client,json,os,platform,re,socket,stat,subprocess,time
from pathlib import Path
configuration=CONFIGURATION
def check(condition,message):
    if not condition:raise AssertionError(message)
def run(args):
    result=subprocess.run(args,capture_output=True,text=True,timeout=5)
    check(result.returncode==0,'Read-only guest command failed')
    return result.stdout.strip()
check(platform.machine()=='aarch64' and os.cpu_count()==2,'Wrong owned guest')
image=configuration['image']; mode=configuration['mode']
core=json.loads(run(['docker','--context','default','inspect','--format',
    '{"image":{{json .Config.Image}},"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"mounts":{{json .Mounts}},"labels":{{json .Config.Labels}}}', 'runtipi']))
check(core['image']==image and not core['paused'],'Guest core image mismatch')
check(core['running']==(mode!='stopped-checkpoint'),'Unexpected guest core running state')
if core['running']:check(core['health']=='healthy','Guest core unhealthy')
labels=core['labels'] or {}
check(labels.get('org.opencontainers.image.version')==configuration['tag'],'Image tag label mismatch')
check(labels.get('org.opencontainers.image.revision')==configuration['commit'],'Image revision label mismatch')
mounts=[item for item in core['mounts'] if item['Destination']=='/data/state']
check(len(mounts)==1 and mounts[0]['Type']=='bind' and mounts[0]['Source']==configuration['install']+'/state','Unexpected history state mount')
check(not any(item['Destination'].startswith('/data/state/') for item in core['mounts']),'State mount override')
core={key:core[key] for key in ['image','id','startedAt','running','health']}
directory=Path(configuration['install'])/'state/orbis-host-history';file=directory/'devices-v1.jsonl'
check(not directory.is_symlink() and stat.S_ISDIR(directory.lstat().st_mode) and stat.S_IMODE(directory.stat().st_mode)==0o700,'History directory must be private0700')
records=None
for attempt in range(4):
    fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as handle:
        before=os.fstat(handle.fileno())
        check(stat.S_ISREG(before.st_mode) and stat.S_IMODE(before.st_mode)==0o600 and before.st_size<=33554432,'Journal file must be bounded private0600')
        contents=handle.read(33554433);after=os.fstat(handle.fileno())
    current=file.lstat()
    check(not stat.S_ISLNK(current.st_mode),'Journal symlink changed')
    if (before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_ino,after.st_size,after.st_mtime_ns)==(current.st_ino,current.st_size,current.st_mtime_ns):
        lines=contents.splitlines();check(0<len(lines)<=4096 and len(contents)<=33554432 and all(0<len(line)<=262144 for line in lines),'Journal bounds exceeded')
        records=[json.loads(line) for line in lines];break
    time.sleep(.05)
check(records is not None,'Journal changed during all bounded reads')
installed=Path('/opt/orbis/host-service')
check(not installed.is_symlink() and stat.S_IMODE(installed.stat().st_mode)==0o700,'Helper directory mode changed')
hashes={}
for name,expected_hash in configuration['helperHashes'].items():
    script=installed/name;info=script.lstat()
    check(stat.S_ISREG(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o600,'Installed helper file changed type or mode')
    hashes[name]=hashlib.sha256(script.read_bytes()).hexdigest()
    check(hashes[name]==expected_hash,'Installed helper source pin mismatch')
check(not Path('/var/lib/orbis/state/helper-maintenance.json').exists(),'Helper is in maintenance')
check(run(['systemctl','is-active','orbis-host.service'])=='active','Helper is inactive')
helper=None
if mode!='stopped-checkpoint':
    address=Path('/run/orbis/host.sock');info=address.lstat()
    check(stat.S_ISSOCK(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o600,'Helper socket mode changed')
    transport=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);transport.settimeout(3);transport.connect(str(address))
    connection=http.client.HTTPConnection('localhost',timeout=3);connection.sock=transport
    connection.request('GET','/v1/telemetry');response=connection.getresponse();body=response.read(262145);connection.close()
    check(response.status==200 and len(body)<=262144,'Helper response failed')
    data=json.loads(body);check(data.get('available') and not data.get('stale'),'Helper telemetry unavailable or stale')
    boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    check(re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',boot),'Unexpected boot identity')
    numbers={parts[2]:parts[:2] for line in Path('/proc/diskstats').read_text().splitlines() if len(parts:=line.split())>=14}
    devices=[]
    for group,kind in [('network','network'),('disks','disk')]:
        for row in data[group]:
            name=row['interface' if kind=='network' else 'device']
            check(re.fullmatch(r'[a-zA-Z0-9_.:@+!-]{1,128}',name) and name not in ['.','..'],'Unexpected logical device')
            if kind=='network':
                generation=(Path('/sys/class/net')/name/'ifindex').read_text().strip()
                check(generation.isdecimal() and 0<int(generation)<=2147483647,'Invalid interface generation')
                identity=[name,generation]
            else:
                generation=(Path('/sys/class/block')/name/'diskseq').read_text().strip()
                check(generation.isdecimal() and 0<int(generation)<2**64,'Invalid disk generation')
                identity=[name,*numbers[name],generation]
            digest=hashlib.sha256('\0'.join([boot,kind,*identity]).encode()).hexdigest()
            check(row.get('historyId')==digest,'Kernel generation digest mismatch')
            devices.append({'kind':kind,'name':name,'sourceId':digest})
    check(len(devices)==11 and len({(row['kind'],row['name']) for row in devices})==11,'Expected eleven independently identified current devices')
    check(boot not in json.dumps(data),'Raw boot identity leaked')
    helper={'sampledAt':data['sampledAt'],'devices':devices,'unavailable':data.get('unavailable'),'omitted':data.get('omitted')}
print(json.dumps({'readOnly':True,'capturedAt':int(time.time()*1000),'core':core,'helper':helper,'helperSha256':hashes,
    'journal':{'directoryMode':'0700','fileMode':'0600','bytes':len(contents),'sha256':hashlib.sha256(contents).hexdigest(),'records':records}}))
'''


def guest_program(pins, mode, helper_hashes):
    configuration = {"image": pins["image"], "tag": TAG, "commit": COMMIT, "install": INSTALL, "mode": mode, "helperHashes": helper_hashes}
    return GUEST.replace("CONFIGURATION", repr(configuration), 1)


def command(arguments, timeout=15):
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=timeout)
    require(result.returncode == 0, "Read-only owned command failed; subprocess output withheld")
    return result.stdout


def mac_core(pins, stopped=False):
    prefix = ["docker", "--context", CONTEXT]
    ids = command(prefix + ["ps", "--all", "--filter", "label=com.docker.compose.service=runtipi", "--format", "{{.ID}}"]).split()
    require(len(ids) == 1, "Expected exactly one owned core")
    template = '{"image":{{json .Config.Image}},"imageId":{{json .Image}},"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"mounts":{{json .Mounts}},"ports":{{json .HostConfig.PortBindings}}}'
    core = parse_json(command(prefix + ["inspect", "--format", template, ids[0]]))
    require(core["image"] == pins["image"] and core["running"] == (not stopped) and not core["paused"], "Owned core state/image differs from reviewed release")
    require(stopped or core["health"] == "healthy", "Owned core must be healthy")
    digests = parse_json(command(prefix + ["inspect", "--type", "image", "--format", "{{json .RepoDigests}}", core["imageId"]]))
    require(pins["image"] in (digests or []), "Immutable image digest not present")
    architecture = parse_json(command(prefix + ["inspect", "--type", "image", "--format", "{{json .Architecture}}", core["imageId"]]))
    require(architecture == "arm64", "Owned image architecture differs")
    bindings = [binding for group in core["ports"].values() for binding in group or [] if binding.get("HostPort") == "18080"]
    require(bindings and all(binding.get("HostIp") in ("127.0.0.1", "::1") for binding in bindings), "Owned HTTP must stay on loopback18080")
    expected = {"/data/.env": ".env", "/data/apps": "apps", "/data/repos": "repos", "/data/user-config": "user-config", "/data/state": "state", "/app-data": "app-data"}
    for destination, relative in expected.items():
        matches = [item for item in core["mounts"] if item["Destination"] == destination]
        require(len(matches) == 1 and matches[0]["Type"] == "bind" and matches[0]["Source"] == INSTALL + "/" + relative, "Owned bind differs")
    require(not any(any(item["Destination"].startswith(destination + "/") for destination in expected) for item in core["mounts"]), "Owned bind has a nested override")
    return {key: core[key] for key in ("image", "imageId", "id", "startedAt", "running", "health")}


def snapshot(pins, mode, helper_hashes):
    local = mac_core(pins, stopped=mode == "stopped-checkpoint")
    program = guest_program(pins, mode, helper_hashes)
    compile(program, "<read-only-owned-guest>", "exec")
    result = subprocess.run(["colima", "--profile", "runtipi-test", "ssh", "--", "sudo", "-n", "timeout", "--kill-after=2s", "20s", "python3", "-"], input=program, text=True, capture_output=True, timeout=30)
    require(result.returncode == 0, "Read-only guest verification failed; remote output withheld")
    require(len(result.stdout) <= MAX_BYTES * 3, "Guest proof exceeds its output bound")
    remote = parse_json(result.stdout)
    require(remote.get("readOnly") is True and remote["core"]["id"] == local["id"] and remote["core"]["startedAt"] == local["startedAt"], "Mac and guest do not identify the same core")
    validate_records(remote["journal"]["records"], remote["capturedAt"])
    remote["core"] = local
    return remote


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise AssertionError("Owned API unexpectedly redirected")


class Api:
    def __init__(self, cookie_file):
        raw = read_private(cookie_file, 65536).decode()
        cookies = []
        for line in raw.splitlines():
            if line.startswith("#HttpOnly_"):
                line = line[len("#HttpOnly_"):]
            elif not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) == 7 and parts[0].lstrip(".") == "127.0.0.1" and parts[2] == "/" and parts[5] == "runtipi-sid":
                require(parts[6] and not re.search(r"[\r\n;]", parts[6]), "Invalid session cookie")
                cookies.append(parts[6])
        require(len(cookies) == 1, "Expected exactly one owned loopback session cookie")
        self.cookie = "runtipi-sid=" + cookies[0]
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.reads = 0

    def get(self, path, authenticated=True, expected=200):
        require(path.startswith("/api/system/") and "#" not in path and "\r" not in path and "\n" not in path, "Unapproved API path")
        headers = {"Accept": "application/json", "Cache-Control": "no-cache"}
        if authenticated:
            headers["Cookie"] = self.cookie
        request = urllib.request.Request(ORIGIN + path, headers=headers, method="GET")
        self.reads += 1
        try:
            response = self.opener.open(request, timeout=6)
        except urllib.error.HTTPError as response_error:
            response = response_error
        with response:
            require(response.status == expected, "API status did not match the expected status")
            raw = response.read(4 * 1024 * 1024 + 1)
            require(len(raw) <= 4 * 1024 * 1024, "API response exceeds its bound")
        return parse_json(raw) if expected == 200 else None

    def history(self, range_name, key=None):
        query = [("range", range_name)] + ([("device", key)] if key else [])
        return self.get("/api/system/host-history?" + urllib.parse.urlencode(query))


def point_row(point, kind, name):
    require(set(point) == {"at", "until", "intervalSeconds", "samples", "sourceId", *FIELDS}, "Unexpected history point members")
    first, last, samples, source = milliseconds(point["at"]), milliseconds(point["until"]), point["samples"], point["sourceId"]
    require(integer(samples, 1) and first <= last and valid_span(first, last, samples), "Impossible API point count/times")
    require(source is None or isinstance(source, str) and SHA.fullmatch(source), "Invalid API generation digest")
    row = [0 if kind == "network" else 1, name, source, first, last, samples]
    for field in FIELDS:
        value = point[field]
        require(set(value) == {"average", "peak", "samples"} and integer(value["samples"], maximum=samples), "Unexpected API metric")
        count = value["samples"]
        if count:
            require(finite(value["average"]) and finite(value["peak"]), "Invalid measured API value")
            require(source is not None and value["average"] <= value["peak"] * (1 + 1e-12) + 1e-8 and value["average"] + value["peak"] * 1e-12 + 1e-8 >= value["peak"] / count, "Impossible API mean/source")
        else:
            require(value["average"] is None and value["peak"] is None, "Unavailable API reading is not null")
        row.extend([value["average"] if count else 0, value["peak"] if count else 0, count])
    require(kind != "network" or row[14] == 0, "Network exposes disk busy data")
    require(row[13] <= 100, "Busy exceeds100 percent")
    return row


def validate_api(body, range_name, key=None):
    expected = {"range", "from", "to", "resolutionSeconds", "sampledEverySeconds", "retentionDays", "seriesLimit", "storage", "collectorAvailable", "reason", "unidentifiedDevices", "omittedDevices", "evictedDevices", "lastSampleAt", "persistedThrough", "devices", "selected", "points"}
    require(set(body) == expected and body["range"] == range_name, "Unexpected history response shape/range")
    require(body["resolutionSeconds"] == RANGES[range_name] and body["sampledEverySeconds"] == 10 and body["retentionDays"] == 7 and body["seriesLimit"] == 64, "History bounds/cadence differ")
    require(body["storage"] == "persistent" and body["collectorAvailable"] is True, "Actual history is unavailable")
    require(body["reason"] is None and body["unidentifiedDevices"] == 0 and body["omittedDevices"] == 0, "Owned history reports incomplete collection")
    require(integer(body["evictedDevices"]) and isinstance(body["devices"], list) and len(body["devices"]) <= 64 and isinstance(body["points"], list) and len(body["points"]) <= 720, "History capacity exceeded")
    require(milliseconds(body["from"]) < milliseconds(body["to"]) and milliseconds(body["lastSampleAt"]) <= milliseconds(body["to"]), "Invalid history time window")
    require(body["persistedThrough"] is not None and milliseconds(body["persistedThrough"]) <= milliseconds(body["lastSampleAt"]), "Persistence watermark exceeds collection")
    seen = set()
    for device in body["devices"]:
        require(set(device) == {"kind", "name", "lastSeenAt", "present"} and device["kind"] in ("network", "disk") and valid_name(device["name"]) and type(device["present"]) is bool, "Unexpected catalogue device")
        device_key = device["kind"] + ":" + device["name"]
        require(device_key not in seen and milliseconds(device["lastSeenAt"]) <= milliseconds(body["lastSampleAt"]), "Duplicate or future catalogue entry")
        seen.add(device_key)
    selection = body["selected"]
    require(selection is not None and set(selection) == {"kind", "name"} and selection["kind"] in ("network", "disk") and valid_name(selection["name"]), "Missing/invalid selected device")
    require(key is None or selection["kind"] + ":" + selection["name"] == key, "Selection changed unexpectedly")
    previous = -1
    for point in body["points"]:
        row = point_row(point, selection["kind"], selection["name"])
        require(point["intervalSeconds"] in ((10, 60) if range_name == "5m" else (RANGES[range_name],)), "Unexpected point resolution")
        require(row[3] > previous and row[4] >= milliseconds(body["from"]) and row[3] <= milliseconds(body["to"]), "History points overlap or are out of range")
        previous = row[4]
    return body


def capture_api(api, keys):
    # A collector tick between calls is retried, never compared as one snapshot.
    for _ in range(4):
        bodies = {key: {range_name: validate_api(api.history(range_name, key), range_name, key) for range_name in RANGES} for key in keys}
        marks = {body["lastSampleAt"] for ranges in bodies.values() for body in ranges.values()}
        if len(marks) == 1:
            return {"lastSampleAt": marks.pop(), "devices": bodies}
    raise AssertionError("Could not capture one coherent collector generation")


def rows_equal(actual, expected, message):
    require(actual[:6] == expected[:6], message + ": identity, timestamp or count differs")
    for index in range(6, 15):
        require(close(actual[index], expected[index]) if index % 3 != 2 else actual[index] == expected[index], message + ": measured mean, peak or null count differs")


def merge_rows(rows):
    require(rows and all(row[:2] == rows[0][:2] for row in rows), "Cannot combine unrelated rows")
    ordered = sorted(rows, key=lambda row: row[3])
    require(all(left[4] < right[3] for left, right in zip(ordered, ordered[1:])), "Measured rows overlap")
    sources = {row[2] for row in ordered}
    source = ordered[0][2] if len(sources) == 1 and None not in sources else None
    result = [*ordered[0][:2], source, ordered[0][3], ordered[-1][4], sum(row[5] for row in ordered)]
    for offset in (6, 9, 12):
        values = [row for row in ordered if row[offset + 2]]
        count = sum(row[offset + 2] for row in values) if source is not None else 0
        result.extend([math.fsum(row[offset] * (row[offset + 2] / count) for row in values) if count else 0, max(row[offset + 1] for row in values) if count else 0, count])
    return result


def indexed_points(capture, key, range_name):
    kind, name = key.split(":", 1)
    return [(point, point_row(point, kind, name)) for point in capture["devices"][key][range_name]["points"]]


def journal_matches(capture, snap):
    latest = validate_records(snap["journal"]["records"], snap["capturedAt"])
    checks = 0
    for key, ranges in capture["devices"].items():
        kind, name = key.split(":", 1)
        for range_name in ("1h", "24h", "7d"):
            seconds = RANGES[range_name]
            points = {(row[3] // (seconds * 1000)) * seconds * 1000: row for _, row in indexed_points(capture, key, range_name)}
            for (tier, bucket), record in latest.items():
                if tier != seconds or bucket + seconds * 1000 > milliseconds(capture["lastSampleAt"]):
                    continue
                stored = next((row for row in record[7] if row[:2] == [0 if kind == "network" else 1, name]), None)
                if stored is not None and stored[4] >= milliseconds(ranges[range_name]["from"]):
                    require(bucket in points, "Persisted completed bucket absent from API")
                    rows_equal(points[bucket], stored, "API/journal summary")
                    checks += 1
    require(checks > 0, "No completed saved summary was compared")
    return checks


def current_identities(capture, snap):
    verified = 0
    for device in snap["helper"]["devices"]:
        key = device["kind"] + ":" + device["name"]
        require(key in capture["devices"], "Current helper device is absent from selected API probes")
        raw = [row for point, row in indexed_points(capture, key, "5m") if point["intervalSeconds"] == 10]
        require(raw and raw[-1][2] == device["sourceId"], "Newest API point differs from independently derived kernel generation")
        verified += 1
    require(verified == 11, "Eleven current generation matches were not verified")
    return verified


def auth_and_validation(api, pins):
    api.get("/api/system/host-history?range=1h", authenticated=False, expected=401)
    build = api.get("/api/system/build")
    require(build["version"] == TAG and build["commit"] == COMMIT, "Actual API build differs from exact release")
    require(build.get("imageDigest") == pins["image"].split("@", 1)[1], "API image digest differs")
    compatibility = pins["runtipiCompatibility"]
    require(build.get("runtipiCompatibility") in (compatibility, "v" + compatibility), "API Runtipi compatibility differs from reviewed release")
    invalid = ["range=8h", "range=", "range=1h&range=5m", "range=1h&device=disk%3A%2Fdev%2Fsda", "range=1h&device=disk%3A..%2Fsda", "range=1h&device=disk%3Asda&device=disk%3Asdb", "range=1h&device=", "range=1h&device=process%3A1"]
    for query in invalid:
        api.get("/api/system/host-history?" + query, expected=400)
    absent_key = "network:orbis:qa-absent"
    absent = validate_api(api.history("1h", absent_key), "1h", absent_key)
    require(not absent["points"], "Absent colon-containing logical device gained invented points")
    return {"anonymous": 401, "authenticated": 200, "invalidAndRepeatedQueries": len(invalid), "validColonLogicalName": True, "build": build}


def observe_patterns(capture):
    changes, gaps, null_metrics = [], [], 0
    for key in capture["devices"]:
        raw = [row for point, row in indexed_points(capture, key, "5m") if point["intervalSeconds"] == 10]
        for left, right in zip(raw, raw[1:]):
            if left[2] != right[2]:
                changes.append({"device": key, "before": left[2], "after": right[2], "at": right[3]})
            if right[3] - left[4] > 15000:
                gaps.append({"device": key, "after": left[4], "before": right[3], "milliseconds": right[3] - left[4]})
        null_metrics += sum(row[offset + 2] == 0 for row in raw for offset in (6, 9, 12))
    return {"observedSourceChanges": changes, "observedSampleGaps": gaps, "unavailableRawMetricCounts": null_metrics, "boundary": "Only actual changes/gaps in captured data are reported; none are induced."}


def quiet_arithmetic(before, after, snap):
    start = ((milliseconds(before["lastSampleAt"]) // 60000) + 1) * 60000
    end = (milliseconds(after["lastSampleAt"]) // 60000) * 60000
    require(start < end, "Quiet interval did not retain a fully observed minute")
    latest = validate_records(snap["journal"]["records"], snap["capturedAt"])
    compared = 0
    for key in after["devices"]:
        raw = [row for point, row in indexed_points(after, key, "5m") if point["intervalSeconds"] == 10]
        summaries = {row[3] // 60000 * 60000: row for _, row in indexed_points(after, key, "1h")}
        for bucket in range(start, end, 60000):
            readings = [row for row in raw if bucket <= row[3] < bucket + 60000]
            if not readings:
                continue
            expected = merge_rows(readings)
            require(bucket in summaries and (60, bucket) in latest, "Actual completed minute is not saved/returned")
            stored = next((row for row in latest[(60, bucket)][7] if row[:2] == expected[:2]), None)
            require(stored is not None, "Actual device samples are absent from saved minute")
            rows_equal(summaries[bucket], expected, "Observed raw/minute API arithmetic")
            rows_equal(stored, expected, "Observed raw/journal arithmetic")
            compared += 1
    require(compared >= 11, "Fewer than eleven actual device-minute aggregates were proved")
    return compared


def quiet_cadence(before, after):
    boundary = milliseconds(before["lastSampleAt"])
    times = sorted({row[3] for key in after["devices"] for point, row in indexed_points(after, key, "5m") if point["intervalSeconds"] == 10 and row[3] > boundary})
    require(len(times) >= 8, "Quiet interval did not collect at least eight actual background readings")
    deltas = [right - left for left, right in zip([boundary, *times], times)]
    require(all(2000 <= delta <= 30000 for delta in deltas), "Actual background cadence is interrupted or impossible")
    return {"distinctBackgroundSamples": len(times), "observedMillisecondsBetweenSamples": deltas, "requestedSampleSeconds": 10}


def restart_arithmetic(saved, capture):
    latest = validate_records(saved["journal"]["records"], saved["capturedAt"])
    minutes = [record for (seconds, _), record in latest.items() if seconds == 60]
    require(minutes, "Stopped checkpoint has no minute summary")
    partial = max(minutes, key=lambda record: record[2])
    boundary = max(record[4] for record in latest.values())
    require(milliseconds(capture["lastSampleAt"]) > boundary, "No post-restart collector sample yet")
    compared, merged, unchanged, new_rows = 0, 0, 0, 0
    for old in partial[7]:
        key = ("network" if old[0] == 0 else "disk") + ":" + old[1]
        if key not in capture["devices"]:
            continue
        raw = [row for point, row in indexed_points(capture, key, "5m") if point["intervalSeconds"] == 10]
        require(all(row[3] > boundary for row in raw), "Post-restart raw history duplicates saved sample times")
        same_minute = [row for row in raw if row[3] // 60000 * 60000 == partial[2]]
        expected = merge_rows([old, *same_minute])
        summaries = {row[3] // 60000 * 60000: row for _, row in indexed_points(capture, key, "1h")}
        require(partial[2] in summaries, "Saved partial minute was not restored")
        rows_equal(summaries[partial[2]], expected, "Saved partial plus unique post-restart readings")
        saved_five_minute = [row for point, row in indexed_points(capture, key, "5m") if point["intervalSeconds"] == 60 and row[:6] == old[:6]]
        require(len(saved_five_minute) == 1, "Five-minute history lost or duplicated the exact saved partial")
        rows_equal(saved_five_minute[0], old, "Five-minute restored partial")
        for bucket in {row[3] // 60000 * 60000 for row in raw if row[3] // 60000 * 60000 != partial[2]}:
            readings = [row for row in raw if row[3] // 60000 * 60000 == bucket]
            require(bucket in summaries, "Post-restart minute is absent")
            rows_equal(summaries[bucket], merge_rows(readings), "Post-restart unique raw arithmetic")
            new_rows += len(readings)
        compared += 1
        merged += bool(same_minute)
        unchanged += not same_minute
    require(compared > 0 and (merged > 0 or new_rows > 0), "Insufficient saved partial/post-restart evidence")
    tier_checks = {"60": 0, "300": 0, "1800": 0}
    for (seconds, bucket), record in latest.items():
        range_name = {60: "1h", 300: "24h", 1800: "7d"}[seconds]
        for old in record[7]:
            key = ("network" if old[0] == 0 else "disk") + ":" + old[1]
            if key not in capture["devices"] or old[4] < milliseconds(capture["devices"][key][range_name]["from"]):
                continue
            raw = [row for point, row in indexed_points(capture, key, "5m") if point["intervalSeconds"] == 10 and row[3] // (seconds * 1000) * seconds * 1000 == bucket]
            require(all(row[3] > boundary for row in raw), "Restored tier replays saved raw readings")
            expected = merge_rows([old, *raw])
            summaries = {row[3] // (seconds * 1000) * seconds * 1000: row for _, row in indexed_points(capture, key, range_name)}
            require(bucket in summaries, "Saved tier summary is absent after restart")
            rows_equal(summaries[bucket], expected, "Exact saved tier plus distinct post-restart readings")
            tier_checks[str(seconds)] += 1
    require(all(tier_checks.values()), "Restart did not compare every saved summary tier")
    return {"savedPartialDeviceRowsCompared": compared, "sameMinuteMergesExercised": merged, "savedRowsRetainedUnchanged": unchanged, "distinctNextMinuteRawRows": new_rows, "savedTierRowsCompared": tier_checks, "savedThrough": boundary, "noDoubleCounting": True}


def release_inputs(args):
    pins = parse_json(read_private(args.release, 65536))
    require(pins.get("tag") == TAG and pins.get("commit") == COMMIT and pins.get("readOnly") is True, "Reviewed beta45 release/source pin required")
    require(isinstance(pins.get("image"), str) and re.fullmatch(r"ghcr\.io/twentylines/orbis@sha256:[a-f0-9]{64}", pins["image"]), "Reviewed immutable image pin required")
    require(pins["image"].split("@", 1)[1] == args.digest and set(pins.get("platforms", [])) == {"linux/amd64", "linux/arm64"}, "Digest or published platforms differ")
    proof = parse_json(read_private(args.helper_pins, 1024 * 1024))
    require(proof.get("passed") is True and proof.get("installedHelperVerified") is True, "Reviewed installed helper proof required")
    hashes = proof.get("sourceSha256")
    require(isinstance(hashes, dict) and set(hashes) == set(MODULES) and all(isinstance(value, str) and SHA.fullmatch(value) for value in hashes.values()), "Two installed helper source pins required")
    return pins, hashes


def self_check():
    dummy = {"image": "ghcr.io/twentylines/orbis@sha256:" + "a" * 64}
    for mode in ("checkpoint", "stopped-checkpoint", "after-restart"):
        compile(guest_program(dummy, mode, {name: "b" * 64 for name in MODULES}), "<generated-guest>", "exec")
    row = [1, "sda", "c" * 64, 60000, 80000, 3, 8, 12, 3, 4, 6, 3, 0, 0, 0]
    record = [1, 60, 60000, 60000, 80000, 3, 0, [row]]
    require(validate_records([record], 100000)[(60, 60000)] == record, "Offline codec acceptance failed")
    rejected = 0
    for index, replacement in ((5, 12), (4, 60000), (7, [row + ["private-extra"]])):
        invalid = list(record)
        invalid[index] = replacement
        try:
            validate_records([invalid], 100000)
        except AssertionError:
            rejected += 1
    require(rejected == 3, "Offline malformed codec rejection failed")
    rows_equal(merge_rows([[1, "sda", "c" * 64, 60000, 60000, 1, 4, 4, 1, 2, 2, 1, 0, 0, 0], [1, "sda", "c" * 64, 70000, 70000, 1, 12, 12, 1, 6, 6, 1, 0, 0, 0]]), [1, "sda", "c" * 64, 60000, 70000, 2, 8, 12, 2, 4, 6, 2, 0, 0, 0], "Offline independent means")
    def iso(stamp):
        return dt.datetime.fromtimestamp(stamp / 1000, tz=dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    def point(values, seconds):
        result = {"at": iso(values[3]), "until": iso(values[4]), "samples": values[5], "sourceId": values[2], "intervalSeconds": seconds}
        for index, field in enumerate(FIELDS):
            average, peak, count = values[6 + index * 3:9 + index * 3]
            result[field] = {"average": average if count else None, "peak": peak if count else None, "samples": count}
        return result
    new_rows = [[1, "sda", "c" * 64, stamp, stamp, 1, value, value, 1, value / 2, value / 2, 1, 0, 0, 0] for stamp, value in [(90000, 16), (100000, 20)]]
    expected = [1, "sda", "c" * 64, 60000, 100000, 5, 12, 20, 5, 6, 10, 5, 0, 0, 0]
    saved = {"capturedAt": 85000, "journal": {"records": [[1, seconds, 60000 if seconds == 60 else 0, 60000, 80000, 3, 0, [row]] for seconds in (60, 300, 1800)]}}
    ranges = {range_name: {"from": iso(0), "points": [point(expected, seconds)]} for range_name, seconds in RANGES.items() if range_name != "5m"}
    ranges["5m"] = {"points": [point(row, 60), *[point(value, 10) for value in new_rows]]}
    capture = {"lastSampleAt": iso(100000), "devices": {"disk:sda": ranges}}
    continuation = restart_arithmetic(saved, capture)
    require(continuation["sameMinuteMergesExercised"] == 1 and continuation["savedTierRowsCompared"] == {"60": 1, "300": 1, "1800": 1}, "Offline partial continuation acceptance failed")
    ranges["1h"]["points"][0]["samples"] += 1
    try:
        restart_arithmetic(saved, capture)
    except AssertionError:
        duplicate_rejected = True
    else:
        duplicate_rejected = False
    require(duplicate_rejected, "Offline duplicated restart count was accepted")
    return {"passed": True, "offlineOnly": True, "generatedGuestProgramsCompiled": 3, "malformedRecordsRejected": rejected, "measuredArithmetic": True, "threeTierPartialContinuation": True, "duplicatedRestartCountRejected": True, "runtimeCalls": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("checkpoint", "stopped-checkpoint", "after-restart"), nargs="?")
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--allow-owned-runtime-probe", action="store_true")
    parser.add_argument("--confirm-no-browser-clients", action="store_true", help="Operator confirms owned test browsers are closed; does not claim global browser absence")
    parser.add_argument("--release", type=Path)
    parser.add_argument("--digest")
    parser.add_argument("--helper-pins", type=Path)
    parser.add_argument("--cookies", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--checkpoint", type=Path, help="Exact stopped-checkpoint report for after-restart")
    parser.add_argument("--seconds", type=int, default=130, help="Quiet checkpoint interval,130..240 seconds")
    args = parser.parse_args()
    if args.self_check:
        require(args.mode is None, "Offline self-check must not select a runtime mode")
        print(json.dumps(self_check()))
        return
    require(args.mode is not None and args.allow_owned_runtime_probe and args.confirm_no_browser_clients, "Explicit owned-runtime and operator no-browser opt-ins required")
    require(args.release and args.digest and args.helper_pins and args.output, "Reviewed release, digest, helper pins and private output required")
    private_path(args.output, existing=False)
    require(not args.output.exists(), "Output must be fresh")
    require(130 <= args.seconds <= 240, "Quiet interval must be130..240 seconds")
    require(args.mode == "stopped-checkpoint" or args.cookies is not None, "Private cookie input required")
    require(args.mode != "after-restart" or args.checkpoint is not None, "After-restart requires an exact stopped checkpoint")
    os.umask(0o077)
    pins, hashes = release_inputs(args)
    result = {"passed": False, "mode": args.mode, "readOnly": True, "tag": TAG, "commit": COMMIT, "image": pins["image"], "macDockerContext": CONTEXT, "guestDockerContext": "default", "operatorConfirmedOwnedBrowsersClosed": True, "browserAbsenceBoundary": "Operator assertion for owned clients only; this script launches no browser and cannot exclude unrelated clients.", "startedAt": int(time.time() * 1000)}
    stage = "initial-snapshot"
    try:
        first = snapshot(pins, args.mode, hashes)
        result["initial"] = first
        if args.mode == "stopped-checkpoint":
            result["exactSavedWitness"] = True
            result["noGuestMutation"] = True
        else:
            api = Api(args.cookies)
            keys = sorted(item["kind"] + ":" + item["name"] for item in first["helper"]["devices"])
            stage = "api-auth-validation"
            result["httpChecks"] = auth_and_validation(api, pins)
            if args.mode == "checkpoint":
                stage = "initial-api"
                before = capture_api(api, keys)
                result["before"] = before
                stage = "quiet-no-probe-reads"
                reads_before, began = api.reads, time.monotonic()
                # Deliberately no API, helper, Docker, browser or journal reads here.
                time.sleep(args.seconds)
                result["quiet"] = {"elapsedSeconds": time.monotonic() - began, "probeApiReads": api.reads - reads_before, "probeGuestReads": 0, "probeBrowsersLaunched": 0}
                stage = "post-quiet-api"
                after = capture_api(api, keys)
                final = snapshot(pins, args.mode, hashes)
                require(first["core"] == final["core"], "Core restarted or changed during quiet observation")
                require(milliseconds(after["lastSampleAt"]) - milliseconds(before["lastSampleAt"]) >= 100000, "Background history did not advance without probe reads")
                stage = "measured-quiet-arithmetic"
                result["rawDeviceMinuteAggregatesCompared"] = quiet_arithmetic(before, after, final)
                result["backgroundCadence"] = quiet_cadence(before, after)
            else:
                stage = "read-exact-stopped-checkpoint"
                saved = parse_json(read_private(args.checkpoint))
                require(saved.get("passed") is True and saved.get("mode") == "stopped-checkpoint" and saved.get("exactSavedWitness") is True and saved.get("image") == pins["image"] and saved.get("commit") == COMMIT, "Exact reviewed stopped checkpoint required")
                stopped = saved["initial"]
                require(stopped["core"]["running"] is False and first["core"]["id"] == stopped["core"]["id"] and first["core"]["imageId"] == stopped["core"]["imageId"] and first["core"]["startedAt"] != stopped["core"]["startedAt"], "Expected same-container same-image restart")
                require(milliseconds(first["core"]["startedAt"]) > stopped["capturedAt"] - 1000, "Core restart predates stopped witness")
                latest_saved = validate_records(stopped["journal"]["records"], stopped["capturedAt"])
                saved_through = max(record[4] for record in latest_saved.values())
                require(int(time.time() * 1000) - saved_through < 240000, "Stopped partial witness is too old for exact5m comparison")
                keys = sorted(set(keys) | {(('network' if row[0] == 0 else 'disk') + ':' + row[1]) for record in latest_saved.values() for row in record[7]})
                stage = "post-restart-actual-samples"
                deadline = time.monotonic() + 35
                while True:
                    after = capture_api(api, keys)
                    if milliseconds(after["lastSampleAt"]) > saved_through and all(any(point["intervalSeconds"] == 10 for point in after["devices"][key]["5m"]["points"]) for key in [item["kind"] + ":" + item["name"] for item in first["helper"]["devices"]]):
                        break
                    require(time.monotonic() < deadline, "No fresh post-restart raw history within35 seconds")
                    time.sleep(2)
                final = snapshot(pins, args.mode, hashes)
                require(first["core"] == final["core"], "Core changed during after-restart inspection")
                stage = "exact-restart-arithmetic"
                result["restartContinuity"] = restart_arithmetic(stopped, after)
                result["stoppedCheckpointSha256"] = hashlib.sha256(read_private(args.checkpoint)).hexdigest()
            result["after"], result["final"] = after, final
            stage = "saved-api-summary-and-current-identity"
            result["savedApiSummariesCompared"] = journal_matches(after, final)
            result["independentCurrentKernelGenerationsMatched"] = current_identities(after, final)
            result["observations"] = observe_patterns(after)
            result["apiReadCount"] = api.reads
        result["passed"] = True
    except Exception as error:
        # Raw command/API errors can contain credentials, paths or helper identity.
        result["failure"] = {"stage": stage, "type": type(error).__name__, "message": str(error) if isinstance(error, AssertionError) else "Read-only probe failed; underlying details withheld"}
    result["finishedAt"] = int(time.time() * 1000)
    write_private(args.output, result)
    print(json.dumps({key: result[key] for key in ("passed", "mode", "tag", "commit", "readOnly")} | {"report": str(args.output), "failure": result.get("failure")}))
    require(result["passed"], "Runtime proof failed; inspect the private report")


if __name__ == "__main__":
    try:
        main()
    except Exception as failure:
        print(json.dumps({"passed": False, "error": str(failure) if isinstance(failure, AssertionError) else "Input or read-only probe error; details withheld", "type": type(failure).__name__}), file=sys.stderr)
        sys.exit(1)
