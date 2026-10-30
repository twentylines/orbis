import importlib.util
import hashlib
import os
import json
import socket
import struct
import threading
import tempfile
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
    def test_proto1_bytes_remain_compatible_and_proto2_contains_only_an_address_hint(self):
        original = D.response_packet(7, ID, "https://source.internal.example:8443", "192.168.50.20")
        self.assertEqual(hashlib.sha256(original).hexdigest(), "ca9f46edf0152424b2c586f63ff4d86955a2e2d1e0f203af254aacfc87e39ce2")
        raw = D.response_packet(7, ID, None, "192.168.50.20", hint_port=8080)
        self.assertLessEqual(len(raw), D.PACKET_LIMIT)
        self.assertEqual(D.candidate(raw, 7, "192.168.50.20"), {"kind": "address", "id": ID, "address": "192.168.50.20", "port": 8080, "ttl": 10, "verified": False})
        self.assertNotIn(b"origin=", raw)
        for changed, source in [(raw, "8.8.8.8"), (raw, "192.168.50.21"), (raw.replace(b"proto=2", b"proto=3"), "192.168.50.20"), (raw.replace(b"proto=2", b"proto=1"), "192.168.50.20"), (original.replace(b"proto=1", b"proto=2"), "192.168.50.20")]:
            self.assertIsNone(D.candidate(changed, 7, source))
        for port in [0, 65536, True, "80"]:
            with self.assertRaises(ValueError):
                D.response_packet(7, ID, None, "192.168.50.20", hint_port=port)
        with self.assertRaises(ValueError):
            D.response_packet(7, ID, "http://192.168.50.20", "192.168.50.20", hint_port=80)

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
    def test_default_route_selects_only_a_unique_eligible_private_interface(self):
        wifi = {**NIC, "id": "wlan0", "index": 3, "address": "192.168.60.10"}
        route = {"dst": "default", "dev": "eth0", "gateway": "192.168.50.1", "metric": 100}
        self.assertEqual(D.preferred_interface([NIC], []), "eth0")
        self.assertEqual(D.preferred_interface([wifi, NIC], [route]), "eth0")
        other = {**route, "dev": "wlan0", "gateway": "192.168.60.1"}
        self.assertIsNone(D.preferred_interface([NIC, wifi], [route, other]))
        self.assertEqual(D.preferred_interface([NIC, wifi], [route, {**other, "metric": 50}]), "wlan0")
        for changed in [{"gateway": "8.8.8.8"}, {"gateway": NIC["address"]}, {"gateway": "192.168.50.255"}, {"dev": "wg0"}, {"metric": True}, {"table": 123}, {"multipath": []}, {"nexthops": []}]:
            self.assertIsNone(D.preferred_interface([NIC, wifi], [{**route, **changed}]))
        self.assertIsNone(D.preferred_interface([NIC, wifi], [route] * 65))

    def test_ambiguous_or_unsafe_preferred_default_cannot_select_a_backup(self):
        wifi = {**NIC, "id": "wlan0", "index": 3, "address": "192.168.60.10"}
        backup = {"dst": "default", "dev": "wlan0", "gateway": "192.168.60.1", "metric": 100}
        primary = {"dst": "default", "metric": 10, "nexthops": [
            {"dev": "eth0", "gateway": "192.168.50.1"},
            {"dev": "wlan0", "gateway": "192.168.60.1"},
        ]}
        competing = [primary, {**primary, "metric": 100}, {**primary, "multipath": primary["nexthops"]},
                     {**backup, "metric": 10, "gateway": "8.8.8.8"},
                     {**backup, "metric": 10, "dev": "wg0"},
                     {**backup, "metric": 10, "type": "blackhole"},
                     {**backup, "metric": True}]
        for uncertain in competing:
            for routes in ([uncertain, backup], [backup, uncertain]):
                with self.subTest(routes=routes):
                    self.assertIsNone(D.preferred_interface([NIC, wifi], routes))

    def test_unambiguous_lower_metric_private_route_wins_over_uncertain_backup(self):
        wifi = {**NIC, "id": "wlan0", "index": 3, "address": "192.168.60.10"}
        primary = {"dst": "default", "dev": "eth0", "gateway": "192.168.50.1", "metric": 10}
        backup = {"dst": "default", "metric": 100, "nexthops": [
            {"dev": "eth0", "gateway": "192.168.50.1"},
            {"dev": "wlan0", "gateway": "192.168.60.1"},
        ]}
        for routes in ([primary, backup], [backup, primary]):
            self.assertEqual(D.preferred_interface([NIC, wifi], routes), "eth0")
        self.assertEqual(D.preferred_interface([NIC, wifi], [primary, {**primary}]), "eth0")

    def test_interface_preference_uses_only_bounded_read_only_route_metadata(self):
        wifi = {**ROW, "ifname": "wlan0", "ifindex": 3, "addr_info": [{"family": "inet", "local": "192.168.60.10", "prefixlen": 24}]}
        route = [{"dst": "default", "dev": "eth0", "gateway": "192.168.50.1"}]
        with mock.patch.object(D.sys, "platform", "linux"), mock.patch.object(D.socket, "SO_BINDTODEVICE", 25, create=True), mock.patch.object(D.subprocess, "run", side_effect=[mock.Mock(returncode=0, stdout=json.dumps([ROW, wifi]).encode()), mock.Mock(returncode=0, stdout=json.dumps(route).encode())]) as command:
            values = D.interfaces()
            self.assertEqual([item["id"] for item in values if item["preferred"]], ["eth0"])
            self.assertEqual(command.call_args_list[1].args[0], ["ip", "-j", "-4", "route", "show", "table", "main", "default"])
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


class DiscoveryPolicyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.file = Path(self.directory.name) / "discovery-policy.json"
        self.factory = mock.Mock(return_value=mock.Mock())
        self.discovery = D.Discovery(policy_path=self.file, socket_factory=self.factory, interface_reader=lambda: [NIC])

    def test_absence_defaults_allowed_without_socket_or_advertisement(self):
        with mock.patch.object(D.sys, "platform", "linux"):
            self.assertEqual(self.discovery.policy_status(), {"available": True, "sharing": None, "policyVersion": 1, "enabled": True, "hintVersion": 2})
        self.factory.assert_not_called()
        self.assertFalse(self.file.exists())

    def test_opt_out_is_private_durable_restart_safe_and_cannot_be_undone_by_configure(self):
        self.discovery.set_policy(False)
        self.assertEqual(json.loads(self.file.read_text()), {"version": 1, "enabled": False})
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)
        restarted = D.Discovery(policy_path=self.file, socket_factory=self.factory, interface_reader=lambda: [NIC])
        self.assertFalse(restarted.configure("eth0", "https://source.example", NIC["address"])["enabled"])
        self.factory.assert_not_called()

    def test_address_hint_without_dns_is_bounded_and_opt_out_survives_restart(self):
        with mock.patch.object(D.threading, "Thread"), mock.patch.object(D.sys, "platform", "linux"):
            active = self.discovery.configure_address("eth0", 8080)
            self.assertEqual(active["sharing"]["kind"], "address")
            self.assertEqual(active["sharing"]["address"], NIC["address"])
            self.assertEqual(active["sharing"]["port"], 8080)
            self.assertNotIn("origin", active["sharing"])
            self.assertLessEqual(self.discovery.lease["until"] - self.discovery.clock(), 180)
            self.discovery.set_policy(False)
            restarted = D.Discovery(policy_path=self.file, socket_factory=self.factory, interface_reader=lambda: [NIC])
            self.factory.reset_mock()
            self.assertFalse(restarted.configure_address("eth0", 8080)["enabled"])
            self.factory.assert_not_called()
            allowed = restarted.set_policy(True, {"kind": "address", "interface": "eth0", "port": 8080})
            self.assertTrue(allowed["enabled"])
            self.assertEqual(json.loads(self.file.read_text()), {"version": 1, "enabled": True})
        self.discovery.disable()

    def test_address_hint_activation_failure_never_enables_or_persists_invalid_configuration(self):
        self.discovery.set_policy(False)
        for configuration in [{"kind": "address", "interface": "eth0", "port": True}, {"kind": "address", "interface": "foreign0", "port": 80}, {"kind": "address", "interface": "eth0", "port": 80, "origin": "http://8.8.8.8"}]:
            with self.assertRaises(ValueError):
                self.discovery.set_policy(True, configuration)
            self.assertFalse(self.discovery.policy_enabled())
        self.factory.side_effect = OSError("fixture failure")
        with self.assertRaises(OSError):
            self.discovery.set_policy(True, {"kind": "address", "interface": "eth0", "port": 80})
        self.assertFalse(self.discovery.policy_enabled())

    def test_address_hint_rechecks_current_preferred_interface_before_opening_a_socket(self):
        wifi = {**NIC, "id": "wlan0", "index": 3, "address": "192.168.60.10", "preferred": True}
        self.discovery.interface_reader = lambda: [{**NIC, "preferred": False}, wifi]
        with self.assertRaisesRegex(ValueError, "changed or is ambiguous"):
            self.discovery.configure_address("eth0", 80)
        self.factory.assert_not_called()
        self.discovery.interface_reader = lambda: [{**NIC, "preferred": False}, {**wifi, "preferred": False}]
        with self.assertRaises(ValueError):
            self.discovery.configure_address("wlan0", 80)
        self.factory.assert_not_called()

    def test_expired_address_hint_worker_cannot_receive_or_send(self):
        now = [0]
        self.discovery.clock = lambda: now[0]
        with mock.patch.object(D.threading, "Thread"):
            self.discovery.configure_address("eth0", 80)
        connection, lease, stop = self.discovery.connection, self.discovery.lease, self.discovery.stop
        now[0] = 181
        self.discovery.respond(connection, NIC, lease, stop)
        connection.recvmsg.assert_not_called()
        connection.sendto.assert_not_called()
        self.assertIsNone(self.discovery.status()["sharing"])

    def test_opt_in_requires_valid_endpoint_and_successful_socket_before_persisting(self):
        self.discovery.set_policy(False)
        for configuration in [None, {"interface": "other", "origin": "https://source.example", "address": NIC["address"]}, {"interface": "eth0", "origin": "http://source.example", "address": NIC["address"]}]:
            with self.assertRaises(ValueError):
                self.discovery.set_policy(True, configuration)
            self.assertFalse(self.discovery.policy_enabled())
        self.factory.side_effect = OSError("fixture failure")
        with self.assertRaises(OSError):
            self.discovery.set_policy(True, {"interface": "eth0", "origin": "https://source.example", "address": NIC["address"]})
        self.assertFalse(self.discovery.policy_enabled())

    def test_configure_uses_only_a_bounded_lease_and_disable_is_persisted_before_stop(self):
        with mock.patch.object(D.threading, "Thread"), mock.patch.object(D.sys, "platform", "linux"):
            self.assertTrue(self.discovery.configure("eth0", "https://source.example", NIC["address"])["sharing"])
            self.factory.reset_mock()
            original = self.discovery.write_policy
            def save(enabled):
                self.assertIsNotNone(self.discovery.lease)
                original(enabled)
            with mock.patch.object(self.discovery, "write_policy", side_effect=save):
                self.discovery.set_policy(False)
            self.assertIsNone(self.discovery.status()["sharing"])

    def test_unknown_duplicate_unsafe_or_future_policy_fails_closed_before_any_socket(self):
        for raw in [b'{"version":2,"enabled":true}', b'{"version":1,"enabled":true,"origin":"private"}', b'{"version":1,"enabled":false,"enabled":true}', b'x'*1025]:
            self.file.write_bytes(raw); self.file.chmod(0o600)
            self.assertFalse(self.discovery.policy_status()["available"])
            with self.assertRaises(ValueError):
                self.discovery.configure("eth0", "https://source.example", NIC["address"])
        self.file.write_text('{"version":1,"enabled":true}');self.file.chmod(0o644)
        self.assertFalse(self.discovery.policy_status()["available"])
        self.file.unlink();self.file.symlink_to(Path(self.directory.name)/"missing")
        self.assertFalse(self.discovery.policy_status()["available"])
        self.factory.assert_not_called()

    def test_background_renewal_and_visibility_policy_do_not_cancel_a_user_scan(self):
        with mock.patch.object(D.threading, "Thread"), mock.patch.object(D.sys, "platform", "linux"):
            self.discovery.configure("eth0", "https://source.example", NIC["address"])
            self.discovery.configure("eth0", "https://source.example", NIC["address"])
            self.assertFalse(self.discovery.scan_stop.is_set())
            self.discovery.set_policy(False)
            self.assertFalse(self.discovery.scan_stop.is_set())
            self.discovery.disable()
            self.assertTrue(self.discovery.scan_stop.is_set())


if __name__ == "__main__":
    unittest.main()
