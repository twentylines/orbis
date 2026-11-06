#!/usr/bin/env python3
"""Protected helper contracts; point eligibility still requires root review."""
import hashlib
import json
from pathlib import Path
import re


CAPTURE_DOMAIN = b'orbis.controller-capture-capability.v3\n'
RESTORE_DOMAIN = b'orbis.retained-restore-capability.v2\n'
ARCHIVE_DOMAIN = b'orbis.backup-archive-capability.v1\n'
VOLUME_DOMAIN = b'orbis.backup-volume-capture-capability.v1\n'
SOURCE_DOMAIN = b'orbis.host-helper-source.v1\n'
MAX_SOURCE_FILES = 128
VOLUME_REQUIRED = {'orbis-host-volume-capture.py', 'orbis-host-volume-engine.py', 'orbis-host-volume-inventory.py', 'orbis-host-volume-service.py'}
NAMES = re.compile(r'(?:orbis-[a-z-]+|install-orbis|migration-preflight)\.py|orbis-host-maintenance-responder\.mjs')
REQUIRED = {'orbis-host-service.py', 'orbis-host.py', 'orbis-host-identity.py', 'orbis-host-retained-authority.py',
            'orbis-host-layout.py', 'orbis-reset-authority.py', 'orbis-proxy-identity.py', 'orbis-proxy-adoption.py',
            'orbis-host-capture-authority.py', 'orbis-host-app-runtime.py', 'orbis-host-retained-restore.py',
            'orbis-host-retained-restore-runtime.py', 'orbis-host-normal-bootstrap.py', 'orbis-host-retained-app-driver.py',
            'orbis-host-retained-app-effects.py', 'orbis-host-app-create-intent.py', 'orbis-host-app-port-policy.py',
            'orbis-host-app-port-observer.py', 'orbis-host-app-inet-diag.py', 'orbis-host-time-machine-capabilities.py'}


def fail():
    return ValueError('Protected native helper contracts are unavailable')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf8')


def source_digest(authority, *, directory=None, extra_required=()):
    # The service never accepts a source path from a request. Substitution is an
    # explicit code-owned filesystem fixture seam, like the authority owner policy.
    path = Path(__file__).resolve().parent if directory is None else Path(directory)
    with authority.protected_directory(path, private=False) as descriptor:
        import os
        names = sorted(name for name in os.listdir(descriptor) if NAMES.fullmatch(name))
        if not REQUIRED.union(extra_required) <= set(names) or len(names) > MAX_SOURCE_FILES: raise fail()
        files, total = {}, 0
        for name in names:
            with authority.protected_file(descriptor, name, 1024 * 1024, private=False) as body:
                if not body: raise fail()
                if name.endswith('.py'):
                    try: compile(body, name, 'exec')
                    except (SyntaxError, UnicodeError) as error: raise fail() from error
                total += len(body)
                if total > 8 * 1024 * 1024: raise fail()
                files[name] = hashlib.sha256(body).hexdigest()
    return hashlib.sha256(SOURCE_DOMAIN + canonical(files)).hexdigest()


def capability(kind, authority, *, directory=None):
    extra = VOLUME_REQUIRED if kind == 'volume' else set()
    source = source_digest(authority, directory=directory, extra_required=extra)
    if kind == 'capture':
        value = {'version': 3, 'runtimeSchema': 'orbis.time-machine-runtime.v6',
                 'imageCaptureSchema': 'orbis.time-machine-image-capture.v2',
                 'controllerAuthoritySchema': 'orbis.controller-capture-authority.v4',
                 'appRuntimeSchema': 'orbis.app-runtime-capture.v1',
                 'proxyHostIdentitySchema': 'orbis.proxy-host-identity-policy.v1',
                 'coherenceSchema': 'orbis.capture-coherence.v1', 'sourceSha256': source}
        domain = CAPTURE_DOMAIN
    elif kind == 'restore':
        value = {'version': 2, 'runtimeSchema': 'orbis.time-machine-runtime.v6',
                 'controllerAuthoritySchema': 'orbis.controller-capture-authority.v4',
                 'coordinatorProtocol': 'orbis.retained-worker-phase.v1',
                 'candidateAppResultProtocol': 'root-candidate-app-result.v1',
                 'targetAppCapability': 'orbis.retained-app-engine.v1',
                 'normalBootstrapProtocol': 'root-normal-bootstrap.v1',
                 'portsProtocol': 'inet-diag-self-proof.v1', 'sourceSha256': source}
        domain = RESTORE_DOMAIN
    elif kind == 'archive':
        value = {'version': 1, 'format': 'orbis-full-backup', 'manifestVersion': 2,
                 'mediaPolicy': 'explicit-inclusion.v1', 'appDataLinks': 'confined-relative.v1',
                 'sourceSha256': source}
        domain = ARCHIVE_DOMAIN
    elif kind == 'volume':
        value = {'version': 1, 'schema': 'orbis.backup-volume-capture.v1', 'manifestVersion': 3,
                 'appRuntimeSchema': 'orbis.app-runtime-capture.v1', 'inventorySchema': 'orbis.backup-volume-inventory.v1',
                 'authority': 'root-controller-capture-fence.v2', 'scope': 'orbis-managed-writers.v1', 'sourceSha256': source}
        domain = VOLUME_DOMAIN
    else:
        raise fail()
    return {**value, 'contractSha256': hashlib.sha256(domain + canonical(value)).hexdigest()}
