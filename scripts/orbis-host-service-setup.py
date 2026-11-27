#!/usr/bin/env python3
"""Install the restricted Orbis host service on an already enrolled Linux host.

This does not adopt stock Runtipi or edit Compose. The socket mount must already
be in the enrolled, healthy core configuration.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import re
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from contextlib import ExitStack, contextmanager


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
    "orbis-host-upgrade-target.py",
    "migration-preflight.py",
    "orbis-release-plan.py",
    "orbis-release-policy.py",
    "orbis-stage-release.py",
    "orbis-host.py",
    "orbis-host-identity.py",
    "orbis-host-retained-authority.py",
    "orbis-host-layout.py",
    "orbis-host-credential-fence.py",
    "orbis-host-credential-peer.py",
    "orbis-container-definition.py",
    "orbis-host-app-storage.py",
    "orbis-host-credential-service.py",
    "orbis-host-ownership-authority.py",
    "orbis-host-ownership-bootstrap.py",
    "orbis-host-existing-ownership.py",
    "orbis-host-legacy-ownership.py",
    "orbis-host-fresh-ownership.py",
    "orbis-host-controller-handoff.py",
    "orbis-host-recovery-admission.py", "orbis-host-recovery-source.py",
    "orbis-host-capture-authority.py",
    "orbis-host-app-runtime.py",
    "orbis-host-volume-capture.py",
    "orbis-host-volume-engine.py",
    "orbis-host-volume-inventory.py",
    "orbis-host-volume-service.py",
    "orbis-app-volume-authority.py",
    "orbis-host-normal-bootstrap.py",
    "orbis-host-app-create-intent.py",
    "orbis-host-retained-app-effects.py",
    "orbis-host-app-port-policy.py",
    "orbis-host-app-port-observer.py",
    "orbis-host-app-inet-diag.py",
    "orbis-host-time-machine-capabilities.py",
    "orbis-host-time-machine-core.py",
    "orbis-host-core-storage-map.py",
    "orbis-host-core-checkpoint.py",
    "orbis-host-core-capture-reader.py",
    "orbis-host-core-capture-service.py",
    "orbis-host-sentinel-capture.py",
    "orbis-host-sentinel-publication.py",
    "orbis-host-sentinel-auto-publication.py",
    "orbis-host-sentinel-reader.py",
    "orbis-sentinel-install.py",
    "orbis-host-core-capture-worker.py",
    "orbis-host-selected-capture.py",
    "orbis-host-selected-capture-io.py",
    "orbis-host-core-capture-lease.py",
    "orbis-host-core-capture-reservation.py",
    "orbis-host-core-capture-reserved.py",
    "orbis-host-core-capture-supervisor.py",
    "orbis-host-core-capture-completion.py",
    "orbis-host-core-capture-retirement.py",
    "orbis-host-core-capture-restart-retirement.py",
    "orbis-host-core-capture-failed-recovery.py",
    "orbis-host-core-capture-namespace.py",
    "orbis-host-core-capture-abort.py",
    "orbis-host-core-capture-empty-abort.py",
    "orbis-host-core-capture-unused-abort.py",
    "orbis-host-retained-app-driver.py",
    "orbis-host-retained-restore.py",
    "orbis-host-retained-restore-runtime.py",
    "orbis-host-controller-update.py",
    "orbis-controller-bootstrap-profile.py",
    "orbis-controller-bootstrap-profile.mjs",
    "orbis-reset-authority.py",
    "orbis-host-maintenance-responder.mjs",
    "orbis-host-maintenance-overlay.py",
    "orbis-proxy-identity.py",
    "orbis-proxy-adoption.py",
    "orbis-host-portable-policy.py",
    "orbis-host-portable-enrollment.py",
    "orbis-host-core-portable-enrollment.py",
    "orbis-host-core-portable-driver.py",
    "orbis-host-core-checkpoint-review.py",
    "orbis-host-core-checkpoint-materialize.py",
    "orbis-host-core-restore-inspection.py",
    "orbis-host-core-pg-profiles.py",
    "orbis-host-core-inspection-profile.py",
    "orbis-host-core-inspection-executor.py",
    "orbis-host-core-inspection-installation.py",
    "orbis-host-core-local-inspection-service.py",
    "orbis-host-core-bootstrap-inspection-service.py",
    "orbis-host-core-local-inspection.py",
    "orbis-host-core-local-source.py",
    "orbis-host-core-source-configuration.py",
    "orbis-host-core-clean-target-profile.py",
    "orbis-host-core-clean-target-bootstrap.py",
    "orbis-host-core-preparation-policy.py",
    "orbis-host-core-preparation-service.py",
    "orbis-host-core-runtime-install.py",
    "orbis-host-core-runtime-service.py",
    "orbis-host-core-reconciliation-service.py",
    "orbis-host-core-restoration-review.py",
    "orbis-host-core-restoration.py",
    "orbis-host-core-live-restoration.py",
    "orbis-host-core-live-import.py",
    "orbis-host-core-clean-target-reconcile.py",
    "orbis-install-compat.py",
    "orbis-controller-identity.py",
    "orbis-release-check.py",
    "orbis-snapshot.py",
    "orbis-host-update.py",
    "orbis-install-detect.py",
    "orbis-install-apps.py",
    "orbis-install-storage.py",
    "orbis-install-restore.py",
    "orbis-install-transaction.py",
    "orbis-host-service.py",
    "orbis-host-docker-socket-recovery.py",
    "orbis-host-sentinel-observer.py",
    "orbis-host-core-capture-progress.py",
    "orbis-host-packages.py",
    "orbis-host-package-worker.py",
    "orbis-host-upgrade-launcher.py",
    "orbis-host-upgrade-supervision.py",
    "orbis-host-upgrade-runner.py",
    "install-orbis.py",
    "orbis-host-service-setup.py",
    "orbis-host-service-upgrade.py",
    "orbis-host-observer-profile.py",
    "orbis-host-telemetry.py",
    "orbis-host-processes.py",
    "orbis-host-sensors.py",
    "orbis-host-drives.py",
    "orbis-host-discovery.py",
)
INSTALL_DIR = Path("/opt/orbis/host-service")
ENV_FILE = Path("/etc/orbis/host-service.env")
UNIT_FILE = Path("/etc/systemd/system/orbis-host.service")
OBSERVER_DROP_IN = Path("/etc/systemd/system/orbis-host.service.d/sentinel-observer.conf")
OBSERVER_DROP_IN_CONTENT = b"[Unit]\nRequires=orbis-host-observer.socket\nAfter=orbis-host-observer.socket\n\n[Service]\nSockets=orbis-host-observer.socket\n"
SOCKET_FILE = Path("/run/orbis/host.sock")


def service_environment(root, context, *, credentials_only=False):
    if type(credentials_only) is not bool:
        raise ValueError('Host service role must be explicit')
    content = (
        f"ORBIS_SERVICE_SOURCE={systemd_quote(str(INSTALL_DIR / 'orbis-host-service.py'))}\n"
        f"ORBIS_ROOT={systemd_quote(str(root))}\n"
        f"ORBIS_DOCKER_CONTEXT={systemd_quote(context)}\n"
    )
    if credentials_only:
        content += 'ORBIS_CREDENTIAL_FLAGS="--credentials-only"\n'
    return content.encode()


def environment_role(body, root, context):
    for selected in (False, True):
        if body == service_environment(root, context, credentials_only=selected):
            return selected
    raise ValueError('Installed Host environment differs from the exact copy context')


def installed_credentials_only(root, context):
    with HOST.AUTHORITY.protected_directory(ENV_FILE.parent, private=False) as directory:
        with HOST.AUTHORITY.protected_file(directory, ENV_FILE.name, 16384) as body:
            return environment_role(body, root, context)


def require_role_unit(body, *, credentials_only=False):
    if type(credentials_only) is not bool:
        raise ValueError('Host service role must be explicit')
    if not credentials_only:
        return
    expected = ('ExecStart=/usr/bin/python3 ${ORBIS_SERVICE_SOURCE} --root ${ORBIS_ROOT} '
                '--docker-context ${ORBIS_DOCKER_CONTEXT} --socket /run/orbis/host.sock '
                '--snapshots /var/lib/orbis/snapshots --state-dir /var/lib/orbis/state $ORBIS_CREDENTIAL_FLAGS')
    lines = [line.strip() for line in body.decode('utf-8').splitlines()]
    if ([line for line in lines if line.startswith('ExecStart=')] != [expected]
            or [line for line in lines if line.startswith('EnvironmentFile=')] != ['EnvironmentFile=/etc/orbis/host-service.env']):
        raise ValueError('The candidate unit cannot preserve the account security role')


def systemd_quote(value: str) -> str:
    if any(character in value for character in "\r\n\0"):
        raise ValueError("systemd environment value contains a control character")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def source_files(source: Path) -> tuple[list[Path], Path]:
    if (type(SCRIPTS) is not tuple or not 1 <= len(SCRIPTS) <= 128
            or any(type(name) is not str or not re.fullmatch(r'(?:[a-z-]+\.py|orbis-[a-z-]+\.mjs)', name) for name in SCRIPTS)
            or len(set(SCRIPTS)) != len(SCRIPTS)):
        raise ValueError('Host source script inventory is invalid')
    if source.is_symlink() or not source.is_dir():
        raise ValueError("source scripts directory must be a real directory")
    files = [source / name for name in SCRIPTS]
    unit = source.parent / "packaging" / "systemd" / "orbis-host.service"
    for file in [*files, unit]:
        if file.is_symlink() or not file.is_file():
            raise ValueError(f"required source file is missing or is a symlink: {file.name}")
    return files, unit


class _SetupSources:
    """Hold the reviewed copy inputs; this is custody, not publisher authority."""

    def __init__(self, files: list[Path], unit: Path, *, drivers=()):
        self.directories = {}
        self.files = {}
        self.descriptors = []
        try:
            if not 1 <= len(files) <= 128 or len({file.name for file in files}) != len(files) or unit in files:
                raise ValueError("host service source inventory is invalid")
            allowed_drivers = {'orbis-host-service-setup.py', 'orbis-host-service-enable.py',
                               'orbis-host-service-upgrade.py'}
            if (type(drivers) not in (tuple, list) or len(drivers) > len(allowed_drivers)
                    or any(not isinstance(path, Path) or path.name not in allowed_drivers
                           or path.parent != files[0].parent for path in drivers)
                    or len(set(drivers)) != len(drivers)):
                raise ValueError('Host source driver inventory is invalid')
            # Installer-only drivers are separately bounded; they do not use
            # installed Host-script membership. Shared inputs are pinned once.
            files = list(dict.fromkeys([*files, *drivers]))
            if len({file.name for file in files}) != len(files) or unit in files:
                raise ValueError('Host source inputs have conflicting identities')
            total = 0
            for path in [*files, unit]:
                if not path.is_absolute() or ".." in path.parts:
                    raise ValueError("host service sources must have absolute paths")
                parent = self._directory(path.parent)
                before = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 <= before.st_size <= 1024 * 1024:
                    raise ValueError("host service source must be a bounded regular file without links")
                descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=parent)
                self.descriptors.append(descriptor)
                identity = self._file_identity(os.fstat(descriptor))
                if identity != self._file_identity(before):
                    raise ValueError("host service source changed while opening")
                body = os.pread(descriptor, 1024 * 1024 + 1, 0)
                if len(body) != before.st_size or self._file_identity(os.fstat(descriptor)) != identity:
                    raise ValueError("host service source changed while reading")
                total += len(body)
                if total > 8 * 1024 * 1024:
                    raise ValueError("host service source inventory exceeds its limit")
                self.files[path] = (descriptor, identity, body)
            self.verify()
        except BaseException:
            self.close()
            raise

    @staticmethod
    def _directory_identity(details):
        return details.st_dev, details.st_ino, details.st_mode, details.st_uid, details.st_gid

    @staticmethod
    def _file_identity(details):
        return (details.st_dev, details.st_ino, details.st_mode, details.st_uid, details.st_gid,
                details.st_nlink, details.st_size, details.st_mtime_ns, details.st_ctime_ns)

    def _directory(self, path):
        if path in self.directories:
            return self.directories[path][0]
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        if path == Path(path.anchor):
            parent, name = None, str(path)
            descriptor = os.open(name, flags)
        else:
            parent, name = self._directory(path.parent), path.name
            descriptor = os.open(name, flags, dir_fd=parent)
        self.descriptors.append(descriptor)
        identity = self._directory_identity(os.fstat(descriptor))
        named = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if self._directory_identity(named) != identity:
            raise ValueError("host service source directory changed while opening")
        self.directories[path] = (descriptor, parent, name, identity)
        return descriptor

    def verify(self):
        for descriptor, parent, name, identity in self.directories.values():
            if (self._directory_identity(os.fstat(descriptor)) != identity
                    or self._directory_identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != identity):
                raise ValueError("host service source directory changed during staging")
        for path, (descriptor, identity, body) in self.files.items():
            parent = self.directories[path.parent][0]
            if (self._file_identity(os.fstat(descriptor)) != identity
                    or self._file_identity(os.stat(path.name, dir_fd=parent, follow_symlinks=False)) != identity
                    or os.pread(descriptor, len(body) + 1, 0) != body):
                raise ValueError("host service source changed during staging")

    def body(self, path):
        return self.files[path][2]

    def close(self):
        while self.descriptors:
            os.close(self.descriptors.pop())

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()



def _hash(body):
    return hashlib.sha256(body).hexdigest()


def _receipt_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")


@contextmanager
def hold_source_selection(source, expected):
    """Hold actual verified extraction custody while copying installer files."""
    if expected is None:
        yield None
        return
    if type(expected) is not str or not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise ValueError("Installer source selection is invalid")
    boot = load_script("install-orbis.py", "orbis_host_source_selection")
    limits = {boot.SOURCE_LAUNCHER: 1024 * 1024, "release-manifest.json": 16 * 1024,
              boot.MANIFEST: 64 * 1024, boot.ARCHIVE: 8 * 1024 * 1024}
    with ExitStack() as pins:
        root = pins.enter_context(HOST.AUTHORITY.protected_directory(source.parent))

        def read(name, maximum):
            return pins.enter_context(HOST.AUTHORITY.protected_file(root, name, maximum))

        record = read(boot.SOURCE_SELECTION, 16384)
        selection = json.loads(record)
        if (_hash(record) != expected or not isinstance(selection, dict)
                or selection.get("schema") != "orbis.installer-source-selection.v1"
                or selection.get("mode") not in ("release", "modular") or selection.get("channel") not in ("stable", "nightly")
                or type(selection.get("proofs")) is not dict or set(selection["proofs"]) != set(limits)):
            raise ValueError("Installer selection changed before copying")
        execution = read(boot.SOURCE_EXECUTION, 4096)
        proof_bytes = {name: read(name, maximum) for name, maximum in limits.items()}
        observed = {name: {"bytes": len(body), "sha256": _hash(body)} for name, body in proof_bytes.items()}
        if observed != selection["proofs"] or json.loads(execution) != {
                "schema": "orbis.installer-source-execution.v1", "selectionSha256": expected,
                "launcherSha256": observed[boot.SOURCE_LAUNCHER]["sha256"], "channel": selection["channel"]}:
            raise ValueError("Installer execution receipt differs from the exact selection")
        identity = selection["installer"]
        manifest, files = boot.verify_source_package(proof_bytes[boot.MANIFEST], identity,
            proof_bytes[boot.ARCHIVE], mode=selection['mode'])
        if selection["mode"] == "release":
            if _hash(proof_bytes["release-manifest.json"]) != manifest["releaseManifestSha256"]:
                raise ValueError("Core manifest differs from the release-bound selection")
        if proof_bytes[boot.SOURCE_LAUNCHER] != boot._render_installer(
                selection["mode"], identity, files["scripts/install-orbis.py"]):
            raise ValueError("Installer launcher differs from the verified template")
        yield {"directory": str(source.parent), "selectionSha256": expected,
               "executionSha256": _hash(execution), "mode": selection["mode"],
               "installer": identity, "coreSha256": observed["release-manifest.json"]["sha256"],
               "inventory": manifest["files"]}


def require_selection_files(source, selection, inputs, files):
    if selection is None:
        return
    for path in files:
        record = selection["inventory"].get(path.relative_to(source.parent).as_posix())
        body = inputs.body(path)
        if record != {"size": len(body), "sha256": _hash(body)}:
            raise ValueError("Host copy input differs from verified installer membership")


def _copy_binding(info):
    return [info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode]


def _copy_file(pins, folder, name, maximum, **options):
    def observe():
        info = os.stat(name, dir_fd=folder, follow_symlinks=False)
        return [*_copy_binding(info), info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns]

    def recheck():
        if observe() != binding:
            raise ValueError("Installed Host copy file was replaced while held")

    binding = observe()
    body = pins.enter_context(HOST.AUTHORITY.protected_file(folder, name, maximum, **options))
    recheck()
    pins.callback(recheck)
    return body, binding


def _copy_snapshot(pins, directory, unit):
    source = pins.enter_context(HOST.AUTHORITY.protected_directory(directory))
    names = sorted(os.listdir(source))
    if not 1 <= len(names) <= 128 or any(not re.fullmatch(r"(?:[a-z-]+\.py|orbis-[a-z-]+\.mjs)", name)
                                            for name in names):
        raise ValueError("Host copy has an unexpected inventory")
    inventory, files = {}, {}
    for name in names:
        digest, files[name] = _copy_file(pins, source, name, 1024 * 1024, digest_only=True)
        inventory[name] = digest.removeprefix("sha256:")

    def recheck_inventory():
        if sorted(os.listdir(source)) != names:
            raise ValueError("Host copy inventory changed while held")

    recheck_inventory()
    pins.callback(recheck_inventory)
    folder = pins.enter_context(HOST.AUTHORITY.protected_directory(unit.parent, private=False))
    body, unit_binding = _copy_file(pins, folder, unit.name, 32768, private=False)
    return ({"inventory": inventory, "unitSha256": _hash(body)},
            {"fileIdentities": files, "sourceDirectory": _copy_binding(os.fstat(source)), "unit": unit_binding})


def actual_copy(directory, unit):
    """Capture private current helper source bytes independently of an installer."""
    with ExitStack() as pins:
        copied, _ = _copy_snapshot(pins, directory, unit)
        return copied


def record_source_copy(root, context, selection, expected):
    if selection is None:
        return None
    with ExitStack() as pins:
        receipt = _source_copy_receipt(pins, root, context, selection, expected)
        return _write_custody_receipt(selection, "host-copy-", receipt)


def _source_copy_receipt(pins, root, context, selection, expected):
    actual, bindings = _copy_snapshot(pins, INSTALL_DIR, UNIT_FILE)
    if actual != expected:
        raise ValueError("Actual installed Host copy differs from the verified candidate")
    config = pins.enter_context(HOST.AUTHORITY.protected_directory(ENV_FILE.parent, private=False))
    environment, bindings["environment"] = _copy_file(pins, config, ENV_FILE.name, 16384)
    environment_role(environment, root, context)
    return _receipt_bytes({"schema": "orbis.host-copy-custody.v1", "root": str(root),
        "context": context, "selection": {key: value for key, value in selection.items() if key != "inventory"},
        "installed": {**actual, "environmentSha256": _hash(environment)}, "bindings": bindings})


def record_source_copy_transition(root, context, custody, *, outcome, copy_receipt=None):
    if custody is None:
        return None
    if (outcome not in ("candidate-active", "prior-restored")
            or (outcome == "candidate-active" and not re.fullmatch(r"[a-f0-9]{64}", copy_receipt or ""))
            or (outcome == "prior-restored" and copy_receipt is not None)):
        raise ValueError("Host copy transition has an invalid outcome")
    receipt = _receipt_bytes({"schema": "orbis.host-copy-transition.v1", "root": str(root),
        "context": context, "outcome": outcome, "hostCopyCustodySha256": copy_receipt, "sources": custody})
    return _write_custody_receipt(custody["selection"], "host-copy-transition-", receipt)


def _write_custody_receipt(selection, prefix, receipt):
    digest = _hash(receipt)
    name = prefix + digest + ".json"
    pending = "." + name + ".pending"
    with HOST.AUTHORITY.protected_directory(Path(selection["directory"])) as extraction:
        folder = os.open("host-copy-custody", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                         dir_fd=extraction)
        try:
            info = os.fstat(folder)
            if info.st_uid != HOST.AUTHORITY.OWNER or stat.S_IMODE(info.st_mode) != 0o700:
                raise ValueError("Host copy custody directory is unsafe")
            _publish_custody_receipt(folder, name, pending, receipt)
            observed = os.stat("host-copy-custody", dir_fd=extraction, follow_symlinks=False)
            if _SetupSources._directory_identity(observed) != _SetupSources._directory_identity(info):
                raise ValueError("Host copy custody directory changed")
        finally:
            os.close(folder)
    return digest


def _publish_custody_receipt(folder, name, pending, receipt):
    try:
        os.stat(name, dir_fd=folder, follow_symlinks=False)
    except FileNotFoundError:
        flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
        try:
            fd = os.open(pending, flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=folder)
        except FileExistsError:
            fd = os.open(pending, flags, dir_fd=folder)
        else:
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "r+b") as output:
            before = os.fstat(output.fileno())
            existing = output.read(len(receipt) + 1)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != HOST.AUTHORITY.OWNER
                    or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) != 0o600
                    or before.st_size != len(existing) or not receipt.startswith(existing)
                    or HOST.AUTHORITY.seal(before) != HOST.AUTHORITY.seal(os.fstat(output.fileno()))):
                raise ValueError("Pending Host copy custody differs; preserve for review")
            output.write(receipt[len(existing):])
            output.flush()
            os.fsync(output.fileno())
            if HOST.AUTHORITY.seal(os.fstat(output.fileno())) != HOST.AUTHORITY.seal(
                    os.stat(pending, dir_fd=folder, follow_symlinks=False)):
                raise ValueError("Pending Host copy custody changed; preserve for review")
            os.replace(pending, name, src_dir_fd=folder, dst_dir_fd=folder)
    with HOST.AUTHORITY.protected_file(folder, name, 64 * 1024) as current:
        if current != receipt:
            raise ValueError("Existing Host copy custody differs; preserve for review")
    os.fsync(folder)

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
    for executable in ("/usr/bin/python3", "/usr/bin/systemctl", "/usr/bin/systemd-run", "/usr/bin/systemd-analyze", "/usr/bin/install"):
        if not Path(executable).is_file():
            raise ValueError(f"required host command is unavailable: {executable}")
    saved = HOST.saved_state(root)
    if not saved or saved.get("root") != str(root) or saved.get("dockerContext") != context or (saved.get("schema") != HOST.IDENTITY.RETAINED_SCHEMA and not isinstance(saved.get("tag"), str)):
        raise ValueError("this installation is not enrolled on the selected Docker context")
    manifest = SERVICE.installed_manifest(root, context)
    core = HOST.current_core(root, context)
    if core.get("state") != "running" or core.get("health") != "healthy" or core.get("image") != HOST.controller_reference(root, manifest, context):
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


def read_socket_status(*, expected_pid: int | None = None) -> dict:
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        connection.settimeout(3)
        connection.connect(str(SOCKET_FILE))
        if expected_pid is not None:
            pid, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
            if pid != expected_pid or uid != 0:
                raise ValueError("the host socket listener is not the expected root systemd process")
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
        value = json.loads(body)
        if not isinstance(value, dict):
            raise ValueError("host service status was invalid")
        return value
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


def _stage_service_files(root: Path, context: str, source: Path, *, resume: bool = False,
                         expected_sources: dict[str, str] | None = None, source_custody=None, credentials_only=False):
    """Copy exact root-owned files; callers separately establish their authority."""
    if type(credentials_only) is not bool:
        raise ValueError('Host service role must be explicit')
    files, unit = source_files(source)
    drivers = [] if expected_sources is None and source_custody is None else [
        source / "orbis-host-service-setup.py", source / "orbis-host-service-enable.py"]
    checked_files = list(dict.fromkeys([*files, *drivers]))
    with hold_source_selection(source, source_custody) as selection, _SetupSources(files, unit, drivers=drivers) as inputs:
        require_role_unit(inputs.body(unit), credentials_only=credentials_only)
        if expected_sources is not None:
            actual = {str(path.relative_to(source.parent)): _hash(inputs.body(path)) for path in [*checked_files, unit]}
            if actual != expected_sources:
                raise ValueError("host service sources differ from the reviewed setup journal")
        require_selection_files(source, selection, inputs, [*checked_files, unit])
        copied = {"inventory": {path.name: _hash(inputs.body(path)) for path in files},
                  "unitSha256": _hash(inputs.body(unit))}
        role = {'credentials_only': True} if credentials_only else {}
        _stage_source_snapshot(root, context, files, unit, inputs, resume=resume, **role)
        inputs.verify()
        return record_source_copy(root, context, selection, copied)


def _stage_source_snapshot(root: Path, context: str, files: list[Path], unit: Path, inputs: _SetupSources, *, resume: bool,
                           credentials_only=False) -> None:
    for directory in (INSTALL_DIR.parent, ENV_FILE.parent, UNIT_FILE.parent):
        if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            raise ValueError(f"setup directory is unsafe: {directory}")
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        details = directory.stat()
        if details.st_uid != 0 or stat.S_IMODE(details.st_mode) & 0o022:
            raise ValueError(f"setup directory must be root-owned and not writable by other users: {directory}")
    if INSTALL_DIR.exists() or INSTALL_DIR.is_symlink():
        if not resume or INSTALL_DIR.is_symlink() or not INSTALL_DIR.is_dir() or {file.name for file in INSTALL_DIR.iterdir()} != {file.name for file in files}:
            raise ValueError("the partial host service directory differs from its reviewed sources")
        details = INSTALL_DIR.stat()
        if details.st_uid != 0 or stat.S_IMODE(details.st_mode) != 0o700:
            raise ValueError("the partial host service directory is not private and root-owned")
        for file in files:
            _require_staged_file(INSTALL_DIR / file.name, inputs.body(file), 0o600)
    else:
        staged = Path(tempfile.mkdtemp(prefix=".host-service-", dir=INSTALL_DIR.parent))
        os.chmod(staged, 0o700)
        for file in files:
            with (staged / file.name).open("xb") as copied:
                os.fchmod(copied.fileno(), 0o600)
                copied.write(inputs.body(file))
                copied.flush()
                os.fsync(copied.fileno())
        directory = os.open(staged, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        inputs.verify()
        os.replace(staged, INSTALL_DIR)
        directory = os.open(INSTALL_DIR.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    environment = service_environment(root, context, credentials_only=credentials_only)
    for target, expected, mode in ((ENV_FILE, environment, 0o600), (UNIT_FILE, inputs.body(unit), 0o644)):
        if target.exists() or target.is_symlink():
            if not resume:
                raise ValueError("a host service configuration already exists")
            _require_staged_file(target, expected, mode)
            continue
        descriptor, temporary = tempfile.mkstemp(prefix=".host-service-", dir=target.parent)
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(expected)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        directory = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    inputs.verify()
    result = subprocess.run(["/usr/bin/systemd-analyze", "verify", str(UNIT_FILE)], capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError("systemd rejected the Orbis host service unit")
    inputs.verify()


def _require_staged_file(target: Path, expected: bytes, mode: int) -> None:
    details = target.lstat()
    if (not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_uid != 0
            or stat.S_IMODE(details.st_mode) != mode or target.read_bytes() != expected):
        raise ValueError("a partial host service source or configuration changed; preserve it for review")


def _start_service() -> None:
    run_systemctl("daemon-reload")
    run_systemctl("enable", "--now", "orbis-host.service")


def _systemd_main_pid(root: Path, context: str, *, credentials_only=False) -> int:
    properties = ("ActiveState", "SubState", "MainPID", "FragmentPath", "DropInPaths", "User", "NeedDaemonReload")
    result = subprocess.run(["/usr/bin/systemctl", "show", "orbis-host.service", *["--property=" + key for key in properties]], capture_output=True, text=True, check=False)
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if (result.returncode or set(values) != set(properties) or values["ActiveState"] != "active"
            or values["SubState"] != "running" or values["FragmentPath"] != str(UNIT_FILE)
            or values["DropInPaths"] not in ("", str(OBSERVER_DROP_IN)) or values["User"] != "root"
            or not values["MainPID"].isdigit()):
        raise ValueError("the expected root systemd host service is not running")
    if values["DropInPaths"]:
        if values["NeedDaemonReload"] != "no":
            raise ValueError("the observer drop-in needs a systemd reload")
        with HOST.AUTHORITY.protected_directory(OBSERVER_DROP_IN.parent, private=False) as directory:
            with HOST.AUTHORITY.protected_file(directory, OBSERVER_DROP_IN.name, 4096, private=False) as content:
                if content != OBSERVER_DROP_IN_CONTENT:
                    raise ValueError("the observer drop-in differs from the managed profile")
    pid = int(values["MainPID"])
    expected = ["/usr/bin/python3", str(INSTALL_DIR / "orbis-host-service.py"), "--root", str(root),
                "--docker-context", context, "--socket", str(SOCKET_FILE), "--snapshots", "/var/lib/orbis/snapshots", "--state-dir", "/var/lib/orbis/state"]
    if credentials_only:
        expected.append('--credentials-only')
    process = Path("/proc") / str(pid)
    if pid <= 1 or process.stat().st_uid != 0 or (process / "cmdline").read_bytes() != b"\0".join(item.encode() for item in expected) + b"\0":
        raise ValueError("the systemd host service process does not match the installed helper")
    return pid


def authenticated_socket_status(root: Path, context: str, *, credentials_only=False) -> dict:
    details = SOCKET_FILE.lstat()
    parent = SOCKET_FILE.parent.lstat()
    if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or stat.S_IMODE(parent.st_mode) != 0o700
            or not stat.S_ISSOCK(details.st_mode) or details.st_uid != 0 or stat.S_IMODE(details.st_mode) != 0o600):
        raise ValueError("the host service socket is not private and root-owned")
    role = {'credentials_only': True} if credentials_only else {}
    pid = _systemd_main_pid(root, context, **role)
    status = read_socket_status(expected_pid=pid)
    if _systemd_main_pid(root, context, **role) != pid:
        raise ValueError("the host service process changed during authentication")
    if credentials_only and (status.get('serviceRole') != 'credentials-only' or type(status.get('credentialProtocol')) is not int
                             or status.get('credentialProtocol') != 1
                             or status.get('capabilities') != []):
        raise ValueError('The authenticated account security listener has a different role')
    return status


def _verify_service(root: Path, context: str, ready: dict, *, credentials_only=False) -> dict:
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        try:
            role = {'credentials_only': True} if credentials_only else {}
            status = authenticated_socket_status(root, context, **role)
            inside = HOST.docker(context, ["exec", "runtipi", "curl", "-fsS", "--unix-socket", str(SOCKET_FILE), "http://localhost/v1/status"], root)
            if (status.get("enrolled") and status.get("coreHealth") == "healthy" and status.get("imageMatches")
                    and status.get("currentDigest") == ready["digest"] and inside.returncode == 0
                    and json.loads(inside.stdout).get("currentDigest") == ready["digest"]
                    and (not credentials_only or (json.loads(inside.stdout).get('serviceRole') == 'credentials-only'
                                                  and type(json.loads(inside.stdout).get('credentialProtocol')) is int
                                                  and json.loads(inside.stdout).get('credentialProtocol') == 1))):
                return {**ready, "service": "active", "socket": str(SOCKET_FILE)}
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        time.sleep(0.4)
    raise RuntimeError("host service did not report the enrolled healthy core")


def install_locked(root: Path, context: str, source: Path, *, resume: bool = False) -> dict[str, str]:
    ready = preflight(root, context, source, allow_existing=True) if resume else preflight(root, context, source)
    # Interrupted copies remain available for an exact-source resume and diagnosis.
    _stage_service_files(root, context, source, resume=resume)
    _start_service()
    verified = _verify_service(root, context, ready)
    runtime = load_script("orbis-host-core-runtime-install.py", "orbis_core_runtime_setup")
    runtime.install_current_locked(root, context, HOST, lambda: SERVICE.installed_manifest(root, context))
    return verified


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
