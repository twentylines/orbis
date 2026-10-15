#!/usr/bin/env python3
"""Capture and verify a stopped CLI installation tree for host operations.

The caller must quiesce every writer first. This module never stops containers or
restores data on its own. A snapshot without its matching sidecar is unusable.
"""

import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "orbis.snapshot.v1"


def sidecar(snapshot: Path) -> Path:
    return snapshot.with_name(f"{snapshot.name}.orbis.json")


def prepare(root: Path, snapshot: Path) -> None:
    if not root.is_dir() or root.is_symlink():
        raise ValueError("installation root must be a real directory")
    if snapshot.exists() or snapshot.is_symlink() or sidecar(snapshot).exists():
        raise ValueError("snapshot destination or sidecar already exists")
    parent = snapshot.parent.resolve(strict=True)
    if not parent.is_dir() or parent.is_symlink():
        raise ValueError("snapshot parent must be a real directory")
    if snapshot.is_relative_to(root) or root.is_relative_to(snapshot):
        raise ValueError("snapshot destination must be outside the installation")


def preflight(root: Path, snapshot: Path) -> dict[str, int]:
    """Check tree shape and destination capacity without reading file contents."""
    prepare(root, snapshot)
    root = root.resolve(strict=True)
    entries = 0
    files = 0
    bytes_required = 0

    def unreadable(error: OSError) -> None:
        raise error

    for folder, directory_names, file_names in os.walk(root, topdown=True, followlinks=False, onerror=unreadable):
        for name in [*directory_names, *file_names]:
            item = Path(folder) / name
            metadata = item.lstat()
            entries += 1
            if stat.S_ISLNK(metadata.st_mode):
                target = os.readlink(item)
                if Path(target).is_absolute() or not item.resolve(strict=False).is_relative_to(root):
                    raise ValueError("snapshot contains a symlink outside its installation tree")
                if name in directory_names:
                    directory_names.remove(name)
            elif stat.S_ISREG(metadata.st_mode):
                files += 1
                bytes_required += metadata.st_size
            elif not stat.S_ISDIR(metadata.st_mode):
                raise ValueError("snapshot contains an unsupported file type")
    free = shutil.disk_usage(snapshot.parent).free
    if free < int(bytes_required * 1.1) + 64 * 1024 * 1024:
        raise ValueError("snapshot destination does not have enough available space")
    return {"entries": entries, "files": files, "bytes": bytes_required}


def fingerprint(root: Path) -> dict[str, object]:
    if not root.is_dir() or root.is_symlink():
        raise ValueError("snapshot tree must be a real directory")
    root = root.resolve(strict=True)
    digest = hashlib.sha256()
    files = 0
    bytes_read = 0
    entries = 0
    def unreadable(error: OSError) -> None:
        raise error

    for folder, directory_names, file_names in os.walk(root, topdown=True, followlinks=False, onerror=unreadable):
        directory_names.sort()
        file_names.sort()
        for name in [*directory_names, *file_names]:
            item = Path(folder) / name
            relative = item.relative_to(root).as_posix()
            metadata = item.lstat()
            mode = stat.S_IMODE(metadata.st_mode)
            digest.update(f"{relative}\0{mode:o}\0{metadata.st_uid}\0{metadata.st_gid}\0".encode())
            entries += 1
            if stat.S_ISLNK(metadata.st_mode):
                target = os.readlink(item)
                if Path(target).is_absolute() or not item.resolve(strict=False).is_relative_to(root):
                    raise ValueError("snapshot contains a symlink outside its installation tree")
                digest.update(f"L\0{target}\0".encode())
                if name in directory_names:
                    directory_names.remove(name)
            elif stat.S_ISDIR(metadata.st_mode):
                digest.update(b"D\0")
            elif stat.S_ISREG(metadata.st_mode):
                files += 1
                bytes_read += metadata.st_size
                digest.update(f"F\0{metadata.st_size}\0".encode())
                with item.open("rb") as stream:
                    while block := stream.read(1024 * 1024):
                        digest.update(block)
                after = item.lstat()
                if after.st_size != metadata.st_size or after.st_mtime_ns != metadata.st_mtime_ns:
                    raise ValueError("installation data changed while snapshotting")
            else:
                raise ValueError("snapshot contains an unsupported file type")
    return {"treeSha256": digest.hexdigest(), "entries": entries, "files": files, "bytes": bytes_read}


def write_sidecar(snapshot: Path, record: dict[str, object]) -> None:
    target = sidecar(snapshot)
    descriptor, name = tempfile.mkstemp(prefix=f".{snapshot.name}.", dir=snapshot.parent)
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


def capture(root: Path, snapshot: Path, release: str, docker_context: str) -> dict[str, object]:
    if root.is_symlink():
        raise ValueError("installation root must be a real directory")
    root = root.resolve(strict=True)
    root_mode = stat.S_IMODE(root.stat().st_mode)
    expanded = snapshot.expanduser()
    snapshot = expanded.parent.resolve(strict=True) / expanded.name
    preflight(root, snapshot)
    before = fingerprint(root)
    copied = subprocess.run(["cp", "-a", str(root), str(snapshot)], capture_output=True, check=False)
    if copied.returncode:
        raise RuntimeError("installation snapshot copy failed; inspect the incomplete destination locally")
    after = fingerprint(root)
    saved = fingerprint(snapshot)
    if after != before or saved != before:
        raise RuntimeError("snapshot did not match the stopped installation; do not use it for rollback")
    os.chmod(snapshot, 0o700)
    record = {
        "schema": SCHEMA,
        "sourceRoot": str(root),
        "snapshot": str(snapshot),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "release": release,
        "dockerContext": docker_context,
        "sourceRootMode": root_mode,
        **saved,
    }
    write_sidecar(snapshot, record)
    return record


def verify(snapshot: Path, expected_root: Path | None = None) -> dict[str, object]:
    if snapshot.is_symlink():
        raise ValueError("snapshot tree must be a real directory")
    snapshot = snapshot.expanduser().resolve(strict=True)
    target = sidecar(snapshot)
    if target.is_symlink() or not target.is_file():
        raise ValueError("snapshot has no regular verification sidecar")
    record = json.loads(target.read_text(encoding="utf-8"))
    if not isinstance(record, dict) or record.get("schema") != SCHEMA or record.get("snapshot") != str(snapshot):
        raise ValueError("snapshot verification sidecar is invalid")
    if expected_root is not None and record.get("sourceRoot") != str(expected_root.resolve(strict=True)):
        raise ValueError("snapshot belongs to another installation root")
    actual = fingerprint(snapshot)
    if any(record.get(key) != value for key, value in actual.items()):
        raise ValueError("snapshot data no longer matches its verification sidecar")
    return record
