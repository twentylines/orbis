"""Opt-in private capture custody in a separately enrolled Sentinel bundle."""

import os
import json
from pathlib import Path
import re
import selectors
import stat
import subprocess
import time
from contextlib import contextmanager


CAPABILITY = {'schema': 'orbis-sentinel.capture-custody.v1', 'version': 1,
              'operations': ['reserve', 'retain-draft'],
              'mutations': 'private-capture-data-only', 'lifecycleAuthority': False}
PROFILE = 'sentinel-capture.json'
RECEIPT = 'sentinel-custody.json'
IMAGE_PREFLIGHT = 'sentinel-image-preflight.json'
IMAGE_CHECK_CAPABILITY = {
    'schema': 'orbis-sentinel.capture-image-check-capability.v1', 'version': 1,
    'operations': ['check-publication-image', 'reserve-for-publication'], 'lifecycleAuthority': False,
}
PUBLICATION_CAPABILITY = {
    'schema': 'orbis-sentinel.capture-publication.v1', 'version': 1,
    'operations': ['publish'], 'pointVersion': 3,
    'publicationSchema': 'orbis.core-capture-catalog-publication.v1',
    'lifecycleAuthority': False, 'incompleteReplay': 'forbidden',
}
IMAGE_WORKERS = {
    'publication': {'schema': 'orbis.core-capture-publication-capability.v1', 'version': 1, 'pointVersion': 3, 'payloadFormat': 'orbis.time-machine-core.v1', 'publicationSchema': 'orbis.core-capture-publication.v1', 'dataRoot': '/data', 'verification': 'authenticated-stream-and-images.v1', 'mutations': 'private-verification-staging-only'},
    'seal': {'schema': 'orbis.core-capture-seal-capability.v1', 'version': 1, 'pointVersion': 3, 'payloadFormat': 'orbis.time-machine-core.v1', 'dataRoot': '/data', 'mutations': 'staged-point-files-only'},
    'catalog': {'schema': 'orbis.core-capture-catalog-capability.v1', 'version': 1, 'pointVersion': 3, 'payloadFormat': 'orbis.time-machine-core.v1', 'publicationSchema': 'orbis.core-capture-catalog-publication.v1', 'dataRoot': '/data', 'verification': 'authenticated-stream-and-images.v1', 'mutations': 'read-only-data-with-private-staging'},
    'image-inventory': {'schema': 'orbis.core-image-inventory-capability.v1', 'version': 1, 'dataRoot': '/data', 'mutations': 'image-inventory-output-only'},
}


class SentinelCaptureCustody:
    def __init__(self, manager, worker, namespace):
        self.manager, self.W, self.namespace = manager, worker, namespace

    def _read(self, directory, name):
        with self.W.A.protected_directory(directory) as parent:
            with self.W.A.protected_file(parent, name, 8192) as body:
                value = self.W.P.metadata(body, byte_limit=8192)
                if not isinstance(value, dict) or self.W.P.canonical(value) != body:
                    raise self.W.AdmissionError('Invalid Sentinel capture custody record')
                return value

    def _profile(self):
        path = self.manager.state / PROFILE
        try:
            path.lstat()
        except FileNotFoundError:
            return None
        value = self._read(path.parent, path.name)
        automatic = value.get('schema') == 'orbis.host.sentinel-capture-profile.v2'
        if (set(value) != {'schema', 'installationId', 'catalogDirectory', 'recoveryImageId', 'bundleDirectory', 'bundleSha256'} | ({'publication'} if automatic else set())
                or value['schema'] not in {'orbis.host.sentinel-capture-profile.v1', 'orbis.host.sentinel-capture-profile.v2'}
                or automatic and value['publication'] != 'sentinel.v1'
                or any(not isinstance(value[k], str) or not self.W.HASH.fullmatch(value[k])
                       for k in ('installationId', 'bundleSha256'))
                or not isinstance(value['recoveryImageId'], str)
                or not re.fullmatch(r'sha256:[0-9a-f]{64}', value['recoveryImageId'])
                or any(not isinstance(value[k], str) or not os.path.isabs(value[k])
                       or os.path.realpath(value[k]) != value[k] for k in ('catalogDirectory', 'bundleDirectory'))):
            raise self.W.AdmissionError('The Sentinel capture profile needs review')
        return value

    def _bundle(self, profile):
        base = Path(profile['bundleDirectory'])
        hashes = {}
        for relative in ('bin', 'src/orbis_sentinel'):
            with self.W.A.protected_directory(base / relative, private=False) as directory:
                names = ['orbis-sentinel-capture'] if relative == 'bin' else os.listdir(directory)
                if (not 1 <= len(names) <= 64 or any(not re.fullmatch(r'[a-z_][a-z_0-9]*\.py', n) for n in names)
                        and relative != 'bin'):
                    raise self.W.AdmissionError('The enrolled Sentinel source is invalid')
                for name in sorted(names):
                    with self.W.A.protected_file(directory, name, 1024 * 1024, private=False) as body:
                        hashes[relative + '/' + name] = self.W.digest(body)
        if self.W.digest(self.W.P.canonical(hashes)) != profile['bundleSha256']:
            raise self.W.AdmissionError('The enrolled Sentinel source changed')
        return base / 'bin/orbis-sentinel-capture'

    def _invoke(self, profile, operation, request=None, descriptor=None):
        launcher = self._bundle(profile)
        command = ['/usr/bin/python3', '-I', '-B', str(launcher), '--' + operation]
        if descriptor is not None:
            command.extend([{'reserve': '--key-fd', 'reserve-for-publication': '--key-fd',
                             'retain-draft': '--point-fd', 'publish': '--checkpoint-fd'}[operation], str(descriptor)])
        body = b'' if request is None else json.dumps(request, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf8')
        if len(body) > 8192:
            raise self.W.AdmissionError('Invalid Sentinel custody handoff size')
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 close_fds=True, pass_fds=() if descriptor is None else (descriptor,),
                                 env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'HOME': '/'})
        output = [bytearray(), bytearray()]
        try:
            child.stdin.write(body)
            child.stdin.close()
            deadline = time.monotonic() + (4 * 60 * 60 if operation == 'publish' else
                                         600 if operation in {'reserve-for-publication', 'check-publication-image'} else 60)
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ, 0)
                selector.register(child.stderr, selectors.EVENT_READ, 1)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise self.W.AdmissionError('Sentinel custody did not finish')
                    for key, _ in selector.select(remaining):
                        block = os.read(key.fileobj.fileno(), 4096)
                        if not block:
                            selector.unregister(key.fileobj)
                            continue
                        output[key.data].extend(block)
                        if len(output[key.data]) > 8192:
                            raise self.W.AdmissionError('Invalid Sentinel custody response')
            if child.wait(timeout=max(0.01, deadline - time.monotonic())) != 0:
                raise self.W.AdmissionError('Sentinel could not retain the capture data')
        finally:
            if child.poll() is None:
                child.kill()
            child.wait()
            child.stdout.close()
            child.stderr.close()
            child.stdin.close()
        self._bundle(profile)
        return self.W.P.metadata(bytes(output[0]), byte_limit=8192)

    @contextmanager
    def _child(self, parent, name, directory=True):
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | (os.O_DIRECTORY if directory else os.O_NONBLOCK)
        descriptor = os.open(name, flags, dir_fd=parent)
        try:
            before = os.fstat(descriptor)
            if (before.st_uid != self.W.A.OWNER
                    or stat.S_IMODE(before.st_mode) != (0o700 if directory else 0o600)
                    or (not stat.S_ISDIR(before.st_mode) if directory else
                        not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != 32)):
                raise self.W.AdmissionError('The original capture storage is not private')
            yield descriptor
            seal = self.W.identity if directory else self.W.A.seal
            if (seal(before) != seal(os.fstat(descriptor))
                    or seal(before) != seal(os.stat(name, dir_fd=parent, follow_symlinks=False))):
                raise self.W.AdmissionError('The original capture storage changed')
        finally:
            os.close(descriptor)

    def require_reserved(self, point, preparation):
        profile = self._profile()
        path = self.manager.directory(point) / RECEIPT
        try:
            path.lstat()
        except FileNotFoundError:
            orphan = path.parent / IMAGE_PREFLIGHT
            if profile is None and not (orphan.exists() or orphan.is_symlink()):
                return None
            raise self.W.AdmissionError('This capture has no Sentinel reservation')
        if profile is None:
            raise self.W.AdmissionError('The reserved Sentinel profile is unavailable')
        receipt = self._read(path.parent, path.name)
        preflight = None
        if receipt.get('schema') == 'orbis.host.sentinel-custody.v2':
            preflight = self._read(path.parent, IMAGE_PREFLIGHT)
            self._validate_image_preflight(profile, preflight)
        elif (path.parent / IMAGE_PREFLIGHT).exists() or (path.parent / IMAGE_PREFLIGHT).is_symlink():
            raise self.W.AdmissionError('This capture has conflicting Sentinel publication selection')
        expected = self._receipt(profile, point, preparation['sourceSha256'], preparation['pointReservationSha256'], preflight)
        if self.W.P.canonical(receipt) != self.W.P.canonical(expected):
            raise self.W.AdmissionError('The Sentinel capture reservation changed')
        return profile

    def _validate_image_preflight(self, profile, value):
        expected = {'schema': 'orbis-sentinel.capture-image-preflight.v1', 'imageId': profile['recoveryImageId'],
                    'workers': IMAGE_WORKERS, 'lifecycleAuthority': False}
        if self.W.P.canonical(value) != self.W.P.canonical(expected):
            raise self.W.AdmissionError('The approved image cannot independently publish this capture')

    def preflight_publication(self):
        """Reject unsupported images before creating a capture preparation identity."""
        profile = self._profile()
        if profile is None:
            raise self.W.AdmissionError('Independent publication requires an enrolled Sentinel')
        if self.W.P.canonical(self._invoke(profile, 'image-check-capability')) != self.W.P.canonical(IMAGE_CHECK_CAPABILITY):
            raise self.W.AdmissionError('The enrolled Sentinel cannot preflight publication images')
        reader = self.W.load('orbis-host-sentinel-reader.py', 'sentinel_custody_export_capability')
        for operation, capability in (('publication-capability', PUBLICATION_CAPABILITY), ('export-capability', reader.EXPORT_CAPABILITY)):
            if self.W.P.canonical(self._invoke(profile, operation)) != self.W.P.canonical(capability):
                raise self.W.AdmissionError('The enrolled Sentinel cannot publish and transfer this capture')
        request = {'schema': 'orbis-sentinel.capture-check-publication-image.v1',
                   'catalogDirectory': profile['catalogDirectory'], 'recoveryImageId': profile['recoveryImageId']}
        reply = self._invoke(profile, 'check-publication-image', request)
        if (not isinstance(reply, dict) or set(reply) != {'schema', 'operation', 'result'}
                or reply['schema'] != 'orbis-sentinel.capture-custody-result.v1'
                or reply['operation'] != 'check-publication-image'):
            raise self.W.AdmissionError('Sentinel did not verify its approved publication image')
        self._validate_image_preflight(profile, reply['result'])
        if self._profile() != profile:
            raise self.W.AdmissionError('The Sentinel profile changed during image preflight')
        return reply['result']

    def require_publication_reserved(self, point, preparation):
        profile = self.require_reserved(point, preparation)
        if profile is None or self._read(self.manager.directory(point), RECEIPT).get('schema') != 'orbis.host.sentinel-custody.v2':
            raise self.W.AdmissionError('Independent publication was not selected before capture')
        return profile

    def publication_mode(self, point, preparation):
        if self.require_reserved(point, preparation) is None:
            return 'controller-restart.v1'
        receipt = self._read(self.manager.directory(point), RECEIPT)
        return 'sentinel.v1' if receipt['schema'] == 'orbis.host.sentinel-custody.v2' else 'controller-restart.v1'

    def _receipt(self, profile, point, source, reservation, preflight=None):
        result = {'schema': 'orbis.host.sentinel-custody.v1', 'id': point,
                'profileSha256': self.W.digest(self.W.P.canonical(profile)),
                'sourceSha256': source, 'pointReservationSha256': reservation}
        if preflight is not None:
            result.update(schema='orbis.host.sentinel-custody.v2', publication='sentinel.v1',
                          imagePreflightSha256=self.W.digest(self.W.P.canonical(preflight)))
        return result

    def _source_directories(self, reader, source, time_machine):
        frame = source.controller
        value = reader._object(['container', 'inspect', '--format', '{{json .}}', frame['id']])
        state = value.get('State', {})
        if (value.get('Id') != frame['id'] or value.get('Image') != frame['imageId']
                or state.get('Running') is not True or state.get('StartedAt') != frame['startedAt']
                or state.get('Pid') != source.pid or type(state.get('Pid')) is not int
                or not isinstance(value.get('Mounts'), list) or len(value['Mounts']) > 256):
            raise self.W.AdmissionError('The original controller storage changed')
        target = '/data/backups/time-machine'
        covering, roots = [], set()
        for mount in value['Mounts']:
            destination = mount.get('Destination') if isinstance(mount, dict) else None
            if (not isinstance(destination, str) or not os.path.isabs(destination)
                    or os.path.normpath(destination) != destination):
                raise self.W.AdmissionError('The controller storage layout is invalid')
            covers = os.path.commonpath((destination, target)) == destination
            if covers:
                covering.append(mount)
            if mount.get('Type') not in {'bind', 'volume'}:
                continue
            path = mount.get('Source')
            if not isinstance(path, str) or not os.path.isabs(path):
                raise self.W.AdmissionError('The controller storage backing is unavailable')
            path = os.path.realpath(path)
            if mount.get('RW') is True and os.path.isdir(path):
                roots.add(path)
        if not covering:
            raise self.W.AdmissionError('The Time Machine backing mount is unavailable')
        deepest = max(len(row['Destination']) for row in covering)
        selected = [row for row in covering if len(row['Destination']) == deepest]
        if len(selected) != 1 or selected[0].get('Type') not in {'bind', 'volume'}:
            raise self.W.AdmissionError('The Time Machine backing mount is ambiguous')
        mount = selected[0]
        roots.add(os.path.realpath(mount['Source']))
        backing = os.path.realpath(os.path.join(mount['Source'], os.path.relpath(target, mount['Destination'])))
        descriptor = os.open(backing, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            expected = self.W.identity(os.fstat(time_machine))
            if (self.W.identity(os.fstat(descriptor)) != expected
                    or self.W.identity(os.stat(backing, follow_symlinks=False)) != expected):
                raise self.W.AdmissionError('The host backing differs from the original capture namespace')
        finally:
            os.close(descriptor)
        roots.add(backing)
        if len(roots) > 64:
            raise self.W.AdmissionError('The controller storage layout exceeds capture limits')
        return sorted(roots)

    def reserve(self, reader, point, observed, reservation, *, for_publication=False):
        profile = self._profile()
        if profile is None:
            if for_publication:
                raise self.W.AdmissionError('Independent publication requires an enrolled Sentinel')
            return
        if self._invoke(profile, 'capability') != CAPABILITY:
            raise self.W.AdmissionError('The enrolled Sentinel does not support capture custody')
        operation = 'reserve-for-publication' if for_publication else 'reserve'
        if for_publication and self.W.P.canonical(self._invoke(profile, 'image-check-capability')) != self.W.P.canonical(IMAGE_CHECK_CAPABILITY):
            raise self.W.AdmissionError('The enrolled Sentinel cannot preflight publication images')
        request = {'schema': 'orbis-sentinel.capture-' + operation + '.v1', 'catalogDirectory': profile['catalogDirectory'],
                   'dataDirectory': str(self.manager.root), 'jobId': point.replace('-', ''),
                   'installationId': profile['installationId'], 'sourceSha256': observed['sourceSha256'],
                   'recoveryImageId': profile['recoveryImageId'], 'reservation': reservation}
        with self.namespace.CaptureNamespace(self.W, reader, observed['controller']) as source:
            with source.directory(storage_only=True) as base, self._child(base, 'keys') as keys:
                directories = self._source_directories(reader, source, base)
                request['sourceDirectories'] = directories
                with self._child(keys, 'master-v1.key', False) as key:
                    reply = self._invoke(profile, operation, request, key)
                if self._source_directories(reader, source, base) != directories:
                    raise self.W.AdmissionError('The controller storage changed during Sentinel reservation')
        expected = {'id': point, 'jobId': request['jobId'], 'installationId': profile['installationId'],
                    'sourceSha256': observed['sourceSha256'], 'ownerId': reservation['ownerId'],
                    'createdAt': reservation['createdAt'], 'dataState': 'reserved', 'lifecycleState': 'unobserved',
                    'archiveBytes': 0, 'files': []}
        preflight = None
        if for_publication:
            result = reply.get('result') if isinstance(reply, dict) else None
            if not isinstance(result, dict) or set(result) != {'custody', 'imagePreflight'}:
                raise self.W.AdmissionError('Sentinel did not verify its publication image before custody')
            preflight = result['imagePreflight']
            self._validate_image_preflight(profile, preflight)
            expected = {'custody': expected, 'imagePreflight': preflight}
        if self.W.P.canonical(reply) != self.W.P.canonical({'schema': 'orbis-sentinel.capture-custody-result.v1', 'operation': operation, 'result': expected}):
            raise self.W.AdmissionError('Sentinel retained a different capture reservation')
        if self._profile() != profile:
            raise self.W.AdmissionError('The Sentinel profile changed during reservation')
        if preflight is not None:
            self.W.RESERVED.create_atomic(self.W, self.manager.directory(point), IMAGE_PREFLIGHT, preflight)
        receipt = self._receipt(profile, point, observed['sourceSha256'], self.W.digest(self.W.P.canonical(reservation)), preflight)
        self.W.RESERVED.create_atomic(self.W, self.manager.directory(point), RECEIPT, receipt)

    def retain_draft(self, reader, point, preparation, source_hold_sha256):
        profile = self.require_reserved(point, preparation)
        if profile is None:
            return
        preparation_sha256 = self.W.digest(self.W.P.canonical(preparation))
        request = {'schema': 'orbis-sentinel.capture-retain-draft.v1', 'catalogDirectory': profile['catalogDirectory'],
                   'pointId': point, 'preparationSha256': preparation_sha256, 'sourceHoldSha256': source_hold_sha256}
        with self.namespace.CaptureNamespace(self.W, reader, preparation['controller']) as source:
            if self.publication_mode(point, preparation) == 'sentinel.v1':
                with source.directory(point) as directory:
                    with self.W.A.protected_file(directory, 'publisher.json', 8192) as body:
                        expected = {'schema': 'orbis.core-capture-publisher.v1', 'publisher': 'sentinel.v1', 'id': point,
                                    'preparationSha256': preparation_sha256, 'sourceSha256': preparation['sourceSha256'],
                                    'pointReservationSha256': preparation['pointReservationSha256'],
                                    'controller': preparation['controller']}
                        if self.W.P.canonical(self.W.P.metadata(body, byte_limit=8192)) != self.W.P.canonical(expected):
                            raise self.W.AdmissionError('The original Orbis publisher intent is unavailable')
            with source.directory(storage_only=True) as base, self._child(base, 'points') as points:
                with self._child(points, point) as directory:
                    reply = self._invoke(profile, 'retain-draft', request, directory)
        result = reply.get('result') if isinstance(reply, dict) else None
        if (not isinstance(reply, dict) or set(reply) != {'schema', 'operation', 'result'}
                or reply['schema'] != 'orbis-sentinel.capture-custody-result.v1' or reply['operation'] != 'retain-draft'
                or not isinstance(result, dict) or set(result) != {'id', 'dataState', 'lifecycleState', 'preparationSha256', 'sourceHoldSha256', 'files'}
                or result['id'] != point or result['dataState'] != 'retained-unverified'
                or result['lifecycleState'] != 'unobserved' or result['preparationSha256'] != preparation_sha256
                or result['sourceHoldSha256'] != source_hold_sha256 or not isinstance(result['files'], list)
                or any(not isinstance(name, str) for name in result['files'])
                or result['files'] != sorted(set(result['files']))
                or not {'point.json', 'capture-draft.orbis'} <= set(result['files']) <= {'point.json', 'capture-draft.orbis', 'wallpaper.orbis', 'icons.orbis'}):
            raise self.W.AdmissionError('Sentinel retained a different capture draft')
        self.require_reserved(point, preparation)
        return True
