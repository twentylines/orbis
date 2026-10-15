#!/usr/bin/env python3
"""Plan, apply, or recover a digest-pinned Orbis core update on a CLI v4 host.

The update stops the core services after refusing active Runtipi app containers,
captures a verified stopped-state tree, and restores it if the new core fails.
Only the explicit Docker context is used for runtime operations.
"""

import argparse
import importlib.util
import json
import os
import re
import shutil
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


HOST = load_script("orbis-host.py", "orbis_host_for_update")
CHECK = load_script("orbis-release-check.py", "orbis_release_check_for_update")
SNAPSHOT = load_script("orbis-snapshot.py", "orbis_snapshot_for_update")
CORE_SERVICES = ("runtipi-reverse-proxy", "runtipi", "runtipi-queue", "runtipi-db")
JOURNAL_SCHEMA = "orbis.update.v1"
TERMINAL_STAGES = {"complete", "rolled-back", "aborted"}


def journal_path(snapshot: Path) -> Path:
    return snapshot.with_name(f"{snapshot.name}.orbis-update.json")


def write_journal(snapshot: Path, record: dict[str, object]) -> None:
    target = journal_path(snapshot)
    descriptor, name = tempfile.mkstemp(prefix=f".{snapshot.name}.orbis-update-", dir=snapshot.parent)
    temporary = Path(name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(record, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        directory = os.open(snapshot.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def read_journal(snapshot: Path, root: Path, context: str, current: dict[str, str], target: dict[str, str]) -> dict[str, object]:
    file = journal_path(snapshot)
    if file.is_symlink() or not file.is_file():
        raise ValueError("update journal is missing or is not a regular file")
    record = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(record, dict) or record.get("schema") != JOURNAL_SCHEMA:
        raise ValueError("update journal has an unsupported schema")
    if (
        record.get("root") != str(root)
        or record.get("snapshot") != str(snapshot)
        or record.get("dockerContext") != context
        or record.get("previousDigest") != current["digest"]
        or record.get("targetDigest") != target["digest"]
    ):
        raise ValueError("update journal does not match this installation and release pair")
    return record


def docker_checked(context: str, arguments: list[str], root: Path, message: str) -> str:
    result = HOST.docker(context, arguments, root)
    if result.returncode:
        raise RuntimeError(message)
    return result.stdout.strip()


def inspect_json(root: Path, context: str, container: str, template: str) -> object:
    text = docker_checked(context, ["inspect", "--format", template, container], root, "Docker could not inspect a container")
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        raise RuntimeError("Docker returned invalid container metadata") from error


def core_ownership(root: Path, context: str, allow_absent: bool = False) -> set[str]:
    existing = set(
        docker_checked(context, ["ps", "--all", "--format", "{{.Names}}"], root, "Docker could not list containers").splitlines()
    )
    if not allow_absent and any(service not in existing for service in CORE_SERVICES):
        raise ValueError("an enrolled core container is missing")
    for service in CORE_SERVICES:
        if service not in existing:
            continue
        labels = inspect_json(root, context, service, "{{json .Config.Labels}}")
        if not isinstance(labels, dict) or labels.get("com.docker.compose.project") != "runtipi":
            raise ValueError("a core container does not belong to the Runtipi Compose project")
        working_dir = labels.get("com.docker.compose.project.working_dir")
        if not isinstance(working_dir, str) or Path(working_dir).resolve(strict=False) != root:
            raise ValueError("a core container belongs to another installation root")
        if labels.get("com.docker.compose.service") != service:
            raise ValueError("a core container has an unexpected Compose service")
    return existing


def require_quiet_apps(root: Path, context: str) -> None:
    ids = docker_checked(context, ["ps", "--format", "{{.ID}}"], root, "Docker could not list running containers").splitlines()
    for container in ids:
        labels = inspect_json(root, context, container, "{{json .Config.Labels}}")
        mounts = inspect_json(root, context, container, "{{json .Mounts}}")
        if not isinstance(labels, dict) or not isinstance(mounts, list):
            raise RuntimeError("Docker returned invalid container metadata")
        working_dir = labels.get("com.docker.compose.project.working_dir")
        is_our_core = (
            labels.get("com.docker.compose.project") == "runtipi"
            and isinstance(working_dir, str)
            and Path(working_dir).resolve(strict=False) == root
            and labels.get("com.docker.compose.service") in CORE_SERVICES
        )
        if is_our_core:
            continue
        if "runtipi.managed" in labels:
            raise ValueError("stop Runtipi-managed applications before updating the core")
        if isinstance(working_dir, str) and Path(working_dir).resolve(strict=False).is_relative_to(root):
            raise ValueError("another running Compose service uses this installation")
        if any(
            isinstance(mount, dict)
            and mount.get("Type") == "bind"
            and isinstance(mount.get("Source"), str)
            and Path(mount["Source"]).resolve(strict=False).is_relative_to(root)
            for mount in mounts
        ):
            raise ValueError("another running container is using installation files")


def verify_release(target: dict[str, str]) -> None:
    published = CHECK.check(target["tag"])
    expected_image = f"{target['image']}@{target['digest']}"
    if (
        published.get("commit") != target["commit"]
        or published.get("image") != expected_image
        or published.get("runtipiCompatibility") != target["runtipiCompatibility"]
    ):
        raise ValueError("target manifest does not match the verified GitHub and GHCR release")


def update_plan(root: Path, current: dict[str, str], target: dict[str, str], context: str, snapshot: Path) -> dict[str, object]:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", context):
        raise ValueError("Docker context name is invalid")
    if current["digest"] == target["digest"]:
        raise ValueError("current and target image digests are identical")
    if shutil.which("rsync") is None:
        raise ValueError("rsync is required to restore a stopped installation snapshot")
    if journal_path(snapshot).exists() or journal_path(snapshot).is_symlink():
        raise ValueError("an update journal already exists for this snapshot destination")
    SNAPSHOT.prepare(root, snapshot)
    expected = HOST.installation_fingerprint(root, current, context)
    HOST.require_current_state(root, expected)
    candidate = HOST.PLAN.plan(root, target)
    current_image = f"{current['image']}@{current['digest']}"
    if candidate.get("configuredImage") != current_image:
        raise ValueError("the configured core image differs from the enrolled release")
    docker_checked(context, ["info", "--format", "{{.ID}}"], root, "the selected Docker context is unavailable")
    core_ownership(root, context)
    core = HOST.current_core(root, context)
    if core.get("image") != current_image or core.get("state") != "running" or core.get("health") != "healthy":
        raise ValueError("the enrolled Orbis core must be running and healthy")
    require_quiet_apps(root, context)
    verify_release(target)
    return {
        "result": "ready-to-update",
        "root": str(root),
        "dockerContext": context,
        "previousTag": current["tag"],
        "targetTag": target["tag"],
        "targetImage": f"{target['image']}@{target['digest']}",
        "snapshot": str(snapshot),
        "runningAppsMustBeStopped": True,
    }


def stop_core(root: Path, context: str, allow_absent: bool = False) -> None:
    existing = core_ownership(root, context, allow_absent=allow_absent)
    for service in CORE_SERVICES:
        if service not in existing:
            continue
        state = docker_checked(context, ["inspect", "--format", "{{.State.Status}}", service], root, "Docker could not inspect core state")
        if state == "running":
            docker_checked(context, ["stop", service], root, "Docker could not stop a core service")
    for service in CORE_SERVICES:
        if service not in existing:
            continue
        state = docker_checked(context, ["inspect", "--format", "{{.State.Status}}", service], root, "Docker could not inspect stopped core")
        if state not in {"exited", "created"}:
            raise RuntimeError("a core service is still writing to the installation")


def start_core(root: Path, context: str, force_recreate: bool = False) -> None:
    command = HOST.compose_args(root) + ["up", "--detach", "--no-build", "--wait", "--pull", "never"]
    if force_recreate:
        command.append("--force-recreate")
    command.extend(("runtipi", "runtipi-db", "runtipi-queue", "runtipi-reverse-proxy"))
    docker_checked(context, command, root, "Docker Compose could not start the core services")


def rollback(root: Path, current: dict[str, str], context: str, snapshot: Path, record: dict[str, object]) -> None:
    record["stage"] = "rolling-back"
    write_journal(snapshot, record)
    stop_core(root, context, allow_absent=True)
    require_quiet_apps(root, context)
    if SNAPSHOT.sidecar(snapshot).is_file():
        saved = SNAPSHOT.verify(snapshot, root)
        if saved.get("release") != current["tag"] or saved.get("dockerContext") != context:
            raise ValueError("snapshot was captured for another release or Docker context")
        result = subprocess.run(
            ["rsync", "-a", "--checksum", "--delete", "--numeric-ids", "--", f"{snapshot}/", f"{root}/"],
            capture_output=True,
            check=False,
        )
        if result.returncode:
            raise RuntimeError("verified snapshot restore failed; keep the stopped services and inspect locally")
        mode = saved.get("sourceRootMode")
        if not isinstance(mode, int) or not 0 <= mode <= 0o7777:
            raise ValueError("snapshot root mode is invalid")
        os.chmod(root, mode)
        actual = SNAPSHOT.fingerprint(root)
        if any(actual[key] != saved.get(key) for key in actual):
            raise RuntimeError("restored installation does not match the verified snapshot")
    expected = HOST.installation_fingerprint(root, current, context)
    HOST.require_current_state(root, expected)
    start_core(root, context, force_recreate=True)
    core = HOST.current_core(root, context)
    if core.get("image") != f"{current['image']}@{current['digest']}" or core.get("health") != "healthy":
        raise RuntimeError("previous Orbis release did not recover to a healthy state")
    record["stage"] = "rolled-back"
    write_journal(snapshot, record)


def apply_update(root: Path, current: dict[str, str], target: dict[str, str], context: str, snapshot: Path) -> dict[str, object]:
    with HOST.host_lock(root):
        update_plan(root, current, target, context, snapshot)
        record = {
            "schema": JOURNAL_SCHEMA,
            "root": str(root),
            "snapshot": str(snapshot),
            "dockerContext": context,
            "previousDigest": current["digest"],
            "targetDigest": target["digest"],
            "stage": "preparing",
        }
        write_journal(snapshot, record)
        try:
            docker_checked(context, ["pull", f"{target['image']}@{target['digest']}"], root, "Docker could not pull the verified Orbis image")
            record["stage"] = "pulled"
            write_journal(snapshot, record)
            record["stage"] = "stopping"
            write_journal(snapshot, record)
            stop_core(root, context)
            require_quiet_apps(root, context)
            record["stage"] = "stopped"
            write_journal(snapshot, record)
            SNAPSHOT.capture(root, snapshot, current["tag"], context)
            record["stage"] = "snapshot-ready"
            write_journal(snapshot, record)
            HOST.STAGE.stage(root, target)
            record["stage"] = "staged"
            write_journal(snapshot, record)
            start_core(root, context)
            core = HOST.current_core(root, context)
            if core.get("image") != f"{target['image']}@{target['digest']}" or core.get("state") != "running" or core.get("health") != "healthy":
                raise RuntimeError("new Orbis core did not reach the verified image and healthy state")
            HOST.write_state(root, HOST.installation_fingerprint(root, target, context))
            record["stage"] = "complete"
            write_journal(snapshot, record)
            return {"result": "healthy", "releaseTag": target["tag"], "snapshot": str(snapshot), "journal": str(journal_path(snapshot))}
        except Exception as error:
            if record["stage"] in {"preparing", "pulled"}:
                record["stage"] = "aborted"
                write_journal(snapshot, record)
                raise RuntimeError("update stopped before service downtime") from error
            try:
                rollback(root, current, context, snapshot, record)
            except Exception as rollback_error:
                record["stage"] = "rollback-failed"
                write_journal(snapshot, record)
                raise RuntimeError(f"update and automatic rollback failed; preserve {snapshot} and inspect the stopped installation") from rollback_error
            raise RuntimeError("update failed; the previous release was restored and is healthy") from error


def recover(root: Path, current: dict[str, str], target: dict[str, str], context: str, snapshot: Path) -> dict[str, object]:
    with HOST.host_lock(root):
        record = read_journal(snapshot, root, context, current, target)
        if record.get("stage") in TERMINAL_STAGES:
            raise ValueError("update transaction is already complete or recovered")
        if record.get("stage") in {"preparing", "pulled"}:
            expected = HOST.installation_fingerprint(root, current, context)
            HOST.require_current_state(root, expected)
            core_ownership(root, context)
            core = HOST.current_core(root, context)
            if (
                core.get("image") != f"{current['image']}@{current['digest']}"
                or core.get("state") != "running"
                or core.get("health") != "healthy"
            ):
                raise RuntimeError("previous release is not healthy before service downtime")
            record["stage"] = "aborted"
            write_journal(snapshot, record)
            return {"result": "aborted-before-downtime", "releaseTag": current["tag"]}
        try:
            rollback(root, current, context, snapshot, record)
        except Exception as error:
            record["stage"] = "rollback-failed"
            write_journal(snapshot, record)
            raise RuntimeError(f"recovery failed; preserve {snapshot} and inspect the stopped installation") from error
        return {"result": "rolled-back", "releaseTag": current["tag"], "snapshot": str(snapshot)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "apply", "recover"))
    parser.add_argument("root", type=Path, help="enrolled Orbis CLI v4.10.1 installation root")
    parser.add_argument("current_manifest", type=Path, help="currently enrolled release manifest")
    parser.add_argument("target_manifest", type=Path, help="new published Orbis release manifest")
    parser.add_argument("--docker-context", required=True, help="explicit Docker context name")
    parser.add_argument("--snapshot", type=Path, required=True, help="new snapshot directory outside the installation")
    parser.add_argument("--confirm-root", help="exact resolved installation root for apply and recover")
    args = parser.parse_args()
    try:
        root = args.root.expanduser().resolve(strict=True)
        expanded_snapshot = args.snapshot.expanduser()
        snapshot = expanded_snapshot.parent.resolve(strict=True) / expanded_snapshot.name
        current = HOST.PLAN.validate_manifest(json.loads(args.current_manifest.read_text(encoding="utf-8")))
        target = HOST.PLAN.validate_manifest(json.loads(args.target_manifest.read_text(encoding="utf-8")))
        if args.action == "plan":
            result = update_plan(root, current, target, args.docker_context, snapshot)
        else:
            HOST.require_confirmation(root, args.confirm_root)
            if args.action == "apply":
                result = apply_update(root, current, target, args.docker_context, snapshot)
            else:
                result = recover(root, current, target, args.docker_context, snapshot)
        print(json.dumps(result, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"Orbis host update failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
