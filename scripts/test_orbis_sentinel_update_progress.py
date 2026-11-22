import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from email.message import Message
from types import SimpleNamespace
from unittest import mock

from test_orbis_host_sentinel_integration import SERVICE
from test_orbis_sentinel_install import INSTALL

INCARNATION = '12345678-1234-1234-1234-123456789abc:123'
RELEASE = {'version': '1.2.3', 'sha256': 'f' * 64, 'sourceCommit': 'a' * 40}
ACTIVATE = "import runpy,sys;sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')"
DOWNLOAD_FIXTURE = """
from email.message import Message
import time
import urllib.request

class Response:
    status = 200
    headers = Message()
    chunks = iter([b'a' * 65536, b'b' * 65536, b''])

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def geturl(self):
        return 'https://github.com/fixture'

    def read(self, _):
        time.sleep(0.5)
        return next(self.chunks)

urllib.request.urlopen = lambda *args, **kwargs: Response()
"""


class ProgressTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.progress = self.root / 'sentinel-progress'
        executable = Path(sys.executable).resolve()
        for name, value in {
            'PROGRESS_ROOT': self.progress, 'OWNER': os.geteuid(), 'require_host': lambda: None,
            '_python': lambda: (executable, INSTALL._seal(executable.lstat())),
            '_process_identity': lambda pid: INCARNATION if pid == os.getpid() else None,
        }.items():
            patch = mock.patch.object(INSTALL, name, value)
            patch.start()
            self.addCleanup(patch.stop)

    def jobs(self):
        return INSTALL.read_update_progress()['jobs']

    def observe_worker(self, work, predicate):
        result, errors = [], []

        def run():
            try:
                result.append(work())
            except BaseException as failure:
                errors.append(failure)

        worker = threading.Thread(target=run)
        worker.start()
        observed = None
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and worker.is_alive():
                for job in self.jobs():
                    if predicate(job):
                        observed = job
                        return job, result, errors
                time.sleep(0.02)
        finally:
            worker.join(timeout=6)
            self.assertFalse(worker.is_alive())
            self.assertIsNotNone(observed, (result, errors))

    def test_reports_real_delayed_writes_with_known_and_unknown_file_totals(self):
        original_download = INSTALL.DOWNLOAD
        for label in ('pinned', 'header', 'unknown'):
            with self.subTest(label=label):
                work = self.root / label
                work.mkdir(mode=0o700)
                header = "Response.headers['Content-Length'] = '131072'\n" if label == 'header' else ''
                asset = work / 'sentinel.tar.gz'
                total = None if label == 'unknown' else 131072

                def download():
                    with INSTALL._observe_update(RELEASE['version'], 'preparing') as progress:
                        result = INSTALL._download(
                            work, asset, 'https://github.com/fixture', 131072,
                            size=131072 if label == 'pinned' else 0,
                            digest=hashlib.sha256(b'a' * 65536 + b'b' * 65536).hexdigest(),
                        )
                        progress.publish('prepared')
                        return result

                with mock.patch.object(INSTALL, 'DOWNLOAD', DOWNLOAD_FIXTURE + header + original_download):
                    job, result, errors = self.observe_worker(download, lambda j: (j['download'] or {}).get('currentBytes') == 65536)
                self.assertEqual(errors, [])
                self.assertEqual(job['download'], {'file': 'release', 'currentBytes': 65536, 'totalBytes': total})
                self.assertEqual(result[0]['bytes'], 131072)
                self.assertEqual(next(j for j in self.jobs() if j['id'] == job['id'])['phase'], 'prepared')

    def test_prepare_only_and_verified_activation_have_distinct_terminal_states(self):
        def prepare(*_args, **_options):
            self.assertEqual(self.jobs()[0]['phase'], 'preparing')
            INSTALL._progress_phase('verifying')
            self.assertEqual(self.jobs()[0]['phase'], 'verifying')
            prepared = INSTALL.Prepared(self.root, (), [], RELEASE, None)
            INSTALL._PREPARATIONS[prepared] = (INSTALL._preparation_identity(prepared), False)
            return prepared

        def activate(_prepared):
            self.assertEqual(self.jobs()[0]['phase'], 'installing')
            return {**RELEASE, 'activated': True, 'publisherVerified': True}

        with mock.patch.object(INSTALL, '_prepare_files', side_effect=prepare):
            prepared = INSTALL.prepare_release(self.root, RELEASE)
        original = self.jobs()[0]
        self.assertEqual(original['phase'], 'prepared')
        with mock.patch.object(INSTALL, '_activate_files', side_effect=activate):
            self.assertTrue(INSTALL.activate(prepared)['activated'])
        self.assertEqual(len(self.jobs()), 1)
        self.assertEqual(self.jobs()[0]['id'], original['id'])
        self.assertEqual(self.jobs()[0]['phase'], 'complete')

    def test_advertised_download_total_must_match_eof_before_preparation_advances(self):
        script = DOWNLOAD_FIXTURE + "Response.headers['Content-Length'] = '131073'\n" + INSTALL.DOWNLOAD
        asset = self.root / 'sentinel.tar.gz'
        with mock.patch.object(INSTALL, 'DOWNLOAD', script):
            with self.assertRaises(INSTALL.SentinelInstallError):
                with INSTALL._observe_update(RELEASE['version'], 'preparing'):
                    INSTALL._download(self.root, asset, 'https://github.com/fixture', 262144)
                    INSTALL._progress_phase('prepared')
        self.assertEqual(self.jobs()[0]['phase'], 'failed')
        self.assertEqual(asset.stat().st_size, 131072)

    def test_typed_activation_refusal_preserves_reconciliation_without_new_journal(self):
        for error, expected in [('RecoveryRequired', 'recovery-required'), ('ActivationError', 'failed')]:
            with self.subTest(error=error):
                work = self.root / error
                work.mkdir(mode=0o700)
                script = work / 'fixture.py'
                script.write_text('class RecoveryRequired(ValueError): pass\n'
                                  'class ActivationError(ValueError): pass\n'
                                  f'def activate_release(): raise {error}("fixture refusal")\n'
                                  'activate_release()\n')
                with self.assertRaises(INSTALL.SentinelInstallError):
                    with INSTALL._observe_update(RELEASE['version'], 'installing') as progress:
                        INSTALL._run(work, 'activate-sentinel', ACTIVATE, [script], timeout=4)
                self.assertEqual(next(job for job in self.jobs() if job['id'] == progress.job['id'])['phase'], expected)
                self.assertEqual((work / 'activate-sentinel.stdout').read_bytes(), b'')

    def test_verifier_observes_real_staging_without_publishing_completion(self):
        (self.root / 'stage_release.py').write_text('import time\ndef stage_release(): time.sleep(0.6)\n')
        script = self.root / 'verify_release.py'
        script.write_text('from stage_release import stage_release\ndef verify_release(): stage_release()\nverify_release()\n')
        verify = "import runpy,sys;sys.path.insert(0,sys.argv[1]);sys.argv=sys.argv[2:];runpy.run_path(sys.argv[0],run_name='__main__')"

        def stage():
            with INSTALL._observe_update(RELEASE['version'], 'verifying'):
                INSTALL._run(self.root, 'verify-package', verify, [self.root, script], timeout=4)
                INSTALL._progress_phase('prepared')

        job, _, errors = self.observe_worker(stage, lambda j: j['phase'] == 'staging')
        self.assertEqual(errors, [])
        self.assertIsNone(job['download'])
        self.assertEqual(self.jobs()[0]['phase'], 'prepared')

    def test_activation_child_reports_only_its_committed_rollback(self):
        script = self.root / 'fixture.py'
        script.write_text("""
import time

def activate_release():
    journal = b'previous'
    def persist(phase):
        nonlocal journal
        body = phase.encode()
        journal = body
    time.sleep(0.3)
    persist('rolling-back')
    time.sleep(0.6)
    persist('rolled-back')
    raise SystemExit(1)

activate_release()
""")

        def activate():
            with INSTALL._observe_update(RELEASE['version'], 'installing'):
                INSTALL._run(self.root, 'activate-sentinel', ACTIVATE, [script], timeout=4)

        job, _, errors = self.observe_worker(activate, lambda j: j['phase'] == 'rolling-back')
        self.assertIsInstance(errors[0], INSTALL.SentinelInstallError)
        self.assertEqual(next(j for j in self.jobs() if j['id'] == job['id'])['phase'], 'rolled-back')
        self.assertEqual((self.root / 'activate-sentinel.stdout').read_bytes(), b'')

    def test_failed_journal_write_cannot_claim_rollback_or_success(self):
        script = self.root / 'fixture.py'
        script.write_text("""
def persist(phase):
    journal = b'previous'
    body = phase.encode()
    raise SystemExit(1)
persist('rolled-back')
""")
        with self.assertRaises(INSTALL.SentinelInstallError):
            with INSTALL._observe_update(RELEASE['version'], 'installing'):
                INSTALL._run(self.root, 'activate-sentinel', ACTIVATE, [script], timeout=4)
        self.assertEqual(self.jobs()[0]['phase'], 'failed')

    def test_live_attempts_keep_distinct_records_and_pid_reuse_is_interrupted(self):
        self.assertEqual(INSTALL.read_update_progress(), {'version': 1, 'available': True, 'jobs': []})
        with INSTALL._observe_update('1.2.3', 'preparing') as first:
            with INSTALL._observe_update('1.2.4', 'installing') as second:
                self.assertNotEqual(first.slot, second.slot)
                self.assertEqual({j['phase'] for j in self.jobs()}, {'preparing', 'installing'})
                with mock.patch.object(INSTALL, '_process_identity', return_value=INCARNATION + '4'):
                    self.assertEqual({j['phase'] for j in self.jobs()}, {'interrupted'})
                second.publish('failed')
            first.publish('prepared')
        self.assertEqual({j['phase'] for j in self.jobs()}, {'failed', 'prepared'})

    def test_cancellation_reports_interrupted_instead_of_completing(self):
        with self.assertRaises(KeyboardInterrupt):
            with INSTALL._observe_update('1.2.3', 'verifying'):
                raise KeyboardInterrupt
        self.assertEqual(self.jobs()[0]['phase'], 'interrupted')

    def test_private_records_and_malformed_files_do_not_leak(self):
        with INSTALL._observe_update('1.2.3', 'preparing') as progress:
            public = self.jobs()[0]
            self.assertEqual(set(public), {'id', 'version', 'phase', 'startedAt', 'updatedAt', 'download'})
            path = self.progress / f'job-{progress.slot}.json'
            data = json.loads(path.read_bytes())
            data['job']['path'] = '/private/secret'
            path.write_text(json.dumps(data))
            self.assertEqual(INSTALL.read_update_progress(), {'version': 1, 'available': False, 'jobs': []})
            path.unlink()
            path.symlink_to(self.root / 'private')
            self.assertEqual(INSTALL.read_update_progress(), {'version': 1, 'available': False, 'jobs': []})

    def test_narrow_credential_role_does_not_expose_update_progress(self):
        handler = SimpleNamespace(path='/v1/sentinel/update-progress',
            server=SimpleNamespace(service=SimpleNamespace(credentials_only=True)))
        with mock.patch.object(SERVICE.CredentialHandler, 'do_GET') as restricted, \
                mock.patch.object(SERVICE, 'load_script') as load:
            SERVICE.Handler.do_GET(handler)
        restricted.assert_called_once_with(handler)
        load.assert_not_called()

    def test_host_read_route_enforces_peer_and_body_before_accessing_state(self):
        handler = SimpleNamespace(path='/v1/sentinel/update-progress', connection=object(), headers=Message(),
            server=SimpleNamespace(service=SimpleNamespace(credentials_only=False)), send_json=mock.Mock())
        module = SimpleNamespace(read_update_progress=mock.Mock(return_value={'version': 1, 'available': True, 'jobs': []}))
        with mock.patch.object(SERVICE, 'load_script', return_value=module), mock.patch.object(SERVICE, 'trusted_capture_peer') as trusted:
            trusted.return_value = False
            SERVICE.Handler.do_GET(handler)
            self.assertEqual(handler.send_json.call_args.args[0], 403)
            module.read_update_progress.assert_not_called()
            trusted.return_value = True
            handler.headers['Transfer-Encoding'] = 'chunked'
            SERVICE.Handler.do_GET(handler)
            self.assertEqual(handler.send_json.call_args.args[0], 400)
            module.read_update_progress.assert_not_called()
            del handler.headers['Transfer-Encoding']
            SERVICE.Handler.do_GET(handler)
            self.assertEqual(handler.send_json.call_args.args, (200, module.read_update_progress.return_value))
