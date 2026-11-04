#!/usr/bin/env python3
"""Review and retire one terminal update's retained maintenance responder.

This root-only recovery command requires approval of its exact read-only plan.
It preserves the original overlay record and creation seal. It never repairs
configuration, replaces a controller, or grants an HTTP caller reconciliation
authority.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
import re
import stat
import sys
import uuid
from pathlib import Path


SPEC = importlib.util.spec_from_file_location('orbis_service_for_terminal_retirement', Path(__file__).with_name('orbis-host-service.py'))
SERVICE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVICE)
SCHEMA = 'orbis.core-maintenance-retirement.v1'
PLAN_KEYS = {'version', 'jobId', 'root', 'context', 'rootIdentity', 'jobSha256', 'overlaySha256', 'responderId',
             'imageId', 'startedAt', 'storedDefinition', 'approvedDefinition', 'intentSha256', 'daemonId'}


def fail():
    return ValueError('The terminal maintenance responder needs independent recovery review')


def digest(publication, value):
    return hashlib.sha256(publication.canonical(value)).hexdigest()


def publication(value):
    return {key: item for key, item in value.items() if key != 'installationProtocol'}


class Retirement:
    def __init__(self, service):
        self.service = service
        self.overlay = service.core_overlays()
        self.runtime, self.P = self.overlay.runtime, self.overlay.P

    def directory(self, identifier):
        if str(uuid.UUID(identifier)) != identifier or uuid.UUID(identifier).version != 4:
            raise fail()
        return self.service.state_dir / 'core-overlays' / identifier

    def receipt(self, identifier):
        directory = self.directory(identifier)
        try:
            with self.overlay.authority.protected_directory(directory) as parent:
                with self.overlay.authority.protected_file(parent, 'retirement.json', 16384) as body:
                    value = self.P.metadata(body, byte_limit=16384)
        except FileNotFoundError:
            return None
        if (not self.P.exact(value, {'schema', 'phase', 'plan', 'planSha256'}) or value['schema'] != SCHEMA
                or value['phase'] not in {'approved', 'complete'} or not self.P.exact(value['plan'], PLAN_KEYS)
                or type(value['plan']['version']) is not int or value['plan']['version'] != 1
                or digest(self.P, value['plan']) != value['planSha256']):
            raise fail()
        return value

    def review(self, identifier, receipt=None):
        job = SERVICE.read_private(self.service.job_file)
        if (not job or job.get('schema') != 'orbis.host-service-job.v1'
                or job.get('id') != identifier or job.get('overlayId') != identifier
                or job.get('state') not in {'complete', 'rolled-back', 'failed'}):
            raise fail()
        self.service.require_restart_clear()
        self.service.require_package_clear()
        if self.service.maintenance_file.exists() or self.service.maintenance_file.is_symlink():
            raise fail()
        expected = job['target'] if job['state'] == 'complete' else job['current']
        if publication(self.service.current_manifest()) != publication(expected):
            raise fail()
        core = self.service.HOST.current_core(self.service.root, self.service.context)
        if (core.get('state') != 'running' or core.get('health') != 'healthy'
                or core.get('image') != self.service.HOST.controller_reference(self.service.root, expected, self.service.context)):
            raise fail()
        main = self.runtime.inspect('runtipi')
        if main.get('Name') != '/runtipi' or main.get('Config', {}).get('Image') != core['image']:
            raise fail()
        operation = self.runtime.bounded_output([
            'docker', '--context', self.service.context, 'exec', main['Id'], 'node', '--input-type=module', '-e',
            "const r=await fetch('http://127.0.0.1:3000/api/system/operation-status',{signal:AbortSignal.timeout(2000)});if(!r.ok)process.exit(2);process.stdout.write(await r.text());"
        ], 1024, 5)
        if self.P.metadata(operation, byte_limit=1024) != {'state': 'idle'}:
            raise fail()
        record = self.overlay.read(identifier)
        if record['current'] != job['current'] or record['target'] != job['target']:
            raise fail()
        raw = self.runtime.inspect(record['responderId'])
        intent = record['intents']['responder']
        labels = raw['Config'].get('Labels') or {}
        if (raw['Id'] != record['responderId'] or raw['Name'] != '/' + intent['name']
                or intent['name'] != 'orbis-retained-' + identifier + '-responder'
                or raw['Image'] != record['source']['imageId']
                or labels.get('io.orbis.restore') != identifier or labels.get('io.orbis.restore.nonce') != record['nonce']
                or labels.get('io.orbis.restore.role') != 'responder'
                or raw['State'].get('Restarting') or raw['State'].get('Paused')
                or type(raw['State'].get('Running')) is not bool):
            raise fail()
        body = copy.deepcopy(intent['body'])
        policy = raw['HostConfig'].get('RestartPolicy')
        # A previous guarded stop may have disabled restart before crashing.
        if policy == {'Name': 'no', 'MaximumRetryCount': 0}:
            body['HostConfig']['RestartPolicy'] = policy
        self.runtime.check_intent(raw, body)
        observed = self.runtime.definition(raw)
        stored = record['definitions']['responder']
        started = raw['State'].get('StartedAt')
        if (any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value) for value in (observed, stored))
                or not isinstance(started, str) or not 1 <= len(started) <= 64):
            raise fail()
        daemon = self.runtime.reader._object(['info', '--format', '{{json .}}'])
        if daemon.get('ID') != record['source']['daemonId']:
            raise fail()
        binding = {key: job[key] for key in ('schema', 'id', 'state', 'current', 'target', 'overlayId')}
        root = self.service.root.lstat()
        if not stat.S_ISDIR(root.st_mode) or self.service.root.resolve(strict=True) != self.service.root:
            raise fail()
        plan = {'version': 1, 'jobId': identifier, 'root': str(self.service.root), 'context': self.service.context,
                'rootIdentity': {'device': str(root.st_dev), 'inode': str(root.st_ino), 'uid': root.st_uid,
                                 'gid': root.st_gid, 'mode': stat.S_IMODE(root.st_mode)},
                'jobSha256': digest(self.P, binding), 'overlaySha256': digest(self.P, record),
                'responderId': raw['Id'], 'imageId': raw['Image'], 'startedAt': started,
                'storedDefinition': stored, 'approvedDefinition': observed,
                'intentSha256': digest(self.P, intent), 'daemonId': daemon['ID']}
        if receipt is not None and plan != receipt['plan']:
            raise fail()
        return plan, raw

    def apply(self, identifier, confirmation):
        if self.service.HOST.LOCK_DESCRIPTOR.get() is None:
            raise ValueError('Terminal responder retirement requires the host operation lock')
        receipt = self.receipt(identifier)
        plan, raw = self.review(identifier, receipt)
        approved = digest(self.P, plan)
        if confirmation != approved:
            raise ValueError('Approve the exact retirement plan before stopping its responder')
        target = self.directory(identifier) / 'retirement.json'
        if receipt is None:
            receipt = {'schema': SCHEMA, 'phase': 'approved', 'plan': plan, 'planSha256': approved}
            self.overlay.authority.atomic(target, self.P.canonical(receipt))
        if receipt['phase'] == 'complete':
            if raw['State']['Running'] or raw['HostConfig']['RestartPolicy'] != {'Name': 'no', 'MaximumRetryCount': 0}:
                raise fail()
            return receipt
        self.runtime.change(['update', '--restart', 'no', plan['responderId']])
        if raw['State']['Running']:
            self.runtime.change(['stop', plan['responderId']])
        _, stopped = self.review(identifier, receipt)
        if stopped['State']['Running'] or stopped['HostConfig']['RestartPolicy'] != {'Name': 'no', 'MaximumRetryCount': 0}:
            raise fail()
        receipt = {**receipt, 'phase': 'complete'}
        self.overlay.authority.atomic(target, self.P.canonical(receipt))
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['plan', 'apply'])
    parser.add_argument('root', type=Path)
    parser.add_argument('--docker-context', required=True)
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--confirm-plan')
    args = parser.parse_args()
    if os.geteuid() != 0 or sys.platform != 'linux':
        raise ValueError('Run retirement review as root on the selected Linux Docker host')
    root = args.root.resolve(strict=True)
    with SERVICE.HOST.host_lock(root):
        job = SERVICE.read_private(Path('/var/lib/orbis/state/job.json'))
        if (not job or job.get('id') != args.job_id or job.get('state') not in {'complete', 'rolled-back', 'failed'}):
            raise fail()
        service = SERVICE.HostService(root, args.docker_context, Path('/var/lib/orbis/snapshots'), Path('/var/lib/orbis/state'))
        retirement = Retirement(service)
        if args.action == 'apply':
            value = retirement.apply(args.job_id, args.confirm_plan)
            result = {'schema': SCHEMA, 'jobId': args.job_id, 'phase': value['phase'], 'planSha256': value['planSha256']}
        else:
            plan, _ = retirement.review(args.job_id, retirement.receipt(args.job_id))
            result = {'schema': SCHEMA, 'plan': plan, 'planSha256': digest(retirement.P, plan), 'readOnly': True}
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
