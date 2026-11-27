#!/usr/bin/env python3
"""Checkpoint and recover all writers of one Linux Runtipi installation.

This is the stopped-state transaction used by the replacement installer. It
does not replace images or reset accounts. Recovery restores the verified
storage and the original containers, running states and restart policies.
"""

import argparse
import hashlib
import json
import os
import re
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
NO_BACKUP_SCHEMA = "orbis.controller-update-handoff.v1"
RUNTIPI_CONFIGURATION_SCHEMA = "orbis.update-runtipi-configuration.v1"
RUNTIPI_CONFIGURATION_FILES = frozenset({".env", "VERSION", "orbis-compose.yml"})
NO_RESTART = {"Name": "no", "MaximumRetryCount": 0}


class TransactionError(ValueError):
    pass


def validate_review(value: dict) -> None:
    if value.get("schema") != SCHEMA or value.get("reviewId") != APPS.digest({key: item for key, item in value.items() if key != "reviewId"}):
        raise TransactionError("The installation review is invalid or was edited")
    if value.get("backupPolicy") not in {None, "none"}:
        raise TransactionError("The installation backup policy is unsupported")
    storage = STORAGE.validate_review(value["storage"])
    if value.get("backupPolicy") == "none" and (storage.get("backupScope") != STORAGE.LIVE_PROXY_SCOPE or storage["estimatedBytes"] != 0):
        raise TransactionError("A no-backup handoff requires the live-proxy controller scope")
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
    locks = APPS.HOST.AUTHORITY.LAYOUT.lock_paths(root)
    targets = [Path(item["source"]) for item in storage["resources"]] + [Path(storage["bundle"])]
    if any(STORAGE.overlaps(path, target) for path in (journal, *locks) for target in targets):
        raise TransactionError("The installation journal and lock must be outside every storage source and backup")
    return journal


def semantic_review(value: dict) -> dict:
    return {key: STORAGE.semantic_review(item) if key == "storage" else item for key, item in value.items() if key != "reviewId"}


def review(root: Path, reader, bundle: Path, journal: Path, *, scope: str = "full", backup: bool = True) -> dict:
    if type(backup) is not bool or not backup and scope != STORAGE.LIVE_PROXY_SCOPE:
        raise TransactionError("Only controller updates support a no-backup review")
    storage = STORAGE.review(root, reader, bundle, scope=scope, check_capacity=backup)
    if storage["conflictingWriters"]:
        raise TransactionError(STORAGE.writer_conflict_message(storage["conflictingWriters"]))
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
    if not backup:
        value["backupPolicy"] = "none"
    value["reviewId"] = APPS.digest(value)
    validate_review(value)
    require_healthy(reader, controller)
    if STORAGE.semantic_review(STORAGE.review(root, reader, bundle, scope=scope, check_capacity=backup)) != STORAGE.semantic_review(storage):
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
    current = STORAGE.review(root, reader, Path(storage["bundle"]), check_capacity=False, existing_bundle=True, scope=storage.get("backupScope", "full"))
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


def quiesce_without_backup(root: Path, reader, value: dict, *, host_writers_stopped: bool) -> dict:
    """Create a distinct stopped-controller handoff, never a recovery backup."""
    validate_review(value)
    if value.get("backupPolicy") != "none" or not host_writers_stopped:
        raise TransactionError("Confirm the no-backup policy and native host writers before handoff")
    current = review(root, reader, Path(value["storage"]["bundle"]), Path(value["journal"]),
                     scope=STORAGE.LIVE_PROXY_SCOPE, backup=False)
    if semantic_review(current) != semantic_review(value):
        raise TransactionError("The installation changed before controller handoff")
    record = {"schema": NO_BACKUP_SCHEMA, "id": str(uuid.uuid4()), "stage": "quiescing", "review": value, "backupCreated": False}
    save(record)
    quiesce(root, reader, record)
    record["stage"] = "ready"
    save(record)
    return record


def read_no_backup_handoff(path: Path, root: Path, reader, *, verify_runtime: bool = True) -> dict:
    record = RESTORE.private_json(path)
    value = record.get("review")
    if (record.get("schema") != NO_BACKUP_SCHEMA or record.get("stage") != "ready" or record.get("backupCreated") is not False
            or "backupFingerprint" in record or not isinstance(value, dict) or value.get("backupPolicy") != "none"):
        raise TransactionError("A complete no-backup controller handoff is required")
    validate_review(value)
    if (value["root"] != str(root) or value["dockerContext"] != reader.context
            or private_paths(root, value["storage"], path) != Path(value["journal"])):
        raise TransactionError("The controller handoff belongs to another root or Docker context")
    if type(verify_runtime) is not bool:
        raise TransactionError("Choose an explicit handoff runtime verification policy")
    if verify_runtime:
        identities(root, reader, value)
        STORAGE.require_quiet_existing(root, reader, value["storage"])
    return record


def checkpoint(root: Path, reader, value: dict, *, host_writers_stopped: bool, progress=None) -> dict:
    validate_review(value)
    if value.get("backupPolicy") == "none":
        raise TransactionError("A no-backup review cannot create a legacy checkpoint")
    if not host_writers_stopped:
        raise TransactionError("Confirm native host and remote storage writers are stopped before checkpointing")
    if semantic_review(review(root, reader, Path(value["storage"]["bundle"]), Path(value["journal"]), scope=value["storage"].get("backupScope", "full"))) != semantic_review(value):
        raise TransactionError("The installation changed; review it again before stopping services")
    RESTORE.runtime()
    record = {"schema": SCHEMA, "id": str(uuid.uuid4()), "stage": "prepared", "review": value}
    save(record)
    record["stage"] = "quiescing"
    save(record)
    if progress is not None:
        progress("stopping")
    quiesce(root, reader, record)
    record["stage"] = "snapshotting"
    save(record)
    if progress is not None:
        progress("snapshotting")
    STORAGE.capture(root, reader, value["storage"], host_writers_stopped=True)
    manifest = STORAGE.verified_manifest(Path(value["storage"]["bundle"]))
    record.update(stage="ready", backupFingerprint=APPS.digest(manifest))
    save(record)
    if progress is not None:
        progress("snapshot-ready")
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


def _runtipi_configuration_record(root, record, path, current, target, binding, compatibility):
    """Derive the approved file set from the already sealed root backup."""
    plan = APPS.HOST.PLAN
    current, target = plan.validate_manifest(current), plan.require_installation_protocol(target)
    fields = {"operationId", "approvedReviewSha256", "sourceReceiptSha256", "targetReceiptSha256"}
    if type(binding) is not dict or set(binding) != fields or type(compatibility) is not dict:
        raise TransactionError("The Runtipi configuration operation binding is invalid")
    try:
        operation = uuid.UUID(binding["operationId"])
        checkpoint_id = uuid.UUID(record["id"])
    except (ValueError, TypeError, AttributeError, KeyError):
        raise TransactionError("The Runtipi configuration operation binding is invalid") from None
    if (operation.version != 4 or str(operation) != binding["operationId"]
            or checkpoint_id.version != 4 or str(checkpoint_id) != record["id"]
            or any(type(binding[name]) is not str or not re.fullmatch(r"[a-f0-9]{64}", binding[name])
                   for name in fields - {"operationId"})
            or binding["approvedReviewSha256"] != APPS.digest(compatibility)):
        raise TransactionError("The Runtipi configuration review does not match this operation")

    checkpoint = record["review"]
    storage = checkpoint["storage"]
    snapshot = Path(storage["bundle"])
    if (checkpoint.get("backupPolicy") == "none" or not record.get("backupFingerprint")
            or snapshot.name != f"orbis-{target['tag']}-{operation}"
            or path != snapshot.with_name(snapshot.name + ".checkpoint.json")):
        raise TransactionError("Runtipi configuration requires this operation's verified backup")
    backup = STORAGE.verified_manifest(snapshot)
    if backup["plan"] != storage or APPS.digest(backup) != record["backupFingerprint"]:
        raise TransactionError("The Runtipi configuration backup no longer matches the checkpoint")
    retained = compatibility.get("retainedFileSha256")
    allowed = set(APPS.HOST.AUTHORITY.CONFIG_PATHS) | {"VERSION"}
    if (type(retained) is not dict or not (RUNTIPI_CONFIGURATION_FILES | {"docker-compose.yml"}) <= retained.keys() <= allowed
            or any(type(value) is not str or not re.fullmatch(r"[a-f0-9]{64}", value) for value in retained.values())
            or compatibility.get("currentTag") != current["tag"] or compatibility.get("currentDigest") != current["digest"]
            or compatibility.get("targetTag") != target["tag"] or compatibility.get("targetDigest") != target["digest"]):
        raise TransactionError("The reviewed Runtipi files or releases do not match the approved change")
    indexes = [index for index, resource in enumerate(storage["resources"])
               if resource["kind"] == "directory" and resource["source"] == str(root)]
    if len(indexes) != 1:
        raise TransactionError("The Runtipi configuration backup must contain the retained installation root")
    copy = snapshot / f"resource-{indexes[0]:04d}"
    before = {name: plan.read_review_file(copy / name) for name in retained}
    sha = lambda body: hashlib.sha256(body).hexdigest()
    if {name: sha(body) for name, body in before.items()} != retained:
        raise TransactionError("The backed-up configuration differs from the approved Runtipi review")
    after, _ = plan.configuration_412(current, target, before[".env"], before["VERSION"])
    override = plan.override_412(target)
    if ({name: sha(body) for name, body in after.items()} != compatibility.get("prospectiveFileSha256")
            or sha(override.encode()) != compatibility.get("prospectiveOverrideSha256")):
        raise TransactionError("The target Runtipi configuration differs from the approved review")
    after["orbis-compose.yml"] = (APPS.HOST.STAGE.HEADER + override).encode()
    receipt = {
        "schema": RUNTIPI_CONFIGURATION_SCHEMA, "binding": dict(binding),
        "checkpointId": record["id"], "backupFingerprint": record["backupFingerprint"],
        "sourceManifestSha256": APPS.digest(current), "targetManifestSha256": APPS.digest(target),
        "compatibility": compatibility, "stagedFileSha256": {name: sha(body) for name, body in after.items()},
    }
    states = {}
    for name in sorted(allowed):
        file = root / name
        if name not in before:
            if os.path.lexists(file):
                raise TransactionError("An unreviewed configuration file appeared during the Runtipi change")
            continue
        actual = plan.read_review_file(file)
        if actual == before[name]:
            if name in after:
                states[name] = "source"
        elif name in after and actual == after[name]:
            states[name] = "target"
        else:
            raise TransactionError("A configuration file differs from both approved Runtipi states")
    return receipt, states


def prepare_runtipi_configuration(root, reader, path, current, target, binding):
    """Record the reviewed 4.12 file pair after the enclosing producer seals its backup."""
    record = read_record(path, root, reader)
    if record["stage"] != "ready":
        raise TransactionError("Runtipi configuration preparation requires a completed stopped checkpoint")
    compatibility = APPS.HOST.PLAN.review_412(root, current, target)
    receipt, states = _runtipi_configuration_record(root, record, path, current, target, binding, compatibility)
    if any(state != "source" for state in states.values()):
        raise TransactionError("Runtipi configuration staging has already started")
    STORAGE.require_quiet_existing(root, reader, record["review"]["storage"])
    previous = record.get("runtipiConfiguration")
    if previous is not None and previous != receipt:
        raise TransactionError("Another Runtipi configuration preparation already owns this checkpoint")
    if previous is None:
        if read_record(path, root, reader) != record:
            raise TransactionError("The Runtipi checkpoint changed during preparation")
        record["runtipiConfiguration"] = receipt
        save(record)
    return receipt


def runtipi_configuration_recovery_state(root, reader, path, current, target, binding):
    """Verify exact source/target file bytes before the producer restores its backup."""
    record = read_record(path, root, reader)
    saved = record.get("runtipiConfiguration")
    if record["stage"] not in {"ready", "recovering", "restoring", "starting"} or type(saved) is not dict:
        raise TransactionError("No active Runtipi configuration preparation is available")
    receipt, states = _runtipi_configuration_record(root, record, path, current, target, binding, saved.get("compatibility"))
    if saved != receipt:
        raise TransactionError("The saved Runtipi configuration preparation has changed")
    return states


def recover(root: Path, reader, path: Path, *, host_writers_stopped: bool, before_controller_start=None, before_originals_start=None) -> dict:
    if not host_writers_stopped:
        raise TransactionError("Confirm native host and remote storage writers are stopped before recovery")
    if before_originals_start is not None and not callable(before_originals_start):
        raise TransactionError('The enclosing Root recovery verifier is invalid')
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
    if before_originals_start is not None:
        before_originals_start()
    return finish_recovery(root, reader, path, before_controller_start=before_controller_start)


def finish_recovery(root: Path, reader, path: Path, *, before_controller_start=None) -> dict:
    """Finish an already restored transaction without replaying its data copy.

    The enclosing Root issuer must independently establish that starting has
    been committed before choosing this internal recovery step.
    """
    record = read_record(path, root, reader)
    if record['stage'] != 'starting':
        raise TransactionError('Only a restored transaction can finish original startup')
    value = record['review']
    for original in ordered(value, starting=True):
        current = identities(root, reader, value)[original["id"]]
        if original["state"] == "running" and current["state"] != "running":
            if value["roles"][original["id"]] == "controller" and before_controller_start is not None:
                before_controller_start()
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
    record.update(stage="recovered", storageRestored=bool(record.get('restoreReview')))
    save(record)
    return {"schema": SCHEMA, "result": "original-installation-recovered", "journal": str(path), "storageRestored": record['storageRestored'], "containers": len(current)}


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
