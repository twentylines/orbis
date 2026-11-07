import copy
import hashlib
import importlib.util
import itertools
import json
import os
import socket
import stat
import tempfile
import unittest
import uuid
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


M = load('orbis-host-maintenance-overlay.py', 'overlay_acceptance_fixture')
H = load('orbis-host.py', 'overlay_acceptance_host')
D = M.DRIVER


class OverlayAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name).resolve()
        self.root, self.state, self.snapshots = (base / name for name in ('installation', 'state', 'snapshots'))
        for path in (self.root, self.state, self.snapshots):
            path.mkdir(mode=0o700)
        self.enterContext(mock.patch.object(H.AUTHORITY, 'OWNER', os.geteuid()))
        self.enterContext(mock.patch.object(H, 'host_lock', side_effect=lambda _: nullcontext()))
        self.current = {'tag': 'source'}
        self.target = {'tag': 'target', 'installationProtocol': H.PLAN.INSTALLATION_PROTOCOL}
        self.service = SimpleNamespace(root=self.root, context='fixture', state_dir=self.state, HOST=H,
                                       snapshots=self.snapshots, job_file=self.state / 'job.json',
                                       current_manifest=lambda: self.current)
        self.overlay = M.CoreOverlay(self.service)
        self.identifier = str(uuid.uuid4())
        self.source = {'Id': 'a' * 64, 'Name': '/runtipi', 'Image': 'sha256:' + 'b' * 64,
                       'State': {'Running': True, 'StartedAt': 'source-start', 'Health': {'Status': 'healthy'}},
                       'Config': {}, 'HostConfig': {}}
        self.responder = {'Id': 'c' * 64, 'Name': '/orbis-retained-' + self.identifier + '-responder',
                          'Image': self.source['Image'], 'Config': {},
                          'State': {'Running': True, 'StartedAt': 'responder-start'},
                          'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0}}}
        def definition(raw):
            value = copy.deepcopy(raw)
            value.pop('State', None)
            value['HostConfig'].pop('RestartPolicy', None)
            return hashlib.sha256(H.IDENTITY.PUBLICATION.canonical(value)).hexdigest()
        self.runtime = mock.Mock()
        self.runtime.definition.side_effect = definition
        self.runtime.inspect.side_effect = lambda identifier: copy.deepcopy(self.source if identifier == self.source['Id'] else self.responder)
        self.runtime.source_snapshot.return_value = {'publication': self.current, 'controllerId': self.source['Id'],
            'imageId': self.source['Image'], 'definition': definition(self.source), 'container': copy.deepcopy(self.source)}
        self.overlay.runtime = self.runtime
        self.events = []
        def prepare(record):
            record.update(responderId=self.responder['Id'], definitions={'responder': definition(self.responder)},
                          intents={'responder': {'name': self.responder['Name'][1:], 'body': {'HostConfig': copy.deepcopy(self.responder['HostConfig'])}}})
            self.overlay.save(record)
        self.runtime.prepare_overlay.side_effect = prepare
        def change(arguments):
            self.events.append(arguments)
            if arguments[0] == 'update':
                self.responder['HostConfig']['RestartPolicy']['Name'] = 'no'
            elif arguments[0] == 'stop':
                self.responder['State']['Running'] = False
            else:
                self.fail('Unexpected mutation')
        self.runtime.change.side_effect = change

    def begin(self):
        self.overlay.begin(self.identifier, self.current, self.target)
        return self.overlay.read(self.identifier)

    def job(self):
        return {'schema': 'orbis.host-service-job.v1', 'id': self.identifier, 'overlayId': self.identifier,
                'current': self.current, 'target': self.target, 'state': 'running',
                'startedAt': 1793814360.3561795,
                'snapshot': str(self.snapshots / ('orbis-target-' + self.identifier))}

    def test_stale_socket_rejection_precedes_overlay_allocation(self):
        self.runtime.live_docker_sockets.side_effect = ValueError('stale Docker connection')
        with self.assertRaisesRegex(ValueError, 'stale Docker connection'):
            self.begin()
        self.assertFalse((self.state / 'core-overlays').exists())
        self.runtime.prepare_overlay.assert_not_called()

    def test_begin_failure_aborts_only_owned_responder_and_preserves_error(self):
        prepare = self.runtime.prepare_overlay.side_effect
        original = ValueError('routing failed')
        def fail(record):
            prepare(record)
            raise original
        self.runtime.prepare_overlay.side_effect = fail
        with self.assertRaises(ValueError) as raised:
            self.begin()
        self.assertIs(raised.exception, original)
        record = self.overlay.read(self.identifier)
        self.assertEqual(record['phase'], 'allocating')
        self.assertEqual(self.overlay.receipt(record)['phase'], 'aborted')
        self.assertEqual(self.events, [['update', '--restart', 'no', self.responder['Id']], ['stop', self.responder['Id']]])
        self.assertFalse(self.responder['State']['Running'])

    def test_changed_source_prevents_abort_without_masking_original_failure(self):
        prepare = self.runtime.prepare_overlay.side_effect
        original = RuntimeError('route ownership failed')
        def fail(record):
            prepare(record)
            self.source['State']['StartedAt'] = 'new-generation'
            raise original
        self.runtime.prepare_overlay.side_effect = fail
        with self.assertRaises(RuntimeError) as raised:
            self.begin()
        self.assertIs(raised.exception, original)
        self.assertFalse(self.events)
        self.assertTrue(self.responder['State']['Running'])

    def test_durable_job_protects_responder_before_acceptance_receipt(self):
        record = self.begin()
        H.AUTHORITY.atomic(self.service.job_file, H.IDENTITY.PUBLICATION.canonical(self.job()))
        with self.assertRaisesRegex(ValueError, 'accepted core operation'):
            self.overlay.abort(self.identifier)
        self.overlay.reconcile_unaccepted()
        self.assertEqual(self.overlay.receipt(record)['phase'], 'accepted')
        self.assertFalse(self.events)

    def test_job_acceptance_supports_existing_fractional_unix_timestamps(self):
        record = self.begin()
        job = {**self.job(), 'startedAt': 1793814360.3561795, 'finishedAt': 1793814551.0904615,
               'download': {'updatedAt': 1793814390.528241, 'currentBytes': 115333777}}
        H.AUTHORITY.atomic(self.service.job_file, H.IDENTITY.PUBLICATION.canonical(job))
        self.assertTrue(self.overlay.accepted_job(record))
        self.overlay.reconcile_unaccepted()
        self.assertEqual('accepted', self.overlay.receipt(record)['phase'])
        self.assertFalse(self.events)

    def test_previous_completed_job_does_not_block_progress_preparation(self):
        previous = {**self.job(), 'id': str(uuid.uuid4()), 'overlayId': str(uuid.uuid4()),
                    'state': 'complete', 'startedAt': 1793814360.3561795, 'finishedAt': 1793814551.0904615}
        H.AUTHORITY.atomic(self.service.job_file, H.IDENTITY.PUBLICATION.canonical(previous))
        record = self.begin()
        self.assertFalse(self.overlay.accepted_job(record))
        self.overlay.ready(record['id'])

    def test_job_binding_still_rejects_duplicate_fields_and_changed_publication(self):
        record = self.begin()
        job = {**self.job(), 'startedAt': 1793814360.3561795, 'target': {'tag': 0.5}}
        H.AUTHORITY.atomic(self.service.job_file, H.IDENTITY.PUBLICATION.canonical(job))
        with self.assertRaises(ValueError):
            self.overlay.accepted_job(record)
        body = H.IDENTITY.PUBLICATION.canonical(self.job())
        duplicate = b'{"id":"other",' + body[1:]
        H.AUTHORITY.atomic(self.service.job_file, duplicate)
        with self.assertRaises(ValueError):
            self.overlay.accepted_job(record)

    def test_reconcile_unaccepted_allocation_settles_after_process_crash(self):
        record = self.begin()
        original_record = (self.overlay.directory(self.identifier) / 'overlay.json').read_bytes()
        self.overlay.reconcile_unaccepted()
        self.assertEqual(self.overlay.receipt(record)['phase'], 'aborted')
        self.assertFalse(self.responder['State']['Running'])
        self.assertEqual((self.overlay.directory(self.identifier) / 'overlay.json').read_bytes(), original_record)
        self.runtime.prepare_overlay.reset_mock()
        with self.assertRaisesRegex(ValueError, 'was aborted'):
            self.begin()
        self.runtime.prepare_overlay.assert_not_called()

    def test_stop_lost_reply_and_crash_after_stop_reconcile(self):
        record = self.begin()
        change = self.runtime.change.side_effect
        def lost(arguments):
            change(arguments)
            if arguments[0] == 'stop':
                raise RuntimeError('lost reply')
        self.runtime.change.side_effect = lost
        self.overlay.abort(self.identifier)
        self.assertEqual(self.overlay.receipt(record)['phase'], 'aborted')
        self.runtime.change.side_effect = change
        self.overlay.abort(self.identifier)
        self.assertFalse(self.responder['State']['Running'])

    def test_process_crash_after_stop_resumes_exact_abort_approval(self):
        class Crash(BaseException):
            pass
        record = self.begin()
        change = self.runtime.change.side_effect
        def crash(arguments):
            change(arguments)
            if arguments[0] == 'stop':
                raise Crash()
        self.runtime.change.side_effect = crash
        with self.assertRaises(Crash):
            self.overlay.abort(self.identifier)
        self.assertEqual(self.overlay.receipt(record)['phase'], 'abort-approved')
        self.runtime.change.side_effect = change
        self.overlay.reconcile_unaccepted()
        self.assertEqual(self.overlay.receipt(record)['phase'], 'aborted')
        self.assertFalse(self.responder['State']['Running'])

    def test_lost_create_reply_reconciles_only_existing_protected_intent(self):
        self.runtime.manager = self.overlay
        self.runtime.reader._read.return_value = self.responder['Id'] + '\n'
        self.runtime.quiesce_owned.side_effect = lambda record: D.DockerRestoreRuntime.quiesce_owned(self.runtime, record)
        original = RuntimeError('create reply lost')
        def lost(record):
            record['intents'] = {'responder': {'name': self.responder['Name'][1:],
                'body': {'HostConfig': copy.deepcopy(self.responder['HostConfig'])}}}
            self.overlay.save(record)
            raise original
        self.runtime.prepare_overlay.side_effect = lost
        with self.assertRaises(RuntimeError) as raised:
            self.begin()
        self.assertIs(raised.exception, original)
        record = self.overlay.read(self.identifier)
        self.assertEqual(record['responderId'], self.responder['Id'])
        self.assertEqual(self.overlay.receipt(record)['phase'], 'aborted')
        self.assertFalse(self.responder['State']['Running'])

    def test_source_restart_policy_drift_is_checked_separately_from_definition(self):
        self.begin()
        self.source['HostConfig']['RestartPolicy'] = {'Name': 'always', 'MaximumRetryCount': 0}
        with self.assertRaisesRegex(ValueError, 'original controller changed'):
            self.overlay.abort(self.identifier)
        self.assertFalse(self.events)

    def test_foreign_responder_definition_or_update_journal_blocks_abort(self):
        record = self.begin()
        self.responder['Config']['Other'] = 'changed'
        with self.assertRaisesRegex(ValueError, 'protected intent'):
            self.overlay.abort(self.identifier)
        self.assertFalse(self.events)
        self.responder['Config'].clear()
        journal = self.snapshots / ('orbis-target-' + self.identifier + '.orbis-update.json')
        journal.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'checkpoint'):
            self.overlay.abort(self.identifier)
        self.assertFalse(self.events)
        self.assertEqual(self.overlay.receipt(record)['phase'], 'allocating')

    def test_legacy_overlay_without_acceptance_receipt_is_not_reinterpreted(self):
        record = self.begin()
        (self.overlay.directory(self.identifier) / 'acceptance.json').unlink()
        self.overlay.reconcile_unaccepted()
        self.assertTrue(self.responder['State']['Running'])
        self.assertFalse(self.events)
        with self.assertRaises(FileNotFoundError):
            self.overlay.abort(self.identifier)

    def test_terminal_dns_empty_representations_preserve_the_original_digest(self):
        keys = ('Dns', 'DnsOptions', 'DnsSearch')
        for before in itertools.product((None, []), repeat=3):
            original = copy.deepcopy(self.responder)
            original['HostConfig'].update(zip(keys, before))
            expected = self.responder_binding(original)
            for after in itertools.product((None, []), repeat=3):
                with self.subTest(before=before, after=after):
                    observed = copy.deepcopy(original)
                    observed['HostConfig'].update(zip(keys, after))
                    untouched = copy.deepcopy(observed)
                    self.assertTrue(self.overlay.terminal_responder_matches(observed, expected))
                    self.assertEqual(observed, untouched)
        self.assertFalse(self.events)

    def test_terminal_dns_compatibility_rejects_nonempty_and_unrelated_changes(self):
        original = copy.deepcopy(self.responder)
        original['HostConfig'].update(Dns=None, DnsOptions=None, DnsSearch=None)
        expected = self.responder_binding(original)
        changes = [('HostConfig', 'Dns', ['1.1.1.1']), ('HostConfig', 'DnsOptions', ['ndots:0']),
                   ('HostConfig', 'DnsSearch', ['example.test']), ('HostConfig', 'CapAdd', ['SYS_ADMIN']),
                   ('HostConfig', 'Privileged', True), ('Config', 'Cmd', ['unexpected']),
                   ('HostConfig', 'Binds', []), ('HostConfig', 'Dns', False)]
        for section, key, value in changes:
            with self.subTest(section=section, key=key):
                observed = copy.deepcopy(original)
                observed['HostConfig'].update(Dns=[], DnsOptions=[], DnsSearch=[])
                observed[section][key] = value
                self.assertFalse(self.overlay.terminal_responder_matches(observed, expected))

    def responder_binding(self, raw):
        return {'responderId': raw['Id'], 'source': {'imageId': raw['Image']},
                'definitions': {'responder': self.runtime.definition(raw)}}

    def test_dns_compatibility_uses_production_digest_and_explicit_image_identity(self):
        self.runtime.definition.side_effect = lambda raw: D.DockerRestoreRuntime.definition(
            SimpleNamespace(P=H.IDENTITY.PUBLICATION), raw)
        original = copy.deepcopy(self.responder)
        original['Config']['Image'] = original['Image']
        original['HostConfig'].update(Dns=None, DnsOptions=None, DnsSearch=None)
        original['Mounts'] = [{'Type': 'bind', 'Source': '/run/orbis', 'Destination': '/run/orbis',
                               'RW': False, 'Mode': '', 'Propagation': 'rprivate'}]
        original['NetworkSettings'] = {'Networks': {'fixture': {'NetworkID': 'original-network'}}}
        expected = self.responder_binding(original)
        observed = copy.deepcopy(original)
        observed['HostConfig'].update(Dns=[], DnsOptions=[], DnsSearch=[])
        self.assertTrue(self.overlay.terminal_responder_matches(observed, expected))
        changes = [lambda raw: raw.update(Id='d' * 64), lambda raw: raw.update(Image='sha256:' + 'e' * 64),
                   lambda raw: raw['Config'].update(Image='different-image'),
                   lambda raw: raw['Mounts'][0].update(RW=True),
                   lambda raw: raw['Mounts'][0].update(Source='/unexpected'),
                   lambda raw: raw['NetworkSettings']['Networks'].update(other={}),
                   lambda raw: raw['HostConfig'].pop('Dns')]
        for change in changes:
            raw = copy.deepcopy(observed)
            change(raw)
            self.assertFalse(self.overlay.terminal_responder_matches(raw, expected))

    def terminal_dns_fixture(self):
        self.responder['HostConfig'].update(Dns=None, DnsOptions=None, DnsSearch=None)
        record = self.begin()
        record.update(phase='complete', decision='commit')
        self.overlay.save(record)
        job = {**self.job(), 'state': 'complete'}
        self.responder['HostConfig'].update(Dns=[], DnsOptions=[], DnsSearch=[],
                                           RestartPolicy={'Name': 'no', 'MaximumRetryCount': 0})
        self.responder['State']['Running'] = False
        return job

    def test_completed_stopped_responder_remains_settled_after_dns_rewrite(self):
        job = self.terminal_dns_fixture()
        path = self.overlay.directory(self.identifier) / 'overlay.json'
        original = path.read_bytes()
        self.assertTrue(self.overlay.settled(job))
        self.assertEqual(path.read_bytes(), original)
        self.assertFalse(self.events)

    def test_dns_compatibility_keeps_terminal_phase_and_restart_guards(self):
        job = self.terminal_dns_fixture()
        self.assertFalse(self.overlay.settled({**job, 'state': 'running'}))
        self.responder['State']['Running'] = True
        self.assertFalse(self.overlay.settled(job))
        self.responder['State']['Running'] = False
        self.responder['HostConfig']['RestartPolicy']['Name'] = 'always'
        self.assertFalse(self.overlay.settled(job))
        self.responder['HostConfig']['RestartPolicy']['Name'] = 'no'
        record = self.overlay.read(self.identifier)
        record['decision'] = 'rollback'
        self.overlay.save(record)
        self.assertFalse(self.overlay.settled(job))

    def test_finish_can_stop_dns_rewritten_responder_of_healthy_terminal_job(self):
        job = self.terminal_dns_fixture()
        self.responder['State']['Running'] = True
        self.current = copy.deepcopy(self.target)
        with mock.patch.object(H, 'current_core', return_value={'state': 'running', 'health': 'healthy'}):
            self.overlay.finish(job)
        self.assertTrue(self.overlay.settled(job))
        self.assertEqual(self.events, [['update', '--restart', 'no', self.responder['Id']], ['stop', self.responder['Id']]])

    def test_dns_rewritten_terminal_responder_is_untouched_when_health_or_publication_changed(self):
        job = self.terminal_dns_fixture()
        self.responder['State']['Running'] = True
        with self.assertRaisesRegex(ValueError, 'terminal publication'):
            self.overlay.finish(job)
        self.assertFalse(self.events)
        self.current = copy.deepcopy(self.target)
        with mock.patch.object(H, 'current_core', return_value={'state': 'running', 'health': 'unhealthy'}):
            with self.assertRaisesRegex(ValueError, 'not healthy'):
                self.overlay.finish(job)
        self.assertFalse(self.events)

    def test_dns_rewritten_rollback_and_failed_jobs_settle_only_the_source(self):
        job = self.terminal_dns_fixture()
        record = self.overlay.read(self.identifier)
        record.update(phase='rolled-back', decision='rollback')
        self.overlay.save(record)
        for state in ('rolled-back', 'failed'):
            with self.subTest(state=state):
                terminal = {**job, 'state': state}
                self.assertTrue(self.overlay.settled(terminal))
                with mock.patch.object(H, 'current_core', return_value={'state': 'running', 'health': 'healthy'}):
                    self.overlay.finish(terminal)
                self.assertTrue(self.overlay.settled(terminal))


class DockerSocketIdentityTests(unittest.TestCase):
    def setUp(self):
        self.runtime = object.__new__(D.DockerRestoreRuntime)
        self.runtime.reader = mock.Mock()
        self.runtime.reader.socket.return_value = '/var/run/docker.sock'
        self.runtime.reader._object.return_value = {'ID': 'fixture-daemon'}
        self.containers = {name: {'Id': character * 64, 'State': {'Pid': pid, 'Running': True, 'StartedAt': 'generation'},
            'Mounts': [{'Destination': '/var/run/docker.sock', 'Source': '/var/run/docker.sock', 'Type': 'bind'}]}
            for name, character, pid in [('runtipi', 'a', 20), ('runtipi-reverse-proxy', 'b', 21)]}
        self.runtime.inspect = mock.Mock(side_effect=lambda name: copy.deepcopy(self.containers[name] if name in self.containers else next(raw for raw in self.containers.values() if raw['Id'] == name)))
        self.selected = SimpleNamespace(st_dev=25, st_ino=65121, st_mode=stat.S_IFSOCK | 0o660)
        self.bound = [copy.copy(self.selected), copy.copy(self.selected)]
        self.enterContext(mock.patch.object(D.os, 'geteuid', return_value=0))
        self.enterContext(mock.patch.object(D.os, 'stat', return_value=self.selected))
        self.enterContext(mock.patch.object(D.os, 'open', return_value=40))
        self.enterContext(mock.patch.object(D.os, 'close'))
        self.enterContext(mock.patch.object(D.os, 'O_PATH', 0, create=True))
        self.runtime.socket_in_root = mock.Mock(side_effect=lambda root, destination: ('/run/docker.sock', self.bound[self.runtime.socket_in_root.call_count - 1]))
        def read(path):
            if path.name == 'cgroup':
                character = 'a' if str(path.parent) == '/proc/20' else 'b'
                return '0::/system.slice/docker-' + character * 64 + '.scope\n'
            return '1 2 0:25 /docker.sock /run/docker.sock rw - tmpfs tmpfs rw\n'
        self.read = self.enterContext(mock.patch.object(D.Path, 'read_text', autospec=True, side_effect=read))

    def test_both_current_socket_mounts_pass_without_container_mutation(self):
        self.assertEqual(self.runtime.live_docker_sockets(), {'controller': 'current', 'proxy': 'current'})

    def test_stale_proxy_always_rejected_with_sanitized_reason(self):
        self.bound[1].st_ino = 1456
        with self.assertRaisesRegex(ValueError, 'stale Docker connection'):
            self.runtime.live_docker_sockets(allow_stale_controller=True)

    def test_stale_source_allowed_only_for_controller_replacement_diagnostic(self):
        self.bound[0].st_ino = 1456
        self.assertEqual(self.runtime.live_docker_sockets(allow_stale_controller=True), {'controller': 'stale', 'proxy': 'current'})
        self.runtime.socket_in_root.reset_mock()
        with self.assertRaisesRegex(ValueError, 'stale Docker connection'):
            self.runtime.live_docker_sockets()

    def test_remote_context_unknown_local_pid_and_non_socket_mount_reject(self):
        self.runtime.reader.socket.return_value = None
        with self.assertRaises(ValueError): self.runtime.live_docker_sockets()
        self.runtime.reader.socket.return_value = '/var/run/docker.sock'
        self.read.side_effect = lambda path: '0::/unrelated\n'
        with self.assertRaises(ValueError): self.runtime.live_docker_sockets()

    def test_changed_container_generation_after_socket_read_is_rejected(self):
        inspect = self.runtime.inspect.side_effect
        count = 0
        def changed(name):
            nonlocal count
            count += 1
            raw = inspect(name)
            if count == 2:
                raw['State']['StartedAt'] = 'replacement-generation'
            return raw
        self.runtime.inspect.side_effect = changed
        with self.assertRaisesRegex(ValueError, 'stale Docker connection'):
            self.runtime.live_docker_sockets(allow_stale_controller=True)

    def test_only_physical_socket_mountpoint_is_accepted(self):
        read = self.read.side_effect
        self.read.side_effect = lambda path: read(path) if path.name == 'cgroup' else '1 2 0:25 /docker.sock /var/run/docker.sock rw - tmpfs tmpfs rw\n'
        with self.assertRaisesRegex(ValueError, 'stale Docker connection'):
            self.runtime.live_docker_sockets()

class ContainerSocketPathTests(unittest.TestCase):
    def test_absolute_container_symlink_stays_beneath_pinned_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'var').mkdir()
            (root / 'run').mkdir()
            (root / 'var' / 'run').symlink_to('/run')
            with socket.socket(socket.AF_UNIX) as endpoint:
                endpoint.bind(str(root / 'run' / 'docker.sock'))
                descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    with mock.patch.object(D.os, 'O_PATH', getattr(os, 'O_PATH', os.O_RDONLY), create=True):
                        canonical, details = D.DockerRestoreRuntime.socket_in_root(descriptor, '/var/run/docker.sock')
                finally:
                    os.close(descriptor)
                self.assertEqual(canonical, '/run/docker.sock')
                self.assertEqual((details.st_dev, details.st_ino), ((root / 'run' / 'docker.sock').stat().st_dev, (root / 'run' / 'docker.sock').stat().st_ino))


if __name__ == '__main__':
    unittest.main()
