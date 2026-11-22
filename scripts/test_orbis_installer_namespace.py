import hashlib
import importlib.util
import io
import json
import os
import subprocess
import unittest
from pathlib import Path
from unittest import mock
from contextlib import redirect_stdout
from types import SimpleNamespace

import test_orbis_fresh_namespace as namespace


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


NEW = load('orbis-install-new.py', 'namespace_installer_target')
GUIDE = load('orbis-install.py', 'namespace_guided_target')


class InstallerNamespaceTests(unittest.TestCase):
    """Real protected layout/files/locks; explicit UID, mount and Docker ports.

    These fixtures create no actual Root decision or installed authority.
    """
    def setUp(self):
        self.flow = namespace.NewNamespaceBirthTests('test_empty_user_parent_installation_publishes_only_private_namespace_birth')
        self.addCleanup(self.flow.doCleanups)
        self.flow.setUp()
        self.root, self.host, self.reader = self.flow.root, self.flow.host, self.flow.reader
        self.b = namespace.legacy.L.B
        self.proxy = NEW.PROXY
        original_host = NEW.HOST
        for change in (mock.patch.object(self.proxy, 'HOST', self.host),
                       mock.patch.object(self.proxy, 'BOOTSTRAP', self.b),
                       mock.patch.object(self.proxy.A, 'LAYOUT', self.host.AUTHORITY.LAYOUT),
                       mock.patch.object(self.proxy.A, 'OWNER', os.geteuid()),
                       mock.patch.object(NEW, 'HOST', self.host),
                       mock.patch.object(NEW, 'OWNERSHIP', self.b),
                       mock.patch.object(GUIDE, 'HOST', self.host),
                       mock.patch.object(GUIDE, 'OWNERSHIP', self.b),
                       mock.patch.object(NEW.RESET, 'CONTROL_ROOT', self.flow.f.f.folder / 'reset-custody')):
            change.start(); self.addCleanup(change.stop)
        filesystem = NEW.RESET.filesystem
        change = mock.patch.object(NEW.RESET, 'filesystem', side_effect=lambda path, mountinfo=None: filesystem(path, mountinfo or self.flow.f.mount))
        change.start(); self.addCleanup(change.stop)
        self.host.STAGE = original_host.STAGE
        self.host.IDENTITY = original_host.IDENTITY
        self.host.compose_args = original_host.compose_args
        self.host.host_lock = lambda root: self.flow.f.locked()
        self.host.installation_fingerprint = mock.Mock(return_value={'fixture': 'healthy-installed-state'})
        self.host.write_state = mock.Mock()
        self.host.docker = mock.Mock(side_effect=self.docker)
        self.host.current_core = mock.Mock(side_effect=lambda root, context: {
            'state': 'running', 'health': 'healthy', 'image': NEW.REPLACE.target_image(self.flow.f.f.manifest), 'id': 'a' * 64,
        })
        self.reader._read = mock.Mock(return_value='')
        self.reader.core = mock.Mock(side_effect=self.core)
        self.active = False
        self.fail_start = False
        self.docker_calls = []
        self.state = self.flow.f.f.folder / 'installer'
        self.state.mkdir(mode=0o700)
        self.storage = self.b.installer_storage(self.host, self.root, 'local')
        self.daemon = hashlib.sha256(b'daemon-fixture').hexdigest()

    def mounts(self, service):
        config = json.loads((self.root / 'docker-compose.yml').read_bytes())
        return [{'Type': 'bind', 'Source': item['source'], 'Destination': item['target'],
                 'RW': not item.get('read_only', False), 'Propagation': 'rprivate'}
                for item in config['services'][service]['volumes']]

    def core(self, identifier):
        if identifier in ('runtipi', 'a' * 64):
            return {'id': 'a' * 64, 'mounts': self.mounts('runtipi')}
        if identifier == 'b' * 64:
            return {'id': identifier, 'mounts': self.mounts('runtipi-reverse-proxy')}
        raise AssertionError('Unexpected fixture container read')

    def proxy_inspection(self):
        return {'Id': 'b' * 64, 'Image': 'sha256:' + 'f' * 64,
                'Config': {'Labels': {'com.docker.compose.project': 'runtipi',
                                     'com.docker.compose.service': 'runtipi-reverse-proxy',
                                     'com.docker.compose.project.working_dir': str(self.root)}},
                'State': {'Running': True, 'Paused': False, 'Restarting': False},
                'Mounts': self.mounts('runtipi-reverse-proxy')}

    def docker(self, context, arguments, root):
        self.assertEqual((context, root), ('local', self.root))
        self.docker_calls.append(arguments)
        if arguments[0] == 'compose':
            self.assertIn('--pull', arguments)
            if self.fail_start:
                return subprocess.CompletedProcess(arguments, 1, '', '')
            self.active = True
            self.reader.containers.return_value = [{'id': 'a' * 64, 'name': 'runtipi'},
                                                   {'id': 'b' * 64, 'name': 'runtipi-reverse-proxy'}]
            (self.root / 'traefik/traefik.yml').write_bytes(b'entryPoints: {}\n')
            return subprocess.CompletedProcess(arguments, 0, '', '')
        if arguments[:2] == ['context', 'inspect']:
            return subprocess.CompletedProcess(arguments, 0, json.dumps({'host': 'unix:///run/docker.sock'}), '')
        if arguments[:2] == ['container', 'inspect'] and arguments[-1] == 'runtipi-reverse-proxy':
            return subprocess.CompletedProcess(arguments, 0, json.dumps(self.proxy_inspection()), '')
        if arguments[:1] == ['inspect'] and arguments[-1] == 'runtipi':
            return subprocess.CompletedProcess(arguments, 0, json.dumps(self.mounts('runtipi')), '')
        raise AssertionError('Unexpected fixture Docker operation')

    def install(self, approval=None):
        if approval is None:
            plan = NEW.RESET.review_external_legacy(self.root, self.daemon, 'local')
            approval = NEW.RESET.review_plan_sha256(plan)
        args = SimpleNamespace(http_port=18280, https_port=19443, server_ip='192.168.20.10', approved_reset_plan_sha256=approval)
        with mock.patch.object(NEW.REPLACE, 'Engine', return_value=SimpleNamespace(endpoint='/run/docker.sock')), \
             mock.patch.object(NEW.socket, 'socket'), \
             mock.patch.object(NEW.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')), \
             redirect_stdout(io.StringIO()):
            return NEW.install(self.root, self.reader, self.flow.f.f.manifest, self.state, args, mock.Mock())

    def interrupted_install(self):
        self.fail_start = True
        with self.assertRaises(RuntimeError): self.install()
        marker = self.b.installer_pointer_path(self.host, self.root, 'local')
        value = json.loads(marker.read_bytes())
        journal = Path(value['journal'])
        self.assertEqual(json.loads(journal.read_bytes())['stage'], 'starting')
        return marker, value, journal

    def recover_command(self, arguments, output, errors):
        self.assertEqual(arguments[0], str(Path(NEW.__file__).resolve()))
        self.assertEqual(arguments[1:3], ['recover', str(self.root)])
        self.assertEqual(arguments[-2:], ['--confirm-root', str(self.root)])
        journal = Path(arguments[arguments.index('--journal') + 1])
        with self.flow.f.locked():
            result = NEW.finish(json.loads(journal.read_bytes()), self.reader, journal)
        output.write_text(json.dumps(result))
        errors.write_text('')
        return 0

    def private_state(self, path):
        # The portable fixture's declared Root owner is this process's UID.
        # Keep the real protected-directory checks on this one private path.
        self.assertEqual(path, self.state)
        with NEW.RESET._control_descriptor(path) as descriptor:
            NEW.RESET._require_private(os.fstat(descriptor))
        return path

    def birth(self):
        with self.flow.f.locked():
            return self.flow.prepare()

    def initialize(self, reference):
        with self.flow.f.locked():
            return self.proxy.initialize(self.root, installer_storage=self.storage,
                                         birth_reference=reference, context='local', daemon_sha256=self.daemon)

    def test_private_proxy_identity_is_bound_outside_data_and_its_own_mount(self):
        reference = self.birth()
        value = self.initialize(reference)
        store = self.flow.f.namespace / 'proxy-identity'
        receipt = self.flow.f.namespace / 'proxy-birth-identity.json'
        self.assertEqual(self.proxy.shared_path(self.root), store)
        self.assertEqual(self.proxy.owned(self.root), value)
        self.assertEqual(value['custody'], self.storage['custody'])
        self.assertFalse(store.is_relative_to(self.root))
        self.assertFalse(receipt.is_relative_to(store))
        self.assertEqual(store.stat().st_mode & 0o777, 0o700)
        self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.root.iterdir()), [])
        mutable = store / 'acme.json'
        mutable.write_bytes(b'mutable proxy fixture')
        before = (receipt.read_bytes(), receipt.stat().st_ino, mutable.read_bytes())
        self.assertEqual(self.initialize(reference), value)
        self.assertEqual((receipt.read_bytes(), receipt.stat().st_ino, mutable.read_bytes()), before)

    def test_layout_alone_cannot_allocate_or_reclassify_proxy_identity(self):
        self.assertEqual(self.proxy.shared_path(self.root), self.root.parent / ('.' + self.root.name + '.orbis-proxy-identity'))
        with self.flow.f.locked():
            before = self.flow.f.f.snapshot()
            with self.assertRaises(ValueError):
                self.proxy.initialize(self.root, installer_storage=self.storage, birth_reference=None,
                                      context='local', daemon_sha256=self.daemon)
            self.assertEqual(self.flow.f.f.snapshot(), before)

    def test_proxy_birth_allocation_requires_the_live_installer_lock(self):
        reference = self.birth()
        with self.assertRaises(ValueError):
            self.proxy.initialize(self.root, installer_storage=self.storage, birth_reference=reference,
                                  context='local', daemon_sha256=self.daemon)
        self.assertFalse((self.flow.f.namespace / 'proxy-birth-identity.json').exists())

    def test_same_content_layout_replacement_does_not_rebind_proxy_identity(self):
        self.initialize(self.birth())
        receipt = self.flow.f.namespace / 'proxy-birth-identity.json'
        body = receipt.read_bytes()
        layout = self.flow.f.namespace / 'layout.json'
        replacement = layout.with_name('layout-replacement.json')
        replacement.write_bytes(layout.read_bytes()); replacement.chmod(0o600)
        os.replace(replacement, layout)
        with self.assertRaises(ValueError): self.proxy.shared_path(self.root)
        self.assertEqual(receipt.read_bytes(), body)

    def test_interrupted_proxy_allocation_resumes_without_legacy_fallback(self):
        reference = self.birth()
        mkdir = os.mkdir
        def interrupted(path, *args, **kwargs):
            if path == 'proxy-identity':
                raise OSError('fixture interrupted directory allocation')
            return mkdir(path, *args, **kwargs)
        with mock.patch.object(os, 'mkdir', side_effect=interrupted), self.assertRaises(OSError):
            self.initialize(reference)
        receipt = self.flow.f.namespace / 'proxy-birth-identity.json'
        self.assertEqual(json.loads(receipt.read_bytes())['phase'], 'allocating')
        with self.assertRaises((OSError, ValueError)): self.proxy.shared_path(self.root)
        declaration = self.proxy.declaration(self.root, installer_storage=self.storage)
        self.assertEqual(declaration['mutableIdentity']['source'], str(self.flow.f.namespace / 'proxy-identity'))
        self.initialize(reference)
        self.assertEqual(json.loads(receipt.read_bytes())['phase'], 'owned')

    def test_unknown_proxy_store_is_preserved_and_never_adopted(self):
        reference = self.birth()
        store = self.flow.f.namespace / 'proxy-identity'
        store.mkdir(mode=0o700)
        (store / 'unknown').write_bytes(b'prior identity')
        before = self.flow.f.f.snapshot()
        with self.assertRaises(ValueError): self.initialize(reference)
        with self.assertRaises(ValueError): self.proxy.shared_path(self.root)
        self.assertEqual(self.flow.f.f.snapshot(), before)

    def test_public_install_finishes_in_reviewed_user_parent_with_real_reset_and_proxy_checks(self):
        self.assertEqual(self.root.stat().st_uid, 1000)
        result = self.install()
        self.assertEqual(result['result'], 'orbis-installed')
        journal = Path(result['journal'])
        record = json.loads(journal.read_bytes())
        self.assertEqual(record['stage'], 'complete')
        self.assertEqual(record['installerStorage'], self.storage)
        self.assertEqual(record['resetAuthority']['schema'], NEW.RESET.SCHEMA_V4)
        self.assertEqual(self.root.stat().st_uid, 1000)
        self.assertFalse((self.root / '.orbis-installation.json').exists())
        marker = json.loads((self.flow.f.namespace / 'installer-pointer.json').read_bytes())
        self.assertEqual(marker['installerStorage'], self.storage)
        self.assertEqual(marker['schema'], 'orbis.installer-pointer.v2')
        self.host.write_state.assert_called_once_with(self.root, {'fixture': 'healthy-installed-state'})
        self.assertEqual(self.proxy.shared_path(self.root), self.flow.f.namespace / 'proxy-identity')
        self.assertTrue((self.root / '.secrets').is_dir())
        self.assertFalse((self.root / '.secrets').is_symlink())
        self.assertEqual((self.root / '.secrets').stat().st_mode & 0o7777, 0o700)
        self.assertEqual(list((self.root / '.secrets').iterdir()), [])

    def test_new_install_captures_host_memory_for_lxc_without_exposing_other_environment_values(self):
        read_text = Path.read_text
        def host_memory(path, *args, **kwargs):
            return 'MemTotal: 8388608 kB\n' if path == Path('/proc/meminfo') else read_text(path, *args, **kwargs)
        with mock.patch.object(NEW.Path, 'read_text', host_memory):
            result = self.install()
        self.assertEqual(result['result'], 'orbis-installed')
        values = (self.root / '.env').read_text().splitlines()
        memory = [line for line in values if line.startswith('RUNTIPI_HOST_MEMORY_TOTAL=')]
        self.assertEqual(memory, ["RUNTIPI_HOST_MEMORY_TOTAL='8589934592'"])
        self.assertEqual(self.root.stat().st_uid, 1000)

    def test_wrong_reset_approval_refuses_before_downloads_or_any_birth(self):
        before = self.flow.f.f.snapshot()
        with self.assertRaises(ValueError): self.install('0' * 64)
        self.assertEqual(self.flow.f.f.snapshot(), before)
        self.assertEqual(self.docker_calls, [])

    def test_guided_recovery_uses_the_bound_original_executor_and_preserves_prepared_files(self):
        marker, _, journal = self.interrupted_install()
        environment = (self.root / '.env').read_bytes()
        identity = (self.flow.f.namespace / 'proxy-birth-identity.json').read_bytes()
        self.fail_start = False
        loader = GUIDE.load
        def portable_operator(name, key):
            return SimpleNamespace(private_directory=self.private_state) if name == 'install-orbis.py' else loader(name, key)
        with mock.patch.object(GUIDE, 'load', side_effect=portable_operator), \
             mock.patch.object(GUIDE, 'command', side_effect=self.recover_command) as execute:
            result = GUIDE.recover_pending(self.root, self.reader, self.state, None)
        self.assertEqual(result['result'], 'orbis-installed')
        execute.assert_called_once()
        self.assertEqual(json.loads(journal.read_bytes())['stage'], 'complete')
        self.assertEqual((self.root / '.env').read_bytes(), environment)
        self.assertEqual((self.flow.f.namespace / 'proxy-birth-identity.json').read_bytes(), identity)
        self.assertTrue(marker.exists())

    def test_guided_recovery_refuses_an_original_executor_without_the_storage_protocol(self):
        marker, value, _ = self.interrupted_install()
        old = self.state / 'old-executor'
        old.mkdir(mode=0o700)
        executor = old / 'orbis-install-new.py'
        executor.write_bytes(b'raise RuntimeError("must not execute")\n')
        value.update(executor=str(executor), executorSha256=hashlib.sha256(executor.read_bytes()).hexdigest())
        NEW.APPS.write_journal(marker, value)
        before = self.flow.f.f.snapshot()
        with mock.patch.object(GUIDE, 'command') as execute:
            with self.assertRaises(ValueError): GUIDE.recover_pending(self.root, self.reader, self.state, None)
        execute.assert_not_called()
        self.assertEqual(self.flow.f.f.snapshot(), before)

    def test_guided_recovery_refuses_missing_custody_without_a_legacy_fallback(self):
        marker, value, _ = self.interrupted_install()
        value.pop('installerStorage')
        NEW.APPS.write_journal(marker, value)
        before = self.flow.f.f.snapshot()
        with mock.patch.object(GUIDE, 'command') as execute:
            with self.assertRaises(ValueError): GUIDE.recover_pending(self.root, self.reader, self.state, None)
        execute.assert_not_called()
        self.assertEqual(self.flow.f.f.snapshot(), before)


if __name__ == '__main__':
    unittest.main()
