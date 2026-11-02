import copy
import importlib.util
from pathlib import Path
import unittest


def load(filename, name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


M = load('orbis-host-app-port-policy.py', 'app_port_policy_test')
F = load('test_orbis_host_app_create_intent.py', 'app_port_policy_actual_fixture')


def plan(ordinal=1, running=True):
    values = F.fixture(ordinal, running)
    return {'appUrn': values[0]['appUrn'], 'service': values[0]['service'], 'ordinal': ordinal,
            'sourceId': values[0]['inspect']['Id'], 'wasRunning': running, 'compiled': F.compile_fixture(values)}


def current(ordinal=1, running=True):
    values = F.fixture(ordinal, running)
    raw = F.created(values, F.compile_fixture(values), running)
    raw['Id'] = ('e' if ordinal == 1 else 'f') * 64
    raw['State'].update(Paused=False, Restarting=False)
    return raw


def socket(protocol='tcp', address='127.0.0.1', port=18080, inode=1, v6only=None):
    return {'protocol': protocol, 'address': address, 'port': port, 'inode': inode, 'v6only': v6only}


def envelope(sockets=None):
    return {'complete': True, 'namespace': 'host', 'protocols': ['tcp', 'udp'], 'sockets': sockets or []}


def bind(protected, address, port=18080, exposed='8080/tcp'):
    body = protected['compiled']['body']
    body['ExposedPorts'] = {exposed: {}}
    body['HostConfig']['PortBindings'] = {exposed: [{'HostIp': address, 'HostPort': str(port)}]}
    return protected


class PortPolicyTests(unittest.TestCase):
    def setUp(self):
        self.plan = plan(); self.current = current()

    def verify(self, plans=None, containers=None, retirement=None, sockets=None, proof=None):
        return M.verify_port_claims([self.plan] if plans is None else plans,
                                   [] if containers is None else containers,
                                   [] if retirement is None else retirement,
                                   envelope() if sockets is None else sockets,
                                   prove_host_socket_owner=proof)

    def test_no_observed_conflicts_in_complete_envelope(self):
        self.assertTrue(self.verify())

    def test_unrelated_running_container_conflicts_even_with_misleading_labels(self):
        self.current['Config']['Labels']['runtipi.appurn'] = self.plan['appUrn']
        with self.assertRaisesRegex(ValueError, 'non-retiring'): self.verify(containers=[self.current])

    def test_core_proxy_claim_is_checked_without_app_label_filter(self):
        self.current['Config']['Labels'] = {'orbis.component': 'proxy'}
        self.current['Name'] = '/core-proxy'
        with self.assertRaises(ValueError): self.verify(containers=[self.current])

    def test_protected_current_retirement_exempts_daemon_binding_by_full_id_only(self):
        self.assertTrue(self.verify(containers=[self.current], retirement=[self.current['Id']]))
        with self.assertRaises(ValueError): self.verify(containers=[self.current], retirement=[self.current['Id'][:12]])

    def test_arbitrary_host_listener_with_no_daemon_match_conflicts(self):
        with self.assertRaisesRegex(ValueError, 'ownership'): self.verify(sockets=envelope([socket()]))

    def test_same_retiring_tuple_without_independent_socket_ownership_proof_conflicts(self):
        with self.assertRaisesRegex(ValueError, 'ownership'):
            self.verify(containers=[self.current], retirement=[self.current['Id']], sockets=envelope([socket()]))

    def test_exact_kernel_inode_retiring_allocator_proof_allows_exemption(self):
        calls = []
        def proof(observed, raw, binding):
            calls.append((observed, raw, binding))
            return (observed['inode'] == 100 and raw['Id'] == self.current['Id']
                    and binding == {'containerId': self.current['Id'], 'containerPort': '8080/tcp',
                                    'protocol': 'tcp', 'address': '127.0.0.1', 'port': 18080})
        self.assertTrue(self.verify(containers=[self.current], retirement=[self.current['Id']],
                                    sockets=envelope([socket(inode=100)]), proof=proof))
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], self.current)

    def test_false_nonboolean_or_raising_ownership_callback_never_grants_exemption(self):
        for response in (False, None, 1, 'true'):
            with self.subTest(response=response), self.assertRaises(ValueError):
                self.verify(containers=[self.current], retirement=[self.current['Id']], sockets=envelope([socket()]), proof=lambda *_: response)
        def broken(*_): raise RuntimeError('unproven root collector')
        with self.assertRaises(RuntimeError):
            self.verify(containers=[self.current], retirement=[self.current['Id']], sockets=envelope([socket()]), proof=broken)

    def test_ownership_callback_never_receives_unrelated_daemon_binding(self):
        calls = []
        with self.assertRaises(ValueError):
            self.verify(containers=[self.current], sockets=envelope([socket()]), proof=lambda *args: calls.append(args) or True)
        self.assertFalse(calls)

    def test_matching_by_overlap_is_not_exact_socket_ownership_candidate(self):
        calls = []
        with self.assertRaises(ValueError):
            self.verify(containers=[self.current], retirement=[self.current['Id']],
                        sockets=envelope([socket(address='0.0.0.0')]), proof=lambda *args: calls.append(args) or True)
        self.assertFalse(calls)

    def test_callback_cannot_mutate_original_inputs(self):
        inputs = ([self.plan], [self.current], envelope([socket()]))
        before = copy.deepcopy(inputs)
        def proof(observed, raw, binding): observed.clear(); raw.clear(); binding.clear(); return True
        self.assertTrue(self.verify(plans=inputs[0], containers=inputs[1], retirement=[self.current['Id']], sockets=inputs[2], proof=proof))
        self.assertEqual(inputs, before)

    def test_mixed_running_and_stopped_replicas_may_share_fixed_requested_port(self):
        stopped = plan(2, False)
        self.assertTrue(self.verify(plans=[self.plan, stopped]))
        stopped['wasRunning'] = True
        with self.assertRaisesRegex(ValueError, 'desired'): self.verify(plans=[self.plan, stopped])

    def test_stopped_requests_are_validated_but_do_not_consume_active_ports(self):
        stopped = plan(2, False)
        self.assertTrue(self.verify(plans=[stopped], containers=[self.current], sockets=envelope([socket()])))
        stopped['compiled']['body']['HostConfig']['PortBindings']['8080/tcp'][0]['HostPort'] = '0'
        with self.assertRaises(ValueError): self.verify(plans=[stopped])

    def test_distinct_running_replicas_with_distinct_ports_remain_separate(self):
        second = bind(plan(2), '127.0.0.1', 18081)
        self.assertTrue(self.verify(plans=[self.plan, second]))

    def test_ipv4_wildcard_conflicts_with_specific_ipv4_in_both_directions(self):
        for desired, observed in [('0.0.0.0', '127.0.0.1'), ('127.0.0.1', '0.0.0.0')]:
            with self.subTest(desired=desired), self.assertRaises(ValueError):
                self.verify(plans=[bind(plan(), desired)], sockets=envelope([socket(address=observed)]))

    def test_distinct_specific_ipv4_addresses_do_not_overlap(self):
        self.assertTrue(self.verify(plans=[bind(plan(), '127.0.0.2')], sockets=envelope([socket()])))

    def test_ipv6_wildcard_conservatively_overlaps_ipv4_without_v6only_proof(self):
        for v6only in (None, False):
            with self.subTest(v6only=v6only), self.assertRaises(ValueError):
                self.verify(plans=[bind(plan(), '127.0.0.1')], sockets=envelope([socket(address='::', v6only=v6only)]))
        with self.assertRaises(ValueError):
            self.verify(plans=[bind(plan(), '::')], sockets=envelope([socket()]))

    def test_independently_proven_ipv6_only_wildcard_does_not_consume_ipv4(self):
        self.assertTrue(self.verify(plans=[bind(plan(), '127.0.0.1')], sockets=envelope([socket(address='::', v6only=True)])))

    def test_ipv6_specific_and_ipv4_wildcard_do_not_overlap(self):
        self.assertTrue(self.verify(plans=[bind(plan(), '2001:db8::1')], sockets=envelope([socket(address='0.0.0.0')])))

    def test_ipv6_wildcard_and_specific_ipv6_overlap_even_v6only_true(self):
        with self.assertRaises(ValueError):
            self.verify(plans=[bind(plan(), '2001:db8::1')], sockets=envelope([socket(address='::', v6only=True)]))

    def test_blank_desired_ip_is_universal_wildcard(self):
        for address in ('127.0.0.1', '2001:db8::1'):
            with self.subTest(address=address), self.assertRaises(ValueError):
                self.verify(plans=[bind(plan(), '')], sockets=envelope([socket(address=address)]))

    def test_ipv4_mapped_ipv6_cannot_bypass_ipv4_conflict(self):
        with self.assertRaises(ValueError):
            self.verify(plans=[bind(plan(), '::ffff:127.0.0.1')], sockets=envelope([socket()]))

    def test_exact_same_container_exposed_port_dual_family_expansion_is_allowed(self):
        desired = bind(plan(), '0.0.0.0')
        desired['compiled']['body']['HostConfig']['PortBindings']['8080/tcp'].append({'HostIp': '::', 'HostPort': '18080'})
        self.assertTrue(self.verify(plans=[desired]))
        second = bind(plan(2), '::')
        with self.assertRaises(ValueError): self.verify(plans=[desired, second])

    def test_same_container_different_exposed_port_cannot_claim_same_wildcard(self):
        desired = bind(plan(), '0.0.0.0')
        desired['compiled']['body']['ExposedPorts']['9090/tcp'] = {}
        desired['compiled']['body']['HostConfig']['PortBindings']['9090/tcp'] = [{'HostIp': '::', 'HostPort': '18080'}]
        with self.assertRaises(ValueError): self.verify(plans=[desired])

    def test_tcp_and_udp_same_host_tuple_do_not_conflict(self):
        self.assertTrue(self.verify(plans=[bind(plan(), '127.0.0.1')], sockets=envelope([socket(protocol='udp')])))
        self.assertTrue(self.verify(plans=[bind(plan(), '127.0.0.1'), bind(plan(2), '127.0.0.1', exposed='8080/udp')]))

    def test_sctp_is_explicitly_unsupported_for_requested_or_active_bindings(self):
        with self.assertRaisesRegex(ValueError, 'SCTP'): self.verify(plans=[bind(plan(), '127.0.0.1', exposed='8080/sctp')])
        raw = current(); raw['Config']['ExposedPorts']['8080/sctp'] = {}
        raw['NetworkSettings']['Ports']['8080/sctp'] = [{'HostIp': '127.0.0.1', 'HostPort': '18080'}]
        with self.assertRaisesRegex(ValueError, 'SCTP'): self.verify(containers=[raw])

    def test_publish_all_and_unresolved_desired_dynamic_allocations_are_refused(self):
        variants = [lambda p: p['compiled']['body']['HostConfig'].update(PublishAllPorts=True),
                    lambda p: p['compiled']['body']['HostConfig']['PortBindings']['8080/tcp'][0].update(HostPort='0'),
                    lambda p: p['compiled']['body']['HostConfig']['PortBindings']['8080/tcp'][0].update(HostPort=''),
                    lambda p: p['compiled']['body']['HostConfig']['PortBindings'].update({'8080/tcp': None}),
                    lambda p: p['compiled']['body']['HostConfig']['PortBindings'].update({'8080/tcp': []})]
        for index, change in enumerate(variants):
            desired = plan(); change(desired)
            with self.subTest(index=index), self.assertRaises(ValueError): self.verify(plans=[desired])

    def test_duplicate_bindings_and_invalid_port_address_protocol_fields_fail(self):
        variants = [('HostPort', '018080'), ('HostPort', '65536'), ('HostPort', 18080), ('HostIp', '::1%lo0'), ('HostIp', 'bad')]
        for key, value in variants:
            desired = plan(); desired['compiled']['body']['HostConfig']['PortBindings']['8080/tcp'][0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError): self.verify(plans=[desired])
        desired = plan(); rows = desired['compiled']['body']['HostConfig']['PortBindings']['8080/tcp']; rows.append(copy.deepcopy(rows[0]))
        with self.assertRaises(ValueError): self.verify(plans=[desired])

    def test_missing_partial_or_wrong_namespace_kernel_coverage_is_refused_even_without_requests(self):
        for bad in ([], {}, envelope() | {'complete': False}, envelope() | {'namespace': 'container'},
                    envelope() | {'protocols': ['tcp']}, envelope() | {'protocols': ['tcp', 'udp', 'sctp']}):
            with self.subTest(envelope=bad), self.assertRaises(ValueError): self.verify(plans=[], sockets=bad)
        self.assertTrue(self.verify(plans=[]))

    def test_partial_current_snapshots_are_never_evidence_of_daemon_absence(self):
        variants = [lambda r: r.pop('State'), lambda r: r['State'].pop('Running'), lambda r: r['HostConfig'].pop('PortBindings'),
                    lambda r: r['NetworkSettings'].pop('Ports'), lambda r: r['Config'].pop('ExposedPorts'),
                    lambda r: r['NetworkSettings'].update(Ports=None)]
        for index, change in enumerate(variants):
            raw = current(); change(raw)
            with self.subTest(index=index), self.assertRaises(ValueError): self.verify(plans=[], containers=[raw])

    def test_active_publish_all_observations_require_all_exposed_assignments(self):
        raw = current(); raw['HostConfig']['PublishAllPorts'] = True
        with self.assertRaises(ValueError): self.verify(plans=[], containers=[raw])
        raw['Config']['ExposedPorts'] = {key: {} for key in raw['NetworkSettings']['Ports']}
        self.assertTrue(self.verify(plans=[], containers=[raw]))

    def test_stopped_current_ports_are_not_active_but_stale_assigned_map_is_refused(self):
        raw = current(running=False)
        self.assertTrue(self.verify(containers=[raw]))
        raw['NetworkSettings']['Ports'] = copy.deepcopy(self.current['NetworkSettings']['Ports'])
        with self.assertRaises(ValueError): self.verify(containers=[raw])

    def test_duplicate_current_ids_and_absent_retirement_ids_are_refused(self):
        with self.assertRaises(ValueError): self.verify(containers=[self.current, self.current])
        with self.assertRaises(ValueError): self.verify(retirement=['e' * 64])
        with self.assertRaises(ValueError): self.verify(containers=[self.current], retirement=[self.current['Id'], self.current['Id']])

    def test_duplicate_kernel_inodes_and_invalid_record_fields_fail(self):
        with self.assertRaises(ValueError): self.verify(sockets=envelope([socket(), socket()]))
        variants = [lambda s: s.update(port=True), lambda s: s.update(port=0), lambda s: s.update(inode=-1),
                    lambda s: s.update(protocol='sctp'), lambda s: s.update(address=''),
                    lambda s: s.update(v6only=True), lambda s: s.pop('v6only'), lambda s: s.update(unknown=True)]
        for index, change in enumerate(variants):
            row = socket(); change(row)
            with self.subTest(index=index), self.assertRaises(ValueError): self.verify(plans=[], sockets=envelope([row]))

    def test_plan_identity_and_compiled_image_integrity_are_required(self):
        variants = [lambda p: p.update(sourceId='short'), lambda p: p.update(wasRunning=1),
                    lambda p: p['compiled']['body'].update(Image='mutable:latest'),
                    lambda p: p['compiled']['body'].pop('ExposedPorts')]
        for index, change in enumerate(variants):
            desired = plan(); change(desired)
            with self.subTest(index=index), self.assertRaises(ValueError): self.verify(plans=[desired])
        with self.assertRaises(ValueError): self.verify(plans=[self.plan, self.plan])

    def test_stopped_replica_still_cannot_smuggle_invalid_or_unresolved_mapping(self):
        desired = plan(2, False); desired['compiled']['body']['HostConfig']['PortBindings']['8080/tcp'][0]['HostPort'] = '0'
        with self.assertRaises(ValueError): self.verify(plans=[desired])

    def test_inode_zero_conflict_cannot_be_exempted_even_with_true_ownership_callback(self):
        calls = []
        with self.assertRaisesRegex(ValueError, 'unowned'):
            self.verify(containers=[self.current], retirement=[self.current['Id']],
                        sockets=envelope([socket(inode=0)]), proof=lambda *args: calls.append(args) or True)
        self.assertFalse(calls)

    def test_duplicate_inode_zero_rows_are_valid_unowned_observations_for_unrelated_ports(self):
        sockets = envelope([socket(port=18081, inode=0), socket(port=18082, inode=0)])
        self.assertTrue(self.verify(sockets=sockets))
        self.assertTrue(self.verify(plans=[], sockets=envelope([socket(inode=0), socket(inode=0)])))

    def test_claim_and_socket_observation_bounds_are_enforced(self):
        desired = bind(plan(), '127.0.0.1')
        desired['compiled']['body']['HostConfig']['PortBindings']['8080/tcp'] = [
            {'HostIp': '127.0.0.1', 'HostPort': str(number)} for number in range(10000, 10065)]
        with self.assertRaises(ValueError): self.verify(plans=[desired])
        oversized = envelope(); oversized['sockets'] = [socket(inode=index + 1) for index in range(M.MAX_SOCKETS + 1)]
        with self.assertRaises(ValueError): self.verify(plans=[], sockets=oversized)

    def test_pathological_same_port_comparisons_fail_at_fixed_work_bound(self):
        previous = M.MAX_COMPARISONS
        M.MAX_COMPARISONS = 1
        try:
            desired = [bind(plan(index), '127.0.0.' + str(index)) for index in (1, 2, 3)]
            with self.assertRaisesRegex(ValueError, 'comparison bound'): self.verify(plans=desired)
        finally: M.MAX_COMPARISONS = previous

    def test_snapshot_recheck_catches_late_listener_without_mutating_observations(self):
        plans, containers, sockets = [self.plan], [], envelope()
        before = copy.deepcopy((plans, containers, sockets))
        self.assertTrue(M.verify_port_claims(plans, containers, [], sockets))
        self.assertEqual((plans, containers, sockets), before)
        sockets['sockets'].append(socket())
        with self.assertRaises(ValueError): M.verify_port_claims(plans, containers, [], sockets)


if __name__ == '__main__': unittest.main()
