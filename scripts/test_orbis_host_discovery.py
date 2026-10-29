import importlib.util
import os
import socket
import struct
import threading
import unittest
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location("discovery", Path(__file__).with_name("orbis-host-discovery.py"))
D = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(D)
NIC = {"id": "eth0", "index": 2, "address": "192.168.50.10", "prefixLength": 24}
ROW = {"ifname": "eth0", "ifindex": 2, "flags": ["UP", "MULTICAST"], "link_type": "ether", "addr_info": [{"family": "inet", "local": NIC["address"], "prefixlen": 24}]}
ID = "a" * 32


class DiscoveryPacketTests(unittest.TestCase):
    def test_round_trip_is_only_an_unverified_hint_with_ephemeral_identity(self):
        raw = D.response_packet(7, ID, "https://source.internal.example:8443", "192.168.50.20")
        item = D.candidate(raw, 7, "192.168.50.20")
        self.assertEqual(item, {"id": ID, "origin": "https://source.internal.example:8443", "address": "192.168.50.20", "port": 8443, "ttl": 10, "verified": False})
        self.assertIsNone(D.candidate(raw, 8, "192.168.50.20"))
        self.assertIsNone(D.candidate(raw, 7, "192.168.50.30"))
        txt = next(row[4] for row in D.parse_packet(raw)[3] if row[1] == 16)
        self.assertEqual(set(txt), {"id", "product", "proto", "origin"})
        self.assertNotIn(b"account", raw)
        self.assertNotIn(b"password", raw)
        self.assertNotIn(b"pairing", raw)

    def test_rejects_bad_lengths_record_counts_flags_and_trailing_data(self):
        valid = D.response_packet(7, ID, "https://192.168.50.20", "192.168.50.20")
        invalid = [b"", b"x" * 11, b"x" * 1233, valid[:-1], valid + b"x", struct.pack("!6H", 1, 0, 5, 0, 0, 0), struct.pack("!6H", 1, 0, 0, 33, 0, 0), struct.pack("!6H", 1, 0x0800, 0, 0, 0, 0)]
        for raw in invalid:
            with self.subTest(raw=raw[:12]), self.assertRaises(ValueError):
                D.parse_packet(raw)

    def test_pointer_loops_forward_pointers_out_of_bounds_and_expanded_names_are_bounded(self):
        for raw, offset in [(b"\xc0\x00", 0), (b"x\xc0\x01", 1), (b"\xc0\xff", 0), (b"\xc0", 0), (b"\x40" + b"x" * 64, 0), ((b"\x3f" + b"x" * 63) * 5 + b"\0", 0)]:
            with self.subTest(raw=raw[:8]), self.assertRaises(ValueError):
                D.decode_name(raw, offset)
        self.assertEqual(D.decode_name(b"\x03abc\0\xc0\0", 5), ("abc", 7))
        chain = b"\0"
        previous = 0
        for _ in range(20):
            current = len(chain)
            chain += struct.pack("!H", 0xC000 | previous)
            previous = current
        with self.assertRaises(ValueError):
            D.decode_name(chain, previous)

    def test_txt_duplicates_truncated_segments_and_large_data_are_rejected(self):
        for text in [b"\x03a=1\x03a=2", b"\x05a=x", b"\0", b"x" * 513]:
            raw = struct.pack("!6H", 0, 0x8400, 0, 1, 0, 0) + D.encode_name(D.SERVICE) + struct.pack("!HHIH", 16, 1, 10, len(text)) + text
            with self.subTest(text=text[:8]), self.assertRaises(ValueError):
                D.parse_packet(raw)

    def test_compressed_record_is_supported_and_random_packets_cannot_escape_parser_bounds(self):
        raw = struct.pack("!6H", 0, 0x8400, 0, 1, 0, 0) + D.encode_name(D.SERVICE) + struct.pack("!HHIH", 12, 1, 10, 2) + b"\xc0\x0c"
        self.assertEqual(D.parse_packet(raw)[3][0][4], D.SERVICE)
        for size in range(256):
            try:
                D.parse_packet(os.urandom(size))
            except (ValueError, UnicodeError, struct.error):
                pass

    def test_only_https_origins_without_credentials_paths_or_public_literals(self):
        for value in ["http://192.168.50.1", "https://8.8.8.8", "https://127.0.0.1", "https://169.254.1.1", "https://192.168.50.1:0", "https://u:p@source.example", "https://source.example/path", "https://source.example?token=x", "https://source.example#x", "https://[fd00::1]", "https://source.example/\n", "https://" + "x" * 241]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                D.secure_origin(value)


class DiscoveryInterfaceTests(unittest.TestCase):
    def test_selects_only_explicit_private_active_multicast_lan_interfaces(self):
        self.assertEqual(D.eligible_interfaces([ROW]), [NIC])
        for changes in [{"flags": ["UP"]}, {"flags": ["UP", "MULTICAST", "POINTOPOINT"]}, {"ifname": "docker0"}, {"ifname": "eth0;bad"}, {"ifindex": 0}, {"link_type": "loopback"}, {"linkinfo": {"info_kind": "bridge"}}, {"addr_info": [{"family": "inet", "local": "8.8.8.8", "prefixlen": 24}]}, {"addr_info": ROW["addr_info"] + [{"family": "inet", "local": "8.8.8.8", "prefixlen": 24}]}]:
            with self.subTest(changes=changes):
                self.assertEqual(D.eligible_interfaces([{**ROW, **changes}]), [])
        with self.assertRaises(ValueError):
            D.select_interface("other", [NIC])

    def test_source_must_be_private_same_subnet_and_not_self_or_broadcast(self):
        self.assertTrue(D.peer_allowed("192.168.50.20", NIC))
        for value in [NIC["address"], "192.168.51.20", "192.168.50.0", "192.168.50.255", "127.0.0.1", "169.254.1.2", "8.8.8.8", "100.64.1.1", "fd00::1"]:
            self.assertFalse(D.peer_allowed(value, NIC))

    def test_socket_is_bound_to_one_device_and_multicast_interface_without_fallback(self):
        connection = mock.MagicMock()
        with mock.patch.object(D.sys, "platform", "linux"), mock.patch.object(D.socket, "SO_BINDTODEVICE", 25, create=True), mock.patch.object(D.socket, "if_nametoindex", return_value=2), mock.patch.object(D.socket, "socket", return_value=connection):
            self.assertIs(D.bound_socket(NIC, True), connection)
            connection.setsockopt.assert_any_call(socket.SOL_SOCKET, 25, b"eth0\0")
            connection.setsockopt.assert_any_call(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(NIC["address"]))
            connection.setsockopt.assert_any_call(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
            connection.setsockopt.assert_any_call(socket.IPPROTO_IP, 49, 0)
            connection.bind.assert_called_once_with(("0.0.0.0", 5353))
            connection.setsockopt.side_effect = OSError("denied")
            with self.assertRaises(OSError):
                D.bound_socket(NIC)
            connection.close.assert_called_once()

    def test_receive_rejects_wrong_interface_hop_limit_destination_and_truncation(self):
        def ancillary(index=2, ttl=255, destination=D.GROUP):
            return [(socket.IPPROTO_IP, D.IP_PKTINFO, struct.pack("=I4s4s", index, b"\0" * 4, socket.inet_aton(destination))), (socket.IPPROTO_IP, socket.IP_TTL, struct.pack("=i", ttl))]
        connection = mock.Mock()
        for info, flags in [(ancillary(3), 0), (ancillary(ttl=64), 0), (ancillary(destination=NIC["address"]), 0), (ancillary(), socket.MSG_TRUNC), ([], 0)]:
            connection.recvmsg.return_value = (b"packet", info, flags, ("192.168.50.20", 5353))
            self.assertIsNone(D.receive(connection, NIC, True))
        connection.recvmsg.return_value = (b"packet", ancillary(), 0, ("192.168.50.20", 5353))
        self.assertEqual(D.receive(connection, NIC, True), (b"packet", ("192.168.50.20", 5353)))


class DiscoveryLeaseTests(unittest.TestCase):
    def test_constructor_does_not_open_a_socket_or_start_visibility(self):
        factory = mock.Mock()
        discovery = D.Discovery(socket_factory=factory, interface_reader=lambda: [NIC])
        self.assertIsNone(discovery.status()["sharing"])
        factory.assert_not_called()

    def test_disabled_responder_and_expired_lease_never_receive_or_send(self):
        connection = mock.Mock()
        discovery = D.Discovery(clock=lambda: 100, interface_reader=lambda: [NIC])
        stopped = threading.Event()
        stopped.set()
        lease = {"until": 200, "id": ID, "origin": "https://source.example"}
        with mock.patch.object(D, "receive") as receive:
            discovery.respond(connection, NIC, lease, stopped)
            discovery.respond(connection, NIC, {**lease, "until": 99}, threading.Event())
        receive.assert_not_called()
        connection.sendto.assert_not_called()

    def test_visibility_is_explicit_short_lived_opaque_and_cancellable(self):
        now = [0]
        connection = mock.Mock()
        discovery = D.Discovery(clock=lambda: now[0], wall=lambda: 1000, socket_factory=lambda *_: connection, interface_reader=lambda: [NIC])
        with mock.patch.object(D.threading, "Thread"):
            active = discovery.advertise("eth0", "https://source.example", NIC["address"], 30)
            self.assertRegex(active["sharing"]["id"], r"^[0-9a-f]{32}$")
            now[0] = 31
            self.assertIsNone(discovery.status()["sharing"])
            discovery.disable()
            connection.close.assert_called()
            self.assertTrue(discovery.stop.is_set())
        for seconds in [0, 29, 301, True]:
            with self.assertRaises(ValueError):
                discovery.advertise("eth0", "https://source.example", NIC["address"], seconds)
        with self.assertRaises(ValueError):
            discovery.advertise("eth0", "https://source.example", "192.168.50.99", 120)

    def test_scan_is_bounded_does_not_connect_and_returns_only_unverified_candidates(self):
        now = [0]
        connection = mock.MagicMock()
        connection.__enter__.return_value = connection
        discovery = D.Discovery(clock=lambda: now[0], wall=lambda: 1000, socket_factory=lambda *_: connection, interface_reader=lambda: [NIC])
        packet = D.response_packet(100, ID, "https://192.168.50.20", "192.168.50.20")
        def receive(*_):
            now[0] += 1
            return packet, ("192.168.50.20", 5353)
        with mock.patch.object(D, "receive", side_effect=receive), mock.patch.object(D.secrets, "randbelow", return_value=99):
            result = discovery.scan("eth0")
        self.assertEqual(len(result["candidates"]), 1)
        self.assertFalse(result["candidates"][0]["verified"])
        self.assertEqual(connection.sendto.call_count, 2)
        connection.connect.assert_not_called()
        self.assertLessEqual(now[0], 5)


if __name__ == "__main__":
    unittest.main()
