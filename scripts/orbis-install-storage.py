#!/usr/bin/env python3
"""Review and capture installation storage on the Linux Docker host.

Includes the installation tree, external bind mounts and local Docker volumes.
The installer must stop all reviewed containers and disable their restart
policies first. This helper never stops containers or restores live data.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("orbis_apps_for_storage", Path(__file__).with_name("orbis-install-apps.py"))
assert SPEC and SPEC.loader
APPS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(APPS)
DETECT = APPS.DETECT
SNAPSHOT = APPS.load_script("orbis-snapshot.py", "orbis_snapshot_for_storage")
SCHEMA = "orbis.installation-storage.v1"
SYSTEM_ROOTS = {"/", "/etc", "/var", "/var/lib", "/var/lib/docker", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/root", "/home", "/opt", "/srv", "/mnt", "/media"}


class StorageError(ValueError):
    pass


def source_identity(source: Path) -> dict:
    if str(source) in SYSTEM_ROOTS or any(source == Path(p) or source.is_relative_to(p) for p in ("/proc", "/sys", "/dev", "/run")):
        raise StorageError("A storage mount covers a system path that cannot be included in an installation backup")
    if not source.is_absolute() or source.resolve(strict=True) != source or source.is_symlink():
        raise StorageError("Storage paths must exist on this host without symlink aliases")
    metadata = source.stat()
    kind = "directory" if stat.S_ISDIR(metadata.st_mode) else "file" if stat.S_ISREG(metadata.st_mode) else None
    if not kind:
        raise StorageError("Installation storage contains an unsupported source type")
    return {"source": str(source), "kind": kind, "device": metadata.st_dev, "inode": metadata.st_ino}


def mount_source(reader, mount: dict) -> Path | None:
    kind = mount.get("Type")
    if kind == "tmpfs":
        return None
    if kind not in {"bind", "volume"} or type(mount.get("RW")) is not bool:
        raise StorageError("Docker returned unsupported storage or mount permissions")
    if kind == "bind":
        source_path = DETECT.path(mount.get("Source"))
        if source_path and any(Path(source_path).is_relative_to(base) for base in ("/proc", "/sys", "/dev")):
            return None
        if mount.get("Destination") in {"/var/run/docker.sock", "/run/docker.sock"}:
            if hasattr(reader, "socket"):
                endpoint = reader.socket()
                source = DETECT.path(mount.get("Source"))
                if endpoint and source and Path(source).resolve(strict=True) == Path(endpoint).resolve(strict=True) and stat.S_ISSOCK(Path(source).stat().st_mode):
                    return None
                raise StorageError("A controller uses a different Docker socket from the selected local context")
            if mount.get("Source") in {"/var/run/docker.sock", "/run/docker.sock"}:
                return None
        if mount.get("RW") is False and mount.get("Source") in {"/etc/localtime", "/etc/timezone"}:
            return None
        source = DETECT.path(mount.get("Source"))
    else:
        name = mount.get("Name")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,254}", name):
            raise StorageError("Docker returned an invalid storage volume name")
        volume = reader._object([
            "volume", "inspect", "--format",
            '{"name":{{json .Name}},"driver":{{json .Driver}},"mountpoint":{{json .Mountpoint}}}', name,
        ])
        source = DETECT.path(volume.get("mountpoint"))
        if volume.get("name") != name or volume.get("driver") != "local" or source != DETECT.path(mount.get("Source")):
            raise StorageError("A storage volume is not an accessible local Docker volume")
    if source is None:
        raise StorageError("Docker returned an invalid storage path")
    return Path(source)


def container_record(reader, row: dict) -> tuple[dict, list[dict]]:
    raw = reader.app(row["id"])
    if raw.get("id") != row["id"] or not APPS.IMAGE_ID.fullmatch(str(raw.get("imageId", ""))) or not isinstance(raw.get("labels"), dict):
        raise StorageError("A storage container changed during inspection")
    mounts = DETECT.validate_mounts(raw.get("mounts"))
    if raw.get("state") not in {"running", "exited", "created"} or raw.get("autoRemove") is not False:
        raise StorageError("Storage containers must have stable states and must not be automatically removed")
    identity = {key: raw.get(key) for key in ("id", "name", "image", "imageId", "labels", "autoRemove", "stopTimeout")}
    identity["mounts"] = sorted(mounts, key=lambda value: value["Destination"])
    return {
        "id": row["id"], "name": row["name"], "definitionHash": APPS.digest(identity),
        "state": raw["state"], "restartPolicy": APPS.policy(raw.get("restartPolicy")),
    }, mounts


def overlaps(first: Path, second: Path) -> bool:
    return first.is_relative_to(second) or second.is_relative_to(first)


def host_mounts(resources: list[dict], mountinfo: Path | None = None) -> list[dict]:
    if mountinfo is None and sys.platform != "linux":
        return []
    mounts = set()
    with (mountinfo or Path("/proc/self/mountinfo")).open() as stream:
        for line in stream:
            if len(line) > 65536:
                raise StorageError("Host mount information exceeds its limit")
            fields = line.split()
            if len(fields) < 10 or "-" not in fields[6:]:
                raise StorageError("Host mount information is invalid")
            decoded = re.sub(r"\\(040|011|012|134)", lambda match: chr(int(match[1], 8)), fields[4])
            target = Path(decoded)
            if not target.is_absolute():
                raise StorageError("Host mount information contains an invalid path")
            if any(target != Path(item["source"]) and target.is_relative_to(item["source"]) for item in resources):
                mounts.add(target)
            if len(mounts) > 4096:
                raise StorageError("Installation storage exceeds the host mount limit")
    return [source_identity(path) for path in sorted(mounts)]


def review(root: Path, reader, bundle: Path, *, check_capacity: bool = True, existing_bundle: bool = False) -> dict:
    if root.is_symlink() or root.resolve(strict=True) != root or not root.is_dir():
        raise StorageError("The installation root must be an existing canonical directory")
    bundle = APPS.journal_path(bundle, root)
    if bundle.exists() and not existing_bundle:
        raise StorageError("Choose a new storage backup destination")
    report, installation = APPS.selected_installation(reader, root)
    rows = reader.containers()
    DETECT.validate_rows(rows)
    owned = {installation["container"]["id"], *(app["container"]["id"] for app in installation["apps"])}
    owned.update(row["id"] for row in rows if row["project"] == "runtipi" and row["service"] in DETECT.CORE_SERVICES and DETECT.path(row["workingDir"]) == str(root))
    containers = []
    sources = {root}
    for row in rows:
        if row["id"] not in owned:
            continue
        record, mounts = container_record(reader, row)
        containers.append(record)
        for mount in mounts:
            source = mount_source(reader, mount)
            if source is not None:
                source_identity(source)
                sources.add(source)
    # Parent directory copies already include nested bind mounts and files.
    sources = sorted(sources, key=lambda source: (len(source.parts), str(source)))
    resources = []
    for source in sources:
        if any(source.is_relative_to(Path(item["source"])) for item in resources):
            continue
        if overlaps(source, bundle):
            raise StorageError("The storage backup must be outside every source being copied")
        resources.append(source_identity(source))
    if len(resources) > 4096:
        raise StorageError("Installation storage exceeds the resource limit")
    conflicts = []
    for row in rows:
        if row["id"] in owned:
            continue
        raw = reader.app(row["id"])
        if raw.get("id") != row["id"]:
            raise StorageError("Docker changed during storage review")
        mounts = DETECT.validate_mounts(raw.get("mounts"))
        restart = APPS.policy(raw.get("restartPolicy"))
        if raw.get("state") in {"exited", "created"} and restart["Name"] == "no":
            continue
        for mount in mounts:
            if type(mount.get("RW")) is not bool:
                raise StorageError("Docker returned invalid mount permissions")
            if mount.get("RW") is not True or mount.get("Type") not in {"bind", "volume"}:
                continue
            source = DETECT.path(mount.get("Source"))
            if not source:
                raise StorageError("Docker returned invalid writable storage")
            if any(overlaps(Path(source).resolve(strict=False), Path(item["source"])) for item in resources):
                conflicts.append({"id": row["id"], "name": row["name"]})
                break
    estimates = []
    for index, item in enumerate(resources if check_capacity else []):
        if item["kind"] == "directory":
            estimate = SNAPSHOT.preflight(Path(item["source"]), bundle.parent / f".orbis-storage-check-{index}")
            estimates.append(estimate["bytes"])
        else:
            estimates.append(Path(item["source"]).stat().st_size)
    required = sum(estimates)
    if check_capacity and shutil.disk_usage(bundle.parent).free < int(required * 1.1) + 64 * 1024 * 1024:
        raise StorageError("The storage backup destination does not have enough available space")
    after, after_installation = APPS.selected_installation(reader, root)
    if after != report or after_installation != installation or sorted(reader.containers(), key=lambda value: value["id"]) != sorted(rows, key=lambda value: value["id"]):
        raise StorageError("Docker changed during storage review")
    identity = {
        "root": str(root), "dockerContext": reader.context, "daemonFingerprint": report["daemonFingerprint"],
        "bundle": str(bundle), "resources": resources,
        "containers": sorted([{key: value[key] for key in ("id", "name", "definitionHash")} for value in containers], key=lambda value: value["id"]),
        "mountPoints": host_mounts(resources),
    }
    result = {
        "schema": SCHEMA, "readOnly": True, **identity, "identityHash": APPS.digest(identity),
        "containerStates": sorted(containers, key=lambda value: value["id"]),
        "conflictingWriters": sorted(conflicts, key=lambda value: value["id"]), "estimatedBytes": required,
        "hostWriterReviewRequired": True,
    }
    result["reviewId"] = APPS.digest(result)
    return result


def require_quiet(root: Path, reader, saved: dict) -> None:
    current = review(root, reader, Path(saved["bundle"]))
    if current["identityHash"] != saved["identityHash"]:
        raise StorageError("Storage sources or container identities changed since review")
    if current["conflictingWriters"]:
        raise StorageError("Another container can write to the reviewed storage")
    if any(item["state"] not in {"exited", "created"} or item["restartPolicy"]["Name"] != "no" for item in current["containerStates"]):
        raise StorageError("Stop every reviewed container and disable its restart policy before copying storage")


def validate_review(saved: object) -> dict:
    if not isinstance(saved, dict) or saved.get("schema") != SCHEMA or saved.get("reviewId") != APPS.digest({key: value for key, value in saved.items() if key != "reviewId"}):
        raise StorageError("The storage review is invalid or was edited")
    identity = {key: saved[key] for key in ("root", "dockerContext", "daemonFingerprint", "bundle", "resources", "containers")}
    if "mountPoints" in saved:
        identity["mountPoints"] = saved["mountPoints"]
    if saved.get("identityHash") != APPS.digest(identity) or not isinstance(saved["resources"], list) or len(saved["resources"]) > 4096:
        raise StorageError("The storage review identity is invalid")
    return saved


def file_fingerprint(source: Path) -> dict:
    metadata = source.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        raise StorageError("A storage file changed type during backup")
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    after = source.lstat()
    if (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise StorageError("A storage file changed while being copied")
    return {"sha256": digest.hexdigest(), "bytes": metadata.st_size, "mode": stat.S_IMODE(metadata.st_mode), "uid": metadata.st_uid, "gid": metadata.st_gid, "mtimeNs": metadata.st_mtime_ns}


def directory_metadata(source: Path) -> dict:
    digest = hashlib.sha256()
    root = source.stat()
    def unreadable(error):
        raise error
    for folder, directories, files in os.walk(source, followlinks=False, onerror=unreadable):
        directories.sort()
        files.sort()
        for name in [*directories, *files]:
            path = Path(folder) / name
            metadata = path.lstat()
            digest.update(json.dumps([
                str(path.relative_to(source)), metadata.st_mode, metadata.st_uid,
                metadata.st_gid, metadata.st_mtime_ns,
            ], separators=(",", ":")).encode())
    # Snapshot roots are deliberately made private; their original mode is
    # recorded separately by the tree snapshot for stopped-writer recovery.
    return {"entriesSha256": digest.hexdigest(), "rootUid": root.st_uid, "rootGid": root.st_gid, "rootMtimeNs": root.st_mtime_ns}


def attributes_metadata(source: Path) -> dict | None:
    if not hasattr(os, "listxattr"):
        if sys.platform == "linux":
            raise StorageError("This Python runtime cannot verify extended storage attributes")
        return None
    digest = hashlib.sha256()
    links = {}

    def entry(path: Path, relative: str) -> None:
        attributes = [
            [name, hashlib.sha256(os.getxattr(path, name, follow_symlinks=False)).hexdigest()]
            for name in sorted(os.listxattr(path, follow_symlinks=False))
        ]
        digest.update(json.dumps([relative, attributes], separators=(",", ":")).encode())
        metadata = path.lstat()
        if stat.S_ISREG(metadata.st_mode) and metadata.st_nlink > 1:
            links.setdefault((metadata.st_dev, metadata.st_ino), []).append(relative)

    entry(source, ".")
    if source.is_dir():
        def unreadable(error):
            raise error
        for folder, directories, files in os.walk(source, followlinks=False, onerror=unreadable):
            directories.sort()
            files.sort()
            for name in [*directories, *files]:
                path = Path(folder) / name
                entry(path, str(path.relative_to(source)))
    groups = sorted(sorted(paths) for paths in links.values() if len(paths) > 1)
    return {"xattrsSha256": digest.hexdigest(), "hardlinksSha256": APPS.digest(groups)}


def require_contained_hardlinks(resources: list[dict]) -> None:
    # Each resource is restored separately. A link crossing those boundaries
    # would silently become two files, or make an inode-preserving file restore
    # overwrite an unreviewed sibling. Refuse it before claiming a full backup.
    for item in resources:
        source = Path(item["source"])
        links = {}
        def entry(path):
            metadata = path.lstat()
            if stat.S_ISREG(metadata.st_mode) and metadata.st_nlink > 1:
                key = (metadata.st_dev, metadata.st_ino)
                group = links.setdefault(key, [metadata.st_nlink, 0])
                if group[0] != metadata.st_nlink:
                    raise StorageError("Storage hard links changed during inspection")
                group[1] += 1
        entry(source)
        if item["kind"] == "directory":
            def unreadable(error):
                raise error
            for folder, _, files in os.walk(source, followlinks=False, onerror=unreadable):
                for name in files:
                    entry(Path(folder) / name)
        if any(expected != found for expected, found in links.values()):
            raise StorageError("A hard link crosses storage backup boundaries; review its linked paths before installation")


def capture(root: Path, reader, saved: dict, *, host_writers_stopped: bool) -> dict:
    validate_review(saved)
    if not host_writers_stopped:
        raise StorageError("Confirm native host and remote storage writers are stopped before backup")
    require_quiet(root, reader, saved)
    require_contained_hardlinks(saved["resources"])
    bundle = Path(saved["bundle"])
    bundle.mkdir(mode=0o700)
    manifest = {"schema": SCHEMA, "stage": "copying", "plan": saved, "copies": []}
    target = bundle / "storage.json"
    APPS.write_journal(target, manifest)
    for index, item in enumerate(saved["resources"]):
        source = Path(item["source"])
        destination = bundle / f"resource-{index:04d}"
        if source_identity(source) != item:
            raise StorageError("A storage source was replaced before backup")
        copy = {"index": index, "kind": item["kind"]}
        attributes = attributes_metadata(source)
        if item["kind"] == "directory":
            metadata = directory_metadata(source)
            lock_fd = getattr(reader, "lock_fd", None)
            record = SNAPSHOT.capture(source, destination, "installation-storage", reader.context, **({"lock_fd": lock_fd} if lock_fd is not None else {}))
            # The private collection parent protects this tree; retain its root ACL mask.
            os.chmod(destination, record["sourceRootMode"])
            descriptor = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            if directory_metadata(source) != metadata or directory_metadata(destination) != metadata:
                raise StorageError("Directory ownership, permissions or timestamps changed while being copied")
            copy["directoryMetadata"] = metadata
        else:
            before = file_fingerprint(source)
            lock_fd = getattr(reader, "lock_fd", None)
            copied = subprocess.run(["cp", "-a", "--", str(source), str(destination)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, pass_fds=(lock_fd,) if lock_fd is not None else ())
            if copied.returncode or file_fingerprint(source) != before or file_fingerprint(destination) != before:
                raise StorageError("A storage file copy did not match its source")
            record = before
            SNAPSHOT.sync_path(destination)
        if attributes is not None:
            if attributes_metadata(source) != attributes or attributes_metadata(destination) != attributes:
                raise StorageError("Storage attributes or hard links changed while being copied")
            copy["attributes"] = attributes
        copy["record"] = record
        manifest["copies"].append(copy)
        APPS.write_journal(target, manifest)
    manifest["stage"] = "verifying"
    APPS.write_journal(target, manifest)
    require_quiet_existing(root, reader, saved)
    require_contained_hardlinks(saved["resources"])
    for item, copy in zip(saved["resources"], manifest["copies"]):
        source = Path(item["source"])
        if source_identity(source) != item:
            raise StorageError("A storage source was replaced while backup was running")
        if item["kind"] == "directory":
            actual = SNAPSHOT.fingerprint(source)
            matches = (
                all(copy["record"].get(key) == value for key, value in actual.items())
                and directory_metadata(source) == copy["directoryMetadata"]
                and stat.S_IMODE(source.stat().st_mode) == copy["record"]["sourceRootMode"]
            )
        else:
            matches = file_fingerprint(source) == copy["record"]
        if not matches:
            raise StorageError("Storage changed after it was copied; keep every writer stopped and take a new backup")
        if "attributes" in copy and attributes_metadata(source) != copy["attributes"]:
            raise StorageError("Storage attributes changed after they were copied; take a new backup")
    require_quiet_existing(root, reader, saved)
    manifest["stage"] = "complete"
    APPS.write_journal(target, manifest)
    return verify(bundle)


def require_quiet_existing(root: Path, reader, saved: dict) -> None:
    current = review(root, reader, Path(saved["bundle"]), check_capacity=False, existing_bundle=True)
    if current["identityHash"] != saved["identityHash"] or current["conflictingWriters"]:
        raise StorageError("Docker or storage changed while backup was running")
    if any(item["state"] not in {"exited", "created"} or item["restartPolicy"]["Name"] != "no" for item in current["containerStates"]):
        raise StorageError("A reviewed storage writer restarted while backup was running")


def verified_manifest(bundle: Path) -> dict:
    if bundle.is_symlink() or not bundle.is_dir() or bundle.stat().st_uid != os.geteuid() or stat.S_IMODE(bundle.stat().st_mode) & 0o077:
        raise StorageError("The storage backup must be a private directory owned by the installer user")
    bundle = bundle.resolve(strict=True)
    target = bundle / "storage.json"
    metadata = target.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o077 or metadata.st_size > 16 * 1024 * 1024:
        raise StorageError("The storage backup manifest is not a private regular file")
    manifest = json.loads(target.read_text())
    if not isinstance(manifest, dict):
        raise StorageError("The storage backup manifest is invalid")
    plan = validate_review(manifest.get("plan"))
    if manifest.get("schema") != SCHEMA or manifest.get("stage") != "complete" or plan.get("bundle") != str(bundle) or not isinstance(plan.get("resources"), list):
        raise StorageError("The storage backup is incomplete or belongs to another destination")
    copies = manifest.get("copies")
    if not isinstance(copies, list) or len(copies) != len(plan["resources"]) or len(copies) > 4096:
        raise StorageError("The storage backup is missing resources")
    for index, (copy, item) in enumerate(zip(copies, plan["resources"])):
        if not isinstance(copy, dict) or not isinstance(item, dict) or item.get("kind") not in {"file", "directory"} or copy.get("index") != index or copy.get("kind") != item["kind"]:
            raise StorageError("The storage backup resource order is invalid")
        source = bundle / f"resource-{index:04d}"
        record = SNAPSHOT.verify(source) if item["kind"] == "directory" else file_fingerprint(source)
        if record != copy.get("record"):
            raise StorageError("The storage backup no longer matches its verification record")
        if item["kind"] == "directory" and directory_metadata(source) != copy.get("directoryMetadata"):
            raise StorageError("The storage backup metadata no longer matches its verification record")
        if "attributes" in copy and attributes_metadata(source) != copy["attributes"]:
            raise StorageError("The storage backup attributes no longer match their verification record")
    return manifest


def verify(bundle: Path) -> dict:
    manifest = verified_manifest(bundle)
    plan = manifest["plan"]
    copies = manifest["copies"]
    bundle = bundle.resolve(strict=True)
    return {"schema": SCHEMA, "result": "storage-backup-verified", "bundle": str(bundle), "resources": len(copies), "reviewId": plan["reviewId"], "requiresStoppedWriterRestore": True}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("review", "capture", "verify"))
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--docker-context")
    parser.add_argument("--review", type=Path, help="saved private review JSON for capture")
    parser.add_argument("--confirm-root")
    parser.add_argument("--host-writers-stopped", action="store_true")
    args = parser.parse_args()
    try:
        if sys.platform != "linux" or os.geteuid() != 0:
            raise StorageError("Run this helper as root on the Linux Docker host")
        if args.action == "verify":
            result = verify(args.bundle)
        else:
            if args.root is None or args.docker_context is None:
                raise StorageError("An installation root and explicit Docker context are required")
            root = args.root.expanduser().resolve(strict=True)
            reader = APPS.Docker(args.docker_context)
            if args.action == "review":
                result = review(root, reader, args.bundle.expanduser())
            else:
                APPS.HOST.require_confirmation(root, args.confirm_root)
                if args.review is None or args.review.is_symlink() or not args.review.is_file():
                    raise StorageError("A saved private storage review is required")
                metadata = args.review.stat()
                if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o077 or metadata.st_size > 16 * 1024 * 1024:
                    raise StorageError("The storage review must be a private regular file")
                saved = json.loads(args.review.read_text())
                validate_review(saved)
                if saved.get("bundle") != str(args.bundle.expanduser()):
                    raise StorageError("The storage review belongs to another backup destination")
                with APPS.HOST.host_lock(root) as lock_fd:
                    reader.lock_fd = lock_fd
                    result = capture(root, reader, saved, host_writers_stopped=args.host_writers_stopped)
        print(json.dumps(result, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, TypeError) as error:
        message = str(error) if isinstance(error, StorageError) else "Storage backup could not finish; retain the private backup and inspect it locally"
        print(json.dumps({"schema": SCHEMA, "result": "storage-backup-failed", "message": message}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
