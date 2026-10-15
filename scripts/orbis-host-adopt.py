#!/usr/bin/env python3
"""Adopt a self-contained Runtipi CLI v4.10.1 installation into Orbis.

This command requires stopped managed apps and refuses their external bind mounts
and named volumes. It snapshots the stopped stock tree before staging Orbis and
can restore stock from that snapshot. Use a separate Docker context for tests.
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


UPDATE = load_script("orbis-host-update.py", "orbis_update_for_adoption")
HOST = UPDATE.HOST
SNAPSHOT = UPDATE.SNAPSHOT
STOCK_IMAGE = "ghcr.io/runtipi/runtipi:v4.10.1"
STOCK_RELEASE = "runtipi:v4.10.1"
JOURNAL_SCHEMA = "orbis.adoption.v1"
TERMINAL_STAGES = {"complete", "rolled-back", "aborted"}


def journal_path(snapshot: Path) -> Path:
    return snapshot.with_name(f"{snapshot.name}.orbis-adopt.json")


def write_journal(snapshot: Path, record: dict[str, object]) -> None:
    target = journal_path(snapshot)
    descriptor, name = tempfile.mkstemp(prefix=f".{snapshot.name}.orbis-adopt-", dir=snapshot.parent)
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


def read_journal(snapshot: Path, root: Path, context: str, target: dict[str, str]) -> dict[str, object]:
    path = journal_path(snapshot)
    if path.is_symlink() or not path.is_file():
        raise ValueError("adoption journal is missing or is not a regular file")
    record = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(record, dict) or record.get("schema") != JOURNAL_SCHEMA:
        raise ValueError("adoption journal has an unsupported schema")
    if (
        record.get("root") != str(root)
        or record.get("snapshot") != str(snapshot)
        or record.get("dockerContext") != context
        or record.get("targetDigest") != target["digest"]
        or record.get("stockImage") != STOCK_IMAGE
        or not isinstance(record.get("stockImageId"), str)
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", record["stockImageId"])
    ):
        raise ValueError("adoption journal does not match this installation and release")
    return record


def stock_image_id(root: Path, context: str) -> str:
    raw = UPDATE.docker_checked(
        context,
        ["image", "inspect", "--format", "{{json .Id}}", STOCK_IMAGE],
        root,
        "the pinned stock Runtipi image is unavailable locally",
    )
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("Docker returned an invalid stock image ID") from error
    if not isinstance(value, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
        raise RuntimeError("Docker returned an invalid stock image ID")
    return value


def require_self_contained_apps(root: Path, context: str) -> None:
    ids = UPDATE.docker_checked(
        context, ["ps", "--all", "--format", "{{.ID}}"], root, "Docker could not list installed containers"
    ).splitlines()
    for container in ids:
        labels = UPDATE.inspect_json(root, context, container, "{{json .Config.Labels}}")
        if not isinstance(labels, dict):
            raise RuntimeError("Docker returned invalid app labels")
        if "runtipi.managed" not in labels:
            continue
        mounts = UPDATE.inspect_json(root, context, container, "{{json .Mounts}}")
        if not isinstance(mounts, list):
            raise RuntimeError("Docker returned invalid app mounts")
        for mount in mounts:
            if not isinstance(mount, dict):
                raise RuntimeError("Docker returned invalid app mounts")
            if mount.get("Type") == "volume":
                raise ValueError("a managed app uses a Docker volume outside the installation snapshot")
            if mount.get("Type") == "bind":
                source = mount.get("Source")
                if not isinstance(source, str) or not Path(source).resolve(strict=False).is_relative_to(root):
                    raise ValueError("a managed app has a bind mount outside the installation snapshot")


def stock_core(root: Path, context: str) -> dict[str, object]:
    UPDATE.core_ownership(root, context)
    core = HOST.current_core(root, context)
    if core.get("image") != STOCK_IMAGE or core.get("state") != "running" or core.get("health") != "healthy":
        raise ValueError("stock Runtipi v4.10.1 must be running and healthy")
    running_id = UPDATE.inspect_json(root, context, "runtipi", "{{json .Image}}")
    local_id = stock_image_id(root, context)
    if running_id != local_id:
        raise ValueError("the running stock core differs from the locally pinned stock image")
    return {"image": STOCK_IMAGE, "imageId": local_id}


def adoption_plan(root: Path, target: dict[str, str], context: str, snapshot: Path) -> dict[str, object]:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", context):
        raise ValueError("Docker context name is invalid")
    if shutil.which("rsync") is None:
        raise ValueError("rsync is required to restore a stopped installation snapshot")
    if journal_path(snapshot).exists() or journal_path(snapshot).is_symlink():
        raise ValueError("an adoption journal already exists for this snapshot destination")
    snapshot_estimate = SNAPSHOT.preflight(root, snapshot)
    if (root / "orbis-compose.yml").exists() or (root / "orbis-compose.yml").is_symlink():
        raise ValueError("Orbis is already staged in this installation")
    if HOST.saved_state(root) is not None:
        raise ValueError("this installation is already enrolled in Orbis")
    candidate = HOST.PLAN.plan(root, target)
    if candidate.get("configuredImage") != STOCK_IMAGE or candidate.get("standardOrbisOverrideIncluded"):
        raise ValueError("the configured core is not stock Runtipi v4.10.1")
    UPDATE.docker_checked(context, ["info", "--format", "{{.ID}}"], root, "the selected Docker context is unavailable")
    previous = stock_core(root, context)
    UPDATE.require_quiet_apps(root, context)
    require_self_contained_apps(root, context)
    UPDATE.verify_release(target)
    return {
        "result": "ready-to-adopt",
        "root": str(root),
        "dockerContext": context,
        "stockImage": previous["image"],
        "stockImageId": previous["imageId"],
        "targetTag": target["tag"],
        "targetImage": f"{target['image']}@{target['digest']}",
        "snapshot": str(snapshot),
        "snapshotBytes": snapshot_estimate["bytes"],
        "managedAppsMustBeStopped": True,
    }


def restore_tree(root: Path, snapshot: Path, context: str, record: dict[str, object]) -> None:
    saved = SNAPSHOT.verify(snapshot, root)
    if saved.get("release") != STOCK_RELEASE or saved.get("dockerContext") != context:
        raise ValueError("snapshot was captured for another stock release or Docker context")
    result = subprocess.run(
        ["rsync", "-a", "--checksum", "--delete", "--numeric-ids", "--", f"{snapshot}/", f"{root}/"],
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError("verified stock snapshot restore failed; keep services stopped and inspect locally")
    mode = saved.get("sourceRootMode")
    if not isinstance(mode, int) or not 0 <= mode <= 0o7777:
        raise ValueError("snapshot root mode is invalid")
    os.chmod(root, mode)
    actual = SNAPSHOT.fingerprint(root)
    if any(actual[key] != saved.get(key) for key in actual):
        raise RuntimeError("restored stock installation does not match the verified snapshot")
    if (root / "orbis-compose.yml").exists() or HOST.saved_state(root) is not None:
        raise RuntimeError("Orbis state remained after restoring the stock snapshot")
    if stock_image_id(root, context) != record["stockImageId"]:
        raise RuntimeError("the stock image tag no longer resolves to the captured image ID")


def rollback(root: Path, context: str, snapshot: Path, record: dict[str, object]) -> None:
    origin = record.get("rollbackStartedFrom", record["stage"])
    record["rollbackStartedFrom"] = origin
    record["stage"] = "rolling-back"
    write_journal(snapshot, record)
    UPDATE.stop_core(root, context, allow_absent=True)
    UPDATE.require_quiet_apps(root, context)
    if SNAPSHOT.sidecar(snapshot).is_file():
        restore_tree(root, snapshot, context, record)
    elif origin in {"stopping", "stopped"}:
        if (root / "orbis-compose.yml").exists() or HOST.saved_state(root) is not None:
            raise RuntimeError("stock files changed before a verified snapshot was available")
        if stock_image_id(root, context) != record["stockImageId"]:
            raise RuntimeError("the stock image tag changed before recovery")
    else:
        raise RuntimeError("no verified stock snapshot is available; keep services stopped")
    UPDATE.start_core(root, context, force_recreate=True)
    core = stock_core(root, context)
    if core["imageId"] != record["stockImageId"]:
        raise RuntimeError("stock Runtipi did not recover at its captured image ID")
    record["stage"] = "rolled-back"
    write_journal(snapshot, record)


def apply_adoption(root: Path, target: dict[str, str], context: str, snapshot: Path) -> dict[str, object]:
    with HOST.host_lock(root):
        plan = adoption_plan(root, target, context, snapshot)
        record = {
            "schema": JOURNAL_SCHEMA,
            "root": str(root),
            "snapshot": str(snapshot),
            "dockerContext": context,
            "stockImage": STOCK_IMAGE,
            "stockImageId": plan["stockImageId"],
            "targetDigest": target["digest"],
            "stage": "preparing",
        }
        write_journal(snapshot, record)
        try:
            UPDATE.docker_checked(
                context,
                ["pull", f"{target['image']}@{target['digest']}"],
                root,
                "Docker could not pull the verified Orbis image",
            )
            record["stage"] = "pulled"
            write_journal(snapshot, record)
            record["stage"] = "stopping"
            write_journal(snapshot, record)
            UPDATE.stop_core(root, context)
            UPDATE.require_quiet_apps(root, context)
            record["stage"] = "stopped"
            write_journal(snapshot, record)
            SNAPSHOT.capture(root, snapshot, STOCK_RELEASE, context)
            record["stage"] = "snapshot-ready"
            write_journal(snapshot, record)
            HOST.STAGE.stage(root, target)
            record["stage"] = "staged"
            write_journal(snapshot, record)
            UPDATE.start_core(root, context)
            core = HOST.current_core(root, context)
            if (
                core.get("image") != f"{target['image']}@{target['digest']}"
                or core.get("state") != "running"
                or core.get("health") != "healthy"
            ):
                raise RuntimeError("Orbis did not reach its reviewed image and healthy state")
            HOST.write_state(root, HOST.installation_fingerprint(root, target, context))
            record["stage"] = "complete"
            write_journal(snapshot, record)
            return {
                "result": "healthy",
                "releaseTag": target["tag"],
                "snapshot": str(snapshot),
                "journal": str(journal_path(snapshot)),
                "requiresApplicationChecks": True,
            }
        except Exception as error:
            if record["stage"] in {"preparing", "pulled"}:
                record["stage"] = "aborted"
                write_journal(snapshot, record)
                raise RuntimeError("adoption stopped before service downtime") from error
            try:
                rollback(root, context, snapshot, record)
            except Exception as rollback_error:
                record["stage"] = "rollback-failed"
                write_journal(snapshot, record)
                raise RuntimeError("adoption and stock rollback failed; inspect the stopped installation") from rollback_error
            raise RuntimeError("adoption failed; stock Runtipi was restored and is healthy") from error


def recover(root: Path, target: dict[str, str], context: str, snapshot: Path) -> dict[str, object]:
    with HOST.host_lock(root):
        record = read_journal(snapshot, root, context, target)
        if record.get("stage") in TERMINAL_STAGES:
            raise ValueError("adoption transaction is already complete or recovered")
        if record.get("stage") in {"preparing", "pulled"}:
            core = stock_core(root, context)
            if core["imageId"] != record["stockImageId"]:
                raise RuntimeError("stock core changed before service downtime")
            record["stage"] = "aborted"
            write_journal(snapshot, record)
            return {"result": "aborted-before-downtime", "releaseTag": STOCK_RELEASE}
        try:
            rollback(root, context, snapshot, record)
        except Exception as error:
            record["stage"] = "rollback-failed"
            write_journal(snapshot, record)
            raise RuntimeError("stock recovery failed; inspect the stopped installation") from error
        return {"result": "rolled-back", "releaseTag": STOCK_RELEASE, "snapshot": str(snapshot)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "apply", "recover"))
    parser.add_argument("root", type=Path, help="stock Runtipi CLI v4.10.1 installation root")
    parser.add_argument("target_manifest", type=Path, help="published Orbis release manifest")
    parser.add_argument("--docker-context", required=True, help="explicit Docker context name")
    parser.add_argument("--snapshot", required=True, type=Path, help="new snapshot directory outside the installation")
    parser.add_argument("--confirm-root", help="exact resolved installation root for apply and recover")
    args = parser.parse_args()
    try:
        root = args.root.expanduser().resolve(strict=True)
        expanded = args.snapshot.expanduser()
        snapshot = expanded.parent.resolve(strict=True) / expanded.name
        target = HOST.PLAN.validate_manifest(json.loads(args.target_manifest.read_text(encoding="utf-8")))
        if args.action == "plan":
            result = adoption_plan(root, target, args.docker_context, snapshot)
        else:
            HOST.require_confirmation(root, args.confirm_root)
            result = (
                apply_adoption(root, target, args.docker_context, snapshot)
                if args.action == "apply"
                else recover(root, target, args.docker_context, snapshot)
            )
        print(json.dumps(result, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"Orbis adoption failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
