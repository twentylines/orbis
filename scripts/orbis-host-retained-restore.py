#!/usr/bin/env python3
"""Root-owned retained restore decisions and single-use coordinator phase grants.

The Unix socket's existing privileged peer boundary supplies operator delegation.
Point/config/image authority comes from the independently retained root origin.
No request may provide a path, image ID, command, descriptor or commit decision.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
import secrets
import stat
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HOST = load('orbis-host.py', 'orbis_host_for_retained_restore')
CAPTURE = load('orbis-host-capture-authority.py', 'orbis_capture_for_retained_restore')
CAPTURE.AUTHORITY = HOST.AUTHORITY
P = HOST.IDENTITY.PUBLICATION
SCHEMA = 'orbis.retained-restore-transaction.v1'
PHASES = {'prepare', 'promote', 'verify', 'rollback', 'commit'}
TERMINAL = {'complete', 'rolled-back'}
JOURNAL_LIMIT = 16 * 1024 * 1024


def fail():
    return ValueError('Retained restore requires protected recovery or a new exact review')


def hex64(value):
    return type(value) is str and HOST.IDENTITY.HEX.fullmatch(value) is not None


def digest(value):
    return hashlib.sha256(P.canonical(value)).hexdigest()


def marker_path(root):
    return root.parent / ('.' + root.name + '.orbis-retained-restore.json')


class RestoreManager:
    def __init__(self, service, runtime=None):
        self.service = service
        self.host = service.HOST if hasattr(service, 'HOST') else HOST
        self.authority = self.host.AUTHORITY
        CAPTURE.AUTHORITY = self.authority
        self.CAPTURE = CAPTURE
        self.root, self.context, self.state = service.root, service.context, service.state_dir
        self.metadata_lock = threading.RLock()
        if runtime is None:
            driver = load('orbis-host-retained-restore-runtime.py', 'orbis_runtime_for_retained_restore')
            runtime = driver.DockerRestoreRuntime(self)
        self.runtime = runtime

    def directory(self, identifier, *, create=False):
        CAPTURE.point_id(identifier)
        with self.authority.protected_directory(self.state):
            pass
        base = self.state / 'retained-restores'
        if create:
            base.mkdir(mode=0o700, exist_ok=True)
        with self.authority.protected_directory(base):
            pass
        target = base / identifier
        if create:
            target.mkdir(mode=0o700, exist_ok=True)
        with self.authority.protected_directory(target):
            pass
        return target

    def read(self, identifier):
        path = self.directory(identifier)
        with self.authority.protected_directory(path) as directory:
            with self.authority.protected_file(directory, 'transaction.json', JOURNAL_LIMIT) as body:
                value = P.metadata(body, byte_limit=JOURNAL_LIMIT, string_limit=2 * 1024 * 1024)
        if (value.get('schema') != SCHEMA or value.get('id') != identifier or value.get('root') != str(self.root)
                or value.get('context') != self.context or value.get('decision') not in (None, 'commit', 'rollback')
                or not hex64(value.get('tokenSha256'))):
            raise fail()
        return value

    def save(self, record):
        body = P.canonical(record)
        if len(body) > JOURNAL_LIMIT:
            raise fail()
        self.authority.atomic(self.directory(record['id']) / 'transaction.json', body)

    @contextmanager
    def operation(self, identifier):
        path = self.directory(identifier)
        descriptor = os.open(path / 'operation.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            details = os.fstat(descriptor)
            if (not stat.S_ISREG(details.st_mode) or details.st_uid != self.authority.OWNER or details.st_nlink != 1
                    or stat.S_IMODE(details.st_mode) & 0o077):
                raise fail()
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            token = self.host.RESTORE_TRANSACTION.set(identifier)
            try:
                with self.host.host_lock(self.root):
                    yield
            finally:
                self.host.RESTORE_TRANSACTION.reset(token)
        finally:
            os.close(descriptor)

    def authenticate(self, identifier, token):
        record = self.read(identifier)
        if not hex64(token) or not secrets.compare_digest(record['tokenSha256'], hashlib.sha256(token.encode()).hexdigest()):
            raise fail()
        return record

    def revocation(self, identifier):
        CAPTURE.point_id(identifier)
        base = self.state / 'retained-restore-revocations'
        try:
            with self.authority.protected_directory(base) as directory:
                with self.authority.protected_file(directory, identifier + '.json', 8192) as body:
                    value = P.metadata(body)
        except FileNotFoundError:
            if base.is_symlink() or (base.exists() and not base.is_dir()):
                raise fail()
            return None
        if (value.get('schema') != 'orbis.retained-restore-revocation.v1' or value.get('root') != str(self.root)
                or value.get('context') != self.context or value.get('restoreId') != identifier):
            raise fail()
        return value

    def require_not_revoked(self, identifier):
        if self.revocation(identifier) is not None:
            raise fail()

    def absence(self, request):
        expected = {'pointId', 'restoreId', 'importId', 'currentRevision', 'stageRevision', 'clientKey'}
        if (not P.exact(request, expected) or any(not hex64(request[key]) for key in ('currentRevision', 'stageRevision', 'clientKey'))):
            raise fail()
        for key in ('pointId', 'restoreId', 'importId'):
            CAPTURE.point_id(request[key])
        marker = marker_path(self.root)
        if marker.exists() or marker.is_symlink():
            raise fail()
        with self.authority.protected_directory(self.state):
            pass
        revoked = self.revocation(request['restoreId'])
        if revoked is not None and revoked.get('requestSha256') != digest(request):
            raise fail()
        base = self.state / 'retained-restores'
        if base.exists() or base.is_symlink():
            with self.authority.protected_directory(base) as directory:
                names = os.listdir(directory)
            if len(names) > 4096:
                raise fail()
            for name in names:
                if name == request['restoreId'] and revoked is not None:
                    with self.authority.protected_directory(base / name) as directory:
                        children = os.listdir(directory)
                        if set(children) - {'operation.lock'}:
                            raise fail()
                        if children:
                            with self.authority.protected_file(directory, 'operation.lock', 0):
                                pass
                    continue
                if self.read(name)['phase'] not in TERMINAL or name == request['restoreId']:
                    raise fail()
        if revoked is not None:
            return revoked['proof']
        review = self.review({key: request[key] for key in ('pointId', 'restoreId', 'importId')})
        if any(review[key] != request[key] for key in ('currentRevision', 'stageRevision')):
            raise fail()
        origin = self.capture_origin(request['pointId'])
        source = self.runtime.source_snapshot()
        if digest(source) != request['currentRevision']:
            raise fail()
        staged = self.runtime.review_stage(request, origin, source)
        if digest(staged) != request['stageRevision']:
            raise fail()
        proof = {'version': 1, 'transactionId': request['restoreId'], 'pointId': request['pointId'], 'state': 'absent', 'revoked': True,
                 'admissionSha256': staged['sourceBinding']['admissionSha256'], 'currentRevision': request['currentRevision'], 'stageRevision': request['stageRevision']}
        revoked = {'schema': 'orbis.retained-restore-revocation.v1', 'root': str(self.root), 'context': self.context,
                   'restoreId': request['restoreId'], 'requestSha256': digest(request),
                   'clientKeySha256': hashlib.sha256(request['clientKey'].encode()).hexdigest(), 'proof': proof}
        base = self.state / 'retained-restore-revocations'
        base.mkdir(mode=0o700, exist_ok=True)
        with self.authority.protected_directory(base):
            pass
        CAPTURE.immutable(base / (request['restoreId'] + '.json'), P.canonical(revoked))
        return proof

    def review(self, request):
        if not P.exact(request, {'pointId', 'restoreId', 'importId'}):
            raise fail()
        for item in request.values():
            CAPTURE.point_id(item)
        self.host.require_no_capture_fence(self.root)
        origin = self.capture_origin(request['pointId'])
        authority = json.loads(origin.authority_bytes)
        source = self.runtime.source_snapshot()
        staged = self.runtime.review_stage(request, origin, source)
        return {'version': 1, **request, 'currentRevision': digest(source), 'stageRevision': digest(staged),
                'publication': authority['publication']}

    def begin(self, request):
        expected = {'pointId', 'restoreId', 'importId', 'currentRevision', 'stageRevision', 'clientKey'}
        if (not P.exact(request, expected) or not hex64(request['currentRevision']) or not hex64(request['stageRevision'])
                or not hex64(request['clientKey'])):
            raise fail()
        identifiers = {name: request[name] for name in ('pointId', 'restoreId', 'importId')}
        identifier = request['restoreId']
        self.require_not_revoked(identifier)
        try:
            existing = self.authenticate(identifier, request['clientKey'])
        except FileNotFoundError:
            existing = None
        if existing is not None:
            if (existing['pointId'] != request['pointId'] or existing['importId'] != request['importId']
                    or digest(existing['source']) != request['currentRevision'] or digest(existing['stage']) != request['stageRevision']):
                raise fail()
            return {'version': 1, 'transactionId': identifier, 'token': request['clientKey'],
                    'binding': self.binding(existing, include_snapshot=True) if existing.get('workerSnapshot') and existing.get('candidateId') and existing.get('verifierId') else None,
                    'state': existing['phase']}
        review = self.review(identifiers)
        if any(review[name] != request[name] for name in ('currentRevision', 'stageRevision')):
            raise fail()
        identifier = request['restoreId']
        path = self.directory(identifier, create=True)
        if (path / 'transaction.json').exists() or (path / 'transaction.json').is_symlink():
            raise fail()
        token = request['clientKey']
        with self.operation(identifier):
            self.require_not_revoked(identifier)
            origin = self.capture_origin(request['pointId'])
            source = self.runtime.source_snapshot()
            staged = self.runtime.review_stage(identifiers, origin, source)
            if digest(source) != request['currentRevision'] or digest(staged) != request['stageRevision']:
                raise fail()
            record = dict(schema=SCHEMA, id=identifier, pointId=request['pointId'], importId=request['importId'], root=str(self.root),
                          context=self.context, tokenSha256=hashlib.sha256(token.encode()).hexdigest(), source=source, stage=staged,
                          originSha256=hashlib.sha256(origin.authority_bytes).hexdigest(), phase='allocating', decision=None,
                          createdAt=int(time.time() * 1000), sequence=0, grant=None, dataTouched=False)
            self.save(record)
            marker = marker_path(self.root)
            if marker.exists() or marker.is_symlink():
                raise fail()
            self.authority.atomic(marker, P.canonical({'schema': SCHEMA, 'id': identifier, 'root': str(self.root), 'context': self.context}))
            # Every created Docker identity is journalled by the runtime before it
            # can run. Allocation never changes live data or stops the controller.
            self.runtime.allocate(record, origin)
            record['phase'] = 'allocated'
            self.save(record)
        return {'version': 1, 'transactionId': identifier, 'token': token, 'binding': self.binding(record, include_snapshot=True), 'state': 'allocated'}

    def binding(self, record, *, include_snapshot=False):
        target = record['target']
        if len({record['workerId'], record['source']['controllerId'], record['candidateId'], record['verifierId']}) != 4:
            raise fail()
        result = {'restoreId': record['id'], 'nonce': record['nonce'], 'pointId': record['pointId'], 'workerId': record['workerId'],
                'originalController': record['source']['controllerId'], 'candidateController': record['candidateId'],
                'verifierController': record['verifierId'], 'target': target,
                'migrationsPath': '/data/backups/restores/' + record['id'] + '/retained/migrations'}
        if include_snapshot:
            result['workerSnapshot'] = record['workerSnapshot']
            result['sourceBinding'] = record['stage']['sourceBinding']
        return result

    def origin(self, record):
        origin = self.capture_origin(record['pointId'])
        if hashlib.sha256(origin.authority_bytes).hexdigest() != record['originSha256']:
            raise fail()
        return origin

    def capture_origin(self, point):
        try:
            path = CAPTURE.directory(self.state, point)
        except FileNotFoundError:
            return CAPTURE.load_origin(self.state, self.root, self.context, point)
        extra = path / 'proxy-finalized.json'
        return (CAPTURE.load_proxy_origin(self.state, self.root, self.context, point) if extra.exists() or extra.is_symlink()
                else CAPTURE.load_origin(self.state, self.root, self.context, point))

    def run_phase(self, record, phase, commit_stage=None):
        if phase not in PHASES:
            raise fail()
        self.require_phase_state(record, phase, commit_stage)
        self.runtime.validate_worker(record)
        self.runtime.validate_overlay(record)
        self.origin(record)
        if phase == 'commit' and record['decision'] != 'commit':
            raise fail()
        if phase == 'rollback' and record['decision'] != 'rollback':
            raise fail()
        if phase in {'prepare', 'promote', 'verify'} and record['decision'] is not None:
            raise fail()
        if commit_stage == 'finish':
            self.runtime.assert_active(record)
        grant = secrets.token_hex(32)
        with self.metadata_lock:
            record['sequence'] += 1
            record['grant'] = dict(tokenSha256=hashlib.sha256(grant.encode()).hexdigest(), phase=phase,
                                   sequence=record['sequence'], status='issued', commitStage=commit_stage)
            self.save(record)
        self.runtime.execute_phase(record, phase, {'version': 1, 'transactionId': record['id'], 'token': grant})
        fresh = self.read(record['id'])
        current = fresh.get('grant')
        if (not current or current['sequence'] != record['sequence'] or current['phase'] != phase or current['status'] != 'complete'):
            raise fail()
        record.clear()
        record.update(fresh)

    def require_phase_state(self, record, phase, commit_stage):
        expected = {'prepare': 'preparing', 'promote': 'promoting', 'verify': 'verifying', 'rollback': 'rolling-back'}
        state = ('active' if commit_stage == 'finish' else 'committing') if phase == 'commit' else expected.get(phase)
        if (record['phase'] != state or (phase == 'commit' and commit_stage not in {'authorize', 'finish'})
                or (phase != 'commit' and commit_stage is not None)):
            raise fail()

    def require_running_operation(self, identifier):
        descriptor = os.open(self.directory(identifier) / 'operation.lock', os.O_RDWR | os.O_NOFOLLOW)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            raise fail()
        finally:
            os.close(descriptor)

    def redeem_phase(self, identifier, request):
        if not P.exact(request, {'version', 'token', 'phase'}) or type(request['version']) is not int or request['version'] != 1:
            raise fail()
        with self.metadata_lock:
            self.require_running_operation(identifier)
            record = self.read(identifier)
            grant = record.get('grant')
            if (not grant or grant['status'] != 'issued' or grant['phase'] != request['phase'] or not hex64(request['token'])
                    or not secrets.compare_digest(grant['tokenSha256'], hashlib.sha256(request['token'].encode()).hexdigest())):
                raise fail()
            self.runtime.validate_worker(record)
            self.origin(record)
            self.require_phase_state(record, grant['phase'], grant['commitStage'])
            healthy = grant['phase'] == 'commit' and grant['commitStage'] == 'finish'
            if healthy:
                self.runtime.assert_active(record)
            grant['status'] = 'running'
            self.save(record)
            return {'version': 1, 'transactionId': identifier, **self.binding(record), 'phase': grant['phase'],
                    'sequence': grant['sequence'], 'rootDecision': record['decision'] or 'none',
                    'commitStage': grant['commitStage'], 'candidateHealthy': healthy}

    def complete_phase(self, identifier, request):
        if (not P.exact(request, {'version', 'token', 'phase', 'sequence'}) or type(request['version']) is not int
                or request['version'] != 1 or type(request['sequence']) is not int):
            raise fail()
        with self.metadata_lock:
            self.require_running_operation(identifier)
            record = self.read(identifier)
            grant = record.get('grant')
            if (not grant or grant['status'] != 'running' or grant['phase'] != request['phase'] or grant['sequence'] != request['sequence']
                    or not hex64(request['token']) or not secrets.compare_digest(grant['tokenSha256'], hashlib.sha256(request['token'].encode()).hexdigest())):
                raise fail()
            self.runtime.validate_worker(record)
            self.require_phase_state(record, grant['phase'], grant['commitStage'])
            if grant['phase'] == 'commit' and grant['commitStage'] == 'finish':
                self.runtime.assert_active(record)
            self.runtime.pin_phase_operation(record, grant['phase'], grant['commitStage'])
            grant['status'] = 'complete'
            self.save(record)
            return {'version': 1, 'transactionId': identifier, 'phase': grant['phase'], 'sequence': grant['sequence'], 'status': 'complete'}

    def prepare(self, identifier, token):
        with self.operation(identifier):
            record = self.authenticate(identifier, token)
            if record['phase'] == 'prepared' and record['decision'] is None:
                self.runtime.validate_prepared(record)
                return self.public(record)
            if record['phase'] != 'allocated' or record['decision'] is not None:
                raise fail()
            self.origin(record)
            self.runtime.validate_rebind(record)
            self.runtime.retire_provisional(record)
            record['phase'] = 'preparing'
            record['dataTouched'] = True
            self.save(record)
            self.run_phase(record, 'prepare')
            self.runtime.validate_prepared(record)
            if record['stage'].get('metadata', {}).get('schema') == 'orbis.time-machine-runtime.v6':
                self.runtime.historical_apps(record, 'probe')
            record['phase'] = 'prepared'
            self.save(record)
            return self.public(record)

    def _finish(self, record, *, app_recovery=False):
        if record['decision'] != 'commit':
            raise fail()
        # Commit authorization never discards old data. Public candidate startup
        # follows the durable root and Node commit decisions; recovery is forward-only.
        record['phase'] = 'committing'
        self.save(record)
        if record.get('commitAuthorized') is not True:
            self.run_phase(record, 'commit', 'authorize')
            # This root-owned acknowledgement precedes every public rename.
            # Recovery never replays pre-activation identity checks afterward.
            record['commitAuthorized'] = True
            self.save(record)
        if not self.runtime.node_commit_authorized(record):
            raise fail()
        if record['stage'].get('metadata', {}).get('schema') == 'orbis.time-machine-runtime.v6':
            self.runtime.historical_apps(record, 'activate', recovery=app_recovery)
        self.runtime.commit_controller(record)
        record['phase'] = 'activating'
        self.save(record)
        self.runtime.activate_candidate(record)
        self.runtime.assert_active(record)
        if record['stage'].get('metadata', {}).get('schema') == 'orbis.time-machine-runtime.v6':
            self.runtime.historical_apps(record, 'verify')
        record['phase'] = 'active'
        self.save(record)
        if not self.runtime.node_complete(record):
            self.run_phase(record, 'commit', 'finish')
        self.runtime.assert_active(record)
        self.runtime.set_terminal_policy(record)
        record['phase'] = 'complete'
        self.save(record)
        self.runtime.retire_auxiliary(record)
        self.seal_terminal(record)
        return self.public(record)

    def activate(self, identifier, token):
        with self.operation(identifier):
            record = self.authenticate(identifier, token)
            self.origin(record)
            if record['phase'] in TERMINAL:
                return self.public(record)
            if record['decision'] == 'commit':
                return self._finish(record)
            if record['phase'] != 'prepared' or record['decision'] is not None:
                raise fail()
            try:
                self.runtime.validate_prepared(record)
                record['phase'] = 'promoting'
                self.save(record)
                self.run_phase(record, 'promote')
                record['phase'] = 'verifying'
                self.save(record)
                self.run_phase(record, 'verify')
                self.runtime.verify_historical_hold(record)
                self.runtime.validate_promoted(record)
                # Persist the complete target/config authority before the global
                # decision, but never publish it as enrollment before commit.
                if record['stage'].get('metadata', {}).get('schema') == 'orbis.time-machine-runtime.v6':
                    self.runtime.historical_apps(record, 'precommit')
                self.runtime.compile_authority(record)
                record['phase'] = 'commit-decided'
                record['decision'] = 'commit'
                record['grant'] = None
                self.save(record)
            except BaseException:
                durable = self.read(identifier)
                if durable['decision'] == 'commit':
                    raise
                self._rollback(durable)
                raise
            return self._finish(record)

    def _rollback(self, record):
        if record['decision'] == 'commit':
            raise fail()
        record['decision'] = 'rollback'
        record['phase'] = 'rolling-back'
        record['grant'] = None
        self.save(record)
        self.runtime.quiesce_owned(record)
        if record['stage'].get('metadata', {}).get('schema') == 'orbis.time-machine-runtime.v6':
            self.runtime.historical_apps(record, 'rollback')
        self.runtime.retire_provisional(record)
        if record.get('workerId') and record.get('dataTouched'):
            self.runtime.restart_coordinator(record)
            self.run_phase(record, 'rollback')
        self.runtime.restore_original_controller(record)
        record['phase'] = 'rolled-back'
        self.save(record)
        self.runtime.retire_auxiliary(record)
        self.seal_terminal(record)
        return self.public(record)

    def recover(self, identifier, token):
        return self._recover(identifier, token)

    def pending_identifier(self):
        path = marker_path(self.root)
        with self.authority.protected_directory(path.parent, private=False) as directory:
            with self.authority.protected_file(directory, path.name, 4096) as body:
                marker = P.metadata(body)
        if (not P.exact(marker, {'schema', 'id', 'root', 'context'}) or marker.get('schema') != SCHEMA
                or marker.get('root') != str(self.root) or marker.get('context') != self.context):
            raise fail()
        return CAPTURE.point_id(marker['id'])

    def resume_pending(self):
        # Only the installed root daemon calls this after opening its socket.
        # The accepted protected journal/origin, not a new request, delegates it.
        identifier = self.pending_identifier()
        return self._recover(identifier, None, root_resume=True)

    def _recover(self, identifier, token, *, root_resume=False):
        with self.operation(identifier):
            if root_resume:
                if self.pending_identifier() != identifier:
                    raise fail()
                record = self.read(identifier)
                record['recoveryRequired'] = True
                self.save(record)
            else:
                record = self.authenticate(identifier, token)
                record['recoveryRequired'] = True
                self.save(record)
            if record['phase'] in TERMINAL and record.get('terminalSettled'):
                if record.get('normalBootstrapRequired') and record['decision'] == 'commit':
                    if not record.get('normalBootstrapReady'):
                        self.origin(record)
                        proof = self.seal_terminal(record)
                        record['normalBootstrapLease'] = None
                        self.save(record)
                        self.runtime.restart_normal_bootstrap(record, proof)
                        return self.public(record)
                    self.runtime.verify_normal_bootstrap_decision(record, self.seal_terminal(record))
                    if self.maintenance()['state'] == 'checking':
                        self.runtime.finish_overlay(record)
                self.clear_marker(record)
                return self.public(record)
            self.origin(record)
            if record['phase'] in TERMINAL:
                if record['phase'] == 'complete':
                    self.runtime.assert_active(record)
                else:
                    self.runtime.restore_original_controller(record)
                self.runtime.retire_auxiliary(record)
                self.seal_terminal(record)
                return self.public(record)
            # Kill a surviving exec before revoking its phase grant. The inert
            # coordinator can then safely execute a new bounded recovery grant.
            self.runtime.quiesce_owned(record)
            self.runtime.restore_overlay(record)
            if record.get('workerId'):
                self.runtime.restart_coordinator(record)
            record['grant'] = None
            self.save(record)
            if record['decision'] == 'commit':
                return self._finish(record, app_recovery=True)
            return self._rollback(record)

    def interrupted(self, identifier):
        with self.metadata_lock:
            record = self.read(identifier)
            if record['phase'] not in TERMINAL:
                record['recoveryRequired'] = True
                self.save(record)

    def clear_marker(self, record):
        path = marker_path(self.root)
        try:
            body = path.read_bytes()
        except FileNotFoundError:
            return
        expected = {'schema': SCHEMA, 'id': record['id'], 'root': str(self.root), 'context': self.context}
        if path.is_symlink() or P.metadata(body) != expected:
            raise fail()
        path.unlink()
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def public(self, record):
        return {'version': 1, 'transactionId': record['id'], 'pointId': record['pointId'], 'state': record['phase'],
                'decision': record['decision'], 'recoverable': record['phase'] not in TERMINAL}

    def status(self, identifier, token):
        record = self.authenticate(identifier, token)
        binding = self.binding(record, include_snapshot=True) if record.get('workerSnapshot') and record.get('candidateId') and record.get('verifierId') else None
        return {**self.public(record), 'admissionSha256': record['stage']['sourceBinding']['admissionSha256'], 'binding': binding}

    def seal_terminal(self, record):
        path = self.directory(record['id'])
        try:
            with self.authority.protected_directory(path) as directory:
                with self.authority.protected_file(directory, 'terminal-proof.json', 512 * 1024) as body:
                    result = P.metadata(body, byte_limit=512 * 1024)
        except FileNotFoundError:
            material = self.runtime.terminal_material(record)
            journal_body = material.pop('_journalBody')
            if hashlib.sha256(journal_body).hexdigest() != material['nodeJournalSha256']:
                raise fail()
            CAPTURE.immutable(path / 'node-terminal-journal.json', journal_body)
            binding = self.binding(record, include_snapshot=True) if record.get('workerSnapshot') and record.get('candidateId') and record.get('verifierId') else None
            result = {'schema': 'orbis.retained-terminal-proof.v1', 'version': 1, 'transactionId': record['id'], 'pointId': record['pointId'],
                      'state': record['phase'], 'decision': record['decision'], 'admissionSha256': record['stage']['sourceBinding']['admissionSha256'],
                      'sourceBinding': record['stage']['sourceBinding'], 'binding': binding, **material}
            result['proofSha256'] = hashlib.sha256(b'orbis.retained-terminal-proof.v1\n' + P.canonical(result)).hexdigest()
            if len(P.canonical(result)) > 512 * 1024:
                raise fail()
            CAPTURE.immutable(path / 'terminal-proof.json', P.canonical(result))
        descriptor = {key: value for key, value in result.items() if key != 'proofSha256'}
        if (result.get('schema') != 'orbis.retained-terminal-proof.v1' or type(result.get('version')) is not int or result['version'] != 1
                or result.get('transactionId') != record['id'] or result.get('pointId') != record['pointId']
                or result.get('state') != record['phase'] or result.get('decision') != record['decision']
                or result.get('sourceBinding') != record['stage']['sourceBinding']
                or result.get('proofSha256') != hashlib.sha256(b'orbis.retained-terminal-proof.v1\n' + P.canonical(descriptor)).hexdigest()):
            raise fail()
        return result

    def candidate_resume(self, identifier, token):
        # Candidate startup calls while the root driver holds its operation lock
        # and waits for health. Taking that lock here would deadlock startup.
        with self.metadata_lock:
            self.require_running_operation(identifier)
            record = self.authenticate(identifier, token)
            lease = record.get('candidateActivationLease')
            now = int(time.time() * 1000)
            if (record.get('decision') != 'commit' or record.get('commitAuthorized') is not True
                    or record.get('phase') not in {'activating', 'active'} or self.pending_identifier() != identifier
                    or not P.exact(lease, {'startedAt', 'expiresAt'})
                    or type(lease['startedAt']) is not int or type(lease['expiresAt']) is not int
                    or lease['expiresAt'] - lease['startedAt'] != 15 * 60 * 1000
                    or not lease['startedAt'] <= now < lease['expiresAt']):
                raise fail()
            self.origin(record)
            material = self.runtime.candidate_resume_material(record)
            if (not P.exact(material, {'operationSha256', 'imageCaptureSha256', 'imageInventorySha256'})
                    or any(not hex64(value) for value in material.values())):
                raise fail()
            result = {'version': 1, 'transactionId': identifier, 'pointId': record['pointId'], 'nonce': record['nonce'],
                      'state': record['phase'], 'decision': 'commit', 'binding': self.binding(record, include_snapshot=True),
                      **material, 'expiresAt': lease['expiresAt']}
            if len(P.canonical(result)) > 512 * 1024:
                raise fail()
            return result

    def terminal_proof(self, identifier, token):
        with self.operation(identifier):
            record = self.authenticate(identifier, token)
            if record['phase'] not in TERMINAL:
                raise fail()
            state = self.maintenance()['state']
            if state == 'checking' and self.pending_identifier() != identifier or state not in {'idle', 'checking'}:
                raise fail()
            self.origin(record)
            return self.seal_terminal(record)

    def terminal_finalize(self, identifier, token, proof_sha256):
        with self.operation(identifier):
            record = self.authenticate(identifier, token)
            if record['phase'] not in TERMINAL or not hex64(proof_sha256):
                raise fail()
            proof = self.seal_terminal(record)
            if proof['proofSha256'] != proof_sha256:
                raise fail()
            if not record.get('terminalSettled'):
                self.origin(record)
                receipt_sha = self.runtime.finalize_terminal_metadata(record, proof)
                if not (record.get('normalBootstrapRequired') and record['decision'] == 'commit'):
                    self.runtime.finish_overlay(record)
                record['terminalReconciliationSha256'] = receipt_sha
                record['terminalSettled'] = True
                self.save(record)
            # A lost reply or crash after the durable settlement still resumes
            # this exact marker removal without revisiting mutable user data.
            if not (record.get('normalBootstrapRequired') and record['decision'] == 'commit' and not record.get('normalBootstrapReady')):
                if record.get('normalBootstrapRequired') and record['decision'] == 'commit':
                    self.runtime.verify_normal_bootstrap_decision(record, proof)
                if record.get('normalBootstrapRequired') and record['decision'] == 'commit' and self.maintenance()['state'] == 'checking':
                    self.runtime.finish_overlay(record)
                self.clear_marker(record)
            return {'version': 1, 'transactionId': identifier, 'state': 'settled', 'proofSha256': proof_sha256}

    def candidate_app_result(self, identifier, token):
        with self.metadata_lock:
            base = self.candidate_resume(identifier, token)
            record = self.authenticate(identifier, token)
            material = self.runtime.candidate_app_result_material(record)
            if (not P.exact(material, {'appRuntimeSha256', 'appEffectsSha256', 'containers'})
                    or not hex64(material['appRuntimeSha256']) or not hex64(material['appEffectsSha256'])
                    or not isinstance(material['containers'], list) or len(material['containers']) > 1024): raise fail()
            result = {**base, **material}
            if len(P.canonical(result)) > 2 * 1024 * 1024: raise fail()
            return result

    def normal_bootstrap(self, identifier, token, proof_sha256):
        with self.operation(identifier):
            record = self.authenticate(identifier, token)
            if (record['phase'] != 'complete' or record['decision'] != 'commit' or record.get('terminalSettled') is not True
                    or record.get('normalBootstrapRequired') is not True or record.get('normalBootstrapReady')
                    or self.pending_identifier() != identifier):
                raise fail()
            self.origin(record)
            proof = self.seal_terminal(record)
            if proof['proofSha256'] != proof_sha256:
                raise fail()
            material = self.runtime.normal_bootstrap_material(record, proof)
            if (not P.exact(material, {'candidateStartedAt', 'brokerStartedAt'})
                    or any(not isinstance(value, str) or not 1 <= len(value) <= 128 for value in material.values())):
                raise fail()
            lease = record.get('normalBootstrapLease')
            now = int(time.time() * 1000)
            if lease is None:
                lease = {'id': str(uuid.uuid4()), 'startedAt': now, 'expiresAt': now + 900000, **material}
                record['normalBootstrapLease'] = lease
                self.save(record)
            if (not P.exact(lease, {'id', 'startedAt', 'expiresAt', 'candidateStartedAt', 'brokerStartedAt'})
                    or CAPTURE.point_id(lease['id']) != lease['id'] or type(lease['startedAt']) is not int
                    or type(lease['expiresAt']) is not int or lease['expiresAt'] - lease['startedAt'] != 900000
                    or not lease['startedAt'] <= now < lease['expiresAt']
                    or material != {key: lease[key] for key in ('candidateStartedAt', 'brokerStartedAt')}):
                raise fail()
            response = {'version': 1, 'transactionId': identifier, 'pointId': record['pointId'], 'nonce': record['nonce'],
                        'state': 'settled', 'decision': 'commit', 'binding': self.binding(record, include_snapshot=True),
                        'operationSha256': proof['operationSha256'], 'terminalProofSha256': proof_sha256,
                        'bootstrapLeaseId': lease['id'], 'expiresAt': lease['expiresAt']}
            if len(P.canonical(response)) > 512 * 1024:
                raise fail()
            return response

    def normal_bootstrap_complete(self, identifier, token, proof_sha256, lease_id):
        with self.operation(identifier):
            record = self.authenticate(identifier, token)
            if (record['phase'] != 'complete' or record['decision'] != 'commit' or record.get('terminalSettled') is not True
                    or record.get('normalBootstrapRequired') is not True):
                raise fail()
            proof = self.seal_terminal(record)
            lease = record.get('normalBootstrapLease')
            if (not P.exact(lease, {'id', 'startedAt', 'expiresAt', 'candidateStartedAt', 'brokerStartedAt'})
                    or lease['id'] != lease_id or CAPTURE.point_id(lease_id) != lease_id or proof['proofSha256'] != proof_sha256
                    or type(lease['startedAt']) is not int or type(lease['expiresAt']) is not int
                    or lease['expiresAt'] - lease['startedAt'] != 900000):
                raise fail()
            if not record.get('normalBootstrapReady'):
                if self.pending_identifier() != identifier or not lease['startedAt'] <= int(time.time() * 1000) < lease['expiresAt']:
                    raise fail()
                self.origin(record)
                evidence = self.runtime.normal_bootstrap_ready(record, proof, lease)
                if (not P.exact(evidence, {'nodeReceiptSha256', 'brokerAttestationSha256'})
                        or any(not hex64(value) for value in evidence.values()) or int(time.time() * 1000) >= lease['expiresAt']):
                    raise fail()
                record['normalBootstrapReceiptSha256'] = evidence['nodeReceiptSha256']
                record['normalBootstrapBrokerSha256'] = evidence['brokerAttestationSha256']
                record['normalBootstrapReady'] = True
                self.save(record)
            self.runtime.verify_normal_bootstrap_decision(record, proof)
            # Retry cleanup after the durable decision without rechecking later
            # user writes, including a lost reply after marker removal.
            if self.maintenance()['state'] == 'checking':
                self.runtime.finish_overlay(record)
            self.clear_marker(record)
            return {'version': 1, 'transactionId': identifier, 'state': 'ready', 'terminalProofSha256': proof_sha256}

    def normal_bootstrap_status(self, identifier, token, proof_sha256):
        with self.operation(identifier):
            record = self.authenticate(identifier, token)
            if record['phase'] not in TERMINAL:
                raise fail()
            proof = self.seal_terminal(record)
            if proof['proofSha256'] != proof_sha256:
                raise fail()
            required, ready = record.get('normalBootstrapRequired', False), record.get('normalBootstrapReady', False)
            if type(required) is not bool or type(ready) is not bool or ready and (not required or record['decision'] != 'commit'):
                raise fail()
            required = required and record['decision'] == 'commit'
            lease = record.get('normalBootstrapLease')
            lease_id = None
            if required and lease is not None:
                if not isinstance(lease, dict):
                    raise fail()
                lease_id = CAPTURE.point_id(lease.get('id'))
            if ready:
                if lease_id is None:
                    raise fail()
                self.runtime.verify_normal_bootstrap_decision(record, proof)
            return {'version': 1, 'transactionId': identifier, 'terminalProofSha256': proof_sha256,
                    'required': required, 'state': 'ready' if ready else 'pending' if required else 'not-required', 'bootstrapLeaseId': lease_id}

    def maintenance(self):
        path = marker_path(self.root)
        try:
            with self.authority.protected_directory(path.parent, private=False) as directory:
                with self.authority.protected_file(directory, path.name, 4096) as body:
                    marker = P.metadata(body)
            if not P.exact(marker, {'schema', 'id', 'root', 'context'}) or marker != {
                    'schema': SCHEMA, 'id': marker.get('id'), 'root': str(self.root), 'context': self.context}:
                raise fail()
            record = self.read(marker['id'])
            if record['phase'] in TERMINAL:
                # Only clear_marker, after independently checked terminal health,
                # releases the lock. A terminal journal alone cannot release it.
                return {'state': 'checking'}
            return {'state': 'recovery' if record['decision'] == 'rollback' or record.get('recoveryRequired') else 'restoring'}
        except FileNotFoundError:
            # A present marker with missing transaction data is damaged, not idle.
            return {'state': 'checking' if path.exists() or path.is_symlink() else 'idle'}
        except (OSError, ValueError, TypeError, KeyError):
            return {'state': 'checking'}

    def image_preflight(self, identifier, request):
        if (not P.exact(request, {'version', 'token', 'requiredBytes'}) or type(request['version']) is not int
                or request['version'] != 1 or type(request['requiredBytes']) is not int
                or not 0 < request['requiredBytes'] <= 2 ** 53 - 1 or not hex64(request['token'])):
            raise fail()
        with self.metadata_lock:
            self.require_running_operation(identifier)
            record = self.read(identifier)
            grant = record.get('grant')
            if (not grant or grant['status'] != 'running' or grant['phase'] != 'prepare' or record['decision'] is not None
                    or not secrets.compare_digest(grant['tokenSha256'], hashlib.sha256(request['token'].encode()).hexdigest())):
                raise fail()
            self.runtime.validate_worker(record)
            self.origin(record)
            return self.runtime.preflight_images(record, request['requiredBytes'])

    def phase_status(self, identifier, request):
        if (not P.exact(request, {'version', 'token', 'phase', 'sequence'}) or type(request['version']) is not int
                or request['version'] != 1 or type(request['sequence']) is not int or not hex64(request['token'])):
            raise fail()
        with self.metadata_lock:
            self.require_running_operation(identifier)
            record = self.read(identifier)
            grant = record.get('grant')
            if (not grant or grant['status'] != 'running' or grant['phase'] != request['phase'] or grant['sequence'] != request['sequence']
                    or not secrets.compare_digest(grant['tokenSha256'], hashlib.sha256(request['token'].encode()).hexdigest())):
                raise fail()
            self.runtime.validate_worker(record)
            self.origin(record)
            self.require_phase_state(record, grant['phase'], grant['commitStage'])
            return {**self.public(record), 'admissionSha256': record['stage']['sourceBinding']['admissionSha256'],
                    'binding': self.binding(record, include_snapshot=True)}
