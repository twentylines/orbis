#!/usr/bin/env python3
"""Download and verify the installer attached to this exact Orbis release."""

import argparse
import hashlib
import io
import json
import os
import re
import stat
import sys
import tarfile
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


EXPECTED_RELEASE = None
ARCHIVE = "orbis-installer.tar.gz"
MANIFEST = "orbis-installer-manifest.json"
ALLOWED = re.compile(r"scripts/(?:orbis-[a-z-]+|install-orbis|migration-preflight)\.py|packaging/systemd/orbis-host\.service")
REQUIRED = {"scripts/install-orbis.py", "scripts/orbis-install.py", "scripts/orbis-install-ui.py", "scripts/orbis-install-new.py", "scripts/orbis-install-replace.py", "scripts/orbis-install-fresh.py", "scripts/orbis-host-service-enable.py", "scripts/orbis-host-discovery.py", "scripts/orbis-release-check.py", "packaging/systemd/orbis-host.service"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url, limit):
    request = Request(url, headers={"User-Agent": "Orbis-installer/1"})
    with urlopen(request, timeout=30) as response:
        if urlsplit(response.geturl()).scheme != "https":
            raise ValueError("Installer downloads require HTTPS")
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError("Installer download exceeds its size limit")
        return data


def verify_manifest(data, identity, *, required=REQUIRED):
    if not isinstance(identity, dict) or not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?", str(identity.get("tag", ""))) or not re.fullmatch(r"[0-9a-f]{40}", str(identity.get("commit", ""))):
        raise ValueError("Use the installer published with an Orbis release")
    if sha(data) != identity.get("manifestSha256"):
        raise ValueError("Installer manifest does not match this release launcher")
    value = json.loads(data)
    if not isinstance(value, dict) or value.get("schema") != "orbis.installer-bundle.v1" or any(value.get(key) != identity[key] for key in ("tag", "commit")) or value.get("archive") != ARCHIVE:
        raise ValueError("Installer package has a different release identity")
    if type(value.get("archiveBytes")) is not int or not 0 < value["archiveBytes"] <= 8 * 1024 * 1024:
        raise ValueError("Installer archive size is invalid")
    for key in ("archiveSha256", "releaseManifestSha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", str(value.get(key, ""))):
            raise ValueError("Installer package hash is invalid")
    files = value.get("files")
    if not isinstance(required, set) or not required or not isinstance(files, dict) or not required.issubset(files) or not 1 <= len(files) <= 64:
        raise ValueError("Installer file list is incomplete")
    total = 0
    for name, record in files.items():
        if not ALLOWED.fullmatch(name) or not isinstance(record, dict) or type(record.get("size")) is not int or not 0 <= record["size"] <= 1024 * 1024 or not re.fullmatch(r"[0-9a-f]{64}", str(record.get("sha256", ""))):
            raise ValueError("Installer file list contains an unsupported file")
        total += record["size"]
    if total > 8 * 1024 * 1024:
        raise ValueError("Installer files exceed their total size limit")
    return value


def verify_files(data, manifest):
    if len(data) != manifest["archiveBytes"] or sha(data) != manifest["archiveSha256"]:
        raise ValueError("Installer archive does not match its manifest")
    result = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for entry in archive:
            if not ALLOWED.fullmatch(entry.name) or entry.name not in manifest["files"] or entry.name in result or not entry.isreg() or entry.issparse():
                raise ValueError("Installer archive contains an unexpected or unsafe entry")
            record = manifest["files"][entry.name]
            if entry.size != record["size"]:
                raise ValueError("Installer file size does not match its manifest")
            with archive.extractfile(entry) as stream:
                content = stream.read(record["size"] + 1)
            if len(content) != record["size"] or sha(content) != record["sha256"]:
                raise ValueError("Installer file hash does not match its manifest")
            result[entry.name] = content
    if set(result) != set(manifest["files"]):
        raise ValueError("Installer archive is missing required files")
    return result


def private_directory(path):
    if not path.is_absolute() or path != path.resolve(strict=False):
        raise ValueError("Installer working directory must be an absolute path without symlinks")
    for parent in reversed([path, *path.parents]):
        if not parent.exists():
            parent.mkdir(mode=0o700)
        details = parent.lstat()
        if not stat.S_ISDIR(details.st_mode) or details.st_uid != 0 or stat.S_IMODE(details.st_mode) & 0o022:
            raise ValueError("Installer working directory has an unsafe parent")
    details = path.lstat()
    if not stat.S_ISDIR(details.st_mode) or details.st_uid != 0 or stat.S_IMODE(details.st_mode) & 0o077:
        raise ValueError("Installer working directory must be private and root-owned")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, default=Path("/var/lib/orbis/installer"))
    args, remaining = parser.parse_known_args()
    if sys.platform != "linux" or os.geteuid() != 0 or sys.version_info < (3, 10):
        raise ValueError("Run this installer as root on Linux with Python 3.10 or newer")
    if any(arg.split("=", 1)[0] in {"--manifest", "--state-dir"} for arg in remaining):
        raise ValueError("The release launcher supplies its own manifest and state directory")
    if not isinstance(EXPECTED_RELEASE, dict):
        raise ValueError("Download install-orbis.py from a published Orbis release")
    identity = EXPECTED_RELEASE
    base = f"https://github.com/twentylines/orbis/releases/download/{identity['tag']}/"
    print(f"Downloading Orbis {identity['tag']} installer…", flush=True)
    manifest_data = fetch(base + MANIFEST, 64 * 1024)
    manifest = verify_manifest(manifest_data, identity)
    release_data = fetch(base + "release-manifest.json", 16 * 1024)
    if sha(release_data) != manifest["releaseManifestSha256"]:
        raise ValueError("Core image manifest does not match the installer release")
    release = json.loads(release_data)
    if any(release.get(key) != identity[key] for key in ("tag", "commit")):
        raise ValueError("Core image and installer have different source identities")
    files = verify_files(fetch(base + ARCHIVE, manifest["archiveBytes"]), manifest)
    parent = private_directory(args.work_dir)
    destination = Path(tempfile.mkdtemp(prefix=identity["tag"] + "-", dir=parent))
    for name, content in files.items():
        file = destination / name
        file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        file.write_bytes(content)
        file.chmod(0o600)
    release_file = destination / "release-manifest.json"
    release_file.write_bytes(release_data)
    release_file.chmod(0o600)
    package_manifest = destination / MANIFEST
    package_manifest.write_bytes(manifest_data)
    package_manifest.chmod(0o600)
    print(f"Verified installer. Recovery files: {destination}", flush=True)
    os.execv(sys.executable, [sys.executable, str(destination / "scripts/orbis-install.py"), "--manifest", str(release_file), "--state-dir", str(destination / "transactions"), *remaining])


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        print(f"Orbis installer could not start: {error}", file=sys.stderr)
        sys.exit(2)
