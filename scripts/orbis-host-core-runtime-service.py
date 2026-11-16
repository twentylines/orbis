"""Root-owned, asynchronous enrollment of the verified current restore runtime."""
import copy
from contextlib import contextmanager
import hashlib
import importlib.util
import os
from pathlib import Path
import sys
import threading


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module


R = load('orbis-host-core-runtime-install.py', 'orbis_runtime_service_installer')
INTENT = 'orbis.core-runtime-enrollment-intent.v1'
COMPLETE = 'orbis.core-runtime-enrollment-complete.v1'
FAILURE = 'orbis.core-runtime-enrollment-failure.v1'
ACTION = 'ensure-current-restore-runtime'
FLAGS = {'scope': 'verified-current-runtime-only', 'activation': False,
         'environmentProved': False, 'restoreAuthority': False, 'sourceWrites': False}
WAIT_SECONDS = 1800


def require(value):
    if not value:
        raise ValueError('Restore support needs review. Your saved data is unchanged.')


class CoreRuntimeEnrollmentService:
    def __init__(self, service, *, enrollment=None, worker_factory=threading.Thread):
        self.service = service
        self.enrollment = enrollment if enrollment is not None else R.E.CorePortableEnrollment(service)
        self.P = self.enrollment.P
        self.worker_factory = worker_factory
        self._condition = threading.Condition()
        self._active = {}

    def _request(self, request, peer, *, prepare=False):
        require(peer is True)
        R.POLICY.I.require_root()
        require(self.P.exact(request, {'id', 'actor', 'action'} if prepare else {'id', 'actor'}))
        require(isinstance(request['id'], str) and R.E.UUID.fullmatch(request['id']))
        if prepare:
            require(request['action'] == ACTION)
        return request['id'], copy.deepcopy(self.enrollment.actor(request['actor']))

    def _directory(self, identifier):
        return Path(self.enrollment.state) / 'core-runtime-enrollments' / identifier

    def _read(self, identifier, name):
        body = self.enrollment.read(self._directory(identifier) / name, 65536)
        value = self.P.metadata(body, byte_limit=65536)
        require(body == self.P.canonical(value))
        return value

    def _sha(self, value):
        return hashlib.sha256(self.P.canonical(value)).hexdigest()

    def _intent(self, identifier, actor):
        intent = self._read(identifier, 'intent.json')
        require(self.P.exact(intent, {'schema', 'id', 'actor', 'root', 'context', 'action'})
                and intent['schema'] == INTENT and intent['id'] == identifier
                and intent['root'] == str(self.enrollment.root) and intent['context'] == self.enrollment.context
                and intent['action'] == ACTION and intent['actor'] == actor)
        self.enrollment.actor(intent['actor'])
        return intent

    def _public(self, identifier, phase):
        return {'version': 1, 'id': identifier, 'phase': phase,
                'enrollmentActive': phase == 'preparing', 'runtimeAvailable': phase == 'installed', **FLAGS}

    def prepare(self, request, *, privileged_peer=False):
        identifier, actor = self._request(request, privileged_peer, prepare=True)
        with self._condition:
            directory = self._directory(identifier)
            if directory.exists() or directory.is_symlink():
                self._intent(identifier, actor)
            else:
                require(not self._active)
                base = self.enrollment.child(Path(self.enrollment.state), directory.parent.name)
                self.enrollment.sync(Path(self.enrollment.state))
                with self.enrollment.a.protected_directory(base):
                    names = os.listdir(base)
                require(len(names) < 256 and all(R.E.UUID.fullmatch(name) for name in names))
                for previous in names:
                    prior = self._read(previous, 'intent.json')
                    prior = self._intent(previous, prior.get('actor'))
                    require(not (base / previous / 'failure.json').exists()
                            and not (base / previous / 'failure.json').is_symlink())
                    complete = self._read(previous, 'complete.json')
                    require(self.P.exact(complete, {'schema', 'intentSha256', 'publication', 'imageId', 'result'})
                            and complete['schema'] == COMPLETE and complete['intentSha256'] == self._sha(prior))
                directory.mkdir(mode=0o700)
                self.enrollment.sync(base)
                intent = {'schema': INTENT, 'id': identifier, 'actor': actor,
                          'root': str(self.enrollment.root), 'context': self.enrollment.context, 'action': ACTION}
                self.enrollment.immutable(directory / 'intent.json', self.P.canonical(intent))
                self.enrollment.sync(directory)
                worker = self.worker_factory(target=self._run, args=(identifier, actor), daemon=True)
                self._active[identifier] = worker
                try:
                    worker.start()
                except BaseException:
                    self._active.pop(identifier, None)
                    self._condition.notify_all()
                    raise
                return self._public(identifier, 'preparing')
        return self.status({'id': identifier, 'actor': actor}, privileged_peer=True)

    def _source(self, installer):
        publication = R.CHECK.PLAN.validate_manifest(self.service.current_manifest())
        image = installer.runtime.image(publication['image'] + '@' + publication['digest'])
        require(isinstance(image.get('Id'), str) and R.POLICY.I.C.IMAGE.fullmatch(image['Id'])
                and publication['image'] + '@' + publication['digest'] in (image.get('RepoDigests') or []))
        supported = ((image.get('Config') or {}).get('Labels') or {}).get(R.LABEL) == R.PROTOCOL
        if supported:
            require(installer.image(publication) == image)
        return publication, image, supported

    def _checked_result(self, installer, publication, image, supported, result):
        if supported:
            require(type(result) is dict and result.get('state') == 'installed'
                    and installer.cached(publication, image) == result)
            return 'installed'
        require(result == {'version': 1, 'state': 'not-supported', 'reason': 'installed-version', **R.FLAGS})
        return 'not-supported'

    def _held_guard(self, descriptor):
        host, thread = self.service.HOST, threading.get_ident()
        require(type(descriptor) is int)
        identity = os.fstat(descriptor)

        @contextmanager
        def held_guard():
            require(threading.get_ident() == thread and host.LOCK_DESCRIPTOR.get() == descriptor
                    and os.fstat(descriptor) == identity and self.service.lock.locked())
            yield
            require(threading.get_ident() == thread and host.LOCK_DESCRIPTOR.get() == descriptor
                    and os.fstat(descriptor) == identity and self.service.lock.locked())

        return held_guard

    def _run(self, identifier, actor):
        try:
            intent = self._intent(identifier, actor)
            with self.service.lock, self.service.HOST.host_lock(self.service.root) as descriptor:
                held_guard = self._held_guard(descriptor)
                installer = R.ReleaseRuntimeInstaller(self.enrollment, lambda: self.service.current_manifest(), held_guard)
                before = self._source(installer)
                result = installer.install()
                publication, image, supported = self._source(installer)
                require(before == (publication, image, supported))
                self._checked_result(installer, publication, image, supported, result)
                receipt = {'schema': COMPLETE, 'intentSha256': self._sha(intent),
                           'publication': publication, 'imageId': image['Id'], 'result': result}
                self.enrollment.immutable(self._directory(identifier) / 'complete.json', self.P.canonical(receipt))
        except BaseException:
            # Unknown external work stays in installer custody; this API never
            # retries an interrupted installation or claims its worker settled.
            try:
                intent = self._intent(identifier, actor)
                self.enrollment.immutable(self._directory(identifier) / 'failure.json', self.P.canonical(
                    {'schema': FAILURE, 'intentSha256': self._sha(intent)}))
            except BaseException:
                pass
        finally:
            with self._condition:
                self._active.pop(identifier, None)
                self._condition.notify_all()

    def status(self, request, *, privileged_peer=False):
        identifier, actor = self._request(request, privileged_peer)
        intent = self._intent(identifier, actor)
        with self._condition:
            if identifier in self._active:
                return self._public(identifier, 'preparing')
        directory = self._directory(identifier)
        if (directory / 'failure.json').exists() or (directory / 'failure.json').is_symlink():
            return self._public(identifier, 'recovery-required')
        try:
            receipt = self._read(identifier, 'complete.json')
            require(self.P.exact(receipt, {'schema', 'intentSha256', 'publication', 'imageId', 'result'})
                    and receipt['schema'] == COMPLETE and receipt['intentSha256'] == self._sha(intent))
        except (OSError, ValueError, RuntimeError, KeyError, TypeError):
            return self._public(identifier, 'recovery-required')
        if not self.service.lock.acquire(blocking=False):
            return self._public(identifier, 'checking')
        entered = False
        try:
            try:
                guard = self.service.HOST.host_lock(self.service.root)
                descriptor = guard.__enter__()
                entered = True
            except (OSError, ValueError, RuntimeError):
                return self._public(identifier, 'checking')
            installer = R.ReleaseRuntimeInstaller(self.enrollment, lambda: self.service.current_manifest(), self._held_guard(descriptor))
            publication, image, supported = self._source(installer)
            require(receipt['publication'] == publication and receipt['imageId'] == image['Id'])
            phase = self._checked_result(installer, publication, image, supported, receipt['result'])
            require(self._source(installer) == (publication, image, supported))
            return self._public(identifier, phase)
        except (OSError, ValueError, RuntimeError, KeyError, TypeError):
            return self._public(identifier, 'recovery-required')
        finally:
            try:
                if entered:
                    guard.__exit__(None, None, None)
            finally:
                self.service.lock.release()

    def wait(self, request, *, privileged_peer=False):
        identifier, actor = self._request(request, privileged_peer)
        self._intent(identifier, actor)
        with self._condition:
            self._condition.wait_for(lambda: identifier not in self._active, timeout=WAIT_SECONDS)
        return self.status({'id': identifier, 'actor': actor}, privileged_peer=True)
