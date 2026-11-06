#!/usr/bin/env python3
"""Inspect local release bytes before any registry or release upload."""

import argparse
import base64
import gzip
import hashlib
import importlib.util
import io
import json
import math
import os
import posixpath
import re
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path


INDEX = 'application/vnd.oci.image.index.v1+json'
MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
CONFIG = 'application/vnd.oci.image.config.v1+json'
LAYERS = {'application/vnd.oci.image.layer.v1.tar': False, 'application/vnd.oci.image.layer.v1.tar+gzip': True}
ATTESTATION = 'application/vnd.in-toto+json'
DIGEST = re.compile(r'sha256:[a-f0-9]{64}')
PRIVATE_NAMES = {'agents.md', 'claude.md', 'handoff.md', 'acceptance.md', 'progress.md', '.netrc', '.npmrc'}
PRIVATE_PARTS = {'.orbis-private', '.ssh', '.aws', '.gnupg', '.git'}
RUNTIME_HIDDEN_DIRECTORIES = {'.bin', '.well-known'}
# The pinned public Node image contains this empty npm placeholder.
PUBLIC_EMPTY_FILES = {'usr/local/lib/node_modules/npm/.npmrc'}
KEY_SUFFIXES = {'.key', '.p12', '.pfx', '.jks', '.keystore'}
TRUST_ROOTS = ('etc/ssl/', 'etc/pki/', 'usr/share/ca-certificates/', 'usr/local/share/ca-certificates/')
# Official v2.40.0 checksums bind upstream build paths to public Compose bytes.
# https://github.com/docker/compose/releases/download/v2.40.0/checksums.txt
PUBLIC_BUILD_PATHS = {
    'usr/local/bin/docker-compose': {
        'fa99ca94c96c8cae4024493581a20049764ce723558991d0d1526c1c7b791a79',
        'bd5835ccbbf06a42dcb5294c65e34a4634b34447afb9ed6fc7adf18a000e0f99',
    },
    # Exact executables from the immutable official Node index used by Dockerfile.
    # registry-1.docker.io/v2/library/node/manifests/sha256:206878a60dc7014193f418ab9259b6110c15fbd514b3044a267be706509944e4
    'usr/local/bin/node': {
        '5a92a46a1d8279fec6776e3123ca22e26a6fddbb7cf1b55e019dbb38eea8ff26',
        'c3be880da6ef2075b119ab02968a822ef96fe23c92c94a1e406b77d6d9c6e59e',
    },
}
# Alpine's compatibility certificate aliases refer to the public CA bundle.
# github.com/alpinelinux/aports/tree/master/main/ca-certificates
PUBLIC_CERTIFICATE_LINKS = {'etc/ssl1.1/cert.pem': '/etc/ssl/cert.pem'}

# Public APK version/cache markers, not authentication secrets.
# github.com/alpinelinux/apk-tools/blob/v3.0.8/src/app_upgrade.c
# Exact executables from the pinned Alpine platform layers used by Dockerfile.
PUBLIC_APK_FILES = {'sbin/apk': {
    '7a7bdf9b9021b676b2842657257bb99d77b3047dbb08100600e6616e72e035b6',
    'd77b885bef835f8cade6fe3feba2fe504896e16ecfe599fa54352fef68a11d4d',
}}
PUBLIC_APK_MARKERS = {b'APK_PREUPGRADE_TOKEN', b'APK_SELFUPGRADE_TOKEN'}

# Public Alpine build roots and literal examples in upstream Node/npm docs.
# These prefixes classify only the path signal; other credential rules still run.
# Public sources: gitlab.alpinelinux.org/alpine/aports,
# github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node,
# github.com/lukeed/escalade, github.com/ChALkeR/safer-buffer, github.com/nodejs/nan,
# github.com/npm/cli, github.com/npm/nopt, github.com/nodejs/node-gyp,
# github.com/isomorphic-git/isomorphic-git (published source comments).
PUBLIC_PATH_REFERENCES = tuple(re.compile(value) for value in (
    rb'/(?:home)/buildozer/aports/',
    rb'/(?:home)/user/(?:dir\b|bin\b)',
    rb'/(?:Users)/mjr/work/node/process-args\.js',
    rb'/(?:Users)/lukeed/oss(?:/escalade)?\b',
    rb'/(?:home)/chalker/repo/safer-buffer/example\.unsafe\.js',
    rb'/(?:Users)/ofrobots/\.node-gyp/0\.12\.18/include/node/(?:node|v8)\.h',
    rb'/(?:Users)/claudiahdz/projects/my-cool-pkg\b',
    rb'/(?:home)/knight/src/gyp/trunk/test/lib\b',
    rb'/(?:Users)/isaacs/b/a/z\b',
    rb'/(?:Users)/Will/AppData/Local/Programs/Git/src/utils\b',
))
RULES = {
    'personal-path': re.compile(rb'/(?:Users|home)/(?!node/|bun/|nobody/|root/)[A-Za-z0-9._-]+/'),
    'private-key': re.compile(rb'-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\r\n]+[A-Za-z0-9+/=\r\n]{32,32768}-----END \1-----'),
    'github-token': re.compile(rb'(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})'),
    'cloud-access-key': re.compile(rb'(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])'),
    'service-token': re.compile(rb'(?<![A-Za-z0-9])(?:xox[baprs]-[A-Za-z0-9-]{20,255}|sk_live_[A-Za-z0-9]{20,255}|AIza[A-Za-z0-9_-]{35})'),
    'api-token': re.compile(rb'(?:sk-|hf_|glpat-|npm_|pypi-)[A-Za-z0-9_-]{32,512}'),
    'private-session': re.compile(rb'(?i)(?:cookie|authorization)[\t ]*[:=][\t ]*[\"\']?(?:bearer[\t ]+[A-Za-z0-9._-]{20,}|(?:runtipi|orbis)-sid=[a-f0-9-]{36})'),
    'signed-token': re.compile(rb'(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,2048}\.[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{20,1024}'),
}
ASSIGNMENT = re.compile(rb'''(?i)(?<![A-Za-z0-9_])(?:(?:jwt|postgres|rabbitmq|database)[_-])?(?:password|passwd|secret|token|api[_-]?key|access[_-]?token|client[_-]?secret)["']?[\t ]*[=:][\t ]*["']([A-Za-z0-9_+/=.!-]{16,256})["']''')
ENVIRONMENT = re.compile(rb'''(?:^|[\x00\r\n" ])(?:[A-Z0-9_]{0,96}(?:PASSWORD|SECRET|TOKEN|API_KEY)[A-Z0-9_]{0,96})=([A-Za-z0-9_+/=.!-]{16,512})''')
CHUNK = 128 * 1024
WINDOW = 64 * 1024
MAX_JSON = 8 * 1024 * 1024
MAX_FILE = 2 * 1024**3
MAX_TOTAL = 24 * 1024**3
MAX_ENTRIES = 500_000


class Rejected(ValueError):
    pass


def reject(rule, location='artifact'):
    # Location counters identify the stream without echoing sensitive names or bytes.
    raise Rejected(f'{rule} at {location}')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_TOTAL:
        reject('unsafe-input')
    with path.open('rb') as stream:
        result = hashlib.sha256()
        for chunk in iter(lambda: stream.read(CHUNK), b''):
            result.update(chunk)
    return result.hexdigest()


def normalized(name):
    if not isinstance(name, str) or '\\' in name or '\x00' in name or name.startswith('/'):
        reject('unsafe-archive-path')
    parts = name.split('/')
    if '..' in parts:
        reject('unsafe-archive-path')
    return posixpath.normpath(name).removeprefix('./')


def private_path(name, directory=False):
    path = normalized(name)
    if path == '.':
        return False
    pieces = path.lower().split('/')
    base = pieces[-1]
    folders = path.split('/') if directory else path.split('/')[:-1]
    if any(piece.startswith('.') and piece not in RUNTIME_HIDDEN_DIRECTORIES for piece in folders):
        return True
    if path in PUBLIC_EMPTY_FILES:
        return False
    if base.startswith('.wh.'):
        return private_path('/'.join(pieces[:-1] + [base[4:]])) if base != '.wh..wh..opq' else False
    if (set(pieces) & PRIVATE_PARTS or base in PRIVATE_NAMES or '.private.' in base or
            base == '.env' or base.startswith('.env.') or base.endswith('.env') or '.env.' in base or
            base.startswith(('id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa')) or
            Path(base).suffix in KEY_SUFFIXES):
        return True
    return base.endswith('.pem') and not path.startswith(TRUST_ROOTS)


class Content:
    def __init__(self, location, defer=()):
        self.location = location
        self.tail = b''
        self.offset = 0
        self.deferred = {rule: set() for rule in defer}

    def feed(self, chunk):
        value = self.tail + chunk
        for rule, pattern in RULES.items():
            if rule == 'personal-path':
                continue
            if rule in self.deferred:
                for match in pattern.finditer(value):
                    self.deferred[rule].add((self.offset - len(self.tail) + match.start(), self.offset - len(self.tail) + match.end()))
                    if len(self.deferred[rule]) > 10000:
                        reject('content-signal-limit', self.location)
            elif pattern.search(value):
                reject(rule, self.location)
        for pattern in (ASSIGNMENT, ENVIRONMENT):
            for match in pattern.finditer(value):
                token = match[1]
                entropy = -sum((token.count(c) / len(token)) * math.log2(token.count(c) / len(token)) for c in set(token))
                if entropy >= 3.5:
                    name = match[0].split(b'=', 1)[0].lstrip(b'\x00\r\n" ')
                    if pattern is ENVIRONMENT and name in PUBLIC_APK_MARKERS and 'apk-upgrade-marker' in self.deferred:
                        self.deferred['apk-upgrade-marker'].add((self.offset - len(self.tail) + match.start(), self.offset - len(self.tail) + match.end()))
                        if len(self.deferred['apk-upgrade-marker']) > 10000:
                            reject('content-signal-limit', self.location)
                    else:
                        reject('credential-assignment', self.location)
        self.personal_paths(value, self.offset - len(self.tail), final=False)
        self.tail = value[-WINDOW:]
        self.offset += len(chunk)

    def personal_paths(self, value, offset, final):
        for match in RULES['personal-path'].finditer(value):
            if not final and len(value) - match.end() < 256:
                continue
            # An HTTP URL path named "home" is not an absolute filesystem home.
            if re.search(rb'https?://[A-Za-z0-9.-]+(?:/[A-Za-z0-9._~-]+)*$', value[max(0, match.start() - 256):match.start()]):
                continue
            if any(pattern.match(value, match.start()) for pattern in PUBLIC_PATH_REFERENCES):
                continue
            if 'personal-path' not in self.deferred:
                reject('personal-path', self.location)
            self.deferred['personal-path'].add((offset + match.start(), offset + match.end()))
            if len(self.deferred['personal-path']) > 10000:
                reject('content-signal-limit', self.location)

    def finish(self):
        self.personal_paths(self.tail, self.offset - len(self.tail), final=True)


class Budget:
    def __init__(self):
        self.bytes = 0
        self.entries = 0

    def add(self, amount):
        self.bytes += amount
        if self.bytes > MAX_TOTAL:
            reject('decompressed-size-limit')


class CheckedReader:
    def __init__(self, source, content, budget):
        self.source, self.content, self.budget = source, content, budget

    def read(self, size=-1):
        if size < 0:
            reject('unbounded-read')
        chunk = self.source.read(size)
        self.budget.add(len(chunk))
        self.content.feed(chunk)
        if not chunk:
            self.content.finish()
        return chunk


def scan_stream(stream, location, budget):
    scanner = Content(location)
    while chunk := stream.read(CHUNK):
        budget.add(len(chunk))
        scanner.feed(chunk)
    scanner.finish()


def public_certificates(data):
    blocks = re.findall(rb'-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END CERTIFICATE-----', data)
    if not blocks:
        return False
    remaining = re.sub(rb'-----BEGIN CERTIFICATE-----\s*[A-Za-z0-9+/=\s]+?\s*-----END CERTIFICATE-----', b'', data)
    if remaining.strip():
        return False
    try:
        return all(base64.b64decode(re.sub(rb'\s', b'', block), validate=True).startswith(b'\x30') for block in blocks)
    except ValueError:
        return False


class Prefixed:
    def __init__(self, prefix, source):
        self.prefix, self.source = prefix, source

    def read(self, size):
        if size < 0:
            reject('unbounded-read')
        before, self.prefix = self.prefix[:size], self.prefix[size:]
        return before + self.source.read(size - len(before))


def tar_header(prefix):
    if len(prefix) != tarfile.BLOCKSIZE:
        return False
    try:
        tarfile.TarInfo.frombuf(prefix, 'utf-8', 'surrogateescape')
    except tarfile.HeaderError:
        return False
    return True


def scan_body(stream, location, budget, depth):
    if depth > 3:
        reject('nested-archive-limit', location)
    prefix = stream.read(512)
    body = Prefixed(prefix, stream)
    if prefix.startswith((b'\xfd7zXZ\x00', b'BZh', b'\x28\xb5\x2f\xfd', b'7z\xbc\xaf\x27\x1c', b'Rar!')):
        reject('unsupported-nested-archive', location)
    if prefix.startswith(b'\x1f\x8b'):
        # A gzip payload may be a tar or a single compressed file.
        decoded = gzip.GzipFile(fileobj=body)
        scan_body(decoded, location + '.gzip', budget, depth + 1)
    elif prefix.startswith(b'PK\x03\x04'):
        with tempfile.TemporaryFile() as copied:
            size = 0
            while chunk := body.read(CHUNK):
                size += len(chunk)
                if size > MAX_FILE:
                    reject('nested-archive-limit', location)
                copied.write(chunk)
            copied.seek(0)
            with zipfile.ZipFile(copied) as archive:
                for number, member in enumerate(archive.infolist()):
                    budget.entries += 1
                    entry = f'{location}.zip{number}'
                    if budget.entries > MAX_ENTRIES or member.file_size > MAX_FILE or member.flag_bits & 1:
                        reject('nested-archive-limit', entry)
                    if private_path(member.filename, member.is_dir()):
                        reject('private-file', entry)
                    metadata = Content(entry)
                    metadata.feed(member.filename.encode())
                    metadata.finish()
                    if not member.is_dir():
                        with archive.open(member) as source:
                            scan_body(source, entry, budget, depth + 1)
    elif tar_header(prefix):
        scan_tar(body, location + '.tar', budget, depth=depth + 1)
    else:
        scan_stream(body, location, budget)


class MemberReader:
    def __init__(self, source):
        self.source = source
        self.bytes = 0
        self.digest = hashlib.sha256()
        self.failed = False

    def read(self, size):
        if size < 0:
            reject('unbounded-read')
        try:
            chunk = self.source.read(size)
        except Exception:
            self.failed = True
            raise
        self.bytes += len(chunk)
        self.digest.update(chunk)
        return chunk

    def rejection_identity(self, size, location, budget):
        if self.failed:
            return None
        while self.bytes < size:
            chunk = self.read(min(CHUNK, size - self.bytes))
            budget.add(len(chunk))
            if not chunk:
                return None
        if self.bytes != size:
            return None
        return {'memberSha256': self.digest.hexdigest(), 'memberBytes': size, 'memberCounter': location}


def scan_tar(source, location, budget, compressed=False, depth=0):
    if depth > 3:
        reject('nested-archive-limit', location)
    decoded = gzip.GzipFile(fileobj=source) if compressed else source
    raw = Content(location, defer={'personal-path', 'apk-upgrade-marker'})
    checked = CheckedReader(decoded, raw, budget)
    public_ranges = []
    public_marker_ranges = []
    with tarfile.open(fileobj=checked, mode='r|', bufsize=CHUNK) as archive:
        for number, member in enumerate(archive):
            budget.entries += 1
            if budget.entries > MAX_ENTRIES or member.size > MAX_FILE or member.size < 0 or member.issparse():
                reject('archive-limit', location)
            entry = f'{location}.entry{number}'
            name = normalized(member.name)
            public_certificate_link = member.issym() and PUBLIC_CERTIFICATE_LINKS.get(name) == member.linkname
            if private_path(name, member.isdir()) and not public_certificate_link:
                reject('private-file', entry)
            metadata = Content(entry)
            metadata.feed(json.dumps({'name': member.name, 'link': member.linkname, 'pax': member.pax_headers}).encode())
            metadata.finish()
            if member.issym() or member.islnk():
                target = member.linkname
                if target.startswith('/'):
                    target = normalized(target[1:])
                elif member.issym():
                    target = normalized(posixpath.normpath(posixpath.join(posixpath.dirname(name), target)))
                else:
                    target = normalized(target)
                if private_path(target):
                    reject('private-link', entry)
            elif member.isfile():
                source = archive.extractfile(member)
                if source is None:
                    reject('missing-archive-body', entry)
                stream = MemberReader(source)
                try:
                    if name in PUBLIC_EMPTY_FILES:
                        if member.size != 0:
                            reject('private-file', entry)
                    elif name.endswith('.pem'):
                        if member.size > MAX_JSON or not public_certificates(stream.read(MAX_JSON + 1)):
                            reject('non-public-certificate', entry)
                    elif name in PUBLIC_BUILD_PATHS:
                        digest = hashlib.sha256()
                        content = Content(entry, defer={'personal-path'})
                        while chunk := stream.read(CHUNK):
                            digest.update(chunk)
                            content.feed(chunk)
                        content.finish()
                        if digest.hexdigest() not in PUBLIC_BUILD_PATHS[name]:
                            reject('upstream-file-identity-mismatch', entry)
                        public_ranges.append((member.offset_data, member.offset_data + member.size))
                    elif name in PUBLIC_APK_FILES:
                        digest = hashlib.sha256()
                        content = Content(entry, defer={'apk-upgrade-marker'})
                        while chunk := stream.read(CHUNK):
                            digest.update(chunk)
                            content.feed(chunk)
                        content.finish()
                        if digest.hexdigest() not in PUBLIC_APK_FILES[name]:
                            reject('upstream-file-identity-mismatch', entry)
                        public_marker_ranges.append((member.offset_data, member.offset_data + member.size))
                    else:
                        # Every historical member is read, including nested compressed content.
                        scan_body(stream, entry, budget, depth)
                except Rejected as error:
                    try:
                        identity = stream.rejection_identity(member.size, entry, budget)
                    except (OSError, ValueError, tarfile.TarError, EOFError):
                        identity = None
                    if identity is not None and not hasattr(error, 'artifact'):
                        error.artifact = identity
                    raise
            elif not member.isdir():
                reject('unsupported-archive-entry', entry)
    # Tar readers stop at the end marker; scan any remaining decoded bytes too.
    while checked.read(CHUNK):
        pass
    if any(not any(start <= left and right <= end for start, end in public_ranges) for left, right in raw.deferred['personal-path']):
        reject('personal-path', location)
    if any(not any(start <= left and right <= end for start, end in public_marker_ranges) for left, right in raw.deferred['apk-upgrade-marker']):
        reject('credential-assignment', location)


class Image:
    def __init__(self, path):
        self.path = path
        self.archive = tarfile.open(path, mode='r:')
        self.files = {}
        for member in self.archive:
            name = normalized(member.name)
            if member.isdir():
                continue
            if not member.isfile() or member.issparse() or name in self.files or member.size > MAX_FILE:
                reject('invalid-oci-entry')
            if name not in {'oci-layout', 'index.json', 'manifest.json'} and not re.fullmatch(r'blobs/sha256/[a-f0-9]{64}', name):
                reject('unexpected-oci-entry')
            self.files[name] = member
            if len(self.files) > 4096:
                reject('oci-entry-limit')
        self.used = set()
        self.layers = {}
        self.platforms = set()

    def close(self):
        self.archive.close()

    def read(self, name, limit=MAX_JSON):
        member = self.files.get(name)
        if member is None or member.size > limit:
            reject('missing-or-large-oci-metadata')
        stream = self.archive.extractfile(member)
        if stream is None:
            reject('missing-oci-body')
        return stream.read(limit + 1)

    def blob(self, descriptor):
        if not isinstance(descriptor, dict) or not DIGEST.fullmatch(str(descriptor.get('digest', ''))):
            reject('invalid-oci-descriptor')
        digest = descriptor['digest']
        name = 'blobs/sha256/' + digest[7:]
        member = self.files.get(name)
        if member is None or type(descriptor.get('size')) is not int or descriptor['size'] != member.size or descriptor.get('urls'):
            reject('incomplete-oci-descriptor')
        self.used.add(name)
        return name

    def document(self, descriptor):
        name = self.blob(descriptor)
        data = self.read(name)
        if 'sha256:' + sha(data) != descriptor['digest']:
            reject('oci-digest-mismatch')
        return json.loads(data)

    def identity(self, tag, commit):
        if json.loads(self.read('oci-layout')) != {'imageLayoutVersion': '1.0.0'}:
            reject('unsupported-oci-layout')
        index = json.loads(self.read('index.json'))
        roots = index.get('manifests')
        if index.get('schemaVersion') != 2 or not isinstance(roots, list) or len(roots) != 1 or roots[0].get('mediaType') != INDEX:
            reject('ambiguous-oci-root')
        root = self.document(roots[0])
        self.walk(root, tag, commit, set(), 0)
        if self.platforms != {'linux/amd64', 'linux/arm64'}:
            reject('unsupported-image-platforms')
        if set(self.files) - {'oci-layout', 'index.json', 'manifest.json'} != self.used:
            reject('unreferenced-oci-blob')
        return roots[0]['digest']

    def walk(self, index, tag, commit, ancestry, depth):
        if depth > 4 or not isinstance(index, dict) or index.get('schemaVersion') != 2 or index.get('mediaType') != INDEX:
            reject('invalid-image-index')
        descriptors = index.get('manifests')
        if not isinstance(descriptors, list) or not 1 <= len(descriptors) <= 32:
            reject('invalid-image-index')
        for descriptor in descriptors:
            name = self.blob(descriptor)
            if name in ancestry:
                reject('recursive-image-index')
            document = self.document(descriptor)
            if descriptor.get('mediaType') == INDEX:
                self.walk(document, tag, commit, ancestry | {name}, depth + 1)
                continue
            if descriptor.get('mediaType') != MANIFEST or document.get('schemaVersion') != 2 or document.get('mediaType') != MANIFEST:
                reject('unsupported-image-manifest')
            config = document.get('config')
            if not isinstance(config, dict) or config.get('mediaType') not in {CONFIG, 'application/vnd.oci.empty.v1+json'}:
                reject('unsupported-image-config')
            configuration = self.document(config)
            platform = descriptor.get('platform', {})
            attestation = descriptor.get('annotations', {}).get('vnd.docker.reference.type') == 'attestation-manifest'
            if attestation:
                if platform != {'architecture': 'unknown', 'os': 'unknown'}:
                    reject('invalid-attestation-platform')
            else:
                label = f"{platform.get('os')}/{platform.get('architecture')}"
                if label not in {'linux/amd64', 'linux/arm64'} or label in self.platforms:
                    reject('unsupported-image-platforms')
                if configuration.get('os') != platform['os'] or configuration.get('architecture') != platform['architecture']:
                    reject('image-config-platform-mismatch')
                labels = configuration.get('config', {}).get('Labels', {})
                if labels.get('org.opencontainers.image.revision') != commit or labels.get('org.opencontainers.image.version') != tag:
                    reject('image-source-identity-mismatch')
                self.platforms.add(label)
            layers = document.get('layers')
            if not isinstance(layers, list) or len(layers) > 256:
                reject('invalid-image-layers')
            for layer in layers:
                name = self.blob(layer)
                media = layer.get('mediaType')
                if media not in ({ATTESTATION} if attestation else set(LAYERS)):
                    reject('unsupported-image-layer')
                if name in self.layers and self.layers[name] != media:
                    reject('conflicting-layer-type')
                self.layers[name] = media

    def scan(self, budget):
        for number, (name, member) in enumerate(sorted(self.files.items())):
            location = f'oci.blob{number}'
            stream = self.archive.extractfile(member)
            if stream is None:
                reject('missing-oci-body', location)
            scanner = Content(location)
            digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(CHUNK), b''):
                budget.add(len(chunk))
                if self.layers.get(name) != 'application/vnd.oci.image.layer.v1.tar':
                    scanner.feed(chunk)
                digest.update(chunk)
            scanner.finish()
            if name.startswith('blobs/') and digest.hexdigest() != name.rsplit('/', 1)[1]:
                reject('oci-digest-mismatch', location)
            media = self.layers.get(name)
            if media in LAYERS:
                source = self.archive.extractfile(member)
                try:
                    scan_tar(source, location + '.layer', budget, LAYERS[media])
                except Rejected as error:
                    if hasattr(error, 'artifact'):
                        error.artifact['layerDigest'] = 'sha256:' + name.rsplit('/', 1)[1]
                    raise


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def installer_files(manifest_path, installer, notes, digest, tag, commit, budget, repository=None):
    build = load('orbis-installer-bundle')
    plan = load('orbis-release-plan')
    release_bytes = manifest_path.read_bytes()
    release = plan.validate_manifest(json.loads(release_bytes))
    if release['tag'] != tag or release['commit'] != commit or release['digest'] != digest:
        reject('installer-image-identity-mismatch')
    source = build.committed_files(repository or Path(__file__).resolve().parent.parent, commit)
    expected = build.build(source, release_bytes)
    if installer.is_symlink() or {file.name for file in installer.iterdir()} != set(expected):
        reject('unexpected-installer-assets')
    result = {}
    for number, (name, data) in enumerate(expected.items()):
        path = installer / name
        if path.is_symlink() or not path.is_file() or path.read_bytes() != data:
            reject('installer-source-mismatch', f'installer.asset{number}')
        scan_stream(io.BytesIO(data), f'installer.asset{number}', budget)
        if name.endswith('.tar.gz'):
            scan_tar(io.BytesIO(data), 'installer.archive', budget, True)
        result[name] = sha(data)
    for location, file in [('release.manifest', manifest_path), ('release.notes', notes)]:
        if file.is_symlink() or not file.is_file() or file.stat().st_size > MAX_JSON:
            reject('unsafe-release-file', location)
        with file.open('rb') as stream:
            scan_stream(stream, location, budget)
        result[location] = file_hash(file)
    return result


def github_json(path, token, body=None, missing=False):
    request = urllib.request.Request(
        'https://api.github.com/repos/twentylines/orbis/' + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            if response.status != (201 if body is not None else 200):
                reject('git-reference-unverified')
            return json.loads(response.read(16384))
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        if missing and status == 404:
            return None
        reject('git-reference-unverified')


def ensure_release_tag(tag, commit, token, create):
    if create:
        if (os.environ.get('GITHUB_REF') != 'refs/heads/main' or os.environ.get('GITHUB_SHA') != commit or
                not re.fullmatch(r'v\d+\.\d+\.\d+-(?:beta|rc)\.\d+', tag)):
            reject('nightly-dispatch-must-use-main')
        main = github_json('git/ref/heads/main', token)
        target = main.get('object', {})
        if main.get('ref') != 'refs/heads/main' or target.get('type') != 'commit' or target.get('sha') != commit:
            reject('main-advanced-before-publication')
    ref = github_json('git/ref/tags/' + tag, token, missing=True)
    if ref is None:
        if not create:
            reject('release-tag-missing')
        ref = github_json('git/refs', token, {'ref': 'refs/tags/' + tag, 'sha': commit})
    if ref.get('ref') != 'refs/tags/' + tag:
        reject('release-tag-mismatch')
    target = ref.get('object', {})
    for _ in range(4):
        if target.get('type') != 'tag':
            break
        value = target.get('sha')
        if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{40}', value):
            reject('release-tag-mismatch')
        target = github_json('git/tags/' + value, token).get('object', {})
    if target.get('type') != 'commit' or target.get('sha') != commit:
        reject('release-tag-mismatch')


def publish_image(oci, digest, tag, authfile, commit, create_tag=False, candidate=False):
    if candidate and (create_tag or not re.fullmatch(r'v\d+\.\d+\.\d+-rc\.\d+', tag)):
        reject('invalid-candidate-publication')
    if not authfile or authfile.is_symlink() or not authfile.is_file():
        reject('missing-registry-authentication')
    token = os.environ.get('GH_TOKEN')
    if not token:
        reject('missing-release-authentication')
    request = urllib.request.Request(
        f'https://api.github.com/repos/twentylines/orbis/releases/tags/{tag}',
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json'},
    )
    try:
        with urllib.request.urlopen(request, timeout=15):
            reject('release-already-exists')
    except urllib.error.HTTPError as error:
        error.close()
        if error.code != 404:
            reject('release-absence-unverified')
    with urllib.request.urlopen('https://ghcr.io/token?scope=repository:twentylines/orbis:pull&service=ghcr.io', timeout=15) as response:
        pull_token = json.loads(response.read(16384))['token']
    request = urllib.request.Request(
        f'https://ghcr.io/v2/twentylines/orbis/manifests/{tag}', method='HEAD',
        headers={'Authorization': 'Bearer ' + pull_token, 'Accept': INDEX},
    )
    try:
        with urllib.request.urlopen(request, timeout=15):
            reject('registry-tag-already-exists')
    except urllib.error.HTTPError as error:
        error.close()
        if error.code != 404:
            reject('registry-absence-unverified')
    if candidate:
        if os.environ.get('GITHUB_REF') != 'refs/heads/main' or os.environ.get('GITHUB_SHA') != commit:
            reject('candidate-must-use-main')
        main = github_json('git/ref/heads/main', token)
        target = main.get('object', {})
        if main.get('ref') != 'refs/heads/main' or target.get('type') != 'commit' or target.get('sha') != commit:
            reject('main-advanced-before-publication')
        if github_json('git/ref/tags/' + tag, token, missing=True) is not None:
            reject('candidate-git-tag-already-exists')
    else:
        ensure_release_tag(tag, commit, token, create_tag)
    target = f'docker://ghcr.io/twentylines/orbis:{tag}'
    result = subprocess.run(
        ['skopeo', 'copy', '--all', '--preserve-digests', '--authfile', str(authfile), 'oci-archive:' + str(oci.resolve()), target],
        capture_output=True,
    )
    if result.returncode:
        reject('registry-copy-failed')
    published = subprocess.run(['skopeo', 'inspect', '--raw', '--authfile', str(authfile), target], capture_output=True)
    if published.returncode or 'sha256:' + sha(published.stdout) != digest:
        reject('published-index-digest-mismatch')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['identity', 'scan', 'verify', 'publish', 'publish-candidate'])
    parser.add_argument('--oci', type=Path, required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--installer', type=Path)
    parser.add_argument('--notes', type=Path)
    parser.add_argument('--report', type=Path)
    parser.add_argument('--github-output', type=Path)
    parser.add_argument('--registry-auth', type=Path)
    parser.add_argument('--create-tag', action='store_true')
    args = parser.parse_args(argv)
    image = None
    stage = 'image-read'
    try:
        if args.mode == 'publish-candidate' and (args.create_tag or not re.fullmatch(r'v\d+\.\d+\.\d+-rc\.\d+', args.tag)):
            reject('invalid-candidate-publication')
        if not re.fullmatch(r'v\d+\.\d+\.\d+(?:-(?:beta|rc)\.\d+)?', args.tag) or not re.fullmatch(r'[a-f0-9]{40}', args.commit):
            reject('invalid-release-identity')
        archive_sha = file_hash(args.oci)
        image = Image(args.oci)
        stage = 'image-identity'
        digest = image.identity(args.tag, args.commit)
        result = {'imageDigest': digest, 'archiveSha256': archive_sha, 'tag': args.tag, 'commit': args.commit,
                  'platforms': sorted(image.platforms)}
        if args.mode != 'identity':
            if not all([args.manifest, args.installer, args.notes, args.report]):
                reject('missing-scan-input')
            budget = Budget()
            if args.mode == 'scan':
                stage = 'image-content'
                image.scan(budget)
            stage = 'installer-assets'
            artifacts = installer_files(args.manifest, args.installer, args.notes, digest, args.tag, args.commit, budget)
            stage = 'artifact-identity'
            if file_hash(args.oci) != archive_sha:
                reject('scanned-artifact-changed')
            result.update(artifacts=artifacts, passed=True)
            if args.mode in {'verify', 'publish', 'publish-candidate'}:
                stage = 'scan-receipt'
                prior = json.loads(args.report.read_bytes())
                if prior != result:
                    reject('scanned-artifact-changed')
            else:
                args.report.write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
                args.report.chmod(0o600)
            if args.mode == 'publish':
                stage = 'image-publication'
                publish_image(args.oci, digest, args.tag, args.registry_auth, args.commit, args.create_tag)
            elif args.mode == 'publish-candidate':
                stage = 'image-publication'
                publish_image(args.oci, digest, args.tag, args.registry_auth, args.commit, candidate=True)
        if args.github_output:
            with args.github_output.open('a') as output:
                output.write(f'digest={digest}\n')
        print(json.dumps({'mode': args.mode, **result}, sort_keys=True))
        return 0
    except Rejected as error:
        result = {'passed': False, 'error': str(error)}
        if hasattr(error, 'artifact'):
            result['artifact'] = error.artifact
        print(json.dumps(result))
        return 1
    except (OSError, ValueError, TypeError, KeyError, AttributeError, tarfile.TarError, zipfile.BadZipFile, EOFError) as error:
        print(json.dumps({'passed': False, 'error': 'invalid-or-unreadable-artifact', 'stage': stage, 'exception': type(error).__name__}))
        return 1
    finally:
        if image:
            image.close()


if __name__ == '__main__':
    raise SystemExit(main())
