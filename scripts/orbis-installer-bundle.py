#!/usr/bin/env python3
"""Build a reproducible installer package from one committed Orbis release."""

import argparse
import gzip
import hashlib
import io
import json
import re
import subprocess
import tarfile
from pathlib import Path


SCHEMA = "orbis.installer-bundle.v1"
ARCHIVE = "orbis-installer.tar.gz"
MANIFEST = "orbis-installer-manifest.json"
LAUNCHER = "install-orbis.py"
ALLOWED = re.compile(r"scripts/(?:orbis-[a-z-]+|install-orbis|migration-preflight)\.py|packaging/systemd/orbis-host\.service")
REQUIRED = {"scripts/install-orbis.py", "scripts/orbis-install.py", "scripts/orbis-install-prerequisites.py", "scripts/orbis-install-ui.py", "scripts/orbis-install-new.py", "scripts/orbis-install-replace.py", "scripts/orbis-install-fresh.py", "scripts/orbis-host-service-enable.py", "scripts/orbis-host-discovery.py", "scripts/orbis-release-check.py", "scripts/orbis-release-policy.py", "packaging/systemd/orbis-host.service"}


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


def build(files, release_bytes):
    release = json.loads(release_bytes)
    if not isinstance(release, dict) or release.get("schema") != "orbis.release.v1" or release.get("image") != "ghcr.io/twentylines/orbis":
        raise ValueError("An Orbis release manifest is required")
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?", str(release.get("tag", ""))) or not re.fullmatch(r"[0-9a-f]{40}", str(release.get("commit", ""))):
        raise ValueError("The release tag or source commit is invalid")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(release.get("digest", ""))) or release.get("installationProtocol") != "orbis.installation-state.v1":
        raise ValueError("The release must declare a pinned installation image")
    sources = {name: data for name, data in files.items() if ALLOWED.fullmatch(name)}
    if not REQUIRED.issubset(sources) or not 1 <= len(sources) <= 64 or any(not isinstance(data, bytes) or len(data) > 1024 * 1024 for data in sources.values()):
        raise ValueError("Installer sources are missing or exceed their limits")
    if sum(len(data) for data in sources.values()) > 8 * 1024 * 1024:
        raise ValueError("Installer files exceed their total size limit")
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
            for name, data in sorted(sources.items()):
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                entry.mode = 0o600
                archive.addfile(entry, io.BytesIO(data))
    archive_bytes = output.getvalue()
    if len(archive_bytes) > 8 * 1024 * 1024:
        raise ValueError("Installer archive exceeds its limit")
    manifest = {
        "schema": SCHEMA, "tag": release["tag"], "commit": release["commit"],
        "archive": ARCHIVE, "archiveBytes": len(archive_bytes), "archiveSha256": sha(archive_bytes),
        "releaseManifestSha256": sha(release_bytes),
        "files": {name: {"sha256": sha(data), "size": len(data)} for name, data in sorted(sources.items())},
    }
    manifest_bytes = (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode()
    identity = {"tag": release["tag"], "commit": release["commit"], "manifestSha256": sha(manifest_bytes)}
    launcher = release_launcher(files.get("scripts/" + LAUNCHER, b""), identity)
    return {ARCHIVE: archive_bytes, MANIFEST: manifest_bytes, LAUNCHER: launcher}


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
