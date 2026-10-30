"""Policy-controlled, interface-bound IPv4 DNS-SD hints. Hints never establish peer trust."""

import ipaddress
import json
import os
import re
import secrets
import socket
import struct
import subprocess
import stat
import sys
import threading
import time
import tempfile
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlsplit

GROUP, PORT = "224.0.0.251", 5353
SERVICE = "_orbis._tcp.local"
PACKET_LIMIT, RECORD_LIMIT, CANDIDATE_LIMIT = 1232, 32, 16
IP_PKTINFO, IP_RECVTTL = 8, 12
PRIVATE = tuple(ipaddress.ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def private_ip(value):
    try:
        address = ipaddress.IPv4Address(value)
        return any(address in block for block in PRIVATE)
    except (ValueError, TypeError):
        return False


def secure_origin(value):
    if not isinstance(value, str) or not 1 <= len(value.encode("utf-8")) <= 240 or not value.isascii() or any(ord(c) < 33 for c in value):
        raise ValueError("Enter a complete private HTTPS origin")
    try:
        url = urlsplit(value)
        port = url.port if url.port is not None else 443
        host = url.hostname
        if url.scheme != "https" or not host or url.username or url.password or url.path not in ("", "/") or url.query or url.fragment:
            raise ValueError()
        if not 1 <= port <= 65535 or not re.fullmatch(r"[a-zA-Z0-9.-]{1,200}", host):
            raise ValueError()
        try:
            if not private_ip(str(ipaddress.ip_address(host))):
                raise ValueError()
        except ValueError:
            if re.fullmatch(r"[0-9.]+", host) or "." not in host or host.startswith(".") or host.endswith(".") or ".." in host:
                raise ValueError()
        return f"https://{host.lower()}" + (f":{port}" if port != 443 else ""), port
    except (ValueError, TypeError):
        raise ValueError("Use a private HTTPS origin without credentials, path, query or fragment") from None


def eligible_interfaces(rows):
    if not isinstance(rows, list) or len(rows) > 64:
        raise ValueError("Interface inventory exceeded its limit")
    result = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        name, index, flags = row.get("ifname"), row.get("ifindex"), row.get("flags", [])
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", name) or type(index) is not int or index <= 0:
            continue
        if re.match(r"^(lo$|docker|veth|br-|virbr|tun|tap|wg|tailscale)", name) or row.get("link_type") != "ether":
            continue
        if not isinstance(flags, list) or not {"UP", "MULTICAST"}.issubset(flags) or "POINTOPOINT" in flags:
            continue
        link = row.get("linkinfo") or {}
        if not isinstance(link, dict) or link.get("info_kind") not in (None, "vlan", "bond"):
            continue
        addresses = row.get("addr_info", [])
        if not isinstance(addresses, list) or len(addresses) > 32:
            continue
        ipv4 = [item for item in addresses if isinstance(item, dict) and item.get("family") == "inet"]
        if len(ipv4) != 1 or not private_ip(ipv4[0].get("local")):
            continue
        prefix = ipv4[0].get("prefixlen")
        if type(prefix) is not int or not 8 <= prefix <= 30:
            continue
        interface = ipaddress.IPv4Interface(f"{ipv4[0]['local']}/{prefix}")
        if not any(interface.network.subnet_of(block) for block in PRIVATE) or interface.ip in (interface.network.network_address, interface.network.broadcast_address):
            continue
        result.append({"id": name, "index": index, "address": str(interface.ip), "prefixLength": prefix})
    return result[:32]


def preferred_interface(rows, routes):
    if len(rows) == 1:
        return rows[0]["id"]
    if not isinstance(routes, list) or len(routes) > 64:
        return None
    choices = []
    for route in routes:
        if not isinstance(route, dict):
            return None
        if route.get("dst") != "default" or route.get("table", "main") not in ("main", 254):
            continue
        metric = route.get("metric", 0)
        if type(metric) is not int or not 0 <= metric <= 2147483647:
            return None
        selected = next((item for item in rows if item["id"] == route.get("dev")), None)
        device = None
        if route.get("type", "unicast") == "unicast" and "multipath" not in route and "nexthops" not in route and selected is not None and private_ip(route.get("gateway")):
            network = ipaddress.IPv4Network(f"{selected['address']}/{selected['prefixLength']}", strict=False)
            gateway = ipaddress.IPv4Address(route["gateway"])
            if gateway in network and gateway not in (network.network_address, network.broadcast_address, ipaddress.IPv4Address(selected["address"])):
                device = selected["id"]
        # Retain uncertain defaults so a higher-metric backup cannot become preferred.
        choices.append((metric, device))
    if not choices:
        return None
    best = min(metric for metric, _ in choices)
    devices = {name for metric, name in choices if metric == best}
    return next(iter(devices)) if len(devices) == 1 else None


def interfaces():
    if sys.platform != "linux" or not hasattr(socket, "SO_BINDTODEVICE"):
        raise ValueError("Nearby discovery requires the Linux host service; enter an address manually")
    completed = subprocess.run(["ip", "-j", "-d", "-4", "address", "show"], capture_output=True, check=False, timeout=2)
    if completed.returncode or len(completed.stdout) > 64 * 1024:
        raise ValueError("Private LAN interfaces are unavailable; enter an address manually")
    rows = eligible_interfaces(json.loads(completed.stdout))
    routes = []
    if len(rows) > 1:
        try:
            route = subprocess.run(["ip", "-j", "-4", "route", "show", "table", "main", "default"], capture_output=True, check=False, timeout=2)
            if route.returncode == 0 and len(route.stdout) <= 64 * 1024:
                routes = json.loads(route.stdout)
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    preferred = preferred_interface(rows, routes)
    return [{**item, "preferred": item["id"] == preferred} for item in rows]


def select_interface(name, rows=None):
    if not isinstance(name, str):
        raise ValueError("Choose one private LAN interface")
    found = next((item for item in (interfaces() if rows is None else rows) if item["id"] == name), None)
    if found is None:
        raise ValueError("The selected private LAN interface is unavailable")
    return found


def encode_name(value):
    labels = value.rstrip(".").split(".")
    if any(not label or len(label.encode("ascii")) > 63 for label in labels):
        raise ValueError("Invalid DNS name")
    encoded = b"".join(bytes([len(label)]) + label.encode("ascii") for label in labels) + b"\0"
    if len(encoded) > 255:
        raise ValueError("DNS name exceeds limit")
    return encoded


def decode_name(data, offset):
    labels, visited, end, expanded = [], set(), None, 1
    for _ in range(128):
        if not 0 <= offset < len(data) or offset in visited:
            raise ValueError("Invalid DNS name pointer")
        visited.add(offset)
        length = data[offset]
        if length & 0xC0 == 0xC0:
            if offset + 1 >= len(data):
                raise ValueError("Truncated DNS pointer")
            pointer = ((length & 63) << 8) | data[offset + 1]
            if pointer >= offset or len(visited) > 16:
                raise ValueError("Invalid DNS pointer chain")
            if end is None:
                end = offset + 2
            offset = pointer
            continue
        if length & 0xC0 or length > 63:
            raise ValueError("Invalid DNS label")
        offset += 1
        if not length:
            return ".".join(labels).lower(), end if end is not None else offset
        if offset + length > len(data):
            raise ValueError("Truncated DNS label")
        label = data[offset:offset + length].decode("ascii")
        if any(ord(c) < 33 or c in ".\\" for c in label):
            raise ValueError("Invalid DNS label text")
        labels.append(label)
        expanded += length + 1
        if expanded > 255:
            raise ValueError("Expanded DNS name exceeds limit")
        offset += length
    raise ValueError("DNS name exceeds work limit")


def parse_packet(data):
    if not 12 <= len(data) <= PACKET_LIMIT:
        raise ValueError("DNS packet length exceeds limit")
    identifier, flags, questions, answers, authorities, additional = struct.unpack_from("!6H", data)
    if questions > 4 or answers + authorities + additional > RECORD_LIMIT or flags & 0x7A0F:
        raise ValueError("Unsupported DNS packet")
    position, query, records = 12, [], []
    for _ in range(questions):
        name, position = decode_name(data, position)
        if position + 4 > len(data):
            raise ValueError("Truncated DNS question")
        kind, klass = struct.unpack_from("!HH", data, position)
        position += 4
        query.append((name, kind, klass & 0x7FFF))
    for _ in range(answers + authorities + additional):
        name, position = decode_name(data, position)
        if position + 10 > len(data):
            raise ValueError("Truncated DNS record")
        kind, klass, ttl, length = struct.unpack_from("!HHIH", data, position)
        position += 10
        end, value = position + length, None
        if end > len(data):
            raise ValueError("Truncated DNS record data")
        if kind == 12:
            value, consumed = decode_name(data, position)
            if consumed != end:
                raise ValueError("Invalid PTR length")
        elif kind == 33:
            if length < 7:
                raise ValueError("Truncated SRV")
            priority, weight, port = struct.unpack_from("!HHH", data, position)
            target, consumed = decode_name(data, position + 6)
            if consumed != end or priority or weight or not port:
                raise ValueError("Unsupported SRV")
            value = (target, port)
        elif kind == 1:
            if length != 4:
                raise ValueError("Invalid IPv4 record")
            value = socket.inet_ntoa(data[position:end])
        elif kind == 16:
            if length > 512:
                raise ValueError("TXT exceeds limit")
            value, cursor = {}, position
            while cursor < end:
                size = data[cursor]
                cursor += 1
                if not size or cursor + size > end or len(value) >= 8:
                    raise ValueError("Invalid TXT length")
                text = data[cursor:cursor + size].decode("ascii")
                key, separator, item = text.partition("=")
                if not separator or key in value or any(ord(c) < 32 or ord(c) == 127 for c in text):
                    raise ValueError("Invalid TXT field")
                value[key] = item
                cursor += size
        records.append((name, kind, klass & 0x7FFF, ttl, value))
        position = end
    if position != len(data):
        raise ValueError("Unexpected trailing DNS data")
    return identifier, flags, query, records


def query_packet(identifier):
    return struct.pack("!6H", identifier, 0, 1, 0, 0, 0) + encode_name(SERVICE) + struct.pack("!HH", 12, 1)


def response_packet(identifier, ephemeral, origin, address, ttl=10, legacy=True, hint_port=None):
    if hint_port is None:
        origin, port = secure_origin(origin)
        txt = ["product=orbis", "proto=1", f"origin={origin}", f"id={ephemeral}"]
    else:
        if origin is not None or type(hint_port) is not int or not 1 <= hint_port <= 65535:
            raise ValueError("Invalid address hint port")
        port = hint_port
        txt = ["product=orbis", "proto=2", f"id={ephemeral}"]
    if not re.fullmatch(r"[0-9a-f]{32}", ephemeral) or not private_ip(address):
        raise ValueError("Invalid discovery advertisement")
    instance, host = f"orbis-{ephemeral}.{SERVICE}", f"orbis-{ephemeral}.local"
    text = b"".join(bytes([len(item)]) + item.encode("ascii") for item in txt)
    values = [(SERVICE, 12, encode_name(instance)), (instance, 33, struct.pack("!HHH", 0, 0, port) + encode_name(host)), (instance, 16, text), (host, 1, socket.inet_aton(address))]
    question = encode_name(SERVICE) + struct.pack("!HH", 12, 1) if legacy else b""
    records = b"".join(encode_name(name) + struct.pack("!HHIH", kind, 1, ttl, len(value)) + value for name, kind, value in values)
    packet = struct.pack("!6H", identifier if legacy else 0, 0x8400, 1 if legacy else 0, 1, 0, 3) + question + records
    if len(packet) > PACKET_LIMIT:
        raise ValueError("Advertisement exceeds packet limit")
    return packet


def candidate(data, identifier, source):
    response_id, flags, questions, records = parse_packet(data)
    if response_id != identifier or not flags & 0x8000 or questions != [(SERVICE, 12, 1)]:
        return None
    pointers = [row for row in records if row[:3] == (SERVICE, 12, 1) and row[3] > 0]
    ptr = pointers[0][4] if len(pointers) == 1 else None
    if not isinstance(ptr, str) or not re.fullmatch(r"orbis-[0-9a-f]{32}\." + re.escape(SERVICE), ptr):
        return None
    srv = [row for row in records if row[:3] == (ptr, 33, 1) and row[3] > 0]
    txt = [row for row in records if row[:3] == (ptr, 16, 1) and row[3] > 0]
    if len(srv) != 1 or len(txt) != 1:
        return None
    fields = txt[0][4]
    hint = fields.get("proto") == "2"
    expected = {"product", "proto", "id"} if hint else {"product", "proto", "origin", "id"}
    if set(fields) != expected or fields["product"] != "orbis" or fields["proto"] not in ("1", "2") or ptr.split(".")[0] != "orbis-" + fields["id"]:
        return None
    host, advertised_port = srv[0][4]
    origin, port = (None, advertised_port) if hint else secure_origin(fields["origin"])
    addresses = [row for row in records if row[:3] == (host, 1, 1) and row[3] > 0]
    if not 1 <= port <= 65535 or port != advertised_port or len(addresses) != 1 or addresses[0][4] != source or not private_ip(source):
        return None
    if not hint and re.fullmatch(r"[0-9.]+", urlsplit(origin).hostname or "") and urlsplit(origin).hostname != source:
        return None
    result = {"id": fields["id"], "address": source, "port": port, "ttl": min(10, *(row[3] for row in [pointers[0], srv[0], txt[0], addresses[0]])), "verified": False}
    return {**result, "kind": "address"} if hint else {**result, "origin": origin}


def peer_allowed(source, selected):
    if not private_ip(source) or source == selected["address"]:
        return False
    network = ipaddress.IPv4Network(f"{selected['address']}/{selected['prefixLength']}", strict=False)
    address = ipaddress.IPv4Address(source)
    return address in network and address not in (network.network_address, network.broadcast_address)


def bound_socket(selected, advertise=False):
    if sys.platform != "linux" or socket.if_nametoindex(selected["id"]) != selected["index"]:
        raise ValueError("The selected LAN interface changed")
    connection = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        connection.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, selected["id"].encode("ascii") + b"\0")
        connection.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(selected["address"]))
        connection.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
        connection.setsockopt(socket.IPPROTO_IP, socket.IP_TTL, 255)
        connection.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 0)
        connection.setsockopt(socket.IPPROTO_IP, IP_PKTINFO, 1)
        connection.setsockopt(socket.IPPROTO_IP, IP_RECVTTL, 1)
        connection.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 32768)
        if advertise:
            connection.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            connection.setsockopt(socket.IPPROTO_IP, 49, 0)  # Linux IP_MULTICAST_ALL: accept only this socket's membership.
            connection.bind(("0.0.0.0", PORT))
            membership = socket.inet_aton(GROUP) + socket.inet_aton(selected["address"]) + struct.pack("=i", selected["index"])
            connection.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, membership)
        else:
            connection.bind((selected["address"], 0))
        connection.settimeout(0.2)
        return connection
    except BaseException:
        connection.close()
        raise


def receive(connection, selected, multicast):
    data, ancillary, flags, peer = connection.recvmsg(PACKET_LIMIT + 1, 128)
    index, destination, ttl = None, None, None
    for level, kind, value in ancillary:
        if level == socket.IPPROTO_IP and kind == IP_PKTINFO and len(value) == 12:
            index, _, raw_destination = struct.unpack("=I4s4s", value)
            destination = socket.inet_ntoa(raw_destination)
        if level == socket.IPPROTO_IP and kind == socket.IP_TTL and len(value) >= 4:
            ttl = struct.unpack_from("=i", value)[0]
    if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or len(data) > PACKET_LIMIT or index != selected["index"] or ttl != 255:
        return None
    if destination != (GROUP if multicast else selected["address"]) or not peer_allowed(peer[0], selected):
        return None
    return data, peer


class Discovery:
    def __init__(self, clock=time.monotonic, wall=time.time, socket_factory=bound_socket, interface_reader=interfaces, policy_path=None):
        self.clock, self.wall, self.socket_factory, self.interface_reader = clock, wall, socket_factory, interface_reader
        self.lock, self.scan_lock = threading.Lock(), threading.Lock()
        self.operation_lock = threading.RLock()
        self.stop, self.scan_stop = threading.Event(), threading.Event()
        self.lease, self.connection, self.worker = None, None, None
        self.policy_path = Path(policy_path) if policy_path is not None else None

    def policy_enabled(self):
        if self.policy_path is None:
            raise ValueError("Persistent nearby discovery is unavailable")
        try:
            descriptor = os.open(self.policy_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return True
        with os.fdopen(descriptor, "rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid() or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) & 0o077 or before.st_size > 1024:
                raise ValueError("Nearby discovery policy is invalid")
            raw = stream.read(1025)
            after = os.fstat(stream.fileno())
            if len(raw) > 1024 or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError("Nearby discovery policy changed")
        def unique_fields(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError("Duplicate discovery policy field")
                value[key] = item
            return value
        value = json.loads(raw, object_pairs_hook=unique_fields)
        if not isinstance(value, dict) or set(value) != {"version", "enabled"} or type(value["version"]) is not int or value["version"] != 1 or type(value["enabled"]) is not bool:
            raise ValueError("Nearby discovery policy is invalid")
        return value["enabled"]

    def write_policy(self, enabled):
        self.policy_enabled()
        descriptor, name = tempfile.mkstemp(prefix=".discovery-policy-", dir=self.policy_path.parent)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(json.dumps({"version": 1, "enabled": enabled}, separators=(",", ":")).encode("ascii"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.policy_path)
            directory = os.open(self.policy_path.parent, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            Path(name).unlink(missing_ok=True)

    def policy_status(self):
        try:
            with self.operation_lock:
                enabled = self.policy_enabled()
                if not enabled and (self.lease is not None or self.connection is not None):
                    self.disable(stop_scan=False)
                return {**self.status(), "policyVersion": 1, "enabled": enabled, "hintVersion": 2}
        except (ValueError, OSError):
            self.disable(stop_scan=False)
            return {"available": False, "reason": "Nearby discovery is unavailable; enter an address manually"}

    def configure(self, name, origin, address):
        with self.operation_lock:
            try:
                if self.policy_enabled():
                    self.advertise(name, origin, address, 180)
                else:
                    self.disable(stop_scan=False)
                return self.policy_status()
            except (ValueError, OSError, RuntimeError, subprocess.SubprocessError):
                self.disable(stop_scan=False)
                raise

    def set_policy(self, enabled, configuration=None):
        if type(enabled) is not bool:
            raise ValueError("Choose a nearby discovery preference")
        with self.operation_lock:
            if not enabled:
                try:
                    self.write_policy(False)
                finally:
                    self.disable(stop_scan=False)
            else:
                self.policy_enabled()
                if not isinstance(configuration, dict):
                    raise ValueError("A private HTTPS endpoint is required")
                try:
                    if set(configuration) == {"interface", "origin", "address"}:
                        result = self.advertise(configuration["interface"], configuration["origin"], configuration["address"], 180)
                    elif set(configuration) == {"kind", "interface", "port"} and configuration["kind"] == "address":
                        result = self.advertise_address(configuration["interface"], configuration["port"])
                    else:
                        raise ValueError("Provide one private LAN discovery configuration")
                    if not result["available"] or result["sharing"] is None:
                        raise ValueError("Nearby discovery is unavailable")
                    self.write_policy(True)
                except (ValueError, OSError, RuntimeError, subprocess.SubprocessError):
                    self.disable(stop_scan=False)
                    raise
            return self.policy_status()

    def inventory(self):
        try:
            return {"available": True, "interfaces": self.interface_reader()}
        except (OSError, ValueError, subprocess.SubprocessError):
            return {"available": False, "interfaces": [], "reason": "Nearby discovery is unavailable; enter an address manually"}

    def status(self):
        with self.lock:
            lease = self.lease if self.lease and self.lease["until"] > self.clock() and not self.stop.is_set() else None
            keys = ("id", "kind", "address", "port", "interface", "expiresAt") if lease and lease.get("kind") == "address" else ("id", "origin", "interface", "expiresAt")
            return {"available": sys.platform == "linux", "sharing": None if lease is None else {key: lease[key] for key in keys}}

    def disable(self, stop_scan=True):
        with self.operation_lock:
            self.stop.set()
            if stop_scan:
                self.scan_stop.set()
            with self.lock:
                if self.connection:
                    self.connection.close()
                self.connection, self.lease = None, None
            if self.worker and self.worker is not threading.current_thread():
                self.worker.join(timeout=0.5)
            return self.status()

    def advertise(self, name, origin, address, seconds=120):
        if type(seconds) is not int or not 30 <= seconds <= 300:
            raise ValueError("Nearby visibility must last 30 to 300 seconds")
        normalized, _ = secure_origin(origin)
        selected = select_interface(name, self.interface_reader())
        if address != selected["address"]:
            raise ValueError("The private HTTPS address must match the selected LAN interface")
        return self._activate(selected, {"origin": normalized}, seconds)

    def advertise_address(self, name, port):
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError("Use the configured private HTTP port")
        inventory = self.interface_reader()
        selected = select_interface(name, inventory)
        preferred = inventory if len(inventory) == 1 else [item for item in inventory if item.get("preferred") is True]
        if len(preferred) != 1 or preferred[0]["id"] != name:
            raise ValueError("The preferred private LAN interface changed or is ambiguous")
        return self._activate(selected, {"kind": "address", "address": selected["address"], "port": port}, 180)

    def configure_address(self, name, port):
        with self.operation_lock:
            try:
                if self.policy_enabled():
                    self.advertise_address(name, port)
                else:
                    self.disable(stop_scan=False)
                return self.policy_status()
            except (ValueError, OSError, RuntimeError, subprocess.SubprocessError):
                self.disable(stop_scan=False)
                raise

    def _activate(self, selected, details, seconds):
        if type(seconds) is not int or not 30 <= seconds <= 300:
            raise ValueError("Nearby visibility must last 30 to 300 seconds")
        with self.operation_lock:
            self.disable(stop_scan=False)
            connection = self.socket_factory(selected, True)
            stop = threading.Event()
            lease = {"id": secrets.token_hex(16), **details, "interface": selected["id"], "until": self.clock() + seconds, "expiresAt": datetime.fromtimestamp(self.wall() + seconds, timezone.utc).isoformat()}
            with self.lock:
                self.stop, self.connection, self.lease = stop, connection, lease
            worker = threading.Thread(target=self.respond, args=(connection, selected, lease, stop), daemon=True, name="orbis-nearby")
            self.worker = worker
            worker.start()
            return self.status()

    def respond(self, connection, selected, lease, stop):
        last_response, window, sent, examined = {}, self.clock(), 0, 0
        try:
            while not stop.is_set() and self.clock() < lease["until"]:
                try:
                    now = self.clock()
                    if now - window >= 1:
                        last_response, window, sent, examined = {}, now, 0, 0
                    if sent >= 8 or examined >= 128:
                        stop.wait(0.05)
                        continue
                    received = receive(connection, selected, True)
                    examined += 1
                    if received is None:
                        continue
                    now = self.clock()
                    if stop.is_set() or now >= lease["until"]:
                        break
                    data, peer = received
                    identifier, flags, questions, _ = parse_packet(data)
                    if flags & 0x8000 or questions != [(SERVICE, 12, 1)] or peer[1] < 1024 or now - last_response.get(peer[0], float("-inf")) < 0.5:
                        continue
                    legacy = peer[1] != PORT
                    packet = response_packet(identifier, lease["id"], lease.get("origin"), selected["address"], 10 if legacy else 30, legacy, lease.get("port"))
                    if stop.is_set() or self.clock() >= lease["until"]:
                        break
                    connection.sendto(packet, peer if legacy else (GROUP, PORT))
                    sent += 1
                    last_response[peer[0]] = now
                except socket.timeout:
                    continue
                except (ValueError, UnicodeError, struct.error):
                    continue
        except OSError:
            pass
        finally:
            connection.close()
            with self.lock:
                if self.connection is connection:
                    self.connection, self.lease = None, None

    def scan(self, name):
        if not self.scan_lock.acquire(blocking=False):
            raise ValueError("A nearby search is already running")
        stop = threading.Event()
        self.scan_stop = stop
        try:
            selected = select_interface(name, self.interface_reader())
            with self.socket_factory(selected) as connection:
                identifier = secrets.randbelow(65535) + 1
                query = query_packet(identifier)
                connection.sendto(query, (GROUP, PORT))
                deadline, second_query, examined, found = self.clock() + 5, self.clock() + 1, 0, {}
                while not stop.is_set() and self.clock() < deadline and examined < 256:
                    if second_query and self.clock() >= second_query:
                        connection.sendto(query, (GROUP, PORT))
                        second_query = None
                    try:
                        received = receive(connection, selected, False)
                        examined += 1
                        if received is None:
                            continue
                        data, peer = received
                        if peer[1] != PORT:
                            continue
                        item = candidate(data, identifier, peer[0])
                        if item and len(found) < CANDIDATE_LIMIT:
                            item["expiresAt"] = datetime.fromtimestamp(self.wall() + item.pop("ttl"), timezone.utc).isoformat()
                            found[item["id"]] = item
                    except socket.timeout:
                        continue
                    except (ValueError, UnicodeError, struct.error):
                        continue
            current_wall = self.wall()
            fresh = [item for item in found.values() if datetime.fromisoformat(item["expiresAt"]).timestamp() > current_wall]
            return {"available": True, "candidates": fresh}
        finally:
            self.scan_lock.release()
