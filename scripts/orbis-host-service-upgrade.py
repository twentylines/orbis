#!/usr/bin/env python3
"""Upgrade an installed Orbis Linux host helper with a reversible service stop.

Run this from a reviewed Orbis checkout. It changes only the helper scripts and
systemd unit; it does not update the Orbis core or touch its data tree.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


def load_setup():
    spec = importlib.util.spec_from_file_location("orbis_host_service_setup_for_upgrade", Path(__file__).with_name("orbis-host-service-setup.py"))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SETUP = load_setup()
HOST = SETUP.HOST
SERVICE = SETUP.SERVICE
STATE_DIR = Path("/var/lib/orbis/state")
MAINTENANCE = STATE_DIR / "helper-maintenance.json"
WORKSPACE_PREFIX = ".host-service-upgrade-"
TERMINAL_JOBS = {"complete", "rolled-back", "failed"}
LEGACY_SCRIPTS = {
    "migration-preflight.py",
    "orbis-release-plan.py",
    "orbis-stage-release.py",
    "orbis-host.py",
    "orbis-release-check.py",
    "orbis-snapshot.py",
    "orbis-host-update.py",
    "orbis-host-service.py",
}


def require_root_owned(path: Path, *, directory: bool, private: bool = False) -> None:
    if path.is_symlink() or (not path.is_dir() if directory else not path.is_file()):
        raise ValueError(f"helper path is missing, unexpected, or a symlink: {path}")
    details = path.stat()
    mode = stat.S_IMODE(details.st_mode)
    if details.st_uid != 0 or mode & (0o077 if private else 0o022):
        raise ValueError(f"helper path has unsafe ownership or permissions: {path}")


def exact_environment(root: Path, context: str) -> str:
    return (
        f"ORBIS_SERVICE_SOURCE={SETUP.systemd_quote(str(SETUP.INSTALL_DIR / 'orbis-host-service.py'))}\n"
        f"ORBIS_ROOT={SETUP.systemd_quote(str(root))}\n"
        f"ORBIS_DOCKER_CONTEXT={SETUP.systemd_quote(context)}\n"
    )


def systemctl_output(*arguments: str) -> str:
    result = subprocess.run(["/usr/bin/systemctl", *arguments], capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"systemctl {arguments[0]} failed; inspect the host journal")
    return result.stdout.strip()


def validate_unit(unit: str) -> None:
    lines = unit.splitlines()
    required = (
        "EnvironmentFile=/etc/orbis/host-service.env",
        "RuntimeDirectory=orbis",
        "RuntimeDirectoryPreserve=yes",
    )
    if not all(line in lines for line in required) or not any(
        line.startswith("ExecStart=/usr/bin/python3 ${ORBIS_SERVICE_SOURCE} --root ${ORBIS_ROOT} --docker-context ${ORBIS_DOCKER_CONTEXT} --socket /run/orbis/host.sock")
        for line in lines
    ):
        raise ValueError("helper unit is missing its fixed environment, runtime directory, or command")


def require_installed(root: Path, context: str) -> None:
    for directory in (SETUP.INSTALL_DIR.parent, SETUP.ENV_FILE.parent, STATE_DIR):
        require_root_owned(directory, directory=True, private=True)
    require_root_owned(SETUP.INSTALL_DIR, directory=True, private=True)
    for name in SETUP.SCRIPTS:
        file = SETUP.INSTALL_DIR / name
        if name in LEGACY_SCRIPTS or file.exists() or file.is_symlink():
            require_root_owned(file, directory=False, private=True)
    require_root_owned(SETUP.ENV_FILE, directory=False, private=True)
    require_root_owned(SETUP.UNIT_FILE, directory=False)
    if SETUP.ENV_FILE.read_text(encoding="utf-8") != exact_environment(root, context):
        raise ValueError("installed helper environment does not match the enrolled root and Docker context")
    validate_unit(SETUP.UNIT_FILE.read_text(encoding="utf-8"))
    if systemctl_output("show", "-p", "FragmentPath", "--value", "orbis-host.service") != str(SETUP.UNIT_FILE):
        raise ValueError("systemd is not using the expected Orbis helper unit")
    if systemctl_output("show", "-p", "DropInPaths", "--value", "orbis-host.service"):
        raise ValueError("Orbis helper unit has unreviewed systemd drop-ins")
    if systemctl_output("is-active", "orbis-host.service") != "active":
        raise ValueError("installed Orbis helper must be active before upgrade")


def job_identity() -> tuple[str, str] | None:
    package_job = SERVICE.read_private(STATE_DIR / "package-job.json")
    if package_job and package_job.get("state") in {"queued", "running", "failed", "interrupted"}:
        raise ValueError("resolve the host package transaction before upgrading the helper")
    job = SERVICE.read_private(STATE_DIR / "job.json")
    if not job:
        return None
    identifier, state = job.get("id"), job.get("state")
    if not isinstance(identifier, str) or not isinstance(state, str):
        raise ValueError("host helper job record is invalid")
    if state not in TERMINAL_JOBS:
        raise ValueError("resolve the running or interrupted core update before upgrading the helper")
    return identifier, state


def digest_files(directory: Path) -> str:
    digest = hashlib.sha256()
    for name in SETUP.SCRIPTS:
        if not (directory / name).is_file():
            continue
        digest.update(name.encode("utf-8") + b"\0")
        digest.update((directory / name).read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def preflight(root: Path, context: str, source: Path) -> dict[str, str]:
    if MAINTENANCE.exists() or MAINTENANCE.is_symlink():
        raise ValueError("a helper upgrade needs recovery before another upgrade")
    ready = SETUP.preflight(root, context, source, allow_existing=True)
    require_installed(root, context)
    job_identity()
    source_files, source_unit = SETUP.source_files(source)
    for file in source_files:
        try:
            compile(file.read_text(encoding="utf-8"), str(file), "exec")
        except SyntaxError as error:
            raise ValueError(f"candidate helper script has invalid Python syntax: {file.name}") from error
    validate_unit(source_unit.read_text(encoding="utf-8"))
    return {
        **ready,
        "installedScriptsSha256": digest_files(SETUP.INSTALL_DIR),
        "candidateScriptsSha256": digest_files(source_files[0].parent),
        "installedUnitSha256": hashlib.sha256(SETUP.UNIT_FILE.read_bytes()).hexdigest(),
        "candidateUnitSha256": hashlib.sha256(source_unit.read_bytes()).hexdigest(),
    }


def sync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_copy(source: Path, destination: Path, mode: int) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=f".{destination.name}-", dir=destination.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(source.read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        sync_directory(destination.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def verify_service(digest: str, root: Path, context: str) -> None:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            status = SETUP.read_socket_status()
            inside = HOST.docker(
                context,
                ["exec", "runtipi", "curl", "-fsS", "--unix-socket", str(SETUP.SOCKET_FILE), "http://localhost/v1/status"],
                root,
            )
            mounted = HOST.docker(context, ["exec", "runtipi", "stat", "-c", "%d:%i", "/run/orbis"], root)
            host_mount = SETUP.SOCKET_FILE.parent.stat()
            if (
                status.get("enrolled")
                and status.get("coreHealth") == "healthy"
                and status.get("imageMatches")
                and status.get("currentDigest") == digest
                and inside.returncode == 0
                and json.loads(inside.stdout).get("currentDigest") == digest
                and mounted.returncode == 0
            ):
                SETUP.validate_running_mount(host_mount.st_dev, host_mount.st_ino, mounted.stdout)
                return
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        time.sleep(0.4)
    raise RuntimeError("restarted helper did not pass host, core, and socket mount checks")


def workspace_from_record(record: dict, root: Path, context: str) -> Path:
    if record.get("schema") != "orbis.helper-upgrade.v1" or record.get("root") != str(root) or record.get("dockerContext") != context:
        raise ValueError("helper maintenance record does not match this installation")
    raw = record.get("workspace")
    if not isinstance(raw, str):
        raise ValueError("helper maintenance workspace is missing")
    workspace = Path(raw)
    if workspace.parent != SETUP.INSTALL_DIR.parent or not workspace.name.startswith(WORKSPACE_PREFIX):
        raise ValueError("helper maintenance workspace is outside the expected directory")
    require_root_owned(workspace, directory=True, private=True)
    return workspace


def restore_previous(workspace: Path, digest: str, root: Path, context: str) -> None:
    SETUP.run_systemctl("stop", "orbis-host.service")
    previous = workspace / "previous"
    if previous.exists():
        require_root_owned(previous, directory=True, private=True)
        failed = workspace / "failed"
        if failed.exists():
            shutil.rmtree(failed)
        if SETUP.INSTALL_DIR.exists():
            os.replace(SETUP.INSTALL_DIR, failed)
            sync_directory(SETUP.INSTALL_DIR.parent)
            sync_directory(workspace)
        os.replace(previous, SETUP.INSTALL_DIR)
        sync_directory(workspace)
        sync_directory(SETUP.INSTALL_DIR.parent)
    if not SETUP.INSTALL_DIR.is_dir():
        raise RuntimeError("old helper scripts are missing; preserve the upgrade workspace")
    atomic_copy(workspace / "previous-unit", SETUP.UNIT_FILE, 0o644)
    SETUP.run_systemctl("daemon-reload")
    SETUP.run_systemctl("start", "orbis-host.service")
    verify_service(digest, root, context)


def finish(workspace: Path) -> None:
    MAINTENANCE.unlink(missing_ok=True)
    sync_directory(STATE_DIR)
    shutil.rmtree(workspace)
    sync_directory(workspace.parent)


def upgrade(root: Path, context: str, source: Path, confirmation: str | None) -> dict[str, str]:
    if os.geteuid() != 0:
        raise ValueError("helper upgrade requires root privileges")
    root = root.resolve(strict=True)
    if confirmation != str(root):
        raise ValueError(f"helper upgrade requires --confirm-root {root}")
    with HOST.host_lock(root):
        ready = preflight(root, context, source)
        if (
            ready["installedScriptsSha256"] == ready["candidateScriptsSha256"]
            and ready["installedUnitSha256"] == ready["candidateUnitSha256"]
        ):
            return {**ready, "service": "active", "socket": str(SETUP.SOCKET_FILE), "upgraded": False}
        previous_job = job_identity()
        workspace = Path(tempfile.mkdtemp(prefix=WORKSPACE_PREFIX, dir=SETUP.INSTALL_DIR.parent))
        os.chmod(workspace, 0o700)
        new = workspace / "new"
        new.mkdir(mode=0o700)
        sync_directory(SETUP.INSTALL_DIR.parent)
        sync_directory(workspace)
        files, unit = SETUP.source_files(source)
        try:
            for file in files:
                atomic_copy(file, new / file.name, 0o600)
            atomic_copy(SETUP.UNIT_FILE, workspace / "previous-unit", 0o600)
            atomic_copy(unit, workspace / "candidate.service", 0o600)
            checked = subprocess.run(["/usr/bin/systemd-analyze", "verify", str(workspace / "candidate.service")], capture_output=True, check=False)
            if checked.returncode:
                raise ValueError("systemd rejected the candidate Orbis helper unit")
            record = {
                "schema": "orbis.helper-upgrade.v1",
                "root": str(root),
                "dockerContext": context,
                "workspace": str(workspace),
                "previousDigest": ready["digest"],
                "stage": "prepared",
            }
            SERVICE.write_private(MAINTENANCE, record)
            SETUP.run_systemctl("stop", "orbis-host.service")
            if job_identity() != previous_job:
                raise ValueError("a core update was accepted while stopping the old helper; retry after resolving it")
            record["stage"] = "stopped"
            SERVICE.write_private(MAINTENANCE, record)
            os.replace(SETUP.INSTALL_DIR, workspace / "previous")
            sync_directory(SETUP.INSTALL_DIR.parent)
            sync_directory(workspace)
            os.replace(new, SETUP.INSTALL_DIR)
            sync_directory(workspace)
            sync_directory(SETUP.INSTALL_DIR.parent)
            atomic_copy(workspace / "candidate.service", SETUP.UNIT_FILE, 0o644)
            record["stage"] = "replaced"
            SERVICE.write_private(MAINTENANCE, record)
            SETUP.run_systemctl("daemon-reload")
            SETUP.run_systemctl("start", "orbis-host.service")
            verify_service(ready["digest"], root, context)
            record["stage"] = "verified"
            SERVICE.write_private(MAINTENANCE, record)
        except Exception as error:
            if MAINTENANCE.exists():
                try:
                    restore_previous(workspace, ready["digest"], root, context)
                except Exception as rollback_error:
                    raise RuntimeError("helper upgrade and rollback failed; preserve the maintenance record and workspace") from rollback_error
            finish(workspace)
            raise RuntimeError("helper upgrade failed; the previous helper was restored") from error
    finish(workspace)
    return {**ready, "service": "active", "socket": str(SETUP.SOCKET_FILE), "upgraded": True}


def recover(root: Path, context: str, confirmation: str | None) -> dict[str, str]:
    if os.geteuid() != 0:
        raise ValueError("helper recovery requires root privileges")
    root = root.resolve(strict=True)
    if confirmation != str(root):
        raise ValueError(f"helper recovery requires --confirm-root {root}")
    with HOST.host_lock(root):
        record = SERVICE.read_private(MAINTENANCE)
        if not record:
            raise ValueError("there is no interrupted helper upgrade")
        workspace = workspace_from_record(record, root, context)
        digest = record.get("previousDigest")
        if not isinstance(digest, str) or not SETUP.PLAN.DIGEST.fullmatch(digest):
            raise ValueError("helper maintenance record has an invalid release digest")
        job_identity()
        if record.get("stage") == "verified":
            try:
                verify_service(digest, root, context)
            except RuntimeError:
                restore_previous(workspace, digest, root, context)
        else:
            restore_previous(workspace, digest, root, context)
    finish(workspace)
    return {"root": str(root), "dockerContext": context, "service": "active", "recovered": True}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "upgrade", "recover"))
    parser.add_argument("root", type=Path)
    parser.add_argument("--docker-context", required=True)
    parser.add_argument("--source-dir", type=Path, default=Path(__file__).parent)
    parser.add_argument("--confirm-root")
    args = parser.parse_args()
    try:
        root = args.root.expanduser().resolve(strict=True)
        source = args.source_dir.expanduser().resolve(strict=True)
        result = (
            preflight(root, args.docker_context, source)
            if args.action == "plan"
            else upgrade(root, args.docker_context, source, args.confirm_root)
            if args.action == "upgrade"
            else recover(root, args.docker_context, args.confirm_root)
        )
        print(json.dumps(result, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"Orbis host service upgrade failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
