#!/usr/bin/env python3
"""Restore a verified installation storage collection with every writer stopped.

Run on the Linux Docker host. This helper does not stop or restart containers.
The enclosing installer must keep native/remote writers stopped and separately
recover its controller, database, queue and app restart policies.
"""

import argparse
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("orbis_storage_for_restore", Path(__file__).with_name("orbis-install-storage.py"))
assert SPEC and SPEC.loader
STORAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STORAGE)
APPS = STORAGE.APPS
SCHEMA = "orbis.installation-restore.v1"


class RestoreError(ValueError):
    pass


def runtime() -> None:
    result = subprocess.run(["rsync", "--version"], capture_output=True, text=True, check=False, timeout=10)
    match = re.search(r"rsync\s+version\s+(\d+)\.(\d+)\.(\d+)", result.stdout)
    if result.returncode or not match or tuple(map(int, match.groups())) < (3, 1, 3):
        raise RestoreError("Storage recovery requires rsync 3.1.3 or newer on the Linux Docker host")


def private_json(path: Path) -> dict:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o077 or metadata.st_size > 16 * 1024 * 1024:
        raise RestoreError("The storage recovery record must be a private regular file")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise RestoreError("The storage recovery record is invalid")
    return value


def destinations(manifest: dict) -> None:
    plan = manifest["plan"]
    resources = plan["resources"]
    if not resources or len({item["source"] for item in resources}) != len(resources):
        raise RestoreError("The storage recovery destinations are invalid")
    for item in resources:
        destination = Path(item["source"])
        if STORAGE.source_identity(destination) != item:
            raise RestoreError("A recovery destination was replaced or changed type; retain the backup")
        if item["kind"] == "file" and destination.stat().st_nlink != 1:
            raise RestoreError("A file-mount recovery destination has additional hard links requiring review")
    if STORAGE.host_mounts(resources) != plan.get("mountPoints", []):
        raise RestoreError("Host mounts changed inside the storage being recovered")


def writers(root: Path, reader, manifest: dict) -> list[dict]:
    plan = manifest["plan"]
    if plan["root"] != str(root) or plan["dockerContext"] != reader.context or APPS.digest_daemon(reader) != plan["daemonFingerprint"]:
        raise RestoreError("The backup belongs to a different root or Docker daemon")
    destinations(manifest)
    resources = [Path(item["source"]) for item in plan["resources"]]
    original_ids = {item["id"] for item in plan["containers"]}
    rows = reader.containers()
    APPS.DETECT.validate_rows(rows)
    records = []
    for row in rows:
        raw = reader.app(row["id"])
        if raw.get("id") != row["id"]:
            raise RestoreError("Docker changed during storage recovery review")
        mounts = APPS.DETECT.validate_mounts(raw.get("mounts"))
        relevant = row["id"] in original_ids
        for mount in mounts:
            if type(mount.get("RW")) is not bool:
                raise RestoreError("Docker returned invalid storage permissions")
            if mount["RW"] and mount.get("Type") in {"bind", "volume"}:
                source = APPS.DETECT.path(mount.get("Source"))
                if source is None:
                    raise RestoreError("Docker returned an invalid writable storage source")
                if any(STORAGE.overlaps(Path(source).resolve(strict=False), target) for target in resources):
                    relevant = True
        if relevant:
            record, _ = STORAGE.container_record(reader, row)
            if record["state"] not in {"exited", "created"} or record["restartPolicy"]["Name"] != "no":
                raise RestoreError("Stop every storage writer and disable its restart policy before recovery")
            records.append(record)
    if sorted(reader.containers(), key=lambda item: item["id"]) != sorted(rows, key=lambda item: item["id"]) or APPS.digest_daemon(reader) != plan["daemonFingerprint"]:
        raise RestoreError("Docker changed during storage recovery review")
    return sorted(records, key=lambda item: item["id"])


def review_value(root: Path, reader, manifest: dict) -> dict:
    value = {
        "schema": SCHEMA, "root": str(root), "dockerContext": reader.context,
        "bundle": manifest["plan"]["bundle"], "backupFingerprint": APPS.digest(manifest),
        "writers": writers(root, reader, manifest), "hostWriterReviewRequired": True,
        "extendedMetadataSealed": all("attributes" in item for item in manifest["copies"]),
    }
    value["reviewId"] = APPS.digest(value)
    return value


def review(root: Path, reader, bundle: Path) -> dict:
    runtime()
    return review_value(root, reader, STORAGE.verified_manifest(bundle))


def validate_review(value: dict) -> None:
    if value.get("schema") != SCHEMA or value.get("reviewId") != APPS.digest({key: item for key, item in value.items() if key != "reviewId"}):
        raise RestoreError("The storage recovery review is invalid or was edited")


def journal_path(path: Path, root: Path, manifest: dict) -> Path:
    path = APPS.journal_path(path, root)
    targets = [Path(item["source"]) for item in manifest["plan"]["resources"]] + [Path(manifest["plan"]["bundle"])]
    if any(STORAGE.overlaps(path, target) for target in targets):
        raise RestoreError("The recovery journal must be outside the backup and every destination")
    return path


def capacity(manifest: dict) -> None:
    bundle = Path(manifest["plan"]["bundle"])
    for index, item in enumerate(manifest["plan"]["resources"]):
        source = bundle / f"resource-{index:04d}"
        if item["kind"] == "file":
            needed = source.stat().st_size
        else:
            needed = 0
            for folder, _, files in os.walk(source, followlinks=False):
                for name in files:
                    metadata = (Path(folder) / name).lstat()
                    if stat.S_ISREG(metadata.st_mode):
                        needed = max(needed, metadata.st_size)
        if shutil.disk_usage(item["source"]).free < int(needed * 1.1) + 64 * 1024 * 1024:
            raise RestoreError("A storage recovery destination needs more free space")


def copy_resource(source: Path, destination: Path, item: dict, copy: dict) -> None:
    if item["kind"] == "directory":
        # Force new file copies so existing hard links cannot alter files outside
        # this resource; -H rebuilds the backup's links inside the restored tree.
        result = subprocess.run([
            "rsync", "-aHAX", "--numeric-ids", "--ignore-times", "--modify-window=-1", "--delete", "--fsync",
            "--", str(source) + "/", str(destination) + "/",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        if result.returncode:
            raise RestoreError("A storage directory could not be recovered; keep every writer stopped and retain its journal")
        metadata = copy["directoryMetadata"]
        os.chown(destination, metadata["rootUid"], metadata["rootGid"])
        os.chmod(destination, copy["record"]["sourceRootMode"])
        os.utime(destination, ns=(destination.stat().st_atime_ns, metadata["rootMtimeNs"]))
        STORAGE.SNAPSHOT.sync_path(destination)
    else:
        descriptor = os.open(destination, os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "wb") as output:
            metadata = os.fstat(output.fileno())
            if not stat.S_ISREG(metadata.st_mode) or (metadata.st_dev, metadata.st_ino) != (item["device"], item["inode"]) or metadata.st_nlink != 1:
                raise RestoreError("A file recovery destination changed before copying")
            output.truncate(0)
            with source.open("rb") as input_file:
                shutil.copyfileobj(input_file, output, 1024 * 1024)
            output.flush()
            record = copy["record"]
            os.fchown(output.fileno(), record["uid"], record["gid"])
            os.fchmod(output.fileno(), record["mode"])
            if hasattr(os, "listxattr"):
                names = set(os.listxattr(source, follow_symlinks=False))
                for name in set(os.listxattr(output.fileno())) - names:
                    os.removexattr(output.fileno(), name)
                for name in sorted(names):
                    os.setxattr(output.fileno(), name, os.getxattr(source, name, follow_symlinks=False))
            os.utime(output.fileno(), ns=(source.stat().st_atime_ns, record["mtimeNs"]))
            os.fsync(output.fileno())


def verify_destination(destination: Path, item: dict, copy: dict) -> None:
    if STORAGE.source_identity(destination) != item:
        raise RestoreError("A storage destination changed identity during recovery")
    if item["kind"] == "file":
        matches = STORAGE.file_fingerprint(destination) == copy["record"]
    else:
        actual = STORAGE.SNAPSHOT.fingerprint(destination)
        matches = (
            all(copy["record"].get(key) == value for key, value in actual.items())
            and STORAGE.directory_metadata(destination) == copy["directoryMetadata"]
            and stat.S_IMODE(destination.stat().st_mode) == copy["record"]["sourceRootMode"]
        )
    if not matches:
        raise RestoreError("Recovered storage did not match the verified backup; keep every writer stopped")
    if "attributes" in copy and STORAGE.attributes_metadata(destination) != copy["attributes"]:
        raise RestoreError("Recovered storage attributes did not match the verified backup")


def restore(root: Path, reader, saved: dict, path: Path, *, host_writers_stopped: bool, recover: bool = False) -> dict:
    validate_review(saved)
    if not host_writers_stopped:
        raise RestoreError("Confirm native host and remote storage writers are stopped before recovery")
    runtime()
    manifest = STORAGE.verified_manifest(Path(saved["bundle"]))
    if review_value(root, reader, manifest) != saved:
        raise RestoreError("Storage writers or destinations changed; review recovery again before writing")
    path = journal_path(path, root, manifest)
    if recover:
        record = private_json(path)
        if record.get("schema") != SCHEMA or record.get("review") != saved or record.get("stage") not in {"prepared", "restoring", "verifying"}:
            raise RestoreError("This recovery journal is invalid, complete or belongs to another review")
    elif path.exists() or path.is_symlink():
        raise RestoreError("A recovery journal already exists; inspect it and use recover for an interrupted operation")
    else:
        record = {"schema": SCHEMA, "stage": "prepared", "review": saved, "completed": [], "active": None}
        APPS.write_journal(path, record)
    capacity(manifest)
    bundle = Path(saved["bundle"])
    # Replay every resource after interruption; never trust a completed index
    # instead of comparing the current data with the original verified backup.
    record.update(stage="restoring", completed=[])
    for index, (item, copy) in enumerate(zip(manifest["plan"]["resources"], manifest["copies"])):
        if review_value(root, reader, manifest) != saved:
            raise RestoreError("A storage writer or destination changed during recovery")
        record["active"] = index
        APPS.write_journal(path, record)
        source, destination = bundle / f"resource-{index:04d}", Path(item["source"])
        copy_resource(source, destination, item, copy)
        verify_destination(destination, item, copy)
        record["completed"].append(index)
        APPS.write_journal(path, record)
    record.update(stage="verifying", active=None)
    APPS.write_journal(path, record)
    STORAGE.verified_manifest(bundle)
    for item, copy in zip(manifest["plan"]["resources"], manifest["copies"]):
        verify_destination(Path(item["source"]), item, copy)
    if review_value(root, reader, manifest) != saved:
        raise RestoreError("A storage writer or destination changed before recovery finished")
    record["stage"] = "complete"
    APPS.write_journal(path, record)
    return {"schema": SCHEMA, "result": "storage-restored", "journal": str(path), "resources": len(manifest["copies"]), "containersRemainStopped": True, "extendedMetadataSealed": saved["extendedMetadataSealed"]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("review", "restore", "recover"))
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--docker-context", required=True)
    parser.add_argument("--review", type=Path)
    parser.add_argument("--journal", type=Path)
    parser.add_argument("--confirm-root")
    parser.add_argument("--host-writers-stopped", action="store_true")
    args = parser.parse_args()
    try:
        if sys.platform != "linux" or os.geteuid() != 0:
            raise RestoreError("Run this helper as root on the Linux Docker host")
        root = args.root.expanduser().resolve(strict=True)
        reader = APPS.Docker(args.docker_context)
        with APPS.HOST.host_lock(root):
            if args.action == "review":
                result = review(root, reader, args.bundle.expanduser())
            else:
                APPS.HOST.require_confirmation(root, args.confirm_root)
                if args.review is None or args.journal is None:
                    raise RestoreError("A private saved recovery review and journal are required")
                saved = private_json(args.review.expanduser())
                if saved.get("bundle") != str(args.bundle.expanduser()):
                    raise RestoreError("The recovery review belongs to another backup")
                result = restore(root, reader, saved, args.journal.expanduser(), host_writers_stopped=args.host_writers_stopped, recover=args.action == "recover")
        print(json.dumps(result, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        message = str(error) if isinstance(error, (RestoreError, STORAGE.StorageError)) else "Storage recovery could not finish; keep writers stopped and inspect the private journal"
        print(json.dumps({"schema": SCHEMA, "result": "storage-recovery-failed", "message": message}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
