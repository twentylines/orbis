#!/usr/bin/env python3
"""Download and verify the installer attached to this exact Orbis release."""

import argparse
import ast
import hashlib
import io
import json
import os
import platform
import re
import stat
import sys
import tarfile
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


EXPECTED_RELEASE = None
CHANNEL_CATALOG = None
CHANNEL_METADATA_URL = "https://twentylines.github.io/orbis/channels.json"
ARCHIVE = "orbis-installer.tar.gz"
MANIFEST = "orbis-installer-manifest.json"
ALLOWED = re.compile(r"scripts/(?:orbis-[a-z-]+|install-orbis|migration-preflight)\.py|packaging/systemd/orbis-host\.service")
REQUIRED = {"scripts/install-orbis.py", "scripts/orbis-install.py", "scripts/orbis-install-ui.py", "scripts/orbis-install-new.py", "scripts/orbis-install-replace.py", "scripts/orbis-install-fresh.py", "scripts/orbis-host-service-enable.py", "scripts/orbis-host-discovery.py", "scripts/orbis-release-check.py", "packaging/systemd/orbis-host.service"}


def require_supported_host():
    if sys.platform != "linux" or os.geteuid() != 0 or sys.version_info < (3, 10):
        raise ValueError("Run this installer as root on Linux with Python 3.10 or newer")
    if sys.maxsize < 2**63 - 1 or platform.machine().lower() not in {"aarch64", "arm64", "x86_64", "amd64"}:
        raise ValueError("Orbis requires 64-bit ARM64 or AMD64 Linux. 32-bit Raspberry Pi OS is unsupported; use a 64-bit Raspberry Pi OS or Ubuntu installation")


def release_channel(tag):
    if not isinstance(tag, str) or len(tag) > 80 or not re.fullmatch(r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:beta|rc)\.(?:0|[1-9][0-9]*))?", tag) or any(int(number) > 9_007_199_254_740_991 for number in re.findall(r"[0-9]+", tag)):
        raise ValueError("The selected release tag is invalid")
    return "nightly" if "-" in tag else "stable"


def display_release(tag):
    release_channel(tag)
    return tag[1:].replace("-beta.", " beta ").replace("-rc.", " rc ")


def select_channel(catalog, requested=None, ask=None):
    if not isinstance(catalog, dict) or set(catalog) != {"schema", "channels"} or catalog["schema"] != "orbis.installer-channels.v1":
        raise ValueError("The published installer channel list is invalid")
    channels = catalog["channels"]
    if not isinstance(channels, dict) or set(channels) != {"stable", "nightly"}:
        raise ValueError("The published installer channel list is invalid")
    for name, record in channels.items():
        if record is None:
            continue
        if not isinstance(record, dict) or set(record) != {"tag", "commit", "launcherSha256"}:
            raise ValueError("The published installer release identity is invalid")
        kind = release_channel(record["tag"])
        if (name == "stable" and kind != "stable") or not re.fullmatch(r"[0-9a-f]{40}", str(record["commit"])) or not re.fullmatch(r"[0-9a-f]{64}", str(record["launcherSha256"])):
            raise ValueError("The published installer release identity is invalid")
    prompted = requested is None
    if prompted:
        if ask is None:
            raise ValueError("Choose --channel stable or --channel nightly for unattended installation")
        labels = [f"  {index}. {name.title()} — {display_release(channels[name]['tag']) if channels[name] else 'not available yet'}" for index, name in enumerate(("stable", "nightly"), 1)]
        answer = ask("Choose an update channel. This does not enable automatic updates.\n" + "\n".join(labels) + "\nNightly can contain incomplete features or regressions.\nChannel [1/2]: ").strip().lower()
        requested = {"1": "stable", "2": "nightly", "stable": "stable", "nightly": "nightly"}.get(answer)
    if requested not in channels:
        raise ValueError("Choose Stable or Nightly")
    if channels[requested] is None:
        raise ValueError(f"{requested.title()} is not available yet. No other channel was selected")
    return requested, channels[requested], prompted


def verify_selected_launcher(data, record):
    if sha(data) != record["launcherSha256"]:
        raise ValueError("The selected installer does not match its published channel")
    values = [node.value for node in ast.parse(data).body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "EXPECTED_RELEASE" for target in node.targets)]
    if len(values) != 1:
        raise ValueError("The selected installer has no unique release identity")
    identity = ast.literal_eval(values[0])
    if not isinstance(identity, dict) or set(identity) != {"tag", "commit", "manifestSha256"} or any(identity.get(key) != record[key] for key in ("tag", "commit")) or not re.fullmatch(r"[0-9a-f]{64}", str(identity.get("manifestSha256"))):
        raise ValueError("The selected installer has a different release identity")
    return identity


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
    parser.add_argument("--channel", choices=("stable", "nightly"))
    args, remaining = parser.parse_known_args()
    require_supported_host()
    if any(arg.split("=", 1)[0] in {"--manifest", "--state-dir"} for arg in remaining):
        raise ValueError("The release launcher supplies its own manifest and state directory")
    if EXPECTED_RELEASE is None:
        if not isinstance(CHANNEL_CATALOG, dict):
            raise ValueError("Download the installer from the published Orbis installer endpoint")
        catalog = json.loads(fetch(CHANNEL_METADATA_URL, 16 * 1024))
        terminal = writer = None
        try:
            if args.channel is None and "--yes" not in remaining:
                terminal = open("/dev/tty", "r", encoding="utf-8")
                writer = open("/dev/tty", "w", encoding="utf-8")

            def ask(question):
                writer.write(question); writer.flush()
                answer = terminal.readline()
                if not answer:
                    raise ValueError("Installation cancelled")
                return answer

            channel, record, prompted = select_channel(catalog, args.channel, ask if terminal else None)
        finally:
            if terminal:
                terminal.close()
            if writer:
                writer.close()
        if channel == "nightly" and "--accept-nightly" not in remaining:
            if "--yes" in remaining:
                raise ValueError("Unattended Nightly installation requires --accept-nightly")
            if prompted:
                remaining.append("--accept-nightly")
        data = fetch(f"https://github.com/twentylines/orbis/releases/download/{record['tag']}/install-orbis.py", 1024 * 1024)
        verify_selected_launcher(data, record)
        destination = Path(tempfile.mkdtemp(prefix="selected-", dir=private_directory(args.work_dir)))
        launcher = destination / "install-orbis.py"
        launcher.write_bytes(data); launcher.chmod(0o600)
        os.execv(sys.executable, [sys.executable, str(launcher), "--work-dir", str(args.work_dir), "--channel", channel, *remaining])
        return
    if not isinstance(EXPECTED_RELEASE, dict):
        raise ValueError("Download the installer from a published Orbis release")
    identity = EXPECTED_RELEASE
    channel = args.channel or release_channel(identity.get("tag"))
    if channel == "stable" and release_channel(identity.get("tag")) != "stable":
        raise ValueError("This release is not available on Stable")
    base = f"https://github.com/twentylines/orbis/releases/download/{identity['tag']}/"
    print(f"Downloading Orbis {display_release(identity['tag'])} installer…", flush=True)
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
    os.execv(sys.executable, [sys.executable, str(destination / "scripts/orbis-install.py"), "--manifest", str(release_file), "--state-dir", str(destination / "transactions"), "--channel", channel, *remaining])


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        print(f"Orbis installer could not start: {error}", file=sys.stderr)
        sys.exit(2)
