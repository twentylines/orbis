#!/usr/bin/env python3
"""Operate an already adopted Orbis CLI-v4 installation through pinned Compose.

Enrollment records a healthy, manually rehearsed Orbis installation. This is
not a first-install or update command: it cannot switch a stock Runtipi core to
Orbis, migrate a database, or take a backup.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def load_script(name: str, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, Path(__file__).with_name(name))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PLAN = load_script("orbis-release-plan.py", "orbis_release_plan")
STAGE = load_script("orbis-stage-release.py", "orbis_stage_release")
STATE_NAME = ".orbis-host-state.json"


def run(command: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=False)


def docker(context: str, arguments: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return run(["docker", "--context", context, *arguments], cwd)


def compose_args(root: Path) -> list[str]:
    files = [root / "docker-compose.yml", root / "user-config" / "tipi-compose.yml", root / "orbis-compose.yml"]
    arguments = ["compose", "--project-name", "runtipi", "--env-file", str(root / ".env")]
    for file in files:
        if file.is_file():
            arguments.extend(("-f", str(file)))
    return arguments


def file_digest(path: Path) -> str | None:
    if not path.exists():
        return None
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"{path.name} must be a regular file")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def installation_fingerprint(root: Path, manifest: dict[str, str], context: str) -> dict[str, object]:
    override = root / "orbis-compose.yml"
    if override.is_symlink() or not override.is_file() or override.read_text(encoding="utf-8") != STAGE.staged_content(manifest):
        raise ValueError("the generated Orbis override does not match the reviewed manifest")
    PLAN.plan(root, manifest)
    paths = ("docker-compose.yml", ".env", "user-config/tipi-compose.yml", "orbis-compose.yml")
    return {
        "schema": "orbis.host.v1",
        "root": str(root),
        "dockerContext": context,
        "tag": manifest["tag"],
        "digest": manifest["digest"],
        "files": {name: file_digest(root / name) for name in paths},
    }


def current_core(root: Path, context: str) -> dict[str, object]:
    probe = docker(context, ["inspect", "--format", "{{json .Config.Image}}", "runtipi"], root)
    if probe.returncode:
        return {"state": "absent"}
    fields = {}
    for field, template in (
        ("image", "{{json .Config.Image}}"),
        ("labels", "{{json .Config.Labels}}"),
        ("runtime", "{{json .State}}"),
    ):
        result = docker(context, ["inspect", "--format", template, "runtipi"], root)
        if result.returncode:
            raise RuntimeError("could not inspect the Orbis core container")
        try:
            fields[field] = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError("Docker returned invalid container metadata") from error
    labels = fields["labels"] or {}
    if labels.get("com.docker.compose.project") != "runtipi":
        raise ValueError("the runtipi container belongs to another Compose project")
    working_dir = labels.get("com.docker.compose.project.working_dir")
    if not working_dir or Path(working_dir).resolve(strict=False) != root:
        raise ValueError("the runtipi container belongs to another installation root")
    runtime = fields["runtime"] or {}
    return {
        "state": runtime.get("Status", "unknown"),
        "health": (runtime.get("Health") or {}).get("Status", "none"),
        "image": fields["image"],
    }


def saved_state(root: Path) -> dict[str, object] | None:
    path = root / STATE_NAME
    if path.is_symlink():
        raise ValueError("Orbis host state is a symlink")
    if not path.exists():
        return None
    if not path.is_file():
        raise ValueError("Orbis host state is not a regular file")
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError("Orbis host state is invalid JSON") from error
    if not isinstance(state, dict) or state.get("schema") != "orbis.host.v1":
        raise ValueError("Orbis host state has an unsupported schema")
    return state


def write_state(root: Path, state: dict[str, object]) -> None:
    descriptor, name = tempfile.mkstemp(prefix=".orbis-host-", dir=root)
    temporary = Path(name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(state, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, root / STATE_NAME)
        directory = os.open(root, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def require_current_state(root: Path, expected: dict[str, object]) -> None:
    previous = saved_state(root)
    if previous is None:
        raise ValueError("this installation is not enrolled; verify a healthy manual Orbis cutover first")
    if previous != expected:
        raise ValueError("release, Docker context, or installation files changed since enrollment")


def require_confirmation(root: Path, supplied: str | None) -> None:
    if supplied != str(root):
        raise ValueError(f"mutating commands require --confirm-root {root}")


def execute(root: Path, manifest: dict[str, str], context: str, action: str, confirmation: str | None) -> dict[str, object]:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", context):
        raise ValueError("Docker context name is invalid")
    expected = installation_fingerprint(root, manifest, context)
    if docker(context, ["info", "--format", "{{.ID}}"], root).returncode:
        raise RuntimeError("the selected Docker context is unavailable")
    core = current_core(root, context)
    image = f"{PLAN.IMAGE}@{manifest['digest']}"
    if action == "status":
        return {
            "root": str(root),
            "dockerContext": context,
            "releaseTag": manifest["tag"],
            "enrolled": saved_state(root) == expected,
            "core": core,
            "expectedImage": image,
            "imageMatches": core.get("image") == image,
        }

    require_confirmation(root, confirmation)
    if action == "enroll":
        if core.get("image") != image or core.get("state") != "running" or core.get("health") != "healthy":
            raise ValueError("enrollment requires the reviewed Orbis image to be running and healthy")
        write_state(root, expected)
        return {"result": "enrolled", "root": str(root), "releaseTag": manifest["tag"]}

    require_current_state(root, expected)
    if action == "stop":
        if core.get("image") != image:
            raise ValueError("refusing to stop a core container with an unexpected image")
        command = compose_args(root) + ["stop", "runtipi-reverse-proxy", "runtipi"]
        result = docker(context, command, root)
        if result.returncode:
            raise RuntimeError("Docker Compose could not stop the Orbis core; inspect it locally")
        return {"result": "stopped", "root": str(root)}
    if action == "start":
        command = compose_args(root) + ["up", "--detach", "--no-build", "--wait", "--pull", "never", "runtipi", "runtipi-reverse-proxy"]
        result = docker(context, command, root)
        if result.returncode:
            raise RuntimeError("Docker Compose could not start the Orbis core; inspect it locally")
        after = current_core(root, context)
        if after.get("image") != image or after.get("state") != "running" or after.get("health") != "healthy":
            raise RuntimeError("Orbis did not reach the reviewed image and healthy state")
        return {"result": "healthy", "root": str(root), "releaseTag": manifest["tag"], "image": image}
    raise ValueError("unsupported host action")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("status", "enroll", "start", "stop"))
    parser.add_argument("root", type=Path, help="Runtipi CLI v4.10.1 installation root")
    parser.add_argument("manifest", type=Path, help="reviewed release-manifest.json")
    parser.add_argument("--docker-context", required=True, help="explicit Docker context name")
    parser.add_argument("--confirm-root", help="exact resolved installation root for a mutating action")
    args = parser.parse_args()
    try:
        root = args.root.expanduser().resolve(strict=True)
        if not root.is_dir():
            raise ValueError("installation root must be a directory")
        manifest = PLAN.validate_manifest(json.loads(args.manifest.read_text(encoding="utf-8")))
        print(json.dumps(execute(root, manifest, args.docker_context, args.action, args.confirm_root), indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"Orbis host command failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
