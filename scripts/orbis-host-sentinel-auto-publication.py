#!/usr/bin/env python3
"""Request the preselected Sentinel publication once after the worker witness."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import time
from types import SimpleNamespace


DEADLINE = 4 * 60 * 60 + 120
LIMIT = 8192


def _source_hash(worker, path):
    with worker.A.protected_directory(path.parent, private=False) as directory:
        with worker.A.protected_file(directory, path.name, 2 * 1024 * 1024, private=False) as body:
            return worker.digest(body)


def _selected(worker, admission):
    directory = admission.state / 'core-capture-preparations' / admission.point
    try:
        with worker.A.protected_directory(directory) as parent:
            try:
                os.stat('sentinel-custody.json', dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                try:
                    os.stat('sentinel-image-preflight.json', dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    return False
                raise worker.AdmissionError('Orphan Sentinel preflight')
    except FileNotFoundError:
        return False
    sentinel = worker.load('orbis-host-sentinel-capture.py', 'auto_publication_selection')
    manager = SimpleNamespace(state=admission.state, directory=lambda point: directory)
    custody = sentinel.SentinelCaptureCustody(manager, worker, None)
    def read_record(name):
        with worker.A.protected_directory(directory) as parent:
            with worker.A.protected_file(parent, name, 65536) as body:
                value = worker.P.metadata(body, byte_limit=65536)
                if not isinstance(value, dict) or worker.P.canonical(value) != body:
                    raise worker.AdmissionError('Invalid preparation record')
                return value, body
    preparation, preparation_body = read_record('preparation.json')
    reserved = admission.request['schema'] == 'orbis.core-capture-admission.v2'
    keys = {'schema', 'id', 'root', 'context', 'scope', 'sourceSha256', 'controller', 'pointReservationSha256'}
    if reserved:
        keys |= worker.RESERVED.EXTRA
    if (set(preparation) != keys
            or preparation['schema'] != ('orbis.core-capture-preparation.v3' if reserved else 'orbis.core-capture-preparation.v2')
            or any(preparation[k] != admission.request[k] for k in ('id', 'root', 'context', 'sourceSha256'))
            or preparation['scope'] != worker.CORE.SCOPE or preparation['controller'] != admission.handoff['controller']
            or (reserved and (admission.reservation is None or admission.reservation.body != worker.P.canonical(preparation)))):
        raise worker.AdmissionError('Sentinel preparation differs from admission')
    reservation, reservation_body = read_record('point-reservation.json')
    worker.load('orbis-host-core-capture-reservation.py', 'auto_publication_reservation').validate_reservation(
        reservation, admission.point)
    acceptance, _ = admission.read('acceptance.json')
    hold, hold_body = admission.read('source-hold.json')
    if (worker.digest(reservation_body) != preparation['pointReservationSha256']
            or not isinstance(acceptance, dict)
            or set(acceptance) != {'schema', 'id', 'preparationSha256', 'sourceHoldSha256', 'workerRequestSha256'}
            or acceptance['schema'] != 'orbis.core-capture-acceptance.v1' or acceptance['id'] != admission.point
            or acceptance['preparationSha256'] != worker.digest(preparation_body)
            or acceptance['sourceHoldSha256'] != worker.digest(hold_body)
            or acceptance['workerRequestSha256'] != admission.request_sha256
            or not isinstance(hold, dict) or hold.get('id') != admission.point
            or hold.get('sourceSha256') != admission.request['sourceSha256']
            or hold.get('pointReservationSha256') != preparation['pointReservationSha256']):
        raise worker.AdmissionError('Sentinel preparation was not accepted')
    admission.unchanged()
    receipt = custody._read(directory, 'sentinel-custody.json')
    profile = custody.require_reserved(admission.point, preparation)
    if profile is None:
        raise worker.AdmissionError('Missing Sentinel profile')
    return (profile['schema'] == 'orbis.host.sentinel-capture-profile.v2'
            and profile.get('publication') == 'sentinel.v1'
            and receipt['schema'] == 'orbis.host.sentinel-custody.v2')


def _launch(command, *, deadline=DEADLINE):
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             close_fds=True, env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'HOME': '/'})
    output = [bytearray(), bytearray()]
    end = time.monotonic() + deadline
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, 0)
            selector.register(child.stderr, selectors.EVENT_READ, 1)
            while selector.get_map():
                remaining = end - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('Publication deadline')
                for key, _ in selector.select(remaining):
                    block = os.read(key.fileobj.fileno(), 4096)
                    if not block:
                        selector.unregister(key.fileobj)
                    else:
                        output[key.data].extend(block)
                        if len(output[key.data]) > LIMIT:
                            raise ValueError('Publication output limit')
        code = child.wait(timeout=max(0.01, end - time.monotonic()))
        return code, bytes(output[0])
    finally:
        if child.poll() is None:
            child.kill()
        try:
            child.wait(timeout=30)
        finally:
            child.stdout.close()
            child.stderr.close()


def publish_after_terminal(worker, state_dir, point, terminal, *, launcher=None):
    worker.require_root()
    admission = worker.Admission(state_dir, point)
    observed = worker.SUPERVISOR.read_terminal(admission, worker=worker.worker_context())
    if (observed != terminal or not isinstance(observed, dict) or observed.get('state') != 'quiescent'
            or observed.get('workerQuiescent') is not True or type(observed.get('workerExitCode')) is not int
            or observed['workerExitCode'] != 0):
        raise worker.AdmissionError('Publication requires the original successful terminal')
    if not _selected(worker, admission):
        return {'state': 'skipped'}
    existing, _ = admission.read('sentinel-auto-launch.json', optional=True)
    if existing is not None:
        return {'state': 'already-requested'}
    path = worker.WORKER.parent / 'orbis-host-sentinel-publication.py'
    source = _source_hash(worker, path)
    terminal_body = admission.read('worker-terminal.json')[1]
    admission.create('sentinel-auto-launch.json', admission.event('sentinel-auto-launch',
        terminalSha256=worker.digest(terminal_body), publicationSourceSha256=source))
    status, code, proof_hash = 'unsettled', None, None
    try:
        if (_source_hash(worker, path) != source
                or worker.SUPERVISOR.read_terminal(admission, worker=worker.worker_context()) != terminal
                or not _selected(worker, admission)):
            raise worker.AdmissionError('Publication authority changed')
        try:
            code, output = (launcher or _launch)(['/usr/bin/python3', '-I', '-B', str(path),
                '--state-directory', str(admission.state), '--point', admission.point])
        finally:
            source_after = _source_hash(worker, path)
        if type(code) is not int or code != 0 or source_after != source:
            raise worker.AdmissionError('Publication did not finish cleanly')
        result = worker.P.metadata(output, byte_limit=LIMIT)
        proof, proof_body = admission.read('sentinel-publication.json')
        proof_hash = worker.digest(proof_body)
        if (not isinstance(result, dict) or set(result) != {'version', 'id', 'state', 'publicationSha256', 'lifecycleComplete'}
                or worker.P.canonical(result) != worker.P.canonical({'version': 1, 'id': admission.point, 'state': 'verified-data-awaiting-continuation',
                              'publicationSha256': proof_hash, 'lifecycleComplete': False})
                or not isinstance(proof, dict)):
            raise worker.AdmissionError('Publication proof is unavailable')
        status = 'verified'
    except Exception:
        status, proof_hash = 'unsettled', None
    admission.create('sentinel-auto-result.json', admission.event('sentinel-auto-result',
        state=status, returnCode=code if type(code) is int and -255 <= code <= 255 else None, proofSha256=proof_hash))
    return {'state': status}
