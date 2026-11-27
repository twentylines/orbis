#!/usr/bin/env python3
"""Check an immutable Orbis image against a copied Runtipi CLI installation.

This command reads Compose configuration and never prints environment values.
It does not pull images, stop containers, or change the installation.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("migration_preflight", Path(__file__).with_name("migration-preflight.py"))
assert SPEC and SPEC.loader
PREFLIGHT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREFLIGHT)
POLICY_SPEC = importlib.util.spec_from_file_location("orbis_release_policy", Path(__file__).with_name("orbis-release-policy.py"))
assert POLICY_SPEC and POLICY_SPEC.loader
POLICY = importlib.util.module_from_spec(POLICY_SPEC)
POLICY_SPEC.loader.exec_module(POLICY)

IMAGE = "ghcr.io/twentylines/orbis"
INSTALLATION_PROTOCOL = "orbis.installation-state.v1"
LEGACY_BASE = "4.10.1"
RUNTIPI_412_BASE = "4.12.0"
RUNTIPI_BASES = frozenset({LEGACY_BASE, RUNTIPI_412_BASE})
RUNTIPI_BASE_LABEL = "io.orbis.runtipi-compatibility"
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
TAG = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$")
ORBIS_ENV = {"ORBIS_VERSION", "ORBIS_COMMIT", "ORBIS_IMAGE_DIGEST"}
VERSION_ASSIGNMENT = re.compile(rb"^[ \t]*(?:export[ \t]+)?TIPI_VERSION[ \t]*[=:]", re.MULTILINE)
VERSION_VALUE = re.compile(rb"(?P<space>[ \t]*)(?P<quote>['\"]?)(?P<value>v?[0-9]+\.[0-9]+\.[0-9]+)(?P=quote)(?=[ \t]*(?:#[^\r\n]*)?\r?$)", re.MULTILINE)


def is_stable_release_tag(tag: str) -> bool:
    return POLICY.is_stable_release_tag(tag)


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
    if not POLICY.is_published_release_tag(raw["tag"]):
        raise ValueError("choose a published Stable or Nightly release")
    if "releaseChannel" in raw and raw["releaseChannel"] != ("stable" if is_stable_release_tag(raw["tag"]) else "nightly"):
        raise ValueError("release channel does not match the published version")
    if "updatePriority" in raw and raw["updatePriority"] not in ("normal", "critical"):
        raise ValueError("release update priority is invalid")
    marker = raw.get("criticalThrough")
    if marker is not None and (
        not isinstance(marker, str)
        or not POLICY.is_published_release_tag(marker)
        or not POLICY.release_allowed_on_channel(marker, "stable" if is_stable_release_tag(raw["tag"]) else "nightly")
        or POLICY.version_order(marker, raw["tag"]) not in (-1, 0)
    ):
        raise ValueError("release manifest has an invalid critical-through marker")
    fixes = raw.get("criticalFixes", [])
    if (
        not isinstance(fixes, list)
        or len(fixes) > 128
        or any(not isinstance(fix, str) or not POLICY.is_published_release_tag(fix) for fix in fixes)
        or len(set(fixes)) != len(fixes)
    ):
        raise ValueError("release manifest has an invalid critical-fix frontier")
    base = raw["runtipiCompatibility"].removeprefix("v")
    if base not in RUNTIPI_BASES:
        raise ValueError("release manifest does not target a supported Runtipi compatibility base")
    if base == RUNTIPI_412_BASE and (
        raw["runtipiCompatibility"] != base or raw.get("installationProtocol") != INSTALLATION_PROTOCOL
    ):
        raise ValueError("Runtipi 4.12 releases require the canonical base and installation protocol")
    if "installationProtocol" in raw and raw["installationProtocol"] != INSTALLATION_PROTOCOL:
        raise ValueError("release manifest has an unsupported installation protocol")
    return raw


def image_compatibility(labels: dict) -> str:
    # Older immutable images predate the label and were built for 4.10.1.
    base = labels.get(RUNTIPI_BASE_LABEL, LEGACY_BASE)
    if not isinstance(base, str) or base not in RUNTIPI_BASES:
        raise ValueError("image declares an unsupported Runtipi compatibility base")
    return base


def require_installation_protocol(raw: object) -> dict[str, str]:
    manifest = validate_manifest(raw)
    if manifest.get("installationProtocol") != INSTALLATION_PROTOCOL:
        raise ValueError("this release does not declare installer hold and resume support")
    return manifest


def update_identity(raw: object) -> dict[str, str]:
    """Project the identity used by protected Host update jobs."""
    release = validate_manifest(raw)
    fields = ("schema", "image", "tag", "commit", "digest", "runtipiCompatibility", "installationProtocol")
    return {name: release[name] for name in fields if name in release}


def override_yaml(manifest: dict[str, str]) -> str:
    return (
        "services:\n  runtipi:\n"
        f"    image: {IMAGE}@{manifest['digest']}\n"
        "    environment:\n"
        f"      ORBIS_VERSION: {manifest['tag']}\n"
        f"      ORBIS_COMMIT: {manifest['commit']}\n"
        f"      ORBIS_IMAGE_DIGEST: {manifest['digest']}\n"
    )


def compose_config(root: Path, files: list[Path], stdin: str | None = None, *, runtipi_base=None,
                   resolve_env_files=True, all_profiles=False, from_install_env=False) -> dict:
    command = ["docker", "compose", "--project-name", "runtipi"]
    if all_profiles:
        command.extend(("--profile", "*"))
    if from_install_env:
        command.extend(("--env-file", str(root / ".env")))
    for file in files:
        command.extend(("-f", str(file)))
    if stdin is not None:
        command.extend(("-f", "-"))
    command.extend(("config", "--format", "json"))
    if not resolve_env_files:
        command.append("--no-env-resolution")
    overrides = {}
    if from_install_env or runtipi_base is not None:
        environment = dict(os.environ)
        environment.pop("TIPI_VERSION", None)
        if runtipi_base is not None:
            environment["TIPI_VERSION"] = runtipi_base
        overrides["env"] = environment
    result = subprocess.run(command, input=stdin, text=True, capture_output=True, cwd=root, check=False, **overrides)
    if result.returncode:
        # Docker may include interpolated secrets in diagnostics; never relay stderr.
        raise RuntimeError("Docker Compose could not validate this installation; inspect it locally")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("Docker Compose returned invalid configuration JSON") from error


def config_invariants(config: dict, *, review_base_change=False) -> dict:
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
    if review_base_change:
        environment.pop("TIPI_VERSION", None)
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


def compose_files(root: Path) -> list[Path]:
    files = [root / "docker-compose.yml"]
    user_override = root / "user-config" / "tipi-compose.yml"
    if user_override.is_file():
        files.append(user_override)
    host_override = root / "orbis-host-compose.yml"
    if host_override.is_symlink():
        raise ValueError("the host service override must not be a symlink")
    if host_override.is_file():
        files.append(host_override)
    current_override = root / "orbis-compose.yml"
    if current_override.is_file():
        files.append(current_override)
    return files


def plan(root: Path, manifest: dict[str, str]) -> dict:
    root = root.resolve(strict=True)
    files = compose_files(root)
    current = compose_config(root, files)
    inventory = PREFLIGHT.inspect(root, compose_config=current)
    if inventory["layout"] not in {"cli-v4", "orbis-v1"}:
        raise ValueError("this planner requires a compatible Runtipi CLI v4 or Orbis installation with its local writable database")
    if inventory["result"] != "inventory-only":
        raise ValueError("the copied installation has unresolved preflight items")
    installed_version = read_version(root)
    if installed_version != manifest["runtipiCompatibility"].removeprefix("v"):
        raise ValueError("the installed Runtipi version does not match this compatibility base")
    if installed_version == RUNTIPI_412_BASE:
        environment = current["services"]["runtipi"].get("environment")
        runtime_base = environment.get("TIPI_VERSION") if isinstance(environment, dict) else None
        if not isinstance(runtime_base, str) or runtime_base.removeprefix("v") != installed_version:
            raise ValueError("the current controller Runtipi version does not match its installation")
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
        "userOverrideIncluded": root / "user-config" / "tipi-compose.yml" in files,
        "standardOrbisOverrideIncluded": root / "orbis-compose.yml" in files,
        "runtimeInspected": False,
        "requiredNextStep": "Rehearse on this copy with a verified database and file snapshot before any live rollout.",
    }


def read_review_file(file: Path) -> bytes:
    with os.fdopen(os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("A compatibility review input is not a regular file")
        body = stream.read(1024 * 1024 + 1)
        if len(body) > 1024 * 1024:
            raise ValueError("A compatibility review input exceeds its limit")
        return body


def is_runtipi_412_upgrade(current: dict, target: dict) -> bool:
    return (current.get("runtipiCompatibility") in (LEGACY_BASE, "v" + LEGACY_BASE)
            and target.get("runtipiCompatibility") == RUNTIPI_412_BASE)


def configuration_412(current: dict, target: dict, env: bytes, version: bytes) -> tuple[dict, str]:
    """Render the exact forward version files and candidate override without writing them."""
    current, target = validate_manifest(current), require_installation_protocol(target)
    if (not is_runtipi_412_upgrade(current, target)
            or POLICY.version_order(current["tag"], target["tag"]) != -1
            or current["digest"] == target["digest"]):
        raise ValueError("Review only a forward Orbis release from Runtipi 4.10.1 to 4.12.0")
    if version.strip().removeprefix(b"v") != LEGACY_BASE.encode():
        raise ValueError("The retained VERSION does not match the current release")
    matches = list(VERSION_ASSIGNMENT.finditer(env))
    value = VERSION_VALUE.match(env, matches[0].end()) if len(matches) == 1 else None
    if value is None or value["value"].removeprefix(b"v") != LEGACY_BASE.encode():
        raise ValueError("The retained .env must declare the current TIPI_VERSION exactly once")
    return {
        ".env": env[:value.start("value")] + RUNTIPI_412_BASE.encode() + env[value.end("value"):],
        "VERSION": (RUNTIPI_412_BASE + "\n").encode(),
    }, value["value"].decode("ascii")


def override_412(target: dict) -> str:
    return override_yaml(target) + f"      TIPI_VERSION: {RUNTIPI_412_BASE}\n"


def review_412(root: Path, current: dict, target: dict) -> dict:
    """Review a forward version change on a retained installation copy without staging it."""
    root = root.resolve(strict=True)
    files = compose_files(root)
    pinned = {file: read_review_file(file) for file in [*files, root / "VERSION", root / ".env"]}
    prospective_files, current_version = configuration_412(current, target, pinned[root / ".env"], pinned[root / "VERSION"])
    # Validate the literal is an actual dotenv assignment, rather than text
    # inside a multiline value. The synthetic service interpolates only this key.
    env_probe = compose_config(root, [], "services:\n  runtipi:\n    image: busybox\n"
                               "    environment:\n      TIPI_VERSION: ${TIPI_VERSION:-}\n", from_install_env=True)
    if env_probe["services"]["runtipi"]["environment"].get("TIPI_VERSION") != current_version:
        raise ValueError("The retained .env does not resolve to the reviewed TIPI_VERSION")

    original = compose_config(root, files, all_profiles=True)
    inventory = PREFLIGHT.inspect(root, compose_config=original)
    if inventory["layout"] != "orbis-v1" or inventory["result"] != "inventory-only":
        raise ValueError("This review requires a retained Orbis installation and its local database")
    definitions = compose_config(root, files, resolve_env_files=False, all_profiles=True)
    for service, configuration in definitions["services"].items():
        if service != "runtipi" and any(
            (entry if isinstance(entry, str) else entry.get("path")) == str(root / ".env")
            for entry in configuration.get("env_file", [])
        ):
            raise ValueError("Another service uses the root environment file and requires separate review")
        if service != "runtipi" and any(
            isinstance(mount, dict) and mount.get("type") == "bind" and isinstance(mount.get("source"), str)
            and any((root / name).is_relative_to(Path(mount["source"]).resolve()) for name in (*prospective_files, "orbis-compose.yml"))
            for mount in configuration.get("volumes", [])
        ):
            raise ValueError("Another service can read the changing version files and requires separate review")
    previous_core = original["services"]["runtipi"]
    env_mounts = [mount for mount in previous_core.get("volumes", []) if mount.get("target") == "/data/.env"]
    if len(env_mounts) != 1 or env_mounts[0].get("type") != "bind" or env_mounts[0].get("source") != str(root / ".env"):
        raise ValueError("The retained controller does not bind the reviewed environment file")
    runtime = previous_core.get("environment", {})
    if (previous_core.get("image") != f"{IMAGE}@{current['digest']}"
            or runtime.get("TIPI_VERSION") not in (LEGACY_BASE, "v" + LEGACY_BASE)
            or any(runtime.get(name) != current[key] for name, key in (
                ("ORBIS_VERSION", "tag"), ("ORBIS_COMMIT", "commit"), ("ORBIS_IMAGE_DIGEST", "digest")
            ))):
        raise ValueError("The retained controller configuration does not match the current release")

    override = override_412(target)
    prospective = compose_config(root, files, override, runtipi_base=RUNTIPI_412_BASE, all_profiles=True)
    next_core = prospective["services"]["runtipi"]
    if next_core.get("image") != f"{IMAGE}@{target['digest']}" or next_core.get("environment", {}).get("TIPI_VERSION") != RUNTIPI_412_BASE:
        raise ValueError("The prospective controller configuration does not match the target release")
    if config_invariants(original, review_base_change=True) != config_invariants(prospective, review_base_change=True):
        raise ValueError("The prospective base would change retained Compose configuration")
    if files != compose_files(root) or any(read_review_file(file) != original_bytes for file, original_bytes in pinned.items()):
        raise ValueError("The retained configuration changed during review")
    return {
        "result": "runtipi-compatibility-reviewed",
        "currentTag": current["tag"],
        "targetTag": target["tag"],
        "currentDigest": current["digest"],
        "targetDigest": target["digest"],
        "currentRuntipiVersion": LEGACY_BASE,
        "targetRuntipiVersion": RUNTIPI_412_BASE,
        "retainedFileSha256": {str(file.relative_to(root)): hashlib.sha256(body).hexdigest() for file, body in pinned.items()},
        "prospectiveFileSha256": {name: hashlib.sha256(body).hexdigest() for name, body in prospective_files.items()},
        "prospectiveOverrideSha256": hashlib.sha256(override.encode()).hexdigest(),
        "currentComposeSha256": hashlib.sha256(json.dumps(original, sort_keys=True).encode()).hexdigest(),
        "prospectiveComposeSha256": hashlib.sha256(json.dumps(prospective, sort_keys=True).encode()).hexdigest(),
        "runtimeInspected": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="isolated copy of a Runtipi CLI installation")
    parser.add_argument("manifest", type=Path, help="reviewed release-manifest.json")
    parser.add_argument("--review-412-from", type=Path, metavar="INSTALLED_MANIFEST",
                        help="review a forward 4.12 change without staging it")
    args = parser.parse_args()
    try:
        root = args.root.expanduser().resolve(strict=True)
        if not root.is_dir():
            raise ValueError("installation root must be a directory")
        manifest = validate_manifest(json.loads(args.manifest.read_text(encoding="utf-8")))
        if args.review_412_from:
            current = json.loads(args.review_412_from.read_text(encoding="utf-8"))
            result = review_412(root, current, manifest)
        else:
            result = plan(root, manifest)
        print(json.dumps(result, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"Orbis release plan failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
