#!/usr/bin/env python3
"""Read Ubuntu package candidates and their distribution changelogs.

This module does not refresh package indexes or install packages. Host package
changes use a separate reviewed transaction.
"""

import importlib
import os
import platform
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path


PACKAGE_TOKEN = r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?"
PACKAGE_NAME = re.compile(rf"^{PACKAGE_TOKEN}$")
MAX_PACKAGES = 1000
MAX_CHANGELOG_BYTES = 48 * 1024
CHANGELOG_TIMEOUT_SECONDS = 20
MAX_PLAN_SELECTION = 250
MAX_SIMULATION_BYTES = 256 * 1024
SIMULATION_TIMEOUT_SECONDS = 35
READINESS_TIMEOUT_SECONDS = 15
# APT may print transient dependency annotations after the candidate description.
# ShortBreaks adds a bracketed list of package names, each followed by a space.
SIMULATED_INSTALL = re.compile(
    rf"^Inst ({PACKAGE_TOKEN})(?: \[([^\s\[\]]+)\])? \(([^\s()]+)(?: .*)?\)"
    rf"(?: \[{PACKAGE_TOKEN} on {PACKAGE_TOKEN}\])*(?: \[(?:{PACKAGE_TOKEN} )*\])?$"
)


def require_ubuntu() -> dict[str, str]:
    if platform.system() != "Linux":
        raise ValueError("host package inventory requires Linux")
    release = platform.freedesktop_os_release()
    if release.get("ID") != "ubuntu" or not release.get("VERSION_ID", "").startswith("24.04"):
        raise ValueError("host package inventory currently supports Ubuntu 24.04 only")
    if not Path("/usr/bin/apt-get").is_file():
        raise ValueError("APT is not installed on this host")
    return release


def apt_module():
    try:
        return importlib.import_module("apt")
    except ImportError as error:
        raise ValueError("python3-apt is required for host package inventory") from error


def index_updated_at(directory: Path = Path("/var/lib/apt/lists")) -> str | None:
    if not directory.is_dir():
        return None
    candidates = [path.stat().st_mtime for path in directory.iterdir() if path.is_file() and path.name.endswith(("InRelease", "Release"))]
    if not candidates:
        return None
    return datetime.fromtimestamp(max(candidates), timezone.utc).isoformat()


def candidate_record(package) -> dict | None:
    if not package.is_installed or not package.is_upgradable or not package.installed or not package.candidate:
        return None
    version = package.candidate
    origins = list(version.origins)
    sources = [
        {
            "origin": origin.origin or None,
            "archive": origin.archive or None,
            "site": origin.site or None,
            "trusted": bool(origin.trusted),
        }
        for origin in origins[:3]
    ]
    security = bool(getattr(version, "is_security_update", False)) or any(
        origin.archive and origin.archive.endswith("-security") for origin in origins
    )
    name = package.fullname if ":" in package.fullname else package.name
    return {
        "name": name,
        "installedVersion": package.installed.version,
        "candidateVersion": version.version,
        "downloadBytes": version.size if isinstance(version.size, int) and version.size >= 0 else None,
        "security": security,
        "sources": sources,
    }


def inventory_from_cache(
    cache, release: dict[str, str], *, checked_at: str, indexes_at: str | None, reboot_required: bool,
    ready_operations: list[dict] | None = None, native_architecture: str = "",
) -> dict:
    records = [record for package in cache if (record := candidate_record(package)) is not None]
    readiness = {"readiness": "unavailable"}
    if ready_operations is not None:
        ready = operation_versions(ready_operations, native_architecture)
        for record in records:
            record["ready"] = package_version(record, native_architecture) in ready
        count = sum(record["ready"] for record in records)
        readiness = {"readiness": "available", "readyPackageCount": count, "deferredPackageCount": len(records) - count}
    records.sort(key=lambda package: (not package.get("ready", False), not package["security"], package["name"]))
    return {
        "available": True,
        **readiness,
        "manager": "apt",
        "operatingSystem": release.get("PRETTY_NAME", "Ubuntu 24.04"),
        "checkedAt": checked_at,
        "indexesUpdatedAt": indexes_at,
        "rebootRequired": reboot_required,
        "packageCount": len(records),
        "truncated": len(records) > MAX_PACKAGES,
        "packages": records[:MAX_PACKAGES],
    }


def inventory() -> dict:
    release = require_ubuntu()
    cache = apt_module().Cache()
    try:
        native = native_apt_architecture()
        ready = normal_upgrade_operations()
    except (OSError, ValueError):
        native, ready = "", None
    return inventory_from_cache(
        cache,
        release,
        checked_at=datetime.now(timezone.utc).isoformat(),
        indexes_at=index_updated_at(),
        reboot_required=Path("/run/reboot-required").is_file(),
        ready_operations=ready, native_architecture=native,
    )


def changelog(name: str) -> dict:
    require_ubuntu()
    if not PACKAGE_NAME.fullmatch(name) or len(name) > 180:
        raise ValueError("package name is invalid")
    cache = apt_module().Cache()
    if name not in cache:
        raise ValueError("package is not in the current APT cache")
    package = cache[name]
    record = candidate_record(package)
    if not record or record["name"] != name:
        raise ValueError("package has no current upgrade candidate")
    target = f"{name}={record['candidateVersion']}"
    environment = {
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PAGER": "cat",
        "APT_PAGER": "cat",
        "DEBIAN_FRONTEND": "noninteractive",
        "HOME": "/root",
    }
    try:
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            result = subprocess.run(
                ["/usr/bin/apt-get", "changelog", target],
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=errors,
                env=environment,
                timeout=CHANGELOG_TIMEOUT_SECONDS,
                check=False,
            )
            output.seek(0, os.SEEK_END)
            total = output.tell()
            output.seek(0)
            content = output.read(MAX_CHANGELOG_BYTES + 1).decode("utf-8", errors="replace")
            if result.returncode or not content.strip():
                return {
                    "name": name,
                    "candidateVersion": record["candidateVersion"],
                    "available": False,
                    "source": "APT distribution changelog",
                    "reason": "APT has no changelog for this candidate or its server is unavailable.",
                }
            return {
                "name": name,
                "candidateVersion": record["candidateVersion"],
                "available": True,
                "source": "APT distribution changelog",
                "body": content[:MAX_CHANGELOG_BYTES],
                "truncated": total > MAX_CHANGELOG_BYTES,
            }
    except subprocess.TimeoutExpired:
        return {
            "name": name,
            "candidateVersion": record["candidateVersion"],
            "available": False,
            "source": "APT distribution changelog",
            "reason": "The changelog server did not respond in time.",
        }


def selected_candidates(names: list[str], cache) -> list[dict]:
    if not isinstance(names, list) or not 1 <= len(names) <= MAX_PLAN_SELECTION or not all(isinstance(name, str) for name in names):
        raise ValueError("choose between 1 and 250 distinct packages")
    if len(set(names)) != len(names):
        raise ValueError("choose between 1 and 250 distinct packages")
    selected = []
    for name in names:
        if not isinstance(name, str) or len(name) > 180 or not PACKAGE_NAME.fullmatch(name):
            raise ValueError("package name is invalid")
        if name not in cache:
            raise ValueError("a selected package is not in the current APT cache")
        record = candidate_record(cache[name])
        if not record or record["name"] != name:
            raise ValueError("a selected package has no current upgrade candidate")
        if not any(origin.trusted for origin in cache[name].candidate.origins):
            raise ValueError("a selected package has no trusted candidate source")
        selected.append(record)
    return sorted(selected, key=lambda item: item["name"])


def apt_install_command(selected: list[dict], *, simulate: bool, new_packages: bool = False) -> list[str]:
    command = ["/usr/bin/apt-get", "--no-remove", "--no-install-recommends"]
    if simulate:
        command.append("--simulate")
    command.append("install")
    if not new_packages:
        command.append("--only-upgrade")
    command.append("--")
    command.extend(f"{item['name']}={item['candidateVersion']}" for item in selected)
    return command


def apt_apply_command(selected: list[dict], *, new_packages: bool = False) -> list[str]:
    command = apt_install_command(selected, simulate=False, new_packages=new_packages)
    command[1:1] = ["-y", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold"]
    return command


def apt_refresh_command() -> list[str]:
    require_ubuntu()
    return [
        "/usr/bin/apt-get", "--error-on=any", "-o", "Acquire::Retries=0",
        "-o", "Acquire::http::Timeout=30", "-o", "Acquire::https::Timeout=30", "update",
    ]


def parse_simulation(output: str, selected: list[dict], *, allow_empty: bool = False) -> list[dict]:
    operations = []
    for line in output.splitlines():
        if line.startswith(("Remv ", "Purg ")):
            raise ValueError("APT planned a package removal")
        if not line.startswith("Inst "):
            continue
        match = SIMULATED_INSTALL.fullmatch(line)
        if not match:
            raise ValueError("APT returned an unrecognized install action")
        name, installed, candidate = match.groups()
        operations.append({"name": name, "installedVersion": installed, "candidateVersion": candidate, "action": "upgrade" if installed else "install"})
    if not operations and not allow_empty:
        raise ValueError("APT did not plan any package changes")
    for item in selected:
        name = item["name"]
        native_name = name.split(":", 1)[0]
        if not any(
            operation["name"] in {name, native_name} and operation["candidateVersion"] == item["candidateVersion"]
            for operation in operations
        ):
            raise ValueError("APT omitted or changed a selected package")
    return operations


def native_apt_architecture() -> str:
    architecture = importlib.import_module("apt_pkg").config.find("APT::Architecture")
    if not architecture:
        raise ValueError("APT native package architecture is unavailable")
    return architecture


def package_version(package: dict, native_architecture: str) -> tuple:
    name, separator, architecture = package["name"].partition(":")
    if separator and architecture != native_architecture:
        name = package["name"]
    return name, package["installedVersion"], package["candidateVersion"]


def operation_versions(operations: list[dict], native_architecture: str) -> set[tuple]:
    return {package_version(item, native_architecture) for item in operations if item["action"] == "upgrade"}


def normal_upgrade_operations() -> list[dict]:
    # Plain apt-get upgrade leaves phased, held, removal-requiring and
    # new-dependency-requiring upgrades for later instead of pinning them.
    command = ["/usr/bin/apt-get", "--simulate", "--no-remove", "upgrade"]
    return parse_simulation(run_simulation(command, READINESS_TIMEOUT_SECONDS), [], allow_empty=True)


def simulate_upgrades(names: list[str]) -> dict:
    require_ubuntu()
    selected = selected_candidates(names, apt_module().Cache())
    native = native_apt_architecture()
    ready = operation_versions(normal_upgrade_operations(), native)
    if any(package_version(item, native) not in ready for item in selected):
        raise ValueError("APT is deferring one or more selected updates. Refresh the package list and try again.")
    result = simulate_install(selected)
    upgrades = operation_versions(result["operations"], native)
    if not upgrades <= ready:
        raise ValueError("APT planned an upgrade outside the current ready package set.")
    selected_names = {package_version(item, native): item["name"] for item in selected}
    if not selected_names.keys() <= upgrades:
        raise ValueError("APT omitted or changed a selected package")
    for operation in result["operations"]:
        identity = package_version(operation, native)
        if identity in selected_names:
            operation["name"] = selected_names[identity]
    return result


def smart_tools_supported() -> bool:
    try:
        require_ubuntu()
        apt_module()
        return True
    except (OSError, ValueError):
        return False


def simulate_smart_tools() -> dict:
    release = require_ubuntu()
    cache = apt_module().Cache()
    archives = {release.get("VERSION_CODENAME") or "noble"}
    archives |= {f"{archive}-{suffix}" for archive in archives for suffix in ("updates", "security", "backports")}

    def official_candidate(name):
        package = cache[name] if name in cache else None
        version = package.candidate if package and not package.is_installed else None
        origins = list(version.origins) if version else []
        if not origins or not all(origin.trusted and origin.origin == "Ubuntu" and origin.archive in archives for origin in origins):
            raise ValueError("A missing SMART package has no trusted Ubuntu candidate. Refresh the host package lists.")
        return {"name": name, "installedVersion": None, "candidateVersion": version.version}

    smartmontools = official_candidate("smartmontools")
    selected = [smartmontools]
    operations = simulate_install(selected, new_packages=True)["operations"]
    seen = set()
    for operation in operations:
        name = operation["name"]
        if name not in {"smartmontools", "libcap-ng0"} or name in seen or operation["action"] != "install":
            raise ValueError("APT planned changes outside the smartmontools installation.")
        seen.add(name)
        candidate = smartmontools if name == "smartmontools" else official_candidate(name)
        if name != "smartmontools":
            selected.append(candidate)
        if operation["candidateVersion"] != candidate["candidateVersion"]:
            raise ValueError("APT changed a reviewed SMART package candidate.")
    if len(selected) > 1 and simulate_install(selected, new_packages=True)["operations"] != operations:
        raise ValueError("APT changed the transaction when pinning the SMART dependencies.")
    return {"selected": selected, "operations": operations}


def simulate_install(selected: list[dict], *, new_packages: bool = False) -> dict:
    command = apt_install_command(selected, simulate=True, new_packages=new_packages)
    summary = run_simulation(command, 20 if new_packages else SIMULATION_TIMEOUT_SECONDS)
    return {"selected": selected, "operations": parse_simulation(summary, selected)}


def run_simulation(command: list[str], timeout: int) -> str:
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "DEBIAN_FRONTEND": "noninteractive", "HOME": "/root"}
    try:
        with tempfile.TemporaryFile() as output:
            result = subprocess.run(
                command,
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.STDOUT,
                env=environment,
                timeout=timeout,
                check=False,
            )
            output.seek(0, os.SEEK_END)
            if output.tell() > MAX_SIMULATION_BYTES:
                raise ValueError("APT simulation output exceeded its limit")
            output.seek(0)
            summary = output.read().decode("utf-8", errors="replace")
    except subprocess.TimeoutExpired as error:
        raise ValueError("APT simulation timed out") from error
    if result.returncode:
        raise ValueError("APT could not resolve the selected package updates")
    return summary
