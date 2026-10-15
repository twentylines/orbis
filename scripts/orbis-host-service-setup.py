#!/usr/bin/env python3
"""Install the restricted Orbis host service on an already enrolled Linux host.

This does not adopt stock Runtipi or edit Compose. The socket mount must already
be in the enrolled, healthy core configuration.
"""

import argparse
import importlib.util
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def load_script(name: str, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, Path(__file__).with_name(name))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SERVICE = load_script("orbis-host-service.py", "orbis_host_service_for_setup")
HOST = SERVICE.HOST
PLAN = SERVICE.PLAN
SCRIPTS = (
    "migration-preflight.py",
    "orbis-release-plan.py",
    "orbis-stage-release.py",
    "orbis-host.py",
    "orbis-release-check.py",
    "orbis-snapshot.py",
    "orbis-host-update.py",
    "orbis-host-service.py",
    "orbis-host-packages.py",
)
INSTALL_DIR = Path("/opt/orbis/host-service")
ENV_FILE = Path("/etc/orbis/host-service.env")
UNIT_FILE = Path("/etc/systemd/system/orbis-host.service")
SOCKET_FILE = Path("/run/orbis/host.sock")


def systemd_quote(value: str) -> str:
    if any(character in value for character in "\r\n\0"):
        raise ValueError("systemd environment value contains a control character")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def source_files(source: Path) -> tuple[list[Path], Path]:
    if source.is_symlink() or not source.is_dir():
        raise ValueError("source scripts directory must be a real directory")
    files = [source / name for name in SCRIPTS]
    unit = source.parent / "packaging" / "systemd" / "orbis-host.service"
    for file in [*files, unit]:
        if file.is_symlink() or not file.is_file():
            raise ValueError(f"required source file is missing or is a symlink: {file.name}")
    return files, unit


def validate_socket_mount(config: dict) -> None:
    services = config.get("services")
    if not isinstance(services, dict) or not isinstance(services.get("runtipi"), dict):
        raise ValueError("merged Compose config has no Orbis core")
    core = services["runtipi"]
    environment = core.get("environment")
    if not isinstance(environment, dict) or environment.get("ORBIS_HOST_SOCKET") != str(SOCKET_FILE):
        raise ValueError("the Orbis core is missing its host socket environment setting")
    volumes = core.get("volumes")
    if not isinstance(volumes, list):
        raise ValueError("the Orbis core is missing its host socket mount")
    matches = [volume for volume in volumes if isinstance(volume, dict) and volume.get("target") == "/run/orbis"]
    if len(matches) != 1 or matches[0].get("type") != "bind" or matches[0].get("source") != "/run/orbis" or matches[0].get("read_only") is not True:
        raise ValueError("the host socket must be a read-only /run/orbis mount on the Orbis core")
    for name, service in services.items():
        if name == "runtipi" or not isinstance(service, dict):
            continue
        if any(isinstance(volume, dict) and volume.get("source") == "/run/orbis" for volume in (service.get("volumes") or [])):
            raise ValueError("the host socket must not be mounted into another service")


def validate_running_mount(device: int, inode: int, container_stat: str) -> None:
    if container_stat.strip() != f"{device}:{inode}":
        raise ValueError("the running Orbis core has a stale host socket mount; recreate only that core after reviewing Compose")


def preflight(root: Path, context: str, source: Path, *, allow_existing: bool = False) -> dict[str, str]:
    if sys.platform != "linux" or not Path("/run/systemd/system").is_dir():
        raise ValueError("this setup requires a running Linux systemd host")
    if root.is_symlink() or not root.is_dir():
        raise ValueError("installation root must be a real directory")
    root = root.resolve(strict=True)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", context):
        raise ValueError("Docker context name is invalid")
    source_files(source)
    for executable in ("/usr/bin/python3", "/usr/bin/systemctl", "/usr/bin/systemd-analyze", "/usr/bin/install"):
        if not Path(executable).is_file():
            raise ValueError(f"required host command is unavailable: {executable}")
    saved = HOST.saved_state(root)
    if not saved or saved.get("root") != str(root) or saved.get("dockerContext") != context or not isinstance(saved.get("tag"), str):
        raise ValueError("this installation is not enrolled on the selected Docker context")
    manifest = SERVICE.manifest_for_tag(saved["tag"])
    if HOST.installation_fingerprint(root, manifest, context) != saved:
        raise ValueError("Orbis enrollment no longer matches the installation files")
    core = HOST.current_core(root, context)
    if core.get("state") != "running" or core.get("health") != "healthy" or core.get("image") != f"{PLAN.IMAGE}@{manifest['digest']}":
        raise ValueError("the enrolled Orbis core must be healthy at its published image")
    merged = HOST.docker(context, HOST.compose_args(root) + ["config", "--format", "json"], root)
    if merged.returncode:
        raise RuntimeError("Docker Compose could not validate the host socket mount")
    try:
        validate_socket_mount(json.loads(merged.stdout))
    except json.JSONDecodeError as error:
        raise RuntimeError("Docker Compose returned invalid configuration JSON") from error
    socket_dir = SOCKET_FILE.parent
    if socket_dir.is_symlink() or not socket_dir.is_dir():
        raise ValueError("create the private /run/orbis directory before starting the Orbis core")
    host_socket_dir = socket_dir.stat()
    mounted = HOST.docker(context, ["exec", "runtipi", "stat", "-c", "%d:%i", "/run/orbis"], root)
    if mounted.returncode:
        raise ValueError("the running Orbis core has no readable host socket mount")
    validate_running_mount(host_socket_dir.st_dev, host_socket_dir.st_ino, mounted.stdout)
    if not allow_existing:
        for target in (INSTALL_DIR, ENV_FILE, UNIT_FILE):
            if target.exists() or target.is_symlink():
                raise ValueError(f"a host service installation already occupies {target}")
    return {"root": str(root), "dockerContext": context, "releaseTag": manifest["tag"], "digest": manifest["digest"]}


def run_systemctl(*arguments: str) -> None:
    result = subprocess.run(["/usr/bin/systemctl", *arguments], capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(f"systemctl {arguments[0]} failed; inspect the host journal")


def read_socket_status() -> dict:
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        connection.settimeout(3)
        connection.connect(str(SOCKET_FILE))
        connection.sendall(b"GET /v1/status HTTP/1.0\r\nHost: localhost\r\n\r\n")
        parts = []
        while True:
            part = connection.recv(8192)
            if not part:
                break
            parts.append(part)
            if sum(map(len, parts)) > 64 * 1024:
                raise ValueError("host service status response was too large")
        header, body = b"".join(parts).split(b"\r\n\r\n", 1)
        if not header.startswith(b"HTTP/1.0 200 "):
            raise ValueError("host service status was not healthy")
        return json.loads(body)
    finally:
        connection.close()


def install(root: Path, context: str, source: Path, confirmation: str | None) -> dict[str, str]:
    if os.geteuid() != 0:
        raise ValueError("installation requires root privileges")
    root = root.resolve(strict=True)
    if confirmation != str(root):
        raise ValueError(f"installation requires --confirm-root {root}")
    with HOST.host_lock(root):
        return install_locked(root, context, source)


def install_locked(root: Path, context: str, source: Path) -> dict[str, str]:
    ready = preflight(root, context, source)
    files, unit = source_files(source)
    for directory in (INSTALL_DIR.parent, ENV_FILE.parent):
        if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            raise ValueError(f"setup directory is unsafe: {directory}")
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        details = directory.stat()
        if details.st_uid != 0 or stat.S_IMODE(details.st_mode) & 0o022:
            raise ValueError(f"setup directory must be root-owned and not writable by other users: {directory}")
    staged = Path(tempfile.mkdtemp(prefix=".host-service-", dir=INSTALL_DIR.parent))
    created = []
    try:
        os.chmod(staged, 0o700)
        for file in files:
            shutil.copyfile(file, staged / file.name)
            os.chmod(staged / file.name, 0o600)
        os.replace(staged, INSTALL_DIR)
        created.append(INSTALL_DIR)
        environment = (
            f"ORBIS_SERVICE_SOURCE={systemd_quote(str(INSTALL_DIR / 'orbis-host-service.py'))}\n"
            f"ORBIS_ROOT={systemd_quote(str(root))}\n"
            f"ORBIS_DOCKER_CONTEXT={systemd_quote(context)}\n"
        )
        descriptor, temporary = tempfile.mkstemp(prefix=".host-service-env-", dir=ENV_FILE.parent)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(environment)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, ENV_FILE)
        created.append(ENV_FILE)
        shutil.copyfile(unit, UNIT_FILE)
        os.chmod(UNIT_FILE, 0o644)
        created.append(UNIT_FILE)
        result = subprocess.run(["/usr/bin/systemd-analyze", "verify", str(UNIT_FILE)], capture_output=True, check=False)
        if result.returncode:
            raise RuntimeError("systemd rejected the Orbis host service unit")
        run_systemctl("daemon-reload")
        run_systemctl("enable", "--now", "orbis-host.service")
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            try:
                status = read_socket_status()
                inside = HOST.docker(
                    context,
                    ["exec", "runtipi", "curl", "-fsS", "--unix-socket", str(SOCKET_FILE), "http://localhost/v1/status"],
                    root,
                )
                if (
                    status.get("enrolled")
                    and status.get("coreHealth") == "healthy"
                    and status.get("imageMatches")
                    and status.get("currentDigest") == ready["digest"]
                    and inside.returncode == 0
                    and json.loads(inside.stdout).get("currentDigest") == ready["digest"]
                ):
                    return {**ready, "service": "active", "socket": str(SOCKET_FILE)}
            except (OSError, ValueError, json.JSONDecodeError):
                pass
            time.sleep(0.4)
        raise RuntimeError("host service did not report the enrolled healthy core")
    except Exception:
        subprocess.run(["/usr/bin/systemctl", "disable", "--now", "orbis-host.service"], capture_output=True, check=False)
        for target in reversed(created):
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink(missing_ok=True)
        shutil.rmtree(staged, ignore_errors=True)
        subprocess.run(["/usr/bin/systemctl", "daemon-reload"], capture_output=True, check=False)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "install"))
    parser.add_argument("root", type=Path)
    parser.add_argument("--docker-context", required=True)
    parser.add_argument("--source-dir", type=Path, default=Path(__file__).parent)
    parser.add_argument("--confirm-root")
    args = parser.parse_args()
    try:
        root = args.root.expanduser().resolve(strict=True)
        source = args.source_dir.expanduser().resolve(strict=True)
        result = preflight(root, args.docker_context, source) if args.action == "plan" else install(root, args.docker_context, source, args.confirm_root)
        print(json.dumps(result, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"Orbis host service setup failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
