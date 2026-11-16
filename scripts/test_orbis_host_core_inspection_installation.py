"""Real private-file custody; image metadata and installer authority are fixture seams."""
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


I = load('orbis-host-core-inspection-installation.py', 'installed_inspection_test')
E = load('orbis-host-core-portable-enrollment.py', 'installed_inspection_enrollment_test')
A = load('orbis-host-retained-authority.py', 'installed_inspection_authority_test')
NODE, SOURCE = 'sha256:' + '1' * 64, 'sha256:' + '2' * 64


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='core-inspection-installation-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.code, self.state = self.root / 'approved-code', self.root / 'state'
        for path in (self.code, self.state):
            path.mkdir(mode=0o700)
        self.inventory = {}
        for name in ('core-inspection-worker.mjs', 'core-source-configuration-worker.mjs'):
            body = b'export const fixture = true;\n'
            (self.code / name).write_bytes(body)
            (self.code / name).chmod(0o400)
            self.inventory[name] = {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
        self.enterContext(mock.patch.object(I, 'require_root'))
        self.enterContext(mock.patch.object(A, 'OWNER', os.geteuid()))
        self.enrollment = object.__new__(E.CorePortableEnrollment)
        self.enrollment.state, self.enrollment.root, self.enrollment.context = self.state, self.root, 'fixture'
        self.enrollment.a, self.enrollment.P = A, A.P
        self.enrollment.runtime = mock.Mock()
        self.enrollment.runtime.image.return_value = {'Id': NODE, 'Os': 'linux', 'Architecture': 'arm64', 'Config': {'Volumes': None}}
        self.registry = I.InstalledInspectionRuntime(self.enrollment)
        self.trust = I.C.TrustedCoordinator(NODE, 'arm64', self.code, self.inventory, SOURCE, I.C.PARSER)
        self.sources = {SOURCE: {'parserProfile': I.C.PARSER, 'qualificationSha256': '4' * 64}}
        self.approval = self.approved()

    def approved(self, **changes):
        fields = {'coordinator': self.trust, 'release_sha256': '3' * 64,
                  'inventory_sha256': self.registry.digest(self.inventory), 'qualified_sources': self.sources}
        return I.RootInstallationApproval(**(fields | changes))

    def selection(self):
        return json.loads((self.registry.base / 'current.json').read_bytes())

    def generation(self):
        return self.registry.base / 'generations' / self.selection()['id']

    def test_installer_copies_and_selects_approved_code_without_execution(self):
        installed = self.registry.install(self.approval)
        broker = self.registry.configuration(SOURCE)
        self.assertEqual(broker.code(), self.inventory)
        self.assertNotEqual(broker.trust.code_directory, self.code)
        self.assertEqual(broker.trust.source_controller_image_id, SOURCE)
        self.assertEqual(broker.trust.image_id, NODE)
        self.assertEqual(installed['id'], self.selection()['id'])
        self.assertEqual(installed['installationSha256'], self.selection()['installationSha256'])
        self.enrollment.runtime.engine.assert_not_called()
        self.enrollment.runtime.change.assert_not_called()
        self.assertTrue(all(call.args == (NODE,) for call in self.enrollment.runtime.image.call_args_list))

    def test_missing_installation_is_not_created_by_read(self):
        with self.assertRaises(I.InstallationError):
            self.registry.configuration(SOURCE)
        self.assertFalse(self.registry.base.exists())

    def test_rpc_shaped_approval_is_not_installer_authority(self):
        with self.assertRaises(I.InstallationError):
            self.registry.install({'coordinator': self.trust, 'release_sha256': '3' * 64})
        self.assertFalse(self.registry.base.exists())

    def test_independent_inventory_hash_and_source_qualification_are_required(self):
        for approval in (self.approved(inventory_sha256='f' * 64), self.approved(qualified_sources={}),
                         self.approved(qualified_sources={'sha256:' + '9' * 64: self.sources[SOURCE]})):
            with self.subTest(approval=approval), self.assertRaises(I.InstallationError):
                self.registry.install(approval)
        self.assertFalse(self.registry.base.exists())

    def test_cached_image_platform_or_volume_mismatch_is_not_selected(self):
        image = self.enrollment.runtime.image.return_value
        for replacement in ({**image, 'Architecture': 'amd64'}, {**image, 'Config': {'Volumes': {'/unexpected': {}}}}):
            self.enrollment.runtime.image.return_value = replacement
            with self.assertRaises(ValueError):
                self.registry.install(self.approval)
        self.assertFalse(self.registry.base.exists())

    def test_unknown_source_is_not_qualified_from_its_own_claim(self):
        self.registry.install(self.approval)
        before = (self.registry.base / 'current.json').read_bytes()
        with self.assertRaises(I.InstallationError):
            self.registry.configuration('sha256:' + 'f' * 64)
        self.assertEqual((self.registry.base / 'current.json').read_bytes(), before)

    def test_changed_selected_code_refuses_without_fallback(self):
        self.registry.install(self.approval)
        self.registry.install(self.approval)
        selected = self.generation() / 'code/core-inspection-worker.mjs'
        selected.chmod(0o600)
        selected.write_bytes(b'changed')
        with self.assertRaises(I.InstallationError):
            self.registry.configuration(SOURCE)
        self.assertEqual(len(list((self.registry.base / 'generations').iterdir())), 2)

    def test_replaced_code_symlink_or_hardlink_refuses(self):
        for kind in ('symlink', 'hardlink'):
            self.registry.install(self.approval)
            selected = self.generation() / 'code/core-inspection-worker.mjs'
            selected.unlink()
            if kind == 'symlink':
                selected.symlink_to(self.code / selected.name)
            else:
                os.link(self.code / selected.name, selected)
            with self.subTest(kind=kind), self.assertRaises(I.InstallationError):
                self.registry.configuration(SOURCE)
            selected.unlink()

    def test_interrupted_copy_keeps_previous_selection_and_partial_generation(self):
        self.registry.install(self.approval)
        before = (self.registry.base / 'current.json').read_bytes()
        immutable = self.enrollment.immutable
        def fail_second(path, body):
            if path.name == 'core-source-configuration-worker.mjs':
                raise OSError('fixture interrupted copy')
            return immutable(path, body)
        with mock.patch.object(self.enrollment, 'immutable', side_effect=fail_second):
            with self.assertRaises(I.InstallationError):
                self.registry.install(self.approval)
        self.assertEqual((self.registry.base / 'current.json').read_bytes(), before)
        self.assertEqual(len(list((self.registry.base / 'generations').iterdir())), 2)
        self.assertEqual(self.registry.configuration(SOURCE).code(), self.inventory)

    def test_concurrent_installer_does_not_overwrite_selection(self):
        self.registry.install(self.approval)
        before = (self.registry.base / 'current.json').read_bytes()
        with (self.registry.base / 'install.lock').open('r+b') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(I.InstallationError):
                self.registry.install(self.approval)
        self.assertEqual((self.registry.base / 'current.json').read_bytes(), before)
        self.assertEqual(len(list((self.registry.base / 'generations').iterdir())), 1)

    def test_shared_authority_directory_refuses(self):
        self.registry.install(self.approval)
        self.registry.base.chmod(0o777)
        with self.assertRaises(I.InstallationError):
            self.registry.configuration(SOURCE)

    def test_current_pointer_change_during_read_refuses(self):
        self.registry.install(self.approval)
        original = self.enrollment.read
        count = 0
        def read(path, maximum):
            nonlocal count
            body = original(path, maximum)
            if path.name == 'current.json':
                count += 1
                if count == 2:
                    return body + b' '
            return body
        with mock.patch.object(self.enrollment, 'read', side_effect=read):
            with self.assertRaises(I.InstallationError):
                self.registry.configuration(SOURCE)

    def test_root_job_can_pin_its_approved_generation_across_later_installations(self):
        first = self.registry.install(self.approval)
        self.registry.install(self.approval)
        old = I.InstalledSelection(first['id'], first['installationSha256'])
        broker = self.registry.configuration(SOURCE, old)
        self.assertEqual(broker.installed_selection, old)
        self.assertEqual(broker.trust.code_directory.parent.name, first['id'])
        self.assertNotEqual(self.selection()['id'], first['id'])
        self.assertEqual(broker.code(), self.inventory)

    def test_rpc_shaped_selection_or_revoked_generation_is_not_loaded(self):
        installed = self.registry.install(self.approval)
        with self.assertRaises(I.InstallationError):
            self.registry.configuration(SOURCE, installed)
        (self.generation() / 'revoked.json').write_text('{}')
        with self.assertRaises(I.InstallationError):
            self.registry.configuration(SOURCE)
        with self.assertRaises(I.InstallationError):
            self.registry.configuration(SOURCE, I.InstalledSelection(installed['id'], installed['installationSha256']))

    def test_revocation_serializes_with_admission_and_never_implies_worker_exit(self):
        installed = self.registry.install(self.approval)
        selected = I.InstalledSelection(installed['id'], installed['installationSha256'])
        with self.registry.authority(selected):
            with self.assertRaises(I.InstallationError):
                self.registry.revoke(selected)
            self.assertFalse((self.generation() / 'revoked.json').exists())
        self.registry.revoke(selected)
        with self.assertRaises(I.InstallationError):
            with self.registry.authority(selected):
                self.fail('revoked code must not admit another phase')
        self.assertFalse(self.enrollment.json(self.generation() / 'revoked.json')['workerQuiescenceProved'])
        self.enrollment.runtime.engine.assert_not_called()
        self.enrollment.runtime.change.assert_not_called()


if __name__ == '__main__':
    unittest.main()
