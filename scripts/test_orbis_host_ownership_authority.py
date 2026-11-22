import copy
import fcntl
import importlib.util
import json
import os
import sqlite3
from pathlib import Path
import tempfile
import threading
import unittest
from contextlib import contextmanager
from contextvars import ContextVar
from types import SimpleNamespace
from unittest.mock import patch


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


K = load('orbis-host-ownership-authority.py', 'ownership_authority_test_target')
F = load('orbis-host-credential-fence.py', 'ownership_authority_test_fence')


class OwnershipAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='orbis-ownership-')
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name).resolve()
        self.root, self.namespace = self.folder / 'installation', self.folder / 'authority'
        self.root.mkdir(mode=0o700)
        self.namespace.mkdir(mode=0o700)
        self.addCleanup(patch.stopall)
        patch.object(F, 'OWNER', os.geteuid()).start()
        patch.object(K, 'OWNER', os.geteuid()).start()
        lock = self.namespace / 'host.lock'
        lock.touch(mode=0o600)

        def identity(info):
            return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode)

        def opened(_root):
            fd = os.open(lock, os.O_RDWR | os.O_NOFOLLOW)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return [fd]
            except BaseException:
                os.close(fd)
                raise

        layout = SimpleNamespace(
            selected_path=lambda _root, purpose: self.namespace / 'credential-fence.json',
            legacy_path=lambda _root, purpose: self.folder / 'legacy-fence.json',
            namespace=lambda _root: self.namespace,
            lock_paths=lambda _root: [lock], open_locks=opened, _lock_identity=identity)
        self.host = SimpleNamespace(
            CREDENTIAL_FENCE=F, AUTHORITY=SimpleNamespace(LAYOUT=layout),
            IDENTITY=SimpleNamespace(PUBLICATION=SimpleNamespace(
                canonical=K.canonical, metadata=lambda body, **_: K.decoded(body))),
            LOCK_DESCRIPTOR=ContextVar('ownership_test_lock', default=None),
            _require_no_capture_restore_fence=lambda _root: None)
        self.host.credential_fence_lock = lambda root, context: F.locked(self.host, root, context)
        self.proof = {'schema': K.ADMISSION, 'mode': 'unmanaged', 'managedEver': False,
                      'installationId': 'a' * 64, 'controllerId': 'b' * 64, 'imageId': 'sha256:' + 'c' * 64,
                      'controllerEpoch': 'd' * 64, 'authorityEpoch': 'e' * 64}
        self.service = K.OwnershipAuthority(self.host, self.root, 'local', self.scope)

    @contextmanager
    def scope(self):
        with F.locked(self.host, self.root, 'local') as guard:
            yield guard, lambda: copy.deepcopy(self.proof)

    def prepare(self, request='f', purpose='first-registration'):
        return self.service.prepare(request * 64, purpose)

    def complete(self, grant, disposition='committed'):
        return self.service.complete(grant['operationId'], grant['admissionBinding'], grant['purpose'], disposition)

    def state(self):
        return json.loads((self.namespace / K.STATE).read_bytes())

    def marker(self):
        return self.namespace / 'credential-fence.json'

    def ledger(self):
        return self.namespace / (K.STATE + '.completed.sqlite3')

    def archived(self, grant):
        with self.service._operation() as (guard, proof, check):
            return self.service._archived(guard, self.state(), 'operation_id', grant['operationId'])

    def ledger_query(self, query, parameters=()):
        with sqlite3.connect(str(self.ledger())) as connection:
            return connection.execute(query, parameters).fetchall()

    def assert_held(self):
        self.assertTrue(self.marker().exists())
        with self.assertRaises(ValueError):
            F.require_clear(self.host, self.root)

    def test_grant_holds_actual_shared_lifecycle_fence_until_verified_completion(self):
        grant = self.prepare()
        self.assertEqual(grant['state'], 'pending')
        self.assertEqual(self.state()['active'], grant['operationId'])
        self.assert_held()
        self.assertEqual(self.service.check(grant['operationId'], grant['admissionBinding'], grant['purpose']), grant)
        done = self.complete(grant)
        self.assertEqual(done['state'], 'completed')
        self.assertIsNone(self.state()['active'])
        self.assertFalse(self.marker().exists())
        F.require_clear(self.host, self.root)

    def test_never_grants_managed_unknown_partial_or_previously_managed_authority(self):
        for changed in ({'mode': 'managed'}, {'mode': 'unknown'}, {'managedEver': True}, {'managedEver': 0},
                        {'authorityEpoch': None}, {'installationId': ''}, {'schema': 'unknown'}):
            with self.subTest(changed=changed):
                before = copy.deepcopy(self.proof)
                self.proof.update(changed)
                try:
                    with self.assertRaises(K.OwnershipAuthorityError):
                        self.prepare()
                    self.assertFalse(self.marker().exists())
                    self.assertFalse((self.namespace / K.STATE).exists())
                finally:
                    self.proof = before
        self.proof.pop('managedEver')
        with self.assertRaises(K.OwnershipAuthorityError):
            self.prepare()

    def test_no_service_or_failed_observation_never_becomes_unmanaged(self):
        @contextmanager
        def missing():
            raise OSError('observation failed')
            yield
        denied = K.OwnershipAuthority(self.host, self.root, 'local', missing)
        with self.assertRaises(K.OwnershipAuthorityError):
            denied.prepare('f' * 64, 'first-registration')
        self.assertFalse(self.marker().exists())

    def test_replay_cannot_grant_new_work_after_completion(self):
        grant = self.prepare()
        self.assertEqual(self.prepare(), grant)
        self.complete(grant)
        replay = self.prepare()
        self.assertEqual(replay['state'], 'completed')
        self.assertFalse(self.marker().exists())
        with self.assertRaises(K.OwnershipAuthorityError):
            self.service.check(replay['operationId'], replay['admissionBinding'], replay['purpose'])
        self.assertEqual(self.complete(grant)['state'], 'completed')

    def test_request_cannot_switch_purpose_or_displace_other_pending_work(self):
        grant = self.prepare()
        before = (self.namespace / K.STATE).read_bytes()
        for request, purpose in [('f', 'account-removal'), ('1', 'first-registration')]:
            with self.assertRaises(K.OwnershipAuthorityError):
                self.prepare(request, purpose)
            self.assertEqual((self.namespace / K.STATE).read_bytes(), before)
        self.assert_held()
        self.complete(grant)

    def test_current_installation_controller_and_authority_epoch_are_revalidated(self):
        grant = self.prepare()
        for field, value in [('installationId', '1' * 64), ('controllerId', '2' * 64),
                             ('controllerEpoch', '3' * 64), ('authorityEpoch', '4' * 64),
                             ('imageId', 'sha256:' + '5' * 64), ('managedEver', True)]:
            with self.subTest(field=field):
                before = copy.deepcopy(self.proof)
                self.proof[field] = value
                try:
                    with self.assertRaises(K.OwnershipAuthorityError):
                        self.complete(grant)
                    self.assert_held()
                    self.assertEqual(self.state()['operations'][grant['operationId']]['phase'], 'pending')
                finally:
                    self.proof = before
        self.complete(grant)

    def test_wrong_identifiers_and_dispositions_do_not_retire_the_hold(self):
        grant = self.prepare()
        for identifier, binding, purpose, disposition in [
            ('0' * 64, grant['admissionBinding'], grant['purpose'], 'committed'),
            (grant['operationId'], '0' * 64, grant['purpose'], 'committed'),
            (grant['operationId'], grant['admissionBinding'], 'account-removal', 'committed'),
            (grant['operationId'], grant['admissionBinding'], grant['purpose'], 'unknown')]:
            with self.assertRaises(K.OwnershipAuthorityError):
                self.service.complete(identifier, binding, purpose, disposition)
            self.assert_held()
        self.complete(grant, 'not-written')
        with self.assertRaises(K.OwnershipAuthorityError):
            self.complete(grant, 'committed')

    def test_restart_reuses_only_the_exact_durable_pending_grant(self):
        grant = self.prepare()
        self.service = K.OwnershipAuthority(self.host, self.root, 'local', self.scope)
        self.assertEqual(self.prepare(), grant)
        self.complete(grant)

    def test_selector_survives_failure_before_the_journal_is_written(self):
        with patch.object(self.service, '_write', side_effect=OSError('interrupted')):
            with self.assertRaises(K.OwnershipAuthorityError):
                self.prepare()
        self.assert_held()
        self.assertFalse((self.namespace / K.STATE).exists())
        grant = self.prepare()
        self.assertEqual(grant['state'], 'pending')
        self.complete(grant)

    def test_completed_record_survives_lost_fence_retirement_and_can_only_finish(self):
        grant = self.prepare()
        with patch.object(F._Guard, 'finish', side_effect=OSError('reply lost')):
            with self.assertRaises(K.OwnershipAuthorityError):
                self.complete(grant)
        self.assertEqual(self.archived(grant)['phase'], 'completed')
        self.assertEqual(self.state()['operations'], {})
        self.assert_held()
        self.assertEqual(self.prepare()['state'], 'completed')
        self.complete(grant)
        self.assertFalse(self.marker().exists())

    def test_corruption_aliases_permission_drift_and_pending_writes_preserve_hold(self):
        grant = self.prepare()
        path = self.namespace / K.STATE
        original = path.read_bytes()
        for mutation in ['corrupt', 'duplicate', 'symlink', 'hardlink', 'mode', 'pending']:
            with self.subTest(mutation=mutation):
                path.unlink()
                path.write_bytes(original)
                path.chmod(0o600)
                other = self.namespace / 'retained.json'
                pending = self.namespace / K.PENDING
                if mutation == 'corrupt':
                    path.write_bytes(b'{}\n')
                elif mutation == 'duplicate':
                    path.write_bytes(b'{"schema":"x","schema":"y"}\n')
                elif mutation == 'symlink':
                    path.rename(other)
                    path.symlink_to(other)
                elif mutation == 'hardlink':
                    os.link(path, other)
                elif mutation == 'mode':
                    path.chmod(0o644)
                else:
                    pending.write_bytes(b'partial')
                try:
                    with self.assertRaises(K.OwnershipAuthorityError):
                        self.complete(grant)
                    self.assert_held()
                finally:
                    if other.exists():
                        other.unlink()
                    if pending.exists():
                        pending.unlink()
        path.unlink()
        path.write_bytes(original)
        path.chmod(0o600)
        self.complete(grant)

    def test_cancelled_or_unacknowledged_grant_has_no_expiration_cleanup(self):
        grant = self.prepare(purpose='account-removal')
        self.service = None
        self.assert_held()
        self.assertEqual(self.state()['active'], grant['operationId'])

    def test_unlocked_foreign_or_lookalike_guards_cannot_issue_a_grant(self):
        with self.scope() as (guard, _):
            old = guard

        @contextmanager
        def expired():
            yield old, lambda: self.proof

        @contextmanager
        def lookalike():
            yield SimpleNamespace(_root=self.root), lambda: self.proof

        for scope in (expired, lookalike):
            with self.assertRaises(K.OwnershipAuthorityError):
                K.OwnershipAuthority(self.host, self.root, 'local', scope).prepare('f' * 64, 'first-registration')
        with self.assertRaises(K.OwnershipAuthorityError):
            K.OwnershipAuthority(self.host, self.root, 'other', self.scope).prepare('f' * 64, 'first-registration')
        self.assertFalse(self.marker().exists())

    def test_more_than_original_history_cap_preserves_all_receipts_without_filling_active_state(self):
        grants = []
        with patch.object(K, 'MAX_RECORDS', 1):
            for i in range(137):
                grant = self.service.prepare(K.digest({'fixtureOperation': i}), 'credential-change')
                grants.append(grant)
                self.assertEqual(len(self.state()['operations']), 1)
                self.complete(grant)
                self.assertEqual(self.state()['operations'], {})
        self.assertEqual(self.state()['completed']['count'], len(grants))
        self.assertEqual(self.ledger_query('SELECT count(*) FROM receipts'), [(len(grants),)])
        self.assertEqual(self.ledger().stat().st_mode & 0o777, 0o600)
        for grant in (grants[0], grants[64], grants[-1]):
            replay = self.service.prepare(grant['requestId'], grant['purpose'])
            self.assertEqual(replay, {**grant, 'state': 'completed'})
            self.assertEqual(self.complete(grant)['state'], 'completed')
            with self.assertRaises(K.OwnershipAuthorityError):
                self.service.check(grant['operationId'], grant['admissionBinding'], grant['purpose'])
        self.assertFalse(self.marker().exists())

    def test_archive_failure_keeps_terminal_state_and_fence_before_any_receipt_is_removed(self):
        grant = self.prepare()
        with patch.object(self.service, '_archive', side_effect=OSError('synthetic archive unavailable')):
            with self.assertRaises(K.OwnershipAuthorityError): self.complete(grant)
        self.assertEqual(self.state()['operations'][grant['operationId']]['phase'], 'completed')
        self.assert_held()
        self.assertFalse(self.ledger().exists())
        self.assertEqual(self.prepare()['state'], 'completed')
        self.complete(grant)
        self.assertEqual(self.archived(grant)['disposition'], 'committed')

    def test_lost_archive_commit_response_reconciles_exact_receipt_without_duplicate_or_new_grant(self):
        grant = self.prepare()
        write = self.service._write
        def interrupted(guard, before, after):
            if grant['operationId'] in before['operations'] and grant['operationId'] not in after['operations']:
                raise OSError('synthetic receipt committed before JSON write')
            return write(guard, before, after)
        with patch.object(self.service, '_write', side_effect=interrupted):
            with self.assertRaises(K.OwnershipAuthorityError): self.complete(grant)
        self.assert_held()
        self.assertEqual(self.state()['completed']['count'], 0)
        self.assertEqual(self.ledger_query('SELECT count FROM metadata'), [(1,)])
        self.assertEqual(self.prepare()['state'], 'completed')
        with self.assertRaises(K.OwnershipAuthorityError): self.prepare('1')
        self.complete(grant)
        self.assertEqual(self.state()['completed']['count'], 1)
        self.assertEqual(self.ledger_query('SELECT count(*) FROM receipts'), [(1,)])
        self.assertFalse(self.marker().exists())

    def test_indexed_completed_receipts_cannot_be_updated_or_deleted(self):
        grant = self.prepare(); self.complete(grant)
        original = self.archived(grant)
        for sql, argument in [('UPDATE receipts SET body=?', b'changed'),
                              ('DELETE FROM receipts WHERE operation_id=?', grant['operationId'])]:
            with self.assertRaises(sqlite3.IntegrityError): self.ledger_query(sql, (argument,))
        self.assertEqual(self.archived(grant), original)

    def test_old_nonce_cannot_change_purpose_or_authority_after_receipt_leaves_active_state(self):
        grant = self.prepare(); self.complete(grant)
        with self.assertRaises(K.OwnershipAuthorityError): self.prepare(purpose='account-removal')
        self.proof['controllerEpoch'] = '0' * 64
        with self.assertRaises(K.OwnershipAuthorityError): self.prepare()
        self.assertFalse(self.marker().exists())
        self.assertEqual(self.state()['completed']['count'], 1)

    def test_missing_aliased_or_unsafe_ledger_never_becomes_an_empty_history(self):
        grant = self.prepare(); self.complete(grant)
        path, retained = self.ledger(), self.namespace / 'preserved-ledger'
        for mutation in ('missing', 'symlink', 'hardlink', 'mode', 'truncated', 'wal-header', 'hot-journal', 'wal', 'shm'):
            with self.subTest(mutation=mutation):
                body = path.read_bytes()
                if mutation in ('missing', 'symlink'): path.rename(retained)
                if mutation == 'symlink': path.symlink_to(retained)
                if mutation == 'hardlink': os.link(path, retained)
                if mutation == 'mode': path.chmod(0o644)
                if mutation == 'truncated': path.write_bytes(b'')
                if mutation == 'wal-header': path.write_bytes(body[:18] + b'\2\2' + body[20:])
                sidecar = Path(str(path) + {'hot-journal': '-journal', 'wal': '-wal', 'shm': '-shm'}.get(mutation, '.unused'))
                if mutation in ('hot-journal', 'wal', 'shm'): sidecar.write_bytes(b'preserve')
                try:
                    with self.assertRaises(K.OwnershipAuthorityError): self.prepare('1')
                    self.assertFalse(self.marker().exists())
                    self.assertEqual(self.state()['completed']['count'], 1)
                finally:
                    if sidecar.exists(): sidecar.unlink()
                    if mutation in ('missing', 'symlink'):
                        if path.is_symlink(): path.unlink()
                        retained.rename(path)
                    elif mutation == 'hardlink': retained.unlink()
                    elif mutation in ('truncated', 'wal-header'): path.write_bytes(body)
                    path.chmod(0o600)
        self.assertEqual(self.complete(grant)['state'], 'completed')

    def test_invalid_receipt_cannot_be_hidden_as_a_missing_index_entry(self):
        first = self.prepare(); self.complete(first)
        self.ledger_query('INSERT INTO receipts VALUES (?,?,?)', ('0' * 64, '1' * 64, b'{}'))
        with self.assertRaises(K.OwnershipAuthorityError): self.prepare('1')
        self.assertFalse(self.marker().exists())

    def test_ledger_rollback_or_schema_change_blocks_the_next_grant(self):
        first = self.prepare(); self.complete(first)
        original = self.ledger().read_bytes()
        for sql in ('UPDATE metadata SET count=0', 'CREATE TABLE unexpected (value TEXT)'):
            with self.subTest(sql=sql):
                self.ledger_query(sql)
                with self.assertRaises(K.OwnershipAuthorityError): self.prepare('1')
                self.assertFalse(self.marker().exists())
                self.ledger().write_bytes(original)
        self.assertEqual(self.prepare()['state'], 'completed')

    def test_lost_ledger_during_pending_work_refuses_current_check_and_preserves_hold(self):
        first = self.prepare(); self.complete(first)
        pending = self.prepare('1')
        retained = self.namespace / 'preserved-ledger'
        self.ledger().rename(retained)
        with self.assertRaises(K.OwnershipAuthorityError):
            self.service.check(pending['operationId'], pending['admissionBinding'], pending['purpose'])
        self.assert_held()
        retained.rename(self.ledger())
        self.complete(pending)

    def test_older_json_format_is_preserved_for_review_instead_of_automatically_reinitialized(self):
        grant = self.prepare()
        state = self.state(); state['schema'] = 'orbis.main-ownership-authority.v1'; del state['completed']
        path = self.namespace / K.STATE; path.write_bytes(K.canonical(state) + b'\n'); original = path.read_bytes()
        with self.assertRaises(K.OwnershipAuthorityError): self.complete(grant)
        self.assertEqual(path.read_bytes(), original)
        self.assert_held()

    def test_python310_connection_without_setlimit_still_bounds_and_validates_selected_receipt(self):
        connect = sqlite3.connect
        class OlderConnection:
            def __init__(self, *args, **kwargs): self.connection = connect(*args, **kwargs)
            def __getattr__(self, name):
                if name == 'setlimit': raise AttributeError(name)
                return getattr(self.connection, name)
        with patch.object(K.sqlite3, 'connect', side_effect=OlderConnection):
            grant = self.prepare(); self.complete(grant)
            self.assertEqual(self.prepare()['state'], 'completed')
        self.ledger_query('INSERT INTO receipts VALUES (?,?,?)', ('0' * 64, '1' * 64, b'x' * (K.LIMIT + 1)))
        with patch.object(K.sqlite3, 'connect', side_effect=OlderConnection):
            with self.assertRaises(K.OwnershipAuthorityError): self.prepare('1')
        self.assertFalse(self.marker().exists())

    def test_orphan_ledger_without_a_root_reference_is_never_adopted_as_empty_history(self):
        self.ledger().write_bytes(b'preserve unexpected ledger')
        with self.assertRaises(K.OwnershipAuthorityError): self.prepare()
        self.assertFalse(self.marker().exists())
        self.assertEqual(self.ledger().read_bytes(), b'preserve unexpected ledger')

    def test_interrupted_initial_database_creation_preserves_empty_inode_and_hold_for_review(self):
        grant = self.prepare()
        with patch.object(K.sqlite3, 'connect', side_effect=OSError('synthetic initialization interruption')):
            with self.assertRaises(K.OwnershipAuthorityError): self.complete(grant)
        self.assert_held()
        self.assertEqual(self.ledger().read_bytes(), b'')
        self.assertEqual(self.state()['operations'][grant['operationId']]['phase'], 'completed')
        with self.assertRaises(K.OwnershipAuthorityError): self.complete(grant)
        self.assertEqual(self.ledger().read_bytes(), b'')
        self.assert_held()


class AdmittedOwnershipIssuerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = OwnershipAuthorityTests('test_grant_holds_actual_shared_lifecycle_fence_until_verified_completion')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.C = load('orbis-host-credential-service.py', 'ownership_admitted_issuer_target')
        patch.object(self.C, 'OWNER', os.geteuid()).start()
        fixture = self.fixture
        fixture.host.AUTHORITY.LAYOUT.STATE_ROOT = fixture.folder
        self.current = {key: value for key, value in fixture.proof.items() if key not in ('managedEver', 'authorityEpoch')}
        self.current['schema'] = 'orbis.sentinel-writer-admission.v1'
        self.current.update(origin='https://recovery.example', recoveryEpoch=None)
        self.writer_active = None

        @contextmanager
        def journal_operation():
            yield

        self.issuer = self.C.CredentialService.__new__(self.C.CredentialService)
        self.issuer.closed = False
        self.issuer.service = SimpleNamespace(HOST=fixture.host, root=fixture.root, context='local', state_dir=fixture.folder)
        self.issuer.lifecycle = self.C.Lifecycle(self.issuer.service)
        self.issuer.value = {'journalDirectory': str(fixture.namespace / 'credential-journal')}
        config = fixture.folder / self.C.CONFIG_NAME
        config.write_bytes(b'{"fixture":"already-validated-config"}\n')
        config.chmod(0o600)
        self.issuer.config_pin = self.C.PinnedFile(config, limit=4096, private=True)
        self.addCleanup(self.issuer.config_pin.close)
        self.issuer.pins = [self.issuer.config_pin]
        self.issuer.broker = SimpleNamespace(
            _admitted=lambda: (copy.deepcopy(self.current), K.digest(self.current)),
            journal=SimpleNamespace(operation=journal_operation, read=lambda: {'active': self.writer_active}))
        self.history = {'schema': 'orbis.recovery-admission-history.v1', 'installationId': self.current['installationId'],
                        'generation': 1, 'managedEver': False, 'mode': 'unmanaged',
                        'configSha256': K.hashlib.sha256(self.issuer.config_pin.body).hexdigest(),
                        'planSha256': '1' * 64, 'sentinelVersion': '0.1.0-dev.20', 'writerProtocol': 1}
        self.history_path = fixture.namespace / 'recovery-admission-history.json'
        self.write_history()
        patch.object(self.C, 'OWNERSHIP_RECOVERY', fixture.folder / 'absent-recovery').start()
        patch.object(self.C, 'OWNERSHIP_RECOVERY_ENV', fixture.folder / 'absent-recovery-env').start()
        self.authority = K.OwnershipAuthority(fixture.host, fixture.root, 'local', self.issuer.ownership_scope)

    def write_history(self):
        self.history_path.write_bytes(K.canonical(self.history) + b'\n')
        self.history_path.chmod(0o600)

    def prepare(self):
        return self.authority.prepare('f' * 64, 'account-removal')

    def test_admitted_never_managed_history_grants_only_a_fenced_lease(self):
        grant = self.prepare()
        self.fixture.assert_held()
        self.assertEqual(self.authority.complete(grant['operationId'], grant['admissionBinding'], grant['purpose'], 'not-written')['state'], 'completed')
        self.assertFalse(self.fixture.marker().exists())

    def test_absent_or_inconsistent_history_never_grants_legacy_authority(self):
        for field, bad in [('managedEver', True), ('managedEver', 0), ('mode', 'managed'),
                           ('installationId', '2' * 64), ('configSha256', '3' * 64),
                           ('writerProtocol', True), ('generation', 0)]:
            with self.subTest(field=field):
                original = copy.deepcopy(self.history)
                self.history[field] = bad
                self.write_history()
                with self.assertRaises(K.OwnershipAuthorityError):
                    self.prepare()
                self.assertFalse(self.fixture.marker().exists())
                self.history = original
        self.history_path.unlink()
        with self.assertRaises(K.OwnershipAuthorityError):
            self.prepare()

    def test_partial_recovery_setup_and_other_credential_work_block_grants(self):
        env = self.C.OWNERSHIP_RECOVERY_ENV
        env.write_bytes(b'partial')
        with self.assertRaises(K.OwnershipAuthorityError):
            self.prepare()
        env.unlink()
        self.writer_active = '1' * 64
        with self.assertRaises(K.OwnershipAuthorityError):
            self.prepare()
        self.writer_active = None
        pending = self.fixture.namespace / 'credential-bootstrap-publication-hold.json'
        pending.write_bytes(b'partial')
        with self.assertRaises(K.OwnershipAuthorityError):
            self.prepare()
        self.assertFalse(self.fixture.marker().exists())

    def test_history_change_after_grant_keeps_the_durable_hold(self):
        grant = self.prepare()
        self.history['generation'] = 2
        self.write_history()
        with self.assertRaises(K.OwnershipAuthorityError):
            self.authority.complete(grant['operationId'], grant['admissionBinding'], grant['purpose'], 'committed')
        self.fixture.assert_held()


class OwnershipDispatchTests(unittest.TestCase):
    def setUp(self):
        self.C = load('orbis-host-credential-service.py', 'ownership_dispatch_target')
        self.calls = []
        self.issuer = self.C.CredentialService.__new__(self.C.CredentialService)
        self.issuer.service = SimpleNamespace(lock=threading.Lock(), HOST=object())
        self.issuer.peer = ContextVar('ownership_dispatch_peer', default=None)
        self.issuer.enrollment = lambda: {}
        self.issuer.verify = lambda: self.calls.append('verify')
        @contextmanager
        def frame():
            yield object()
        self.issuer.lifecycle = SimpleNamespace(operation=frame)
        self.issuer.data_scope = lambda guard: frame()

        def prepare(request, purpose):
            self.assertTrue(self.issuer.service.lock.locked())
            self.assertIs(self.issuer.peer.get(), self.witness)
            self.calls.append('prepare')
            return {'requestId': request, 'purpose': purpose}

        self.issuer.ownership_authority = SimpleNamespace(prepare=prepare)
        self.witness = object()

        @contextmanager
        def admit(*args, **kwargs):
            self.calls.append('peer')
            yield self.witness
            self.calls.append('peer-closed')

        self.peer = SimpleNamespace(admit_configured=admit)

    def test_outer_request_verifies_producer_before_any_ownership_dispatch(self):
        result = self.issuer.request(None, 'ownership-prepare', {'requestId': 'a' * 64, 'purpose': 'first-registration'}, peer_module=self.peer)
        self.assertEqual(result['purpose'], 'first-registration')
        self.assertEqual(self.calls, ['verify', 'peer', 'prepare', 'peer-closed'])
        self.assertIsNone(self.issuer.peer.get())
        self.assertFalse(self.issuer.service.lock.locked())

    def test_unverified_producer_never_reaches_the_issuer(self):
        @contextmanager
        def denied(*args, **kwargs):
            raise self.C.fail()
            yield

        with self.assertRaises(ValueError):
            self.issuer.request(None, 'ownership-prepare', {'requestId': 'a' * 64, 'purpose': 'first-registration'}, peer_module=SimpleNamespace(admit_configured=denied))
        self.assertEqual(self.calls, ['verify'])
        self.assertFalse(self.issuer.service.lock.locked())

    def test_caller_cannot_supply_mode_proof_unknown_purpose_or_nonexact_ids(self):
        for body in [{'requestId': 'a' * 64, 'purpose': 'first-registration', 'mode': 'unmanaged'},
                     {'requestId': 'a' * 64, 'purpose': 'withdrawal'},
                     {'requestId': 'not-a-hash', 'purpose': 'first-registration'}]:
            with self.subTest(body=body), self.assertRaises(ValueError):
                self.issuer.request(None, 'ownership-prepare', body, peer_module=self.peer)
        self.assertNotIn('prepare', self.calls)


if __name__ == '__main__':
    unittest.main()
