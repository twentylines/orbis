#!/usr/bin/env python3
"""Attach and enable the restricted host service without changing app storage."""

import hashlib
import importlib.util
import json
import os
import shlex
import stat
import tempfile
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("orbis_enable_setup", Path(__file__).with_name("orbis-host-service-setup.py"))
SETUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SETUP)
HOST = SETUP.HOST
SPEC = importlib.util.spec_from_file_location("orbis_enable_apps", Path(__file__).with_name("orbis-install-apps.py"))
APPS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(APPS)
SCHEMA = "orbis.host-enable.v1"


def read_record(path):
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


def enable(root, context, source):
    available(root, context)
    with HOST.host_lock(root):
        path = journal_path(root, context)
        override = root / "orbis-host-compose.yml"
        if existing_owner(root, context) and healthy_existing(root, context, source):
            if path.exists():
                record = read_record(path)
                if record.get("root") != str(root) or record.get("dockerContext") != context:
                    raise ValueError("The host setup journal belongs to another installation")
                record["stage"] = "complete"
                APPS.write_journal(path, record)
            return {"result": "host-service-active", "socket": str(SETUP.SOCKET_FILE)}
        if path.exists():
            record = read_record(path)
            if record.get("schema") != SCHEMA or record.get("root") != str(root) or record.get("dockerContext") != context or record.get("sources") != source_hashes(source):
                raise ValueError("Resume host setup using its original verified installer sources")
            if record.get("stage") == "complete":
                raise ValueError("The installed host service needs diagnosis; a completed setup cannot be replayed")
        else:
            manifest = SETUP.SERVICE.installed_manifest(root, context)
            require_scoped_cleanup(root, context, f"{manifest['image']}@{manifest['digest']}")
            before = HOST.installation_fingerprint(root, manifest, context)
            HOST.require_current_state(root, before)
            if override.exists() or override.is_symlink():
                raise ValueError("Review the existing host service override before enabling it")
            if any(target.exists() or target.is_symlink() for target in (SETUP.INSTALL_DIR, SETUP.ENV_FILE, SETUP.UNIT_FILE)):
                raise ValueError("An existing host service must be repaired or upgraded separately")
            record = {"schema": SCHEMA, "root": str(root), "dockerContext": context, "manifest": manifest, "before": before, "sources": source_hashes(source), "stage": "prepared"}
            SETUP.ENV_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            details = SETUP.ENV_FILE.parent.stat()
            if SETUP.ENV_FILE.parent.is_symlink() or details.st_uid != 0 or stat.S_IMODE(details.st_mode) & 0o077:
                raise ValueError("Host service configuration directory must be private and root-owned")
            APPS.write_journal(path, record)
        manifest = record["manifest"]
        for name, expected in record["before"]["files"].items():
            if HOST.file_digest(root / name) != expected:
                raise ValueError("Installation configuration changed during host setup; preserve its journal")
        if override.exists() or override.is_symlink():
            if override.is_symlink() or not override.is_file() or override.read_text() != content():
                raise ValueError("The host socket override changed during setup")
        else:
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
        socket_dir = SETUP.SOCKET_FILE.parent
        socket_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        details = socket_dir.lstat()
        if not stat.S_ISDIR(details.st_mode) or details.st_uid != 0 or stat.S_IMODE(details.st_mode) & 0o077:
            raise ValueError("Host socket directory must be private and root-owned")
        record["stage"] = "mount-prepared"
        APPS.write_journal(path, record)
        arguments = HOST.compose_args(root) + ["up", "--detach", "--no-deps", "--force-recreate", "--pull", "never", "--no-build", "--wait", "--wait-timeout", "180", "runtipi"]
        result = HOST.docker(context, arguments, root)
        if result.returncode:
            raise RuntimeError(f"The controller could not restart with its host socket. Preserve {path} and rerun the same installer to continue")
        core = HOST.current_core(root, context)
        if core.get("state") != "running" or core.get("health") != "healthy" or core.get("image") != f"{manifest['image']}@{manifest['digest']}":
            raise RuntimeError("The controller did not reach its enrolled healthy image; preserve the host setup journal")
        HOST.write_state(root, HOST.installation_fingerprint(root, manifest, context))
        record["stage"] = "installing-service"
        APPS.write_journal(path, record)
        ready = SETUP.install_locked(root, context, source, resume=True)
        record["stage"] = "complete"
        APPS.write_journal(path, record)
        return {"result": "host-service-active", "socket": ready["socket"]}
