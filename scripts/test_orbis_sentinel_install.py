import hashlib
import fcntl
import io
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock
import uuid


SPEC = importlib.util.spec_from_file_location('sentinel_installer_tests', Path(__file__).with_name('orbis-sentinel-install.py'))
INSTALL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALL)


def digest(body):
    return hashlib.sha256(body).hexdigest()


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.root.chmod(0o700)
        for name, value in [('OWNER', os.geteuid()), ('require_host', lambda: None)]:
            patch = mock.patch.object(INSTALL, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        self.payloads = {name: ('verified fixture ' + name).encode() for name in INSTALL.TOOLKIT}
        self.toolkit = {name: (len(body), digest(body)) for name, body in self.payloads.items()}
        self.commands = []
        self.downloads = []
        self.binary = b'verifier fixture; never executed'
        self.archive = b'archive fixture; never executed'
        self.spec = {'version': '2.103.3', 'architecture': 'amd64', 'archiveBytes': len(self.archive),
                     'archiveSha256': digest(self.archive), 'binaryBytes': len(self.binary), 'binarySha256': digest(self.binary),
                     'url': 'https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_amd64.tar.gz'}
        self.release = {**INSTALL.RELEASE, 'sha256': digest(b'package fixture')}

    def download(self, work, path, url, maximum, *, size=0, digest=''):
        self.downloads.append((path.name, url, maximum))
        if path.parent.name == 'toolkit':
            body = self.payloads[path.name]
        elif path.name == 'github-cli.tar.gz':
            body = self.archive
        elif path.name.endswith('.sigstore.json'):
            body = b'public signature fixture'
        else:
            body = b'package fixture'
        path.write_bytes(body)
        path.chmod(0o600)
        return INSTALL._file(path, size, digest, maximum=maximum)

    def command(self, work, name, code, arguments, **options):
        self.commands.append((name, code, list(arguments), options))
        if name == 'verifier-spec':
            self.assertEqual(len(list((work / 'toolkit').iterdir())), len(self.toolkit))
            return json.dumps(self.spec).encode()
        if name == 'bootstrap-verifier':
            verifier = Path(arguments[2]) / 'pinned-gh'
            if not verifier.exists():
                verifier.write_bytes(self.binary)
                verifier.chmod(0o555)
            return json.dumps({'verifier': str(verifier)}).encode()
        if name == 'verify-package':
            return json.dumps({**self.release, 'publisherVerified': True, 'activated': False}).encode()
        if name == 'activate-sentinel':
            return json.dumps({**self.release, 'publisherVerified': True, 'activated': True, 'retainedVersionsRemoved': 0}).encode()
        raise AssertionError('Unexpected command')

    def prepare(self, *, downloader=None, command=None):
        with mock.patch.object(INSTALL, 'TOOLKIT', self.toolkit), mock.patch.object(INSTALL, 'RELEASE', self.release), \
                mock.patch.object(INSTALL, '_download', side_effect=downloader or self.download), \
                mock.patch.object(INSTALL, '_run', side_effect=command or self.command):
            return INSTALL.prepare(self.root)

    def activate(self, prepared, *, command=None):
        with mock.patch.object(INSTALL, 'RELEASE', self.release), mock.patch.object(INSTALL, '_run', side_effect=command or self.command):
            return INSTALL.activate(prepared)

    def prepare_selected(self, release):
        with mock.patch.object(INSTALL, 'TOOLKIT', self.toolkit), \
                mock.patch.object(INSTALL, '_download', side_effect=self.download), \
                mock.patch.object(INSTALL, '_run', side_effect=self.command):
            return INSTALL.prepare_release(self.root, release)

    def test_preparation_checks_toolkit_then_verifier_then_publisher_without_activation(self):
        prepared = self.prepare()
        self.assertEqual([item[0] for item in self.commands], ['verifier-spec', 'bootstrap-verifier', 'verify-package'])
        self.assertFalse(prepared.used)
        self.assertEqual(len(prepared.files), len(self.toolkit) + 4)
        self.assertEqual(len(self.downloads), len(self.toolkit) + 3)
        for name, url, _ in self.downloads[:len(self.toolkit)]:
            self.assertIn(INSTALL.TOOLKIT_COMMIT, url)
            self.assertTrue(url.endswith('/' + name))

    def test_every_invocation_gets_a_fresh_namespace_and_reuses_only_verified_cache(self):
        first = self.prepare()
        second = self.prepare()
        self.assertNotEqual(first.work, second.work)
        self.assertEqual(first.verifier, second.verifier)
        self.assertNotEqual(first.files[0]['identity'], second.files[0]['identity'])

    def test_changed_toolkit_during_download_is_rejected_before_any_code_runs(self):
        def download(*args, **kwargs):
            result = self.download(*args, **kwargs)
            if args[1].name == 'LICENSE':
                (args[0] / 'toolkit' / 'stage_release.py').write_bytes(b'changed')
            return result
        with self.assertRaises(INSTALL.SentinelInstallError):
            self.prepare(downloader=download)
        self.assertEqual(self.commands, [])

    def test_failed_source_download_is_retained_and_never_executes_tooling(self):
        def download(*args, **kwargs):
            if args[1].name == 'stage_release.py':
                raise TimeoutError('controlled download timeout')
            return self.download(*args, **kwargs)
        with self.assertRaises(TimeoutError):
            self.prepare(downloader=download)
        self.assertEqual(self.commands, [])
        self.assertTrue(list(self.root.glob('sentinel-install-*/toolkit/activate_release.py')))

    def test_bad_publisher_result_cannot_return_a_prepared_activation(self):
        def command(*args, **kwargs):
            if args[1] == 'verify-package':
                return json.dumps({**self.release, 'publisherVerified': False, 'activated': False}).encode()
            return self.command(*args, **kwargs)
        with self.assertRaises(INSTALL.SentinelInstallError):
            self.prepare(command=command)
        self.assertNotIn('activate-sentinel', [item[0] for item in self.commands])

    def test_activation_consumes_once_and_rechecks_every_prepared_file(self):
        prepared = self.prepare()
        result = self.activate(prepared)
        self.assertTrue(result['activated'])
        command = self.commands[-1]
        self.assertEqual(command[0], 'activate-sentinel')
        self.assertIsNone(command[3]['timeout'])
        self.assertEqual(command[2][-2:], ['--source-commit', self.release['sourceCommit']])
        with self.assertRaisesRegex(INSTALL.SentinelInstallError, 'already been consumed'):
            self.activate(prepared)
        self.assertEqual(sum(item[0] == 'activate-sentinel' for item in self.commands), 1)

    def retained_binding(self):
        return {'operationId': str(uuid.uuid4()), 'planSha256': '2' * 64, 'targetDigest': 'sha256:' + '3' * 64}

    def lease_state(self):
        state = self.root / 'installed-state'
        state.mkdir(mode=0o700)
        lock = state / 'activation.lock'
        lock.write_bytes(b'')
        lock.chmod(0o600)
        patch = mock.patch.object(INSTALL, 'INSTALLED_STATE', state)
        patch.start()
        self.addCleanup(patch.stop)
        return state, lock

    def lease_preparation(self, body=None):
        body = body if body is not None else b"ACTIVATION_LEASE_PROTOCOL='orbis-sentinel.activation-lease.v1'\n"
        self.payloads['activate_release.py'] = body
        self.toolkit['activate_release.py'] = (len(body), digest(body))
        return self.prepare_selected(self.release)

    def test_activation_lease_is_opaque_exclusive_and_expires_when_closed(self):
        _state, lock = self.lease_state()
        other = os.open(lock, os.O_RDWR)
        try:
            with INSTALL.activation_lease() as lease:
                lease.verify()
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(BlockingIOError):
                    with INSTALL.activation_lease():
                        self.fail('A second lease must not be admitted')
                with self.assertRaises(INSTALL.SentinelInstallError):
                    INSTALL.ActivationLease().verify()
            fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(INSTALL.SentinelInstallError):
                lease.verify()
        finally:
            os.close(other)

    def test_lease_never_creates_or_adopts_a_missing_unprotected_or_aliased_lock(self):
        state, lock = self.lease_state()
        lock.unlink()
        with self.assertRaises(FileNotFoundError):
            with INSTALL.activation_lease():
                self.fail('Missing lock cannot be created')
        self.assertFalse(lock.exists())
        for change in ('public', 'symlink', 'hardlink'):
            with self.subTest(change=change):
                lock.write_bytes(b'')
                lock.chmod(0o600)
                if change == 'public':
                    lock.chmod(0o644)
                elif change == 'symlink':
                    lock.rename(state / 'original')
                    lock.symlink_to(state / 'original')
                else:
                    os.link(lock, state / 'alias')
                with self.assertRaises((OSError, INSTALL.SentinelInstallError)):
                    with INSTALL.activation_lease():
                        self.fail('Untrusted lock cannot be adopted')
                lock.unlink()

    def test_lock_replacement_or_permission_change_revokes_lease_before_dispatch(self):
        state, lock = self.lease_state()
        prepared = self.lease_preparation()
        with self.assertRaises(INSTALL.SentinelInstallError):
            with INSTALL.activation_lease() as lease:
                lock.chmod(0o644)
                with self.assertRaises(INSTALL.SentinelInstallError):
                    lease.verify()
                lock.chmod(0o600)
                lock.rename(state / 'held')
                lock.write_bytes(b'')
                lock.chmod(0o600)
                with mock.patch.object(INSTALL, '_run') as run:
                    with self.assertRaises(INSTALL.SentinelInstallError):
                        INSTALL.activate(prepared, retain=self.retained_binding(), lease=lease)
                    run.assert_not_called()
                # Successful context exit also revalidates the original inode.
        self.assertFalse(prepared.used)

    def test_unsupported_toolkit_is_refused_before_consuming_preparation(self):
        self.lease_state()
        for body in (b'def activate_release(): pass\n', b'ACTIVATION_LEASE_PROTOCOL="other"\n',
                     b'ACTIVATION_LEASE_PROTOCOL="orbis-sentinel.activation-lease.v1"\nACTIVATION_LEASE_PROTOCOL="other"\n'):
            with self.subTest(body=body), INSTALL.activation_lease() as lease:
                prepared = self.lease_preparation(body)
                with mock.patch.object(INSTALL, '_run') as run:
                    with self.assertRaises(INSTALL.SentinelInstallError):
                        INSTALL.activate(prepared, retain=self.retained_binding(), lease=lease)
                    run.assert_not_called()
                self.assertFalse(prepared.used)

    def test_coordinated_child_receives_only_registered_lease_for_activation_and_return(self):
        self.lease_state()
        prepared = self.lease_preparation()
        binding = self.retained_binding()
        ticket = self.retained_ticket(binding)
        with INSTALL.activation_lease() as lease:
            def command(work, name, code, arguments, **options):
                descriptor = INSTALL._activation_lease_descriptor(lease)
                self.assertEqual(options['descriptors'], (descriptor,))
                if name == 'activate-sentinel':
                    self.assertEqual(json.loads(arguments[1])['activation_lock_fd'], descriptor)
                    return json.dumps({**self.release, 'publisherVerified': True, 'activated': True,
                        'retainedVersionsRemoved': 0, 'activationId': ticket['activationId'],
                        'retainedRollback': ticket}).encode()
                self.assertEqual(name, 'restore-sentinel')
                self.assertEqual(arguments[-1], str(descriptor))
                return json.dumps(self.restored_result(ticket)).encode()
            with mock.patch.object(INSTALL, '_run', side_effect=command):
                self.assertTrue(INSTALL.activate(prepared, retain=binding, lease=lease)['activated'])
                self.assertTrue(INSTALL.restore_retained(prepared, ticket, binding=binding, lease=lease)['restored'])
            lease.verify()

    def observer_preparation(self):
        return self.lease_preparation(b"ACTIVATION_LEASE_PROTOCOL='orbis-sentinel.activation-lease.v1'\n"
            b"OBSERVER_CHANGE_PROTOCOL='orbis-sentinel.observer-change.v1'\n")

    def observer_ticket(self, retained):
        return {'schema':'orbis-sentinel.observer-change-ticket.v1','id':'a'*32,
                'activationId':retained['activationId'],'binding':retained['binding'],'sha256':'b'*64}

    def observer_profile(self):
        return {'schema':'orbis-sentinel.observer-profile.v1','profile':'orbis-observer-v2','groupId':1234,
                'files':{role:'c'*64 for role in ('collector','host','socket','sysusers')}}

    def test_observer_spec_is_authenticated_and_does_not_consume_preparation(self):
        prepared=self.observer_preparation()
        expected={'schema':'orbis-sentinel.observer-spec.v1','profile':'orbis-observer-v2',
                  'groupName':'orbis-observer','files':self.observer_profile()['files']}
        def command(work,name,code,arguments,**options):
            self.assertEqual(name,'observer-spec');self.assertEqual(code,INSTALL._OBSERVER_COMMAND)
            self.assertEqual(arguments[1],'spec');self.assertEqual(options['descriptors'],())
            return json.dumps(expected).encode()
        with mock.patch.object(INSTALL,'_run',side_effect=command):
            self.assertEqual(INSTALL.observer_profile_spec(prepared),expected)
        self.assertFalse(prepared.used)

    def installed_observation_fixture(self):
        self.lease_state()
        prepared = self.observer_preparation()
        files = {'release.json': {'bytes': 3, 'sha256': 'd' * 64}}
        installed = {'schema': 'orbis-sentinel.installation.v1', **self.release, 'files': files}
        path = INSTALL.INSTALLED_STATE / 'installed.json'
        path.write_text(json.dumps(installed))
        path.chmod(0o600)
        observed = {'release': dict(self.release),
            'inventorySha256': digest((json.dumps(files, sort_keys=True, separators=(',', ':')) + '\n').encode()),
            'profile': None, 'host': {'MainPID': '123', 'InvocationID': 'a' * 32,
                                    'ControlGroup': '/system.slice/orbis-host.service'}}
        return prepared, path, observed

    def test_installed_observation_rechecks_full_payload_and_same_receipt_without_consuming_preparation(self):
        prepared, path, observed = self.installed_observation_fixture()
        with INSTALL.activation_lease() as lease:
            def command(work, name, code, arguments, **options):
                self.assertEqual(name, 'observer-observe')
                self.assertEqual(code, INSTALL._OBSERVER_COMMAND)
                self.assertEqual(arguments[1], 'observe')
                self.assertEqual(options['descriptors'], (INSTALL._activation_lease_descriptor(lease),))
                return json.dumps(observed).encode()
            with mock.patch.object(INSTALL, '_installed_payload') as payload, \
                    mock.patch.object(INSTALL, '_run', side_effect=command):
                self.assertEqual(INSTALL.observe_installation(prepared, lease=lease), observed)
                self.assertEqual(payload.call_count, 2)
            lease.verify()
        self.assertFalse(prepared.used)
        self.assertEqual(len(list(prepared.work.glob('observer-observe-*'))), 1)

    def test_installed_observation_rejects_changed_inventory_receipt_host_frame_and_fake_lease(self):
        prepared, path, observed = self.installed_observation_fixture()
        original = path.read_bytes()
        with mock.patch.object(INSTALL, '_installed_payload'), INSTALL.activation_lease() as lease:
            mutations = [({**observed, 'inventorySha256': '0' * 64}, False),
                         ({**observed, 'host': {**observed['host'], 'InvocationID': ''}}, False),
                         (observed, True)]
            for response, replace in mutations:
                def command(*args, **options):
                    if replace:
                        path.write_bytes(original + b' ')
                    return json.dumps(response).encode()
                with self.subTest(replace=replace, response=response), \
                        mock.patch.object(INSTALL, '_run', side_effect=command), \
                        self.assertRaises(INSTALL.SentinelInstallError):
                    INSTALL.observe_installation(prepared, lease=lease)
                path.write_bytes(original)
            with mock.patch.object(INSTALL, '_run') as run, self.assertRaises(INSTALL.SentinelInstallError):
                INSTALL.observe_installation(prepared, lease=INSTALL.ActivationLease())
            run.assert_not_called()
        self.assertFalse(prepared.used)

    def reconciled_result(self, binding, *, phase='complete'):
        retained = self.retained_ticket(binding)
        return {'retainedRollback': retained, 'candidateRelease': self.release,
                'previousRelease': {**self.release, 'version': '0.1.0-dev.23'},
                'activation': 'candidate',
                'restoration': None,
                'observer': {'ticket': self.observer_ticket(retained), 'phase': phase,
                             'profile': self.observer_profile(), 'originalProfile': None}}

    def test_fresh_reconciliation_registers_only_verified_existing_receipts_and_spends_enrollment(self):
        prepared, path, observed = self.installed_observation_fixture()
        binding = self.retained_binding()
        result = self.reconciled_result(binding)
        with INSTALL.activation_lease() as lease, mock.patch.object(INSTALL, '_installed_payload') as inventory:
            def command(work, name, code, arguments, **options):
                self.assertEqual(name, 'observer-reconcile')
                self.assertEqual(code, INSTALL._RECONCILE_RETAINED)
                self.assertEqual(json.loads(arguments[3]), {'binding': binding})
                self.assertEqual(options['descriptors'], (INSTALL._activation_lease_descriptor(lease),))
                return json.dumps(result).encode()
            with mock.patch.object(INSTALL, '_run', side_effect=command) as run:
                self.assertEqual(INSTALL.reconcile_retained(prepared, binding=binding, lease=lease), result)
                self.assertEqual(inventory.call_count, 2)
                self.assertTrue(prepared.used)
                with self.assertRaises(INSTALL.SentinelInstallError):
                    INSTALL.enroll_observer(prepared, result['retainedRollback'], binding=binding,
                                            lease=lease, ready=lambda *_: None)
                with self.assertRaises(INSTALL.SentinelInstallError):
                    INSTALL.reconcile_retained(prepared, binding=binding, lease=lease)
                self.assertEqual(run.call_count, 1)

    def test_failed_or_crossed_reconciliation_cannot_supply_live_return_authority(self):
        prepared, path, observed = self.installed_observation_fixture()
        binding = self.retained_binding()
        result = self.reconciled_result(binding)
        result['retainedRollback']['binding'] = self.retained_binding()
        with INSTALL.activation_lease() as lease, mock.patch.object(INSTALL, '_installed_payload'), \
                mock.patch.object(INSTALL, '_run', return_value=json.dumps(result).encode()):
            with self.assertRaises(INSTALL.SentinelInstallError):
                INSTALL.reconcile_retained(prepared, binding=binding, lease=lease)
        self.assertFalse(prepared.used)
        self.assertNotIn(prepared, INSTALL._RETENTIONS)
        self.assertNotIn(prepared, INSTALL._OBSERVERS)

    def test_confirmed_returned_observer_is_observed_without_replaying_return(self):
        prepared, path, observed = self.installed_observation_fixture()
        binding = self.retained_binding()
        result = self.reconciled_result(binding, phase='returned')
        with INSTALL.activation_lease() as lease, mock.patch.object(INSTALL, '_installed_payload'), \
                mock.patch.object(INSTALL, '_run', return_value=json.dumps(result).encode()) as run:
            INSTALL.reconcile_retained(prepared, binding=binding, lease=lease)
            with self.assertRaises(INSTALL.SentinelInstallError):
                INSTALL.return_observer(prepared, result['retainedRollback'], result['observer']['ticket'],
                                        binding=binding, lease=lease)
            self.assertEqual(run.call_count, 1)

    def test_observer_enrollment_and_return_bind_the_retained_activation_and_real_lease(self):
        self.lease_state();prepared=self.observer_preparation();binding=self.retained_binding()
        retained=self.retained_activation(prepared,binding)['retainedRollback']
        ticket=self.observer_ticket(retained)
        calls=[]
        ready=mock.Mock()
        with INSTALL.activation_lease() as lease:
            def command(work,name,code,arguments,**options):
                descriptor=INSTALL._activation_lease_descriptor(lease)
                self.assertEqual(options['descriptors'],(descriptor,))
                self.assertEqual(arguments[-1],str(descriptor))
                self.assertEqual(json.loads(arguments[2]),self.release)
                self.assertEqual(json.loads(arguments[3]),retained)
                self.assertEqual(code,INSTALL._OBSERVER_COMMAND)
                calls.append((name,work))
                if name=='observer-prepare':
                    ready.assert_not_called()
                    return json.dumps({'ticket':ticket,'profile':self.observer_profile(),'prepared':True}).encode()
                if name=='observer-activate':
                    ready.assert_called_once_with(self.observer_profile(),ticket)
                    return json.dumps({'ticket':ticket,'profile':self.observer_profile(),'enrolled':True}).encode()
                self.assertEqual(name,'observer-return');self.assertEqual(json.loads(arguments[4]),ticket)
                return json.dumps({'ticket':ticket,'profile':None,'restored':True}).encode()
            with mock.patch.object(INSTALL,'_run',side_effect=command):
                result=INSTALL.enroll_observer(prepared,retained,binding=binding,lease=lease,ready=ready)
                self.assertTrue(result['enrolled'])
                self.assertTrue(INSTALL.return_observer(prepared,retained,ticket,binding=binding,lease=lease)['restored'])
                for action in ('enroll','return'):
                    with self.assertRaises(INSTALL.SentinelInstallError):
                        if action=='enroll':INSTALL.enroll_observer(prepared,retained,binding=binding,lease=lease,ready=ready)
                        else:INSTALL.return_observer(prepared,retained,ticket,binding=binding,lease=lease)
            self.assertEqual(len(calls),3);self.assertEqual(len({call[1] for call in calls}),3);lease.verify()

    def test_observer_changes_refuse_unretained_preparation_fake_lease_and_wrong_binding(self):
        self.lease_state();prepared=self.observer_preparation();binding=self.retained_binding()
        retained=self.retained_ticket(binding)
        with INSTALL.activation_lease() as lease,mock.patch.object(INSTALL,'_run') as run:
            with self.assertRaises(INSTALL.SentinelInstallError):
                INSTALL.enroll_observer(prepared,retained,binding=binding,lease=lease)
            run.assert_not_called()
        self.retained_activation(prepared,binding)
        with mock.patch.object(INSTALL,'_run') as run:
            with self.assertRaises(INSTALL.SentinelInstallError):
                INSTALL.enroll_observer(prepared,retained,binding=binding,lease=INSTALL.ActivationLease())
            with INSTALL.activation_lease() as lease:
                with self.assertRaises(INSTALL.SentinelInstallError):
                    INSTALL.enroll_observer(prepared,retained,binding=self.retained_binding(),lease=lease)
                with self.assertRaisesRegex(INSTALL.SentinelInstallError,'independent update progress'):
                    INSTALL.enroll_observer(prepared,retained,binding=binding,lease=lease)
            run.assert_not_called()

    def test_progress_start_failure_returns_prepared_profile_without_activating_collector(self):
        self.lease_state();prepared=self.observer_preparation();binding=self.retained_binding()
        retained=self.retained_activation(prepared,binding)['retainedRollback'];ticket=self.observer_ticket(retained)
        ready=mock.Mock(side_effect=RuntimeError('progress listener unavailable'))
        calls=[]
        def command(work,name,code,arguments,**options):
            calls.append(name)
            if name=='observer-prepare':
                return json.dumps({'ticket':ticket,'profile':self.observer_profile(),'prepared':True}).encode()
            self.assertEqual(name,'observer-return')
            return json.dumps({'ticket':ticket,'profile':None,'restored':True}).encode()
        with INSTALL.activation_lease() as lease,mock.patch.object(INSTALL,'_run',side_effect=command):
            with self.assertRaises(RuntimeError):
                INSTALL.enroll_observer(prepared,retained,binding=binding,lease=lease,ready=ready)
            ready.assert_called_once_with(self.observer_profile(),ticket)
            self.assertTrue(INSTALL.return_observer(prepared,retained,ticket,binding=binding,lease=lease)['restored'])
        self.assertEqual(calls,['observer-prepare','observer-return'])

    def test_lost_observer_reply_cannot_replay_and_preserves_attempt_directory(self):
        self.lease_state();prepared=self.observer_preparation();binding=self.retained_binding()
        retained=self.retained_activation(prepared,binding)['retainedRollback']
        with INSTALL.activation_lease() as lease,mock.patch.object(INSTALL,'_run',side_effect=RuntimeError('lost reply')) as run:
            with self.assertRaises(RuntimeError):INSTALL.enroll_observer(prepared,retained,binding=binding,lease=lease,ready=lambda *_:None)
            with self.assertRaises(INSTALL.SentinelInstallError):INSTALL.enroll_observer(prepared,retained,binding=binding,lease=lease,ready=lambda *_:None)
            self.assertEqual(run.call_count,1)
        self.assertEqual(len(list(prepared.work.glob('observer-prepare-*'))),1)

    def test_missing_or_ambiguous_observer_protocol_stops_before_child_dispatch(self):
        bodies=(b"ACTIVATION_LEASE_PROTOCOL='orbis-sentinel.activation-lease.v1'\n",
                b"ACTIVATION_LEASE_PROTOCOL='orbis-sentinel.activation-lease.v1'\nOBSERVER_CHANGE_PROTOCOL='other'\n",
                b"ACTIVATION_LEASE_PROTOCOL='orbis-sentinel.activation-lease.v1'\nOBSERVER_CHANGE_PROTOCOL='orbis-sentinel.observer-change.v1'\nOBSERVER_CHANGE_PROTOCOL='other'\n")
        for body in bodies:
            prepared=self.lease_preparation(body)
            with mock.patch.object(INSTALL,'_run') as run,self.assertRaises(INSTALL.SentinelInstallError):
                INSTALL.observer_profile_spec(prepared)
            run.assert_not_called();self.assertFalse(prepared.used)

    def test_observer_child_binds_installed_candidate_before_api_dispatch(self):
        state=self.root/'child-state';state.mkdir(mode=0o700)
        toolkit=self.root/'observer-toolkit.py';effect=self.root/'effect'
        toolkit.write_text("ACTIVATION_LEASE_PROTOCOL='orbis-sentinel.activation-lease.v1'\n"
            "OBSERVER_CHANGE_PROTOCOL='orbis-sentinel.observer-change.v1'\n"
            "from pathlib import Path\nimport json\nSTATE=Path(__file__).parent/'child-state'\n"
            "class RecoveryRequired(ValueError): pass\n"
            "class _Parent:\n def __init__(self,path): self.path=path\n def close(self): pass\n"
            "def _read(parent,name,mode): return (parent.path/name).read_bytes()\n"
            "def _json(body): return json.loads(body)\n"
            "def prepare_observer_profile(ticket,**options):\n Path(__file__).with_name('effect').write_text('called')\n return {'prepared':True}\n")
        retained=self.retained_ticket(self.retained_binding())
        command=[os.sys.executable,'-I','-B','-c',INSTALL._OBSERVER_COMMAND,str(toolkit),'prepare',
                 json.dumps(self.release),json.dumps(retained),'null','3']
        def run():return subprocess.run(command,cwd=self.root,stdin=subprocess.DEVNULL,capture_output=True,timeout=10)
        (state/'installed.json').write_text(json.dumps({**self.release,'version':'9.9.9'}))
        self.assertNotEqual(run().returncode,0);self.assertFalse(effect.exists())
        (state/'installed.json').write_text(json.dumps(self.release))
        result=run();self.assertEqual(result.returncode,0,result.stderr.decode());self.assertTrue(effect.exists())

    def test_fake_raw_or_unretained_lease_never_consumes_preparation(self):
        self.lease_state()
        prepared = self.lease_preparation()
        with mock.patch.object(INSTALL, '_run') as run:
            for lease in (INSTALL.ActivationLease(), {}, 3, object()):
                with self.subTest(lease=type(lease)), self.assertRaises(INSTALL.SentinelInstallError):
                    INSTALL.activate(prepared, retain=self.retained_binding(), lease=lease)
            with INSTALL.activation_lease() as lease:
                with self.assertRaises(INSTALL.SentinelInstallError):
                    INSTALL.activate(prepared, lease=lease)
            run.assert_not_called()
        self.assertFalse(prepared.used)

    def retained_ticket(self, binding):
        return {'schema': 'orbis-sentinel.upgrade-retention-ticket.v1', 'activationId': '4' * 32,
                'sha256': '5' * 64, 'binding': dict(binding)}

    def retained_activation(self, prepared, binding, *, changes=None):
        ticket = self.retained_ticket(binding)

        def command(work, name, code, arguments, **options):
            self.assertEqual(name, 'activate-sentinel')
            self.assertEqual(code, INSTALL._ACTIVATE_RETAINED)
            self.assertEqual(json.loads(arguments[1])['retain'], binding)
            result = {**self.release, 'publisherVerified': True, 'activated': True, 'retainedVersionsRemoved': 0,
                      'activationId': ticket['activationId'], 'retainedRollback': ticket, **(changes or {})}
            return json.dumps(result).encode()

        with mock.patch.object(INSTALL, 'RELEASE', self.release), mock.patch.object(INSTALL, '_run', side_effect=command):
            return INSTALL.activate(prepared, retain=binding)

    def restored_result(self, ticket):
        return {'restored': True, 'activationId': '6' * 32, 'restoredActivationId': ticket['activationId'],
                'version': '0.1.0-dev.20', 'retainedVersionsRemoved': 0,
                'previousRelease': {'version': '0.1.0-dev.20', 'sha256': '7' * 64, 'sourceCommit': '8' * 40}}

    def return_activation(self, prepared, ticket, binding, *, command=None):
        with mock.patch.object(INSTALL, 'RELEASE', self.release), mock.patch.object(INSTALL, '_run', side_effect=command or
                               (lambda *_args, **_kwargs: json.dumps(self.restored_result(ticket)).encode())):
            return INSTALL.restore_retained(prepared, ticket, binding=binding)

    def test_retained_activation_requires_exact_ticket_and_preserves_default_one_use_boundary(self):
        binding = self.retained_binding()
        prepared = self.prepare()
        result = self.retained_activation(prepared, binding)
        self.assertEqual(result['retainedRollback'], self.retained_ticket(binding))
        with self.assertRaises(INSTALL.SentinelInstallError):
            self.activate(prepared)
        for changes in ({'retainedRollback': None}, {'activationId': '0' * 32},
                        {'retainedRollback': self.retained_ticket(self.retained_binding())}):
            with self.subTest(changes=changes), self.assertRaises(INSTALL.SentinelInstallError):
                self.retained_activation(self.prepare(), binding, changes=changes)

    def test_live_return_reuses_only_its_bound_preparation_and_keeps_each_attempts_evidence(self):
        binding = self.retained_binding()
        prepared = self.prepare()
        ticket = self.retained_activation(prepared, binding)['retainedRollback']
        calls = []

        def command(work, name, code, arguments, **options):
            self.assertEqual(name, 'restore-sentinel')
            self.assertEqual(code, INSTALL._RESTORE_RETAINED)
            self.assertEqual(arguments[0], prepared.work / 'toolkit/activate_release.py')
            self.assertEqual(json.loads(arguments[1]), ticket)
            self.assertEqual(json.loads(arguments[2]), prepared.release)
            self.assertEqual(work.parent, prepared.work)
            self.assertEqual({p.name for p in work.iterdir()}, {'tmp', 'cache', 'config', 'state', 'data'})
            calls.append(work)
            return json.dumps(self.restored_result(ticket)).encode()

        self.assertTrue(self.return_activation(prepared, ticket, binding, command=command)['restored'])
        self.assertTrue(self.return_activation(prepared, ticket, binding, command=command)['restored'])
        self.assertNotEqual(calls[0], calls[1])
        self.assertTrue(all(path.exists() for path in calls))

    def test_restart_can_authenticate_a_fresh_preparation_before_observing_the_retained_return(self):
        binding = self.retained_binding()
        prepared = self.prepare()
        ticket = self.retained_ticket(binding)
        self.assertTrue(self.return_activation(prepared, ticket, binding)['restored'])
        self.assertTrue(prepared.used)
        with self.assertRaises(INSTALL.SentinelInstallError):
            self.activate(prepared)

    def test_retention_binding_and_ticket_refusals_do_not_consume_unused_preparation(self):
        prepared = self.prepare()
        binding = self.retained_binding()
        with self.assertRaises(INSTALL.SentinelInstallError):
            INSTALL.activate(prepared, retain={**binding, 'operationId': 'invalid'})
        with self.assertRaises(INSTALL.SentinelInstallError):
            INSTALL.restore_retained(prepared, self.retained_ticket(binding), binding=self.retained_binding())
        self.assertFalse(prepared.used)
        self.assertTrue(self.activate(prepared)['activated'])

    def test_changed_or_unretained_used_preparation_cannot_dispatch_return(self):
        binding = self.retained_binding()
        prepared = self.prepare()
        self.activate(prepared)
        with mock.patch.object(INSTALL, '_run') as run, self.assertRaises(INSTALL.SentinelInstallError):
            INSTALL.restore_retained(prepared, self.retained_ticket(binding), binding=binding)
        run.assert_not_called()
        prepared = self.prepare()
        ticket = self.retained_activation(prepared, binding)['retainedRollback']
        prepared.files[0]['path'].write_bytes(b'changed toolkit')
        with mock.patch.object(INSTALL, '_run') as run, self.assertRaises(INSTALL.SentinelInstallError):
            INSTALL.restore_retained(prepared, ticket, binding=binding)
        run.assert_not_called()

    def test_return_requires_confirmed_identity_without_version_pruning_or_bool_counts(self):
        binding = self.retained_binding()
        ticket = self.retained_ticket(binding)
        for changes in ({'restored': False}, {'version': '0.1.0-dev.19'}, {'retainedVersionsRemoved': False},
                        {'restoredActivationId': '9' * 32}, {'activationId': ticket['activationId']},
                        {'previousRelease': None}):
            result = {**self.restored_result(ticket), **changes}
            with self.subTest(changes=changes), self.assertRaises(INSTALL.SentinelInstallError):
                self.return_activation(self.prepare(), ticket, binding,
                                       command=lambda *_args, **_kwargs: json.dumps(result).encode())

    def test_isolated_return_wrapper_binds_verified_candidate_before_any_return_api_call(self):
        binding = self.retained_binding()
        ticket = self.retained_ticket(binding)
        record = {'activation': {'candidate': self.release, 'previous': self.restored_result(ticket)['previousRelease']}}
        body = json.dumps(record).encode()
        ticket['sha256'] = digest(body)
        (self.root / ('retention-' + ticket['activationId'] + '.json')).write_bytes(body)
        module = self.root / 'activate_release.py'
        module.write_text('''
import json
from pathlib import Path
STATE=Path(__file__).parent
class RecoveryRequired(ValueError): pass
class _Parent:
    def __init__(self,path): self.path=path
    def close(self): pass
def _read(parent,name,mode): return (parent.path/name).read_bytes()
_json=json.loads
def restore_retained(ticket):
    (STATE/'called').write_text('called')
    return {'restored':True,'version':'0.1.0-dev.20'}
''')
        def run(expected):
            return subprocess.run([str(INSTALL.PYTHON), '-I', '-B', '-c', INSTALL._RESTORE_RETAINED,
                str(module), json.dumps(ticket), json.dumps(expected)], capture_output=True,
                env=INSTALL._environment(self.root), timeout=10)

        wrong = run({**self.release, 'sourceCommit': '9' * 40})
        self.assertNotEqual(wrong.returncode, 0)
        self.assertFalse((self.root / 'called').exists())
        right = run(self.release)
        self.assertEqual(right.returncode, 0, right.stderr)
        self.assertEqual(json.loads(right.stdout)['previousRelease'], record['activation']['previous'])
        self.assertTrue((self.root / 'called').exists())

    def test_equal_byte_input_replacement_is_rejected_before_activation(self):
        prepared = self.prepare()
        path = prepared.files[0]['path']
        replacement = path.with_name('replacement')
        replacement.write_bytes(path.read_bytes())
        replacement.chmod(0o600)
        replacement.replace(path)
        with self.assertRaises(INSTALL.SentinelInstallError):
            self.activate(prepared)
        self.assertTrue(prepared.used)
        self.assertNotIn('activate-sentinel', [item[0] for item in self.commands])

    def test_verifier_tamper_or_namespace_alias_never_activates(self):
        prepared = self.prepare()
        prepared.verifier.chmod(0o755)
        with self.assertRaises(INSTALL.SentinelInstallError):
            self.activate(prepared)
        self.assertNotIn('activate-sentinel', [item[0] for item in self.commands])
        alias = self.root / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            INSTALL.Directory(alias)

    def test_directory_permission_drift_and_linked_files_are_rejected(self):
        with INSTALL.Directory(self.root, private=True) as directory:
            self.root.chmod(0o755)
            with self.assertRaises(INSTALL.SentinelInstallError):
                directory.check()
            self.root.chmod(0o700)
        path = self.root / 'record'
        path.write_bytes(b'record')
        path.chmod(0o600)
        os.link(path, self.root / 'linked')
        with self.assertRaises(INSTALL.SentinelInstallError):
            INSTALL._file(path, 6, digest(b'record'))

    def test_unknown_lengths_remain_bounded_and_duplicate_metadata_is_rejected(self):
        path = self.root / 'record'
        path.write_bytes(b'x' * 100)
        path.chmod(0o600)
        with self.assertRaises(INSTALL.SentinelInstallError):
            INSTALL._file(path, 0, '', maximum=99)
        with self.assertRaises(INSTALL.SentinelInstallError):
            INSTALL._json(b'{"activated":true,"activated":false}')

    def test_activation_rejects_wrong_identity_or_version_pruning_claim(self):
        for changes in ({'sourceCommit': 'f' * 40}, {'activated': False}, {'retainedVersionsRemoved': 1}, {'retainedVersionsRemoved': False}):
            with self.subTest(changes=changes):
                prepared = self.prepare()
                def command(*_args, **_kwargs):
                    return json.dumps({**self.release, 'publisherVerified': True, 'activated': True,
                                       'retainedVersionsRemoved': 0, **changes}).encode()
                with self.assertRaises(INSTALL.SentinelInstallError):
                    self.activate(prepared, command=command)

    def test_sanitized_child_environment_does_not_inherit_credentials_or_loader_configuration(self):
        with mock.patch.dict(os.environ, {'GH_TOKEN': 'synthetic', 'PYTHONPATH': '/untrusted', 'LD_PRELOAD': '/untrusted'}):
            environment = INSTALL._environment(self.root)
        self.assertTrue({'GH_TOKEN', 'PYTHONPATH', 'LD_PRELOAD', 'HOME'}.isdisjoint(environment))
        self.assertEqual(Path(environment['TMPDIR']).parent, self.root)

    def test_real_isolated_downloader_rejects_http_before_network_or_file_writes(self):
        path = self.root / 'download'
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        self.addCleanup(os.close, descriptor)
        result = subprocess.run([str(INSTALL.PYTHON), '-I', '-B', '-c', INSTALL.DOWNLOAD,
            'http://invalid.example/', str(descriptor), '100', '0', ''],
            env=INSTALL._environment(self.root), pass_fds=(descriptor,), capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(path.stat().st_size, 0)

    def test_selected_release_uses_shared_publisher_verification_without_changing_installer_default(self):
        default = dict(INSTALL.RELEASE)
        self.release = {**self.release, 'version': '0.2.0-beta.1', 'sourceCommit': 'a' * 40}
        selected = dict(self.release)
        prepared = self.prepare_selected(selected)
        self.assertEqual(INSTALL.RELEASE, default)
        self.assertEqual(prepared.release, selected)
        package = next(url for name, url, _ in self.downloads if name == 'orbis-sentinel-0.2.0-beta.1.tar.gz')
        self.assertEqual(package, 'https://github.com/twentylines/orbis-sentinel/releases/download/v0.2.0-beta.1/orbis-sentinel-0.2.0-beta.1.tar.gz')
        self.assertEqual(self.commands[-1][0], 'verify-package')
        self.assertEqual(self.commands[-1][2][-2:], ['--source-commit', selected['sourceCommit']])
        selected['version'] = '9.9.9'
        self.assertEqual(prepared.release['version'], '0.2.0-beta.1')
        with mock.patch.object(INSTALL, '_run', side_effect=self.command):
            result = INSTALL.activate(prepared)
        self.assertEqual(result['version'], '0.2.0-beta.1')
        self.assertEqual(INSTALL.RELEASE, default)
        with self.assertRaises(INSTALL.SentinelInstallError):
            INSTALL.activate(prepared)

    def test_invalid_release_identity_is_refused_before_host_files_or_network(self):
        for value in (None, [], {}, {**self.release, 'url': 'https://untrusted.example/'},
                      {**self.release, 'version': None}, {**self.release, 'sha256': 'F' * 64},
                      {**self.release, 'sourceCommit': 'main'}):
            with self.subTest(value=value), mock.patch.object(INSTALL, 'require_host') as host:
                with self.assertRaises(INSTALL.SentinelInstallError):
                    INSTALL.prepare_release(self.root, value)
                host.assert_not_called()
        self.assertEqual(self.downloads, [])
        self.assertEqual(self.commands, [])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_selected_version_requires_canonical_semver_and_cannot_change_download_paths(self):
        for version in ('v1.2.3', '1.2.3\n', '../1.2.3', '1.2.3/other', '01.2.3',
                        '1.2.3-dev.01', '1.2.3-a..b', '1.2.3+a..b', '1.2.3-', '1.2.3+', 'x' * 129):
            with self.subTest(version=version):
                with self.assertRaises(INSTALL.SentinelInstallError):
                    INSTALL.prepare_release(self.root, {**self.release, 'version': version})
        for version in ('1.2.3', '1.2.3-dev.0', '1.2.3-dev.10', '1.2.3-0a+001.build'):
            self.assertEqual(INSTALL._release_identity({**self.release, 'version': version})['version'], version)
        self.assertEqual(self.downloads, [])

    def test_changed_selected_identity_or_file_records_never_execute_activation(self):
        def change_release(prepared):
            prepared.release['sourceCommit'] = 'f' * 40
        def change_file(prepared):
            prepared.files[0] = {**prepared.files[0], 'sha256': 'f' * 64}
        def change_verifier(prepared):
            prepared.verifier = prepared.work / 'other-verifier'
        for change in (change_release, change_file, change_verifier):
            with self.subTest(change=change.__name__):
                prepared = self.prepare_selected(self.release)
                change(prepared)
                with mock.patch.object(INSTALL, '_run') as run:
                    with self.assertRaises(INSTALL.SentinelInstallError):
                        INSTALL.activate(prepared)
                    run.assert_not_called()
                self.assertTrue(prepared.used)

    def test_copying_a_prepared_object_does_not_copy_activation_authority(self):
        prepared = self.prepare()
        copied = INSTALL.Prepared(prepared.work, prepared.identity, prepared.files, prepared.release, prepared.verifier)
        with mock.patch.object(INSTALL, '_run') as run:
            with self.assertRaises(INSTALL.SentinelInstallError):
                INSTALL.activate(copied)
            run.assert_not_called()
        self.assertTrue(copied.used)
        self.assertFalse(prepared.used)

    def test_default_preparation_still_requires_its_original_pinned_policy(self):
        prepared = self.prepare()
        with mock.patch.object(INSTALL, 'RELEASE', {**self.release, 'sourceCommit': 'f' * 40}), \
                mock.patch.object(INSTALL, '_run') as run:
            with self.assertRaises(INSTALL.SentinelInstallError):
                INSTALL.activate(prepared)
            run.assert_not_called()

    def test_cli_requires_all_selected_identity_fields_before_preparing(self):
        for arguments in (['--release-version', '1.2.3'], ['--release-sha256', 'a' * 64],
                          ['--release-source-commit', 'a' * 40],
                          ['--release-version', '1.2.3', '--release-sha256', 'a' * 64]):
            with self.subTest(arguments=arguments), \
                    mock.patch.object(INSTALL.sys, 'argv', ['installer', '--state-dir', str(self.root), *arguments]), \
                    mock.patch.object(INSTALL, 'prepare') as default, \
                    mock.patch.object(INSTALL, 'prepare_release') as selected, \
                    mock.patch.object(INSTALL.sys, 'stderr', io.StringIO()):
                with self.assertRaises(SystemExit) as result:
                    INSTALL.main()
                self.assertEqual(result.exception.code, 1)
                default.assert_not_called()
                selected.assert_not_called()

    def test_cli_selected_prepare_only_never_calls_activation(self):
        prepared = self.prepare_selected(self.release)
        arguments = ['installer', '--state-dir', str(self.root), '--prepare-only',
                     '--release-version', self.release['version'], '--release-sha256', self.release['sha256'],
                     '--release-source-commit', self.release['sourceCommit']]
        with mock.patch.object(INSTALL.sys, 'argv', arguments), \
                mock.patch.object(INSTALL, 'prepare_release', return_value=prepared) as selected, \
                mock.patch.object(INSTALL, 'prepare') as default, \
                mock.patch.object(INSTALL, 'activate') as activate, \
                mock.patch.object(INSTALL.sys, 'stdout', io.StringIO()) as output:
            self.assertEqual(INSTALL.main(), 0)
            selected.assert_called_once_with(self.root, self.release)
            default.assert_not_called()
            activate.assert_not_called()
            self.assertEqual(json.loads(output.getvalue()), {'prepared': True, 'activated': False, 'version': self.release['version']})


if __name__ == '__main__':
    unittest.main()
