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
INSTALLER = None
CHANNEL_CATALOG = None
INSTALLER_SOURCE_CUSTODY = 1
CHANNEL_METADATA_URL = "https://twentylines.github.io/orbis/channels.json"
INSTALLER_BASE_URL = "https://twentylines.github.io/orbis/installer/"
ARCHIVE = "orbis-installer.tar.gz"
MANIFEST = "orbis-installer-manifest.json"
SOURCE_SELECTION = "installer-source-selection.json"
SOURCE_LAUNCHER = "installer-source-launcher.py"
SOURCE_EXECUTION = "installer-source-execution.json"
SOURCE_COPIES = "host-copy-custody"
OWNER = 0
ALLOWED = re.compile(r"scripts/(?:orbis-[a-z-]+|install-orbis|migration-preflight)\.py|scripts/(?:orbis-host-maintenance-responder|orbis-controller-bootstrap-profile)\.mjs|packaging/systemd/orbis-host\.service")
REQUIRED = {"scripts/install-orbis.py", "scripts/orbis-install.py", "scripts/orbis-install-prerequisites.py", "scripts/orbis-install-ui.py", "scripts/orbis-install-new.py", "scripts/orbis-install-replace.py", "scripts/orbis-install-fresh.py", "scripts/orbis-host-service-enable.py", "scripts/orbis-host-discovery.py", "scripts/orbis-release-check.py", "packaging/systemd/orbis-host.service", "scripts/orbis-proxy-identity.py", "scripts/orbis-host-maintenance-responder.mjs"}

REQUIRED |= {
    "scripts/orbis-host-controller-update.py",
    "scripts/orbis-controller-bootstrap-profile.py",
    "scripts/orbis-controller-bootstrap-profile.mjs",
    "scripts/orbis-reset-authority.py",
    "scripts/orbis-host-layout.py",
    "scripts/orbis-host-credential-fence.py",
    "scripts/orbis-host-credential-peer.py",
    "scripts/orbis-host-credential-service.py",
    "scripts/orbis-host-recovery-admission.py", "scripts/orbis-host-recovery-source.py",
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
    "scripts/orbis-host-controller-handoff.py",
    "scripts/orbis-host-core-restoration-review.py",
    "scripts/orbis-host-core-restoration.py",
    "scripts/orbis-host-core-live-restoration.py",
    "scripts/orbis-host-core-live-import.py",
    "scripts/orbis-host-core-reconciliation-service.py",
    "scripts/orbis-host-core-preparation-service.py",
    "scripts/orbis-host-core-local-inspection-service.py",
    "scripts/orbis-release-policy.py", "scripts/orbis-host-service.py", "scripts/orbis-host-service-setup.py", "scripts/orbis-host-sentinel-observer.py",
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
    "scripts/orbis-host-core-capture-restart-retirement.py",
    "scripts/orbis-host-core-capture-failed-recovery.py",
    "scripts/orbis-host-core-capture-abort.py", "scripts/orbis-host-core-capture-empty-abort.py", "scripts/orbis-host-core-capture-unused-abort.py",
}

REQUIRED |= {"scripts/orbis-sentinel-install.py"}
REQUIRED_V5 = REQUIRED | {"scripts/orbis-host-docker-socket-recovery.py",
    "scripts/orbis-host-upgrade-launcher.py", "scripts/orbis-host-upgrade-supervision.py",
    "scripts/orbis-host-upgrade-target.py", "scripts/orbis-host-service-setup.py",
    "scripts/orbis-host-service.py", "scripts/orbis-host-service-upgrade.py"}
SOURCE_CUSTODY_REQUIRED = frozenset({'scripts/install-orbis.py', 'scripts/orbis-install.py',
    'scripts/orbis-host-service-setup.py', 'scripts/orbis-host-service.py', 'scripts/orbis-host-service-upgrade.py',
    'scripts/orbis-sentinel-install.py', 'packaging/systemd/orbis-host.service'})
FILE_LIMITS = {"orbis.installer-bundle.v1": 66, "orbis.installer-bundle.v2": 66,
               "orbis.installer-bundle.v3": 128, "orbis.installer-bundle.v4": 128,
               "orbis.installer-bundle.v5": 160, "orbis.installer-bundle.v6": 160}


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
    base, separator, suffix = tag[1:].partition("-")
    if separator and base.endswith(".0"):
        base = base[:-2]
    return base + (" " + suffix.replace(".", " ") if separator else "")


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
        prompt = "Choose an update channel. This does not enable automatic updates.\n" + "\n".join(labels) + "\nNightly can contain incomplete features or regressions.\nChannel [1/2]: "
        choices = {"1": "stable", "2": "nightly", "stable": "stable", "nightly": "nightly"}
        while True:
            requested = choices.get(ask(prompt).strip().lower())
            if requested is None:
                print("Enter 1 for Stable or 2 for Nightly.", file=sys.stderr)
                continue
            if channels[requested] is None:
                print(f"{requested.title()} is not available yet. Choose an available channel.", file=sys.stderr)
                continue
            break
    if requested not in channels:
        raise ValueError("Choose Stable or Nightly")
    if channels[requested] is None:
        raise ValueError(f"{requested.title()} is not available yet. No other channel was selected")
    return requested, channels[requested], prompted


def select_verified_channel_launcher(catalog, requested=None, ask=None, fetch_launcher=None):
    fetch_launcher = fetch_launcher or (lambda record: fetch(
        f"https://github.com/twentylines/orbis/releases/download/{record['tag']}/install-orbis.py",
        1024 * 1024,
    ))
    while True:
        channel, record, prompted = select_channel(catalog, requested, ask)
        try:
            data = fetch_launcher(record)
            identity = verify_selected_launcher(data, record)
            return channel, record, prompted, data, identity
        except (OSError, ValueError) as error:
            if not prompted or ask is None:
                raise
            print(f"Could not load the {channel.title()} installer: {error}. Choose a channel to retry.", file=sys.stderr)
            requested = None



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


def verify_files_manifest(value, required=None):
    schema = value.get('schema')
    if not isinstance(schema, str) or schema not in FILE_LIMITS:
        raise ValueError('Installer format is unsupported')
    if required is None:
        if schema in {'orbis.installer-bundle.v1', 'orbis.installer-bundle.v2'}:
            required = LEGACY_REQUIRED
        elif schema in {'orbis.installer-bundle.v5', 'orbis.installer-bundle.v6'}:
            required = REQUIRED_V5
        else:
            required = REQUIRED
    if type(value.get("archiveBytes")) is not int or not 0 < value["archiveBytes"] <= 8 * 1024 * 1024:
        raise ValueError("Installer archive size is invalid")
    if not re.fullmatch(r"[0-9a-f]{64}", str(value.get("archiveSha256", ""))):
        raise ValueError("Installer package hash is invalid")
    files = value.get("files")
    if not isinstance(required, (set, frozenset)) or not required or not isinstance(files, dict) or not required.issubset(files) or not 1 <= len(files) <= FILE_LIMITS[schema]:
        raise ValueError("Installer file list is incomplete")
    total = 0
    for name, record in files.items():
        if not ALLOWED.fullmatch(name) or not isinstance(record, dict) or type(record.get("size")) is not int or not 0 <= record["size"] <= 1024 * 1024 or not re.fullmatch(r"[0-9a-f]{64}", str(record.get("sha256", ""))):
            raise ValueError("Installer file list contains an unsupported file")
        total += record["size"]
    if total > 8 * 1024 * 1024:
        raise ValueError("Installer files exceed their total size limit")


def source_requirements(template, schema):
    """Read the embedded reader's closed requirement sets without executing it."""
    import ast
    names = {'REQUIRED', 'LEGACY_REQUIRED', 'REQUIRED_V5'}
    values = {}
    def evaluate(node):
        if isinstance(node, ast.Set):
            value = ast.literal_eval(node)
        elif isinstance(node, ast.Name) and node.id in values:
            value = set(values[node.id])
        elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            value = evaluate(node.left) | evaluate(node.right)
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'frozenset'
              and len(node.args) == 1 and not node.keywords):
            value = evaluate(node.args[0])
        else:
            raise ValueError('Unsupported embedded installer requirement declaration')
        if type(value) is not set or not value or any(type(name) is not str or not ALLOWED.fullmatch(name) for name in value):
            raise ValueError('Invalid embedded installer requirements')
        return value
    for node in ast.parse(template).body:
        if isinstance(node, ast.Assign) and any(isinstance(item, ast.Name) and item.id in names for item in node.targets):
            if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name) or node.targets[0].id in values:
                raise ValueError('Ambiguous embedded installer requirements')
            values[node.targets[0].id] = evaluate(node.value)
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign)) and isinstance(node.target, ast.Name) and node.target.id in names:
            if not isinstance(node, ast.AugAssign) or not isinstance(node.op, ast.BitOr) or node.target.id not in values:
                raise ValueError('Ambiguous embedded installer requirements')
            values[node.target.id] |= evaluate(node.value)
    selected = ('LEGACY_REQUIRED' if schema in {'orbis.installer-bundle.v1', 'orbis.installer-bundle.v2'} else
                'REQUIRED_V5' if schema in {'orbis.installer-bundle.v5', 'orbis.installer-bundle.v6'} else 'REQUIRED')
    required = values.get(selected)
    if (schema not in FILE_LIMITS or required is None
            or len(required) > FILE_LIMITS[schema]):
        raise ValueError('Embedded installer requirements do not preserve their format contract')
    return required


def verify_source_package(data, identity, archive, *, mode='release'):
    """Validate source custody against its own reader and fixed source inputs.

    This grants no execution or publisher authority. The caller separately
    authenticates source publication or holds an actual executed selection.
    Default download/manifest verification keeps its current requirements.
    """
    if mode not in ('release', 'modular'):
        raise ValueError('Unsupported source selection mode')
    verify = verify_manifest if mode == 'release' else verify_installer_manifest
    initial = verify(data, identity, required=SOURCE_CUSTODY_REQUIRED)
    files = verify_files(archive, initial)
    required = source_requirements(files['scripts/install-orbis.py'], initial['schema'])
    manifest = verify(data, identity, required=required | SOURCE_CUSTODY_REQUIRED)
    return manifest, files


def verify_manifest(data, identity, *, required=None):
    if not isinstance(identity, dict) or not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?", str(identity.get("tag", ""))) or not re.fullmatch(r"[0-9a-f]{40}", str(identity.get("commit", ""))):
        raise ValueError("Use the installer published with an Orbis release")
    if sha(data) != identity.get("manifestSha256"):
        raise ValueError("Installer manifest does not match this release launcher")
    value = json.loads(data)
    if (not isinstance(value, dict) or not isinstance(value.get("schema"), str)
            or value["schema"] not in {"orbis.installer-bundle.v1", "orbis.installer-bundle.v3", "orbis.installer-bundle.v5"}
            or "installerCommit" in value or any(value.get(key) != identity[key] for key in ("tag", "commit"))
            or value.get("archive") != ARCHIVE):
        raise ValueError("Installer package has a different release identity")
    if not re.fullmatch(r"[0-9a-f]{64}", str(value.get("releaseManifestSha256", ""))):
        raise ValueError("Installer package hash is invalid")
    verify_files_manifest(value, required)
    return value


def verify_installer_manifest(data, identity, *, required=None):
    if not isinstance(identity, dict) or set(identity) != {"commit", "manifestSha256"} or not re.fullmatch(r"[0-9a-f]{40}", str(identity.get("commit", ""))) or not re.fullmatch(r"[0-9a-f]{64}", str(identity.get("manifestSha256", ""))):
        raise ValueError("The published installer identity is invalid")
    if sha(data) != identity["manifestSha256"]:
        raise ValueError("Installer manifest does not match this installer launcher")
    value = json.loads(data)
    if (not isinstance(value, dict) or not isinstance(value.get("schema"), str)
            or value["schema"] not in {"orbis.installer-bundle.v2", "orbis.installer-bundle.v4", "orbis.installer-bundle.v6"}
            or any(field in value for field in ("tag", "commit", "releaseManifestSha256"))
            or value.get("installerCommit") != identity["commit"] or value.get("archive") != ARCHIVE):
        raise ValueError("Installer package has a different source identity")
    verify_files_manifest(value, required)
    return value


def verify_files(data, manifest):
    if not isinstance(manifest, dict) or not isinstance(manifest.get('files'), dict):
        raise ValueError('Installer file list is invalid')
    verify_files_manifest(manifest, set(manifest['files']))
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



def _receipt_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")


def _render_installer(mode, identity, template):
    if mode == "release":
        marker = b"EXPECTED_RELEASE = " + b"None"
        if template.count(marker) != 1:
            raise ValueError("The verified installer archive cannot bind its release launcher")
        ordered = {key: identity[key] for key in ("tag", "commit", "manifestSha256")}
        launcher = template.replace(marker, ("EXPECTED_RELEASE = " + repr(ordered)).encode())
    elif mode == "modular":
        marker = b"INSTALLER = " + b"None"
        if template.count(marker) != 1:
            raise ValueError("The verified installer archive cannot bind its modular launcher")
        ordered = {key: identity[key] for key in ("commit", "manifestSha256")}
        launcher = template.replace(marker, ("INSTALLER = " + repr(ordered)).encode())
    else:
        raise ValueError("The verified installer selection mode is invalid")
    return launcher


def stage_verified_installer(destination, *, mode, identity, channel, release, manifest, archive, files):
    """Persist publisher-selected bytes as private custody before executing scripts."""
    launcher = _render_installer(mode, identity, files["scripts/install-orbis.py"])
    proofs = {SOURCE_LAUNCHER: launcher, "release-manifest.json": release, MANIFEST: manifest, ARCHIVE: archive}
    selection = _receipt_bytes({
        "schema": "orbis.installer-source-selection.v1", "mode": mode, "installer": identity, "channel": channel,
        "proofs": {name: {"bytes": len(body), "sha256": sha(body)} for name, body in proofs.items()},
    })
    # Extraction files are limited to verified bundle membership. The source
    # selection is last, so an incomplete copy cannot look ready to the child.
    directories = {destination}
    if _custody_template(files["scripts/install-orbis.py"]):
        copies = destination / SOURCE_COPIES
        copies.mkdir(mode=0o700)
        os.chmod(copies, 0o700)
        directories.add(copies)
    for name, body in {**files, **proofs, SOURCE_SELECTION: selection}.items():
        target = destination / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        directories.update(parent for parent in target.parents if parent.is_relative_to(destination))
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        with os.fdopen(fd, "wb") as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(body)
            output.flush()
            os.fsync(output.fileno())
    for folder in sorted(directories, key=lambda directory: len(directory.parts), reverse=True):
        fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return sha(selection)


def _custody_template(template):
    return any(
        isinstance(node, ast.Assign) and len(node.targets) == 1
        and isinstance(node.targets[0], ast.Name) and node.targets[0].id == "INSTALLER_SOURCE_CUSTODY"
        and isinstance(node.value, ast.Constant) and type(node.value.value) is int and node.value.value == 1
        for node in ast.parse(template).body
    )


def _held_private_file(directory, name, maximum):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    fd = os.open(name, flags, dir_fd=directory)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_nlink != 1 or not 0 < info.st_size <= maximum):
            raise ValueError("Installer proof file is unsafe")
        body = os.pread(fd, maximum + 1, 0)
        if len(body) != info.st_size or _identity(os.fstat(fd)) != _identity(info):
            raise ValueError("Installer proof changed while reading")
        return fd, body, info
    except BaseException:
        os.close(fd)
        raise


def _identity(info):
    return info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _exec_guided(destination, channel, remaining, selection=None):
    print(f"Verified installer. Recovery files: {destination}", flush=True)
    arguments = [sys.executable, str(destination / "scripts/orbis-install.py"),
        "--manifest", str(destination / "release-manifest.json"), "--state-dir", str(destination / "transactions"),
        "--channel", channel]
    if selection is not None:
        arguments.extend(("--installer-custody-sha256", selection))
    os.execv(sys.executable, [*arguments, *remaining])


def _exec_verified_installer(destination, channel, remaining, selection, files):
    if not _custody_template(files["scripts/install-orbis.py"]):
        return _exec_guided(destination, channel, remaining)
    directory = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    launcher = None
    try:
        manifest_fd, record, _ = _held_private_file(directory, SOURCE_SELECTION, 16384)
        os.close(manifest_fd)
        if sha(record) != selection:
            raise ValueError("Installer selection changed before second stage")
        launcher, body, info = _held_private_file(directory, SOURCE_LAUNCHER, 1024 * 1024)
        proof = json.loads(record)["proofs"][SOURCE_LAUNCHER]
        if (proof != {"bytes": len(body), "sha256": sha(body)}
                or _identity(os.stat(SOURCE_LAUNCHER, dir_fd=directory, follow_symlinks=False)) != _identity(info)):
            raise ValueError("Selected installer launcher changed before execution")
        os.set_inheritable(launcher, True)
        os.execv(sys.executable, [sys.executable, "-I", "-B", f"/proc/self/fd/{launcher}",
            "--continue-verified-installer", str(destination), selection, channel, *remaining])
    finally:
        if launcher is not None:
            os.close(launcher)
        os.close(directory)


def _continue_verified_installer(arguments):
    if len(arguments) < 3:
        raise ValueError("Installer continuation is missing its private selection")
    location, selection, channel, *remaining = arguments
    match = re.fullmatch(r"/proc/self/fd/([0-9]+)", __file__)
    if (match is None or channel not in ("stable", "nightly") or not re.fullmatch(r"[a-f0-9]{64}", selection)
            or any(arg.split("=", 1)[0] in {"--manifest", "--state-dir", "--installer-custody-sha256",
                                            "--continue-verified-installer", "--channel"} for arg in remaining)):
        raise ValueError("Installer continuation is not bound to the selected launcher")
    running = int(match[1])
    destination = Path(location)
    if not destination.is_absolute() or not destination.is_dir() or destination.resolve(strict=True) != destination:
        raise ValueError("Installer selection directory is missing or changed")
    destination = private_directory(destination)
    directory = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    held = []
    script_directory = driver_fd = None
    def read(name, maximum):
        fd, body, info = _held_private_file(directory, name, maximum)
        held.append((fd, name, info))
        return body, info

    def recheck():
        held_dir, named_dir = os.fstat(directory), destination.lstat()
        if (held_dir.st_dev, held_dir.st_ino, held_dir.st_uid, held_dir.st_mode) != (
                named_dir.st_dev, named_dir.st_ino, named_dir.st_uid, named_dir.st_mode):
            raise ValueError("Installer selection directory changed")
        for fd, name, info in held:
            if (_identity(os.fstat(fd)) != _identity(info)
                    or _identity(os.stat(name, dir_fd=directory, follow_symlinks=False)) != _identity(info)):
                raise ValueError("Installer proof changed before continuation")
        if (_identity(os.fstat(driver_fd)) != _identity(driver_info)
                or _identity((destination / "scripts/orbis-install.py").lstat()) != _identity(driver_info)
                or _identity(os.fstat(running)) != _identity(launcher_info)
                or os.pread(running, len(launcher) + 1, 0) != launcher):
            raise ValueError("Installer executable changed before continuation")

    try:
        record_body, _ = read(SOURCE_SELECTION, 16384)
        record = json.loads(record_body)
        mode, identity = record["mode"], record["installer"]
        if (sha(record_body) != selection or record["schema"] != "orbis.installer-source-selection.v1"
                or record["channel"] != channel or mode not in ("release", "modular")
                or identity != (EXPECTED_RELEASE if mode == "release" else INSTALLER)):
            raise ValueError("Installer selection identity changed")
        bundle, _ = read(MANIFEST, 64 * 1024)
        core, _ = read("release-manifest.json", 16 * 1024)
        archive, _ = read(ARCHIVE, 8 * 1024 * 1024)
        launcher, launcher_info = read(SOURCE_LAUNCHER, 1024 * 1024)
        if _identity(os.fstat(running)) != _identity(launcher_info) or os.pread(running, len(launcher) + 1, 0) != launcher:
            raise ValueError("Installer continuation was not executed from the held selected launcher")
        proofs = {SOURCE_LAUNCHER: launcher, "release-manifest.json": core, MANIFEST: bundle, ARCHIVE: archive}
        if record["proofs"] != {name: {"bytes": len(body), "sha256": sha(body)} for name, body in proofs.items()}:
            raise ValueError("Installer proof bytes changed before continuation")
        manifest = verify_manifest(bundle, identity) if mode == "release" else verify_installer_manifest(bundle, identity)
        if mode == "release" and sha(core) != manifest["releaseManifestSha256"]:
            raise ValueError("Selected core differs from the release-bound installer")
        files = verify_files(archive, manifest)
        if launcher != _render_installer(mode, identity, files["scripts/install-orbis.py"]):
            raise ValueError("Held launcher does not match the verified embedded template")
        script_directory = os.open("scripts", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
        driver_fd, driver, driver_info = _held_private_file(script_directory, "orbis-install.py", 1024 * 1024)
        if driver != files["scripts/orbis-install.py"]:
            raise ValueError("Guided installer differs from the verified bundle")
        recheck()
        execution = _receipt_bytes({"schema": "orbis.installer-source-execution.v1", "selectionSha256": selection,
                                    "launcherSha256": sha(launcher), "channel": channel})
        fd = os.open(SOURCE_EXECUTION, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=directory)
        with os.fdopen(fd, "wb") as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(execution)
            output.flush()
            os.fsync(output.fileno())
        os.fsync(directory)
        recheck()
        os.set_inheritable(running, False)
        _exec_guided(destination, channel, remaining, selection)
    finally:
        if driver_fd is not None:
            os.close(driver_fd)
        if script_directory is not None:
            os.close(script_directory)
        for fd, _, _ in reversed(held):
            os.close(fd)
        os.close(directory)


def run_published_installer(args, remaining):
    if not isinstance(INSTALLER, dict) or set(INSTALLER) != {"commit", "manifestSha256"} or not re.fullmatch(r"[0-9a-f]{40}", str(INSTALLER.get("commit", ""))) or not re.fullmatch(r"[0-9a-f]{64}", str(INSTALLER.get("manifestSha256", ""))):
        raise ValueError("Download the installer from the published Orbis installer endpoint")
    catalog = json.loads(fetch(CHANNEL_METADATA_URL, 16 * 1024))
    terminal = writer = None
    try:
        if args.channel is None and "--yes" not in remaining:
            terminal = open("/dev/tty", "r", encoding="utf-8")
            writer = open("/dev/tty", "w", encoding="utf-8")

        def ask(question):
            writer.write(question)
            writer.flush()
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
    release_data = fetch(f"https://github.com/twentylines/orbis/releases/download/{record['tag']}/release-manifest.json", 16 * 1024)
    release = json.loads(release_data)
    if not isinstance(release, dict) or any(release.get(key) != record[key] for key in ("tag", "commit")):
        raise ValueError("The selected release does not match its published channel")
    if release.get("schema") != "orbis.release.v1" or release.get("image") != "ghcr.io/twentylines/orbis" or release.get("installationProtocol") != "orbis.installation-state.v1" or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(release.get("digest", ""))):
        raise ValueError("The selected release has an invalid installation manifest")
    base = INSTALLER_BASE_URL + INSTALLER["commit"] + "/"
    print(f"Downloading Orbis {display_release(record['tag'])} installer…", flush=True)
    manifest_data = fetch(base + MANIFEST, 64 * 1024)
    manifest = verify_installer_manifest(manifest_data, INSTALLER)
    archive = fetch(base + ARCHIVE, manifest["archiveBytes"])
    files = verify_files(archive, manifest)
    parent = private_directory(args.work_dir)
    destination = Path(tempfile.mkdtemp(prefix="installer-" + INSTALLER["commit"][:12] + "-", dir=parent))
    selection = stage_verified_installer(destination, mode="modular", identity=INSTALLER, channel=channel,
        release=release_data, manifest=manifest_data, archive=archive, files=files)
    _exec_verified_installer(destination, channel, remaining, selection, files)


def main():
    if sys.argv[1:2] == ["--continue-verified-installer"]:
        require_supported_host()
        return _continue_verified_installer(sys.argv[2:])
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, default=Path("/var/lib/orbis/installer"))
    parser.add_argument("--channel", choices=("stable", "nightly"))
    args, remaining = parser.parse_known_args()
    require_supported_host()
    if any(arg.split("=", 1)[0] in {"--manifest", "--state-dir", "--installer-custody-sha256", "--continue-verified-installer"} for arg in remaining):
        raise ValueError("The release launcher supplies its own manifest and state directory")
    if EXPECTED_RELEASE is None and isinstance(INSTALLER, dict):
        run_published_installer(args, remaining)
        return
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

            channel, record, prompted, data, identity = select_verified_channel_launcher(catalog, args.channel, ask if terminal else None)
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
    archive = fetch(base + ARCHIVE, manifest["archiveBytes"])
    files = verify_files(archive, manifest)
    parent = private_directory(args.work_dir)
    destination = Path(tempfile.mkdtemp(prefix=identity["tag"] + "-", dir=parent))
    selection = stage_verified_installer(destination, mode="release", identity=identity, channel=channel,
        release=release_data, manifest=manifest_data, archive=archive, files=files)
    _exec_verified_installer(destination, channel, remaining, selection, files)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        print(f"Orbis installer could not start: {error}", file=sys.stderr)
        sys.exit(2)
