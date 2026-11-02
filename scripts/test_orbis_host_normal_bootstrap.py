import copy
import importlib.util
import json
import socket
from pathlib import Path
import threading
import time
import unittest
from unittest import mock

import test_orbis_host_retained_restore as R
S, D = R.S, R.D

spec = importlib.util.spec_from_file_location('bootstrap_validation_tests', Path(__file__).with_name('orbis-host-normal-bootstrap.py'))
B = importlib.util.module_from_spec(spec); spec.loader.exec_module(B)


class BootstrapValidationTests(unittest.TestCase):
    def test_broker_requires_zero_ready_and_unacknowledged_messages_and_exact_consumers(self):
        values = [{'name': name, 'messages_ready': 0, 'messages_unacknowledged': 0, 'consumers': 1} for name in B.QUEUES]
        self.assertEqual([item['name'] for item in B.queues(list(reversed(values)), 1)], B.QUEUES)
        for key in ('messages_ready', 'messages_unacknowledged', 'consumers'):
            for bad in (True, 1 if key != 'consumers' else 2, 0.0):
                changed = copy.deepcopy(values); changed[0][key] = bad
                with self.subTest(key=key, bad=bad), self.assertRaises(ValueError): B.queues(changed, 1)
        with self.assertRaises(ValueError): B.queues([values[0], values[0], values[2]], 1)
        with self.assertRaises(ValueError): B.queues(values + [{'name': 'rpc-reply'}], 1)

    def test_every_consumer_channel_and_connection_is_bound_to_actual_candidate_peer(self):
        consumers = [{'queue_name': name, 'channel_pid': 'channel-' + str(i), 'consumer_tag': 'consumer-' + str(i),
                      'ack_required': True, 'prefetch_count': 3, 'active': True, 'arguments': {}} for i, name in enumerate(B.QUEUES)]
        channels = [{'pid': 'channel-' + str(i), 'connection': 'connection', 'vhost': '/', 'consumer_count': 1,
                     'messages_unacknowledged': 0} for i in range(3)]
        connections = [{'pid': 'connection', 'peer_host': '::ffff:172.20.0.2', 'vhost': '/', 'state': 'running'}]
        B.consumers(consumers, channels, connections, ['172.20.0.2'])
        for mutation in ('peer', 'unacked', 'foreign-channel', 'duplicate', 'no-ack', 'hidden-consumer'):
            a, b, c = copy.deepcopy(consumers), copy.deepcopy(channels), copy.deepcopy(connections)
            if mutation == 'peer': c[0]['peer_host'] = '172.20.0.3'
            if mutation == 'unacked': b[0]['messages_unacknowledged'] = 1
            if mutation == 'foreign-channel': a[0]['channel_pid'] = 'unknown'
            if mutation == 'duplicate': a[0]['queue_name'] = a[1]['queue_name']
            if mutation == 'no-ack': a[0]['ack_required'] = False
            if mutation == 'hidden-consumer': b.append({**b[0], 'pid': 'hidden'})
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): B.consumers(a, b, c, ['172.20.0.2'])

    def test_receipt_has_exact_proof_runtime_lease_generation_and_time(self):
        record = {'id': 'restore', 'pointId': 'point', 'candidateId': 'candidate'}
        proof = {'proofSha256': 'a' * 64, 'operationSha256': 'b' * 64}
        lease = {'id': 'lease', 'startedAt': 1000, 'expiresAt': 901000}
        value = {'version': 1, 'transactionId': 'restore', 'pointId': 'point', 'candidateId': 'candidate',
                 'terminalProofSha256': proof['proofSha256'], 'operationSha256': proof['operationSha256'], 'bootstrapLeaseId': 'lease',
                 'queueGeneration': 1, 'readyAt': 1001,
                 'queues': [{'name': name, 'messagesReady': 0, 'consumers': 1} for name in B.QUEUES]}
        self.assertEqual(B.receipt(value, record, proof, lease, 1002), value)
        for key, bad in [('queueGeneration', 0), ('queueGeneration', True), ('readyAt', 999), ('readyAt', 1003),
                         ('bootstrapLeaseId', 'other'), ('operationSha256', 'f' * 64), ('version', True)]:
            with self.subTest(key=key, bad=bad), self.assertRaises(ValueError): B.receipt({**value, key: bad}, record, proof, lease, 1002)
        with self.assertRaises(ValueError): B.receipt(value, record, proof, lease, lease['expiresAt'])
        changed = copy.deepcopy(value); changed['queues'][0]['messagesUnacknowledged'] = 0
        with self.assertRaises(ValueError): B.receipt(changed, record, proof, lease, 1002)


class BootstrapTransactionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = R.RetainedRestoreTests(); self.fixture.setUp(); self.addCleanup(self.fixture.doCleanups)
        self.manager, self.runtime = self.fixture.manager, self.fixture.runtime
        self.fixture.begin(); self.identifier = self.fixture.request['restoreId']; self.key = self.fixture.key
        self.manager.prepare(self.identifier, self.key); self.manager.activate(self.identifier, self.key)
        record = self.manager.read(self.identifier); record['normalBootstrapRequired'] = True; self.manager.save(record)
        self.proof = self.manager.terminal_proof(self.identifier, self.key)
        self.material = {'candidateStartedAt': 'candidate-start-1', 'brokerStartedAt': 'broker-start-1'}
        self.runtime.normal_bootstrap_material = mock.Mock(side_effect=lambda *_: dict(self.material))
        self.runtime.normal_bootstrap_ready = mock.Mock(return_value={'nodeReceiptSha256': 'f' * 64, 'brokerAttestationSha256': 'e' * 64})
        self.runtime.verify_normal_bootstrap_decision = mock.Mock()
        self.runtime.restart_normal_bootstrap = mock.Mock()

    def settle(self):
        return self.manager.terminal_finalize(self.identifier, self.key, self.proof['proofSha256'])

    def lease(self):
        return self.manager.normal_bootstrap(self.identifier, self.key, self.proof['proofSha256'])

    def complete(self, lease):
        return self.manager.normal_bootstrap_complete(self.identifier, self.key, self.proof['proofSha256'], lease['bootstrapLeaseId'])

    def test_new_commit_holds_marker_and_responder_through_bootstrap_until_root_verified_ready(self):
        self.settle()
        self.assertEqual(self.manager.maintenance(), {'state': 'checking'})
        self.assertNotIn('overlay-finish', self.runtime.events)
        lease = self.lease(); self.assertEqual(self.lease(), lease)
        self.assertEqual(lease['operationSha256'], self.proof['operationSha256'])
        self.assertEqual(lease['terminalProofSha256'], self.proof['proofSha256'])
        self.assertEqual(self.complete(lease), {'version': 1, 'transactionId': self.identifier, 'state': 'ready',
                                              'terminalProofSha256': self.proof['proofSha256']})
        self.assertTrue(self.manager.read(self.identifier)['normalBootstrapReady'])
        self.assertEqual(self.manager.maintenance(), {'state': 'idle'})

    def test_root_status_discriminates_new_required_scope_from_legacy_terminal(self):
        pending = self.manager.normal_bootstrap_status(self.identifier, self.key, self.proof['proofSha256'])
        self.assertEqual((pending['required'], pending['state']), (True, 'pending'))
        self.assertIsNone(pending['bootstrapLeaseId'])
        record = self.manager.read(self.identifier); record.pop('normalBootstrapRequired'); self.manager.save(record)
        old = self.manager.normal_bootstrap_status(self.identifier, self.key, self.proof['proofSha256'])
        self.assertEqual((old['required'], old['state']), (False, 'not-required'))
        record['normalBootstrapRequired'] = True; self.manager.save(record); self.settle(); self.complete(self.lease())
        ready = self.manager.normal_bootstrap_status(self.identifier, self.key, self.proof['proofSha256'])
        self.assertEqual((ready['required'], ready['state']), (True, 'ready'))
        self.assertEqual(ready['bootstrapLeaseId'], self.manager.read(self.identifier)['normalBootstrapLease']['id'])
        with self.assertRaises(ValueError): self.manager.normal_bootstrap_status(self.identifier, self.key, '0' * 64)

    def test_lease_cannot_renew_or_survive_candidate_broker_drift_expiry_or_wrong_authority(self):
        with self.assertRaises(ValueError): self.lease()
        self.settle(); lease = self.lease()
        with self.assertRaises(ValueError): self.manager.normal_bootstrap(self.identifier, '0' * 64, self.proof['proofSha256'])
        with self.assertRaises(ValueError): self.manager.normal_bootstrap(self.identifier, self.key, '0' * 64)
        with self.assertRaises(ValueError): self.manager.normal_bootstrap_complete(self.identifier, self.key, self.proof['proofSha256'], 'wrong')
        self.material['brokerStartedAt'] = 'restarted'
        with self.assertRaises(ValueError): self.lease()
        self.material['brokerStartedAt'] = 'broker-start-1'
        record = self.manager.read(self.identifier); record['normalBootstrapLease']['startedAt'] -= 900001; record['normalBootstrapLease']['expiresAt'] -= 900001
        self.manager.save(record)
        with self.assertRaises(ValueError): self.lease()
        self.runtime.normal_bootstrap_ready.side_effect = ValueError('expired proof')
        with self.assertRaises(ValueError): self.complete(lease)
        self.assertEqual(self.manager.maintenance(), {'state': 'checking'})

    def test_lost_ack_reconciles_marker_without_rechecking_later_user_data(self):
        self.settle(); lease = self.lease()
        with mock.patch.object(self.manager, 'clear_marker', side_effect=RuntimeError('interrupted marker cleanup')):
            with self.assertRaises(RuntimeError): self.complete(lease)
        self.assertTrue(self.manager.read(self.identifier)['normalBootstrapReady'])
        self.assertEqual(self.manager.maintenance(), {'state': 'checking'})
        self.runtime.normal_bootstrap_ready.side_effect = AssertionError('must not revisit later mutable app data')
        result = self.complete(lease)
        self.assertEqual(self.complete(lease), result)
        self.assertEqual(self.runtime.normal_bootstrap_ready.call_count, 1)
        self.assertEqual(self.manager.maintenance(), {'state': 'idle'})

    def test_first_stage_retry_cannot_clear_marker_while_ready_overlay_cleanup_is_incomplete(self):
        self.settle(); lease = self.lease()
        with mock.patch.object(self.runtime, 'finish_overlay', side_effect=RuntimeError('interrupted overlay stop')):
            with self.assertRaises(RuntimeError): self.complete(lease)
        self.assertTrue(self.manager.read(self.identifier)['normalBootstrapReady'])
        self.assertEqual(self.manager.maintenance(), {'state': 'checking'})
        before = self.runtime.events.count('overlay-finish')
        self.settle()
        self.assertEqual(self.runtime.events.count('overlay-finish'), before + 1)
        self.assertEqual(self.manager.maintenance(), {'state': 'idle'})
        self.assertEqual(self.runtime.normal_bootstrap_ready.call_count, 1)

    def test_protected_restart_revokes_bootstrap_lease_and_keeps_commit_locked(self):
        self.settle(); old = self.lease()
        self.manager.resume_pending()
        record = self.manager.read(self.identifier)
        self.assertIsNone(record['normalBootstrapLease']); self.assertEqual(record['decision'], 'commit')
        self.assertEqual(self.manager.maintenance(), {'state': 'checking'})
        self.runtime.restart_normal_bootstrap.assert_called_once()
        self.assertNotEqual(self.lease()['bootstrapLeaseId'], old['bootstrapLeaseId'])

    def test_actual_unix_routes_keep_exact_body_and_peer_boundary(self):
        self.settle(); endpoint = self.fixture.base / 'bootstrap.sock'
        server = S.UnixHTTPServer(str(endpoint), S.Handler); server.service = type('Service', (), {'retained_restores': lambda _: self.manager})()
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        def call(action, body):
            wire = json.dumps(body).encode()
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(5); connection.connect(str(endpoint))
                header = ('POST /v1/retained-restore/' + self.identifier + '/' + action + ' HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: '
                          + str(len(wire)) + '\r\n\r\n').encode()
                connection.sendall(header + wire)
                chunks = []
                while block := connection.recv(65536): chunks.append(block)
            headers, payload = b''.join(chunks).split(b'\r\n\r\n', 1)
            return int(headers.split(b' ', 2)[1]), json.loads(payload)
        request = {'token': self.key, 'terminalProofSha256': self.proof['proofSha256']}
        with mock.patch.object(S, 'trusted_capture_peer', return_value=True):
            status, required = call('normal-bootstrap-status', request); self.assertEqual(status, 200)
            self.assertEqual((required['required'], required['state']), (True, 'pending'))
            status, lease = call('normal-bootstrap', request); self.assertEqual(status, 200)
            self.assertEqual(call('normal-bootstrap', {**request, 'extra': True})[0], 409)
            self.assertEqual(call('normal-bootstrap-complete', {**request, 'bootstrapLeaseId': lease['bootstrapLeaseId']})[0], 200)
        with mock.patch.object(S, 'trusted_capture_peer', return_value=False):
            self.assertEqual(call('normal-bootstrap', request)[0], 409)

    def test_new_capability_precommit_rollback_still_has_no_bootstrap_requirement(self):
        fixture = R.RetainedRestoreTests(); fixture.setUp(); self.addCleanup(fixture.doCleanups)
        fixture.begin(); identifier = fixture.request['restoreId']
        record = fixture.manager.read(identifier); record['normalBootstrapRequired'] = True; fixture.manager.save(record)
        fixture.manager.recover(identifier, fixture.key)
        proof = fixture.manager.terminal_proof(identifier, fixture.key)
        result = fixture.manager.normal_bootstrap_status(identifier, fixture.key, proof['proofSha256'])
        self.assertEqual((result['required'], result['state']), (False, 'not-required'))
        fixture.manager.terminal_finalize(identifier, fixture.key, proof['proofSha256'])
        self.assertEqual(fixture.manager.maintenance(), {'state': 'idle'})


class BootstrapDriverTests(unittest.TestCase):
    def setUp(self):
        self.fixture = R.RetainedRestoreTests(); self.fixture.setUp(); self.addCleanup(self.fixture.doCleanups)
        self.fixture.begin(); self.manager = self.fixture.manager; self.record = self.manager.read(self.fixture.request['restoreId'])
        self.driver = D.DockerRestoreRuntime(self.manager)
        network = 'a' * 64
        self.candidate = {'Id': self.record['candidateId'], 'Image': 'sha256:' + 'c' * 64, 'Name': '/runtipi',
                          'Config': {'Env': ['NODE_ENV=production'], 'Labels': {}},
                          'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0}}, 'Mounts': [],
                          'State': {'Running': True, 'StartedAt': 'candidate-start-1', 'Health': {'Status': 'healthy'}},
                          'NetworkSettings': {'Networks': {'core': {'NetworkID': network, 'IPAddress': '172.20.0.2'}}}}
        self.broker = copy.deepcopy(self.candidate)
        self.broker.update(Id='5' * 64, Name='/runtipi-queue', Image='sha256:' + 'e' * 64)
        self.broker['Config']['Labels'] = {'com.docker.compose.project': 'runtipi', 'com.docker.compose.service': 'runtipi-queue',
                                            'com.docker.compose.project.working_dir': str(self.fixture.root)}
        self.broker['State']['StartedAt'] = 'broker-start-1'
        self.broker['NetworkSettings']['Networks']['core']['IPAddress'] = '172.20.0.3'
        self.driver.inspect = lambda identifier: copy.deepcopy(self.broker if identifier in {'runtipi-queue', self.broker['Id']} else self.candidate)
        self.record['source']['container'] = copy.deepcopy(self.candidate)
        self.record['source']['proxyHostIdentity'] = {'fixture': 'preserve-live-identity'}
        self.manager.service.proxy_host_identity = mock.Mock(return_value={'descriptor': copy.deepcopy(self.record['source']['proxyHostIdentity'])})
        self.record['normalBootstrapQueue'] = self.driver.bootstrap_queue_binding(self.record)
        self.proof = {'proofSha256': 'a' * 64, 'operationSha256': 'b' * 64,
                      'survivor': {'id': self.candidate['Id'], 'definitionSha256': self.driver.definition(self.candidate)}, 'database': {}}
        self.driver.terminal_survivor_database = mock.Mock(return_value=(self.proof['survivor'], self.proof['database']))
        now = int(time.time() * 1000)
        self.lease = {'id': self.fixture.request['restoreId'], 'startedAt': now - 1, 'expiresAt': now + 899999,
                      **self.driver.normal_bootstrap_material(self.record, self.proof)}
        journal = self.fixture.base / 'journal'; journal.mkdir(mode=0o700)
        self.record['stage']['journalPath'] = str(journal)
        ready = journal / 'normal-bootstrap' / self.lease['id']; ready.mkdir(mode=0o700, parents=True)
        self.receipt = {'version': 1, 'transactionId': self.record['id'], 'pointId': self.record['pointId'],
                        'terminalProofSha256': self.proof['proofSha256'], 'operationSha256': self.proof['operationSha256'],
                        'candidateId': self.record['candidateId'], 'bootstrapLeaseId': self.lease['id'], 'queueGeneration': 1,
                        'queues': [{'name': name, 'messagesReady': 0, 'consumers': 1} for name in B.QUEUES], 'readyAt': now}
        self.receipt_path = ready / 'ready.json'; self.receipt_path.write_bytes(self.driver.P.canonical(self.receipt)); self.receipt_path.chmod(0o600)
        self.outputs = {
            'list_queues': [{'name': name, 'messages_ready': 0, 'messages_unacknowledged': 0, 'consumers': 1} for name in B.QUEUES],
            'list_consumers': [{'queue_name': name, 'channel_pid': 'channel-' + str(i), 'consumer_tag': 'consumer-' + str(i),
                                'ack_required': True, 'prefetch_count': 3, 'active': True, 'arguments': {}} for i, name in enumerate(B.QUEUES)],
            'list_channels': [{'pid': 'channel-' + str(i), 'connection': 'connection', 'vhost': '/', 'consumer_count': 1,
                              'messages_unacknowledged': 0} for i in range(3)],
            'list_connections': [{'pid': 'connection', 'peer_host': '172.20.0.2', 'vhost': '/', 'state': 'running'}],
        }
        self.commands = []
        def output(arguments, maximum, timeout):
            self.commands.append(arguments)
            self.assertEqual(arguments[:7], ['docker', '--context', 'fixture', 'exec', self.broker['Id'], 'rabbitmqctl', '--quiet'])
            command = arguments[10]; self.assertIn(command, self.outputs)
            self.assertLessEqual(timeout, 7); self.assertGreater(timeout, 0)
            return self.driver.P.canonical(self.outputs[command])
        self.driver.bounded_output = output

    def test_actual_private_receipt_and_fixed_readonly_broker_queries_seal_root_readiness(self):
        digest = self.driver.normal_bootstrap_ready(self.record, self.proof, self.lease)
        self.assertEqual(digest['nodeReceiptSha256'], D.hashed(self.receipt_path.read_bytes()))
        broker = self.manager.directory(self.record['id']) / 'normal-bootstrap-evidence' / self.lease['id'] / 'broker.json'
        self.assertEqual(digest['brokerAttestationSha256'], D.hashed(broker.read_bytes()))
        self.assertEqual(json.loads(broker.read_bytes())['queues'][0]['messagesUnacknowledged'], 0)
        self.assertEqual([item[10] for item in self.commands], ['list_queues', 'list_consumers', 'list_channels', 'list_connections', 'list_queues'])
        for item in self.commands:
            self.assertNotIn('eval', item); self.assertNotIn('publish', item); self.assertNotIn('purge_queue', item)
            if item[10] in {'list_queues', 'list_consumers'}: self.assertEqual(item[11:13], ['-p', '/'])
            else: self.assertNotIn('-p', item)

    def test_lost_root_ready_save_reuses_exact_lease_attestation_with_unordered_broker_rows(self):
        first = self.driver.normal_bootstrap_ready(self.record, self.proof, self.lease)
        for key in ('list_queues', 'list_consumers', 'list_channels', 'list_connections'): self.outputs[key].reverse()
        self.assertEqual(self.driver.normal_bootstrap_ready(self.record, self.proof, self.lease), first)

    def test_permanent_root_decision_is_usable_after_lease_expiry_without_live_data_checks(self):
        evidence = self.driver.normal_bootstrap_ready(self.record, self.proof, self.lease)
        self.record['normalBootstrapLease'] = self.lease
        self.record['normalBootstrapReceiptSha256'] = evidence['nodeReceiptSha256']
        self.record['normalBootstrapBrokerSha256'] = evidence['brokerAttestationSha256']
        self.driver.inspect = mock.Mock(side_effect=AssertionError('must not recheck later mutable runtime'))
        with mock.patch.object(D.time, 'time', return_value=(self.lease['expiresAt'] + 1000) / 1000):
            self.driver.verify_normal_bootstrap_decision(self.record, self.proof)
        self.record['normalBootstrapBrokerSha256'] = '0' * 64
        with self.assertRaises(ValueError): self.driver.verify_normal_bootstrap_decision(self.record, self.proof)

    def test_root_ignores_claimed_empty_queue_when_actual_broker_has_unacked_work_or_wrong_peer(self):
        self.outputs['list_queues'][0]['messages_unacknowledged'] = 1
        with self.assertRaises(ValueError): self.driver.normal_bootstrap_ready(self.record, self.proof, self.lease)
        self.outputs['list_queues'][0]['messages_unacknowledged'] = 0
        self.outputs['list_connections'][0]['peer_host'] = '172.20.0.99'
        with self.assertRaises(ValueError): self.driver.normal_bootstrap_ready(self.record, self.proof, self.lease)
        self.assertFalse((self.manager.directory(self.record['id']) / 'normal-bootstrap-receipt.json').exists())

    def test_actual_ipv6_candidate_peer_is_bound_to_the_same_approved_network(self):
        self.candidate['NetworkSettings']['Networks']['core'].update(IPAddress='', GlobalIPv6Address='fd00::2')
        self.outputs['list_connections'][0]['peer_host'] = 'fd00::2'
        self.assertEqual(self.driver.normal_bootstrap_ready(self.record, self.proof, self.lease)['nodeReceiptSha256'], D.hashed(self.receipt_path.read_bytes()))

    def test_source_broker_restart_and_changed_definition_cannot_redeem_old_lease(self):
        self.broker['State']['StartedAt'] = 'broker-restarted'
        with self.assertRaises(ValueError): self.driver.normal_bootstrap_ready(self.record, self.proof, self.lease)
        self.broker['State']['StartedAt'] = 'broker-start-1'
        self.broker['Config']['Env'].append('CHANGED=1')
        with self.assertRaises(ValueError): self.driver.normal_bootstrap_material(self.record, self.proof)

    def test_bootstrap_cannot_replace_live_proxy_identity_or_static_configuration(self):
        self.manager.service.proxy_host_identity.return_value = {'descriptor': {'fixture': 'unexpected-identity-or-static-change'}}
        with self.assertRaises(ValueError): self.driver.normal_bootstrap_ready(self.record, self.proof, self.lease)
        self.assertFalse((self.manager.directory(self.record['id']) / 'normal-bootstrap-receipt.json').exists())

    def test_pre_promotion_broker_barrier_independently_rejects_hidden_unacknowledged_work(self):
        for item in self.outputs['list_queues']: item['consumers'] = 0
        self.driver.bootstrap_queues_quiet(self.record)
        self.outputs['list_queues'][0]['messages_unacknowledged'] = 1
        with self.assertRaises(ValueError): self.driver.bootstrap_queues_quiet(self.record)

    def test_forward_bootstrap_restart_only_stops_and_starts_exact_bound_candidate(self):
        self.record['target']['creationReference'] = self.candidate['Image']
        def change(arguments):
            self.candidate['State']['Running'] = arguments[0] != 'stop'
        self.driver.change = mock.Mock(side_effect=change)
        self.driver.restart_normal_bootstrap(self.record, self.proof)
        self.assertEqual(self.driver.change.call_args_list, [mock.call(['stop', '--time', '30', self.candidate['Id']]), mock.call(['start', self.candidate['Id']])])
        self.driver.change.reset_mock(); self.candidate['Name'] = '/different'
        with self.assertRaises(ValueError): self.driver.restart_normal_bootstrap(self.record, self.proof)
        self.driver.change.assert_not_called()


if __name__ == '__main__': unittest.main()
