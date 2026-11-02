#!/usr/bin/env python3
"""Bounded TCP INET_DIAG snapshot with mandatory bound-inactive self-proof.

Default syscalls are native Linux/root only. system injection is trusted test
code, never request JSON. This grants no restore authority or atomic reservation.
"""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import sys
import time

AF_INET, AF_INET6 = 2, 10
SOCK_DIAG_BY_FAMILY, NETLINK_SOCK_DIAG = 20, 4
NLMSG_ERROR, NLMSG_DONE = 2, 3
MULTI, REQUEST_DUMP = 2, 1 | 0x300
STATE_MASK = sum(1 << state for state in range(1, 14))
MAX_DATAGRAM = 262144
MAX_BYTES = 16 * 1024 * 1024
MAX_DATAGRAMS = 2048
MAX_MESSAGES = 65536
MAX_ATTRIBUTES = 64


class Refused(ValueError):
    def __init__(self, reason): self.reason = reason; super().__init__(reason)


def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def _ip(packed):
    result = ipaddress.ip_address(packed)
    if isinstance(result, ipaddress.IPv6Address) and result.ipv4_mapped is not None: result = result.ipv4_mapped
    return str(result)


class LinuxSystem:
    """Fixed native syscall boundary. Do not expose injection through a caller."""
    def effective_uid(self): return os.geteuid()

    def namespace(self):
        if sys.platform != 'linux' or os.geteuid() != 0: raise Refused('unsupported-platform')
        result = {}
        for name in ('self', '1'):
            path = Path('/proc') / name / 'ns/net'
            before = os.lstat(path); link = os.readlink(path); target = os.stat(path)
            if (not stat.S_ISLNK(before.st_mode) or before.st_uid != 0 or target.st_uid != 0
                    or re.fullmatch(r'net:\[[1-9][0-9]{0,19}\]', link) is None
                    or int(link[5:-1]) != target.st_ino or os.readlink(path) != link
                    or (before.st_dev, before.st_ino) != (os.lstat(path).st_dev, os.lstat(path).st_ino)):
                raise Refused('namespace-invalid')
            result[name] = {'device': target.st_dev, 'inode': target.st_ino, 'link': link}
        return result

    def open_netlink(self):
        if sys.platform != 'linux': raise Refused('unsupported-platform')
        return socket.socket(socket.AF_NETLINK, socket.SOCK_RAW | socket.SOCK_CLOEXEC, NETLINK_SOCK_DIAG)

    def open_probe(self, family):
        return socket.socket(family, socket.SOCK_STREAM | socket.SOCK_CLOEXEC, socket.IPPROTO_TCP)

    def socket_identity(self, sock):
        details = os.fstat(sock.fileno())
        if not stat.S_ISSOCK(details.st_mode): raise Refused('probe-invalid')
        return {'inode': details.st_ino, 'uid': details.st_uid}


class InetDiagTcpObserver:
    def __init__(self, *, deadline, system=None):
        now = time.time()
        if type(deadline) is not int or not now < deadline <= now + 30: raise ValueError('fresh integer deadline <=30seconds required')
        self.deadline = deadline
        self.monotonic_deadline = time.monotonic() + min(30, deadline - now)
        self.system = LinuxSystem() if system is None else system
        if any(not callable(getattr(self.system, name, None)) for name in
               ('effective_uid', 'namespace', 'open_netlink', 'open_probe', 'socket_identity')):
            raise ValueError('trusted syscall boundary required')
        self.bytes = self.datagrams = self.messages = 0

    def _check(self):
        remaining = min(self.deadline - time.time(), self.monotonic_deadline - time.monotonic())
        if remaining <= 0: raise Refused('deadline-expired')
        return remaining

    def _namespace(self):
        self._check(); result = self.system.namespace(); self._check()
        if not isinstance(result, dict) or set(result) != {'self', '1'}: raise Refused('namespace-invalid')
        for value in result.values():
            if (not isinstance(value, dict) or set(value) != {'device', 'inode', 'link'}
                    or type(value['device']) is not int or value['device'] < 0
                    or type(value['inode']) is not int or not 0 < value['inode'] <= 9007199254740991
                    or value['link'] != 'net:[' + str(value['inode']) + ']'): raise Refused('namespace-invalid')
        if result['self'] != result['1']: raise Refused('namespace-mismatch')
        return json.loads(canonical(result))

    def _probe_identity(self, sock, family):
        self._check(); result = self.system.socket_identity(sock)
        if (not isinstance(result, dict) or set(result) != {'inode', 'uid'}
                or type(result['inode']) is not int or not 0 < result['inode'] <= 0xffffffff
                or type(result['uid']) is not int or result['uid'] != 0
                or sock.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) != 0): raise Refused('probe-invalid')
        endpoint = sock.getsockname()
        expected = '127.0.0.1' if family == AF_INET else '::1'
        if (not isinstance(endpoint, tuple) or len(endpoint) != (2 if family == AF_INET else 4)
                or endpoint[0] != expected or type(endpoint[1]) is not int or not 1 <= endpoint[1] <= 65535
                or family == AF_INET6 and endpoint[2:] != (0, 0)): raise Refused('probe-invalid')
        if family == AF_INET6 and sock.getsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY) != 1:
            raise Refused('probe-invalid')
        self._check()
        return {'family': family, 'address': expected, 'port': endpoint[1], **result}

    @staticmethod
    def request(family, sequence, port_id, *, states=STATE_MASK):
        if family not in (AF_INET, AF_INET6) or states not in (STATE_MASK, 1 << 13): raise Refused('family-invalid')
        sockid = bytes(40) + struct.pack('=II', 0xffffffff, 0xffffffff)
        body = struct.pack('=BBBBI', family, socket.IPPROTO_TCP, 0, 0, states) + sockid
        return struct.pack('=IHHII', 16 + len(body), SOCK_DIAG_BY_FAMILY, REQUEST_DUMP, sequence, port_id) + body

    def _record(self, payload, family):
        if len(payload) < 72 or payload[0] != family or not 1 <= payload[1] <= 13 or payload[2] > 5:
            raise Refused('record-invalid')
        port, remote_port = struct.unpack_from('!HH', payload, 4)
        src, dst = payload[8:24], payload[24:40]
        if family == AF_INET:
            if src[4:] != bytes(12) or dst[4:] != bytes(12): raise Refused('record-invalid')
            src, dst = src[:4], dst[:4]
        uid, inode = struct.unpack_from('=II', payload, 64)
        v6only, offset, count, kinds = None, 72, 0, set()
        while offset < len(payload):
            if len(payload) - offset < 4: raise Refused('attribute-truncated')
            length, kind = struct.unpack_from('=HH', payload, offset)
            end = offset + length; aligned = offset + ((length + 3) & ~3)
            if length < 4 or end > len(payload) or aligned > len(payload): raise Refused('attribute-truncated')
            count += 1
            if count > MAX_ATTRIBUTES: raise Refused('attribute-bound')
            raw_kind = kind
            if kind & 0xc000 == 0xc000: raise Refused('attribute-invalid')
            kind &= 0x3fff
            if kind == 0 or kind in kinds: raise Refused('attribute-invalid')
            kinds.add(kind)
            if kind == 11:
                if raw_kind != 11 or family != AF_INET6 or length != 5 or payload[offset + 4] not in (0, 1): raise Refused('attribute-invalid')
                v6only = bool(payload[offset + 4])
            offset = aligned
        return {'family': family, 'state': payload[1], 'uid': uid, 'inode': inode,
                'address': _ip(src), 'port': port, 'remoteAddress': _ip(dst), 'remotePort': remote_port,
                'v6only': v6only}

    def _dump(self, netlink, family, sequence, port_id, *, states=STATE_MASK):
        request = self.request(family, sequence, port_id, states=states)
        netlink.settimeout(min(2.0, self._check()))
        if netlink.sendto(request, (0, 0)) != len(request): raise Refused('request-truncated')
        rows, completed = [], False
        while not completed:
            netlink.settimeout(min(2.0, self._check()))
            packet, ancillary, flags, sender = netlink.recvmsg(MAX_DATAGRAM, 0)
            self._check(); self.bytes += len(packet); self.datagrams += 1
            if (flags != 0 or ancillary or sender != (0, 0) or not packet): raise Refused('sender-or-truncation')
            if len(packet) > MAX_DATAGRAM or self.bytes > MAX_BYTES or self.datagrams > MAX_DATAGRAMS: raise Refused('dump-bound')
            offset = 0
            while offset < len(packet):
                self._check(); self.messages += 1
                if self.messages > MAX_MESSAGES: raise Refused('dump-bound')
                if completed or len(packet) - offset < 16: raise Refused('multipart-invalid')
                length, kind, msgflags, seq, sender_id = struct.unpack_from('=IHHII', packet, offset)
                end, aligned = offset + length, offset + ((length + 3) & ~3)
                if length < 16 or end > len(packet) or aligned > len(packet): raise Refused('message-truncated')
                if seq != sequence or sender_id != port_id or msgflags != MULTI: raise Refused('sequence-or-flags')
                payload = packet[offset + 16:end]
                if kind == NLMSG_DONE:
                    if len(payload) != 4 or struct.unpack('=i', payload)[0] != 0: raise Refused('dump-error')
                    completed = True
                elif kind == SOCK_DIAG_BY_FAMILY: rows.append(self._record(payload, family))
                else: raise Refused('netlink-error' if kind == NLMSG_ERROR else 'message-type')
                offset = aligned
        positives = [row['inode'] for row in rows if row['inode'] > 0]
        if len(set(positives)) != len(positives): raise Refused('duplicate-inode')
        return rows

    def observe(self):
        """Return false coverage on ANY unsupported/partial/error observation.

        Both loopback-only ephemeral TCP probes are bound but never listened or
        connected. Exact UID/inode entries are mandatory in each complete family
        dump and a separate state13-only request. The kernel may report these
        underlying bound sockets as TCP_CLOSE7; request selector13 is the proof. Every local resource closes in finally before success.
        """
        resources, probes, proof, rows = [], [], [], []
        result = {'version': 1, 'complete': False, 'tcpBoundInactive': False, 'sockets': [],
                  'namespace': None, 'selfProof': {'families': [], 'closed': False}, 'reason': 'unavailable'}
        try:
            self._check()
            uid = self.system.effective_uid()
            if type(uid) is not int or uid != 0: raise Refused('unsupported-uid')
            namespace = self._namespace()
            for family in (AF_INET, AF_INET6):
                sock = self.system.open_probe(family); resources.append(sock)
                sock.settimeout(min(2.0, self._check()))
                if family == AF_INET6: sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                sock.bind(('127.0.0.1', 0) if family == AF_INET else ('::1', 0, 0, 0))
                info = self._probe_identity(sock, family); probes.append((sock, info))
            if probes[0][1]['inode'] == probes[1][1]['inode']: raise Refused('probe-invalid')
            netlink = self.system.open_netlink(); resources.append(netlink)
            netlink.settimeout(min(2.0, self._check())); netlink.bind((0, 0))
            local = netlink.getsockname()
            if (not isinstance(local, tuple) or len(local) != 2 or local[1] != 0
                    or type(local[0]) is not int or not 0 < local[0] <= 0xffffffff): raise Refused('netlink-local-invalid')
            for sequence, family in enumerate((AF_INET, AF_INET6), 1):
                rows.extend(self._dump(netlink, family, sequence, local[0]))
            seen = set()
            for item in rows:
                if item['inode'] > 0:
                    if item['inode'] in seen: raise Refused('duplicate-inode')
                    seen.add(item['inode'])
            by_inode = {item['inode']: item for item in rows if item['inode'] > 0}
            for sequence, (sock, expected) in enumerate(probes, 3):
                bound_rows = self._dump(netlink, expected['family'], sequence, local[0], states=1 << 13)
                if any(item['state'] not in (7, 13) or item['port'] == 0 for item in bound_rows): raise Refused('bound-selector-invalid')
                if self._probe_identity(sock, expected['family']) != expected: raise Refused('probe-changed')
                matches = [item for item in rows if all(item[key] == expected[key] for key in ('family', 'address', 'port', 'inode', 'uid'))]
                bound_matches = [item for item in bound_rows if all(item[key] == expected[key] for key in ('family', 'address', 'port', 'inode', 'uid'))]
                if (len(matches) != 1 or matches[0]['state'] not in (7, 13) or len(bound_matches) != 1
                        or bound_matches[0]['remotePort'] != 0
                        or not ipaddress.ip_address(bound_matches[0]['remoteAddress']).is_unspecified): raise Refused('bound-inactive-unproven')
                proof.append({**expected, 'requestedState': 13, 'state': bound_matches[0]['state']})
                for item in bound_rows:
                    if item['inode'] > 0 and item['inode'] in by_inode:
                        if item != by_inode[item['inode']]: raise Refused('socket-changed')
                    else:
                        rows.append(item)
                        if item['inode'] > 0: by_inode[item['inode']] = item
            if self._namespace() != namespace: raise Refused('namespace-changed')
            own_inodes = {item['inode'] for item in proof}
            sockets = [{'protocol': 'tcp', **{key: item[key] for key in ('address', 'port', 'inode', 'v6only')}}
                       for item in rows if item['port'] > 0 and item['inode'] not in own_inodes]
            self._check()
            result.update(complete=True, tcpBoundInactive=True, sockets=sockets, namespace=namespace,
                          selfProof={'families': proof, 'closed': False}, reason='ok')
        except Exception as error:
            result['reason'] = error.reason if isinstance(error, Refused) else 'io-or-observation-error'
        finally:
            closed = True
            for resource in reversed(resources):
                try: resource.close()
                except Exception: closed = False
            result['selfProof']['closed'] = closed
            if not closed:
                result.update(complete=False, tcpBoundInactive=False, sockets=[], reason='cleanup-failed')
        if result['complete']:
            try:
                self._check()
                if self._namespace() != result['namespace']: raise Refused('namespace-changed')
            except Exception as error:
                result.update(complete=False, tcpBoundInactive=False, sockets=[],
                              reason=error.reason if isinstance(error, Refused) else 'io-or-observation-error')
        if not result['complete']: result['sockets'] = []
        result['evidenceSha256'] = hashlib.sha256(canonical(result)).hexdigest()
        return result
