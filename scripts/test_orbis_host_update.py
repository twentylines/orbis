import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("orbis_host_update", Path(__file__).with_name("orbis-host-update.py"))
assert SPEC and SPEC.loader
UPDATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPDATE)

CURRENT = {
    "schema": "orbis.release.v1",
    "image": "ghcr.io/twentylines/orbis",
    "tag": "v0.1.0-beta.4",
    "commit": "a" * 40,
    "digest": "sha256:" + "b" * 64,
    "runtipiCompatibility": "4.10.1",
}
TARGET = {**CURRENT, "tag": "v0.1.0-beta.5", "commit": "c" * 40, "digest": "sha256:" + "d" * 64}
CURRENT_IMAGE = f"{CURRENT['image']}@{CURRENT['digest']}"
TARGET_IMAGE = f"{TARGET['image']}@{TARGET['digest']}"
TARGET_412 = {**TARGET, "runtipiCompatibility": "4.12.0", "installationProtocol": UPDATE.HOST.PLAN.INSTALLATION_PROTOCOL}


class FakeDocker:
    def __init__(self, root: Path, fail_target_start: bool = False, remove_on_failed_start: bool = False):
        self.root = root
        self.image = CURRENT_IMAGE
        self.states = {service: "running" for service in UPDATE.CORE_SERVICES}
        self.fail_target_start = fail_target_start
        self.remove_on_failed_start = remove_on_failed_start
        self.calls = []

    def __call__(self, context, arguments, root):
        self.calls.append(arguments)
        if arguments[0] == "info":
            return subprocess.CompletedProcess(arguments, 0, "test-daemon\n", "")
        if arguments[0] == "ps":
            names = [name for name, state in self.states.items() if "--all" in arguments or state == "running"]
            return subprocess.CompletedProcess(arguments, 0, "\n".join(names), "")
        if arguments[0] == "inspect":
            template, name = arguments[2], arguments[3]
            labels = {
                "com.docker.compose.project": "runtipi",
                "com.docker.compose.project.working_dir": str(self.root),
                "com.docker.compose.service": name,
            }
            if template == "{{json .Config.Image}}":
                value = json.dumps(self.image)
            elif template == "{{json .Config.Labels}}":
                value = json.dumps(labels)
            elif template == "{{json .Mounts}}":
                value = "[]"
            elif template == "{{json .State}}":
                value = json.dumps({"Status": self.states[name], "Health": {"Status": "healthy"}})
            elif template == "{{.State.Status}}":
                value = self.states[name]
            else:
                raise AssertionError(f"unexpected Docker inspect template: {template}")
            return subprocess.CompletedProcess(arguments, 0, value + "\n", "")
        if arguments[0] == "pull":
            return subprocess.CompletedProcess(arguments, 0, "pulled\n", "")
        if arguments[0] == "stop":
            self.states[arguments[1]] = "exited"
            return subprocess.CompletedProcess(arguments, 0, "stopped\n", "")
        if arguments[0] == "compose" and "up" in arguments:
            contents = (self.root / "orbis-compose.yml").read_text()
            candidate = TARGET_IMAGE if TARGET["digest"] in contents else CURRENT_IMAGE
            if candidate == TARGET_IMAGE and self.fail_target_start:
                if self.remove_on_failed_start:
                    del self.states["runtipi"]
                return subprocess.CompletedProcess(arguments, 1, "", "synthetic failure")
            self.image = candidate
            self.states = {service: "running" for service in UPDATE.CORE_SERVICES}
            return subprocess.CompletedProcess(arguments, 0, "started\n", "")
        raise AssertionError(f"unexpected Docker command: {arguments}")


class OrbisHostUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = (Path(self.temp.name) / "install")
        self.root.mkdir()
        self.root = self.root.resolve()
        self.snapshot = self.root.parent / "before-update"
        for name in ("docker-compose.yml", ".env"):
            (self.root / name).write_text("safe fixture\n")
        (self.root / "orbis-compose.yml").write_text(UPDATE.HOST.STAGE.staged_content(CURRENT))
        (self.root / "data" / "postgres").mkdir(parents=True)
        (self.root / "data" / "postgres" / "record").write_text("original database fixture\n")
        self.plan = mock.patch.object(UPDATE.HOST.PLAN, "plan", return_value={"configuredImage": CURRENT_IMAGE})
        self.plan.start()
        self.addCleanup(self.plan.stop)
        self.release = mock.patch.object(
            UPDATE.CHECK,
            "check",
            return_value={"commit": TARGET["commit"], "image": TARGET_IMAGE, "runtipiCompatibility": "4.10.1"},
        )
        self.release.start()
        self.addCleanup(self.release.stop)
        self.pull = mock.patch.object(UPDATE, "pull_verified_image", side_effect=lambda context, target, root, publish:
                                     UPDATE.docker_checked(context, ["pull", f"{target['image']}@{target['digest']}"], root, "download failed"))
        self.pull.start()
        self.addCleanup(self.pull.stop)
        UPDATE.HOST.write_state(self.root, UPDATE.HOST.installation_fingerprint(self.root, CURRENT, "test-daemon"))

    def test_live_proxy_update_uses_reviewed_runtime_and_never_compose_up(self):
        fake = FakeDocker(self.root)
        checkpoint = {'storage': {'backupScope': UPDATE.CONTROLLER.SCOPE}}
        runtime = mock.Mock()
        tools, reader = mock.Mock(), mock.Mock()
        checkpoint_stages = []
        def save_checkpoint(root, actual_reader, value, *, host_writers_stopped, progress):
            self.assertEqual((root, actual_reader, value, host_writers_stopped), (self.root, reader, checkpoint, True))
            for phase in ('stopping', 'snapshotting', 'snapshot-ready'):
                progress(phase)
                checkpoint_stages.append(json.loads(UPDATE.journal_path(self.snapshot).read_text())['stage'])
        tools.checkpoint.side_effect = save_checkpoint
        def start_target(*, progress):
            before = json.loads(UPDATE.journal_path(self.snapshot).read_text())
            self.assertEqual((before['stage'], before['progressPhase']), ('staged', 'restarting'))
            fake.image = TARGET_IMAGE
            progress('verifying')
            after = json.loads(UPDATE.journal_path(self.snapshot).read_text())
            self.assertEqual((after['stage'], after['progressPhase']), ('staged', 'verifying'))
        runtime.start_target.side_effect = start_target
        runtime.commit.return_value = False
        with mock.patch.object(UPDATE, 'update_plan', return_value={'checkpoint': checkpoint}), \
                mock.patch.object(UPDATE.CONTROLLER, 'ControllerUpdate', return_value=runtime), \
                mock.patch.object(UPDATE, 'controller_tools', return_value=(tools, reader)), \
                mock.patch.object(UPDATE.HOST, 'docker', side_effect=fake):
            result = UPDATE.apply_update(self.root, CURRENT, TARGET, 'test-daemon', self.snapshot)
        self.assertEqual(result['result'], 'healthy')
        runtime.prepare.assert_called_once_with(checkpoint)
        runtime.start_target.assert_called_once()
        runtime.restore_policies.assert_called_once_with(target=True)
        runtime.commit.assert_called_once()
        tools.checkpoint.assert_called_once()
        self.assertEqual(checkpoint_stages, ['stopping', 'snapshotting', 'snapshot-ready'])
        self.assertFalse(any(call[0] in {'compose', 'stop'} for call in fake.calls))
        saved = json.loads(UPDATE.journal_path(self.snapshot).read_text())
        self.assertEqual(saved['backupScope'], UPDATE.CONTROLLER.SCOPE)
        self.assertEqual(saved['stage'], 'complete')
        self.assertEqual(saved['progressPhase'], 'verifying')

    def test_no_backup_update_never_captures_or_automatically_restores_storage(self):
        for failed in (False, True):
            with self.subTest(failed=failed):
                snapshot = self.snapshot.with_name(self.snapshot.name + str(failed))
                fake = FakeDocker(self.root)
                checkpoint = {'backupPolicy': 'none', 'storage': {'backupScope': UPDATE.CONTROLLER.SCOPE}}
                runtime = mock.Mock()
                tools, reader = mock.Mock(), mock.Mock()
                runtime.commit.return_value = False
                if failed:
                    runtime.start_target.side_effect = RuntimeError('health failed after start')
                else:
                    runtime.start_target.side_effect = lambda **options: setattr(fake, 'image', TARGET_IMAGE)
                with mock.patch.object(UPDATE, 'update_plan', return_value={'checkpoint': checkpoint}), \
                        mock.patch.object(UPDATE.CONTROLLER, 'ControllerUpdate', return_value=runtime), \
                        mock.patch.object(UPDATE, 'controller_tools', return_value=(tools, reader)), \
                        mock.patch.object(UPDATE.HOST, 'docker', side_effect=fake), \
                        mock.patch.object(UPDATE, 'rollback') as rollback, \
                        mock.patch.object(UPDATE.SNAPSHOT, 'capture') as capture:
                    if failed:
                        with self.assertRaises(UPDATE.CONTROLLER.NoBackupRecoveryRequired):
                            UPDATE.apply_update(self.root, CURRENT, TARGET, 'test-daemon', snapshot)
                    else:
                        self.assertEqual(UPDATE.apply_update(self.root, CURRENT, TARGET, 'test-daemon', snapshot)['result'], 'healthy')
                    tools.quiesce_without_backup.assert_called_once_with(self.root, reader, checkpoint, host_writers_stopped=True)
                    tools.checkpoint.assert_not_called()
                    rollback.assert_not_called()
                    capture.assert_not_called()
                saved = json.loads(UPDATE.journal_path(snapshot).read_text())
                self.assertEqual(saved['schema'], UPDATE.NO_BACKUP_JOURNAL_SCHEMA)
                self.assertEqual(saved['stage'], 'recovery-required' if failed else 'complete')
                self.assertFalse(snapshot.exists())
                if not failed:
                    (self.root / 'orbis-compose.yml').write_text(UPDATE.HOST.STAGE.staged_content(CURRENT))
                    UPDATE.HOST.write_state(self.root, UPDATE.HOST.installation_fingerprint(self.root, CURRENT, 'test-daemon'))

    def test_modern_plan_reviews_no_backup_without_copy_capacity_or_rsync(self):
        fake = FakeDocker(self.root)
        target = {**TARGET, 'installationProtocol': UPDATE.HOST.PLAN.INSTALLATION_PROTOCOL}
        tools, reader = mock.Mock(), mock.Mock()
        checkpoint = {'backupPolicy': 'none', 'storage': {'estimatedBytes': 0}}
        tools.review.return_value = checkpoint
        with mock.patch.object(UPDATE.HOST, 'docker', side_effect=fake), \
                mock.patch.object(UPDATE, 'verify_release'), \
                mock.patch.object(UPDATE, 'controller_tools', return_value=(tools, reader)), \
                mock.patch.object(UPDATE.shutil, 'which', return_value=None), \
                mock.patch.object(UPDATE.SNAPSHOT, 'preflight') as copy_review:
            plan = UPDATE.update_plan(self.root, CURRENT, target, 'test-daemon', self.snapshot)
        self.assertEqual(plan['backupPolicy'], 'none')
        self.assertEqual(plan['snapshotBytes'], 0)
        self.assertFalse(plan['runningAppsMustBeStopped'])
        tools.review.assert_called_once_with(self.root, reader, self.snapshot, UPDATE.checkpoint_path(self.snapshot), scope=UPDATE.CONTROLLER.SCOPE, backup=False)
        copy_review.assert_not_called()
        self.assertFalse(self.snapshot.exists())

    def test_cross_base_plan_requires_a_backed_controller_and_binds_the_review(self):
        fake = FakeDocker(self.root)
        tools, reader = mock.Mock(), mock.Mock()
        tools.review.return_value = {"storage": {"estimatedBytes": 256}}
        tools.APPS.digest.return_value = "1" * 64
        with mock.patch.object(UPDATE.HOST, "docker", side_effect=fake), \
                mock.patch.object(UPDATE, "verify_release"), \
                mock.patch.object(UPDATE, "controller_tools", return_value=(tools, reader)), \
                mock.patch.object(UPDATE.HOST.PLAN, "review_412", return_value={"approved": True}), \
                mock.patch.object(UPDATE.shutil, "which", return_value="/usr/bin/rsync"):
            plan = UPDATE.update_plan(self.root, CURRENT, TARGET_412, "test-daemon", self.snapshot)
        self.assertEqual(plan["backupPolicy"], "automatic")
        self.assertEqual(plan["snapshotBytes"], 256)
        self.assertFalse(plan["runningAppsMustBeStopped"])
        self.assertEqual(plan["runtipiReviewSha256"], "1" * 64)
        tools.review.assert_called_once_with(self.root, reader, self.snapshot, UPDATE.checkpoint_path(self.snapshot),
                                             scope=UPDATE.CONTROLLER.SCOPE, backup=True)
        tools.APPS.digest.assert_called_once_with({"approved": True})

    def test_cross_base_producer_stages_only_after_a_backed_checkpoint(self):
        fake = FakeDocker(self.root)
        operation = str(uuid.uuid4())
        snapshot = self.root.parent / f"orbis-{TARGET_412['tag']}-{operation}"
        binding = {"operationId": operation, "approvedReviewSha256": "1" * 64,
                   "sourceReceiptSha256": "2" * 64, "targetReceiptSha256": "3" * 64}
        checkpoint = {"storage": {"backupScope": UPDATE.CONTROLLER.SCOPE}}
        tools, reader, runtime = mock.Mock(), mock.Mock(), mock.Mock()
        effects = mock.Mock()
        for name in ("checkpoint", "prepare_runtipi_configuration", "stage_runtipi_configuration"):
            effects.attach_mock(getattr(tools, name), name)
        effects.attach_mock(runtime.start_target, "start_target")
        runtime.start_target.side_effect = lambda **options: setattr(fake, 'image', TARGET_IMAGE)
        runtime.commit.return_value = False
        with mock.patch.object(UPDATE, "update_plan", return_value={"checkpoint": checkpoint, "runtipiReviewSha256": "1" * 64}), \
                mock.patch.object(UPDATE, "controller_tools", return_value=(tools, reader)), \
                mock.patch.object(UPDATE.CONTROLLER, "ControllerUpdate", return_value=runtime), \
                mock.patch.object(UPDATE.HOST, "published_installation_fingerprint", return_value={}), \
                mock.patch.object(UPDATE.HOST, "write_state"), \
                mock.patch.object(UPDATE.HOST, "docker", side_effect=fake), \
                mock.patch.object(UPDATE.HOST.STAGE, "stage") as ordinary_stage:
            with self.assertRaisesRegex(ValueError, "coordinated configuration review"):
                UPDATE.apply_update(self.root, CURRENT, TARGET_412, "test-daemon", snapshot)
            self.assertFalse(UPDATE.journal_path(snapshot).exists())
            result = UPDATE.apply_update(self.root, CURRENT, TARGET_412, "test-daemon", snapshot, runtipi_binding=binding)
        self.assertEqual(result["result"], "healthy")
        observed = UPDATE.read_journal(snapshot, self.root, "test-daemon", CURRENT, TARGET_412)
        self.assertEqual(observed["runtipiBinding"], binding)
        self.assertEqual([call[0] for call in effects.mock_calls],
                         ["checkpoint", "prepare_runtipi_configuration", "stage_runtipi_configuration", "start_target"])
        tools.prepare_runtipi_configuration.assert_called_once_with(
            self.root, reader, UPDATE.checkpoint_path(snapshot), CURRENT, TARGET_412, binding)
        ordinary_stage.assert_not_called()

    def test_cross_base_rollback_requires_restored_original_configuration_before_restart(self):
        operation = str(uuid.uuid4())
        snapshot = self.root.parent / f"orbis-{TARGET_412['tag']}-{operation}"
        journal = UPDATE.checkpoint_path(snapshot)
        journal.touch()
        checkpoint = {"storage": {"backupScope": UPDATE.CONTROLLER.SCOPE}}
        binding = {"operationId": operation, "approvedReviewSha256": "1" * 64,
                   "sourceReceiptSha256": "2" * 64, "targetReceiptSha256": "3" * 64}
        tools, reader, runtime = mock.Mock(), mock.Mock(), mock.Mock()
        runtime.read.return_value = {"checkpoint": checkpoint}
        tools.read_record.return_value = {"review": checkpoint, "stage": "ready", "runtipiConfiguration": {}}
        record = {"backupScope": UPDATE.CONTROLLER.SCOPE, "targetPublication": TARGET_412, "stage": "staged",
                  "runtipiBinding": binding}
        def recover(*args, before_originals_start, **options):
            before_originals_start()
        tools.recover.side_effect = recover
        for reconstructed in (False, True):
            with self.subTest(reconstructed=reconstructed):
                runtime.restore_reconstructed_checkpoint.return_value = reconstructed
                tools.verify_restored_runtipi_configuration.side_effect = ValueError("original configuration differs")
                with mock.patch.object(UPDATE.CONTROLLER, "ControllerUpdate", return_value=runtime), \
                        mock.patch.object(UPDATE, "controller_tools", return_value=(tools, reader)), \
                        mock.patch.object(UPDATE, "write_journal"):
                    with self.assertRaisesRegex(ValueError, "original configuration differs"):
                        UPDATE.rollback(self.root, CURRENT, "test-daemon", snapshot, dict(record))
                runtime.start_original.assert_not_called()

    def test_recovery_seals_an_interrupted_backup_before_attempting_source_retirement(self):
        path = UPDATE.checkpoint_path(self.snapshot)
        path.touch()
        checkpoint = {"storage": {"backupScope": UPDATE.CONTROLLER.SCOPE}}
        tools, reader, runtime = mock.Mock(), mock.Mock(), mock.Mock()
        protected = {"checkpoint": checkpoint, "sourceBootstrapEnablement": {"reviewed": True}}
        runtime.read.return_value = protected
        runtime.validate_retirement.return_value = {"phase": "held"}
        runtime.restore_reconstructed_checkpoint.return_value = True
        tools.read_record.side_effect = [{"review": checkpoint, "stage": "snapshotting"}, {"review": checkpoint, "stage": "ready"}]
        effects = mock.Mock()
        effects.attach_mock(tools.complete_rollback_checkpoint, "seal")
        effects.attach_mock(runtime.stop_for_rollback, "stop")
        effects.attach_mock(runtime.start_original, "start")
        record = {"backupScope": UPDATE.CONTROLLER.SCOPE, "targetPublication": TARGET_412, "stage": "snapshotting"}
        with (
            mock.patch.object(UPDATE.CONTROLLER, "ControllerUpdate", return_value=runtime),
            mock.patch.object(UPDATE, "controller_tools", return_value=(tools, reader)),
            mock.patch.object(UPDATE.HOST, "docker", side_effect=FakeDocker(self.root)),
        ):
            UPDATE.rollback(self.root, CURRENT, "test-daemon", self.snapshot, record)
        self.assertEqual(effects.mock_calls, [mock.call.seal(self.root, reader, path, checkpoint), mock.call.stop(), mock.call.start()])
        self.assertEqual(record["stage"], "rolled-back")
        tools.recover.assert_not_called()

    def test_recovery_does_not_retire_the_source_when_checkpoint_completion_fails(self):
        UPDATE.checkpoint_path(self.snapshot).touch()
        checkpoint = {"storage": {"backupScope": UPDATE.CONTROLLER.SCOPE}}
        tools, runtime = mock.Mock(), mock.Mock()
        runtime.read.return_value = {"checkpoint": checkpoint, "sourceBootstrapEnablement": {"reviewed": True}}
        runtime.validate_retirement.return_value = {"phase": "held"}
        tools.read_record.return_value = {"review": checkpoint, "stage": "snapshotting"}
        tools.complete_rollback_checkpoint.side_effect = ValueError("copy remains incomplete")
        record = {"backupScope": UPDATE.CONTROLLER.SCOPE, "targetPublication": TARGET_412, "stage": "snapshotting"}
        with (
            mock.patch.object(UPDATE.CONTROLLER, "ControllerUpdate", return_value=runtime),
            mock.patch.object(UPDATE, "controller_tools", return_value=(tools, mock.Mock())),
            self.assertRaisesRegex(ValueError, "copy remains incomplete"),
        ):
            UPDATE.rollback(self.root, CURRENT, "test-daemon", self.snapshot, record)
        runtime.stop_for_rollback.assert_not_called()
        runtime.start_original.assert_not_called()

    def test_recovery_before_checkpoint_journal_keeps_the_healthy_source_running(self):
        runtime = mock.Mock()
        runtime.read.return_value = {"checkpoint": {}, "sourceBootstrapEnablement": {"reviewed": True}}
        runtime.verify_source.return_value = {"State": {"Running": True, "Health": {"Status": "healthy"}}}
        record = {"backupScope": UPDATE.CONTROLLER.SCOPE, "targetPublication": TARGET_412, "stage": "stopping"}
        tools = mock.Mock()
        with (
            mock.patch.object(UPDATE.CONTROLLER, "ControllerUpdate", return_value=runtime),
            mock.patch.object(UPDATE, "controller_tools", return_value=(tools, mock.Mock())),
        ):
            UPDATE.rollback(self.root, CURRENT, "test-daemon", self.snapshot, record)
        self.assertEqual(record["stage"], "aborted")
        self.assertEqual(json.loads(UPDATE.journal_path(self.snapshot).read_bytes())["stage"], "aborted")
        runtime.stop_for_rollback.assert_not_called()
        runtime.start_original.assert_not_called()
        tools.complete_rollback_checkpoint.assert_not_called()

    def test_changed_reviewed_backup_policy_fails_before_journal_or_download(self):
        checkpoint = {'backupPolicy': 'none', 'storage': {'backupScope': UPDATE.CONTROLLER.SCOPE}}
        with mock.patch.object(UPDATE, 'update_plan', return_value={'checkpoint': checkpoint}), \
                mock.patch.object(UPDATE, 'pull_verified_image') as pull:
            with self.assertRaisesRegex(ValueError, 'backup policy changed'):
                UPDATE.apply_update(self.root, CURRENT, TARGET, 'test-daemon', self.snapshot, expected_backup_policy='automatic')
            pull.assert_not_called()
        self.assertFalse(UPDATE.journal_path(self.snapshot).exists())

    def test_no_backup_abort_records_the_pre_downtime_boundary_for_component_return(self):
        runner = UPDATE.load_script("orbis-host-upgrade-runner.py", "early_abort_recovery_consumer")
        checkpoint = {'backupPolicy': 'none', 'storage': {'backupScope': UPDATE.CONTROLLER.SCOPE}}
        job = {'snapshot': str(self.snapshot), 'current': CURRENT, 'target': TARGET}
        for stage in ('preparing', 'downloading', 'pulled'):
            with self.subTest(stage=stage):
                fake = FakeDocker(self.root)
                fake.states['runtipi'] = 'exited'
                runtime = mock.Mock()
                runtime.read.side_effect = FileNotFoundError
                record = {'schema': UPDATE.NO_BACKUP_JOURNAL_SCHEMA, 'backupPolicy': 'none',
                          'backupScope': UPDATE.CONTROLLER.SCOPE, 'checkpoint': checkpoint, 'root': str(self.root),
                          'snapshot': str(self.snapshot), 'dockerContext': 'test-daemon', 'previousDigest': CURRENT['digest'],
                          'targetDigest': TARGET['digest'], 'stage': stage}
                UPDATE.write_journal(self.snapshot, record)
                journal = UPDATE.journal_path(self.snapshot)
                original = journal.read_bytes()
                with (
                    mock.patch.object(UPDATE.CONTROLLER, 'ControllerUpdate', return_value=runtime),
                    mock.patch.object(UPDATE.HOST, 'docker', side_effect=fake),
                    mock.patch.object(UPDATE.HOST.AUTHORITY, 'OWNER', os.geteuid()),
                    mock.patch.object(UPDATE, 'rollback') as rollback,
                ):
                    with self.assertRaisesRegex(RuntimeError, 'not healthy before service downtime'):
                        UPDATE.recover(self.root, CURRENT, TARGET, 'test-daemon', self.snapshot)
                    self.assertEqual(journal.read_bytes(), original)
                    fake.states['runtipi'] = 'running'
                    result = UPDATE.recover(self.root, CURRENT, TARGET, 'test-daemon', self.snapshot)
                    self.assertEqual(result['result'], 'aborted-before-downtime')
                    self.assertEqual(runner.original_core_boundary(UPDATE, self.root, 'test-daemon', job, self.temp.name),
                                     {'stage': 'aborted', 'journalSha256': runner.sha(journal.read_bytes())})
                    rollback.assert_not_called()
                self.assertEqual(json.loads(journal.read_text())['failureStage'], stage)
                self.assertFalse(any(call[0] in {'compose', 'stop', 'start'} for call in fake.calls))

    def test_no_backup_recovery_never_uses_legacy_rollback_after_handoff(self):
        checkpoint = {'backupPolicy': 'none', 'storage': {'backupScope': UPDATE.CONTROLLER.SCOPE}}
        record = {'schema': UPDATE.NO_BACKUP_JOURNAL_SCHEMA, 'backupPolicy': 'none',
                  'backupScope': UPDATE.CONTROLLER.SCOPE, 'checkpoint': checkpoint, 'root': str(self.root),
                  'snapshot': str(self.snapshot), 'dockerContext': 'test-daemon',
                  'previousDigest': CURRENT['digest'], 'targetDigest': TARGET['digest'], 'stage': 'staged'}
        UPDATE.write_journal(self.snapshot, record)
        runtime = mock.Mock()
        runtime.read.return_value = {'schema': UPDATE.CONTROLLER.NO_BACKUP_POLICY, 'checkpoint': checkpoint, 'phase': 'active'}
        with mock.patch.object(UPDATE.CONTROLLER, 'ControllerUpdate', return_value=runtime), mock.patch.object(UPDATE, 'rollback') as rollback:
            with self.assertRaises(UPDATE.CONTROLLER.NoBackupRecoveryRequired):
                UPDATE.recover(self.root, CURRENT, TARGET, 'test-daemon', self.snapshot)
            rollback.assert_not_called()
            runtime.stop_for_rollback.assert_not_called()
            runtime.start_original.assert_not_called()
        saved = json.loads(UPDATE.journal_path(self.snapshot).read_text())
        self.assertEqual(saved['stage'], 'recovery-required')
        self.assertIn('no automatic data backup', UPDATE.failure_message(saved))
        with self.assertRaises(UPDATE.CONTROLLER.NoBackupRecoveryRequired):
            UPDATE.require_local_recovery(self.snapshot, saved)
        self.assertEqual(json.loads(UPDATE.journal_path(self.snapshot).read_text()), saved)
        self.assertEqual(saved['failureStage'], 'staged')
        with self.assertRaises(UPDATE.CONTROLLER.NoBackupRecoveryRequired):
            UPDATE.rollback(self.root, CURRENT, 'test-daemon', self.snapshot, record)

    def test_no_backup_committed_target_settles_after_lost_completion_reply(self):
        checkpoint = {'backupPolicy': 'none', 'storage': {'backupScope': UPDATE.CONTROLLER.SCOPE}}
        record = {'schema': UPDATE.NO_BACKUP_JOURNAL_SCHEMA, 'backupPolicy': 'none',
                  'backupScope': UPDATE.CONTROLLER.SCOPE, 'checkpoint': checkpoint, 'root': str(self.root),
                  'snapshot': str(self.snapshot), 'dockerContext': 'test-daemon',
                  'previousDigest': CURRENT['digest'], 'targetDigest': TARGET['digest'], 'stage': 'staged'}
        UPDATE.write_journal(self.snapshot, record)
        runtime = mock.Mock()
        runtime.read.return_value = {'schema': UPDATE.CONTROLLER.NO_BACKUP_POLICY, 'checkpoint': checkpoint, 'phase': 'committed'}
        runtime.commit.return_value = False
        with mock.patch.object(UPDATE.CONTROLLER, 'ControllerUpdate', return_value=runtime), mock.patch.object(UPDATE, 'rollback') as rollback:
            result = UPDATE.recover(self.root, CURRENT, TARGET, 'test-daemon', self.snapshot)
            self.assertEqual(result['result'], 'healthy')
            self.assertFalse(result['backupCreated'])
            rollback.assert_not_called()
        self.assertEqual(json.loads(UPDATE.journal_path(self.snapshot).read_text())['stage'], 'complete')

    def test_incapable_target_has_explicit_failure_before_checkpoint_or_downtime(self):
        fake = FakeDocker(self.root)
        runtime = mock.Mock()
        runtime.prepare.side_effect = UPDATE.CONTROLLER.CapabilityError('unsupported target')
        runtime.read.return_value = {'phase': 'preparing'}
        checkpoint = {'storage': {'backupScope': UPDATE.CONTROLLER.SCOPE}}
        with mock.patch.object(UPDATE, 'update_plan', return_value={'checkpoint': checkpoint}), \
                mock.patch.object(UPDATE.CONTROLLER, 'ControllerUpdate', return_value=runtime), \
                mock.patch.object(UPDATE, 'controller_tools') as tools, \
                mock.patch.object(UPDATE.HOST, 'docker', side_effect=fake):
            with self.assertRaisesRegex(RuntimeError, 'before service downtime'):
                UPDATE.apply_update(self.root, CURRENT, TARGET, 'test-daemon', self.snapshot)
        tools.assert_not_called()
        runtime.start_target.assert_not_called()
        self.assertFalse(any(call[0] in {'compose', 'stop'} for call in fake.calls))
        saved = json.loads(UPDATE.journal_path(self.snapshot).read_text())
        self.assertEqual(saved['stage'], 'aborted')
        self.assertEqual(saved['failureCode'], 'controller-preservation-unsupported')
        self.assertEqual(UPDATE.failure_message(saved), 'This Orbis version cannot be installed with the current updater. Choose a newer version.')

    def test_probe_retirement_runs_after_durable_abort_and_never_masks_capability_error(self):
        fake = FakeDocker(self.root)
        runtime = mock.Mock()
        original = UPDATE.CONTROLLER.CapabilityError('target unsupported')
        runtime.prepare.side_effect = original
        runtime.read.return_value = {'phase': 'preparing'}
        observed = []
        def cleanup():
            journal = json.loads(UPDATE.journal_path(self.snapshot).read_text())
            observed.append((journal['stage'], journal['failureCode']))
            raise ValueError('probe cleanup needs review')
        runtime.retire_rejected_probe.side_effect = cleanup
        checkpoint = {'storage': {'backupScope': UPDATE.CONTROLLER.SCOPE}}
        with mock.patch.object(UPDATE, 'update_plan', return_value={'checkpoint': checkpoint}), \
                mock.patch.object(UPDATE.CONTROLLER, 'ControllerUpdate', return_value=runtime), \
                mock.patch.object(UPDATE.HOST, 'docker', side_effect=fake):
            with self.assertRaisesRegex(RuntimeError, 'before service downtime') as raised:
                UPDATE.apply_update(self.root, CURRENT, TARGET, 'test-daemon', self.snapshot)
        self.assertIs(raised.exception.__cause__, original)
        self.assertEqual(observed, [('aborted', 'controller-preservation-unsupported')])
        runtime.retire_rejected_probe.assert_called_once()
        self.assertFalse(any(call[0] in {'compose', 'stop'} for call in fake.calls))

    def test_terminal_capability_abort_retries_probe_retirement_without_changing_recovery_decision(self):
        record = {'schema': UPDATE.JOURNAL_SCHEMA, 'root': str(self.root), 'snapshot': str(self.snapshot),
                  'dockerContext': 'test-daemon', 'previousDigest': CURRENT['digest'], 'targetDigest': TARGET['digest'],
                  'stage': 'aborted', 'backupScope': UPDATE.CONTROLLER.SCOPE,
                  'failureStage': 'pulled', 'failureCode': UPDATE.CONTROLLER.CapabilityError.code}
        UPDATE.write_journal(self.snapshot, record)
        original = UPDATE.journal_path(self.snapshot).read_bytes()
        for failure in (None, ValueError('probe requires review')):
            runtime = mock.Mock()
            runtime.read.return_value = {'phase': 'preparing'}
            runtime.retire_rejected_probe.side_effect = failure
            with mock.patch.object(UPDATE.CONTROLLER, 'ControllerUpdate', return_value=runtime):
                with self.assertRaisesRegex(ValueError, 'already complete or recovered'):
                    UPDATE.recover(self.root, CURRENT, TARGET, 'test-daemon', self.snapshot)
            runtime.retire_rejected_probe.assert_called_once()
            self.assertEqual(UPDATE.journal_path(self.snapshot).read_bytes(), original)

    def test_dedicated_reconstruction_rollback_dispatch_does_not_replay_old_controller_id_journal(self):
        runtime = mock.Mock()
        runtime.read.return_value = {'checkpoint': {'storage': {'backupScope': UPDATE.CONTROLLER.SCOPE}}}
        runtime.restore_reconstructed_checkpoint.return_value = True
        tools, reader = mock.Mock(), mock.Mock()
        record = {'schema': UPDATE.JOURNAL_SCHEMA, 'stage': 'staged', 'backupScope': UPDATE.CONTROLLER.SCOPE,
                  'targetPublication': TARGET}
        fake = FakeDocker(self.root)
        with mock.patch.object(UPDATE.CONTROLLER, 'ControllerUpdate', return_value=runtime), \
                mock.patch.object(UPDATE, 'controller_tools', return_value=(tools, reader)), \
                mock.patch.object(UPDATE.HOST, 'docker', side_effect=fake):
            UPDATE.rollback(self.root, CURRENT, 'test-daemon', self.snapshot, record)
        runtime.stop_for_rollback.assert_called_once()
        runtime.restore_reconstructed_checkpoint.assert_called_once()
        tools.recover.assert_not_called()
        runtime.start_original.assert_called_once()
        runtime.restore_policies.assert_called_once_with(target=False)
        self.assertEqual(record['stage'], 'rolled-back')

    def test_update_keeps_a_verified_previous_release_snapshot(self):
        fake = FakeDocker(self.root)
        writes = []
        write = UPDATE.write_journal
        def observe(snapshot, record):
            write(snapshot, record)
            writes.append(json.loads(UPDATE.journal_path(snapshot).read_text()))
        with mock.patch.object(UPDATE.HOST, "docker", side_effect=fake), \
                mock.patch.object(UPDATE, "write_journal", side_effect=observe):
            result = UPDATE.apply_update(self.root, CURRENT, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(result["result"], "healthy")
        progress = [(record['stage'], record['progressPhase']) for record in writes if record.get('progressPhase') and record['stage'] == 'staged']
        self.assertEqual(progress, [('staged', 'restarting'), ('staged', 'verifying')])
        self.assertEqual(fake.image, TARGET_IMAGE)
        self.assertEqual(UPDATE.SNAPSHOT.verify(self.snapshot, self.root)["release"], CURRENT["tag"])
        self.assertEqual(UPDATE.journal_path(self.snapshot).read_text().find('"stage": "complete"') >= 0, True)
        self.assertEqual(
            UPDATE.HOST.saved_state(self.root), UPDATE.HOST.installation_fingerprint(self.root, TARGET, "test-daemon")
        )

    def test_failed_download_is_reported_and_never_stops_running_services(self):
        fake = FakeDocker(self.root)
        observed = []

        def docker(context, arguments, root):
            if arguments[0] == "pull":
                observed.append(json.loads(UPDATE.journal_path(self.snapshot).read_text())["stage"])
                return subprocess.CompletedProcess(arguments, 1, "", "synthetic download failure")
            return fake(context, arguments, root)

        with mock.patch.object(UPDATE.HOST, "docker", side_effect=docker):
            with self.assertRaises(RuntimeError):
                UPDATE.apply_update(self.root, CURRENT, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(observed, ["downloading"])
        record = UPDATE.read_journal(self.snapshot, self.root, "test-daemon", CURRENT, TARGET)
        self.assertEqual(record["stage"], "aborted")
        self.assertEqual(record["failureStage"], "downloading")
        self.assertTrue(all(state == "running" for state in fake.states.values()))
        self.assertFalse(any(call[0] == "stop" for call in fake.calls))

    def test_installer_capability_must_match_the_published_release(self):
        target = {**TARGET, "installationProtocol": UPDATE.HOST.PLAN.INSTALLATION_PROTOCOL}
        with self.assertRaisesRegex(ValueError, "verified GitHub and GHCR release"):
            UPDATE.verify_release(target)
        published = {"commit": TARGET["commit"], "image": TARGET_IMAGE, "runtipiCompatibility": "4.10.1", "installationProtocol": target["installationProtocol"]}
        with mock.patch.object(UPDATE.CHECK, "check", return_value=published):
            UPDATE.verify_release(target)
            UPDATE.verify_release(TARGET)

    def test_failed_target_start_restores_previous_database_and_core(self):
        fake = FakeDocker(self.root, fail_target_start=True)
        with mock.patch.object(UPDATE.HOST, "docker", side_effect=fake):
            with self.assertRaisesRegex(RuntimeError, "previous release was restored"):
                UPDATE.apply_update(self.root, CURRENT, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(fake.image, CURRENT_IMAGE)
        self.assertEqual(fake.states["runtipi"], "running")
        self.assertEqual((self.root / "data" / "postgres" / "record").read_text(), "original database fixture\n")
        self.assertIn(CURRENT["digest"], (self.root / "orbis-compose.yml").read_text())
        self.assertEqual(UPDATE.read_journal(self.snapshot, self.root, "test-daemon", CURRENT, TARGET)["stage"], "rolled-back")

    def test_failed_recreate_with_missing_core_container_restores_previous_release(self):
        fake = FakeDocker(self.root, fail_target_start=True, remove_on_failed_start=True)
        with mock.patch.object(UPDATE.HOST, "docker", side_effect=fake):
            with self.assertRaisesRegex(RuntimeError, "previous release was restored"):
                UPDATE.apply_update(self.root, CURRENT, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(fake.image, CURRENT_IMAGE)
        self.assertEqual(fake.states["runtipi"], "running")
        self.assertEqual(UPDATE.read_journal(self.snapshot, self.root, "test-daemon", CURRENT, TARGET)["stage"], "rolled-back")

    def test_capture_failure_restarts_current_core_without_staging_or_restoring_partial_copy(self):
        codes = (
            "snapshot-source-read-failed",
            "snapshot-copy-failed",
            "snapshot-source-changed",
            "snapshot-copy-mismatch",
            "snapshot-seal-failed",
        )
        for code in codes:
            with self.subTest(code=code):
                snapshot = self.snapshot.with_name(code)
                fake = FakeDocker(self.root)
                secret = "PRIVATE_CAUSE"

                def fail_capture(root, destination, release, context):
                    journal = UPDATE.read_journal(destination, root, context, CURRENT, TARGET)
                    self.assertEqual(journal["stage"], "snapshotting")
                    self.assertTrue(all(state == "exited" for state in fake.states.values()))
                    destination.mkdir()
                    (destination / "partial").write_text("incomplete snapshot fixture\n")
                    raise UPDATE.SNAPSHOT.SnapshotError(code) from OSError(secret)

                with (
                    mock.patch.object(UPDATE.HOST, "docker", side_effect=fake),
                    mock.patch.object(UPDATE.SNAPSHOT, "capture", side_effect=fail_capture),
                    mock.patch.object(UPDATE.HOST.STAGE, "stage") as stage,
                    mock.patch.object(UPDATE.subprocess, "run") as local_process,
                ):
                    with self.assertRaisesRegex(RuntimeError, "previous release was restored") as raised:
                        UPDATE.apply_update(self.root, CURRENT, TARGET, "test-daemon", snapshot)

                stage.assert_not_called()
                local_process.assert_not_called()
                self.assertFalse(UPDATE.SNAPSHOT.sidecar(snapshot).exists())
                self.assertEqual(fake.image, CURRENT_IMAGE)
                self.assertTrue(all(state == "running" for state in fake.states.values()))
                starts = [call for call in fake.calls if call[0] == "compose" and "up" in call]
                self.assertEqual(len(starts), 1)
                self.assertIn("--force-recreate", starts[0])
                self.assertEqual((self.root / "data" / "postgres" / "record").read_text(), "original database fixture\n")
                self.assertIn(CURRENT["digest"], (self.root / "orbis-compose.yml").read_text())
                journal = UPDATE.read_journal(snapshot, self.root, "test-daemon", CURRENT, TARGET)
                self.assertEqual(journal["stage"], "rolled-back")
                self.assertEqual(journal["failureStage"], "snapshotting")
                self.assertEqual(journal["failureCode"], code)
                self.assertEqual(journal["failureType"], "SnapshotError")
                self.assertNotIn(secret, json.dumps(journal))
                self.assertNotIn(secret, str(raised.exception))

    def test_unrecognized_failure_code_and_unsafe_exception_type_are_not_copied_to_journal(self):
        fake = FakeDocker(self.root)
        secret = "PRIVATE_FAILURE"
        unsafe_type = type("Unsafe\nFailure", (RuntimeError,), {})
        failure = unsafe_type(secret)
        failure.code = secret

        def fail_capture(root, destination, release, context):
            self.assertEqual(UPDATE.read_journal(destination, root, context, CURRENT, TARGET)["stage"], "snapshotting")
            raise failure

        with (
            mock.patch.object(UPDATE.HOST, "docker", side_effect=fake),
            mock.patch.object(UPDATE.SNAPSHOT, "capture", side_effect=fail_capture),
            mock.patch.object(UPDATE.HOST.STAGE, "stage") as stage,
            mock.patch.object(UPDATE.subprocess, "run") as local_process,
        ):
            with self.assertRaisesRegex(RuntimeError, "previous release was restored"):
                UPDATE.apply_update(self.root, CURRENT, TARGET, "test-daemon", self.snapshot)

        stage.assert_not_called()
        local_process.assert_not_called()
        journal = UPDATE.read_journal(self.snapshot, self.root, "test-daemon", CURRENT, TARGET)
        self.assertEqual(journal["stage"], "rolled-back")
        self.assertEqual(journal["failureStage"], "snapshotting")
        self.assertEqual(journal["failureCode"], "update-step-failed")
        self.assertRegex(journal["failureType"], r"\A[A-Za-z_][A-Za-z0-9_]*\Z")
        self.assertNotIn(secret, json.dumps(journal))
        self.assertEqual(fake.image, CURRENT_IMAGE)
        self.assertTrue(all(state == "running" for state in fake.states.values()))

    def test_refuses_a_running_managed_app_before_pull_or_stop(self):
        fake = FakeDocker(self.root)
        original = fake.__call__

        def with_app(context, arguments, root):
            if arguments[0] == "ps":
                return subprocess.CompletedProcess(arguments, 0, "runtipi\nruntipi-db\nruntipi-queue\nruntipi-reverse-proxy\napp", "")
            if arguments[0] == "inspect" and arguments[3] == "app":
                if arguments[2] == "{{json .Config.Labels}}":
                    return subprocess.CompletedProcess(arguments, 0, json.dumps({"runtipi.managed": "true"}), "")
                if arguments[2] == "{{json .Mounts}}":
                    return subprocess.CompletedProcess(arguments, 0, "[]", "")
            return original(context, arguments, root)

        with mock.patch.object(UPDATE.HOST, "docker", side_effect=with_app):
            with self.assertRaisesRegex(ValueError, "stop Runtipi-managed applications"):
                UPDATE.apply_update(self.root, CURRENT, TARGET, "test-daemon", self.snapshot)
        self.assertFalse(UPDATE.journal_path(self.snapshot).exists())
        self.assertFalse(any("pull" in call for call in fake.calls))

    def test_recover_restores_a_staged_transaction_after_interruption(self):
        fake = FakeDocker(self.root)
        fake.states = {service: "exited" for service in UPDATE.CORE_SERVICES}
        UPDATE.SNAPSHOT.capture(self.root, self.snapshot, CURRENT["tag"], "test-daemon")
        UPDATE.HOST.STAGE.stage(self.root, TARGET)
        record = {
            "schema": UPDATE.JOURNAL_SCHEMA,
            "root": str(self.root),
            "snapshot": str(self.snapshot),
            "dockerContext": "test-daemon",
            "previousDigest": CURRENT["digest"],
            "targetDigest": TARGET["digest"],
            "stage": "staged",
            "progressPhase": "verifying",
        }
        UPDATE.write_journal(self.snapshot, record)

        with mock.patch.object(UPDATE.HOST, "docker", side_effect=fake):
            result = UPDATE.recover(self.root, CURRENT, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(result["result"], "rolled-back")
        self.assertEqual(fake.image, CURRENT_IMAGE)
        recovered = UPDATE.read_journal(self.snapshot, self.root, "test-daemon", CURRENT, TARGET)
        self.assertEqual(recovered["stage"], "rolled-back")
        self.assertEqual(recovered["rollbackStartedFrom"], "staged")

    def test_recover_before_downtime_leaves_healthy_core_running(self):
        fake = FakeDocker(self.root)
        record = {
            "schema": UPDATE.JOURNAL_SCHEMA,
            "root": str(self.root),
            "snapshot": str(self.snapshot),
            "dockerContext": "test-daemon",
            "previousDigest": CURRENT["digest"],
            "targetDigest": TARGET["digest"],
            "stage": "pulled",
        }
        UPDATE.write_journal(self.snapshot, record)
        with mock.patch.object(UPDATE.HOST, "docker", side_effect=fake):
            result = UPDATE.recover(self.root, CURRENT, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(result["result"], "aborted-before-downtime")
        self.assertEqual(fake.image, CURRENT_IMAGE)
        self.assertFalse(any(call[0] == "stop" for call in fake.calls))
        self.assertEqual(UPDATE.read_journal(self.snapshot, self.root, "test-daemon", CURRENT, TARGET)["stage"], "aborted")

    def test_corrupt_snapshot_blocks_recovery_before_restore(self):
        fake = FakeDocker(self.root)
        fake.states = {service: "exited" for service in UPDATE.CORE_SERVICES}
        UPDATE.SNAPSHOT.capture(self.root, self.snapshot, CURRENT["tag"], "test-daemon")
        (self.snapshot / "data" / "postgres" / "record").write_text("corrupt")
        record = {
            "schema": UPDATE.JOURNAL_SCHEMA,
            "root": str(self.root),
            "snapshot": str(self.snapshot),
            "dockerContext": "test-daemon",
            "previousDigest": CURRENT["digest"],
            "targetDigest": TARGET["digest"],
            "stage": "snapshot-ready",
        }
        UPDATE.write_journal(self.snapshot, record)
        with mock.patch.object(UPDATE.HOST, "docker", side_effect=fake):
            with self.assertRaisesRegex(RuntimeError, "recovery failed"):
                UPDATE.recover(self.root, CURRENT, TARGET, "test-daemon", self.snapshot)
        self.assertEqual(fake.states["runtipi"], "exited")
        self.assertEqual(UPDATE.read_journal(self.snapshot, self.root, "test-daemon", CURRENT, TARGET)["stage"], "rollback-failed")


if __name__ == "__main__":
    unittest.main()
