#!/usr/bin/env python3
"""Root review authority for an already restored retained controller.

This does not decrypt a point, import images, edit configuration, or restore data.
The root reviewer must independently verify those steps and pin review.json's
hash out of band. Container-owned point metadata is never an authorization input.
"""
import argparse
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
import stat
import sys
import tarfile
import tempfile
from contextlib import contextmanager
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('orbis_retained_identity', Path(__file__).with_name('orbis-host-identity.py'))
IDENTITY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IDENTITY)
LAYOUT_SPEC = importlib.util.spec_from_file_location('orbis_layout_for_retained_authority', Path(__file__).with_name('orbis-host-layout.py'))
LAYOUT = importlib.util.module_from_spec(LAYOUT_SPEC)
LAYOUT_SPEC.loader.exec_module(LAYOUT)
P = IDENTITY.PUBLICATION
OWNER = 0
LIMIT = 8 * 1024 * 1024
ARCHIVE_DIGEST_CACHE = {}
ARCHIVE_ROOT_CACHE = {}
REVIEW_SCHEMA = 'orbis.host.retained-review.v1'
CONFIG_PATHS = ('docker-compose.yml', '.env', 'user-config/tipi-compose.yml', 'orbis-host-compose.yml', 'orbis-compose.yml')


def fail():
    return ValueError('Protected retained controller authority could not be verified')


def seal(value):
    return tuple(getattr(value, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


@contextmanager
def protected_directory(path, *, private=True):
    path = Path(path)
    if not path.is_absolute() or str(path) != str(path.resolve(strict=True)):
        raise fail()
    descriptors = []
    bindings = []
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    descriptors.append(descriptor)
    try:
        for component in path.parts[1:]:
            parent = descriptor
            descriptor = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            descriptors.append(descriptor)
            details = os.fstat(descriptor)
            if details.st_uid not in {0, OWNER} or stat.S_IMODE(details.st_mode) & 0o022:
                raise fail()
            bindings.append((parent, component, descriptor, details))
        before = os.fstat(descriptor)
        if before.st_uid != OWNER or stat.S_IMODE(before.st_mode) & (0o077 if private else 0o022):
            raise fail()
        yield descriptor
        for parent, component, child, details in bindings:
            # Ancestor directory contents can change independently. Their inode,
            # ownership and modes must remain fixed; the final directory is sealed.
            keys = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid')
            expected = tuple(getattr(details, key) for key in keys)
            if any(tuple(getattr(value, key) for key in keys) != expected for value in
                   (os.fstat(child), os.stat(component, dir_fd=parent, follow_symlinks=False))):
                raise fail()
        if seal(before) != seal(os.fstat(descriptor)):
            raise fail()
    finally:
        for item in reversed(descriptors):
            os.close(item)


@contextmanager
def protected_file(directory, name, maximum=LIMIT, *, digest_only=False, private=True):
    if '/' in name or name in {'.', '..'}:
        raise fail()
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        before = os.fstat(descriptor)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != OWNER or before.st_nlink != 1
                or stat.S_IMODE(before.st_mode) & (0o077 if private else 0o022) or not 0 <= before.st_size <= maximum):
            raise fail()
        cache_key = (OWNER, seal(before))
        if digest_only and cache_key in ARCHIVE_DIGEST_CACHE:
            yield ARCHIVE_DIGEST_CACHE[cache_key]
            if seal(before) != seal(os.fstat(descriptor)) or seal(before) != seal(os.stat(name, dir_fd=directory, follow_symlinks=False)):
                raise fail()
            return
        chunks, count, hashed = [], 0, hashlib.sha256()
        while True:
            data = os.read(descriptor, min(1024 * 1024, maximum + 1 - count))
            if not data:
                break
            count += len(data)
            if count > maximum:
                raise fail()
            hashed.update(data)
            if not digest_only:
                chunks.append(data)
        if count != before.st_size:
            raise fail()
        result = ('sha256:' + hashed.hexdigest()) if digest_only else b''.join(chunks)
        yield result
        if seal(before) != seal(os.fstat(descriptor)) or seal(before) != seal(os.stat(name, dir_fd=directory, follow_symlinks=False)):
            raise fail()
        if digest_only:
            if len(ARCHIVE_DIGEST_CACHE) >= 32:
                ARCHIVE_DIGEST_CACHE.clear()
            ARCHIVE_DIGEST_CACHE[cache_key] = result
    finally:
        os.close(descriptor)


@contextmanager
def installation_files(root, names):
    from contextlib import ExitStack
    with ExitStack() as stack:
        directory = stack.enter_context(protected_directory(root, private=False))
        user = None
        hashes = {}
        for relative in names:
            parent = directory
            if relative.startswith('user-config/'):
                if not (root / 'user-config').exists() and not (root / 'user-config').is_symlink():
                    hashes[relative] = None
                    continue
                if user is None:
                    user = stack.enter_context(protected_directory(root / 'user-config', private=False))
                parent = user
            name = relative.split('/')[-1]
            try:
                body = stack.enter_context(protected_file(parent, name, 1024 * 1024, private=False))
            except FileNotFoundError:
                hashes[relative] = None
            else:
                hashes[relative] = hashlib.sha256(body).hexdigest()
        yield hashes


def store_path(root):
    return LAYOUT.selected_path(root, 'retained-authority')


def installation_observations(root, names, *, daemon, context):
    """Bounded hashes for capture/review, never authority to execute these files."""
    names = tuple(names)
    path = LAYOUT.selected_path(root, 'host-lock')
    if path == LAYOUT.legacy_path(root, 'host-lock'):
        with installation_files(root, names) as hashes:
            return hashes
    receipt = LAYOUT.read(root, daemon=daemon, context=context)
    plan = receipt['plan']
    return LAYOUT.observe_files(root, plan['daemon'], plan['context'], names)


def override_content(release, creation):
    # Publication environment stays canonical; only creation identity changes.
    spec = importlib.util.spec_from_file_location('orbis_retained_stage', Path(__file__).with_name('orbis-stage-release.py'))
    stage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stage)
    published = release['image'] + '@' + release['digest']
    return stage.staged_content(release).replace('    image: ' + published + '\n', '    image: ' + creation + '\n', 1)


def configuration_files(config):
    version = config.get('version') if type(config) is dict else None
    required = {'version', 'pointId', 'controller', 'rootIdentity', 'files', 'configurationSetSha256'}
    if version == 2:
        required.add('retainedIdentity')
    if (not P.exact(config, required)
            or version not in (1, 2) or type(config['files']) is not list
            or [item.get('path') for item in config['files'] if type(item) is dict] != list(CONFIG_PATHS)):
        raise fail()
    if version == 2:
        retained = config['retainedIdentity']
        required_identity = {'publishedReference', 'platform', 'platformManifestDigest', 'configDigest', 'sourceImageId', 'creationReference',
                             'pointId', 'configurationDigest', 'archiveRootId', 'descriptorDigest', 'archiveKind', 'proofDigest'}
        if (not P.exact(retained, required_identity) or retained['archiveKind'] not in {'oci', 'docker'}
                or any(not IDENTITY.hashed(retained[name]) for name in required_identity - {'publishedReference', 'platform', 'archiveKind'})):
            raise fail()
        P.platform_identity(retained['platform'], selectable=True)
    metadata = {key: value for key, value in config.items() if key != 'configurationSetSha256'}
    metadata['files'] = []
    hashes = {}
    for item in config['files']:
        if item.get('present') is False:
            if not P.exact(item, {'path', 'present'}) or item['path'] in {'docker-compose.yml', '.env', 'orbis-compose.yml'}:
                raise fail()
            digest = None
        else:
            if not P.exact(item, {'path', 'present', 'bytes', 'mode', 'uid', 'gid', 'device', 'inode', 'mtimeNs', 'ctimeNs', 'sha256', 'data'}) or item['present'] is not True:
                raise fail()
            try:
                data = base64.b64decode(item['data'], validate=True)
            except (ValueError, TypeError) as error:
                raise fail() from error
            if len(data) != item['bytes'] or len(data) > 1024 * 1024 or hashlib.sha256(data).hexdigest() != item['sha256']:
                raise fail()
            digest = item['sha256']
        metadata['files'].append({key: value for key, value in item.items() if key != 'data'})
        if item['path'] != 'orbis-host-compose.yml' or item['present']:
            hashes[item['path']] = digest
    domain = b'orbis.controller-config.v2\n' if version == 2 else b'orbis.controller-config.v1\n'
    expected = hashlib.sha256(domain + P.canonical(metadata)).hexdigest()
    if expected != config['configurationSetSha256']:
        raise fail()
    return IDENTITY.files(hashes)


@contextmanager
def reviewed_bundle(path, expected_digest, root, context):
    """Read independently root-reviewed bytes, never a request descriptor."""
    from contextlib import ExitStack
    if Path(path).is_relative_to(root):
        raise fail()
    with ExitStack() as stack:
        directory = stack.enter_context(protected_directory(path))
        review_bytes = stack.enter_context(protected_file(directory, 'review.json'))
        if not IDENTITY.hashed(expected_digest) or P.digest(review_bytes) != expected_digest:
            raise fail()
        review = P.metadata(review_bytes)
        if (not P.exact(review, {'schema', 'root', 'dockerContext', 'pointDigest', 'configurationDigest', 'archiveRootId', 'proofDigest',
                                'releaseDigest', 'archiveKind', 'archiveDigest', 'previousStateDigest'}) or review['schema'] != REVIEW_SCHEMA
                or review['root'] != str(root) or review['dockerContext'] != context
                or any(not IDENTITY.hashed(review[name]) for name in ('pointDigest', 'configurationDigest', 'archiveRootId', 'proofDigest', 'releaseDigest', 'archiveDigest', 'previousStateDigest'))):
            raise fail()
        blobs = {}
        for name, key, maximum in (('point.json', 'pointDigest', LIMIT), ('configuration.json', 'configurationDigest', LIMIT),
                                   ('proof.json', 'proofDigest', P.PROOF_WIRE_BYTES), ('release.json', 'releaseDigest', LIMIT)):
            body = stack.enter_context(protected_file(directory, name, maximum))
            if P.digest(body) != review[key]:
                raise fail()
            blobs[name] = body
        archive_digest = stack.enter_context(protected_file(directory, 'controller-image.tar', P.MAX_IMAGE_BYTES, digest_only=True))
        if archive_digest != review['archiveDigest']:
            raise fail()
        release = P.release_identity(P.metadata(blobs['release.json']))
        graph = P.verify_publication_proof(release, P.metadata(blobs['proof.json'], byte_limit=P.PROOF_WIRE_BYTES,
                                           string_limit=4 * ((P.METADATA_BYTES + 2) // 3)))
        config = P.metadata(blobs['configuration.json'], byte_limit=LIMIT, string_limit=2 * 1024 * 1024)
        hashes = configuration_files(config)
        controller = config['controller']
        point = P.metadata(blobs['point.json'], byte_limit=LIMIT)
        # The independently reviewed runtime manifest binds its extracted config,
        # captured source image and archive inventory; it does not grant restore readiness.
        if (point.get('schema') != 'orbis.time-machine-runtime.v2' or point.get('pointId') != config['pointId']
                or point.get('configurationSetSha256') != config['configurationSetSha256']
                or point.get('configuration') != {**config, 'files': [{k: v for k, v in item.items() if k != 'data'} for item in config['files']]}
                or point.get('controller', {}).get('sourceImageId') != controller.get('imageId')
                or controller.get('releaseTag') != release['tag'] or controller.get('releaseDigest') != release['digest']
                or (config['version'] == 1 and controller.get('imageReference') != release['image'] + '@' + release['digest'])
                or (config['version'] == 2 and (config.get('retainedIdentity', {}).get('publishedReference') != release['image'] + '@' + release['digest']
                    or controller.get('imageReference') != config['retainedIdentity'].get('creationReference')
                    or controller.get('imageId') != config['retainedIdentity'].get('creationReference')))
                or config.get('rootIdentity', {}).get('pathSha256') != hashlib.sha256(str(root).encode()).hexdigest()):
            raise fail()
        creation = graph.creation_reference(review['archiveKind'])
        archive_root = archive_root_identity(directory, review['archiveKind'], graph)
        if archive_root != review['archiveRootId']:
            raise fail()
        hashes['orbis-compose.yml'] = hashlib.sha256(override_content(release, creation).encode()).hexdigest()
        descriptor = dict(schema=IDENTITY.RETAINED_SCHEMA, root=str(root), dockerContext=context, files=hashes,
                          pointId=review['pointDigest'], configurationDigest=review['configurationDigest'], archiveRootId=archive_root,
                          archiveKind=review['archiveKind'], proofDigest=review['proofDigest'], publication=release,
                          platform=json.loads(graph.platform_bytes), platformManifestDigest=graph.manifest_digest,
                          configDigest=graph.config_digest, sourceImageId=controller['imageId'], creationReference=creation)
        authority = {key: descriptor[key] for key in ('root', 'dockerContext', 'pointId', 'configurationDigest', 'archiveRootId', 'proofDigest', 'publication')}
        authority.update(schema=IDENTITY.AUTHORITY_SCHEMA, descriptorDigest=P.digest(P.canonical(descriptor)))
        yield descriptor, authority, blobs['proof.json'], review


def archive_root_identity(directory, kind, graph):
    descriptor = os.open('controller-image.tar', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    try:
        before = os.fstat(descriptor)
        key = (OWNER, seal(before), kind, graph.manifest_digest, graph.config_digest)
        if key in ARCHIVE_ROOT_CACHE:
            result = ARCHIVE_ROOT_CACHE[key]
        else:
            wanted = {'index.json'} if kind == 'oci' else {'manifest.json'}
            wanted |= {'blobs/sha256/' + graph.config_digest[7:], graph.config_digest[7:] + '.json'}
            if kind == 'oci':
                wanted.add('blobs/sha256/' + graph.manifest_digest[7:])
            found, seen = {}, set()
            with os.fdopen(os.dup(descriptor), 'rb') as stream, tarfile.open(fileobj=stream, mode='r|') as archive:
                for entry in archive:
                    name = entry.name.removeprefix('./')
                    if (len(seen) > P.MAX_LAYERS * 4 + 64 or name in seen or name.startswith('/')
                            or '..' in name.split('/') or not (entry.isfile() or entry.isdir())):
                        raise fail()
                    seen.add(name)
                    if name in wanted:
                        if not entry.isfile() or entry.size > P.METADATA_BYTES:
                            raise fail()
                        found[name] = archive.extractfile(entry).read(P.METADATA_BYTES + 1)
            configs = [body for name, body in found.items() if name in
                       {'blobs/sha256/' + graph.config_digest[7:], graph.config_digest[7:] + '.json'}]
            if configs != [graph.config_bytes]:
                raise fail()
            if kind == 'oci':
                if found.get('blobs/sha256/' + graph.manifest_digest[7:]) != graph.manifest_bytes or 'index.json' not in found:
                    raise fail()
                index = P.metadata(found['index.json'])
                entries = index.get('manifests')
                if index.get('schemaVersion') != 2 or index.get('mediaType') != P.OCI_INDEX or not isinstance(entries, list) or len(entries) > P.MAX_DESCRIPTORS:
                    raise fail()
                config_platform = {key: json.loads(graph.config_bytes)[key] for key in ('os', 'architecture', 'variant') if key in json.loads(graph.config_bytes)}
                expected_platform = json.loads(graph.platform_bytes)
                if P.platform_identity(config_platform, selectable=True) != expected_platform:
                    raise fail()
                matches = [item for item in entries if isinstance(item, dict) and item.get('digest') == graph.manifest_digest
                           and item.get('size') == len(graph.manifest_bytes) and ('platform' not in item or item['platform'] == expected_platform)]
                if len(matches) != 1:
                    raise fail()
                result = P.digest(found['index.json'])
            else:
                if 'index.json' in seen or 'oci-layout' in seen or 'manifest.json' not in found:
                    raise fail()
                manifests = P.metadata(b'{"items":' + found['manifest.json'] + b'}')['items']
                if not isinstance(manifests, list) or len(manifests) != 1:
                    raise fail()
                manifest = manifests[0]
                if (not P.exact(manifest, {'Config', 'RepoTags', 'Layers'}) or manifest['Config'] not in found
                        or found[manifest['Config']] != graph.config_bytes or not isinstance(manifest['Layers'], list)
                        or len(manifest['Layers']) != len(graph.rootfs_diff_ids)
                        or any(not isinstance(name, str) or name.removeprefix('./') not in seen for name in manifest['Layers'])):
                    raise fail()
                result = graph.config_digest
        if seal(before) != seal(os.fstat(descriptor)) or seal(before) != seal(os.stat('controller-image.tar', dir_fd=directory, follow_symlinks=False)):
            raise fail()
        if len(ARCHIVE_ROOT_CACHE) >= 32:
            ARCHIVE_ROOT_CACHE.clear()
        ARCHIVE_ROOT_CACHE[key] = result
        return result
    except tarfile.TarError as error:
        raise fail() from error
    finally:
        os.close(descriptor)


def atomic(path, body):
    descriptor, name = tempfile.mkstemp(prefix='.retained-', dir=path.parent)
    temporary = Path(name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def current(root, context, enrollment_bytes):
    with protected_directory(store_path(root)) as directory:
        try:
            os.stat('pending.json', dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise fail()
        with protected_file(directory, 'current.json') as selector_bytes:
            selector = P.metadata(selector_bytes)
            if selector.get('schema') == 'orbis.host.retained-selector.v2':
                if (not P.exact(selector, {'schema', 'bundle', 'descriptorDigest'}) or type(selector['bundle']) is not str
                        or not IDENTITY.hashed(selector['descriptorDigest'])):
                    raise fail()
                with restore_generation(Path(selector['bundle']), selector['descriptorDigest'], root, context, enrollment_bytes) as resolved:
                    yield resolved
                return
            if not P.exact(selector, {'schema', 'bundle', 'reviewDigest', 'descriptorDigest'}) or selector['schema'] != 'orbis.host.retained-selector.v1':
                raise fail()
            with reviewed_bundle(Path(selector['bundle']), selector['reviewDigest'], root, context) as (descriptor, authority, proof, review):
                if P.digest(enrollment_bytes) != selector['descriptorDigest'] or selector['descriptorDigest'] != authority['descriptorDigest'] or P.metadata(enrollment_bytes) != descriptor:
                    raise fail()
                yield descriptor, authority, proof


def trusted_observation(root, context, descriptor):
    spec = importlib.util.spec_from_file_location('orbis_host_for_retained_observation', Path(__file__).with_name('orbis-host.py'))
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    return host.retained_observation(root, context, descriptor)


def authorize_reviewed(root, context, bundle, review_digest, *, confirm_root, lock_fd):
    """Root activation entrypoint, called under HOST.host_lock after offline restore.

    The review digest must come from the independent root review, not the point
    request. Root must stage override_content and restore config before this call.
    A pending marker is deliberately preserved after a crash and blocks reads.
    Repeating the exact pinned review finishes the same transaction.
    """
    IDENTITY.binding(str(root), context)
    if os.geteuid() != OWNER or confirm_root != str(root):
        raise fail()
    locked = os.fstat(lock_fd)
    marker = LAYOUT.lock_paths(root)[0]
    if (not stat.S_ISREG(locked.st_mode) or locked.st_uid != OWNER or locked.st_nlink != 1
            or stat.S_IMODE(locked.st_mode) & 0o077 or seal(locked) != seal(marker.lstat())):
        raise fail()
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    with reviewed_bundle(bundle, review_digest, root, context) as (descriptor, authority, proof, review):
        names = descriptor['files']
        observation = trusted_observation(root, context, descriptor)
        with installation_files(root, names) as actual:
            IDENTITY.resolve_host_identity(P.canonical(descriptor), root=str(root), context=context, current_files=actual,
                                          expected_release=descriptor['publication'], observation=observation,
                                          retained_authority=authority, proof=proof)
        state = root / '.orbis-host-state.json'
        state_digest = P.digest(state.read_bytes()) if state.is_file() and not state.is_symlink() else None
        if state_digest not in {review['previousStateDigest'], authority['descriptorDigest']}:
            raise fail()
        store = store_path(root)
        store.mkdir(mode=0o700, exist_ok=True)
        # The store's stat changes during this transaction; protect files directly
        # and re-open its protected directory on the reader path.
        details = store.lstat()
        if store.is_symlink() or details.st_uid != OWNER or stat.S_IMODE(details.st_mode) & 0o077:
            raise fail()
        selector = P.canonical(dict(schema='orbis.host.retained-selector.v1', bundle=str(bundle), reviewDigest=review_digest,
                                    descriptorDigest=authority['descriptorDigest']))
        pending = store / 'pending.json'
        with protected_directory(store) as store_fd:
            try:
                with protected_file(store_fd, 'pending.json') as previous_pending:
                    if previous_pending != selector:
                        raise fail()
            except FileNotFoundError:
                pass
        atomic(pending, selector)
        atomic(store / 'current.json', selector)
        atomic(state, P.canonical(descriptor))
        pending.unlink()
        directory = os.open(store, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return descriptor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('authorize-reviewed',))
    parser.add_argument('root', type=Path)
    parser.add_argument('review_bundle', type=Path)
    parser.add_argument('--review-sha256', required=True, help='independently pinned sha256: digest of root review.json')
    parser.add_argument('--docker-context', required=True)
    parser.add_argument('--confirm-root', required=True)
    args = parser.parse_args()
    try:
        spec = importlib.util.spec_from_file_location('orbis_host_for_retained_authorization', Path(__file__).with_name('orbis-host.py'))
        host = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(host)
        root, bundle = args.root.resolve(strict=True), args.review_bundle.resolve(strict=True)
        with host.host_lock(root) as lock_fd:
            authorize_reviewed(root, args.docker_context, bundle, args.review_sha256,
                               confirm_root=args.confirm_root, lock_fd=lock_fd)
        print(json.dumps({'result': 'retained-enrolled', 'root': str(root)}))
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print('Retained enrollment failed: ' + str(error), file=sys.stderr)
        return 2




class _AuthorityView:
    def __getattr__(self, name):
        return globals()[name]


_CAPTURE_READER = None


def _capture_reader():
    global _CAPTURE_READER
    if _CAPTURE_READER is None:
        spec = importlib.util.spec_from_file_location('orbis_capture_for_transaction_authority', Path(__file__).with_name('orbis-host-capture-authority.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.AUTHORITY = _AuthorityView()
        _CAPTURE_READER = module
    return _CAPTURE_READER


def runtime_origin_binding(runtime, origin):
    pairs = {'orbis.time-machine-runtime.v3': 'orbis.controller-capture-authority.v1',
             'orbis.time-machine-runtime.v4': 'orbis.controller-capture-authority.v2',
             'orbis.time-machine-runtime.v6': 'orbis.controller-capture-authority.v4'}
    if (not isinstance(runtime, dict) or not isinstance(origin, dict) or runtime.get('schema') not in pairs
            or pairs[runtime['schema']] != origin.get('schema')):
        raise fail()
    if runtime['schema'] != 'orbis.time-machine-runtime.v3':
        if runtime.get('proxyHostIdentitySha256') != origin.get('proxyHostIdentity', {}).get('sha256') or not IDENTITY.HEX.fullmatch(str(runtime.get('proxyHostIdentitySha256'))):
            raise fail()
    if runtime['schema'] == 'orbis.time-machine-runtime.v6':
        if runtime.get('appRuntimeSha256') != origin.get('appRuntimeSha256') or not IDENTITY.HEX.fullmatch(str(runtime.get('appRuntimeSha256'))):
            raise fail()


@contextmanager
def restore_generation(bundle, descriptor_digest, root, context, enrollment_bytes):
    from contextlib import ExitStack
    bundle = Path(bundle)
    if (bundle.is_relative_to(root) or bundle.name != descriptor_digest.removeprefix('sha256:')
            or bundle.parent.name != 'authority' or bundle.parents[2].name != 'retained-restores'):
        raise fail()
    transaction = bundle.parents[1]
    state_dir = bundle.parents[3]
    capture = _capture_reader()
    with ExitStack() as stack:
        directory = stack.enter_context(protected_directory(bundle))
        bodies = {name: stack.enter_context(protected_file(directory, name, 16 * 1024 * 1024))
                  for name in ('descriptor.json', 'authority.json', 'configuration.json', 'runtime-manifest.json', 'proof.json')}
        if bodies['descriptor.json'] != enrollment_bytes or P.digest(enrollment_bytes) != descriptor_digest:
            raise fail()
        descriptor, reviewed, config, runtime = [P.metadata(bodies[name], byte_limit=16 * 1024 * 1024) for name in
                                                 ('descriptor.json', 'authority.json', 'configuration.json', 'runtime-manifest.json')]
        keys = {'schema', 'root', 'dockerContext', 'transactionId', 'pointUUID', 'originAuthoritySha256', 'descriptorDigest',
                'configurationDigest', 'runtimeManifestDigest', 'proofDigest', 'archiveRootId', 'publication', 'commitDigest', 'preparedAuthorityDigest'}
        if (not P.exact(reviewed, keys) or reviewed['schema'] != 'orbis.host.retained-transaction-authority.v1'
                or reviewed['root'] != str(root) or reviewed['dockerContext'] != context or reviewed['transactionId'] != transaction.name
                or reviewed['descriptorDigest'] != descriptor_digest or reviewed['configurationDigest'] != P.digest(bodies['configuration.json'])
                or reviewed['runtimeManifestDigest'] != P.digest(bodies['runtime-manifest.json'])
                or reviewed['proofDigest'] != P.digest(bodies['proof.json'])):
            raise fail()
        origin = capture.load_effective_origin(state_dir, root, context, reviewed['pointUUID'])
        original = P.metadata(origin.authority_bytes)
        runtime_origin_binding(runtime, original)
        if (hashlib.sha256(origin.authority_bytes).hexdigest() != reviewed['originAuthoritySha256']
                or reviewed['publication'] != original['publication'] or reviewed['archiveRootId'] != original['archive']['archiveRootId']
                or runtime.get('pointId') != reviewed['pointUUID']):
            raise fail()
        tx_directory = stack.enter_context(protected_directory(transaction))
        commit_bytes = stack.enter_context(protected_file(tx_directory, 'commit.json', LIMIT))
        prepared_bytes = stack.enter_context(protected_file(tx_directory, 'prepared-authority.json', LIMIT))
        commit, prepared = P.metadata(commit_bytes), P.metadata(prepared_bytes)
        if (P.digest(commit_bytes) != reviewed['commitDigest'] or P.digest(prepared_bytes) != reviewed['preparedAuthorityDigest']
                or commit.get('schema') != 'orbis.retained-restore-commit.v1' or commit.get('decision') != 'commit'
                or commit.get('transactionId') != transaction.name or commit.get('pointId') != reviewed['pointUUID']
                or commit.get('root') != str(root) or commit.get('dockerContext') != context
                or commit.get('preparedAuthorityDigest') != reviewed['preparedAuthorityDigest']
                or commit.get('originAuthoritySha256') != reviewed['originAuthoritySha256']
                or prepared.get('runtimeManifestDigest') != reviewed['runtimeManifestDigest']
                or prepared.get('target', {}).get('publication') != original['publication']):
            raise fail()
        config_keys = {'schema', 'files', 'preparedAuthorityDigest', 'originalConfigurationSetSha256', 'incomingEnvSha256', 'normalization'}
        if (not P.exact(config, config_keys) or config['schema'] != 'orbis.host.retained-restored-config.v1'
                or config['files'] != descriptor.get('files') or config['preparedAuthorityDigest'] != reviewed['preparedAuthorityDigest']
                or config['originalConfigurationSetSha256'] != original['configurationSetSha256']
                or config['incomingEnvSha256'] != prepared.get('incomingEnvSha256')
                or config['normalization'] != 'verified-historical-controller-startup.v1'):
            raise fail()
        archive = original['archive']
        expected = dict(schema=IDENTITY.RETAINED_SCHEMA, root=str(root), dockerContext=context, files=IDENTITY.files(config['files']),
                        pointId=reviewed['runtimeManifestDigest'], configurationDigest=reviewed['configurationDigest'],
                        archiveRootId=archive['archiveRootId'], archiveKind=archive['kind'], proofDigest=reviewed['proofDigest'],
                        publication=original['publication'], platform=original['platform'], platformManifestDigest=archive['platformManifestDigest'],
                        configDigest=archive['configDigest'], sourceImageId=archive['sourceImageId'], creationReference=archive['creationReference'])
        if descriptor != expected:
            raise fail()
        proof = P.metadata(bodies['proof.json'], byte_limit=P.PROOF_WIRE_BYTES, string_limit=2 * 1024 * 1024)
        if proof != P.metadata(origin.publication_receipt_bytes, byte_limit=P.PROOF_WIRE_BYTES, string_limit=2 * 1024 * 1024)['proof']:
            raise fail()
        P.verify_publication_proof(original['publication'], proof)
        authority = {key: descriptor[key] for key in ('root', 'dockerContext', 'pointId', 'configurationDigest', 'archiveRootId', 'proofDigest', 'publication')}
        authority.update(schema=IDENTITY.AUTHORITY_SCHEMA, descriptorDigest=descriptor_digest)
        yield descriptor, authority, bodies['proof.json']


def commit_restore_generation(manager, record):
    """Compile only a durable root-decided restore; never a request descriptor."""
    if (os.geteuid() != OWNER or record.get('decision') != 'commit' or manager.read(record['id'])['decision'] != 'commit'
            or manager.host.RESTORE_TRANSACTION.get() != record['id']):
        raise fail()
    root, context = manager.root, manager.context
    origin = manager.origin(record)
    original = P.metadata(origin.authority_bytes)
    transaction = manager.directory(record['id'])
    commit_bytes = (transaction / 'commit.json').read_bytes()
    prepared_bytes = (transaction / 'prepared-authority.json').read_bytes()
    prepared = P.metadata(prepared_bytes)
    names = set(P.metadata(base64_decode(record['source']['enrollment']))['files'])
    if (root / 'orbis-host-compose.yml').exists():
        names.add('orbis-host-compose.yml')
    with installation_files(root, names) as hashes:
        for name, expected in record['source']['files'].items():
            if name not in {'.env', 'orbis-compose.yml'} and hashes.get(name) != expected:
                raise fail()
        content = override_content(original['publication'], original['archive']['creationReference']).encode()
        if hashes['orbis-compose.yml'] != hashlib.sha256(content).hexdigest():
            raise fail()
        configuration = dict(schema='orbis.host.retained-restored-config.v1', files=hashes,
                             preparedAuthorityDigest=P.digest(prepared_bytes), originalConfigurationSetSha256=original['configurationSetSha256'],
                             incomingEnvSha256=record['incomingEnvSha256'], normalization='verified-historical-controller-startup.v1')
        config_bytes = P.canonical(configuration)
        runtime_bytes = manager.runtime.read_file(Path(record['retainedPath']) / 'runtime-manifest.json', 1024 * 1024)
        runtime_origin_binding(P.metadata(runtime_bytes, byte_limit=1024 * 1024), original)
        if P.digest(runtime_bytes) != prepared['runtimeManifestDigest']:
            raise fail()
        proof_bytes = P.canonical(P.metadata(origin.publication_receipt_bytes, byte_limit=P.PROOF_WIRE_BYTES, string_limit=2 * 1024 * 1024)['proof'])
        archive = original['archive']
        descriptor = dict(schema=IDENTITY.RETAINED_SCHEMA, root=str(root), dockerContext=context, files=hashes,
                          pointId=P.digest(runtime_bytes), configurationDigest=P.digest(config_bytes), archiveRootId=archive['archiveRootId'],
                          archiveKind=archive['kind'], proofDigest=P.digest(proof_bytes), publication=original['publication'], platform=original['platform'],
                          platformManifestDigest=archive['platformManifestDigest'], configDigest=archive['configDigest'],
                          sourceImageId=archive['sourceImageId'], creationReference=archive['creationReference'])
        body = P.canonical(descriptor)
        descriptor_digest = P.digest(body)
        generation = transaction / 'authority' / descriptor_digest[7:]
        generation.parent.mkdir(mode=0o700, exist_ok=True)
        generation.mkdir(mode=0o700, exist_ok=True)
        with protected_directory(generation):
            pass
        reviewed = dict(schema='orbis.host.retained-transaction-authority.v1', root=str(root), dockerContext=context,
                        transactionId=record['id'], pointUUID=record['pointId'], originAuthoritySha256=hashlib.sha256(origin.authority_bytes).hexdigest(),
                        descriptorDigest=descriptor_digest, configurationDigest=P.digest(config_bytes), runtimeManifestDigest=P.digest(runtime_bytes),
                        proofDigest=P.digest(proof_bytes), archiveRootId=archive['archiveRootId'], publication=original['publication'],
                        commitDigest=P.digest(commit_bytes), preparedAuthorityDigest=P.digest(prepared_bytes))
        capture = _capture_reader()
        for name, data in {'descriptor.json': body, 'authority.json': P.canonical(reviewed), 'configuration.json': config_bytes,
                           'runtime-manifest.json': runtime_bytes, 'proof.json': proof_bytes}.items():
            capture.immutable(generation / name, data)
    with restore_generation(generation, descriptor_digest, root, context, body):
        pass
    store = store_path(root)
    store.mkdir(mode=0o700, exist_ok=True)
    with protected_directory(store) as directory:
        try:
            os.stat('pending.json', dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise fail()
    selector = P.canonical(dict(schema='orbis.host.retained-selector.v2', bundle=str(generation), descriptorDigest=descriptor_digest))
    atomic(store / 'current.json', selector)
    atomic(root / '.orbis-host-state.json', body)
    record['authorityGeneration'] = str(generation)
    record['descriptorDigest'] = descriptor_digest
    manager.save(record)
    return descriptor


def base64_decode(value):
    import base64
    try:
        return base64.b64decode(value, validate=True)
    except (TypeError, ValueError) as error:
        raise fail() from error

if __name__ == '__main__':
    sys.exit(main())
