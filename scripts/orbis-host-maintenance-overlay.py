#!/usr/bin/env python3
"""Durable progress responder for scoped controller updates on standard Traefik."""
import importlib.util
import hashlib
import json
import os
import secrets
import stat
import time
from pathlib import Path


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DRIVER = load('orbis-host-retained-restore-runtime.py', 'orbis_driver_for_core_overlay')
SCHEMA = 'orbis.core-maintenance-overlay.v1'
ACCEPTANCE = 'orbis.core-maintenance-acceptance.v1'


class CoreOverlay:
    def __init__(self, service):
        self.service, self.host = service, service.HOST
        self.root, self.context, self.state = service.root, service.context, service.state_dir
        self.authority = self.host.AUTHORITY
        self.P = self.host.IDENTITY.PUBLICATION
        self.runtime = DRIVER.DockerRestoreRuntime(self)

    def directory(self, identifier):
        import uuid
        if str(uuid.UUID(identifier)) != identifier or uuid.UUID(identifier).version != 4:
            raise ValueError('Core maintenance identity is invalid')
        with self.authority.protected_directory(self.state):
            pass
        base = self.state / 'core-overlays'
        base.mkdir(mode=0o700, exist_ok=True)
        with self.authority.protected_directory(base):
            pass
        path = base / identifier
        path.mkdir(mode=0o700, exist_ok=True)
        with self.authority.protected_directory(path):
            pass
        return path

    def save(self, record):
        self.authority.atomic(self.directory(record['id']) / 'overlay.json', self.P.canonical(record))

    def read(self, identifier):
        with self.authority.protected_directory(self.directory(identifier)) as directory:
            with self.authority.protected_file(directory, 'overlay.json', 16 * 1024 * 1024) as body:
                record = self.P.metadata(body, byte_limit=16 * 1024 * 1024, string_limit=2 * 1024 * 1024)
        if (record.get('schema') != SCHEMA or record.get('id') != identifier or record.get('root') != str(self.root)
                or record.get('context') != self.context):
            raise ValueError('Core maintenance requires protected recovery')
        return record

    def ensure(self, record):
        self.runtime.quiesce_owned(record)
        if not record.get('responderId'):
            self.runtime.prepare_overlay(record)
            return
        raw = self.runtime.inspect(record['responderId'])
        if not raw['State'].get('Running'):
            self.runtime.change(['start', raw['Id']])
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                self.runtime.validate_overlay(record)
                return
            except (ValueError, RuntimeError):
                time.sleep(0.5)
        raise ValueError('Core progress routing could not be verified')

    def receipt(self, record):
        with self.authority.protected_directory(self.directory(record['id'])) as directory:
            with self.authority.protected_file(directory, 'acceptance.json', 16384) as body:
                receipt = self.P.metadata(body, byte_limit=16384)
        binding = self.acceptance_binding(record)
        if (set(receipt) != {*binding, 'phase', 'retirement'}
                or any(receipt.get(key) != value for key, value in binding.items())
                or receipt.get('phase') not in {'allocating', 'accepted', 'abort-approved', 'aborted'}):
            raise ValueError('Core progress acceptance requires protected recovery')
        return receipt

    def acceptance_binding(self, record):
        return {'schema': ACCEPTANCE, 'id': record['id'], 'root': str(self.root), 'context': self.context,
                'nonce': record['nonce'], 'sourceSha256': hashlib.sha256(self.P.canonical(record['source'])).hexdigest(),
                'current': record['current'], 'target': record['target']}

    def save_receipt(self, record, receipt):
        self.authority.atomic(self.directory(record['id']) / 'acceptance.json', self.P.canonical(receipt))

    def accepted_job(self, record):
        try:
            with self.authority.protected_directory(self.service.job_file.parent) as directory:
                with self.authority.protected_file(directory, self.service.job_file.name, 1024 * 1024) as body:
                    job = self.P.metadata(body, byte_limit=1024 * 1024)
        except FileNotFoundError:
            return False
        if job.get('id') != record['id'] and job.get('overlayId') != record['id']:
            return False
        if (job.get('schema') != 'orbis.host-service-job.v1' or job.get('id') != record['id']
                or job.get('overlayId') != record['id'] or job.get('current') != record['current']
                or job.get('target') != record['target']
                or job.get('snapshot') != str(self.service.snapshots / ('orbis-' + record['target']['tag'] + '-' + record['id']))):
            raise ValueError('Core progress job acceptance changed')
        return True

    def unchanged_source(self, record):
        source = record['source']
        raw = self.runtime.inspect(source['controllerId'])
        if (self.service.current_manifest() != record['current'] or raw.get('Name') != '/runtipi'
                or raw.get('Id') != source['controllerId'] or self.runtime.definition(raw) != source['definition']
                or raw.get('Image') != source['imageId'] or raw['State'].get('Running') is not True
                or raw['State'].get('Restarting') or raw['State'].get('Paused')
                or raw['State'].get('StartedAt') != source['container']['State']['StartedAt']
                or raw['HostConfig'].get('RestartPolicy') != source['container']['HostConfig'].get('RestartPolicy')
                or (raw['State'].get('Health') or {}).get('Status') != 'healthy'):
            raise ValueError('The original controller changed before progress acceptance')

    def ready(self, identifier):
        with self.host.host_lock(self.root):
            record = self.read(identifier)
            if self.receipt(record)['phase'] != 'allocating' or self.accepted_job(record):
                raise ValueError('Core progress acceptance changed')
            self.unchanged_source(record)
            self.runtime.live_docker_sockets(allow_stale_controller=True)
            self.runtime.validate_overlay(record)

    def accept(self, job):
        with self.host.host_lock(self.root):
            record = self.read(job['id'])
            receipt = self.receipt(record)
            if receipt['phase'] not in {'allocating', 'accepted'} or not self.accepted_job(record):
                raise ValueError('Core progress has no durable accepted job')
            receipt['phase'] = 'accepted'
            self.save_receipt(record, receipt)

    def reconcile_unaccepted(self):
        with self.host.host_lock(self.root):
            base = self.state / 'core-overlays'
            try:
                with self.authority.protected_directory(base) as directory:
                    names = os.listdir(directory)
            except FileNotFoundError:
                return
            if len(names) > 4096:
                raise ValueError('Core progress acceptance inventory requires protected recovery')
            for identifier in sorted(names):
                try:
                    with self.authority.protected_directory(base / identifier) as directory:
                        with self.authority.protected_file(directory, 'acceptance.json', 16384):
                            pass
                except FileNotFoundError:
                    continue
                record = self.read(identifier)
                receipt = self.receipt(record)
                if receipt['phase'] in {'accepted', 'aborted'}:
                    continue
                if self.accepted_job(record):
                    receipt['phase'] = 'accepted'
                    self.save_receipt(record, receipt)
                else:
                    self.abort_locked(record)

    def abort(self, identifier):
        with self.host.host_lock(self.root):
            return self.abort_locked(self.read(identifier))

    def abort_locked(self, record):
        receipt = self.receipt(record)
        if receipt['phase'] == 'accepted' or self.accepted_job(record):
            raise ValueError('An accepted core operation requires normal recovery')
        self.unchanged_source(record)
        if record.get('phase') not in {'allocating', 'active'} or record.get('decision') is not None:
            raise ValueError('Core progress has entered normal recovery')
        snapshot = self.service.snapshots / ('orbis-' + record['target']['tag'] + '-' + record['id'])
        journal = snapshot.with_name(snapshot.name + '.orbis-update.json')
        if snapshot.exists() or snapshot.is_symlink() or journal.exists() or journal.is_symlink():
            raise ValueError('Core progress has an update checkpoint requiring recovery')
        if set(record.get('intents', {})) - {'responder'} or any(record.get(key) for key in ('workerId', 'candidateId', 'verifierId')):
            raise ValueError('Core progress owns additional recovery workers')
        if receipt['phase'] == 'allocating':
            # The existing intent reconciler handles a lost create reply and
            # refuses a changed saved definition. No failed seal is replaced.
            self.runtime.quiesce_owned(record)
        identifier = record.get('responderId')
        if not identifier:
            if record.get('intents'):
                intent = record['intents']['responder']
                if intent.get('name') != 'orbis-retained-' + record['id'] + '-responder':
                    raise ValueError('Core responder creation intent changed')
                found = self.runtime.reader._read(['container', 'ls', '--all', '--no-trunc', '--filter',
                    'name=^/' + intent['name'] + '$', '--format', '{{.ID}}']).splitlines()
                if found:
                    raise ValueError('Core responder allocation requires recovery')
            receipt.update(phase='aborted', retirement=None)
            self.save_receipt(record, receipt)
            return
        raw = self.runtime.inspect(identifier)
        intent = record.get('intents', {}).get('responder') or {}
        expected = {'overlaySha256': hashlib.sha256(self.P.canonical(record)).hexdigest(), 'responderId': identifier,
                    'definitionSha256': record.get('definitions', {}).get('responder'),
                    'intentSha256': hashlib.sha256(self.P.canonical(intent)).hexdigest()}
        if (raw.get('Id') != identifier or raw.get('Name') != '/' + intent.get('name', '')
                or raw.get('Image') != record['source']['imageId']
                or self.runtime.definition(raw) != expected['definitionSha256']
                or intent.get('name') != 'orbis-retained-' + record['id'] + '-responder'):
            raise ValueError('Core responder does not match its protected intent')
        self.runtime.verify_networks(record, raw)
        body = json.loads(json.dumps(intent['body']))
        policy = raw['HostConfig'].get('RestartPolicy')
        if policy not in (body['HostConfig']['RestartPolicy'], {'Name': 'no', 'MaximumRetryCount': 0}):
            raise ValueError('Core responder restart ownership changed')
        body['HostConfig']['RestartPolicy'] = policy
        self.runtime.check_intent(raw, body)
        if receipt['phase'] != 'allocating' and receipt['retirement'] != expected:
            raise ValueError('Core responder abort approval changed')
        receipt.update(phase='abort-approved', retirement=expected)
        self.save_receipt(record, receipt)
        for arguments in (['update', '--restart', 'no', identifier], ['stop', identifier]):
            self.unchanged_source(record)
            try:
                self.runtime.change(arguments)
            except RuntimeError:
                observed = self.runtime.inspect(identifier)
                if (arguments[0] == 'update' and observed['HostConfig'].get('RestartPolicy') != {'Name': 'no', 'MaximumRetryCount': 0}
                        or arguments[0] == 'stop' and observed['State'].get('Running') is not False):
                    raise
        stopped = self.runtime.inspect(identifier)
        if (self.runtime.definition(stopped) != expected['definitionSha256'] or stopped['State'].get('Running') is not False
                or stopped['State'].get('Restarting') or stopped['State'].get('Paused')
                or stopped['HostConfig'].get('RestartPolicy') != {'Name': 'no', 'MaximumRetryCount': 0}):
            raise ValueError('Core responder abort is not settled')
        receipt['phase'] = 'aborted'
        self.save_receipt(record, receipt)

    def begin(self, identifier, current, target):
        # The legacy full-core updater stops the reverse proxy itself. It cannot
        # keep this transport alive, so refuse it before accepting an operation.
        if target.get('installationProtocol') != self.host.PLAN.INSTALLATION_PROTOCOL:
            raise ValueError('This update path cannot preserve the operation screen during controller replacement')
        with self.host.host_lock(self.root):
            self.runtime.live_docker_sockets(allow_stale_controller=True)
            source = self.runtime.source_snapshot(policy="controller-overlay.v1")
            if source['publication'] != current:
                raise ValueError('The current controller changed before progress preparation')
            try:
                record = self.read(identifier)
            except FileNotFoundError:
                record = dict(schema=SCHEMA, id=identifier, nonce=secrets.token_hex(32), root=str(self.root), context=self.context,
                              source=source, current=current, target=target, phase='allocating', decision=None)
                self.save(record)
                self.save_receipt(record, {**self.acceptance_binding(record), 'phase': 'allocating', 'retirement': None})
            receipt = self.receipt(record)
            if receipt['phase'] in {'abort-approved', 'aborted'}:
                self.abort_locked(record)
                raise ValueError('This progress preparation was aborted; create a new update plan')
            if (record['current'] != current or record['target'] != target or record['phase'] in {'complete', 'rolled-back'}
                    or record['source'] != source):
                raise ValueError('Progress preparation changed; use protected recovery')
            try:
                self.ensure(record)
                record['phase'] = 'active'
                self.save(record)
            except Exception:
                try:
                    self.abort_locked(self.read(identifier))
                except Exception:
                    pass
                raise
        return identifier

    def resume(self, job):
        if job.get('overlayId') != job['id']:
            raise ValueError('This interrupted operation lacks protected progress routing')
        with self.host.host_lock(self.root):
            record = self.read(job['id'])
            if record['current'] != job['current'] or record['target'] != job['target']:
                raise ValueError('Core maintenance source changed')
            try:
                receipt = self.receipt(record)
            except FileNotFoundError:
                receipt = None
            if receipt is not None:
                if receipt['phase'] not in {'allocating', 'accepted'} or not self.accepted_job(record):
                    raise ValueError('Core progress requires its durable accepted job')
                receipt['phase'] = 'accepted'
                self.save_receipt(record, receipt)
            self.ensure(record)

    def finish(self, job):
        if job.get('overlayId') != job['id'] or job.get('state') not in {'complete', 'rolled-back', 'failed'}:
            raise ValueError('Core maintenance is still active')
        expected = job['target'] if job['state'] == 'complete' else job['current']
        with self.host.host_lock(self.root):
            installed = self.service.current_manifest()
            if {key: value for key, value in installed.items() if key != 'installationProtocol'} != {
                    key: value for key, value in expected.items() if key != 'installationProtocol'}:
                raise ValueError('The canonical controller is not the terminal publication')
            core = self.host.current_core(self.root, self.context)
            if core.get('state') != 'running' or core.get('health') != 'healthy':
                raise ValueError('The canonical controller is not healthy')
            record = self.read(job['id'])
            if record['current'] != job['current'] or record['target'] != job['target']:
                raise ValueError('Core maintenance source changed')
            if record.get('responderId'):
                raw = self.runtime.inspect(record['responderId'])
                if self.runtime.definition(raw) != record['definitions']['responder']:
                    raise ValueError('The maintenance responder changed')
                self.runtime.change(['update', '--restart', 'no', raw['Id']])
                if raw['State'].get('Running'):
                    self.runtime.change(['stop', raw['Id']])
                stopped = self.runtime.inspect(record['responderId'])
                if (self.runtime.definition(stopped) != record['definitions']['responder']
                        or stopped['State'].get('Running') is not False
                        or stopped['HostConfig'].get('RestartPolicy') != {'Name': 'no', 'MaximumRetryCount': 0}):
                    raise ValueError('The maintenance responder has not stopped safely')
            record.update(phase='complete' if job['state'] == 'complete' else 'rolled-back', decision='commit' if job['state'] == 'complete' else 'rollback')
            self.save(record)

    def settled(self, job):
        if job.get('overlayId') != job['id'] or job.get('state') not in {'complete', 'rolled-back', 'failed'}:
            return False
        record = self.read(job['id'])
        if record['current'] != job['current'] or record['target'] != job['target']:
            return False
        if self.reviewed_retirement(job, record):
            return True
        if (record.get('phase') != ('complete' if job['state'] == 'complete' else 'rolled-back')
                or record.get('decision') != ('commit' if job['state'] == 'complete' else 'rollback')):
            return False
        if not record.get('responderId'):
            return True
        raw = self.runtime.inspect(record['responderId'])
        return (self.runtime.definition(raw) == record['definitions']['responder']
                and raw['State'].get('Running') is False
                and raw['HostConfig'].get('RestartPolicy') == {'Name': 'no', 'MaximumRetryCount': 0})

    def reviewed_retirement(self, job, record):
        import hashlib
        def digest(value):
            return hashlib.sha256(self.P.canonical(value)).hexdigest()
        try:
            with self.authority.protected_directory(self.directory(job['id'])) as directory:
                with self.authority.protected_file(directory, 'retirement.json', 16384) as body:
                    receipt = self.P.metadata(body, byte_limit=16384)
        except FileNotFoundError:
            return False
        if (not self.P.exact(receipt, {'schema', 'phase', 'plan', 'planSha256'})
                or receipt['schema'] != 'orbis.core-maintenance-retirement.v1'
                or receipt['phase'] not in {'approved', 'complete'}
                or not self.P.exact(receipt['plan'], {'version', 'jobId', 'root', 'context', 'rootIdentity', 'jobSha256',
                    'overlaySha256', 'responderId', 'imageId', 'startedAt', 'storedDefinition', 'approvedDefinition', 'intentSha256', 'daemonId'})
                or type(receipt['plan']['version']) is not int or receipt['plan']['version'] != 1
                or digest(receipt['plan']) != receipt['planSha256']):
            raise ValueError('Terminal responder retirement needs recovery review')
        if receipt['phase'] != 'complete':
            return False
        plan = receipt['plan']
        binding = {key: job[key] for key in ('schema', 'id', 'state', 'current', 'target', 'overlayId')}
        root = self.root.lstat()
        identity = {'device': str(root.st_dev), 'inode': str(root.st_ino), 'uid': root.st_uid,
                    'gid': root.st_gid, 'mode': stat.S_IMODE(root.st_mode)}
        if (plan.get('version') != 1 or plan.get('jobId') != job['id'] or plan.get('root') != str(self.root)
                or plan.get('context') != self.context or plan.get('rootIdentity') != identity
                or plan.get('jobSha256') != digest(binding) or plan.get('overlaySha256') != digest(record)
                or plan.get('responderId') != record.get('responderId') or plan.get('imageId') != record['source']['imageId']
                or plan.get('daemonId') != record['source']['daemonId']
                or plan.get('storedDefinition') != record['definitions']['responder']
                or plan.get('intentSha256') != digest(record['intents']['responder'])):
            return False
        raw = self.runtime.inspect(plan['responderId'])
        return (raw['Id'] == plan['responderId'] and raw['Image'] == plan['imageId']
                and self.runtime.definition(raw) == plan.get('approvedDefinition')
                and raw['State'].get('StartedAt') == plan.get('startedAt') and raw['State'].get('Running') is False
                and raw['HostConfig'].get('RestartPolicy') == {'Name': 'no', 'MaximumRetryCount': 0})
