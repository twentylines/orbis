import importlib.util
import json
import os
import tempfile
import unittest
import uuid
from contextlib import ExitStack, contextmanager, nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SPEC = importlib.util.spec_from_file_location("orbis_host_service_upgrade", Path(__file__).with_name("orbis-host-service-upgrade.py"))
assert SPEC and SPEC.loader
UPGRADE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPGRADE)


class OrbisHostServiceUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def test_interrupted_component_copy_uses_exact_bound_maintenance_and_leaves_workspace(self):
        root = self.base / 'install'
        workspace = self.base / 'workspace'
        workspace.mkdir(mode=0o700)
        file = self.base / 'helper-maintenance.json'
        binding = {'operationId': str(uuid.uuid4()), 'planSha256': 'a' * 64, 'targetDigest': 'sha256:' + 'b' * 64}
        selection = {'directory': str(self.base / 'source'), 'selectionSha256': 'c' * 64, 'executionSha256': 'd' * 64}
        prior = {'inventory': {'prior.py': 'e' * 64}, 'unitSha256': 'f' * 64}
        candidate = {'inventory': {'target.py': '1' * 64}, 'unitSha256': '2' * 64}
        target = {'host': candidate, 'selectionDirectory': selection['directory'],
                  'sourceSelectionSha256': selection['selectionSha256'], 'sourceExecutionSha256': selection['executionSha256']}
        record = {'componentUpgrade': binding, 'stage': 'stopped', 'environmentSha256': '3' * 64,
                  'previousDigest': 'sha256:' + '4' * 64, 'sourceCustody': {'selection': selection,
                  'prior': prior, 'candidate': candidate}}
        UPGRADE.SERVICE.write_private(file, record)
        def returned(*args):
            UPGRADE.SERVICE.write_private(file, {**record, 'stage': 'restored'})
        with (mock.patch.multiple(UPGRADE, MAINTENANCE=file, STATE_DIR=self.base),
              mock.patch.object(UPGRADE.os, 'geteuid', return_value=0),
              mock.patch.object(UPGRADE.HOST, 'host_lock', return_value=nullcontext()),
              mock.patch.object(UPGRADE.SETUP, 'hold_source_selection', return_value=nullcontext({**selection, 'inventory': {}})),
              mock.patch.object(UPGRADE, 'workspace_from_record', return_value=workspace),
              mock.patch.object(UPGRADE, 'require_maintenance_identity'),
              mock.patch.object(UPGRADE, 'restore_previous', side_effect=returned) as restore):
            with self.assertRaisesRegex(ValueError, 'different execution custody'):
                UPGRADE.restore_interrupted_component_copy(root, 'ctx', record, binding,
                    {**target, 'sourceExecutionSha256': '9' * 64}, prior, record['previousDigest'],
                    record['environmentSha256'], lock_fds=(9, 10))
            restore.assert_not_called()
            UPGRADE.restore_interrupted_component_copy(root, 'ctx', record, binding, target, prior,
                record['previousDigest'], record['environmentSha256'], lock_fds=(9, 10))
            restore.assert_called_once_with(workspace, record['previousDigest'], root, 'ctx')
        self.assertFalse(file.exists())
        self.assertTrue(workspace.is_dir())

    def test_custodied_rollback_refuses_crossed_prior_and_persists_exact_restored_copy(self):
        root = self.base / "installation"
        root.mkdir()
        extraction = self.base / "selected"
        extraction.mkdir(mode=0o700)
        receipts = extraction / "host-copy-custody"
        receipts.mkdir(mode=0o700)
        workspace = self.base / "workspace"
        workspace.mkdir(mode=0o700)
        prior = workspace / "previous"
        prior.mkdir(mode=0o700)
        installed = self.base / "host-service"
        installed.mkdir(mode=0o700)
        unit = self.base / "orbis-host.service"
        previous_unit = workspace / "previous-unit"
        prior_source = prior / "orbis-host-service.py"
        candidate_source = installed / "orbis-host-service.py"
        candidate_source.write_bytes(b"# candidate\n")
        prior_source.write_bytes(b"# prior\n")
        unit.write_bytes(b"candidate unit\n")
        previous_unit.write_bytes(b"prior unit\n")
        for path in (prior_source, candidate_source, previous_unit):
            path.chmod(0o600)
        maintenance = self.base / "helper-maintenance.json"
        with (mock.patch.object(UPGRADE.SETUP.HOST.AUTHORITY, "OWNER", os.geteuid()),
              mock.patch.multiple(UPGRADE.SETUP, INSTALL_DIR=installed, UNIT_FILE=unit),
              mock.patch.object(UPGRADE, "MAINTENANCE", maintenance),
              mock.patch.object(UPGRADE, "require_maintenance_identity"),
              mock.patch.object(UPGRADE, "require_root_owned"),
              mock.patch.object(UPGRADE, "require_profile"),
              mock.patch.object(UPGRADE, "verify_service"),
              mock.patch.object(UPGRADE.SETUP, "run_systemctl"),
              mock.patch.object(UPGRADE, "stop_service") as stop):
            custody = {"selection": {"directory": str(extraction), "selectionSha256": "a" * 64},
                       "prior": UPGRADE.SETUP.actual_copy(prior, previous_unit),
                       "candidate": UPGRADE.SETUP.actual_copy(installed, unit)}
            UPGRADE.SERVICE.write_private(maintenance, {"stage": "replaced", "sourceCustody": custody})
            prior_source.write_bytes(candidate_source.read_bytes())
            with self.assertRaisesRegex(ValueError, "exact journaled source"):
                UPGRADE.restore_previous(workspace, "digest", root, "test")
            stop.assert_not_called()
            self.assertEqual(list(receipts.iterdir()), [])
            prior_source.write_bytes(b"# prior\n")
            UPGRADE.restore_previous(workspace, "digest", root, "test")
            stop.assert_called_once()
            self.assertEqual(UPGRADE.SETUP.actual_copy(installed, unit), custody["prior"])
            self.assertEqual(UPGRADE.SERVICE.read_private(maintenance)["stage"], "restored")
            receipt, = receipts.iterdir()
            body = receipt.read_bytes()
            self.assertEqual(receipt.name, f"host-copy-transition-{UPGRADE.SETUP._hash(body)}.json")
            self.assertEqual(json.loads(body)["sources"], custody)
            self.assertEqual(json.loads(body)["outcome"], "prior-restored")

    def test_candidate_scripts_distinguish_python_and_maintenance_javascript(self):
        python = self.base / "helper.py"
        javascript = self.base / "orbis-host-maintenance-responder.mjs"
        python.write_text("value = 1\n")
        javascript.write_text("export const value = 1;\n")
        UPGRADE.validate_candidate_scripts([python, javascript])
        python.write_text("def invalid(\n")
        with self.assertRaisesRegex(ValueError, "invalid Python syntax"):
            UPGRADE.validate_candidate_scripts([python, javascript])
        with self.assertRaisesRegex(ValueError, "unsupported candidate"):
            UPGRADE.validate_candidate_scripts([self.base / "other.mjs"])

    def test_running_or_interrupted_core_job_blocks_helper_upgrade(self):
        with mock.patch.object(UPGRADE, "STATE_DIR", self.base):
            job = self.base / "job.json"
            for state in ("running", "recovering", "interrupted"):
                UPGRADE.SERVICE.write_private(job, {"id": "one", "state": state})
                with self.assertRaisesRegex(ValueError, "resolve"):
                    UPGRADE.job_identity()
            UPGRADE.SERVICE.write_private(job, {"id": "one", "state": "complete"})
            self.assertEqual(UPGRADE.job_identity(), ("one", "complete"))

    def test_unresolved_package_job_blocks_helper_upgrade(self):
        with mock.patch.object(UPGRADE, "STATE_DIR", self.base):
            package_job = self.base / "package-job.json"
            for state in ("queued", "running", "failed", "interrupted"):
                UPGRADE.SERVICE.write_private(package_job, {"id": "one", "state": state})
                with self.assertRaisesRegex(ValueError, "host package transaction"):
                    UPGRADE.job_identity()
            UPGRADE.SERVICE.write_private(package_job, {"id": "one", "state": "complete"})
            self.assertIsNone(UPGRADE.job_identity())

    def test_pending_same_boot_restart_blocks_helper_upgrade(self):
        with mock.patch.object(UPGRADE, "STATE_DIR", self.base), mock.patch.object(UPGRADE.SERVICE, "boot_id", return_value="boot-one"):
            restart = self.base / "restart-job.json"
            UPGRADE.SERVICE.write_private(restart, {"state": "restarting", "bootId": "boot-one"})
            with self.assertRaisesRegex(ValueError, "server restart"):
                UPGRADE.job_identity()
            UPGRADE.SERVICE.write_private(restart, {"state": "restarting", "bootId": "previous-boot"})
            self.assertIsNone(UPGRADE.job_identity())

    def test_unit_must_preserve_the_socket_directory_across_restarts(self):
        unit = (Path(__file__).parent.parent / "packaging/systemd/orbis-host.service").read_text()
        UPGRADE.validate_unit(unit)
        with self.assertRaisesRegex(ValueError, "runtime directory"):
            UPGRADE.validate_unit(unit.replace("RuntimeDirectoryPreserve=yes", "RuntimeDirectoryPreserve=no"))

    def test_recovery_record_cannot_point_outside_the_helper_directory(self):
        parent = self.base / "opt"
        parent.mkdir()
        workspace = parent / ".host-service-upgrade-test"
        workspace.mkdir(mode=0o700)
        root = self.base / "install"
        record = {
            "schema": "orbis.helper-upgrade.v1",
            "root": str(root),
            "dockerContext": "test",
            "workspace": str(workspace),
        }
        with mock.patch.object(UPGRADE.SETUP, "INSTALL_DIR", parent / "host-service"):
            with mock.patch.object(UPGRADE, "require_root_owned"):
                self.assertEqual(UPGRADE.workspace_from_record(record, root, "test"), workspace)
                record["workspace"] = str(self.base / "other" / workspace.name)
                with self.assertRaisesRegex(ValueError, "outside"):
                    UPGRADE.workspace_from_record(record, root, "test")
                record["workspace"] = str(workspace)
                with self.assertRaisesRegex(ValueError, "does not match"):
                    UPGRADE.workspace_from_record(record, root, "other")

    def test_legacy_helper_digest_allows_new_optional_package_reader(self):
        self.assertIn("orbis-host-packages.py", UPGRADE.SETUP.SCRIPTS)
        self.assertNotIn("orbis-host-packages.py", UPGRADE.LEGACY_SCRIPTS)
        for name in UPGRADE.LEGACY_SCRIPTS:
            (self.base / name).write_text(name)
        before = UPGRADE.digest_files(self.base)
        (self.base / "orbis-host-packages.py").write_text("new helper")
        self.assertNotEqual(before, UPGRADE.digest_files(self.base))

    def test_installed_old_helper_is_not_required_to_have_new_capture_modules(self):
        installed = self.base / 'installed'
        installed.mkdir()
        for name in UPGRADE.LEGACY_SCRIPTS:
            (installed / name).write_text('# installed legacy helper\n')
        root = self.base / 'installation'
        environment = self.base / 'helper.env'
        unit = self.base / 'helper.service'
        unit.write_text((Path(__file__).parent.parent / 'packaging/systemd/orbis-host.service').read_text())
        def systemctl(*args):
            return str(unit) if 'FragmentPath' in args else '' if 'DropInPaths' in args else 'no' if 'NeedDaemonReload' in args else 'active'
        with mock.patch.object(UPGRADE.SETUP, 'INSTALL_DIR', installed), mock.patch.object(UPGRADE.SETUP, 'ENV_FILE', environment), \
                mock.patch.object(UPGRADE.SETUP, 'UNIT_FILE', unit), mock.patch.object(UPGRADE, 'STATE_DIR', self.base), \
                mock.patch.object(UPGRADE, 'require_root_owned') as inspected, mock.patch.object(UPGRADE, 'systemctl_output', side_effect=systemctl):
            environment.write_text(UPGRADE.exact_environment(root, 'legacy'))
            UPGRADE.require_installed(root, 'legacy')
        checked = {call.args[0] for call in inspected.call_args_list}
        self.assertTrue({installed / name for name in UPGRADE.LEGACY_SCRIPTS} <= checked)
        self.assertNotIn(installed / 'orbis-host-core-capture-reader.py', checked)


class RetainedHelperRollbackTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        folder = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.base = Path(folder).resolve()
        self.root = self.base / 'installation'
        self.root.mkdir(mode=0o700)
        self.installed = self.base / 'host-service'
        self.installed.mkdir(mode=0o700)
        self.unit = self.base / 'orbis-host.service'
        self.workspace = self.base / (UPGRADE.WORKSPACE_PREFIX + uuid.uuid4().hex)
        self.workspace.mkdir(mode=0o700)
        previous = self.workspace / 'previous'
        previous.mkdir(mode=0o700)
        self.extraction = self.base / 'selected'
        self.extraction.mkdir(mode=0o700)
        (self.extraction / 'host-copy-custody').mkdir(mode=0o700)
        for path, body in [(self.installed / 'orbis-host-service.py', b'# candidate\n'),
                           (previous / 'orbis-host-service.py', b'# prior\n'),
                           (self.unit, b'candidate unit\n'),
                           (self.workspace / 'previous-unit', b'prior unit\n')]:
            path.write_bytes(body)
            path.chmod(0o600)
        self.maintenance = self.base / 'helper-maintenance.json'
        self.patch(UPGRADE.HOST.AUTHORITY, 'OWNER', os.geteuid())
        self.patch(UPGRADE.SETUP, 'INSTALL_DIR', self.installed)
        self.patch(UPGRADE.SETUP, 'UNIT_FILE', self.unit)
        self.patch(UPGRADE, 'STATE_DIR', self.base)
        self.patch(UPGRADE, 'MAINTENANCE', self.maintenance)
        self.patch(UPGRADE, 'require_root_owned')
        self.patch(UPGRADE, 'require_maintenance_identity')
        self.patch(UPGRADE, 'require_profile')
        self.patch(UPGRADE, 'require_installed', return_value=None)
        self.health = self.patch(UPGRADE, 'verify_service')
        self.patch(UPGRADE.SETUP, 'run_systemctl')
        self.stop = self.patch(UPGRADE, 'stop_service')
        self.jobs = self.patch(UPGRADE, 'job_identity', return_value=None)
        self.patch(UPGRADE.HOST, 'host_lock', side_effect=lambda _: nullcontext())
        self.selection = {'directory': str(self.extraction), 'selectionSha256': 'a' * 64}
        self.patch(UPGRADE.SETUP, 'hold_source_selection', side_effect=lambda *_: nullcontext(self.selection))
        self.custody = {'selection': self.selection,
                        'prior': UPGRADE.SETUP.actual_copy(previous, self.workspace / 'previous-unit'),
                        'candidate': UPGRADE.SETUP.actual_copy(self.installed, self.unit)}
        self.record = {'schema': 'orbis.helper-upgrade.v1', 'root': str(self.root), 'dockerContext': 'test',
                       'workspace': str(self.workspace), 'previousDigest': 'sha256:' + 'b' * 64,
                       'stage': 'verified', 'observerProfile': None, 'sourceCustody': self.custody}
        UPGRADE.SERVICE.write_private(self.maintenance, self.record)
        self.binding = {'operationId': str(uuid.uuid4()), 'planSha256': 'c' * 64,
                        'targetDigest': 'sha256:' + 'd' * 64}

    def patch(self, owner, name, *args, **kwargs):
        return self.stack.enter_context(mock.patch.object(owner, name, *args, **kwargs))

    def retain(self):
        return UPGRADE.retain_previous(self.workspace, self.binding)

    def rollback(self, retained):
        with mock.patch.object(UPGRADE.os, 'geteuid', return_value=0):
            return UPGRADE.rollback_retained(self.root, 'test', str(self.root), retained)

    def test_retention_preserves_both_copies_and_retires_only_maintenance(self):
        retained = self.retain()
        self.assertFalse(self.maintenance.exists())
        self.assertEqual((self.workspace / 'previous/orbis-host-service.py').read_bytes(), b'# prior\n')
        self.assertEqual((self.installed / 'orbis-host-service.py').read_bytes(), b'# candidate\n')
        body = (self.workspace / 'retained.json').read_bytes()
        self.assertEqual(UPGRADE.SETUP._hash(body), retained['sha256'])
        self.assertEqual(json.loads(body)['binding'], self.binding)
        self.stop.assert_not_called()

    def test_verified_rollback_restores_exact_source_and_unit_then_settles(self):
        retained = self.retain()
        result = self.rollback(retained)
        self.assertTrue(result['restored'])
        self.assertEqual((self.installed / 'orbis-host-service.py').read_bytes(), b'# prior\n')
        self.assertEqual(self.unit.read_bytes(), b'prior unit\n')
        self.assertFalse(self.workspace.exists())
        self.assertFalse(self.maintenance.exists())
        self.assertEqual(self.health.call_args_list, [mock.call(self.record['previousDigest'], self.root, 'test')] * 2)
        receipts = list((self.extraction / 'host-copy-custody').glob('host-copy-transition-*.json'))
        self.assertEqual(len(receipts), 1)
        self.assertEqual(json.loads(receipts[0].read_bytes())['outcome'], 'prior-restored')

    def test_retention_requires_verified_execution_custody_and_never_overwrites(self):
        self.record['sourceCustody'] = None
        UPGRADE.SERVICE.write_private(self.maintenance, self.record)
        with self.assertRaises(ValueError):
            self.retain()
        self.record['sourceCustody'] = self.custody
        UPGRADE.SERVICE.write_private(self.maintenance, self.record)
        (self.workspace / 'retained.json').write_bytes(b'earlier evidence')
        with self.assertRaises(FileExistsError):
            self.retain()
        self.assertEqual((self.workspace / 'retained.json').read_bytes(), b'earlier evidence')
        self.assertTrue(self.maintenance.exists())

    def test_crossed_operation_or_plan_refuses_before_stop(self):
        retained = self.retain()
        for key, value in [('operationId', str(uuid.uuid4())), ('planSha256', 'e' * 64),
                           ('targetDigest', 'sha256:' + 'f' * 64), ('sha256', '0' * 64)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.rollback({**retained, key: value})
        self.stop.assert_not_called()
        self.assertFalse(self.maintenance.exists())

    def test_unhealthy_original_core_refuses_before_any_helper_change(self):
        retained = self.retain()
        self.health.side_effect = RuntimeError('original Core not healthy')
        with self.assertRaises(RuntimeError):
            self.rollback(retained)
        self.stop.assert_not_called()
        self.assertFalse(self.maintenance.exists())
        self.assertTrue(self.workspace.exists())

    def test_changed_retained_or_installed_copy_refuses_before_stop(self):
        retained = self.retain()
        for path in [self.workspace / 'previous/orbis-host-service.py', self.installed / 'orbis-host-service.py']:
            before = path.read_bytes()
            path.write_bytes(b'# changed\n')
            with self.subTest(path=path.name), self.assertRaises(ValueError):
                self.rollback(retained)
            self.stop.assert_not_called()
            path.write_bytes(before)

    def test_changed_source_execution_or_observer_refuses_before_stop(self):
        retained = self.retain()
        self.selection['selectionSha256'] = 'f' * 64
        with self.assertRaises(ValueError):
            self.rollback(retained)
        self.selection['selectionSha256'] = 'a' * 64
        with mock.patch.object(UPGRADE, 'require_installed', return_value={'different': True}), self.assertRaises(ValueError):
            self.rollback(retained)
        self.stop.assert_not_called()

    def test_other_active_job_or_maintenance_refuses_without_touching_retained_copy(self):
        retained = self.retain()
        with mock.patch.object(UPGRADE, 'job_identity', side_effect=ValueError('active job')), self.assertRaises(ValueError):
            self.rollback(retained)
        UPGRADE.SERVICE.write_private(self.maintenance, {'earlier': 'maintenance'})
        with self.assertRaises(ValueError):
            self.rollback(retained)
        self.assertEqual(UPGRADE.SERVICE.read_private(self.maintenance), {'earlier': 'maintenance'})
        self.stop.assert_not_called()

    def test_job_accepted_while_stopping_keeps_both_copies_and_maintenance(self):
        retained = self.retain()
        self.jobs.side_effect = [None, None, ('new job', 'running')]
        with self.assertRaises(ValueError):
            self.rollback(retained)
        self.assertTrue(self.maintenance.exists())
        self.assertTrue((self.workspace / 'previous').exists())
        self.assertEqual((self.installed / 'orbis-host-service.py').read_bytes(), b'# candidate\n')

    def test_job_accepted_during_health_check_refuses_before_stopping(self):
        retained = self.retain()
        self.jobs.side_effect = [None, ('new job', 'running')]
        with self.assertRaises(ValueError):
            self.rollback(retained)
        self.stop.assert_not_called()
        self.assertTrue(self.maintenance.exists())
        self.assertTrue((self.workspace / 'previous').exists())

    def test_failed_restored_health_preserves_rollback_evidence(self):
        retained = self.retain()
        self.health.side_effect = [None, RuntimeError('restored helper health unavailable')]
        with self.assertRaises(RuntimeError):
            self.rollback(retained)
        self.assertTrue(self.maintenance.exists())
        self.assertTrue(self.workspace.exists())
        self.assertEqual((self.installed / 'orbis-host-service.py').read_bytes(), b'# prior\n')

    def test_lost_stop_reply_recovers_toward_original_copy(self):
        retained = self.retain()
        self.stop.side_effect = RuntimeError('lost supervisor reply')
        with self.assertRaises(RuntimeError):
            self.rollback(retained)
        record = UPGRADE.SERVICE.read_private(self.maintenance)
        self.assertEqual(record['stage'], 'retained-rollback')
        self.assertEqual(record['retention'], retained)
        self.stop.side_effect = None
        with mock.patch.object(UPGRADE.os, 'geteuid', return_value=0):
            result = UPGRADE.recover(self.root, 'test', str(self.root))
        self.assertTrue(result['recovered'])
        self.assertEqual((self.installed / 'orbis-host-service.py').read_bytes(), b'# prior\n')
        self.assertFalse(self.workspace.exists())

    def test_coordinated_return_uses_held_original_profile_and_keeps_source_custody(self):
        self.record.update(schema='orbis.helper-upgrade.v2', observerProfile={'managed': 'new'})
        UPGRADE.SERVICE.write_private(self.maintenance, self.record)
        retained = self.retain()
        held = []
        @contextmanager
        def admission(*args, **options):
            self.assertEqual(options, {'returning': retained})
            held.append(True)
            try:
                yield {'job': (self.binding['operationId'], 'running'), 'profile': None}
            finally:
                held.pop()
        launcher = SimpleNamespace(hold_owned_helper_job=admission)
        original = UPGRADE.SETUP.load_script
        self.patch(UPGRADE.SETUP, 'load_script', side_effect=lambda name, key:
                   launcher if name == 'orbis-host-upgrade-launcher.py' else original(name, key))
        self.patch(UPGRADE.HOST, 'host_lock', side_effect=lambda _, **kwargs: nullcontext())
        def stop(profile):
            self.assertTrue(held)
            self.assertIsNone(profile)
            record = UPGRADE.SERVICE.read_private(self.maintenance)
            self.assertEqual(record['schema'], 'orbis.helper-upgrade.v1')
            self.assertEqual(record['upgradeObserverProfile'], {'managed': 'new'})
            self.assertIsNone(record['observerProfile'])
        self.stop.side_effect = stop
        with mock.patch.object(UPGRADE.os, 'geteuid', return_value=0):
            result = UPGRADE.rollback_retained(self.root, 'test', str(self.root), retained,
                                               lock_fds=(7, 8), coordinated=True)
        self.assertTrue(result['restored'])
        self.assertFalse(held)
        self.assertEqual((self.installed / 'orbis-host-service.py').read_bytes(), b'# prior\n')

    def test_coordinated_flag_alone_cannot_admit_a_helper_return(self):
        retained = self.retain()
        self.jobs.side_effect = ValueError('live kernel/source admission failed')
        with mock.patch.object(UPGRADE.os, 'geteuid', return_value=0), self.assertRaises(ValueError):
            UPGRADE.rollback_retained(self.root, 'test', str(self.root), retained, coordinated=True)
        self.stop.assert_not_called()
        self.assertFalse(self.maintenance.exists())
        self.assertTrue((self.workspace / 'previous').exists())


if __name__ == "__main__":
    unittest.main()
