#!/usr/bin/env python3
"""Attach and enable the restricted host service without changing app storage."""

import hashlib
import importlib.util
import json
import os
import shlex
import stat
import re
import sys
import time
import tempfile
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("orbis_enable_setup", Path(__file__).with_name("orbis-host-service-setup.py"))
SETUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SETUP)
HOST = SETUP.HOST
SPEC = importlib.util.spec_from_file_location("orbis_enable_apps", Path(__file__).with_name("orbis-install-apps.py"))
APPS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(APPS)
SCHEMA = "orbis.host-enable.v2"
STATE_DIR = Path("/var/lib/orbis/state")
STAGES = {"prepared", "service-starting", "attaching", "mount-prepared", "restarting-controller", "verifying", "complete"}


def read_record(path):
    parent = path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or stat.S_IMODE(parent.st_mode) & 0o077:
        raise ValueError("The host setup journal directory must be private and root-owned")
    details = path.lstat()
    if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_uid != os.geteuid() or stat.S_IMODE(details.st_mode) & 0o077 or details.st_size > 1024 * 1024:
        raise ValueError("The host setup journal must be a private regular file")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError("The host setup journal is invalid")
    return value


def content():
    return json.dumps({"services": {"runtipi": {"environment": {"ORBIS_HOST_SOCKET": str(SETUP.SOCKET_FILE)}, "volumes": [{"type": "bind", "source": str(SETUP.SOCKET_FILE.parent), "target": "/run/orbis", "read_only": True, "bind": {"create_host_path": True}}]}}}, indent=2) + "\n"


def journal_path(root, context):
    identity = hashlib.sha256((str(root) + "\0" + context).encode()).hexdigest()[:20]
    return SETUP.ENV_FILE.parent / ("enable-" + identity + ".json")


def source_hashes(source):
    files, unit = SETUP.source_files(source)
    files = [*files, source / "orbis-host-service-setup.py", source / "orbis-host-service-enable.py"]
    if any(file.is_symlink() or not file.is_file() for file in files):
        raise ValueError("Host setup sources must be regular files")
    return {str(file.relative_to(source.parent)): hashlib.sha256(file.read_bytes()).hexdigest() for file in [*files, unit]}


def existing_owner(root, context):
    if not SETUP.ENV_FILE.exists() or SETUP.ENV_FILE.is_symlink():
        return False
    values = {}
    for line in SETUP.ENV_FILE.read_text().splitlines():
        key, separator, raw = line.partition("=")
        if separator:
            parsed = shlex.split(raw)
            if len(parsed) != 1:
                return False
            values[key] = parsed[0]
    return values.get("ORBIS_ROOT") == str(root) and values.get("ORBIS_DOCKER_CONTEXT") == context


def available(root, context="default"):
    if root == SETUP.INSTALL_DIR or root in SETUP.INSTALL_DIR.parents or SETUP.INSTALL_DIR in root.parents:
        raise ValueError("The server directory must be separate from /opt/orbis/host-service")
    targets = [SETUP.INSTALL_DIR, SETUP.ENV_FILE, SETUP.UNIT_FILE]
    if any(path.exists() or path.is_symlink() for path in targets):
        if not journal_path(root, context).exists() and not (all(path.exists() and not path.is_symlink() for path in targets) and existing_owner(root, context)):
            raise ValueError("Another or incomplete host service occupies this host; its files were preserved")
    if not Path("/run/systemd/system").is_dir():
        raise ValueError("Host administration requires Linux systemd")
    return all(path.exists() for path in targets) and existing_owner(root, context)


def healthy_existing(root, context, source):
    try:
        SETUP.preflight(root, context, source, allow_existing=True)
        status = SETUP.read_socket_status()
        return bool(status.get("enrolled") and status.get("coreHealth") == "healthy" and status.get("imageMatches"))
    except (OSError, ValueError, RuntimeError):
        return False


def require_scoped_cleanup(root, context, image):
    result = HOST.docker(context, ["image", "inspect", "--format", "{{json .Config.Labels}}", image], root if root.is_dir() else Path(__file__).parent)
    try:
        labels = json.loads(result.stdout) if result.returncode == 0 else None
    except (ValueError, TypeError):
        labels = None
    if not isinstance(labels, dict) or labels.get("io.orbis.network-prune-scope") != "orbis.managed":
        raise ValueError("Use an Orbis image with external-network protection before restarting the controller through this installer")


def _require_no_operation(root):
    if HOST.retained_state(root):
        raise ValueError("retained host socket configuration changes require a new independent root review")
    selectors = [HOST.restore_selector_path(root), HOST.capture_fence_path(root)]
    # Starting the daemon must never authorize its automatic retained recovery path.
    selectors.extend(HOST.AUTHORITY.LAYOUT.legacy_path(root, purpose) for purpose in ("restore-selector", "capture-fence", "retained-authority"))
    selectors.extend(STATE_DIR / name for name in ("job.json", "package-job.json", "restart-job.json", "helper-maintenance.json"))
    if any(path.exists() or path.is_symlink() for path in selectors):
        raise ValueError("an existing or pending host operation requires independent recovery before host setup")


def _require_controller(root, context, manifest, *, recovering=False):
    if SETUP.SERVICE.installed_manifest(root, context) != manifest:
        raise ValueError("the enrolled manifest changed during host setup")
    core = HOST.current_core(root, context)
    if (core.get("image") != f"{manifest['image']}@{manifest['digest']}"
            or (not recovering and (core.get("state") != "running" or core.get("health") != "healthy"))
            or (recovering and core.get("state") not in {"running", "restarting", "exited", "created"})):
        raise ValueError("the enrolled Orbis core must be healthy at its published image")


def _require_host(root, context, source):
    if os.geteuid() != 0 or sys.platform != "linux" or not Path("/run/systemd/system").is_dir():
        raise ValueError("host setup requires root on a running Linux systemd host")
    if root.is_symlink() or not root.is_dir() or root.resolve(strict=True) != root:
        raise ValueError("installation root must be a real resolved directory")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", context):
        raise ValueError("Docker context name is invalid")
    SETUP.source_files(source)
    for executable in ("/usr/bin/python3", "/usr/bin/systemctl", "/usr/bin/systemd-run", "/usr/bin/systemd-analyze", "/usr/bin/install"):
        if not Path(executable).is_file():
            raise ValueError(f"required host command is unavailable: {executable}")


def _require_listener(root, context, manifest, *, recovering=False):
    deadline = time.monotonic() + 12
    while True:
        try:
            _require_no_operation(root)
            status = SETUP.authenticated_socket_status(root, context)
            if (status.get("enrolled") is True and (recovering or status.get("coreHealth") == "healthy")
                    and status.get("imageMatches") is True and status.get("currentDigest") == manifest["digest"]
                    and status.get("job") is None):
                return
        except (OSError, ValueError):
            if time.monotonic() >= deadline:
                raise RuntimeError("the expected root helper listener could not be authenticated")
        if time.monotonic() >= deadline:
            raise RuntimeError("the root helper did not report the enrolled healthy image without an operation")
        time.sleep(0.4)


def _write_override(root, override):
    descriptor, name = tempfile.mkstemp(prefix=".orbis-host-compose-", dir=root)
    temporary = Path(name)
    with os.fdopen(descriptor, "w") as file:
        file.write(content())
        file.flush()
        os.fsync(file.fileno())
    if override.exists() or override.is_symlink():
        temporary.unlink()
        raise ValueError("The host socket override appeared during setup; preserve it for review")
    os.replace(temporary, override)
    descriptor = os.open(root, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def enable(root, context, source):
    _require_host(root, context, source)
    available(root, context)
    with HOST.host_lock(root):
        path = journal_path(root, context)
        override = root / "orbis-host-compose.yml"
        # Reusing an already healthy older helper does not replay a bootstrap or
        # impose the new installer's sources/unit contract on that installation.
        if existing_owner(root, context) and healthy_existing(root, context, source):
            existing = read_record(path) if path.exists() or path.is_symlink() else None
            if existing is not None and (existing.get("root") != str(root) or existing.get("dockerContext") != context):
                raise ValueError("The host setup journal belongs to another installation")
            if existing is None or existing.get("schema") != SCHEMA or existing.get("stage") == "complete":
                return {"result": "host-service-active", "socket": str(SETUP.SOCKET_FILE)}
        hashes = source_hashes(source)
        record = None
        if path.exists() or path.is_symlink():
            record = read_record(path)
            if (record.get("schema") != SCHEMA or record.get("root") != str(root) or record.get("dockerContext") != context
                    or record.get("sources") != hashes or record.get("stage") not in STAGES):
                raise ValueError("Resume host setup using its original verified installer sources; incompatible journals require independent review")
        _require_no_operation(root)
        if record is None:
            manifest = SETUP.SERVICE.installed_manifest(root, context)
            require_scoped_cleanup(root, context, f"{manifest['image']}@{manifest['digest']}")
            before = HOST.installation_fingerprint(root, manifest, context)
            HOST.require_current_state(root, before)
            _require_controller(root, context, manifest)
            if override.exists() or override.is_symlink():
                raise ValueError("Review the existing host service override before enabling it")
            if any(target.exists() or target.is_symlink() for target in (SETUP.INSTALL_DIR, SETUP.ENV_FILE, SETUP.UNIT_FILE)):
                raise ValueError("An existing host service must be repaired or upgraded separately")
            after = {**before, "files": {**before["files"], "orbis-host-compose.yml": hashlib.sha256(content().encode()).hexdigest()}}
            record = {"schema": SCHEMA, "root": str(root), "dockerContext": context, "manifest": manifest,
                      "before": before, "after": after, "sources": hashes, "stage": "prepared"}
            SETUP.ENV_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            details = SETUP.ENV_FILE.parent.lstat()
            if not stat.S_ISDIR(details.st_mode) or details.st_uid != 0 or stat.S_IMODE(details.st_mode) & 0o077:
                raise ValueError("Host service configuration directory must be private and root-owned")
            APPS.write_journal(path, record)
        elif record["stage"] == "complete":
            raise ValueError("The installed host service needs diagnosis; a completed setup cannot be replayed")
        recovering = record["stage"] in {"restarting-controller", "verifying"}
        manifest, before = record["manifest"], record["before"]
        after = {**before, "files": {**before["files"], "orbis-host-compose.yml": hashlib.sha256(content().encode()).hexdigest()}}
        if record.get("after") != after or "orbis-host-compose.yml" in before["files"]:
            raise ValueError("The host setup fingerprint transition is invalid")
        for name, expected in before["files"].items():
            if HOST.file_digest(root / name) != expected:
                raise ValueError("Installation configuration changed during host setup; preserve its journal")
        attached = override.exists() or override.is_symlink()
        if attached and (override.is_symlink() or not override.is_file() or override.read_text() != content()):
            raise ValueError("The host socket override changed during setup")
        saved = HOST.saved_state(root)
        if record["stage"] in {"prepared", "service-starting"}:
            if attached or saved != before:
                raise ValueError("The original enrollment changed before helper startup")
        elif ((not attached and record["stage"] != "attaching") or saved not in (before, after)
                or (saved == after and not attached) or (saved == before and record["stage"] != "attaching")):
            raise ValueError("The journal-bound host setup enrollment changed")
        if record["stage"] not in {"prepared", "service-starting"}:
            if not attached:
                _write_override(root, override)
            if HOST.installation_fingerprint(root, manifest, context) != after:
                raise ValueError("The generated host setup fingerprint changed")
            if saved == before:
                HOST.write_state(root, after)
        _require_controller(root, context, manifest, recovering=recovering)
        socket_dir = SETUP.SOCKET_FILE.parent
        socket_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        details = socket_dir.lstat()
        if not stat.S_ISDIR(details.st_mode) or details.st_uid != 0 or stat.S_IMODE(details.st_mode) != 0o700:
            raise ValueError("Host socket directory must be private and root-owned")
        original = record["stage"] in {"prepared", "service-starting"}
        verify_only = record["stage"] == "verifying" and HOST.current_core(root, context).get("health") == "healthy"
        if original:
            record["stage"] = "service-starting"
            APPS.write_journal(path, record)
        SETUP._stage_service_files(root, context, source, resume=True)
        _require_no_operation(root)
        SETUP._start_service()
        _require_listener(root, context, manifest, recovering=recovering)
        if verify_only:
            return _finish_enable(root, context, source, manifest, path, record)
        if original:
            record["stage"] = "attaching"
            APPS.write_journal(path, record)
            _write_override(root, override)
            if HOST.installation_fingerprint(root, manifest, context) != after:
                raise ValueError("The generated host setup fingerprint changed")
            HOST.require_current_state(root, before)
            HOST.write_state(root, after)
        if not recovering:
            record["stage"] = "mount-prepared"
            APPS.write_journal(path, record)
        # Reauthenticate against the transitioned enrollment before any recreation.
        _require_listener(root, context, manifest, recovering=recovering)
        _require_controller(root, context, manifest, recovering=recovering)
        HOST.require_current_state(root, after)
        if HOST.installation_fingerprint(root, manifest, context) != after or source_hashes(source) != hashes:
            raise ValueError("Host setup sources or configuration changed before restart")
        record["stage"] = "restarting-controller"
        APPS.write_journal(path, record)
        arguments = HOST.compose_args(root) + ["up", "--detach", "--no-deps", "--force-recreate", "--pull", "never", "--no-build", "--wait", "--wait-timeout", "180", "runtipi"]
        result = HOST.docker(context, arguments, root)
        if result.returncode:
            raise RuntimeError(f"The controller could not restart with its host socket. Preserve {path} and rerun the same installer to continue")
        record["stage"] = "verifying"
        APPS.write_journal(path, record)
        return _finish_enable(root, context, source, manifest, path, record)


def _finish_enable(root, context, source, manifest, path, record):
    _require_controller(root, context, manifest)
    ready = SETUP.preflight(root, context, source, allow_existing=True)
    _require_listener(root, context, manifest)
    ready = SETUP._verify_service(root, context, ready)
    record["stage"] = "complete"
    APPS.write_journal(path, record)
    return {"result": "host-service-active", "socket": ready["socket"]}
