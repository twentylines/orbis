#!/usr/bin/env python3
"""Durable progress responder for scoped controller updates on standard Traefik."""
import importlib.util
import json
import secrets
import time
from pathlib import Path


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DRIVER = load('orbis-host-retained-restore-runtime.py', 'orbis_driver_for_core_overlay')
SCHEMA = 'orbis.core-maintenance-overlay.v1'


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

    def begin(self, identifier, current, target):
        # The legacy full-core updater stops the reverse proxy itself. It cannot
        # keep this transport alive, so refuse it before accepting an operation.
        if target.get('installationProtocol') != self.host.PLAN.INSTALLATION_PROTOCOL:
            raise ValueError('This update path cannot preserve the operation screen during controller replacement')
        with self.host.host_lock(self.root):
            source = self.runtime.source_snapshot()
            if source['publication'] != current:
                raise ValueError('The current controller changed before progress preparation')
            try:
                record = self.read(identifier)
            except FileNotFoundError:
                record = dict(schema=SCHEMA, id=identifier, nonce=secrets.token_hex(32), root=str(self.root), context=self.context,
                              source=source, current=current, target=target, phase='allocating', decision=None)
                self.save(record)
            if (record['current'] != current or record['target'] != target or record['phase'] in {'complete', 'rolled-back'}
                    or record['source']['controllerId'] != source['controllerId'] or record['source']['definition'] != source['definition']):
                raise ValueError('Progress preparation changed; use protected recovery')
            self.ensure(record)
            record['phase'] = 'active'
            self.save(record)
        return identifier

    def resume(self, job):
        if job.get('overlayId') != job['id']:
            raise ValueError('This interrupted operation lacks protected progress routing')
        with self.host.host_lock(self.root):
            record = self.read(job['id'])
            if record['current'] != job['current'] or record['target'] != job['target']:
                raise ValueError('Core maintenance source changed')
            self.ensure(record)

    def finish(self, job):
        if job.get('overlayId') != job['id'] or job.get('state') not in {'complete', 'rolled-back', 'failed'}:
            raise ValueError('Core maintenance is still active')
        expected = job['target'] if job['state'] == 'complete' else job['current']
        with self.host.host_lock(self.root):
            if self.service.current_manifest() != expected:
                raise ValueError('The canonical controller is not the terminal publication')
            core = self.host.current_core(self.root, self.context)
            if core.get('state') != 'running' or core.get('health') != 'healthy':
                raise ValueError('The canonical controller is not healthy')
            record = self.read(job['id'])
            record.update(phase='complete' if job['state'] == 'complete' else 'rolled-back', decision='commit' if job['state'] == 'complete' else 'rollback')
            self.save(record)
            if record.get('responderId'):
                raw = self.runtime.inspect(record['responderId'])
                if self.runtime.definition(raw) != record['definitions']['responder']:
                    raise ValueError('The maintenance responder changed')
                self.runtime.change(['update', '--restart', 'no', raw['Id']])
                if raw['State'].get('Running'):
                    self.runtime.change(['stop', raw['Id']])
