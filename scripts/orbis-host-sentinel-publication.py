#!/usr/bin/env python3
"""Root publication of captured data; never releases a source or host hold."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import threading
from types import SimpleNamespace


SPEC = importlib.util.spec_from_file_location('sentinel_publication_host', Path(__file__).with_name('orbis-host-core-capture-service.py'))
S = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(S)
W = S.W
PUBLICATION_CAPABILITY = {
    'schema': 'orbis-sentinel.capture-publication.v1', 'version': 1,
    'operations': ['publish'], 'pointVersion': 3,
    'publicationSchema': 'orbis.core-capture-catalog-publication.v1',
    'lifecycleAuthority': False, 'incompleteReplay': 'forbidden',
}


def publish_completed(manager, point):
    W.require_root()
    W.identifier(point)
    completion = S.COMPLETION.CoreCaptureCompletion(manager, W)
    with manager.service.lock:
        admission = W.Admission(manager.state, point)
        if admission.root != manager.root or admission.context != manager.context or admission.state != manager.state:
            raise W.AdmissionError('The Sentinel publication belongs to another installation')
        with admission.lease.owner(), W.CORE.HOST.host_lock(manager.root):
            preparation, reservation, acceptance, hold_body = completion.bound_preparation(admission)
            profile = manager.sentinel.require_publication_reserved(point, preparation)
            if profile is None:
                raise W.AdmissionError('This capture has no independent Sentinel custody')
            if manager.sentinel._invoke(profile, 'publication-capability') != PUBLICATION_CAPABILITY:
                raise W.AdmissionError('The enrolled Sentinel cannot publish this capture')
            terminal = W.SUPERVISOR.read_terminal(admission, worker=W.worker_context())
            if (not isinstance(terminal, dict) or terminal.get('state') != 'quiescent'
                    or terminal.get('workerQuiescent') is not True or type(terminal.get('workerExitCode')) is not int
                    or terminal['workerExitCode'] != 0):
                raise W.AdmissionError('Publication needs a successful independent terminal witness')
            terminal_body = admission.read('worker-terminal.json')[1]
            status = W.read_status(manager.state, point)
            if status.get('state') != 'resumed-awaiting-publication' or not isinstance(status.get('artifact'), dict):
                raise W.AdmissionError('The capture has no verified portable checkpoint')
            artifact = status['artifact']
            settled_body = admission.read('settled.json')[1]
            expected = {'pointId': point, 'sourceSha256': admission.request['sourceSha256'],
                        'checkpointSha256': artifact['checkpointSha256'], 'captureReceiptSha256': W.digest(settled_body),
                        'checkpoint': artifact['checkpoint'], 'resourceCount': artifact['resourceCount'],
                        'images': artifact['roleImageIds'], 'compatibility': artifact['compatibility']}
            request = {'schema': 'orbis-sentinel.capture-publish.v1', 'catalogDirectory': profile['catalogDirectory'],
                       'pointId': point, 'expectation': expected, 'preparationSha256': W.digest(W.P.canonical(preparation)),
                       'sourceHoldSha256': acceptance['sourceHoldSha256'], 'terminalSha256': W.digest(terminal_body)}
            checkpoint = manager.state / 'time-machine-core' / point / 'portable-checkpoint'
            with W.A.protected_directory(checkpoint) as directory:
                fd = os.open('checkpoint.tar', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
                try:
                    before = os.fstat(fd)
                    if (not stat.S_ISREG(before.st_mode) or before.st_uid != W.A.OWNER or before.st_nlink != 1
                            or stat.S_IMODE(before.st_mode) != 0o600 or before.st_size != expected['checkpoint']['bytes']):
                        raise W.AdmissionError('The approved checkpoint is not a private regular file')
                    reply = manager.sentinel._invoke(profile, 'publish', request, fd)
                    if (W.A.seal(os.fstat(fd)) != W.A.seal(before)
                            or W.A.seal(os.stat('checkpoint.tar', dir_fd=directory, follow_symlinks=False)) != W.A.seal(before)):
                        raise W.AdmissionError('The approved checkpoint changed during publication')
                finally:
                    os.close(fd)
            result = reply.get('result') if isinstance(reply, dict) else None
            if (not isinstance(reply, dict) or set(reply) != {'schema', 'operation', 'result'}
                    or reply['schema'] != 'orbis-sentinel.capture-custody-result.v1' or reply['operation'] != 'publish'
                    or not isinstance(result, dict) or set(result) != {'schema', 'id', 'dataState', 'lifecycleState',
                        'preparationSha256', 'sourceHoldSha256', 'terminalSha256', 'publication'}
                    or result['schema'] != 'orbis-sentinel.prepared-publication.v1' or result['id'] != point
                    or result['dataState'] != 'verified' or result['lifecycleState'] != 'unobserved'
                    or any(result[key] != request[key] for key in ('preparationSha256', 'sourceHoldSha256', 'terminalSha256'))
                    or not isinstance(result.get('publication'), dict)
                    or set(result['publication']) != {'schema', 'core', 'keyId', 'files'}
                    or result['publication']['schema'] != 'orbis.core-capture-catalog-publication.v1'
                    or result['publication']['keyId'] != reservation['envelope']['keyId']):
                raise W.AdmissionError('Sentinel published a different capture')
            core = completion.validate_publication(admission, result['publication']['core'], expected, reservation)
            files = result['publication']['files']
            if (not isinstance(files, dict) or not {'point.json', 'metadata.orbis', 'core.orbis', 'capture-draft.orbis'} <= set(files)
                    or not set(files) <= {'point.json', 'metadata.orbis', 'core.orbis', 'capture-draft.orbis', 'wallpaper.orbis', 'icons.orbis'}):
                raise W.AdmissionError('The independent point inventory is invalid')
            for name, item in files.items():
                if (not isinstance(item, dict) or set(item) != {'bytes', 'sha256'} or type(item['bytes']) is not int
                        or not 1 <= item['bytes'] <= 68719476736 or not isinstance(item['sha256'], str) or not W.HASH.fullmatch(item['sha256'])):
                    raise W.AdmissionError('The independent point inventory is invalid')
            if (files['point.json']['sha256'] != core['pointSha256'] or files['metadata.orbis']['sha256'] != core['metadataSha256']
                    or files['core.orbis'] != {'bytes': core['cipherBytes'], 'sha256': core['cipherSha256']}):
                raise W.AdmissionError('The independent point inventory differs from its verification')
            if (completion.bound_preparation(admission) != (preparation, reservation, acceptance, hold_body)
                    or W.SUPERVISOR.read_terminal(admission, worker=W.worker_context()) != terminal
                    or admission.read('worker-terminal.json')[1] != terminal_body
                    or W.read_status(manager.state, point) != status
                    or manager.sentinel.require_publication_reserved(point, preparation) != profile):
                raise W.AdmissionError('The capture authority changed during Sentinel publication')
            proof = admission.event('sentinel-publication', publication=result,
                                     profileSha256=W.digest(W.P.canonical(profile)))
            existing, _ = admission.read('sentinel-publication.json', optional=True)
            if existing is None:
                admission.create('sentinel-publication.json', proof)
            elif W.P.canonical(existing) != W.P.canonical(proof):
                raise W.AdmissionError('The earlier Sentinel publication differs')
            admission.unchanged()
            return {'version': 1, 'id': point, 'state': 'verified-data-awaiting-continuation',
                    'publicationSha256': W.digest(W.P.canonical(proof)), 'lifecycleComplete': False}


def main():
    parser = argparse.ArgumentParser(description='Publish independently retained capture data without releasing holds')
    parser.add_argument('--state-directory', required=True)
    parser.add_argument('--point', required=True)
    args = parser.parse_args()
    try:
        admission = W.Admission(Path(args.state_directory), args.point)
        service = SimpleNamespace(root=admission.root, state_dir=admission.state, snapshots=admission.snapshots,
                                  context=admission.context, lock=threading.RLock())
        manager = S.CoreCaptureService(service)
        print(json.dumps(publish_completed(manager, args.point), separators=(',', ':')))
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        print('Capture publication needs review. Existing capture data and holds were kept.')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
