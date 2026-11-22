import copy
from contextlib import closing, contextmanager
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
from types import SimpleNamespace
import unittest
from unittest import mock

import test_orbis_host_fresh_ownership as fixtures

M, TX = fixtures.M, fixtures.TX


def load(name):
    spec = importlib.util.spec_from_file_location('cutover_' + name, Path(__file__).with_name(name + '.py'))
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result


class CutoverBirthTests(unittest.TestCase):
    """Actual validators, backup fingerprint, reset IO and birth publication.

    Docker, publisher and SQL execution are explicit synthetic fixture ports.
    This is not Linux/native migration or human Root approval acceptance.
    """
    def setUp(self):
        self.b = fixtures.FreshPermitTests('test_pending_permit_blocks_ordinary_credential_and_lifecycle_paths')
        self.addCleanup(self.b.doCleanups); self.b.setUp()
        self.f, self.root, self.reader, self.host = self.b.f, self.b.root, self.b.reader, self.b.host
        self.r = load('orbis-install-replace')
        compose = mock.patch.object(self.r.FRESH, 'compose_intent')
        compose.start(); self.addCleanup(compose.stop)
        self.host.file_digest = self.r.HOST.file_digest
        self.r.HOST = self.host
        self.host.STAGE = load('orbis-stage-release')
        self.host.PLAN.INSTALLATION_PROTOCOL = 'orbis.installation-state.v1'
        self.issuer = M.Issuer(self.host, self.root, self.reader, self.r.validate_review)
        self.issuer.attach_replacement(self.r)
        self.private = self.f.folder / 'private'; self.private.mkdir(mode=0o700)
        self.journal = self.private / 'transaction.json'; self.bundle = self.private / 'backup'
        self.bundle.mkdir(mode=0o700)
        self.env_key = ''.join(('JWT', '_SECRET'))
        (self.root / '.env').write_text(self.env_key + '=original-fixture-key\nSERVER_NAME=fixture\n')
        self.f.raw['Config']['Env'].append(self.env_key + '=original-fixture-key')
        self.f.raw['NetworkSettings'] = {'Networks': {}}
        self.raws = {self.f.raw['Id']: self.f.raw}
        self.roles = {self.f.raw['Id']: 'controller'}
        for char, role, name in (('6', 'database', 'runtipi-db'), ('7', 'queue', 'runtipi-queue'), ('8', 'proxy', 'runtipi-reverse-proxy')):
            self.roles[char * 64] = role
            self.raws[char * 64] = {'Id': char * 64, 'Name': '/' + name, 'Image': 'sha256:' + 'b' * 64,
                'Config': {'Image': 'fixture/service:1', 'Labels': {'com.docker.compose.project': 'runtipi'}},
                'Mounts': [], 'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0}},
                'State': {'Status': 'running', 'Running': True, 'Pid': 42}}
        self.accounts = {'users': 2, 'links': 3, 'references': ['link'], 'customTriggers': 0, 'descendants': 0,
                         'apps': 'a' * 64, 'stores': 'b' * 64}
        self.incoming = {'Env': [], 'Labels': {'org.opencontainers.image.version': self.f.manifest['tag']}}
        self.reader.containers.side_effect = lambda: [{'id': raw['Id'], 'name': raw['Name'].removeprefix('/')} for raw in self.raws.values()]
        self.reader._object.side_effect = self.inspect
        self.reader.app = self.app
        self.reader._read = self.read
        self.sql_calls = 0
        self.record = None

    def inspect(self, args):
        if args[:2] == ['image', 'inspect']:
            return {} if args[-1] == self.f.raw['Image'] else copy.deepcopy(self.incoming)
        return copy.deepcopy(self.raws[args[-1]])

    def app(self, identifier):
        raw = self.raws[identifier]
        return {'id': identifier, 'name': raw['Name'], 'image': raw['Config']['Image'], 'imageId': raw['Image'],
                'labels': raw['Config']['Labels'], 'mounts': raw['Mounts'], 'state': raw['State']['Status'],
                'restartPolicy': raw['HostConfig']['RestartPolicy'], 'autoRemove': False, 'stopTimeout': 10}

    def read(self, args):
        if 'psql' in args: return json.dumps(self.accounts)
        if 'curl' in args: return json.dumps({'schema': self.host.PLAN.INSTALLATION_PROTOCOL, 'phase': 'hold', 'transactionId': TX})
        raise AssertionError('Unexpected Docker observation')

    def save(self):
        self.r.APPS.write_journal(self.journal, self.record)

    def reviewed(self):
        with mock.patch.object(self.r.FRESH, 'compose_intent'):
            fresh = self.r.FRESH.review(self.root, self.reader, self.f.raw, '6' * 64)
        self.f.authorization_fixture()
        with M.L.authorized(self.host, self.root, self.reader, self.f.manifest) as proof:
            decision = proof.verify()
        storage = {'schema': self.r.TX.STORAGE.SCHEMA, 'root': str(self.root), 'dockerContext': self.reader.context,
                   'daemonFingerprint': self.r.APPS.digest_daemon(self.reader), 'bundle': str(self.bundle),
                   'resources': [self.r.TX.STORAGE.source_identity(self.root / '.env')],
                   'containers': [{'id': key} for key in self.roles], 'containerStates': []}
        for key in self.roles:
            entry, _ = self.r.TX.STORAGE.container_record(self.reader, {'id': key, 'name': self.raws[key]['Name'].removeprefix('/')})
            storage['containerStates'].append(entry)
        storage['identityHash'] = self.r.APPS.digest({key: storage[key] for key in ('root', 'dockerContext', 'daemonFingerprint', 'bundle', 'resources', 'containers')})
        storage['reviewId'] = self.r.APPS.digest(storage)
        checkpoint = {'schema': self.r.TX.SCHEMA, 'root': str(self.root), 'dockerContext': self.reader.context,
                      'journal': str(self.journal) + '.checkpoint.json', 'storage': storage, 'roles': self.roles}
        checkpoint['reviewId'] = self.r.APPS.digest(checkpoint)
        ledger = [{'createdAt': 1, 'hash': 'f' * 64}]
        review = {'schema': self.r.SCHEMA, 'mode': 'fresh', 'root': str(self.root), 'dockerContext': self.reader.context,
                  'journal': str(self.journal), 'target': self.f.manifest, 'checkpoint': checkpoint,
                  'image': {'imageId': 'sha256:' + 'e' * 64, 'ledger': ledger}, 'database': {'ledger': ledger},
                  'controllerName': 'runtipi', 'files': self.r.files(self.root), 'fresh': fresh, 'freshOwnership': decision}
        review['reviewId'] = self.r.APPS.digest(review)
        self.r.validate_review(review)
        return review

    def checkpoint(self, value, permit):
        for raw in self.raws.values():
            raw['State'].update(Status='exited', Running=False, Pid=0, Paused=False, Restarting=False, Dead=False)
            raw['HostConfig']['RestartPolicy'] = dict(M.NO_RESTART)
        copied = self.bundle / 'resource-0000'; shutil.copy2(self.root / '.env', copied)
        manifest = {'schema': self.r.TX.STORAGE.SCHEMA, 'stage': 'complete', 'plan': value['checkpoint']['storage'],
                    'copies': [{'index': 0, 'kind': 'file', 'record': self.r.TX.STORAGE.file_fingerprint(copied)}]}
        self.r.APPS.write_journal(self.bundle / 'storage.json', manifest)
        self.r.APPS.write_journal(Path(value['checkpoint']['journal']), {'schema': self.r.TX.SCHEMA, 'id': TX,
            'stage': 'ready', 'review': value['checkpoint'], 'backupFingerprint': self.r.APPS.digest(manifest)})
        self.record = {'schema': self.r.SCHEMA, 'id': TX, 'stage': 'checkpointed', 'review': value,
                       'retainedName': 'orbis-previous-' + TX, 'ownershipPermit': permit.reference,
                       'quiescedConfiguration': self.r.APPS.digest({key: self.f.raw[key] for key in ('Config', 'HostConfig')})}
        self.save()

    def staged(self):
        self.f.raw['Name'] = '/orbis-previous-' + TX
        (self.root / 'orbis-compose.yml').write_text(self.host.STAGE.staged_content(self.f.manifest))
        (self.root / 'orbis-compose.yml').chmod(0o644)
        for identifier, role in self.roles.items():
            if role in ('database', 'queue'): self.raws[identifier]['State'].update(Status='running', Running=True, Pid=43)
        self.record.update(stage='holding', candidatePhase='hold', networks={})
        body = self.r.payload(self.record, self.reader, 'hold')
        raw = {'Id': '9' * 64, 'Image': self.record['review']['image']['imageId'], 'Name': '/runtipi',
               'Config': {key: item for key, item in body.items() if key not in ('HostConfig', 'NetworkingConfig')},
               'HostConfig': body['HostConfig'], 'NetworkSettings': {'Networks': {}}, 'Mounts': [],
               'State': {'Status': 'running', 'Health': {'Status': 'healthy'}}}
        self.raws[raw['Id']] = raw
        self.record['candidate'] = {'id': raw['Id'], 'definition': self.r.candidate_definition(raw), 'validated': True}
        self.save()

    def remove_hold(self):
        self.raws.pop('9' * 64); self.record.pop('candidate'); self.record.update(stage='resetting'); self.save()

    def sql(self, args, **kwargs):
        self.assertEqual(args[:4], ['docker', '--context', self.reader.context, 'exec'])
        self.assertEqual(args[4], '6' * 64)
        self.sql_calls += 1; self.accounts.update(users=0, links=0)
        return SimpleNamespace(returncode=0)

    @contextmanager
    def prepared(self):
        with self.b.guarded() as guard:
            value = self.reviewed()
            with self.issuer.begin(guard, value, TX) as permit:
                self.checkpoint(value, permit)
                yield guard, permit

    def reset_ready(self, permit):
        permit.record_cutover(self.record); self.staged(); permit.record_hold(self.record); self.remove_hold()

    def test_full_real_snapshot_reset_and_birth_keep_fence_and_match_target(self):
        with self.prepared() as (guard, permit):
            self.reset_ready(permit)
            with mock.patch.object(self.r.FRESH.subprocess, 'run', side_effect=self.sql):
                result = permit.reset_accounts(self.record)
            self.assertEqual(self.sql_calls, 1)
            self.assertEqual(permit.reset_result(self.record), result)
            birth = permit.publish_birth(self.record)
            self.assertEqual(permit.publish_birth(self.record), birth)
            body = M.L.C.json_body(M.L.B.receipt_path(self.root).read_bytes())
            self.assertEqual(body['initialPublication']['manifestSha256'], M.L.K.digest(self.f.manifest))
            self.assertEqual(body['installationId'], self.record['review']['freshOwnership']['installationId'])
            self.assertEqual(guard.read()['operationId'], permit.reference['operationId'])
            self.assertFalse(M.L.B.pending_path(self.root).exists())

    def test_cutover_rejects_running_writers_or_corrupt_backup_before_receipt(self):
        with self.prepared() as (guard, permit):
            self.raws['8' * 64]['State']['Status'] = 'running'
            with self.assertRaises(ValueError): permit.record_cutover(self.record)
            self.raws['8' * 64]['State']['Status'] = 'exited'
            (self.bundle / 'resource-0000').write_bytes(b'changed fixture')
            with self.assertRaises(ValueError): permit.record_cutover(self.record)
            self.assertFalse(M.phase_path(self.root, permit.reference['operationId'], 'cutover').exists())
            self.assertIsNotNone(guard.read())

    def test_missing_hold_or_published_hold_cannot_reset_accounts(self):
        with self.prepared() as (guard, permit):
            permit.record_cutover(self.record); self.staged()
            with self.assertRaises(FileNotFoundError): permit.reset_accounts(self.record)
            self.raws['9' * 64]['HostConfig']['PortBindings'] = {'3000/tcp': [{'HostPort': '3000'}]}
            with self.assertRaises(ValueError): permit.record_hold(self.record)
            self.assertEqual(self.sql_calls, 0); self.assertIsNotNone(guard.read())

    def test_nonempty_cache_or_regained_account_cannot_publish_birth(self):
        with self.prepared() as (guard, permit):
            self.reset_ready(permit)
            with mock.patch.object(self.r.FRESH.subprocess, 'run', side_effect=self.sql): permit.reset_accounts(self.record)
            self.accounts['users'] = 1
            with self.assertRaises(ValueError): permit.publish_birth(self.record)
            self.assertFalse(M.L.B.receipt_path(self.root).exists()); self.assertIsNotNone(guard.read())

    def test_lost_reset_reply_reuses_receipt_without_second_sql_and_extra_keys_fail(self):
        with self.prepared() as (guard, permit):
            self.reset_ready(permit)
            with mock.patch.object(self.r.FRESH.subprocess, 'run', side_effect=self.sql):
                result = permit.reset_accounts(self.record)
                with self.assertRaises(ValueError): permit.reset_accounts(self.record)
            self.assertEqual(self.sql_calls, 1); self.assertEqual(permit.reset_result(self.record), result)
            path = M.phase_path(self.root, permit.reference['operationId'], 'reset')
            body = M.L.C.json_body(path.read_bytes()); body['unrecognized'] = True
            path.write_bytes(M.L.K.canonical(body) + b'\n')
            with self.assertRaises(ValueError): permit.publish_birth(self.record)
            self.assertIsNotNone(guard.read())

    def test_real_cache_contents_block_birth_without_clearing_or_repairing(self):
        with self.prepared() as (guard, permit):
            self.reset_ready(permit)
            with mock.patch.object(self.r.FRESH.subprocess, 'run', side_effect=self.sql): permit.reset_accounts(self.record)
            path = self.root / 'cache/cache.sqlite'
            with closing(sqlite3.connect(path)) as db, db:
                db.execute('CREATE TABLE keyv (key TEXT PRIMARY KEY, value TEXT)')
                db.execute("INSERT INTO keyv VALUES ('session:fixture','fixture')")
            body = path.read_bytes()
            with self.assertRaises(ValueError): permit.publish_birth(self.record)
            self.assertEqual(path.read_bytes(), body)
            self.assertFalse(M.L.B.receipt_path(self.root).exists()); self.assertIsNotNone(guard.read())

    def test_post_hold_metadata_is_the_bound_reset_baseline(self):
        with self.prepared() as (guard, permit):
            permit.record_cutover(self.record); self.staged()
            self.accounts['apps'] = 'c' * 64  # Published target's fixture migration.
            permit.record_hold(self.record); self.remove_hold()
            with mock.patch.object(self.r.FRESH.subprocess, 'run', side_effect=self.sql):
                result = permit.reset_accounts(self.record)
            self.assertEqual(result['apps'], 'c' * 64)
            permit.publish_birth(self.record)
            self.assertIsNotNone(guard.read())

    def test_metadata_changed_after_hold_refuses_before_sql_or_key_rotation(self):
        with self.prepared() as (guard, permit):
            self.reset_ready(permit)
            before = (self.root / '.env').read_bytes()
            self.accounts['apps'] = 'c' * 64
            with mock.patch.object(self.r.FRESH.subprocess, 'run', side_effect=self.sql):
                with self.assertRaises(ValueError): permit.reset_accounts(self.record)
            self.assertEqual(self.sql_calls, 0)
            self.assertEqual((self.root / '.env').read_bytes(), before)
            self.assertFalse(M.phase_path(self.root, permit.reference['operationId'], 'reset').exists())
            self.assertIsNotNone(guard.read())

    def test_phase_data_extensions_and_checkpoint_replacement_remain_held(self):
        with self.prepared() as (guard, permit):
            permit.record_cutover(self.record); self.staged()
            path = M.phase_path(self.root, permit.reference['operationId'], 'cutover')
            body = M.L.C.json_body(path.read_bytes()); body['data']['unrecognized'] = True
            path.write_bytes(M.L.K.canonical(body) + b'\n')
            with self.assertRaises(ValueError): permit.record_hold(self.record)
            del body['data']['unrecognized']; path.write_bytes(M.L.K.canonical(body) + b'\n')
            checkpoint = Path(self.record['review']['checkpoint']['journal'])
            replaced = checkpoint.with_suffix('.replacement'); replaced.write_bytes(checkpoint.read_bytes()); replaced.chmod(0o600)
            os.replace(replaced, checkpoint)
            with self.assertRaises(ValueError): permit.record_hold(self.record)
            self.assertIsNotNone(guard.read())

    def test_new_guard_can_resume_complete_birth_after_lost_reply(self):
        with self.prepared() as (guard, permit):
            self.reset_ready(permit)
            with mock.patch.object(self.r.FRESH.subprocess, 'run', side_effect=self.sql): result = permit.reset_accounts(self.record)
            selected = permit.reference
            publish = permit._publish_phase
            def interrupted(record, name, previous, data):
                if name == 'birth': raise OSError('fixture lost birth reply before attestation')
                return publish(record, name, previous, data)
            with mock.patch.object(permit, '_publish_phase', side_effect=interrupted), self.assertRaises(OSError):
                permit.publish_birth(self.record)
            self.assertTrue(M.L.B.receipt_path(self.root).is_file())
        with self.b.guarded() as guard:
            with self.issuer.resume_cutover(guard, self.record, selected) as permit:
                self.assertEqual(permit.reset_result(self.record), result)
                permit.publish_birth(self.record)
            self.assertIsNotNone(guard.read())

    def test_partial_birth_pending_stays_held(self):
        with self.prepared() as (guard, permit):
            self.reset_ready(permit)
            with mock.patch.object(self.r.FRESH.subprocess, 'run', side_effect=self.sql): permit.reset_accounts(self.record)
            pending = M.L.B.pending_path(self.root); pending.write_bytes(b'{'); pending.chmod(0o600)
            with self.assertRaises(ValueError): permit.publish_birth(self.record)
            self.assertEqual(pending.read_bytes(), b'{')
            self.assertFalse(M.L.B.receipt_path(self.root).exists()); self.assertIsNotNone(guard.read())

    def test_two_link_birth_interruption_is_preserved_without_promotion(self):
        with self.prepared() as (guard, permit):
            self.reset_ready(permit)
            with mock.patch.object(self.r.FRESH.subprocess, 'run', side_effect=self.sql): permit.reset_accounts(self.record)
            pending = M.L.B.pending_path(self.root)
            pending.write_bytes(M.L.K.canonical(permit._birth(self.record)) + b'\n'); pending.chmod(0o600)
            final = M.L.B.receipt_path(self.root); os.link(pending, final)
            with self.assertRaises(ValueError): permit.publish_birth(self.record)
            self.assertEqual(pending.stat().st_nlink, 2)
            self.assertTrue(final.exists()); self.assertIsNotNone(guard.read())


if __name__ == '__main__': unittest.main()
