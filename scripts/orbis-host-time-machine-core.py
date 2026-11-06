#!/usr/bin/env python3
"""Unexposed, single-attempt core checkpoint and same-container resume.

The trusted supervisor must drain native/remote writers before calling capture.
An unfinished job is a recovery hold, including after process restart. This module
never reclaims a job, restores snapshot bytes, or grants HTTP admission.
"""
import copy
import fcntl
import importlib.util
import os
import re
import stat
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TX = load('orbis-install-transaction.py', 'orbis_core_capture_transaction')
HOST = TX.APPS.HOST
D = load('orbis-host-retained-restore-runtime.py', 'orbis_core_capture_definitions')
MAP = load('orbis-host-core-storage-map.py', 'orbis_core_capture_storage_map')
SCHEMA = 'orbis.time-machine-core-job.v1'
SCOPE = 'controller-live-proxy.v1'
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')


class CoreCaptureError(ValueError):
    pass


class GuardedReader:
    def __init__(self, operation, reader, record):
        self.operation, self.reader, self.record = operation, reader, record
        self.context, self.lock_fd = reader.context, reader.lock_fd

    def __getattr__(self, name):
        return getattr(self.reader, name)

    def change(self, arguments, timeout=90):
        self.operation.mutate(self.reader, self.record, arguments, timeout)


class CoreCapture:
    def __init__(self, service):
        self.service, self.root, self.context = service, Path(service.root), service.context
        self.a, self.P = HOST.AUTHORITY, HOST.IDENTITY.PUBLICATION
        HOST.IDENTITY.binding(str(self.root), self.context)
        self.state, self.snapshots = Path(service.state_dir), Path(service.snapshots)
        for directory in (self.state, self.snapshots):
            self.private(directory)
            if TX.STORAGE.overlaps(directory, self.root):
                raise CoreCaptureError('Core capture authority must be outside the installation')
        self.base = self.state / 'time-machine-core'
        self.child(self.base)

    def private(self, directory):
        with self.a.protected_directory(directory):
            pass

    def child(self, directory):
        self.private(directory.parent)
        try:
            directory.mkdir(mode=0o700)
            self.sync(directory.parent)
        except FileExistsError:
            pass
        self.private(directory)

    @staticmethod
    def sync(directory):
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def read(self, directory):
        with self.a.protected_directory(directory) as descriptor:
            with self.a.protected_file(descriptor, 'job.json', 16 * 1024 * 1024) as body:
                value = self.P.metadata(body, byte_limit=16 * 1024 * 1024)
        settlement = value.get('settlement')
        if (value.get('schema') != SCHEMA or value.get('id') != directory.name
                or value.get('root') != str(self.root) or value.get('context') != self.context
                or value.get('scope') != SCOPE or value.get('phase') != 'complete'
                or 'pendingMutation' not in value or value['pendingMutation'] is not None
                or not isinstance(settlement, dict)
                or settlement.get('schema') != 'orbis.time-machine-core-resumed.v1'
                or settlement.get('pointId') != value['id'] or settlement.get('root') != str(self.root)
                or settlement.get('context') != self.context or settlement.get('scope') != SCOPE
                or settlement.get('restoredSnapshotBytes') is not False
                or settlement.get('sourceSha256') != TX.APPS.digest(value.get('source'))
                or settlement.get('checkpointSha256') != value.get('checkpointSha256')
                or not isinstance(value.get('original'), dict) or not isinstance(value.get('expected'), dict)
                or settlement.get('containersSha256') != TX.APPS.digest({**value['original'], **value['expected']})
                or settlement.get('originalCoreIds') != sorted(value['expected'])):
            raise CoreCaptureError('An unfinished core capture requires protected recovery')
        TX.validate_review(value['checkpoint'])
        if (value['checkpoint']['storage'].get('backupScope') != SCOPE
                or set(value['checkpoint']['roles']) != set(value['expected'])
                or set(value['checkpoint']['roles'].values()) != {'controller', 'database', 'queue'}
                or len(value['expected']) != 3):
            raise CoreCaptureError('The completed core capture scope changed')
        if 'portableStorage' in value or 'portableStorageSha256' in settlement:
            mapping = MAP.validate(TX, value.get('portableStorage'), value['checkpoint'], value['original'])
            if settlement.get('portableStorageSha256') != TX.APPS.digest(mapping):
                raise CoreCaptureError('The completed core storage mapping changed')
        return value

    def save(self, record):
        directory = self.base / record['id']
        self.private(directory)
        self.a.atomic(directory / 'job.json', self.P.canonical(record))
        self.private(directory)

    @contextmanager
    def exclusive(self):
        self.private(self.base)
        path = self.base / 'operation.lock'
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            def identity(value):
                if (not stat.S_ISREG(value.st_mode) or value.st_uid != self.a.OWNER
                        or value.st_nlink != 1 or stat.S_IMODE(value.st_mode) != 0o600):
                    raise CoreCaptureError('The core capture operation lock is not private')
                return value.st_dev, value.st_ino
            expected = identity(os.fstat(descriptor))
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise CoreCaptureError('A core capture worker still owns its operation') from error
            if identity(path.lstat()) != expected:
                raise CoreCaptureError('The core capture operation lock changed')
            self.private(self.base)
            for name in os.listdir(self.base):
                if name != 'operation.lock':
                    if not UUID.fullmatch(name):
                        raise CoreCaptureError('Unknown core capture authority requires review')
                    self.read(self.base / name)
            yield descriptor
            if identity(path.lstat()) != expected or identity(os.fstat(descriptor)) != expected:
                raise CoreCaptureError('The core capture operation lock changed')
        finally:
            os.close(descriptor)

    def observation(self, reader, identifier):
        raw = reader._object(['container', 'inspect', '--format', '{{json .}}', identifier])
        state, host = raw['State'], raw['HostConfig']
        if (raw['Id'] != identifier or not TX.APPS.IMAGE_ID.fullmatch(str(raw.get('Image')))
                or state.get('Restarting') or state.get('Paused')
                or state.get('Status') not in {'running', 'exited', 'created'}
                or not isinstance(state.get('StartedAt'), str)
                or state.get('Running') != (state['Status'] == 'running')
                or host.get('AutoRemove') is not False):
            raise CoreCaptureError('A reviewed container has unstable runtime state')
        networks = {name: endpoint['NetworkID'] for name, endpoint in raw['NetworkSettings']['Networks'].items()}
        if any(not isinstance(value, str) or not (re.fullmatch('[a-f0-9]{64}', value)
               or value == '' and state['Status'] != 'running') for value in networks.values()):
            raise CoreCaptureError('A reviewed container network identity is unavailable')
        return {'id': identifier, 'name': raw['Name'], 'imageId': raw['Image'],
                'definition': D.DockerRestoreRuntime.definition(SimpleNamespace(P=self.P), raw),
                'networks': networks, 'state': state['Status'], 'startedAt': state['StartedAt'],
                'restartPolicy': copy.deepcopy(TX.APPS.policy(host['RestartPolicy']))}

    def verify(self, reader, record):
        rows = reader.containers()
        TX.APPS.DETECT.validate_rows(rows)
        if ({item['id'] for item in rows} != set(record['original'])
                or TX.APPS.digest_daemon(reader) != record['daemonFingerprint']):
            raise CoreCaptureError('The captured Docker inventory changed')
        for identifier, original in record['original'].items():
            actual = self.observation(reader, identifier)
            expected = record['expected'].get(identifier, original)
            if actual != expected:
                raise CoreCaptureError('A reviewed or preserved container changed')

    def source(self):
        publication = HOST.PLAN.validate_manifest(self.service.current_manifest())
        enrollment = HOST.installation_fingerprint(self.root, publication, self.context)
        HOST.require_current_state(self.root, enrollment)
        return {'publication': publication, 'enrollment': enrollment,
                'creationReference': HOST.controller_reference(self.root, publication, self.context)}

    def mutate(self, reader, record, arguments, timeout):
        identifier = arguments[-1]
        if record['pendingMutation'] is not None or identifier not in record['expected']:
            raise CoreCaptureError('Only the current worker may change its reviewed core')
        original = record['original'][identifier]
        flag = original['restartPolicy']['Name']
        if flag == 'on-failure':
            flag += ':' + str(original['restartPolicy']['MaximumRetryCount'])
        allowed = ([['update', '--restart', 'no', identifier], ['stop', identifier]]
                   if record['phase'] == 'checkpointing' else
                   [['start', identifier], ['update', '--restart', flag, identifier]]
                   if record['phase'] == 'resuming' else [])
        if arguments not in allowed:
            raise CoreCaptureError('This core capture mutation is outside its fixed phase')
        self.verify(reader, record)
        record['pendingMutation'] = list(arguments)
        self.save(record)
        reader.change(arguments, timeout=timeout)
        after = self.observation(reader, identifier)
        expected = copy.deepcopy(record['expected'][identifier])
        if arguments[0] == 'update':
            expected['restartPolicy'] = TX.NO_RESTART if arguments[2] == 'no' else original['restartPolicy']
        else:
            expected['state'] = 'running' if arguments[0] == 'start' else 'exited'
            if arguments[0] == 'start':
                expected['startedAt'] = after['startedAt']
                expected['networks'] = original['networks']
            else:
                if any(value not in {'', original['networks'].get(name)} for name, value in after['networks'].items()):
                    raise CoreCaptureError('A stopped core changed its network identity')
                expected['networks'] = after['networks']
        if after != expected:
            raise CoreCaptureError('The core mutation did not settle to its exact expected state')
        record['expected'][identifier] = after
        self.verify(reader, record)
        record['pendingMutation'] = None
        self.save(record)

    def capture(self, point_id, *, host_writers_stopped):
        if not isinstance(point_id, str) or not UUID.fullmatch(point_id) or host_writers_stopped is not True:
            raise CoreCaptureError('A core point ID and trusted stopped-writer acknowledgement are required')
        owner = HOST.core_capture_owner(self.root)
        if owner is not None and (owner['id'] != point_id or owner['context'] != self.context):
            raise CoreCaptureError('The capture owner is bound to a different operation')
        with self.exclusive(), HOST.host_lock(self.root) as lock_fd:
            directory = self.base / point_id
            if directory.exists() or directory.is_symlink():
                raise CoreCaptureError('Core capture jobs cannot be replayed or reclaimed')
            directory.mkdir(mode=0o700)
            self.sync(self.base)
            record = {'schema': SCHEMA, 'id': point_id, 'root': str(self.root), 'context': self.context,
                      'scope': SCOPE, 'phase': 'preparing', 'pendingMutation': None}
            self.save(record)
            try:
                reader = TX.APPS.Docker(self.context)
                reader.lock_fd = lock_fd
                source = self.source()
                if owner is not None and owner['sourceSha256'] != TX.APPS.digest(source):
                    raise CoreCaptureError('The capture owner source binding changed')
                bundle = self.snapshots / ('orbis-time-machine-core-' + point_id)
                checkpoint = TX.review(self.root, reader, bundle, directory / 'checkpoint.json', scope=SCOPE)
                if set(checkpoint['roles'].values()) != {'controller', 'database', 'queue'} or len(checkpoint['roles']) != 3:
                    raise CoreCaptureError('A core capture must cover exactly controller, database and queue')
                rows = reader.containers()
                TX.APPS.DETECT.validate_rows(rows)
                original = {row['id']: self.observation(reader, row['id']) for row in rows}
                controller = next(key for key, role in checkpoint['roles'].items() if role == 'controller')
                raw = reader._object(['container', 'inspect', '--format', '{{json .}}', controller])
                if raw['Config'].get('Image') != source['creationReference']:
                    raise CoreCaptureError('The source controller publication changed')
                record.update(source=source, checkpoint=checkpoint, original=original,
                              expected={key: copy.deepcopy(original[key]) for key in checkpoint['roles']},
                              daemonFingerprint=checkpoint['storage']['daemonFingerprint'])
                record['portableStorage'] = MAP.capture(TX, D, reader, checkpoint, original)
                self.verify(reader, record)
                if self.source() != source:
                    raise CoreCaptureError('The source enrollment changed during review')
                record['phase'] = 'checkpointing'
                self.save(record)
                guarded = GuardedReader(self, reader, record)
                TX.checkpoint(self.root, guarded, checkpoint, host_writers_stopped=True)
                manifest = TX.STORAGE.verified_manifest(bundle)
                journal = TX.read_record(directory / 'checkpoint.json', self.root, reader)
                if (manifest['plan'] != checkpoint['storage'] or journal.get('stage') != 'ready'
                        or journal.get('review') != checkpoint
                        or journal.get('backupFingerprint') != TX.APPS.digest(manifest)):
                    raise CoreCaptureError('The exact core checkpoint did not seal')
                record.update(phase='checkpoint-ready', checkpointSha256=TX.APPS.digest(manifest))
                self.save(record)
                self.verify(reader, record)
                if self.source() != source:
                    raise CoreCaptureError('The source enrollment changed before resume')
                record['phase'] = 'resuming'
                self.save(record)
                for item in TX.ordered(checkpoint, starting=True):
                    guarded.change(['start', item['id']], timeout=180)
                    if checkpoint['roles'][item['id']] == 'controller':
                        TX.require_healthy(reader, item['id'], timeout=180)
                for item in TX.ordered(checkpoint, starting=True):
                    policy = item['restartPolicy']
                    flag = policy['Name'] + (':' + str(policy['MaximumRetryCount']) if policy['Name'] == 'on-failure' else '')
                    guarded.change(['update', '--restart', flag, item['id']])
                self.verify(reader, record)
                if self.source() != source:
                    raise CoreCaptureError('The resumed source enrollment changed')
                TX.require_healthy(reader, controller)
                record.update(phase='complete', settlement={'schema': 'orbis.time-machine-core-resumed.v1',
                              'pointId': point_id, 'root': str(self.root), 'context': self.context, 'scope': SCOPE,
                              'sourceSha256': TX.APPS.digest(source), 'checkpointSha256': record['checkpointSha256'],
                              'portableStorageSha256': TX.APPS.digest(record['portableStorage']),
                              'containersSha256': TX.APPS.digest({**original, **record['expected']}),
                              'originalCoreIds': sorted(checkpoint['roles']), 'restoredSnapshotBytes': False})
                self.save(record)
                return copy.deepcopy(record['settlement'])
            except BaseException as error:
                record['phase'] = 'recovery-required'
                record['failureClass'] = type(error).__name__
                record.pop('settlement', None)
                self.save(record)
                raise
