import importlib.util
import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest import mock


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RESET = load('orbis-reset-authority')
NEW = load('orbis-install-new')


class AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.root = self.base / 'server'
        self.root.mkdir(mode=0o700)
        self.mountinfo = self.base / 'mountinfo'
        self.mountinfo.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n')
        self.path = RESET.directory(self.root)

    def prepare(self):
        return RESET.prepare(self.root, self.mountinfo)

    def verify(self, binding):
        return RESET.verify(self.root, binding, self.mountinfo)

    def test_private_persistent_sibling_mount(self):
        binding = self.prepare()
        self.assertEqual(self.path.parent, self.root)
        self.assertEqual(self.path.stat().st_mode & 0o7777, 0o700)
        config = NEW.compose(self.root, 'fixture', '/run/docker.sock', 80, 443, {'schema': RESET.SCHEMA})
        self.assertTrue(RESET.require_compose(self.root, config, binding))
        self.assertIn(RESET.compose_mount(self.root), config['services']['runtipi']['volumes'])
        self.assertFalse(RESET.compose_mount(self.root)['bind']['create_host_path'])
        self.assertEqual(self.verify(binding), binding)

    def test_resume_retains_nonempty_recorded_authority(self):
        binding = self.prepare()
        journal = self.path / 'active.json'
        journal.write_bytes(b'pending imported intent')
        lock = self.path / 'operation.lock'
        lock.write_bytes(b'orphan lock')
        self.verify(binding)
        self.assertEqual(journal.read_bytes(), b'pending imported intent')
        self.assertEqual(lock.read_bytes(), b'orphan lock')
        with self.assertRaises(RESET.ResetAuthorityError):
            self.prepare()

    def test_unfamiliar_nonempty_private_directory_is_preserved(self):
        self.path.mkdir(mode=0o700)
        (self.path / 'foreign').write_bytes(b'retain')
        with self.assertRaises(RESET.ResetAuthorityError):
            self.prepare()
        self.assertEqual((self.path / 'foreign').read_bytes(), b'retain')

    def test_existing_empty_private_directory_can_be_bound(self):
        self.path.mkdir(mode=0o700)
        self.verify(self.prepare())

    def test_shared_directory_is_not_chmodded(self):
        self.path.mkdir(mode=0o700)
        self.path.chmod(0o777)
        with self.assertRaises(RESET.ResetAuthorityError):
            self.prepare()
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o777)

    def test_wrong_owner_is_refused(self):
        self.path.mkdir(mode=0o700)
        with mock.patch.object(RESET.os, 'geteuid', return_value=os.geteuid() + 1):
            with self.assertRaises(RESET.ResetAuthorityError):
                self.prepare()

    def test_symlink_file_and_ancestor_symlink_refused(self):
        foreign = self.base / 'foreign'
        foreign.mkdir(mode=0o700)
        self.path.symlink_to(foreign)
        with self.assertRaises(RESET.ResetAuthorityError):
            self.prepare()
        self.path.unlink()
        self.path.write_bytes(b'retain')
        with self.assertRaises(RESET.ResetAuthorityError):
            self.prepare()
        alias = self.base / 'alias'
        alias.symlink_to(self.root)
        with self.assertRaises(RESET.ResetAuthorityError):
            RESET.prepare(alias, self.mountinfo)
        self.assertEqual(self.path.read_bytes(), b'retain')
        self.assertEqual(list(foreign.iterdir()), [])

    def test_shared_parent_refused(self):
        self.root.chmod(0o777)
        with self.assertRaises(RESET.ResetAuthorityError):
            self.prepare()
        self.assertFalse(self.path.exists())

    def test_ephemeral_backing_refused_before_creation(self):
        for fs_type in ('overlay', 'tmpfs', 'ramfs', 'aufs'):
            with self.subTest(fs_type=fs_type):
                self.mountinfo.write_text(f'1 0 8:1 / / rw - {fs_type} none rw\n')
                with self.assertRaises(RESET.ResetAuthorityError):
                    self.prepare()
                self.assertFalse(self.path.exists())

    def test_host_bind_alias_of_shared_subtree_is_refused(self):
        self.path.mkdir(mode=0o700)
        escaped = str(self.path).replace(' ', r'\040')
        self.mountinfo.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n'
                                 + f'2 1 8:1 /state/hidden {escaped} rw - ext4 /dev/test rw\n')
        with self.assertRaises(RESET.ResetAuthorityError):
            self.prepare()

    def test_unrelated_linux_namespace_mount_does_not_reject_durable_backing(self):
        self.mountinfo.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n'
                                 '2 1 0:4 net:[4026532001] /run/docker/netns/proof rw shared:7 - nsfs nsfs rw\n')
        binding = self.prepare()
        self.assertEqual(self.verify(binding), binding)
        for fs_type, namespace in [('ext4', 'net:[4026532001]'), ('nsfs', 'invalid')]:
            self.mountinfo.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n'
                                     f'2 1 0:4 {namespace} /run/docker/netns/proof rw - {fs_type} nsfs rw\n')
            with self.assertRaises(RESET.ResetAuthorityError):
                self.verify(binding)

    def test_stacked_covering_mount_refused(self):
        self.mountinfo.write_text('1 0 8:1 / / rw - ext4 one rw\n2 0 8:2 / / rw - ext4 two rw\n')
        with self.assertRaises(RESET.ResetAuthorityError):
            self.prepare()

    def test_unavailable_malformed_and_oversize_mountinfo_refused(self):
        for data in (b'', b'bad', b'x' * (RESET.MOUNTINFO_LIMIT + 1)):
            self.mountinfo.write_bytes(data)
            with self.assertRaises(RESET.ResetAuthorityError):
                self.prepare()
        self.mountinfo.unlink()
        with self.assertRaises(RESET.ResetAuthorityError):
            self.prepare()

    def test_mount_replacement_refused_even_on_same_filesystem_type(self):
        binding = self.prepare()
        self.mountinfo.write_text('2 0 8:2 / / rw - ext4 /dev/other rw\n')
        with self.assertRaises(RESET.ResetAuthorityError):
            self.verify(binding)

    def test_backing_replacement_refused(self):
        binding = self.prepare()
        self.path.rename(self.root / 'preserved')
        self.path.mkdir(mode=0o700)
        with self.assertRaises(RESET.ResetAuthorityError):
            self.verify(binding)

    def test_root_replacement_during_preparation_is_detected_and_foreign_tree_untouched(self):
        real = RESET.filesystem
        calls = []
        def replace(*args):
            result = real(*args)
            calls.append(1)
            if len(calls) == 1:
                self.root.rename(self.base / 'preserved')
                self.root.mkdir(mode=0o700)
            return result
        with mock.patch.object(RESET, 'filesystem', side_effect=replace):
            with self.assertRaises(RESET.ResetAuthorityError):
                self.prepare()
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertTrue((self.base / 'preserved/orbis-reset').is_dir())

    def test_mount_change_during_preparation_refused(self):
        with mock.patch.object(RESET, 'filesystem', side_effect=[{'identity': 'one'}, {'identity': 'one'}, {'identity': 'two'}, {'identity': 'two'}]):
            with self.assertRaises(RESET.ResetAuthorityError):
                self.prepare()

    def test_missing_binding_never_creates_or_enables_authority(self):
        config = NEW.compose(self.root, 'fixture', '/run/docker.sock', 80, 443, {'schema': RESET.SCHEMA})
        with self.assertRaises(RESET.ResetAuthorityError):
            RESET.require_compose(self.root, config, None)
        self.assertFalse(RESET.require_compose(self.root, {'services': {}}, None))
        self.assertFalse(self.path.exists())

    def test_compose_duplicate_wrong_source_autocreate_and_readonly_refused(self):
        binding = self.prepare()
        mount = RESET.compose_mount(self.root)
        for mounts in ([mount, mount], [{**mount, 'source': str(self.root / 'state/orbis-reset')}],
                       [{**mount, 'bind': {'create_host_path': True}}], [{**mount, 'read_only': True}], [mount, {**mount, 'target': RESET.TARGET + '/active.json'}], []):
            with self.subTest(mounts=mounts), self.assertRaises(RESET.ResetAuthorityError):
                RESET.require_compose(self.root, {'services': {'runtipi': {'volumes': mounts}}}, binding)

    def test_runtime_mount_must_match_dedicated_writable_private_bind(self):
        mount = {'Type': 'bind', 'Source': str(self.path), 'Destination': RESET.TARGET, 'RW': True, 'Propagation': 'rprivate'}
        RESET.require_runtime(self.root, [mount])
        for mounts in ([], [mount, mount], [{**mount, 'Type': 'volume'}], [{**mount, 'Source': str(self.root / 'state')}],
                       [{**mount, 'RW': False}], [{**mount, 'Propagation': 'shared'}], [mount, {**mount, 'Destination': RESET.TARGET + '/active.json'}]):
            with self.subTest(mounts=mounts), self.assertRaises(RESET.ResetAuthorityError):
                RESET.require_runtime(self.root, mounts)

    def test_new_transaction_without_binding_stops_before_mutation(self):
        run = self.base / 'run'
        (run / 'files').mkdir(parents=True)
        config = NEW.compose(self.root, 'fixture', '/run/docker.sock', 80, 443, {'schema': RESET.SCHEMA})
        body = json.dumps(config).encode()
        (run / 'files/docker-compose.yml').write_bytes(body)
        journal = run / 'transaction.json'
        NEW.APPS.write_journal(self.root / '.orbis-installation.json', {'journal': str(journal), 'dockerContext': 'test', 'root': str(self.root)})
        record = {'root': str(self.root), 'daemon': 'selected', 'stage': 'prepared', 'files': {'docker-compose.yml': NEW.hashlib.sha256(body).hexdigest()}}
        with mock.patch.object(NEW.APPS, 'digest_daemon', return_value='selected'), mock.patch.object(NEW.PROXY, 'initialize') as initialize, mock.patch.object(NEW.HOST, 'docker') as docker:
            with self.assertRaises(ValueError):
                NEW.finish(record, mock.Mock(context='test'), journal)
            initialize.assert_not_called()
            docker.assert_not_called()
        self.assertFalse(self.path.exists())

    def finish_fixture(self):
        binding = self.prepare()
        config = NEW.compose(self.root, 'fixture', '/run/docker.sock', 80, 443, {'schema': RESET.SCHEMA})
        files = {'docker-compose.yml': json.dumps(config).encode(), 'orbis-compose.yml': b'fixture',
                 'VERSION': b'4.10.1', '.env': b'preserve server generated environment'}
        for name, body in files.items():
            (self.root / name).write_bytes(body)
            (self.root / name).chmod(0o600)
        run = self.base / 'run'
        run.mkdir()
        journal = run / 'transaction.json'
        NEW.APPS.write_journal(self.root / '.orbis-installation.json', {'journal': str(journal), 'dockerContext': 'test', 'root': str(self.root)})
        ownership = {'fixture': 'protected ownership'}
        ownership_hash = NEW.hashlib.sha256(NEW.PROXY.P.canonical(ownership)).hexdigest()
        record = {'root': str(self.root), 'daemon': 'selected', 'stage': 'starting', 'resetAuthority': binding,
                  'manifest': {'image': 'fixture', 'digest': 'sha256:' + 'a' * 64, 'tag': 'fixture'},
                  'proxyHostIdentitySha256': ownership_hash,
                  'files': {name: NEW.hashlib.sha256(body).hexdigest() for name, body in files.items()}}
        NEW.APPS.write_journal(journal, record)
        return record, journal, ownership

    def run_finish(self, record, journal, ownership, docker, isolation=None):
        verify = NEW.RESET.verify
        with mock.patch.object(NEW.APPS, 'digest_daemon', return_value='selected'), \
             mock.patch.object(NEW.PROXY, 'owned', return_value=ownership), \
             mock.patch.object(NEW.PROXY, 'observe_current', return_value={'mutableIdentity': {'ownershipSha256': record['proxyHostIdentitySha256']}}), \
             mock.patch.object(NEW.RESET, 'verify', side_effect=lambda root, binding: verify(root, binding, self.mountinfo)), \
             mock.patch.object(NEW.RESET, 'require_docker_isolation', side_effect=isolation), \
             mock.patch.object(NEW.HOST, 'docker', side_effect=docker), \
             mock.patch.object(NEW.HOST, 'current_core', return_value={'state': 'running', 'health': 'healthy', 'image': NEW.REPLACE.target_image(record['manifest'])}), \
             mock.patch.object(NEW.HOST, 'installation_fingerprint', return_value={}), \
             mock.patch.object(NEW.HOST, 'write_state'):
            return NEW.finish(record, SimpleNamespace(context='test', core=lambda _: {'id': 'a' * 64}), journal)

    def test_failed_start_resumes_without_losing_journal_or_environment(self):
        record, journal, ownership = self.finish_fixture()
        pending = self.path / 'active.json'
        pending.write_bytes(b'preserved pending intent')
        def failed(*args):
            return SimpleNamespace(returncode=1)
        with self.assertRaises(RuntimeError):
            self.run_finish(record, journal, ownership, failed)
        self.assertEqual(json.loads(journal.read_bytes())['stage'], 'starting')
        mount = {'Type': 'bind', 'Source': str(self.path), 'Destination': RESET.TARGET, 'RW': True, 'Propagation': 'rprivate'}
        calls = []
        def healthy(context, args, root):
            calls.append(args)
            return SimpleNamespace(returncode=0, stdout=json.dumps([mount]))
        result = self.run_finish(record, journal, ownership, healthy)
        self.assertEqual(result['result'], 'orbis-installed')
        self.assertEqual(json.loads(journal.read_bytes())['stage'], 'complete')
        self.assertEqual(pending.read_bytes(), b'preserved pending intent')
        self.assertEqual((self.root / '.env').read_bytes(), b'preserve server generated environment')
        self.assertTrue(any('{{json .Mounts}}' in args for args in calls))

    def test_healthy_controller_with_missing_runtime_mount_is_not_enrolled(self):
        record, journal, ownership = self.finish_fixture()
        with self.assertRaises(ValueError):
            self.run_finish(record, journal, ownership, lambda *args: SimpleNamespace(returncode=0, stdout='[]'))
        self.assertEqual(json.loads(journal.read_bytes())['stage'], 'starting')

    def test_healthy_controller_with_other_reset_writer_is_not_enrolled(self):
        record, journal, ownership = self.finish_fixture()
        mount = {'Type': 'bind', 'Source': str(self.path), 'Destination': RESET.TARGET, 'RW': True, 'Propagation': 'rprivate'}
        with self.assertRaises(NEW.RESET.ResetAuthorityError):
            self.run_finish(record, journal, ownership,
                            lambda *args: SimpleNamespace(returncode=0, stdout=json.dumps([mount])),
                            isolation=NEW.RESET.ResetAuthorityError('another writable mount'))
        self.assertEqual(json.loads(journal.read_bytes())['stage'], 'starting')

class ExternalAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.root = self.base / 'server'
        self.root.mkdir(mode=0o700)
        self.control = self.base / 'control'
        self.mountinfo = self.base / 'mountinfo'
        self.mountinfo.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n')
        self.patch = mock.patch.object(RESET, 'CONTROL_ROOT', self.control)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.path = RESET.external_directory(self.root)

    def prepare(self):
        return RESET.prepare_external(self.root, 'daemon-a', 'local', self.mountinfo)

    def verify(self, binding, daemon='daemon-a', context='local'):
        return RESET.verify(self.root, binding, self.mountinfo, daemon=daemon, context=context)

    def review(self):
        return RESET.review_external_legacy(self.root, 'daemon-a', 'local', self.mountinfo)

    def reviewed_prepare(self, plan):
        return RESET.prepare_external_reviewed(self.root, 'daemon-a', 'local', RESET.review_plan_sha256(plan), self.mountinfo)

    def test_reviewed_legacy_enrollment_requires_exact_plan_and_preserves_root(self):
        self.root.chmod(0o775)
        before = self.root.stat()
        plan = self.review()
        self.assertEqual(plan, self.review())
        self.assertEqual(plan['ancestry'][-1]['uid'], before.st_uid)
        self.assertEqual(plan['ancestry'][-1]['mode'], 0o775)
        with self.assertRaises(RESET.ResetAuthorityError):
            RESET.prepare_external_reviewed(self.root, 'daemon-a', 'local', '0' * 64, self.mountinfo)
        self.assertFalse(self.control.exists())
        binding = self.reviewed_prepare(plan)
        self.assertEqual(binding['schema'], RESET.SCHEMA_V4)
        self.assertEqual(self.root.stat().st_mode, before.st_mode)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.path.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.path.parent / 'enrollment.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.verify(binding), binding)
        self.mountinfo.write_text('29 7 8:1 / / rw - ext4 /dev/test rw\n')
        self.assertEqual(self.verify(binding), binding)
        mount = RESET.compose_mount(self.root, binding=binding)
        self.assertTrue(RESET.require_compose(self.root, {'services': {'runtipi': {'volumes': [mount]}}}, binding))
        runtime = {'Type': 'bind', 'Source': str(self.path), 'Destination': RESET.TARGET, 'RW': True, 'Propagation': 'rprivate'}
        RESET.require_runtime(self.root, [runtime], binding)
        with self.assertRaises(RESET.ResetAuthorityError):
            RESET.require_no_enrollment_aliases(self.root, [{'Type': 'bind', 'Source': str(self.path.parent), 'RW': True}], binding)
        with mock.patch.object(RESET, 'filesystem', side_effect=lambda path, mountinfo=None: {'path': '/', 'fsType': 'ext4', 'identity': '29 7 8:1 / / rw - ext4 /dev/test rw'}):
            self.assertEqual(RESET.read_external_enrollment(self.root, 'daemon-a', 'local'), binding)
        with self.assertRaises(RESET.ResetAuthorityError): self.reviewed_prepare(plan)

    def test_reviewed_plan_detects_changed_approval_ancestry_and_root(self):
        self.root.chmod(0o775)
        plan = self.review()
        self.root.chmod(0o750)
        with self.assertRaises(RESET.ResetAuthorityError): self.reviewed_prepare(plan)
        self.assertFalse(self.control.exists())
        self.root.chmod(0o775)
        # Shared filesystems may report a new inode after chmod; approve the new observation.
        plan = self.review()
        binding = self.reviewed_prepare(plan)
        for daemon, context in [('other', 'local'), ('daemon-a', 'other')]:
            with self.assertRaises(RESET.ResetAuthorityError): self.verify(binding, daemon, context)
        self.base.chmod(0o750)
        with self.assertRaises(RESET.ResetAuthorityError): self.verify(binding)
        self.base.chmod(0o700)
        self.root.rename(self.base / 'old-server')
        self.root.mkdir(mode=0o775)
        with self.assertRaises(RESET.ResetAuthorityError): self.verify(binding)

    def test_review_rejects_symlink_and_world_writable_ancestry(self):
        link = self.base / 'link'
        link.symlink_to(self.root)
        with self.assertRaises(RESET.ResetAuthorityError):
            RESET.review_external_legacy(link, 'daemon-a', 'local', self.mountinfo)
        self.root.chmod(0o777)
        with self.assertRaises(RESET.ResetAuthorityError): self.review()
        self.root.chmod(0o700)
        self.base.chmod(0o777)
        with self.assertRaises(RESET.ResetAuthorityError): self.review()

    def test_reviewed_requires_private_control_parent(self):
        self.control.mkdir(mode=0o755)
        self.control.chmod(0o755)
        plan = self.review()
        with self.assertRaises(RESET.ResetAuthorityError): self.reviewed_prepare(plan)
        self.assertFalse(self.path.parent.exists())
        self.control.chmod(0o700)
        binding = self.reviewed_prepare(plan)
        self.control.chmod(0o755)
        with self.assertRaises(RESET.ResetAuthorityError): self.verify(binding)

    def test_reviewed_rejects_mount_changes_and_untrusted_enrollment(self):
        plan = self.review()
        self.mountinfo.write_text('1 0 8:1 / / ro - ext4 /dev/test ro\n')
        with self.assertRaises(RESET.ResetAuthorityError): self.reviewed_prepare(plan)
        self.mountinfo.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n')
        binding = self.reviewed_prepare(plan)
        for line in ('2 0 8:2 / / rw - ext4 /dev/test rw\n', '2 0 8:1 / / rw - ext4 /dev/other rw\n', '2 0 8:1 / / ro - ext4 /dev/test ro\n'):
            self.mountinfo.write_text(line)
            with self.assertRaises(RESET.ResetAuthorityError): self.verify(binding)
        self.mountinfo.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n')
        (self.path.parent / 'enrollment.json').chmod(0o644)
        with self.assertRaises(RESET.ResetAuthorityError): self.verify(binding)

    def test_durable_receipt_and_resume(self):
        binding = self.prepare()
        self.assertEqual(json.loads((self.path.parent / 'enrollment.json').read_bytes()), binding)
        self.assertEqual((self.path.parent / 'enrollment.json').stat().st_mode & 0o777, 0o600)
        (self.path / 'active.json').write_bytes(b'pending')
        self.assertEqual(self.verify(binding), binding)
        self.assertEqual((self.path / 'active.json').read_bytes(), b'pending')
        with self.assertRaises(RESET.ResetAuthorityError):
            self.prepare()

    def test_frozen_v2_binding_still_refuses_changed_session_mount_ids(self):
        binding = self.prepare()
        self.mountinfo.write_text('29 7 8:1 / / rw - ext4 /dev/test rw\n')
        with self.assertRaises(RESET.ResetAuthorityError):
            self.verify(binding)

    def test_v3_persists_across_session_mount_ids_without_rewriting_enrollment(self):
        binding = RESET.prepare_external_durable(self.root, 'daemon-a', 'local', self.mountinfo)
        receipt = self.path.parent / 'enrollment.json'
        before = receipt.read_bytes()
        self.mountinfo.write_text('29 7 8:1 / / rw - ext4 /dev/test rw\n')
        self.assertEqual(self.verify(binding), binding)
        self.assertEqual(receipt.read_bytes(), before)

    def test_v3_still_refuses_changed_filesystem_source_flags_and_mount_root(self):
        binding = RESET.prepare_external_durable(self.root, 'daemon-a', 'local', self.mountinfo)
        for line in ('29 7 8:2 / / rw - ext4 /dev/test rw\n',
                     '29 7 8:1 / / ro - ext4 /dev/test ro\n',
                     '29 7 8:1 /alias / rw - ext4 /dev/test rw\n',
                     '29 7 8:1 / / rw - ext4 /dev/other rw\n'):
            self.mountinfo.write_text(line)
            with self.subTest(line=line), self.assertRaises(RESET.ResetAuthorityError):
                self.verify(binding)

    def test_changed_root_daemon_and_context_fail(self):
        binding = self.prepare()
        for daemon, context in [('daemon-b', 'local'), ('daemon-a', 'other')]:
            with self.assertRaises(RESET.ResetAuthorityError):
                self.verify(binding, daemon, context)
        self.root.rename(self.base / 'old-server')
        self.root.mkdir(mode=0o700)
        with self.assertRaises(RESET.ResetAuthorityError):
            self.verify(binding)
        with self.assertRaises(RESET.ResetAuthorityError):
            self.prepare()

    def test_replacement_receipt_backing_permissions_and_mount_fail(self):
        binding = self.prepare()
        receipt = self.path.parent / 'enrollment.json'
        receipt.chmod(0o644)
        with self.assertRaises(RESET.ResetAuthorityError): self.verify(binding)
        receipt.chmod(0o600)
        original = receipt.read_bytes()
        receipt.write_bytes(b'{}')
        with self.assertRaises(RESET.ResetAuthorityError): self.verify(binding)
        receipt.write_bytes(original)
        self.path.chmod(0o755)
        with self.assertRaises(RESET.ResetAuthorityError): self.verify(binding)
        self.path.chmod(0o700)
        self.mountinfo.write_text('2 0 8:2 / / rw - ext4 /dev/other rw\n')
        with self.assertRaises(RESET.ResetAuthorityError): self.verify(binding)
        self.mountinfo.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n')
        self.path.rename(self.path.parent / 'preserved')
        self.path.mkdir(mode=0o700)
        with self.assertRaises(RESET.ResetAuthorityError): self.verify(binding)

    def test_unfamiliar_or_interrupted_namespace_never_adopted(self):
        self.path.mkdir(mode=0o700, parents=True)
        (self.path / 'foreign').write_bytes(b'retain')
        with self.assertRaises(RESET.ResetAuthorityError): self.prepare()
        self.assertEqual((self.path / 'foreign').read_bytes(), b'retain')
        with self.assertRaises(RESET.ResetAuthorityError): self.verify({'schema': RESET.SCHEMA_V2, 'path': str(self.path)})

    def test_symlink_shared_and_ephemeral_rejected(self):
        self.control.mkdir(mode=0o777)
        self.control.chmod(0o777)
        with self.assertRaises(RESET.ResetAuthorityError): self.prepare()
        self.control.chmod(0o700)
        self.mountinfo.write_text('1 0 8:1 / / rw - tmpfs none rw\n')
        with self.assertRaises(RESET.ResetAuthorityError): self.prepare()
        self.assertFalse(self.path.exists())
        self.mountinfo.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n')
        self.control.rmdir()
        foreign = self.base / 'foreign'
        foreign.mkdir(mode=0o700)
        self.control.symlink_to(foreign)
        with self.assertRaises(RESET.ResetAuthorityError): self.prepare()
        self.assertEqual(list(foreign.iterdir()), [])

    def test_alias_and_wrong_mount_refused(self):
        self.control.mkdir(mode=0o700)
        escaped = str(self.path).replace(' ', r'\040')
        self.mountinfo.write_text('1 0 8:1 / / rw - ext4 /dev/test rw\n' + f'2 1 8:1 /shared {escaped} rw - ext4 /dev/test rw\n')
        with self.assertRaises(RESET.ResetAuthorityError): self.prepare()
        self.assertFalse(self.path.exists())

    def test_missing_or_symlinked_receipt_and_overlap_fail_closed(self):
        binding = self.prepare()
        receipt = self.path.parent / 'enrollment.json'
        receipt.rename(self.path.parent / 'preserved-receipt')
        with self.assertRaises(RESET.ResetAuthorityError): self.verify(binding)
        receipt.symlink_to(self.path.parent / 'preserved-receipt')
        with self.assertRaises(RESET.ResetAuthorityError): self.verify(binding)
        with self.assertRaises(RESET.ResetAuthorityError): RESET.external_directory(self.base)

    def test_binding_drives_compose_and_runtime(self):
        binding = self.prepare()
        mount = RESET.compose_mount(self.root, binding=binding)
        self.assertTrue(RESET.require_compose(self.root, {'services': {'runtipi': {'volumes': [mount]}}}, binding))
        runtime = {'Type': 'bind', 'Source': str(self.path), 'Destination': RESET.TARGET, 'RW': True, 'Propagation': 'rprivate'}
        RESET.require_runtime(self.root, [runtime], binding)
        with self.assertRaises(RESET.ResetAuthorityError):
            RESET.require_runtime(self.root, [{**runtime, 'Source': str(self.root / 'orbis-reset')}], binding)

    def test_runtime_rejects_writable_enrollment_ancestors_and_data_aliases(self):
        binding = self.prepare()
        runtime = {'Type': 'bind', 'Source': str(self.path), 'Destination': RESET.TARGET, 'RW': True, 'Propagation': 'rprivate'}
        for source in (self.path, self.path.parent, self.path.parent.parent, self.path.parent / 'enrollment.json'):
            alias = {'Type': 'bind', 'Source': str(source), 'Destination': '/other', 'RW': True, 'Propagation': 'rprivate'}
            with self.subTest(source=source), self.assertRaises(RESET.ResetAuthorityError):
                RESET.require_runtime(self.root, [runtime, alias], binding)
            with self.assertRaises(RESET.ResetAuthorityError):
                RESET.require_no_enrollment_aliases(self.root, [alias], binding)
        readonly = {'Type': 'bind', 'Source': str(self.path.parent), 'Destination': '/readonly', 'RW': False}
        RESET.require_runtime(self.root, [runtime, readonly], binding)

    def test_other_containers_cannot_expose_enrollment_or_backing_for_writing(self):
        binding = self.prepare()
        controller, other = 'a' * 64, 'b' * 64
        runtime = {'Type': 'bind', 'Source': str(self.path), 'Destination': RESET.TARGET, 'RW': True, 'Propagation': 'rprivate'}
        reader = mock.Mock()
        reader.daemon.return_value = 'selected-daemon'
        # The all-container inventory includes stopped containers: their mount
        # definitions are hazardous even before a restart policy starts them.
        reader.containers.return_value = [{'id': controller}, {'id': other, 'state': 'exited'}]
        other_mount = {'Type': 'bind', 'Source': str(self.path.parent), 'Destination': '/host', 'RW': False}
        reader.core.side_effect = lambda identifier: {'id': identifier, 'mounts': [runtime] if identifier == controller else [other_mount]}
        RESET.require_docker_isolation(self.root, reader, binding, controller)
        for source in (self.path, self.path.parent, self.path.parent.parent, self.path.parent / 'enrollment.json'):
            with self.subTest(source=source):
                other_mount.update(Source=str(source), RW=True)
                with self.assertRaises(RESET.ResetAuthorityError):
                    RESET.require_docker_isolation(self.root, reader, binding, controller)

    def test_docker_isolation_rejects_missing_replaced_or_changing_inventory(self):
        binding = self.prepare()
        controller, other = 'a' * 64, 'b' * 64
        runtime = {'Type': 'bind', 'Source': str(self.path), 'Destination': RESET.TARGET, 'RW': True, 'Propagation': 'rprivate'}
        reader = mock.Mock()
        reader.daemon.return_value = 'selected-daemon'
        reader.containers.return_value = []
        with self.assertRaises(RESET.ResetAuthorityError):
            RESET.require_docker_isolation(self.root, reader, binding, controller)
        reader.containers.return_value = [{'id': controller}]
        reader.core.return_value = {'id': other, 'mounts': [runtime]}
        with self.assertRaises(RESET.ResetAuthorityError):
            RESET.require_docker_isolation(self.root, reader, binding, controller)
        reader.core.return_value = {'id': controller, 'mounts': [runtime]}
        reader.containers.side_effect = [[{'id': controller}], [{'id': controller}, {'id': other}]]
        with self.assertRaises(RESET.ResetAuthorityError):
            RESET.require_docker_isolation(self.root, reader, binding, controller)
        reader.containers.side_effect = None
        reader.daemon.side_effect = ['selected-daemon', 'changed-daemon']
        with self.assertRaises(RESET.ResetAuthorityError):
            RESET.require_docker_isolation(self.root, reader, binding, controller)


    def test_interrupted_creation_never_automatically_recreates(self):
        real_open = RESET.os.open
        def fail_receipt(path, *args, **kwargs):
            if path == 'enrollment.json':
                raise OSError('injected failure')
            return real_open(path, *args, **kwargs)
        with mock.patch.object(RESET.os, 'open', side_effect=fail_receipt):
            with self.assertRaises(RESET.ResetAuthorityError): self.prepare()
        self.assertTrue(self.path.is_dir())
        with self.assertRaises(RESET.ResetAuthorityError): self.prepare()

    def test_v2_start_failure_and_resume_preserves_intent(self):
        with mock.patch.object(NEW.RESET, 'CONTROL_ROOT', self.control):
            binding = NEW.RESET.prepare_external(self.root, 'daemon-a', 'local', self.mountinfo)
            config = NEW.compose(self.root, 'fixture', '/run/docker.sock', 80, 443)
            files = {'docker-compose.yml': json.dumps(config).encode(), 'orbis-compose.yml': b'fixture',
                     'VERSION': b'4.10.1', '.env': b'private environment'}
            for name, body in files.items():
                (self.root / name).write_bytes(body)
                (self.root / name).chmod(0o600)
            run = self.base / 'run'
            run.mkdir()
            journal = run / 'transaction.json'
            NEW.APPS.write_journal(self.root / '.orbis-installation.json', {'journal': str(journal), 'dockerContext': 'local', 'root': str(self.root)})
            ownership = {'fixture': 'protected ownership'}
            ownership_hash = NEW.hashlib.sha256(NEW.PROXY.P.canonical(ownership)).hexdigest()
            record = {'root': str(self.root), 'daemon': 'daemon-a', 'stage': 'starting', 'resetAuthority': binding,
                      'manifest': {'image': 'fixture', 'digest': 'sha256:' + 'a' * 64, 'tag': 'fixture'},
                      'proxyHostIdentitySha256': ownership_hash,
                      'files': {name: NEW.hashlib.sha256(body).hexdigest() for name, body in files.items()}}
            NEW.APPS.write_journal(journal, record)
            (self.path / 'active.json').write_bytes(b'pending')
            verify = NEW.RESET.verify
            mount = {'Type': 'bind', 'Source': str(self.path), 'Destination': RESET.TARGET, 'RW': True, 'Propagation': 'rprivate'}
            docker = mock.Mock(return_value=SimpleNamespace(returncode=1))
            with mock.patch.object(NEW.APPS, 'digest_daemon', return_value='daemon-a'), \
                 mock.patch.object(NEW.PROXY, 'owned', return_value=ownership), \
                 mock.patch.object(NEW.PROXY, 'observe_current', return_value={'mutableIdentity': {'ownershipSha256': ownership_hash}}), \
                 mock.patch.object(NEW.RESET, 'verify', side_effect=lambda root, binding, **kwargs: verify(root, binding, self.mountinfo, **kwargs)), \
                 mock.patch.object(NEW.RESET, 'require_docker_isolation'), \
                 mock.patch.object(NEW.HOST, 'docker', docker), \
                 mock.patch.object(NEW.HOST, 'current_core', return_value={'state': 'running', 'health': 'healthy', 'image': NEW.REPLACE.target_image(record['manifest'])}), \
                 mock.patch.object(NEW.HOST, 'installation_fingerprint', return_value={}), \
                 mock.patch.object(NEW.HOST, 'write_state'):
                reader = SimpleNamespace(context='local', core=lambda _: {'id': 'a' * 64})
                with self.assertRaises(RuntimeError): NEW.finish(record, reader, journal)
                self.assertEqual(json.loads(journal.read_bytes())['stage'], 'starting')
                docker.return_value = SimpleNamespace(returncode=0, stdout=json.dumps([mount]))
                self.assertEqual(NEW.finish(record, reader, journal)['result'], 'orbis-installed')
            self.assertEqual((self.path / 'active.json').read_bytes(), b'pending')
            self.assertEqual(json.loads((self.path.parent / 'enrollment.json').read_bytes()), binding)


if __name__ == '__main__':
    unittest.main()
