"""Real protected stage files/SQL command construction; Docker and SQL are fixtures."""
import copy
from contextlib import contextmanager
import hashlib
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


M = load('orbis-host-core-restoration.py', 'core_logical_stage_test')
V = load('orbis-host-core-restoration-review.py', 'core_logical_stage_review_fixture')
C = load('orbis-host-core-reconciliation-service.py', 'core_logical_stage_reconciliation_fixture')
A = load('orbis-host-retained-authority.py', 'core_logical_stage_authority_fixture')
ID = 'ad845c50-fc86-4d74-8712-840eac4fc2e8'
REVIEW = '6af11531-ea76-468d-a641-8ed6bd14c8ea'
RECONCILIATION = 'a71c77d2-f420-440e-951b-083209514e72'
ACTOR = {'ownerId': 1, 'sessionBinding': 'a' * 64, 'securityBinding': 'b' * 64}


class Engine:
    def __init__(self, test):
        self.test, self.workers, self.events, self.database = test, {}, [], None
        self.lost_create, self.bad_marker, self.bad_import, self.bad_verify = False, False, False, False
        self.wrong_network = False
        self.live = {'Id': '1' * 64, 'Name': '/runtipi-db', 'Image': C.R.SOURCE.PG.PG17_ARM64_IMAGE,
            'Config': {'Env': ['POSTGRES_USER=tipi', 'POSTGRES_PASSWORD=private:fixture\\only'], 'Labels': {
                'com.docker.compose.service': 'runtipi-db', 'com.docker.compose.project.working_dir': str(test.root)}},
            'State': {'Running': True, 'Restarting': False, 'Paused': False, 'StartedAt': 'current-db-start'},
            'NetworkSettings': {'Networks': {'installed-core': {'NetworkID': '2' * 64, 'IPAddress': '192.0.2.20'}}}}
        self.server = {'systemIdentifier': '123456789', 'role': 'tipi', 'serverVersionNum': 170005, 'postmasterEpochUs': 1700000000000000}

    def image(self, identifier):
        return {'Id': identifier, 'Os': 'linux', 'Architecture': 'arm64', 'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}}

    def inspect(self, identifier):
        return copy.deepcopy(self.live if identifier in {'runtipi-db', self.live['Id']} else self.workers[identifier])

    def definition(self, raw):
        value = raw.get('body') or {key: value for key, value in raw.items() if key != 'State'}
        return hashlib.sha256(self.test.P.canonical(value)).hexdigest()

    def check_intent(self, raw, body):
        self.test.assertEqual(raw['body'], body)

    def never_started(self, raw):
        return raw['State']['Status'] == 'created'

    def engine(self, method, route, body):
        self.test.assertEqual(method, 'POST')
        identifier = str(len(self.workers) + 10).zfill(64)
        name = route.split('=', 1)[1]
        role = body['Labels'].get('io.orbis.core-logical.role', 'database')
        self.workers[identifier] = {'Id': identifier, 'Name': '/' + name, 'Image': body['Image'], 'body': copy.deepcopy(body),
            'State': {'Status': 'created', 'Running': False, 'Restarting': False, 'Paused': False, 'Dead': False,
                      'OOMKilled': False, 'ExitCode': 0, 'FinishedAt': '0001-01-01T00:00:00Z'}, 'role': role,
            'NetworkSettings': {'Networks': {name: {'NetworkID': ('f' if self.wrong_network else '2') * 64}
                for name in body['NetworkingConfig']['EndpointsConfig']}}}
        self.events.append(('create', role))
        return self.test.P.canonical({'Id': identifier})

    def change(self, command):
        self.events.append(('change', tuple(command)))
        row = self.workers[command[-1]]
        if command[0] == 'stop':
            row['State'].update(Status='exited', Running=False, FinishedAt='2026-11-12T12:00:00Z')
            return
        self.test.assertEqual(command[0], 'start')
        row['State'].update(Status='running', Running=True)
        role = row['role']
        if role == 'dump':
            output = next(Path(mount['Source']) for mount in row['body']['HostConfig']['Mounts'] if mount['Target'] == '/core-dump')
            (output / 'target.dump').write_bytes(b'PGDMPgenuine-command-boundary-fixture')
            (output / 'target.dump').chmod(0o600)
        if role == 'verify-imported':
            stage = self.test.manager.read(ID)
            result = {**self.test.manager.binding_for(stage), 'schema': M.VERIFIED, 'logicalTargetVerified': True,
                      'environmentProved': False, 'restoreAuthority': False, 'activation': False}
            if self.bad_verify:
                result['database']['databaseOid'] = str(int(result['database']['databaseOid']) + 1)
            (self.test.manager._directory(ID) / 'verification/result.json').write_bytes(self.test.P.canonical(result))
            (self.test.manager._directory(ID) / 'verification/result.json').chmod(0o600)
        if role != 'database':
            row['State'].update(Status='exited', Running=False, FinishedAt='2026-11-12T12:00:00Z',
                                ExitCode=1 if role == 'import' and self.bad_import else 0)

    def bounded_output(self, command, maximum, timeout):
        self.events.append(('read', tuple(command)))
        if 'wait' in command:
            return str(self.workers[command[-1]]['State']['ExitCode']).encode() + b'\n'
        sql = command[-1]
        if 'pg_control_system' in sql:
            value = self.server
        elif "SELECT json_build_object('value'" in sql:
            value = {'value': copy.deepcopy(self.database)}
        elif sql.startswith('CREATE DATABASE'):
            self.test.assertIsNone(self.database)
            self.database = {'databaseOid': 17001, 'database': 'orbis_restore_' + ID.replace('-', ''),
                             'owner': 'tipi', 'marker': None, 'allowConnections': True, 'locale': copy.deepcopy(self.test.profile['locale'])}
            if self.lost_create:
                raise OSError('synthetic lost CREATE acknowledgement')
            return b''
        elif sql.startswith('COMMENT ON DATABASE'):
            self.database['marker'] = sql.split(" IS '", 1)[1][:-1]
            if self.bad_marker:
                self.database['marker'] = 'foreign marker'
            return b''
        else:
            raise AssertionError('unexpected SQL command')
        return self.test.P.canonical(value)


class LogicalStageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='core-logical-stage-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve();self.root.chmod(0o700)
        self.enterContext(mock.patch.object(A, 'OWNER', os.geteuid()))
        self.P = A.P
        self.enrollment = object.__new__(C.P.F.L.BASE.E.CorePortableEnrollment)
        self.enrollment.root = self.enrollment.state = self.root
        self.enrollment.context, self.enrollment.a, self.enrollment.P = 'fixture', A, self.P
        self.runtime = Engine(self);self.enrollment.runtime = self.runtime
        self.target = self.enrollment.child(self.root, 'isolated-target')
        for name in ('pgdata', 'socket', 'config'):
            self.enrollment.child(self.target, name)
        self.socket = self.target / 'socket/.s.PGSQL.5432'
        self.socket.write_bytes(b'fixed socket syscall fixture')
        self.profile = C.R.TARGET.bounded_clean_target_profile(self.runtime.image(C.R.SOURCE.PG.PG17_ARM64_IMAGE),
            'source_role', 'source_database', {'encoding': 'UTF8', 'collate': 'C', 'ctype': 'C', 'provider': 'c'})
        self.code = self.enrollment.child(self.root, 'installed-code')
        self.enrollment.immutable(self.code / 'core-restoration-worker.mjs', b'fixture installed verifier entry')
        self.inventory = {'core-restoration-worker.mjs': {'bytes': 33, 'sha256': 'd' * 64}}
        self.broker = SimpleNamespace(trust=SimpleNamespace(image_id='sha256:'+'3'*64, source_controller_image_id='sha256:'+'4'*64,
            code_directory=self.code), code=lambda: copy.deepcopy(self.inventory))
        source_dir = self.enrollment.child(self.root, 'source-inspection')
        execution = self.enrollment.child(source_dir, 'execution')
        trusted = self.enrollment.child(execution, 'trusted-input')
        self.enrollment.immutable(trusted / 'source-authentication.json', self.P.canonical({'jwtSecret': 'private source jwt '*4, 'passkeys': None}))
        self.prepared = {'schema': 'orbis.core-clean-target-reconciliation.v2', 'id': RECONCILIATION,
                         'authenticationSha256': 'e'*64, 'restoreAuthority': False}
        source = SimpleNamespace(approved={'target': {'directory': str(self.target), 'profile': self.profile,
            'workspace': {'allocation': {}, 'identities': {}}}}, broker=self.broker, record=lambda identifier: {'prepared': copy.deepcopy(self.prepared)},
            approval=SimpleNamespace(source_inspection=SimpleNamespace(directory=lambda identifier: source_dir), source_identifier=RECONCILIATION))
        self.service = SimpleNamespace()
        review = object.__new__(V.CoreRestorationReview)
        review.service, review.enrollment, review.P, review.C = self.service, self.enrollment, self.P, C
        review._graph = lambda: self.runtime
        review.reconciliations = SimpleNamespace(_identifier=lambda value: C.require(isinstance(value,str) and C.P.F.L.BASE.E.UUID.fullmatch(value)))
        reconciliation = SimpleNamespace(manager=source, admission={'id': RECONCILIATION},
            prepared_target=SimpleNamespace(receipt_sha256='a'*64), intent={'installedRuntime': {'id': RECONCILIATION,
            'installationSha256':'b'*64,'sourceControllerImageId':'sha256:'+'4'*64},'migrationPolicySha256':'c'*64})
        self.active = False
        @contextmanager
        def guard():
            C.require(self.active)
            yield
            C.require(self.active)
        @contextmanager
        def checked(identifier, actor):
            self.assertEqual(identifier,REVIEW);self.assertEqual(actor,ACTOR)
            self.active=True
            try:
                yield V.CheckedRestorationReview(review,reconciliation,{'snapshot': {'container': {'NetworkSettings': {'Networks': {'installed-core': {}}}}}},guard)
            finally:self.active=False
        review._checked_review=checked
        self.service.core_restoration_reviews=lambda:review
        self.service.core_restoration_review_module=V
        self.manager=M.CoreDerivedLogicalStage(self.service)
        self.enterContext(mock.patch.object(self.manager.TARGET,'database_body',return_value=self.manager._body(
            {'id':ID,'nonce':'nonce'},'database',self.profile['imageId'],'postgres',[],[],network='none')))
        original=Path.lstat
        def lstat(path,*args,**kwargs):
            if path==self.socket:return SimpleNamespace(st_mode=stat.S_IFSOCK|0o770,st_uid=self.profile['uid'])
            return original(path,*args,**kwargs)
        self.enterContext(mock.patch.object(Path,'lstat',lstat))

    def stage(self):
        return self.manager.prepare(ID,REVIEW,ACTOR)

    def test_actual_export_mark_import_and_typed_verification_keep_original_untouched(self):
        binding=self.stage()
        self.assertEqual(binding['schema'],M.BINDING)
        self.assertEqual(binding['database']['databaseOid'],'17001')
        self.assertIs(type(binding['database']['databaseOid']),str)
        self.assertEqual(binding['database']['database'],'orbis_restore_'+ID.replace('-',''))
        record=self.manager.read(ID)
        self.assertEqual(record['phase'],'awaiting-verification')
        self.assertEqual(record['databaseMarker'],'orbis.core-derived-logical.v1/'+ID+'/'+record['nonce']+'/'+record['stageSha256'])
        self.assertEqual(record['dump'],self.manager._seal_dump(self.manager._directory(ID)/'dump/target.dump'))
        self.assertFalse(record['liveDestinationProved']);self.assertFalse(record['activation']);self.assertFalse(record['restoreAuthority'])
        result=self.manager.verify_imported(ID)
        self.assertIs(type(result),M.ImportedCoreStage)
        self.assertEqual(self.manager.read(ID)['phase'],'staged')
        commands=[event[1] for event in self.runtime.events if event[0]=='read']
        self.assertFalse(any('DROP DATABASE' in command[-1] or 'ALTER DATABASE' in command[-1] for command in commands))
        self.assertNotIn('private:fixture',json.dumps(record))
        role_rows=self.manager.read(ID)['workers']
        for role in ('dump','import','verify-imported'):
            self.assertEqual(role_rows[role]['intent'],'complete')
        self.assertEqual(role_rows['database']['intent'],'complete')
        self.assertEqual(role_rows['dump']['body']['User'],'0:70')

    def test_create_intent_precedes_create_and_lost_response_never_adopts_database(self):
        self.runtime.lost_create=True
        with self.assertRaises(OSError):self.stage()
        record=self.manager.read(ID)
        self.assertEqual(record['phase'],'recovery-required')
        self.assertIsNone(self.runtime.database['marker'])
        before=len(self.runtime.events)
        with self.assertRaises(ValueError):self.stage()
        self.assertEqual(len(self.runtime.events),before)
        with self.assertRaises(ValueError):self.manager.binding(ID)

    def test_preexisting_or_foreign_marked_database_is_never_changed_or_deleted(self):
        self.runtime.database={'databaseOid':1,'database':'orbis_restore_'+ID.replace('-',''),'owner':'tipi','marker':'foreign','allowConnections':True,'locale':copy.deepcopy(self.profile['locale'])}
        before=copy.deepcopy(self.runtime.database)
        with self.assertRaises(ValueError):self.stage()
        self.assertEqual(self.runtime.database,before)
        self.assertFalse(any(event[0]=='read' and event[1][-1].startswith('COMMENT ON') for event in self.runtime.events))

    def test_unconfirmed_import_and_wrong_verifier_identity_remain_holds(self):
        self.runtime.bad_import=True
        with self.assertRaises(ValueError):self.stage()
        self.assertEqual(self.manager.read(ID)['phase'],'recovery-required')
        self.assertIsNotNone(self.runtime.database)

    def test_wrong_verified_oid_never_publishes_stage_receipt(self):
        self.stage();self.runtime.bad_verify=True
        with self.assertRaises(ValueError):self.manager.verify_imported(ID)
        self.assertFalse((self.manager._directory(ID)/'verification-receipt.json').exists())
        self.assertEqual(self.manager.read(ID)['phase'],'recovery-required')

    def test_missing_installed_entry_does_not_fabricate_verification(self):
        self.stage();self.inventory.clear()
        with self.assertRaises(ValueError):self.manager.verify_imported(ID)
        self.assertEqual(self.manager.read(ID)['phase'],'awaiting-verification')
        self.assertNotIn('verify-imported',self.manager.read(ID)['workers'])

    def test_missing_entry_before_preparation_refuses_without_stage_or_native_commands(self):
        self.inventory.clear()
        with self.assertRaises(ValueError):self.stage()
        self.assertFalse(self.manager._directory(ID).parent.exists())
        self.assertEqual(self.runtime.events,[])
        self.assertIsNone(self.runtime.database)

    def test_database_oid_owner_marker_server_epoch_and_dump_drift_refuse(self):
        self.stage()
        self.runtime.server['postmasterEpochUs']+=1
        with self.assertRaises(ValueError):self.manager.binding(ID)
        self.runtime.server['postmasterEpochUs']-=1
        self.runtime.database['databaseOid']+=1
        with self.assertRaises(ValueError):self.manager.binding(ID)
        self.runtime.database['databaseOid']-=1
        path=self.manager._directory(ID)/'dump/target.dump';path.write_bytes(b'PGDMPchanged')
        record=self.manager.read(ID)
        with self.assertRaises(ValueError):self.manager._import(record)

    def test_identifier_actor_and_plain_dict_are_not_root_review_authority(self):
        with self.assertRaises(ValueError):self.manager.prepare('../escape',REVIEW,ACTOR)
        with self.assertRaises(AssertionError):self.manager.prepare(ID,REVIEW,{**ACTOR,'ownerId':2})
        self.assertFalse(self.manager._directory(ID).exists())
        self.service.core_restoration_reviews=lambda:True
        with self.assertRaises((ValueError,AttributeError)):M.CoreDerivedLogicalStage(self.service)

    def test_pgpass_is_private_readonly_and_password_never_enters_command_arguments(self):
        self.stage()
        file=self.manager._directory(ID)/'private/pgpass'
        self.assertEqual(stat.S_IMODE(file.stat().st_mode),0o600)
        self.assertIn('private\\:fixture\\\\only',file.read_text())
        for event in self.runtime.events:
            self.assertNotIn('private:fixture',repr(event))
        imported=self.manager.read(ID)['workers']['import']['body']
        self.assertTrue(all(row['ReadOnly'] is True for row in imported['HostConfig']['Mounts']))
        self.assertEqual(imported['Env'][0],'PGPASSFILE=/core-private/pgpass')
        self.assertIn('--no-comments',imported['Cmd'])
        for role in ('dump', 'import'):
            body = self.manager.read(ID)['workers'][role]['body']
            masks = [row for row in body['HostConfig']['Mounts'] if row['Target'] == '/var/lib/postgresql/data']
            self.assertEqual(len(masks), 1)
            self.assertTrue(masks[0]['ReadOnly'])
            self.assertEqual(masks[0]['Source'], str(self.manager._directory(ID) / 'tool-data'))

    def test_explicit_locale_provider_is_owned_and_rechecked_after_import(self):
        self.stage()
        queries=[event[1][-1] for event in self.runtime.events if event[0]=='read']
        create=next(query for query in queries if query.startswith('CREATE DATABASE'))
        self.assertIn("ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' LOCALE_PROVIDER libc",create)
        descriptor=json.loads((self.manager._directory(ID)/'descriptor.json').read_bytes())
        self.assertEqual(descriptor['targetProfile']['locale'],self.profile['locale'])
        self.assertEqual(descriptor['network'], {'name': 'installed-core', 'id': '2' * 64, 'address': '192.0.2.20'})
        self.runtime.database['locale']['collate']='POSIX'
        with self.assertRaises(ValueError):self.manager.binding(ID)

    def test_replaced_network_and_nonarchive_dump_never_receive_import_authority(self):
        self.runtime.wrong_network=True
        with self.assertRaises(ValueError):self.stage()
        self.assertEqual(self.manager.read(ID)['phase'],'recovery-required')
        path=self.manager._directory(ID)/'dump/target.dump'
        path.write_bytes(b'not a PostgreSQL custom archive')
        with self.assertRaises(ValueError):self.manager._seal_dump(path)

    def test_new_id_cannot_take_over_an_unverified_or_unknown_prior_stage(self):
        self.stage()
        before=len(self.runtime.events)
        other='ad845c50-fc86-4d74-8712-840eac4fc2e9'
        with self.assertRaises(ValueError):self.manager.prepare(other,REVIEW,ACTOR)
        self.assertEqual(len(self.runtime.events),before)
        self.assertFalse(self.manager._directory(other).exists())

    def test_fixed_dump_restore_tools_are_closed_to_pinned_profiles(self):
        self.assertEqual(C.R.SOURCE.PG.binary_for(self.profile,'pg_dump'),'/usr/local/bin/pg_dump')
        other=C.R.SOURCE.PG.execution_image_profile({'Id':C.R.SOURCE.PG.PG14_AMD64_IMAGE,'Os':'linux','Architecture':'amd64',
            'Config':{'Volumes':{'/var/lib/postgresql/data':{}}}})
        self.assertEqual(C.R.SOURCE.PG.binary_for(other,'pg_restore'),'/usr/lib/postgresql/14/bin/pg_restore')
        with self.assertRaises(ValueError):C.R.SOURCE.PG.binary_for(self.profile,'sh')


if __name__=='__main__':unittest.main()
