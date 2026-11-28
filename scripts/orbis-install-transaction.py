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
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from contextlib import contextmanager
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
RUNTIPI_CONFIGURATION_ORDER = (".env", "VERSION", "orbis-compose.yml")
RUNTIPI_CONFIGURATION_FILES = frozenset(RUNTIPI_CONFIGURATION_ORDER)
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


def retain_incomplete_checkpoint(root: Path, storage: dict) -> None:
    approved = Path(storage["bundle"])
    bundle = APPS.journal_path(approved, root)
    if bundle != approved:
        raise TransactionError("The interrupted storage destination changed")
    info = bundle.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise TransactionError("The interrupted storage destination is not a private directory")
    manifest = bundle / "storage.json"
    if os.path.lexists(manifest):
        saved = RESTORE.private_json(manifest)
        if saved.get("schema") != STORAGE.SCHEMA or saved.get("plan") != storage or saved.get("stage") not in {"copying", "verifying"}:
            raise TransactionError("The interrupted storage manifest does not belong to this checkpoint")
    else:
        # The directory and the temporary manifest can survive a stop before
        # the first atomic manifest publication. No resource copy starts then.
        for entry in bundle.iterdir():
            details = entry.lstat()
            if (not entry.name.startswith(".storage.json-") or not stat.S_ISREG(details.st_mode)
                    or details.st_uid != os.geteuid() or stat.S_IMODE(details.st_mode) & 0o077):
                raise TransactionError("An unbound interrupted storage directory contains unexpected files")
    # Keep the failed copy under the private parent. Never overwrite a sealed
    # backup or use bytes from an unfinished copy to restore the installation.
    retained = Path(tempfile.mkdtemp(prefix=f".{bundle.name}.interrupted-", dir=bundle.parent))
    os.rename(bundle, retained / "snapshot")
    for path in (retained, bundle.parent):
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def complete_rollback_checkpoint(root: Path, reader, path: Path, expected: dict) -> None:
    """Seal the accepted source checkpoint before any controller retirement."""
    record = read_record(path, root, reader)
    if (record.get("review") != expected or record["stage"] not in {"prepared", "quiescing", "snapshotting"}
            or expected.get("backupPolicy") == "none" or "backupFingerprint" in record
            or "runtipiConfiguration" in record or "recoveryStartedFrom" in record):
        raise TransactionError("The checkpoint is not an unfinished copy of the accepted source")
    RESTORE.runtime()
    if record["stage"] != "snapshotting":
        record["stage"] = "quiescing"
        save(record)
        quiesce(root, reader, record)
        record["stage"] = "snapshotting"
        save(record)
    storage = expected["storage"]
    bundle = Path(storage["bundle"])
    if os.path.lexists(bundle):
        STORAGE.require_quiet_existing(root, reader, storage)
        target = bundle / "storage.json"
        saved = RESTORE.private_json(target) if os.path.lexists(target) else None
        if saved is None or saved.get("stage") != "complete":
            retain_incomplete_checkpoint(root, storage)
    if not os.path.lexists(bundle):
        STORAGE.capture(root, reader, storage, host_writers_stopped=True)
    manifest = STORAGE.verified_manifest(bundle)
    if manifest.get("plan") != storage:
        raise TransactionError("The completed storage backup does not match the accepted source checkpoint")
    record.update(stage="ready", backupFingerprint=APPS.digest(manifest))
    save(record)


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
    states = _runtipi_file_states(root, before, after, copy)
    return receipt, states, before, after, copy


def _runtipi_file_states(root, before, after, backup):
    states = {}
    allowed = set(APPS.HOST.AUTHORITY.CONFIG_PATHS) | {"VERSION"}
    for name in sorted(allowed):
        file = root / name
        if name not in before:
            if os.path.lexists(file):
                raise TransactionError("An unreviewed configuration file appeared during the Runtipi change")
            continue
        actual = APPS.HOST.PLAN.read_review_file(file)
        if name in after:
            expected_metadata = _configuration_file_metadata(backup / name)
            if expected_metadata[3] != 1 or _configuration_file_metadata(file) != expected_metadata:
                raise TransactionError("A Runtipi configuration file has unreviewed permissions or attributes")
        if actual == before[name]:
            if name in after:
                states[name] = "source"
        elif name in after and actual == after[name]:
            states[name] = "target"
        else:
            raise TransactionError("A configuration file differs from both approved Runtipi states")
    return states


def _configuration_file_metadata(file):
    info = file.lstat()
    attributes = {}
    if hasattr(os, "listxattr"):
        attributes = {name: os.getxattr(file, name, follow_symlinks=False)
                      for name in os.listxattr(file, follow_symlinks=False)}
    return (info.st_mode, info.st_uid, info.st_gid, info.st_nlink, attributes)


def _verify_runtipi_compose(root, expected):
    plan = APPS.HOST.PLAN
    observed = plan.compose_config(root, plan.compose_files(root), all_profiles=True)
    if hashlib.sha256(json.dumps(observed, sort_keys=True).encode()).hexdigest() != expected:
        raise TransactionError("Resolved Compose does not match the reviewed Runtipi configuration")


def prepare_runtipi_configuration(root, reader, path, current, target, binding):
    """Record the reviewed 4.12 file pair after the enclosing producer seals its backup."""
    record = read_record(path, root, reader)
    if record["stage"] != "ready":
        raise TransactionError("Runtipi configuration preparation requires a completed stopped checkpoint")
    compatibility = APPS.HOST.PLAN.review_412(root, current, target)
    receipt, states, _, _, _ = _runtipi_configuration_record(root, record, path, current, target, binding, compatibility)
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


def _read_runtipi_configuration(root, record, path, current, target, binding):
    saved = record.get("runtipiConfiguration")
    if record["stage"] not in {"ready", "recovering", "restoring", "starting", "recovered"} or type(saved) is not dict:
        raise TransactionError("No active Runtipi configuration preparation is available")
    pair = _runtipi_configuration_record(root, record, path, current, target, binding, saved.get("compatibility"))
    if saved != pair[0]:
        raise TransactionError("The saved Runtipi configuration preparation has changed")
    return pair


def _runtipi_staging(record, receipt):
    staging = record.get("runtipiConfigurationStaging")
    if staging is None:
        return None
    if (type(staging) is not dict or set(staging) != {"receiptSha256", "completed", "phase"}
            or staging["receiptSha256"] != APPS.digest(receipt)
            or type(staging["completed"]) is not int or not 0 <= staging["completed"] <= len(RUNTIPI_CONFIGURATION_ORDER)
            or staging["phase"] not in ("staging", "staged")
            or (staging["phase"] == "staged" and staging["completed"] != len(RUNTIPI_CONFIGURATION_ORDER))):
        raise TransactionError("The Runtipi configuration staging journal has changed")
    return staging


def _runtipi_staged_prefix(states, staging):
    target = [name for name in RUNTIPI_CONFIGURATION_ORDER if states[name] == "target"]
    observed = len(target)
    if target != list(RUNTIPI_CONFIGURATION_ORDER[:observed]):
        raise TransactionError("The staged Runtipi configuration is out of order")
    if staging is None and observed:
        raise TransactionError("Runtipi configuration changed before staging was authorized")
    # One rename can be durable before its completion acknowledgement.
    if staging is not None and not staging["completed"] <= observed <= staging["completed"] + 1:
        raise TransactionError("The staged Runtipi configuration conflicts with its journal")
    return observed


def _read_configuration_file(directory, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 <= info.st_size <= 1024 * 1024:
            raise TransactionError("A Runtipi configuration staging file is not regular")
        body = stream.read(1024 * 1024 + 1)
        current = os.stat(name, dir_fd=directory, follow_symlinks=False)
        seal = APPS.HOST.AUTHORITY.seal
        if len(body) != info.st_size or seal(info) != seal(os.fstat(fd)) or seal(info) != seal(current):
            raise TransactionError("A Runtipi configuration staging file changed while it was read")
        return body, info


@contextmanager
def _runtipi_staging_directory(root, operation, after, staging, *, create=False):
    name = f".orbis-runtipi-412-{operation}"
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open(root, flags)
    children = None
    try:
        info = os.fstat(directory)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o022:
            raise TransactionError("The installation root is not protected for Runtipi configuration staging")
        if create:
            try:
                os.mkdir(name, mode=0o700, dir_fd=directory)
            except FileExistsError:
                pass
            os.fsync(directory)
        try:
            children = os.open(name, flags, dir_fd=directory)
        except FileNotFoundError:
            if create:
                raise
        if children is not None:
            details = os.fstat(children)
            if (not staging or staging["phase"] != "staging" or details.st_uid != info.st_uid
                    or details.st_dev != info.st_dev or stat.S_IMODE(details.st_mode) != 0o700):
                raise TransactionError("An unreviewed Runtipi configuration staging directory exists")
            names = os.listdir(children)
            pending = RUNTIPI_CONFIGURATION_ORDER[staging["completed"]:staging["completed"] + 1]
            if any(file not in pending for file in names):
                raise TransactionError("An unreviewed file exists in Runtipi configuration staging")
            for file in names:
                body, metadata = _read_configuration_file(children, file)
                if metadata.st_uid != info.st_uid or not after[file].startswith(body):
                    raise TransactionError("An interrupted Runtipi configuration file has unreviewed bytes")
        yield directory, name, children
    finally:
        if children is not None:
            os.close(children)
        os.close(directory)


def _replace_runtipi_configuration_file(directory, stage, name, source, target, backup):
    actual, info = _read_configuration_file(directory, name)
    original = (backup / name).lstat()
    if actual != source or (info.st_uid, info.st_gid, info.st_mode) != (original.st_uid, original.st_gid, original.st_mode):
        raise TransactionError("The original Runtipi configuration changed before staging")
    try:
        partial, partial_info = _read_configuration_file(stage, name)
    except FileNotFoundError:
        pass
    else:
        if partial_info.st_uid != info.st_uid or not target.startswith(partial):
            raise TransactionError("An interrupted Runtipi configuration file has unreviewed bytes")
        os.unlink(name, dir_fd=stage)
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=stage)
    with os.fdopen(fd, "wb") as stream:
        st = os.fstat(fd)
        if (st.st_uid, st.st_gid) != (info.st_uid, info.st_gid):
            os.fchown(fd, info.st_uid, info.st_gid)
        os.fchmod(fd, stat.S_IMODE(info.st_mode))
        if hasattr(os, "listxattr"):
            for attribute in os.listxattr(backup / name, follow_symlinks=False):
                os.setxattr(fd, attribute, os.getxattr(backup / name, attribute, follow_symlinks=False))
        stream.write(target)
        stream.flush()
        os.fsync(fd)
    if APPS.HOST.AUTHORITY.seal(info) != APPS.HOST.AUTHORITY.seal(os.stat(name, dir_fd=directory, follow_symlinks=False)):
        raise TransactionError("The original Runtipi configuration changed during staging")
    os.replace(name, name, src_dir_fd=stage, dst_dir_fd=directory)
    os.fsync(directory)
    os.fsync(stage)


def stage_runtipi_configuration(root, reader, path, current, target, binding):
    """Stage the approved configuration while the enclosing producer holds the installation lock."""
    record = read_record(path, root, reader)
    if record["stage"] != "ready":
        raise TransactionError("Runtipi configuration staging requires a completed stopped checkpoint")
    receipt, states, before, after, backup = _read_runtipi_configuration(root, record, path, current, target, binding)
    STORAGE.require_quiet_existing(root, reader, record["review"]["storage"])
    operation = binding["operationId"]
    staging = _runtipi_staging(record, receipt)
    observed = _runtipi_staged_prefix(states, staging)
    with _runtipi_staging_directory(root, operation, after, staging):
        pass
    if staging is None:
        staging = {"receiptSha256": APPS.digest(receipt), "completed": 0, "phase": "staging"}
        record["runtipiConfigurationStaging"] = staging
        save(record)
    if staging["phase"] == "staged":
        _verify_runtipi_compose(root, receipt["compatibility"]["prospectiveComposeSha256"])
        return receipt
    staging["completed"] = observed
    save(record)
    with _runtipi_staging_directory(root, operation, after, staging, create=True) as (directory, folder, stage):
        for name in RUNTIPI_CONFIGURATION_ORDER[observed:]:
            _replace_runtipi_configuration_file(directory, stage, name, before[name], after[name], backup)
            staging["completed"] += 1
            save(record)
        os.rmdir(folder, dir_fd=directory)
        os.fsync(directory)
    if any(state != "target" for state in _runtipi_file_states(root, before, after, backup).values()):
        raise TransactionError("The target Runtipi files were not completely staged")
    _verify_runtipi_compose(root, receipt["compatibility"]["prospectiveComposeSha256"])
    staging["phase"] = "staged"
    save(record)
    return receipt


def _runtipi_configuration_recovery(root, record, path, current, target, binding):
    receipt, states, _, after, _ = _read_runtipi_configuration(root, record, path, current, target, binding)
    staging = _runtipi_staging(record, receipt)
    with _runtipi_staging_directory(root, binding["operationId"], after, staging):
        pass
    if staging is None and any(state != "source" for state in states.values()):
        raise TransactionError("Runtipi configuration changed before staging was authorized")
    return receipt, states


def runtipi_configuration_recovery_state(root, reader, path, current, target, binding):
    """Verify exact source/target file bytes before the producer restores its backup."""
    record = read_record(path, root, reader)
    if record["stage"] == "recovered":
        raise TransactionError("No active Runtipi configuration preparation is available")
    receipt, states = _runtipi_configuration_recovery(root, record, path, current, target, binding)
    if record["stage"] == "ready":
        _runtipi_staged_prefix(states, _runtipi_staging(record, receipt))
    return states


def verify_restored_runtipi_configuration(root, reader, path, current, target, binding, *, reconstructed=False):
    """Verify all reviewed source files at or after the original startup boundary."""
    record = read_record(path, root, reader)
    # The caller has independently verified the completed reconstructed restore.
    stages = ("ready",) if reconstructed else ("starting", "recovered")
    if type(reconstructed) is not bool or record["stage"] not in stages:
        raise TransactionError("Runtipi configuration recovery has not returned to original startup")
    receipt, states = _runtipi_configuration_recovery(root, record, path, current, target, binding)
    if any(state != "source" for state in states.values()):
        raise TransactionError("The original Runtipi configuration has not been completely restored")
    if os.path.lexists(root / f".orbis-runtipi-412-{binding['operationId']}"):
        raise TransactionError("Runtipi configuration staging files remain after recovery")
    _verify_runtipi_compose(root, receipt["compatibility"]["currentComposeSha256"])


def recover(root: Path, reader, path: Path, *, host_writers_stopped: bool, before_controller_start=None, before_originals_start=None) -> dict:
    if not host_writers_stopped:
        raise TransactionError("Confirm native host and remote storage writers are stopped before recovery")
    if before_originals_start is not None and not callable(before_originals_start):
        raise TransactionError('The enclosing Root recovery verifier is invalid')
    RESTORE.runtime()
    record = read_record(path, root, reader)
    if record["stage"] == "recovered":
        raise TransactionError("This installation has already recovered; its journal cannot be replayed")
    if record.get("runtipiConfiguration") is not None and before_originals_start is None:
        raise TransactionError("The Runtipi configuration recovery verifier is required")
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
    return finish_recovery(root, reader, path, before_controller_start=before_controller_start,
                           before_originals_start=before_originals_start)


def finish_recovery(root: Path, reader, path: Path, *, before_controller_start=None, before_originals_start=None) -> dict:
    """Finish an already restored transaction without replaying its data copy.

    The enclosing Root issuer must independently establish that starting has
    been committed before choosing this internal recovery step.
    """
    record = read_record(path, root, reader)
    if record['stage'] != 'starting':
        raise TransactionError('Only a restored transaction can finish original startup')
    if record.get("runtipiConfiguration") is not None and before_originals_start is None:
        raise TransactionError("The Runtipi configuration recovery verifier is required")
    if before_originals_start is not None:
        if not callable(before_originals_start):
            raise TransactionError('The enclosing Root recovery verifier is invalid')
        before_originals_start()
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
