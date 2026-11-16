"""Synthetic Root/runtime boundaries around the real supervisor and durable broker.

No Docker, PostgreSQL, Root ownership or installation qualification is claimed.
The filesystem, worker definitions, supervisor transitions and receipts run for real.
"""
import contextlib
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module


M = load('orbis-host-core-clean-target-reconcile.py', 'reconcile_test_subject')
F = load('test_orbis_host_core_clean_target_bootstrap.py', 'reconcile_test_fixtures')
ID = 'a71c77d2-f420-440e-951b-083209514e72'
ACTOR = {'ownerId': 1, 'sessionBinding': 'a' * 64, 'securityBinding': 'b' * 64}


class Runtime(F.Runtime):
    def change(self, args):
        self.calls.append(tuple(args))
        worker = self.workers[args[-1]]
        if args[0] == 'stop':
            worker['State'].update(Status='exited', Running=False)
            return
        M.require(args[0] == 'start')
        worker['State'].update(Status='running', Running=True)
        body = worker['actualBody']
        role = body['Labels']['io.orbis.core-reconciliation.role']
        if role in {'reconcile', 'verify'}:
            self.publish(body, role == 'verify')

    def bounded_output(self, args, maximum, timeout):
        self.calls.append(tuple(args))
        M.require('wait' in args)
        worker = self.workers[args[-1]]
        role = worker['actualBody']['Labels']['io.orbis.core-reconciliation.role']
        worker['State'].update(Status='exited', Running=False, FinishedAt='2026-11-11T00:00:00Z')
        if self.mode == 'uncertain' and role == 'reconcile':
            raise TimeoutError('synthetic commit acknowledgement unavailable')
        return b'0\n'

    def publish(self, body, verify):
        record = self.manager.record(ID)
        bound = self.manager.bound(record)
        mounts = {row['Target']: Path(row['Source']) for row in body['HostConfig']['Mounts']}
        if verify:
            intent = json.loads((mounts['/clean-target-verify-input'] / 'write-intent.json').read_bytes())
            value = {'schema': 'orbis.core-clean-target-verification-result.v2', **bound,
                'writeIntentSha256': self.manager.digest(intent), 'prepared': intent['prepared'],
                'targetVerified': True, 'databaseCommitObserved': True, 'serverQuiescenceProved': False}
            self.enrollment.publisher(mounts['/clean-target-verify-output'] / 'result.json', self.manager.P.canonical(value))
            return
        request = record['request']
        descriptor = {'schema': 'orbis.core-clean-target-reconciliation.v2', 'id': ID, 'nonce': request['nonce'],
            'sourceIdentity': {'systemIdentifier': '100', 'databaseOid': '16384', 'database': 'source'},
            'destinationIdentity': {'systemIdentifier': '101', 'databaseOid': '16384', 'database': 'destination'},
            'targetIdentity': request['target'], 'sourceSha256': request['source']['snapshotSha256'],
            'destinationSha256': request['destination']['snapshotSha256'],
            'catalogSha256': request['expected']['catalogSha256'], 'authenticationSha256': 'a' * 64,
            'sourceAccountsSha256': '7' * 64, 'destinationAppsSha256': '8' * 64, 'destinationRecoverySha256': '9' * 64,
            'sourceOwnerId': 1, 'destinationOwnerId': 1, 'catalogOwnershipSha256': request['expected']['catalogOwnershipSha256'],
            'catalogContext': 'pg_catalog', 'major': self.manager.reconciliation_major(), 'environmentProved': False, 'restoreAuthority': False,
            'sequencePolicy': request['sequencePolicy']}
        prepared = descriptor | {'marker': 'orbis.core-clean-target.v2/' + ID + '/' + request['nonce'] + '/' + self.manager.digest(descriptor)}
        intent = {'schema': 'orbis.core-clean-target-write-intent.v2', **bound, 'prepared': prepared}
        values = {'worker-start.json': {'schema': 'orbis.core-clean-target-worker-start.v2', **bound}, 'write-intent.json': intent,
            'completion.json': {'schema': 'orbis.core-clean-target-completion.v2', **bound,
                'writeIntentSha256': self.manager.digest(intent), 'preparedSha256': self.manager.digest(prepared),
                'databaseCommitAcknowledged': True, 'targetVerified': False},
            'result.json': {'schema': 'orbis.core-clean-target-worker-result.v2', **bound,
                'writeIntentSha256': self.manager.digest(intent), 'prepared': prepared, 'targetVerified': True, 'serverQuiescenceProved': False}}
        if self.mode == 'tampered-result':
            values['result.json']['targetVerified'] = False
        if self.mode == 'uncertain':
            values.pop('completion.json')
            values.pop('result.json')
        for name, value in values.items():
            self.enrollment.publisher(mounts['/clean-target-output'] / name, self.manager.P.canonical(value))


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        root_probe = mock.patch.object(M.BOOTSTRAP.TARGET, 'require_root')
        root_probe.start()
        self.addCleanup(root_probe.stop)
        self.temp = tempfile.TemporaryDirectory(prefix='orbis-reconciliation-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.enrollment = F.Enrollment(self.root)
        self.runtime = self.enrollment.runtime = Runtime(self.enrollment)
        publisher = SimpleNamespace(a=self.enrollment.a)
        self.publisher = lambda path, body: M.BOOTSTRAP.CoreCleanTargetBootstrap.publish(publisher, path, body)
        self.enrollment.publisher = self.publisher
        self.code = self.enrollment.child(self.root, 'code')
        self.enrollment.immutable(self.code / 'core-clean-target-worker.mjs', b'fixture installed worker')
        self.broker = SimpleNamespace(enrollment=self.enrollment, trust=SimpleNamespace(
            image_id=self.runtime.node, source_controller_image_id=self.runtime.controller, code_directory=self.code))
        self.guard_depth = 0
        image = self.runtime.image(M.SOURCE.PG17_ARM64_IMAGE)
        profile = M.TARGET.clean_target_profile(image, 'target_role', 'target', {'encoding': 'UTF8', 'collate': 'C', 'ctype': 'C', 'provider': 'c'})
        target_dir = self.make_directories('target')
        self.binding = {'configuration': {}, 'codeDirectory': {}, 'codeSeals': {}, 'catalog': {},
            'catalogOwnerIds': [1], 'ownership': {'schema': 'fixture Root ownership boundary'},
            'target': {'directory': str(target_dir), 'profile': profile, 'receiptSha256': '4' * 64,
                'target': {'systemIdentifier': '200', 'databaseOid': '16384', 'database': 'target'},
                'workspace': {'allocation': {'id': ID, 'nonce': ID, 'rootIntentSha256': '5' * 64}, 'identities': {}}}}
        for index, role in enumerate(('source', 'destination')):
            directory = self.make_directories(role)
            trusted = self.enrollment.child(directory, 'trusted-input')
            auth = self.enrollment.P.canonical({'jwtSecret': 'synthetic authentication only ' * 3, 'passkeys': None})
            self.enrollment.immutable(trusted / 'source-authentication.json', auth)
            self.binding[role] = {'directory': str(directory),
                'authenticationSeal': list(F.Authority.seal((trusted / 'source-authentication.json').lstat())),
                'profile': M.SOURCE.role_bound_image_profile(image, role + '_role', 'e' * 64),
                'request': {'role': role + '_role', 'database': role, 'snapshotSha256': str(index + 1) * 64,
                    'authenticationSha256': M.BOOTSTRAP.sha(auth)},
                'evidence': {'catalogSha256': '3' * 64, 'authenticationSha256': 'a' * 64, 'systemIdentifier': str(100 + index)},
                'catalog': {'sourceControllerImageId': self.runtime.controller,
                    'ledger': [{'id': 1, 'hash': '6' * 64, 'created_at': '1'}]}}
        self.bootstrap = SimpleNamespace(read=self.read, publish=self.publisher, capacity=lambda directory: None,
            ledger_hash=lambda rows: self.digest(sorted(rows, key=self.enrollment.P.canonical)))
        approval = M.RootReconciliationApproval(ACTOR, object(), ID, object(), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            self.bootstrap, object(), self.binding, self.guard)
        self.manager = M.CoreCleanTargetReconcile(self.broker, approval)
        self.runtime.manager = self.manager
        self.live_binding = copy.deepcopy(self.binding)
        self.manager.current_binding = lambda active=False: copy.deepcopy(self.live_binding)
        patches = [mock.patch.object(self.manager, 'socket_available'),
            mock.patch.object(M.TARGET, 'database_body', side_effect=self.target_body)]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.original = self.root / 'original-live-data'
        self.original.write_bytes(b'original services and data')
        self.original_seal = F.Authority.seal(self.original.stat())

    def make_directories(self, name):
        directory = self.enrollment.child(self.root, name)
        for child in ('pgdata', 'socket', 'config'):
            self.enrollment.child(directory, child)
        return directory

    @contextlib.contextmanager
    def guard(self):
        self.guard_depth += 1
        try:
            yield
        finally:
            self.guard_depth -= 1

    def digest(self, value):
        return M.BOOTSTRAP.sha(self.enrollment.P.canonical(value))

    def read(self, path, maximum=65536):
        return F.BootstrapTests.read_owned_fixture(self.manager, path, maximum)

    def target_body(self, workspace, authority):
        return M.TARGET.body(workspace, 'database', '/usr/local/bin/postgres', ['-D', '/var/lib/postgresql/data'], [
            M.SOURCE.mount(workspace.directory / 'pgdata', '/var/lib/postgresql/data', False),
            M.SOURCE.mount(workspace.directory / 'socket', '/var/run/postgresql', False),
            M.SOURCE.mount(workspace.directory / 'config', '/clean-target-config', True)])

    def mutate(self, relative, change):
        path = self.manager.directory(ID) / relative
        value = json.loads(path.read_bytes())
        change(value)
        path.chmod(0o600)
        path.write_bytes(self.enrollment.P.canonical(value))
        path.chmod(0o400)

    def test_success_runs_real_supervisor_on_three_isolated_copies_and_checks_receipt(self):
        handle = self.manager.reconcile(ID, ACTOR)
        self.assertEqual(self.manager.checked(handle, ACTOR), handle)
        record = self.manager.record(ID)
        self.assertEqual(set(record['inspectionWorkers']), {'source-database', 'destination-database', 'target-database', 'reconcile'})
        self.assertEqual([call[0] for call in self.runtime.calls].count('start'), 4)
        self.assertEqual([call[0] for call in self.runtime.calls].count('stop'), 3)
        self.assertEqual(self.guard_depth, 0)
        self.assertEqual(F.Authority.seal(self.original.stat()), self.original_seal)
        worker = record['inspectionWorkers']['reconcile']['body']
        self.assertEqual(worker['Cmd'][-1], '--prepare')
        self.assertEqual(record['request']['sourceControllerImageId'], self.binding['source']['catalog']['sourceControllerImageId'])
        self.assertEqual(record['request']['sequencePolicy']['sourceControllerImageId'], self.binding['source']['catalog']['sourceControllerImageId'])
        self.assertEqual(worker['HostConfig']['NetworkMode'], 'none')
        for flag in ('activation', 'environmentProved', 'restoreAuthority'):
            self.assertIs(record[flag], False)
        with self.assertRaises(FileExistsError):
            self.manager.reconcile(ID, ACTOR)

    def test_real_shared600_auth_is_pinned_and_republished_as_new400_transport(self):
        originals = {}
        for role in ('source', 'destination'):
            path = Path(self.binding[role]['directory']) / 'trusted-input/source-authentication.json'
            self.assertEqual(stat.S_IMODE(path.lstat().st_mode), 0o600)
            originals[role] = (F.Authority.seal(path.lstat()), path.read_bytes())
        handle = self.manager.reconcile(ID, ACTOR)
        directory = self.manager.directory(ID)
        for name in ('root-intent.json', 'receipt.json'):
            self.assertEqual(stat.S_IMODE((directory / name).lstat().st_mode), 0o400)
        self.assertEqual(stat.S_IMODE((directory / 'job.json').lstat().st_mode), 0o600)
        for path in (directory / 'input').iterdir(): self.assertEqual(stat.S_IMODE(path.lstat().st_mode), 0o400)
        for role, (seal, body) in originals.items():
            original = Path(self.binding[role]['directory']) / 'trusted-input/source-authentication.json'
            self.assertEqual(F.Authority.seal(original.lstat()), seal)
            self.assertEqual(original.read_bytes(), body)
            self.assertEqual((directory / 'input' / (role + '-authentication.json')).read_bytes(), body)
        self.assertEqual(self.manager.checked(handle, ACTOR), handle)

    def test_recovery_verify_inputs_use_real_exclusive400_publisher(self):
        self.runtime.mode = 'uncertain'
        with self.assertRaises(ValueError): self.manager.reconcile(ID, ACTOR)
        self.settle_interrupted_fixture()
        self.runtime.mode = 'success'
        handle = self.manager.recover_committed(ID, ACTOR)
        directory = self.manager.directory(ID)
        self.assertEqual(set(path.name for path in (directory / 'verify-input').iterdir()), {'request.json', 'authorization.json', 'write-intent.json'})
        for path in (directory / 'verify-input').iterdir(): self.assertEqual(stat.S_IMODE(path.lstat().st_mode), 0o400)
        self.assertEqual(self.manager.checked(handle, ACTOR), handle)

    def test_reconcile_refuses_replaced600_inspector_auth_before_any_workers(self):
        original = Path(self.binding['source']['directory']) / 'trusted-input/source-authentication.json'
        body = original.read_bytes(); original.unlink(); self.enrollment.immutable(original, body)
        with self.assertRaises(ValueError): self.manager.reconcile(ID, ACTOR)
        self.assertEqual(self.manager.record(ID)['phase'], 'recovery-required')
        self.assertFalse(any(call[0] in {'create', 'start', 'stop'} for call in self.runtime.calls))
        self.assertFalse((self.manager.directory(ID) / 'receipt.json').exists())

    def test_changed_root_binding_refused_before_allocation(self):
        self.live_binding['catalogOwnerIds'] = [1, 2]
        with self.assertRaises(M.ReconciliationError):
            self.manager.reconcile(ID, ACTOR)
        self.assertEqual(self.runtime.calls, [])

    def test_result_tamper_cannot_grant_commit_or_authority(self):
        self.runtime.mode = 'tampered-result'
        with self.assertRaises(M.ReconciliationError):
            self.manager.reconcile(ID, ACTOR)
        self.assertEqual(self.manager.record(ID)['phase'], 'recovery-required')
        self.assertFalse((self.manager.directory(ID) / 'receipt.json').exists())

    def test_replacement_of_same_bytes_input_result_and_directory_refused(self):
        handle = self.manager.reconcile(ID, ACTOR)
        for relative in ('input/request.json', 'output/result.json'):
            with self.subTest(relative=relative):
                path = self.manager.directory(ID) / relative
                held = path.with_suffix('.retained')
                path.rename(held)
                self.publisher(path, held.read_bytes())
                with self.assertRaises(M.ReconciliationError):
                    self.manager.checked(handle, ACTOR)
                path.unlink()
                held.rename(path)
        directory = self.manager.directory(ID) / 'output'
        held = directory.with_name('retained-output')
        directory.rename(held)
        directory.mkdir(mode=0o700)
        with self.assertRaises(M.ReconciliationError):
            self.manager.checked(handle, ACTOR)

    def test_tampered_persisted_request_or_worker_identity_refused(self):
        handle = self.manager.reconcile(ID, ACTOR)
        worker = self.manager.record(ID)['inspectionWorkers']['reconcile']
        self.runtime.workers[worker['id']]['Name'] = '/replacement'
        with self.assertRaises(ValueError):
            self.manager.checked(handle, ACTOR)
        self.runtime.workers[worker['id']]['Name'] = '/' + worker['name']
        self.mutate('job.json', lambda value: value['request'].update(targetRole='replacement'))
        with self.assertRaises(M.ReconciliationError):
            self.manager.checked(handle, ACTOR)

    def test_uncertain_commit_retained_and_no_replay_or_automatic_cleanup(self):
        self.runtime.mode = 'uncertain'
        with self.assertRaises(M.ReconciliationError):
            self.manager.reconcile(ID, ACTOR)
        calls = copy.deepcopy(self.runtime.calls)
        self.assertEqual([call[0] for call in calls].count('stop'), 0)
        self.assertTrue((self.manager.directory(ID) / 'output/write-intent.json').is_file())
        with self.assertRaises(ValueError):
            self.manager.recover_committed(ID, ACTOR)
        self.assertEqual(self.runtime.calls, calls)
        with self.assertRaises(FileExistsError):
            self.manager.reconcile(ID, ACTOR)
        self.assertEqual(self.runtime.calls, calls)

    def settle_interrupted_fixture(self):
        # Independent Root recovery boundary, deliberately not automatic broker cleanup.
        record = self.manager.record(ID)
        supervisor = M.SUPERVISOR.InspectionSupervisor(self.manager, record)
        for role in ('target-database', 'destination-database', 'source-database'):
            self.manager.stop(supervisor, role)

    def test_explicit_recovery_verifies_same_target_without_prepare_replay(self):
        self.runtime.mode = 'uncertain'
        with self.assertRaises(ValueError):
            self.manager.reconcile(ID, ACTOR)
        self.settle_interrupted_fixture()
        writer = self.manager.record(ID)['inspectionWorkers']['reconcile']
        self.runtime.workers[writer['id']]['State']['ExitCode'] = 1
        before = [call for call in self.runtime.calls if call[0] == 'create']
        self.runtime.mode = 'success'
        handle = self.manager.recover_committed(ID, ACTOR)
        self.assertEqual(self.manager.checked(handle, ACTOR), handle)
        created = [call[1] for call in self.runtime.calls if call[0] == 'create'][len(before):]
        self.assertEqual(len(created), 2)
        self.assertEqual(created[-1]['Cmd'][-1], '--verify-v2')
        self.assertNotIn('--prepare', [arg for body in created for arg in body['Cmd']])
        self.assertEqual({m['Target'] for m in created[-1]['HostConfig']['Mounts']}, {
            '/app/core-clean-target', '/clean-target-verify-input', '/clean-target-verify-output', '/clean-target-target-socket'})

    def test_recovery_rejects_substituted_original_intent(self):
        self.runtime.mode = 'uncertain'
        with self.assertRaises(ValueError):
            self.manager.reconcile(ID, ACTOR)
        self.settle_interrupted_fixture()
        self.mutate('output/write-intent.json', lambda value: value['prepared']['targetIdentity'].update(databaseOid='999'))
        before = len(self.runtime.calls)
        with self.assertRaises(ValueError):
            self.manager.recover_committed(ID, ACTOR)
        self.assertEqual(len(self.runtime.calls), before)

    def test_programmatic_approval_required(self):
        with self.assertRaises(M.ReconciliationError):
            M.CoreCleanTargetReconcile(self.broker, {'decision': 'approved'})

    def factory_fixture(self):
        """Authenticated inspector/bootstrap capabilities are synthetic; binding code is real."""
        self.broker.image = lambda: None
        self.broker.binding = lambda: {'imageId': self.runtime.node, 'architecture': 'arm64', 'inventory': {p.name: {'bytes': p.stat().st_size,
            'sha256': M.BOOTSTRAP.sha(p.read_bytes())} for p in self.code.iterdir()}}
        inspectors = []
        for index, role in enumerate(('source', 'destination')):
            base = self.enrollment.child(self.root, role + '-inspection')
            directory = self.enrollment.child(base, 'execution')
            for name in ('pgdata', 'socket', 'config', 'trusted-input'):
                self.enrollment.child(directory, name)
            auth = {'jwtSecret': 'synthetic captured authentication ' * 3, 'passkeys': None}
            raw_auth = self.enrollment.P.canonical(auth)
            request = {'role': role + '_role', 'database': role, 'sourceAuthenticationSha256': M.BOOTSTRAP.sha(raw_auth)}
            for name, value in (('request.json', request), ('source-authentication.json', auth)):
                self.enrollment.immutable(directory / 'trusted-input' / name, self.enrollment.P.canonical(value))
            evidence = {'schema': 'orbis.core-source-bootstrap-evidence.v2', 'sourceSha256': str(index + 1) * 64,
                'authenticationVerified': True, 'environmentProved': False, 'restoreAuthority': False,
                'catalogSha256': '3' * 64, 'systemIdentifier': str(100 + index), 'sourceOwnerId': 1,
                'identitySha256': 'f' * 64, 'authenticationSha256': self.digest({'jwtSecret': auth['jwtSecret']}),
                'catalogUserIdentities': [{'ownerId': 1, 'identitySha256': 'f' * 64}]}
            catalog = {'catalogSha256': '3' * 64, 'systemIdentifier': str(100 + index), 'ledger': [],
                       'sourceControllerImageId': self.broker.trust.source_controller_image_id}
            record = {'actor': ACTOR, 'phase': 'inspection-complete', 'evidence': {'profile': self.binding[role]['profile']}, 'pointId': ID}
            inspector = SimpleNamespace(configuration=self.broker, enrollment=self.enrollment, a=self.enrollment.a, P=self.enrollment.P,
                schema='orbis.core-restore-inspection.v3', report={'bootstrapSource': evidence},
                directory=lambda identifier, base=base: base,
                record=lambda identifier, record=record: copy.deepcopy(record),
                bootstrap_catalog=lambda identifier, actor, catalog=catalog: copy.deepcopy(catalog))
            inspector.catalog = catalog
            inspectors.append(inspector)
        library = self.enrollment.child(self.root, 'library')
        points = self.enrollment.child(library, 'points')
        point_dir = self.enrollment.child(points, ID)
        point = self.enrollment.P.canonical({'ownerId': 1})
        self.enrollment.immutable(point_dir / 'point.json', point)
        destination = {'library': str(library), 'catalog': {ID: {'bytes': len(point), 'sha256': M.BOOTSTRAP.sha(point)}}}
        self.enrollment.destination = lambda: copy.deepcopy(destination)
        def source(point, actor):
            self.assertEqual(actor, ACTOR)
            self.assertGreater(self.guard_depth, 0)
            return SimpleNamespace(basis=lambda: {'pointId': point, 'sourceAuthority': True, 'environmentProved': False,
                'restoreAuthority': False, 'sourceOwnerId': 1, 'sourceWitnessSha256': 'c' * 64})
        inspectors[0].source = source
        bootstrap_record = {'inspectionWorkers': {}, 'workspace': self.binding['target']['workspace'],
                            'request': {'target': self.binding['target']['target']}}
        receipt = b'{}'
        self.publisher(self.root / 'receipt.json', receipt)
        handle = M.BOOTSTRAP.PreparedCleanTarget(ID, M.BOOTSTRAP.sha(receipt))
        bootstrap = SimpleNamespace(publish=self.publisher, broker=self.broker, enrollment=self.enrollment, a=self.enrollment.a, P=self.enrollment.P,
            _checked=lambda record, actor, finalize: handle,
            record=lambda identifier: copy.deepcopy(bootstrap_record), read=self.read,
            directory=lambda identifier: self.root, validate=lambda actor: None,
            approved={'profile': self.binding['target']['profile'], 'catalog': inspectors[0].catalog})
        return inspectors, bootstrap, handle

    @contextlib.contextmanager
    def factory_boundaries(self):
        with mock.patch.object(M.TARGET, 'require_root'), mock.patch.object(M.TARGET, 'verify_workspace', side_effect=lambda workspace, authority: workspace), \
             mock.patch.object(M.SUPERVISOR.InspectionSupervisor, 'checked_completion',
                lambda supervisor, directory, profile: copy.deepcopy(supervisor.manager.report)):
            yield

    def test_factory_binds_authenticated_inspections_actual_catalog_and_prepared_bootstrap(self):
        inspectors, bootstrap, handle = self.factory_fixture()
        with self.factory_boundaries():
            manager = M.CoreCleanTargetReconcile.from_inspections(self.broker, inspectors[0], ID,
                inspectors[1], 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', bootstrap, handle, ACTOR, guard=self.guard)
            with self.guard():
                manager.validate(ACTOR)
            self.assertEqual(manager.approved['catalogOwnerIds'], [1])
            self.assertEqual(manager.approved['ownership']['owners'], [{'ownerId': 1, 'identitySha256': 'f' * 64}])
            self.assertEqual(manager.approved['catalog']['points'][0]['sourceWitnessSha256'], 'c' * 64)
            self.assertEqual(manager.approved['target']['receiptSha256'], handle.receipt_sha256)
            inspectors[1].report['bootstrapSource']['catalogUserIdentities'][0]['identitySha256'] = '0' * 64
            with self.guard(), self.assertRaises(ValueError):
                manager.validate(ACTOR)

    def test_factory_refuses_legacy_evidence_and_unsupported_catalog_without_skipping(self):
        inspectors, bootstrap, handle = self.factory_fixture()
        with self.factory_boundaries():
            inspectors[0].report['bootstrapSource']['schema'] = 'orbis.core-source-bootstrap-evidence.v1'
            with self.assertRaises(M.ReconciliationError):
                M.CoreCleanTargetReconcile.from_inspections(self.broker, inspectors[0], ID,
                    inspectors[1], 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', bootstrap, handle, ACTOR, guard=self.guard)
            inspectors[0].report['bootstrapSource']['schema'] = 'orbis.core-source-bootstrap-evidence.v2'
            inspectors[0].source = lambda point, actor: (_ for _ in ()).throw(ValueError('unsupported catalog authority'))
            with self.assertRaises(ValueError):
                M.CoreCleanTargetReconcile.from_inspections(self.broker, inspectors[0], ID,
                    inspectors[1], 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', bootstrap, handle, ACTOR, guard=self.guard)
        self.assertEqual(self.runtime.calls, [])

    def test_cross_release_qualifications_bind_same_installed_coordinator_generation(self):
        inspectors, bootstrap, handle = self.factory_fixture()
        selected = SimpleNamespace(identifier=ID, installation_sha256='d' * 64)
        self.broker.installed_selection = selected
        self.broker.installed_authority = self.guard
        destination_configuration = copy.copy(self.broker)
        destination_configuration.trust = copy.copy(self.broker.trust)
        destination_configuration.trust.source_controller_image_id = 'sha256:' + '9' * 64
        inspectors[1].configuration = destination_configuration
        inspectors[1].catalog['sourceControllerImageId'] = destination_configuration.trust.source_controller_image_id
        with self.factory_boundaries():
            manager = M.CoreCleanTargetReconcile.from_inspections(self.broker, inspectors[0], ID,
                inspectors[1], 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', bootstrap, handle, ACTOR, guard=self.guard)
            self.assertEqual(manager.approved['destination']['catalog']['sourceControllerImageId'], 'sha256:' + '9' * 64)
            self.assertEqual(manager.source_controller_image(), inspectors[0].configuration.trust.source_controller_image_id)
            self.assertNotEqual(manager.source_controller_image(), destination_configuration.trust.source_controller_image_id)
            destination_configuration.installed_selection = SimpleNamespace(identifier=ID, installation_sha256='0' * 64)
            with self.guard(), self.assertRaises(ValueError):
                manager.validate(ACTOR)

    def test_cross_release_refuses_worker_qualified_for_destination_instead_of_source(self):
        inspectors, bootstrap, handle = self.factory_fixture()
        selected = SimpleNamespace(identifier=ID, installation_sha256='d' * 64)
        self.broker.installed_selection = selected
        self.broker.installed_authority = self.guard
        # Preserve the genuine source qualification while the coordinator broker
        # is mistakenly selected using the destination release qualification.
        source_configuration = copy.copy(self.broker)
        source_configuration.trust = copy.copy(self.broker.trust)
        inspectors[0].configuration = source_configuration
        self.broker.trust.source_controller_image_id = 'sha256:' + '9' * 64
        inspectors[1].catalog['sourceControllerImageId'] = self.broker.trust.source_controller_image_id
        with self.factory_boundaries(), self.assertRaises(M.ReconciliationError):
            M.CoreCleanTargetReconcile.from_inspections(self.broker, inspectors[0], ID,
                inspectors[1], 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', bootstrap, handle, ACTOR, guard=self.guard)
        self.assertEqual(self.runtime.calls, [])


class VersionedReconcileTests(unittest.TestCase):
    def setUp(self):
        self.fixture = ReconcileTests('test_success_runs_real_supervisor_on_three_isolated_copies_and_checks_receipt')
        self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.old_image = self.fixture.runtime.image
        self.configure(14)

    def configure(self, major):
        f = self.fixture;architecture = 'amd64' if major == 14 else 'arm64'
        def image(identifier):
            value = self.old_image(identifier)
            if identifier == M.SOURCE.PG.PG14_AMD64_IMAGE:
                value['Config']['Volumes'] = {'/var/lib/postgresql/data': {}};value['Architecture'] = 'amd64'
            elif identifier != M.SOURCE.PG17_ARM64_IMAGE:value['Architecture'] = architecture
            return value
        f.runtime.image = image
        identifier = M.SOURCE.PG.PG14_AMD64_IMAGE if major == 14 else M.SOURCE.PG17_ARM64_IMAGE
        target = M.TARGET.bounded_clean_target_profile(image(identifier), 'target_role', 'target', {'encoding': 'UTF8', 'collate': 'C', 'ctype': 'C', 'provider': 'c'})
        f.binding['configuration']['architecture'] = architecture
        f.binding['target']['profile'] = target
        f.binding['target']['target'].update(role=target['role'], locale=copy.deepcopy(target['locale']))
        for role in ('source', 'destination'):
            endpoint = f.binding[role];profile = M.SOURCE.role_bound_execution_profile(image(identifier), role + '_role', 'e' * 64)
            observation = {'schema': 'orbis.core-pg-execution-observation.v1', 'profileId': profile['profileId'],
                'serverVersionNum': major * 10000 + 23, 'major': major, 'database': role,
                'locale': copy.deepcopy(target['locale']),
                'localeProviderEvidence': 'postgresql14-libc-database-default' if major == 14 else 'pg_database.datlocprovider'}
            endpoint.update(profile=profile, databaseExecution=observation)
            endpoint['catalog'].update(schema='orbis.core-root-authenticated-bootstrap-source.v2',
                executionProfile=copy.deepcopy(profile), databaseExecution=copy.deepcopy(observation))
        f.bootstrap.schema = M.BOOTSTRAP.CoreVersionedCleanTargetBootstrap.schema;f.bootstrap.worker_version = 2
        f.binding['executionProfile'] = target['profileId']
        approval = M.RootReconciliationApproval(ACTOR, object(), ID, object(), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            f.bootstrap, object(), copy.deepcopy(f.binding), f.guard)
        f.manager = M.CoreVersionedCleanTargetReconcile(f.broker, approval);f.runtime.manager = f.manager
        f.live_binding = copy.deepcopy(f.binding);f.manager.current_binding = lambda active=False: copy.deepcopy(f.live_binding)
        self.enterContext(mock.patch.object(f.manager, 'socket_available'))
        self.enterContext(mock.patch.object(M.TARGET, 'database_body', side_effect=self.target_body))

    def target_body(self, workspace, authority):
        return M.TARGET.body(workspace, 'database', M.TARGET.binary_for(workspace.profile, 'postgres'), ['-D', '/var/lib/postgresql/data'], [
            M.SOURCE.mount(workspace.directory / 'pgdata', '/var/lib/postgresql/data', False),
            M.SOURCE.mount(workspace.directory / 'socket', '/var/run/postgresql', False),
            M.SOURCE.mount(workspace.directory / 'config', '/clean-target-config', True)])

    def test_versioned14_runs_existing_worker2_protocol_and_checks_root_receipt2(self):self.check_success(14)

    def test_versioned17_keeps_new_root_scope_explicit(self):
        self.configure(17);self.check_success(17)

    def check_success(self, major):
        f = self.fixture;handle = f.manager.reconcile(ID, ACTOR)
        self.assertEqual(f.manager.checked(handle, ACTOR), handle)
        record = f.manager.record(ID);directory = f.manager.directory(ID)
        self.assertEqual(record['schema'], 'orbis.core-clean-target-reconcile-job.v2')
        self.assertEqual(record['rootIntent']['schema'], 'orbis.core-clean-target-reconcile-root-intent.v2')
        self.assertEqual(record['request']['schema'], 'orbis.core-clean-target-worker-input.v2')
        self.assertNotIn('executionProfile', record['request'])
        self.assertEqual(record['prepared']['major'], major)
        receipt = json.loads((directory / 'receipt.json').read_bytes())
        self.assertEqual(receipt['schema'], 'orbis.core-clean-target-reconcile-receipt.v2')
        self.assertEqual(receipt['executionProfile'], f.binding['executionProfile'])
        for path in (directory / 'input').iterdir():self.assertEqual(path.stat().st_mode & 0o777, 0o400)
        for role in ('source-database', 'destination-database', 'target-database'):
            self.assertEqual(record['inspectionWorkers'][role]['body']['Entrypoint'],
                [M.TARGET.binary_for(f.binding['target']['profile'], 'postgres')])
        self.assertEqual(F.Authority.seal(f.original.stat()), f.original_seal)
        self.assertFalse(receipt['restoreAuthority']);self.assertFalse(receipt['environmentProved']);self.assertFalse(receipt['activation'])

    def test_versioned_mixed_image_major_locale_or_old_schema_refuses_before_allocation(self):
        f = self.fixture;original = copy.deepcopy(f.manager.approved)
        changes = [lambda b: b['source']['profile'].update(major=17),
            lambda b: b['destination']['profile'].update(schema=M.SOURCE.ROLE_SCHEMA),
            lambda b: b['destination']['databaseExecution']['locale'].update(collate='POSIX'),
            lambda b: b['target']['target']['locale'].update(ctype='POSIX'),
            lambda b: b['configuration'].update(architecture='arm64'),
            lambda b: b['source']['catalog'].update(schema='orbis.core-root-authenticated-bootstrap-source.v1')]
        for change in changes:
            bad = copy.deepcopy(original);change(bad);f.manager.approved = bad;f.live_binding = copy.deepcopy(bad)
            with self.subTest(change=change), self.assertRaises(ValueError):f.manager.reconcile(ID, ACTOR)
            self.assertEqual(f.runtime.calls, [])
            self.assertFalse((f.root / 'core-clean-target-reconciliations').exists())

    def test_versioned_worker_result_wrong_major_is_rejected_without_fake_receipt(self):
        f = self.fixture;f.manager.reconciliation_major = lambda: 17
        # The synthetic worker emits17 while the immutable Root target profile remains14.
        publish = f.runtime.publish
        def wrong(body, verify):
            publish(body, verify)
            f.manager.reconciliation_major = lambda: 14
        f.runtime.publish = wrong
        with self.assertRaises(ValueError):f.manager.reconcile(ID, ACTOR)
        self.assertEqual(f.manager.record(ID)['phase'], 'recovery-required')
        self.assertFalse((f.manager.directory(ID) / 'receipt.json').exists())

    def test_versioned_recovery_keeps_same_target_and_new_verify_transport400(self):
        f = self.fixture;f.runtime.mode = 'uncertain'
        with self.assertRaises(ValueError):f.manager.reconcile(ID, ACTOR)
        calls = copy.deepcopy(f.runtime.calls)
        with self.assertRaises(ValueError):f.manager.recover_committed(ID, ACTOR)
        self.assertEqual(f.runtime.calls, calls)
        f.settle_interrupted_fixture();f.runtime.mode = 'success'
        handle = f.manager.recover_committed(ID, ACTOR)
        self.assertEqual(f.manager.checked(handle, ACTOR), handle)
        record = f.manager.record(ID);self.assertEqual(record['prepared']['major'], 14)
        self.assertTrue(json.loads((f.manager.directory(ID) / 'receipt.json').read_bytes())['recoveredByVerification'])
        for path in (f.manager.directory(ID) / 'verify-input').iterdir():self.assertEqual(path.stat().st_mode & 0o777, 0o400)
        self.assertEqual(record['inspectionWorkers']['verify']['body']['Cmd'][-1], '--verify-v2')

    def versioned_factory_fixture(self):
        f = self.fixture;inspectors, bootstrap, handle = f.factory_fixture()
        binding = f.broker.binding
        f.broker.binding = lambda: binding() | {'architecture': f.binding['target']['profile']['architecture']}
        for index, inspection in enumerate(inspectors):
            role = ('source', 'destination')[index];endpoint = f.binding[role]
            profile = endpoint['profile'];observation = copy.deepcopy(endpoint['databaseExecution'])
            inspection.schema = 'orbis.core-restore-inspection.v4'
            inspection.report.update(schema='orbis.core-inspection-worker-result.v4', executionProfile=profile['profileId'], databaseExecution=observation)
            inspection.catalog.update(schema='orbis.core-root-authenticated-bootstrap-source.v2',
                executionProfile=copy.deepcopy(profile), databaseExecution=copy.deepcopy(observation))
            record = inspection.record
            inspection.record = lambda identifier, original=record: original(identifier) | {'schema': 'orbis.core-restore-inspection.v4', 'sandboxProfile': M.SOURCE.EXECUTION_SCHEMA}
        bootstrap.schema = M.BOOTSTRAP.CoreVersionedCleanTargetBootstrap.schema;bootstrap.worker_version = 2
        return inspectors, bootstrap, handle

    def test_versioned_factory_binds_real_endpoint_checks_and_rejects_observation_drift(self):
        f = self.fixture;inspectors, bootstrap, handle = self.versioned_factory_fixture()
        with f.factory_boundaries():
            manager = M.CoreVersionedCleanTargetReconcile.from_inspections(f.broker, inspectors[0], ID,
                inspectors[1], 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', bootstrap, handle, ACTOR, guard=f.guard)
            self.assertEqual(manager.approved['executionProfile'], 'pg14-debian-amd64.v1')
            with f.guard():manager.validate(ACTOR)
            inspectors[1].report['databaseExecution']['serverVersionNum'] = 170023
            with f.guard(), self.assertRaises(ValueError):manager.validate(ACTOR)
        self.assertEqual(f.runtime.calls, [])

    def test_versioned_factory_does_not_adopt_v3_inspection_or_v1_bootstrap(self):
        f = self.fixture;inspectors, bootstrap, handle = self.versioned_factory_fixture()
        with f.factory_boundaries():
            inspectors[1].schema = 'orbis.core-restore-inspection.v3'
            with self.assertRaises(ValueError):M.CoreVersionedCleanTargetReconcile.from_inspections(f.broker, inspectors[0], ID,
                inspectors[1], 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', bootstrap, handle, ACTOR, guard=f.guard)
            inspectors[1].schema = 'orbis.core-restore-inspection.v4';bootstrap.schema = M.BOOTSTRAP.SCHEMA
            with self.assertRaises(ValueError):M.CoreVersionedCleanTargetReconcile.from_inspections(f.broker, inspectors[0], ID,
                inspectors[1], 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', bootstrap, handle, ACTOR, guard=f.guard)
        self.assertEqual(f.runtime.calls, [])


if __name__ == '__main__':
    unittest.main()
