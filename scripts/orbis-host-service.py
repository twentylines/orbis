#!/usr/bin/env python3
"""Expose bounded host readings, reviewed updates, and explicit restarts over a Unix socket.

Run this service outside the Orbis container. Socket file permissions are the
transport boundary; the web API must separately authenticate its user.
"""

import argparse
import http.server
import importlib.util
import json
import os
import re
import socket
import socketserver
import stat
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
HOST = UPDATE.HOST
PLAN = HOST.PLAN
CHECK = UPDATE.CHECK
POLICY = PLAN.POLICY
PLAN_TTL_SECONDS = 15 * 60
BODY_LIMIT = 64 * 1024
PACKAGE_OUTPUT_BYTES = 8192
RESTART_PLAN_TTL_SECONDS = 120


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
        self.lock = threading.Lock()
        self.busy = False
        self.job_file = self.state_dir / "job.json"
        self.package_job_file = self.state_dir / "package-job.json"
        self.restart_job_file = self.state_dir / "restart-job.json"
        self.maintenance_file = self.state_dir / "helper-maintenance.json"
        self.drives = DRIVES.DriveHealth(self.state_dir)
        previous = read_private(self.job_file)
        if previous and previous.get("state") in {"running", "recovering"}:
            previous["state"] = "interrupted"
            write_private(self.job_file, previous)

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

    def require_restart_clear(self) -> None:
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
        return enrollment_matches(self.root, self.context, saved)

    def current_manifest(self) -> dict[str, str]:
        return installed_manifest(self.root, self.context)

    def status(self) -> dict:
        saved = HOST.saved_state(self.root)
        enrolled = self.state_matches(saved)
        core = HOST.current_core(self.root, self.context)
        job = read_private(self.job_file)
        phase = None
        if job and job.get("state") == "running":
            journal = read_private(UPDATE.journal_path(Path(job["snapshot"]))) if isinstance(job.get("snapshot"), str) else None
            phase = journal.get("stage") if journal else "preparing"
            if phase not in UPDATE.FAILURE_STAGES | UPDATE.TERMINAL_STAGES:
                phase = "preparing"
        if job and job.get("state") == "interrupted":
            journal = read_private(UPDATE.journal_path(Path(job["snapshot"])))
            stage = journal.get("stage") if journal else None
            expected_digest = job["target"]["digest"] if stage == "complete" else job["current"]["digest"]
            healthy_expected = (
                enrolled
                and saved
                and saved.get("digest") == expected_digest
                and core.get("image") == f"{PLAN.IMAGE}@{expected_digest}"
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
                            "available": True, "capabilities": ["restart.v1", "packages.refresh.v1", "release-channels.v1"],
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
            "capabilities": ["restart.v1", "packages.refresh.v1", "release-channels.v1"],
            "enrolled": enrolled,
            "currentTag": saved.get("tag") if saved else None,
            "currentDigest": saved.get("digest") if saved else None,
            "coreState": core.get("state"),
            "coreHealth": core.get("health"),
            "imageMatches": bool(enrolled and saved and core.get("image") == f"{PLAN.IMAGE}@{saved.get('digest')}"),
            "job": {key: job.get(key) for key in ("id", "state", "targetTag", "startedAt", "finishedAt", "message")} | {"phase": phase} | UPDATE.safe_failure(job)
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
            plan = self._read_plan(plan_id)
            current = PLAN.validate_manifest(plan["current"])
            target = PLAN.validate_manifest(plan["target"])
            if self.current_manifest() != current:
                raise ValueError("installed release changed since the update plan")
            if plan.get("channelState") != read_channel(self.root):
                raise ValueError("the release channel changed since the update plan")
            self.validate_channel_plan(plan["channelState"], current, target, plan.get("returnToStable", False))
            snapshot = Path(plan["snapshot"])
            if snapshot.parent != self.snapshots or snapshot.name != f"orbis-{target['tag']}-{plan_id}":
                raise ValueError("update plan has an invalid snapshot destination")
            job = {
                "schema": "orbis.host-service-job.v1",
                "id": plan_id,
                "state": "running",
                "targetTag": target["tag"],
                "startedAt": time.time(),
                "snapshot": str(snapshot),
                "current": current,
                "target": target,
                "channelState": plan["channelState"],
                "returnToStable": plan.get("returnToStable", False),
            }
            write_private(self.job_file, job)
            self.busy = True

        def run() -> None:
            try:
                UPDATE.apply_update(self.root, current, target, self.context, snapshot)
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
            job["state"] = "recovering"
            write_private(self.job_file, job)
            self.busy = True

        def run() -> None:
            try:
                UPDATE.recover(self.root, current, target, self.context, snapshot)
                job["state"] = "rolled-back"
                journal = read_private(UPDATE.journal_path(snapshot))
                job.update(UPDATE.safe_failure(journal))
                job["message"] = f"{UPDATE.failure_message(journal)} Previous Orbis release is healthy.".strip()
            except Exception:
                job["state"] = "interrupted"
                job["message"] = "Recovery needs local inspection."
            finally:
                job["finishedAt"] = time.time()
                try:
                    write_private(self.job_file, job)
                finally:
                    with self.lock:
                        self.busy = False

        return {"jobId": job_id, "state": "recovering"}, lambda: threading.Thread(target=run, daemon=True).start()


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


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

    def body(self) -> dict:
        length = self.headers.get("Content-Length", "")
        if not length.isascii() or not length.isdecimal() or not 0 < int(length) <= BODY_LIMIT:
            raise ValueError("request body length is invalid")
        data = json.loads(self.rfile.read(int(length)))
        if not isinstance(data, dict):
            raise ValueError("request body must be an object")
        return data

    def do_GET(self) -> None:
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
        try:
            server.serve_forever(poll_interval=0.5)
        except KeyboardInterrupt:
            pass
    finally:
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
