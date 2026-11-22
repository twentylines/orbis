import copy
import contextlib
from contextlib import contextmanager
from contextvars import ContextVar
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


L = load('orbis-host-legacy-ownership.py', 'legacy_ownership_target')
F = load('orbis-host-credential-fence.py', 'legacy_ownership_fence')
P = load('orbis-release-plan.py', 'legacy_ownership_plan')
BUILD = load('orbis-installer-bundle.py', 'legacy_ownership_bundle')
SETUP = load('orbis-host-service-setup.py', 'legacy_ownership_setup')


class LegacyOwnershipTests(unittest.TestCase):
    """Real private files/flocks, explicit Docker/Compose and owner test ports.

    Synthetic authorization records below are fixtures, never native approval.
    """
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='orbis-legacy-')
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name).resolve()
        self.root, self.state = self.folder / 'server', self.folder / 'state'
        self.root.mkdir(mode=0o700); self.state.mkdir(mode=0o700)
        for module in (L, L.B, L.C, L.K, F):
            patch = mock.patch.object(module, 'OWNER', os.geteuid()); patch.start(); self.addCleanup(patch.stop)
        for name in ('RECOVERY', 'RECOVERY_ENV'):
            patch = mock.patch.object(L.B, name, self.folder / name.lower()); patch.start(); self.addCleanup(patch.stop)
        for name, body in (('docker-compose.yml', 'services: {}\n'), ('.env', "SERVER_NAME='fixture-only'\n"), ('VERSION', '4.10.1\n')):
            (self.root / name).write_text(body); (self.root / name).chmod(0o600)
        for name in ('state', 'cache', 'user-config'):
            (self.root / name).mkdir(mode=0o700)

        def legacy(root, purpose):
            suffix = {'host-lock': 'host.lock', 'credential-fence': 'credential-fence.json',
                      'retained-authority': 'retained-authority', 'capture-fence': 'capture-fence.json',
                      'restore-selector': 'retained-restore.json'}[purpose]
            return root.parent / ('.' + root.name + '.orbis-' + suffix)

        def lock_identity(info):
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
                raise ValueError('Fixture lock is not protected')
            return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode'))

        self.layout = SimpleNamespace(STATE_ROOT=self.state, legacy_path=legacy, _lock_identity=lock_identity,
            selected_path=lambda root, purpose: legacy(root, purpose), lock_paths=lambda root: [legacy(root, 'host-lock')],
            namespace=lambda root: self.state / 'installations' / hashlib.sha256(os.fsencode(root)).hexdigest())
        self.host = SimpleNamespace(AUTHORITY=SimpleNamespace(LAYOUT=self.layout), CREDENTIAL_FENCE=F,
            STATE_NAME='.orbis-host-state.json', LOCK_DESCRIPTOR=ContextVar('legacy_review_lock', default=None),
            _require_no_capture_restore_fence=mock.Mock(), saved_state=lambda root: None,
            PLAN=SimpleNamespace(require_installation_protocol=P.require_installation_protocol,
                                 plan=mock.Mock(return_value={'configuredImage': 'ghcr.io/runtipi/runtipi:v4.10.1'})))
        self.host.require_no_capture_fence = lambda root: F.require_clear(self.host, root)
        self.raw = {'Id': 'a' * 64, 'Image': 'sha256:' + 'b' * 64, 'Name': '/runtipi', 'RestartCount': 0,
            'Config': {'Image': 'ghcr.io/runtipi/runtipi:v4.10.1', 'Env': ['SOURCE_ONLY_MARKER=fixture-value'],
                       'Labels': {'com.docker.compose.project': 'runtipi', 'com.docker.compose.service': 'runtipi',
                                  'com.docker.compose.project.working_dir': str(self.root)}},
            'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0}},
            'State': {'Running': True, 'Status': 'running', 'Pid': 1234, 'Paused': False, 'Restarting': False,
                      'Dead': False, 'Health': {'Status': 'healthy'}, 'StartedAt': '2026-01-01T00:00:00Z'},
            'Mounts': [{'Type': 'bind', 'Source': str(self.root / relative), 'Destination': destination, 'RW': True}
                       for destination, relative in (('/data/.env', '.env'), ('/data/state', 'state'), ('/cache', 'cache'))]}
        self.reader = SimpleNamespace(context='local', lock_fd=None, daemon=mock.Mock(return_value='daemon-fixture'),
            containers=mock.Mock(return_value=[{'id': self.raw['Id'], 'name': 'runtipi'}]),
            _object=mock.Mock(side_effect=lambda args: copy.deepcopy(self.raw)))
        self.manifest = {'schema': 'orbis.release.v1', 'image': 'ghcr.io/twentylines/orbis', 'tag': 'v1.0.0',
            'commit': 'c' * 40, 'digest': 'sha256:' + 'd' * 64, 'runtipiCompatibility': '4.10.1',
            'installationProtocol': 'orbis.installation-state.v1'}

    @contextmanager
    def locked(self):
        path = self.layout.legacy_path(self.root, 'host-lock')
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        token = self.host.LOCK_DESCRIPTOR.set(fd); self.reader.lock_fd = fd
        try:
            yield
        finally:
            self.reader.lock_fd = None; self.host.LOCK_DESCRIPTOR.reset(token); os.close(fd)

    def authorization_fixture(self, plan=None):
        plan = plan or L.review(self.host, self.root, self.reader, self.manifest)
        path = L.authorization_path(self.root)
        value = {'schema': L.AUTHORIZATION, 'policy': L.POLICY, 'planSha256': L.K.digest(plan), 'approvalId': 'e' * 64}
        path.write_bytes(L.K.canonical(value) + b'\n'); path.chmod(0o600)
        return path, value

    def snapshot(self):
        return {str(path.relative_to(self.folder)): path.read_bytes() for path in self.folder.rglob('*') if path.is_file()}

    def test_review_is_bound_metadata_only_and_never_creates_authorization(self):
        with self.locked():
            before = self.snapshot()
            plan = L.review(self.host, self.root, self.reader, self.manifest)
            self.assertEqual(plan['controller']['id'], self.raw['Id'])
            self.assertEqual(plan['target']['manifestSha256'], L.K.digest(self.manifest))
            self.assertEqual(plan['rootIdentity'], L.B.root_identity(self.root))
            self.assertEqual(plan['files']['.env'], hashlib.sha256((self.root / '.env').read_bytes()).hexdigest())
            self.assertNotIn('fixture-value', json.dumps(plan)); self.assertNotIn('fixture-only', json.dumps(plan))
            self.assertEqual(self.snapshot(), before)
            self.assertFalse(L.authorization_path(self.root).exists())

    def test_absence_of_every_recovery_file_is_not_positive_authorization(self):
        with self.locked():
            before = self.snapshot()
            with self.assertRaises(FileNotFoundError), L.authorized(self.host, self.root, self.reader, self.manifest):
                self.fail('No Root decision exists')
            self.assertEqual(self.snapshot(), before)

    def test_exact_independent_fixture_yields_only_a_live_decision_witness(self):
        with self.locked():
            path, _ = self.authorization_fixture(); before = self.snapshot()
            with L.authorized(self.host, self.root, self.reader, self.manifest) as proof:
                reference = proof.verify()
                self.assertEqual(reference['authorizationSha256'], hashlib.sha256(path.read_bytes()).hexdigest())
                plan = proof.plan; plan['controller']['id'] = 'f' * 64
                self.assertEqual(proof.verify(), reference)
                self.assertNotIn('operationId', reference)
                self.assertNotIn('admissionBinding', reference)
            self.assertEqual(self.snapshot(), before)
            with self.assertRaises(ValueError): proof.verify()

    def test_approval_shape_policy_plan_and_canonical_bytes_are_exact(self):
        with self.locked():
            path, original = self.authorization_fixture()
            cases = [{**original, 'policy': 'unmanaged'}, {**original, 'planSha256': '0' * 64},
                     {**original, 'approvalId': True}, {**original, 'mode': 'unmanaged'},
                     {**original, 'schema': 'wrong'}]
            for value in cases:
                path.write_bytes(L.K.canonical(value) + b'\n')
                with self.subTest(value=value), self.assertRaises(ValueError), L.authorized(self.host, self.root, self.reader, self.manifest):
                    pass
            path.write_bytes(json.dumps(original, indent=2).encode())
            with self.assertRaises(ValueError), L.authorized(self.host, self.root, self.reader, self.manifest): pass

    def test_old_plan_never_authorizes_changed_daemon_context_controller_epoch_files_or_release(self):
        with self.locked():
            self.authorization_fixture()
            raw, manifest = copy.deepcopy(self.raw), copy.deepcopy(self.manifest)
            cases = [lambda: setattr(self.reader, 'context', 'other'),
                     lambda: setattr(self.reader.daemon, 'return_value', 'other-daemon'),
                     lambda: self.raw['State'].update(Pid=9999), lambda: self.raw.update(RestartCount=1),
                     lambda: self.raw['Config']['Env'].append('ADDITIONAL=fixture'),
                     lambda: self.manifest.update(commit='f' * 40),
                     lambda: (self.root / 'orbis-host-compose.yml').write_text('services: {}\n')]
            for change in cases:
                change()
                with self.assertRaises(ValueError), L.authorized(self.host, self.root, self.reader, self.manifest): pass
                self.reader.context = 'local'; self.reader.daemon.return_value = 'daemon-fixture'
                self.raw = copy.deepcopy(raw); self.manifest = copy.deepcopy(manifest)
                (self.root / 'orbis-host-compose.yml').unlink(missing_ok=True)

    def test_all_managed_partial_retired_and_completed_custody_vetoes_are_preserved(self):
        with self.locked():
            self.authorization_fixture()
            authority, pending = L.B.legacy_journal_paths(self.layout, self.root)
            paths = [*L.B.vetoes(self.host, self.root), L.B.receipt_path(self.root), authority, pending,
                     authority.with_name(authority.name + '.completed.sqlite3'), self.root / self.host.STATE_NAME]
            for path in dict.fromkeys(paths):
                path.parent.mkdir(mode=0o700, parents=True, exist_ok=True); path.write_bytes(b'held-fixture')
                before = self.snapshot()
                with self.subTest(path=path.name), self.assertRaises(ValueError), L.authorized(self.host, self.root, self.reader, self.manifest): pass
                self.assertEqual(self.snapshot(), before)
                path.unlink()

    def test_controller_state_mounts_and_compose_identity_cannot_be_substituted(self):
        with self.locked():
            original = copy.deepcopy(self.raw)
            changes = [lambda: self.raw['State'].update(Running=False, Status='exited', Pid=0),
                       lambda: self.raw['State'].update(Running=1), lambda: self.raw['State'].update(Paused=True),
                       lambda: self.raw['State']['Health'].update(Status='unhealthy'),
                       lambda: self.raw['Config'].update(Image='unreviewed'),
                       lambda: self.raw['Mounts'][0].update(Source=str(self.root / 'other-env')),
                       lambda: self.raw['Mounts'].append(copy.deepcopy(self.raw['Mounts'][0])),
                       lambda: self.raw['Config']['Labels'].update({'com.docker.compose.project.working_dir': '/other'})]
            for change in changes:
                change()
                with self.assertRaises(ValueError): L.review(self.host, self.root, self.reader, self.manifest)
                self.raw = copy.deepcopy(original)
            self.reader.containers.return_value *= 2
            with self.assertRaises(ValueError): L.review(self.host, self.root, self.reader, self.manifest)

    def test_state_and_cache_inode_owner_mode_and_aliases_are_bound(self):
        with self.locked():
            for name in ('state', 'cache'):
                path = self.root / name
                self.authorization_fixture()
                held = self.root / ('held-' + name)
                path.rename(held); path.mkdir(mode=0o700)
                with self.assertRaises(ValueError), L.authorized(self.host, self.root, self.reader, self.manifest): pass
                path.rmdir(); path.symlink_to(held, target_is_directory=True)
                with self.assertRaises(ValueError): L.review(self.host, self.root, self.reader, self.manifest)
                path.unlink(); held.rename(path); path.chmod(0o777)
                with self.assertRaises(ValueError): L.review(self.host, self.root, self.reader, self.manifest)
                path.chmod(0o700)

    def test_symlink_hardlink_or_public_authorization_is_rejected(self):
        with self.locked():
            path, _ = self.authorization_fixture(); body = path.read_bytes()
            path.chmod(0o644)
            with self.assertRaises(ValueError), L.authorized(self.host, self.root, self.reader, self.manifest): pass
            path.chmod(0o600); other = self.folder / 'other'; os.link(path, other)
            with self.assertRaises(ValueError), L.authorized(self.host, self.root, self.reader, self.manifest): pass
            other.unlink(); path.unlink(); other.write_bytes(body); other.chmod(0o600); path.symlink_to(other)
            with self.assertRaises((ValueError, OSError)), L.authorized(self.host, self.root, self.reader, self.manifest): pass

    def test_changed_approval_lock_or_cross_thread_invalidates_live_witness(self):
        with self.locked():
            path, _ = self.authorization_fixture()
            with self.assertRaises(ValueError):
                with L.authorized(self.host, self.root, self.reader, self.manifest) as proof:
                    errors = []
                    thread = threading.Thread(target=lambda: self.capture(errors, proof.verify)); thread.start(); thread.join()
                    self.assertEqual(len(errors), 1)
                    token = self.host.LOCK_DESCRIPTOR.set(None)
                    try:
                        with self.assertRaises(ValueError): proof.verify()
                    finally: self.host.LOCK_DESCRIPTOR.reset(token)
                    body = path.read_bytes(); path.write_bytes(body)
                    with self.assertRaises(ValueError): proof.verify()
                # The context exit also refuses the changed inode metadata.

    @staticmethod
    def capture(errors, callback):
        try: callback()
        except Exception as error: errors.append(error)

    def test_real_installer_lock_and_reader_descriptor_are_required(self):
        with self.assertRaises(ValueError): L.review(self.host, self.root, self.reader, self.manifest)
        with self.locked():
            fd = self.reader.lock_fd; self.reader.lock_fd = None
            with self.assertRaises(ValueError): L.review(self.host, self.root, self.reader, self.manifest)
            self.reader.lock_fd = fd
            path = self.layout.legacy_path(self.root, 'host-lock'); path.rename(path.with_name('retained-lock'))
            path.write_bytes(b''); path.chmod(0o600)
            with self.assertRaises(ValueError): L.review(self.host, self.root, self.reader, self.manifest)

    def test_helper_is_required_by_both_producers_and_present_in_host_copy(self):
        self.assertIn('scripts/orbis-host-legacy-ownership.py', BUILD.REQUIRED)
        self.assertIn('orbis-host-legacy-ownership.py', SETUP.SCRIPTS)

    def cli(self, replacement):
        manifest = self.folder / 'manifest.json'; manifest.write_text(json.dumps(self.manifest))
        arguments = ['legacy-review', 'review', str(self.root), '--docker-context', 'local', '--manifest', str(manifest)]
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(L.os.sys, 'argv', arguments), mock.patch.object(L.os.sys, 'platform', 'linux'), \
                mock.patch.object(L, 'load', return_value=replacement), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = L.main()
        return code, stdout.getvalue(), stderr.getvalue()

    def test_cli_reviews_under_lock_and_checks_publication_without_approving(self):
        @contextmanager
        def locked(root):
            self.assertEqual(root, self.root)
            with self.locked(): yield self.reader.lock_fd
        self.host.host_lock = locked
        replacement = SimpleNamespace(HOST=self.host, UPDATE=SimpleNamespace(verify_release=mock.Mock()),
                                      APPS=SimpleNamespace(Docker=mock.Mock(return_value=self.reader)))
        code, stdout, stderr = self.cli(replacement)
        self.assertEqual(code, 0); self.assertEqual(stderr, '')
        value = json.loads(stdout)
        self.assertEqual(value['planSha256'], L.K.digest(value['plan']))
        self.assertFalse(L.authorization_path(self.root).exists())
        replacement.UPDATE.verify_release.assert_called_once_with(self.manifest)
        replacement.APPS.Docker.assert_called_once_with('local')

    def test_cli_inspection_failures_do_not_print_private_exception_values(self):
        replacement = SimpleNamespace(HOST=self.host,
            UPDATE=SimpleNamespace(verify_release=mock.Mock(side_effect=RuntimeError('SOURCE_ONLY_MARKER=fixture-value'))))
        code, stdout, stderr = self.cli(replacement)
        self.assertEqual(code, 1); self.assertEqual(stdout, '')
        self.assertNotIn('fixture-value', stderr)
        self.assertIn('existing data was preserved', stderr)


class AdoptedLegacyOwnershipTests(unittest.TestCase):
    """Real layout/receipt/dual locks, explicit owner and filesystem ports.

    Layout approval and never-managed decisions are synthetic fixtures, not
    authorization for a real installation. No files are actually chowned.
    """
    def setUp(self):
        self.f = LegacyOwnershipTests('test_review_is_bound_metadata_only_and_never_creates_authorization')
        self.addCleanup(self.f.doCleanups); self.f.setUp()
        f = self.f
        old = f.root
        self.home = f.folder / 'home'; self.home.mkdir(mode=0o775); self.home.chmod(0o775)
        f.root = self.home / 'server'; old.rename(f.root); f.root.chmod(0o775)
        f.raw['Config']['Labels']['com.docker.compose.project.working_dir'] = str(f.root)
        for mount in f.raw['Mounts']:
            mount['Source'] = str(f.root / Path(mount['Source']).relative_to(old))
        for name in ('state', 'cache', 'user-config'):
            (f.root / name).chmod(0o775)
        for name in ('docker-compose.yml', '.env', 'VERSION'):
            (f.root / name).chmod(0o664)
        self.layout = load('orbis-host-layout.py', 'adopted_legacy_actual_layout')
        f.layout = f.host.AUTHORITY.LAYOUT = self.layout
        self.mount = f.folder / 'mountinfo'
        self.mount.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n')
        read = self.layout.read
        for change in (mock.patch.object(self.layout, 'STATE_ROOT', f.state),
                       mock.patch.object(self.layout, '_operator'),
                       mock.patch.object(self.layout, 'read', side_effect=lambda root, daemon=None, context=None, mountinfo=None:
                           read(root, daemon, context, mountinfo or self.mount))):
            change.start(); self.addCleanup(change.stop)
        self.namespace = self.layout.namespace(f.root)

    @contextmanager
    def data_owner(self):
        identities = {(path.stat().st_dev, path.stat().st_ino) for path in
                      (self.home, self.f.root, *self.f.root.rglob('*'))}
        def changed(info):
            if (info.st_dev, info.st_ino) not in identities: return info
            return SimpleNamespace(**{name: (1000 if name == 'st_uid' else getattr(info, name))
                                      for name in dir(info) if name.startswith('st_')})
        original_stat, original_lstat, original_fstat = os.stat, os.lstat, os.fstat
        with mock.patch.object(os, 'stat', side_effect=lambda *a, **k: changed(original_stat(*a, **k))), \
                mock.patch.object(os, 'lstat', side_effect=lambda *a, **k: changed(original_lstat(*a, **k))), \
                mock.patch.object(os, 'fstat', side_effect=lambda *a, **k: changed(original_fstat(*a, **k))):
            yield

    def adopt(self):
        plan = self.layout.review(self.f.root, 'daemon-fixture', 'local', self.mount)
        return self.layout.prepare(self.f.root, 'daemon-fixture', 'local', self.layout.plan_sha256(plan), self.mount)

    @contextmanager
    def locked(self):
        f = self.f
        with F.locked(f.host, f.root, 'local') as guard:
            f.reader.lock_fd = f.host.LOCK_DESCRIPTOR.get()
            try: yield guard
            finally: f.reader.lock_fd = None

    def review(self):
        f = self.f
        return L.review(f.host, f.root, f.reader, f.manifest)

    def decision(self):
        f = self.f
        plan = self.review()
        path = L.authorization_path(f.root, f.host, f.reader)
        value = {'schema': L.AUTHORIZATION, 'policy': L.POLICY, 'planSha256': L.K.digest(plan), 'approvalId': 'e' * 64}
        path.write_bytes(L.K.canonical(value) + b'\n'); path.chmod(0o600)
        return path

    def authorized(self):
        f = self.f
        return L.authorized(f.host, f.root, f.reader, f.manifest)

    def test_real_layout_user_owned_data_and_dual_lock_review_has_no_writes_or_grants(self):
        with self.data_owner():
            self.adopt()
            with self.locked() as guard:
                before = self.f.snapshot(); plan = self.review()
                self.assertEqual(plan['custody']['kind'], 'adopted')
                self.assertEqual(plan['custody']['receipt']['path'], str(self.namespace / 'layout.json'))
                self.assertEqual(plan['rootIdentity'][2], 1000)
                self.assertEqual(plan['dataAncestry'][-2]['uid'], 1000)
                self.assertEqual(plan['storage']['state'][2], 1000)
                self.assertEqual(plan['fileIdentities']['.env'][2], 1000)
                self.assertNotIn('fixture-only', json.dumps(plan)); self.assertNotIn('operationId', plan)
                self.assertEqual(len(guard._descriptors), 2); self.assertIsNone(guard.read())
                self.assertEqual(self.f.snapshot(), before)
                with self.assertRaises(FileNotFoundError), self.authorized(): pass

    def test_only_exact_private_namespace_decision_qualifies_and_never_sibling_fallback(self):
        with self.data_owner():
            self.adopt()
            with self.locked():
                plan = self.review()
                sibling = L.authorization_path(self.f.root)
                value = {'schema': L.AUTHORIZATION, 'policy': L.POLICY, 'planSha256': L.K.digest(plan), 'approvalId': 'e' * 64}
                sibling.write_bytes(L.K.canonical(value) + b'\n'); sibling.chmod(0o600)
                with self.assertRaises(FileNotFoundError), self.authorized(): pass
                path = self.decision(); before = self.f.snapshot()
                with self.authorized() as witness:
                    self.assertEqual(witness.verify()['authorizationSha256'], hashlib.sha256(path.read_bytes()).hexdigest())
                self.assertEqual(self.f.snapshot(), before)
                with self.assertRaises(ValueError): witness.verify()

    def test_partial_or_replaced_layout_never_falls_back_to_legacy(self):
        self.adopt()
        receipt = self.namespace / 'layout.json'; body = receipt.read_bytes()
        for action in ('missing', 'invalid', 'public'):
            with self.subTest(action=action):
                if action == 'missing': receipt.unlink()
                elif action == 'invalid': receipt.write_bytes(b'{}\n')
                else: receipt.chmod(0o644)
                with self.assertRaises((ValueError, OSError)): self.review()
                with self.assertRaises((ValueError, OSError)): L.authorization_path(self.f.root, self.f.host, self.f.reader)
                receipt.write_bytes(body); receipt.chmod(0o600)

    def test_layout_daemon_context_and_ancestry_changes_refuse_existing_decision(self):
        self.adopt()
        with self.locked():
            self.decision()
            self.f.reader.daemon.return_value = 'changed-daemon'
            with self.assertRaises(ValueError), self.authorized(): pass
            self.f.reader.daemon.return_value = 'daemon-fixture'
            self.f.reader.context = 'changed-context'
            with self.assertRaises(ValueError), self.authorized(): pass
            self.f.reader.context = 'local'
            self.home.chmod(0o750)
            with self.assertRaises(ValueError), self.authorized(): pass
            self.home.chmod(0o775)

    def test_orphan_managed_transition_and_hidden_namespace_cohorts_veto_review(self):
        self.adopt()
        with self.locked():
            names = ('credential-journal', '.credential-floor.pending', 'recovery-admission-intent.json',
                     'main-ownership-floor.json', 'controller-handoff', 'existing-ownership-proof.retired.json',
                     'bootstrap-profile.json', 'storage-migration-intent.json',
                     '.orbis-fresh-ownership-' + 'a' * 64 + '-' + 'b' * 64 + '.json',
                     '.orbis-main-ownership-bootstrap.json')
            for name in names:
                path = self.namespace / name; path.write_bytes(b'partial')
                try:
                    with self.subTest(name=name), self.assertRaises(ValueError): self.review()
                finally: path.unlink()
            self.assertEqual(self.review()['custody']['kind'], 'adopted')

    def test_namespace_decision_private_reader_rejects_permissions_links_and_aliases(self):
        self.adopt()
        with self.locked():
            path = self.decision(); body = path.read_bytes()
            path.chmod(0o644)
            with self.assertRaises(ValueError), self.authorized(): pass
            path.chmod(0o600); other = self.f.folder / 'alias'; os.link(path, other)
            with self.assertRaises(ValueError), self.authorized(): pass
            other.unlink(); path.unlink(); other.write_bytes(body); other.chmod(0o600); path.symlink_to(other)
            with self.assertRaises((ValueError, OSError)), self.authorized(): pass

    def test_main_cannot_mount_protected_namespace_even_read_only_or_through_inode_alias(self):
        self.adopt()
        with self.locked():
            for source in (self.namespace, self.namespace / 'layout.json', self.f.state):
                self.f.raw['Mounts'].append({'Type': 'bind', 'Source': str(source), 'Destination': '/authority', 'RW': False})
                try:
                    with self.subTest(source=source.name), self.assertRaises(ValueError): self.review()
                finally: self.f.raw['Mounts'].pop()
            alias = self.f.folder / 'bind-alias'; alias.mkdir()
            self.f.raw['Mounts'].append({'Type': 'bind', 'Source': str(alias), 'Destination': '/authority', 'RW': False})
            identity = L.E.mount_identity
            with mock.patch.object(L.E, 'mount_identity', side_effect=lambda path: identity(self.namespace if Path(path) == alias else path)):
                with self.assertRaises(ValueError): self.review()
            self.f.raw['Mounts'].pop()

    def test_observed_data_replacement_links_or_world_write_invalidate_plan(self):
        self.adopt()
        with self.locked():
            self.decision()
            path = self.f.root / 'VERSION'; held = self.f.root / 'old-version'
            path.rename(held); path.write_bytes(held.read_bytes()); path.chmod(0o664)
            with self.assertRaises(ValueError), self.authorized(): pass
            path.unlink(); path.symlink_to(held)
            with self.assertRaises((ValueError, OSError)): self.review()
            path.unlink(); held.rename(path)
            os.link(path, held)
            with self.assertRaises(ValueError): self.review()
            held.unlink(); path.chmod(0o666)
            with self.assertRaises(ValueError): self.review()
            path.chmod(0o664)
            (self.f.root / 'state').chmod(0o777)
            with self.assertRaises(ValueError): self.review()
            (self.f.root / 'state').chmod(0o775)

    def test_adoption_is_required_before_user_parent_can_be_used_for_control_custody(self):
        with self.data_owner(), self.f.locked():
            with self.assertRaises(ValueError): self.review()
            self.assertFalse(self.namespace.exists())
            self.assertFalse(L.authorization_path(self.f.root).exists())

    def test_data_and_layout_replacements_during_review_cannot_produce_a_plan(self):
        self.adopt()
        with self.locked():
            for name in ('data', 'layout'):
                path = self.f.root / 'VERSION' if name == 'data' else self.namespace / 'layout.json'
                body, mode = path.read_bytes(), stat.S_IMODE(path.stat().st_mode)
                def changed(root, manifest):
                    path.write_bytes(body)
                    return {'configuredImage': 'ghcr.io/runtipi/runtipi:v4.10.1'}
                try:
                    with self.subTest(name=name), mock.patch.object(self.f.host.PLAN, 'plan', side_effect=changed), self.assertRaises(ValueError):
                        self.review()
                finally: path.write_bytes(body); path.chmod(mode)

    def test_optional_file_or_storage_directory_appearing_during_review_is_not_accepted(self):
        self.adopt()
        with self.locked():
            optional = self.f.root / 'orbis-host-compose.yml'
            def appeared(root, manifest):
                optional.write_bytes(b'services: {}\n'); optional.chmod(0o664)
                return {'configuredImage': 'ghcr.io/runtipi/runtipi:v4.10.1'}
            with mock.patch.object(self.f.host.PLAN, 'plan', side_effect=appeared), self.assertRaises(ValueError):
                self.review()
            optional.unlink()
            path, old = self.f.root / 'state', self.f.root / 'old-state'
            def replaced(root, manifest):
                path.rename(old); path.mkdir(mode=0o775)
                return {'configuredImage': 'ghcr.io/runtipi/runtipi:v4.10.1'}
            with mock.patch.object(self.f.host.PLAN, 'plan', side_effect=replaced), self.assertRaises(ValueError):
                self.review()
            path.rmdir(); old.rename(path)

    def test_adopted_fresh_issuer_requires_matching_live_guard_and_reader(self):
        fresh = load('orbis-host-fresh-ownership.py', 'adopted_legacy_fresh_boundary')
        change = mock.patch.object(fresh, 'OWNER', os.geteuid()); change.start(); self.addCleanup(change.stop)
        self.adopt()
        with self.locked() as guard:
            self.decision(); before = self.f.snapshot()
            with mock.patch.object(fresh, 'L', L):
                issuer = fresh.Issuer(self.f.host, self.f.root, self.f.reader, lambda value: value)
                issuer._guard(guard)
                descriptor = self.f.reader.lock_fd; self.f.reader.lock_fd = None
                try:
                    with self.assertRaises(ValueError): issuer._guard(guard)
                finally: self.f.reader.lock_fd = descriptor
            self.assertEqual(self.f.snapshot(), before); self.assertIsNone(guard.read())


if __name__ == '__main__':
    unittest.main()
