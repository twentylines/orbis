#!/usr/bin/env python3
"""Checkpoint and recover all writers of one Linux Runtipi installation.

This is the stopped-state transaction used by the replacement installer. It
does not replace images or reset accounts. Recovery restores the verified
storage and the original containers, running states and restart policies.
"""

import argparse
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
import importlib.util


SPEC = importlib.util.spec_from_file_location("orbis_restore_for_transaction", Path(__file__).with_name("orbis-install-restore.py"))
assert SPEC and SPEC.loader
RESTORE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RESTORE)
STORAGE = RESTORE.STORAGE
APPS = STORAGE.APPS
SCHEMA = "orbis.installation-transaction.v1"
STAGES = {"prepared", "quiescing", "snapshotting", "ready", "recovering", "restoring", "starting", "recovered"}
NO_RESTART = {"Name": "no", "MaximumRetryCount": 0}


class TransactionError(ValueError):
    pass


def validate_review(value: dict) -> None:
    if value.get("schema") != SCHEMA or value.get("reviewId") != APPS.digest({key: item for key, item in value.items() if key != "reviewId"}):
        raise TransactionError("The installation review is invalid or was edited")
    storage = STORAGE.validate_review(value["storage"])
    if value["root"] != storage["root"] or value["dockerContext"] != storage["dockerContext"]:
        raise TransactionError("The installation and storage reviews do not match")
    roles = value.get("roles")
    if not isinstance(roles, dict) or set(roles) != {item["id"] for item in storage["containers"]}:
        raise TransactionError("The reviewed container roles are invalid")
    if set(roles.values()) - {"controller", "proxy", "database", "queue", "app"}:
        raise TransactionError("The reviewed container role is unsupported")
    for role in ("controller", "database", "queue"):
        if list(roles.values()).count(role) != 1:
            raise TransactionError("Exactly one controller, database and queue must be reviewed")


def private_paths(root: Path, storage: dict, journal: Path) -> Path:
    journal = APPS.journal_path(journal, root)
    lock = root.parent / f".{root.name}.orbis-host.lock"
    targets = [Path(item["source"]) for item in storage["resources"]] + [Path(storage["bundle"])]
    if any(STORAGE.overlaps(path, target) for path in (journal, lock) for target in targets):
        raise TransactionError("The installation journal and lock must be outside every storage source and backup")
    return journal


def review(root: Path, reader, bundle: Path, journal: Path) -> dict:
    storage = STORAGE.review(root, reader, bundle)
    if storage["conflictingWriters"]:
        raise TransactionError("Another container can write to this installation's storage")
    journal = private_paths(root, storage, journal)
    if journal.exists() or journal.is_symlink():
        raise TransactionError("An installation transaction already exists; use its recovery command")
    _, installation = APPS.selected_installation(reader, root)
    controller = installation["container"]["id"]
    roles = {}
    for item in storage["containerStates"]:
        raw = reader.app(item["id"])
        labels = raw["labels"]
        if item["id"] == controller:
            role = "controller"
        elif labels.get("com.docker.compose.project") == "runtipi" and APPS.DETECT.path(labels.get("com.docker.compose.project.working_dir")) == str(root):
            role = {"runtipi-db": "database", "runtipi-queue": "queue", "runtipi-reverse-proxy": "proxy"}.get(labels.get("com.docker.compose.service"))
            if role is None:
                raise TransactionError("A core service has an unsupported role")
        else:
            role = "app"
        roles[item["id"]] = role
        if role in {"controller", "database", "queue"} and item["state"] != "running":
            raise TransactionError("Start the original controller, database and queue before reviewing a checkpoint")
    value = {"schema": SCHEMA, "root": str(root), "dockerContext": reader.context, "journal": str(journal), "storage": storage, "roles": roles}
    value["reviewId"] = APPS.digest(value)
    validate_review(value)
    require_healthy(reader, controller)
    if STORAGE.review(root, reader, bundle) != storage:
        raise TransactionError("The installation changed during review")
    return value


def require_healthy(reader, identifier: str, timeout: int = 0) -> None:
    deadline = time.monotonic() + timeout
    while True:
        value = reader._object(["container", "inspect", "--format", "{{json .State}}", identifier])
        if value.get("Status") == "running" and (value.get("Health") or {}).get("Status") == "healthy":
            return
        if time.monotonic() >= deadline or value.get("Status") in {"exited", "dead"}:
            raise TransactionError("The original controller did not become healthy; keep its recovery journal")
        time.sleep(1)


def identities(root: Path, reader, value: dict) -> dict:
    storage = value["storage"]
    current = STORAGE.review(root, reader, Path(storage["bundle"]), check_capacity=False, existing_bundle=True)
    if current["identityHash"] != storage["identityHash"] or current["conflictingWriters"]:
        raise TransactionError("Container definitions, storage, or Docker changed; keep the recovery journal")
    expected = {item["id"]: item for item in storage["containerStates"]}
    for item in current["containerStates"]:
        if item["restartPolicy"] not in [expected[item["id"]]["restartPolicy"], NO_RESTART]:
            raise TransactionError("A container restart policy changed outside the installation transaction")
        if expected[item["id"]]["state"] != "running" and item["state"] != expected[item["id"]]["state"]:
            raise TransactionError("An originally stopped container changed state outside the transaction")
    return {item["id"]: item for item in current["containerStates"]}


def save(record: dict) -> None:
    APPS.write_journal(Path(record["review"]["journal"]), record)


def ordered(value: dict, *, starting: bool = False) -> list[dict]:
    ranks = {"database": 0, "queue": 1, "app": 2, "controller": 3, "proxy": 4} if starting else {"controller": 0, "proxy": 1, "app": 2, "queue": 3, "database": 4}
    return sorted(value["storage"]["containerStates"], key=lambda item: (ranks[value["roles"][item["id"]]], item["id"]))


def quiesce(root: Path, reader, record: dict) -> None:
    value = record["review"]
    identities(root, reader, value)
    for original in ordered(value):
        identities(root, reader, value)
        reader.change(["update", "--restart", "no", original["id"]])
    for original in ordered(value):
        current = identities(root, reader, value)[original["id"]]
        if current["state"] == "running":
            timeout = reader.app(original["id"]).get("stopTimeout")
            if timeout is not None and (type(timeout) is not int or not 0 <= timeout <= 3600):
                raise TransactionError("A container stop timeout is invalid")
            reader.change(["stop", original["id"]], timeout=max(90, (timeout or 10) + 30))
    STORAGE.require_quiet_existing(root, reader, value["storage"])


def checkpoint(root: Path, reader, value: dict, *, host_writers_stopped: bool) -> dict:
    validate_review(value)
    if not host_writers_stopped:
        raise TransactionError("Confirm native host and remote storage writers are stopped before checkpointing")
    if review(root, reader, Path(value["storage"]["bundle"]), Path(value["journal"])) != value:
        raise TransactionError("The installation changed; review it again before stopping services")
    RESTORE.runtime()
    record = {"schema": SCHEMA, "id": str(uuid.uuid4()), "stage": "prepared", "review": value}
    save(record)
    record["stage"] = "quiescing"
    save(record)
    quiesce(root, reader, record)
    record["stage"] = "snapshotting"
    save(record)
    STORAGE.capture(root, reader, value["storage"], host_writers_stopped=True)
    manifest = STORAGE.verified_manifest(Path(value["storage"]["bundle"]))
    record.update(stage="ready", backupFingerprint=APPS.digest(manifest))
    save(record)
    return {"schema": SCHEMA, "result": "installation-checkpointed", "journal": value["journal"], "containersRemainStopped": True, "resources": len(manifest["copies"])}


def read_record(path: Path, root: Path, reader) -> dict:
    record = RESTORE.private_json(path)
    value = record.get("review")
    if record.get("schema") != SCHEMA or record.get("stage") not in STAGES or not isinstance(value, dict):
        raise TransactionError("The installation journal is invalid")
    validate_review(value)
    if value["root"] != str(root) or value["dockerContext"] != reader.context or private_paths(root, value["storage"], path) != Path(value["journal"]):
        raise TransactionError("The installation journal belongs to another root or Docker context")
    return record


def recover(root: Path, reader, path: Path, *, host_writers_stopped: bool) -> dict:
    if not host_writers_stopped:
        raise TransactionError("Confirm native host and remote storage writers are stopped before recovery")
    RESTORE.runtime()
    record = read_record(path, root, reader)
    if record["stage"] == "recovered":
        raise TransactionError("This installation has already recovered; its journal cannot be replayed")
    value = record["review"]
    origin = record.setdefault("recoveryStartedFrom", record["stage"])
    record["stage"] = "recovering"
    save(record)
    quiesce(root, reader, record)
    bundle = Path(value["storage"]["bundle"])
    target = bundle / "storage.json"
    if "backupFingerprint" in record or origin in {"ready", "restoring", "starting"} or record.get("restoreReview"):
        manifest = STORAGE.verified_manifest(bundle)
    elif target.exists():
        unfinished = RESTORE.private_json(target)
        manifest = STORAGE.verified_manifest(bundle) if unfinished.get("stage") == "complete" else None
    else:
        manifest = None
    if manifest is not None:
        if manifest["plan"] != value["storage"] or ("backupFingerprint" in record and record["backupFingerprint"] != APPS.digest(manifest)):
            raise TransactionError("The backup does not match this installation transaction")
        restore_review = record.get("restoreReview") or RESTORE.review(root, reader, bundle)
        restore_path = Path(record.get("restoreJournal", str(path) + ".restore.json"))
        if restore_path.exists() and RESTORE.private_json(restore_path).get("stage") == "complete":
            # A previous recovery may have reached startup before interruption.
            # Those services can have changed data; repeat from the sealed copy.
            restore_path = Path(str(path) + f".restore-{uuid.uuid4()}.json")
            restore_review = RESTORE.review(root, reader, bundle)
        record.update(stage="restoring", restoreReview=restore_review, restoreJournal=str(restore_path))
        save(record)
        if restore_path.exists():
            RESTORE.restore(root, reader, restore_review, restore_path, host_writers_stopped=True, recover=True)
        else:
            RESTORE.restore(root, reader, restore_review, restore_path, host_writers_stopped=True)
    record["stage"] = "starting"
    save(record)
    for original in ordered(value, starting=True):
        current = identities(root, reader, value)[original["id"]]
        if original["state"] == "running" and current["state"] != "running":
            reader.change(["start", original["id"]], timeout=180)
        if value["roles"][original["id"]] == "controller":
            require_healthy(reader, original["id"], timeout=180)
    for original in ordered(value, starting=True):
        identities(root, reader, value)
        policy = original["restartPolicy"]
        flag = policy["Name"] + (f":{policy['MaximumRetryCount']}" if policy["Name"] == "on-failure" else "")
        reader.change(["update", "--restart", flag, original["id"]])
    current = identities(root, reader, value)
    if current != {item["id"]: item for item in value["storage"]["containerStates"]}:
        raise TransactionError("The recovered containers do not match their original states and policies")
    record.update(stage="recovered", storageRestored=manifest is not None)
    save(record)
    return {"schema": SCHEMA, "result": "original-installation-recovered", "journal": str(path), "storageRestored": manifest is not None, "containers": len(current)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("review", "checkpoint", "recover"))
    parser.add_argument("root", type=Path)
    parser.add_argument("--docker-context", required=True)
    parser.add_argument("--backup", type=Path)
    parser.add_argument("--journal", type=Path, required=True)
    parser.add_argument("--review", type=Path)
    parser.add_argument("--confirm-root")
    parser.add_argument("--host-writers-stopped", action="store_true")
    args = parser.parse_args()
    try:
        if sys.platform != "linux" or os.geteuid() != 0:
            raise TransactionError("Run this helper as root on the Linux Docker host")
        root = args.root.expanduser().resolve(strict=True)
        reader = APPS.Docker(args.docker_context)
        with APPS.HOST.host_lock(root) as lock_fd:
            # A native copier retains this same flock if the Python installer
            # is killed. Recovery cannot race a surviving cp, rsync or Docker CLI.
            reader.lock_fd = lock_fd
            if args.action == "review":
                if args.backup is None:
                    raise TransactionError("Choose a new private backup destination")
                result = review(root, reader, args.backup.expanduser(), args.journal.expanduser())
            else:
                APPS.HOST.require_confirmation(root, args.confirm_root)
                if args.action == "checkpoint":
                    if args.review is None:
                        raise TransactionError("A private saved installation review is required")
                    value = RESTORE.private_json(args.review.expanduser())
                    if value.get("journal") != str(args.journal.expanduser()):
                        raise TransactionError("The review belongs to another journal")
                    result = checkpoint(root, reader, value, host_writers_stopped=args.host_writers_stopped)
                else:
                    result = recover(root, reader, args.journal.expanduser(), host_writers_stopped=args.host_writers_stopped)
        print(json.dumps(result, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        message = str(error) if isinstance(error, TransactionError) else "Installation operation did not finish; preserve the private journal and inspect it locally"
        print(json.dumps({"schema": SCHEMA, "result": "installation-transaction-failed", "message": message}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
