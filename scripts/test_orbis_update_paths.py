import contextlib
import copy
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GUIDE = load('orbis-install')
SERVICE = load('orbis-host-service')
FIXTURE = load('test_orbis_install_transaction')
UPDATE = load('orbis-host-update')
CURRENT = {'schema': 'orbis.release.v1', 'image': 'ghcr.io/twentylines/orbis', 'tag': 'v0.1.0-beta.76', 'commit': 'a' * 40, 'digest': 'sha256:' + 'b' * 64, 'runtipiCompatibility': '4.10.1'}
TARGET = {**CURRENT, 'tag': 'v0.1.0-beta.77', 'commit': 'c' * 40, 'digest': 'sha256:' + 'd' * 64, 'installationProtocol': 'orbis.installation-state.v1'}


class InstallerUpdateTests(unittest.TestCase):
    def test_installed_entry_updates_without_an_extra_offer_or_replacement(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            manifest = root / 'release.json'; manifest.write_text(json.dumps(TARGET))
            selected = {'installRoot': str(root), 'product': 'orbis', 'reviewRequired': []}
            argv = ['installer', '--manifest', str(manifest), '--state-dir', str(root / 'private'), '--yes', '--accept-nightly', '--root', str(root)]
            with mock.patch.object(sys, 'argv', argv), mock.patch.object(GUIDE.sys, 'platform', 'linux'), mock.patch.object(GUIDE.os, 'geteuid', return_value=0), mock.patch.object(GUIDE.APPS, 'Docker') as docker, mock.patch.object(GUIDE.REPLACE, 'Engine'), mock.patch.object(GUIDE.APPS.DETECT, 'discover', return_value={'installations': [selected]}), mock.patch.object(GUIDE, 'update_existing', return_value={'result': 'orbis-updated'}) as update, mock.patch.object(GUIDE, 'replacement') as replacement, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(GUIDE.main(), 0)
            update.assert_called_once()
            self.assertEqual(update.call_args.args[:3], (root, docker.return_value, TARGET))
            replacement.assert_not_called()

    def exercise(self, *, target=TARGET, status=None, apply_error=None, channel='nightly'):
        root = Path('/opt/owned-server')
        channel_reads = [
            {'channel': channel, 'revision': 'initial'},
            {'channel': 'nightly', 'revision': 'selected'},
        ] if channel == 'stable' else [{'channel': channel, 'revision': 'initial'}]
        upgrade = SimpleNamespace(SERVICE=SimpleNamespace(
            installed_manifest=mock.Mock(return_value=CURRENT),
            read_channel=mock.Mock(side_effect=channel_reads),
        ), SETUP=SimpleNamespace(SOCKET_FILE=Path('/run/orbis/host.sock')), upgrade=mock.Mock())
        enable = SimpleNamespace(enable=mock.Mock())
        planned = {'planId': 'owned-plan', 'targetTag': target['tag'], 'targetDigest': target['digest']}
        accepted = {'jobId': 'owned-plan', 'state': 'running'}
        complete = {'job': {'id': 'owned-plan', 'state': 'complete'}, 'currentDigest': target['digest'], 'imageMatches': True, 'coreHealth': 'healthy'}
        calls = []
        def request(socket, endpoint, body=None):
            calls.append((endpoint, body))
            if endpoint == '/v1/plan': return planned
            if endpoint == '/v1/apply':
                if apply_error: raise apply_error
                return accepted
            return status or complete
        def module(name, _):
            return upgrade if name == 'orbis-host-service-upgrade.py' else enable
        with mock.patch.object(GUIDE, 'load', side_effect=module), mock.patch.object(GUIDE.REPLACE.UPDATE, 'verify_release'), mock.patch.object(GUIDE, 'host_request', side_effect=request), mock.patch.object(GUIDE.time, 'sleep'), contextlib.redirect_stdout(io.StringIO()):
            result = GUIDE.update_existing(root, SimpleNamespace(context='owned'), target, GUIDE.UI.Presentation(interactive=False))
        return result, calls, upgrade

    def test_latest_installer_checks_and_applies_exactly_once(self):
        result, calls, upgraded = self.exercise()
        self.assertEqual(result['result'], 'orbis-updated')
        self.assertEqual([x[0] for x in calls], ['/v1/plan', '/v1/apply', '/v1/status'])
        upgraded.upgrade.assert_called_once()

    def test_explicit_nightly_update_from_stable_selects_channel_before_planning(self):
        _, calls, upgrade = self.exercise(channel='stable')
        self.assertEqual([endpoint for endpoint, _ in calls], ['/v1/channel', '/v1/plan', '/v1/apply', '/v1/status'])
        self.assertEqual(calls[0][1], {'channel': 'nightly', 'revision': 'initial', 'acknowledgeNightly': True})
        self.assertEqual(upgrade.SERVICE.read_channel.call_count, 2)

    def test_current_release_is_a_clear_noop_and_never_reapplies(self):
        result, calls, _ = self.exercise(target=CURRENT)
        self.assertEqual(result['result'], 'up-to-date')
        self.assertEqual(calls, [])

    def test_old_pinned_installer_cannot_downgrade(self):
        with self.assertRaisesRegex(ValueError, 'newer.*no downgrade'):
            self.exercise(target={**CURRENT, 'tag': 'v0.1.0-beta.9'})

    def test_failed_job_is_not_retried(self):
        with self.assertRaisesRegex(ValueError, 'storage changed.*Do not retry'):
            self.exercise(status={'job': {'id': 'owned-plan', 'state': 'failed', 'message': 'storage changed'}})

    def test_lost_apply_acknowledgement_observes_the_same_job_without_reapplying(self):
        result, calls, _ = self.exercise(apply_error=TimeoutError('connection lost after acceptance'))
        self.assertEqual(result['result'], 'orbis-updated')
        self.assertEqual(sum(endpoint == '/v1/apply' for endpoint, _ in calls), 1)
        self.assertEqual(sum(endpoint == '/v1/status' for endpoint, _ in calls), 2)

    def test_semver_numeric_prereleases_and_stable_order(self):
        self.assertLess(GUIDE.release_order('v0.1.0-beta.9'), GUIDE.release_order('v0.1.0-beta.10'))
        self.assertLess(GUIDE.release_order('v0.1.0-beta.100'), GUIDE.release_order('v0.1.0'))
        self.assertLess(GUIDE.release_order('v0.1.0'), GUIDE.release_order('v0.2.0-beta.1'))


class UpdateServiceTests(unittest.TestCase):
    def test_terminal_tail_streams_new_output_and_keeps_credentials_and_controls_private(self):
        with tempfile.TemporaryDirectory() as folder:
            log = Path(folder) / 'package.log'
            log.write_bytes(b'\x1b[32mUnpacking example 1.2\x1b[0m\nhttps://user:private-pass@mirror.example/package?token=private-token\nAuthorization: Bearer PRIVATE_AUTH\npassword=private multi word value\n')
            log.chmod(0o600)
            first = SERVICE.terminal_tail(log)
            self.assertIn('Unpacking example 1.2', first['text'])
            for secret in ['private-pass', 'private-token', 'PRIVATE_AUTH', 'private multi word value', '\x1b']:
                self.assertNotIn(secret, first['text'])
            with log.open('ab') as output: output.write(b'Setting up example 1.2\n')
            second = SERVICE.terminal_tail(log)
            self.assertIn('Setting up example 1.2', second['text'])
            self.assertGreater(second['bytes'], first['bytes'])
            self.assertFalse(second['truncated'])

    def test_terminal_tail_is_bounded_and_refuses_symlinks_and_public_files(self):
        with tempfile.TemporaryDirectory() as folder:
            log = Path(folder) / 'package.log'; log.write_bytes(b'old output\n' * 2000 + b'finished\n'); log.chmod(0o600)
            result = SERVICE.terminal_tail(log)
            self.assertTrue(result['truncated']); self.assertLessEqual(len(result['text'].encode()), SERVICE.PACKAGE_OUTPUT_BYTES)
            self.assertTrue(result['text'].endswith('finished\n'))
            link = Path(folder) / 'link'; link.symlink_to(log)
            with self.assertRaises(OSError): SERVICE.terminal_tail(link)
            log.chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'private regular file'): SERVICE.terminal_tail(log)

    def test_job_output_is_scoped_to_the_validated_job_and_missing_log_waits(self):
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder).resolve()
            for name in ['root', 'snapshots', 'state']: (parent / name).mkdir(mode=0o700)
            service = SERVICE.HostService(parent/'root', 'owned', parent/'snapshots', parent/'state')
            identifier = '00000000-0000-4000-8000-000000000001'
            self.assertEqual(service.public_package_job({'id': identifier})['output']['text'], '')
            with self.assertRaises(ValueError): service.public_package_job({'id': '../../other'})

    def test_release_protocol_survives_host_manifest_verification(self):
        published = {'image': TARGET['image'] + '@' + TARGET['digest'], 'commit': TARGET['commit'], 'runtipiCompatibility': TARGET['runtipiCompatibility'], 'installationProtocol': TARGET['installationProtocol']}
        with mock.patch.object(SERVICE.CHECK, 'check', return_value=published):
            self.assertEqual(SERVICE.manifest_for_tag(TARGET['tag']), TARGET)

    def test_apply_acknowledges_before_slow_revalidation_and_does_not_replay(self):
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder).resolve()
            root, snapshots, state = [parent / name for name in ('root', 'snapshots', 'state')]
            for path in (root, snapshots, state): path.mkdir(mode=0o700)
            service = SERVICE.HostService(root, 'owned', snapshots, state)
            SERVICE.save_channel(root, 'nightly', '00000000-0000-4000-8000-000000000002')
            with mock.patch.object(service, 'current_manifest', return_value=CURRENT), mock.patch.object(SERVICE, 'manifest_for_tag', return_value=TARGET), mock.patch.object(SERVICE.UPDATE, 'update_plan', return_value={'snapshotBytes': 1, 'runningAppsMustBeStopped': False}) as validate:
                plan = service.plan(TARGET['tag']); validate.reset_mock()
                self.assertFalse(plan['appsMustBeStopped'])
                accepted, _ = service.apply(plan['planId'])
                validate.assert_not_called()
                self.assertEqual(accepted['state'], 'running')
                self.assertEqual(SERVICE.read_private(service.job_file)['id'], plan['planId'])
                with self.assertRaisesRegex(ValueError, 'in progress'):
                    service.apply(plan['planId'])


class ScopedUpdateTests(unittest.TestCase):
    setUp = FIXTURE.TransactionTests.setUp
    states = FIXTURE.TransactionTests.states

    def prepare(self):
        (self.root / 'VERSION').write_text('4.10.1\n')
        (self.root / 'orbis-compose.yml').write_text(UPDATE.HOST.STAGE.staged_content(CURRENT))
        self.old_apps = copy.deepcopy(self.docker.apps)
        for owner, name, value in [
            (UPDATE.HOST.PLAN, 'plan', {'configuredImage': CURRENT['image'] + '@' + CURRENT['digest']}),
            (UPDATE.HOST, 'current_core', {'image': CURRENT['image'] + '@' + CURRENT['digest'], 'state': 'running', 'health': 'healthy'}),
            (UPDATE, 'core_ownership', set(UPDATE.CORE_SERVICES)),
            (UPDATE.CHECK, 'check', {'image': TARGET['image'] + '@' + TARGET['digest'], 'commit': TARGET['commit'], 'runtipiCompatibility': TARGET['runtipiCompatibility'], 'installationProtocol': TARGET['installationProtocol']}),
            (UPDATE, 'controller_tools', (FIXTURE.TX, self.docker)),
        ]:
            patch = mock.patch.object(owner, name, return_value=value); patch.start(); self.addCleanup(patch.stop)
        patch = mock.patch.object(UPDATE, 'docker_checked', return_value='owned-daemon'); patch.start(); self.addCleanup(patch.stop)
        UPDATE.HOST.write_state(self.root, UPDATE.HOST.installation_fingerprint(self.root, CURRENT, self.docker.context))

    def test_managed_apps_keep_running_and_live_data_is_not_scanned(self):
        self.prepare()
        os.mkfifo(self.root / 'app-data/app-0/live-pipe')
        with mock.patch.object(UPDATE, 'require_quiet_apps', side_effect=AssertionError('apps must remain live')), mock.patch.object(UPDATE.SNAPSHOT, 'preflight', side_effect=AssertionError('whole app data must not be scanned')):
            planned = UPDATE.update_plan(self.root, CURRENT, TARGET, self.docker.context, self.bundle)
        self.assertFalse(planned['runningAppsMustBeStopped'])
        self.assertEqual(planned['checkpoint']['storage']['resources'][0]['excludedPaths'], ['app-data'])
        self.assertEqual(self.docker.apps, self.old_apps)
        self.assertEqual(self.docker.calls, [])

    def test_unknown_metadata_writer_still_blocks_before_any_service_change(self):
        self.prepare()
        app = next(iter(self.docker.apps.values()))
        app['mounts'].append({'Type': 'bind', 'Source': str(self.root / '.env'), 'Destination': '/unsafe', 'RW': True})
        with self.assertRaisesRegex(ValueError, '(?s)Another container.*writable'):
            UPDATE.update_plan(self.root, CURRENT, TARGET, self.docker.context, self.bundle)
        self.assertEqual(self.docker.calls, [])

    @unittest.skipUnless(sys.platform == 'linux', 'requires Linux rsync with ACL/xattr support')
    def test_scoped_start_failure_restores_control_data_and_retains_new_live_app_writes(self):
        self.prepare()
        data = self.root / 'app-data/app-0/live'
        data.write_bytes(b'original app data')
        database = self.root / 'controller-database'
        database.write_bytes(b'original control database')
        def checked(context, arguments, root, message):
            if arguments[0] == 'inspect':
                return self.docker.controller_id if arguments[-1] == 'runtipi' else FIXTURE.identifier(arguments[-1])
            return 'pulled'
        def stop(*_args, **_kwargs):
            self.docker.controller_state = 'exited'
            for service in self.docker.services.values(): service['state'] = 'exited'
        def start(*_args, **_kwargs):
            if TARGET['digest'] in (self.root / 'orbis-compose.yml').read_text():
                database.write_bytes(b'failed new control database')
                data.write_bytes(b'new application writes while updating')
                raise RuntimeError('synthetic target start failure')
            self.docker.controller_state = 'running'
            for service in self.docker.services.values(): service['state'] = 'running'
        with mock.patch.object(UPDATE, 'docker_checked', side_effect=checked), mock.patch.object(UPDATE, 'start_core', side_effect=start), mock.patch.object(UPDATE, 'stop_core', side_effect=stop):
            with self.assertRaisesRegex(RuntimeError, 'previous release was restored'):
                UPDATE.apply_update(self.root, CURRENT, TARGET, self.docker.context, self.bundle)
        self.assertEqual(database.read_bytes(), b'original control database')
        self.assertEqual(data.read_bytes(), b'new application writes while updating')
        self.assertEqual(self.docker.apps, self.old_apps)
        self.assertTrue(all(arguments[-1] not in self.old_apps for arguments, _ in self.docker.calls))
        self.assertEqual(UPDATE.read_journal(self.bundle, self.root, self.docker.context, CURRENT, TARGET)['stage'], 'rolled-back')


class ScopedRecoveryTests(unittest.TestCase):
    def test_checkpoint_recheck_failure_aborts_without_stopping_or_replaying(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'root'; root.mkdir()
            snapshot = Path(folder) / 'backup'
            checkpoint = {'storage': {'bundle': str(snapshot), 'resources': []}}
            tools = SimpleNamespace(validate_review=mock.Mock(), checkpoint=mock.Mock(side_effect=ValueError('changed before checkpoint')), recover=mock.Mock())
            with mock.patch.object(UPDATE, 'update_plan', return_value={'checkpoint': checkpoint}), mock.patch.object(UPDATE, 'controller_tools', return_value=(tools, SimpleNamespace())), mock.patch.object(UPDATE, 'docker_checked', return_value='pulled'), mock.patch.object(UPDATE, 'core_ownership'), mock.patch.object(UPDATE.HOST, 'installation_fingerprint', return_value={}), mock.patch.object(UPDATE.HOST, 'require_current_state'), mock.patch.object(UPDATE.HOST, 'current_core', return_value={'image': CURRENT['image']+'@'+CURRENT['digest'], 'state': 'running', 'health': 'healthy'}), mock.patch.object(UPDATE, 'stop_core') as stop:
                with self.assertRaisesRegex(RuntimeError, 'before service downtime'):
                    UPDATE.apply_update(root, CURRENT, TARGET, 'owned', snapshot)
            self.assertEqual(UPDATE.read_journal(snapshot, root, 'owned', CURRENT, TARGET)['stage'], 'aborted')
            self.assertFalse(UPDATE.checkpoint_path(snapshot).exists())
            self.assertFalse(snapshot.exists())
            stop.assert_not_called()
            tools.recover.assert_not_called()

    def test_recovery_keeps_pre_checkpoint_origin_after_a_transient_health_probe_error(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'root'; root.mkdir()
            snapshot = Path(folder) / 'backup'
            checkpoint = {'storage': {'bundle': str(snapshot), 'resources': []}}
            tools = SimpleNamespace(validate_review=mock.Mock(), checkpoint=mock.Mock(side_effect=ValueError('changed before checkpoint')), recover=mock.Mock())
            healthy = {'image': CURRENT['image']+'@'+CURRENT['digest'], 'state': 'running', 'health': 'healthy'}
            with mock.patch.object(UPDATE, 'update_plan', return_value={'checkpoint': checkpoint}), mock.patch.object(UPDATE, 'controller_tools', return_value=(tools, SimpleNamespace())), mock.patch.object(UPDATE, 'docker_checked', return_value='pulled'), mock.patch.object(UPDATE, 'core_ownership'), mock.patch.object(UPDATE.HOST, 'installation_fingerprint', return_value={}), mock.patch.object(UPDATE.HOST, 'require_current_state'), mock.patch.object(UPDATE.HOST, 'current_core', side_effect=[OSError('temporary inspection failure'), healthy]), mock.patch.object(UPDATE, 'stop_core') as stop:
                with self.assertRaisesRegex(RuntimeError, 'automatic rollback failed'):
                    UPDATE.apply_update(root, CURRENT, TARGET, 'owned', snapshot)
                failed = UPDATE.read_journal(snapshot, root, 'owned', CURRENT, TARGET)
                self.assertEqual((failed['stage'], failed['rollbackStartedFrom']), ('rollback-failed', 'stopping'))
                result = UPDATE.recover(root, CURRENT, TARGET, 'owned', snapshot)
            self.assertEqual(result['result'], 'aborted-before-downtime')
            self.assertEqual(UPDATE.read_journal(snapshot, root, 'owned', CURRENT, TARGET)['stage'], 'aborted')
            stop.assert_not_called()
            tools.recover.assert_not_called()

    def test_retry_after_completed_restore_uses_fresh_journal_and_can_start_old_core(self):
        transaction = UPDATE.load_script('orbis-install-transaction.py', 'orbis_update_recovery_fixture')
        restore = transaction.RESTORE
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'root'; root.mkdir()
            snapshot = Path(folder) / 'backup'; snapshot.mkdir()
            storage = {'bundle': str(snapshot), 'resources': []}
            checkpoint = {'storage': storage}
            manifest = {'plan': storage, 'copies': []}
            saved = {'bundle': str(snapshot), 'extendedMetadataSealed': True}
            tools = SimpleNamespace(validate_review=mock.Mock(), STORAGE=restore.STORAGE, RESTORE=restore)
            record = {'stage': 'staged', 'backupScope': 'controller', 'checkpoint': checkpoint}
            healthy = {'image': CURRENT['image']+'@'+CURRENT['digest'], 'state': 'running', 'health': 'healthy'}
            with mock.patch.object(UPDATE, 'write_journal'), mock.patch.object(UPDATE, 'controller_tools', return_value=(tools, SimpleNamespace())), mock.patch.object(UPDATE, 'core_ownership', return_value=set()), mock.patch.object(UPDATE, 'stop_core'), mock.patch.object(UPDATE, 'start_core', side_effect=[RuntimeError('temporary old-core startup failure'), None]) as start, mock.patch.object(UPDATE, 'restore_core_policies'), mock.patch.object(UPDATE.HOST, 'installation_fingerprint', return_value={}), mock.patch.object(UPDATE.HOST, 'require_current_state'), mock.patch.object(UPDATE.HOST, 'current_core', return_value=healthy), mock.patch.object(restore, 'runtime'), mock.patch.object(restore, 'validate_review'), mock.patch.object(restore, 'review', return_value=saved), mock.patch.object(restore, 'review_value', return_value=saved), mock.patch.object(restore.STORAGE, 'verified_manifest', return_value=manifest):
                with self.assertRaisesRegex(RuntimeError, 'old-core startup failure'):
                    UPDATE.rollback(root, CURRENT, 'owned', snapshot, record)
                original = snapshot.with_name(snapshot.name + '.restore.json')
                self.assertEqual(json.loads(original.read_text())['stage'], 'complete')
                record['stage'] = 'rollback-failed'
                UPDATE.rollback(root, CURRENT, 'owned', snapshot, record)
            self.assertEqual(start.call_count, 2)
            self.assertEqual(record['stage'], 'rolled-back')
            journals = list(Path(folder).glob('backup.restore*.json'))
            self.assertEqual(len(journals), 2)
            self.assertTrue(all(json.loads(file.read_text())['stage'] == 'complete' for file in journals))


if __name__ == '__main__':
    unittest.main()
