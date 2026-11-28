"""Observe two pre-effect boundaries of the official disposable upgrade."""

from contextlib import contextmanager
from json import JSONDecodeError
import os
from pathlib import Path
import signal
import subprocess
from threading import Event, Thread
import uuid


PREPARATION = 'source-preparation.json'
SELECTION = 'selection/installer-source-selection.json'
EXECUTION = 'selection/installer-source-execution.json'
CHECKED = 'source-checked.json'
TARGET = 'target-set.json'
INTENT = 'execution-intent.json'
BOUNDARIES = {
    'source-selection': ((PREPARATION, SELECTION), (EXECUTION, CHECKED, TARGET, INTENT)),
    'target-custody': ((PREPARATION, SELECTION, EXECUTION, CHECKED, TARGET, INTENT), ()),
}


def boundary_paths(launcher, directory, snapshot, journal, state, case):
    required, forbidden = BOUNDARIES[case]
    effect_paths = (snapshot, journal, directory / 'host-forward-intent.json',
                    state / 'helper-maintenance.json')
    if (not all(launcher.absent(path) for path in effect_paths)
            or not launcher.before_component_stage(directory)
            or not all(not launcher.absent(directory / name) for name in required)
            or not all(launcher.absent(directory / name) for name in forbidden)):
        return None
    return required


def read_witness(runtime, launcher, service, source, target, case, *, stopped=False):
    job = service.read_private(runtime.STATE / 'job.json')
    if not job or not job.get('worker') or job.get('backupPolicy') != 'automatic':
        return None
    if job['state'] not in (('running', 'interrupted') if stopped else ('running',)):
        return None
    releases = [tuple(job[role][field] for field in ('tag', 'commit', 'digest')) for role in ('current', 'target')]
    runtime.require(releases == [source[:3], target[:3]], 'pre-effect-release-changed')
    operation = job['id']
    runtime.require(str(uuid.UUID(operation)) == operation, 'pre-effect-operation-invalid')
    snapshot = Path('/var/lib/orbis/snapshots') / f'orbis-{target[0]}-{operation}'
    runtime.require(Path(job['snapshot']) == snapshot, 'pre-effect-snapshot-invalid')
    directory = runtime.STATE / 'component-upgrades' / operation
    journal = service.UPDATE.journal_path(snapshot)
    required = boundary_paths(launcher, directory, snapshot, journal, runtime.STATE, case)
    if required is None:
        return None

    if stopped:
        bootstrap = launcher.ReconciliationBootstrap(runtime.STATE, operation, job['worker'])
        bootstrap.verify_original_claim()
        frame = bootstrap.original_frame
        runtime.require(bootstrap.verify_files() == job, 'pre-effect-job-changed')
    else:
        bootstrap = launcher.Bootstrap(runtime.STATE, operation, job['worker'])
        frame = bootstrap.verify_bootstrap(current=False)
    runtime.require(bootstrap.directory == directory, 'pre-effect-directory-invalid')
    if boundary_paths(launcher, directory, snapshot, journal, runtime.STATE, case) is None:
        return None

    data = {name: launcher.read_file(directory / name) for name in required}
    preparation = launcher.decoded(data[PREPARATION])
    selection = launcher.decoded(data[SELECTION])
    request = bootstrap.reference['requestSha256']
    runtime.require(launcher.decoded(launcher.read_file(directory / 'claim.json', 16384)) == {
        'schema': 'orbis.host-upgrade-claim.v1', 'requestSha256': request, **frame,
    }, 'pre-effect-worker-claim-invalid')
    runtime.require(
        preparation['schema'] == 'orbis.component-upgrade-source.v1'
        and preparation['operationId'] == operation and preparation['requestSha256'] == request
        and preparation['core'] == job['target'] and preparation['channel'] == bootstrap.channel
        and preparation['selectionSha256'] == runtime.sha(data[SELECTION])
        and selection['schema'] == 'orbis.installer-source-selection.v1'
        and selection['mode'] == 'release' and selection['channel'] == bootstrap.channel
        and (selection['installer']['tag'], selection['installer']['commit']) == target[:2],
        'pre-effect-source-selection-invalid',
    )
    if case == 'target-custody':
        execution_sha = runtime.sha(data[EXECUTION])
        target_set = launcher.decoded(data[TARGET])
        execution = launcher.decoded(data[EXECUTION])
        runtime.require(
            execution['schema'] == 'orbis.installer-source-execution.v1'
            and execution['selectionSha256'] == preparation['selectionSha256']
            and execution['launcherSha256'] == selection['proofs']['install-orbis.py']['sha256']
            and execution['channel'] == bootstrap.channel
            and launcher.decoded(data[CHECKED]) == {**preparation, 'executionSha256': execution_sha}
            and target_set['schema'] == 'orbis.component-upgrade-target.v1'
            and target_set['core'] == job['target']
            and target_set['sourceSelectionSha256'] == preparation['selectionSha256']
            and target_set['sourceExecutionSha256'] == execution_sha
            and launcher.decoded(data[INTENT]) == {
                'schema': 'orbis.host-upgrade-execution.v1', 'requestSha256': request, **frame,
            },
            'pre-effect-target-custody-invalid',
        )
    if boundary_paths(launcher, directory, snapshot, journal, runtime.STATE, case) is None:
        return None
    return operation, frame, {name: runtime.sha(body) for name, body in data.items()}


@contextmanager
def interrupt(runtime, source, target, case, result):
    launcher = runtime.load('orbis-host-upgrade-launcher')
    service = runtime.load('orbis-host-service')
    stop = Event()
    missed = (FileNotFoundError, ProcessLookupError, JSONDecodeError, launcher.UpgradeSourceError,
              subprocess.SubprocessError)

    def observe():
        try:
            while not stop.wait(0.025):
                try:
                    candidate = read_witness(runtime, launcher, service, source, target, case)
                    if candidate is None:
                        continue
                    operation, frame, records = candidate
                    pid = os.pidfd_open(frame['pid'])
                    try:
                        exact = read_witness(runtime, launcher, service, source, target, case)
                        if exact != candidate or stop.is_set():
                            continue
                        runtime.fence(f'{case}-interruption-intent', target)
                        signal.pidfd_send_signal(pid, signal.SIGKILL)
                        result['preEffectInterruption'] = {
                            'case': case, 'operation': operation, 'records': records, 'sent': True,
                        }
                        return
                    finally:
                        os.close(pid)
                except missed:
                    continue
        except (OSError, ValueError, KeyError, TypeError, RuntimeError):
            result['preEffectObserverRefused'] = True

    observer = Thread(target=observe, name=f'disposable-{case}-interruption')
    observer.start()
    try:
        yield
    finally:
        stop.set()
        observer.join()


def installed_generation(runtime, source):
    runtime.check_host(source)
    setup = runtime.load('orbis-host-service-setup', runtime.HOST)
    copy = setup.actual_copy(setup.INSTALL_DIR, setup.UNIT_FILE)
    generations = []
    for unit in ('orbis-host.service', 'orbis-sentinel.service'):
        invocation = runtime.run(['/usr/bin/systemctl', 'show', '--property=InvocationID', '--value', unit])
        runtime.require(len(invocation) == 32 and all(digit in '0123456789abcdef' for digit in invocation)
                        and int(invocation, 16) != 0, 'pre-effect-installed-invocation-invalid')
        generations.append(invocation)
    return copy, generations


def verify(runtime, source, target, result, credential, identity, original, proxy, generation):
    fault = result['preEffectInterruption']
    launcher = runtime.load('orbis-host-upgrade-launcher')
    service = runtime.load('orbis-host-service')

    def verify_original_boundary(job):
        witness = read_witness(runtime, launcher, service, source, target, fault['case'], stopped=True)
        runtime.require(witness and witness[0] == job['id'] and witness[2] == fault['records'],
                        'pre-effect-window-closed-before-interruption')

    job, current, directory = runtime.reconcile_interruption(
        source, target, fault, 'failed', before_dispatch=verify_original_boundary)
    runtime.require(current['message'] ==
                    'The update stopped before component installation. The original release is intact.'
                    and current.get('componentReceiptSha256') is None
                    and current.get('finishedAt') is not None, 'pre-effect-terminal-invalid')
    snapshot = Path(job['snapshot'])
    runtime.require(boundary_paths(launcher, directory, snapshot, service.UPDATE.journal_path(snapshot),
                                   runtime.STATE, fault['case']) is not None, 'pre-effect-component-change')
    runtime.require(installed_generation(runtime, source) == generation, 'pre-effect-installed-generation-changed')
    status = runtime.check_host(source)
    runtime.require(status['job']['id'] == fault['operation'] and status['job']['state'] == 'failed',
                    'pre-effect-host-terminal-invalid')
    cookie = runtime.session('login', credential)
    try:
        runtime.build(cookie, source)
        runtime.require(runtime.app_data(identity) == original, 'pre-effect-data-marker-changed')
        runtime.require(runtime.run(runtime.DOCKER + [
            'inspect', '--format', '{{.Id}} {{.State.StartedAt}} {{.State.Running}}', 'runtipi-reverse-proxy',
        ]) == proxy, 'pre-effect-proxy-restarted')
    finally:
        runtime.http('POST', '/api/auth/logout', cookie=cookie, expect=(204,))
    result.update(phase='pre-effect-recovery-complete', markerChecks=2, appAndProxyUninterrupted=True,
                  originalReleaseVerified=True, originalHostAndSentinelInvocationVerified=True,
                  componentEffectsAbsent=True, preEffectTerminalVerified=True)
