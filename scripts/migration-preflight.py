#!/usr/bin/env python3
"""Read-only inventory of a copied Runtipi installation tree.

The report never includes .env values or file contents. It does not query Docker.
"""

import argparse
import json
import sys
from pathlib import Path


DATA_PATHS = {
    "media": "RUNTIPI_MEDIA_PATH",
    "state": "RUNTIPI_STATE_PATH",
    "repos": "RUNTIPI_REPOS_PATH",
    "apps": "RUNTIPI_APPS_PATH",
    "logs": "RUNTIPI_LOGS_PATH",
    "traefik": "RUNTIPI_TRAEFIK_PATH",
    "user-config": "RUNTIPI_USER_CONFIG_PATH",
    "app-data": "RUNTIPI_APP_DATA_PATH",
    "backups": "RUNTIPI_BACKUPS_PATH",
}

CRITICAL = {"state", "repos", "apps", "user-config", "app-data"}


def data_overrides(env_file: Path) -> dict[str, str]:
    if not env_file.is_file():
        return {}
    keys = set(DATA_PATHS.values())
    values = {}
    for line in env_file.read_text(encoding="utf-8").splitlines():
        name, separator, value = line.partition("=")
        if not separator or name.strip() not in keys:
            continue
        values[name.strip()] = value.strip().strip('"\'')
    return values


def root_host_status(env_file: Path, root: Path) -> str:
    if not env_file.is_file():
        return "missing"
    for line in env_file.read_text(encoding="utf-8").splitlines():
        name, separator, value = line.partition("=")
        if separator and name.strip() == "ROOT_FOLDER_HOST":
            configured = value.strip().strip('"\'')
            if not configured or "$" in configured or "~" in configured:
                return "unresolved"
            candidate = Path(configured)
            if not candidate.is_absolute():
                return "relative-path"
            return "matches-copy" if candidate.resolve(strict=False) == root else "points-elsewhere"
    return "missing"


def inspect_directory(root: Path, base: str, suffix: str) -> dict[str, object]:
    if not base or "$" in base or "~" in base:
        return {"status": "uninspected-variable"}
    candidate = root / base / suffix
    try:
        resolved = candidate.resolve(strict=False)
    except (OSError, RuntimeError):
        return {"status": "uninspected-path"}
    if not resolved.is_relative_to(root):
        return {"status": "external-path-not-inspected"}
    if candidate.is_symlink():
        return {"status": "symlink-not-inspected"}
    if not candidate.exists():
        return {"status": "missing"}
    if not candidate.is_dir():
        return {"status": "not-a-directory"}
    try:
        count = sum(1 for _ in candidate.iterdir())
    except OSError:
        return {"status": "unreadable"}
    return {"status": "present", "topLevelEntries": count}


def detect_layout(root: Path) -> tuple[str, str, str]:
    """Distinguish a CLI installation from a source-tree Compose test stack."""
    cli_compose = root / "docker-compose.yml"
    dev_compose = root / "docker-compose.prod.yml"
    try:
        if cli_compose.is_file():
            compose = cli_compose.read_text(encoding="utf-8")
            if "./data/postgres:/var/lib/postgresql/data" in compose:
                return "cli-v4", ".", "data/postgres"
        if dev_compose.is_file():
            compose = dev_compose.read_text(encoding="utf-8")
            if "pgdata:/var/lib/postgresql/data" in compose:
                return "source-compose", ".internal", "docker-volume:pgdata"
    except (OSError, UnicodeError):
        pass
    return "unknown", "", "unknown"


def inspect(root: Path) -> dict[str, object]:
    root = root.resolve(strict=True)
    env_file = root / ".env"
    overrides = data_overrides(env_file)
    layout, default_base, database_path = detect_layout(root)
    host_root = root_host_status(env_file, root) if layout == "cli-v4" else "not-applicable"
    directories = {
        suffix: inspect_directory(root, overrides.get(key, default_base), suffix)
        for suffix, key in DATA_PATHS.items()
    }
    critical_missing = [name for name in sorted(CRITICAL) if directories[name]["status"] != "present"]
    compose_files = [name for name in ("docker-compose.yml", "docker-compose.prod.yml", "compose.yml") if (root / name).is_file()]
    database = (
        inspect_directory(root, ".", database_path)
        if database_path == "data/postgres"
        else {"status": "docker-volume-not-inspected"} if database_path.startswith("docker-volume:") else {"status": "unknown"}
    )
    return {
        "root": str(root),
        "readOnly": True,
        "layout": layout,
        "rootFolderHost": host_root,
        "envFilePresent": env_file.is_file(),
        "composeFilesPresent": compose_files,
        "directories": directories,
        "criticalDirectoriesNeedingReview": critical_missing,
        "database": database,
        "result": "review-required"
        if critical_missing or not env_file.is_file() or layout == "unknown" or database["status"] != "present" or host_root not in {"matches-copy", "not-applicable"}
        else "inventory-only",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="path to an isolated copy of the Runtipi installation")
    args = parser.parse_args()
    root = args.root.expanduser().resolve(strict=False)
    if not root.is_dir():
        parser.error("root must be an existing directory")
    result = inspect(root)
    print(json.dumps(result, indent=2))
    return 0 if result["result"] == "inventory-only" else 2


if __name__ == "__main__":
    sys.exit(main())
