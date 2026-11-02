import copy
import base64
import hashlib
import io
import tarfile
import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
import uuid
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


M = load('orbis-host-retained-restore.py', 'retained_restore_test')
D = load('orbis-host-retained-restore-runtime.py', 'retained_restore_driver_test')
S = load('orbis-host-service.py', 'retained_restore_service_test')


class Runtime:
    def __init__(self):
        self.events, self.fail_at, self.completed = [], None, False

    def event(self, name):
        self.events.append(name)
        if self.fail_at == name:
            raise RuntimeError('fixture interruption')

    def source_snapshot(self):
        return {'controllerId': '1' * 64, 'imageId': 'sha256:' + 'a' * 64}

    def review_stage(self, request, origin, source):
        return {'sourceBinding': {key: 'b' * 64 for key in ('originalJournalSha256', 'bootstrapSha256', 'admissionSha256',
                'sourceSealSha256', 'legacyManifestSha256', 'runtimeManifestSha256')}}

    def allocate(self, record, origin):
        record.update(workerId='2' * 64, candidateId='3' * 64, verifierId='4' * 64, nonce='c' * 64,
                      workerSnapshot={'Id': '2' * 64}, target={'publication': {'fixture': True}})
        self.event('allocate')

    def validate_worker(self, record):
        self.event('worker')

    def validate_rebind(self, record):
        self.event('rebind')

    def validate_overlay(self, record):
        self.event('overlay-check')

    def restore_overlay(self, record):
        self.event('overlay-recover')

    def execute_phase(self, record, phase, capsule):
        response = self.manager.redeem_phase(record['id'], {'version': 1, 'phase': phase, 'token': capsule['token']})
        status = self.manager.phase_status(record['id'], {'version': 1, 'phase': phase, 'sequence': response['sequence'], 'token': capsule['token']})
        if status['binding']['sourceBinding'] != record['stage']['sourceBinding'] or status['binding']['workerSnapshot'] != record['workerSnapshot']:
            raise AssertionError('phase binding changed')
        if response['candidateHealthy'] != (phase == 'commit' and response['commitStage'] == 'finish'):
            raise AssertionError('incorrect health grant')
        event = phase + (':' + response['commitStage'] if response['commitStage'] else '')
        self.event(event)
        if event == 'commit:finish':
            self.completed = True
        self.last_capsule = capsule
        self.last_response = response
        self.manager.complete_phase(record['id'], {'version': 1, 'phase': phase, 'sequence': response['sequence'], 'token': capsule['token']})

    def validate_prepared(self, record):
        self.event('prepared-check')

    def verify_historical_hold(self, record):
        self.event('historical-health')

    def validate_promoted(self, record):
        self.event('promoted-check')

    def compile_authority(self, record):
        self.event('authority')

    def commit_controller(self, record):
        if record['decision'] != 'commit' or self.manager.read(record['id'])['decision'] != 'commit':
            raise AssertionError('undurable commit')
        self.event('controller-commit')

    def activate_candidate(self, record):
        started = int(M.time.time() * 1000)
        record['candidateActivationLease'] = {'startedAt': started, 'expiresAt': started + 15 * 60 * 1000}
        self.manager.save(record)
        self.event('activation')

    def candidate_resume_material(self, record):
        self.event('candidate-resume')
        return {'operationSha256': 'a' * 64, 'imageCaptureSha256': 'b' * 64, 'imageInventorySha256': 'c' * 64}

    def assert_active(self, record):
        self.event('active-health')

    def pin_phase_operation(self, record, phase, commit_stage):
        self.event('pin-operation:' + phase)

    def node_commit_authorized(self, record):
        return record.get('commitAuthorized') is True and 'commit:authorize' in self.events

    def node_complete(self, record):
        return self.completed

    def quiesce_owned(self, record):
        self.event('quiesce')

    def restart_coordinator(self, record):
        self.event('restart-worker')

    def restore_original_controller(self, record):
        if record['decision'] == 'commit':
            raise AssertionError('postcommit rollback')
        self.event('original-health')

    def finish_overlay(self, record):
        if self.manager.maintenance() != {'state': 'checking'}:
            raise AssertionError('responder must stop while terminal settlement still holds maintenance')
        self.event('overlay-finish')

    def terminal_material(self, record):
        committed = record['decision'] == 'commit'
        body = b'{"fixture":"root archived terminal journal"}'
        return {'_journalBody': body, 'nodePhase': 'completed' if committed else 'rolled-back', 'nodeJournalSha256': hashlib.sha256(body).hexdigest(), 'operationSha256': 'd' * 64,
                'survivor': {'id': record['candidateId'] if committed else record['source']['controllerId'], 'imageId': 'sha256:' + 'a' * 64,
                             'definitionSha256': 'e' * 64, 'role': 'candidate' if committed else 'original'},
                'database': {'containerId': '5' * 64, 'imageId': 'sha256:' + 'f' * 64, 'name': 'fixture', 'user': 'fixture', 'oid': 42,
                             'marker': None, 'connectionSha256': 'a' * 64, 'environmentSha256': 'b' * 64}, 'retired': []}

    def finalize_terminal_metadata(self, record, proof):
        self.event('reconcile-terminal-pointer')
        return 'a' * 64

    def retire_provisional(self, record):
        self.event('retire-provisional')

    def retire_auxiliary(self, record):
        if self.manager.maintenance() != {'state': 'checking'}:
            raise AssertionError('auxiliary retired outside terminal protected maintenance')
        self.event('retire-owned-containers')

    def set_terminal_policy(self, record):
        self.event('terminal-restart-policy')


class RetainedRestoreTests(unittest.TestCase):
    def test_node_fingerprint_matches_actual_legacy_node_enumeration_for_numeric_and_unicode_labels(self):
        from test_orbis_host_app_runtime import fixture
        descriptor, _ = fixture(); raw = copy.deepcopy(descriptor['containers'][0]['inspect']); raw['State'] = {'Running': True}
        raw['Config']['Labels'].update({'4294967294': 'plain-label', '4294967295': 'plain-label'})
        runtime = D.DockerRestoreRuntime(self.manager)
        self.assertEqual(runtime.node_fingerprint(raw), '5a772c4d4fbce6a81caf4c1114516c416253b9d9f74c34db5cc7a1ff543a16bd')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root, self.state = self.base / 'installation', self.base / 'state'
        self.root.mkdir(mode=0o700)
        self.state.mkdir(mode=0o700)
        self.enterContext(mock.patch.object(M.HOST.AUTHORITY, 'OWNER', os.geteuid()))
        self.enterContext(mock.patch.object(M.HOST, 'host_lock', side_effect=lambda _: nullcontext()))
        self.enterContext(mock.patch.object(M.HOST, 'require_no_capture_fence'))
        self.origin = SimpleNamespace(authority_bytes=b'{"publication":{"fixture":true}}')
        self.enterContext(mock.patch.object(M.CAPTURE, 'load_origin', return_value=self.origin))
        self.runtime = Runtime()
        self.manager = M.RestoreManager(SimpleNamespace(root=self.root, context='fixture', state_dir=self.state, HOST=M.HOST), self.runtime)
        self.runtime.manager = self.manager
        self.request = {name: str(uuid.uuid4()) for name in ('pointId', 'restoreId', 'importId')}
        self.key = 'd' * 64

    def begin(self):
        review = self.manager.review(self.request)
        request = {**self.request, 'currentRevision': review['currentRevision'], 'stageRevision': review['stageRevision'], 'clientKey': self.key}
        return self.manager.begin(request), request

    def settle(self):
        identifier = self.request['restoreId']
        proof = self.manager.terminal_proof(identifier, self.key)
        return self.manager.terminal_finalize(identifier, self.key, proof['proofSha256'])

    def test_begin_retries_exact_binding_without_reallocating_or_adopting_another_key(self):
        result, request = self.begin()
        self.assertEqual(self.manager.maintenance(), {'state': 'restoring'})
        self.assertEqual(self.manager.begin(request), result)
        self.assertEqual(self.runtime.events.count('allocate'), 1)
        with self.assertRaises(ValueError):
            self.manager.begin({**request, 'clientKey': 'e' * 64})
        with self.assertRaises(ValueError):
            self.manager.begin({**request, 'stageRevision': 'e' * 64})

    def test_partial_allocation_status_preserves_root_pinned_owner_receipt_hash(self):
        self.runtime.fail_at = 'allocate'
        with self.assertRaises(RuntimeError):
            self.begin()
        identifier = self.request['restoreId']
        status = self.manager.status(identifier, self.key)
        self.assertEqual(status['state'], 'allocating')
        self.assertIsNone(status['binding'])
        self.assertEqual(status['admissionSha256'], 'b' * 64)
        with self.assertRaises(ValueError):
            self.manager.status(identifier, 'e' * 64)

    def test_root_startup_resumes_only_existing_protected_accepted_transaction(self):
        self.begin()
        identifier = self.request['restoreId']
        self.assertEqual(self.manager.resume_pending()['state'], 'rolled-back')
        self.assertEqual(self.manager.maintenance(), {'state': 'checking'})
        self.settle()
        self.assertEqual(self.manager.maintenance(), {'state': 'idle'})
        with self.assertRaises(FileNotFoundError):
            self.manager.resume_pending()
        self.assertEqual(self.manager.read(identifier)['decision'], 'rollback')

    def test_absence_proof_durably_revokes_delayed_begin_and_replays_without_staging(self):
        review = self.manager.review(self.request)
        request = {**self.request, 'currentRevision': review['currentRevision'], 'stageRevision': review['stageRevision'], 'clientKey': self.key}
        proof = self.manager.absence(request)
        self.assertTrue(proof['revoked'])
        self.assertEqual(proof['admissionSha256'], 'b' * 64)
        self.runtime.review_stage = mock.Mock(side_effect=AssertionError('staging already disposed'))
        self.assertEqual(self.manager.absence(request), proof)
        with self.assertRaises(ValueError):
            self.manager.absence({**request, 'clientKey': 'e' * 64})
        with self.assertRaises(ValueError):
            self.manager.begin(request)
        restarted = M.RestoreManager(self.manager.service, self.runtime)
        with self.assertRaises(ValueError):
            restarted.begin(request)
        self.assertNotIn('allocate', self.runtime.events)
        stored = (self.state / 'retained-restore-revocations' / (request['restoreId'] + '.json')).read_text()
        self.assertNotIn(self.key, stored)

    def test_absence_never_treats_active_or_damaged_transaction_as_safe_to_dispose(self):
        _, request = self.begin()
        with self.assertRaises(ValueError):
            self.manager.absence(request)
        M.marker_path(self.root).unlink()
        with self.assertRaises(ValueError):
            self.manager.absence(request)
        (self.manager.directory(request['restoreId']) / 'transaction.json').unlink()
        with self.assertRaises(FileNotFoundError):
            self.manager.absence(request)

    def test_success_orders_health_before_durable_commit_and_activation_before_finish(self):
        self.begin()
        identifier = self.request['restoreId']
        self.manager.prepare(identifier, self.key)
        self.manager.activate(identifier, self.key)
        events = self.runtime.events
        self.assertLess(events.index('historical-health'), events.index('controller-commit'))
        self.assertLess(events.index('retire-provisional'), events.index('prepare'))
        self.assertLess(events.index('commit:authorize'), events.index('activation'))
        self.assertLess(events.index('activation'), events.index('commit:finish'))
        self.assertEqual(self.manager.read(identifier)['decision'], 'commit')
        self.assertEqual(self.manager.maintenance(), {'state': 'checking'})
        self.settle()
        self.assertEqual(self.manager.maintenance(), {'state': 'idle'})

    def test_precommit_verification_failure_rolls_back_then_releases_maintenance(self):
        self.begin()
        identifier = self.request['restoreId']
        self.manager.prepare(identifier, self.key)
        self.runtime.fail_at = 'historical-health'
        with self.assertRaises(RuntimeError):
            self.manager.activate(identifier, self.key)
        self.assertEqual(self.manager.read(identifier)['phase'], 'rolled-back')
        self.assertIn('rollback', self.runtime.events)
        self.assertNotIn('controller-commit', self.runtime.events)
        self.assertEqual(self.manager.maintenance(), {'state': 'checking'})
        self.settle()
        self.assertEqual(self.manager.maintenance(), {'state': 'idle'})

    def test_postcommit_interruption_recovers_forward_without_rollback_or_second_promotion(self):
        self.begin()
        identifier = self.request['restoreId']
        self.manager.prepare(identifier, self.key)
        self.runtime.fail_at = 'activation'
        with self.assertRaises(RuntimeError):
            self.manager.activate(identifier, self.key)
        self.manager.interrupted(identifier)
        self.assertEqual(self.manager.maintenance(), {'state': 'recovery'})
        self.runtime.fail_at = None
        result = self.manager.recover(identifier, self.key)
        self.assertEqual(result['state'], 'complete')
        self.assertNotIn('rollback', self.runtime.events)
        self.assertNotIn('original-health', self.runtime.events)
        self.assertEqual(self.runtime.events.count('promote'), 1)
        self.assertEqual(self.runtime.events.count('commit:authorize'), 1)
        self.assertTrue(self.manager.read(identifier)['commitAuthorized'])

    def test_phase_tokens_are_single_use_and_orphaned_grants_cannot_complete(self):
        self.begin()
        identifier = self.request['restoreId']
        self.manager.prepare(identifier, self.key)
        response, capsule = self.runtime.last_response, self.runtime.last_capsule
        with self.assertRaises(ValueError):
            self.manager.redeem_phase(identifier, {'version': 1, 'phase': 'prepare', 'token': capsule['token']})
        with self.assertRaises(ValueError):
            self.manager.complete_phase(identifier, {'version': 1, 'phase': 'prepare', 'sequence': response['sequence'], 'token': capsule['token']})
        self.assertNotEqual(capsule['token'], self.key)
        self.assertNotIn('workerSnapshot', response)
        self.assertNotIn('sourceBinding', response)

    def test_terminal_journal_does_not_unlock_until_health_and_marker_clear(self):
        self.begin()
        identifier = self.request['restoreId']
        record = self.manager.read(identifier)
        record.update(phase='complete', decision='commit')
        self.manager.save(record)
        self.assertEqual(self.manager.maintenance(), {'state': 'checking'})
        self.runtime.fail_at = 'active-health'
        with self.assertRaises(RuntimeError):
            self.manager.recover(identifier, self.key)
        self.assertEqual(self.manager.maintenance(), {'state': 'checking'})
        self.runtime.fail_at = None
        self.manager.recover(identifier, self.key)
        self.assertEqual(self.manager.maintenance(), {'state': 'checking'})
        self.settle()
        self.assertEqual(self.manager.maintenance(), {'state': 'idle'})

    def test_status_after_service_restart_stays_locked_and_damaged_marker_is_sanitized(self):
        self.begin()
        other = M.RestoreManager(SimpleNamespace(root=self.root, context='fixture', state_dir=self.state, HOST=M.HOST), self.runtime)
        self.assertEqual(other.maintenance(), {'state': 'restoring'})
        M.marker_path(self.root).write_bytes(b'{"secretFixture":"must not escape"}')
        self.assertEqual(other.maintenance(), {'state': 'checking'})
        self.assertNotIn('Fixture', json.dumps(other.maintenance()))

    def test_actual_unix_handler_routes_sanitized_status_and_rejects_untrusted_peer(self):
        self.begin()
        endpoint = self.base / 'host.sock'
        server = S.UnixHTTPServer(str(endpoint), S.Handler)
        server.service = SimpleNamespace(retained_restores=lambda: self.manager)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        def request():
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            with connection:
                connection.connect(str(endpoint))
                connection.sendall(b'GET /v1/retained-restore/maintenance HTTP/1.0\r\n\r\n')
                body = b''
                while True:
                    block = connection.recv(8192)
                    if not block:
                        return body
                    body += block
        with mock.patch.object(S, 'trusted_capture_peer', return_value=True):
            response = request()
        self.assertIn(b'200 OK', response)
        self.assertEqual(json.loads(response.split(b'\r\n\r\n')[1]), {'state': 'restoring'})
        with mock.patch.object(S, 'trusted_capture_peer', return_value=False):
            self.assertIn(b'403 Forbidden', request())

    def test_kernel_peer_validation_requires_linux_root_not_caller_headers(self):
        connection = mock.Mock()
        import struct
        with mock.patch.object(S.socket, 'SO_PEERCRED', 17, create=True), mock.patch.object(S.os, 'geteuid', return_value=0):
            connection.getsockopt.return_value = struct.pack('3i', 123, 0, 0)
            self.assertTrue(S.trusted_capture_peer(connection))
            connection.getsockopt.return_value = struct.pack('3i', 123, 501, 0)
            self.assertFalse(S.trusted_capture_peer(connection))

    def test_incomplete_capability_never_dispatches_old_legacy_worker_flags(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        runtime.validate_worker = mock.Mock()
        runtime.bounded_output = mock.Mock(return_value=M.P.canonical({**D.CAPABILITY, 'phases': [], 'commitStages': []}))
        with mock.patch.object(D.subprocess, 'run') as execute:
            with self.assertRaises(ValueError):
                runtime.execute_phase({'workerId': '1' * 64}, 'prepare', {'version': 1})
        execute.assert_not_called()

    def test_command_output_is_bounded_while_reading_not_after_allocation(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        self.assertEqual(runtime.bounded_output([sys.executable, '-c', 'print("fixture")'], 64, 5), b'fixture\n')
        with self.assertRaises(ValueError):
            runtime.bounded_output([sys.executable, '-c', 'import sys;sys.stdout.buffer.write(b"x" * 65536)'], 1024, 5)

    def test_frozen_copy_rejects_links_and_source_change_without_replacing_live_data(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        source, target = self.base / 'payload', self.base / 'frozen'
        source.mkdir(mode=0o700)
        data = source / 'database.dump'
        data.write_bytes(b'fixture database')
        data.chmod(0o600)
        inventory, count = runtime.freeze_tree(source, target, 4096)
        self.assertEqual(count, len(b'fixture database'))
        self.assertEqual((target / 'database.dump').read_bytes(), data.read_bytes())
        self.assertEqual(inventory[0]['path'], 'database.dump')
        self.assertEqual((target / 'database.dump').stat().st_mode & 0o777, 0o400)
        (source / 'linked').symlink_to(data)
        with self.assertRaises(ValueError):
            runtime.freeze_tree(source, self.base / 'reject', 4096)

    def test_root_image_preflight_uses_bound_inventory_and_actual_daemon_storage(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        runtime.check_source = mock.Mock()
        inventory = {'version': 1, 'images': [{'bytes': 100, 'identity': {'expandedBytes': 200}}], 'bindings': []}
        capture = {'inventory': inventory}
        body = M.P.canonical(capture)
        runtime.read_file = mock.Mock(return_value=body)
        record = {'id': self.request['restoreId'], 'retainedPath': str(self.base), 'source': {'daemonId': 'fixed-daemon'},
                  'stage': {'metadata': {'imageCaptureSha256': hashlib.sha256(body).hexdigest(), 'imageInventorySha256': M.digest(inventory)}}}
        runtime.reader = mock.Mock()
        runtime.reader._object.return_value = {'ID': 'fixed-daemon', 'DockerRootDir': str(self.base)}
        required = 256 * 1024 * 1024 + 500
        space = SimpleNamespace(f_bavail=required + 100, f_frsize=1, f_favail=100, f_files=1000)
        with mock.patch.object(D.os, 'statvfs', return_value=space) as statfs:
            result = runtime.preflight_images(record, required)
            self.assertEqual(result['availableBytes'], required + 100)
            statfs.assert_called_once_with(self.base)
            with self.assertRaises(ValueError):
                runtime.preflight_images(record, required - 1)
            runtime.reader._object.return_value['ID'] = 'substituted-daemon'
            with self.assertRaises(ValueError):
                runtime.preflight_images(record, required)
        runtime.reader._object.return_value['ID'] = 'fixed-daemon'
        with mock.patch.object(D.os, 'statvfs', return_value=SimpleNamespace(**{**vars(space), 'f_favail': 63})):
            with self.assertRaises(ValueError):
                runtime.preflight_images(record, required)

    def test_root_core_maintenance_distinguishes_actual_jobs_and_requires_terminal_health(self):
        service = S.HostService.__new__(S.HostService)
        service.lock = threading.Lock()
        service.job_file, service.root, service.context = self.state / 'job.json', self.root, 'fixture'
        current = {'tag': 'v0.5.0', 'digest': 'sha256:' + 'a' * 64}
        target = {'tag': 'v0.5.1', 'digest': 'sha256:' + 'b' * 64}
        job = {'schema': 'orbis.host-service-job.v1', 'current': current, 'target': target, 'state': 'running'}
        service.current_manifest = mock.Mock(return_value=target)
        with mock.patch.object(S.PLAN, 'validate_manifest', side_effect=lambda value: value), \
                mock.patch.object(S, 'read_private', return_value=None):
            self.assertEqual(service.core_operation_maintenance(), {'state': 'idle'})
        with mock.patch.object(S.PLAN, 'validate_manifest', side_effect=lambda value: value), \
                mock.patch.object(S, 'read_private', side_effect=lambda _: copy.deepcopy(job)), \
                mock.patch.object(S.HOST, 'current_core', return_value={'state': 'running', 'health': 'healthy'}) as core:
            self.assertEqual(service.core_operation_maintenance(), {'state': 'updating'})
            core.assert_not_called()
            job.update(current=target, target=current)
            self.assertEqual(service.core_operation_maintenance(), {'state': 'downgrading'})
            job['state'] = 'interrupted'
            self.assertEqual(service.core_operation_maintenance(), {'state': 'recovery'})
            job.update(current=current, target=target, state='complete')
            self.assertEqual(service.core_operation_maintenance(), {'state': 'idle'})
            core.return_value['health'] = 'unhealthy'
            self.assertEqual(service.core_operation_maintenance(), {'state': 'checking'})
            job['schema'] = 'orbis.package-job.v1'
            self.assertEqual(service.core_operation_maintenance(), {'state': 'checking'})

    def test_committed_generation_reloads_original_root_origin_and_rejects_tampered_commit(self):
        from test_orbis_host_capture_authority import A, CaptureAuthorityTests
        fixture = CaptureAuthorityTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.finalize()
        root, state, host = fixture.fixture.root, fixture.fixture.state, fixture.service.HOST
        authority = host.AUTHORITY
        point = fixture.fixture.point
        identifier = str(uuid.uuid4())
        parent = state / 'retained-restores'
        parent.mkdir(mode=0o700)
        transaction = parent / identifier
        transaction.mkdir(mode=0o700)
        retained = transaction / 'retained'
        retained.mkdir(mode=0o700)
        origin = A.load_origin(state, root, 'fixture', point)
        original = json.loads(origin.authority_bytes)
        enrollment = host.enrollment_bytes(root)
        source_files = {name: host.file_digest(root / name) for name in host.IDENTITY.FILES}
        override = authority.override_content(original['publication'], original['archive']['creationReference']).encode()
        (root / 'orbis-compose.yml').write_bytes(override)
        (root / 'orbis-compose.yml').chmod(0o600)
        runtime = authority.P.canonical({'schema': 'orbis.time-machine-runtime.v3', 'pointId': point})
        authority.atomic(retained / 'runtime-manifest.json', runtime)
        incoming = hashlib.sha256((root / '.env').read_bytes()).hexdigest()
        prepared = {'schema': 'orbis.retained-restore-prepared.v1', 'target': {'publication': original['publication']},
                    'runtimeManifestDigest': authority.P.digest(runtime), 'incomingEnvSha256': incoming}
        prepared_bytes = authority.P.canonical(prepared)
        authority.atomic(transaction / 'prepared-authority.json', prepared_bytes)
        commit = {'schema': 'orbis.retained-restore-commit.v1', 'decision': 'commit', 'transactionId': identifier, 'pointId': point,
                  'root': str(root), 'dockerContext': 'fixture', 'preparedAuthorityDigest': authority.P.digest(prepared_bytes),
                  'originAuthoritySha256': hashlib.sha256(origin.authority_bytes).hexdigest()}
        authority.atomic(transaction / 'commit.json', authority.P.canonical(commit))
        record = {'id': identifier, 'pointId': point, 'decision': 'commit', 'incomingEnvSha256': incoming,
                  'source': {'files': source_files, 'enrollment': base64.b64encode(enrollment).decode()}, 'retainedPath': str(retained)}
        manager = SimpleNamespace(root=root, context='fixture', host=host, read=lambda _: record, origin=lambda _: origin,
                                  directory=lambda _: transaction, save=lambda _: None,
                                  runtime=SimpleNamespace(read_file=lambda path, _: path.read_bytes()))
        token = host.RESTORE_TRANSACTION.set(identifier)
        try:
            descriptor = authority.commit_restore_generation(manager, record)
        finally:
            host.RESTORE_TRANSACTION.reset(token)
        self.assertEqual(descriptor['creationReference'], original['archive']['creationReference'])
        self.assertEqual(descriptor['sourceImageId'], original['archive']['sourceImageId'])
        self.assertNotEqual(descriptor['sourceImageId'], descriptor['creationReference'])
        self.assertEqual(descriptor['pointId'], authority.P.digest(runtime))
        selector = json.loads((authority.store_path(root) / 'current.json').read_bytes())
        self.assertEqual(selector['schema'], 'orbis.host.retained-selector.v2')
        bundle = Path(selector['bundle'])
        with authority.restore_generation(bundle, selector['descriptorDigest'], root, 'fixture', host.enrollment_bytes(root)) as resolved:
            self.assertEqual(resolved[0], descriptor)
        commit['decision'] = 'rollback'
        authority.atomic(transaction / 'commit.json', authority.P.canonical(commit))
        with self.assertRaises(ValueError):
            with authority.restore_generation(bundle, selector['descriptorDigest'], root, 'fixture', host.enrollment_bytes(root)):
                pass

    def test_overlay_preflight_rejects_direct_ports_and_builds_only_reviewed_router_scope(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        folder = self.root / 'traefik'
        folder.mkdir(mode=0o700)
        (folder / 'traefik.yml').write_bytes(b'owned static proxy fixture')
        (folder / 'traefik.yml').chmod(0o600)
        labels = {'traefik.enable': 'true', 'traefik.http.services.dashboard.loadbalancer.server.port': '3000'}
        routers = {}
        for name, entry in (('dashboard', 'web'), ('dashboard-secure', 'websecure')):
            prefix = 'traefik.http.routers.' + name + '.'
            labels.update({prefix + 'rule': 'PathPrefix(`/`)', prefix + 'entrypoints': entry, prefix + 'service': 'dashboard'})
            routers[name + '@docker'] = {'status': 'enabled', 'rule': 'PathPrefix(`/`)', 'entryPoints': [entry], 'service': 'dashboard', 'priority': 15}
            if entry == 'websecure':
                labels[prefix + 'tls'] = 'true'
                routers[name + '@docker']['tls'] = {}
        original = {'Id': '1' * 64, 'HostConfig': {'PortBindings': {}, 'NetworkMode': 'managed'}, 'Config': {'Labels': labels},
                    'Mounts': [{'Destination': '/run/orbis', 'Type': 'bind', 'Source': '/run/orbis', 'RW': False}],
                    'NetworkSettings': {'Networks': {'managed': {}}}}
        proxy = {'Id': '9' * 64, 'Config': {'Labels': {'com.docker.compose.project.working_dir': str(self.root), 'com.docker.compose.service': 'runtipi-reverse-proxy'}},
                 'State': {'Running': True}, 'NetworkSettings': {'Networks': {'managed': {}}}}
        runtime.inspect = mock.Mock(return_value=proxy)
        runtime.definition = mock.Mock(return_value='owned-proxy-definition')
        runtime.proxy_routers = mock.Mock(return_value=routers)
        configuration = runtime.overlay_preflight(original)
        record = {'id': self.request['restoreId'], 'nonce': 'a' * 64, 'source': {'overlay': configuration, 'imageId': 'sha256:' + 'b' * 64}}
        body = runtime.overlay_body(record)
        self.assertEqual(body['Image'], record['source']['imageId'])
        self.assertEqual(body['HostConfig']['Mounts'], [{'Type': 'bind', 'Source': '/run/orbis', 'Target': '/run/orbis', 'ReadOnly': True, 'BindOptions': {'Propagation': 'rprivate'}}])
        self.assertTrue(body['HostConfig']['ReadonlyRootfs'])
        self.assertEqual(body['HostConfig']['CapDrop'], ['ALL'])
        self.assertEqual(body['HostConfig']['PortBindings'], {})
        self.assertEqual(set(body['NetworkingConfig']['EndpointsConfig']), {'managed'})
        priorities = [value for key, value in body['Labels'].items() if key.endswith('.priority')]
        self.assertEqual(priorities, ['16', '16'])
        original['HostConfig']['PortBindings'] = {'3000/tcp': [{'HostPort': '3000'}]}
        with self.assertRaises(ValueError):
            runtime.overlay_preflight(original)

    def test_legacy_core_proxy_stop_path_is_refused_before_any_overlay_or_job_acceptance(self):
        overlay = load('orbis-host-maintenance-overlay.py', 'orbis_core_overlay_test').CoreOverlay(self.manager.service)
        overlay.runtime = mock.Mock()
        with self.assertRaisesRegex(ValueError, 'cannot preserve'):
            overlay.begin(self.request['restoreId'], {'tag': 'fixture'}, {'tag': 'old-legacy-target'})
        overlay.runtime.source_snapshot.assert_not_called()
        self.assertFalse((self.state / 'core-overlays').exists())

    def test_core_overlay_is_durable_before_acceptance_and_teardown_requires_terminal_health(self):
        module = load('orbis-host-maintenance-overlay.py', 'orbis_core_overlay_lifecycle_test')
        service = self.manager.service
        current, target = {'tag': 'current'}, {'tag': 'target', 'installationProtocol': M.HOST.PLAN.INSTALLATION_PROTOCOL}
        service.current_manifest = mock.Mock(return_value=target)
        overlay = module.CoreOverlay(service)
        runtime = mock.Mock()
        runtime.source_snapshot.return_value = {'publication': current, 'controllerId': 'a' * 64, 'definition': 'current-definition'}
        def prepare(record):
            record.update(responderId='b' * 64, definitions={'responder': 'responder-definition'})
            overlay.save(record)
        runtime.prepare_overlay.side_effect = prepare
        runtime.inspect.return_value = {'Id': 'b' * 64, 'State': {'Running': True}}
        runtime.definition.return_value = 'responder-definition'
        overlay.runtime = runtime
        identifier = self.request['restoreId']
        self.assertEqual(overlay.begin(identifier, current, target), identifier)
        self.assertEqual(overlay.read(identifier)['phase'], 'active')
        self.assertEqual(overlay.begin(identifier, current, target), identifier)
        runtime.prepare_overlay.assert_called_once()
        job = {'id': identifier, 'overlayId': identifier, 'state': 'complete', 'current': current, 'target': target}
        with mock.patch.object(M.HOST, 'current_core', return_value={'state': 'running', 'health': 'unhealthy'}):
            with self.assertRaises(ValueError):
                overlay.finish(job)
        runtime.change.assert_not_called()
        with mock.patch.object(M.HOST, 'current_core', return_value={'state': 'running', 'health': 'healthy'}):
            overlay.finish(job)
        self.assertEqual(overlay.read(identifier)['phase'], 'complete')
        runtime.change.assert_any_call(['stop', 'b' * 64])

    def test_source_revision_ignores_health_log_noise_but_binds_container_restart(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        reference = 'ghcr.io/twentylines/orbis@sha256:' + 'c' * 64
        raw = {'Id': 'a' * 64, 'Image': 'sha256:' + 'b' * 64, 'Name': '/runtipi',
               'HostConfig': {'Privileged': False, 'AutoRemove': False},
               'Mounts': [{'Source': '/fixture-z', 'Destination': '/z', 'RW': True}, {'Source': '/fixture-a', 'Destination': '/a', 'RW': False}],
               'Config': {'Image': reference, 'Labels': {'com.docker.compose.project': 'runtipi', 'com.docker.compose.service': 'runtipi', 'com.docker.compose.project.working_dir': str(self.root)}},
               'State': {'Running': True, 'Restarting': False, 'Paused': False, 'StartedAt': 'fixture-generation-1', 'Health': {'Status': 'healthy', 'Log': ['changing-health-observation']}}}
        runtime.inspect = mock.Mock(side_effect=lambda _: copy.deepcopy(raw))
        runtime.image = mock.Mock(return_value={'Id': raw['Image'], 'Config': {}})
        runtime.definition = mock.Mock(return_value='immutable-definition')
        runtime.reader = mock.Mock()
        runtime.reader._object.return_value = {'ID': 'fixed-daemon'}
        runtime.reader.socket.return_value = '/fixture-docker.sock'
        runtime.require_capability = mock.Mock(return_value='capability-sha')
        runtime.overlay_preflight = mock.Mock(return_value={'fixture': 'reviewed-overlay'})
        self.manager.service.current_manifest = mock.Mock(return_value={'fixture': 'publication'})
        self.manager.service.proxy_host_identity = mock.Mock(return_value={'descriptor': {'fixture': 'protected-layout'}})
        with mock.patch.object(M.HOST, 'controller_reference', return_value=reference), mock.patch.object(M.HOST, 'retained_state', return_value=False), \
                mock.patch.object(M.HOST, 'file_digest', return_value='a' * 64), mock.patch.object(M.HOST, 'enrollment_bytes', return_value=b'{}'):
            first = M.digest(runtime.source_snapshot())
            raw['State']['Health']['Log'] = ['a-new-probe-at-a-new-time']
            self.assertEqual(first, M.digest(runtime.source_snapshot()))
            raw['Mounts'].reverse()
            self.assertEqual(first, M.digest(runtime.source_snapshot()))
            raw['Mounts'][0]['RW'] = not raw['Mounts'][0]['RW']
            self.assertNotEqual(first, M.digest(runtime.source_snapshot()))
            raw['Mounts'][0]['RW'] = not raw['Mounts'][0]['RW']
            raw['State']['StartedAt'] = 'fixture-generation-2'
            self.assertNotEqual(first, M.digest(runtime.source_snapshot()))
            raw['Mounts'].append(copy.deepcopy(raw['Mounts'][0]))
            with self.assertRaises(ValueError):
                runtime.source_snapshot()

    def test_terminal_auxiliary_retirement_reconciles_lost_remove_reply_without_touching_candidate(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        identifier = self.request['restoreId']
        original, worker, verifier, candidate = ('1' * 64, '2' * 64, '3' * 64, '4' * 64)
        record = {'id': identifier, 'phase': 'complete', 'decision': 'commit', 'workerId': worker, 'verifierId': verifier, 'candidateId': candidate,
                  'source': {'controllerId': original, 'definition': 'original-definition', 'container': {'NetworkSettings': {'Networks': {'main': {'NetworkID': 'a' * 64}}}}},
                  'definitions': {'coordinator': 'worker-definition', 'verifier': 'verifier-definition'}}
        runtime.manager = SimpleNamespace(read=lambda _: record, save=mock.Mock())
        runtime.assert_active = mock.Mock()
        names = {original: 'previous', worker: 'coordinator', verifier: 'verifier'}
        definitions = {original: 'original-definition', worker: 'worker-definition', verifier: 'verifier-definition'}
        raw = {value: {'Id': value, 'Name': '/orbis-retained-' + identifier + '-' + role, 'State': {'Running': value == worker},
                       'NetworkSettings': {'Networks': {'main': {'NetworkID': 'a' * 64}}}} for value, role in names.items()}
        runtime.inspect = mock.Mock(side_effect=lambda value: raw[value])
        runtime.definition = mock.Mock(side_effect=lambda value: definitions[value['Id']])
        removed = set()
        runtime.reader = mock.Mock()
        runtime.reader._read.side_effect = lambda args: '' if args[5][3:] in removed else args[5][3:]
        operations = []
        lost = [True]
        def change(args):
            operations.append(args)
            if args[0] == 'rm':
                self.assertIn(args[1], record['cleanupIntents'].values())
                removed.add(args[1])
                if lost[0]:
                    lost[0] = False
                    raise RuntimeError('fixture removed successfully but reply lost')
        runtime.change = change
        with self.assertRaises(RuntimeError):
            runtime.retire_auxiliary(record)
        runtime.retire_auxiliary(record)
        self.assertEqual(removed, {original, worker, verifier})
        self.assertNotIn(candidate, removed)
        self.assertTrue(all('--volumes' not in args and '--force' not in args for args in operations))
        self.assertEqual(record['cleaned'], {'previous': original, 'verifier': verifier, 'coordinator': worker})

    def test_created_network_observation_can_populate_only_the_pinned_network_on_start(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        raw = {'Id': 'b' * 64, 'Config': {}, 'HostConfig': {}, 'Mounts': [], 'State': {'Running': False},
               'NetworkSettings': {'Networks': {'main': {'NetworkID': ''}}}}
        record = {'source': {'container': {'NetworkSettings': {'Networks': {'main': {'NetworkID': 'a' * 64}}}}}}
        first = runtime.definition(raw)
        runtime.verify_networks(record, raw)
        raw['State']['Running'] = True
        raw['NetworkSettings']['Networks']['main']['NetworkID'] = 'a' * 64
        self.assertEqual(first, runtime.definition(raw))
        runtime.verify_networks(record, raw)
        raw['NetworkSettings']['Networks']['main']['NetworkID'] = 'c' * 64
        with self.assertRaises(ValueError):
            runtime.verify_networks(record, raw)

    def test_provisional_fingerprints_do_not_self_authorize_started_or_out_of_scope_workers(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        identifier, nonce = self.request['restoreId'], str(uuid.uuid4())
        source = {'controllerId': '1' * 64, 'imageId': 'sha256:' + 'a' * 64, 'imageConfiguration': {'Labels': {'org.fixture': 'fixture'}},
                  'container': {'NetworkSettings': {'Networks': {'main': {'NetworkID': 'b' * 64}}}}}
        journal = {'id': identifier, 'nonce': nonce, 'worker': '2' * 64, 'verifierController': '3' * 64}
        observed = {}
        for role, key in (('worker', 'worker'), ('verifier', 'verifierController')):
            observed[journal[key]] = {'Id': journal[key], 'Name': '/orbis-restore-' + identifier + '-' + role, 'Image': source['imageId'], 'RestartCount': 0,
                'Config': {'Labels': {'org.fixture': 'fixture', 'io.orbis.restore': identifier, 'io.orbis.restore.nonce': nonce, 'io.orbis.restore.role': role, 'traefik.enable': 'false'},
                           'Entrypoint': ['node'], 'User': '0', 'WorkingDir': '/app', 'Cmd': ['/app/restore-worker.mjs', identifier] if role == 'worker' else ['/app/main.mjs']},
                'HostConfig': {'ReadonlyRootfs': True, 'NetworkMode': 'main', 'CapDrop': ['ALL'], 'CapAdd': ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'] if role == 'worker' else [],
                               'SecurityOpt': ['no-new-privileges:true'], 'RestartPolicy': {'Name': 'unless-stopped' if role == 'worker' else 'no', 'MaximumRetryCount': 0}},
                'Mounts': [{'Source': str(self.root / 'state'), 'Destination': '/data/state', 'RW': role == 'worker'}],
                'State': {'Running': False, 'StartedAt': '0001-01-01T00:00:00Z'}, 'NetworkSettings': {'Networks': {'main': {'NetworkID': ''}}}}
        runtime.inspect = mock.Mock(side_effect=lambda value: observed[value])
        runtime.storage_mounts = mock.Mock(side_effect=lambda _, role: [{'Source': str(self.root / 'state'), 'Target': '/data/state', 'ReadOnly': role == 'verifier'}])
        bootstrap = {'identity': {role: {'id': journal[key], 'fingerprint': runtime.node_fingerprint(observed[journal[key]])} for role, key in (('worker', 'worker'), ('verifier', 'verifierController'))}}
        self.assertEqual(set(runtime.provisional_auxiliaries(source, journal, bootstrap)), {'worker', 'verifier'})
        worker = observed[journal['worker']]
        worker['State']['StartedAt'] = '2026-11-01T00:00:00Z'
        with self.assertRaises(ValueError):
            runtime.provisional_auxiliaries(source, journal, bootstrap)
        worker['State']['StartedAt'] = '0001-01-01T00:00:00Z'
        worker['Mounts'][0]['Source'] = '/unrelated-fixture-data'
        bootstrap['identity']['worker']['fingerprint'] = runtime.node_fingerprint(worker)
        with self.assertRaises(ValueError):
            runtime.provisional_auxiliaries(source, journal, bootstrap)

    def test_real_review_binds_full_authority_receipt_bytes_not_its_internal_domain_hash(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        identifier, point = self.request['restoreId'], self.request['pointId']
        source = {'controllerId': '1' * 64, 'imageId': 'sha256:' + 'a' * 64}
        journal = {'id': identifier, 'phase': 'staging', 'decision': None, 'nonce': 'n',
                   'originalController': source['controllerId'], 'candidateController': source['controllerId'], 'roots': sorted(D.ROOTS)}
        manifest_body = b'{"version":1}'
        manifest_sha = D.hashed(manifest_body)
        database = {'bytes': 10, 'sha256': 'b' * 64}
        seal = {'manifest': {'sha256': manifest_sha, 'bytes': len(manifest_body)}, 'database': database}
        bootstrap = {'identity': {'id': identifier, 'nonce': 'n', 'image': source['imageId'], 'original': {'id': source['controllerId']}},
                     'source': seal, 'ownerId': 1}
        admission = {'restoreId': identifier, 'nonce': 'n', 'importId': self.request['importId'], 'ownerId': 1,
                     'binding': {'pointId': point, 'manifestSha256': manifest_sha, 'archiveSha256': 'c' * 64}}
        authority = {'schema': 'orbis.controller-capture-authority.v1', 'authoritySha256': 'd' * 64,
                     'configurationSetSha256': 'e' * 64, 'publicationProofSha256': 'f' * 64, 'preparationSha256': 'a' * 64}
        canon = runtime.P.canonical
        bodies = {'manifest.json': manifest_body, 'controller-config.json': canon({'configuration': True}),
                  'controller-publication.json': canon({'publication': True}), 'controller-authority.json': canon(authority)}
        capture = {'pointId': point, 'inventory': {'images': []}}
        bodies['image-capture.json'] = canon(capture)
        coherence = {'schema': 'orbis.capture-coherence.v1', 'scope': 'orbis-managed-writers.v1', 'pointId': point,
                     'controllerAuthoritySha256': D.hashed(bodies['controller-authority.json']), 'publicationProofSha256': authority['publicationProofSha256'],
                     'imageCaptureSha256': D.hashed(bodies['image-capture.json']), 'imageInventorySha256': D.hashed(canon(capture['inventory'])),
                     'hostFence': {'configurationSetSha256': authority['configurationSetSha256'], 'preparationSha256': authority['preparationSha256']},
                     'manifestSha256': manifest_sha, 'database': database}
        def seal_coherence():
            coherence.pop('sha256', None)
            coherence['sha256'] = D.hashed(b'orbis.capture-coherence.v1\n' + canon(coherence))
            bodies['coherence.json'] = canon(coherence)
            metadata = {'schema': 'orbis.time-machine-runtime.v4' if authority['schema'].endswith('.v2') else 'orbis.time-machine-runtime.v3', 'pointId': point,
                        'configurationSetSha256': authority['configurationSetSha256'], 'publicationProofSha256': authority['publicationProofSha256'],
                        'imageCaptureSha256': coherence['imageCaptureSha256'], 'imageInventorySha256': coherence['imageInventorySha256'],
                        'legacy': {'manifestSha256': manifest_sha, 'cipherSha256': 'c' * 64},
                        'entries': [{'name': name, 'bytes': len(bodies[file]), 'sha256': D.hashed(bodies[file])} for name, file in
                                    [('image-capture/capture.json', 'image-capture.json'), ('coherence/receipt.json', 'coherence.json'),
                                     ('controller-authority/receipt.json', 'controller-authority.json'), ('controller-publication/proof.json', 'controller-publication.json')]]}
            if authority['schema'].endswith('.v2'):
                body = bodies['proxy-host-identity.json']
                metadata['proxyHostIdentitySha256'] = D.hashed(body)
                metadata['entries'].append({'name': 'host-identity/proxy.json', 'bytes': len(body), 'sha256': D.hashed(body)})
            bodies['runtime-manifest.json'] = canon(metadata)
        seal_coherence()
        bodies.update({'bootstrap.json': canon(bootstrap), 'time-machine-admission.json': canon(admission)})
        runtime.journal_directory = mock.Mock(return_value=self.root / 'fixture')
        runtime.a = SimpleNamespace(protected_directory=lambda _: nullcontext())
        runtime.json = lambda path, _limit: journal if path.name == 'restore.json' else bootstrap if path.name == 'bootstrap.json' else admission
        runtime.read_file = lambda path, *args: bodies[path.name]
        runtime.read_hash = mock.Mock(return_value=database)
        runtime.provisional_auxiliaries = mock.Mock(return_value={})
        origin = SimpleNamespace(authority_bytes=bodies['controller-authority.json'], configuration_bytes=bodies['controller-config.json'],
                                 publication_receipt_bytes=bodies['controller-publication.json'])
        self.assertEqual(runtime.review_stage(self.request, origin, source)['database'], database)
        coherence['controllerAuthoritySha256'] = authority['authoritySha256']
        seal_coherence()
        with self.assertRaises(ValueError):
            runtime.review_stage(self.request, origin, source)
        static_body = b'protected captured static proxy config'
        policy = {'schema': 'orbis.proxy-host-identity-policy.v1', 'policy': 'preserve-live-proxy-identity.v1',
                  'rootSha256': D.hashed(str(self.root).encode()), 'dockerContextSha256': D.hashed(self.manager.context.encode()),
                  'configuration': {'destination': '/etc/traefik', 'readOnly': True, 'staticSha256': D.hashed(static_body),
                                    'capture': 'encrypted-review-only', 'restore': 'preserve-live'},
                  'mutableIdentity': {'destination': '/shared', 'capture': 'excluded', 'restore': 'preserve-live', 'ownershipSha256': 'a' * 64},
                  'proxy': {'containerId': 'c' * 64, 'imageId': 'sha256:' + 'd' * 64}}
        policy['sha256'] = D.hashed(b'orbis.proxy-host-identity-policy.v1\n' + canon(policy))
        source['proxyHostIdentity'] = copy.deepcopy(policy)
        authority.update(schema='orbis.controller-capture-authority.v2', proxyHostIdentity=policy)
        bodies['controller-authority.json'] = canon(authority)
        bodies['proxy-host-identity.json'], bodies['traefik.yml'] = canon(policy), static_body
        origin.authority_bytes = bodies['controller-authority.json']
        coherence['controllerAuthoritySha256'] = D.hashed(bodies['controller-authority.json'])
        journal['roots'] = sorted(D.ROOTS - {'traefik'})
        seal_coherence()
        self.assertEqual(runtime.review_stage(self.request, origin, source)['database'], database)
        journal['roots'] = sorted(D.ROOTS)
        with self.assertRaises(ValueError):
            runtime.review_stage(self.request, origin, source)
        journal['roots'] = sorted(D.ROOTS - {'traefik'})
        source['proxyHostIdentity']['mutableIdentity']['ownershipSha256'] = 'b' * 64
        with self.assertRaises(ValueError):
            runtime.review_stage(self.request, origin, source)

    def test_terminal_proof_is_available_while_own_marker_checks_and_requires_exact_capability(self):
        self.begin();identifier=self.request['restoreId']
        with self.assertRaises(ValueError):self.manager.terminal_proof(identifier,self.key)
        self.manager.prepare(identifier,self.key);self.manager.activate(identifier,self.key)
        with self.assertRaises(ValueError):self.manager.terminal_proof(identifier,'0'*64)
        proof=self.manager.terminal_proof(identifier,self.key)
        descriptor={key:value for key,value in proof.items() if key!='proofSha256'}
        self.assertEqual(proof['proofSha256'],D.hashed(b'orbis.retained-terminal-proof.v1\n'+M.P.canonical(descriptor)))
        self.assertEqual(proof['state'],'complete');self.assertEqual(proof['survivor']['role'],'candidate')
        self.assertEqual(self.manager.terminal_proof(identifier,self.key),proof)
        M.marker_path(self.root).write_bytes(M.P.canonical({'schema':M.SCHEMA,'id':str(uuid.uuid4()),'root':str(self.root),'context':'fixture'}))
        M.marker_path(self.root).chmod(0o600)
        with self.assertRaises(ValueError):self.manager.terminal_proof(identifier,self.key)

    def test_settlement_capabilities_require_exact_current_and_inert_target_support(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        terminal = runtime.P.canonical(D.TERMINAL_CAPABILITY)
        runtime.bounded_output = mock.Mock(side_effect=[runtime.P.canonical(D.CAPABILITY), terminal])
        expected = D.hashed(runtime.P.canonical({'phase': D.CAPABILITY, 'terminal': D.TERMINAL_CAPABILITY}))
        self.assertEqual(runtime.require_capability('1' * 64), expected)
        for value in ({**D.TERMINAL_CAPABILITY, 'beforeUnlock': 1}, {**D.TERMINAL_CAPABILITY, 'version': True},
                      {**D.TERMINAL_CAPABILITY, 'states': []}, {**D.TERMINAL_CAPABILITY, 'extra': True}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                runtime.validate_terminal_capability(runtime.P.canonical(value))
        with self.assertRaises(ValueError):
            runtime.validate_terminal_capability(b'{"schema":"x","schema":"y"}')
        def archive(name, kind=tarfile.REGTYPE, extra=False, payload=None):
            payload = terminal if payload is None else payload
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode='w') as handle:
                entry = tarfile.TarInfo(name); entry.type = kind; entry.size = len(payload) if kind == tarfile.REGTYPE else 0
                handle.addfile(entry, io.BytesIO(payload) if entry.size else None)
                if extra:
                    entry = tarfile.TarInfo('extra'); handle.addfile(entry, io.BytesIO())
            return output.getvalue()
        activation = runtime.P.canonical(D.APP_ACTIVATION_CAPABILITY)
        def target_archive(arguments, *_):
            name = arguments[-2].split('/')[-1]
            return archive(name, payload=activation if name == 'retained-app-activation-capability.json' else terminal)
        runtime.bounded_output = mock.Mock(side_effect=target_archive)
        expected = D.hashed(runtime.P.canonical({D.TERMINAL_CAPABILITY_PATH: D.hashed(terminal), D.APP_ACTIVATION_CAPABILITY_PATH: D.hashed(activation)}))
        self.assertEqual(runtime.require_target_settlement('1' * 64), expected)
        self.assertNotIn('exec', runtime.bounded_output.call_args.args[0])
        for name, kind, extra in (('../retained-terminal-capability.json', tarfile.REGTYPE, False),
                                  ('retained-terminal-capability.json', tarfile.SYMTYPE, False),
                                  ('retained-terminal-capability.json', tarfile.REGTYPE, True)):
            runtime.bounded_output = mock.Mock(return_value=archive(name, kind, extra))
            with self.assertRaises(ValueError): runtime.require_target_settlement('1' * 64)
        for value in ({**D.APP_ACTIVATION_CAPABILITY, 'ordinaryMutationsHeld': 1}, {**D.APP_ACTIVATION_CAPABILITY, 'extra': True},
                      {key: value for key, value in D.APP_ACTIVATION_CAPABILITY.items() if key != 'normalBootstrap'}):
            runtime.bounded_output = mock.Mock(side_effect=[archive('retained-terminal-capability.json'),
                archive('retained-app-activation-capability.json', payload=runtime.P.canonical(value))])
            with self.assertRaises(ValueError): runtime.require_target_settlement('1' * 64)

    def test_actual_handler_terminal_endpoints_reject_duplicate_and_extra_fields(self):
        self.begin(); identifier = self.request['restoreId']; self.manager.prepare(identifier, self.key); self.manager.activate(identifier, self.key)
        endpoint = self.base / 'terminal-host.sock'
        server = S.UnixHTTPServer(str(endpoint), S.Handler); server.service = SimpleNamespace(retained_restores=lambda: self.manager)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        def request(action, value):
            body = value if isinstance(value, bytes) else json.dumps(value).encode()
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            with connection:
                connection.connect(str(endpoint))
                headers = ('POST /v1/retained-restore/' + identifier + '/' + action + ' HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(body)) + '\r\n\r\n').encode()
                connection.sendall(headers + body); response = b''
                while True:
                    part = connection.recv(65536)
                    if not part: break
                    response += part
            head, payload = response.split(b'\r\n\r\n', 1)
            return head, json.loads(payload)
        with mock.patch.object(S, 'trusted_capture_peer', return_value=True):
            head, proof = request('terminal-proof', {'token': self.key}); self.assertIn(b'200 OK', head)
            self.assertEqual(proof['state'], 'complete')
            self.assertIn(b'409', request('terminal-proof', ('{"token":"' + self.key + '","token":"' + self.key + '"}').encode())[0])
            self.assertIn(b'409', request('terminal-finalize', {'token': self.key, 'proofSha256': proof['proofSha256'], 'extra': True})[0])
            head, settled = request('terminal-finalize', {'token': self.key, 'proofSha256': proof['proofSha256']}); self.assertIn(b'200 OK', head)
            self.assertEqual(settled, {'version': 1, 'transactionId': identifier, 'state': 'settled', 'proofSha256': proof['proofSha256']})
        with mock.patch.object(S, 'trusted_capture_peer', return_value=False):
            self.assertIn(b'409', request('terminal-proof', {'token': self.key})[0])

    def test_terminal_settlement_retries_crash_after_durable_receipt_before_marker_clear(self):
        self.begin();identifier=self.request['restoreId'];self.manager.prepare(identifier,self.key);self.manager.activate(identifier,self.key)
        proof=self.manager.terminal_proof(identifier,self.key)
        self.assertEqual(self.manager.maintenance(),{'state':'checking'})
        with mock.patch.object(self.manager,'clear_marker',side_effect=RuntimeError('crash before marker clear')):
            with self.assertRaises(RuntimeError):self.manager.terminal_finalize(identifier,self.key,proof['proofSha256'])
        self.assertTrue(self.manager.read(identifier)['terminalSettled']);self.assertEqual(self.manager.maintenance(),{'state':'checking'})
        self.runtime.fail_at='reconcile-terminal-pointer'
        result=self.manager.terminal_finalize(identifier,self.key,proof['proofSha256'])
        self.assertEqual(result['state'],'settled');self.assertEqual(self.manager.maintenance(),{'state':'idle'})
        self.assertEqual(self.runtime.events.count('reconcile-terminal-pointer'),1)
        self.assertEqual(self.manager.terminal_finalize(identifier,self.key,proof['proofSha256']),result)

    def test_terminal_finalizer_requires_exact_discard_transition_receipt_and_absent_pointer(self):
        runtime=D.DockerRestoreRuntime(self.manager);identifier=self.request['restoreId'];nonce=str(uuid.uuid4())
        private=self.manager.directory(identifier,create=True);store=self.root/'restore-store';store.mkdir(mode=0o700);node=store/identifier;node.mkdir(mode=0o700)
        original={'version':1,'id':identifier,'nonce':nonce,'phase':'staging','decision':None,'originalController':'1'*64,'candidateController':'1'*64,'worker':'6'*64,'verifierController':'7'*64,'roots':['state']}
        original_body=runtime.P.canonical(original)
        (private/'node-terminal-journal.json').write_bytes(original_body);(private/'node-terminal-journal.json').chmod(0o600)
        proof={'proofSha256':'a'*64,'nodeJournalSha256':D.hashed(original_body),'operationSha256':None,'decision':'rollback','nodePhase':'staging',
               'survivor':{'id':'1'*64},'database':{'oid':42,'connectionSha256':'c'*64,'environmentSha256':'d'*64}}
        record={'id':identifier,'pointId':self.request['pointId'],'stage':{'journalPath':str(node)}}
        receipt={'version':1,'transactionId':identifier,'pointId':record['pointId'],'proofSha256':proof['proofSha256'],
                 'nodeJournalSha256':proof['nodeJournalSha256'],'operationSha256':None,'decision':'rollback','survivorId':'1'*64,'databaseOid':42}
        receipt_body=runtime.P.canonical(receipt);(node/'retained-terminal-reconciliation.json').write_bytes(receipt_body);(node/'retained-terminal-reconciliation.json').chmod(0o600)
        runtime.terminal_survivor_database=mock.Mock(return_value=(proof['survivor'],{**proof['database'],'environmentSha256':'e'*64}))
        (node/'restore.json').write_bytes(original_body);(node/'restore.json').chmod(0o600)
        with self.assertRaises(ValueError):runtime.finalize_terminal_metadata(record,proof)
        discarded={**original,'phase':'discarded','decision':'rollback'};(node/'restore.json').write_bytes(runtime.P.canonical(discarded))
        (store/'active.json').write_bytes(b'{}');(store/'active.json').chmod(0o600)
        with self.assertRaises(ValueError):runtime.finalize_terminal_metadata(record,proof)
        (store/'active.json').unlink();self.assertEqual(runtime.finalize_terminal_metadata(record,proof),D.hashed(receipt_body))
        (node/'restore.json').write_bytes(runtime.P.canonical({**discarded,'worker':'9'*64}))
        with self.assertRaises(ValueError):runtime.finalize_terminal_metadata(record,proof)

    def test_terminal_operation_cannot_enroll_unpinned_backend_json_and_survives_owned_cleanup(self):
        runtime=D.DockerRestoreRuntime(self.manager);identifier=self.request['restoreId'];directory=self.manager.directory(identifier,create=True)
        backend=self.root/'node';backend.mkdir(mode=0o700);body=b'{"version":1,"fixture":"actual immutable byte sequence"}'
        (backend/'runtime.json').write_bytes(body);(backend/'runtime.json').chmod(0o600)
        record={'id':identifier,'stage':{'journalPath':str(backend)}}
        with self.assertRaises(ValueError):runtime.terminal_operation(record)
        self.assertFalse((directory/'node-runtime.json').exists())
        record['preparedOperationSha256']=D.hashed(body)
        operation,digest=runtime.terminal_operation(record);self.assertEqual(digest,D.hashed(body));self.assertEqual(operation['version'],1)
        (backend/'runtime.json').unlink();self.assertEqual(runtime.terminal_operation(record),(operation,digest))
        (directory/'node-runtime.json').write_bytes(b'changed')
        with self.assertRaises(ValueError):runtime.terminal_operation(record)

    def test_terminal_survivor_and_database_are_observed_without_restoring_or_rewriting_state(self):
        runtime=D.DockerRestoreRuntime(self.manager);identifier=self.request['restoreId'];environment=self.root/'.env'
        environment.write_bytes(b'fixture current database binding');environment.chmod(0o600);env_sha=D.hashed(environment.read_bytes())
        raw={'Id':'3'*64,'Name':'/runtipi','Image':'sha256:'+'a'*64,'State':{'Running':True,'Paused':False,'Restarting':False,'Health':{'Status':'healthy'}},'NetworkSettings':{'Networks':{}}}
        database={'Id':'5'*64,'Image':'sha256:'+'b'*64,'State':{'Running':True},'Config':{'Labels':{'com.docker.compose.project.working_dir':str(self.root),'com.docker.compose.service':'runtipi-db'}}}
        connection={'database':'tipi','user':'fixture_user','host':'runtipi-db','port':5432,'password':'fixture-secret'}
        name='orbis_restore_'+identifier.replace('-','');owner={'name':name,'oid':42,'marker':'orbis.restore.v1/'+identifier+'/nonce'}
        operation={'database':{'connection':connection,'owner':owner}}
        record={'id':identifier,'decision':'commit','candidateId':'3'*64,'target':{'creationReference':raw['Image']},'definitions':{'candidate':'c'*64},
                'source':{'controllerId':'1'*64,'imageId':'sha256:'+'d'*64,'definition':'e'*64,'files':{'.env':env_sha},'container':{'NetworkSettings':{'Networks':{}}}},
                'stage':{'journalPath':str(self.root),'bootstrap':{'connection':connection}}}
        runtime.inspect=mock.Mock(side_effect=lambda value:database if value=='runtipi-db' else raw)
        runtime.definition=mock.Mock(return_value='c'*64);runtime.assert_active=mock.Mock();runtime.terminal_operation=mock.Mock(return_value=(operation,'f'*64))
        runtime.map_path=mock.Mock(return_value=environment);runtime.reader=mock.Mock();runtime.reader._read.return_value=runtime.P.canonical({'oid':42,'marker':owner['marker'],'owner':'fixture_user'}).decode()
        with mock.patch.object(runtime.host,'saved_state',return_value={'files':{'.env':env_sha}}):
            survivor,observed=runtime.terminal_survivor_database(record)
            self.assertEqual(survivor['id'],'3'*64);self.assertEqual(observed['name'],name)
            self.assertEqual(observed['connectionSha256'],D.hashed(runtime.P.canonical({**connection,'database':name})))
            runtime.reader._read.return_value=runtime.P.canonical({'oid':43,'marker':owner['marker'],'owner':'fixture_user'}).decode()
            with self.assertRaises(ValueError):runtime.terminal_survivor_database(record)
            raw['State']['Health']['Status']='unhealthy'
            with self.assertRaises(ValueError):runtime.terminal_survivor_database(record)
        self.assertEqual(environment.read_bytes(),b'fixture current database binding')

    def test_phase_acknowledgement_pins_exact_runtime_only_after_matching_all_independent_roles(self):
        runtime=D.DockerRestoreRuntime(self.manager);identifier=self.request['restoreId'];nonce=str(uuid.uuid4())
        node=self.root/'ack-node';node.mkdir(mode=0o700);self.manager.directory(identifier,create=True)
        ids={'original':'1'*64,'worker':'2'*64,'candidate':'3'*64,'verifier':'4'*64}
        raw={role:{'Id':value,'Name':'/'+role,'Image':'sha256:'+'a'*64,'Config':{},'HostConfig':{},'Mounts':[],
                   'NetworkSettings':{'Networks':{}},'State':{'Running':role=='worker'}} for role,value in ids.items()}
        runtime.inspect=mock.Mock(side_effect=lambda value:next(item for item in raw.values() if item['Id']==value))
        incoming=b'fixture incoming environment';(node/'incoming.env').write_bytes(incoming);(node/'incoming.env').chmod(0o600)
        journal={'id':identifier,'nonce':nonce,'phase':'prepared','decision':None,'worker':ids['worker'],'originalController':ids['original'],
                 'candidateController':ids['candidate'],'verifierController':ids['verifier']}
        operation={'version':1,'id':identifier,'nonce':nonce,'image':'sha256:'+'a'*64,'apps':[],'queue':{'fixture':'independently pinned'},
                   'originalEnvSha256':'b'*64,'incomingEnvSha256':D.hashed(incoming),
                   **{role:{'id':value,'fingerprint':runtime.node_fingerprint(raw[role])} for role,value in ids.items()}}
        for name,body in [('restore.json',runtime.P.canonical(journal)),('runtime.json',runtime.P.canonical(operation))]:(node/name).write_bytes(body);(node/name).chmod(0o600)
        record={'id':identifier,'nonce':nonce,'workerId':ids['worker'],'candidateId':ids['candidate'],'verifierId':ids['verifier'],
                'source':{'controllerId':ids['original'],'imageId':'sha256:'+'a'*64,'files':{'.env':'b'*64},'container':{'NetworkSettings':{'Networks':{}}}},
                'stage':{'journalPath':str(node),'bootstrap':{'identity':{'apps':[],'queue':operation['queue']}}}}
        raw['candidate']['Config']['unexpected']='changed'
        with self.assertRaises(ValueError):runtime.pin_phase_operation(record,'prepare',None)
        self.assertFalse((self.manager.directory(identifier)/'node-runtime.json').exists())
        raw['candidate']['Config'].pop('unexpected')
        runtime.pin_phase_operation(record,'prepare',None)
        self.assertEqual(record['phaseOperationSha256'],D.hashed((node/'runtime.json').read_bytes()))
        self.assertEqual((self.manager.directory(identifier)/'node-runtime.json').read_bytes(),(node/'runtime.json').read_bytes())

    def test_terminal_material_binds_full_node_roles_pinned_runtime_and_actual_retired_absence(self):
        runtime=D.DockerRestoreRuntime(self.manager);identifier=self.request['restoreId'];nonce=str(uuid.uuid4())
        backend=self.root/'terminal-node';backend.mkdir(mode=0o700)
        journal={'id':identifier,'nonce':nonce,'phase':'completed','decision':'commit','originalController':'1'*64,
                 'candidateController':'3'*64,'worker':'2'*64,'verifierController':'4'*64}
        body=runtime.P.canonical(journal);(backend/'restore.json').write_bytes(body);(backend/'restore.json').chmod(0o600)
        record={'id':identifier,'nonce':nonce,'decision':'commit','source':{'controllerId':'1'*64},'candidateId':'3'*64,'workerId':'2'*64,'verifierId':'4'*64,
                'stage':{'journalPath':str(backend),'journal':{'nonce':nonce},'provisional':{'worker':{'id':'6'*64},'verifier':{'id':'7'*64}}},
                'cleaned':{'previous':'1'*64,'coordinator':'2'*64,'verifier':'4'*64,'provisional-worker':'6'*64,'provisional-verifier':'7'*64}}
        runtime.terminal_operation=mock.Mock(return_value=({'version':1},'a'*64));runtime.reader=mock.Mock();runtime.reader._read.return_value=''
        runtime.terminal_survivor_database=mock.Mock(return_value=({'fixture':'healthy survivor'},{'fixture':'verified DB'}))
        proof=runtime.terminal_material(record);self.assertEqual(proof['nodeJournalSha256'],D.hashed(body));self.assertEqual(len(proof['retired']),5)
        saved=record['cleaned'].pop('verifier')
        with self.assertRaises(ValueError):runtime.terminal_material(record)
        record['cleaned']['verifier']=saved;runtime.reader._read.return_value='1'*64
        with self.assertRaises(ValueError):runtime.terminal_material(record)
        runtime.reader._read.return_value='';runtime.terminal_operation.return_value=(None,None)
        with self.assertRaises(ValueError):runtime.terminal_material(record)

    def test_database_oid_query_is_numeric_and_exact_typed_owner_counts_and_ledger_are_required(self):
        runtime = D.DockerRestoreRuntime(self.manager);identifier=self.request['restoreId']
        runtime.inspect=mock.Mock(return_value={'Id':'a'*64,'Config':{'Labels':{'com.docker.compose.project.working_dir':str(self.root),'com.docker.compose.service':'runtipi-db'}},'State':{'Running':True}})
        runtime.reader=mock.Mock()
        ledger=[{'createdAt':1,'hash':'c'*64}]
        record={'id':identifier,'migrationLedger':ledger}
        owner={'name':'orbis_restore_'+identifier.replace('-',''),'oid':42,'marker':'orbis.restore.v1/'+identifier+'/nonce'}
        counts={name:0 for name in ('user','app','app_store','link')}
        operation={'database':{'owner':owner,'connection':{'user':'fixture_user'},'counts':counts}}
        good={'oid':42,'marker':owner['marker'],'owner':'fixture_user'}
        def verify(observed=good,observed_counts=None,observed_ledger=ledger):
            runtime.reader._read.side_effect=[runtime.P.canonical(observed).decode(),runtime.P.canonical(observed_counts if observed_counts is not None else {**counts,'pendingApps':0}).decode(),runtime.P.canonical(observed_ledger).decode()]
            runtime.verify_database(record,operation)
        verify()
        self.assertIn("'oid',oid::bigint",runtime.reader._read.call_args_list[0].args[0][-1])
        for oid in ('42',True,-1,0,2**32):
            with self.subTest(oid=oid),self.assertRaises(ValueError):verify({**good,'oid':oid})
        for key in ('marker','owner'):
            with self.subTest(key=key),self.assertRaises(ValueError):verify({**good,key:'different'})
        with self.assertRaises(ValueError):verify(observed_counts={**counts,'pendingApps':False})
        with self.assertRaises(ValueError):verify(observed_ledger=[{'createdAt':1,'hash':'d'*64}])

    def test_prepared_and_promoted_bind_the_actual_node_runtime_json_not_an_alias(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        path = self.root / 'node-journal';path.mkdir(mode=0o700)
        identifier = self.request['restoreId'];nonce = str(uuid.uuid4());incoming = b'fixture retained environment'
        operation = {'id':identifier,'nonce':nonce,'worker':{'id':'2'*64},'original':{'id':'1'*64},
                     'candidate':{'id':'3'*64},'verifier':{'id':'4'*64},'incomingEnvSha256':D.hashed(incoming),
                     'database':{'owner':{'name':'orbis_restore_'+identifier.replace('-',''),'marker':'orbis.restore.v1/'+identifier+'/'+nonce}}}
        bodies = {'runtime.json':runtime.P.canonical(operation),'restore.json':runtime.P.canonical({'phase':'prepared','decision':None}),
                  'incoming.env':incoming,'operation.json':b'UNTRUSTED_ALIAS_MUST_NOT_BE_READ'}
        for name,body in bodies.items():(path/name).write_bytes(body);(path/name).chmod(0o600)
        record = {'id':identifier,'nonce':nonce,'workerId':'2'*64,'candidateId':'3'*64,'verifierId':'4'*64,
                  'source':{'controllerId':'1'*64,'container':{},'files':{}},'stage':{'journalPath':str(path)}}
        runtime.manager=SimpleNamespace(save=mock.Mock());runtime.validate_worker=mock.Mock();runtime.verify_database=mock.Mock()
        runtime.validate_prepared(record)
        self.assertEqual(record['preparedOperationSha256'],D.hashed(bodies['runtime.json']))
        runtime.verify_database.assert_called_with(record,operation)
        runtime.validate_overlay=mock.Mock();runtime.map_path=mock.Mock(return_value=path/'incoming.env')
        runtime.validate_promoted(record)
        (path/'runtime.json').write_bytes(b'changed')
        with self.assertRaises(ValueError):runtime.validate_promoted(record)
        (path/'runtime.json').unlink()
        with self.assertRaises(FileNotFoundError):runtime.validate_prepared(record)

    def test_early_provisional_retirement_requires_never_started_exact_identity_and_reconciles_lost_reply(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        identifier = self.request['restoreId'];owned = 'b' * 64
        record = {'id': identifier, 'decision': None, 'source': {'controllerId': 'a' * 64, 'container': {'NetworkSettings': {'Networks': {'main': {'NetworkID': 'f' * 64}}}}},
                  'stage': {'provisional': {'worker': {'id': owned, 'definition': 'exact'}}}}
        raw = {'Id': owned, 'Name': '/orbis-restore-' + identifier + '-worker', 'RestartCount': 0,
               'State': {'Running': False, 'Restarting': False, 'Paused': False, 'StartedAt': '0001-01-01T00:00:00Z'},
               'NetworkSettings': {'Networks': {'main': {'NetworkID': ''}}}}
        runtime.inspect = mock.Mock(return_value=raw);runtime.definition = mock.Mock(return_value='exact')
        runtime.reader = mock.Mock();runtime.reader._read.return_value=owned
        runtime.manager = SimpleNamespace(save=mock.Mock())
        operations=[]
        def change(args):
            operations.append(args)
            if args[0]=='rm':
                self.assertEqual(record['cleanupIntents']['provisional-worker'],owned)
                runtime.reader._read.return_value=''
                raise RuntimeError('lost exact rm reply')
        runtime.change=change
        raw['State']['StartedAt']='2026-11-01T00:00:00Z'
        with self.assertRaises(ValueError):runtime.retire_provisional(record)
        self.assertEqual(operations,[])
        raw['State']['StartedAt']='0001-01-01T00:00:00Z'
        runtime.definition.return_value='changed'
        with self.assertRaises(ValueError):runtime.retire_provisional(record)
        self.assertEqual(operations,[])
        runtime.definition.return_value='exact'
        with self.assertRaises(RuntimeError):runtime.retire_provisional(record)
        runtime.retire_provisional(record)
        self.assertEqual(record['cleaned']['provisional-worker'],owned)
        self.assertEqual(operations.count(['rm',owned]),1)
        self.assertNotIn(record['source']['controllerId'],[value for args in operations for value in args])

    def test_docker_omitted_writable_readonly_default_is_exact_and_rejects_coercions(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        body = {'HostConfig': {'Mounts': [{'Type': 'bind', 'Source': '/fixture', 'Target': '/data'}]}, 'NetworkingConfig': {'EndpointsConfig': {'main': {}}}}
        raw = {'Config': {}, 'HostConfig': {}, 'Mounts': [{'Type': 'bind', 'Source': '/fixture', 'Destination': '/data', 'RW': True, 'Propagation': 'rprivate'}],
               'NetworkSettings': {'Networks': {'main': {}}}}
        runtime.check_intent(raw, body)
        for read_only in (False, True):
            body['HostConfig']['Mounts'][0]['ReadOnly'] = read_only
            raw['Mounts'][0]['RW'] = not read_only
            runtime.check_intent(raw, body)
        for invalid in (None, 0, 1, 'false', [], {}):
            body['HostConfig']['Mounts'][0]['ReadOnly'] = invalid
            with self.subTest(value=invalid), self.assertRaises(ValueError):
                runtime.check_intent(raw, body)
        body['HostConfig']['Mounts'][0].pop('ReadOnly')
        with self.assertRaises(ValueError):
            runtime.check_intent(raw, body)

    def mixed_mount_intent(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        host = {'Mounts': [{'Type': 'bind', 'Source': '/fixture/data', 'Target': '/data', 'ReadOnly': False}],
                'Binds': ['/run/orbis:/run/orbis:ro']}
        body = {'HostConfig': copy.deepcopy(host), 'NetworkingConfig': {'EndpointsConfig': {'main': {}}}}
        raw = {'Config': {}, 'HostConfig': copy.deepcopy(host),
               'Mounts': [{'Type': 'bind', 'Source': '/fixture/data', 'Destination': '/data', 'RW': True, 'Propagation': 'rprivate'},
                          {'Type': 'bind', 'Source': '/run/orbis', 'Destination': '/run/orbis', 'RW': False, 'Propagation': 'rprivate'}],
               'NetworkSettings': {'Networks': {'main': {}}}}
        return runtime, body, raw

    def test_mixed_structured_and_legacy_bind_intent_requires_exact_complete_union(self):
        runtime, body, raw = self.mixed_mount_intent()
        runtime.check_intent(raw, body)
        raw['Mounts'].reverse(); runtime.check_intent(raw, body)
        for suffix, writable, propagation in [('', True, 'rprivate'), (':rw', True, 'rprivate'),
                                                (':ro,rslave', False, 'rslave'), (':ro,z', False, 'rprivate')]:
            expected = '/run/orbis:/run/orbis' + suffix
            body['HostConfig']['Binds'] = [expected]; raw['HostConfig']['Binds'] = [expected]
            raw['Mounts'][0].update(RW=writable, Propagation=propagation)
            runtime.check_intent(raw, body)
        runtime, body, raw = self.mixed_mount_intent()
        body['HostConfig'].pop('Mounts'); raw['HostConfig'].pop('Mounts'); raw['Mounts'].pop(0)
        runtime.check_intent(raw, body)

    def test_mixed_mount_intent_rejects_missing_extra_changed_and_duplicate_actual_binds(self):
        def missing(raw): raw['Mounts'].pop()
        def extra(raw): raw['Mounts'].append({'Type': 'bind', 'Source': '/other', 'Destination': '/extra', 'RW': True, 'Propagation': 'rprivate'})
        def duplicate(raw): raw['Mounts'].append(copy.deepcopy(raw['Mounts'][0]))
        def source(raw): raw['Mounts'][1]['Source'] = '/other'
        def writable(raw): raw['Mounts'][1]['RW'] = True
        def coercion(raw): raw['Mounts'][1]['RW'] = 0
        def kind(raw): raw['Mounts'][1]['Type'] = 'volume'
        def propagation(raw): raw['Mounts'][1]['Propagation'] = 'rshared'
        def changed_legacy(raw): raw['HostConfig']['Binds'] = ['/run/orbis:/run/orbis:rw']
        for change in (missing, extra, duplicate, source, writable, coercion, kind, propagation, changed_legacy):
            runtime, body, raw = self.mixed_mount_intent(); change(raw)
            with self.subTest(change=change.__name__), self.assertRaises(ValueError): runtime.check_intent(raw, body)
        runtime, body, raw = self.mixed_mount_intent()
        body['HostConfig']['Mounts'].append({'Type': 'bind', 'Source': '/run/orbis', 'Target': '/run/orbis', 'ReadOnly': True})
        with self.assertRaises(ValueError): runtime.check_intent(raw, body)

    def test_legacy_bind_intent_rejects_ambiguous_paths_modes_and_untyped_lists(self):
        invalid = ['', 'named-volume:/run/orbis:ro', '/run/orbis:relative:ro', '/run/orbis:/run/orbis:',
                   '/run/orbis:/run/orbis:ro,rw', '/run/orbis:/run/orbis:ro,ro', '/run/orbis:/run/orbis:rprivate,rshared',
                   '/run/orbis:/run/orbis:ro,Z,z', '/run/orbis:/run/orbis:unknown', '/run/orbis:/run/orbis:ro:extra',
                   '/run/orbis:/run/../orbis:ro', '/run/orbis:/run/orbis:ro\n', None, 0, False, {}, []]
        for entry in invalid:
            runtime, body, raw = self.mixed_mount_intent(); body['HostConfig']['Binds'] = [entry]; raw['HostConfig']['Binds'] = [entry]
            with self.subTest(entry=entry), self.assertRaises(ValueError): runtime.check_intent(raw, body)
        for value in (False, 0, '', {}, 'not-an-array'):
            for field in ('Mounts', 'Binds'):
                runtime, body, raw = self.mixed_mount_intent(); body['HostConfig'][field] = value
                with self.subTest(field=field, value=value), self.assertRaises(ValueError): runtime.check_intent(raw, body)
        for value in (False, 0, '', [], {'Propagation': False}, {'Propagation': []}):
            runtime, body, raw = self.mixed_mount_intent(); body['HostConfig']['Mounts'][0]['BindOptions'] = value
            with self.subTest(options=value), self.assertRaises(ValueError): runtime.check_intent(raw, body)

    def test_preworker_allocation_recovery_rechecks_mixed_intent_before_exact_retirement(self):
        runtime, body, raw = self.mixed_mount_intent()
        identifier, candidate = self.request['restoreId'], '3' * 64
        raw.update(Id=candidate, Name='/orbis-retained-' + identifier + '-candidate', Image='sha256:' + 'a' * 64,
                   State={'Running': False})
        body['Labels'] = {'io.orbis.restore': identifier}; raw['Config']['Labels'] = body['Labels'].copy()
        policy = {'Name': 'no', 'MaximumRetryCount': 0}
        body['HostConfig']['RestartPolicy'] = policy; raw['HostConfig']['RestartPolicy'] = policy.copy()
        raw['NetworkSettings']['Networks']['main'] = {'NetworkID': ''}
        record = {'id': identifier, 'phase': 'rolled-back', 'decision': 'rollback', 'candidateId': candidate,
                  'definitions': {}, 'intents': {'candidate': {'name': raw['Name'][1:], 'body': body}},
                  'source': {'controllerId': '1' * 64, 'container': {'NetworkSettings': {'Networks': {'main': {'NetworkID': 'b' * 64}}}}}}
        saved, actions = [], []
        runtime.manager = SimpleNamespace(save=lambda value: saved.append(copy.deepcopy(value)), read=lambda _: record)
        runtime.inspect = mock.Mock(return_value=raw); runtime.image = mock.Mock(return_value={'Config': {'Labels': {}}})
        runtime.change = mock.Mock(side_effect=lambda args: actions.append(args))
        original = raw['Mounts'][1]['RW']; raw['Mounts'][1]['RW'] = True
        with self.assertRaises(ValueError): runtime.quiesce_owned(record)
        self.assertEqual(actions, []); self.assertEqual(record['definitions'], {})
        raw['Mounts'][1]['RW'] = original
        runtime.quiesce_owned(record)
        self.assertEqual(record['definitions']['candidate'], runtime.definition(raw)); self.assertTrue(saved)
        self.assertEqual(actions, [['update', '--restart', 'no', candidate]])
        runtime.reader = mock.Mock(); runtime.reader._read.return_value = candidate + '\n'
        runtime.restore_original_controller = mock.Mock()
        runtime.retire_auxiliary(record)
        self.assertIn(['rm', candidate], actions)
        self.assertTrue(all('1' * 64 not in action for action in actions))
        self.assertEqual(record['cleaned'], {'candidate': candidate})

    def staged_candidate_activation(self):
        self.begin(); identifier = self.request['restoreId']; self.manager.prepare(identifier, self.key)
        self.runtime.fail_at = 'activation'
        with self.assertRaises(RuntimeError): self.manager.activate(identifier, self.key)
        self.runtime.fail_at = None
        return identifier, self.manager.read(identifier)

    def test_candidate_resume_requires_live_exclusive_commit_and_cannot_renew_lease(self):
        identifier, original = self.staged_candidate_activation()
        with self.assertRaises(ValueError): self.manager.candidate_resume(identifier, self.key)
        with self.manager.operation(identifier):
            first = self.manager.candidate_resume(identifier, self.key)
            self.assertEqual(first['operationSha256'], 'a' * 64)
            self.assertEqual(first['state'], 'activating'); self.assertEqual(first['decision'], 'commit')
            self.assertEqual(first['binding'], self.manager.binding(original, include_snapshot=True))
            self.assertEqual(self.manager.candidate_resume(identifier, self.key), first)
            self.assertEqual(self.manager.read(identifier), original)
            with self.assertRaises(ValueError): self.manager.candidate_resume(identifier, '0' * 64)
            for field, value in [('decision', None), ('commitAuthorized', False), ('phase', 'prepared'),
                                 ('candidateActivationLease', None),
                                 ('candidateActivationLease', {'startedAt': 1, 'expiresAt': 900001}),
                                 ('candidateActivationLease', {'startedAt': True, 'expiresAt': 900001})]:
                record = copy.deepcopy(original); record[field] = value; self.manager.save(record)
                with self.subTest(field=field), self.assertRaises(ValueError): self.manager.candidate_resume(identifier, self.key)
            self.manager.save(original)
            expires = original['candidateActivationLease']['expiresAt']
            with mock.patch.object(M.time, 'time', return_value=expires / 1000):
                with self.assertRaises(ValueError): self.manager.candidate_resume(identifier, self.key)

    def test_candidate_resume_material_requires_root_pinned_runtime_and_actual_unhealthy_running_candidate(self):
        runtime = D.DockerRestoreRuntime(self.manager); identifier = self.request['restoreId']; nonce = str(uuid.uuid4())
        directory = self.root / 'candidate-resume'; directory.mkdir(mode=0o700)
        record = {'id': identifier, 'nonce': nonce, 'candidateId': '3' * 64, 'workerId': '2' * 64, 'verifierId': '4' * 64,
                  'preparedOperationSha256': 'a' * 64, 'source': {'controllerId': '1' * 64},
                  'target': {'creationReference': 'sha256:' + 'b' * 64}, 'definitions': {'candidate': 'exact-definition'},
                  'stage': {'journalPath': str(directory), 'metadata': {'imageCaptureSha256': 'c' * 64, 'imageInventorySha256': 'd' * 64}}}
        journal = {'version': 1, 'id': identifier, 'nonce': nonce, 'phase': 'committing', 'decision': 'commit', 'originalController': '1' * 64,
                   'candidateController': '3' * 64, 'worker': '2' * 64, 'verifierController': '4' * 64, 'roots': ['state']}
        record['stage']['journal'] = {**journal, 'phase': 'staging', 'decision': None, 'candidateController': '1' * 64,
                                      'worker': '6' * 64, 'verifierController': '7' * 64}
        (directory / 'restore.json').write_bytes(runtime.P.canonical(journal)); (directory / 'restore.json').chmod(0o600)
        operation = {'id': identifier, 'nonce': nonce, 'resumeApps': []}
        runtime.check_source = mock.Mock(); runtime.terminal_operation = mock.Mock(return_value=(operation, 'a' * 64))
        raw = {'Name': '/runtipi', 'Image': record['target']['creationReference'], 'State': {'Running': True, 'Health': {'Status': 'unhealthy'}}}
        runtime.inspect = mock.Mock(return_value=raw); runtime.verify_networks = mock.Mock(); runtime.definition = mock.Mock(return_value='exact-definition')
        self.assertEqual(runtime.candidate_resume_material(record)['operationSha256'], 'a' * 64)
        for field, value in [('Name', '/other'), ('Image', 'sha256:' + 'e' * 64), ('State', {'Running': False}), ('State', {'Running': True, 'Paused': True})]:
            changed = copy.deepcopy(raw); changed[field] = value; runtime.inspect.return_value = changed
            with self.subTest(field=field), self.assertRaises(ValueError): runtime.candidate_resume_material(record)
        runtime.inspect.return_value = raw
        runtime.terminal_operation.return_value = (operation, 'f' * 64)
        with self.assertRaises(ValueError): runtime.candidate_resume_material(record)
        runtime.terminal_operation.return_value = (operation, 'a' * 64)
        for field, value in [('worker', '5' * 64), ('roots', ['state', 'traefik']), ('version', True), ('extra', True)]:
            changed = {**journal, field: value}; (directory / 'restore.json').write_bytes(runtime.P.canonical(changed))
            with self.subTest(field=field), self.assertRaises(ValueError): runtime.candidate_resume_material(record)

    def test_candidate_lease_is_root_persisted_before_start_without_releasing_maintenance(self):
        runtime = D.DockerRestoreRuntime(self.manager); saved, actions = [], []
        record = {'decision': 'commit', 'candidateId': '3' * 64, 'target': {'creationReference': 'sha256:' + 'a' * 64}}
        raw = {'Id': '3' * 64, 'Image': record['target']['creationReference'], 'State': {'Running': False}}
        runtime.inspect = mock.Mock(return_value=raw); runtime.verify_networks = mock.Mock()
        runtime.manager = SimpleNamespace(save=lambda value: saved.append(copy.deepcopy(value)))
        runtime.change = lambda value: actions.append((value, copy.deepcopy(saved[-1])))
        runtime.health = mock.Mock(); runtime.enroll_committed = mock.Mock()
        with mock.patch.object(D.time, 'time', return_value=1000): runtime.activate_candidate(record)
        self.assertEqual(record['candidateActivationLease'], {'startedAt': 1000000, 'expiresAt': 1900000})
        self.assertEqual(actions, [(['start', '3' * 64], saved[0])]); runtime.health.assert_called_once()

    def test_postcommit_recovery_quiesces_exact_candidate_child_processes_without_reverting_data(self):
        runtime, body, raw = self.mixed_mount_intent(); identifier = self.request['restoreId']; candidate = '3' * 64
        raw.update(Id=candidate, Name='/runtipi', Image='sha256:' + 'a' * 64, State={'Running': True})
        raw['NetworkSettings']['Networks']['main'] = {'NetworkID': 'b' * 64}
        body['Labels'] = {'io.orbis.restore': identifier}; raw['Config']['Labels'] = body['Labels'].copy()
        policy = {'Name': 'no', 'MaximumRetryCount': 0}; body['HostConfig']['RestartPolicy'] = policy; raw['HostConfig']['RestartPolicy'] = policy.copy()
        record = {'id': identifier, 'decision': 'commit', 'candidateId': candidate, 'definitions': {'candidate': runtime.definition(raw)},
                  'intents': {'candidate': {'name': 'orbis-retained-' + identifier + '-candidate', 'body': body}},
                  'source': {'controllerId': '1' * 64, 'container': {'NetworkSettings': {'Networks': {'main': {'NetworkID': 'b' * 64}}}}}}
        runtime.manager = SimpleNamespace(save=mock.Mock()); runtime.inspect = mock.Mock(return_value=raw)
        runtime.image = mock.Mock(return_value={'Config': {'Labels': {}}}); actions = []
        def change(value):
            actions.append(value)
            if value[0] == 'stop': raw['State']['Running'] = False
        runtime.change = change
        runtime.quiesce_owned(record)
        self.assertIsNone(record['candidateActivationLease'])
        self.assertIn(['stop', '--time', '30', candidate], actions)
        self.assertFalse(raw['State']['Running'])
        self.assertTrue(all(action[0] in {'update', 'stop'} and '1' * 64 not in action for action in actions))
        actions.clear(); runtime.quiesce_owned(record)
        self.assertTrue(all(action[0] == 'update' for action in actions))

    def test_actual_candidate_resume_route_uses_token_only_while_root_operation_is_held(self):
        identifier, record = self.staged_candidate_activation()
        endpoint = self.base / 'candidate-host.sock'
        server = S.UnixHTTPServer(str(endpoint), S.Handler); server.service = SimpleNamespace(retained_restores=lambda: self.manager)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        def request(value):
            body = value if isinstance(value, bytes) else json.dumps(value).encode()
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); connection.settimeout(2)
            with connection:
                connection.connect(str(endpoint))
                headers = ('POST /v1/retained-restore/' + identifier + '/candidate-resume HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(body)) + '\r\n\r\n').encode()
                connection.sendall(headers + body); response = b''
                while True:
                    part = connection.recv(65536)
                    if not part: break
                    response += part
            head, data = response.split(b'\r\n\r\n', 1)
            return head, json.loads(data)
        with mock.patch.object(S, 'trusted_capture_peer', return_value=True):
            with self.manager.operation(identifier):
                head, response = request({'token': self.key}); self.assertIn(b'200 OK', head)
                self.assertEqual(set(response), {'version', 'transactionId', 'pointId', 'nonce', 'state', 'decision', 'binding',
                    'operationSha256', 'imageCaptureSha256', 'imageInventorySha256', 'expiresAt'})
                self.assertEqual(response['expiresAt'], record['candidateActivationLease']['expiresAt'])
                self.assertIn(b'409', request({'token': self.key, 'expiresAt': response['expiresAt'] + 1000})[0])
                duplicate = ('{"token":"' + self.key + '","token":"' + self.key + '"}').encode()
                self.assertIn(b'409', request(duplicate)[0])
            self.assertIn(b'409', request({'token': self.key})[0])
        with mock.patch.object(S, 'trusted_capture_peer', return_value=False):
            self.assertIn(b'409', request({'token': self.key})[0])

    def test_actual_candidate_resume_capability_is_strict_static_and_peer_protected(self):
        endpoint = self.base / 'candidate-capability.sock'
        server = S.UnixHTTPServer(str(endpoint), S.Handler); server.service = SimpleNamespace()
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        def request():
            connection = D.Connection(str(endpoint))
            try:
                connection.request('GET', '/v1/retained-restore/candidate-resume-capability')
                response = connection.getresponse(); return response.status, json.loads(response.read())
            finally: connection.close()
        with mock.patch.object(S, 'trusted_capture_peer', return_value=True):
            status, value = request(); self.assertEqual(status, 200)
            self.assertEqual(value, {'version': 1, 'protocol': 'root-candidate-resume.v1', 'leaseMilliseconds': 900000,
                                    'requiresAppCapability': 'orbis.retained-app-activation.v1', 'normalBootstrap': 'root-normal-bootstrap.v1',
                                    'ordinaryWritesHeldUntilBootstrap': True})
        with mock.patch.object(S, 'trusted_capture_peer', return_value=False):
            self.assertEqual(request()[0], 403)

    def test_root_commit_acknowledgement_recovery_requires_exact_node_binding(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        record = {'id': self.request['restoreId'], 'nonce': 'n', 'decision': 'commit', 'commitAuthorized': True,
                  'stage': {'journalPath': '/fixture'}, 'source': {'controllerId': '1' * 64},
                  'candidateId': '2' * 64, 'verifierId': '3' * 64, 'workerId': '4' * 64}
        journal = {'id': record['id'], 'nonce': 'n', 'decision': 'commit', 'phase': 'committing', 'originalController': '1' * 64,
                   'candidateController': '2' * 64, 'verifierController': '3' * 64, 'worker': '4' * 64}
        runtime.json = mock.Mock(return_value=journal)
        self.assertTrue(runtime.node_commit_authorized(record))
        for field, value in [('phase', 'promoted'), ('decision', 'rollback'), ('candidateController', '5' * 64), ('nonce', 'other')]:
            with self.subTest(field=field):
                runtime.json.return_value = {**journal, field: value}
                self.assertFalse(runtime.node_commit_authorized(record))
        runtime.json.return_value = journal
        record['commitAuthorized'] = False
        self.assertFalse(runtime.node_commit_authorized(record))

    def test_retirement_adapter_emits_exact_docker_container_rm_without_duplicate_prefix(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        runtime.reader = D.APPS.Docker('fixture')
        identifier = 'a' * 64
        with mock.patch.object(D.APPS.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run:
            runtime.change(['rm', identifier])
        self.assertEqual(run.call_args.args[0], ['docker', '--context', 'fixture', 'container', 'rm', identifier])
        self.assertNotIn('--volumes', run.call_args.args[0])

    def test_actual_packaged_drizzle_tree_recognizes_inert_snapshots_but_never_migrates_them(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        directory = self.manager.directory(self.request['restoreId'], create=True)
        (directory / 'retained').mkdir(mode=0o700)
        source = Path(__file__).parent.parent / 'packages/backend/src/core/database/drizzle'
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w') as archive:
            for path in sorted(source.rglob('*')):
                if path.is_file():
                    archive.add(path, arcname=str(path.relative_to(source)), recursive=False)
        runtime.bounded_output = mock.Mock(return_value=output.getvalue())
        record = {'id': self.request['restoreId']}
        runtime.copy_migrations(record, '1' * 64, None)
        destination = directory / 'retained/migrations'
        self.assertEqual(set(record['migrationFiles']), {path.name for path in source.glob('*.sql')} | {'meta/_journal.json'})
        self.assertIn('meta/0000_snapshot.json', record['migrationAuxiliaryFiles'])
        self.assertIn('schema.ts', record['migrationAuxiliaryFiles'])
        self.assertFalse((destination / 'meta/0000_snapshot.json').exists())
        self.assertFalse((destination / 'schema.ts').exists())
        self.assertEqual(len(record['migrationLedger']), len(json.loads((source / 'meta/_journal.json').read_bytes())['entries']))
        for name, kind in [('meta/not-a-snapshot.json', tarfile.REGTYPE), ('../escape.sql', tarfile.REGTYPE),
                           ('meta/0001_snapshot.json', tarfile.SYMTYPE), ('schema.ts', tarfile.LNKTYPE)]:
            with self.subTest(name=name, kind=kind):
                nested = self.manager.directory(str(uuid.uuid4()), create=True)
                (nested / 'retained').mkdir(mode=0o700)
                data = io.BytesIO()
                with tarfile.open(fileobj=data, mode='w') as archive:
                    item = tarfile.TarInfo(name); item.type = kind; item.linkname = 'outside'
                    archive.addfile(item, io.BytesIO(b''))
                runtime.bounded_output.return_value = data.getvalue()
                with self.assertRaises(ValueError):
                    runtime.copy_migrations({'id': nested.name}, '1' * 64, None)

    def test_real_shaped_proxy_array_has_separate_strict_bounded_parser(self):
        runtime = D.DockerRestoreRuntime(self.manager)
        body = b'[{"name":"dashboard@docker","rule":"PathPrefix(`/`)","entryPoints":["web"],"priority":15,"service":"dashboard","status":"enabled"}]'
        self.assertEqual(runtime.parse_proxy_routers(body)['dashboard@docker']['priority'], 15)
        for malformed in (b'{"name":"not-an-array"}', b'[{"name":"a","name":"b"}]', b'[{"name":"a","priority":1.5}]',
                          b'[],"injected":true', b'[{"name":"a"},{"name":"a"}]', b'[true]', b'[' + b' ' * (1024 * 1024) + b']'):
            with self.subTest(malformed=malformed[:60]), self.assertRaises(ValueError):
                runtime.parse_proxy_routers(malformed)
        nested = '[' * 34 + '0' + ']' * 34
        with self.assertRaises(ValueError):
            runtime.parse_proxy_routers(('{"bad":' + nested + '}').encode())


if __name__ == '__main__':
    unittest.main()
