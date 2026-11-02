import copy
import importlib.util
import ipaddress
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock


def load(filename, name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


M = load('orbis-host-app-port-observer.py', 'app_port_observer_test')
P = load('orbis-host-app-port-policy.py', 'app_port_observer_policy_test')
F = load('test_orbis_host_app_create_intent.py', 'app_port_observer_actual_fixture')
HEADER = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n'


def hex_ip(value):
    data = ipaddress.ip_address(value).packed
    return ''.join(format(int.from_bytes(data[index:index + 4], M.sys.byteorder), '08X') for index in range(0, len(data), 4))


def row(index=0, address='127.0.0.1', port=18080, inode=100, state='0A', tail=True):
    family = ipaddress.ip_address(address).version
    remote = '0.0.0.0' if family == 4 else '::'
    result = (f'{index}: {hex_ip(address)}:{port:04X} {hex_ip(remote)}:0000 {state} '
              f'00000000:00000000 00:00000000 00000000 {os.getuid()} 0 {inode}')
    if tail: result += ' 1 0000000000000000 100 0 0 10 -1'
    return result + '\n'


class ObserverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='.proc-port-test-', dir=Path(__file__).parent)
        self.root = Path(self.temp.name); self.uid = os.getuid()
        (self.root / 'net').mkdir()
        for name, _ in M.TABLES: (self.root / 'net' / name).write_text(HEADER)
        self.namespace_file = self.root / 'namespace-object'; self.namespace_file.touch()
        self.namespace_inode = self.namespace_file.stat().st_ino
        self.namespace('self'); self.pid(1, comm='init', argv=None, fds={})
        (self.root / 'net/tcp').write_text(HEADER + row())
        self.pid(42)
        values = F.fixture(); compiled = F.compile_fixture(values)
        self.raw = F.created(values, compiled, True); self.raw['Id'] = 'e' * 64
        self.raw['State'].update(Paused=False, Restarting=False)
        for name, endpoint in self.raw['NetworkSettings']['Networks'].items():
            endpoint['IPAddress'] = '172.20.0.2' if name == 'whoami_demo_default' else '172.21.0.2'
            endpoint['GlobalIPv6Address'] = ''
        self.plan = {'appUrn': values[0]['appUrn'], 'service': values[0]['service'], 'ordinal': 1,
                     'sourceId': values[0]['inspect']['Id'], 'wasRunning': True, 'compiled': compiled}
        self.binding = {'containerId': self.raw['Id'], 'containerPort': '8080/tcp', 'protocol': 'tcp', 'address': '127.0.0.1', 'port': 18080}
        self.observer = self.new_observer()

    def tearDown(self): self.temp.cleanup()

    def new_observer(self):
        # Explicit test-only source and UID substitution. No real /proc reads.
        return M.ProcPortObserver(deadline=int(time.time()) + 20, proc_root=self.root, owner_uid=self.uid)

    def namespace(self, pid, *, different=False):
        directory = self.root / str(pid) / 'ns'; directory.mkdir(parents=True, exist_ok=True)
        target = self.namespace_file
        if different:
            target = self.root / ('different-namespace-' + str(pid)); target.touch()
        inode = target.stat().st_ino
        local = directory / ('net:[' + str(inode) + ']')
        if not local.exists(): os.link(target, local)
        link = directory / 'net'
        link.unlink(missing_ok=True); link.symlink_to(local.name)

    def stat(self, pid, *, comm='docker-proxy', started=1234):
        values = ['S'] + ['0'] * 50; values[19] = str(started)
        (self.root / str(pid) / 'stat').write_bytes(str(pid).encode() + b' (' + comm.encode() + b') ' + ' '.join(values).encode() + b'\n')

    def uid_status(self, pid, uid=None):
        uid = self.uid if uid is None else uid
        (self.root / str(pid) / 'status').write_text(f'Name:\tfixture\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\n')

    def argv(self, **changes):
        values = {'-proto': 'tcp', '-host-ip': '127.0.0.1', '-host-port': '18080', '-container-ip': '172.20.0.2', '-container-port': '8080'}
        values.update(changes)
        return ['/usr/bin/docker-proxy'] + [item for pair in values.items() for item in pair]

    def cmdline(self, pid, argv):
        (self.root / str(pid) / 'cmdline').write_bytes(b'\0'.join(item.encode() for item in argv) + b'\0')

    def pid(self, pid, *, comm='docker-proxy', argv='default', fds=None):
        directory = self.root / str(pid); directory.mkdir(exist_ok=True)
        (directory / 'fd').mkdir(exist_ok=True)
        self.namespace(pid); self.stat(pid, comm=comm); self.uid_status(pid)
        if argv is not None: self.cmdline(pid, self.argv() if argv == 'default' else argv)
        for fd, inode in ({7: 100} if fds is None else fds).items():
            link = directory / 'fd' / str(fd); link.unlink(missing_ok=True); link.symlink_to('socket:[' + str(inode) + ']')

    def observe(self): return self.observer.observe([self.raw])

    def test_complete_observation_and_exact_retiring_proxy_proof(self):
        result = self.observe(); observation, ownership = result['observation'], result['ownership']
        self.assertEqual(observation, {'complete': True, 'namespace': 'host', 'protocols': ['tcp', 'udp'],
                                      'sockets': [{'protocol': 'tcp', 'address': '127.0.0.1', 'port': 18080, 'inode': 100, 'v6only': None}]})
        self.assertEqual(ownership['coverage'], {'tcpBoundInactive': False})
        self.assertTrue(ownership['processScanComplete']); self.assertEqual(len(ownership['entries']), 1)
        self.assertEqual(ownership['retirementSnapshots'], {self.raw['Id']: M.digest(self.raw)})
        claimed = ownership.pop('ownershipSha256'); self.assertEqual(claimed, M.digest(ownership))
        self.assertTrue(self.observer.prove_host_socket_owner(observation['sockets'][0], self.raw, self.binding))
        self.assertTrue(P.verify_port_claims([self.plan], [self.raw], [self.raw['Id']], observation,
                                           prove_host_socket_owner=self.observer.prove_host_socket_owner))

    def test_all_four_tables_include_ipv4_ipv6_tcp_udp_and_all_bound_states(self):
        (self.root / 'net/tcp').write_text(HEADER + row(state='01'))
        (self.root / 'net/tcp6').write_text(HEADER + row(address='2001:db8::1234', port=443, inode=101, state='08'))
        (self.root / 'net/udp').write_text(HEADER + row(address='0.0.0.0', port=53, inode=102, state='07'))
        (self.root / 'net/udp6').write_text(HEADER + row(address='::1', port=19090, inode=103, state='01'))
        sockets = self.observe()['observation']['sockets']
        self.assertEqual({(item['protocol'], item['address'], item['port']) for item in sockets},
                         {('tcp', '127.0.0.1', 18080), ('tcp', '2001:db8::1234', 443), ('udp', '0.0.0.0', 53), ('udp', '::1', 19090)})
        self.assertTrue(all(item['v6only'] is None for item in sockets))

    def test_time_wait_inode_zero_is_kept_and_never_gets_an_ownership_exemption(self):
        (self.root / 'net/tcp').write_text(HEADER + row(inode=0, state='06', tail=False) + row(index=1, inode=0, port=18081, state='06', tail=False))
        result = self.observe(); sockets = result['observation']['sockets']
        self.assertEqual([item['inode'] for item in sockets], [0, 0]); self.assertFalse(result['ownership']['entries'])
        self.assertFalse(self.observer.prove_host_socket_owner(sockets[0], self.raw, self.binding))
        with self.assertRaisesRegex(ValueError, 'unowned'):
            P.verify_port_claims([self.plan], [self.raw], [self.raw['Id']], result['observation'], prove_host_socket_owner=lambda *_: True)

    def test_zero_local_port_is_validated_then_excluded_from_bound_claims(self):
        (self.root / 'net/tcp').write_text(HEADER + row(port=0))
        self.assertEqual(self.observe()['observation']['sockets'], [])

    def test_missing_any_socket_table_has_no_fallback_or_complete_receipt(self):
        for name, _ in M.TABLES:
            path = self.root / 'net' / name; body = path.read_bytes(); path.unlink()
            with self.subTest(name=name), self.assertRaises((OSError, ValueError)): self.new_observer().observe([self.raw])
            path.write_bytes(body)

    def test_bad_header_truncated_nonascii_and_extra_row_fields_fail(self):
        variants = [b'unknown header\n', (HEADER + row()).encode()[:-1], HEADER.encode() + b'\xff\n',
                    (HEADER + row().rstrip() + ' UNKNOWN\n').encode()]
        for index, data in enumerate(variants):
            (self.root / 'net/tcp').write_bytes(data)
            with self.subTest(index=index), self.assertRaises(ValueError): self.new_observer().observe([self.raw])

    def test_invalid_hex_port_state_inode_and_row_duplicates_fail(self):
        original = row()
        variants = [original.replace('0100007F', 'GG00007F'), original.replace(':46A0', ':10000'),
                    original.replace(' 0A ', ' FF '), original.replace(' 100 1 ', ' -1 1 '),
                    original + original, original.replace('00000000:00000000', '0:0', 1)]
        for index, text in enumerate(variants):
            (self.root / 'net/tcp').write_text(HEADER + text)
            with self.subTest(index=index), self.assertRaises(ValueError): self.new_observer().observe([self.raw])

    def test_duplicate_positive_inode_across_tables_is_refused(self):
        (self.root / 'net/udp').write_text(HEADER + row(port=53, inode=100, state='07'))
        with self.assertRaises(ValueError): self.observe()

    def test_ipv6_wildcard_remains_unknown_v6only(self):
        (self.root / 'net/tcp6').write_text(HEADER + row(address='::', port=443, inode=200))
        result = self.observe()
        self.assertEqual(next(item for item in result['observation']['sockets'] if item['inode'] == 200)['v6only'], None)

    def test_namespace_equality_requires_same_readlink_device_and_inode(self):
        self.namespace('self', different=True)
        with self.assertRaisesRegex(ValueError, 'namespace'): self.observe()

    def test_namespace_malformed_or_forged_link_fails(self):
        link = self.root / 'self/ns/net'; link.unlink(); link.symlink_to('net:[123]')
        with self.assertRaises((OSError, ValueError)): self.observe()
        link.unlink(); link.symlink_to('not-a-net-namespace')
        with self.assertRaises(ValueError): self.observe()

    def test_proxy_outside_observed_host_netns_never_gets_exemption(self):
        self.namespace(42, different=True)
        result = self.observe(); self.assertFalse(result['ownership']['processScanComplete']); self.assertFalse(result['ownership']['entries'])

    def test_wrong_uid_or_mixed_uid_proxy_never_gets_exemption(self):
        for status in (f'Uid:\t{self.uid + 1}\t{self.uid + 1}\t{self.uid + 1}\t{self.uid + 1}\n',
                       f'Uid:\t{self.uid}\t{self.uid + 1}\t{self.uid}\t{self.uid}\n'):
            (self.root / '42/status').write_text(status)
            with self.subTest(status=status): self.assertFalse(self.new_observer().observe([self.raw])['ownership']['entries'])

    def test_only_exact_known_proxy_flags_and_binary_are_recognized(self):
        original = self.argv()
        variants = [original + ['-unknown', 'value'], original + ['-proto', 'tcp'],
                    ['/tmp/docker-proxy'] + original[1:], ['docker-proxy'] + original[1:],
                    self.argv(**{'-proto': 'sctp'}), self.argv(**{'-host-port': '018080'}),
                    self.argv(**{'-host-ip': '::1%lo0'}), original[:-1]]
        for index, argv in enumerate(variants):
            self.cmdline(42, argv)
            with self.subTest(index=index): self.assertFalse(self.new_observer().observe([self.raw])['ownership']['entries'])

    def test_wrong_host_tuple_container_ip_or_container_port_never_exempts(self):
        variants = [{'-host-ip': '0.0.0.0'}, {'-host-port': '18081'}, {'-container-ip': '172.20.0.99'}, {'-container-port': '8081'}]
        for change in variants:
            self.cmdline(42, self.argv(**change))
            with self.subTest(change=change): self.assertFalse(self.new_observer().observe([self.raw])['ownership']['entries'])

    def test_missing_or_wrong_approved_network_identity_cannot_prove_owner(self):
        self.raw['NetworkSettings']['Networks']['whoami_demo_default']['NetworkID'] = ''
        with self.assertRaises(ValueError): self.observe()

    def test_same_proxy_tuple_matching_two_retired_containers_is_ambiguous(self):
        other = copy.deepcopy(self.raw); other['Id'] = 'f' * 64
        self.assertFalse(self.observer.observe([self.raw, other])['ownership']['entries'])

    def test_shared_inode_held_by_another_process_never_exempts(self):
        self.pid(43, comm='unrelated', argv=None)
        result = self.observe(); self.assertTrue(result['ownership']['processScanComplete']); self.assertFalse(result['ownership']['entries'])

    def test_arbitrary_nonproxy_commandline_is_not_read_or_stored(self):
        self.pid(43, comm='other', argv=['private-value-must-not-enter-evidence'], fds={})
        original = self.observer._read
        def guarded(path, maximum, **kwargs):
            if path == 'cmdline' and os.fstat(kwargs['directory']).st_ino == (self.root / '43').stat().st_ino:
                raise AssertionError('nonproxy commandline must remain unread')
            return original(path, maximum, **kwargs)
        self.observer._read = guarded
        result = self.observe()
        self.assertNotIn('private-value', str(result))
        self.assertEqual(len(result['ownership']['entries']), 1)

    def test_unicode_other_process_names_do_not_require_private_cmdline_reads(self):
        self.pid(43, comm='应用', argv=None, fds={})
        (self.root / '43/status').write_text(f'Name:\t应用\nUid:\t{self.uid}\t{self.uid}\t{self.uid}\t{self.uid}\n')
        self.assertEqual(len(self.observe()['ownership']['entries']), 1)

    def test_starttime_uid_cmdline_and_fd_instability_invalidate_all_exemptions(self):
        for change in ('starttime', 'uid', 'cmdline', 'fd'):
            self.stat(42); self.uid_status(42); self.cmdline(42, self.argv())
            link = self.root / '42/fd/7'; link.unlink(); link.symlink_to('socket:[100]')
            observer = self.new_observer(); original = observer._process_meta; counts = {}
            def drift(descriptor, pid, details):
                result = original(descriptor, pid, details); counts[pid] = counts.get(pid, 0) + 1
                if pid == '42' and counts[pid] == 1:
                    if change == 'starttime': self.stat(42, started=9999)
                    elif change == 'uid': self.uid_status(42, self.uid + 1)
                    elif change == 'cmdline': self.cmdline(42, self.argv(**{'-container-port': '8081'}))
                return result
            observer._process_meta = drift
            if change == 'fd':
                original_links = observer._fd_links; link_calls = [0]
                def fd_drift(*args):
                    result = original_links(*args); link_calls[0] += 1
                    if link_calls[0] == 3: link.unlink(); link.symlink_to('socket:[101]')
                    return result
                observer._fd_links = fd_drift
            with self.subTest(change=change):
                result = observer.observe([self.raw]); self.assertFalse(result['ownership']['processScanComplete']); self.assertFalse(result['ownership']['entries'])

    def test_unknown_or_unreadable_pid_ownership_yields_no_exemptions(self):
        original = self.observer._process_meta
        def unreadable(descriptor, pid, details):
            if pid == '42': raise PermissionError('simulated unreadable PID')
            return original(descriptor, pid, details)
        self.observer._process_meta = unreadable
        result = self.observe(); self.assertTrue(result['observation']['complete']); self.assertFalse(result['ownership']['entries'])
        with self.assertRaises(ValueError): P.verify_port_claims([self.plan], [self.raw], [self.raw['Id']], result['observation'], prove_host_socket_owner=self.observer.prove_host_socket_owner)

    def test_socket_table_or_host_namespace_drift_fails_complete_observation(self):
        original = self.observer._processes
        def drift(*args):
            result = original(*args)
            with (self.root / 'net/tcp').open('a') as stream: stream.write(row(index=1, port=18081, inode=0, state='06'))
            return result
        self.observer._processes = drift
        with self.assertRaisesRegex(ValueError, 'snapshot changed'): self.observe()

    def test_pid_enumeration_drift_discards_ownership_receipt(self):
        original = self.observer._pids; count = 0
        def drift():
            nonlocal count
            count += 1
            return original() if count == 1 else original() + ['999']
        self.observer._pids = drift
        result = self.observe(); self.assertFalse(result['ownership']['processScanComplete']); self.assertFalse(result['ownership']['entries'])

    def test_result_mutation_and_wrong_full_snapshot_cannot_forge_proof(self):
        result = self.observe(); socket = copy.deepcopy(result['observation']['sockets'][0])
        result['ownership']['entries'][0]['containerId'] = 'f' * 64
        altered = copy.deepcopy(self.raw); altered['Config']['Env'].append('CHANGED=1')
        self.assertFalse(self.observer.prove_host_socket_owner(socket, altered, self.binding))
        bad_socket = dict(socket, inode=999); self.assertFalse(self.observer.prove_host_socket_owner(bad_socket, self.raw, self.binding))
        bad_binding = dict(self.binding, containerPort='9090/tcp'); self.assertFalse(self.observer.prove_host_socket_owner(socket, self.raw, bad_binding))
        self.assertTrue(self.observer.prove_host_socket_owner(socket, self.raw, self.binding))

    def test_failed_reobservation_clears_previously_valid_owner_evidence(self):
        result = self.observe(); socket = result['observation']['sockets'][0]
        (self.root / 'net/udp6').unlink()
        with self.assertRaises((OSError, ValueError)): self.observe()
        self.assertFalse(self.observer.prove_host_socket_owner(socket, self.raw, self.binding))

    def test_expired_deadline_prevents_reads_and_stale_proof(self):
        result = self.observe()
        with mock.patch.object(M.time, 'time', return_value=self.observer.deadline + 1):
            with mock.patch.object(self.observer, '_read', side_effect=AssertionError('must not read')):
                with self.assertRaises(M.LimitError): self.observe()
            self.assertFalse(self.observer.prove_host_socket_owner(result['observation']['sockets'][0], self.raw, self.binding))

    def test_monotonic_deadline_prevents_wall_clock_rollback_from_extending_observation(self):
        with mock.patch.object(M.time, 'time', return_value=self.observer.deadline - 10):
            with mock.patch.object(M.time, 'monotonic', return_value=self.observer._monotonic_deadline + 1):
                with self.assertRaises(M.LimitError): self.observe()

    def test_deadline_beyond_thirty_seconds_and_noninteger_values_fail(self):
        for deadline in (int(time.time()) - 1, int(time.time()) + 32, time.time() + 20, True):
            with self.subTest(deadline=deadline), self.assertRaises(ValueError):
                M.ProcPortObserver(deadline=deadline, proc_root=self.root, owner_uid=self.uid)

    def test_default_production_source_and_uid_cannot_be_changed_accidentally(self):
        with mock.patch.object(M.sys, 'platform', 'linux'), mock.patch.object(M.os, 'geteuid', return_value=0):
            observer = M.ProcPortObserver(deadline=int(time.time()) + 20)
            self.assertEqual(observer.root, Path('/proc')); self.assertEqual(observer.owner_uid, 0)
            with self.assertRaises(ValueError): M.ProcPortObserver(deadline=int(time.time()) + 20, owner_uid=1)
        with self.assertRaises(ValueError): M.ProcPortObserver(deadline=int(time.time()) + 20, proc_root='relative')

    def test_byte_row_pid_and_fd_bounds_fail_before_availability_claim(self):
        for constant, value in (('MAX_BYTES', 1), ('MAX_TABLE_BYTES', 32), ('MAX_ROWS', 0), ('MAX_PIDS', 1), ('MAX_PROC_ENTRIES', 0), ('MAX_FDS', 0), ('MAX_PID_FDS', 0)):
            with self.subTest(bound=constant), mock.patch.object(M, constant, value):
                with self.assertRaises(M.LimitError): self.new_observer().observe([self.raw])

    def test_socket_table_symlink_is_never_followed(self):
        target = self.root / 'not-a-table'; target.write_text('MUST_NOT_BE_READ')
        path = self.root / 'net/tcp'; path.unlink(); path.symlink_to(target)
        with self.assertRaises(OSError): self.observe()

    def test_udp_ipv6_host_proxy_with_exact_approved_container_endpoint_is_proven(self):
        (self.root / 'net/udp6').write_text(HEADER + row(address='::1', port=19090, inode=200, state='07'))
        self.pid(43, argv=self.argv(**{'-proto': 'udp', '-host-ip': '::1', '-host-port': '19090', '-container-port': '9090'}), fds={8: 200})
        result = self.observe(); self.assertEqual(len(result['ownership']['entries']), 2)
        udp = next(item for item in result['observation']['sockets'] if item['protocol'] == 'udp')
        binding = {'containerId': self.raw['Id'], 'containerPort': '9090/udp', 'protocol': 'udp', 'address': '::1', 'port': 19090}
        self.assertTrue(self.observer.prove_host_socket_owner(udp, self.raw, binding))

    def test_namespace_link_text_must_match_the_followed_inode(self):
        directory = self.root / 'self/ns'; fake = directory / 'net:[123]'
        os.link(self.namespace_file, fake)
        link = directory / 'net'; link.unlink(); link.symlink_to(fake.name)
        with self.assertRaisesRegex(ValueError, 'inode mismatch'): self.observe()

    def test_pid_directory_replacement_is_not_a_stable_proxy_identity(self):
        import shutil
        original = self.observer._process_meta; count = 0
        def replace(descriptor, pid, details):
            nonlocal count
            result = original(descriptor, pid, details)
            if pid == '42':
                count += 1
                if count == 1:
                    (self.root / '42').rename(self.root / 'previous-proxy')
                    shutil.copytree(self.root / 'previous-proxy', self.root / '42', symlinks=True)
            return result
        self.observer._process_meta = replace
        result = self.observe(); self.assertFalse(result['ownership']['processScanComplete']); self.assertFalse(result['ownership']['entries'])

    def test_ownership_structure_has_only_recognized_proxy_fields_and_hashes(self):
        result = self.observe(); text = str(result['ownership'])
        self.assertNotIn('Env', text); self.assertNotIn('cmdline\x00', text)
        entry = result['ownership']['entries'][0]
        self.assertEqual(entry['snapshotSha256'], M.digest(self.raw))
        self.assertEqual(set(entry['process']), {'pid', 'starttime', 'uid', 'cmdlineSha256', 'proxy', 'fds'})


class ObservationUnionTests(unittest.TestCase):
    def setUp(self):
        self.namespace = {'device': 1, 'inode': 42, 'link': 'net:[42]'}
        self.socket = {'protocol': 'tcp', 'address': '127.0.0.1', 'port': 18080, 'inode': 100, 'v6only': None}
        ownership = {'version': 1, 'namespace': self.namespace, 'processScanComplete': False,
                     'retirementSnapshots': {}, 'entries': [], 'coverage': {'tcpBoundInactive': False}}
        ownership['ownershipSha256'] = M.digest(ownership)
        self.proc = {'observation': {'complete': True, 'namespace': 'host', 'protocols': ['tcp', 'udp'], 'sockets': [self.socket]},
                     'ownership': ownership}
        self.diag = {'version': 1, 'complete': True, 'tcpBoundInactive': True, 'reason': 'ok', 'sockets': [copy.deepcopy(self.socket)],
                     'namespace': {'self': self.namespace, '1': self.namespace},
                     'selfProof': {'closed': True, 'families': [
                         {'family': 2, 'address': '127.0.0.1', 'port': 40001, 'inode': 1001, 'uid': 0, 'requestedState': 13, 'state': 7},
                         {'family': 10, 'address': '::1', 'port': 40002, 'inode': 1002, 'uid': 0, 'requestedState': 13, 'state': 13}]}}
        self.seal()

    def seal(self):
        self.diag.pop('evidenceSha256', None)
        data = M.json.dumps(self.diag, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
        self.diag['evidenceSha256'] = M.hashlib.sha256(data).hexdigest()

    def union(self): return M.combine_port_observations(self.proc, self.diag)

    def test_native_bound_only_tcp_and_complete_udp_are_both_preserved(self):
        udp = {**self.socket, 'protocol': 'udp', 'port': 19090, 'inode': 300}
        inactive = {**self.socket, 'port': 18081, 'inode': 200}
        self.proc['observation']['sockets'].append(udp)
        self.diag['sockets'].append(inactive); self.seal()
        value = self.union()
        self.assertEqual(len(value['sockets']), 3)
        self.assertIn(udp, value['sockets']); self.assertIn(inactive, value['sockets'])
        self.assertEqual(value['protocols'], ['tcp', 'udp'])

    def test_missing_bound_coverage_or_unclosed_or_wrong_family_proof_fails(self):
        changes = [lambda x: x.update(complete=False), lambda x: x.update(tcpBoundInactive=False),
                   lambda x: x['selfProof'].update(closed=False), lambda x: x['selfProof']['families'].pop(),
                   lambda x: x['selfProof']['families'][0].update(uid=1),
                   lambda x: x['selfProof']['families'][0].update(requestedState=7),
                   lambda x: x['selfProof']['families'][0].update(state=1),
                   lambda x: x['selfProof']['families'][0].update(address='0.0.0.0')]
        original = copy.deepcopy(self.diag)
        for change in changes:
            self.diag = copy.deepcopy(original); change(self.diag); self.seal()
            with self.subTest(change=change), self.assertRaises(ValueError): self.union()

    def test_native_result_and_namespace_cannot_be_substituted(self):
        self.diag['sockets'][0]['port'] = 18082
        with self.assertRaises(ValueError): self.union()
        self.seal()
        self.diag['namespace'] = {'self': {'device': 1, 'inode': 43, 'link': 'net:[43]'},
                                  '1': {'device': 1, 'inode': 43, 'link': 'net:[43]'}}
        self.seal()
        with self.assertRaises(ValueError): self.union()

    def test_same_positive_inode_with_changed_tuple_is_never_deduplicated(self):
        self.diag['sockets'][0]['address'] = '0.0.0.0'; self.seal()
        with self.assertRaises(ValueError): self.union()

    def test_duplicate_positive_inode_inside_one_collector_fails(self):
        self.diag['sockets'].append(copy.deepcopy(self.socket)); self.seal()
        with self.assertRaises(ValueError): self.union()

    def test_zero_inode_conflicts_are_preserved_without_ownership(self):
        self.diag['sockets'].extend([{**self.socket, 'inode': 0}, {**self.socket, 'inode': 0, 'port': 18081}]); self.seal()
        self.assertEqual(sum(item['inode'] == 0 for item in self.union()['sockets']), 2)

    def test_v6_unknown_stays_conservative_and_contradictions_fail(self):
        self.proc['observation']['sockets'] = [{**self.socket, 'address': '::', 'v6only': None}]
        self.diag['sockets'] = [{**self.socket, 'address': '::', 'v6only': True}]; self.seal()
        self.assertIsNone(self.union()['sockets'][0]['v6only'])
        self.proc['observation']['sockets'][0]['v6only'] = False
        with self.assertRaises(ValueError): self.union()

    def test_udp_from_tcp_diagnostic_and_leaked_closed_probe_are_rejected(self):
        self.diag['sockets'][0]['protocol'] = 'udp'; self.seal()
        with self.assertRaises(ValueError): self.union()
        self.diag['sockets'][0].update(protocol='tcp', inode=1001); self.seal()
        with self.assertRaises(ValueError): self.union()

    def test_bound_only_conflict_reaches_existing_policy_without_new_exemption(self):
        fixture = ObserverTests(); fixture.setUp(); self.addCleanup(fixture.tearDown)
        proc = fixture.observe()
        self.diag['namespace'] = {'self': proc['ownership']['namespace'], '1': proc['ownership']['namespace']}
        self.seal()
        value = M.combine_port_observations(proc, self.diag)
        self.assertTrue(P.verify_port_claims([fixture.plan], [fixture.raw], [fixture.raw['Id']], value,
                                            prove_host_socket_owner=fixture.observer.prove_host_socket_owner))
        self.diag['sockets'].append({**self.socket, 'inode': 200}); self.seal()
        value = M.combine_port_observations(proc, self.diag)
        with self.assertRaises(ValueError):
            P.verify_port_claims([fixture.plan], [fixture.raw], [fixture.raw['Id']], value,
                                 prove_host_socket_owner=fixture.observer.prove_host_socket_owner)


if __name__ == '__main__': unittest.main()
