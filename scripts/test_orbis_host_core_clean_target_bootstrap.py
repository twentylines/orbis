"""Actual supervisor lifecycle and filesystem fixtures; no Linux/Docker qualification.

Root ownership/chown, PostgreSQL file validation and the socket/RAM probes have
explicit seams on macOS. The allocator, durable job IO and supervisor run for real.
"""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location('clean_target_bootstrap_tests_subject', Path(__file__).with_name('orbis-host-core-clean-target-bootstrap.py'))
M = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = M
spec.loader.exec_module(M)
ID = 'a71c77d2-f420-440e-951b-083209514e72'


class Publication:
    @staticmethod
    def canonical(value):
        return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    @staticmethod
    def metadata(body, **kwargs):
        return json.loads(body)


class Authority:
    OWNER = 0
    @staticmethod
    def seal(value):
        return tuple(getattr(value, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))
    @staticmethod
    @contextlib.contextmanager
    def protected_directory(path):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            before = Authority.seal(os.fstat(fd))
            yield fd
            if before != Authority.seal(os.fstat(fd)):
                raise ValueError('read-only leaf seal changed')
        finally:
            os.close(fd)
    @staticmethod
    def atomic(path, body):
        path.write_bytes(body)
        path.chmod(0o600)


class Enrollment:
    def __init__(self, root):
        self.root = self.state = root
        self.a, self.P, self.context = Authority(), Publication(), 'fixture'
        self.runtime = Runtime(self)
    def child(self, parent, name):
        with self.a.protected_directory(parent):
            pass
        path = parent / name
        path.mkdir(mode=0o700, exist_ok=True)
        with self.a.protected_directory(path):
            pass
        return path
    @staticmethod
    def sync(path):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    @staticmethod
    def actor(value):
        if value != {'ownerId': 1, 'sessionBinding': 'a' * 64, 'securityBinding': 'b' * 64}:
            raise ValueError('actor')
        return copy.deepcopy(value)
    @staticmethod
    def read(path, maximum):
        value = path.read_bytes()
        M.require(len(value) <= maximum)
        return value
    def json(self, path, maximum):
        return json.loads(self.read(path, maximum))
    @staticmethod
    def immutable(path, body):
        with path.open('xb') as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        path.chmod(0o600)


def archive(files, special=None):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.USTAR_FORMAT) as output:
        for name, value in files.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(value)
            output.addfile(entry, io.BytesIO(value))
        if special is not None:
            output.addfile(special)
    return stream.getvalue()


class Runtime:
    def __init__(self, enrollment):
        self.enrollment, self.workers, self.calls = enrollment, {}, []
        self.mode = 'success'
        self.files = {'0000_initial.sql': b'CREATE TABLE fixture();',
                      'meta/_journal.json': Publication.canonical({'version': '7', 'dialect': 'postgresql', 'entries': [
                          {'idx': 0, 'version': '7', 'when': 1, 'tag': '0000_initial', 'breakpoints': True}]})}
        self.node, self.controller = 'sha256:' + '1' * 64, 'sha256:' + '2' * 64
    def image(self, image):
        value = {'Id': image, 'Os': 'linux', 'Architecture': 'arm64',
                 'Config': {'Volumes': {'/var/lib/postgresql/data': {}} if image == M.TARGET.SOURCE.PG17_ARM64_IMAGE else {}}}
        if self.mode == 'image':
            value['Architecture'] = 'amd64'
        if self.mode == 'volumes' and image == self.controller:
            value['Config']['Volumes'] = {'/app/assets/migrations': {}}
        return value
    def engine(self, method, route, body):
        self.calls.append(('create', copy.deepcopy(body)))
        identifier = f'{len(self.workers) + 1:064x}'
        expected = copy.deepcopy(body)
        expected['NetworkingConfig'] = {'EndpointsConfig': {'none': {}}}
        self.workers[identifier] = {'Id': identifier, 'Image': body['Image'], 'Name': '/' + route.split('name=')[1],
            'actualBody': expected, 'Config': {'Healthcheck': body['Healthcheck']},
            'HostConfig': copy.deepcopy(body['HostConfig']), 'NetworkSettings': {'Networks': {'none': {}}},
            'State': {'Status': 'created', 'Running': False, 'Restarting': False, 'Paused': False,
                      'Dead': False, 'OOMKilled': False, 'ExitCode': 0, 'FinishedAt': '0001-01-01T00:00:00Z'}}
        return Publication.canonical({'Id': identifier})
    def inspect(self, identifier):
        return copy.deepcopy(self.workers[identifier])
    @staticmethod
    def never_started(raw):
        return raw['State']['Status'] == 'created'
    @staticmethod
    def definition(raw):
        return M.sha(Publication.canonical(raw['actualBody']))
    @staticmethod
    def check_intent(raw, expected):
        M.require(raw['actualBody'] == expected)
    def change(self, args):
        self.calls.append(tuple(args))
        worker = self.workers[args[-1]]
        if args[0] == 'stop':
            worker['State']['Status'] = 'exited'
            worker['State']['Running'] = False
            return
        M.require(args[0] == 'start')
        worker['State'].update(Status='running', Running=True)
        body = worker['actualBody']
        phase = body['Labels']['io.orbis.core-clean-target.phase']
        if phase == 'initialize':
            data = Path(body['HostConfig']['Mounts'][0]['Source'])
            major = 14 if body['Image'] == M.TARGET.SOURCE.PG.PG14_AMD64_IMAGE else 17
            for name, value in [('PG_VERSION', (str(major) + '\n').encode()), ('postgresql.auto.conf', b'# automatic\n')]:
                (data / name).write_bytes(value)
                (data / name).chmod(0o600)
        if phase == 'bootstrap':
            self.publish_bootstrap(body)
    def bounded_output(self, args, maximum, timeout):
        self.calls.append(tuple(args))
        if 'cp' in args:
            value = archive(self.files)
        elif 'logs' in args:
            target = self.target()
            body = self.workers[args[-1]]['actualBody']
            if 'serverVersionNum' in body['Cmd'][-1]:
                major = 14 if body['Image'] == M.TARGET.SOURCE.PG.PG14_AMD64_IMAGE else 17
                target = target | {'serverVersionNum': major * 10000 + 23,
                    'localeProviderEvidence': 'postgresql14-libc-database-default' if major == 14 else 'pg_database.datlocprovider'}
            value = Publication.canonical(target)
        elif 'wait' in args:
            identifier = args[-1]
            phase = self.workers[identifier]['actualBody']['Labels']['io.orbis.core-clean-target.phase']
            if self.mode == 'ambiguous' and phase == 'bootstrap':
                raise TimeoutError('wait unknown')
            state = self.workers[identifier]['State']
            state.update(Status='exited', Running=False, FinishedAt='2026-01-01T00:00:00Z')
            value = b'0\n'
        else:
            raise AssertionError(args)
        M.require(len(value) <= maximum)
        return value
    def target(self):
        return {'systemIdentifier': '200', 'databaseOid': '16384', 'database': 'target_database',
                'role': 'target_role', 'locale': {'encoding': 'UTF8', 'collate': 'C', 'ctype': 'C', 'provider': 'c'}}
    def publish_bootstrap(self, body):
        mounts = {m['Target']: Path(m['Source']) for m in body['HostConfig']['Mounts']}
        directory = mounts['/clean-target-bootstrap-input']
        request = json.loads((directory / 'request.json').read_bytes())
        authorization = json.loads((directory / 'authorization.json').read_bytes())
        version = 'v2' if request['schema'] == 'orbis.core-clean-target-bootstrap-input.v2' else 'v1'
        major = M.TARGET.SOURCE.PG.execution_image_profile(self.image(M.TARGET.SOURCE.PG.PG14_AMD64_IMAGE))['major'] if request.get('executionProfile') == 'pg14-debian-amd64.v1' else 17
        bound = {k: v for k, v in request.items() if k not in {'schema', 'expectedMigrationLedger'}}
        bound.update(requestSha256=M.sha(Publication.canonical(request)), authorizationSha256=M.sha(Publication.canonical(authorization)))
        intent = {'schema': 'orbis.core-clean-target-migration-intent.' + version, **bound, 'serverBeforeSeconds': 100}
        common = {**bound, 'migrationIntentSha256': M.sha(Publication.canonical(intent))}
        generated = [{'id': 1, 'hash': M.sha(self.files['0000_initial.sql']), 'created_at': '1'}]
        output = {
            'worker-start.json': {'schema': 'orbis.core-clean-target-bootstrap-start.' + version, **bound},
            'migration-intent.json': intent,
            'ledger-intent.json': {'schema': 'orbis.core-clean-target-ledger-intent.' + version, **common,
                                   'generatedLedgerSha256': M.sha(Publication.canonical(generated)), 'ledgerRows': 1},
            'migration-completion.json': {'schema': 'orbis.core-clean-target-migration-completion.' + version, **common,
                'serverBeforeSeconds': 100, 'serverAfterSeconds': 101, 'migrationCommitAcknowledged': True,
                'ledgerCommitAcknowledged': True, 'sanitationPending': True},
            'sanitation-intent.json': {'schema': 'orbis.core-clean-target-sanitation-intent.' + version, **common,
                'seedSha256': 'e' * 64, 'serverBeforeSeconds': 100, 'serverAfterSeconds': 101},
            'result.json': {'schema': 'orbis.core-clean-target-bootstrap-result.' + version, **common, 'seedSha256': 'e' * 64,
                'structure': {'schema': 'orbis.core-database-structure.v1', 'sha256': 'f' * 64, 'major': major,
                              'catalogSha256': request['expectedCatalogSha256'], 'authenticationVerified': False, 'restoreAuthority': False,
                              'rows': {'user': 0, 'link': 0, 'app_store': 0, 'app': 0, 'orbis_reset_receipt': 0, '__drizzle_migrations': 1}},
                'ledgerCommitAcknowledged': True, 'sanitationCommitAcknowledged': True, 'applicationTablesEmpty': True,
                'serverQuiescenceProved': False}}
        if self.mode == 'target-output':
            output['result.json']['target'] = self.target() | {'systemIdentifier': '300'}
        if self.mode == 'catalog-output':
            output['result.json']['structure']['catalogSha256'] = '0' * 64
        for name, value in output.items():
            self.enrollment.publisher(mounts['/clean-target-bootstrap-output'] / name, Publication.canonical(value))


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='orbis-bootstrap-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.enrollment = Enrollment(self.root)
        self.runtime = self.enrollment.runtime
        self.actor = {'ownerId': 1, 'sessionBinding': 'a' * 64, 'securityBinding': 'b' * 64}
        self.code = self.root / 'code'
        self.code.mkdir(mode=0o700)
        for name in ('core-source-configuration-worker.mjs', 'core-clean-target-bootstrap-worker.mjs'):
            self.enrollment.immutable(self.code / name, b'fixture')
        self.inventory = {p.name: {'bytes': 7, 'sha256': M.sha(b'fixture')} for p in self.code.iterdir()}
        self.trust = SimpleNamespace(image_id=self.runtime.node, architecture='arm64', code_directory=self.code,
                                     inventory=self.inventory, source_controller_image_id=self.runtime.controller)
        self.broker = SimpleNamespace(enrollment=self.enrollment, trust=self.trust, binding=self.binding, image=self.image)
        self.profile = M.TARGET.clean_target_profile(self.runtime.image(M.TARGET.SOURCE.PG17_ARM64_IMAGE),
            'target_role', 'target_database', self.runtime.target()['locale'])
        files, auxiliary, graph = M.migration_bundle(archive(self.runtime.files))
        migrations = {'schema': 'orbis.core-executable-migration-inventory.v1',
                      'files': {n: {'bytes': len(b), 'sha256': M.sha(b)} for n, b in files.items()}}
        self.catalog = {'schema': 'orbis.core-root-authenticated-bootstrap-source.v1', 'actor': self.actor,
            'sourceWitnessSha256': 'c' * 64, 'sourceManifestSha256': 'd' * 64, 'sourceControllerImageId': self.runtime.controller,
            'catalogSha256': 'e' * 64, 'systemIdentifier': '100', 'ledger': [{'id': 4, **graph[0]}],
            'authenticationVerified': True, 'authorityScope': 'authenticated-source-catalog-and-ledger',
            'environmentProved': False, 'restoreAuthority': False}
        self.guards = 0
        self.approval = M.RootBootstrapApproval(self.binding(), self.profile, copy.deepcopy(self.catalog), migrations, graph,
                                                lambda: copy.deepcopy(self.catalog), self.guard)
        self.manager = M.CoreCleanTargetBootstrap(self.broker, self.approval)
        self.enrollment.publisher = self.manager.publish
        self.original = self.root / 'original-data'
        self.original.write_bytes(b'original services and data must remain unchanged')
        self.original_seal = Authority.seal(self.original.stat())
        patches = [mock.patch.object(M.TARGET, 'require_root'), mock.patch.object(M.TARGET.os, 'fchown'),
                   mock.patch.object(M.TARGET, 'verify_workspace', side_effect=self.verify_workspace),
                   mock.patch.object(M.TARGET, 'database_body', side_effect=self.database_body),
                   mock.patch.object(M.CoreCleanTargetBootstrap, 'read', self.read_owned_fixture),
                   mock.patch.object(self.manager, 'capacity'),
                   mock.patch.object(M.SUPERVISOR.InspectionSupervisor, 'socket_available')]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
    def binding(self):
        inventory = {p.name: {'bytes': p.stat().st_size, 'sha256': M.sha(p.read_bytes())} for p in self.code.iterdir()}
        return {'imageId': self.trust.image_id, 'architecture': 'arm64', 'inventory': inventory,
                'sourceControllerImageId': self.trust.source_controller_image_id, 'codeDirectory': str(self.code)}
    def image(self):
        image = self.runtime.image(self.trust.image_id)
        M.require(image['Id'] == self.trust.image_id and image['Architecture'] == 'arm64' and not image['Config']['Volumes'])
    @contextlib.contextmanager
    def guard(self):
        self.guards += 1
        try:
            yield
        finally:
            self.guards -= 1
    @staticmethod
    def read_owned_fixture(manager, path, maximum):
        # Virtual Root ownership only: regular-file, mode, link and byte checks remain real.
        with manager.a.protected_directory(path.parent) as fd:
            before = path.lstat()
            M.require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and stat.S_IMODE(before.st_mode) == 0o400)
            expected = M.TARGET.SOURCE.regular_digest(fd, path.name, manager.a, maximum)
            body = manager.enrollment.read(path, maximum)
            M.require(expected == {'bytes': len(body), 'sha256': M.sha(body)} and Authority.seal(before) == Authority.seal(path.lstat()))
            return body
    @staticmethod
    def verify_workspace(workspace, authority):
        M.require(set(os.listdir(workspace.directory)) == {'allocation.json', 'pgdata', 'socket', 'config'})
        for name, identity in workspace.identities.items():
            M.require(M.TARGET.directory_identity((workspace.directory / name).lstat()) == identity)
        M.require((workspace.directory / 'allocation.json').read_bytes() == Publication.canonical(workspace.allocation))
        for name, body in M.TARGET.config_for(workspace.profile).items():
            M.require((workspace.directory / 'config' / name).read_bytes() == body)
        return workspace
    def database_body(self, workspace, authority):
        self.verify_workspace(workspace, authority)
        M.require((workspace.directory / 'pgdata/PG_VERSION').read_bytes() == b'17\n'
                  and not (workspace.directory / 'pgdata/postmaster.pid').exists())
        command = ['-D', '/var/lib/postgresql/data']
        for name, value in M.TARGET.settings_for(workspace.profile).items():
            command.extend(['-c', name + '=' + value])
        return M.TARGET.body(workspace, 'database', '/usr/local/bin/postgres', command, [
            M.TARGET.SOURCE.mount(workspace.directory / 'pgdata', '/var/lib/postgresql/data', False),
            M.TARGET.SOURCE.mount(workspace.directory / 'config', '/clean-target-config', True),
            M.TARGET.SOURCE.mount(workspace.directory / 'socket', '/var/run/postgresql', False)])
    def test_source_inspection_factory_uses_its_catalog_and_rechecks_under_guard(self):
        calls = []
        def catalog(identifier, actor):
            self.assertEqual(identifier, ID)
            self.assertEqual(actor, self.actor)
            self.assertGreater(self.guards, 0)
            calls.append(identifier)
            return copy.deepcopy(self.catalog)
        inspection = SimpleNamespace(configuration=self.broker, schema='orbis.core-restore-inspection.v3', bootstrap_catalog=catalog)
        manager = M.CoreCleanTargetBootstrap.from_source_inspection(
            self.broker, inspection, ID, self.actor, profile=self.profile,
            migration_inventory=self.approval.migration_inventory,
            migration_graph=self.approval.migration_graph, guard=self.guard)
        with mock.patch.object(manager, 'capacity'):
            prepared = manager.prepare(ID, self.actor)
            self.assertEqual(manager.checked(prepared, self.actor), prepared)
        self.assertGreater(len(calls), 1)
        self.assertEqual(manager.record(ID)['request']['expectedMigrationLedger'], self.catalog['ledger'])
        self.assertEqual(self.guards, 0)

    def test_source_inspection_factory_refuses_old_scope_foreign_broker_and_missing_guard(self):
        inspection = SimpleNamespace(configuration=self.broker, schema='orbis.core-restore-inspection.v3',
                                     bootstrap_catalog=lambda identifier, actor: copy.deepcopy(self.catalog))
        args = dict(profile=self.profile, migration_inventory=self.approval.migration_inventory,
                    migration_graph=self.approval.migration_graph, guard=self.guard)
        for attack in ('old', 'foreign', 'guard'):
            candidate = copy.copy(inspection)
            parameters = dict(args)
            if attack == 'old': candidate.schema = 'orbis.core-restore-inspection.v2'
            if attack == 'foreign': candidate.configuration = object()
            if attack == 'guard': parameters['guard'] = None
            with self.subTest(attack=attack), self.assertRaises(ValueError):
                M.CoreCleanTargetBootstrap.from_source_inspection(self.broker, candidate, ID, self.actor, **parameters)
        self.assertEqual(self.runtime.calls, [])

    def prepare(self):
        return self.manager.prepare(ID, self.actor)
    def mutate_json(self, relative, change):
        path = self.manager.directory(ID) / relative
        value = json.loads(path.read_bytes())
        change(value)
        path.chmod(0o600)
        path.write_bytes(Publication.canonical(value))
        path.chmod(0o400)
    def assert_recovery(self):
        self.assertEqual(self.manager.record(ID)['phase'], 'recovery-required')
        self.assertFalse((self.manager.directory(ID) / 'receipt.json').exists())
        self.assertEqual(Authority.seal(self.original.stat()), self.original_seal)
    def test_success_real_allocator_and_supervisor_checked_handle(self):
        prepared = self.prepare()
        self.assertEqual(self.manager.checked(prepared, self.actor), prepared)
        self.assertEqual(self.guards, 0)
        record = self.manager.record(ID)
        self.assertEqual(record['phase'], 'complete')
        self.assertNotIn('continuationSha256', json.loads((self.manager.directory(ID) / 'receipt.json').read_bytes()))
        self.assertEqual(record['request']['expectedMigrationLedger'][0]['id'], 4)
        self.assertEqual(set(record['inspectionWorkers']), {'migration-carrier', 'initialize', 'database', 'creation', 'observer', 'bootstrap'})
        carrier = record['inspectionWorkers']['migration-carrier']
        self.assertEqual(carrier['intent'], 'created-never-start')
        self.assertFalse(any(call[0] == 'start' and call[-1] == carrier['id'] for call in self.runtime.calls))
        self.assertFalse(any('wait' in call and call[-1] == carrier['id'] for call in self.runtime.calls))
        stops = [call for call in self.runtime.calls if call[0] == 'stop']
        self.assertEqual(stops, [('stop', '--time', '20', record['inspectionWorkers']['database']['id'])])
        self.assertTrue((self.manager.directory(ID) / 'stop-intent.json').is_file())
        self.assertEqual(Authority.seal(self.original.stat()), self.original_seal)
        for key in ('activation', 'environmentProved', 'restoreAuthority'):
            self.assertIs(record[key], False)
        for worker in record['inspectionWorkers'].values():
            body = worker['body']
            self.assertEqual(body['HostConfig']['NetworkMode'], 'none')
            self.assertEqual(body['HostConfig']['Memory'] <= 512 * 1024 ** 2, True)
            if body['Image'] == self.profile['imageId']:
                self.assertIn('/var/lib/postgresql/data', {m['Target'] for m in body['HostConfig']['Mounts']})
            for mount in body['HostConfig']['Mounts']:
                if not mount['ReadOnly']:
                    self.assertTrue(Path(mount['Source']).is_relative_to(self.manager.directory(ID)))
    def test_duplicate_and_partial_job_never_reused(self):
        self.prepare()
        before = list(self.runtime.calls)
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.assertEqual(self.runtime.calls, before)
    def test_archived_job_history_does_not_impose_a_lifetime_quota(self):
        base = self.enrollment.child(self.enrollment.state, 'core-clean-target-bootstraps')
        for index in range(70):
            (base / f'{index:08x}-1111-4111-8111-111111111111').mkdir(mode=0o700)
        directory = self.manager.directory(ID, create=True)
        self.assertEqual(directory.name, ID)
        self.assertEqual(len(list(base.iterdir())), 71)

    def test_untrusted_catalog_and_actor_rejected_before_allocating(self):
        self.catalog['authenticationVerified'] = False
        with self.assertRaises(M.BootstrapError):
            self.prepare()
        self.assertFalse((self.root / 'core-clean-target-bootstraps').exists())
    def test_changed_code_image_and_source_catalog_refuse_checked(self):
        prepared = self.prepare()
        original = self.catalog['catalogSha256']
        self.catalog['catalogSha256'] = '0' * 64
        with self.assertRaises(M.BootstrapError):
            self.manager.checked(prepared, self.actor)
        self.catalog['catalogSha256'] = original
        self.runtime.mode = 'image'
        with self.assertRaises(M.BootstrapError):
            self.manager.checked(prepared, self.actor)
        self.runtime.mode = 'success'
        path = self.code / 'core-clean-target-bootstrap-worker.mjs'
        path.chmod(0o600)
        path.write_bytes(b'changed')
        with self.assertRaises(M.BootstrapError):
            self.manager.checked(prepared, self.actor)
    def test_changed_migration_authorization_and_target_output_rejected(self):
        prepared = self.prepare()
        for relative, change in [
                ('input/authorization.json', lambda value: value.update(decision='denied')),
                ('output/result.json', lambda value: value['target'].update(databaseOid='7')),
                ('output/sanitation-intent.json', lambda value: value.update(seedSha256='0' * 64))]:
            with self.subTest(relative=relative):
                path = self.manager.directory(ID) / relative
                original = path.read_bytes()
                self.mutate_json(relative, change)
                with self.assertRaises(M.BootstrapError):
                    self.manager.checked(prepared, self.actor)
                path.chmod(0o600)
                path.write_bytes(original)
                path.chmod(0o400)
        sql = self.manager.directory(ID) / 'migrations/0000_initial.sql'
        sql.chmod(0o600)
        sql.write_bytes(b'changed')
        sql.chmod(0o400)
        with self.assertRaises(M.BootstrapError):
            self.manager.checked(prepared, self.actor)
    def test_changed_worker_definition_and_terminal_refuse(self):
        prepared = self.prepare()
        identifier = self.manager.record(ID)['inspectionWorkers']['bootstrap']['id']
        worker = self.runtime.workers[identifier]
        worker['actualBody']['Cmd'].append('--changed')
        with self.assertRaises(ValueError):
            self.manager.checked(prepared, self.actor)
        worker['actualBody']['Cmd'].pop()
        worker['State']['Running'] = True
        with self.assertRaises(ValueError):
            self.manager.checked(prepared, self.actor)
    def test_changed_request_and_stop_intent_refuse(self):
        prepared = self.prepare()
        for relative, change in [
                ('input/request.json', lambda value: value.update(expectedCatalogSha256='0' * 64)),
                ('stop-intent.json', lambda value: value['database'].update(id='0' * 64)),
                ('output/worker-start.json', lambda value: value.update(extra='unsupported'))]:
            with self.subTest(relative=relative):
                path = self.manager.directory(ID) / relative
                original = path.read_bytes()
                self.mutate_json(relative, change)
                with self.assertRaises(ValueError):
                    self.manager.checked(prepared, self.actor)
                path.chmod(0o600)
                path.write_bytes(original)
                path.chmod(0o400)
    def test_partial_carrier_migration_refusal_retains_exclusive_job(self):
        self.runtime.files['0000_initial.sql'] = b'changed image migration'
        with self.assertRaises(M.BootstrapError):
            self.prepare()
        self.assert_recovery()
        record = self.manager.record(ID)
        self.assertEqual(set(record['inspectionWorkers']), {'migration-carrier'})
        self.assertFalse(any(call[0] in {'start', 'stop'} for call in self.runtime.calls))
        with self.assertRaises(FileExistsError):
            self.prepare()
    def test_ambiguous_wait_retains_owned_running_database_and_blocks_retry(self):
        self.runtime.mode = 'ambiguous'
        with self.assertRaises(M.BootstrapError):
            self.prepare()
        self.assert_recovery()
        record = self.manager.record(ID)
        self.assertTrue(self.runtime.workers[record['inspectionWorkers']['database']['id']]['State']['Running'])
        self.assertFalse(any(call[0] == 'stop' for call in self.runtime.calls))
        count = len(self.runtime.calls)
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.assertEqual(count, len(self.runtime.calls))
    def test_worker_bad_output_preserves_recovery(self):
        self.runtime.mode = 'target-output'
        with self.assertRaises(M.BootstrapError):
            self.prepare()
        self.assert_recovery()
    def test_worker_wrong_catalog_preserves_recovery(self):
        self.runtime.mode = 'catalog-output'
        with self.assertRaises(M.BootstrapError):
            self.prepare()
        self.assert_recovery()
    def test_controller_volume_is_rejected_without_any_job(self):
        self.runtime.mode = 'volumes'
        with self.assertRaises(M.BootstrapError):
            self.prepare()
        self.assertFalse((self.root / 'core-clean-target-bootstraps').exists())
    def interrupt_initialized(self, identifier=ID, *, generic=False, legacy=False):
        self.manager.capacity.side_effect = [None, None, M.BootstrapCapacityError('memory', 0, 1536 * 1024 ** 2)]
        with contextlib.ExitStack() as stack:
            if legacy:
                stack.enter_context(mock.patch.object(self.manager, 'publish', side_effect=self.enrollment.immutable))
            with self.assertRaises(M.BootstrapError):
                self.manager.prepare(identifier, self.actor)
        self.manager.capacity.side_effect = None
        record = self.manager.record(identifier)
        self.assertEqual(set(record['inspectionWorkers']), {'migration-carrier', 'initialize'})
        if generic:
            record['failureClass'] = 'BootstrapError'
            record.pop('capacityFailure')
            self.manager.save(record)
        return (self.manager.directory(identifier) / 'job.json').read_bytes()

    @staticmethod
    def continuation_id(index=0):
        return f'c329ac67-d7b8-4a55-9aa5-{index:012x}'

    def assert_continued(self, *, generic=False):
        prior = self.interrupt_initialized(generic=generic)
        before = self.manager.record(ID)
        calls = len(self.runtime.calls)
        continued = self.manager.continue_initialized(ID, self.actor, self.continuation_id())
        self.assertEqual(continued.identifier, ID)
        self.assertEqual(self.manager.checked(continued, self.actor), continued)
        record = self.manager.record(ID)
        self.assertEqual(record['workspace'], before['workspace'])
        self.assertEqual(record['inspectionWorkers']['initialize'], before['inspectionWorkers']['initialize'])
        self.assertEqual(record['inspectionWorkers']['migration-carrier'], before['inspectionWorkers']['migration-carrier'])
        self.assertNotIn('failureClass', record)
        self.assertNotIn('capacityFailure', record)
        self.assertEqual(self.guards, 0)
        attempt = self.manager.directory(ID) / 'continuations' / self.continuation_id()
        self.assertEqual((attempt / 'prior-failure.json').read_bytes(), prior)
        intent = json.loads((attempt / 'intent.json').read_bytes())
        self.assertEqual(intent['priorFailureSha256'], M.sha(prior))
        self.assertEqual(intent['proof']['workersSha256'], self.manager.digest(before['inspectionWorkers']))
        created = [call[1]['Labels']['io.orbis.core-clean-target.phase'] for call in self.runtime.calls[calls:] if call[0] == 'create']
        self.assertEqual(created, ['database', 'create-database', 'observer', 'bootstrap'])
        receipt = json.loads((self.manager.directory(ID) / 'receipt.json').read_bytes())
        self.assertEqual(receipt['continuationSha256'], self.manager.digest(record['continuation']))
        self.assertEqual(Authority.seal(self.original.stat()), self.original_seal)
        count = len(self.runtime.calls)
        for candidate in (self.continuation_id(), self.continuation_id(1)):
            with self.assertRaises(ValueError):
                self.manager.continue_initialized(ID, self.actor, candidate)
        self.assertFalse(any(call[0] in {'create', 'start', 'stop'} for call in self.runtime.calls[count:]))
        return continued

    def test_initialized_continuation_preserves_target_and_never_replays_initializer_or_carrier(self):
        self.assert_continued()

    def test_initialized_continuation_accepts_proven_stage_without_inventing_historical_capacity_reason(self):
        continued = self.assert_continued(generic=True)
        prior = json.loads((self.manager.directory(ID) / 'continuations' / self.continuation_id() / 'prior-failure.json').read_bytes())
        self.assertEqual(prior['failureClass'], 'BootstrapError')
        self.assertNotIn('capacityFailure', prior)
        self.assertEqual(self.manager.checked(continued, self.actor), continued)

    def test_initialized_continuation_capacity_refusal_has_no_writes_or_worker_mutations(self):
        prior = self.interrupt_initialized()
        directory = self.manager.directory(ID)
        before = {str(p.relative_to(directory)): Authority.seal(p.lstat()) for p in directory.rglob('*')}
        calls = len(self.runtime.calls)
        self.manager.capacity.side_effect = M.BootstrapCapacityError('disk', 0, 1024 ** 3)
        with self.assertRaises(M.BootstrapCapacityError):
            self.manager.continue_initialized(ID, self.actor, self.continuation_id())
        self.assertEqual((directory / 'job.json').read_bytes(), prior)
        self.assertEqual({str(p.relative_to(directory)): Authority.seal(p.lstat()) for p in directory.rglob('*')}, before)
        self.assertFalse(any(call[0] in {'create', 'start', 'stop'} for call in self.runtime.calls[calls:]))

    def test_initialized_continuation_refuses_changed_bindings_closure_and_partial_state_before_writes(self):
        attacks = ['actor', 'code', 'catalog', 'image', 'approval', 'nonce', 'workspace', 'phase', 'later-role', 'initialize-intent',
                   'initialize-state', 'initialize-exit-bool', 'initialize-oom', 'initialize-terminal', 'initialize-body', 'carrier-started', 'carrier-definition',
                   'migration', 'migration-audit', 'input', 'output', 'pg-version', 'postmaster', 'socket', 'partial-continuation', 'continuation-id']
        for index, attack in enumerate(attacks):
            identifier = f'a71c77d2-f420-440e-951b-{index:012x}'
            self.interrupt_initialized(identifier)
            directory = self.manager.directory(identifier)
            record = self.manager.record(identifier)
            actor, continuation = self.actor, self.continuation_id(index)
            code = self.code / 'core-clean-target-bootstrap-worker.mjs'
            original_code, original_catalog = code.read_bytes(), copy.deepcopy(self.catalog)
            try:
                if attack == 'actor': actor = self.actor | {'ownerId': 2}
                if attack == 'code': code.chmod(0o600); code.write_bytes(b'changed'); code.chmod(0o400)
                if attack == 'catalog': self.catalog['catalogSha256'] = '0' * 64
                if attack == 'image': self.runtime.mode = 'image'
                if attack == 'approval': record['approvalSha256'] = '0' * 64
                if attack == 'nonce': record['workspace']['allocation']['nonce'] = self.continuation_id(index)
                if attack == 'workspace': record['workspace']['identities']['pgdata'][1] += 1
                if attack == 'phase': record['phases'].pop()
                if attack == 'later-role': record['inspectionWorkers']['database'] = {'intent': 'creating'}
                if attack == 'initialize-intent': record['inspectionWorkers']['initialize']['intent'] = 'waiting'
                if attack == 'initialize-terminal': record['inspectionWorkers']['initialize']['terminal']['state']['ExitCode'] = 1
                if attack == 'initialize-body': record['inspectionWorkers']['initialize']['body']['Cmd'].append('--changed')
                if attack == 'initialize-state': self.runtime.workers[record['inspectionWorkers']['initialize']['id']]['State']['ExitCode'] = 1
                if attack == 'initialize-exit-bool': self.runtime.workers[record['inspectionWorkers']['initialize']['id']]['State']['ExitCode'] = False
                if attack == 'initialize-oom': self.runtime.workers[record['inspectionWorkers']['initialize']['id']]['State']['OOMKilled'] = True
                if attack == 'carrier-started': self.runtime.workers[record['inspectionWorkers']['migration-carrier']['id']]['State'].update(Status='running', Running=True)
                if attack == 'carrier-definition': self.runtime.workers[record['inspectionWorkers']['migration-carrier']['id']]['actualBody']['Cmd'].append('--changed')
                if attack == 'migration':
                    file = directory / 'migrations/0000_initial.sql'; file.chmod(0o600); file.write_bytes(b'changed'); file.chmod(0o400)
                if attack == 'migration-audit':
                    file = directory / 'migration-audit.json'; file.chmod(0o600); file.write_bytes(b'{"changed":true}'); file.chmod(0o400)
                if attack in {'input', 'output'}: (directory / attack / 'unexpected').write_bytes(b'partial')
                if attack == 'pg-version': (directory / 'target/pgdata/PG_VERSION').write_bytes(b'16\n')
                if attack == 'postmaster': (directory / 'target/pgdata/postmaster.pid').write_bytes(b'1')
                if attack == 'socket': (directory / 'target/socket/stale').write_bytes(b'partial')
                if attack == 'partial-continuation': (directory / 'continuations').mkdir(mode=0o700)
                if attack == 'continuation-id': continuation = 'not-an-id'
                self.manager.save(record)
                prior = (directory / 'job.json').read_bytes()
                calls = len(self.runtime.calls)
                with self.subTest(attack=attack), self.assertRaises(ValueError):
                    self.manager.continue_initialized(identifier, actor, continuation)
                self.assertEqual((directory / 'job.json').read_bytes(), prior)
                self.assertEqual((directory / 'continuations').exists(), attack == 'partial-continuation')
                self.assertFalse(any(call[0] in {'create', 'start', 'stop'} for call in self.runtime.calls[calls:]))
            finally:
                self.runtime.mode = 'success'
                self.catalog.clear(); self.catalog.update(original_catalog)
                code.chmod(0o600); code.write_bytes(original_code); code.chmod(0o400)

    def test_initialized_continuation_rechecks_bindings_after_capacity_before_writing(self):
        prior = self.interrupt_initialized()
        def change_catalog(_directory):
            self.catalog['catalogSha256'] = '0' * 64
        self.manager.capacity.side_effect = change_catalog
        with self.assertRaises(ValueError):
            self.manager.continue_initialized(ID, self.actor, self.continuation_id())
        self.assertEqual((self.manager.directory(ID) / 'job.json').read_bytes(), prior)
        self.assertFalse((self.manager.directory(ID) / 'continuations').exists())

    def test_initialized_continuation_partial_intent_is_retained_and_never_reclaimed(self):
        prior = self.interrupt_initialized()
        original = self.manager.publish
        def fail_intent(path, body):
            if path.name == 'intent.json': raise OSError('test interrupted intent write')
            return original(path, body)
        calls = len(self.runtime.calls)
        with mock.patch.object(self.manager, 'publish', side_effect=fail_intent), self.assertRaises(OSError):
            self.manager.continue_initialized(ID, self.actor, self.continuation_id())
        attempt = self.manager.directory(ID) / 'continuations' / self.continuation_id()
        self.assertEqual(set(p.name for p in attempt.iterdir()), {'prior-failure.json', 'migrations'})
        self.assertEqual((attempt / 'prior-failure.json').read_bytes(), prior)
        self.assertEqual((self.manager.directory(ID) / 'job.json').read_bytes(), prior)
        with self.assertRaises(ValueError):
            self.manager.continue_initialized(ID, self.actor, self.continuation_id(1))
        self.assertFalse(any(call[0] in {'create', 'start', 'stop'} for call in self.runtime.calls[calls:]))

    def test_initialized_continuation_failure_after_database_start_retains_owned_worker_and_prior_failure(self):
        prior = self.interrupt_initialized()
        self.manager.capacity.side_effect = [None, None, M.BootstrapCapacityError('disk', 0, 1024 ** 3)]
        calls = len(self.runtime.calls)
        with self.assertRaises(M.BootstrapError):
            self.manager.continue_initialized(ID, self.actor, self.continuation_id())
        record = self.manager.record(ID)
        self.assertEqual(record['phase'], 'recovery-required')
        self.assertEqual(record['capacityFailure']['reason'], 'disk')
        self.assertEqual(set(record['inspectionWorkers']), {'migration-carrier', 'initialize', 'database'})
        self.assertTrue(self.runtime.workers[record['inspectionWorkers']['database']['id']]['State']['Running'])
        self.assertFalse(any(call[0] == 'stop' for call in self.runtime.calls[calls:]))
        self.assertEqual((self.manager.directory(ID) / 'continuations' / self.continuation_id() / 'prior-failure.json').read_bytes(), prior)
        self.manager.capacity.side_effect = None
        count = len(self.runtime.calls)
        with self.assertRaises(ValueError):
            self.manager.continue_initialized(ID, self.actor, self.continuation_id(1))
        self.assertFalse(any(call[0] in {'create', 'start', 'stop'} for call in self.runtime.calls[count:]))

    def test_initialized_continuation_holds_guard_through_source_checks_and_new_worker_starts(self):
        self.interrupt_initialized()
        original_reader, original_engine = self.approval.catalog_reader, self.runtime.engine
        def catalog():
            self.assertGreater(self.guards, 0)
            return original_reader()
        def engine(*args):
            self.assertGreater(self.guards, 0)
            return original_engine(*args)
        self.manager.approval = M.RootBootstrapApproval(self.approval.configuration_binding, self.approval.profile,
            self.approval.source_catalog, self.approval.migration_inventory, self.approval.migration_graph, catalog, self.guard)
        with mock.patch.object(self.runtime, 'engine', side_effect=engine):
            continued = self.manager.continue_initialized(ID, self.actor, self.continuation_id())
            self.assertEqual(self.manager.checked(continued, self.actor), continued)
        self.assertEqual(self.guards, 0)

    def test_initialized_continuation_checked_receipt_binds_intent_and_directory_identity(self):
        continued = self.assert_continued()
        directory = self.manager.directory(ID)
        attempt = directory / 'continuations' / self.continuation_id()
        path = attempt / 'intent.json'
        body = json.loads(path.read_bytes()); body['actor']['ownerId'] = 2
        path.chmod(0o600); path.write_bytes(Publication.canonical(body)); path.chmod(0o400)
        with self.assertRaises(ValueError):
            self.manager.checked(continued, self.actor)
        moved = directory / 'journal-preserved'
        attempt.rename(moved)
        attempt.mkdir(mode=0o700)
        for item in moved.iterdir():
            if item.is_file(): self.manager.publish(attempt / item.name, item.read_bytes())
            else:
                (attempt / item.name).mkdir(mode=0o700)
                (attempt / item.name / 'meta').mkdir(mode=0o700)
                for original in item.rglob('*'):
                    if original.is_file(): self.manager.publish(attempt / item.name / original.relative_to(item), original.read_bytes())
        with self.assertRaises(ValueError):
            self.manager.checked(continued, self.actor)

    def test_initialized_continuation_checked_receipt_refuses_journal_tamper_and_identical_replacement(self):
        continued = self.assert_continued()
        record = self.manager.record(ID)
        attempt = self.manager.directory(ID) / 'continuations' / self.continuation_id()
        path = attempt / 'prior-failure.json'
        raw = path.read_bytes()
        path.unlink(); self.manager.publish(path, raw)
        with self.assertRaises(ValueError):
            self.manager.checked(continued, self.actor)
        self.assertEqual(self.manager.record(ID)['phase'], 'complete')
        record.pop('continuation')
        self.manager.save(record)
        with self.assertRaises(ValueError):
            self.manager.checked(continued, self.actor)

    def test_exclusive_publisher_uses_real0400_transport_and_leaves_shared_default600(self):
        directory = self.enrollment.child(self.root, 'publication')
        shared, target = directory / 'shared.json', directory / 'new.json'
        self.enrollment.immutable(shared, b'shared private default')
        self.assertEqual(stat.S_IMODE(shared.lstat().st_mode), 0o600)
        real_open = os.open
        with mock.patch.object(M.os, 'open', wraps=real_open) as calls, mock.patch.object(M.os, 'fsync', wraps=os.fsync) as sync:
            self.manager.publish(target, b'new worker transport')
        created = [call for call in calls.call_args_list if call.args[1] & os.O_CREAT]
        self.assertEqual(len(created), 1)
        self.assertTrue(created[0].args[1] & os.O_EXCL)
        self.assertTrue(created[0].args[1] & os.O_NOFOLLOW)
        self.assertIn('dir_fd', created[0].kwargs)
        self.assertGreaterEqual(sync.call_count, 2)
        self.assertEqual(stat.S_IMODE(target.lstat().st_mode), 0o400)
        self.assertEqual(target.lstat().st_nlink, 1)
        self.assertEqual(target.read_bytes(), b'new worker transport')
        seal = Authority.seal(target.lstat())
        with self.assertRaises(FileExistsError): self.manager.publish(target, b'new worker transport')
        self.assertEqual(Authority.seal(target.lstat()), seal)
        self.assertEqual(stat.S_IMODE(shared.lstat().st_mode), 0o600)

    def test_exclusive_publisher_refuses_symlinks_and_partial_names_without_cleanup(self):
        directory = self.enrollment.child(self.root, 'publication')
        target = directory / 'data'
        target.symlink_to(self.original)
        with self.assertRaises(FileExistsError): self.manager.publish(target, b'not accepted')
        self.assertEqual(Authority.seal(self.original.lstat()), self.original_seal)
        partial = directory / 'partial'
        real_write = os.write
        count = 0
        def interrupted(descriptor, body):
            nonlocal count
            count += 1
            if count == 1: return real_write(descriptor, body[:1])
            raise OSError('test write interrupted')
        with mock.patch.object(M.os, 'write', side_effect=interrupted), self.assertRaises(OSError):
            self.manager.publish(partial, b'complete bytes')
        self.assertEqual(partial.read_bytes(), b'c')
        self.assertEqual(stat.S_IMODE(partial.lstat().st_mode), 0o400)
        with self.assertRaises(FileExistsError): self.manager.publish(partial, b'complete bytes')
        self.assertEqual(partial.read_bytes(), b'c')

    def test_exclusive_publisher_detects_identical_byte_name_replacement(self):
        directory = self.enrollment.child(self.root, 'publication')
        target, held = directory / 'data', directory / 'preserved'
        real_sync, first = os.fsync, True
        def replace(descriptor):
            nonlocal first
            real_sync(descriptor)
            if first:
                first = False
                target.rename(held)
                self.manager.publish(target, b'identical bytes')
        with mock.patch.object(M.os, 'fsync', side_effect=replace), self.assertRaises(M.BootstrapError):
            self.manager.publish(target, b'identical bytes')
        self.assertEqual(target.read_bytes(), held.read_bytes())
        self.assertNotEqual(target.lstat().st_ino, held.lstat().st_ino)

    def test_real_legacy600_inputs_remain_unchanged_and_only400_copies_reach_worker(self):
        self.interrupt_initialized(generic=True, legacy=True)
        directory = self.manager.directory(ID)
        names = ['root-intent.json', 'migration-audit.json', 'migrations/0000_initial.sql', 'migrations/meta/_journal.json']
        before = {name: (Authority.seal((directory / name).lstat()), (directory / name).read_bytes()) for name in names}
        self.assertTrue(all(stat.S_IMODE((directory / name).lstat().st_mode) == 0o600 for name in names))
        with self.assertRaises(M.BootstrapError): self.manager.read(directory / 'root-intent.json', 2 * 1024 ** 2)
        continued = self.manager.continue_initialized(ID, self.actor, self.continuation_id())
        self.assertEqual(self.manager.checked(continued, self.actor), continued)
        self.assertEqual({name: (Authority.seal((directory / name).lstat()), (directory / name).read_bytes()) for name in names}, before)
        record = self.manager.record(ID)
        copies = directory / 'continuations' / self.continuation_id() / 'migrations'
        mount = next(m for m in record['inspectionWorkers']['bootstrap']['body']['HostConfig']['Mounts'] if m['Target'] == '/clean-target-migrations')
        self.assertEqual(Path(mount['Source']), copies)
        for name in self.approved_inventory():
            self.assertEqual(stat.S_IMODE((copies / name).lstat().st_mode), 0o400)
            self.assertEqual((copies / name).read_bytes(), (directory / 'migrations' / name).read_bytes())
        for file in (directory / 'input').iterdir(): self.assertEqual(stat.S_IMODE(file.lstat().st_mode), 0o400)
        with self.assertRaises(M.BootstrapError): self.manager.read(directory / 'root-intent.json', 2 * 1024 ** 2)
        file = copies / '0000_initial.sql'; body = file.read_bytes(); file.unlink(); self.manager.publish(file, body)
        with self.assertRaises(ValueError): self.manager.checked(continued, self.actor)

    def test_legacy600_history_and_copy_path_remain_pinned_after_continuation(self):
        self.interrupt_initialized(generic=True, legacy=True)
        handle = self.manager.continue_initialized(ID, self.actor, self.continuation_id())
        directory = self.manager.directory(ID)
        record = self.manager.record(ID)
        record['continuation']['migrationPath'] = 'migrations'
        self.manager.save(record)
        with self.assertRaises(ValueError): self.manager.checked(handle, self.actor)
        record['continuation']['migrationPath'] = 'continuations/' + self.continuation_id() + '/migrations'
        self.manager.save(record)
        self.assertEqual(self.manager.checked(handle, self.actor), handle)
        history = directory / 'root-intent.json'; body = history.read_bytes()
        history.unlink(); self.enrollment.immutable(history, body)
        self.assertEqual(stat.S_IMODE(history.lstat().st_mode), 0o600)
        with self.assertRaises(ValueError): self.manager.checked(handle, self.actor)

    def approved_inventory(self):
        return self.approval.migration_inventory['files']

    def test_legacy600_admission_refuses_wrong_stage_modes_and_unexpected_paths(self):
        self.interrupt_initialized(generic=True, legacy=True)
        directory = self.manager.directory(ID)
        record = self.manager.record(ID)
        arbitrary = directory / 'arbitrary.json'
        self.enrollment.immutable(arbitrary, b'arbitrary')
        with self.assertRaises(M.BootstrapError): self.manager._initialized_file(record, 'arbitrary.json', b'arbitrary')
        arbitrary.unlink()
        file = directory / 'migrations/0000_initial.sql'
        file.chmod(0o644)
        with self.assertRaises(ValueError): self.manager.continue_initialized(ID, self.actor, self.continuation_id())
        self.assertFalse((directory / 'continuations').exists())
        file.chmod(0o600)
        record['inspectionWorkers']['database'] = {'intent': 'creating'}
        self.manager.save(record)
        with self.assertRaises(ValueError): self.manager.continue_initialized(ID, self.actor, self.continuation_id())
        self.assertFalse((directory / 'continuations').exists())

    def test_capacity_thresholds_and_host_policy_stay_fixed(self):
        method = M.CoreCleanTargetBootstrap.capacity
        memory, disk = 1536 * 1024 ** 2, 1024 ** 3
        for available, free, reason in [(memory, disk, None), (memory - 1024, disk, 'memory'),
                                        (memory, disk - 1, 'disk'), (memory - 1024, disk - 1, 'memory')]:
            with (mock.patch('builtins.open', mock.mock_open(read_data=f'MemAvailable: {available // 1024} kB\n')),
                  mock.patch.object(M.os, 'statvfs', return_value=SimpleNamespace(f_bavail=free, f_frsize=1))):
                if reason is None:
                    method(self.manager, self.root)
                else:
                    with self.assertRaises(M.BootstrapCapacityError) as failure:
                        method(self.manager, self.root)
                    self.assertEqual((failure.exception.reason, failure.exception.availableBytes, failure.exception.requiredBytes),
                                     (reason, available, memory) if reason == 'memory' else (reason, free, disk))

    def test_capacity_failure_records_only_the_precise_resource_on_new_job(self):
        memory, disk = 1536 * 1024 ** 2, 1024 ** 3
        for index, (reason, available, required) in enumerate((('memory', memory - 1024, memory), ('disk', disk - 1, disk))):
            identifier = ID[:-1] + str(index)
            self.manager.capacity.side_effect = [None, None, M.BootstrapCapacityError(reason, available, required)]
            with self.subTest(reason=reason), self.assertRaises(M.BootstrapError):
                self.manager.prepare(identifier, self.actor)
            record = self.manager.record(identifier)
            self.assertEqual(record['phase'], 'recovery-required')
            self.assertEqual(record['failureClass'], 'BootstrapCapacityError')
            self.assertEqual(record['capacityFailure'], {'reason': reason, 'availableBytes': available, 'requiredBytes': required})
            self.assertEqual(record['phases'], ['selecting-migrations', 'initializing', 'starting-database'])
            self.assertEqual(set(record['inspectionWorkers']), {'migration-carrier', 'initialize'})
            self.assertFalse((self.manager.directory(identifier) / 'receipt.json').exists())
            self.assertEqual(Authority.seal(self.original.stat()), self.original_seal)

    def test_preallocation_capacity_failure_creates_no_job_or_workers(self):
        self.manager.capacity.side_effect = M.BootstrapCapacityError('memory', 0, 1536 * 1024 ** 2)
        with self.assertRaises(M.BootstrapCapacityError):
            self.prepare()
        self.assertFalse((self.root / 'core-clean-target-bootstraps').exists())
        self.assertEqual(self.runtime.calls, [])

    def test_missing_memory_measurement_does_not_invent_resource_bytes(self):
        with (mock.patch('builtins.open', mock.mock_open(read_data='MemTotal: 3145728 kB\n')),
              mock.patch.object(M.os, 'statvfs', return_value=SimpleNamespace(f_bavail=1024 ** 3, f_frsize=1))):
            with self.assertRaises(M.BootstrapError) as failure:
                M.CoreCleanTargetBootstrap.capacity(self.manager, self.root)
            self.assertNotIsInstance(failure.exception, M.BootstrapCapacityError)


class MigrationTests(unittest.TestCase):
    def test_archive_links_paths_duplicates_and_gaps_refuse(self):
        files = Runtime(None).files
        for name in ('../outside.sql', 'meta/../../outside', 'unexpected'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                M.migration_bundle(archive(files | {name: b'bad'}))
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE):
            link = tarfile.TarInfo('alias')
            link.type, link.linkname = kind, '0000_initial.sql'
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                M.migration_bundle(archive(files, link))
        _, _, graph = M.migration_bundle(archive(files))
        M.validate_ledger([{'id': 7, **graph[0]}], graph)
        with self.assertRaises(M.BootstrapError):
            M.validate_ledger([{'id': 0, **graph[0]}], graph)
        with self.assertRaises(M.BootstrapError):
            M.validate_ledger([{'id': 7, 'hash': '0' * 64, 'created_at': '1'}], graph)
    def test_journal_graph_completeness_and_wrapped_archive(self):
        files = Runtime(None).files
        self.assertEqual(M.migration_bundle(archive({'migrations/' + n: b for n, b in files.items()}))[0], files)
        for changed in (files | {'0001_extra.sql': b'UNAPPROVED'},
                        {n: b for n, b in files.items() if n != '0000_initial.sql'},
                        files | {'0000_initial.sql': b'\xff'}):
            with self.subTest(files=list(changed)), self.assertRaises(ValueError):
                M.migration_bundle(archive(changed))
    def test_serialized_approval_has_no_authority(self):
        with self.assertRaises(M.BootstrapError):
            M.CoreCleanTargetBootstrap(object(), {'profile': 'raw request'})
        if sys.platform != 'linux' or os.geteuid() != 0:
            with self.assertRaises(M.TARGET.TargetProfileError):
                M.TARGET.require_root()


class VersionedBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.fixture = BootstrapTests('test_success_real_allocator_and_supervisor_checked_handle')
        self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.old_image = self.fixture.runtime.image
        self.configure(14)

    def configure(self, major):
        f = self.fixture;architecture = 'amd64' if major == 14 else 'arm64'
        def image(identifier):
            value = self.old_image(identifier)
            if identifier == M.TARGET.SOURCE.PG.PG14_AMD64_IMAGE:
                value['Config']['Volumes'] = {'/var/lib/postgresql/data': {}};value['Architecture'] = 'amd64'
            elif identifier != M.TARGET.SOURCE.PG17_ARM64_IMAGE:value['Architecture'] = architecture
            return value
        f.runtime.image = image;f.trust.architecture = architecture
        f.broker.binding = lambda: f.binding() | {'architecture': architecture}
        f.broker.image = lambda: M.require(f.runtime.image(f.trust.image_id)['Architecture'] == architecture)
        identifier = M.TARGET.SOURCE.PG.PG14_AMD64_IMAGE if major == 14 else M.TARGET.SOURCE.PG17_ARM64_IMAGE
        f.profile = M.TARGET.bounded_clean_target_profile(image(identifier), 'target_role', 'target_database', f.runtime.target()['locale'])
        source = M.TARGET.SOURCE.role_bound_execution_profile(image(identifier), 'source_role', 'b' * 64)
        f.catalog.update(schema='orbis.core-root-authenticated-bootstrap-source.v2', executionProfile=source,
            databaseExecution={'schema': 'orbis.core-pg-execution-observation.v1', 'profileId': source['profileId'],
                'serverVersionNum': major * 10000 + 23, 'major': major, 'database': 'source_database',
                'locale': copy.deepcopy(f.profile['locale']),
                'localeProviderEvidence': 'postgresql14-libc-database-default' if major == 14 else 'pg_database.datlocprovider'})
        f.approval = M.RootBootstrapApproval(f.broker.binding(), f.profile, copy.deepcopy(f.catalog),
            f.approval.migration_inventory, f.approval.migration_graph, lambda: copy.deepcopy(f.catalog), f.guard)
        f.manager = M.CoreVersionedCleanTargetBootstrap(f.broker, f.approval)
        f.enrollment.publisher = f.manager.publish
        self.enterContext(mock.patch.object(f.manager, 'capacity'))
        # Only child ownership/group are virtual; inode, mode, FD traversal and seals remain real.
        self.enterContext(mock.patch.object(f.manager, 'validate_initialized_child', side_effect=self.fixture_child_identity))
        self.enterContext(mock.patch.object(M.TARGET, 'database_body', side_effect=self.database_body))

    def fixture_child_identity(self, record, child, details):
        M.require(child in {'pgdata', 'config'} and stat.S_ISDIR(details.st_mode)
            and stat.S_IMODE(details.st_mode) == (0o700 if child == 'pgdata' else 0o550)
            and M.TARGET.directory_identity(details) == record['workspace']['identities'][child])

    def database_body(self, workspace, authority):
        f = self.fixture;f.verify_workspace(workspace, authority)
        M.require((workspace.directory / 'pgdata/PG_VERSION').read_bytes() == (str(workspace.profile['major']) + '\n').encode())
        command = ['-D', '/var/lib/postgresql/data']
        for name, value in M.TARGET.settings_for(workspace.profile).items():command.extend(['-c', name + '=' + value])
        return M.TARGET.body(workspace, 'database', M.TARGET.binary_for(workspace.profile, 'postgres'), command, [
            M.TARGET.SOURCE.mount(workspace.directory / 'pgdata', '/var/lib/postgresql/data', False),
            M.TARGET.SOURCE.mount(workspace.directory / 'config', '/clean-target-config', True),
            M.TARGET.SOURCE.mount(workspace.directory / 'socket', '/var/run/postgresql', False)])

    def test_versioned14_runs_real_private_file_supervisor_path_and_checked_receipt(self):self.check_success(14)

    def test_versioned17_is_explicit_and_preserves_legacy_binaries(self):
        self.configure(17);self.check_success(17)

    def check_success(self, major):
        f = self.fixture;handle = f.prepare();self.assertEqual(f.manager.checked(handle, f.actor), handle)
        record = f.manager.record(ID);directory = f.manager.directory(ID)
        self.assertEqual(record['schema'], 'orbis.core-clean-target-bootstrap-job.v2')
        self.assertEqual(record['request']['schema'], 'orbis.core-clean-target-bootstrap-input.v2')
        self.assertEqual(record['authorization']['schema'], 'orbis.core-clean-target-bootstrap-authorization.v2')
        self.assertEqual(record['request']['executionProfile'], f.profile['profileId'])
        for path in (directory / 'output').iterdir():
            value = json.loads(path.read_bytes());self.assertTrue(value['schema'].endswith('.v2'))
            self.assertEqual(value['executionProfile'], f.profile['profileId']);self.assertEqual(path.stat().st_mode & 0o777, 0o400)
        receipt = json.loads((directory / 'receipt.json').read_bytes())
        self.assertEqual(receipt['schema'], 'orbis.core-clean-target-bootstrap-receipt.v2')
        self.assertEqual(receipt['executionProfile'], f.profile['profileId'])
        observation = json.loads((directory / 'target-execution.json').read_bytes())
        self.assertEqual(observation['major'], major)
        self.assertEqual(observation['serverVersionNum'] // 10000, major)
        self.assertEqual(receipt['targetExecutionSha256'], M.sha((directory / 'target-execution.json').read_bytes()))
        initializer = record['inspectionWorkers']['initialize']['body'];observer = record['inspectionWorkers']['observer']['body']
        self.assertEqual(initializer['Entrypoint'], [M.TARGET.binary_for(f.profile, 'initdb')])
        self.assertEqual('--locale-provider=libc' in initializer['Cmd'], major == 17)
        self.assertEqual(observer['Entrypoint'], [M.TARGET.binary_for(f.profile, 'psql')])
        self.assertEqual('d.datlocprovider' in observer['Cmd'][-1], major == 17)
        self.assertEqual((directory / 'job.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(Authority.seal(f.original.stat()), f.original_seal)
        self.assertFalse(receipt['activation']);self.assertFalse(receipt['environmentProved']);self.assertFalse(receipt['restoreAuthority'])

    def test_versioned_factory_requires_new_inspector_and_rechecks_its_catalog(self):
        f = self.fixture;calls = []
        def catalog(identifier, actor):
            self.assertGreater(f.guards, 0);calls.append(identifier);return copy.deepcopy(f.catalog)
        inspection = SimpleNamespace(configuration=f.broker, schema='orbis.core-restore-inspection.v4', bootstrap_catalog=catalog)
        args = dict(profile=f.profile, migration_inventory=f.approval.migration_inventory, migration_graph=f.approval.migration_graph, guard=f.guard)
        with self.assertRaises(ValueError):M.CoreCleanTargetBootstrap.from_source_inspection(f.broker, inspection, ID, f.actor, **args)
        old = copy.copy(inspection);old.schema = 'orbis.core-restore-inspection.v3'
        with self.assertRaises(ValueError):M.CoreVersionedCleanTargetBootstrap.from_source_inspection(f.broker, old, ID, f.actor, **args)
        manager = M.CoreVersionedCleanTargetBootstrap.from_source_inspection(f.broker, inspection, ID, f.actor, **args)
        with f.guard():self.assertEqual(manager.validate(f.actor), f.actor)
        self.assertGreater(len(calls), 1)
        self.assertEqual(f.runtime.calls, [])

    def test_versioned_catalog_profile_observation_and_locale_mismatch_refuse_before_allocation(self):
        f = self.fixture
        changes = [lambda c: c.update(schema='orbis.core-root-authenticated-bootstrap-source.v1'),
            lambda c: c['executionProfile'].update(uid=70), lambda c: c['executionProfile'].update(major=17),
            lambda c: c['databaseExecution'].update(major=17), lambda c: c['databaseExecution'].update(serverVersionNum=170023),
            lambda c: c['databaseExecution']['locale'].update(collate='POSIX'), lambda c: c.update(databaseExecution=None)]
        original = copy.deepcopy(f.manager.approved['catalog'])
        for change in changes:
            bad = copy.deepcopy(original);change(bad);f.catalog.clear();f.catalog.update(copy.deepcopy(bad));f.manager.approved['catalog'] = bad
            with self.subTest(change=change), self.assertRaises(ValueError):f.prepare()
            self.assertEqual(f.runtime.calls, [])
            self.assertFalse((f.root / 'core-clean-target-bootstraps').exists())

    def test_v2_output_profile_schema_and_major_cannot_be_replayed_or_relabelled(self):
        f = self.fixture;f.prepare();record = f.manager.record(ID);path = f.manager.directory(ID) / 'output/result.json';original = json.loads(path.read_bytes())
        for change in ({'schema': 'orbis.core-clean-target-bootstrap-result.v1'}, {'executionProfile': 'pg17-alpine-arm64.v1'},
                       {'structure': original['structure'] | {'major': 17}}):
            path.chmod(0o600);path.write_bytes(Publication.canonical(original | change));path.chmod(0o400)
            with self.subTest(change=change), self.assertRaises(ValueError):f.manager.outputs(f.manager.directory(ID), record)
        self.assertEqual(Authority.seal(f.original.stat()), f.original_seal)

    def test_new_target_observer_rejects_actual_major_and_provider_evidence_drift_before_bootstrap(self):
        f = self.fixture;profile = f.profile;value = f.runtime.target() | {'serverVersionNum': 140023,
            'localeProviderEvidence': 'postgresql14-libc-database-default'}
        self.assertEqual(f.manager.observed_identity(value, profile), f.runtime.target())
        for change in ({'serverVersionNum': 170023}, {'serverVersionNum': True},
                       {'localeProviderEvidence': 'pg_database.datlocprovider'}, {'localeProviderEvidence': None}):
            with self.subTest(change=change), self.assertRaises(ValueError):f.manager.observed_identity(value | change, profile)
        with self.assertRaises(ValueError):f.manager.observed_identity(f.runtime.target(), profile)
        self.assertEqual(f.runtime.calls, [])

    def test_observer_wrong_server_major_stops_before_request_or_bootstrap_worker(self):
        f = self.fixture;output = f.runtime.bounded_output
        def changed(args, maximum, timeout):
            raw = output(args, maximum, timeout)
            if 'logs' in args:
                value = json.loads(raw);value['serverVersionNum'] = 170023;return Publication.canonical(value)
            return raw
        f.runtime.bounded_output = changed
        with self.assertRaises(ValueError):f.prepare()
        record = f.manager.record(ID)
        self.assertEqual(record['phase'], 'recovery-required')
        self.assertNotIn('bootstrap', record['inspectionWorkers'])
        self.assertFalse(list((f.manager.directory(ID) / 'input').iterdir()))
        self.assertFalse((f.manager.directory(ID) / 'receipt.json').exists())
        self.assertFalse(any(call[0] == 'stop' for call in f.runtime.calls))

    def test_target_execution_evidence_tamper_refuses_checked_receipt(self):
        f = self.fixture;handle = f.prepare();path = f.manager.directory(ID) / 'target-execution.json'
        value = json.loads(path.read_bytes());value['serverVersionNum'] += 1
        path.chmod(0o600);path.write_bytes(Publication.canonical(value));path.chmod(0o400)
        with self.assertRaises(ValueError):f.manager.checked(handle, f.actor)
        self.assertEqual(Authority.seal(f.original.stat()), f.original_seal)

    def test_v2_immutable_inputs_reject600_and_old_job_schema(self):
        f = self.fixture;handle = f.prepare();directory = f.manager.directory(ID)
        path = directory / 'input/request.json';path.chmod(0o600)
        with self.assertRaises(ValueError):f.manager.checked(handle, f.actor)
        path.chmod(0o400);record = f.manager.record(ID);record['schema'] = M.SCHEMA;f.manager.save(record)
        with self.assertRaises(ValueError):f.manager.record(ID)

    def test_initialized_v2_failure_without_original_custody_remains_blocked(self):
        f = self.fixture;f.interrupt_initialized();record = f.manager.record(ID)
        record.pop('initializedCustody');f.manager.save(record)
        path = f.manager.directory(ID) / 'job.json';before = path.read_bytes();seal = Authority.seal(path.stat());calls = copy.deepcopy(f.runtime.calls)
        with self.assertRaises(ValueError):f.manager.continue_initialized(ID, f.actor, f.continuation_id())
        self.assertEqual(path.read_bytes(), before);self.assertEqual(Authority.seal(path.stat()), seal)
        self.assertFalse((f.manager.directory(ID) / 'continuations').exists())
        self.assertFalse(any(call[0] in {'create', 'start', 'stop'} for call in f.runtime.calls[len(calls):]))


class VersionedInitializedContinuationTests(unittest.TestCase):
    def setUp(self):
        self.versioned = VersionedBootstrapTests('test_versioned14_runs_real_private_file_supervisor_path_and_checked_receipt')
        self.versioned.setUp();self.addCleanup(self.versioned.doCleanups)
        self.fixture = self.versioned.fixture

    def snapshot(self, directory):
        return {str(path.relative_to(directory)): Authority.seal(path.lstat()) for path in directory.rglob('*')}

    def test_pg14_same_initialized_target_continues_with_v2_intent_and_checked_receipt(self):self.check_success(14)

    def test_pg17_same_initialized_target_continues_without_legacy_scope_adoption(self):
        self.versioned.configure(17);self.check_success(17)

    def check_success(self, major):
        f = self.fixture;prior = f.interrupt_initialized();before = f.manager.record(ID);calls = len(f.runtime.calls)
        custody = before['initializedCustody'];seals = f.manager.initialized_file_seals(before)
        self.assertEqual(custody['profile'], f.profile)
        self.assertEqual(custody['initialWorkersSha256'], f.manager.digest(before['inspectionWorkers']))
        with mock.patch.object(f.manager, 'require_initialized_recheck', wraps=f.manager.require_initialized_recheck) as recheck:
            handle = f.manager.continue_initialized(ID, f.actor, f.continuation_id())
            recheck.assert_called_once();self.assertEqual(recheck.call_args.args[0], recheck.call_args.args[1])
        self.assertEqual(f.manager.checked(handle, f.actor), handle)
        record = f.manager.record(ID);directory = f.manager.directory(ID);attempt = directory / 'continuations' / f.continuation_id()
        self.assertEqual(record['workspace'], before['workspace'])
        self.assertEqual(record['initializedCustody'], custody)
        self.assertEqual(f.manager.initialized_file_seals(before), seals)
        for role in ('migration-carrier', 'initialize'):self.assertEqual(record['inspectionWorkers'][role], before['inspectionWorkers'][role])
        phases = [call[1]['Labels']['io.orbis.core-clean-target.phase'] for call in f.runtime.calls[calls:] if call[0] == 'create']
        self.assertEqual(phases, ['database', 'create-database', 'observer', 'bootstrap'])
        self.assertEqual((attempt / 'prior-failure.json').read_bytes(), prior)
        intent = json.loads((attempt / 'intent.json').read_bytes())
        self.assertEqual(intent['schema'], 'orbis.core-clean-target-initialized-continuation.v2')
        self.assertEqual(intent['executionProfile'], f.profile['profileId'])
        self.assertEqual(intent['proof']['initializedCustodySha256'], f.manager.digest(custody))
        self.assertEqual(intent['proof']['executionProfile'], f.profile['profileId'])
        self.assertEqual(intent['proof']['inputMode'], 0o400)
        for path in attempt.rglob('*'):
            if path.is_file():self.assertEqual(path.stat().st_mode & 0o777, 0o400)
        worker = record['inspectionWorkers']['bootstrap']['body'];mount = next(m for m in worker['HostConfig']['Mounts'] if m['Target'] == '/clean-target-migrations')
        self.assertEqual(mount['Source'], str(attempt / 'migrations'))
        receipt = json.loads((directory / 'receipt.json').read_bytes())
        self.assertEqual(receipt['schema'], 'orbis.core-clean-target-bootstrap-receipt.v2')
        self.assertEqual(receipt['executionProfile'], f.profile['profileId'])
        self.assertEqual(receipt['continuationSha256'], f.manager.digest(record['continuation']))
        self.assertEqual(json.loads((directory / 'target-execution.json').read_bytes())['major'], major)
        calls = len(f.runtime.calls)
        with self.assertRaises(ValueError):f.manager.continue_initialized(ID, f.actor, f.continuation_id(1))
        self.assertFalse(any(call[0] in {'create', 'start', 'stop'} for call in f.runtime.calls[calls:]))
        self.assertEqual(Authority.seal(f.original.stat()), f.original_seal)

    def test_original400_seals_reject_identical_replacement_tamper_and_unsafe_stage(self):
        f = self.fixture
        attacks = ['missing', 'custody-profile', 'custody-workers', 'custody-seal-type', 'custody-policy-type', 'schema1', '600-intent', '600-migration',
            'replace-intent', 'replace-migration', 'replace-pg-version', 'tamper-migration', 'later-role',
            'phase', 'initialize-state', 'carrier-started', 'input', 'output', 'socket', 'workspace', 'code', 'source']
        for index, attack in enumerate(attacks):
            identifier = f'a71c77d2-f420-440e-951b-{index:012x}';f.interrupt_initialized(identifier)
            directory = f.manager.directory(identifier);record = f.manager.record(identifier)
            code = f.code / 'core-clean-target-bootstrap-worker.mjs';original_code = code.read_bytes();original_catalog = copy.deepcopy(f.catalog)
            try:
                if attack == 'missing':record.pop('initializedCustody')
                if attack == 'custody-profile':record['initializedCustody']['profile']['major'] = 17
                if attack == 'custody-workers':record['initializedCustody']['initialWorkersSha256'] = '0' * 64
                if attack == 'custody-seal-type':record['initializedCustody']['fileSeals']['root-intent.json'][5] = True
                if attack == 'custody-policy-type':record['initializedCustody']['profile']['activation'] = 0
                if attack == 'schema1':record['schema'] = M.SCHEMA
                if attack == '600-intent':(directory / 'root-intent.json').chmod(0o600)
                if attack == '600-migration':(directory / 'migrations/0000_initial.sql').chmod(0o600)
                if attack.startswith('replace-'):
                    name = {'replace-intent': 'root-intent.json', 'replace-migration': 'migrations/0000_initial.sql', 'replace-pg-version': 'target/pgdata/PG_VERSION'}[attack]
                    path = directory / name;raw = path.read_bytes();path.unlink()
                    if name.startswith('target/pgdata'):f.enrollment.immutable(path, raw)
                    else:f.manager.publish(path, raw)
                if attack == 'tamper-migration':
                    path = directory / 'migrations/0000_initial.sql';path.chmod(0o600);path.write_bytes(b'changed');path.chmod(0o400)
                if attack == 'later-role':record['inspectionWorkers']['database'] = {'intent': 'creating'}
                if attack == 'phase':record['phases'].pop()
                if attack == 'initialize-state':f.runtime.workers[record['inspectionWorkers']['initialize']['id']]['State']['ExitCode'] = 1
                if attack == 'carrier-started':f.runtime.workers[record['inspectionWorkers']['migration-carrier']['id']]['State'].update(Status='running', Running=True)
                if attack in {'input', 'output'}:(directory / attack / 'unexpected').write_bytes(b'partial')
                if attack == 'socket':(directory / 'target/socket/stale').write_bytes(b'partial')
                if attack == 'workspace':record['workspace']['identities']['pgdata'][1] += 1
                if attack == 'code':code.chmod(0o600);code.write_bytes(b'changed');code.chmod(0o400)
                if attack == 'source':f.catalog['catalogSha256'] = '0' * 64
                f.manager.save(record);raw = (directory / 'job.json').read_bytes();seals = self.snapshot(directory);calls = len(f.runtime.calls)
                with self.subTest(attack=attack), self.assertRaises(ValueError):f.manager.continue_initialized(identifier, f.actor, f.continuation_id(index))
                self.assertEqual((directory / 'job.json').read_bytes(), raw);self.assertEqual(self.snapshot(directory), seals)
                self.assertFalse((directory / 'continuations').exists())
                self.assertFalse(any(call[0] in {'create', 'start', 'stop'} for call in f.runtime.calls[calls:]))
            finally:
                f.catalog.clear();f.catalog.update(original_catalog);code.chmod(0o600);code.write_bytes(original_code);code.chmod(0o400)

    def test_capacity_refusal_preserves_whole_failed_namespace(self):
        f = self.fixture;prior = f.interrupt_initialized();directory = f.manager.directory(ID);seals = self.snapshot(directory);calls = len(f.runtime.calls)
        f.manager.capacity.side_effect = M.BootstrapCapacityError('disk', 0, 1024 ** 3)
        with self.assertRaises(M.BootstrapCapacityError):f.manager.continue_initialized(ID, f.actor, f.continuation_id())
        self.assertEqual((directory / 'job.json').read_bytes(), prior);self.assertEqual(self.snapshot(directory), seals)
        self.assertFalse((directory / 'continuations').exists())
        self.assertFalse(any(call[0] in {'create', 'start', 'stop'} for call in f.runtime.calls[calls:]))

    def test_capacity_hook_identical_replacement_or_binding_drift_refuses_before_writes(self):
        f = self.fixture
        for index, attack in enumerate(('replace', 'source')):
            identifier = f'a71c77d2-f420-440e-951b-{index:012x}';prior = f.interrupt_initialized(identifier);directory = f.manager.directory(identifier);calls = len(f.runtime.calls)
            def drift(_directory):
                self.assertGreater(f.guards, 0)
                if attack == 'replace':
                    path = directory / 'migrations/0000_initial.sql';raw = path.read_bytes();path.unlink();f.manager.publish(path, raw)
                else:f.catalog['catalogSha256'] = '0' * 64
            f.manager.capacity.side_effect = drift
            with self.subTest(attack=attack), self.assertRaises(ValueError):f.manager.continue_initialized(identifier, f.actor, f.continuation_id(index))
            self.assertEqual((directory / 'job.json').read_bytes(), prior);self.assertFalse((directory / 'continuations').exists())
            self.assertFalse(any(call[0] in {'create', 'start', 'stop'} for call in f.runtime.calls[calls:]))
            f.manager.capacity.side_effect = None

    def test_partial_copy_or_intent_never_reclaims_or_replays_attempt(self):
        f = self.fixture
        for index, name in enumerate(('0000_initial.sql', 'intent.json')):
            identifier = f'a71c77d2-f420-440e-951b-{index:012x}';prior = f.interrupt_initialized(identifier);directory = f.manager.directory(identifier);publish = f.manager.publish;calls = len(f.runtime.calls)
            def partial(path, body):
                if 'continuations' in path.parts and path.name == name:
                    publish(path, body[:1]);raise OSError('synthetic partial continuation publication')
                return publish(path, body)
            with mock.patch.object(f.manager, 'publish', side_effect=partial), self.subTest(name=name), self.assertRaises(OSError):f.manager.continue_initialized(identifier, f.actor, f.continuation_id(index))
            attempt = directory / 'continuations' / f.continuation_id(index)
            self.assertEqual((directory / 'job.json').read_bytes(), prior)
            self.assertEqual((attempt / 'prior-failure.json').read_bytes(), prior)
            self.assertEqual(next(path for path in attempt.rglob(name)).read_bytes(), b'{' if name == 'intent.json' else b'C')
            with self.assertRaises(ValueError):f.manager.continue_initialized(identifier, f.actor, f.continuation_id(index + 10))
            self.assertFalse(any(call[0] in {'create', 'start', 'stop'} for call in f.runtime.calls[calls:]))

    def test_post_start_failure_retains_owned_database_and_refuses_replay(self):
        f = self.fixture;prior = f.interrupt_initialized();f.manager.capacity.side_effect = [None, None, M.BootstrapCapacityError('disk', 0, 1024 ** 3)];calls = len(f.runtime.calls)
        with self.assertRaises(ValueError):f.manager.continue_initialized(ID, f.actor, f.continuation_id())
        record = f.manager.record(ID);self.assertEqual(record['phase'], 'recovery-required')
        self.assertEqual(set(record['inspectionWorkers']), {'migration-carrier', 'initialize', 'database'})
        self.assertTrue(f.runtime.workers[record['inspectionWorkers']['database']['id']]['State']['Running'])
        self.assertEqual((f.manager.directory(ID) / 'continuations' / f.continuation_id() / 'prior-failure.json').read_bytes(), prior)
        self.assertFalse(any(call[0] == 'stop' for call in f.runtime.calls[calls:]))
        f.manager.capacity.side_effect = None;calls = len(f.runtime.calls)
        with self.assertRaises(ValueError):f.manager.continue_initialized(ID, f.actor, f.continuation_id(1))
        self.assertFalse(any(call[0] in {'create', 'start', 'stop'} for call in f.runtime.calls[calls:]))

    def test_checked_v2_intent_profile_seals_and_custody_are_immutable(self):
        f = self.fixture
        for index, attack in enumerate(('schema', 'profile', 'replacement', 'custody')):
            identifier = f'a71c77d2-f420-440e-951b-{index:012x}';f.interrupt_initialized(identifier);handle = f.manager.continue_initialized(identifier, f.actor, f.continuation_id(index))
            directory = f.manager.directory(identifier);path = directory / 'continuations' / f.continuation_id(index) / 'intent.json';raw = path.read_bytes()
            if attack == 'replacement':path.unlink();f.manager.publish(path, raw)
            elif attack == 'custody':
                record = f.manager.record(identifier);record['initializedCustody']['executionProfile'] = 'pg17-alpine-arm64.v1';f.manager.save(record)
            else:
                value = json.loads(raw);value['schema' if attack == 'schema' else 'executionProfile'] = 'orbis.core-clean-target-initialized-continuation.v1' if attack == 'schema' else 'pg17-alpine-arm64.v1'
                path.chmod(0o600);path.write_bytes(Publication.canonical(value));path.chmod(0o400)
            with self.subTest(attack=attack), self.assertRaises(ValueError):f.manager.checked(handle, f.actor)

    def test_whole_guard_covers_custody_rechecks_and_new_worker_admission(self):
        f = self.fixture;f.interrupt_initialized();reader=f.manager.approval.catalog_reader;engine=f.runtime.engine
        def current():self.assertGreater(f.guards, 0);return reader()
        def create(*args):self.assertGreater(f.guards, 0);return engine(*args)
        approval=f.manager.approval
        f.manager.approval=M.RootBootstrapApproval(approval.configuration_binding,approval.profile,approval.source_catalog,
            approval.migration_inventory,approval.migration_graph,current,f.guard)
        with mock.patch.object(f.runtime,'engine',side_effect=create):
            handle=f.manager.continue_initialized(ID,f.actor,f.continuation_id());self.assertEqual(f.manager.checked(handle,f.actor),handle)
        self.assertEqual(f.guards,0)

    def test_strict_authority_never_traverses_postgres_owned_or0550_children(self):
        f = self.fixture;protected = f.manager.a.protected_directory;seen = []
        @contextlib.contextmanager
        def strict(directory):
            seen.append(str(directory))
            if directory.name in {'pgdata', 'config'}:raise ValueError('Root authority rejects nonprivate or postgres-owned leaf')
            with protected(directory) as descriptor:yield descriptor
        with mock.patch.object(f.manager.a, 'protected_directory', side_effect=strict):
            f.interrupt_initialized()
            handle = f.manager.continue_initialized(ID, f.actor, f.continuation_id())
            self.assertEqual(f.manager.checked(handle, f.actor), handle)
        self.assertTrue(any(path.endswith('/target') for path in seen))
        self.assertFalse(any(path.endswith('/pgdata') or path.endswith('/config') for path in seen))

    def test_fd_child_validation_requires_original_identity_and_actual_profile_owner_mode(self):
        f = self.fixture;check = M.CoreVersionedCleanTargetBootstrap.validate_initialized_child
        for major in (14, 17):
            if major == 17:self.versioned.configure(17)
            profile = f.profile
            for child in ('pgdata', 'config'):
                mode = stat.S_IFDIR | (0o700 if child == 'pgdata' else 0o550)
                uid = profile['uid'] if child == 'pgdata' else 0
                fields = {'st_dev': 1, 'st_ino': 2, 'st_mode': mode, 'st_uid': uid, 'st_gid': profile['gid']}
                details = SimpleNamespace(**fields);identity = M.TARGET.directory_identity(details)
                record = {'workspace': {'identities': {child: identity}}}
                check(f.manager, record, child, details)
                for key, value in [('st_uid', uid + 1), ('st_gid', profile['gid'] + 1), ('st_mode', stat.S_IFDIR | 0o770)]:
                    changed = SimpleNamespace(**(fields | {key: value}))
                    # Matching recorded identity cannot substitute a wrong native owner/group/mode.
                    record['workspace']['identities'][child] = M.TARGET.directory_identity(changed)
                    with self.subTest(major=major, child=child, key=key), self.assertRaises(ValueError):check(f.manager, record, child, changed)
                record['workspace']['identities'][child] = identity[:-1] + [profile['gid'] + 1]
                with self.assertRaises(ValueError):check(f.manager, record, child, details)

    def test_custody_commit_ambiguity_remains_missing_and_never_reconstructed(self):
        f = self.fixture;save=f.manager.save;failed=False
        def ambiguous(record):
            nonlocal failed
            if 'initializedCustody' in record and not failed:
                failed=True;save(record);raise OSError('synthetic ambiguous custody commit')
            return save(record)
        with mock.patch.object(f.manager,'save',side_effect=ambiguous),self.assertRaises(ValueError):f.prepare()
        record=f.manager.record(ID);self.assertNotIn('initializedCustody',record);self.assertEqual(record['phase'],'recovery-required')
        before=(f.manager.directory(ID)/'job.json').read_bytes();calls=len(f.runtime.calls)
        with self.assertRaises(ValueError):f.manager.continue_initialized(ID,f.actor,f.continuation_id())
        self.assertEqual((f.manager.directory(ID)/'job.json').read_bytes(),before)
        self.assertFalse(any(call[0] in {'create','start','stop'} for call in f.runtime.calls[calls:]))


if __name__ == '__main__':
    unittest.main()
