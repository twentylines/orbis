import copy
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

import test_orbis_fresh_rollback as rollback

M = rollback.M


class FreshInstallerTests(unittest.TestCase):
    """Public workflow with real guards/files/transaction and explicit ports.

    Docker, publisher verification, SQL, image probes and Linux copier are
    synthetic ports. This does not establish native or publisher acceptance.
    """
    def setUp(self):
        self.b = rollback.FreshRollbackTests('test_pre_reset_rollback_returns_original_without_birth_or_reset')
        self.addCleanup(self.b.doCleanups); self.b.setUp()
        c = self.c = self.b.c
        actual = c.host.file_digest.__globals__
        c.host.PLAN.read_version = actual['PLAN'].read_version
        c.host.published_installation_fingerprint = actual['published_installation_fingerprint']
        c.host.installation_fingerprint = actual['installation_fingerprint']
        c.host.write_state = actual['write_state']
        c.host.require_confirmation = actual['require_confirmation']
        c.f.raw['HostConfig']['LogConfig'] = {'Type': 'json-file', 'Config': {}}
        c.f.raw['HostConfig']['Binds'] = [item['Source'] + ':' + item['Destination'] + ':rw' for item in c.f.raw['Mounts']]
        self.ledger = [{'createdAt': 1, 'hash': 'f' * 64}]
        for port, name, value in ((c.r.UPDATE, 'verify_release', None),
                                  (c.r.COMPAT, 'image_ledger', {'imageId': 'sha256:' + 'e' * 64, 'ledger': self.ledger}),
                                  (actual['PLAN'], 'plan', {'configuredImage': 'ghcr.io/runtipi/runtipi:v4.10.1'})):
            patch = mock.patch.object(port, name, return_value=value)
            patch.start(); self.addCleanup(patch.stop)
        self.phases = []; self.fail_normal = False
        def create(name, body):
            phase = body['Labels']['io.orbis.installation.phase']
            selected = json.loads(c.f.layout.selected_path(c.root, 'credential-fence').read_text())
            required = {'hold': 'cutover', 'resume': 'resume', 'normal': 'forward'}[phase]
            self.assertTrue(M.phase_path(c.root, selected['operationId'], required).exists())
            if phase == 'normal' and self.fail_normal:
                self.fail_normal = False
                raise OSError('fixture normal creation interrupted')
            identifier = str(len(self.phases) + 1) * 64
            self.phases.append(phase)
            c.raws[identifier] = {'Id': identifier, 'Name': '/' + name, 'Image': 'sha256:' + 'e' * 64,
                'Config': {key: copy.deepcopy(item) for key, item in body.items() if key not in ('HostConfig', 'NetworkingConfig')},
                'HostConfig': copy.deepcopy(body['HostConfig']), 'Mounts': copy.deepcopy(c.f.raw['Mounts']),
                'NetworkSettings': {'Networks': {}}, 'State': {'Status': 'created', 'Health': {'Status': 'starting'}}}
            return identifier
        engine = mock.patch.object(c.r, 'Engine', return_value=SimpleNamespace(create=create))
        engine.start(); self.addCleanup(engine.stop)
        def read(args):
            if 'psql' in args:
                if args[-1] == c.r.FRESH.ACCOUNT_QUERY: return json.dumps(c.accounts)
                return json.dumps({'pendingApps': 0, 'postgresMajor': 15, 'ledger': self.ledger})
            if 'rabbitmqctl' in args:
                return json.dumps([{'name': 'app-events-queue', 'messages_ready': 0, 'messages_unacknowledged': 0,
                                    'consumers': int(c.f.raw['State']['Status'] == 'running')}])
            if 'rabbitmq-diagnostics' in args: return 'ok'
            if 'curl' in args:
                phase = c.raws[args[1]]['Config']['Labels']['io.orbis.installation.phase']
                return json.dumps({'schema': c.host.PLAN.INSTALLATION_PROTOCOL, 'phase': phase,
                                   'transactionId': None if phase == 'normal' else c.raws[args[1]]['Config']['Labels']['io.orbis.installation.transaction']})
            raise AssertionError('Unexpected Docker observation')
        c.reader._read = read
        previous = c.r.FRESH.subprocess.run
        def run(args, **kwargs):
            if args[0] == 'docker' and 'psql' in args: return c.sql(args, **kwargs)
            return previous(args, **kwargs)
        sql = mock.patch.object(c.r.FRESH.subprocess, 'run', side_effect=run)
        sql.start(); self.addCleanup(sql.stop)

    def review(self, guard):
        c = self.c
        c.f.authorization_fixture()
        return c.r.review(c.root, c.reader, c.f.manifest, c.bundle, c.journal, mode='fresh', ownership=guard)

    def apply(self, guard, reviewed):
        c = self.c
        return c.r.apply(c.root, c.reader, reviewed, host_writers_stopped=True, ownership=guard)

    def recover(self, guard):
        c = self.c
        return c.r.recover(c.root, c.reader, c.journal, host_writers_stopped=True, ownership=guard)

    def test_public_review_apply_uses_all_protected_phases_and_finishes_exact_target(self):
        c = self.c
        with c.b.guarded() as guard:
            reviewed = self.review(guard)
            self.assertIsNone(guard.read()); self.assertEqual(reviewed['ownershipProtocol'], c.r.OWNERSHIP_PROTOCOL)
            result = self.apply(guard, reviewed)
            self.assertEqual(result['result'], 'orbis-installed'); self.assertIsNone(guard.read())
        self.assertEqual(self.phases, ['hold', 'resume', 'normal']); self.assertEqual(c.sql_calls, 1)
        self.assertNotIn(c.f.raw['Id'], c.raws); self.assertEqual(self.b.copy_calls, 0)

    def test_missing_independent_decision_or_wrong_review_never_reserves_or_mutates(self):
        c = self.c
        with c.b.guarded() as guard:
            with self.assertRaises(FileNotFoundError):
                c.r.review(c.root, c.reader, c.f.manifest, c.bundle, c.journal, mode='fresh', ownership=guard)
            reviewed = self.review(guard)
            reviewed['fresh']['accounts']['users'] += 1
            reviewed['reviewId'] = c.r.APPS.digest({key: value for key, value in reviewed.items() if key != 'reviewId'})
            with self.assertRaises(c.r.ReplacementError): self.apply(guard, reviewed)
            self.assertIsNone(guard.read())
        self.assertEqual(self.b.changes, []); self.assertEqual(self.phases, [])

    def test_pre_checkpoint_failure_aborts_unchanged_original_and_terminal_replay(self):
        c = self.c
        with c.b.guarded() as guard:
            reviewed = self.review(guard)
            with mock.patch.object(c.r.TX, 'checkpoint', side_effect=OSError('fixture before checkpoint')):
                with self.assertRaisesRegex(c.r.ReplacementError, 'original Runtipi installation was recovered'):
                    self.apply(guard, reviewed)
            self.assertIsNone(guard.read())
        before = c.journal.read_bytes()
        with c.b.guarded() as guard:
            self.assertEqual(self.recover(guard)['result'], 'original-runtipi-recovered'); self.assertIsNone(guard.read())
        self.assertEqual(c.journal.read_bytes(), before); self.assertEqual(c.sql_calls, 0); self.assertEqual(self.b.copy_calls, 0)

    def test_partial_checkpoint_aborts_without_data_restore(self):
        c = self.c
        marker = c.root / 'state/kept'; marker.write_text('fixture original data')
        with c.b.guarded() as guard:
            reviewed = self.review(guard)
            with mock.patch.object(c.r.TX.STORAGE, 'capture', side_effect=OSError('fixture incomplete copy')), \
                    mock.patch.object(c.r.TX.RESTORE, 'restore') as restore:
                with self.assertRaisesRegex(c.r.ReplacementError, 'original Runtipi installation was recovered'):
                    self.apply(guard, reviewed)
                restore.assert_not_called()
            self.assertIsNone(guard.read())
        self.assertEqual(marker.read_text(), 'fixture original data'); self.assertEqual(self.b.copy_calls, 0)

    def test_pre_cutover_configuration_drift_stays_held_instead_of_false_abort_success(self):
        c = self.c
        with c.b.guarded() as guard:
            reviewed = self.review(guard)
            def changed(*args, **kwargs):
                path = c.root / '.env'; path.write_bytes(path.read_bytes() + b'CHANGED_FIXTURE=yes\n')
                raise OSError('fixture concurrent configuration change')
            with mock.patch.object(c.r.TX, 'checkpoint', side_effect=changed):
                with self.assertRaisesRegex(c.r.ReplacementError, 'protected recovery'): self.apply(guard, reviewed)
            self.assertIsNotNone(guard.read())
            self.assertTrue((c.root / '.env').read_bytes().endswith(b'CHANGED_FIXTURE=yes\n'))
        self.assertEqual(self.phases, []); self.assertEqual(c.sql_calls, 0)
        self.assertNotIn('failure', json.loads(c.journal.read_text()))

    def test_hold_failure_before_reset_restores_positive_checkpoint(self):
        c = self.c
        with c.b.guarded() as guard:
            reviewed = self.review(guard)
            with mock.patch.object(c.r.FRESH, 'reset', side_effect=c.r.FRESH.FreshError('fixture reset refused before writes')):
                with self.assertRaisesRegex(c.r.ReplacementError, 'original Runtipi installation was recovered'):
                    self.apply(guard, reviewed)
            self.assertIsNone(guard.read())
        self.assertEqual(c.sql_calls, 0); self.assertEqual(self.b.copy_calls, 1)

    def test_forward_failure_recovery_never_rewinds_or_resets_again(self):
        c = self.c
        with c.b.guarded() as guard:
            reviewed = self.review(guard); self.fail_normal = True
            with self.assertRaisesRegex(c.r.ReplacementError, 'recorded outcome'): self.apply(guard, reviewed)
            self.assertIsNotNone(guard.read())
        marker = c.root / 'state/new-forward-write'; marker.write_text('fixture new data')
        c.accounts['users'] = 1
        with c.b.guarded() as guard:
            self.assertEqual(self.recover(guard)['result'], 'orbis-installed'); self.assertIsNone(guard.read())
        self.assertEqual(marker.read_text(), 'fixture new data'); self.assertEqual(c.accounts['users'], 1)
        self.assertEqual(c.sql_calls, 1); self.assertEqual(self.b.copy_calls, 0)

    def test_lost_completion_reply_preserves_pinned_journal_for_recovery(self):
        c = self.c
        with c.b.guarded() as guard:
            reviewed = self.review(guard)
            with mock.patch.object(guard, 'finish', side_effect=OSError('fixture interrupted retirement')):
                with self.assertRaisesRegex(c.r.ReplacementError, 'recorded outcome'): self.apply(guard, reviewed)
            before = c.journal.read_bytes(); self.assertIsNotNone(guard.read())
        self.assertNotIn('failure', json.loads(before))
        with c.b.guarded() as guard:
            self.assertEqual(self.recover(guard)['result'], 'orbis-installed'); self.assertIsNone(guard.read())
        self.assertEqual(c.journal.read_bytes(), before); self.assertEqual(c.sql_calls, 1)

    def test_standalone_cli_uses_the_real_guard_for_review_and_apply(self):
        c = self.c
        c.host.credential_fence_lock = lambda root, context: c.b.guarded()
        manifest = c.f.folder / 'release.json'; manifest.write_text(json.dumps(c.f.manifest))
        reviewed_path = c.f.folder / 'review.json'
        with c.b.guarded(): c.f.authorization_fixture()
        base = [str(c.r.__file__), 'review', str(c.root), '--docker-context', c.reader.context,
                '--manifest', str(manifest), '--backup', str(c.bundle), '--journal', str(c.journal), '--mode', 'fresh']
        with mock.patch.object(c.r, 'require_host'), mock.patch.object(c.r.APPS, 'Docker', return_value=c.reader):
            out = io.StringIO()
            with mock.patch.object(c.r.sys, 'argv', base), redirect_stdout(out): self.assertEqual(c.r.main(), 0)
            reviewed = json.loads(out.getvalue()); c.r.APPS.write_journal(reviewed_path, reviewed)
            apply = [str(c.r.__file__), 'apply', str(c.root), '--docker-context', c.reader.context,
                     '--review', str(reviewed_path), '--journal', str(c.journal), '--mode', 'fresh',
                     '--confirm-root', str(c.root), '--host-writers-stopped']
            out = io.StringIO()
            with mock.patch.object(c.r.sys, 'argv', apply), redirect_stdout(out): self.assertEqual(c.r.main(), 0)
            self.assertEqual(json.loads(out.getvalue())['result'], 'orbis-installed')
        self.assertEqual(c.sql_calls, 1); self.assertIsNone(c.reader.lock_fd)


if __name__ == '__main__': unittest.main()
