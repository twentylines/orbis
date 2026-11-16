"""Root-reviewed cold restart after a quiescent worker failed before its core job.

This abandons the failed point, preserves current installation data and retires
the exact capture markers. It never retries a worker or restores snapshot bytes.
Only an independently authenticated Root caller may approve the reviewed stop.
"""
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
import json
import base64
import argparse
import importlib.util
import os
from pathlib import Path
import re
import stat
import sys
from types import SimpleNamespace


SCHEMA = 'orbis.core-capture-failed-recovery.v1'
POLICY = {'captureCompleted': False, 'restoreAuthority': False, 'snapshotRestore': False,
          'workerReplay': False, 'queueStateProved': False, 'restart': 'same-controller-cold-start-only'}
ADMISSION_FILES = {'request.json', 'handoff.json', 'source-hold.json', 'acceptance.json',
                   'launch-intent.json', 'supervisor.json', 'claim.json', 'failure.json', 'worker-terminal.json'}
POINT_FILES = {'point.json', 'capture-draft.orbis', 'wallpaper.orbis', 'icons.orbis'}


class FailedRecoveryError(ValueError):
    pass


def require(value):
    if not value:
        raise FailedRecoveryError('The failed capture needs protected review; retained data was preserved')


def require_platform(worker):
    worker.require_root()
    require(os.uname().sysname == 'Linux')


def execution_time(value):
    require(isinstance(value, str))
    match = re.fullmatch(r'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z', value)
    require(match is not None)
    try:parsed = datetime.strptime(match[1], '%Y-%m-%dT%H:%M:%S')
    except ValueError:raise FailedRecoveryError('Invalid Docker execution timestamp') from None
    return (*parsed.timetuple()[:6], int((match[2] or '').ljust(9, '0')))


@dataclass(frozen=True)
class RootFailedCaptureApproval:
    actor: dict
    review_sha256: str
    confirmation_id: str


class FailedCaptureRecovery:
    def __init__(self, manager, worker):
        require_platform(worker)
        self.M, self.W, self.A, self.P = manager, worker, worker.A, worker.P
        self.H = worker.CORE.HOST
        self.root, self.state, self.context = Path(manager.root), Path(manager.state), manager.context
        self.completion = worker.load('orbis-host-core-capture-completion.py', 'failed_recovery_completion')
        self.namespace = worker.load('orbis-host-core-capture-namespace.py', 'failed_recovery_namespace')
        self.retirement = worker.load('orbis-host-core-capture-retirement.py', 'failed_recovery_retirement')
        self.reservation = worker.load('orbis-host-core-capture-reservation.py', 'failed_recovery_reservation')
        self.base = self.state / 'core-capture-failed-recoveries'

    def digest(self, value):
        return self.W.digest(self.P.canonical(value))

    def actor(self, value):
        require(isinstance(value, dict) and set(value) == {'operatorId', 'authorizationSha256'})
        self.W.identifier(value['operatorId'])
        require(isinstance(value['authorizationSha256'], str) and self.W.HASH.fullmatch(value['authorizationSha256']))
        return self.digest(value)

    def transaction(self, point):
        return self.base / self.W.identifier(point)

    def read(self, directory, name):
        with self.A.protected_directory(directory) as fd:
            with self.A.protected_file(fd, name, 65536) as body:
                value = self.P.metadata(body, byte_limit=65536)
                require(isinstance(value, dict) and body == self.P.canonical(value))
                return value, body

    def persist(self, directory, name, value):
        self.W.RESERVED.create_atomic(self.W, directory, name, value)
        require(self.read(directory, name)[0] == value)

    def absent(self, base, parts):
        with self.A.protected_directory(base) as fd:
            parent = os.dup(fd)
        try:
            for index, name in enumerate(parts):
                require(name not in {'', '.', '..'} and '/' not in name)
                try:
                    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    return {'missing': index, 'parent': list(self.W.identity(os.fstat(parent)))}
                require(index < len(parts) - 1 and stat.S_ISDIR(info.st_mode) and info.st_uid == self.A.OWNER
                        and not stat.S_IMODE(info.st_mode) & 0o077)
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
                require(self.W.identity(os.fstat(child)) == self.W.identity(info))
                os.close(parent);parent = child
            raise FailedRecoveryError('Existing job, snapshot or selected-capture authority prevents early recovery')
        finally:
            os.close(parent)

    def no_job(self, point):
        return {'job': self.absent(self.M.capture.base, [point]),
                'snapshot': self.absent(self.M.capture.snapshots, ['orbis-time-machine-core-' + point]),
                'selection': self.absent(self.state, ['selected-captures', point])}

    def file(self, fd, name, limit):
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
        try:
            before = os.fstat(descriptor)
            require(stat.S_ISREG(before.st_mode) and before.st_uid == self.A.OWNER and before.st_nlink == 1
                    and stat.S_IMODE(before.st_mode) == 0o600 and 0 < before.st_size <= limit)
            chunks, count = [], 0
            while block := os.read(descriptor, min(1048576, limit + 1 - count)):
                chunks.append(block);count += len(block);require(count <= limit)
            require(count == before.st_size and self.A.seal(before) == self.A.seal(os.fstat(descriptor))
                    and self.A.seal(before) == self.A.seal(os.stat(name, dir_fd=fd, follow_symlinks=False)))
            return b''.join(chunks), list(self.A.seal(before))
        finally:
            os.close(descriptor)

    @contextmanager
    def storage(self, point):
        handles = []
        try:
            with self.A.protected_directory(self.root, private=False) as root:
                parent = os.dup(root);handles.append(parent)
            for index, name in enumerate(('backups', 'time-machine')):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
                info = os.fstat(child);require(info.st_uid == self.A.OWNER and not stat.S_IMODE(info.st_mode) & 0o022
                                              and (index == 0 or stat.S_IMODE(info.st_mode) == 0o700))
                require(self.W.identity(info) == self.W.identity(os.stat(name, dir_fd=parent, follow_symlinks=False)))
                handles.append(child);parent = child
            tm = parent
            points = os.open('points', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=tm);handles.append(points)
            leaf = os.open(point, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=points);handles.append(leaf)
            markers = os.open('core-capture', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=tm);handles.append(markers)
            identities = [list(self.W.identity(os.fstat(fd))) for fd in handles]
            for fd in (points, leaf, markers):
                info = os.fstat(fd);require(info.st_uid == self.A.OWNER and stat.S_IMODE(info.st_mode) == 0o700)
            yield SimpleNamespace(point=leaf, markers=markers, tm=tm, identities=identities,
                                  backups=handles[1], point_parent=points)
            require([list(self.W.identity(os.fstat(fd))) for fd in handles] == identities)
            with self.storage_binding(point) as current:
                require(current == identities)
        finally:
            for fd in reversed(handles):os.close(fd)

    @contextmanager
    def storage_binding(self, point):
        handles = []
        try:
            with self.A.protected_directory(self.root, private=False) as root:
                parent = os.dup(root);handles.append(parent)
            for name in ('backups', 'time-machine'):
                parent = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent);handles.append(parent)
            tm = parent
            parent = os.open('points', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=tm);handles.append(parent)
            handles.append(os.open(point, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent))
            handles.append(os.open('core-capture', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=tm))
            yield [list(self.W.identity(os.fstat(fd))) for fd in handles]
        finally:
            for fd in reversed(handles):os.close(fd)

    def point(self, storage, point, reservation, *, failed=False):
        names = set(os.listdir(storage.point));require({'point.json', 'capture-draft.orbis'} <= names <= POINT_FILES)
        inventory = {}
        for name in sorted(names):
            body, seal = self.file(storage.point, name, 32768 if name == 'point.json' else 33554484)
            inventory[name] = {'sha256': self.W.digest(body), 'seal': seal}
            if name == 'point.json':raw = body
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=self.reservation.unique_object,
                           parse_constant=self.reservation.invalid_number)
        require(isinstance(value, dict) and set(value) in (self.reservation.POINT_FIELDS, self.reservation.POINT_FIELDS | {'assetBytes'})
                and value['kind'] == 'orbis-core' and value['coreFormat'] == 'orbis.time-machine-core.v1'
                and value['status'] == ('failed' if failed else 'capturing')
                and value['issue'] == ('capture-failed' if failed else None)
                and value['core'] is None and type(value['archiveBytes']) is int and value['archiveBytes'] == 0
                and all(value[key] is None for key in ('backupJobId', 'archiveSha256', 'metadataSha256'))
                and type(value.get('assetBytes', 0)) is int and 0 <= value.get('assetBytes', 0) <= 67108968
                and self.reservation.validate_reservation({key: value[key] for key in self.reservation.FIELDS}, point) == reservation)
        after = {**value, 'status': 'failed', 'issue': 'capture-failed'}
        after_body = json.dumps(after, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
        return raw, after_body, inventory

    def raw_controller(self, reader, frame, *, running):
        raw = reader._object(['container', 'inspect', '--format', '{{json .}}', frame['id']])
        definition = self.W.CORE.D.DockerRestoreRuntime.definition(SimpleNamespace(P=self.P), raw)
        require(raw['Id'] == frame['id'] and raw['Image'] == frame['imageId']
                and self.digest(definition) == frame['definitionSha256'])
        state = raw['State']
        require(state.get('Running') is running and state.get('Status') == ('running' if running else 'exited')
                and all(state.get(key) is False for key in ('Restarting', 'Paused', 'Dead', 'OOMKilled')))
        require((type(state.get('Pid')) is int and state['Pid'] > 0) if running else state.get('Pid') == 0)
        mounts = [mount for mount in raw['Mounts'] if mount.get('Destination') == '/data/backups']
        require(len(mounts) == 1 and mounts[0].get('Type') == 'bind'
                and mounts[0].get('Source') == str(self.root / 'backups') and mounts[0].get('RW') is True)
        return raw

    def terminal(self, admission):
        terminal = self.W.SUPERVISOR.read_terminal(admission, worker=self.W.worker_context())
        require(terminal is not None and terminal['state'] == 'recovery-required'
                and terminal['workerQuiescent'] is True and type(terminal['workerExitCode']) is int
                and terminal['workerExitCode'] != 0 and terminal['claimSha256'] is not None
                and terminal['settledSha256'] is None)
        failure, _ = admission.read('failure.json')
        require(failure == admission.event('failure', state='recovery-required', failureClass=failure.get('failureClass'))
                and isinstance(failure['failureClass'], str) and re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]{0,127}', failure['failureClass']))
        require(set(os.listdir(admission.directory)) == ADMISSION_FILES)
        return terminal

    def inventory(self, reader):
        rows = reader.containers();self.W.CORE.TX.APPS.DETECT.validate_rows(rows)
        return {row['id']: self.W.CORE.TX.APPS.digest(self.M.capture.observation(reader, row['id'])) for row in rows}

    def dependencies(self, reader):
        roles = {}
        for row in reader.containers():
            raw = reader.app(row['id']);labels = raw['labels']
            if (labels.get('com.docker.compose.project') != 'runtipi'
                    or labels.get('com.docker.compose.project.working_dir') != str(self.root)):
                continue
            role = {'runtipi-db': 'database', 'runtipi-queue': 'queue'}.get(labels.get('com.docker.compose.service'))
            if role is None:continue
            require(role not in roles)
            self.completion.require_dependency_ready(self.W, reader, row['id'], role)
            roles[role] = {'id': row['id'], 'observationSha256': self.digest(self.M.capture.observation(reader, row['id']))}
        require(set(roles) == {'database', 'queue'})
        return roles

    def unchanged_inputs(self, review):
        point = self.W.identifier(review['id'])
        expected = {f'core-capture-admissions/{point}/{name}' for name in ADMISSION_FILES}
        expected |= {f'core-capture-preparations/{point}/{name}' for name in
                     ('preparation-intent.json', 'preparation.json', 'point-reservation.json', 'decision.json')}
        require(isinstance(review['inputs'], dict) and set(review['inputs']) == expected)
        for relative, expected in review['inputs'].items():
            directory, name = relative.rsplit('/', 1)
            require(self.W.digest(self.read(self.state / directory, name)[1]) == expected)

    def input_hashes(self, admission):
        result = {}
        for directory, names in ((admission.directory, ADMISSION_FILES),
                                 (self.M.directory(admission.point), {'preparation-intent.json', 'preparation.json',
                                                                   'point-reservation.json', 'decision.json'})):
            for name in names:
                result[str(directory.relative_to(self.state) / name)] = self.W.digest(self.read(directory, name)[1])
        return result

    def evidence(self, admission, reader, storage, actor_sha):
        point = admission.point
        require(admission.request['schema'] == 'orbis.core-capture-admission.v2')
        self.M.require_owned_idle_core()
        preparation, reservation, acceptance, hold = self.completion.CoreCaptureCompletion(self.M, self.W).bound_preparation(admission)
        terminal = self.terminal(admission)
        no_job = self.no_job(point)
        observed = self.M.observe(reader);frame = preparation['controller']
        require(observed['controller'] == frame and observed['sourceSha256'] == admission.request['sourceSha256'])
        raw = self.raw_controller(reader, frame, running=True)
        require(raw['State']['StartedAt'] == frame['startedAt'])
        execution_time(frame['startedAt'])
        with self.namespace.CaptureNamespace(self.W, reader, frame) as namespace:
            bound, bound_body, _ = namespace.read_source_hold(point)
            require(bound_body == hold)
            with namespace.directory() as marker_fd:
                require(self.W.identity(os.fstat(marker_fd)) == self.W.identity(os.fstat(storage.markers)))
            namespace.unchanged()
        original, after, files = self.point(storage, point, reservation)
        marker, marker_seal = self.file(storage.markers, 'source-hold.json', 8192)
        require(marker == hold)
        try:os.stat('source-hold-retired-' + point + '.json', dir_fd=storage.markers, follow_symlinks=False)
        except FileNotFoundError:pass
        else:raise FailedRecoveryError('Conflicting retired source marker')
        before = self.inventory(reader)
        review = {'schema': SCHEMA + '.review', 'id': point, 'root': str(self.root), 'context': self.context,
                  'actorSha256': actor_sha, 'controller': frame, 'sourceSha256': observed['sourceSha256'],
                  'requestSha256': admission.request_sha256, 'preparationSha256': acceptance['preparationSha256'],
                  'pointReservationSha256': preparation['pointReservationSha256'],
                  'terminalSha256': self.W.digest(admission.read('worker-terminal.json')[1]),
                  'failureSha256': self.W.digest(admission.read('failure.json')[1]), 'noJob': no_job,
                  'leaseSha256': self.W.digest(admission.lease.proof[0]),
                  'leaseIdentity': self.retirement.lease_identity(os.stat(self.H.capture_fence_path(self.root), follow_symlinks=False)),
                  'pointFiles': files, 'pointBeforeSha256': self.W.digest(original), 'pointAfterSha256': self.W.digest(after),
                  'sourceHoldSha256': self.W.digest(marker), 'sourceHoldSeal': marker_seal,
                  'storageIdentities': storage.identities, 'containers': before, 'dependencies': self.dependencies(reader),
                  'inputs': self.input_hashes(admission), **POLICY}
        require(self.terminal(admission) == terminal and self.no_job(point) == no_job and self.inventory(reader) == before)
        require(self.dependencies(reader) == review['dependencies'])
        admission.unchanged()
        return review

    @contextmanager
    def owned(self, point):
        admission = self.W.Admission(self.state, self.W.identifier(point))
        with self.M.service.lock, admission.lease.owner(), self.H.host_lock(self.root) as lock:
            reader = self.W.CORE.TX.APPS.Docker(self.context);reader.lock_fd = lock
            yield admission, reader

    def review(self, point, actor):
        actor_sha = self.actor(actor)
        with self.owned(point) as (admission, reader), self.storage(point) as storage:
            return self.evidence(admission, reader, storage, actor_sha)

    def intent(self, point, approval):
        require(isinstance(approval, RootFailedCaptureApproval))
        self.W.identifier(approval.confirmation_id)
        require(isinstance(approval.review_sha256, str) and self.W.HASH.fullmatch(approval.review_sha256))
        value, _ = self.read(self.transaction(point), 'intent.json')
        require(set(value) == {'schema', 'id', 'review', 'reviewSha256', 'actorSha256', 'confirmationId',
                               'pointBefore', 'pointAfter', 'lease'}
                and value['schema'] == SCHEMA + '.intent' and value['id'] == point
                and value['reviewSha256'] == approval.review_sha256
                and value['actorSha256'] == self.actor(approval.actor)
                and value['confirmationId'] == approval.confirmation_id)
        return self.validate_intent(point, value)

    def validate_intent(self, point, value):
        require(value['schema'] == SCHEMA + '.intent' and value['id'] == self.W.identifier(point))
        review = value['review']
        require(self.digest(review) == value['reviewSha256'] and review['schema'] == SCHEMA + '.review'
                and review['id'] == point and review['root'] == str(self.root) and review['context'] == self.context
                and review['actorSha256'] == value['actorSha256']
                and all(review[key] == field for key, field in POLICY.items()))
        require(self.W.digest(base64.b64decode(value['pointBefore'], validate=True)) == review['pointBeforeSha256']
                and self.W.digest(base64.b64decode(value['pointAfter'], validate=True)) == review['pointAfterSha256']
                and self.digest(value['lease']) == review['leaseSha256'])
        return value

    def point_write(self, storage, point, before, after):
        current, _ = self.file(storage.point, 'point.json', 32768)
        if current == after:return
        require(current == before)
        name = '.failed-recovery-' + point
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=storage.point)
        try:
            with os.fdopen(descriptor, 'wb', closefd=False) as stream:
                stream.write(after);stream.flush();os.fsync(descriptor)
            require(self.file(storage.point, 'point.json', 32768)[0] == before)
            os.replace(name, 'point.json', src_dir_fd=storage.point, dst_dir_fd=storage.point)
            os.fsync(storage.point)
            require(self.file(storage.point, 'point.json', 32768)[0] == after)
        finally:
            os.close(descriptor)

    def marker(self, storage, point, review, *, retired):
        name = 'source-hold-retired-' + point + '.json' if retired else 'source-hold.json'
        other = 'source-hold.json' if retired else 'source-hold-retired-' + point + '.json'
        body, seal = self.file(storage.markers, name, 8192)
        require(self.W.digest(body) == review['sourceHoldSha256'])
        # Rename changes ctime only; data, ownership and inode must survive.
        require(seal[:-1] == review['sourceHoldSeal'][:-1])
        try:os.stat(other, dir_fd=storage.markers, follow_symlinks=False)
        except FileNotFoundError:pass
        else:raise FailedRecoveryError('Contradictory active and retired source holds')
        return body

    def marker_write(self, storage, point, review):
        try:self.marker(storage, point, review, retired=True)
        except FileNotFoundError:
            self.marker(storage, point, review, retired=False)
            self.retirement.rename_noreplace(storage.markers, 'source-hold.json', 'source-hold-retired-' + point + '.json')
            os.fsync(storage.markers)
        self.marker(storage, point, review, retired=True)

    def retirement_for(self, point):
        subject = self
        class FailedRetirement(subject.retirement.CaptureRetirement):
            def authority_directory(self):return subject.transaction(point)
            def _authority(self):
                commit, _ = self._read('metadata-commit.json')
                value, _ = self._read('intent.json')
                review = value['review']
                require(commit == {'schema': SCHEMA + '.metadata-commit', 'id': point,
                    'root': str(subject.root), 'context': subject.context,
                    'intentSha256': subject.digest(value), 'reviewSha256': subject.digest(review),
                    'leaseIdentity': review['leaseIdentity'], 'pointAfterSha256': review['pointAfterSha256'],
                    'sourceHoldSha256': review['sourceHoldSha256']})
                require(subject.digest(value['lease']) == review['leaseSha256'])
                return commit, value['lease'], subject.P.canonical(value['lease'])
        return FailedRetirement(self.W, self.state, self.root, self.context, point)

    def metadata(self, point, value, storage):
        review = value['review'];self.unchanged_inputs(review)
        require(storage.identities == review['storageIdentities'])
        before, after = (base64.b64decode(value[key], validate=True) for key in ('pointBefore', 'pointAfter'))
        original_names = set(review['pointFiles'])
        require(set(os.listdir(storage.point)) == original_names)
        for name, expected in review['pointFiles'].items():
            if name != 'point.json':
                body, seal = self.file(storage.point, name, 33554484)
                require(self.W.digest(body) == expected['sha256'] and seal == expected['seal'])
        self.point_write(storage, point, before, after)
        self.marker_write(storage, point, review)
        commit = {'schema': SCHEMA + '.metadata-commit', 'id': point, 'root': str(self.root), 'context': self.context,
                  'intentSha256': self.digest(value), 'reviewSha256': self.digest(review),
                  'leaseIdentity': review['leaseIdentity'], 'pointAfterSha256': review['pointAfterSha256'],
                  'sourceHoldSha256': review['sourceHoldSha256']}
        file = self.transaction(point) / 'metadata-commit.json'
        if file.exists():require(self.read(file.parent, file.name)[0] == commit)
        else:self.persist(file.parent, file.name, commit)

    def stopped(self, reader, review):
        raw = self.raw_controller(reader, review['controller'], running=False)
        require(raw['State']['StartedAt'] == review['controller']['startedAt']
                and isinstance(raw['State'].get('FinishedAt'), str)
                and execution_time(raw['State']['FinishedAt']) > execution_time(raw['State']['StartedAt']))
        current = self.inventory(reader)
        require({key: value for key, value in current.items() if key != raw['Id']}
                == {key: value for key, value in review['containers'].items() if key != raw['Id']})
        self.unchanged_inputs(review)
        require(self.no_job(review['id']) == review['noJob'])
        require(self.dependencies(reader) == review['dependencies'])
        return {'schema': SCHEMA + '.stopped', 'id': review['id'], 'controller': review['controller'],
                'finishedAt': raw['State']['FinishedAt'], 'processId': 0}

    def apply(self, point, approval):
        require(isinstance(approval, RootFailedCaptureApproval))
        actor_sha = self.actor(approval.actor);self.W.identifier(approval.confirmation_id)
        require(isinstance(approval.review_sha256, str) and self.W.HASH.fullmatch(approval.review_sha256))
        directory = self.transaction(point)
        selector = self.H.capture_fence_path(self.root)
        if not selector.exists():
            value = self.intent(point, approval)
            self.retirement_for(point).inspect_retired()
            return self.start(point, value)
        with self.owned(point) as (admission, reader), self.storage(point) as storage:
            if not directory.exists():
                reviewed = self.evidence(admission, reader, storage, actor_sha)
                require(self.digest(reviewed) == approval.review_sha256)
                before, after, _ = self.point(storage, point,
                    self.completion.CoreCaptureCompletion(self.M, self.W).bound_preparation(admission)[1])
                value = {'schema': SCHEMA + '.intent', 'id': point, 'review': reviewed,
                         'reviewSha256': approval.review_sha256, 'actorSha256': actor_sha,
                         'confirmationId': approval.confirmation_id, 'pointBefore': base64.b64encode(before).decode(),
                         'pointAfter': base64.b64encode(after).decode(),
                         'lease': self.P.metadata(admission.lease.proof[0], byte_limit=8192)}
                self.base.mkdir(mode=0o700, exist_ok=True)
                with self.A.protected_directory(self.base):pass
                directory.mkdir(mode=0o700)
                self.persist(directory, 'intent.json', value)
            value = self.intent(point, approval);review = value['review']
            require(storage.identities == review['storageIdentities'])
            stop_file = directory / 'stopped.json'
            if not stop_file.exists():
                stop_intent = directory / 'stop-intent.json'
                if not stop_intent.exists():
                    require(self.evidence(admission, reader, storage, actor_sha) == review)
                    self.persist(directory, stop_intent.name, {'schema': SCHEMA + '.stop-intent',
                        'id': point, 'intentSha256': self.digest(value), 'controller': review['controller']})
                    reader.change(['stop', '--time', '30', review['controller']['id']], timeout=45)
                # A lost stop response is observed, never automatically replayed.
                self.persist(directory, stop_file.name, self.stopped(reader, review))
            require(self.read(directory, stop_file.name)[0] == self.stopped(reader, review))
            self.terminal(admission)
            self.metadata(point, value, storage)
            self.retirement_for(point).retire_committed()
        return self.start(point, value)

    def validate_retired_metadata(self, point, value):
        review = value['review'];self.unchanged_inputs(review)
        self.retirement_for(point).inspect_retired()
        with self.storage(point) as storage:
            require(storage.identities == review['storageIdentities']
                    and self.W.digest(self.file(storage.point, 'point.json', 32768)[0]) == review['pointAfterSha256'])
            self.marker(storage, point, review, retired=True)
            require(set(os.listdir(storage.point)) == set(review['pointFiles']))
            for name, expected in review['pointFiles'].items():
                if name != 'point.json':
                    body, seal = self.file(storage.point, name, 33554484)
                    require(self.W.digest(body) == expected['sha256'] and seal == expected['seal'])

    def start(self, point, value):
        directory, review = self.transaction(point), value['review']
        with self.M.service.lock, self.H.host_lock(self.root) as lock:
            self.validate_retired_metadata(point, value)
            reader = self.W.CORE.TX.APPS.Docker(self.context);reader.lock_fd = lock
            receipt = {'schema': SCHEMA + '.retired', 'id': point, 'intentSha256': self.digest(value),
                       'reviewSha256': self.digest(review), 'pointAfterSha256': review['pointAfterSha256'], **POLICY}
            if (directory / 'retired.json').exists():require(self.read(directory, 'retired.json')[0] == receipt)
            else:self.persist(directory, 'retired.json', receipt)
            if not (directory / 'start-intent.json').exists():
                self.stopped(reader, review)
                self.persist(directory, 'start-intent.json', {'schema': SCHEMA + '.start-intent', 'id': point,
                    'retirementSha256': self.digest(receipt), 'controller': review['controller']})
                reader.change(['start', review['controller']['id']], timeout=60)
            # A lost start response must be resolved by observation, never replay.
            raw = self.raw_controller(reader, review['controller'], running=True)
            require(raw['State']['StartedAt'] != review['controller']['startedAt'])
            stopped = self.read(directory, 'stopped.json')[0]
            require(execution_time(raw['State']['StartedAt']) > execution_time(stopped['finishedAt']))
            self.W.CORE.TX.require_healthy(reader, review['controller']['id'], timeout=180)
            require(self.dependencies(reader) == review['dependencies'])
            self.validate_retired_metadata(point, value)
            actual = self.raw_controller(reader, review['controller'], running=True)
            require(actual['State']['StartedAt'] == raw['State']['StartedAt'])
            result = {'schema': SCHEMA + '.complete', 'id': point, 'retirementSha256': self.digest(receipt),
                      'controller': {**review['controller'], 'startedAt': actual['State']['StartedAt']}, **POLICY}
            if (directory / 'complete.json').exists():require(self.read(directory, 'complete.json')[0] == result)
            else:self.persist(directory, 'complete.json', result)
            return result

    def status(self, point):
        value = self.validate_intent(point, self.read(self.transaction(point), 'intent.json')[0])
        self.unchanged_inputs(value['review'])
        directory = self.transaction(point)
        if (directory / 'complete.json').exists():
            self.validate_retired_metadata(point, value)
            receipt = self.read(directory, 'retired.json')[0]
            result = self.read(directory, 'complete.json')[0]
            require(result['schema'] == SCHEMA + '.complete' and result['id'] == point
                    and result['retirementSha256'] == self.digest(receipt)
                    and receipt['intentSha256'] == self.digest(value)
                    and all(result[key] == field for key, field in POLICY.items()))
            return {'id': point, 'state': 'complete', 'result': result}
        if not self.H.capture_fence_path(self.root).exists():
            self.validate_retired_metadata(point, value)
            state = 'retired-awaiting-cold-start'
        elif (directory / 'stopped.json').exists():state = 'controller-stopped'
        else:state = 'stop-outcome-needs-review'
        return {'id': point, 'state': state, **POLICY}


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('review', 'apply', 'status'))
    parser.add_argument('point')
    for name in ('root', 'state-dir', 'snapshots'):parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--docker-context', required=True)
    parser.add_argument('--operator-id', required=True)
    parser.add_argument('--authorization-sha256', required=True)
    parser.add_argument('--review-sha256')
    parser.add_argument('--confirmation-id')
    result = parser.parse_args(argv)
    for value in (result.root, result.state_dir, result.snapshots):
        if not value.is_absolute() or '..' in value.parts:parser.error('Choose canonical absolute installation paths.')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', result.docker_context):parser.error('Choose a valid Docker context.')
    uuid = r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
    if any(not re.fullmatch(uuid, value) for value in (result.point, result.operator_id)):
        parser.error('Choose valid capture and Root operator identifiers.')
    if not re.fullmatch(r'[a-f0-9]{64}', result.authorization_sha256):parser.error('A Root authorization audit digest is required.')
    if result.action == 'apply':
        if (not isinstance(result.review_sha256, str) or not re.fullmatch(r'[a-f0-9]{64}', result.review_sha256)
                or not isinstance(result.confirmation_id, str) or not re.fullmatch(uuid, result.confirmation_id)):
            parser.error('Apply requires the exact review digest and a new confirmation identifier.')
    elif result.review_sha256 is not None or result.confirmation_id is not None:
        parser.error('Observation does not accept a mutation confirmation.')
    return result


def cli_context(args):
    def load(name, key):
        spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
        module = importlib.util.module_from_spec(spec);sys.modules[key] = module;spec.loader.exec_module(module)
        return module
    service_module = load('orbis-host-service.py', 'failed_recovery_admin_service')
    service = service_module.HostService(args.root, args.docker_context, args.snapshots, args.state_dir,
                                         recover_interrupted_job=False)
    manager = load('orbis-host-core-capture-service.py', 'failed_recovery_admin_capture')
    return FailedCaptureRecovery(manager.CoreCaptureService(service), manager.W)


def require_root_cli():
    require(os.geteuid() == 0 and os.uname().sysname == 'Linux')


def main(argv=None):
    args = arguments(argv)
    require_root_cli()
    subject = cli_context(args)
    actor = {'operatorId': args.operator_id, 'authorizationSha256': args.authorization_sha256}
    if args.action == 'review':
        review = subject.review(args.point, actor);result = {'review': review, 'reviewSha256': subject.digest(review)}
    elif args.action == 'apply':
        result = subject.apply(args.point, RootFailedCaptureApproval(actor, args.review_sha256, args.confirmation_id))
    else:result = subject.status(args.point)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    try:raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, TypeError, KeyError):
        print('Failed capture recovery needs protected review. Retained data was preserved.', file=sys.stderr)
        raise SystemExit(1)
