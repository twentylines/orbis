#!/usr/bin/env python3
"""Check an immutable Orbis image against a copied Runtipi CLI installation.

This command reads Compose configuration and never prints environment values.
It does not pull images, stop containers, or change the installation.
"""

import argparse
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("migration_preflight", Path(__file__).with_name("migration-preflight.py"))
assert SPEC and SPEC.loader
PREFLIGHT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREFLIGHT)

IMAGE = "ghcr.io/twentylines/orbis"
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
TAG = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$")
ORBIS_ENV = {"ORBIS_VERSION", "ORBIS_COMMIT", "ORBIS_IMAGE_DIGEST"}


def validate_manifest(raw: object) -> dict[str, str]:
    if not isinstance(raw, dict):
        raise ValueError("release manifest must be an object")
    for key in ("schema", "image", "tag", "commit", "digest", "runtipiCompatibility"):
        if not isinstance(raw.get(key), str):
            raise ValueError(f"release manifest has an invalid {key}")
    if raw["schema"] != "orbis.release.v1" or raw["image"] != IMAGE:
        raise ValueError("release manifest is not an Orbis v1 release")
    if not TAG.fullmatch(raw["tag"]) or not COMMIT.fullmatch(raw["commit"]) or not DIGEST.fullmatch(raw["digest"]):
        raise ValueError("release manifest has an invalid tag, commit, or digest")
    if raw["runtipiCompatibility"].removeprefix("v") != "4.10.1":
        raise ValueError("release manifest does not target the 4.10.1 compatibility base")
    return raw


def override_yaml(manifest: dict[str, str]) -> str:
    return (
        "services:\n  runtipi:\n"
        f"    image: {IMAGE}@{manifest['digest']}\n"
        "    environment:\n"
        f"      ORBIS_VERSION: {manifest['tag']}\n"
        f"      ORBIS_COMMIT: {manifest['commit']}\n"
        f"      ORBIS_IMAGE_DIGEST: {manifest['digest']}\n"
    )


def compose_config(root: Path, files: list[Path], stdin: str | None = None) -> dict:
    command = ["docker", "compose", "--project-name", "runtipi"]
    for file in files:
        command.extend(("-f", str(file)))
    if stdin is not None:
        command.extend(("-f", "-"))
    command.extend(("config", "--format", "json"))
    result = subprocess.run(command, input=stdin, text=True, capture_output=True, cwd=root, check=False)
    if result.returncode:
        # Docker may include interpolated secrets in diagnostics; never relay stderr.
        raise RuntimeError("Docker Compose could not validate this installation; inspect it locally")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("Docker Compose returned invalid configuration JSON") from error


def config_invariants(config: dict) -> dict:
    safe = json.loads(json.dumps(config))
    services = safe.get("services", {})
    core = services.get("runtipi")
    if not isinstance(core, dict):
        raise ValueError("Compose does not define the runtipi service")
    core.pop("image", None)
    environment = core.get("environment", {})
    if not isinstance(environment, dict):
        raise ValueError("runtipi environment is not a Compose mapping")
    for key in ORBIS_ENV:
        environment.pop(key, None)
    return safe


def read_version(root: Path) -> str | None:
    version_file = root / "VERSION"
    if version_file.is_file():
        return version_file.read_text(encoding="utf-8").strip().removeprefix("v")
    env_file = root / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            name, separator, value = line.partition("=")
            if separator and name == "TIPI_VERSION":
                return value.strip().strip("\"'").removeprefix("v")
    return None


def plan(root: Path, manifest: dict[str, str]) -> dict:
    inventory = PREFLIGHT.inspect(root)
    if inventory["layout"] != "cli-v4":
        raise ValueError("this planner requires a copied Runtipi CLI v4 installation")
    if inventory["result"] != "inventory-only":
        raise ValueError("the copied installation has unresolved preflight items")
    installed_version = read_version(root)
    if installed_version != manifest["runtipiCompatibility"].removeprefix("v"):
        raise ValueError("the installed Runtipi version does not match this compatibility base")

    files = [root / "docker-compose.yml"]
    user_override = root / "user-config" / "tipi-compose.yml"
    if user_override.is_file():
        files.append(user_override)
    current_override = root / "orbis-compose.yml"
    if current_override.is_file():
        files.append(current_override)

    current = compose_config(root, files)
    candidate = compose_config(root, files, override_yaml(manifest))
    if config_invariants(current) != config_invariants(candidate):
        raise ValueError("Orbis override would change more than the core image and build identity")
    services = current.get("services", {})
    if not {"runtipi", "runtipi-db", "runtipi-queue", "runtipi-reverse-proxy"}.issubset(services):
        raise ValueError("the expected Runtipi core services are missing")

    return {
        "result": "plan-ready",
        "installRoot": str(root),
        "installedRuntipiVersion": installed_version,
        "configuredImage": services["runtipi"].get("image"),
        "candidateImage": f"{IMAGE}@{manifest['digest']}",
        "releaseTag": manifest["tag"],
        "releaseCommit": manifest["commit"],
        "userOverrideIncluded": user_override.is_file(),
        "standardOrbisOverrideIncluded": current_override.is_file(),
        "runtimeInspected": False,
        "requiredNextStep": "Rehearse on this copy with a verified database and file snapshot before any live rollout.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="isolated copy of a Runtipi CLI installation")
    parser.add_argument("manifest", type=Path, help="reviewed release-manifest.json")
    args = parser.parse_args()
    try:
        root = args.root.expanduser().resolve(strict=True)
        if not root.is_dir():
            raise ValueError("installation root must be a directory")
        manifest = validate_manifest(json.loads(args.manifest.read_text(encoding="utf-8")))
        print(json.dumps(plan(root, manifest), indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"Orbis release plan failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
