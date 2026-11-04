#!/usr/bin/env python3
"""Expose bounded host readings, reviewed updates, and explicit restarts over a Unix socket.

Run this service outside the Orbis container. Socket file permissions are the
transport boundary; the web API must separately authenticate its user.
"""

import argparse
import base64
import hashlib
import http.server
import importlib.util
import json
import secrets
import os
import re
import select
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, urlsplit


def load_script(name: str, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, Path(__file__).with_name(name))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


UPDATE = load_script("orbis-host-update.py", "orbis_update_for_service")
PACKAGES = load_script("orbis-host-packages.py", "orbis_packages_for_service")
TELEMETRY = load_script("orbis-host-telemetry.py", "orbis_telemetry_for_service").HostTelemetry()
PROCESSES = load_script("orbis-host-processes.py", "orbis_processes_for_service").HostProcesses()
SENSORS = load_script("orbis-host-sensors.py", "orbis_sensors_for_service").HostSensors()
DRIVES = load_script("orbis-host-drives.py", "orbis_drives_for_service")
DISCOVERY = load_script("orbis-host-discovery.py", "orbis_discovery_for_service")
CONTROLLER_IDENTITY = load_script("orbis-controller-identity.py", "orbis_controller_identity_for_service")
HOST = UPDATE.HOST
CAPTURE_AUTHORITY = load_script("orbis-host-capture-authority.py", "orbis_capture_authority_for_service")
CAPTURE_AUTHORITY.AUTHORITY = HOST.AUTHORITY
TIME_MACHINE_CAPABILITIES = load_script("orbis-host-time-machine-capabilities.py", "orbis_native_time_machine_capabilities")
PLAN = HOST.PLAN
CHECK = UPDATE.CHECK
POLICY = PLAN.POLICY
PLAN_TTL_SECONDS = 15 * 60
BODY_LIMIT = 64 * 1024
PACKAGE_OUTPUT_BYTES = 8192
RESTART_PLAN_TTL_SECONDS = 120
CAPTURE_FENCE_TTL = 120
CAPTURE_FENCE_MAX = 60 * 60
CONTROLLER_CONFIG_FILES = ("docker-compose.yml", ".env", "user-config/tipi-compose.yml", "orbis-host-compose.yml", "orbis-compose.yml")
CONTROLLER_CONFIG_FILE_LIMIT = 1024 * 1024
CONTROLLER_CONFIG_TOTAL_LIMIT = 4 * 1024 * 1024


def capture_stat(details):
    return (details.st_dev, details.st_ino, details.st_uid, details.st_gid, details.st_mode,
            details.st_nlink, details.st_size, details.st_mtime_ns, details.st_ctime_ns)


def read_capture_job(file: Path):
    if file.parent.resolve(strict=True) != file.parent:
        raise ValueError("host capture operation state is invalid")
    try:
        descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    try:
        before = os.fstat(descriptor)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.geteuid()
                or stat.S_IMODE(before.st_mode) & 0o077 or before.st_size > 65536):
            raise ValueError("host capture operation state is invalid")
        data = os.read(descriptor, 65537)
        if len(data) != before.st_size or capture_stat(before) != capture_stat(os.fstat(descriptor)) or capture_stat(before) != capture_stat(file.lstat()):
            raise ValueError("host capture operation state changed")
        value = json.loads(data)
        if not isinstance(value, dict):
            raise ValueError("host capture operation state is invalid")
        return value
    finally:
        os.close(descriptor)


@contextmanager
def controller_config_files(root: Path):
    descriptors = []
    def opened(name, flags, parent=None):
        descriptor = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        descriptors.append(descriptor)
        return descriptor
    try:
        if root.resolve(strict=True) != root:
            raise ValueError("controller configuration root is invalid")
        root_fd = opened(root, os.O_RDONLY | os.O_DIRECTORY)
        root_stat = os.fstat(root_fd)
        trusted_owners = {os.geteuid(), root_stat.st_uid}
        directories = [(root, None, root_fd, root_stat)]
        if stat.S_IMODE(root_stat.st_mode) & 0o022 or capture_stat(root_stat) != capture_stat(root.lstat()):
            raise ValueError("controller configuration root is not protected")
        try:
            user_fd = opened("user-config", os.O_RDONLY | os.O_DIRECTORY, root_fd)
        except FileNotFoundError:
            user_fd = None
        if user_fd is not None:
            user_stat = os.fstat(user_fd)
            if user_stat.st_uid not in trusted_owners or stat.S_IMODE(user_stat.st_mode) & 0o022:
                raise ValueError("controller configuration directory is not protected")
            directories.append(("user-config", root_fd, user_fd, user_stat))
        state_fd = opened(HOST.STATE_NAME, os.O_RDONLY, root_fd)
        state_stat = os.fstat(state_fd)
        if (not stat.S_ISREG(state_stat.st_mode) or state_stat.st_nlink != 1 or state_stat.st_uid not in trusted_owners
                or stat.S_IMODE(state_stat.st_mode) & 0o077 or state_stat.st_size > 16384):
            raise ValueError("controller enrollment is not protected")
        state_bytes = os.read(state_fd, 16385)
        if len(state_bytes) != state_stat.st_size:
            raise ValueError("controller enrollment changed")
        enrollment = json.loads(state_bytes)
        files = []
        seals = [(root_fd, HOST.STATE_NAME, state_fd, state_stat)]
        total = 0
        for relative in CONTROLLER_CONFIG_FILES:
            parent = user_fd if relative.startswith("user-config/") else root_fd
            name = relative.split("/")[-1]
            try:
                details = os.stat(name, dir_fd=parent, follow_symlinks=False) if parent is not None else None
            except FileNotFoundError:
                details = None
            if details is None:
                if relative in {"docker-compose.yml", ".env", "orbis-compose.yml"}:
                    raise ValueError("required controller configuration is absent")
                files.append({"path": relative, "present": False})
                seals.append((parent, name, None, None))
                continue
            mode = stat.S_IMODE(details.st_mode)
            if (not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_uid not in trusted_owners
                    or mode & 0o7022 or details.st_size > CONTROLLER_CONFIG_FILE_LIMIT):
                raise ValueError("controller configuration file is unsafe")
            descriptor = opened(name, os.O_RDONLY, parent)
            if capture_stat(os.fstat(descriptor)) != capture_stat(details):
                raise ValueError("controller configuration changed")
            data = bytearray()
            while True:
                deadline = HOST.CAPTURE_READ_DEADLINE.get()
                if deadline is not None and time.monotonic() >= deadline:
                    raise ValueError("controller configuration capture timed out")
                block = os.read(descriptor, min(65536, CONTROLLER_CONFIG_FILE_LIMIT + 1 - len(data)))
                if not block:
                    break
                data.extend(block)
                if len(data) > CONTROLLER_CONFIG_FILE_LIMIT:
                    raise ValueError("controller configuration exceeds its limit")
            total += len(data)
            if len(data) != details.st_size or total > CONTROLLER_CONFIG_TOTAL_LIMIT:
                raise ValueError("controller configuration exceeds its limit")
            files.append({"path": relative, "present": True, "bytes": len(data), "mode": mode,
                          "uid": details.st_uid, "gid": details.st_gid, "device": str(details.st_dev), "inode": str(details.st_ino),
                          "mtimeNs": str(details.st_mtime_ns), "ctimeNs": str(details.st_ctime_ns),
                          "sha256": hashlib.sha256(data).hexdigest(), "data": base64.b64encode(data).decode("ascii")})
            seals.append((parent, name, descriptor, details))
        root_identity = {"device": str(root_stat.st_dev), "inode": str(root_stat.st_ino), "uid": root_stat.st_uid,
                         "gid": root_stat.st_gid, "mode": stat.S_IMODE(root_stat.st_mode),
                         "pathSha256": hashlib.sha256(str(root).encode()).hexdigest()}
        yield root_identity, files, enrollment
        for parent, name, descriptor, before in seals:
            if parent is None:
                if (root / "user-config").exists() or (root / "user-config").is_symlink():
                    raise ValueError("controller configuration changed")
                continue
            try:
                after = os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                after = None
            if before is None:
                if after is not None:
                    raise ValueError("controller configuration changed")
            elif after is None or capture_stat(before) != capture_stat(after) or capture_stat(before) != capture_stat(os.fstat(descriptor)):
                raise ValueError("controller configuration changed")
        for name, parent, descriptor, before in directories:
            after = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if capture_stat(before) != capture_stat(after) or capture_stat(before) != capture_stat(os.fstat(descriptor)):
                raise ValueError("controller configuration directory changed")
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def plan_is_current(created_at: object, lifetime: int) -> bool:
    now = time.time()
    return type(created_at) in (int, float) and now - lifetime <= created_at <= now


def boot_id() -> str:
    value = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
    return str(uuid.UUID(value))


@contextmanager
def package_locks():
    descriptors = []
    try:
        for name in ("/var/lib/dpkg/lock-frontend", "/var/lib/dpkg/lock", "/var/lib/apt/lists/lock", "/var/cache/apt/archives/lock"):
            try:
                descriptor = os.open(name, os.O_RDWR | os.O_NOFOLLOW)
            except FileNotFoundError:
                continue
            descriptors.append(descriptor)
            try:
                HOST.fcntl.lockf(descriptor, HOST.fcntl.LOCK_EX | HOST.fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise ValueError("a host package manager is active; wait before restarting") from error
        yield
    finally:
        for descriptor in descriptors:
            os.close(descriptor)


def terminal_tail(path: Path) -> dict:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return {"text": "", "bytes": 0, "truncated": False, "updatedAt": None}
    with os.fdopen(descriptor, "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) & 0o077:
            raise ValueError("package output must be a private regular file")
        start = max(0, metadata.st_size - PACKAGE_OUTPUT_BYTES)
        stream.seek(start)
        raw = stream.read(PACKAGE_OUTPUT_BYTES)
    if start:
        raw = raw.partition(b"\n")[2]
    text = raw.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))", "", text)
    text = "".join(char for char in text if char in "\n\t" or ord(char) >= 32 and ord(char) != 127)
    def public_url(match):
        value = re.sub(r"(?<=://)[^/\s]*@", "[redacted]@", match[0])
        return re.split(r"[?#]", value, maxsplit=1)[0] + ("?[redacted]" if "?" in value or "#" in value else "")
    text = re.sub(r"https?://[^\s]+", public_url, text)
    text = re.sub(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*", r"\1 [redacted]", text)
    text = re.sub(r"(?im)\b(password|passwd|token|secret|api[_-]?key|authorization)(\s*(?::|=)\s*|\s+)[^\n]+", r"\1\2[redacted]", text)
    return {"text": text, "bytes": metadata.st_size, "truncated": start > 0, "updatedAt": metadata.st_mtime}


def write_private(path: Path, data: dict) -> None:
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    temporary = Path(name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(data, stream, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def read_private(path: Path) -> dict | None:
    if path.is_symlink():
        raise ValueError("host service state is a symlink")
    if not path.exists():
        return None
    if not path.is_file():
        raise ValueError("host service state is not a regular file")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("host service state is invalid")
    return data


def channel_file(root: Path, *, create: bool = False) -> Path:
    state = root / "state"
    if create:
        state.mkdir(mode=0o700, exist_ok=True)
    if state.is_symlink() or (state.exists() and (not state.is_dir() or state.resolve() != state)):
        raise ValueError("the update channel state directory is invalid")
    directory = state / "orbis-update-policy"
    if create:
        directory.mkdir(mode=0o700, exist_ok=True)
    if directory.exists() or directory.is_symlink():
        details = directory.lstat()
        if not stat.S_ISDIR(details.st_mode) or directory.is_symlink() or details.st_uid != os.getuid() or stat.S_IMODE(details.st_mode) & 0o077 or directory.resolve() != directory:
            raise ValueError("the private update policy directory is invalid")
    file = directory / "channel.json"
    if create or file.exists() or file.is_symlink():
        return file
    legacy = state / "orbis-release-channel.json"
    if legacy.exists() or legacy.is_symlink():
        if stat.S_IMODE(state.stat().st_mode) & 0o022:
            raise ValueError("the legacy update channel directory is not protected")
        return legacy
    return file


def read_channel(root: Path) -> dict:
    file = channel_file(root)
    try:
        descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return {"version": 1, "channel": "stable", "revision": "initial"}
    with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
        details = os.fstat(stream.fileno())
        if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_size > 4096 or stat.S_IMODE(details.st_mode) & 0o077 or details.st_uid != os.getuid():
            raise ValueError("the saved update channel is not a private regular file")
        value = json.load(stream)
    if not isinstance(value, dict) or set(value) != {"version", "channel", "revision"} or type(value["version"]) is not int or value["version"] != 1 or not isinstance(value["channel"], str) or value["channel"] not in {"stable", "nightly"} or not isinstance(value["revision"], str):
        raise ValueError("the saved update channel is invalid")
    try:
        identifier = uuid.UUID(value["revision"], version=4)
    except ValueError as error:
        raise ValueError("the update channel revision is invalid") from error
    if str(identifier) != value["revision"]:
        raise ValueError("the update channel revision is invalid")
    return value


def save_channel(root: Path, channel: str, revision: str) -> None:
    file = channel_file(root, create=True)
    write_private(file, {"version": 1, "channel": channel, "revision": revision})


def latest_stable_tag() -> str:
    metadata = CHECK.read_json("https://api.github.com/repos/twentylines/orbis/releases/latest", 1024 * 1024, {"Accept": "application/vnd.github+json"})
    tag = metadata.get("tag_name") if isinstance(metadata, dict) else None
    if not POLICY.is_stable_release_tag(tag) or metadata.get("draft") or metadata.get("prerelease"):
        raise ValueError("the latest Stable release could not be verified")
    return tag


def manifest_for_tag(tag: str) -> dict[str, str]:
    if not PLAN.TAG.fullmatch(tag):
        raise ValueError("release tag is invalid")
    published = CHECK.check(tag)
    image = published.get("image")
    if not isinstance(image, str) or not image.startswith(f"{PLAN.IMAGE}@"):
        raise ValueError("verified release has an unexpected image")
    return PLAN.validate_manifest(
        {
            "schema": "orbis.release.v1",
            "image": PLAN.IMAGE,
            "tag": tag,
            "commit": published["commit"],
            "digest": image.removeprefix(f"{PLAN.IMAGE}@"),
            "runtipiCompatibility": published["runtipiCompatibility"],
            **({"installationProtocol": published["installationProtocol"]} if "installationProtocol" in published else {}),
        }
    )


def enrollment_matches(root: Path, context: str, saved: dict | None) -> bool:
    if not saved or saved.get("root") != str(root) or saved.get("dockerContext") != context:
        return False
    files = saved.get("files")
    if not isinstance(files, dict):
        return False
    names = ["docker-compose.yml", ".env", "user-config/tipi-compose.yml", "orbis-compose.yml"]
    if (root / "orbis-host-compose.yml").exists() or (root / "orbis-host-compose.yml").is_symlink():
        names.append("orbis-host-compose.yml")
    return set(files) == set(names) and all(files[name] == HOST.file_digest(root / name) for name in names)


def installed_manifest(root: Path, context: str) -> dict[str, str]:
    if HOST.retained_state(root):
        resolved = HOST.resolve_current_identity(root, context)
        current = PLAN.validate_manifest(resolved.publication())
        HOST.require_current_state(root, HOST.installation_fingerprint(root, current, context))
        return current
    saved = HOST.saved_state(root)
    if (
        not enrollment_matches(root, context, saved)
        or not isinstance(saved.get("tag"), str)
        or not isinstance(saved.get("digest"), str)
        or not PLAN.DIGEST.fullmatch(saved["digest"])
    ):
        raise ValueError("this installation is not enrolled in Orbis")
    image = f"{PLAN.IMAGE}@{saved['digest']}"
    result = HOST.docker(
        context,
        ["image", "inspect", "--format", '{"labels":{{json .Config.Labels}},"digests":{{json .RepoDigests}}}', image],
        root,
    )
    if result.returncode:
        raise RuntimeError("could not inspect the enrolled Orbis image")
    try:
        metadata = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ValueError("Docker returned invalid enrolled image metadata") from error
    labels = metadata.get("labels") if isinstance(metadata, dict) else None
    digests = metadata.get("digests") if isinstance(metadata, dict) else None
    if (
        not isinstance(labels, dict)
        or not isinstance(digests, list)
        or image not in digests
        or labels.get("org.opencontainers.image.source") != "https://github.com/twentylines/orbis"
        or labels.get("org.opencontainers.image.version") != saved["tag"]
    ):
        raise ValueError("the installed image identity differs from the enrolled release")
    # Installed releases can outlive their remote assets. New targets still
    # require fresh GitHub/GHCR verification in plan and apply.
    current = PLAN.validate_manifest({
        "schema": "orbis.release.v1",
        "image": PLAN.IMAGE,
        "tag": saved["tag"],
        "commit": labels.get("org.opencontainers.image.revision"),
        "digest": saved["digest"],
        "runtipiCompatibility": PLAN.read_version(root),
    })
    HOST.require_current_state(root, HOST.installation_fingerprint(root, current, context))
    return current


class HostService:
    def __init__(self, root: Path, context: str, snapshots: Path, state_dir: Path):
        self.HOST = HOST
        self.retained_restore_manager = None
        self.core_overlay_manager = None
        self.root = root.resolve(strict=True)
        self.context = context
        self.snapshots = snapshots.resolve(strict=True)
        self.state_dir = state_dir.resolve(strict=True)
        if not self.root.is_dir() or not self.snapshots.is_dir() or not self.state_dir.is_dir():
            raise ValueError("host service paths must be directories")
        if self.snapshots.is_relative_to(self.root) or self.state_dir.is_relative_to(self.root):
            raise ValueError("host service state and snapshots must be outside the installation")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", context):
            raise ValueError("Docker context name is invalid")
        if stat.S_IMODE(self.state_dir.stat().st_mode) & 0o077:
            raise ValueError("host service state directory must be private (0700)")
        self.capture_fence_fd = None
        self.capture_fence_session = str(uuid.uuid4())
        self.prepared_capture = None
        self.lock = threading.Lock()
        self.restore_manager_lock = threading.Lock()
        self.busy = False
        self.job_file = self.state_dir / "job.json"
        self.package_job_file = self.state_dir / "package-job.json"
        self.restart_job_file = self.state_dir / "restart-job.json"
        self.maintenance_file = self.state_dir / "helper-maintenance.json"
        self.drives = DRIVES.DriveHealth(self.state_dir)
        self.discovery = DISCOVERY.Discovery(policy_path=self.state_dir / "discovery-policy.json")
        previous = read_private(self.job_file)
        if previous and previous.get("state") in {"running", "recovering"}:
            previous["state"] = "interrupted"
            write_private(self.job_file, previous)

    def retained_restores(self):
        if self.retained_restore_manager is None:
            # The responder asks for restore status while apply holds self.lock.
            with self.restore_manager_lock:
                if self.retained_restore_manager is None:
                    module = load_script("orbis-host-retained-restore.py", "orbis_retained_restore_for_service")
                    module.HOST = HOST
                    module.CAPTURE = CAPTURE_AUTHORITY
                    self.retained_restore_manager = module.RestoreManager(self)
        return self.retained_restore_manager

    def core_overlays(self):
        # Callers already serialize accepted update/recovery setup with self.lock.
        if self.core_overlay_manager is None:
            module = load_script("orbis-host-maintenance-overlay.py", "orbis_maintenance_overlay_for_service")
            self.core_overlay_manager = module.CoreOverlay(self)
        return self.core_overlay_manager

    def portable_modules(self):
        module = load_script("orbis-host-portable-enrollment.py", "orbis_portable_enrollment_for_service")
        module.A, module.C.AUTHORITY, module.P = HOST.AUTHORITY, HOST.AUTHORITY, CONTROLLER_IDENTITY
        return module

    def capture_portable_mount_policy(self, point_id, request):
        if not CONTROLLER_IDENTITY.exact(request, {"token"}):
            raise ValueError("portable capture binding is invalid")
        return self.portable_modules().capture_mount_policy(self, point_id, request["token"])

    def portable_destination_observation(self):
        module = self.portable_modules()
        runtime = self.retained_restores().runtime
        source = runtime.source_snapshot()
        original = source["container"]
        roots = [str(runtime.map_path(original, target)) for target in
                 ("/app-data", "/data/apps", "/data/user-config", "/data/state", "/data/repos")]
        rows = runtime.reader._read(["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"]).splitlines()
        if len(rows) > 4096 or any(not re.fullmatch(r"[a-f0-9]{64}", identifier) for identifier in rows):
            raise ValueError("portable destination inventory is invalid")
        occupied = []
        for identifier in rows:
            observed = runtime.inspect(identifier)
            state = observed.get("State") or {}
            if state.get("Running") or state.get("Restarting"):
                occupied.extend(module.M.ports(observed))
        names = runtime.reader._read(["network", "ls", "--format", "{{.Name}}"]).splitlines()
        if len(names) > 1024 or any(not module.M.NAME.fullmatch(name) for name in names):
            raise ValueError("portable destination network inventory is invalid")
        networks = {name: runtime.reader._object(["network", "inspect", "--format", "{{json .}}", name]) for name in names}
        return {"currentRevision": hashlib.sha256(CONTROLLER_IDENTITY.canonical(source)).hexdigest(), "controllerId": source["controllerId"],
                "controllerImageId": source["imageId"], "includedRoots": roots,
                "mountTable": module.M.table(Path("/proc/self/mountinfo").read_text()), "occupiedPorts": occupied, "networks": networks}

    def portable_enrollments(self):
        # The installed root driver must provide authenticated capsule decryption
        # in a fixed current-image worker. Its absence keeps this API fail-closed.
        module = self.portable_modules()
        return module.PortableEnrollment(self, getattr(self, "portable_capsule_driver", None))

    def proxy_host_identity(self):
        module = load_script("orbis-proxy-identity.py", "orbis_proxy_identity_for_service")
        module.HOST, module.A, module.P = HOST, HOST.AUTHORITY, CONTROLLER_IDENTITY
        return {"version": 1, "descriptor": module.observe_current(self.root, self.context)}

    def resume_pending_retained_restore(self):
        marker = self.root.parent / ("." + self.root.name + ".orbis-retained-restore.json")
        if not marker.exists() and not marker.is_symlink():
            return
        manager = self.retained_restores()
        with self.lock:
            if self.busy:
                return
            self.busy = True
        def run():
            try:
                manager.interrupted(manager.pending_identifier())
                deadline = time.monotonic() + 25 * 60
                while True:
                    try:
                        manager.resume_pending()
                        break
                    except BlockingIOError:
                        # A surviving bounded copier/exec retains the inherited
                        # root flock. Never race it; retry after its lease ends.
                        if time.monotonic() >= deadline:
                            break
                        time.sleep(1)
            except (OSError, ValueError, RuntimeError, TypeError, subprocess.SubprocessError):
                pass
            finally:
                with self.lock:
                    self.busy = False
        threading.Thread(target=run, daemon=True).start()

    def core_operation_maintenance(self):
        try:
            job = read_private(self.job_file)
            if job is None:
                return {"state": "idle"}
            if job.get("schema") != "orbis.host-service-job.v1":
                return {"state": "checking"}
            current, target = PLAN.validate_manifest(job["current"]), PLAN.validate_manifest(job["target"])
            order = POLICY.version_order(target["tag"], current["tag"])
            if order is None or order == 0:
                return {"state": "checking"}
            state = job.get("state")
            if state == "running":
                return {"state": "downgrading" if order < 0 else "updating"}
            if state in {"recovering", "interrupted"}:
                return {"state": "recovery"}
            if state not in {"complete", "rolled-back", "failed"}:
                return {"state": "checking"}
            if job.get("maintenanceSettled") is True:
                if not job.get("overlayId") or job.get("overlayCleanupRequired") is True:
                    return {"state": "idle"}
                try:
                    if self.core_overlays().settled(job):
                        return {"state": "idle"}
                except (OSError, ValueError, RuntimeError, TypeError, KeyError, subprocess.SubprocessError):
                    pass
            expected = target if state == "complete" else current
            # Persisted terminal jobs are only unlocked when the exact enrolled
            # publication is healthy. Reviews and app/package jobs never enter here.
            installed = self.current_manifest()
            if {k: v for k, v in installed.items() if k != 'installationProtocol'} != {
                k: v for k, v in expected.items() if k != 'installationProtocol'
            }:
                return {"state": "checking"}
            core = HOST.current_core(self.root, self.context)
            if core.get("state") != "running" or core.get("health") != "healthy":
                return {"state": "checking"}
            with self.lock:
                fresh = read_private(self.job_file)
                if fresh != job:
                    return {"state": "checking"}
                if fresh.get("overlayId"):
                    fresh["maintenanceSettled"] = False
                    write_private(self.job_file, fresh)
                    try:
                        self.core_overlays().finish(fresh)
                        if not self.core_overlays().settled(fresh):
                            raise ValueError("maintenance routing still needs review")
                    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
                        # The exact terminal publication above is healthy. Keep
                        # it usable while blocking another core replacement.
                        fresh["overlayCleanupRequired"] = True
                    else:
                        fresh.pop("overlayCleanupRequired", None)
                fresh["maintenanceSettled"] = True
                write_private(self.job_file, fresh)
            return {"state": "idle"}
        except (OSError, ValueError, RuntimeError, TypeError, KeyError, subprocess.SubprocessError):
            return {"state": "checking"}

    def review_retained_restore(self, request):
        manager = self.retained_restores()
        with self.lock:
            self.require_idle_core()
            return manager.review(request)

    def absent_retained_restore(self, request):
        manager = self.retained_restores()
        with self.lock, HOST.host_lock(self.root):
            self.require_idle_core()
            return manager.absence(request)

    def begin_retained_restore(self, request):
        manager = self.retained_restores()
        # A repeated exact begin is a capability-bound recovery request; generic
        # idle checks must not mistake its own protected marker for another job.
        try:
            existing = manager.read(request.get("restoreId"))
        except FileNotFoundError:
            existing = None
        if existing is None and self.core_operation_maintenance()["state"] != "idle":
            raise ValueError("resolve the Orbis core operation before restoring a retained point")
        with self.lock:
            if existing is None:
                self.require_idle_core()
            return manager.begin(request)

    def launch_retained_restore(self, action, identifier, token):
        if action not in {"prepare", "activate", "recover"}:
            raise ValueError("invalid retained restore action")
        manager = self.retained_restores()
        record = manager.authenticate(identifier, token)
        with self.lock:
            if self.busy:
                raise ValueError("another host operation is in progress")
            self.busy = True
        def run():
            try:
                if action == "activate":
                    if manager.read(identifier)["phase"] == "allocated":
                        manager.prepare(identifier, token)
                    manager.activate(identifier, token)
                elif action == "prepare":
                    manager.prepare(identifier, token)
                else:
                    manager.recover(identifier, token)
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
                # The private root transaction and marker remain authoritative.
                # No exception text or backend configuration enters public logs.
                try:
                    manager.interrupted(identifier)
                except (OSError, ValueError, RuntimeError):
                    pass
            finally:
                with self.lock:
                    self.busy = False
        return manager.public(record), lambda: threading.Thread(target=run, daemon=True).start()

    def require_idle_core(self) -> None:
        self.require_restart_clear()
        self.require_package_clear()
        if self.maintenance_file.exists() or self.maintenance_file.is_symlink():
            raise ValueError("host helper maintenance is in progress")
        if self.busy:
            raise ValueError("another host update is in progress")
        previous = read_private(self.job_file)
        if previous and previous.get("state") in {"running", "recovering", "interrupted"}:
            raise ValueError("finish or recover the current host update before changing release channels")
        self.require_core_overlay_clear(previous)

    def require_core_overlay_clear(self, previous):
        if previous and previous.get("overlayId") and not self.core_overlays().settled(previous):
            raise ValueError("The previous update's maintenance route needs recovery before another core operation.")

    def controller_capture_identity(self, expected_id: str, expected_image: str, enrollment: dict) -> dict:
        template = ('{"id":{{json .Id}},"imageId":{{json .Image}},"imageReference":{{json .Config.Image}},'
                    '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
                    '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
                    '"workingDirectory":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},'
                    '"running":{{json .State.Running}},"restarting":{{json .State.Restarting}},"paused":{{json .State.Paused}},'
                    '"startedAt":{{json .State.StartedAt}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}}}')
        result = HOST.docker(self.context, ["inspect", "--format", template, "runtipi"], self.root)
        if result.returncode or len(result.stdout) > 16384:
            raise ValueError("controller identity is unavailable")
        value = json.loads(result.stdout)
        retained = HOST.resolve_current_identity(self.root, self.context) if enrollment.get("schema") == HOST.IDENTITY.RETAINED_SCHEMA else None
        publication = retained.publication() if retained else enrollment
        expected_reference = retained.controller()["creationReference"] if retained else f"{PLAN.IMAGE}@{enrollment['digest']}"
        if (not isinstance(value, dict) or value.get("id") != expected_id or value.get("imageId") != expected_image
                or value.get("imageReference") != expected_reference
                or value.get("project") != "runtipi" or value.get("service") != "runtipi"
                or value.get("workingDirectory") != str(self.root) or value.get("running") is not True
                or value.get("restarting") is not False or value.get("paused") is not False or value.get("health") != "healthy"
                or not isinstance(value.get("startedAt"), str) or not 1 <= len(value["startedAt"]) <= 80):
            raise ValueError("controller identity is not healthy and enrolled")
        return {key: value[key] for key in ("id", "imageId", "imageReference", "project", "service", "startedAt")} | {
            "releaseTag": publication["tag"], "releaseDigest": publication["digest"]}

    def capture_controller_config(self, point_id: str, controller_id: str, image_id: str, fence_token=None) -> dict:
        if (not isinstance(point_id, str) or str(uuid.UUID(point_id)) != point_id or uuid.UUID(point_id).version != 4
                or not isinstance(controller_id, str) or not re.fullmatch(r"[a-f0-9]{64}", controller_id)
                or not isinstance(image_id, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id)):
            raise ValueError("controller capture identity is invalid")
        if not self.lock.acquire(blocking=False):
            raise ValueError("another host operation is in progress")
        try:
            if fence_token is not None:
                record = self._verify_capture_fence(fence_token)
                if (point_id, controller_id, image_id) != (record["pointId"], record["controllerId"], record["imageId"]):
                    raise ValueError("controller capture fence binding changed")
                result = self._capture_controller_config_locked(point_id, controller_id, image_id)
                if result["configurationSetSha256"] != record["configurationSetSha256"]:
                    raise ValueError("controller capture fence configuration changed")
                return result
            with HOST.host_lock(self.root):
                return self._capture_controller_config_locked(point_id, controller_id, image_id)
        finally:
            self.lock.release()

    def _capture_fence_generation(self, capture):
        descriptor = {key: value for key, value in capture.items() if key != "configurationSetSha256"}
        descriptor["controller"] = {key: value for key, value in capture["controller"].items() if key != "startedAt"}
        descriptor["files"] = [{key: value for key, value in item.items() if key != "data"} for item in capture["files"]]
        return hashlib.sha256(b"orbis.controller-capture-generation.v1\n" + CONTROLLER_IDENTITY.canonical(descriptor)).hexdigest()

    def _verify_capture_fence(self, token, *, expired=False, stale=False):
        record = read_capture_job(HOST.capture_fence_path(self.root))
        keys = {"schema", "session", "tokenSha256", "rootSha256", "contextSha256", "pointId", "controllerId", "imageId",
                "configurationSetSha256", "preparationSha256", "stableGenerationSha256", "createdAt", "expiresAt"}
        modern = isinstance(record, dict) and record.get("schema") == "orbis.controller-capture-fence.v2"
        if (not CONTROLLER_IDENTITY.exact(record, keys | ({"captureContractSha256"} if modern else set()))
                or record["schema"] != ("orbis.controller-capture-fence.v2" if modern else "orbis.controller-capture-fence.v1")
                or modern and (type(record["captureContractSha256"]) is not str or not re.fullmatch(r"[a-f0-9]{64}", record["captureContractSha256"]))
                or type(token) is not str or not re.fullmatch(r"[a-f0-9]{64}", token)
                or type(record["tokenSha256"]) is not str or not re.fullmatch(r"[a-f0-9]{64}", record["tokenSha256"])
                or not secrets.compare_digest(record["tokenSha256"], hashlib.sha256(token.encode()).hexdigest())
                or record["rootSha256"] != hashlib.sha256(str(self.root).encode()).hexdigest()
                or record["contextSha256"] != hashlib.sha256(self.context.encode()).hexdigest()
                or (not stale and (record["session"] != self.capture_fence_session or self.capture_fence_fd is None))
                or type(record["createdAt"]) not in (int, float) or type(record["expiresAt"]) not in (int, float)
                or not record["createdAt"] <= record["expiresAt"] <= record["createdAt"] + CAPTURE_FENCE_MAX
                or (not expired and not record["createdAt"] <= time.time() < record["expiresAt"])):
            raise ValueError("controller capture fence is unavailable or requires reconciliation")
        if modern and not expired and not stale and record["captureContractSha256"] != self.time_machine_capability("capture")["contractSha256"]:
            raise ValueError("controller capture native contract changed")
        return record

    def time_machine_capability(self, kind):
        return TIME_MACHINE_CAPABILITIES.capability(kind, HOST.AUTHORITY)

    def acquire_capture_fence(self, request):
        keys = {"pointId", "controllerId", "imageId", "configurationSetSha256", "preparationSha256"}
        modern = isinstance(request, dict) and "captureContractSha256" in request
        if (not CONTROLLER_IDENTITY.exact(request, keys | {"clientKey"} | ({"captureContractSha256"} if modern else set()))
                or type(request["clientKey"]) is not str or not re.fullmatch(r"[a-f0-9]{64}", request["clientKey"])):
            raise ValueError("controller capture fence request is invalid")
        with self.lock:
            if modern and request["captureContractSha256"] != self.time_machine_capability("capture")["contractSha256"]:
                raise ValueError("controller capture native contract is unavailable")
            marker = HOST.capture_fence_path(self.root)
            if marker.exists() or marker.is_symlink():
                record = self._verify_capture_fence(request["clientKey"])
                if modern != (record["schema"] == "orbis.controller-capture-fence.v2") or (modern and record["captureContractSha256"] != request["captureContractSha256"]):
                    raise ValueError("controller capture retry contract changed")
                if any(record[key] != request[key] for key in keys):
                    raise ValueError("controller capture retry binding changed")
                current = self._capture_controller_config_locked(record["pointId"], record["controllerId"], record["imageId"])
                if current["configurationSetSha256"] != record["configurationSetSha256"]:
                    raise ValueError("controller capture retry configuration changed")
                return ({"version": 2, "token": request["clientKey"], "expiresAt": record["expiresAt"], "captureContractSha256": record["captureContractSha256"]}
                        if modern else {"version": 1, "token": request["clientKey"], "expiresAt": record["expiresAt"]})
            self.require_idle_core()
            parent = self.root.parent.lstat()
            if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid()
                    or stat.S_IMODE(parent.st_mode) & 0o022 or self.root.parent.resolve(strict=True) != self.root.parent):
                raise ValueError("controller capture marker directory is not protected")
            prepared = self.prepared_capture
            if (not isinstance(prepared, dict) or prepared.get("expiresAt", 0) <= time.time()
                    or any(prepared.get(key) != request[key] for key in keys)):
                raise ValueError("controller publication must be independently prepared before fencing")
            descriptor = os.open(self.root.parent / f".{self.root.name}.orbis-host.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            try:
                details = os.fstat(descriptor)
                if (not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid() or details.st_nlink != 1
                        or stat.S_IMODE(details.st_mode) & 0o077):
                    raise ValueError("controller capture lock is not protected")
                HOST.fcntl.flock(descriptor, HOST.fcntl.LOCK_EX | HOST.fcntl.LOCK_NB)
                HOST.require_no_capture_fence(self.root)
                current = self._capture_controller_config_locked(request["pointId"], request["controllerId"], request["imageId"])
                if current["configurationSetSha256"] != request["configurationSetSha256"]:
                    raise ValueError("controller configuration changed before fencing")
                token = request["clientKey"]
                now = time.time()
                record = {"schema": "orbis.controller-capture-fence.v1", "session": self.capture_fence_session,
                          "tokenSha256": hashlib.sha256(token.encode()).hexdigest(),
                          "rootSha256": hashlib.sha256(str(self.root).encode()).hexdigest(),
                          "contextSha256": hashlib.sha256(self.context.encode()).hexdigest(),
                          **{key: request[key] for key in keys}, "stableGenerationSha256": self._capture_fence_generation(current),
                          "createdAt": now, "expiresAt": now + CAPTURE_FENCE_TTL}
                if modern:
                    record.update(schema="orbis.controller-capture-fence.v2", captureContractSha256=request["captureContractSha256"])
                file = HOST.capture_fence_path(self.root)
                fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                try:
                    body = CONTROLLER_IDENTITY.canonical(record)
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(body)
                        stream.flush()
                        os.fsync(stream.fileno())
                    self._sync_capture_fence_directory()
                except BaseException:
                    # Keep an ambiguous durable marker fail-closed for explicit reconciliation.
                    raise
                self.capture_fence_fd = descriptor
                descriptor = None
                self.prepared_capture = None
                return ({"version": 2, "token": token, "expiresAt": record["expiresAt"], "captureContractSha256": record["captureContractSha256"]}
                        if modern else {"version": 1, "token": token, "expiresAt": record["expiresAt"]})
            finally:
                if descriptor is not None:
                    os.close(descriptor)

    def _sync_capture_fence_directory(self):
        descriptor = os.open(self.root.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def maintain_capture_fence(self, action, token, expected=None):
        if action not in {"renew", "release", "reconcile"}:
            raise ValueError("controller capture fence action is invalid")
        bindings = {"pointId", "controllerId", "imageId", "configurationSetSha256", "preparationSha256"}
        if expected is not None and (not CONTROLLER_IDENTITY.exact(expected, bindings)
                                     or any(type(value) is not str for value in expected.values())):
            raise ValueError("controller capture recovery binding is invalid")
        with self.lock:
            marker = HOST.capture_fence_path(self.root)
            if action in {"release", "reconcile"} and not marker.exists() and not marker.is_symlink() and self.capture_fence_fd is None:
                if type(token) is not str or not re.fullmatch(r"[a-f0-9]{64}", token):
                    raise ValueError("controller capture key is invalid")
                return {"version": 1, "released": True}
            record = self._verify_capture_fence(token, expired=action != "renew", stale=action == "reconcile")
            if expected is not None and any(record[key] != expected[key] for key in bindings):
                raise ValueError("controller capture recovery binding changed")
            if action == "reconcile" and record["session"] == self.capture_fence_session:
                raise ValueError("a current capture must release its own fence")
            descriptor = None
            try:
                if action == "reconcile":
                    descriptor = os.open(self.root.parent / f".{self.root.name}.orbis-host.lock", os.O_RDWR | os.O_NOFOLLOW)
                    HOST.fcntl.flock(descriptor, HOST.fcntl.LOCK_EX | HOST.fcntl.LOCK_NB)
                current = self._capture_controller_config_locked(record["pointId"], record["controllerId"], record["imageId"])
                if current["configurationSetSha256"] != record["configurationSetSha256"]:
                    if (expected is None or action == "renew"
                            or self._capture_fence_generation(current) != record["stableGenerationSha256"]):
                        raise ValueError("controller capture configuration changed; local reconciliation is required")
                if action == "renew":
                    record["expiresAt"] = min(time.time() + CAPTURE_FENCE_TTL, record["createdAt"] + CAPTURE_FENCE_MAX)
                    if record["expiresAt"] <= time.time():
                        raise ValueError("controller capture fence duration exhausted")
                    write_private(HOST.capture_fence_path(self.root), record)
                    return {"version": 1, "expiresAt": record["expiresAt"]}
                HOST.capture_fence_path(self.root).unlink()
                self._sync_capture_fence_directory()
                if self.capture_fence_fd is not None:
                    os.close(self.capture_fence_fd)
                    self.capture_fence_fd = None
                return {"version": 1, "released": True}
            finally:
                if descriptor is not None:
                    os.close(descriptor)

    def publication_image(self, image_id: str, platform=None) -> dict:
        deadline = time.monotonic() + 15
        outer_deadline = HOST.CAPTURE_READ_DEADLINE.get()
        token = HOST.CAPTURE_READ_DEADLINE.set(min(deadline, outer_deadline) if outer_deadline is not None else deadline)
        try:
            arguments = ["image", "inspect"]
            if platform is not None:
                platform = CONTROLLER_IDENTITY.platform_identity(platform, selectable=True)
                arguments += ["--platform", "/".join(platform[key] for key in ("os", "architecture", "variant") if key in platform)]
            arguments += ["--format", "{{json .}}", image_id]
            result = HOST.docker(self.context, arguments, self.root)
            if result.returncode or len(result.stdout.encode()) > CONTROLLER_IDENTITY.METADATA_BYTES:
                raise ValueError("controller image is unavailable")
            value = CONTROLLER_IDENTITY.metadata(result.stdout.encode())
            if (not isinstance(value.get("Id"), str) or not PLAN.DIGEST.fullmatch(value["Id"])
                    or (platform is None and value["Id"] != image_id) or not isinstance(value.get("Config"), dict)):
                raise ValueError("controller image identity changed")
            if platform is not None:
                observed = {"os": value.get("Os"), "architecture": value.get("Architecture")}
                if value.get("Variant"):
                    observed["variant"] = value["Variant"]
                if observed != platform:
                    raise ValueError("controller image platform changed")
            return {key: value.get(key) for key in ("Id", "RepoDigests", "Os", "Architecture", "Variant", "RootFS", "Manifests")} | {
                "Labels": value["Config"].get("Labels")}
        finally:
            HOST.CAPTURE_READ_DEADLINE.reset(token)

    def _prepare_retained_publication(self, request, before, cancelled):
        body = HOST.enrollment_bytes(self.root)
        with HOST.AUTHORITY.current(self.root, self.context, body) as (descriptor, authority, proof_bytes):
            resolved = HOST.resolve_current_identity(self.root, self.context)
            if resolved.controller() != before["retainedIdentity"]:
                raise ValueError("retained publication authority changed")
            proof = CONTROLLER_IDENTITY.metadata(proof_bytes, byte_limit=CONTROLLER_IDENTITY.PROOF_WIRE_BYTES,
                    string_limit=4 * ((CONTROLLER_IDENTITY.METADATA_BYTES + 2) // 3))
            CONTROLLER_IDENTITY.verify_publication_proof(resolved.publication(), proof)
            after = self._capture_controller_config_locked(request["pointId"], request["controllerId"], request["imageId"])
            if after != before or (cancelled is not None and cancelled()):
                raise ValueError("retained controller changed during publication preparation")
            receipt = {"version": 2, "pointId": request["pointId"], "controller": before["controller"],
                       "rootIdentity": before["rootIdentity"], "configurationSetSha256": before["configurationSetSha256"],
                       "retainedIdentity": resolved.controller(), "proof": proof}
            receipt["preparationSha256"] = hashlib.sha256(
                b"orbis.controller-publication-capture.v2\n" + CONTROLLER_IDENTITY.canonical(receipt)).hexdigest()
            if len(CONTROLLER_IDENTITY.canonical(receipt)) > CONTROLLER_IDENTITY.PROOF_WIRE_BYTES:
                raise ValueError("retained publication receipt exceeds its limit")
            CAPTURE_AUTHORITY.capture_preparation(self.state_dir, self.root, self.context, before, receipt)
            self.prepared_capture = {key: request[key] for key in request} | {
                "preparationSha256": receipt["preparationSha256"], "expiresAt": time.time() + CAPTURE_FENCE_MAX}
        return receipt

    def prepare_controller_proxy_identity(self, point_id, request):
        CAPTURE_AUTHORITY.point_id(point_id)
        keys = {"token", "configurationSetSha256", "preparationSha256", "publicationProofSha256"}
        if (not CONTROLLER_IDENTITY.exact(request, keys)
                or any(type(value) is not str or not re.fullmatch(r"[a-f0-9]{64}", value) for value in request.values())):
            raise ValueError("proxy identity capture binding is invalid")
        with self.lock:
            fence = self._verify_capture_fence(request["token"])
            prepared = CAPTURE_AUTHORITY.load_preparation(self.state_dir, point_id)
            if (fence["pointId"] != point_id or prepared["rootSha256"] != hashlib.sha256(str(self.root).encode()).hexdigest()
                    or prepared["contextSha256"] != hashlib.sha256(self.context.encode()).hexdigest()
                    or request["configurationSetSha256"] != fence["configurationSetSha256"]
                    or request["preparationSha256"] != fence["preparationSha256"]
                    or request["publicationProofSha256"] != hashlib.sha256(CONTROLLER_IDENTITY.canonical(prepared["publicationReceipt"])).hexdigest()):
                raise ValueError("proxy identity capture source changed")
            current = self._capture_controller_config_locked(point_id, fence["controllerId"], fence["imageId"])
            if current != prepared["configuration"]:
                raise ValueError("proxy identity capture configuration changed")
            proxy = CAPTURE_AUTHORITY.prepare_proxy_policy(self.state_dir, point_id, request["token"], prepared, self.proxy_host_identity()["descriptor"])
            return {"version": 2, "pointId": point_id, "proxyHostIdentity": proxy["descriptor"],
                    "proxyPreparationSha256": hashlib.sha256(CONTROLLER_IDENTITY.canonical(proxy)).hexdigest()}

    def prepare_controller_app_runtime(self, point_id, request):
        if not isinstance(request, dict):
            raise ValueError("app runtime capture binding is invalid")
        with self.lock:
            fence = self._verify_capture_fence(request.get("token"))
            if fence["schema"] != "orbis.controller-capture-fence.v2":
                raise ValueError("app runtime requires an independently selected capture contract")
        proxy_response = self.prepare_controller_proxy_identity(point_id, request)
        with self.lock:
            prepared = CAPTURE_AUTHORITY.load_preparation(self.state_dir, point_id)
            proxy = CAPTURE_AUTHORITY.load_proxy_preparation(self.state_dir, point_id, prepared)
            try:
                app = CAPTURE_AUTHORITY.load_app_preparation(self.state_dir, point_id, prepared, proxy)
            except FileNotFoundError:
                app = None
            if app is not None:
                if app["tokenSha256"] != hashlib.sha256(request["token"].encode()).hexdigest():
                    raise ValueError("app runtime preparation owner changed")
                return {**proxy_response, "version": 3, **{key: app[key] for key in
                        ("appRuntimeSha256", "appRuntimeDaemonSha256", "appRuntimeBytes")}}
        # Inspection may use the entire bounded minute. Fence renewals retain
        # the service mutex while no daemon or filesystem writes occur here.
        observed = CAPTURE_AUTHORITY.APP.observe(self, prepared, HOST, point_id)
        bindings = CAPTURE_AUTHORITY.APP.observe_bindings(observed)
        with self.lock:
            fence = self._verify_capture_fence(request["token"])
            if (fence["pointId"] != point_id or CAPTURE_AUTHORITY.load_preparation(self.state_dir, point_id) != prepared
                    or self._capture_controller_config_locked(point_id, fence["controllerId"], fence["imageId"]) != prepared["configuration"]
                    or self.proxy_host_identity()["descriptor"] != proxy["descriptor"]):
                raise ValueError("app runtime source changed during independent observation")
            path = CAPTURE_AUTHORITY.directory(self.state_dir, point_id)
            try:
                original = CAPTURE_AUTHORITY.APP.validate(CAPTURE_AUTHORITY.APP.parse(
                    CAPTURE_AUTHORITY.read(path, "app-runtime.json", CAPTURE_AUTHORITY.APP.MAX_BYTES)),
                    CAPTURE_AUTHORITY.app_expectations(prepared, observed["daemonSha256"]))
            except FileNotFoundError:
                original = None
            if original is not None:
                left = {key: value for key, value in original.items() if key not in {"capturedAt", "sha256"}}
                right = {key: value for key, value in observed.items() if key not in {"capturedAt", "sha256"}}
                if left != right:
                    raise ValueError("immutable app preparation differs from its observed source")
                observed = original
            app = CAPTURE_AUTHORITY.prepare_app_policy(self.state_dir, point_id, request["token"], prepared, proxy, observed, bindings)
            return {**proxy_response, "version": 3, **{key: app[key] for key in
                    ("appRuntimeSha256", "appRuntimeDaemonSha256", "appRuntimeBytes")}}

    def controller_app_runtime_bytes(self, point_id, request):
        keys = {"token", "configurationSetSha256", "preparationSha256", "publicationProofSha256", "appRuntimeSha256"}
        if (not CONTROLLER_IDENTITY.exact(request, keys)
                or any(type(value) is not str or not re.fullmatch(r"[a-f0-9]{64}", value) for value in request.values())):
            raise ValueError("app runtime download binding is invalid")
        with self.lock:
            fence = self._verify_capture_fence(request["token"])
            prepared = CAPTURE_AUTHORITY.load_preparation(self.state_dir, point_id)
            app = CAPTURE_AUTHORITY.load_app_preparation(self.state_dir, point_id, prepared)
            if (fence["schema"] != "orbis.controller-capture-fence.v2" or fence["pointId"] != point_id or any(request[key] != app[key] for key in
                    ("configurationSetSha256", "preparationSha256", "publicationProofSha256", "appRuntimeSha256"))
                    or prepared["rootSha256"] != hashlib.sha256(str(self.root).encode()).hexdigest()
                    or prepared["contextSha256"] != hashlib.sha256(self.context.encode()).hexdigest()):
                raise ValueError("app runtime download source changed")
            return CAPTURE_AUTHORITY.app_runtime_bytes(self.state_dir, point_id, request["token"], prepared, request["appRuntimeSha256"])

    def finalize_controller_capture_authority(self, point_id, token, stream, length, *, proxy_policy=False, app_policy=False):
        if app_policy and not proxy_policy:
            raise ValueError("app capture requires the independent proxy policy")
        CAPTURE_AUTHORITY.point_id(point_id)
        if type(length) is not int or not 1 <= length <= CONTROLLER_IDENTITY.MAX_IMAGE_BYTES:
            raise ValueError("controller archive upload exceeds its limit")
        deadline = time.monotonic() + CAPTURE_AUTHORITY.MAX_SECONDS
        with self.lock:
            fence = self._verify_capture_fence(token)
            if fence["pointId"] != point_id or app_policy and fence["schema"] != "orbis.controller-capture-fence.v2":
                raise ValueError("controller archive point or capture contract differs from its protected fence")
            prepared = CAPTURE_AUTHORITY.load_preparation(self.state_dir, point_id)
            if (prepared["rootSha256"] != hashlib.sha256(str(self.root).encode()).hexdigest()
                    or prepared["contextSha256"] != hashlib.sha256(self.context.encode()).hexdigest()
                    or prepared["configuration"]["configurationSetSha256"] != fence["configurationSetSha256"]
                    or prepared["publicationReceipt"]["preparationSha256"] != fence["preparationSha256"]):
                raise ValueError("controller archive preparation binding changed")
            current = self._capture_controller_config_locked(point_id, fence["controllerId"], fence["imageId"])
            if current != prepared["configuration"]:
                raise ValueError("controller archive configuration differs from original root preparation")
            proxy_prepared = None
            if proxy_policy:
                proxy_prepared = CAPTURE_AUTHORITY.load_proxy_preparation(self.state_dir, point_id, prepared)
                if (proxy_prepared["tokenSha256"] != hashlib.sha256(token.encode()).hexdigest()
                        or self.proxy_host_identity()["descriptor"] != proxy_prepared["descriptor"]):
                    raise ValueError("proxy host identity changed before archive verification")
        path = CAPTURE_AUTHORITY.directory(self.state_dir, point_id)
        lock_fd = os.open(path / "finalize.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        temporary = None
        try:
            details = os.fstat(lock_fd)
            if (not stat.S_ISREG(details.st_mode) or details.st_uid != HOST.AUTHORITY.OWNER or details.st_nlink != 1
                    or stat.S_IMODE(details.st_mode) & 0o077):
                raise ValueError("controller archive finalize lock is not protected")
            HOST.fcntl.flock(lock_fd, HOST.fcntl.LOCK_EX | HOST.fcntl.LOCK_NB)
            space = os.statvfs(path)
            if space.f_bavail * space.f_frsize < length + 256 * 1024 * 1024:
                raise ValueError("controller archive staging requires free space and its host reserve")
            descriptor, name = tempfile.mkstemp(prefix=".controller-archive-", dir=path)
            temporary = Path(name)
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                remaining = length
                while remaining:
                    CAPTURE_AUTHORITY.checked_deadline(deadline)
                    block = stream.read(min(1024 * 1024, remaining))
                    if not block or len(block) > remaining:
                        raise ValueError("controller archive upload was truncated")
                    output.write(block)
                    remaining -= len(block)
                output.flush()
                os.fsync(output.fileno())
            receipt = prepared["publicationReceipt"]
            graph = CONTROLLER_IDENTITY.verify_publication_proof(receipt["proof"]["publication"], receipt["proof"])
            archive = CAPTURE_AUTHORITY.verify_archive(temporary, graph, deadline)
            proposed = CAPTURE_AUTHORITY.finalized_receipt(prepared, archive)
            app_prepared = None
            if app_policy:
                app_prepared = CAPTURE_AUTHORITY.load_app_preparation(self.state_dir, point_id, prepared, proxy_prepared)
                original = CAPTURE_AUTHORITY.APP.parse(CAPTURE_AUTHORITY.app_runtime_bytes(
                    self.state_dir, point_id, token, prepared, app_prepared["appRuntimeSha256"]))
                observed = CAPTURE_AUTHORITY.APP.observe(self, prepared, HOST, point_id)
                CAPTURE_AUTHORITY.APP.verify_quiesced(original, observed)
                if (hashlib.sha256(CONTROLLER_IDENTITY.canonical(CAPTURE_AUTHORITY.APP.observe_bindings(observed))).hexdigest()
                        != app_prepared["hostBindingsSha256"]):
                    raise ValueError("app host mount identity changed before sealing")
            # Upload/decompression run outside the service mutex so the owner can
            # renew its existing bounded capture lease. No active state changes.
            with self.lock:
                final_fence = self._verify_capture_fence(token)
                if any(final_fence[key] != fence[key] for key in ("pointId", "controllerId", "imageId", "configurationSetSha256", "preparationSha256")):
                    raise ValueError("controller archive fence changed during verification")
                current = self._capture_controller_config_locked(point_id, fence["controllerId"], fence["imageId"])
                if current != prepared["configuration"] or CAPTURE_AUTHORITY.load_preparation(self.state_dir, point_id) != prepared:
                    raise ValueError("controller archive preparation changed during verification")
                if proxy_policy and self.proxy_host_identity()["descriptor"] != proxy_prepared["descriptor"]:
                    raise ValueError("proxy host identity changed during archive verification")
                result = CAPTURE_AUTHORITY.commit_finalized(self.state_dir, point_id, token, prepared, proposed)
                if proxy_policy:
                    result = CAPTURE_AUTHORITY.commit_proxy_finalized(self.state_dir, point_id, token, prepared, proxy_prepared, result)
                return CAPTURE_AUTHORITY.commit_app_finalized(self.state_dir, point_id, token, prepared, app_prepared, result) if app_policy else result
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            os.close(lock_fd)

    def recover_controller_capture_authority(self, point_id, request, *, proxy_policy=False, app_policy=False):
        if app_policy and not proxy_policy:
            raise ValueError("app recovery requires the protected proxy policy")
        CAPTURE_AUTHORITY.point_id(point_id)
        keys = {"token", "configurationSetSha256", "preparationSha256", "publicationProofSha256"}
        if (not CONTROLLER_IDENTITY.exact(request, keys)
                or any(type(value) is not str or not re.fullmatch(r"[a-f0-9]{64}", value) for value in request.values())):
            raise ValueError("controller capture recovery binding is invalid")
        with self.lock:
            prepared = CAPTURE_AUTHORITY.load_preparation(self.state_dir, point_id)
            publication = prepared["publicationReceipt"]
            if (prepared["rootSha256"] != hashlib.sha256(str(self.root).encode()).hexdigest()
                    or prepared["contextSha256"] != hashlib.sha256(self.context.encode()).hexdigest()
                    or request["configurationSetSha256"] != prepared["configuration"]["configurationSetSha256"]
                    or request["preparationSha256"] != publication["preparationSha256"]
                    or request["publicationProofSha256"] != hashlib.sha256(CONTROLLER_IDENTITY.canonical(publication)).hexdigest()):
                raise ValueError("controller capture recovery origin changed")
            if proxy_policy:
                proxy = CAPTURE_AUTHORITY.load_proxy_preparation(self.state_dir, point_id, prepared)
                if proxy["tokenSha256"] != hashlib.sha256(request["token"].encode()).hexdigest():
                    raise ValueError("proxy identity capture recovery token changed")
                if app_policy:
                    app = CAPTURE_AUTHORITY.load_app_preparation(self.state_dir, point_id, prepared, proxy)
                    if app["tokenSha256"] != hashlib.sha256(request["token"].encode()).hexdigest():
                        raise ValueError("app runtime recovery token changed")
                    try:
                        origin = CAPTURE_AUTHORITY.load_app_origin(self.state_dir, self.root, self.context, point_id)
                    except FileNotFoundError:
                        try:
                            CAPTURE_AUTHORITY.load_origin(self.state_dir, self.root, self.context, point_id)
                        except FileNotFoundError:
                            fence = self._verify_capture_fence(request["token"], expired=True, stale=True)
                            if fence["pointId"] != point_id:
                                raise ValueError("app runtime recovery point changed")
                            return {"version": 3, "state": "prepared"}
                        return {"version": 3, "state": "verified-uncommitted"}
                    return {"version": 3, "state": "finalized", "authority": json.loads(origin.authority_bytes)}
                try:
                    origin = CAPTURE_AUTHORITY.load_proxy_origin(self.state_dir, self.root, self.context, point_id)
                except FileNotFoundError:
                    try:
                        CAPTURE_AUTHORITY.load_finalization(self.state_dir, point_id, request["token"], prepared)
                        CAPTURE_AUTHORITY.load_origin(self.state_dir, self.root, self.context, point_id)
                    except FileNotFoundError:
                        fence = self._verify_capture_fence(request["token"], expired=True, stale=True)
                        if fence["pointId"] != point_id:
                            raise ValueError("proxy identity capture recovery point changed")
                        return {"version": 2, "state": "prepared"}
                    return {"version": 2, "state": "verified-uncommitted"}
                return {"version": 2, "state": "finalized", "authority": json.loads(origin.authority_bytes)}
            try:
                plan = CAPTURE_AUTHORITY.load_finalization(self.state_dir, point_id, request["token"], prepared)
            except FileNotFoundError:
                fence = self._verify_capture_fence(request["token"], expired=True, stale=True)
                if fence["pointId"] != point_id:
                    raise ValueError("controller capture recovery point changed")
                return {"version": 1, "state": "prepared"}
            path = CAPTURE_AUTHORITY.directory(self.state_dir, point_id)
            try:
                final = CAPTURE_AUTHORITY.read(path, "finalized.json", CAPTURE_AUTHORITY.RECEIPT_LIMIT)
            except FileNotFoundError:
                return {"version": 1, "state": "verified-uncommitted"}
            if final != CONTROLLER_IDENTITY.canonical(plan["authority"]):
                raise ValueError("controller capture committed authority changed")
            origin = CAPTURE_AUTHORITY.load_origin(self.state_dir, self.root, self.context, point_id)
            return {"version": 1, "state": "finalized", "authority": json.loads(origin.authority_bytes)}

    def prepare_controller_publication(self, request: dict, cancelled=None) -> dict:
        deadline = time.monotonic() + 150
        if (not CONTROLLER_IDENTITY.exact(request, {"pointId", "controllerId", "imageId", "configurationSetSha256"})
                or not isinstance(request["pointId"], str) or str(uuid.UUID(request["pointId"])) != request["pointId"]
                or uuid.UUID(request["pointId"]).version != 4
                or not isinstance(request["controllerId"], str) or not re.fullmatch(r"[a-f0-9]{64}", request["controllerId"])
                or not isinstance(request["imageId"], str) or not PLAN.DIGEST.fullmatch(request["imageId"])
                or not isinstance(request["configurationSetSha256"], str)
                or not re.fullmatch(r"[a-f0-9]{64}", request["configurationSetSha256"])):
            raise ValueError("controller publication identity is invalid")
        if not self.lock.acquire(blocking=False):
            raise ValueError("another host operation is in progress")
        deadline_token = HOST.CAPTURE_READ_DEADLINE.set(deadline)
        try:
            with HOST.host_lock(self.root):
                before = self._capture_controller_config_locked(request["pointId"], request["controllerId"], request["imageId"])
                if before["configurationSetSha256"] != request["configurationSetSha256"]:
                    raise ValueError("controller configuration changed")
                if before["version"] == 2:
                    return self._prepare_retained_publication(request, before, cancelled)
                local = self.publication_image(request["imageId"])
                controller = before["controller"]
                labels = local.get("Labels")
                digests = local.get("RepoDigests")
                if (not isinstance(labels, dict) or not isinstance(digests, list) or len(digests) > 256
                        or controller["imageReference"] not in digests
                        or labels.get("org.opencontainers.image.source") != CONTROLLER_IDENTITY.SOURCE
                        or labels.get("org.opencontainers.image.version") != controller["releaseTag"]):
                    raise ValueError("controller image is not the enrolled publication")
                expected = {"schema": "orbis.release.v1", "image": PLAN.IMAGE, "tag": controller["releaseTag"],
                            "commit": labels.get("org.opencontainers.image.revision"), "digest": controller["releaseDigest"],
                            "runtipiCompatibility": "4.10.1"}
                if "io.orbis.installation-protocol" in labels:
                    expected["installationProtocol"] = labels["io.orbis.installation-protocol"]
                expected = CONTROLLER_IDENTITY.release_identity(expected)
                platform = {"os": local.get("Os"), "architecture": local.get("Architecture")}
                if local.get("Variant"):
                    platform["variant"] = local["Variant"]
                platform = CONTROLLER_IDENTITY.platform_identity(platform, selectable=True)
                proof = CONTROLLER_IDENTITY.produce_bounded_publication(
                    controller["releaseTag"], platform, cancelled,
                    timeout_seconds=min(CONTROLLER_IDENTITY.PRODUCER_TIMEOUT_SECONDS, deadline - time.monotonic() - 60))
                verified = CONTROLLER_IDENTITY.verify_publication_proof(expected, proof)
                if json.loads(verified.platform_bytes) != platform:
                    raise ValueError("published platform differs from the controller")
                manifests = local.get("Manifests")
                if manifests is not None and (not isinstance(manifests, list) or len(manifests) > 256):
                    raise ValueError("controller platform identity is unavailable")
                selected = None
                if manifests:
                    matches = []
                    for item in manifests:
                        if not isinstance(item, dict) or item.get("Kind") != "image" or item.get("Available") is not True:
                            continue
                        descriptor = item.get("Descriptor")
                        image_data = item.get("ImageData")
                        if not isinstance(descriptor, dict) or (image_data is not None and not isinstance(image_data, dict)):
                            raise ValueError("controller platform observation is invalid")
                        described = descriptor.get("platform")
                        observed = (image_data or {}).get("Platform")
                        if described is None and observed is None:
                            raise ValueError("controller platform observation is absent")
                        if described is not None:
                            described = CONTROLLER_IDENTITY.platform_identity(described, selectable=False)
                        if observed is not None:
                            observed = CONTROLLER_IDENTITY.platform_identity(observed, selectable=False)
                        if described is not None and observed is not None and described != observed:
                            raise ValueError("controller platform observations disagree")
                        if (described or observed) == platform:
                            matches.append(item)
                    if len(matches) != 1 or matches[0]["Descriptor"].get("digest") != verified.manifest_digest:
                        raise ValueError("controller platform differs from publication")
                elif request["imageId"] != verified.config_digest:
                    selected = self.publication_image(request["imageId"], platform)
                    if (selected["Id"] != verified.manifest_digest or selected["Labels"] != local["Labels"]
                            or selected["RootFS"] != local["RootFS"]):
                        raise ValueError("controller platform differs from publication")
                if (not isinstance(local.get("RootFS"), dict) or local["RootFS"].get("Type") != "layers"
                        or local["RootFS"].get("Layers") != list(verified.rootfs_diff_ids)):
                    raise ValueError("controller rootfs differs from publication")
                after = self._capture_controller_config_locked(request["pointId"], request["controllerId"], request["imageId"])
                if (before != after or self.publication_image(request["imageId"]) != local
                        or (selected is not None and self.publication_image(request["imageId"], platform) != selected)
                        or time.monotonic() >= deadline or (cancelled is not None and cancelled())):
                    raise ValueError("controller changed during publication preparation")
                receipt = {"version": 1, "pointId": request["pointId"], "controller": before["controller"],
                           "rootIdentity": before["rootIdentity"], "configurationSetSha256": before["configurationSetSha256"],
                           "proof": proof}
                receipt["preparationSha256"] = hashlib.sha256(
                    b"orbis.controller-publication-capture.v1\n" + CONTROLLER_IDENTITY.canonical(receipt)).hexdigest()
                if len(CONTROLLER_IDENTITY.canonical(receipt)) > CONTROLLER_IDENTITY.PROOF_WIRE_BYTES:
                    raise ValueError("controller publication receipt exceeds its limit")
                CAPTURE_AUTHORITY.capture_preparation(self.state_dir, self.root, self.context, before, receipt)
                self.prepared_capture = {key: request[key] for key in request} | {
                    "preparationSha256": receipt["preparationSha256"], "expiresAt": time.time() + 120}
                return receipt
        finally:
            HOST.CAPTURE_READ_DEADLINE.reset(deadline_token)
            self.lock.release()

    def _capture_controller_config_locked(self, point_id: str, controller_id: str, image_id: str) -> dict:
        deadline = time.monotonic() + 15
        outer_deadline = HOST.CAPTURE_READ_DEADLINE.get()
        token = HOST.CAPTURE_READ_DEADLINE.set(min(deadline, outer_deadline) if outer_deadline is not None else deadline)
        try:
            self.require_controller_capture_idle()
            with controller_config_files(self.root) as (root_identity, files, enrollment):
                hashes = {item["path"]: item.get("sha256") for item in files if item["path"] != "orbis-host-compose.yml" or item["present"]}
                retained = None
                if isinstance(enrollment, dict) and enrollment.get("schema") == HOST.IDENTITY.RETAINED_SCHEMA:
                    retained = HOST.resolve_current_identity(self.root, self.context)
                    if enrollment.get("files") != hashes:
                        raise ValueError("retained configuration changed")
                if retained is None and (not isinstance(enrollment, dict) or set(enrollment) != {"schema", "root", "dockerContext", "tag", "digest", "files"}
                        or enrollment.get("schema") != "orbis.host.v1" or enrollment.get("root") != str(self.root)
                        or enrollment.get("dockerContext") != self.context or enrollment.get("files") != hashes
                        or not isinstance(enrollment.get("tag"), str) or not PLAN.TAG.fullmatch(enrollment["tag"])
                        or not isinstance(enrollment.get("digest"), str) or not PLAN.DIGEST.fullmatch(enrollment["digest"])):
                    raise ValueError("controller configuration is not enrolled")
                before = self.controller_capture_identity(controller_id, image_id, enrollment)
                self.require_controller_capture_idle()
                after = self.controller_capture_identity(controller_id, image_id, enrollment)
                if before != after:
                    raise ValueError("controller identity changed")
                descriptor = {"version": 2 if retained else 1, "pointId": point_id, "controller": before, "rootIdentity": root_identity,
                              "files": [{key: value for key, value in item.items() if key != "data"} for item in files]}
                if retained:
                    latest = HOST.resolve_current_identity(self.root, self.context)
                    if latest != retained:
                        raise ValueError("retained authority changed during configuration capture")
                    descriptor["retainedIdentity"] = retained.controller()
                domain = b"orbis.controller-config.v2\n" if retained else b"orbis.controller-config.v1\n"
                digest = hashlib.sha256(domain + json.dumps(descriptor, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
                result = {**descriptor, "files": files, "configurationSetSha256": digest}
            return result
        finally:
            HOST.CAPTURE_READ_DEADLINE.reset(token)

    def require_controller_capture_idle(self) -> None:
        if self.busy or self.maintenance_file.exists() or self.maintenance_file.is_symlink():
            raise ValueError("another host operation is in progress")
        for file, settled in ((self.job_file, {"complete", "rolled-back", "failed"}),
                              (self.package_job_file, {"complete"}),
                              (self.restart_job_file, {"complete", "failed"})):
            job = read_capture_job(file)
            if job is not None and job.get("state") not in settled:
                raise ValueError("another host operation requires completion or recovery")

    def select_channel(self, channel: str, revision: str, acknowledge_nightly: bool = False) -> dict:
        with self.lock:
            self.require_idle_core()
            self.require_healthy_core()
            record = read_channel(self.root)
            if channel not in {"stable", "nightly"} or revision != record["revision"]:
                raise ValueError("the release channel changed; refresh before continuing")
            if channel == "nightly" and acknowledge_nightly is not True:
                raise ValueError("confirm the Nightly warning before enabling it")
            current = self.current_manifest()
            if channel == "stable" and not POLICY.is_stable_release_tag(current["tag"]):
                raise ValueError("install a reviewed Stable release before leaving Nightly")
            if channel != record["channel"]:
                save_channel(self.root, channel, str(uuid.uuid4()))
            return {"channel": read_channel(self.root)["channel"]}

    def validate_channel_plan(self, record: dict, current: dict, target: dict, return_to_stable: bool) -> None:
        if type(return_to_stable) is not bool:
            raise ValueError("the Stable return choice is invalid")
        if return_to_stable:
            if record["channel"] != "nightly" or not POLICY.is_stable_release_tag(target["tag"]) or target["tag"] != latest_stable_tag():
                raise ValueError("review the latest Stable release before leaving Nightly")
        elif not POLICY.release_allowed_on_channel(target["tag"], record["channel"]):
            raise ValueError("this release is not available on the selected update channel")
        order = POLICY.version_order(target["tag"], current["tag"])
        if order is None or order == 0:
            raise ValueError("choose a different published release")
        if order < 0 and not POLICY.downgrade_allowed_on_channel(target["tag"], current["tag"], record["channel"]):
            raise ValueError("Nightly downgrades are limited to the same version's beta revisions and earlier Stable releases")

    def complete_channel_change(self, job: dict) -> None:
        if not job.get("returnToStable"):
            return
        current = read_channel(self.root)
        committed = {"version": 1, "channel": "stable", "revision": job["id"]}
        if current == committed:
            return
        if current != job.get("channelState") or not POLICY.is_stable_release_tag(job["target"]["tag"]):
            raise ValueError("the release channel changed during installation; local recovery is required")
        save_channel(self.root, "stable", job["id"])

    def restart_status(self) -> dict:
        if not Path("/run/systemd/system").is_dir() or not os.access("/usr/bin/systemctl", os.X_OK):
            return {"available": False, "reason": "Server restart requires a systemd host.", "job": None}
        current_boot = boot_id()
        job = read_private(self.restart_job_file)
        if job:
            if (
                job.get("schema") != "orbis.restart-job.v1"
                or job.get("root") != str(self.root)
                or job.get("dockerContext") != self.context
                or job.get("state") not in {"restarting", "complete", "failed"}
                or not isinstance(job.get("id"), str)
                or not isinstance(job.get("bootId"), str)
                or not isinstance(job.get("createdAt"), (int, float))
            ):
                raise ValueError("server restart job is invalid")
            uuid.UUID(job["id"])
            uuid.UUID(job["bootId"])
            if job["state"] == "restarting" and job["bootId"] != current_boot:
                job.update(state="complete", finishedAt=time.time(), message="The server restarted and Orbis is reconnecting.")
                write_private(self.restart_job_file, job)
        return {
            "available": True,
            "rebootRequired": Path("/run/reboot-required").is_file(),
            "job": {key: job.get(key) for key in ("id", "state", "createdAt", "finishedAt", "message")} if job else None,
        }

    def run_capture_mutation(self, work):
        with self.lock, HOST.host_lock(self.root):
            self.require_controller_capture_idle()
            return work()

    def require_capture_fence_clear(self) -> None:
        HOST.require_no_capture_fence(self.root)

    def require_restart_clear(self) -> None:
        self.require_capture_fence_clear()
        if not self.restart_job_file.exists() and not self.restart_job_file.is_symlink():
            return
        current = self.restart_status()
        if not current["available"]:
            raise ValueError(current["reason"])
        if (current.get("job") or {}).get("state") == "restarting":
            raise ValueError("the server is restarting; wait for it to reconnect")

    def require_restart_ready(self) -> None:
        self.require_restart_clear()
        self.require_healthy_core()
        self.require_package_clear()
        if self.maintenance_file.exists() or self.maintenance_file.is_symlink():
            raise ValueError("host helper maintenance is in progress")
        if self.busy:
            raise ValueError("another host update is in progress")
        core_job = read_private(self.job_file)
        if core_job and core_job.get("state") in {"running", "recovering", "interrupted"}:
            raise ValueError("resolve the Orbis core update before restarting the server")
        state = self.restart_status()
        if not state["available"]:
            raise ValueError(state["reason"])

    def restart_plan(self) -> dict:
        with self.lock, HOST.host_lock(self.root), package_locks():
            self.require_restart_ready()
            identifier = str(uuid.uuid4())
            created = time.time()
            record = {
                "schema": "orbis.restart-plan.v1", "id": identifier,
                "root": str(self.root), "dockerContext": self.context,
                "bootId": boot_id(), "createdAt": created,
            }
            write_private(self.state_dir / f"restart-plan-{identifier}.json", record)
            return {"planId": identifier, "expiresAt": created + RESTART_PLAN_TTL_SECONDS, "rebootRequired": Path("/run/reboot-required").is_file()}

    def restart_apply(self, plan_id: str) -> tuple[dict, Callable[[], None]]:
        try:
            uuid.UUID(plan_id)
        except (TypeError, ValueError) as error:
            raise ValueError("restart plan ID is invalid") from error
        with self.lock, HOST.host_lock(self.root), package_locks():
            self.require_restart_ready()
            file = self.state_dir / f"restart-plan-{plan_id}.json"
            plan = read_private(file)
            if (
                not plan or plan.get("schema") != "orbis.restart-plan.v1" or plan.get("id") != plan_id
                or plan.get("root") != str(self.root) or plan.get("dockerContext") != self.context
                or plan.get("bootId") != boot_id() or "consumedAt" in plan
                or not plan_is_current(plan.get("createdAt"), RESTART_PLAN_TTL_SECONDS)
            ):
                raise ValueError("restart plan is missing, changed, expired, or already used; review a new restart")
            plan["consumedAt"] = time.time()
            write_private(file, plan)
            job = {
                "schema": "orbis.restart-job.v1", "id": plan_id, "root": str(self.root),
                "dockerContext": self.context, "bootId": plan["bootId"], "state": "restarting",
                "createdAt": time.time(), "message": "The server is restarting. Orbis will reconnect when it returns.",
            }
            write_private(self.restart_job_file, job)

        def run() -> None:
            try:
                with self.lock, HOST.host_lock(self.root), package_locks():
                    # Recheck after flushing the HTTP response, before requesting shutdown.
                    current = read_private(self.restart_job_file)
                    if not current or current.get("id") != plan_id or current.get("state") != "restarting" or current.get("bootId") != boot_id():
                        raise ValueError("server restart job changed")
                    self.require_package_clear()
                    self.require_healthy_core()
                    if self.maintenance_file.exists() or self.maintenance_file.is_symlink() or self.busy:
                        raise ValueError("another host operation is in progress")
                    core_job = read_private(self.job_file)
                    if core_job and core_job.get("state") in {"running", "recovering", "interrupted"}:
                        raise ValueError("an Orbis core update is in progress")
                    result = subprocess.run(["/usr/bin/systemctl", "reboot", "--no-block"], capture_output=True, text=True, timeout=10, check=False)
                    if result.returncode:
                        raise RuntimeError("systemd rejected the restart")
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                current = read_private(self.restart_job_file)
                if current and current.get("id") == plan_id and current.get("state") == "restarting":
                    if isinstance(error, subprocess.TimeoutExpired):
                        job["message"] = "The restart request could not be confirmed. Wait for the server to reconnect before starting another host operation."
                    else:
                        job.update(state="failed", finishedAt=time.time(), message="The server restart could not be requested. Review host operations before retrying.")
                    write_private(self.restart_job_file, job)

        return {"jobId": plan_id, "state": "restarting"}, lambda: threading.Thread(target=run, daemon=True).start()

    def require_package_clear(self) -> None:
        job = read_private(self.package_job_file)
        if job and job.get("state") in {"queued", "running", "failed", "interrupted"} and not self.refresh_retryable(job):
            raise ValueError("resolve the host package transaction before changing the Orbis core")

    def refresh_retryable(self, job: dict) -> bool:
        if job.get("kind") != "refresh" or job.get("state") not in {"failed", "interrupted"}:
            return False
        identifier = job.get("id")
        try:
            uuid.UUID(identifier)
            state = subprocess.run(["/usr/bin/systemctl", "show", "-p", "ActiveState", "--value", f"orbis-package-{identifier}.service"],
                                   capture_output=True, text=True, timeout=3, check=False)
            return state.returncode == 0 and state.stdout.strip() in {"inactive", "failed"}
        except (ValueError, TypeError, AttributeError, OSError, subprocess.SubprocessError):
            return False

    def require_healthy_core(self) -> None:
        current = self.status()
        if not (
            current["enrolled"]
            and current["imageMatches"]
            and current["coreState"] == "running"
            and current["coreHealth"] == "healthy"
        ):
            raise ValueError("host package changes require a healthy enrolled Orbis core")

    def package_job_status(self) -> dict:
        job = read_private(self.package_job_file)
        if job and job.get("state") in {"queued", "running"}:
            if not isinstance(job.get("createdAt"), (int, float)):
                raise ValueError("package job record is invalid")
            if time.time() - job["createdAt"] <= 5:
                return {"available": True, "job": self.public_package_job(job)}
            identifier = job.get("id")
            if not isinstance(identifier, str):
                raise ValueError("package job record is invalid")
            uuid.UUID(identifier)
            unit = f"orbis-package-{identifier}.service"
            result = subprocess.run(
                ["/usr/bin/systemctl", "show", "-p", "ActiveState", "--value", unit],
                capture_output=True,
                text=True,
                timeout=3,
                check=False,
            )
            if result.returncode or result.stdout.strip() not in {"active", "activating"}:
                try:
                    with HOST.host_lock(self.root):
                        refreshed = read_private(self.package_job_file)
                        if refreshed and refreshed.get("id") == identifier and refreshed.get("state") in {"queued", "running"}:
                            refreshed["state"] = "interrupted"
                            refreshed["finishedAt"] = time.time()
                            refreshed["message"] = "The package worker stopped without recording completion. Inspect APT and dpkg locally."
                            write_private(self.package_job_file, refreshed)
                        job = refreshed
                except ValueError:
                    job = read_private(self.package_job_file)
        return {
            "available": True,
            "job": self.public_package_job(job)
            if job
            else None,
        }

    def public_package_job(self, job: dict) -> dict:
        identifier = job.get("id")
        if not isinstance(identifier, str):
            raise ValueError("package job identity is invalid")
        uuid.UUID(identifier)
        return {
            **{key: job.get(key) for key in ("id", "state", "createdAt", "startedAt", "finishedAt", "message", "exitCode", "rebootRequired", "operationCount")},
            **({"kind": "refresh"} if job.get("kind") == "refresh" else {}),
            "output": terminal_tail(self.state_dir / f"package-job-{identifier}.log"),
        }

    def require_package_ready(self, allow_refresh_retry: bool = False) -> dict | None:
        self.require_restart_clear()
        self.require_healthy_core()
        if self.maintenance_file.exists() or self.maintenance_file.is_symlink():
            raise ValueError("host helper maintenance is in progress")
        if self.busy:
            raise ValueError("another host update is in progress")
        core_job = read_private(self.job_file)
        if core_job and core_job.get("state") in {"running", "recovering", "interrupted"}:
            raise ValueError("resolve the Orbis core update before changing host packages")
        package_job = self.package_job_status()["job"]
        if package_job and package_job.get("state") in {"queued", "running", "failed", "interrupted"} and not (allow_refresh_retry and self.refresh_retryable(package_job)):
            raise ValueError("resolve the previous host package transaction first")
        return package_job

    def package_refresh(self) -> dict:
        with self.lock:
            self.require_package_ready(allow_refresh_retry=True)
            PACKAGES.require_ubuntu()
            identifier = str(uuid.uuid4())
            created = time.time()
            write_private(self.state_dir / f"package-plan-{identifier}.json", {
                "schema": "orbis.package-refresh.v1", "id": identifier, "root": str(self.root), "createdAt": created,
            })
            return self.start_package_worker({
                "schema": "orbis.package-job.v1", "id": identifier, "kind": "refresh", "state": "queued", "createdAt": created,
                "message": "Refreshing package lists.",
            })

    def package_plan(self, names: list[str]) -> dict:
        with self.lock:
            self.require_package_ready()
            simulation = PACKAGES.simulate_upgrades(names)
            plan_id = str(uuid.uuid4())
            record = {
                "schema": "orbis.package-plan.v1",
                "id": plan_id,
                "root": str(self.root),
                "createdAt": time.time(),
                **simulation,
            }
            write_private(self.state_dir / f"package-plan-{plan_id}.json", record)
            return {
                "planId": plan_id, "createdAt": record["createdAt"],
                "expiresAt": record["createdAt"] + PLAN_TTL_SECONDS, **simulation,
            }

    def package_apply(self, plan_id: str) -> dict:
        with self.lock:
            package_job = self.require_package_ready()
            try:
                uuid.UUID(plan_id)
            except (TypeError, ValueError) as error:
                raise ValueError("package plan ID is invalid") from error
            if package_job and package_job.get("id") == plan_id:
                raise ValueError("package plan was already applied; prepare a new plan")
            plan = read_private(self.state_dir / f"package-plan-{plan_id}.json")
            if (
                not plan
                or plan.get("schema") != "orbis.package-plan.v1"
                or plan.get("id") != plan_id
                or plan.get("root") != str(self.root)
                or not plan_is_current(plan.get("createdAt"), PLAN_TTL_SECONDS)
                or not isinstance(plan.get("selected"), list)
                or not isinstance(plan.get("operations"), list)
            ):
                raise ValueError("package plan is missing, changed, or expired")
            current = PACKAGES.simulate_upgrades([item["name"] for item in plan["selected"]])
            if current != {"selected": plan["selected"], "operations": plan["operations"]}:
                raise ValueError("APT package candidates changed; prepare a new plan")
            job = {
                "schema": "orbis.package-job.v1",
                "id": plan_id,
                "state": "queued",
                "createdAt": time.time(),
                "operationCount": len(plan["operations"]),
            }
            return self.start_package_worker(job)

    def start_package_worker(self, job: dict) -> dict:
        identifier = job["id"]
        write_private(self.package_job_file, job)
        command = [
            "/usr/bin/systemd-run", f"--unit=orbis-package-{identifier}", "--collect", "--property=Type=exec",
            "/usr/bin/python3", str(Path(__file__).with_name("orbis-host-package-worker.py")), identifier,
        ]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=10, check=False)
            if result.returncode:
                raise RuntimeError("systemd worker launch was not confirmed")
        except (OSError, RuntimeError, subprocess.TimeoutExpired):
            # A lost launch response does not prove that the worker did not start.
            # Keep the durable queued record until status observes this exact unit.
            pass
        return {"jobId": identifier, "state": "queued"}

    def state_matches(self, saved: dict | None) -> bool:
        if saved and saved.get("schema") == HOST.IDENTITY.RETAINED_SCHEMA:
            try:
                HOST.resolve_current_identity(self.root, self.context)
                return True
            except (OSError, ValueError, RuntimeError):
                return False
        return enrollment_matches(self.root, self.context, saved)

    def current_manifest(self) -> dict[str, str]:
        return installed_manifest(self.root, self.context)

    def status(self) -> dict:
        saved = HOST.saved_state(self.root)
        enrolled = self.state_matches(saved)
        core = HOST.current_core(self.root, self.context)
        retained = None
        if enrolled and saved and saved.get("schema") == HOST.IDENTITY.RETAINED_SCHEMA:
            try:
                retained = HOST.resolve_current_identity(self.root, self.context)
            except (OSError, ValueError, RuntimeError):
                enrolled = False
        publication = retained.publication() if retained else (saved or {})
        expected_reference = retained.controller()["creationReference"] if retained else f"{PLAN.IMAGE}@{(saved or {}).get('digest')}"
        job = read_private(self.job_file)
        phase = None
        journal = read_private(UPDATE.journal_path(Path(job["snapshot"]))) if job and isinstance(job.get("snapshot"), str) else None
        download = UPDATE.safe_download(journal)
        if job and job.get("state") == "running":
            phase = journal.get("stage") if journal else "preparing"
            if phase not in UPDATE.FAILURE_STAGES | UPDATE.TERMINAL_STAGES:
                phase = "preparing"
        if job and job.get("state") == "interrupted":
            stage = journal.get("stage") if journal else None
            expected_digest = job["target"]["digest"] if stage == "complete" else job["current"]["digest"]
            healthy_expected = (
                enrolled
                and saved
                and publication.get("digest") == expected_digest
                and core.get("image") == expected_reference
                and (retained is None or (stage == "rolled-back" and journal.get("retainedSource") is not None
                     and UPDATE.retained_source(self.root, self.context, journal, job["current"], job["target"]) == saved))
                and core.get("health") == "healthy"
            )
            if stage in {"complete", "rolled-back"} and healthy_expected:
                if stage == "complete":
                    try:
                        self.complete_channel_change(job)
                    except (OSError, ValueError, json.JSONDecodeError):
                        job["message"] = "Stable is installed, but its channel change needs recovery. Refresh status to retry."
                        write_private(self.job_file, job)
                        return {
                            "available": True, "capabilities": ["restart.v1", "packages.refresh.v1", "release-channels.v1", "controller-config.v1"],
                            "enrolled": enrolled, "currentTag": saved.get("tag"), "currentDigest": saved.get("digest"),
                            "coreState": core.get("state"), "coreHealth": core.get("health"), "imageMatches": True,
                            "job": {key: job.get(key) for key in ("id", "state", "targetTag", "startedAt", "finishedAt", "message")},
                        }
                job["state"] = "complete" if stage == "complete" else "rolled-back"
                job.update(UPDATE.safe_failure(journal))
                job["message"] = "Reviewed Orbis release is healthy." if stage == "complete" else f"{UPDATE.failure_message(journal)} Previous Orbis release is healthy.".strip()
                job["finishedAt"] = time.time()
                write_private(self.job_file, job)
            elif stage == "aborted":
                job["state"] = "failed"
                job.update(UPDATE.safe_failure(journal))
                job["message"] = "Update stopped before service downtime."
                job["finishedAt"] = time.time()
                write_private(self.job_file, job)
        return {
            "available": True,
            "capabilities": ["restart.v1", "packages.refresh.v1", "release-channels.v1", "controller-config.v1"],
            "enrolled": enrolled,
            "currentTag": publication.get("tag"),
            "currentDigest": publication.get("digest"),
            "coreState": core.get("state"),
            "coreHealth": core.get("health"),
            "imageMatches": bool(enrolled and saved and core.get("image") == expected_reference),
            "job": {key: job.get(key) for key in ("id", "state", "targetTag", "startedAt", "finishedAt", "message")} | {"phase": phase} | download | UPDATE.safe_failure(job)
            if job
            else None,
        }

    def plan(self, tag: str, return_to_stable: bool = False) -> dict:
        with self.lock:
            self.require_restart_clear()
            self.require_package_clear()
            if self.maintenance_file.exists() or self.maintenance_file.is_symlink():
                raise ValueError("host helper maintenance is in progress")
            if self.busy:
                raise ValueError("another host update is in progress")
            previous = read_private(self.job_file)
            if previous and previous.get("state") in {"running", "recovering", "interrupted"}:
                raise ValueError("resolve the previous host update before creating another plan")
            self.require_core_overlay_clear(previous)
        current = self.current_manifest()
        target = manifest_for_tag(tag)
        channel = read_channel(self.root)
        self.validate_channel_plan(channel, current, target, return_to_stable)
        plan_id = str(uuid.uuid4())
        snapshot = self.snapshots / f"orbis-{tag}-{plan_id}"
        result = UPDATE.update_plan(self.root, current, target, self.context, snapshot)
        record = {
            "schema": "orbis.host-service-plan.v1",
            "id": plan_id,
            "createdAt": time.time(),
            "current": current,
            "target": target,
            "snapshot": str(snapshot),
            "channelState": channel,
            "returnToStable": return_to_stable,
        }
        if HOST.retained_state(self.root):
            record["retainedSource"] = HOST.retained_descriptor(self.root, self.context, current)
        write_private(self.state_dir / f"plan-{plan_id}.json", record)
        return {
            "planId": plan_id,
            "currentTag": current["tag"],
            "targetTag": target["tag"],
            "targetDigest": target["digest"],
            "snapshotBytes": result["snapshotBytes"],
            "appsMustBeStopped": result.get("runningAppsMustBeStopped", True),
        }

    def _read_plan(self, plan_id: str) -> dict:
        try:
            uuid.UUID(plan_id)
        except ValueError as error:
            raise ValueError("plan ID is invalid") from error
        record = read_private(self.state_dir / f"plan-{plan_id}.json")
        if (
            not record
            or record.get("schema") != "orbis.host-service-plan.v1"
            or record.get("id") != plan_id
            or not plan_is_current(record.get("createdAt"), PLAN_TTL_SECONDS)
        ):
            raise ValueError("update plan is missing or expired; create a new plan")
        return record

    def apply(self, plan_id: str) -> tuple[dict, Callable[[], None]]:
        if self.core_operation_maintenance()["state"] != "idle":
            raise ValueError("resolve the active Orbis operation before installing another release")
        with self.lock:
            self.require_restart_clear()
            self.require_package_clear()
            if self.maintenance_file.exists() or self.maintenance_file.is_symlink():
                raise ValueError("host helper maintenance is in progress")
            if self.busy:
                raise ValueError("another host update is in progress")
            previous = read_private(self.job_file)
            if previous and previous.get("state") in {"running", "recovering", "interrupted"}:
                raise ValueError("resolve the previous host update before applying another")
            self.require_core_overlay_clear(previous)
            plan = self._read_plan(plan_id)
            current = PLAN.validate_manifest(plan["current"])
            target = PLAN.validate_manifest(plan["target"])
            if self.current_manifest() != current:
                raise ValueError("installed release changed since the update plan")
            if HOST.retained_state(self.root) or plan.get("retainedSource") is not None:
                if plan.get("retainedSource") != HOST.retained_descriptor(self.root, self.context, current):
                    raise ValueError("retained source changed since the update plan")
            if plan.get("channelState") != read_channel(self.root):
                raise ValueError("the release channel changed since the update plan")
            self.validate_channel_plan(plan["channelState"], current, target, plan.get("returnToStable", False))
            snapshot = Path(plan["snapshot"])
            if snapshot.parent != self.snapshots or snapshot.name != f"orbis-{target['tag']}-{plan_id}":
                raise ValueError("update plan has an invalid snapshot destination")
            overlay_id = self.core_overlays().begin(plan_id, current, target)
            job = {
                "schema": "orbis.host-service-job.v1",
                "id": plan_id,
                "state": "running",
                "overlayId": overlay_id,
                "targetTag": target["tag"],
                "startedAt": time.time(),
                "snapshot": str(snapshot),
                "current": current,
                "target": target,
                "channelState": plan["channelState"],
                "returnToStable": plan.get("returnToStable", False),
            }
            if plan.get("retainedSource") is not None:
                job["retainedSource"] = plan["retainedSource"]
            write_private(self.job_file, job)
            self.busy = True

        def run() -> None:
            try:
                self.core_overlays().resume(job)
                options = {"expected_source": job["retainedSource"]} if job.get("retainedSource") is not None else {}
                UPDATE.apply_update(self.root, current, target, self.context, snapshot, controller_state_dir=self.state_dir, **options)
                self.complete_channel_change(job)
                job["state"] = "complete"
                job["message"] = "Orbis reached the reviewed image and healthy state."
            except Exception:
                try:
                    journal = read_private(UPDATE.journal_path(snapshot))
                except (OSError, ValueError, json.JSONDecodeError):
                    journal = None
                stage = journal.get("stage") if journal else None
                job.update(UPDATE.safe_failure(journal))
                job["state"] = "rolled-back" if stage == "rolled-back" else "failed" if stage in {None, "aborted"} else "interrupted"
                job["message"] = (
                    f"{UPDATE.failure_message(journal)} The previous Orbis release was restored.".strip()
                    if job["state"] == "rolled-back"
                    else "Update stopped before service downtime."
                    if job["state"] == "failed"
                    else "Update needs local inspection or recovery."
                )
            finally:
                job["finishedAt"] = time.time()
                try:
                    write_private(self.job_file, job)
                    if job["state"] in {"complete", "rolled-back", "failed"}:
                        self.core_operation_maintenance()
                finally:
                    with self.lock:
                        self.busy = False

        return {"jobId": plan_id, "state": "running"}, lambda: threading.Thread(target=run, daemon=True).start()

    def recover(self, job_id: str) -> tuple[dict, Callable[[], None]]:
        with self.lock:
            self.require_restart_clear()
            self.require_package_clear()
            if self.maintenance_file.exists() or self.maintenance_file.is_symlink():
                raise ValueError("host helper maintenance is in progress")
            if self.busy:
                raise ValueError("another host update is in progress")
            job = read_private(self.job_file)
            if not job or job.get("id") != job_id or job.get("state") != "interrupted":
                raise ValueError("there is no interrupted transaction for this job ID")
            current = PLAN.validate_manifest(job["current"])
            target = PLAN.validate_manifest(job["target"])
            snapshot = Path(job["snapshot"])
            if snapshot.parent != self.snapshots or snapshot.name != f"orbis-{target['tag']}-{job_id}":
                raise ValueError("interrupted job has an invalid snapshot destination")
            journal = UPDATE.read_journal(snapshot, self.root, self.context, current, target)
            if journal.get("stage") in UPDATE.TERMINAL_STAGES:
                raise ValueError("transaction already finished; refresh status")
            self.core_overlays().resume(job)
            job["state"] = "recovering"
            write_private(self.job_file, job)
            self.busy = True

        def run() -> None:
            try:
                outcome = UPDATE.recover(self.root, current, target, self.context, snapshot, controller_state_dir=self.state_dir)
                committed = isinstance(outcome, dict) and outcome.get("result") == "healthy"
                if committed:
                    self.complete_channel_change(job)
                job["state"] = "complete" if committed else "rolled-back"
                journal = read_private(UPDATE.journal_path(snapshot))
                job.update(UPDATE.safe_failure(journal))
                job["message"] = (
                    "Orbis reached the reviewed image and healthy state."
                    if committed else f"{UPDATE.failure_message(journal)} Previous Orbis release is healthy.".strip()
                )
            except Exception:
                job["state"] = "interrupted"
                job["message"] = "Recovery needs local inspection."
            finally:
                job["finishedAt"] = time.time()
                try:
                    write_private(self.job_file, job)
                    if job["state"] in {"complete", "rolled-back"}:
                        self.core_operation_maintenance()
                finally:
                    with self.lock:
                        self.busy = False

        return {"jobId": job_id, "state": "recovering"}, lambda: threading.Thread(target=run, daemon=True).start()


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def trusted_capture_peer(connection):
    if not hasattr(socket, "SO_PEERCRED"):
        return False
    try:
        pid, uid, _gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
    except (OSError, ValueError, struct.error):
        return False
    return pid > 0 and uid == os.geteuid() == 0


class Handler(http.server.BaseHTTPRequestHandler):
    server: UnixHTTPServer

    def log_message(self, format: str, *args: object) -> None:
        pass

    def send_json(self, status: int, data: dict) -> None:
        body = json.dumps(data, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def body(self, limit: int = BODY_LIMIT) -> dict:
        length = self.headers.get("Content-Length", "")
        if not length.isascii() or not length.isdecimal() or not 0 < int(length) <= limit:
            raise ValueError("request body length is invalid")
        data = json.loads(self.rfile.read(int(length)))
        if not isinstance(data, dict):
            raise ValueError("request body must be an object")
        return data

    def do_GET(self) -> None:
        if self.path in {"/v3/controller-capture-authority/capability", "/v1/retained-restore/capability"}:
            if not trusted_capture_peer(self.connection):
                self.send_json(403, {"error": "native helper peer is unavailable"})
                return
            try:
                kind = "capture" if self.path.startswith("/v3/") else "restore"
                self.send_json(200, self.server.service.time_machine_capability(kind))
            except (OSError, ValueError, RuntimeError, TypeError):
                self.send_json(409, {"error": "Native helper contracts require a complete protected installation."})
            return
        if self.path == "/v1/retained-restore/candidate-resume-capability":
            if not trusted_capture_peer(self.connection):
                self.send_json(403, {"error": "retained restore peer is unavailable"})
                return
            self.send_json(200, {"version": 1, "protocol": "root-candidate-resume.v1", "leaseMilliseconds": 900000,
                                 "requiresAppCapability": "orbis.retained-app-activation.v1", "normalBootstrap": "root-normal-bootstrap.v1",
                                 "ordinaryWritesHeldUntilBootstrap": True})
            return
        if self.path == "/v1/portable-restore/capability":
            if not trusted_capture_peer(self.connection):
                self.send_json(403, {"error": "portable restore peer is unavailable"})
                return
            self.send_json(200, {"version": 1, "mountPolicy": "orbis.portable-mount-policy.v1", "prepare": False, "activation": False})
            return
        if self.path == "/v2/controller-capture-authority/capability":
            self.send_json(200, {"version": 2, "capability": "controller-capture-authority.v2"})
            return
        if self.path in {"/v1/proxy-host-identity", "/v1/proxy-host-identity/capability"}:
            if not trusted_capture_peer(self.connection):
                self.send_json(403, {"error": "proxy identity peer is unavailable"})
                return
            if self.path.endswith("/capability"):
                self.send_json(200, {"version": 1, "capability": "proxy-host-identity.v1"})
                return
            try:
                self.send_json(200, self.server.service.proxy_host_identity())
            except (OSError, ValueError, RuntimeError, TypeError, subprocess.SubprocessError):
                self.send_json(409, {"code": "PROXY_LAYOUT_MIGRATION_REQUIRED", "message": "The proxy needs an explicit host identity layout migration before coherent capture. Existing data was preserved."})
            return
        if self.path == "/v1/core-operation/maintenance":
            if not trusted_capture_peer(self.connection):
                self.send_json(403, {"error": "core operation peer is unavailable"})
                return
            self.send_json(200, self.server.service.core_operation_maintenance())
            return
        if self.path == "/v1/retained-restore/maintenance":
            if not trusted_capture_peer(self.connection):
                self.send_json(403, {"error": "retained restore peer is unavailable"})
                return
            try:
                result = self.server.service.retained_restores().maintenance()
            except (OSError, ValueError, RuntimeError, TypeError):
                result = {"state": "checking"}
            self.send_json(200, result)
            return
        if self.path == "/v1/retained-restore/capability":
            self.send_json(200, {"version": 1, "capability": "retained-restore-transaction.v1"})
            return
        if self.path == "/v1/controller-capture-authority/capability":
            self.send_json(200, {"version": 1, "capability": "controller-capture-authority.v1"})
            return
        if self.path == "/v1/controller-capture-fence/capability":
            self.send_json(200, {"version": 1, "capability": "controller-capture-fence.v1"})
            return
        if self.path == "/v1/controller-publication/capability":
            self.send_json(200, {"version": 1, "capability": "controller-publication.v1"})
            return
        if self.path == "/v1/controller-config/capability":
            self.send_json(200, {"version": 1, "capability": "controller-config.v1"})
            return
        if self.path == "/v1/discovery/status":
            self.send_json(200, self.server.service.discovery.policy_status())
            return
        if self.path == "/v1/discovery/interfaces":
            self.send_json(200, self.server.service.discovery.inventory())
            return
        if self.path == "/v1/drives":
            self.send_json(200, self.server.service.drives.read())
            return
        if self.path == "/v1/sensors":
            self.send_json(200, SENSORS.read())
            return
        if self.path == "/v1/processes":
            self.send_json(200, PROCESSES.read())
            return
        if self.path == "/v1/telemetry":
            self.send_json(200, TELEMETRY.read())
            return
        if self.path == "/v1/status":
            try:
                self.send_json(200, self.server.service.status())
            except (OSError, ValueError, RuntimeError):
                self.send_json(503, {"error": "host status is unavailable"})
            return
        if self.path == "/v1/restart":
            try:
                self.send_json(200, self.server.service.restart_status())
            except (OSError, ValueError, RuntimeError):
                self.send_json(503, {"error": "server restart status is unavailable"})
            return
        if self.path == "/v1/packages":
            try:
                self.send_json(200, PACKAGES.inventory())
            except ValueError as error:
                self.send_json(200, {"available": False, "reason": str(error)})
            except (OSError, RuntimeError, SystemError):
                self.send_json(503, {"error": "host package inventory is unavailable"})
            return
        if self.path == "/v1/packages/job":
            try:
                self.send_json(200, self.server.service.package_job_status())
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
                self.send_json(503, {"error": "host package job status is unavailable"})
            return
        parsed = urlsplit(self.path)
        if parsed.path != "/v1/packages/changelog" or parsed.fragment:
            self.send_json(404, {"error": "not found"})
            return
        try:
            parameters = parse_qs(parsed.query, keep_blank_values=True)
            if set(parameters) != {"name"} or len(parameters["name"]) != 1:
                raise ValueError("choose one package name")
            self.send_json(200, PACKAGES.changelog(parameters["name"][0]))
        except ValueError as error:
            self.send_json(409, {"error": str(error)})
        except (OSError, RuntimeError, SystemError):
            self.send_json(503, {"error": "package changelog is unavailable"})

    def do_POST(self) -> None:
        if self.path.startswith("/v1/portable-capture/") or self.path in {"/v1/portable-restore/prepare", "/v1/portable-restore/approve"}:
            try:
                if not trusted_capture_peer(self.connection):
                    raise ValueError("portable operation peer is unavailable")
                length = self.headers.get("Content-Length", "")
                if self.headers.get("Transfer-Encoding") is not None or not length.isascii() or not length.isdecimal() or not 1 <= int(length) <= 1024 * 1024:
                    raise ValueError("portable request exceeds its bound")
                body = self.rfile.read(int(length))
                if len(body) != int(length):
                    raise ValueError("portable request was truncated")
                request = CONTROLLER_IDENTITY.metadata(body, byte_limit=1024 * 1024)
                service = self.server.service
                match = re.fullmatch(r"/v1/portable-capture/([a-f0-9-]{36})/mounts", self.path)
                if match:
                    result = service.capture_portable_mount_policy(match[1], request)
                else:
                    if self.path not in {"/v1/portable-restore/prepare", "/v1/portable-restore/approve"}:
                        raise ValueError("portable route is invalid")
                    with service.lock, HOST.host_lock(service.root):
                        manager = service.portable_enrollments()
                        result = manager.prepare(request) if self.path.endswith("/prepare") else manager.approve(request, privileged_peer=True)
                self.send_json(200, result)
            except (OSError, ValueError, RuntimeError, TypeError, subprocess.SubprocessError):
                self.send_json(409, {"error": "Portable review requires the protected capsule driver, destination storage review and a fresh critical approval."})
            return
        if self.path.startswith("/v3/controller-capture-authority/"):
            self.close_connection = True
            try:
                self.connection.settimeout(15)
                if not trusted_capture_peer(self.connection):
                    raise ValueError("app runtime authority peer is unavailable")
                match = re.fullmatch(r"/v3/controller-capture-authority/([a-f0-9-]{36})/(prepare|app-runtime|recover|finalize)", self.path)
                length = self.headers.get("Content-Length", "")
                if (not match or self.headers.get("Transfer-Encoding") is not None or not length.isascii() or not length.isdecimal()):
                    raise ValueError("app runtime authority request is invalid")
                point, action = match.groups()
                if action == "finalize":
                    if self.headers.get("Content-Type") != "application/x-tar":
                        raise ValueError("app runtime authority upload is invalid")
                    result = self.server.service.finalize_controller_capture_authority(
                        point, self.headers.get("X-Orbis-Capture-Token"), self.rfile, int(length), proxy_policy=True, app_policy=True)
                else:
                    if self.headers.get("Content-Type") != "application/json" or not 1 <= int(length) <= 4096:
                        raise ValueError("app runtime authority binding is invalid")
                    request = CONTROLLER_IDENTITY.metadata(self.rfile.read(int(length)), byte_limit=4096)
                    if action == "app-runtime":
                        body = self.server.service.controller_app_runtime_bytes(point, request)
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(body)))
                        self.send_header("Cache-Control", "no-store")
                        self.end_headers()
                        self.wfile.write(body)
                        self.wfile.flush()
                        return
                    result = (self.server.service.prepare_controller_app_runtime(point, request) if action == "prepare"
                              else self.server.service.recover_controller_capture_authority(point, request, proxy_policy=True, app_policy=True))
                self.send_json(200, result)
            except (OSError, ValueError, RuntimeError, TypeError, subprocess.SubprocessError):
                self.send_json(409, {"error": "App runtime authority requires protected capture review or recovery."})
            return
        if self.path.startswith("/v2/controller-capture-authority/"):
            self.close_connection = True
            try:
                self.connection.settimeout(15)
                if not trusted_capture_peer(self.connection):
                    raise ValueError("controller capture authority peer is unavailable")
                match = re.fullmatch(r"/v2/controller-capture-authority/([a-f0-9-]{36})/(prepare|recover|finalize)", self.path)
                length = self.headers.get("Content-Length", "")
                if (not match or self.headers.get("Transfer-Encoding") is not None or not length.isascii() or not length.isdecimal()):
                    raise ValueError("controller proxy authority request is invalid")
                point, action = match.groups()
                if action == "finalize":
                    if self.headers.get("Content-Type") != "application/x-tar":
                        raise ValueError("controller proxy authority upload is invalid")
                    result = self.server.service.finalize_controller_capture_authority(
                        point, self.headers.get("X-Orbis-Capture-Token"), self.rfile, int(length), proxy_policy=True)
                else:
                    if self.headers.get("Content-Type") != "application/json" or not 1 <= int(length) <= 4096:
                        raise ValueError("controller proxy authority binding is invalid")
                    request = CONTROLLER_IDENTITY.metadata(self.rfile.read(int(length)), byte_limit=4096)
                    result = (self.server.service.prepare_controller_proxy_identity(point, request) if action == "prepare"
                              else self.server.service.recover_controller_capture_authority(point, request, proxy_policy=True))
                self.send_json(200, result)
            except (OSError, ValueError, RuntimeError, TypeError, subprocess.SubprocessError):
                self.send_json(409, {"error": "Controller proxy authority requires protected layout review or recovery."})
            return
        if self.path.startswith("/v1/retained-restore/"):
            try:
                if not trusted_capture_peer(self.connection):
                    raise ValueError("retained restore peer is unavailable")
                length = self.headers.get("Content-Length", "")
                if (self.headers.get("Content-Type") != "application/json" or self.headers.get("Transfer-Encoding") is not None
                        or not length.isascii() or not length.isdecimal() or not 0 < int(length) <= 8192):
                    raise ValueError("retained restore request body is invalid")
                data = CONTROLLER_IDENTITY.metadata(self.rfile.read(int(length)), byte_limit=8192)
                manager = self.server.service.retained_restores()
                if self.path == "/v1/retained-restore/review":
                    self.send_json(200, self.server.service.review_retained_restore(data))
                elif self.path == "/v1/retained-restore/absence":
                    self.send_json(200, self.server.service.absent_retained_restore(data))
                elif self.path == "/v1/retained-restore/begin":
                    self.send_json(200, self.server.service.begin_retained_restore(data))
                else:
                    match = re.fullmatch(r"/v1/retained-restore/([a-f0-9-]{36})/(phase|phase-complete|phase-status|image-preflight|prepare|activate|recover|status|terminal-proof|terminal-finalize|candidate-resume|candidate-app-result|normal-bootstrap|normal-bootstrap-complete|normal-bootstrap-status)", self.path)
                    if not match:
                        raise ValueError("retained restore route is invalid")
                    identifier, action = match.groups()
                    if action == "phase":
                        self.send_json(200, manager.redeem_phase(identifier, data))
                    elif action == "phase-complete":
                        self.send_json(200, manager.complete_phase(identifier, data))
                    elif action == "image-preflight":
                        self.send_json(200, manager.image_preflight(identifier, data))
                    elif action == "phase-status":
                        self.send_json(200, manager.phase_status(identifier, data))
                    elif action == "terminal-finalize":
                        if set(data) != {"token", "proofSha256"}:
                            raise ValueError("terminal finalization binding is invalid")
                        self.send_json(200, manager.terminal_finalize(identifier, data["token"], data["proofSha256"]))
                    elif action == "normal-bootstrap":
                        if set(data) != {"token", "terminalProofSha256"}:
                            raise ValueError("normal bootstrap proof binding is invalid")
                        self.send_json(200, manager.normal_bootstrap(identifier, data["token"], data["terminalProofSha256"]))
                    elif action == "normal-bootstrap-status":
                        if set(data) != {"token", "terminalProofSha256"}:
                            raise ValueError("normal bootstrap status binding is invalid")
                        self.send_json(200, manager.normal_bootstrap_status(identifier, data["token"], data["terminalProofSha256"]))
                    elif action == "normal-bootstrap-complete":
                        if set(data) != {"token", "terminalProofSha256", "bootstrapLeaseId"}:
                            raise ValueError("normal bootstrap readiness binding is invalid")
                        self.send_json(200, manager.normal_bootstrap_complete(identifier, data["token"], data["terminalProofSha256"], data["bootstrapLeaseId"]))
                    elif set(data) != {"token"}:
                        raise ValueError("retained restore capability is invalid")
                    elif action == "candidate-app-result":
                        self.send_json(200, manager.candidate_app_result(identifier, data["token"]))
                    elif action == "candidate-resume":
                        self.send_json(200, manager.candidate_resume(identifier, data["token"]))
                    elif action == "terminal-proof":
                        self.send_json(200, manager.terminal_proof(identifier, data["token"]))
                    elif action == "status":
                        self.send_json(200, manager.status(identifier, data["token"]))
                    else:
                        result, launch = self.server.service.launch_retained_restore(action, identifier, data["token"])
                        try:
                            self.send_json(202, result)
                        finally:
                            launch()
            except (OSError, ValueError, RuntimeError, TypeError, subprocess.SubprocessError):
                self.send_json(409, {"error": "Retained restore requires a protected review or recovery."})
            return
        if self.path.startswith("/v1/controller-capture-authority/"):
            self.close_connection = True
            try:
                self.connection.settimeout(15)
                if not trusted_capture_peer(self.connection):
                    raise ValueError("controller capture authority peer is unavailable")
                recovery = re.fullmatch(r"/v1/controller-capture-authority/([a-f0-9-]{36})/recover", self.path)
                if recovery:
                    length = self.headers.get("Content-Length", "")
                    if (self.headers.get("Content-Type") != "application/json" or self.headers.get("Transfer-Encoding") is not None
                            or not length.isascii() or not length.isdecimal() or not 1 <= int(length) <= 4096):
                        raise ValueError("controller capture authority recovery is invalid")
                    data = CONTROLLER_IDENTITY.metadata(self.rfile.read(int(length)), byte_limit=4096)
                    result = self.server.service.recover_controller_capture_authority(recovery[1], data)
                else:
                    match = re.fullmatch(r"/v1/controller-capture-authority/([a-f0-9-]{36})/finalize", self.path)
                    length = self.headers.get("Content-Length", "")
                    if (not match or self.headers.get("Content-Type") != "application/x-tar"
                            or self.headers.get("Transfer-Encoding") is not None or not length.isascii() or not length.isdecimal()):
                        raise ValueError("controller capture authority upload is invalid")
                    self.connection.settimeout(15)
                    result = self.server.service.finalize_controller_capture_authority(
                        match[1], self.headers.get("X-Orbis-Capture-Token"), self.rfile, int(length))
                self.send_json(200, result)
            except (OSError, ValueError, RuntimeError, TypeError, subprocess.SubprocessError):
                self.send_json(409, {"error": "Controller capture authority could not be verified."})
            return
        if self.path.startswith("/v1/controller-capture-fence/"):
            try:
                data = self.body(1024)
                action = self.path.removeprefix("/v1/controller-capture-fence/")
                if action == "acquire":
                    result = self.server.service.acquire_capture_fence(data)
                elif action in {"renew", "release", "reconcile"} and set(data) in (
                        {"token"}, {"token", "pointId", "controllerId", "imageId", "configurationSetSha256", "preparationSha256"}):
                    expected = {key: value for key, value in data.items() if key != "token"} if len(data) > 1 else None
                    result = self.server.service.maintain_capture_fence(action, data["token"], expected)
                else:
                    raise ValueError("invalid fence action")
                self.send_json(200, result)
            except (OSError, ValueError, RuntimeError, TypeError, subprocess.SubprocessError):
                self.send_json(409, {"error": "Controller capture fence is unavailable or requires explicit reconciliation."})
            return
        if self.path == "/v1/controller-publication/prepare":
            try:
                def disconnected():
                    if select.select([self.connection], [], [], 0)[0]:
                        return self.connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b""
                    return False
                result = self.server.service.prepare_controller_publication(self.body(1024), disconnected)
                if len(json.dumps(result, separators=(",", ":")).encode()) > CONTROLLER_IDENTITY.PROOF_WIRE_BYTES:
                    raise ValueError("controller publication response exceeds its limit")
                self.send_json(200, result)
            except (OSError, ValueError, RuntimeError, TypeError, subprocess.SubprocessError):
                self.send_json(409, {"error": "Controller publication preparation is unavailable. Verify enrollment and retry before capturing."})
            return
        if self.path == "/v1/controller-config/capture":
            try:
                data = self.body()
                if not {"pointId", "controllerId", "imageId"} <= set(data) <= {"pointId", "controllerId", "imageId", "fenceToken"}:
                    raise ValueError("controller capture fields are invalid")
                result = self.server.service.capture_controller_config(data["pointId"], data["controllerId"], data["imageId"], data.get("fenceToken"))
                self.send_json(200, result)
            except (OSError, ValueError, RuntimeError, TypeError, subprocess.SubprocessError):
                self.send_json(409, {"error": "Controller configuration capture is unavailable. Verify enrollment, file protection and current operations."})
            return
        if self.path in {"/v1/discovery/scan", "/v1/discovery/advertise", "/v1/discovery/disable", "/v1/discovery/policy", "/v1/discovery/configure", "/v1/discovery/configure-address", "/v1/discovery/suspend"}:
            try:
                data = self.body()
                discovery = self.server.service.discovery
                def mutate():
                    if self.path.endswith("/disable"):
                        if data:
                            raise ValueError("Stop nearby visibility without additional fields")
                        result = discovery.set_policy(False)
                    elif self.path.endswith("/suspend"):
                        if data:
                            raise ValueError("Suspend nearby discovery without fields")
                        discovery.disable(stop_scan=False)
                        result = discovery.policy_status()
                    elif self.path.endswith("/configure-address"):
                        if set(data) != {"interface", "port"}:
                            raise ValueError("Provide one private LAN interface and configured port")
                        result = discovery.configure_address(data["interface"], data["port"])
                    elif self.path.endswith("/configure"):
                        if set(data) != {"interface", "origin", "address"}:
                            raise ValueError("Provide one configured private HTTPS endpoint")
                        result = discovery.configure(data["interface"], data["origin"], data["address"])
                    elif self.path.endswith("/policy"):
                        if set(data) not in ({"enabled"}, {"enabled", "configuration"}):
                            raise ValueError("Choose one discovery policy")
                        result = discovery.set_policy(data["enabled"], data.get("configuration"))
                    elif self.path.endswith("/scan"):
                        if set(data) != {"interface"}:
                            raise ValueError("Choose one private LAN interface")
                        result = discovery.scan(data["interface"])
                    else:
                        if set(data) != {"interface", "origin", "address", "leaseSeconds"}:
                            raise ValueError("Confirm one nearby visibility lease")
                        if type(data["leaseSeconds"]) is not int or not 30 <= data["leaseSeconds"] <= 300:
                            raise ValueError("Invalid visibility lease")
                        result = discovery.configure(data["interface"], data["origin"], data["address"])
                    return result
                result = self.server.service.run_capture_mutation(mutate)
                self.send_json(200, result)
            except (ValueError, OSError, RuntimeError, subprocess.SubprocessError):
                self.send_json(200, {"available": False, "reason": "Nearby discovery is unavailable; enter an address manually"})
            return
        if self.path not in {"/v1/channel", "/v1/plan", "/v1/apply", "/v1/recover", "/v1/packages/plan", "/v1/packages/apply", "/v1/packages/refresh", "/v1/restart/plan", "/v1/restart/apply", "/v1/drives/test"}:
            self.send_json(404, {"error": "not found"})
            return
        try:
            data = self.body()
            if self.path == "/v1/drives/test":
                if set(data) != {"id", "kind"}:
                    raise ValueError("Choose one drive and self-test.")
                self.server.service.require_restart_clear()
                self.send_json(202, self.server.service.drives.start_test(data["id"], data["kind"]))
            elif self.path == "/v1/channel":
                if not {"channel", "revision"}.issubset(data) or set(data) - {"channel", "revision", "acknowledgeNightly"} or not isinstance(data["channel"], str) or not isinstance(data["revision"], str) or type(data.get("acknowledgeNightly", False)) is not bool:
                    raise ValueError("confirm one release channel and its displayed revision")
                self.send_json(200, self.server.service.select_channel(data["channel"], data["revision"], data.get("acknowledgeNightly", False)))
            elif self.path == "/v1/plan":
                if not isinstance(data.get("tag"), str) or set(data) - {"tag", "returnToStable"} or type(data.get("returnToStable", False)) is not bool:
                    raise ValueError("request must contain one release tag")
                self.send_json(200, self.server.service.plan(data["tag"], data.get("returnToStable", False)))
            elif self.path == "/v1/apply":
                if set(data) != {"planId"} or not isinstance(data["planId"], str):
                    raise ValueError("request must contain one plan ID")
                result, launch = self.server.service.apply(data["planId"])
                try:
                    self.send_json(202, result)
                finally:
                    launch()
            elif self.path == "/v1/recover":
                if set(data) != {"jobId"} or not isinstance(data["jobId"], str):
                    raise ValueError("request must contain one job ID")
                result, launch = self.server.service.recover(data["jobId"])
                try:
                    self.send_json(202, result)
                finally:
                    launch()
            elif self.path == "/v1/packages/refresh":
                if data:
                    raise ValueError("package list refresh does not accept options")
                self.send_json(202, self.server.service.package_refresh())
            elif self.path == "/v1/packages/plan":
                if set(data) != {"names"} or not isinstance(data["names"], list):
                    raise ValueError("request must contain a package name list")
                self.send_json(200, self.server.service.package_plan(data["names"]))
            elif self.path == "/v1/packages/apply":
                if set(data) != {"planId"} or not isinstance(data["planId"], str):
                    raise ValueError("request must contain one package plan ID")
                self.send_json(202, self.server.service.package_apply(data["planId"]))
            elif self.path == "/v1/restart/plan":
                if data:
                    raise ValueError("restart review does not accept options")
                self.send_json(200, self.server.service.restart_plan())
            else:
                if set(data) != {"planId"} or not isinstance(data["planId"], str):
                    raise ValueError("request must contain one reviewed restart plan ID")
                result, launch = self.server.service.restart_apply(data["planId"])
                try:
                    self.send_json(202, result)
                finally:
                    launch()
        except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
            self.send_json(409, {"error": str(error) if isinstance(error, ValueError) else "host operation could not start"})


def serve(socket_path: Path, service: HostService) -> None:
    parent = socket_path.parent.resolve(strict=True)
    if not parent.is_dir() or stat.S_IMODE(parent.stat().st_mode) & 0o022:
        raise ValueError("host socket parent must not be writable by other users")
    if socket_path.exists() or socket_path.is_symlink():
        existing = socket_path.lstat()
        if not stat.S_ISSOCK(existing.st_mode) or existing.st_uid != os.getuid():
            raise ValueError("host socket path is occupied by another file")
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.settimeout(0.5)
            probe.connect(str(socket_path))
        except ConnectionRefusedError:
            socket_path.unlink()
        else:
            raise ValueError("another Orbis host service is already listening")
        finally:
            probe.close()
    old_umask = os.umask(0o177)
    try:
        server = UnixHTTPServer(str(socket_path), Handler)
    finally:
        os.umask(old_umask)
    server.service = service
    try:
        os.chmod(socket_path, 0o600)
        service.resume_pending_retained_restore()
        try:
            server.serve_forever(poll_interval=0.5)
        except KeyboardInterrupt:
            pass
    finally:
        service.discovery.disable()
        server.server_close()
        socket_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--docker-context", required=True)
    parser.add_argument("--socket", required=True, type=Path)
    parser.add_argument("--snapshots", required=True, type=Path)
    parser.add_argument("--state-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        service = HostService(args.root, args.docker_context, args.snapshots, args.state_dir)
        serve(args.socket, service)
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Orbis host service failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
