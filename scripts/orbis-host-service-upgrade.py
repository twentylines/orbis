#!/usr/bin/env python3
"""Upgrade an installed Orbis Linux host helper with a reversible service stop.

Run this from a reviewed Orbis checkout. It changes only the helper scripts and
systemd unit; it does not update the Orbis core or touch its data tree.
Use review-host-source separately to stage a Sentinel plan for Root approval.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import ExitStack
from pathlib import Path


def load_setup():
    spec = importlib.util.spec_from_file_location("orbis_host_service_setup_for_upgrade", Path(__file__).with_name("orbis-host-service-setup.py"))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SETUP = load_setup()
PROFILE = SETUP.load_script('orbis-host-observer-profile.py', 'orbis_observer_profile_for_upgrade')
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


def exact_environment(root: Path, context: str, *, credentials_only=False) -> str:
    return SETUP.service_environment(root, context, credentials_only=credentials_only).decode()


def systemctl_output(*arguments: str) -> str:
    result = subprocess.run(["/usr/bin/systemctl", *arguments], capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"systemctl {arguments[0]} failed; inspect the host journal")
    return result.stdout.strip()


def validate_unit(unit: str, *, credentials_only=False) -> None:
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
    SETUP.require_role_unit(unit.encode(), credentials_only=credentials_only)


def require_installed(root: Path, context: str) -> dict | None:
    for directory in (SETUP.INSTALL_DIR.parent, SETUP.ENV_FILE.parent, STATE_DIR):
        require_root_owned(directory, directory=True, private=True)
    require_root_owned(SETUP.INSTALL_DIR, directory=True, private=True)
    for name in SETUP.SCRIPTS:
        file = SETUP.INSTALL_DIR / name
        if name in LEGACY_SCRIPTS or file.exists() or file.is_symlink():
            require_root_owned(file, directory=False, private=True)
    require_root_owned(SETUP.ENV_FILE, directory=False, private=True)
    require_root_owned(SETUP.UNIT_FILE, directory=False)
    role = SETUP.environment_role(SETUP.ENV_FILE.read_bytes(), root, context)
    validate_unit(SETUP.UNIT_FILE.read_text(encoding="utf-8"), credentials_only=role)
    if systemctl_output("show", "-p", "FragmentPath", "--value", "orbis-host.service") != str(SETUP.UNIT_FILE):
        raise ValueError("systemd is not using the expected Orbis helper unit")
    profile = PROFILE.configuration(SETUP.UNIT_FILE, systemctl_output, HOST.AUTHORITY)
    PROFILE.require_support(SETUP.INSTALL_DIR, profile)
    if systemctl_output("is-active", "orbis-host.service") != "active":
        raise ValueError("installed Orbis helper must be active before upgrade")
    return profile


def require_profile(expected, directory=None, *, loaded=True):
    if PROFILE.configuration(SETUP.UNIT_FILE, systemctl_output, HOST.AUTHORITY, loaded=loaded) != expected:
        raise ValueError('Sentinel observer configuration changed during helper maintenance')
    if directory is not None:
        PROFILE.require_support(directory, expected)


def stop_service(profile):
    if profile is None:
        SETUP.run_systemctl('stop', 'orbis-host.service')
        return
    if systemctl_output('show', '-p', 'KillMode', '--value', 'orbis-host.service') != 'control-group':
        raise ValueError('Sentinel observer helper stop policy needs review')
    # An open activation socket could restart the helper while scripts are swapped.
    SETUP.run_systemctl('stop', PROFILE.SOCKET, 'orbis-host.service')
    for name in (PROFILE.SOCKET, 'orbis-host.service'):
        if (systemctl_output('show', '-p', 'ActiveState', '--value', name) != 'inactive'
                or systemctl_output('show', '-p', 'SubState', '--value', name) != 'dead'):
            raise ValueError('Sentinel observer helper stop has not completed')


def job_identity() -> tuple[str, str] | None:
    restart_job = SERVICE.read_private(STATE_DIR / "restart-job.json")
    if restart_job and restart_job.get("state") == "restarting":
        if not isinstance(restart_job.get("bootId"), str):
            raise ValueError("server restart job is invalid")
        if restart_job["bootId"] == SERVICE.boot_id():
            raise ValueError("wait for the server restart before upgrading the helper")
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


def preflight(root: Path, context: str, source: Path) -> dict:
    if MAINTENANCE.exists() or MAINTENANCE.is_symlink():
        raise ValueError("a helper upgrade needs recovery before another upgrade")
    ready = SETUP.preflight(root, context, source, allow_existing=True)
    profile = require_installed(root, context)
    if HOST.retained_state(root):
        HOST.resolve_current_identity(root, context)
        for name in ("orbis-host-identity.py", "orbis-host-retained-authority.py"):
            require_root_owned(SETUP.INSTALL_DIR / name, directory=False, private=True)
    job_identity()
    source_files, source_unit = SETUP.source_files(source)
    validate_candidate_scripts(source_files)
    environment = SETUP.ENV_FILE.read_bytes()
    role = SETUP.environment_role(environment, root, context)
    validate_unit(source_unit.read_text(encoding="utf-8"), credentials_only=role)
    PROFILE.require_support(source, profile)
    if SETUP.ENV_FILE.read_bytes() != environment:
        raise ValueError('Installed service environment changed during helper preflight')
    return {
        **ready,
        "installedScriptsSha256": digest_files(SETUP.INSTALL_DIR),
        "candidateScriptsSha256": digest_files(source_files[0].parent),
        "installedUnitSha256": hashlib.sha256(SETUP.UNIT_FILE.read_bytes()).hexdigest(),
        "candidateUnitSha256": hashlib.sha256(source_unit.read_bytes()).hexdigest(),
        "observerProfile": profile,
        "installedEnvironmentSha256": hashlib.sha256(environment).hexdigest(),
    }


def validate_candidate_scripts(source_files):
    for file in source_files:
        if file.name in {"orbis-host-maintenance-responder.mjs", "orbis-controller-bootstrap-profile.mjs"}:
            continue
        if file.suffix != ".py":
            raise ValueError(f"unsupported candidate helper script: {file.name}")
        try:
            compile(file.read_text(encoding="utf-8"), str(file), "exec")
        except SyntaxError as error:
            raise ValueError(f"candidate helper script has invalid Python syntax: {file.name}") from error


def sync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_copy(source: Path, destination: Path, mode: int) -> None:
    atomic_contents(source.read_bytes(), destination, mode)


def atomic_contents(body: bytes, destination: Path, mode: int) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=f".{destination.name}-", dir=destination.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        sync_directory(destination.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def verify_service(digest: str, root: Path, context: str) -> None:
    credentials_only = SETUP.installed_credentials_only(root, context)
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
                and (not credentials_only or (status.get('serviceRole') == 'credentials-only'
                                              and status.get('capabilities') == []
                                              and type(status.get('credentialProtocol')) is int
                                              and status.get('credentialProtocol') == 1
                                              and json.loads(inside.stdout).get('serviceRole') == 'credentials-only'
                                              and json.loads(inside.stdout).get('capabilities') == []
                                              and type(json.loads(inside.stdout).get('credentialProtocol')) is int
                                              and json.loads(inside.stdout).get('credentialProtocol') == 1))
            ):
                SETUP.validate_running_mount(host_mount.st_dev, host_mount.st_ino, mounted.stdout)
                return
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        time.sleep(0.4)
    raise RuntimeError("restarted helper did not pass host, core, and socket mount checks")


def workspace_from_record(record: dict, root: Path, context: str) -> Path:
    schema = record.get('schema')
    profile = record.get('observerProfile')
    if (schema not in ('orbis.helper-upgrade.v1', 'orbis.helper-upgrade.v2')
            or (schema == 'orbis.helper-upgrade.v1' and profile is not None)
            or (schema == 'orbis.helper-upgrade.v2' and not isinstance(profile, dict))
            or record.get("root") != str(root) or record.get("dockerContext") != context):
        raise ValueError("helper maintenance record does not match this installation")
    raw = record.get("workspace")
    if not isinstance(raw, str):
        raise ValueError("helper maintenance workspace is missing")
    workspace = Path(raw)
    if workspace.parent != SETUP.INSTALL_DIR.parent or not workspace.name.startswith(WORKSPACE_PREFIX):
        raise ValueError("helper maintenance workspace is outside the expected directory")
    require_root_owned(workspace, directory=True, private=True)
    return workspace


def require_maintenance_identity(root, context):
    record = SERVICE.read_private(MAINTENANCE)
    if record and 'environmentSha256' in record:
        expected = record['environmentSha256']
        require_root_owned(SETUP.ENV_FILE, directory=False, private=True)
        if (type(expected) is not str or not re.fullmatch(r'[a-f0-9]{64}', expected)
                or hashlib.sha256(SETUP.ENV_FILE.read_bytes()).hexdigest() != expected):
            raise ValueError('The installed service role or environment changed during helper maintenance')
    if record and record.get("retainedSource") is not None:
        if HOST.retained_descriptor(root, context) != record["retainedSource"]:
            raise ValueError("retained source changed during helper maintenance")
        HOST.resolve_current_identity(root, context)
    elif HOST.retained_state(root):
        raise ValueError("retained helper recovery requires its protected source descriptor")


def _require_custodied_copy(custody, member, directory, unit):
    if custody is None:
        return
    if (type(custody) is not dict or set(custody) != {"selection", "prior", "candidate"}
            or SETUP.actual_copy(directory, unit) != custody[member]):
        raise ValueError("Helper maintenance copy differs from its exact journaled source")


def restore_previous(workspace: Path, digest: str, root: Path, context: str) -> None:
    require_maintenance_identity(root, context)
    record = SERVICE.read_private(MAINTENANCE)
    profile = record.get('observerProfile') if record else None
    previous = workspace / "previous"
    if previous.exists() or previous.is_symlink():
        require_root_owned(previous, directory=True, private=True)
    prior_directory = previous if previous.exists() else SETUP.INSTALL_DIR
    custody = record.get("sourceCustody") if record else None
    _require_custodied_copy(custody, "prior", prior_directory, workspace / "previous-unit")
    require_profile(profile, prior_directory, loaded=False)
    stop_service(profile)
    if previous.exists():
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
    _require_custodied_copy(custody, "prior", SETUP.INSTALL_DIR, SETUP.UNIT_FILE)
    SETUP.run_systemctl("daemon-reload")
    require_profile(profile, SETUP.INSTALL_DIR)
    SETUP.run_systemctl("start", "orbis-host.service")
    verify_service(digest, root, context)
    require_profile(profile, SETUP.INSTALL_DIR)
    if custody is not None:
        record["stage"] = "restored"
        SERVICE.write_private(MAINTENANCE, record)
        SETUP.record_source_copy_transition(root, context, custody, outcome="prior-restored")


def retention_binding(value):
    if (type(value) is not dict or set(value) != {'operationId', 'planSha256', 'targetDigest'}
            or type(value['operationId']) is not str
            or type(value['planSha256']) is not str or not re.fullmatch(r'[a-f0-9]{64}', value['planSha256'])
            or type(value['targetDigest']) is not str or not SETUP.PLAN.DIGEST.fullmatch(value['targetDigest'])):
        raise ValueError('Helper rollback retention requires one exact component upgrade binding')
    try:
        identifier = uuid.UUID(value['operationId'])
    except ValueError as error:
        raise ValueError('Helper rollback retention operation is invalid') from error
    if str(identifier) != value['operationId'] or identifier.version != 4:
        raise ValueError('Helper rollback retention operation is invalid')
    return dict(value)


def retain_previous(workspace, binding):
    """Keep verified helper source rollback custody for a larger transaction.

    This receipt records facts only. It does not authorize a component update,
    approve recovery, release a hold or certify the other components healthy.
    """
    binding = retention_binding(binding)
    record = SERVICE.read_private(MAINTENANCE)
    if (not isinstance(record, dict) or record.get('stage') != 'verified'
            or record.get('sourceCustody') is None
            or workspace_from_record(record, Path(record['root']), record['dockerContext']) != workspace):
        raise ValueError('Helper rollback retention needs exact verified source custody')
    custody = record['sourceCustody']
    _require_custodied_copy(custody, 'prior', workspace / 'previous', workspace / 'previous-unit')
    _require_custodied_copy(custody, 'candidate', SETUP.INSTALL_DIR, SETUP.UNIT_FILE)
    require_maintenance_identity(Path(record['root']), record['dockerContext'])
    value = {'schema': 'orbis.helper-upgrade-retained.v1', 'binding': binding, 'maintenance': record}
    body = SETUP._receipt_bytes(value)
    with HOST.AUTHORITY.protected_directory(workspace) as pinned:
        directory = os.dup(pinned)
        identity = SETUP._SetupSources._directory_identity(os.fstat(directory))
    try:
        descriptor = os.open('retained.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=directory)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(body)
            output.flush()
            os.fsync(output.fileno())
        os.fsync(directory)
        with HOST.AUTHORITY.protected_directory(workspace) as observed:
            if (SETUP._SetupSources._directory_identity(os.fstat(observed)) != identity
                    or SETUP._SetupSources._directory_identity(os.fstat(directory)) != identity):
                raise ValueError('Helper rollback retention directory changed')
            with HOST.AUTHORITY.protected_file(observed, 'retained.json', 131072) as retained:
                if retained != body or SERVICE.read_private(MAINTENANCE) != record:
                    raise ValueError('Helper rollback retention changed before maintenance settled')
    finally:
        os.close(directory)
    MAINTENANCE.unlink()
    sync_directory(STATE_DIR)
    return {'schema': 'orbis.helper-upgrade-retention.v1', **binding,
            'workspace': str(workspace), 'sha256': hashlib.sha256(body).hexdigest()}


def rollback_retained(root, context, confirmation, retained):
    """Restore retained helper bytes only after the original Core is healthy.

    The independent coordinator must restore/verify Core first. Uncertain or
    mixed Core state never permits replacing the helper with its old copy.
    """
    if os.geteuid() != 0:
        raise ValueError('Helper rollback requires root privileges')
    root = root.resolve(strict=True)
    if confirmation != str(root):
        raise ValueError('Helper rollback requires the exact confirmed installation')
    if (type(retained) is not dict
            or set(retained) != {'schema', 'operationId', 'planSha256', 'targetDigest', 'workspace', 'sha256'}
            or retained['schema'] != 'orbis.helper-upgrade-retention.v1'
            or type(retained['workspace']) is not str or type(retained['sha256']) is not str
            or not re.fullmatch(r'[a-f0-9]{64}', retained['sha256'])):
        raise ValueError('Helper rollback retention descriptor is invalid')
    binding = retention_binding({key: retained[key] for key in ('operationId', 'planSha256', 'targetDigest')})
    workspace = Path(retained['workspace'])
    if (workspace.parent != SETUP.INSTALL_DIR.parent or not workspace.name.startswith(WORKSPACE_PREFIX)
            or workspace != workspace.resolve(strict=True)):
        raise ValueError('Helper rollback retention workspace is invalid')
    with HOST.host_lock(root):
        if MAINTENANCE.exists() or MAINTENANCE.is_symlink():
            raise ValueError('Resolve existing helper maintenance before retained rollback')
        with HOST.AUTHORITY.protected_directory(workspace) as directory:
            with HOST.AUTHORITY.protected_file(directory, 'retained.json', 131072) as body:
                value = json.loads(body)
                if (hashlib.sha256(body).hexdigest() != retained['sha256']
                        or type(value) is not dict or set(value) != {'schema', 'binding', 'maintenance'}
                        or value['schema'] != 'orbis.helper-upgrade-retained.v1' or value['binding'] != binding
                        or SETUP._receipt_bytes(value) != body):
                    raise ValueError('Helper rollback retention receipt changed')
                record = value['maintenance']
                if (not isinstance(record, dict) or record.get('stage') != 'verified'
                        or record.get('sourceCustody') is None
                        or workspace_from_record(record, root, context) != workspace):
                    raise ValueError('Helper rollback belongs to a different verified installation')
                digest = record.get('previousDigest')
                if type(digest) is not str or not SETUP.PLAN.DIGEST.fullmatch(digest):
                    raise ValueError('Helper rollback original Core identity is invalid')
                custody = record['sourceCustody']
                selection = custody['selection']
                source = Path(selection['directory']) / 'scripts'
                with SETUP.hold_source_selection(source, selection['selectionSha256']) as current:
                    if current is None or {key: item for key, item in current.items() if key != 'inventory'} != selection:
                        raise ValueError('Helper rollback source execution custody changed')
                    profile = require_installed(root, context)
                    if profile != record.get('observerProfile'):
                        raise ValueError('Helper rollback observer profile changed')
                    previous_job = job_identity()
                    _require_custodied_copy(custody, 'prior', workspace / 'previous', workspace / 'previous-unit')
                    _require_custodied_copy(custody, 'candidate', SETUP.INSTALL_DIR, SETUP.UNIT_FILE)
                    verify_service(digest, root, context)
                    # A restart must resume restoration, rather than treating
                    # the earlier verified candidate as the requested outcome.
                    record = {**record, 'stage': 'retained-rollback', 'retention': retained}
                    SERVICE.write_private(MAINTENANCE, record)
        require_maintenance_identity(root, context)
        if job_identity() != previous_job:
            raise ValueError('A Core operation changed before stopping the helper; preserve rollback custody')
        stop_service(profile)
        if job_identity() != previous_job:
            raise ValueError('A Core operation changed while stopping the helper; preserve rollback custody')
        restore_previous(workspace, digest, root, context)
        finish(workspace)
        return {'operationId': binding['operationId'], 'planSha256': binding['planSha256'],
                'service': 'active', 'restored': True}


def finish(workspace: Path) -> None:
    MAINTENANCE.unlink(missing_ok=True)
    sync_directory(STATE_DIR)
    shutil.rmtree(workspace)
    sync_directory(workspace.parent)


def upgrade(root: Path, context: str, source: Path, confirmation: str | None, *, source_custody=None, retain=None) -> dict:
    if os.geteuid() != 0:
        raise ValueError("helper upgrade requires root privileges")
    root = root.resolve(strict=True)
    if confirmation != str(root):
        raise ValueError(f"helper upgrade requires --confirm-root {root}")
    if retain is not None:
        retain = retention_binding(retain)
        if source_custody is None:
            raise ValueError('Coordinated helper rollback requires verified installer execution custody')
    with HOST.host_lock(root), SETUP.hold_source_selection(source, source_custody) as selection:
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
            copy_custody = None
            if selection is None:
                for file in files:
                    atomic_copy(file, new / file.name, 0o600)
                atomic_copy(unit, workspace / "candidate.service", 0o600)
            else:
                drivers = [source / name for name in ("orbis-host-service-setup.py",
                    "orbis-host-service-enable.py", "orbis-host-service-upgrade.py")]
                with SETUP._SetupSources([*files, *drivers], unit) as pinned:
                    SETUP.require_selection_files(source, selection, pinned, [*files, *drivers, unit])
                    candidate = {"inventory": {file.name: SETUP._hash(pinned.body(file)) for file in files},
                                 "unitSha256": SETUP._hash(pinned.body(unit))}
                    prior = SETUP.actual_copy(SETUP.INSTALL_DIR, SETUP.UNIT_FILE)
                    for file in files:
                        atomic_contents(pinned.body(file), new / file.name, 0o600)
                    atomic_contents(pinned.body(unit), workspace / "candidate.service", 0o600)
                    pinned.verify()
                copy_custody = {"selection": {key: value for key, value in selection.items() if key != "inventory"},
                                "prior": prior, "candidate": candidate}
                _require_custodied_copy(copy_custody, "candidate", new, workspace / "candidate.service")
            atomic_copy(SETUP.UNIT_FILE, workspace / "previous-unit", 0o600)
            _require_custodied_copy(copy_custody, "prior", SETUP.INSTALL_DIR, workspace / "previous-unit")
            checked = subprocess.run(["/usr/bin/systemd-analyze", "verify", str(workspace / "candidate.service")], capture_output=True, check=False)
            if checked.returncode:
                raise ValueError("systemd rejected the candidate Orbis helper unit")
            record = {
                "schema": "orbis.helper-upgrade.v2" if ready['observerProfile'] is not None else "orbis.helper-upgrade.v1",
                "root": str(root),
                "dockerContext": context,
                "workspace": str(workspace),
                "previousDigest": ready["digest"],
                "stage": "prepared",
                "observerProfile": ready["observerProfile"],
            }
            if 'installedEnvironmentSha256' in ready:
                record['environmentSha256'] = ready['installedEnvironmentSha256']
            if copy_custody is not None:
                record["sourceCustody"] = copy_custody
            if HOST.retained_state(root):
                record["retainedSource"] = HOST.retained_descriptor(root, context)
            SERVICE.write_private(MAINTENANCE, record)
            require_maintenance_identity(root, context)
            require_profile(ready['observerProfile'], new)
            _require_custodied_copy(copy_custody, "prior", SETUP.INSTALL_DIR, SETUP.UNIT_FILE)
            stop_service(ready['observerProfile'])
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
            _require_custodied_copy(copy_custody, "candidate", SETUP.INSTALL_DIR, SETUP.UNIT_FILE)
            record["stage"] = "replaced"
            SERVICE.write_private(MAINTENANCE, record)
            SETUP.run_systemctl("daemon-reload")
            require_profile(ready['observerProfile'], SETUP.INSTALL_DIR)
            SETUP.run_systemctl("start", "orbis-host.service")
            verify_service(ready["digest"], root, context)
            require_profile(ready['observerProfile'], SETUP.INSTALL_DIR)
            if copy_custody is not None:
                receipt = SETUP.record_source_copy(root, context, selection, copy_custody["candidate"])
                record["hostCopyCustodySha256"] = receipt
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
        if copy_custody is not None:
            transition = SETUP.record_source_copy_transition(root, context, copy_custody,
                outcome="candidate-active", copy_receipt=receipt)
            ready.update(hostCopyCustodySha256=receipt, hostCopyTransitionSha256=transition)
        if retain is not None:
            ready['retainedRollback'] = retain_previous(workspace, retain)
        else:
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
        require_maintenance_identity(root, context)
        require_profile(record.get('observerProfile'), loaded=False)
        custody = record.get("sourceCustody")
        if record.get("stage") == "restored" and custody is not None:
            _require_custodied_copy(custody, "prior", SETUP.INSTALL_DIR, SETUP.UNIT_FILE)
            verify_service(digest, root, context)
            SETUP.record_source_copy_transition(root, context, custody, outcome="prior-restored")
        elif record.get("stage") == "verified":
            try:
                _require_custodied_copy(custody, "candidate", SETUP.INSTALL_DIR, SETUP.UNIT_FILE)
                require_profile(record.get('observerProfile'), SETUP.INSTALL_DIR)
                verify_service(digest, root, context)
                require_profile(record.get('observerProfile'), SETUP.INSTALL_DIR)
            except RuntimeError:
                restore_previous(workspace, digest, root, context)
            else:
                if custody is not None:
                    receipt = record.get("hostCopyCustodySha256")
                    if SETUP.record_source_copy(root, context, custody["selection"], custody["candidate"]) != receipt:
                        raise ValueError("Verified helper copy differs from its exact recorded receipt")
                    SETUP.record_source_copy_transition(root, context, custody,
                        outcome="candidate-active", copy_receipt=receipt)
        else:
            restore_previous(workspace, digest, root, context)
        finish(workspace)
        return {"root": str(root), "dockerContext": context, "service": "active", "recovered": True}


def review_host_source(root, context, confirmation, selection_directory, selection_sha, copy_sha):
    """Join retained installer custody to the installed Sentinel review only."""
    sentinel = SETUP.load_script("orbis-sentinel-install.py", "orbis_sentinel_host_source_review")
    sentinel.require_host()
    if (not root.is_absolute() or root.resolve(strict=True) != root or not root.is_dir()
            or len(os.fsencode(root)) > 4096 or confirmation != str(root) or any(ord(char) < 32 or ord(char) == 127 for char in str(root))):
        raise ValueError("Host source review requires the canonical installed root and matching --confirm-root")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", context):
        raise ValueError("Host source review requires the exact installed Docker context")
    if (selection_directory is None or not selection_directory.is_absolute()
            or selection_directory.resolve(strict=True) != selection_directory
            or any(ord(char) < 32 or ord(char) == 127 for char in str(selection_directory))
            or not all(re.fullmatch(r"[a-f0-9]{64}", value or "") for value in (selection_sha, copy_sha))):
        raise ValueError("Supply the retained installer directory, selection SHA-256 and Host-copy SHA-256")

    protected = (sentinel.INSTALLED_ROOT, sentinel.INSTALLED_STATE, SETUP.INSTALL_DIR, SETUP.UNIT_FILE, SETUP.ENV_FILE)
    if any(root.is_relative_to(path) or path.is_relative_to(root) for path in protected):
        raise ValueError("The installation root overlaps protected Host or Sentinel paths")
    source = selection_directory / "scripts"
    files, unit = SETUP.source_files(source)
    with ExitStack() as pins:
        for descriptor in HOST.AUTHORITY.LAYOUT.open_locks(root, create=False):
            pins.callback(os.close, descriptor)
        if SERVICE.read_private(MAINTENANCE) is not None:
            raise ValueError("Reconcile pending Host helper maintenance before requesting source review")
        selection = pins.enter_context(SETUP.hold_source_selection(source, selection_sha))
        inputs = pins.enter_context(SETUP._SetupSources(files, unit))
        SETUP.require_selection_files(source, selection, inputs, [*files, unit])
        expected = {"inventory": {file.name: SETUP._hash(inputs.body(file)) for file in files},
                    "unitSha256": SETUP._hash(inputs.body(unit))}
        actual = SETUP._source_copy_receipt(pins, root, context, selection, expected)
        copies = pins.enter_context(HOST.AUTHORITY.protected_directory(selection_directory / "host-copy-custody"))
        receipt = pins.enter_context(HOST.AUTHORITY.protected_file(copies, f"host-copy-{copy_sha}.json", 1024 * 1024))
        if receipt != actual or SETUP._hash(receipt) != copy_sha:
            raise ValueError("Retained Host-copy receipt differs from the exact installed Host copy")
        operation = SETUP._hash(SETUP._receipt_bytes({
            "schema": "orbis.installer.host-source-review.v1", "root": str(root), "context": context,
            "selectionDirectory": str(selection_directory), "selectionSha256": selection_sha,
            "hostCopySha256": copy_sha,
        }))
        inputs.verify()
        result = sentinel.review_host_source(operation, selection_directory, copy_sha)
        inputs.verify()
        return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "upgrade", "recover", "review-host-source"))
    parser.add_argument("root", type=Path)
    parser.add_argument("--docker-context", required=True)
    parser.add_argument("--source-dir", type=Path)
    parser.add_argument("--confirm-root")
    parser.add_argument("--installer-selection", type=Path, help="retained installer selection directory for Host source review")
    parser.add_argument("--installer-selection-sha256", help="exact installer selection receipt digest")
    parser.add_argument("--host-copy-sha256", help="exact installed Host-copy custody digest")
    args = parser.parse_args()
    review = (args.installer_selection, args.installer_selection_sha256, args.host_copy_sha256)
    if args.action == "review-host-source":
        if any(value is None for value in review) or args.source_dir is not None:
            parser.error("Host source review requires all three custody options and excludes --source-dir")
    elif any(value is not None for value in review):
        parser.error("Custody review options require review-host-source")
    try:
        if args.action == "review-host-source":
            print(json.dumps(review_host_source(args.root, args.docker_context, args.confirm_root, *review), indent=2))
            return 0
        root = args.root.expanduser().resolve(strict=True)
        source = (args.source_dir or Path(__file__).parent).expanduser().resolve(strict=True)
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
        label = "Host source review" if args.action == "review-host-source" else "Orbis host service upgrade"
        print(f"{label} failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
