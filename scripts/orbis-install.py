#!/usr/bin/env python3
"""Install Orbis or replace a discovered Runtipi installation on this host."""

import argparse
import ast
from contextlib import ExitStack, contextmanager, nullcontext
import hashlib
import ipaddress
import json
import os
import platform
import re
import shutil
import shlex
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path


def load(name, module_name):
    import importlib.util
    spec = importlib.util.spec_from_file_location(module_name, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


REPLACE = load("orbis-install-replace.py", "orbis_guided_replace")
HOST = REPLACE.HOST
APPS = REPLACE.APPS
UI = load("orbis-install-ui.py", "orbis_guided_ui")
CHANNELS = load("orbis-host-service.py", "orbis_guided_channels")
BOOT = load("install-orbis.py", "orbis_guided_platform")
PREREQUISITES = load("orbis-install-prerequisites.py", "orbis_guided_prerequisites")
SENTINEL = load("orbis-sentinel-install.py", "orbis_guided_sentinel")
OWNERSHIP = load("orbis-host-ownership-bootstrap.py", "orbis_guided_ownership_storage")
UPGRADE_SOURCE_CHECK_PROTOCOL = 'orbis.component-upgrade-source-check.v1'


DOCKER_INSTALL_HELP = "Install Docker Engine and the Docker Compose plugin first, then rerun this installer. For 64-bit Raspberry Pi OS or Debian: https://docs.docker.com/engine/install/debian/ ; for Ubuntu: https://docs.docker.com/engine/install/ubuntu/ . Automatic setup supports the local default Docker context on 64-bit Debian 12/13 and Ubuntu 22.04/24.04; other layouts need a separate review."


def require_docker_prerequisites(reader, *, state_dir=None, accepted=False, inspect_only=False, check_engine=False):
    terminal = None
    declined = False

    def ask(question):
        nonlocal terminal, declined
        if terminal is None:
            terminal = Terminal()
        while True:
            answer = terminal.ask(question).strip().lower()
            if answer in {"y", "yes"}:
                declined = False
                return "y"
            if answer in {"", "n", "no"}:
                declined = True
                return "n"
            print("Enter y to continue or n to cancel.", file=sys.stderr)

    def check():
        if state_dir is not None:
            PREREQUISITES.prepare(reader.context, state_dir, accepted=accepted, ask=None if accepted else ask, inspect_only=inspect_only)
        if shutil.which("docker") is None:
            raise ValueError("Docker was not found. " + DOCKER_INSTALL_HELP)
        try:
            version = reader._read(["compose", "version", "--short"])
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            raise ValueError("The Docker Compose plugin could not be used. " + DOCKER_INSTALL_HELP) from error
        match = re.fullmatch(r"v?(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", version) if isinstance(version, str) else None
        if match is None or int(match[1]) < 2:
            raise ValueError("A supported Docker Compose plugin was not found. " + DOCKER_INSTALL_HELP)
        if check_engine:
            REPLACE.Engine(reader)

    try:
        while True:
            declined = False
            try:
                check()
                return
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                if state_dir is None or accepted or inspect_only or declined:
                    raise
                print(f"Required setup did not finish: {error}", file=sys.stderr)
                while True:
                    answer = ask("Retry required setup and any pending recovery? [y/N]: ").strip().lower()
                    if answer in {"", "n", "no"}:
                        raise ValueError("Installation cancelled; any recovery files were preserved") from error
                    if answer in {"y", "yes"}:
                        break
                    print("Enter y to retry or n to cancel.", file=sys.stderr)
    finally:
        if terminal:
            terminal.close()


def acknowledge_release_channel(manifest, accepted=False, ask=None, *, channel=None):
    if (channel or ("stable" if HOST.PLAN.POLICY.is_stable_release_tag(manifest["tag"]) else "nightly")) == "stable":
        return
    warning = "Nightly builds can contain incomplete features or regressions. Returning to Stable requires a compatible Stable installation."
    if accepted:
        print(warning)
        return
    if ask is None or ask(warning + "\nInstall this Nightly build and follow Nightly updates? [y/N]: ").strip().lower() != "y":
        raise ValueError("Nightly installation was not approved. Use --accept-nightly only after reviewing this warning")


class Terminal:
    def __init__(self):
        self.reader = open("/dev/tty", "r", encoding="utf-8")
        try:
            self.writer = open("/dev/tty", "w", encoding="utf-8")
        except OSError:
            self.reader.close()
            raise

    def ask(self, question):
        self.writer.write(question)
        self.writer.flush()
        answer = self.reader.readline()
        if not answer:
            raise ValueError("Installation cancelled")
        return answer

    def close(self):
        self.reader.close()
        self.writer.close()


def safe_root(path):
    path = path.expanduser().absolute()
    if path != path.resolve(strict=False) or any(ord(char) < 32 or ord(char) == 127 for char in str(path)):
        raise ValueError("Choose an absolute installation path without symlinks or control characters")
    return path


def browser_address(root):
    """Read only the dashboard address fields; never evaluate shell content."""
    try:
        descriptor = os.open(root / ".env", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
            details = os.fstat(stream.fileno())
            if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_size > 1024 * 1024:
                return None
            content = stream.read(1024 * 1024 + 1)
        if len(content) > 1024 * 1024:
            return None
        values = {}
        for line in content.splitlines():
            match = re.fullmatch(r"\s*(?:export\s+)?(INTERNAL_IP|NGINX_PORT)\s*=(.*)", line)
            if match:
                value = shlex.split(match[2], comments=True)
                if len(value) != 1:
                    return None
                values[match[1]] = value[0]
        address = ipaddress.ip_address(values.get("INTERNAL_IP", ""))
        if address.is_unspecified or address.is_multicast or address.is_loopback or "%" in str(address):
            return None
        port_text = values.get("NGINX_PORT", "80")
        if not re.fullmatch(r"[0-9]{1,5}", port_text) or not 1 <= int(port_text) <= 65535:
            return None
        host = f"[{address}]" if address.version == 6 else str(address)
        suffix = "" if int(port_text) == 80 else f":{int(port_text)}"
        return f"http://{host}{suffix}"
    except (OSError, UnicodeError, ValueError):
        return None


def show_browser_address(root):
    address = browser_address(root)
    if address:
        print(f"\nOpen Orbis in your browser:\n  {address}\n\nSign in or create your administrator account.")
    else:
        print("\nThe dashboard address could not be determined. Check the server's LAN address and dashboard port.")


def select_installation(report, root=None, ask=None):
    installations = report["installations"]
    recovery = report.get("recoveryTargets", [])
    if any(root is None or item.get("root") == str(root) for item in recovery):
        raise ValueError("Protected controller recovery artifacts need review before installing or updating this root")
    if root is not None:
        matches = [item for item in installations if item.get("installRoot") == str(root)]
        if len(matches) > 1:
            raise ValueError("Multiple controllers use that installation; resolve the conflict first")
        if matches:
            return matches[0]
        if installations:
            raise ValueError("Another controller already occupies this Docker host; select its installation root")
        return None
    if len(installations) == 1:
        return installations[0]
    if not installations:
        return None
    if ask is None:
        raise ValueError("Several installations were found; provide --root")
    print("Installations found:")
    for index, item in enumerate(installations, 1):
        print(f"  {index}. {item['product']} {item.get('version') or ''} — {item.get('installRoot') or 'unconfirmed root'}")
    while True:
        answer = ask("Select an installation number: ").strip()
        if answer.isascii() and answer.isdigit() and len(answer) <= len(str(len(installations))) and 1 <= int(answer) <= len(installations):
            return installations[int(answer) - 1]
        print(f"Enter a number from 1 to {len(installations)} to select an installation.", file=sys.stderr)


def semantic_review(value):
    return REPLACE.semantic_review(value)


def prepare_backup_tools(display):
    REPLACE.TX.RESTORE.runtime()


def executor_failure(path):
    try:
        with path.open() as stream:
            value = json.loads(stream.read(16385))
        if value.get("schema") == REPLACE.SCHEMA and value.get("result") == "replacement-failed" and isinstance(value.get("message"), str):
            return " ".join(value["message"].split())[:800]
    except (OSError, ValueError, AttributeError):
        pass
    return "The replacement executor could not finish"


def command(arguments, out, err):
    with out.open("xb") as stdout, err.open("xb") as stderr:
        result = subprocess.run([sys.executable, *arguments], stdout=stdout, stderr=stderr, check=False)
    return result.returncode


def recover_pending(root, reader, state, ask, *, writers_stopped=False):
    path = OWNERSHIP.installer_pointer_path(HOST, root, reader.context)
    if not path.exists() and not path.is_symlink():
        return None
    marker = REPLACE.TX.RESTORE.private_json(path)
    if marker.get("schema") not in {"orbis.installer-pointer.v1", "orbis.installer-pointer.v2"} or marker.get("root") != str(root) or marker.get("dockerContext") != reader.context or marker.get("kind") not in {"new", "replacement"}:
        raise ValueError("The installation recovery marker needs local review")
    storage = OWNERSHIP.verify_installer_storage(HOST, root, marker.get('installerStorage'), reader.context)
    if (storage is not None) != (marker.get('schema') == 'orbis.installer-pointer.v2'):
        raise ValueError('The installation marker does not match its protected storage')
    journal = Path(marker["journal"])
    if not journal.exists():
        return None
    record = REPLACE.TX.RESTORE.private_json(journal)
    scope = record.get("review") if marker["kind"] == "replacement" else record
    if not isinstance(scope, dict) or scope.get("root") != str(root) or scope.get("dockerContext") != reader.context:
        raise ValueError("The recovery journal belongs to another installation")
    if marker['kind'] == 'new':
        OWNERSHIP.verify_installer_storage(HOST, root, scope.get('installerStorage'), reader.context)
    fresh = marker['kind'] == 'replacement' and scope.get('mode') == 'fresh'
    if record.get("stage") in {"complete", "rolled-back"}:
        if not fresh:
            return None
        if scope.get('ownershipProtocol') != REPLACE.OWNERSHIP_PROTOCOL or record.get('ownershipProtocol') != REPLACE.OWNERSHIP_PROTOCOL:
            REPLACE.require_ownership_authority('fresh')
        try:
            HOST.CREDENTIAL_FENCE.require_clear(HOST, root)
        except (OSError, ValueError):
            pass
        else:
            # This only skips an old installer; it grants no ownership or
            # enrollment. Subsequent installation paths verify their own state.
            return None
    # The saved executor remains hash-pinned and can predate today's boundary.
    # Do not dispatch any Fresh recovery (including automatic rollback) on its
    # stage/JWT receipt alone. Keep/new recovery retains its existing checks.
    if marker['kind'] == 'replacement':
        if not fresh or scope.get('ownershipProtocol') != REPLACE.OWNERSHIP_PROTOCOL or record.get('ownershipProtocol') != REPLACE.OWNERSHIP_PROTOCOL:
            REPLACE.require_ownership_authority(scope.get('mode'))
    if marker["kind"] == "replacement" and not writers_stopped:
        if ask is None or ask("Stop native and remote storage writers before recovery. Ready? [y/N]: ").strip().lower() != "y":
            raise ValueError("Interrupted replacement recovery requires stopped native and remote writers")
    if ask is not None and ask(f"Resume the interrupted installation at {root}? [Y/n]: ").strip().lower() not in {"", "y"}:
        raise ValueError("Recovery cancelled; the journal was preserved")
    executor = Path(marker["executor"])
    if executor.is_symlink() or not executor.is_file() or executor.stat().st_uid != os.geteuid() or hashlib.sha256(executor.read_bytes()).hexdigest() != marker["executorSha256"]:
        raise ValueError("The original verified recovery executor is missing or changed")
    expected_name = "orbis-install-new.py" if marker["kind"] == "new" else "orbis-install-replace.py"
    if executor.name != expected_name:
        raise ValueError("The recovery executor has an unexpected name")
    private = load("install-orbis.py", "orbis_recovery_private")
    private.private_directory(state)
    name = "recovery-" + str(uuid.uuid4())
    arguments = [str(executor), "recover", str(root), "--docker-context", reader.context, "--journal", str(journal), "--confirm-root", str(root)]
    if marker["kind"] == "replacement":
        arguments.append("--host-writers-stopped")
    with verified_storage_executor(executor, marker), verified_fresh_executor(executor, marker, scope) if fresh else nullcontext():
        OWNERSHIP.verify_installer_storage(HOST, root, storage, reader.context)
        code = command(arguments, state / (name + ".stdout.json"), state / (name + ".stderr.json"))
        OWNERSHIP.verify_installer_storage(HOST, root, storage, reader.context)
    if code:
        raise ValueError(f"Recovery did not finish. Preserve {journal} and the private logs in {state}")
    return json.loads((state / (name + ".stdout.json")).read_text())


@contextmanager
def verified_storage_executor(executor, marker):
    if marker.get('schema') != 'orbis.installer-pointer.v2':
        yield
        return
    if marker.get('executorStorageProtocol') != OWNERSHIP.INSTALLER_STORAGE_PROTOCOL:
        raise ValueError('The original executor lacks the protected installer storage protocol')
    pin = OWNERSHIP.C.PinnedFile(executor, limit=1024 * 1024)
    try:
        if hashlib.sha256(pin.body).hexdigest() != marker.get('executorSha256'):
            raise ValueError('The original protected installer executor changed')
        try:
            tree = ast.parse(pin.body)
        except (SyntaxError, ValueError):
            raise ValueError('The original protected installer executor is invalid') from None
        declarations = [node.value.value for node in tree.body if isinstance(node, ast.Assign)
                        and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                        and node.targets[0].id == 'INSTALLER_STORAGE_PROTOCOL' and isinstance(node.value, ast.Constant)]
        if declarations != [OWNERSHIP.INSTALLER_STORAGE_PROTOCOL]:
            raise ValueError('The original executor cannot use protected installer storage')
        pin.verify()
        yield
        pin.verify()
    finally:
        pin.close()


@contextmanager
def verified_fresh_executor(executor, marker, scope):
    """Hold every verified original package member before Fresh dispatch."""
    expected = marker.get('sourceCustodySha256')
    if (scope.get('ownershipProtocol') != REPLACE.OWNERSHIP_PROTOCOL or type(expected) is not str
            or not re.fullmatch(r'[a-f0-9]{64}', expected)):
        raise ValueError('Fresh recovery requires its verified original installer source custody')
    setup = load('orbis-host-service-setup.py', 'orbis_fresh_executor_custody')
    with setup.hold_source_selection(executor.parent, expected) as selection, ExitStack() as opened:
        if selection is None or selection['directory'] != str(executor.parent.parent):
            raise ValueError('Fresh executor belongs to a different verified extraction')
        core = REPLACE.OWNERSHIP.L.C.PinnedFile(executor.parent.parent / 'release-manifest.json', limit=16384)
        opened.callback(core.close)
        if hashlib.sha256(core.body).hexdigest() != selection['coreSha256'] or json.loads(core.body) != scope.get('target'):
            raise ValueError('Fresh target differs from the original installer selection')
        pins = []
        executor_body = None
        for name, identity in selection['inventory'].items():
            pin = REPLACE.OWNERSHIP.L.C.PinnedFile(executor.parent.parent / name, limit=1024 * 1024)
            opened.callback(pin.close); pins.append(pin)
            if {'size': len(pin.body), 'sha256': hashlib.sha256(pin.body).hexdigest()} != identity:
                raise ValueError('Fresh executor dependency differs from its verified package')
            if pin.path == executor:
                executor_body = pin.body
        if executor_body is None or hashlib.sha256(executor_body).hexdigest() != marker.get('executorSha256'):
            raise ValueError('The original Fresh executor changed')
        tree = ast.parse(executor_body)
        declarations = [node.value.value for node in tree.body if isinstance(node, ast.Assign)
                        and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                        and node.targets[0].id == 'OWNERSHIP_PROTOCOL' and isinstance(node.value, ast.Constant)]
        if declarations != [REPLACE.OWNERSHIP_PROTOCOL]:
            raise ValueError('The original executor lacks the protected Fresh protocol')
        for pin in pins: pin.verify()
        yield
        core.verify()
        for pin in pins: pin.verify()


def replacement(root, reader, manifest, state, mode, confirm, display=None, *, backup_scope="controller", source_custody=None):
    if mode == 'fresh' and source_custody is None:
        raise ValueError('Fresh requires the original verified installer source custody')
    REPLACE.TX.RESTORE.runtime()
    run = state / ("replacement-" + str(uuid.uuid4()))
    run.mkdir(mode=0o700)
    backup, journal = run / "backup", run / "transaction.json"
    review_path = run / "review.json"
    display = display or UI.Presentation(interactive=False)
    with display.step("Reviewing app ownership and backup storage"):
        try:
            if mode == 'fresh':
                with HOST.credential_fence_lock(root, reader.context) as guard:
                    reader.lock_fd = HOST.LOCK_DESCRIPTOR.get()
                    review = REPLACE.review(root, reader, manifest, backup, journal, mode=mode, backup_scope=backup_scope, ownership=guard)
            else:
                with HOST.host_lock(root) as descriptor:
                    reader.lock_fd = descriptor
                    review = REPLACE.review(root, reader, manifest, backup, journal, mode=mode, backup_scope=backup_scope)
        finally:
            reader.lock_fd = None
    APPS.write_journal(review_path, review)
    storage = review["checkpoint"]["storage"]
    count = len(storage["preservedAppContainers"]) if backup_scope == "controller" else list(review["checkpoint"]["roles"].values()).count("app")
    print(f"\nInstallation: {root}\nRelease: {UI.display_release(manifest['tag'])}\nMode: {mode.title()}\nApp containers: {count}\nBackup: {backup}\n")
    if mode == "fresh":
        print("Fresh removes dashboard accounts, saved links and workspace preferences. Apps and their data are retained. Existing logins will be revoked.")
    else:
        print("Keep preserves accounts, settings, installed apps and their data.")
    if backup_scope == "controller":
        print("App containers keep running. The backup covers Runtipi configuration and control services; app data is excluded. Control services pause briefly during replacement.")
    else:
        print("The full backup pauses managed apps and control services, including their persistent data.")
    confirm(root)
    script = str(Path(__file__).with_name("orbis-install-replace.py"))
    marker = {"schema": "orbis.installer-pointer.v1", "root": str(root), "dockerContext": reader.context, "kind": "replacement", "journal": str(journal), "executor": script, "executorSha256": hashlib.sha256(Path(script).read_bytes()).hexdigest()}
    if source_custody is not None: marker['sourceCustodySha256'] = source_custody
    storage = OWNERSHIP.installer_storage(HOST, root, reader.context)
    if storage is not None:
        marker.update(schema='orbis.installer-pointer.v2', installerStorage=storage,
                      executorStorageProtocol=OWNERSHIP.INSTALLER_STORAGE_PROTOCOL)
    APPS.write_journal(OWNERSHIP.installer_pointer_path(HOST, root, reader.context), marker)
    arguments = [script, "apply", str(root), "--docker-context", reader.context, "--mode", mode, "--review", str(review_path), "--journal", str(journal), "--confirm-root", str(root), "--host-writers-stopped"]
    code = None
    output, errors = run / "apply-0.stdout.json", run / "apply-0.stderr.json"
    with display.step("Backing up storage and replacing the controller", completed=lambda: code == 0):
        with verified_storage_executor(Path(script), marker), verified_fresh_executor(Path(script), marker, review) if mode == 'fresh' else nullcontext():
            code = command(arguments, output, errors)
        if code:
            reason = executor_failure(errors)
            if not journal.exists():
                raise ValueError(f"{reason}. Nothing was replaced. Private logs: {run}")
            record = REPLACE.TX.RESTORE.private_json(journal)
            if record.get("stage") == "rolled-back":
                reason = record.get("failure", {}).get("message") or reason
                raise ValueError(f"{reason}. The original Runtipi installation was recovered. Private logs: {run}")
            raise ValueError(f"{reason}. Preserve {run}. Recover with: python3 {script} recover {root} --docker-context {reader.context} --journal {journal} --confirm-root {root} --host-writers-stopped")
    result = json.loads(output.read_text())
    if result.get("result") != "orbis-installed" or result.get("mode") != mode:
        raise ValueError("The executor did not report a completed installation; preserve its journal")
    return result


def release_order(tag):
    match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?", tag)
    if not match:
        raise ValueError("The installed release cannot be compared safely; use the Update Center")
    pre = match[4]
    identifiers = tuple((0, int(part)) if part.isdigit() else (1, part) for part in (pre or "").split("."))
    return (*map(int, match.group(1, 2, 3)), int(pre is None), identifiers if pre else ())


def host_request(socket_path, endpoint, body=None):
    connection = REPLACE.UnixConnection(str(socket_path))
    connection.timeout = 120
    try:
        payload = None if body is None else json.dumps(body)
        connection.request("GET" if body is None else "POST", endpoint, payload, {"Content-Type": "application/json"})
        response = connection.getresponse()
        raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("The update service response exceeded its limit")
        result = json.loads(raw)
        if not 200 <= response.status < 300:
            raise ValueError(result.get("error", "The update request was rejected"))
        if not isinstance(result, dict):
            raise ValueError("The update service returned an invalid response")
        return result
    finally:
        connection.close()


class HostServiceCompatibilityError(ValueError):
    code = "host-service-capabilities-unsupported"


def require_helper_capabilities(status):
    required = {"restart.v1", "packages.refresh.v1", "release-channels.v1"}
    actual = status.get("capabilities") if isinstance(status, dict) else None
    if not isinstance(actual, list) or not all(isinstance(value, str) for value in actual) or not required.issubset(actual):
        raise HostServiceCompatibilityError("The host service did not confirm the required update capabilities. Repair or upgrade it before retrying; no core update was started")


def prepare_sentinel(display, state_dir):
    state = BOOT.private_directory(state_dir or Path('/var/lib/orbis/installer'))
    with display.step("Preparing Sentinel"):
        return SENTINEL.prepare(state)


def activate_sentinel(display, prepared):
    with display.step("Enabling Sentinel"):
        return SENTINEL.activate(prepared)


def update_existing(root, reader, target, display, *, without_host_service=False, selected_channel=None, state_dir=None, source_custody=None):
    upgrade = load("orbis-host-service-upgrade.py", "orbis_guided_helper_upgrade")
    current = upgrade.SERVICE.installed_manifest(root, reader.context)
    channel = upgrade.SERVICE.read_channel(root)
    target_nightly = (selected_channel or ("stable" if HOST.PLAN.POLICY.is_stable_release_tag(target["tag"]) else "nightly")) == "nightly"
    if without_host_service and (channel["channel"] == "nightly" or target_nightly):
        raise ValueError("Nightly updates and returning to Stable require the host service; no update was made")
    if release_order(target["tag"]) < release_order(current["tag"]):
        raise ValueError(f"Installed {UI.display_release(current['tag'])} is newer than this installer. Use the latest installer; no downgrade was made")
    if current["tag"] == target["tag"] and current["digest"] != target["digest"]:
        raise ValueError("The same release tag has a different digest; inspect its published identity before updating")
    cross_base = HOST.PLAN.is_runtipi_412_upgrade(current, target)
    socket_path = upgrade.SETUP.SOCKET_FILE
    if cross_base:
        if without_host_service:
            raise ValueError("The compatibility upgrade requires an enrolled coordinating Orbis Host service")
        try:
            status = host_request(socket_path, "/v1/status")
        except OSError as error:
            raise HostServiceCompatibilityError("Install and verify the same-base Orbis Host update before changing the compatibility base") from error
        capabilities = status.get("capabilities")
        if (status.get("enrolled") is not True or status.get("imageMatches") is not True
                or status.get("coreHealth") != "healthy"
                or status.get("currentDigest") != current["digest"]
                or not isinstance(capabilities, list) or "runtipi-412-update.v1" not in capabilities):
            raise HostServiceCompatibilityError("Install and verify the same-base Orbis Host update before changing the compatibility base")
    requires_backup_tools = cross_base or target.get("installationProtocol") != HOST.PLAN.INSTALLATION_PROTOCOL
    missing_backup_tools = requires_backup_tools and not shutil.which("rsync")
    display.set_remaining_steps((3 if cross_base else 6) + int(missing_backup_tools))
    with display.step("Verifying the Orbis release"):
        REPLACE.UPDATE.verify_release(target)
    if requires_backup_tools:
        prepare_backup_tools(display)
    if not cross_base:
        prepared_sentinel = prepare_sentinel(display, state_dir)
        activate_sentinel(display, prepared_sentinel)
        with display.step("Updating account security" if without_host_service else "Updating the host service"):
            enable = load("orbis-host-service-enable.py", "orbis_guided_update_enable")
            custody = {"source_custody": source_custody} if source_custody is not None else {}
            role = {'credentials_only': True} if without_host_service else {}
            enable.enable(root, reader.context, Path(__file__).parent, **custody, **role)
            upgrade.upgrade(root, reader.context, Path(__file__).parent, str(root), **custody)
    credentials_only = upgrade.SETUP.installed_credentials_only(root, reader.context)
    # A later installer run retains a previously selected narrow role even
    # when the flag is omitted; it must not attempt administrative RPCs.
    without_host_service = without_host_service or credentials_only
    if without_host_service and (channel['channel'] == 'nightly' or target_nightly):
        raise ValueError('Nightly updates and returning to Stable require system administration; no core update was started')
    if without_host_service:
        role = {'credentials_only': True} if credentials_only else {}
        status = upgrade.SETUP.authenticated_socket_status(root, reader.context, **role)
        if type(status.get('credentialProtocol')) is not int or status['credentialProtocol'] != 1:
            raise HostServiceCompatibilityError('The account security service could not be verified; no core update was started')
    if not without_host_service:
        require_helper_capabilities(host_request(socket_path, "/v1/status"))
    if target_nightly and channel["channel"] != "nightly":
        host_request(socket_path, "/v1/channel", {"channel": "nightly", "revision": channel["revision"], "acknowledgeNightly": True})
        channel = upgrade.SERVICE.read_channel(root)
    if current["digest"] == target["digest"]:
        if channel["channel"] == "nightly" and not target_nightly:
            host_request(socket_path, "/v1/channel", {"channel": "stable", "revision": channel["revision"]})
        print(f"Orbis {UI.display_release(current['tag'])} is up to date at {root}.")
        return {"result": "up-to-date", "releaseTag": current["tag"]}
    if without_host_service:
        private = load("install-orbis.py", "orbis_guided_update_private")
        snapshots = private.private_directory(Path("/var/lib/orbis/snapshots"))
        snapshot = snapshots / ("orbis-" + target["tag"] + "-" + str(uuid.uuid4()))
        with display.step("Updating Orbis and verifying server health"):
            return REPLACE.UPDATE.apply_update(root, current, target, reader.context, snapshot)
    with display.step("Checking the release and update readiness"):
        request = {"tag": target["tag"]}
        if channel["channel"] == "nightly" and not target_nightly:
            request["returnToStable"] = True
        checked = host_request(socket_path, "/v1/plan", request)
        if checked.get("targetTag") != target["tag"] or checked.get("targetDigest") != target["digest"]:
            raise ValueError("The checked update does not match the verified installer release")
        if cross_base and checked.get("backupPolicy") != "automatic":
            raise ValueError("The Host service did not confirm the required compatibility upgrade backup")
    with display.step("Updating Orbis and verifying server health"):
        try:
            accepted = host_request(socket_path, "/v1/apply", {"planId": checked["planId"]})
        except OSError as error:
            status = host_request(socket_path, "/v1/status")
            observed = status.get("job") or {}
            if observed.get("id") != checked["planId"]:
                raise ValueError(f"Update acknowledgement was lost. Inspect job {checked['planId']} in Updates before retrying") from error
            accepted = {"jobId": observed["id"], "state": observed["state"]}
        job_id = accepted.get("jobId")
        if job_id != checked["planId"]:
            raise ValueError("Update acknowledgement changed. Check Updates before retrying")
        deadline = time.monotonic() + 1800
        while time.monotonic() < deadline:
            try:
                status = host_request(socket_path, "/v1/status")
            except OSError:
                # The coordinated update replaces this listener. Keep observing
                # the accepted job without resubmitting it during that gap.
                time.sleep(1)
                continue
            job = status.get("job") or {}
            if job.get("id") != job_id:
                raise ValueError(f"The update status changed. Inspect job {job_id} before retrying")
            if job.get("state") == "complete":
                if status.get("currentDigest") != target["digest"] or not status.get("imageMatches") or status.get("coreHealth") != "healthy":
                    raise ValueError("The update finished without the expected healthy image; inspect Updates before retrying")
                return {"result": "orbis-updated", "releaseTag": target["tag"], "jobId": job_id}
            if job.get("state") not in {"queued", "running"}:
                message = str(job.get('message') or 'The update needs attention').rstrip().rstrip('.')
                raise ValueError(f"{message}. Job: {job_id}. Check Updates before trying again")
            time.sleep(1)
        raise ValueError(f"Update {job_id} is still running. Follow it in Updates; do not start another update")


def verify_upgrade_source(args, custody):
    """A source-only acknowledgement after the genuine launcher continuation."""
    SENTINEL.require_host()
    if custody is None:
        raise ValueError('Upgrade source checking requires genuine installer execution custody')
    source = Path(__file__).resolve(strict=True).parent
    setup = load('orbis-host-service-setup.py', 'orbis_source_check_setup')
    with setup.hold_source_selection(source, custody) as selected:
        if selected is None or selected['mode'] != 'release':
            raise ValueError('Upgrade source checking requires a release-bound selection')
        with setup.HOST.AUTHORITY.protected_directory(source.parent) as folder:
            with setup.HOST.AUTHORITY.protected_file(folder, BOOT.SOURCE_SELECTION, 16384) as selection_body:
                if hashlib.sha256(selection_body).hexdigest() != custody:
                    raise ValueError('Upgrade source selection changed')
                selected_channel = json.loads(selection_body)['channel']
            with setup.HOST.AUTHORITY.protected_file(folder, 'release-manifest.json', 16384) as body:
                core = HOST.PLAN.validate_manifest(json.loads(body))
                if (hashlib.sha256(body).hexdigest() != selected['coreSha256']
                        or selected['installer']['tag'] != core['tag']
                        or selected['installer']['commit'] != core['commit']
                        or args.channel != selected_channel):
                    raise ValueError('Upgrade source differs from its executed selection')
        print(json.dumps({'schema': UPGRADE_SOURCE_CHECK_PROTOCOL, 'selectionSha256': custody,
            'executionSha256': selected['executionSha256'], 'coreSha256': selected['coreSha256'],
            'core': core}, sort_keys=True))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--installer-custody-sha256", help=argparse.SUPPRESS)
    parser.add_argument('--verify-upgrade-source', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument("--docker-context", default="default")
    parser.add_argument("--root", type=Path)
    parser.add_argument("--mode", choices=("keep", "fresh"))
    parser.add_argument("--backup-scope", choices=("controller", "full"), default="controller", help="back up control services while apps run (default), or pause apps for a full backup")
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--yes", action="store_true")
    parser.add_argument("--accept-nightly", action="store_true", help="acknowledge Nightly risks and follow Nightly updates")
    parser.add_argument("--channel", choices=("stable", "nightly"), help="keep following the selected release channel")
    parser.add_argument("--host-writers-stopped", action="store_true")
    parser.add_argument("--without-host-service", action="store_true", help="skip optional host administration; account security and Sentinel remain enabled")
    parser.add_argument("--no-animation", action="store_true", help="show static installation progress")
    parser.add_argument("--no-color", action="store_true", help="disable terminal colours")
    parser.add_argument("--http-port", type=int, default=80)
    parser.add_argument("--https-port", type=int, default=443)
    parser.add_argument("--server-ip")
    parser.add_argument('--approved-reset-plan-sha256', help='separately reviewed reset storage digest for a new installation in protected layout storage')
    args = parser.parse_args()
    custody = args.installer_custody_sha256
    if custody is not None:
        extraction = Path(__file__).resolve().parent.parent
        if (not re.fullmatch(r"[a-f0-9]{64}", custody)
                or args.manifest != extraction / "release-manifest.json"
                or args.state_dir != extraction / "transactions"):
            raise ValueError("Installer source custody does not match this extraction")
    custody_options = {"source_custody": custody} if custody is not None else {}

    BOOT.require_supported_host()
    if args.verify_upgrade_source:
        return verify_upgrade_source(args, custody)
    manifest = HOST.PLAN.require_installation_protocol(json.loads(args.manifest.read_text()))
    channel = args.channel or ("stable" if HOST.PLAN.POLICY.is_stable_release_tag(manifest["tag"]) else "nightly")
    if not HOST.PLAN.POLICY.release_allowed_on_channel(manifest["tag"], channel):
        raise ValueError("This release is not available on the selected update channel")
    if channel == "nightly" and args.yes and not args.accept_nightly:
        raise ValueError("Nightly installation was not approved. Use --accept-nightly only after reviewing this warning")
    if not args.inspect:
        SENTINEL.require_host()
    reader = APPS.Docker(args.docker_context)
    require_docker_prerequisites(reader, state_dir=args.state_dir, accepted=args.yes, inspect_only=args.inspect, check_engine=True)
    if args.inspect:
        report = APPS.DETECT.discover(reader)
        print(json.dumps(report, indent=2))
        return 0
    display = UI.Presentation(interactive=not args.yes, color=not args.no_color, animation=not args.no_animation)
    display.banner(manifest["tag"])
    with display.step("Detecting existing installations"):
        report = APPS.DETECT.discover(reader, resolve_app_owners=APPS.local_app_owners, resolve_registered_app_owners=APPS.local_registered_app_owners)
    tty = None
    try:
        if not args.yes:
            try:
                tty = Terminal()
            except OSError as error:
                raise ValueError("An interactive terminal is required, or provide --yes with an explicit --root and mode") from error
        elif args.root is None:
            raise ValueError("Unattended installation requires an explicit --root")

        def ask(question):
            if tty is None:
                raise ValueError("An interactive terminal is required")
            return tty.ask(question)

        acknowledge_release_channel(manifest, args.accept_nightly, None if args.yes else ask, channel=channel)

        supplied_root = safe_root(args.root) if args.root else None
        roots = {item["installRoot"] for item in report["installations"] if item.get("installRoot")}
        roots.update(item["root"] for item in report.get("recoveryTargets", []) if item.get("root"))
        possible_root = supplied_root or (safe_root(Path(next(iter(roots)))) if len(roots) == 1 else None)
        if possible_root:
            recovered = recover_pending(possible_root, reader, args.state_dir.expanduser(), None if args.yes else ask, writers_stopped=args.host_writers_stopped)
            if recovered:
                print(json.dumps(recovered, indent=2))
                print("Recovery completed. Run the installer again to continue setup.")
                return 0
        selected = select_installation(report, supplied_root, None if args.yes else ask)
        if selected is not None and args.approved_reset_plan_sha256 is not None:
            raise ValueError('A reset storage approval applies only to a new installation')
        root = safe_root(Path(selected["installRoot"])) if selected and selected.get("installRoot") else supplied_root
        if selected and (not root or selected["reviewRequired"]):
            raise ValueError("The detected controller version, ownership or layout needs compatibility review before replacement")
        if selected and selected["product"] == "orbis":
            if args.mode:
                raise ValueError("Orbis is already installed. Use Settings for resets or Updates for a core update")
            result = update_existing(root, reader, manifest, display, without_host_service=args.without_host_service, selected_channel=channel, state_dir=args.state_dir.expanduser(), **custody_options)
            print(json.dumps(result, indent=2))
            show_browser_address(root)
            return 0
        if selected and selected["product"] != "runtipi":
            raise ValueError("The controller cannot be replaced automatically")
        if selected or report.get("unassignedManagedContainers"):
            with display.step("Checking managed-container ownership"):
                APPS.require_assigned(report)
        if root is None:
            answer = ask("Installation directory [/opt/orbis/server]: ").strip()
            root = safe_root(Path(answer or "/opt/orbis/server"))
        mode = args.mode
        if selected and mode is None:
            if args.yes:
                raise ValueError("Unattended Runtipi replacement requires --mode keep or --mode fresh")
            print(f"\nDetected Runtipi {selected['version']} at {root}\n  1. Keep accounts, settings and apps\n  2. Start fresh with new accounts; retain apps and data")
            while True:
                answer = ask("Replacement choice [1]: ").strip()
                if answer in {"", "1", "2"}:
                    break
                print("Enter 1 to keep the existing accounts, settings and apps, or 2 to start fresh.", file=sys.stderr)
            mode = "fresh" if answer == "2" else "keep"
        if not selected and mode is not None:
            raise ValueError("No Runtipi installation matches the requested replacement mode")
        new = None if selected else load("orbis-install-new.py", "orbis_guided_new")
        if new:
            args.http_port, args.https_port = new.choose_ports(root, reader, args.http_port, args.https_port, None if args.yes else ask)
        remaining = 4 if selected else 3 + len(new.IMAGES)
        display.set_remaining_steps(remaining + 3 + (0 if shutil.which("rsync") else 1))
        enable = load("orbis-host-service-enable.py", "orbis_guided_enable")
        enable.available(root, reader.context)
        with display.step("Verifying the Orbis release"):
            REPLACE.UPDATE.verify_release(manifest)
        private = load("install-orbis.py", "orbis_guided_private")
        state = private.private_directory(args.state_dir.expanduser())
        def pull_core():
            pull_log = state / ("image-pull-" + str(uuid.uuid4()) + ".log")
            with display.step("Downloading the verified Orbis image", detail=UI.PullProgress(pull_log)):
                with pull_log.open("xb") as log:
                    pulled = subprocess.run(["docker", "--context", reader.context, "pull", REPLACE.target_image(manifest)], stdout=log, stderr=subprocess.STDOUT, check=False, timeout=900)
                if pulled.returncode:
                    raise RuntimeError(f"Docker could not pull the verified image; inspect the private logs in {state}")
        UI.retry_download(pull_core, None if args.yes else ask)
        enable.require_scoped_cleanup(root, reader.context, REPLACE.target_image(manifest))
        prepared_sentinel = prepare_sentinel(display, state)

        def confirm(chosen):
            if selected and not args.host_writers_stopped:
                target = "the controller's database, state or .env" if args.backup_scope == "controller" else "this app storage"
                if args.yes or ask(f"Have native host processes and remote clients writing to {target} been stopped? [y/N]: ").strip().lower() != "y":
                    raise ValueError("Stop native and remote storage writers before replacing the installation")
            if not args.yes and ask(f"Type {chosen} to confirm installation: ").strip() != str(chosen):
                raise ValueError("Installation cancelled; no controller was replaced")
            if not selected:
                prepare_backup_tools(display)
            activate_sentinel(display, prepared_sentinel)

        if selected:
            prepare_backup_tools(display)
            result = replacement(root, reader, manifest, state, mode, confirm, display, backup_scope=args.backup_scope, **custody_options)
        else:
            result = new.install(root, reader, manifest, state, args, confirm, display=display, ask=None if args.yes else ask)
        saved_channel = CHANNELS.read_channel(root)
        if saved_channel["channel"] != channel or saved_channel["revision"] == "initial":
            CHANNELS.save_channel(root, channel, str(uuid.uuid4()))
        with display.step("Enabling account security" if args.without_host_service else "Enabling system administration"):
            role = {'credentials_only': True} if args.without_host_service else {}
            enable.enable(root, reader.context, Path(__file__).parent, **custody_options, **role)
        print(f"\nOrbis {UI.display_release(manifest['tag'])} is installed at {root}.")
        print(json.dumps(result, indent=2))
        show_browser_address(root)
        return 0
    finally:
        if tty:
            tty.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nInstallation interrupted. Keep the recovery files before retrying.", file=sys.stderr)
        sys.exit(130)
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        print(f"Orbis installation stopped: {error}", file=sys.stderr)
        sys.exit(2)
