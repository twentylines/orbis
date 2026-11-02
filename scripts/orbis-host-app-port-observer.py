#!/usr/bin/env python3
"""Bounded Linux proc socket snapshot and narrowly proved retiring proxy owners.

Production MUST use fixed /proc and UID0 from an independently admitted native
root service. Equal self/PID1 netns evidence alone cannot prove host provenance
inside an isolated proc mount. Injected proc_root/owner_uid are test-only code
hooks, never request JSON. No execution, binds, daemon calls or process writes.
"""
import copy
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import sys
import time


SPEC = importlib.util.spec_from_file_location('orbis_app_observer_compiler', Path(__file__).with_name('orbis-host-app-create-intent.py'))
COMPILER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COMPILER)
HEX = re.compile(r'[a-f0-9]{64}')
DECIMAL = re.compile(r'0|[1-9][0-9]*')
TABLES = (('tcp', 4), ('tcp6', 6), ('udp', 4), ('udp6', 6))
PROXY_BINARIES = {'/usr/bin/docker-proxy', '/usr/lib/docker-proxy', '/usr/libexec/docker/docker-proxy', '/usr/libexec/docker-proxy'}
MAX_BYTES = 32 * 1024 * 1024
MAX_TABLE_BYTES = 4 * 1024 * 1024
MAX_ROWS = 65536
MAX_PIDS = 4096
MAX_PROC_ENTRIES = 8192
MAX_FDS = 65536
MAX_PID_FDS = 4096


def fail(reason):
    return ValueError('Root app port observation refused: ' + reason)


class LimitError(ValueError): pass


def canonical(value):
    COMPILER._bounded(value)
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def digest(value): return hashlib.sha256(canonical(value)).hexdigest()


def address(value):
    if not isinstance(value, str) or not value or '%' in value or '[' in value or ']' in value: raise fail('invalid address')
    try: parsed = ipaddress.ip_address(value)
    except ValueError as error: raise fail('invalid address') from error
    if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped is not None: parsed = parsed.ipv4_mapped
    return str(parsed)


def number(value, maximum=9007199254740991, *, positive=False):
    if not isinstance(value, str) or DECIMAL.fullmatch(value) is None or len(value) > 20: raise fail('invalid decimal field')
    result = int(value)
    if not (1 if positive else 0) <= result <= maximum: raise fail('decimal field out of range')
    return result


def identity(details):
    return (details.st_dev, details.st_ino, details.st_uid, stat.S_IFMT(details.st_mode))


def combine_port_observations(proc, diag):
    """Union fresh code-owned observations; this grants no allocator exemption."""
    try:
        if (not isinstance(proc, dict) or set(proc) != {'observation', 'ownership'}
                or not isinstance(diag, dict) or set(diag) != {'version', 'complete', 'tcpBoundInactive', 'sockets', 'namespace', 'selfProof', 'reason', 'evidenceSha256'}
                or type(diag['version']) is not int or diag['version'] != 1 or diag['complete'] is not True
                or diag['tcpBoundInactive'] is not True or diag['reason'] != 'ok'):
            raise fail('complete native bound-inactive proof required')
        # The diagnostic result contains only ASCII kernel identities and IPs.
        unhashed = {key: value for key, value in diag.items() if key != 'evidenceSha256'}
        wire = json.dumps(unhashed, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
        if hashlib.sha256(wire).hexdigest() != diag['evidenceSha256']: raise fail('diagnostic evidence changed')
        observation, ownership, namespace = proc['observation'], proc['ownership'], diag['namespace']
        if (not isinstance(observation, dict) or set(observation) != {'complete', 'namespace', 'protocols', 'sockets'}
                or observation['complete'] is not True or observation['namespace'] != 'host' or observation['protocols'] != ['tcp', 'udp']
                or not isinstance(ownership, dict) or ownership.get('version') != 1
                or ownership.get('ownershipSha256') != digest({key: value for key, value in ownership.items() if key != 'ownershipSha256'})
                or not isinstance(namespace, dict) or set(namespace) != {'self', '1'}
                or namespace['self'] != namespace['1'] or namespace['self'] != ownership.get('namespace')):
            raise fail('collector namespaces or ownership changed')
        current_namespace = namespace['self']
        if (not isinstance(current_namespace, dict) or set(current_namespace) != {'device', 'inode', 'link'}
                or type(current_namespace['device']) is not int or current_namespace['device'] < 0
                or type(current_namespace['inode']) is not int or current_namespace['inode'] <= 0
                or current_namespace['link'] != 'net:[' + str(current_namespace['inode']) + ']'):
            raise fail('invalid host namespace')
        proof = diag['selfProof']
        if not isinstance(proof, dict) or set(proof) != {'families', 'closed'} or proof['closed'] is not True:
            raise fail('diagnostic resources did not close')
        families = proof['families']
        if not isinstance(families, list) or len(families) != 2: raise fail('both family proofs required')
        own = set()
        for item, family, loopback in zip(families, (2, 10), ('127.0.0.1', '::1'), strict=True):
            if (not isinstance(item, dict) or set(item) != {'family', 'address', 'port', 'inode', 'uid', 'requestedState', 'state'}
                    or type(item['family']) is not int or item['family'] != family or item['address'] != loopback
                    or type(item['port']) is not int or not 1 <= item['port'] <= 65535
                    or type(item['inode']) is not int or not 0 < item['inode'] <= 0xffffffff or item['inode'] in own
                    or type(item['uid']) is not int or item['uid'] != 0 or type(item['requestedState']) is not int or item['requestedState'] != 13
                    or type(item['state']) is not int or item['state'] not in (7, 13)):
                raise fail('bound-inactive family proof changed')
            own.add(item['inode'])
        rows, by_inode, by_tuple = [], {}, {}
        for index, values in enumerate((observation['sockets'], diag['sockets'])):
            if not isinstance(values, list) or len(values) > MAX_ROWS: raise fail('socket union bound')
            local_inodes = set()
            for raw in values:
                if (not isinstance(raw, dict) or set(raw) != {'protocol', 'address', 'port', 'inode', 'v6only'}
                        or raw['protocol'] not in ({'tcp'} if index else {'tcp', 'udp'})
                        or type(raw['port']) is not int or not 1 <= raw['port'] <= 65535
                        or type(raw['inode']) is not int or not 0 <= raw['inode'] <= 9007199254740991
                        or raw['v6only'] is not None and type(raw['v6only']) is not bool): raise fail('invalid socket union row')
                if raw['inode'] > 0:
                    if raw['inode'] in local_inodes: raise fail('duplicate positive inode inside collector')
                    local_inodes.add(raw['inode'])
                row = copy.deepcopy(raw); row['address'] = address(row['address'])
                if ipaddress.ip_address(row['address']).version == 4 and row['v6only'] is not None: raise fail('IPv4 v6-only conflict')
                if row['inode'] in own: raise fail('closed diagnostic probe leaked into occupancy')
                key = (row['protocol'], row['address'], row['port'], row['inode'])
                if row['inode'] > 0:
                    previous = by_inode.get(row['inode'])
                    if previous is not None and previous != key: raise fail('socket inode changed between collectors')
                    by_inode[row['inode']] = key
                previous = by_tuple.get(key)
                if previous is not None:
                    left, right = previous['v6only'], row['v6only']
                    if left is not None and right is not None and left != right: raise fail('v6-only evidence conflict')
                    # Unknown on either side stays conservative and preserves
                    # exact proc ownership evidence instead of widening it.
                    previous['v6only'] = left if left == right else None
                else:
                    by_tuple[key] = row; rows.append(row)
                if len(rows) > MAX_ROWS: raise fail('socket union bound')
        result = {'complete': True, 'namespace': 'host', 'protocols': ['tcp', 'udp'],
                  'sockets': sorted(rows, key=lambda item: (item['protocol'], item['address'], item['port'], item['inode']))}
        canonical(result)
        return result
    except (KeyError, TypeError, AttributeError, OverflowError) as error:
        raise fail('invalid native observation union') from error


class ProcPortObserver:
    def __init__(self, *, deadline, proc_root='/proc', owner_uid=0):
        now = time.time()
        if type(deadline) is not int or not now < deadline <= now + 30: raise fail('fresh integer deadline of at most30seconds required')
        if type(owner_uid) is not int or owner_uid < 0: raise fail('invalid owner policy')
        self.root = Path(proc_root)
        if not self.root.is_absolute(): raise fail('absolute proc root required')
        if self.root == Path('/proc') and (owner_uid != 0 or sys.platform != 'linux' or os.geteuid() != 0): raise fail('native root Linux proc required')
        self.deadline, self.owner_uid = deadline, owner_uid
        self._monotonic_deadline = time.monotonic() + min(30, deadline - now)
        self.bytes = 0
        self._ownership_bytes = self._observation_bytes = None

    def _check(self):
        if time.time() >= self.deadline or time.monotonic() >= self._monotonic_deadline: raise LimitError('Root app port observation deadline expired')

    def _read(self, path, maximum, *, directory=None):
        self._check()
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode): raise fail('nonregular proc record')
            chunks, count = [], 0
            while True:
                self._check()
                chunk = os.read(descriptor, min(65536, maximum + 1 - count))
                if not chunk: break
                count += len(chunk); self.bytes += len(chunk)
                if count > maximum or self.bytes > MAX_BYTES: raise LimitError('Root app port observation byte bound exceeded')
                chunks.append(chunk)
            if identity(before) != identity(os.fstat(descriptor)): raise fail('proc record identity changed')
            self._check()
            return b''.join(chunks), before
        finally: os.close(descriptor)

    def _link(self, path, *, directory=None):
        self._check()
        target = os.readlink(path, dir_fd=directory)
        size = len(os.fsencode(target)); self.bytes += size
        if size > 4096 or self.bytes > MAX_BYTES: raise LimitError('Root app port observation link byte bound exceeded')
        self._check()
        return target

    def _namespace(self, path):
        self._check()
        first = os.lstat(path)
        if not stat.S_ISLNK(first.st_mode) or first.st_uid != self.owner_uid: raise fail('namespace link owner invalid')
        target = self._link(path)
        match = re.fullmatch(r'net:\[([1-9][0-9]{0,19})\]', target)
        if match is None: raise fail('namespace link invalid')
        resolved = os.stat(path)
        if resolved.st_ino != int(match[1]) or resolved.st_uid != self.owner_uid: raise fail('namespace inode mismatch')
        if identity(first) != identity(os.lstat(path)) or self._link(path) != target: raise fail('namespace link changed')
        self._check()
        return {'device': resolved.st_dev, 'inode': resolved.st_ino, 'link': target}

    def _host_namespace(self):
        own = self._namespace(self.root / 'self/ns/net')
        initial = self._namespace(self.root / '1/ns/net')
        if own != initial: raise fail('collector is outside PID1 network namespace')
        return own

    @staticmethod
    def _hex_endpoint(value, family):
        length = 8 if family == 4 else 32
        if not isinstance(value, str) or re.fullmatch('[0-9A-Fa-f]{' + str(length) + '}:[0-9A-Fa-f]{4}', value) is None:
            raise fail('invalid proc endpoint')
        raw, port = value.split(':')
        packed = b''.join(int(raw[index:index + 8], 16).to_bytes(4, sys.byteorder) for index in range(0, length, 8))
        return address(str(ipaddress.ip_address(packed))), int(port, 16)

    def _tables(self):
        result, positives, total = [], set(), 0
        for table, family in TABLES:
            data, details = self._read(self.root / 'net' / table, MAX_TABLE_BYTES)
            if details.st_uid != self.owner_uid or not data.endswith(b'\n'): raise fail('incomplete socket table')
            try: lines = data.decode('ascii').splitlines()
            except UnicodeError as error: raise fail('nonascii socket table') from error
            expected = ['sl', 'local_address', 'rem_address', 'st', 'tx_queue', 'rx_queue', 'tr', 'tm->when', 'retrnsmt', 'uid', 'timeout', 'inode']
            if not lines: raise fail('missing socket table header')
            header = lines[0].split()
            if len(header) >= 3 and header[2] == 'remote_address': header[2] = 'rem_address'
            if header[:12] != expected or header[12:] not in ([], ['ref', 'pointer', 'drops']): raise fail('unknown socket table header')
            indices = set()
            for line in lines[1:]:
                self._check(); total += 1
                if total > MAX_ROWS or len(line) > 1024: raise LimitError('Root app port observation row bound exceeded')
                fields = line.split()
                if not 10 <= len(fields) <= 24 or re.fullmatch(r'(?:0|[1-9][0-9]{0,9}):', fields[0]) is None:
                    raise fail('invalid socket table row')
                index = int(fields[0][:-1])
                if index in indices: raise fail('duplicate socket table row')
                indices.add(index)
                local, port = self._hex_endpoint(fields[1], family)
                self._hex_endpoint(fields[2], family)
                if re.fullmatch(r'[0-9A-Fa-f]{2}', fields[3]) is None: raise fail('invalid socket state')
                state = int(fields[3], 16)
                if state not in (set(range(1, 14)) if table.startswith('tcp') else {1, 7}): raise fail('unsupported socket state')
                if (re.fullmatch(r'[0-9A-Fa-f]{8}:[0-9A-Fa-f]{8}', fields[4]) is None
                        or re.fullmatch(r'[0-9A-Fa-f]{2}:[0-9A-Fa-f]{8}', fields[5]) is None
                        or re.fullmatch(r'[0-9A-Fa-f]{8}', fields[6]) is None): raise fail('invalid socket counters')
                number(fields[7], 4294967295); number(fields[8], 18446744073709551615)
                inode = number(fields[9])
                for tail_index, value in enumerate(fields[10:], 10):
                    pattern = r'[0-9A-Fa-f]{1,16}' if tail_index == 11 else r'-?[0-9]{1,20}'
                    if re.fullmatch(pattern, value) is None: raise fail('unknown socket row tail')
                if port == 0: continue
                if inode > 0:
                    if inode in positives: raise fail('duplicate positive socket inode')
                    positives.add(inode)
                result.append({'protocol': 'tcp' if table.startswith('tcp') else 'udp', 'address': local,
                               'port': port, 'inode': inode, 'v6only': None})
        return sorted(result, key=lambda row: (row['protocol'], row['address'], row['port'], row['inode']))

    def _pids(self):
        self._check()
        names, total = [], 0
        with os.scandir(self.root) as entries:
            for entry in entries:
                self._check(); total += 1
                if total > MAX_PROC_ENTRIES: raise LimitError('Root app port observation directory bound exceeded')
                if not entry.name.isascii() or not entry.name.isdecimal(): continue
                number(entry.name, 2147483647, positive=True)
                names.append(entry.name)
                if len(names) > MAX_PIDS: raise LimitError('Root app port observation PID bound exceeded')
        return sorted(names, key=int)

    def _process_meta(self, descriptor, pid, details):
        raw_stat, stat_details = self._read('stat', 8192, directory=descriptor)
        status, status_details = self._read('status', 65536, directory=descriptor)
        try:
            prefix, tail = raw_stat.rstrip(b'\n').rsplit(b') ', 1)
            before, comm = prefix.split(b' (', 1)
            values = tail.decode('ascii').split()
            if (number(before.decode('ascii'), 2147483647, positive=True) != int(pid) or not 20 <= len(values) <= 100
                    or values[0] not in set('RSDZTWtXxKIP')
                    or any(re.fullmatch(r'-?[0-9]{1,20}', value) is None for value in values[1:])): raise fail('invalid PID stat')
            started = number(values[19], positive=True)
            uid_lines = [line.decode('ascii') for line in status.splitlines() if line.startswith(b'Uid:')]
            if len(uid_lines) != 1 or len(uid_lines[0].split()) != 5: raise fail('invalid PID UID record')
            uids = [number(value, 4294967295) for value in uid_lines[0].split()[1:]]
        except (UnicodeError, ValueError) as error: raise fail('unproven PID metadata') from error
        eligible = details.st_uid == self.owner_uid and uids == [self.owner_uid] * 4
        eligible = eligible and stat_details.st_uid == self.owner_uid and status_details.st_uid == self.owner_uid
        cmdline = None
        if eligible and comm == b'docker-proxy':
            cmdline, command_details = self._read('cmdline', 4096, directory=descriptor)
            if command_details.st_uid != self.owner_uid: eligible = False
        return {'pid': int(pid), 'starttime': started, 'uids': uids, 'comm': comm,
                'eligible': eligible, 'cmdline': cmdline}

    def _fd_links(self, pid_descriptor, interesting, counter):
        self._check()
        descriptor = os.open('fd', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=pid_descriptor)
        try:
            names = []
            with os.scandir(descriptor) as entries:
                for entry in entries:
                    self._check(); names.append(entry.name)
                    if len(names) > MAX_PID_FDS: raise LimitError('Root app port observation per-PID FD bound exceeded')
            result = []
            for name in sorted(names):
                self._check(); number(name, 2147483647)
                counter[0] += 1
                if counter[0] > MAX_FDS: raise LimitError('Root app port observation FD bound exceeded')
                before = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                if not stat.S_ISLNK(before.st_mode): raise fail('unproven FD link')
                target = self._link(name, directory=descriptor)
                matched = re.fullmatch(r'socket:\[([1-9][0-9]{0,19})\]', target)
                if matched and int(matched[1]) in interesting:
                    if identity(before) != identity(os.stat(name, dir_fd=descriptor, follow_symlinks=False)):
                        raise fail('FD link changed')
                    result.append({'fd': int(name), 'inode': int(matched[1]), 'uid': before.st_uid,
                                   'linkInode': before.st_ino, 'linkDevice': before.st_dev})
            return sorted(result, key=lambda entry: entry['fd'])
        finally: os.close(descriptor)

    @staticmethod
    def _proxy(cmdline):
        if cmdline is None or not cmdline.endswith(b'\0'): return None
        try: argv = cmdline[:-1].decode('ascii').split('\0')
        except UnicodeError: return None
        if len(argv) != 11 or argv[0] not in PROXY_BINARIES: return None
        fields = {}
        for index in range(1, len(argv), 2):
            flag, value = argv[index:index + 2]
            if flag not in {'-proto', '-host-ip', '-host-port', '-container-ip', '-container-port'} or flag in fields: return None
            fields[flag] = value
        if len(fields) != 5 or fields['-proto'] not in {'tcp', 'udp'}: return None
        try:
            return {'binary': argv[0], 'protocol': fields['-proto'], 'hostIp': address(fields['-host-ip']),
                    'hostPort': number(fields['-host-port'], 65535, positive=True),
                    'containerIp': address(fields['-container-ip']),
                    'containerPort': number(fields['-container-port'], 65535, positive=True)}
        except ValueError: return None

    def _processes(self, interesting, host_namespace):
        owners, proxies, complete, counter = {}, {}, True, [0]
        pids = self._pids()
        for pid in pids:
            self._check()
            descriptor = None
            try:
                descriptor = os.open(self.root / pid, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                before = os.fstat(descriptor)
                first = self._process_meta(descriptor, pid, before)
                links = self._fd_links(descriptor, interesting, counter)
                proxy = self._proxy(first['cmdline']) if first['eligible'] else None
                namespace = self._namespace(self.root / pid / 'ns/net') if proxy else None
                second = self._process_meta(descriptor, pid, os.fstat(descriptor))
                second_links = self._fd_links(descriptor, interesting, counter)
                if (first != second or links != second_links or identity(before) != identity(os.fstat(descriptor))
                        or identity(before) != identity(os.stat(self.root / pid, follow_symlinks=False))):
                    raise fail('PID ownership changed')
                if proxy and (namespace != host_namespace or self._namespace(self.root / pid / 'ns/net') != namespace):
                    raise fail('proxy namespace changed')
                for link in links: owners.setdefault(link['inode'], set()).add(int(pid))
                if proxy and all(link['uid'] == self.owner_uid for link in links):
                    proxies[int(pid)] = {'pid': int(pid), 'starttime': first['starttime'], 'uid': self.owner_uid,
                                         'cmdlineSha256': hashlib.sha256(first['cmdline']).hexdigest(),
                                         'proxy': proxy, 'fds': links}
            except LimitError: raise
            except (OSError, ValueError): complete = False
            finally:
                if descriptor is not None: os.close(descriptor)
        if self._pids() != pids: complete = False
        return owners, proxies, complete

    def _retirements(self, containers):
        COMPILER._bounded(containers)
        if not isinstance(containers, list) or len(containers) > 4096: raise fail('invalid retirement snapshots')
        snapshots, candidates = {}, []
        for raw in containers:
            self._check()
            if (not isinstance(raw, dict) or not isinstance(raw.get('Id'), str) or HEX.fullmatch(raw['Id']) is None
                    or raw['Id'] in snapshots or not isinstance(raw.get('NetworkSettings'), dict)
                    or not {'Networks', 'Ports'} <= set(raw['NetworkSettings'])
                    or not isinstance(raw['NetworkSettings']['Networks'], dict)):
                raise fail('incomplete retirement snapshot')
            snapshots[raw['Id']] = digest(raw)
            bindings = COMPILER._ports(raw['NetworkSettings']['Ports'], assigned=True)
            endpoints = []
            for name, endpoint in raw['NetworkSettings']['Networks'].items():
                if not isinstance(name, str) or not isinstance(endpoint, dict): raise fail('invalid approved endpoint')
                network_id = endpoint.get('NetworkID')
                for field, family in (('IPAddress', 4), ('GlobalIPv6Address', 6)):
                    value = endpoint.get(field)
                    if not value: continue
                    parsed = address(value)
                    if (not isinstance(network_id, str) or HEX.fullmatch(network_id) is None
                            or ipaddress.ip_address(parsed).version != family or ipaddress.ip_address(parsed).is_unspecified):
                        raise fail('unproven approved endpoint identity')
                    endpoints.append({'name': name, 'networkId': network_id, 'containerIp': parsed})
            for exposed, rows in bindings.items():
                internal, protocol = exposed.split('/')
                if protocol not in {'tcp', 'udp'}: continue
                for host, port in rows or []:
                    binding = {'containerId': raw['Id'], 'containerPort': exposed, 'protocol': protocol,
                               'address': address(host), 'port': int(port)}
                    for endpoint in endpoints:
                        self._check()
                        if len(candidates) >= 65536: raise fail('retirement candidate bound exceeded')
                        candidates.append({'containerId': raw['Id'], 'snapshotSha256': snapshots[raw['Id']],
                                           'binding': binding, 'network': endpoint, 'internalPort': int(internal)})
            if len(candidates) > 65536: raise fail('retirement candidate bound exceeded')
        return snapshots, candidates

    def observe(self, retiring_containers):
        """Read all four tables twice and stable PID/FD evidence within deadline.

        Process ambiguity yields no ownership exemptions. Kernel table/namespace
        ambiguity fails the entire observation. All bound nonzero local ports
        and states, including inode0 TIME_WAIT, remain conflicts. v6only is None.
        complete means every mandated proc table was read, not absence of every
        possible kernel binding: bound-inactive TCP requires inet_diag coverage.
        ownership.coverage.tcpBoundInactive is therefore always False. Root MUST
        refuse published-host-port plans before COMMIT until independent coverage
        exists. No-port plans and this snapshot do not imply universal absence.
        This observation is never an atomic reservation.
        """
        self._ownership_bytes = self._observation_bytes = None
        self._check(); snapshots, candidates = self._retirements(retiring_containers)
        root_details = os.stat(self.root, follow_symlinks=False)
        if (not stat.S_ISDIR(root_details.st_mode) or root_details.st_uid != self.owner_uid
                or self.root != self.root.resolve(strict=True)): raise fail('untrusted proc root')
        namespace = self._host_namespace()
        sockets = self._tables()
        owners, proxies, complete = self._processes({row['inode'] for row in sockets if row['inode'] > 0}, namespace)
        if self._tables() != sockets or self._host_namespace() != namespace: raise fail('socket or namespace snapshot changed')
        if identity(root_details) != identity(os.stat(self.root, follow_symlinks=False)): raise fail('proc root changed')
        entries, approved_by_tuple = [], {}
        for candidate in candidates:
            self._check()
            key = (candidate['binding']['protocol'], candidate['binding']['address'], candidate['binding']['port'],
                   candidate['network']['containerIp'], candidate['internalPort'])
            approved_by_tuple.setdefault(key, []).append(candidate)
        if complete:
            for socket in sockets:
                self._check()
                inode = socket['inode']
                holders = owners.get(inode, set()) if inode > 0 else set()
                if len(holders) != 1: continue
                process = proxies.get(next(iter(holders)))
                if process is None: continue
                proxy = process['proxy']
                if (proxy['protocol'] != socket['protocol'] or proxy['hostIp'] != socket['address']
                        or proxy['hostPort'] != socket['port']): continue
                approved = approved_by_tuple.get((proxy['protocol'], proxy['hostIp'], proxy['hostPort'], proxy['containerIp'], proxy['containerPort']), [])
                if len(approved) != 1: continue
                entry = copy.deepcopy(approved[0]); entry.pop('internalPort')
                proof_process = copy.deepcopy(process)
                proof_process['fds'] = [item for item in proof_process['fds'] if item['inode'] == inode]
                entry.update(socket=copy.deepcopy(socket), process=proof_process)
                entries.append(entry)
        observation = {'complete': True, 'namespace': 'host', 'protocols': ['tcp', 'udp'], 'sockets': sockets}
        ownership = {'version': 1, 'namespace': namespace, 'processScanComplete': complete,
                     'retirementSnapshots': snapshots, 'entries': entries, 'coverage': {'tcpBoundInactive': False}}
        ownership['ownershipSha256'] = digest(ownership)
        self._check()
        self._observation_bytes, self._ownership_bytes = canonical(observation), canonical(ownership)
        return {'observation': json.loads(self._observation_bytes), 'ownership': json.loads(self._ownership_bytes)}

    def prove_host_socket_owner(self, socket, current_container, binding):
        """Pure callback over byte-backed captured evidence; never reads proc.

        Root must collect a fresh observation immediately precommit/beforestart.
        Expired evidence, inode0, arbitrary/changed current snapshots and private
        returned-result mutation never create an ownership exemption.
        """
        try:
            self._check()
            if self._ownership_bytes is None or type(socket.get('inode')) is not int or socket['inode'] <= 0: return False
            ownership = json.loads(self._ownership_bytes)
            if not ownership['processScanComplete']: return False
            snapshot = digest(current_container)
            result = any(entry['socket'] == socket and entry['binding'] == binding
                         and entry['containerId'] == current_container.get('Id') and entry['snapshotSha256'] == snapshot
                         for entry in ownership['entries'])
            self._check()
            return result
        except (ValueError, TypeError, AttributeError, KeyError): return False
