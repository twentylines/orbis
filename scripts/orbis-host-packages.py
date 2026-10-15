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


PACKAGE_NAME = re.compile(r"^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?$")
MAX_PACKAGES = 1000
MAX_CHANGELOG_BYTES = 48 * 1024
CHANGELOG_TIMEOUT_SECONDS = 20
MAX_PLAN_SELECTION = 250
MAX_SIMULATION_BYTES = 256 * 1024
SIMULATION_TIMEOUT_SECONDS = 45
SIMULATED_INSTALL = re.compile(r"^Inst ([^ ]+)(?: \[([^]]+)\])? \(([^ ]+)(?: .*)?\)$")


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


def inventory_from_cache(cache, release: dict[str, str], *, checked_at: str, indexes_at: str | None, reboot_required: bool) -> dict:
    records = [record for package in cache if (record := candidate_record(package)) is not None]
    records.sort(key=lambda package: (not package["security"], package["name"]))
    return {
        "available": True,
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
    return inventory_from_cache(
        cache,
        release,
        checked_at=datetime.now(timezone.utc).isoformat(),
        indexes_at=index_updated_at(),
        reboot_required=Path("/run/reboot-required").is_file(),
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


def apt_install_command(selected: list[dict], *, simulate: bool) -> list[str]:
    command = ["/usr/bin/apt-get", "--no-remove", "--no-install-recommends"]
    if simulate:
        command.append("--simulate")
    command.extend(["install", "--only-upgrade", "--"])
    command.extend(f"{item['name']}={item['candidateVersion']}" for item in selected)
    return command


def apt_apply_command(selected: list[dict]) -> list[str]:
    command = apt_install_command(selected, simulate=False)
    command[1:1] = ["-y", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold"]
    return command


def parse_simulation(output: str, selected: list[dict]) -> list[dict]:
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
    if not operations:
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


def simulate_upgrades(names: list[str]) -> dict:
    require_ubuntu()
    selected = selected_candidates(names, apt_module().Cache())
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "DEBIAN_FRONTEND": "noninteractive", "HOME": "/root"}
    try:
        with tempfile.TemporaryFile() as output:
            result = subprocess.run(
                apt_install_command(selected, simulate=True),
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.STDOUT,
                env=environment,
                timeout=SIMULATION_TIMEOUT_SECONDS,
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
    return {"selected": selected, "operations": parse_simulation(summary, selected)}
