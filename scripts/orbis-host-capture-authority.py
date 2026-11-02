#!/usr/bin/env python3
"""Persist host-observed controller capture authority outside container storage."""
import hashlib
import importlib.util
import json
import math
import os
import stat
import tarfile
import tempfile
import time
import uuid
import zlib
from pathlib import Path
from typing import NamedTuple

SPEC = importlib.util.spec_from_file_location('orbis_retained_for_capture', Path(__file__).with_name('orbis-host-retained-authority.py'))
AUTHORITY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUTHORITY)
P = AUTHORITY.P
APP_SPEC = importlib.util.spec_from_file_location('orbis_capture_app_runtime', Path(__file__).with_name('orbis-host-app-runtime.py'))
APP = importlib.util.module_from_spec(APP_SPEC)
APP_SPEC.loader.exec_module(APP)
PREPARATION_SCHEMA = 'orbis.controller-capture-preparation.v1'
AUTHORITY_SCHEMA = 'orbis.controller-capture-authority.v1'
PREPARATION_LIMIT = 16 * 1024 * 1024
RECEIPT_LIMIT = 65536
MAX_POINTS = 256
MAX_SECONDS = 300


def fail():
    return ValueError('Protected controller capture authority could not be verified')


def point_id(value):
    try:
        parsed = uuid.UUID(value)
        if str(parsed) != value or parsed.version != 4:
            raise fail()
    except (TypeError, ValueError, AttributeError) as error:
        raise fail() from error
    return value


def directory(state_dir, point, *, create=False):
    point_id(point)
    state_dir = Path(state_dir)
    with AUTHORITY.protected_directory(state_dir):
        pass
    base = state_dir / 'controller-capture-authorities'
    if create:
        base.mkdir(mode=0o700, exist_ok=True)
    with AUTHORITY.protected_directory(base):
        entries = list(base.iterdir())
        if len(entries) > MAX_POINTS or (create and not (base / point).exists() and len(entries) >= MAX_POINTS):
            raise fail()
        if any(not item.is_dir() or item.is_symlink() for item in entries):
            raise fail()
    result = base / point
    if create:
        result.mkdir(mode=0o700, exist_ok=True)
    with AUTHORITY.protected_directory(result):
        pass
    return result


def read(path, name, limit):
    with AUTHORITY.protected_directory(path) as parent:
        with AUTHORITY.protected_file(parent, name, limit) as body:
            return body


def immutable(path, body):
    descriptor, name = tempfile.mkstemp(prefix='.capture-authority-', dir=path.parent)
    temporary = Path(name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path, follow_symlinks=False)
        except FileExistsError:
            if read(path.parent, path.name, max(PREPARATION_LIMIT, len(body))) != body:
                raise fail()
        finally:
            temporary.unlink(missing_ok=True)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        temporary.unlink(missing_ok=True)


def capture_preparation(state_dir, root, context, configuration, publication_receipt):
    point = point_id(configuration['pointId'])
    if (publication_receipt.get('pointId') != point or publication_receipt.get('controller') != configuration['controller']
            or publication_receipt.get('rootIdentity') != configuration['rootIdentity']
            or publication_receipt.get('configurationSetSha256') != configuration['configurationSetSha256']):
        raise fail()
    AUTHORITY.configuration_files(configuration)
    receipt = dict(publication_receipt)
    claimed = receipt.pop('preparationSha256', None)
    domain = b'orbis.controller-publication-capture.v2\n' if receipt.get('version') == 2 else b'orbis.controller-publication-capture.v1\n'
    if claimed != hashlib.sha256(domain + P.canonical(receipt)).hexdigest():
        raise fail()
    # The host preparation path independently produced/verified this proof.
    # This persistence function is not an HTTP request decoder.
    proof = publication_receipt['proof']
    P.verify_publication_proof(proof['publication'], proof)
    path = directory(state_dir, point, create=True)
    proposed = dict(schema=PREPARATION_SCHEMA, pointId=point, configuration=configuration,
                    rootSha256=hashlib.sha256(str(root).encode()).hexdigest(), contextSha256=hashlib.sha256(context.encode()).hexdigest(),
                    publicationReceipt=publication_receipt, preparedAt=int(time.time() * 1000))
    try:
        previous = load_preparation(state_dir, point)
    except FileNotFoundError:
        previous = None
    if previous is not None:
        if any(previous[key] != proposed[key] for key in ('schema', 'pointId', 'rootSha256', 'contextSha256', 'configuration', 'publicationReceipt')):
            raise fail()
        return previous
    body = P.canonical(proposed)
    if len(body) > PREPARATION_LIMIT:
        raise fail()
    immutable(path / 'prepared.json', body)
    return proposed


def load_preparation(state_dir, point):
    path = directory(state_dir, point)
    body = read(path, 'prepared.json', PREPARATION_LIMIT)
    value = P.metadata(body, byte_limit=PREPARATION_LIMIT, string_limit=2 * 1024 * 1024)
    if (not P.exact(value, {'schema', 'pointId', 'rootSha256', 'contextSha256', 'configuration', 'publicationReceipt', 'preparedAt'})
            or value['schema'] != PREPARATION_SCHEMA or value['pointId'] != point
            or type(value['preparedAt']) is not int):
        raise fail()
    configuration = value['configuration']
    receipt = value['publicationReceipt']
    AUTHORITY.configuration_files(configuration)
    if (receipt.get('pointId') != point or receipt.get('controller') != configuration.get('controller')
            or receipt.get('rootIdentity') != configuration.get('rootIdentity')
            or receipt.get('configurationSetSha256') != configuration.get('configurationSetSha256')):
        raise fail()
    unhashed = {key: item for key, item in receipt.items() if key != 'preparationSha256'}
    domain = b'orbis.controller-publication-capture.v2\n' if receipt.get('version') == 2 else b'orbis.controller-publication-capture.v1\n'
    if receipt.get('preparationSha256') != hashlib.sha256(domain + P.canonical(unhashed)).hexdigest():
        raise fail()
    P.verify_publication_proof(receipt['proof']['publication'], receipt['proof'])
    return value


def checked_deadline(deadline):
    if time.monotonic() >= deadline:
        raise fail()


def verify_archive(path, graph, deadline):
    """Verify every selected layer's compressed digest and uncompressed diff ID.

    No tar entry is extracted. Additional OCI blobs must be in the authenticated
    selected-image/attestation closure. The installed host verifier, not a request
    hash or the backend validator, establishes the archive identity.
    """
    manifest = P.metadata(graph.manifest_bytes)
    wanted_layers = {}
    for layer, diff_id in zip(manifest['layers'], graph.rootfs_diff_ids, strict=True):
        prior = wanted_layers.get(layer['digest'])
        item = (layer['size'], layer['mediaType'], diff_id)
        if prior is not None and prior != item:
            raise fail()
        wanted_layers[layer['digest']] = item
    metadata, entries, layer_diffs, expanded_sizes = {}, {}, {}, {}
    total, expanded, metadata_bytes = 0, 0, 0
    archive_hash = hashlib.sha256()
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != AUTHORITY.OWNER or before.st_nlink != 1
                or stat.S_IMODE(before.st_mode) & 0o077 or not 1 <= before.st_size <= P.MAX_IMAGE_BYTES):
            raise fail()
        with os.fdopen(os.dup(descriptor), 'rb') as raw:
            while True:
                checked_deadline(deadline)
                block = raw.read(1024 * 1024)
                if not block:
                    break
                archive_hash.update(block)
        os.lseek(descriptor, 0, os.SEEK_SET)
        with os.fdopen(os.dup(descriptor), 'rb') as stream, tarfile.open(fileobj=stream, mode='r|') as archive:
            for entry in archive:
                checked_deadline(deadline)
                name = entry.name.removeprefix('./')
                if (name in entries or len(entries) >= P.MAX_LAYERS * 4 + 64 or name.startswith('/')
                        or '..' in name.split('/') or not (entry.isfile() or entry.isdir())
                        or len(name) > 1024 or entry.size < 0 or entry.size > P.MAX_LAYER_BYTES):
                    raise fail()
                entries[name] = (entry.size, entry.isdir())
                if entry.isdir():
                    if entry.size:
                        raise fail()
                    continue
                total += entry.size
                if total > P.MAX_IMAGE_BYTES:
                    raise fail()
                digest_name = 'sha256:' + name[13:] if name.startswith('blobs/sha256/') and len(name) == 77 else None
                classic_id = 'sha256:' + name[:-5] if name.endswith('.json') and len(name) == 69 and '/' not in name else None
                expected = wanted_layers.get(digest_name)
                if not expected and entry.size <= 16 * 1024 * 1024:
                    metadata_bytes += entry.size
                    if metadata_bytes > 16 * 1024 * 1024:
                        raise fail()
                hashed, diff, chunks = hashlib.sha256(), hashlib.sha256(), []
                decompressor = zlib.decompressobj(31) if expected and expected[1].endswith('+gzip') or expected and expected[1].endswith('.gzip') else None
                count, expanded_layer = 0, 0
                content = archive.extractfile(entry)
                while True:
                    checked_deadline(deadline)
                    block = content.read(1024 * 1024)
                    if not block:
                        break
                    count += len(block)
                    hashed.update(block)
                    if expected:
                        pending = block
                        while pending:
                            checked_deadline(deadline)
                            output = decompressor.decompress(pending, 1024 * 1024) if decompressor else pending
                            pending = decompressor.unconsumed_tail if decompressor else b''
                            expanded_layer += len(output)
                            expanded += len(output)
                            if expanded_layer > P.MAX_LAYER_BYTES or expanded > P.MAX_IMAGE_BYTES:
                                raise fail()
                            diff.update(output)
                            if decompressor and decompressor.unused_data:
                                raise fail()
                    elif entry.size <= 16 * 1024 * 1024:
                        chunks.append(block)
                actual = 'sha256:' + hashed.hexdigest()
                if count != entry.size or (digest_name is not None and actual != digest_name) or (classic_id is not None and actual != classic_id):
                    raise fail()
                if expected:
                    if (count != expected[0] or actual != digest_name or (decompressor is not None and (not decompressor.eof or decompressor.unused_data))
                            or 'sha256:' + diff.hexdigest() != expected[2]):
                        raise fail()
                    layer_diffs[digest_name] = expected[2]
                    expanded_sizes[digest_name] = expanded_layer
                elif chunks or entry.size == 0:
                    metadata[name] = b''.join(chunks)
        if AUTHORITY.seal(before) != AUTHORITY.seal(os.fstat(descriptor)) or AUTHORITY.seal(before) != AUTHORITY.seal(Path(path).lstat()):
            raise fail()
    except (tarfile.TarError, zlib.error, EOFError) as error:
        raise fail() from error
    finally:
        os.close(descriptor)
    if set(layer_diffs) != set(wanted_layers) or sum(expanded_sizes[layer['digest']] for layer in manifest['layers']) > P.MAX_IMAGE_BYTES:
        raise fail()
    if 'index.json' in metadata:
        kind = 'oci'
        index = P.metadata(metadata['index.json'])
        if index.get('schemaVersion') != 2 or index.get('mediaType') != P.OCI_INDEX or not isinstance(index.get('manifests'), list) or not 1 <= len(index['manifests']) <= P.MAX_DESCRIPTORS:
            raise fail()
        if any(key in (index.get('annotations') or {}) for key in ('org.opencontainers.image.ref.name', 'io.containerd.image.name')):
            raise fail()
        primary = 'blobs/sha256/' + graph.manifest_digest[7:]
        config = 'blobs/sha256/' + graph.config_digest[7:]
        if metadata.get(primary) != graph.manifest_bytes or metadata.get(config) != graph.config_bytes:
            raise fail()
        allowed = {primary, config} | {'blobs/sha256/' + value[7:] for value in wanted_layers}
        matches = 0
        for item in index['manifests']:
            if (not isinstance(item, dict) or item.get('mediaType') != P.OCI_MANIFEST
                    or not AUTHORITY.IDENTITY.hashed(item.get('digest')) or type(item.get('size')) is not int):
                raise fail()
            if any(key in (item.get('annotations') or {}) for key in ('org.opencontainers.image.ref.name', 'io.containerd.image.name')):
                raise fail()
            name = 'blobs/sha256/' + item['digest'][7:]
            body = metadata.get(name)
            if body is None or len(body) != item['size']:
                raise fail()
            if item['digest'] == graph.manifest_digest:
                expected_platform = json.loads(graph.platform_bytes)
                actual_config = P.metadata(metadata[config])
                config_platform = {key: actual_config[key] for key in ('os', 'architecture', 'variant') if key in actual_config}
                if (P.platform_identity(config_platform, selectable=True) != expected_platform
                        or 'platform' in item and item['platform'] != expected_platform):
                    raise fail()
                matches += 1
            else:
                verify_attestation(item, body, graph, metadata, entries, allowed)
        if matches != 1:
            raise fail()
        if 'manifest.json' in metadata:
            mapped = P.metadata(b'{"items":' + metadata['manifest.json'] + b'}')['items']
            expected_layers = ['blobs/sha256/' + layer['digest'][7:] for layer in manifest['layers']]
            if (not isinstance(mapped, list) or len(mapped) != 1 or not P.exact(mapped[0], {'Config', 'RepoTags', 'Layers'})
                    or mapped[0]['Config'] != config or mapped[0]['Layers'] != expected_layers
                    or mapped[0]['RepoTags'] not in (None, [])):
                raise fail()
        extras = {name for name, (_, is_dir) in entries.items() if not is_dir} - allowed - {'index.json', 'manifest.json', 'oci-layout'}
        if extras or metadata.get('oci-layout') not in (None, b'{"imageLayoutVersion":"1.0.0"}'):
            raise fail()
        archive_root = P.digest(metadata['index.json'])
    else:
        # Classic Docker archives use uncompressed per-layer tar paths; selected
        # layer proof verification above requires content-addressed OCI blobs.
        # Reject until the classic path is independently implemented and tested.
        raise fail()
    return dict(kind=kind, sha256=archive_hash.hexdigest(), bytes=before.st_size, archiveRootId=archive_root,
                platformManifestDigest=graph.manifest_digest, configDigest=graph.config_digest,
                creationReference=graph.creation_reference(kind))


def verify_attestation(root, body, graph, metadata, entries, allowed):
    attestation_type = 'application/vnd.docker.attestation.manifest.v1+json'
    docker_form = 'artifactType' not in root
    if (not P.exact(root, {'mediaType', 'digest', 'size'}, {'artifactType', 'annotations', 'platform'})
            or not docker_form and root['artifactType'] != attestation_type
            or 'platform' in root and root['platform'] != {'os': 'unknown', 'architecture': 'unknown'}):
        raise fail()
    annotations = root.get('annotations') or {}
    P.annotations(annotations)
    if (docker_form and annotations.get('io.containerd.manifest.subject') != graph.manifest_digest
            or any(annotations.get(key, graph.manifest_digest) != graph.manifest_digest for key in ('io.containerd.manifest.subject', 'vnd.docker.reference.digest'))
            or annotations.get('vnd.docker.reference.type', 'attestation-manifest') != 'attestation-manifest'):
        raise fail()
    manifest = P.metadata(body)
    required = {'schemaVersion', 'mediaType', 'config', 'layers'} | (set() if docker_form else {'artifactType', 'subject'})
    if (not P.exact(manifest, required, {'annotations'}) or manifest['schemaVersion'] != 2 or manifest['mediaType'] != P.OCI_MANIFEST
            or not docker_form and manifest['artifactType'] != attestation_type
            or not isinstance(manifest['layers'], list) or not 1 <= len(manifest['layers']) <= 64):
        raise fail()
    if 'annotations' in manifest:
        P.annotations(manifest['annotations'])
    config = manifest['config']
    name = 'blobs/sha256/' + str(config.get('digest', ''))[7:]
    config_body = metadata.get(name)
    optional = {'annotations'} if docker_form else {'annotations', 'data'}
    if (not P.exact(config, {'mediaType', 'digest', 'size'}, optional) or not AUTHORITY.IDENTITY.hashed(config.get('digest'))
            or config_body is None or len(config_body) != config.get('size') or P.digest(config_body) != config['digest']):
        raise fail()
    if 'annotations' in config:
        P.annotations(config['annotations'])
    diffs = None
    if docker_form:
        data = P.metadata(config_body)
        if (config['mediaType'] != P.OCI_CONFIG or not P.exact(data, {'architecture', 'os', 'config', 'rootfs'})
                or data['architecture'] != 'unknown' or data['os'] != 'unknown' or data['config'] != {}
                or not P.exact(data['rootfs'], {'type', 'diff_ids'}) or data['rootfs']['type'] != 'layers'
                or not isinstance(data['rootfs']['diff_ids'], list) or len(data['rootfs']['diff_ids']) != len(manifest['layers'])):
            raise fail()
        diffs = data['rootfs']['diff_ids']
    else:
        subject = P.descriptor(manifest['subject'], {P.OCI_MANIFEST}, P.METADATA_BYTES)
        if (subject['digest'] != graph.manifest_digest or subject['size'] != len(graph.manifest_bytes)
                or config['mediaType'] != 'application/vnd.oci.empty.v1+json' or config['size'] != 2 or config_body != b'{}'
                or 'data' in config and config['data'] != 'e30='):
            raise fail()
    allowed |= {'blobs/sha256/' + root['digest'][7:], name}
    for index, layer in enumerate(manifest['layers']):
        layer = P.descriptor(layer, {'application/vnd.in-toto+json'}, 16 * 1024 * 1024)
        name = 'blobs/sha256/' + str(layer.get('digest', ''))[7:]
        payload = metadata.get(name)
        if (payload is None or len(payload) != layer['size'] or P.digest(payload) != layer['digest']
                or diffs is not None and diffs[index] != layer['digest']):
            raise fail()
        statement = attestation_metadata(payload)
        if (not P.exact(statement, {'_type', 'subject', 'predicateType', 'predicate'})
                or statement['_type'] not in {'https://in-toto.io/Statement/v1', 'https://in-toto.io/Statement/v0.1'}
                or not isinstance(statement['predicate'], dict) or not isinstance(statement['predicateType'], str)
                or not 1 <= len(statement['predicateType']) <= 2048 or not isinstance(statement['subject'], list)
                or not 1 <= len(statement['subject']) <= 64):
            raise fail()
        if layer.get('annotations', {}).get('in-toto.io/predicate-type', statement['predicateType']) != statement['predicateType']:
            raise fail()
        for subject in statement['subject']:
            if (not P.exact(subject, {'name', 'digest'}) or not isinstance(subject['name'], str)
                    or not 1 <= len(subject['name']) <= 2048 or not P.exact(subject['digest'], {'sha256'})
                    or subject['digest']['sha256'] != graph.manifest_digest[7:]):
                raise fail()
        allowed.add(name)


def attestation_metadata(body):
    if not 1 <= len(body) <= 16 * 1024 * 1024:
        raise fail()
    try:
        value = json.loads(body.decode('utf8'), object_pairs_hook=P.pairs, parse_constant=P.unsupported_number)
        pending, count = [(value, 0)], 0
        while pending:
            item, depth = pending.pop()
            count += 1
            if depth > 32 or count > 1_000_000:
                raise fail()
            if isinstance(item, dict):
                if len(item) > 256 or any(len(key) > 1024 for key in item):
                    raise fail()
                pending.extend((child, depth + 1) for child in item.values())
            elif isinstance(item, list):
                if len(item) > 100000:
                    raise fail()
                pending.extend((child, depth + 1) for child in item)
            elif isinstance(item, str):
                if len(item) > 2 * 1024 * 1024 or any(0xD800 <= ord(char) <= 0xDFFF for char in item):
                    raise fail()
            elif isinstance(item, float) and not math.isfinite(item):
                raise fail()
        if not isinstance(value, dict):
            raise fail()
        return value
    except (UnicodeError, RecursionError, ValueError) as error:
        raise fail() from error


def finalized_receipt(prepared, archive):
    config = prepared['configuration']
    publication = prepared['publicationReceipt']
    result = dict(schema=AUTHORITY_SCHEMA, version=1, pointId=prepared['pointId'],
                  configurationSetSha256=config['configurationSetSha256'], preparationSha256=publication['preparationSha256'],
                  publicationProofSha256=hashlib.sha256(P.canonical(publication)).hexdigest(),
                  rootIdentitySha256=hashlib.sha256(P.canonical(config['rootIdentity'])).hexdigest(),
                  publication=P.release_identity(publication['proof']['publication']), platform=publication['proof']['platform'],
                  archive={**archive, 'sourceImageId': config['controller']['imageId']}, finalizedAt=int(time.time() * 1000))
    result['authoritySha256'] = hashlib.sha256(b'orbis.controller-capture-authority.v1\n' + P.canonical(result)).hexdigest()
    if len(P.canonical(result)) > RECEIPT_LIMIT:
        raise fail()
    return result


def _load_finalization_plan(state_dir, point, prepared):
    path = directory(state_dir, point)
    plan = P.metadata(read(path, 'finalization.json', RECEIPT_LIMIT), byte_limit=RECEIPT_LIMIT)
    if (not P.exact(plan, {'schema', 'pointId', 'tokenSha256', 'authority'})
            or plan['schema'] != 'orbis.controller-capture-finalization.v1' or plan['pointId'] != point
            or type(plan['tokenSha256']) is not str or AUTHORITY.IDENTITY.HEX.fullmatch(plan['tokenSha256']) is None):
        raise fail()
    result = plan['authority']
    expected = prepared['publicationReceipt']
    required = {'schema', 'version', 'pointId', 'configurationSetSha256', 'preparationSha256', 'publicationProofSha256',
                'rootIdentitySha256', 'publication', 'platform', 'archive', 'finalizedAt', 'authoritySha256'}
    archive_keys = {'kind', 'sha256', 'bytes', 'archiveRootId', 'platformManifestDigest', 'configDigest', 'sourceImageId', 'creationReference'}
    if (not P.exact(result, required) or result['version'] != 1 or type(result['version']) is not int
            or not P.exact(result['archive'], archive_keys) or type(result['finalizedAt']) is not int or result['finalizedAt'] <= 0
            or type(result['archive']['bytes']) is not int or not 1 <= result['archive']['bytes'] <= P.MAX_IMAGE_BYTES):
        raise fail()
    graph = P.verify_publication_proof(expected['proof']['publication'], expected['proof'])
    archive = result['archive']
    if (archive['kind'] not in {'oci', 'docker'} or archive['creationReference'] != graph.creation_reference(archive['kind'])
            or archive['configDigest'] != graph.config_digest or archive['platformManifestDigest'] != graph.manifest_digest
            or archive['sourceImageId'] != prepared['configuration']['controller']['imageId']
            or type(archive['sha256']) is not str or AUTHORITY.IDENTITY.HEX.fullmatch(archive['sha256']) is None
            or not AUTHORITY.IDENTITY.hashed(archive['archiveRootId'])
            or result['platform'] != json.loads(graph.platform_bytes)):
        raise fail()
    unhashed = {key: value for key, value in result.items() if key != 'authoritySha256'}
    if (result.get('schema') != AUTHORITY_SCHEMA or result.get('pointId') != point
            or result.get('configurationSetSha256') != prepared['configuration']['configurationSetSha256']
            or result.get('preparationSha256') != expected['preparationSha256']
            or result.get('publicationProofSha256') != hashlib.sha256(P.canonical(expected)).hexdigest()
            or result.get('publication') != expected['proof']['publication']
            or result.get('rootIdentitySha256') != hashlib.sha256(P.canonical(prepared['configuration']['rootIdentity'])).hexdigest()
            or result.get('authoritySha256') != hashlib.sha256(b'orbis.controller-capture-authority.v1\n' + P.canonical(unhashed)).hexdigest()):
        raise fail()
    return plan


def load_finalization(state_dir, point, token, prepared):
    plan = _load_finalization_plan(state_dir, point, prepared)
    if type(token) is not str or plan['tokenSha256'] != hashlib.sha256(token.encode()).hexdigest():
        raise fail()
    return plan


class RootCaptureOrigin(NamedTuple):
    authority_bytes: bytes
    configuration_bytes: bytes
    publication_receipt_bytes: bytes


def proxy_descriptor(value, root_sha, context_sha):
    keys = {'schema', 'policy', 'rootSha256', 'dockerContextSha256', 'configuration', 'mutableIdentity', 'proxy', 'sha256'}
    if (not P.exact(value, keys) or value['schema'] != 'orbis.proxy-host-identity-policy.v1'
            or value['policy'] != 'preserve-live-proxy-identity.v1' or value['rootSha256'] != root_sha or value['dockerContextSha256'] != context_sha):
        raise fail()
    config, mutable, proxy = value['configuration'], value['mutableIdentity'], value['proxy']
    if (not P.exact(config, {'destination', 'readOnly', 'staticSha256', 'capture', 'restore'})
            or config['destination'] != '/etc/traefik' or config['readOnly'] is not True
            or config['capture'] != 'encrypted-review-only' or config['restore'] != 'preserve-live'
            or not P.exact(mutable, {'destination', 'capture', 'restore', 'ownershipSha256'}) or mutable['destination'] != '/shared'
            or mutable['capture'] != 'excluded' or mutable['restore'] != 'preserve-live'
            or not P.exact(proxy, {'containerId', 'imageId'}) or not AUTHORITY.IDENTITY.hashed(proxy['imageId'])
            or any(not isinstance(item, str) or not AUTHORITY.IDENTITY.HEX.fullmatch(item)
                   for item in (root_sha, context_sha, config['staticSha256'], mutable['ownershipSha256'], proxy['containerId'], value['sha256']))):
        raise fail()
    descriptor = {key: item for key, item in value.items() if key != 'sha256'}
    if value['sha256'] != hashlib.sha256(b'orbis.proxy-host-identity-policy.v1\n' + P.canonical(descriptor)).hexdigest():
        raise fail()
    return value


def prepare_proxy_policy(state_dir, point, token, prepared, descriptor):
    descriptor = proxy_descriptor(descriptor, prepared['rootSha256'], prepared['contextSha256'])
    value = {'schema': 'orbis.controller-proxy-preparation.v1', 'pointId': point, 'rootSha256': prepared['rootSha256'],
             'contextSha256': prepared['contextSha256'], 'tokenSha256': hashlib.sha256(token.encode()).hexdigest(),
             'configurationSetSha256': prepared['configuration']['configurationSetSha256'],
             'preparationSha256': prepared['publicationReceipt']['preparationSha256'],
             'publicationProofSha256': hashlib.sha256(P.canonical(prepared['publicationReceipt'])).hexdigest(), 'descriptor': descriptor}
    immutable(directory(state_dir, point) / 'proxy-prepared.json', P.canonical(value))
    return load_proxy_preparation(state_dir, point, prepared)


def load_proxy_preparation(state_dir, point, prepared):
    value = P.metadata(read(directory(state_dir, point), 'proxy-prepared.json', 16384), byte_limit=16384)
    keys = {'schema', 'pointId', 'rootSha256', 'contextSha256', 'tokenSha256', 'configurationSetSha256', 'preparationSha256', 'publicationProofSha256', 'descriptor'}
    if (not P.exact(value, keys) or value['schema'] != 'orbis.controller-proxy-preparation.v1' or value['pointId'] != point
            or value['rootSha256'] != prepared['rootSha256'] or value['contextSha256'] != prepared['contextSha256']
            or value['configurationSetSha256'] != prepared['configuration']['configurationSetSha256']
            or value['preparationSha256'] != prepared['publicationReceipt']['preparationSha256']
            or value['publicationProofSha256'] != hashlib.sha256(P.canonical(prepared['publicationReceipt'])).hexdigest()
            or not isinstance(value['tokenSha256'], str) or not AUTHORITY.IDENTITY.HEX.fullmatch(value['tokenSha256'])):
        raise fail()
    proxy_descriptor(value['descriptor'], prepared['rootSha256'], prepared['contextSha256'])
    return value


def commit_proxy_finalized(state_dir, point, token, prepared, proxy_prepared, base):
    if (proxy_prepared != load_proxy_preparation(state_dir, point, prepared)
            or proxy_prepared['tokenSha256'] != hashlib.sha256(token.encode()).hexdigest()):
        raise fail()
    original = load_origin_from_preparation(state_dir, point, prepared)
    if P.metadata(original.authority_bytes) != base:
        raise fail()
    descriptor = {key: value for key, value in base.items() if key != 'authoritySha256'}
    descriptor.update(schema='orbis.controller-capture-authority.v2', version=2, proxyHostIdentity=proxy_prepared['descriptor'])
    authority = {**descriptor, 'authoritySha256': hashlib.sha256(b'orbis.controller-capture-authority.v2\n' + P.canonical(descriptor)).hexdigest()}
    plan = {'schema': 'orbis.controller-proxy-finalization.v1', 'pointId': point, 'tokenSha256': proxy_prepared['tokenSha256'],
            'proxyPreparationSha256': hashlib.sha256(P.canonical(proxy_prepared)).hexdigest(),
            'baseAuthoritySha256': hashlib.sha256(original.authority_bytes).hexdigest(), 'authority': authority}
    immutable(directory(state_dir, point) / 'proxy-finalized.json', P.canonical(plan))
    return authority


def load_origin_from_preparation(state_dir, point, prepared):
    plan = _load_finalization_plan(state_dir, point, prepared)
    authority = read(directory(state_dir, point), 'finalized.json', 65536)
    if P.metadata(authority) != plan['authority']:
        raise fail()
    return RootCaptureOrigin(authority, P.canonical(prepared['configuration']), P.canonical(prepared['publicationReceipt']))


def load_proxy_origin(state_dir, root, context, point):
    base = load_origin(state_dir, root, context, point)
    prepared = load_preparation(state_dir, point)
    proxy_prepared = load_proxy_preparation(state_dir, point, prepared)
    plan = P.metadata(read(directory(state_dir, point), 'proxy-finalized.json', 65536), byte_limit=65536)
    keys = {'schema', 'pointId', 'tokenSha256', 'proxyPreparationSha256', 'baseAuthoritySha256', 'authority'}
    if (not P.exact(plan, keys) or plan['schema'] != 'orbis.controller-proxy-finalization.v1' or plan['pointId'] != point
            or plan['tokenSha256'] != proxy_prepared['tokenSha256']
            or plan['proxyPreparationSha256'] != hashlib.sha256(P.canonical(proxy_prepared)).hexdigest()
            or plan['baseAuthoritySha256'] != hashlib.sha256(base.authority_bytes).hexdigest()):
        raise fail()
    descriptor = {key: value for key, value in P.metadata(base.authority_bytes).items() if key != 'authoritySha256'}
    descriptor.update(schema='orbis.controller-capture-authority.v2', version=2, proxyHostIdentity=proxy_prepared['descriptor'])
    expected = {**descriptor, 'authoritySha256': hashlib.sha256(b'orbis.controller-capture-authority.v2\n' + P.canonical(descriptor)).hexdigest()}
    if plan['authority'] != expected:
        raise fail()
    return RootCaptureOrigin(P.canonical(expected), base.configuration_bytes, base.publication_receipt_bytes)


def load_effective_origin(state_dir, root, context, point):
    path = directory(state_dir, point)
    app = path / 'app-finalized.json'
    if app.exists() or app.is_symlink():
        return load_app_origin(state_dir, root, context, point)
    extra = path / 'proxy-finalized.json'
    return load_proxy_origin(state_dir, root, context, point) if extra.exists() or extra.is_symlink() else load_origin(state_dir, root, context, point)


def app_expectations(prepared, daemon_sha):
    return {'pointId': prepared['pointId'], 'rootSha256': prepared['rootSha256'],
            'dockerContextSha256': prepared['contextSha256'], 'daemonSha256': daemon_sha,
            'configurationSetSha256': prepared['configuration']['configurationSetSha256'],
            'preparationSha256': prepared['publicationReceipt']['preparationSha256']}


def prepare_app_policy(state_dir, point, token, prepared, proxy, observed, bindings):
    if proxy != load_proxy_preparation(state_dir, point, prepared) or proxy['tokenSha256'] != APP.digest(token.encode()):
        raise fail()
    APP.validate(observed, app_expectations(prepared, observed.get('daemonSha256')))
    body = APP.canonical(observed)
    value = {'schema': 'orbis.controller-app-preparation.v1', 'pointId': point, 'tokenSha256': proxy['tokenSha256'],
             'rootSha256': prepared['rootSha256'], 'contextSha256': prepared['contextSha256'],
             'configurationSetSha256': proxy['configurationSetSha256'], 'preparationSha256': proxy['preparationSha256'],
             'publicationProofSha256': proxy['publicationProofSha256'], 'proxyPreparationSha256': APP.digest(P.canonical(proxy)),
             'appRuntimeSha256': APP.digest(body), 'appRuntimeDaemonSha256': observed['daemonSha256'], 'appRuntimeBytes': len(body),
             'hostBindingsSha256': APP.digest(P.canonical(bindings))}
    path = directory(state_dir, point)
    immutable(path / 'app-runtime.json', body)
    immutable(path / 'app-host-bindings.json', P.canonical(bindings))
    immutable(path / 'app-prepared.json', P.canonical(value))
    return load_app_preparation(state_dir, point, prepared, proxy)


def load_app_preparation(state_dir, point, prepared, proxy=None):
    proxy = proxy or load_proxy_preparation(state_dir, point, prepared)
    value = P.metadata(read(directory(state_dir, point), 'app-prepared.json', 4096), byte_limit=4096)
    keys = {'schema', 'pointId', 'tokenSha256', 'rootSha256', 'contextSha256', 'configurationSetSha256', 'preparationSha256',
            'publicationProofSha256', 'proxyPreparationSha256', 'appRuntimeSha256', 'appRuntimeDaemonSha256', 'appRuntimeBytes', 'hostBindingsSha256'}
    if (not P.exact(value, keys) or value['schema'] != 'orbis.controller-app-preparation.v1' or value['pointId'] != point
            or value['rootSha256'] != prepared['rootSha256'] or value['contextSha256'] != prepared['contextSha256']
            or any(value[key] != proxy[key] for key in ('tokenSha256', 'configurationSetSha256', 'preparationSha256', 'publicationProofSha256'))
            or value['proxyPreparationSha256'] != APP.digest(P.canonical(proxy))
            or not APP.hash_value(value['appRuntimeSha256']) or not APP.hash_value(value['appRuntimeDaemonSha256'])
            or not APP.integer(value['appRuntimeBytes'], 1, APP.MAX_BYTES)):
        raise fail()
    body = read(directory(state_dir, point), 'app-runtime.json', APP.MAX_BYTES)
    if len(body) != value['appRuntimeBytes'] or APP.digest(body) != value['appRuntimeSha256']:
        raise fail()
    observed = APP.validate(APP.parse(body), app_expectations(prepared, value['appRuntimeDaemonSha256']))
    if APP.canonical(observed) != body:
        raise fail()
    bindings = read(directory(state_dir, point), 'app-host-bindings.json', APP.MAX_BYTES)
    if APP.digest(bindings) != value['hostBindingsSha256']:
        raise fail()
    bindings = APP.parse(bindings)
    sources = sorted({mount['Source'] for item in observed['containers'] for mount in item['inspect']['Mounts'] if mount.get('Type') == 'bind'})
    if (not isinstance(bindings, list) or len(bindings) != len(sources)
            or any(not P.exact(item, {'source', 'device', 'inode', 'type', 'specialDevice'}) or item['source'] != source
                   or any(type(item[key]) is not int or item[key] < 0 for key in ('device', 'inode', 'type', 'specialDevice'))
                   for item, source in zip(bindings, sources, strict=True))):
        raise fail()
    return value


def app_runtime_bytes(state_dir, point, token, prepared, expected_sha):
    value = load_app_preparation(state_dir, point, prepared)
    if value['tokenSha256'] != APP.digest(token.encode()) or value['appRuntimeSha256'] != expected_sha:
        raise fail()
    return read(directory(state_dir, point), 'app-runtime.json', APP.MAX_BYTES)


def commit_app_finalized(state_dir, point, token, prepared, app, base):
    if app != load_app_preparation(state_dir, point, prepared) or app['tokenSha256'] != APP.digest(token.encode()):
        raise fail()
    proxy = load_proxy_preparation(state_dir, point, prepared)
    # Reconstruct from the independently pinned base and proxy preparation.
    origin = load_origin_from_preparation(state_dir, point, prepared)
    original = P.metadata(origin.authority_bytes)
    expected = {key: child for key, child in original.items() if key != 'authoritySha256'}
    expected.update(schema='orbis.controller-capture-authority.v2', version=2, proxyHostIdentity=proxy['descriptor'])
    expected['authoritySha256'] = APP.digest(b'orbis.controller-capture-authority.v2\n' + P.canonical(expected))
    if base != expected:
        raise fail()
    descriptor = {key: child for key, child in base.items() if key != 'authoritySha256'}
    descriptor.update(schema='orbis.controller-capture-authority.v4', version=4,
                      appRuntimeSha256=app['appRuntimeSha256'], appRuntimeDaemonSha256=app['appRuntimeDaemonSha256'])
    authority = {**descriptor, 'authoritySha256': APP.digest(b'orbis.controller-capture-authority.v4\n' + P.canonical(descriptor))}
    plan = {'schema': 'orbis.controller-app-finalization.v1', 'pointId': point, 'tokenSha256': app['tokenSha256'],
            'appPreparationSha256': APP.digest(P.canonical(app)), 'baseAuthoritySha256': APP.digest(P.canonical(base)), 'authority': authority}
    immutable(directory(state_dir, point) / 'app-finalized.json', P.canonical(plan))
    return authority


def load_app_origin(state_dir, root, context, point):
    base = load_proxy_origin(state_dir, root, context, point)
    prepared = load_preparation(state_dir, point)
    app = load_app_preparation(state_dir, point, prepared)
    plan = P.metadata(read(directory(state_dir, point), 'app-finalized.json', RECEIPT_LIMIT), byte_limit=RECEIPT_LIMIT)
    descriptor = {key: child for key, child in P.metadata(base.authority_bytes).items() if key != 'authoritySha256'}
    descriptor.update(schema='orbis.controller-capture-authority.v4', version=4,
                      appRuntimeSha256=app['appRuntimeSha256'], appRuntimeDaemonSha256=app['appRuntimeDaemonSha256'])
    authority = {**descriptor, 'authoritySha256': APP.digest(b'orbis.controller-capture-authority.v4\n' + P.canonical(descriptor))}
    expected = {'schema': 'orbis.controller-app-finalization.v1', 'pointId': point, 'tokenSha256': app['tokenSha256'],
                'appPreparationSha256': APP.digest(P.canonical(app)), 'baseAuthoritySha256': APP.digest(base.authority_bytes), 'authority': authority}
    if plan != expected:
        raise fail()
    return RootCaptureOrigin(P.canonical(authority), base.configuration_bytes, base.publication_receipt_bytes)


def load_origin(state_dir, root, context, point):
    """Root-only origin reader for a future independently authorized restore.

    This grants no activation rights and requires no expired capture capability.
    Its private config bytes must never be serialized to a socket/HTTP response.
    The root-controlled state directory is an installed-host binding, not input
    accepted from a backend request.
    """
    from contextlib import ExitStack
    path = directory(state_dir, point)
    with ExitStack() as stack:
        parent = stack.enter_context(AUTHORITY.protected_directory(path))
        prepared_bytes = stack.enter_context(AUTHORITY.protected_file(parent, 'prepared.json', PREPARATION_LIMIT))
        plan_bytes = stack.enter_context(AUTHORITY.protected_file(parent, 'finalization.json', RECEIPT_LIMIT))
        final = stack.enter_context(AUTHORITY.protected_file(parent, 'finalized.json', RECEIPT_LIMIT))
        prepared = load_preparation(state_dir, point)
        if (prepared_bytes != P.canonical(prepared)
                or prepared['rootSha256'] != hashlib.sha256(str(root).encode()).hexdigest()
                or prepared['contextSha256'] != hashlib.sha256(context.encode()).hexdigest()):
            raise fail()
        plan = _load_finalization_plan(state_dir, point, prepared)
        if plan_bytes != P.canonical(plan) or final != P.canonical(plan['authority']):
            raise fail()
        return RootCaptureOrigin(final, P.canonical(prepared['configuration']), P.canonical(prepared['publicationReceipt']))


def commit_finalized(state_dir, point, token, prepared, proposed):
    path = directory(state_dir, point)
    try:
        plan = load_finalization(state_dir, point, token, prepared)
    except FileNotFoundError:
        plan = dict(schema='orbis.controller-capture-finalization.v1', pointId=point,
                    tokenSha256=hashlib.sha256(token.encode()).hexdigest(), authority=proposed)
        immutable(path / 'finalization.json', P.canonical(plan))
    existing = plan['authority']
    if any(existing.get(key) != value for key, value in proposed.items() if key not in {'finalizedAt', 'authoritySha256'}):
        raise fail()
    immutable(path / 'finalized.json', P.canonical(existing))
    return existing
