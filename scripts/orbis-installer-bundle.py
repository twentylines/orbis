#!/usr/bin/env python3
"""Build a reproducible installer package from one committed Orbis release."""

import argparse
import ast
import gzip
import hashlib
import io
import json
import re
import subprocess
import tarfile
from pathlib import Path


SCHEMA = "orbis.installer-bundle.v3"
INSTALLER_SCHEMA = "orbis.installer-bundle.v4"
FILE_LIMITS = {"orbis.installer-bundle.v1": 66, "orbis.installer-bundle.v2": 66,
               "orbis.installer-bundle.v3": 128, "orbis.installer-bundle.v4": 128}
ARCHIVE = "orbis-installer.tar.gz"
MANIFEST = "orbis-installer-manifest.json"
LAUNCHER = "install-orbis.py"
ALLOWED = re.compile(r"scripts/(?:orbis-[a-z-]+|install-orbis|migration-preflight)\.py|scripts/(?:orbis-host-maintenance-responder|orbis-controller-bootstrap-profile)\.mjs|packaging/systemd/orbis-host\.service")
REQUIRED = {"scripts/install-orbis.py", "scripts/orbis-install.py", "scripts/orbis-install-prerequisites.py", "scripts/orbis-install-ui.py", "scripts/orbis-install-new.py", "scripts/orbis-install-replace.py", "scripts/orbis-install-fresh.py", "scripts/orbis-host-service-enable.py", "scripts/orbis-host-discovery.py", "scripts/orbis-release-check.py", "scripts/orbis-release-policy.py", "packaging/systemd/orbis-host.service", "scripts/orbis-proxy-identity.py", "scripts/orbis-host-maintenance-responder.mjs"}

REQUIRED |= {
    "scripts/orbis-host-controller-update.py",
    "scripts/orbis-controller-bootstrap-profile.py",
    "scripts/orbis-controller-bootstrap-profile.mjs",
    "scripts/orbis-reset-authority.py",
    "scripts/orbis-host-layout.py",
    "scripts/orbis-proxy-adoption.py",
    "scripts/orbis-host-app-create-intent.py",
    "scripts/orbis-host-app-inet-diag.py",
    "scripts/orbis-host-app-port-observer.py",
    "scripts/orbis-host-app-port-policy.py",
    "scripts/orbis-host-retained-app-driver.py",
    "scripts/orbis-host-retained-app-effects.py",
    "scripts/orbis-host-time-machine-capabilities.py",
    "scripts/orbis-host-volume-capture.py",
    "scripts/orbis-host-volume-engine.py",
    "scripts/orbis-host-volume-inventory.py",
    "scripts/orbis-host-volume-service.py",
    "scripts/orbis-app-volume-authority.py",
}

LEGACY_REQUIRED = frozenset(REQUIRED)
REQUIRED |= {
    "scripts/orbis-host-service.py", "scripts/orbis-host-service-setup.py", "scripts/orbis-host-sentinel-observer.py",
    "scripts/orbis-host-observer-profile.py",
    "scripts/orbis-host-time-machine-core.py", "scripts/orbis-host-core-storage-map.py", "scripts/orbis-host-core-checkpoint.py",
    "scripts/orbis-host-core-capture-reader.py", "scripts/orbis-host-core-capture-service.py", "scripts/orbis-host-core-capture-worker.py",
    "scripts/orbis-host-sentinel-capture.py",
    "scripts/orbis-host-sentinel-publication.py",
    "scripts/orbis-host-sentinel-auto-publication.py",
    "scripts/orbis-host-sentinel-reader.py",
    "scripts/orbis-host-core-capture-lease.py", "scripts/orbis-host-core-capture-reservation.py", "scripts/orbis-host-core-capture-reserved.py",
    "scripts/orbis-host-core-capture-supervisor.py", "scripts/orbis-host-core-capture-completion.py", "scripts/orbis-host-core-capture-retirement.py",
    "scripts/orbis-host-core-capture-namespace.py",
    "scripts/orbis-host-core-capture-abort.py", "scripts/orbis-host-core-capture-empty-abort.py", "scripts/orbis-host-core-capture-unused-abort.py",
}

BUILD_ONLY = {"scripts/orbis-installer-bundle.py", "scripts/orbis-migration-fingerprint.py",
              "scripts/orbis-release-metadata.py", "scripts/orbis-release-watermark.py"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def committed_files(repository, commit):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("A full release commit is required")
    rows = subprocess.check_output(["git", "ls-tree", "-rz", commit], cwd=repository).split(b"\0")
    result = {}
    for row in rows:
        if not row:
            continue
        metadata, name = row.split(b"\t", 1)
        name = name.decode("utf-8")
        if not ALLOWED.fullmatch(name) and name != "scripts/" + LAUNCHER:
            continue
        mode, kind, _ = metadata.split()
        if mode not in {b"100644", b"100755"} or kind != b"blob":
            raise ValueError("Installer sources must be committed regular files")
        result[name] = subprocess.check_output(["git", "show", f"{commit}:{name}"], cwd=repository)
    return result


def release_launcher(template, identity):
    if template.count(b"EXPECTED_RELEASE = None") != 1:
        raise ValueError("The committed installer launcher has no unique release marker")
    launcher = template.replace(b"EXPECTED_RELEASE = None", ("EXPECTED_RELEASE = " + repr(identity)).encode())
    compile(launcher, LAUNCHER, "exec")
    return launcher


def source_contract(files):
    source = files.get('scripts/orbis-installer-bundle.py')
    if source is None:
        return SCHEMA, INSTALLER_SCHEMA
    values = {}
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign):
            names = [target.id for target in node.targets if isinstance(target, ast.Name) and target.id in {'SCHEMA', 'INSTALLER_SCHEMA'}]
            for name in names:
                if name in values:
                    raise ValueError('Ambiguous installer source contract')
                values[name] = ast.literal_eval(node.value)
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)) and isinstance(node.target, ast.Name) and node.target.id in {'SCHEMA', 'INSTALLER_SCHEMA'}:
            raise ValueError('Ambiguous installer source contract')
    pair = values.get('SCHEMA'), values.get('INSTALLER_SCHEMA')
    if any(value is not None and type(value) is not str for value in pair) or pair not in {('orbis.installer-bundle.v1', None), ('orbis.installer-bundle.v1', 'orbis.installer-bundle.v2'),
                    ('orbis.installer-bundle.v3', 'orbis.installer-bundle.v4')}:
        raise ValueError('Unsupported installer source contract')
    return pair


def source_required(files):
    source = files.get('scripts/orbis-installer-bundle.py')
    if source is None:
        return set(REQUIRED)
    result = None
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'REQUIRED' for target in node.targets):
            if result is not None:
                raise ValueError('Ambiguous installer requirements')
            value = ast.literal_eval(node.value)
            if type(value) is not set or any(type(name) is not str for name in value):
                raise ValueError('Invalid installer requirements')
            result = set(value)
        elif isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name) and node.target.id == 'REQUIRED':
            if result is None or not isinstance(node.op, ast.BitOr):
                raise ValueError('Invalid installer requirements')
            value = ast.literal_eval(node.value)
            if type(value) is not set or any(type(name) is not str for name in value):
                raise ValueError('Invalid installer requirements')
            result.update(value)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == 'REQUIRED':
            raise ValueError('Ambiguous installer requirements')
    schema, _ = source_contract(files)
    if not result or len(result) > FILE_LIMITS[schema] or any(not ALLOWED.fullmatch(name) for name in result):
        raise ValueError('Installer requirements exceed their source contract')
    return result


def source_excluded(files):
    source = files.get('scripts/orbis-installer-bundle.py')
    if source is None:
        return set(BUILD_ONLY)
    definitions = [node.value for node in ast.parse(source).body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'BUILD_ONLY' for target in node.targets)]
    if len(definitions) > 1:
        raise ValueError('Ambiguous installer build tools')
    excluded = ast.literal_eval(definitions[0]) if definitions else set()
    if type(excluded) is not set or any(type(name) is not str or not ALLOWED.fullmatch(name) for name in excluded):
        raise ValueError('Invalid installer build tools')
    if excluded & source_required(files):
        raise ValueError('Installer build tools overlap runtime requirements')
    return excluded


def sources(files, *, schema=None):
    release_schema, independent_schema = source_contract(files)
    schema = schema or release_schema
    if schema not in (release_schema, independent_schema) or schema not in FILE_LIMITS:
        raise ValueError('Installer format differs from its committed source')
    excluded = source_excluded(files)
    values = {name: data for name, data in files.items() if ALLOWED.fullmatch(name) and name not in excluded}
    if not source_required(files).issubset(values) or not 1 <= len(values) <= FILE_LIMITS[schema] or any(not isinstance(data, bytes) or len(data) > 1024 * 1024 for data in values.values()):
        raise ValueError("Installer sources are missing or exceed their limits")
    if sum(len(data) for data in values.values()) > 8 * 1024 * 1024:
        raise ValueError("Installer files exceed their total size limit")
    return values


def archive(values):
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as tar:
            for name, data in sorted(values.items()):
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                entry.mode = 0o600
                tar.addfile(entry, io.BytesIO(data))
    data = output.getvalue()
    if len(data) > 8 * 1024 * 1024:
        raise ValueError("Installer archive exceeds its limit")
    return data


def file_records(values):
    return {name: {"sha256": sha(data), "size": len(data)} for name, data in sorted(values.items())}


def build(files, release_bytes):
    release = json.loads(release_bytes)
    if not isinstance(release, dict) or release.get("schema") != "orbis.release.v1" or release.get("image") != "ghcr.io/twentylines/orbis":
        raise ValueError("An Orbis release manifest is required")
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?", str(release.get("tag", ""))) or not re.fullmatch(r"[0-9a-f]{40}", str(release.get("commit", ""))):
        raise ValueError("The release tag or source commit is invalid")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(release.get("digest", ""))) or release.get("installationProtocol") != "orbis.installation-state.v1":
        raise ValueError("The release must declare a pinned installation image")
    schema, _ = source_contract(files)
    values = sources(files, schema=schema)
    archive_bytes = archive(values)
    manifest = {
        "schema": schema, "tag": release["tag"], "commit": release["commit"],
        "archive": ARCHIVE, "archiveBytes": len(archive_bytes), "archiveSha256": sha(archive_bytes),
        "releaseManifestSha256": sha(release_bytes),
        "files": file_records(values),
    }
    manifest_bytes = (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode()
    identity = {"tag": release["tag"], "commit": release["commit"], "manifestSha256": sha(manifest_bytes)}
    launcher = release_launcher(files.get("scripts/" + LAUNCHER, b""), identity)
    return {ARCHIVE: archive_bytes, MANIFEST: manifest_bytes, LAUNCHER: launcher}


def build_installer(files, installer_commit):
    if not re.fullmatch(r"[0-9a-f]{40}", str(installer_commit)):
        raise ValueError("The installer source commit is invalid")
    _, schema = source_contract(files)
    if schema is None:
        raise ValueError('This source predates independently versioned installers')
    values = sources(files, schema=schema)
    archive_bytes = archive(values)
    manifest = {
        "schema": schema, "installerCommit": installer_commit,
        "archive": ARCHIVE, "archiveBytes": len(archive_bytes), "archiveSha256": sha(archive_bytes),
        "files": file_records(values),
    }
    manifest_bytes = (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode()
    return {ARCHIVE: archive_bytes, MANIFEST: manifest_bytes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release_manifest", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    release_bytes = args.release_manifest.read_bytes()
    release = json.loads(release_bytes)
    repository = Path(__file__).resolve().parent.parent
    commit = release.get("commit")
    files = committed_files(repository, commit)
    assets = build(files, release_bytes)
    args.output.mkdir(mode=0o700)
    for name, data in assets.items():
        (args.output / name).write_bytes(data)
    print(json.dumps({"tag": release["tag"], "commit": commit, "assets": {name: sha(data) for name, data in assets.items()}}, indent=2))


if __name__ == "__main__":
    main()
