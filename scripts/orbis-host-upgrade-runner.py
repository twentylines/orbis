"""Execute one admitted component set outside the replaceable Host service.

No CLI, enrollment or retry authority lives here. The fixed launcher supplies
its real live process admission and holds every selected installer byte. Each
effect has an exclusive durable intent; uncertain effects are never repeated.
"""
from contextlib import ExitStack, contextmanager
import copy
import grp
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import threading
import time
import weakref

OWNER = 0
DIRECTORY = Path('/run/orbis-upgrade')
NAME = 'progress.sock'
BROWSER_DIRECTORY = Path('/run/orbis/upgrade-progress')
PROTOCOL = 'orbis.component-upgrade-runner.v1'
_OUTCOMES = weakref.WeakKeyDictionary()
_OBSERVER = None
PHASES = {
    'staged', 'sentinel-intent', 'sentinel-ready', 'integration-intent', 'integration-prepared',
    'integration-ready', 'host-intent', 'host-ready', 'core-intent', 'core-ready',
    'complete', 'interrupted', 'integration-return-intent', 'integration-returned',
    'sentinel-return-intent', 'sentinel-returned', 'host-return-intent', 'host-returned', 'rolled-back',
    'core-reconcile-intent', 'core-reconciled', 'host-return-reconciled',
    'host-maintenance-return-intent', 'host-maintenance-returned'}


def require(value):
    if not value:
        raise ValueError('The complete component upgrade requires reconciliation; preserve its records.')


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False) + '\n').encode('ascii')


def sha(body):
    return hashlib.sha256(body).hexdigest()


def seal(info):
    return info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode


class ProgressEndpoint:
    """Same-UUID, progress-only endpoint owned by the independent process."""
    def __init__(self, observer, initial, *, directory=DIRECTORY, name=NAME, allow_stale=False):
        require(sys.platform == 'linux' and os.getuid() == os.geteuid() == OWNER)
        initial = observer.validate_progress(initial)
        require(initial['job'] is not None and initial['job']['state'] in ('queued', 'running', 'recovering'))
        self.operation, self.target = initial['job']['id'], initial['job']['targetTag']
        self.observer, self.body = observer, encoded(initial)
        self.location, self.name, self.allow_stale = directory, name, allow_stale
        self.lock, self.resources = threading.Lock(), ExitStack()
        self.directory = self.listener = self.server = self.thread = None
        self.socket_seal = None
        self.closed = self.entered = False

    def _directory_current(self):
        require(self.directory is not None and seal(os.fstat(self.directory)) == self.directory_seal
                and seal(self.location.lstat()) == self.directory_seal)

    def _clear_stopped_socket(self, group):
        # An admitted reconciliation can reclaim its own operation's socket.
        self._directory_current()
        try:
            previous = os.stat(self.name, dir_fd=self.directory, follow_symlinks=False)
        except FileNotFoundError:
            return
        require(stat.S_ISSOCK(previous.st_mode) and previous.st_nlink == 1 and previous.st_uid == OWNER
                and previous.st_gid in (OWNER, group) and stat.S_IMODE(previous.st_mode) in (0o660, 0o700))
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.5)
            try:
                probe.connect(str(self.location / self.name))
            except ConnectionRefusedError:
                pass
            else:
                require(False)
        self._directory_current()
        current = os.stat(self.name, dir_fd=self.directory, follow_symlinks=False)
        require(seal(previous) == seal(current) and previous.st_ctime_ns == current.st_ctime_ns and current.st_nlink == 1)
        os.unlink(self.name, dir_fd=self.directory)
        os.fsync(self.directory)

    def _snapshot(self):
        with self.lock:
            require(not self.closed)
            return json.loads(self.body)

    def publish(self, value):
        require(self.entered and not self.closed)
        value = self.observer.validate_progress(value)
        require(value['job'] is not None and value['job']['id'] == self.operation
                and value['job']['targetTag'] == self.target)
        self._directory_current()
        require(self.thread is not None and self.thread.is_alive()
                and seal((self.location / self.name).lstat()) == self.socket_seal)
        with self.lock:
            require(not self.closed)
            self.body = encoded(value)

    def __enter__(self):
        require(not self.entered and not self.closed)
        self.entered = True
        try:
            require(self.location.is_absolute() and self.location == Path(os.path.realpath(self.location)))
            mode = 0o755 if self.location == DIRECTORY else 0o700
            descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            self.resources.callback(os.close, descriptor)
            for index, part in enumerate(self.location.parts[1:]):
                info = os.fstat(descriptor)
                require(info.st_uid in (0, OWNER) and not info.st_mode & 0o022)
                created = False
                if index == len(self.location.parts) - 2:
                    try:
                        os.mkdir(part, mode, dir_fd=descriptor)
                        created = True
                    except FileExistsError:
                        pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                dir_fd=descriptor)
                self.resources.callback(os.close, child)
                descriptor = child
                if created:
                    require(os.fstat(child).st_uid == OWNER)
                    os.fchmod(child, mode)
            self.directory = descriptor
            info = os.fstat(descriptor)
            require(info.st_uid == OWNER and stat.S_IMODE(info.st_mode) == mode)
            self.directory_seal = seal(info)
            self._directory_current()
            group = grp.getgrnam('orbis-observer').gr_gid
            require(type(group) is int and 0 < group < 2**31)
            if self.allow_stale:
                self._clear_stopped_socket(group)
            self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.resources.callback(self.listener.close)
            endpoint = self.location / self.name
            self.listener.bind(str(endpoint))
            self.socket_seal = seal(endpoint.lstat())
            self._directory_current()
            os.chown(endpoint, OWNER, group, follow_symlinks=False)
            os.chmod(endpoint, 0o660, follow_symlinks=False)
            self.socket_seal = seal(endpoint.lstat())
            require(stat.S_ISSOCK(self.socket_seal[-1]) and self.socket_seal[2:4] == (OWNER, group)
                    and stat.S_IMODE(self.socket_seal[-1]) == 0o660)
            self.listener.listen(16)
            self.server = self.observer.ObserverServer(self.listener, self._snapshot)
            self.thread = threading.Thread(target=self.server.serve_forever, name='orbis-upgrade-progress', daemon=True)
            self.thread.start()
            return self
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.closed:
            return
        with self.lock:
            self.closed = True
        try:
            if self.server is not None:
                if self.thread is not None and self.thread.ident is not None:
                    self.server.shutdown()
                    self.thread.join(timeout=3)
                    require(not self.thread.is_alive())
                self.server.server_close()
            if self.socket_seal is not None:
                self._directory_current()
                require(seal((self.location / self.name).lstat()) == self.socket_seal)
                os.unlink(self.name, dir_fd=self.directory)
                os.fsync(self.directory)
        finally:
            self.resources.close()

    def __exit__(self, *_args):
        self.close()


def progress_protocol():
    global _OBSERVER
    if _OBSERVER is None:
        spec = importlib.util.spec_from_file_location('orbis_component_progress_reader',
            Path(__file__).with_name('orbis-host-sentinel-observer.py'))
        observer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(observer)
        _OBSERVER = observer
    return _OBSERVER


def read_progress(service, job):
    """Read facts only; a progress record cannot admit or resume an effect."""
    reference = job.get('worker')
    require(type(reference) is dict and reference.get('schema') == 'orbis.host-upgrade-worker.v1')
    path = service.state_dir / 'component-upgrades' / job['id'] / 'component-progress.json'
    value = service.read_core_operation_record(path, optional=True)
    if value is None:
        return None
    require(set(value) == {'schema', 'requestSha256', 'progress'}
            and value['schema'] == 'orbis.component-upgrade-progress.v1'
            and value['requestSha256'] == reference['requestSha256'])
    # Use the fixed local protocol validator, not a persisted callback/path.
    observer = progress_protocol()
    progress = observer.validate_progress(value['progress'])
    require(progress['job'] is not None and progress['job']['id'] == job['id']
            and progress['job']['targetTag'] == job['targetTag'])
    # Only the accepted job supplies success/failure terminal authority.
    # Telemetry may report uncertainty while the accepted running-job fence
    # remains held; it can never manufacture completion or grant a retry.
    if job['state'] in ('queued', 'running', 'recovering'):
        require(progress['job']['state'] in ('queued', 'running', 'recovering', 'interrupted'))
        if progress['job']['state'] != 'interrupted':
            progress['job']['state'] = job['state']
    elif job['state'] == 'interrupted' and progress['job']['state'] == 'recovering':
        # An interruption is durable. Show active recovery only while the
        # corresponding new generation is positively observed.
        try:
            require(service.component_recovery_live(job))
        except (OSError, ValueError, TypeError, RuntimeError):
            progress['job']['state'] = 'interrupted'
    else:
        progress['job']['state'] = 'failed' if job['state'] == 'rolled-back' else job['state']
    return observer.validate_progress(progress)


class Journal:
    def __init__(self, launcher, admission):
        self.launcher, self.admission, self.records = launcher, admission, []
        self.directory = launcher.make_directory(admission.bootstrap.directory, 'component-journal')
        self.identity = launcher.file_seal(self.directory.lstat())[:5]

    @classmethod
    def reopen(cls, launcher, admission):
        """Pin existing facts under new live admission; never replace a claim."""
        admission.verify_bootstrap()
        result = cls.__new__(cls)
        result.launcher, result.admission, result.records = launcher, admission, []
        result.directory = admission.bootstrap.directory / 'component-journal'
        result.identity = launcher.file_seal(result.directory.lstat())[:5]
        with launcher.directory(result.directory) as descriptor:
            names = sorted(os.listdir(descriptor))
            require(1 <= len(names) <= 64)
            previous = None
            for index, name in enumerate(names):
                body = launcher.read_file(result.directory / name)
                record = launcher.decoded(body)
                phase = record.get('phase')
                require(phase in PHASES and name == f'{index:02d}-{phase}.json'
                        and set(record) == {'schema', 'operationId', 'requestSha256', 'targetSetSha256',
                                           'phase', 'value', 'previousSha256'}
                        and record['schema'] == 'orbis.component-upgrade-step.v1'
                        and record['operationId'] == admission.bootstrap.operation
                        and record['requestSha256'] == admission.bootstrap.request_sha
                        and record['targetSetSha256'] == sha(admission.body)
                        and record['previousSha256'] == previous and encoded(record) == body)
                result.records.append((name, body, launcher.file_seal((result.directory / name).lstat())))
                previous = sha(body)
        result.verify()
        return result

    def facts(self):
        self.verify()
        return {json.loads(body)['phase']: json.loads(body)['value'] for _, body, _ in self.records}

    def terminal(self):
        self.verify()
        records = [json.loads(body) for _, body, _ in self.records]
        outcomes = [record for record in records if record['phase'] in ('complete', 'rolled-back')]
        require(len(outcomes) <= 1 and (not outcomes or outcomes[0] == records[-1]))
        return outcomes[0] if outcomes else None

    def once(self, phase, value):
        """Preserve an existing intent/fact; this does not authorize its effect."""
        facts = self.facts()
        if phase in facts:
            require(facts[phase] == value)
        else:
            self.append(phase, value)

    def verify(self):
        self.admission.verify_bootstrap()
        require(self.launcher.file_seal(self.directory.lstat())[:5] == self.identity)
        with self.launcher.directory(self.directory) as directory:
            require(set(os.listdir(directory)) == {name for name, _, _ in self.records})
            for name, body, identity in self.records:
                require(self.launcher.read_file(self.directory / name) == body
                        and self.launcher.file_seal((self.directory / name).lstat()) == identity)

    def append(self, phase, value):
        self.verify()
        require(len(self.records) < 64 and phase in PHASES)
        record = {'schema': 'orbis.component-upgrade-step.v1', 'operationId': self.admission.bootstrap.operation,
                  'requestSha256': self.admission.bootstrap.request_sha,
                  'targetSetSha256': sha(self.admission.body), 'phase': phase, 'value': value,
                  'previousSha256': sha(self.records[-1][1]) if self.records else None}
        body = encoded(record)
        require(len(body) <= 1024 * 1024)
        name = f'{len(self.records):02d}-{phase}.json'
        self.launcher.write_exclusive(self.directory / name, body)
        self.records.append((name, body, self.launcher.file_seal((self.directory / name).lstat())))
        self.verify()
        return sha(body)


class Progress:
    def __init__(self, launcher, service, bootstrap, observer):
        self.launcher, self.service, self.bootstrap, self.observer = launcher, service, bootstrap, observer
        self.sentinel, self.browser, self.value = None, None, None
        self.lock = threading.Lock()

    def publish(self, phase, *, state='running', download=None):
        value = {'version': 1, 'job': {'id': self.bootstrap.operation, 'targetTag': self.bootstrap.target['tag'],
                                     'state': state, 'phase': phase}}
        if download is not None:
            value['job']['download'] = download
        value = self.observer.validate_progress(value)
        with self.lock:
            self.service.write_component_progress(self.bootstrap, value)
            for endpoint in (self.sentinel, self.browser):
                if endpoint is not None:
                    endpoint.publish(value)
            self.value = value

    def start_browser(self, resources):
        require(self.browser is None and self.value is not None)
        self.bootstrap.verify_bootstrap()
        job = self.bootstrap.accepted_job()
        require(job['id'] == self.bootstrap.operation and job['target'] == self.bootstrap.target)
        overlay = self.service.core_overlays()
        record = overlay.read(job['id'])
        binding_version = record.get('componentProgress')
        if binding_version is None:
            return
        require(binding_version == 'orbis.component-browser-progress.v1'
                and record['current'] == job['current'] and record['target'] == job['target']
                and overlay.accepted_job(record))
        # The maintenance responder derives the same name from its held overlay.
        binding = '\n'.join((job['id'], job['current']['digest'], job['target']['digest'])).encode('ascii')
        self.browser = resources.enter_context(ProgressEndpoint(self.observer, self.value, directory=BROWSER_DIRECTORY,
            name=sha(binding) + '.sock', allow_stale=isinstance(self.bootstrap, self.launcher.ReconciliationBootstrap)))

    def start(self, resources):
        require(self.sentinel is None and self.value is not None)
        if self.browser is None:
            self.start_browser(resources)
        self.sentinel = resources.enter_context(ProgressEndpoint(self.observer, self.value))

    @contextmanager
    def follow_core(self, update, job):
        """Observe the real Core journal without changing the accepted job."""
        stop, errors = threading.Event(), []
        state = self.value['job']['state']
        def observe():
            try:
                while not stop.wait(0.1):
                    value = self.service.read_core_operation_record(update.journal_path(Path(job['snapshot'])), optional=True)
                    if value is None:
                        continue
                    require(self.service.update_journal_matches(job, value))
                    stage = value['stage']
                    phase = ('recovering' if stage in ('rolling-back', 'rollback-failed') else
                             'downloading' if stage == 'downloading' else
                             self.service.update_progress_phase(job, value))
                    phase = phase if phase in ('downloading', 'restarting', 'verifying', 'recovering') else 'installing'
                    self.publish(phase, state=state, download=update.safe_download(value).get('download'))
            except Exception as error:
                errors.append(error)
        thread = threading.Thread(target=observe, name='orbis-component-core-progress', daemon=True)
        thread.start()
        try:
            yield
        finally:
            stop.set()
            thread.join(timeout=3)
            require(not thread.is_alive())
        require(not errors)


class Outcome:
    """An in-process result, bound to a verified immutable final record."""
    pass


def load_target(launcher, admission, name):
    admission.verify_bootstrap()
    manifest = admission.target.manifest()
    source = Path(manifest['selectionDirectory']) / 'scripts'
    require(name in manifest['host']['inventory'])
    body = launcher.read_file(source / name)
    require(sha(body) == manifest['host']['inventory'][name])
    spec = importlib.util.spec_from_file_location('orbis_component_target_' + name.replace('-', '_'), source / name)
    module = importlib.util.module_from_spec(spec)
    # Compile the exact held body, rather than reopening the entrypoint after
    # authentication. Its fixed siblings remain held by target admission.
    exec(compile(body, str(source / name), 'exec'), module.__dict__)
    admission.verify_bootstrap()
    return module


def core_observation(helper, root, context, reference):
    require(helper.HOST.current_core(root, context) == {
        'state': 'running', 'health': 'healthy', 'image': helper.HOST.controller_reference(root, reference, context)})
    helper.HOST.installation_fingerprint(root, reference, context)
    return {'commit': reference['commit'], 'digest': reference['digest']}


def verify_unit(source, work):
    result = subprocess.run(['/usr/bin/systemd-analyze', 'verify',
        str(source.parent / 'packaging/systemd/orbis-host.service')], cwd=work,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        timeout=30, check=False, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
    require(result.returncode == 0)


def host_observation(helper, root, context, expected, environment_sha, core_digest):
    require(helper.SETUP.actual_copy(helper.SETUP.INSTALL_DIR, helper.SETUP.UNIT_FILE) == expected)
    require(sha(helper.SETUP.ENV_FILE.read_bytes()) == environment_sha)
    profile = helper.require_installed(root, context)
    helper.verify_service(core_digest, root, context)
    require(helper.SETUP.actual_copy(helper.SETUP.INSTALL_DIR, helper.SETUP.UNIT_FILE) == expected
            and sha(helper.SETUP.ENV_FILE.read_bytes()) == environment_sha)
    return {'inventorySha256': sha(encoded(expected['inventory'])), 'unitSha256': expected['unitSha256'],
            'environmentSha256': environment_sha, 'observerProfile': profile}


def register_outcome(bootstrap, job, journal, phase, observed):
    require(phase in ('complete', 'rolled-back'))
    terminal = journal.terminal()
    if terminal is None:
        final_sha = journal.append(phase, observed)
    else:
        require(terminal['phase'] == phase and same_component_set(terminal['value'], observed))
        final_sha = sha(journal.records[-1][1])
    journal.verify()
    outcome = Outcome()
    _OUTCOMES[outcome] = (bootstrap, copy.deepcopy(job), phase, final_sha, journal.records[-1])
    return outcome


def same_component_set(previous, current):
    """A reboot can change the observed Host generation, not its identity."""
    return (set(previous) == set(current) == {'core', 'host', 'sentinel'}
            and previous['core'] == current['core'] and previous['host'] == current['host']
            and same_sentinel_installation(previous['sentinel'], current['sentinel']))


def same_sentinel_installation(previous, current):
    return {key: item for key, item in previous.items() if key != 'host'} == {
        key: item for key, item in current.items() if key != 'host'}


def original_core_boundary(update, root, context, job, state):
    """Observe an unchanged or positively returned Core; never force a return.

    A healthy old image alone says nothing about data after migrations. Only
    the exact update producer's terminal abort/return permits that case.
    """
    path = update.journal_path(Path(job['snapshot']))
    if not path.exists() and not path.is_symlink():
        return {'stage': 'not-started', 'journalSha256': None}
    record = update.read_journal(Path(job['snapshot']), root, context, job['current'], job['target'])
    require(record['stage'] in ('aborted', 'rolled-back'))
    if update.unbacked_job(record):
        require(record['stage'] == 'aborted' and record.get('failureStage') in ('preparing', 'downloading', 'pulled'))
    if record.get('backupScope') == update.CONTROLLER.SCOPE:
        runtime = update.CONTROLLER.ControllerUpdate(update.HOST, root, context, Path(job['snapshot']),
                                                     job['current'], job['target'], state)
        try:
            protected = runtime.read()
        except FileNotFoundError:
            require(record['stage'] == 'aborted' and record.get('failureStage') in ('preparing', 'downloading', 'pulled'))
        else:
            require(protected.get('phase') != 'committed')
            if record['stage'] == 'rolled-back':
                require(protected.get('phase') == 'rolled-back')
            runtime.preserved(protected)
            raw = runtime.verify_source(protected)
            require(raw['State'].get('Running') and (raw['State'].get('Health') or {}).get('Status') == 'healthy')
    with update.HOST.AUTHORITY.protected_directory(path.parent) as directory:
        with update.HOST.AUTHORITY.protected_file(directory, path.name, 1024 * 1024) as body:
            require(json.loads(body) == record)
    return {'stage': record['stage'], 'journalSha256': sha(body)}


def helper_return_profile(launcher, admission, update, root, context, job, retained):
    """Derive Host's old profile from the held plan and ordered real receipts.

    Called inside live source/kernel admission. This grants no fresh-process
    resume and accepts no caller-supplied profile or busy-operation override.
    """
    admission.verify_bootstrap()
    directory = admission.bootstrap.directory / 'component-journal'
    with launcher.directory(directory) as descriptor:
        names = sorted(os.listdir(descriptor))
        require(1 <= len(names) <= 64)
        records, previous = {}, None
        for index, name in enumerate(names):
            body = launcher.read_file(directory / name)
            record = launcher.decoded(body)
            phase = record.get('phase')
            require(name == f'{index:02d}-{phase}.json' and (phase not in records or phase == 'host-return-reconciled')
                    and record.get('schema') == 'orbis.component-upgrade-step.v1'
                    and record.get('operationId') == job['id']
                    and record.get('requestSha256') == admission.bootstrap.request_sha
                    and record.get('targetSetSha256') == sha(admission.body)
                    and record.get('previousSha256') == previous and encoded(record) == body)
            records[phase] = record['value']
            previous = sha(body)
        resumed = isinstance(admission.bootstrap, launcher.ReconciliationBootstrap)
        require(names[-1].endswith('-host-return-intent.json')
                or resumed and names[-1].endswith('-host-return-reconciled.json'))
        phases = list(records)
        ordered = ['staged', 'sentinel-ready', 'integration-prepared', 'integration-ready', 'host-ready',
                   'integration-returned', 'sentinel-returned', 'host-return-intent']
        forbidden = {'complete', 'rolled-back', 'host-returned'}
        if not resumed:
            forbidden.add('interrupted')
        require(all(phase in phases for phase in ordered)
                and [phases.index(phase) for phase in ordered] == sorted(phases.index(phase) for phase in ordered)
                and not forbidden & records.keys())
        plan, intent = records['staged'], records['host-return-intent']
        if names[-1].endswith('-host-return-reconciled.json'):
            fresh = records['host-return-reconciled']
            prior = next(launcher.read_file(directory / name) for name in names if name.endswith('-host-return-intent.json'))
            require(fresh['originalIntentSha256'] == sha(prior)
                    and fresh['scope'] == admission.verify_bootstrap()
                    and fresh['retention'] == intent['retention'] and fresh['originalCore'] == intent['originalCore']
                    and {key: value for key, value in fresh['sentinel'].items() if key != 'host'} == {
                        key: value for key, value in intent['sentinel'].items() if key != 'host'})
            intent = fresh
        binding = {'operationId': job['id'], 'planSha256': sha(encoded(plan)), 'targetDigest': job['target']['digest']}
        require(plan['requestSha256'] == admission.bootstrap.request_sha
                and plan['targetSetSha256'] == sha(admission.body) and plan['target'] == admission.target.manifest()
                and records['host-ready']['retention'] == retained
                and {key: retained[key] for key in binding} == binding and intent['retention'] == retained)
        original = plan['original']
        require(original['host']['inventorySha256'] == sha(encoded(admission.bootstrap.intake['files']))
                and original['host']['unitSha256'] == admission.bootstrap.intake['acceptingHostUnitSha256']
                and records['integration-returned']['restored'] is True
                and records['integration-returned']['profile'] == original['sentinel']['profile']
                and records['sentinel-returned']['restored'] is True
                and records['sentinel-returned']['previousRelease'] == original['sentinel']['release']
                and {key: value for key, value in intent['sentinel'].items() if key != 'host'} == {
                    key: value for key, value in original['sentinel'].items() if key != 'host'})
        require(original_core_boundary(update, root, context, job, admission.bootstrap.state_directory) == intent['originalCore'])
        require(update.HOST.current_core(root, context) == {
            'state': 'running', 'health': 'healthy',
            'image': update.HOST.controller_reference(root, job['current'], context)})
        update.HOST.installation_fingerprint(root, job['current'], context)
        admission.verify_bootstrap()
        return copy.deepcopy(original['host']['observerProfile'])


def return_after_host_replacement(helper, sentinel, prepared, retained, integration_ticket,
                                  host_retained, binding, lease, service, job, original,
                                  original_copy, environment_sha, journal, progress, locks):
    require(retained is not None and integration_ticket is not None and host_retained is not None)
    journal.verify()
    ready = [json.loads(body)['value'] for name, body, _ in journal.records if name.endswith('-host-ready.json')]
    require(len(ready) == 1 and ready[0]['retention'] == host_retained)
    require(not helper.MAINTENANCE.exists() and not helper.MAINTENANCE.is_symlink()
            and sha(helper.SETUP.ENV_FILE.read_bytes()) == environment_sha)
    update = helper.SETUP.SERVICE.UPDATE
    boundary = original_core_boundary(update, service.root, service.context, job, service.state_dir)
    core_observation(helper, service.root, service.context, job['current'])
    progress.publish('recovering')
    journal.append('integration-return-intent', {'ticket': integration_ticket})
    returned = sentinel.return_observer(prepared, retained, integration_ticket, binding=binding, lease=lease)
    require(returned['restored'] is True and returned['profile'] == original['sentinel']['profile'])
    journal.append('integration-returned', returned)
    require(original_core_boundary(update, service.root, service.context, job, service.state_dir) == boundary)
    core_observation(helper, service.root, service.context, job['current'])
    journal.append('sentinel-return-intent', {'retention': retained})
    restored = sentinel.restore_retained(prepared, retained, binding=binding, lease=lease)
    require(restored['restored'] is True and restored['previousRelease'] == original['sentinel']['release'])
    journal.append('sentinel-returned', restored)
    collector = sentinel.observe_installation(prepared, lease=lease)
    require({key: value for key, value in collector.items() if key != 'host'} == {
        key: value for key, value in original['sentinel'].items() if key != 'host'})
    journal.append('host-return-intent', {'retention': host_retained, 'originalCore': boundary, 'sentinel': collector})
    restored_host = helper.rollback_retained(service.root, service.context, str(service.root), host_retained,
                                            lock_fds=locks, coordinated=True)
    require(restored_host['restored'] is True and restored_host['operationId'] == binding['operationId']
            and restored_host['planSha256'] == binding['planSha256'])
    journal.append('host-returned', restored_host)
    require(original_core_boundary(update, service.root, service.context, job, service.state_dir) == boundary)
    collector = sentinel.observe_installation(prepared, lease=lease)
    require({key: value for key, value in collector.items() if key != 'host'} == {
        key: value for key, value in original['sentinel'].items() if key != 'host'}
        and int(collector['host']['MainPID']) == helper.SETUP._systemd_main_pid(service.root, service.context))
    observed = {'core': core_observation(helper, service.root, service.context, job['current']),
                'host': host_observation(helper, service.root, service.context, original_copy,
                                         environment_sha, job['current']['digest']), 'sentinel': collector}
    require(observed['core'] == original['core'] and observed['host'] == original['host'])
    return register_outcome(journal.admission.bootstrap, job, journal, 'rolled-back', observed)


def return_before_host_replacement(helper, sentinel, prepared, retained, integration_ticket,
                                   binding, lease, service, job, original, original_copy,
                                   environment_sha, journal, progress):
    """Return known collector effects while original Host/Core remain intact.

    A changed helper or any Core journal needs the separate full return path.
    A lost ticket or an uncertain toolkit intent is never adopted here.
    """
    require(retained is not None)
    path = helper.SETUP.SERVICE.UPDATE.journal_path(Path(job['snapshot']))
    require(not path.exists() and not path.is_symlink()
            and not helper.MAINTENANCE.exists() and not helper.MAINTENANCE.is_symlink()
            and helper.SETUP.actual_copy(helper.SETUP.INSTALL_DIR, helper.SETUP.UNIT_FILE) == original_copy
            and sha(helper.SETUP.ENV_FILE.read_bytes()) == environment_sha)
    core_observation(helper, service.root, service.context, job['current'])
    progress.publish('recovering')
    if integration_ticket is not None:
        journal.append('integration-return-intent', {'ticket': integration_ticket})
        returned = sentinel.return_observer(prepared, retained, integration_ticket, binding=binding, lease=lease)
        require(returned['restored'] is True and returned['profile'] == original['sentinel']['profile'])
        journal.append('integration-returned', returned)
    journal.append('sentinel-return-intent', {'retention': retained})
    restored = sentinel.restore_retained(prepared, retained, binding=binding, lease=lease)
    require(restored['restored'] is True and restored['previousRelease'] == original['sentinel']['release'])
    journal.append('sentinel-returned', restored)
    collector = sentinel.observe_installation(prepared, lease=lease)
    require({key: value for key, value in collector.items() if key != 'host'} == {
        key: value for key, value in original['sentinel'].items() if key != 'host'}
        and int(collector['host']['MainPID']) == helper.SETUP._systemd_main_pid(service.root, service.context))
    observed = {'core': core_observation(helper, service.root, service.context, job['current']),
                'host': host_observation(helper, service.root, service.context, original_copy,
                                         environment_sha, job['current']['digest']), 'sentinel': collector}
    require(observed['core'] == original['core'] and observed['host'] == original['host'])
    return register_outcome(journal.admission.bootstrap, job, journal, 'rolled-back', observed)


def run(launcher, service, job, admission):
    """Use the actual installer/helper/Core APIs, with no Core-only fallback."""
    launcher.operator()
    admission.verify_bootstrap()
    bootstrap = admission.bootstrap
    require(job == launcher.decoded(launcher.read_file(service.job_file)))
    target = admission.target.manifest()
    source = Path(target['selectionDirectory']) / 'scripts'
    helper = load_target(launcher, admission, 'orbis-host-service-upgrade.py')
    sentinel = load_target(launcher, admission, 'orbis-sentinel-install.py')
    observer = load_target(launcher, admission, 'orbis-host-sentinel-observer.py')
    require(service.state_dir == bootstrap.state_directory == helper.STATE_DIR
            and helper.MAINTENANCE == service.state_dir / 'helper-maintenance.json')
    update = helper.SETUP.SERVICE.UPDATE
    progress = Progress(launcher, service, bootstrap, observer)
    journal = Journal(launcher, admission)
    progress.publish('downloading')
    with ExitStack() as resources:
        locks = resources.enter_context(helper.HOST.host_lock_lease(service.root))
        lease = resources.enter_context(sentinel.activation_lease())
        def check():
            journal.verify()
            helper.HOST.AUTHORITY.LAYOUT.verify_locks(service.root, locks)
            lease.verify()
        check()
        prepared = sentinel.prepare_release(bootstrap.directory, target['sentinel']['release'])
        sentinel.require_observer_change_support(prepared)
        spec = sentinel.observer_profile_spec(prepared)
        check()
        service.core_overlays().resume(job, lock_fds=locks)
        ready = helper.preflight(service.root, service.context, source)
        verify_unit(source, bootstrap.directory)
        original_copy = helper.SETUP.actual_copy(helper.SETUP.INSTALL_DIR, helper.SETUP.UNIT_FILE)
        require(original_copy == {'inventory': bootstrap.intake['files'],
                                  'unitSha256': bootstrap.intake['acceptingHostUnitSha256']})
        environment_sha = ready['installedEnvironmentSha256']
        original_collector = sentinel.observe_installation(prepared, lease=lease)
        original = {'core': core_observation(helper, service.root, service.context, job['current']),
                    'host': host_observation(helper, service.root, service.context, original_copy,
                                             environment_sha, job['current']['digest']),
                    'sentinel': original_collector}
        planned = update.update_plan(service.root, job['current'], job['target'], service.context, Path(job['snapshot']))
        policy = 'none' if planned.get('checkpoint', {}).get('backupPolicy') == 'none' else 'automatic'
        require(policy == job['backupPolicy'])
        if job.get('retainedSource') is not None:
            require(helper.HOST.retained_descriptor(service.root, service.context, job['current']) == job['retainedSource'])
        # Cache all Core image layers before stopping or replacing any actor.
        update.pull_verified_image(service.context, job['target'], service.root,
                                   lambda value: progress.publish('downloading', download=value))
        check()
        require(sentinel.observe_installation(prepared, lease=lease) == original_collector)
        require(host_observation(helper, service.root, service.context, original_copy,
                                 environment_sha, job['current']['digest']) == original['host'])
        core_observation(helper, service.root, service.context, job['current'])
        plan = {'schema': 'orbis.component-upgrade-plan.v1', 'requestSha256': bootstrap.request_sha,
                'targetSetSha256': sha(admission.body), 'original': original,
                'target': target, 'integration': spec, 'backupPolicy': policy,
                'order': ['sentinel', 'integration', 'host', 'core']}
        binding = {'operationId': job['id'], 'planSha256': sha(encoded(plan)), 'targetDigest': job['target']['digest']}
        journal.append('staged', plan)
        retained = integration_ticket = host_retained = None
        try:
            check()
            progress.publish('installing')
            journal.append('sentinel-intent', binding)
            activated = sentinel.activate(prepared, retain=binding, lease=lease)
            retained = activated['retainedRollback']
            collector = sentinel.observe_installation(prepared, lease=lease)
            require(collector['release'] == target['sentinel']['release']
                    and collector['profile'] == original_collector['profile']
                    and collector['host'] == original_collector['host'])
            journal.append('sentinel-ready', {'retention': retained, 'observed': collector})
            check()
            journal.append('integration-intent', {'retention': retained, 'spec': spec})
            def ready_progress(profile, ticket):
                nonlocal integration_ticket
                check()
                require(profile['profile'] == spec['profile'] and profile['files'] == spec['files'])
                integration_ticket = ticket
                journal.append('integration-prepared', {'ticket': ticket, 'profile': profile})
                progress.start(resources)
                progress.publish('installing')
            integrated = sentinel.enroll_observer(prepared, retained, binding=binding, lease=lease, ready=ready_progress)
            collector = sentinel.observe_installation(prepared, lease=lease)
            require(collector['release'] == target['sentinel']['release']
                    and collector['profile'] == integrated['profile']
                    and collector['host'] == original_collector['host'])
            journal.append('integration-ready', {'ticket': integration_ticket, 'observed': collector})
            check()
            journal.append('host-intent', binding)
            launcher.admit_helper_replacement(admission)
            progress.publish('restarting')
            replaced = helper.upgrade(service.root, service.context, source, str(service.root),
                source_custody=target['sourceSelectionSha256'], retain=binding, lock_fds=locks)
            host_retained = replaced.get('retainedRollback')
            expected_copy = {'inventory': target['host']['inventory'], 'unitSha256': target['host']['unitSha256']}
            new_host = host_observation(helper, service.root, service.context, expected_copy,
                                        environment_sha, job['current']['digest'])
            collector_after_host = sentinel.observe_installation(prepared, lease=lease)
            require(collector_after_host['release'] == collector['release']
                    and collector_after_host['inventorySha256'] == collector['inventorySha256']
                    and collector_after_host['profile'] == collector['profile']
                    and int(collector_after_host['host']['MainPID']) == helper.SETUP._systemd_main_pid(service.root, service.context))
            if replaced['upgraded']:
                require(collector_after_host['host']['InvocationID'] != collector['host']['InvocationID'])
            journal.append('host-ready', {'retention': replaced.get('retainedRollback'), 'observed': new_host,
                                          'collector': collector_after_host})
            check()
            core_observation(helper, service.root, service.context, job['current'])
            journal.append('core-intent', binding)
            progress.publish('installing')
            options = {'expected_backup_policy': job['backupPolicy'], 'controller_state_dir': service.state_dir,
                       'lock_fds': locks}
            if job.get('retainedSource') is not None:
                options['expected_source'] = job['retainedSource']
            with progress.follow_core(update, job):
                result = update.apply_update(service.root, job['current'], job['target'], service.context,
                                             Path(job['snapshot']), **options)
            require(type(result) is dict and result.get('result') == 'healthy')
            journal.append('core-ready', result)
            check()
            progress.publish('verifying')
            final = {'core': core_observation(helper, service.root, service.context, job['target']),
                     'host': host_observation(helper, service.root, service.context, expected_copy,
                                             environment_sha, job['target']['digest']),
                     'sentinel': sentinel.observe_installation(prepared, lease=lease)}
            require(final['host'] == new_host and final['sentinel'] == collector_after_host)
            # Completion remains invisible until the admission scope has
            # exited with the original accepted job still byte/field-identical.
            return register_outcome(bootstrap, job, journal, 'complete', final)
        except Exception:
            try:
                check()
                # A committed terminal receipt is never followed by an
                # opposing effect or another journal entry.
                if journal.terminal() is not None:
                    raise ValueError('Terminal publication requires reconciliation')
                if host_retained is not None:
                    return return_after_host_replacement(helper, sentinel, prepared, retained, integration_ticket,
                        host_retained, binding, lease, service, job, original, original_copy,
                        environment_sha, journal, progress, locks)
                return return_before_host_replacement(helper, sentinel, prepared, retained, integration_ticket,
                    binding, lease, service, job, original, original_copy, environment_sha, journal, progress)
            except Exception:
                pass
            # An exception is not proof of rollback or permission to repeat.
            # Preserve exact component tickets/intents and all retained bytes.
            # The closed reconciliation path must independently prove the
            # entire original set before reporting rolled-back.
            try:
                if journal.terminal() is None:
                    journal.append('interrupted', {'requiresReconciliation': True})
                progress.publish('recovering', state='interrupted')
            except Exception:
                pass
            raise


def reconcile(launcher, service, job, admission):
    """Recover from actual receipts under a distinct, quiescent-generation scope.

    Completed Core data is kept forward. Otherwise its existing recovery
    producer establishes the original data boundary before ordered component
    return. Missing/uncertain component effects never become retry permission.
    """
    launcher.operator()
    require(isinstance(admission.bootstrap, launcher.ReconciliationBootstrap))
    admission.verify_bootstrap()
    require(job == launcher.decoded(launcher.read_file(service.job_file)))
    bootstrap = admission.bootstrap
    journal = Journal.reopen(launcher, admission)
    facts, target = journal.facts(), admission.target.manifest()
    terminal = journal.terminal()
    plan = facts.get('staged')
    require(type(plan) is dict and plan.get('schema') == 'orbis.component-upgrade-plan.v1'
            and plan['requestSha256'] == bootstrap.request_sha and plan['targetSetSha256'] == sha(admission.body)
            and plan['target'] == target and plan['backupPolicy'] == job['backupPolicy']
            and plan['order'] == ['sentinel', 'integration', 'host', 'core'])
    binding = {'operationId': job['id'], 'planSha256': sha(encoded(plan)), 'targetDigest': job['target']['digest']}
    original = plan['original']
    original_copy = {'inventory': bootstrap.intake['files'], 'unitSha256': bootstrap.intake['acceptingHostUnitSha256']}
    require(original['host']['inventorySha256'] == sha(encoded(original_copy['inventory']))
            and original['host']['unitSha256'] == original_copy['unitSha256'])
    helper = load_target(launcher, admission, 'orbis-host-service-upgrade.py')
    sentinel = load_target(launcher, admission, 'orbis-sentinel-install.py')
    observer = load_target(launcher, admission, 'orbis-host-sentinel-observer.py')
    require(service.state_dir == bootstrap.state_directory == helper.STATE_DIR
            and helper.MAINTENANCE == service.state_dir / 'helper-maintenance.json')
    update = helper.SETUP.SERVICE.UPDATE
    environment_sha = original['host']['environmentSha256']
    expected_copy = {'inventory': target['host']['inventory'], 'unitSha256': target['host']['unitSha256']}
    progress = Progress(launcher, service, bootstrap, observer)
    progress.publish('recovering', state='recovering')
    with ExitStack() as resources:
        locks = resources.enter_context(helper.HOST.host_lock_lease(service.root))
        lease = resources.enter_context(sentinel.activation_lease())
        def check():
            journal.verify()
            helper.HOST.AUTHORITY.LAYOUT.verify_locks(service.root, locks)
            lease.verify()
            require(sha(helper.SETUP.ENV_FILE.read_bytes()) == environment_sha)
        check()
        maintenance = service.read_core_operation_record(helper.MAINTENANCE, optional=True)
        pending_host_return = None
        if maintenance is not None:
            require(terminal is None and facts.get('host-intent') == binding and 'integration-ready' in facts
                    and maintenance.get('componentUpgrade') == binding
                    and launcher.decoded(launcher.read_file(bootstrap.directory / 'host-forward-intent.json', 16384))
                        == launcher.helper_intent(admission))
            progress.start_browser(resources)
            boundary = original_core_boundary(update, service.root, service.context, job, service.state_dir)
            require(core_observation(helper, service.root, service.context, job['current']) == original['core'])
            return_intent = facts.get('host-return-intent')
            if return_intent is None:
                require('core-intent' not in facts and boundary['stage'] == 'not-started')
                options = {}
            else:
                pending_host_return = return_intent['retention']
                require(boundary == return_intent['originalCore']
                        and facts.get('host-ready', {}).get('retention') == pending_host_return
                        and facts.get('integration-returned', {}).get('restored') is True
                        and facts['integration-returned']['profile'] == original['sentinel']['profile']
                        and facts.get('sentinel-returned', {}).get('restored') is True
                        and facts['sentinel-returned']['previousRelease'] == original['sentinel']['release']
                        and same_sentinel_installation(return_intent['sentinel'], original['sentinel']))
                options = {'returning': (pending_host_return, original['host']['observerProfile'])}
            journal.once('host-maintenance-return-intent', {'binding': binding, 'originalCore': boundary,
                                                          'retention': pending_host_return})
            helper.restore_interrupted_component_copy(service.root, service.context, maintenance, binding,
                target, original_copy, job['current']['digest'], environment_sha, lock_fds=locks, **options)
            check()
            require(service.read_core_operation_record(helper.MAINTENANCE, optional=True) is None)
            require(helper.SETUP.actual_copy(helper.SETUP.INSTALL_DIR, helper.SETUP.UNIT_FILE) == original_copy)
            journal.once('host-maintenance-returned', {'binding': binding})
        prepared = sentinel.prepare_release(bootstrap.directory, target['sentinel']['release'])
        sentinel.require_observer_change_support(prepared)
        require(sentinel.observer_profile_spec(prepared) == plan['integration'])
        retained = facts.get('sentinel-ready', {}).get('retention')
        ticket = facts.get('integration-prepared', {}).get('ticket')
        reconciled = None
        if terminal is None and 'integration-intent' in facts:
            # During preparation the installed profile exists on disk but is
            # not loaded in systemd yet. Only the authentic pending receipt
            # explains this mismatch and permits the existing return API.
            reconciled = sentinel.reconcile_retained(prepared, binding=binding, lease=lease, retained=retained, observer=ticket)
        pending = (reconciled or {}).get('observer')
        collector = (None if pending is not None and pending['phase'] == 'installed'
                     else sentinel.observe_installation(prepared, lease=lease))
        if collector and collector['profile'] is not None and collector['profile']['profile'] == 'orbis-observer-v2':
            progress.start(resources)
        path = update.journal_path(Path(job['snapshot']))
        core_record = None
        if path.exists() or path.is_symlink():
            require('core-intent' in facts)
            core_record = update.read_journal(Path(job['snapshot']), service.root, service.context, job['current'], job['target'])
            if core_record['stage'] not in ('complete', 'aborted', 'rolled-back'):
                require(terminal is None and collector is not None)
                # The protected Core producer owns data recovery. Its no-backup
                # and irreversible-commit fences remain authoritative.
                service.core_overlays().resume(job, lock_fds=locks)
                journal.once('core-reconcile-intent', binding)
                with progress.follow_core(update, job):
                    recovered = update.recover(service.root, job['current'], job['target'], service.context,
                        Path(job['snapshot']), controller_state_dir=service.state_dir, lock_fds=locks)
                journal.append('core-reconciled', recovered)
                check()
                core_record = update.read_journal(Path(job['snapshot']), service.root, service.context, job['current'], job['target'])
        if core_record is not None and core_record['stage'] == 'complete':
            require((terminal is None or terminal['phase'] == 'complete')
                    and 'host-intent' in facts and collector is not None and collector['release'] == target['sentinel']['release']
                    and collector['profile'] is not None
                    and collector['profile']['profile'] == plan['integration']['profile']
                    and collector['profile']['files'] == plan['integration']['files'])
            observed = {'core': core_observation(helper, service.root, service.context, job['target']),
                        'host': host_observation(helper, service.root, service.context, expected_copy,
                                                 environment_sha, job['target']['digest']),
                        'sentinel': sentinel.observe_installation(prepared, lease=lease)}
            require(observed['sentinel'] == collector)
            return register_outcome(bootstrap, job, journal, 'complete', observed)
        boundary = original_core_boundary(update, service.root, service.context, job, service.state_dir)
        core_observation(helper, service.root, service.context, job['current'])
        current_copy = helper.SETUP.actual_copy(helper.SETUP.INSTALL_DIR, helper.SETUP.UNIT_FILE)
        require(current_copy in (original_copy, expected_copy))
        def original_collector(value):
            return same_sentinel_installation(value, original['sentinel'])
        if pending_host_return is not None:
            require(current_copy == original_copy and collector is not None and original_collector(collector))
        if current_copy == original_copy and collector is not None and original_collector(collector):
            observed = {'core': core_observation(helper, service.root, service.context, job['current']),
                        'host': host_observation(helper, service.root, service.context, original_copy,
                                                 environment_sha, job['current']['digest']), 'sentinel': collector}
            require(observed['core'] == original['core'] and observed['host'] == original['host'])
            return register_outcome(bootstrap, job, journal, 'rolled-back', observed)
        require(terminal is None)
        require('sentinel-intent' in facts)
        # Stage real helper-return custody before any collector/profile effect.
        host_retained = None
        if current_copy != original_copy:
            require('host-intent' in facts and collector is not None)
            held = helper.find_retained(service.root, service.context, binding)
            require(held['previous'] == original_copy and held['candidate'] == expected_copy
                    and held['environmentSha256'] == environment_sha and held['previousDigest'] == job['current']['digest'])
            host_retained = held['retainedRollback']
            current_host = host_observation(helper, service.root, service.context, expected_copy,
                                            environment_sha, job['current']['digest'])
            if 'host-ready' in facts:
                saved = facts['host-ready']['observed']
                if pending is not None and pending['phase'] == 'returned':
                    saved = {**saved, 'observerProfile': original['host']['observerProfile']}
                require(facts['host-ready']['retention'] == host_retained and saved == current_host)
            else:
                journal.append('host-ready', {'retention': host_retained, 'observed': current_host, 'collector': collector})
        if reconciled is None:
            reconciled = sentinel.reconcile_retained(prepared, binding=binding, lease=lease, retained=retained, observer=ticket)
        retained, observed_observer = reconciled['retainedRollback'], reconciled['observer']
        require(reconciled['previousRelease'] == original['sentinel']['release'])
        if observed_observer is not None:
            ticket = observed_observer['ticket']
            require(observed_observer['originalProfile'] == original['sentinel']['profile'])
            # Discovering a genuine completed effect fills its missing reply
            # with an explicit observation; it never repeats enrollment.
            if 'integration-prepared' not in facts:
                journal.append('integration-prepared', {'ticket': ticket, 'profile': observed_observer['profile']})
            if observed_observer['phase'] != 'returned':
                journal.once('integration-return-intent', {'ticket': ticket})
                returned = sentinel.return_observer(prepared, retained, ticket, binding=binding, lease=lease)
            else:
                returned = {'ticket': ticket, 'profile': observed_observer['originalProfile'], 'restored': True}
            require(returned['restored'] is True and returned['profile'] == original['sentinel']['profile'])
            journal.once('integration-returned', returned)
        else:
            require(host_retained is None and ticket is None)
        check()
        require(original_core_boundary(update, service.root, service.context, job, service.state_dir) == boundary)
        if reconciled['activation'] == 'returned':
            restored = reconciled['restoration']
        else:
            journal.once('sentinel-return-intent', {'retention': retained})
            restored = sentinel.restore_retained(prepared, retained, binding=binding, lease=lease)
        require(restored['restored'] is True and restored['previousRelease'] == original['sentinel']['release'])
        journal.once('sentinel-returned', restored)
        collector = sentinel.observe_installation(prepared, lease=lease)
        require(original_collector(collector))
        if host_retained is not None:
            intent = {'retention': host_retained, 'originalCore': boundary, 'sentinel': collector}
            existing = journal.facts().get('host-return-intent')
            if existing is None:
                journal.append('host-return-intent', intent)
            else:
                require(existing['retention'] == host_retained and existing['originalCore'] == boundary
                        and original_collector(existing['sentinel']))
                prior = next(body for name, body, _ in journal.records if name.endswith('-host-return-intent.json'))
                journal.append('host-return-reconciled', {**intent, 'originalIntentSha256': sha(prior),
                                                        'scope': admission.verify_bootstrap()})
            restored_host = helper.rollback_retained(service.root, service.context, str(service.root), host_retained,
                                                    lock_fds=locks, coordinated=True)
            require(restored_host['restored'] is True and restored_host['operationId'] == binding['operationId']
                    and restored_host['planSha256'] == binding['planSha256'])
            journal.once('host-returned', restored_host)
        check()
        require(original_core_boundary(update, service.root, service.context, job, service.state_dir) == boundary)
        collector = sentinel.observe_installation(prepared, lease=lease)
        require(original_collector(collector)
                and int(collector['host']['MainPID']) == helper.SETUP._systemd_main_pid(service.root, service.context))
        observed = {'core': core_observation(helper, service.root, service.context, job['current']),
                    'host': host_observation(helper, service.root, service.context, original_copy,
                                             environment_sha, job['current']['digest']), 'sentinel': collector}
        require(observed['core'] == original['core'] and observed['host'] == original['host'])
        return register_outcome(bootstrap, job, journal, 'rolled-back', observed)


def finalize(launcher, service, bootstrap, outcome):
    """Publish only this process's verified whole-set terminal result once."""
    launcher.operator()
    registered = _OUTCOMES.pop(outcome, None) if type(outcome) is Outcome else None
    require(registered is not None)
    owner, job, phase, final_sha, (name, body, identity) = registered
    require(owner is bootstrap)
    bootstrap.verify_bootstrap()
    path = bootstrap.directory / 'component-journal' / name
    require(launcher.read_file(path) == body and sha(body) == final_sha
            and launcher.file_seal(path.lstat()) == identity)
    record = json.loads(body)
    require(record['phase'] == phase and phase in ('complete', 'rolled-back') and record['operationId'] == job['id']
            and record['requestSha256'] == bootstrap.request_sha
            and launcher.decoded(launcher.read_file(service.job_file)) == job)
    if phase == 'complete':
        service.complete_channel_change(job)
    bootstrap.verify_bootstrap()
    final = {**job, 'state': phase, 'finishedAt': time.time(),
             'message': ('Orbis, Host and Sentinel reached the verified component set.' if phase == 'complete' else
                         'All update components returned to their verified original state.'),
             'componentReceiptSha256': final_sha}
    service.publish_component_outcome(bootstrap, job, final)
