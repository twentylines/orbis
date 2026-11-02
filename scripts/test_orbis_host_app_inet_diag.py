import copy
import hashlib
import importlib.util
import ipaddress
import json
from pathlib import Path
import socket
import struct
import time
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('app_inet_diag_test', Path(__file__).with_name('orbis-host-app-inet-diag.py'))
M = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(M)


def attribute(kind, data):
    length = 4 + len(data)
    return struct.pack('=HH', length, kind) + data + bytes((-length) % 4)


def record(family, *, address=None, port=None, inode=None, uid=0, state=7, attrs=b''):
    address = ('127.0.0.1' if family == 2 else '::1') if address is None else address
    port = 41000 + family if port is None else port
    inode = 1000 + family if inode is None else inode
    src = ipaddress.ip_address(address).packed
    if family == 2: src += bytes(12)
    return (bytes([family, state, 0, 0]) + struct.pack('!HH', port, 0) + src + bytes(16)
            + struct.pack('=III', 0, 1, 2) + struct.pack('=IIIII', 0, 0, 0, uid, inode) + attrs)


def message(payload, *, sequence=1, port_id=4321, kind=20, flags=2):
    length = 16 + len(payload)
    return struct.pack('=IHHII', length, kind, flags, sequence, port_id) + payload + bytes((-length) % 4)


def done(sequence): return message(struct.pack('=i', 0), sequence=sequence, kind=3)


def datagram(data, *, flags=0, peer=(0, 0), ancillary=None):
    return (data, [] if ancillary is None else ancillary, flags, peer)


class Probe:
    def __init__(self, system, family):
        self.system, self.family, self.closed = system, family, False
        self.endpoint = None; self.v6only = 0

    def settimeout(self, value):
        if not 0 < value <= 2: raise AssertionError('unbounded probe timeout')

    def setsockopt(self, level, key, value):
        if (level, key, value) != (socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1): raise AssertionError('unexpected option')
        self.v6only = 1

    def getsockopt(self, level, key):
        if key == socket.SO_ACCEPTCONN: return self.system.accepting
        if key == socket.IPV6_V6ONLY: return self.v6only
        raise AssertionError('unexpected getsockopt')

    def bind(self, endpoint):
        if self.system.bind_error: raise OSError('simulated bind failure')
        expected = ('127.0.0.1', 0) if self.family == 2 else ('::1', 0, 0, 0)
        if endpoint != expected: raise AssertionError('only fixed loopback ephemeral bind permitted')
        self.endpoint = (endpoint[0], 41000 + self.family) + endpoint[2:]
        self.system.binds.append(endpoint)

    def getsockname(self): return self.endpoint

    def close(self):
        self.closed = True
        if self.system.close_error: raise OSError('simulated close failure')


class Netlink:
    def __init__(self, system): self.system, self.closed, self.queue = system, False, []

    def settimeout(self, value):
        if not 0 < value <= 2: raise AssertionError('unbounded receive timeout')

    def bind(self, address):
        if address != (0, 0): raise AssertionError('no multicast or remote exposure')

    def getsockname(self): return self.system.local

    def sendto(self, data, address):
        if address != (0, 0): raise AssertionError('kernel destination required')
        self.system.requests.append(data)
        length, kind, flags, sequence, port_id = struct.unpack_from('=IHHII', data)
        family = data[16]
        if (length, kind, flags, port_id) != (72, 20, M.REQUEST_DUMP, 4321): raise AssertionError('incorrect request')
        states = struct.unpack_from('=I', data, 20)[0]
        if states not in (M.STATE_MASK, 1 << 13): raise AssertionError('state13 bit required')
        self.system.current_mask = states
        payload = record(family, attrs=attribute(11, b'\x01') if family == 10 else b'')
        extra = record(family, address='0.0.0.0' if family == 2 else '::', port=18080 + family, inode=2000 + family, uid=1000)
        tw = record(family, port=443, inode=0, state=6)
        packets = [datagram(message(payload, sequence=sequence) + message(extra, sequence=sequence)
                            + (message(tw, sequence=sequence) if states == M.STATE_MASK else b'')),
                   datagram(done(sequence))]
        self.queue = self.system.transform(family, packets)
        return len(data) - (1 if self.system.short_send else 0)

    def recvmsg(self, maximum, ancsize):
        if (maximum, ancsize) != (M.MAX_DATAGRAM, 0): raise AssertionError('fixed bounded recvmsg required')
        if not self.queue: raise TimeoutError('no complete dump')
        return self.queue.pop(0)

    def close(self): self.closed = True


class System:
    def __init__(self):
        self.resources, self.requests, self.binds = [], [], []
        self.uid, self.accepting, self.local = 0, 0, (4321, 0)
        self.bind_error = self.close_error = self.short_send = False
        self.transform = lambda family, packets: packets
        self.namespace_calls = 0

    def effective_uid(self): return self.uid

    def namespace(self):
        self.namespace_calls += 1
        value = {'device': 4, 'inode': 12345, 'link': 'net:[12345]'}
        return {'self': copy.deepcopy(value), '1': copy.deepcopy(value)}

    def open_probe(self, family):
        result = Probe(self, family); self.resources.append(result); return result

    def open_netlink(self):
        result = Netlink(self); self.resources.append(result); return result

    def socket_identity(self, sock): return {'inode': 1000 + sock.family, 'uid': 0}


class InetDiagTests(unittest.TestCase):
    def setUp(self):
        self.system = System()
        self.observer = M.InetDiagTcpObserver(deadline=int(time.time()) + 20, system=self.system)

    def observe(self):
        result = self.observer.observe()
        self.assertTrue(all(resource.closed for resource in self.system.resources))
        return result

    def transform_first(self, transform):
        def apply(family, packets):
            if family == 2: return transform(packets)
            return packets
        self.system.transform = apply

    def assert_refused(self):
        result = self.observe(); self.assertFalse(result['complete']); self.assertFalse(result['tcpBoundInactive']); self.assertEqual(result['sockets'], [])
        return result

    def test_success_requires_both_exact_bound_inactive_self_proofs_and_closes_resources(self):
        result = self.observe(); self.assertTrue(result['complete']); self.assertTrue(result['tcpBoundInactive'])
        self.assertEqual([item['family'] for item in result['selfProof']['families']], [2, 10])
        self.assertTrue(result['selfProof']['closed']); self.assertEqual(len(result['sockets']), 4)
        self.assertEqual({item['inode'] for item in result['sockets']}, {0, 2002, 2010})
        self.assertEqual(self.system.binds, [('127.0.0.1', 0), ('::1', 0, 0, 0)])
        self.assertTrue(all(item['requestedState'] == 13 and item['state'] == 7 and item['uid'] == 0 for item in result['selfProof']['families']))
        digest = result.pop('evidenceSha256'); self.assertEqual(digest, hashlib.sha256(M.canonical(result)).hexdigest())

    def test_bound_only_query_is_independently_checked_for_filtered_dump(self):
        def filtered(family, packets):
            if self.system.current_mask != 1 << 13: return packets
            packet = bytearray(packets[0][0]); struct.pack_into('=H', packet, 6, 2 | 0x20)
            return [datagram(bytes(packet)), packets[-1]]
        self.system.transform = filtered
        self.assert_refused()

    def test_new_bound_socket_in_second_selector_dump_is_retained_in_union(self):
        def extra(family, packets):
            if family != 2 or self.system.current_mask != 1 << 13: return packets
            seq = struct.unpack_from('=I', packets[0][0], 8)[0]
            return [datagram(packets[0][0] + message(record(2, port=19001, inode=9999, uid=1000), sequence=seq)), packets[-1]]
        self.system.transform = extra
        result = self.observe(); self.assertTrue(result['complete'])
        self.assertIn(9999, [item['inode'] for item in result['sockets']])

    def test_selector_proof_can_also_report_pseudo_state13_without_guessing_support(self):
        def state13(family, packets):
            packet = bytearray(packets[0][0]); packet[17] = 13
            return [datagram(bytes(packet)), packets[-1]]
        self.system.transform = state13
        result = self.observe(); self.assertTrue(result['complete'])
        self.assertTrue(all(item['state'] == 13 and item['requestedState'] == 13 for item in result['selfProof']['families']))

    def test_req_v2_has_exact_unfiltered_all_known_states_cookie_and_family_fields(self):
        self.observe()
        self.assertEqual(len(self.system.requests), 4)
        for request, family, sequence in zip(self.system.requests, (2, 10, 2, 10), (1, 2, 3, 4)):
            self.assertEqual(struct.unpack_from('=IHHII', request), (72, 20, 769, sequence, 4321))
            self.assertEqual(struct.unpack_from('=BBBBI', request, 16), (family, 6, 0, 0, M.STATE_MASK if sequence <= 2 else 1 << 13))
            self.assertTrue(M.STATE_MASK & (1 << 13)); self.assertEqual(request[24:64], bytes(40)); self.assertEqual(request[64:], b'\xff' * 8)

    def test_no_real_socket_or_proc_syscalls_are_used_by_fake_boundary(self):
        with mock.patch.object(M.socket, 'socket', side_effect=AssertionError('actual sockets forbidden')):
            with mock.patch.object(M.os, 'readlink', side_effect=AssertionError('actual proc forbidden')):
                with mock.patch.object(M.os, 'fstat', side_effect=AssertionError('actual socket fd forbidden')):
                    self.assertTrue(self.observe()['complete'])

    def test_empty_complete_dump_is_not_bound_inactive_coverage(self):
        self.system.transform = lambda family, packets: [packets[-1]]
        self.assertEqual(self.assert_refused()['reason'], 'bound-inactive-unproven')

    def test_old_kernel_with_empty_bound_selector_cannot_prove_support_from_close_in_full_dump(self):
        self.system.transform = lambda family, packets: [packets[-1]] if self.system.current_mask == 1 << 13 else packets
        self.assert_refused()

    def test_only_one_family_self_proof_is_not_complete(self):
        self.system.transform = lambda family, packets: packets if family == 2 else [packets[-1]]
        self.assert_refused()

    def test_wrong_probe_uid_inode_address_or_port_cannot_prove_support(self):
        for changes in ({'uid': 1}, {'inode': 3002}, {'address': '127.0.0.2'}, {'port': 41003}):
            system = System(); observer = M.InetDiagTcpObserver(deadline=int(time.time()) + 20, system=system)
            system.transform = lambda family, packets, changes=changes: ([datagram(message(record(2, **changes))), datagram(done(1))] if family == 2 else packets)
            with self.subTest(changes=changes): self.assertFalse(observer.observe()['complete']); self.assertTrue(all(r.closed for r in system.resources))

    def test_probe_uid_mode_and_accepting_state_are_checked(self):
        self.system.accepting = 1; self.assert_refused()
        self.system = System(); self.observer = M.InetDiagTcpObserver(deadline=int(time.time()) + 20, system=self.system)
        self.system.socket_identity = lambda sock: {'inode': 1000 + sock.family, 'uid': 1}
        self.assert_refused()

    def test_wrong_or_reused_positive_inode_is_rejected(self):
        self.transform_first(lambda packets: [datagram(message(record(2)) + message(record(2, port=9999))), packets[-1]])
        self.assertEqual(self.assert_refused()['reason'], 'duplicate-inode')

    def test_probe_identity_drift_after_dump_is_rejected(self):
        calls = [0]
        def identity(sock):
            calls[0] += 1
            return {'inode': 1000 + sock.family + (1 if calls[0] > 2 else 0), 'uid': 0}
        self.system.socket_identity = identity
        self.assert_refused()

    def test_netlink_sender_and_group_must_be_kernel_unicast(self):
        for peer in ((1, 0), (0, 1), (4321, 0)):
            self.setUp(); self.transform_first(lambda packets, peer=peer: [datagram(packets[0][0], peer=peer), packets[-1]])
            with self.subTest(peer=peer): self.assert_refused()

    def test_message_sender_id_and_sequence_must_match_exact_client_request(self):
        for sequence, port_id in ((0, 4321), (2, 4321), (1, 0), (1, 4322)):
            self.setUp(); self.transform_first(lambda packets, sequence=sequence, port_id=port_id: [datagram(message(record(2), sequence=sequence, port_id=port_id)), packets[-1]])
            with self.subTest(sequence=sequence, port_id=port_id): self.assert_refused()

    def test_nonmultipart_filtered_interrupted_or_unknown_flags_are_not_complete(self):
        for flags in (0, 2 | 0x10, 2 | 0x20, 2 | 0x200):
            self.setUp(); self.transform_first(lambda packets, flags=flags: [datagram(message(record(2), flags=flags)), packets[-1]])
            with self.subTest(flags=flags): self.assert_refused()

    def test_recvmsg_truncation_and_unexpected_ancillary_data_are_rejected(self):
        for flag in (socket.MSG_TRUNC, socket.MSG_CTRUNC, 1):
            self.setUp(); self.transform_first(lambda packets, flag=flag: [datagram(packets[0][0], flags=flag), packets[-1]])
            with self.subTest(flag=flag): self.assert_refused()
        self.setUp(); self.transform_first(lambda packets: [datagram(packets[0][0], ancillary=[(1, 2, b'x')]), packets[-1]])
        self.assert_refused()

    def test_error_and_zero_ack_never_replace_successful_done(self):
        for error in (-95, -1, 0):
            self.setUp(); self.transform_first(lambda packets, error=error: [datagram(message(struct.pack('=i', error), kind=2))])
            with self.subTest(error=error): self.assert_refused()

    def test_done_requires_zero_status_exact_payload_and_no_following_message(self):
        for payload in (b'', struct.pack('=i', -1), struct.pack('=i', 0) + b'xxxx'):
            self.setUp(); self.transform_first(lambda packets, payload=payload: [packets[0], datagram(message(payload, kind=3))])
            with self.subTest(payload=payload): self.assert_refused()
        self.setUp(); self.transform_first(lambda packets: [datagram(done(1) + message(record(2)))])
        self.assert_refused()

    def test_missing_done_timeout_and_empty_datagram_are_not_empty_success(self):
        self.transform_first(lambda packets: [packets[0]]); self.assert_refused()
        self.setUp(); self.transform_first(lambda packets: [datagram(b'')]); self.assert_refused()

    def test_partial_headers_lengths_and_trailing_garbage_are_rejected(self):
        variants = [b'x', struct.pack('=IHHII', 15, 20, 2, 1, 4321), struct.pack('=IHHII', 5000, 20, 2, 1, 4321), message(record(2)) + b'x']
        for packet in variants:
            self.setUp(); self.transform_first(lambda packets, packet=packet: [datagram(packet), packets[-1]])
            with self.subTest(bytes=len(packet)): self.assert_refused()

    def test_unknown_message_type_family_state_timer_or_short_record_is_rejected(self):
        variants = [message(record(2), kind=4), message(record(10)), message(record(2, state=14)), message(bytes(71))]
        timer = bytearray(record(2)); timer[2] = 6; variants.append(message(bytes(timer)))
        for packet in variants:
            self.setUp(); self.transform_first(lambda packets, packet=packet: [datagram(packet), packets[-1]])
            with self.subTest(packet=packet[:20]): self.assert_refused()

    def test_attributes_are_bounded_framed_and_v6only_is_typed(self):
        variants = [struct.pack('=HH', 3, 11), struct.pack('=HH', 100, 11), attribute(11, b'\x02'), attribute(11, b'\x01') + attribute(11, b'\x01')]
        for attrs in variants:
            self.setUp()
            self.system.transform = lambda family, packets, attrs=attrs: ([datagram(message(record(10, attrs=attrs), sequence=2)), datagram(done(2))] if family == 10 else packets)
            with self.subTest(attrs=attrs): self.assert_refused()

    def test_valid_unknown_attributes_are_ignored_without_deriving_authority(self):
        self.system.transform = lambda family, packets: ([datagram(message(record(2, attrs=attribute(123, b'not-authority')))), datagram(done(1))] if family == 2 and self.system.current_mask == M.STATE_MASK else packets)
        result = self.observe(); self.assertTrue(result['complete']); self.assertNotIn('not-authority', str(result))

    def test_namespace_mismatch_or_change_fails_coverage(self):
        original = self.system.namespace
        def mismatch():
            value = original(); value['1']['inode'] += 1; value['1']['link'] = 'net:[12346]'; return value
        self.system.namespace = mismatch; self.assert_refused()
        self.setUp(); original = self.system.namespace
        def change():
            value = original()
            if self.system.namespace_calls > 1:
                for item in value.values(): item.update(inode=12346, link='net:[12346]')
            return value
        self.system.namespace = change; self.assert_refused()

    def test_partial_namespace_and_nonroot_uid_are_explicit_failure(self):
        self.system.namespace = lambda: {}; self.assert_refused()
        self.setUp(); self.system.uid = 1000; self.assert_refused()
        self.setUp(); self.system.uid = False; self.assert_refused()

    def test_unsupported_platform_or_family_fails_without_partial_coverage(self):
        self.system.namespace = lambda: (_ for _ in ()).throw(M.Refused('unsupported-platform'))
        self.assertEqual(self.assert_refused()['reason'], 'unsupported-platform')
        self.setUp(); original = self.system.open_probe
        self.system.open_probe = lambda family: original(family) if family == 2 else (_ for _ in ()).throw(OSError('IPv6 unsupported'))
        self.assert_refused()

    def test_bind_or_send_failure_closes_every_created_resource(self):
        self.system.bind_error = True; self.assert_refused()
        self.setUp(); self.system.short_send = True; self.assert_refused()

    def test_close_failure_revokes_coverage_and_still_closes_other_resources(self):
        self.system.close_error = True
        result = self.assert_refused(); self.assertEqual(result['reason'], 'cleanup-failed'); self.assertFalse(result['selfProof']['closed'])

    def test_invalid_netlink_local_identity_is_rejected(self):
        for local in ((0, 0), (4321, 1), (True, 0)):
            self.setUp(); self.system.local = local
            with self.subTest(local=local): self.assert_refused()

    def test_bounds_on_bytes_datagrams_messages_and_attributes_fail_closed(self):
        for name, value in (('MAX_BYTES', 1), ('MAX_DATAGRAMS', 0), ('MAX_MESSAGES', 0), ('MAX_ATTRIBUTES', 0)):
            self.setUp()
            with self.subTest(bound=name), mock.patch.object(M, name, value): self.assert_refused()

    def test_expired_deadline_or_clock_rollback_cannot_open_socket(self):
        with mock.patch.object(M.time, 'time', return_value=self.observer.deadline + 1): self.assert_refused()
        self.assertFalse(self.system.resources)
        self.setUp()
        with mock.patch.object(M.time, 'time', return_value=self.observer.deadline - 10):
            with mock.patch.object(M.time, 'monotonic', return_value=self.observer.monotonic_deadline + 1): self.assert_refused()
        self.assertFalse(self.system.resources)

    def test_deadline_is_bounded_integer_and_injection_is_code_only(self):
        for deadline in (int(time.time()) - 1, int(time.time()) + 32, time.time() + 20, True):
            with self.subTest(deadline=deadline), self.assertRaises(ValueError): M.InetDiagTcpObserver(deadline=deadline, system=self.system)
        with self.assertRaises(ValueError): M.InetDiagTcpObserver(deadline=int(time.time()) + 20, system={})


if __name__ == '__main__': unittest.main()
