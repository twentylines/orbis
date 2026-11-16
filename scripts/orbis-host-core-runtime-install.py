"""Enroll restore workers from the independently verified, installed release."""
import argparse
from contextlib import contextmanager
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import sys
import tarfile
from types import SimpleNamespace
from urllib.parse import quote
import uuid


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module


POLICY = load('orbis-host-core-preparation-policy.py', 'orbis_release_runtime_policy')
E = load('orbis-host-core-portable-enrollment.py', 'orbis_release_runtime_enrollment')
CHECK = load('orbis-release-check.py', 'orbis_release_runtime_verification')
PROTOCOL = 'orbis.core-restore-release.v1'
LABEL = 'io.orbis.core-restore-runtime'
QUALIFICATION = {'schema': 'orbis.core-restore-source-qualification.v1', 'scope': 'same-published-controller-only',
    'parserProfile': POLICY.I.C.PARSER, 'configuration': 'captured-complete-configuration',
    'sourceWrites': False, 'activation': False}
ROOTS = {'core-inspection-worker.mjs', 'core-source-configuration-worker.mjs',
         'core-clean-target-bootstrap-worker.mjs', 'core-clean-target-worker.mjs'}
OPTIONAL_ROOTS = {'core-restoration-worker.mjs', 'core-live-reconciliation-worker.mjs'}
FLAGS = {'activation': False, 'restoreAuthority': False, 'sourceWrites': False}


def require(value):
    if not value:
        raise ValueError('Restore support could not be prepared. Orbis and saved data were kept.')


class ReleaseRuntimeInstaller:
    def __init__(self, enrollment, installed_publication, guard, *, verify_release=CHECK.check):
        require(callable(installed_publication) and callable(guard) and callable(verify_release))
        self.enrollment, self.P, self.runtime = enrollment, enrollment.P, enrollment.runtime
        self.installed_publication, self.guard, self.verify_release = installed_publication, guard, verify_release
        self.policies = POLICY.CleanTargetMigrationPolicies(enrollment)
        self.registry = self.policies.registry
        self.base = Path(enrollment.state) / 'core-runtime-release-installs'

    def digest(self, value):
        return hashlib.sha256(self.P.canonical(value)).hexdigest()

    def manifest(self, value):
        require(self.P.exact(value, {'schema', 'parserProfile', 'workers', 'migrations', 'graph', 'qualification'})
                and value['schema'] == PROTOCOL and value['parserProfile'] == POLICY.I.C.PARSER
                and self.P.canonical(value['qualification']) == self.P.canonical(QUALIFICATION)
                and self.P.exact(value['workers'], {'files'}))
        files = value['workers']['files']
        require(type(files) is dict and ROOTS <= set(files) and len(files) <= 64)
        total = 0
        for name, details in files.items():
            require(isinstance(name, str) and (name in ROOTS | OPTIONAL_ROOTS or re.fullmatch(r'core-publication-[a-z0-9-]{1,80}\.mjs', name))
                    and self.P.exact(details, {'bytes', 'sha256'}) and type(details['bytes']) is int
                    and 0 < details['bytes'] <= 16 * 1024 ** 2
                    and isinstance(details['sha256'], str) and POLICY.I.C.HEX.fullmatch(details['sha256']))
            total += details['bytes']
        require(total <= 64 * 1024 ** 2)
        self.policies.manifest(value['migrations'], value['graph'])
        return copy.deepcopy(value)

    def directory(self, identifier):
        require(isinstance(identifier, str) and POLICY.I.C.UUID.fullmatch(identifier))
        directory = self.base / identifier
        with self.enrollment.a.protected_directory(directory):
            pass
        return directory

    def read(self, path, maximum=2 * 1024 ** 2):
        body = self.enrollment.read(path, maximum)
        value = self.P.metadata(body, byte_limit=maximum)
        require(body == self.P.canonical(value))
        return value

    def save(self, job):
        self.enrollment.a.atomic(self.directory(job['id']) / 'job.json', self.P.canonical(job))

    def image(self, publication):
        reference = publication['image'] + '@' + publication['digest']
        image = self.runtime.image(reference)
        require(isinstance(image.get('Id'), str) and POLICY.I.C.IMAGE.fullmatch(image['Id'])
                and image.get('Os') == 'linux' and image.get('Architecture') in {'amd64', 'arm64'}
                and reference in (image.get('RepoDigests') or [])
                and (image.get('Config') or {}).get('Volumes') in (None, {}))
        labels = image['Config'].get('Labels') or {}
        require(labels.get('org.opencontainers.image.source') == 'https://github.com/twentylines/orbis'
                and labels.get('org.opencontainers.image.version') == publication['tag']
                and labels.get('org.opencontainers.image.revision') == publication['commit'])
        return image

    def verified(self):
        publication = CHECK.PLAN.validate_manifest(self.installed_publication())
        reference = publication['image'] + '@' + publication['digest']
        observed = self.runtime.image(reference)
        require(isinstance(observed.get('Id'), str) and POLICY.I.C.IMAGE.fullmatch(observed['Id'])
                and reference in (observed.get('RepoDigests') or []))
        advertised = ((observed.get('Config') or {}).get('Labels') or {}).get(LABEL)
        if advertised != PROTOCOL:
            return publication, observed, False
        image = self.image(publication)
        published = self.verify_release(publication['tag'])
        require(isinstance(published, dict) and published.get('tag') == publication['tag']
                and published.get('commit') == publication['commit']
                and published.get('image') == publication['image'] + '@' + publication['digest']
                and published.get('runtipiCompatibility') == publication['runtipiCompatibility'])
        return publication, image, True

    def existing(self, publication, image, manifest):
        manifest = self.manifest(manifest)
        pointer = self.registry.base / 'current.json'
        if not pointer.exists() and not pointer.is_symlink():
            return None
        selected = self.read(pointer, 16384)
        require(self.P.exact(selected, {'schema', 'id', 'installationSha256'}) and selected['schema'] == POLICY.I.POINTER)
        selection = POLICY.I.InstalledSelection(selected['id'], selected['installationSha256'])
        with self.registry.policy_lock(selection) as directory:
            self.registry.not_revoked(directory)
            record = self.read(directory / 'installation.json', 1024 ** 2)
        if record['releaseSha256'] != self.digest(publication) or record['coordinator']['imageId'] != image['Id']:
            return None
        broker = self.registry.configuration(image['Id'], selection)
        require(broker.trust.image_id == image['Id'] and broker.trust.architecture == image['Architecture'])
        policy_file = self.registry.base / 'generations' / selection.identifier / 'clean-target-migrations' / (image['Id'][7:] + '.json')
        if not policy_file.exists() and not policy_file.is_symlink():
            return None
        policy = self.policies.read(selection, image['Id'])
        require(policy['releaseSha256'] == self.digest(publication))
        require(broker.code() == manifest['workers']['files'] and policy['inventory'] == manifest['migrations']
                and policy['graph'] == manifest['graph']
                and record['qualifiedSources'] == {image['Id']: {'parserProfile': POLICY.I.C.PARSER,
                    'qualificationSha256': self.digest(manifest['qualification'])}})
        return {'version': 1, 'state': 'installed', 'imageId': image['Id'], 'installedRuntime': {
            'id': selection.identifier, 'installationSha256': selection.installation_sha256},
            'migrationPolicySha256': self.digest(policy), **FLAGS}

    def cached(self, publication, image):
        if not self.base.exists() and not self.base.is_symlink():
            return None
        with self.enrollment.a.protected_directory(self.base):
            entries = list(self.base.iterdir())
        require(len(entries) < 256)
        for path in entries:
            job = self.read(self.directory(path.name) / 'job.json')
            if job.get('phase') != 'complete' or job.get('publication') != publication or job.get('imageId') != image['Id']:
                continue
            require(job.get('schema') == 'orbis.core-runtime-release-install.v1' and job.get('id') == path.name
                    and job.get('root') == str(self.enrollment.root) and job.get('context') == self.enrollment.context)
            manifest = self.read(path / 'manifest.json')
            require(self.digest(manifest) == job.get('manifestSha256'))
            retired = self.read(path / 'carrier-retired.json', 16384)
            require(retired == {'schema': 'orbis.core-runtime-install-carrier-retired.v1', 'id': job['id'],
                'carrierId': job['carrierId'], 'definitionSha256': job['definitionSha256'], 'neverStarted': True})
            result = self.existing(publication, image, manifest)
            if result is not None and result == job.get('result'):
                return result
        return None

    def pending(self, publication, image):
        if not self.base.exists() and not self.base.is_symlink():
            return None
        with self.enrollment.a.protected_directory(self.base):
            entries = list(self.base.iterdir())
        require(len(entries) < 256)
        pending = []
        for path in entries:
            job = self.read(self.directory(path.name) / 'job.json')
            require(job.get('schema') == 'orbis.core-runtime-release-install.v1' and job.get('id') == path.name
                    and job.get('root') == str(self.enrollment.root) and job.get('context') == self.enrollment.context)
            if job.get('phase') in {'complete', 'failed-retired'}:
                continue
            require(job.get('publication') == publication and job.get('imageId') == image['Id'])
            retired = self.read(path / 'carrier-retired.json', 16384)
            require(retired == {'schema': 'orbis.core-runtime-install-carrier-retired.v1', 'id': job['id'],
                'carrierId': job['carrierId'], 'definitionSha256': job['definitionSha256'], 'neverStarted': True})
            require(job.get('phase') == 'extracted')
            pending.append(job)
        require(len(pending) <= 1)
        return pending[0] if pending else None

    def carrier(self, job):
        raw = self.runtime.inspect(job['carrierId'])
        self.runtime.check_intent(raw, job['body'])
        require(raw['Id'] == job['carrierId'] and raw['Image'] == job['imageId'] and self.runtime.never_started(raw)
                and raw['State'].get('Status') == 'created' and raw.get('Mounts') == [])
        definition = self.runtime.definition(raw)
        require(job.get('definitionSha256', definition) == definition)
        changes = self.P.metadata(b'{"changes":' + self.runtime.engine('GET', '/containers/' + raw['Id'] + '/changes', maximum=4096) + b'}')
        require(changes['changes'] in (None, []))
        return definition

    def file(self, job, name, maximum):
        require(re.fullmatch(r'[A-Za-z0-9_.-]+', name))
        route = '/containers/' + job['carrierId'] + '/archive?path=' + quote('/app/' + name, safe='')
        body = self.runtime.engine('GET', route, maximum=maximum + 32768)

        class PlainTar(tarfile.TarInfo):
            def _proc_member(self, archive):
                require(self.type in {tarfile.REGTYPE, tarfile.AREGTYPE})
                return super()._proc_member(archive)

        with tarfile.open(fileobj=io.BytesIO(body), mode='r:', tarinfo=PlainTar) as archive:
            members = archive.getmembers()
            require(len(members) == 1)
            item = members[0]
            require(item.name == name and item.isfile() and not item.pax_headers and not item.linkname
                    and item.uid == 0 and item.mode & 0o022 == 0 and 0 < item.size <= maximum)
            value = archive.extractfile(item).read(maximum + 1)
            require(len(value) == item.size)
            return value

    def retire(self, job):
        require(self.carrier(job) == job['definitionSha256'])
        job['phase'] = 'retiring'
        self.save(job)
        self.runtime.engine('DELETE', '/containers/' + job['carrierId'] + '?v=false')
        require(self.runtime.engine('GET', '/containers/' + job['carrierId'] + '/json', allow_missing=True) is None)
        value = {'schema': 'orbis.core-runtime-install-carrier-retired.v1', 'id': job['id'],
                 'carrierId': job['carrierId'], 'definitionSha256': job['definitionSha256'], 'neverStarted': True}
        self.enrollment.immutable(self.directory(job['id']) / 'carrier-retired.json', self.P.canonical(value))

    def extract(self, publication, image):
        self.base = self.enrollment.child(Path(self.enrollment.state), self.base.name)
        self.enrollment.sync(Path(self.enrollment.state))
        identifier = str(uuid.uuid4())
        directory = self.base / identifier
        directory.mkdir(mode=0o700)
        self.enrollment.sync(self.base)
        body = {'Image': image['Id'], 'User': '0:0', 'Entrypoint': ['/bin/true'], 'Cmd': [], 'Env': [], 'WorkingDir': '/app',
            'Healthcheck': {'Test': ['NONE']}, 'Labels': {'io.orbis.core-runtime-install': identifier},
            'HostConfig': POLICY.B.TARGET.SOURCE.host({'pids': 16, 'memory': 64 * 1024 ** 2}) | {'Mounts': []},
            'NetworkingConfig': {'EndpointsConfig': {'none': {}}}}
        job = {'schema': 'orbis.core-runtime-release-install.v1', 'id': identifier, 'root': str(self.enrollment.root),
               'context': self.enrollment.context, 'publication': publication, 'imageId': image['Id'],
               'architecture': image['Architecture'], 'body': body, 'phase': 'creating', **FLAGS}
        self.save(job)
        response = self.P.metadata(self.runtime.engine('POST', '/containers/create?name=orbis-runtime-install-' + identifier, body))
        require(isinstance(response.get('Id'), str) and re.fullmatch(r'[a-f0-9]{64}', response['Id']))
        job.update(carrierId=response['Id'], phase='created')
        extracted = False
        try:
            self.save(job)
            job['definitionSha256'] = self.carrier(job)
            self.save(job)
            manifest_body = self.file(job, 'core-restore-runtime.json', 2 * 1024 ** 2)
            manifest = self.manifest(self.P.metadata(manifest_body, byte_limit=2 * 1024 ** 2))
            require(manifest_body == self.P.canonical(manifest))
            self.enrollment.immutable(directory / 'manifest.json', manifest_body)
            job['manifestSha256'] = self.digest(manifest)
            self.save(job)
            code = self.enrollment.child(directory, 'code')
            self.enrollment.sync(directory)
            for name, expected in manifest['workers']['files'].items():
                value = self.file(job, name, 16 * 1024 ** 2)
                require(len(value) == expected['bytes'] and hashlib.sha256(value).hexdigest() == expected['sha256'])
                self.enrollment.immutable(code / name, value)
            self.enrollment.sync(code)
            archive = self.runtime.bounded_output(['docker', '--context', self.enrollment.context, 'container', 'cp',
                job['carrierId'] + ':/app/assets/migrations/.', '-'], 32 * 1024 ** 2, 30)
            files, _, graph = POLICY.B.migration_bundle(archive)
            inventory = {'schema': POLICY.INVENTORY, 'files': {
                name: {'bytes': len(value), 'sha256': hashlib.sha256(value).hexdigest()} for name, value in files.items()}}
            require(inventory == manifest['migrations'] and graph == manifest['graph'])
            extracted = True
        finally:
            if 'definitionSha256' not in job:
                job['definitionSha256'] = self.carrier(job)
            self.retire(job)
            job['phase'] = 'extracted' if extracted else 'failed-retired'
            self.save(job)
        return job

    def enroll(self, job, publication, image):
        directory = self.directory(job['id'])
        manifest = self.manifest(self.read(directory / 'manifest.json'))
        require(self.digest(manifest) == job.get('manifestSha256'))
        trust = POLICY.I.C.TrustedCoordinator(image['Id'], image['Architecture'], directory / 'code',
            manifest['workers']['files'], image['Id'], POLICY.I.C.PARSER)
        broker = POLICY.I.C.CoreSourceConfigurationPreparation(self.enrollment, trust)
        broker.image()
        require(broker.code() == manifest['workers']['files'])
        pointer = self.registry.base / 'current.json'
        selection = None
        if pointer.exists() or pointer.is_symlink():
            value = self.read(pointer, 16384)
            require(self.P.exact(value, {'schema', 'id', 'installationSha256'}) and value['schema'] == POLICY.I.POINTER)
            candidate = POLICY.I.InstalledSelection(value['id'], value['installationSha256'])
            with self.registry.policy_lock(candidate) as generation:
                self.registry.not_revoked(generation)
                record = self.read(generation / 'installation.json', 1024 ** 2)
            if (record['releaseSha256'] == self.digest(publication) and record['coordinator'] == {
                    'imageId': image['Id'], 'architecture': image['Architecture'], 'files': manifest['workers']['files']}
                    and record['qualifiedSources'] == {image['Id']: {'parserProfile': POLICY.I.C.PARSER,
                        'qualificationSha256': self.digest(manifest['qualification'])}}):
                selection = candidate
        if selection is None:
            approved = POLICY.I.RootInstallationApproval(trust, self.digest(publication), self.digest(manifest['workers']['files']),
                {image['Id']: {'parserProfile': POLICY.I.C.PARSER, 'qualificationSha256': self.digest(manifest['qualification'])}})
            installed = self.registry.install(approved)
            selection = POLICY.I.InstalledSelection(installed['id'], installed['installationSha256'])
        approval = POLICY.RootMigrationPolicyApproval(selection, image['Id'], self.digest(publication),
            manifest['migrations'], self.digest(manifest['migrations']), manifest['graph'], self.digest(manifest['graph']))
        self.policies.install(approval)
        result = self.existing(publication, image, manifest)
        require(result is not None)
        job.update(phase='complete', result=result)
        self.save(job)
        return result

    def install(self):
        POLICY.I.require_root()
        with self.guard():
            publication, image, supported = self.verified()
            if not supported:
                return {'version': 1, 'state': 'not-supported', 'reason': 'installed-version', **FLAGS}
            job = self.pending(publication, image)
            if job is None:
                existing = self.cached(publication, image)
                if existing is not None:
                    return existing
                job = self.extract(publication, image)
            return self.enroll(job, publication, image)


def install_current_locked(root, context, host, installed_publication, *, state=Path('/var/lib/orbis/state')):
    """The installer holds the enrolled host lock; no old controller API is used."""
    POLICY.I.require_root()
    descriptor = host.LOCK_DESCRIPTOR.get()
    require(type(descriptor) is int)
    before = os.fstat(descriptor)

    @contextmanager
    def held_guard():
        require(host.LOCK_DESCRIPTOR.get() == descriptor and os.fstat(descriptor) == before)
        yield
        require(host.LOCK_DESCRIPTOR.get() == descriptor and os.fstat(descriptor) == before)

    retained = load('orbis-host-retained-restore.py', 'orbis_runtime_install_retained')
    service = SimpleNamespace(HOST=host, root=Path(root), context=context, state_dir=state)
    manager = retained.RestoreManager(service)
    service.retained_restores = lambda: manager
    enrollment = E.CorePortableEnrollment(service)
    return ReleaseRuntimeInstaller(enrollment, installed_publication, held_guard).install()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--docker-context', required=True)
    parser.add_argument('--confirm-root', required=True)
    args = parser.parse_args()
    try:
        POLICY.I.require_root()
        service = load('orbis-host-service.py', 'orbis_runtime_install_service')
        root = args.root.resolve(strict=True)
        require(str(root) == args.confirm_root)
        with service.HOST.host_lock(root):
            result = install_current_locked(root, args.docker_context, service.HOST,
                lambda: service.installed_manifest(root, args.docker_context))
        print(json.dumps(result))
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, tarfile.TarError):
        print('Restore support needs review. Orbis and saved data were kept.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
